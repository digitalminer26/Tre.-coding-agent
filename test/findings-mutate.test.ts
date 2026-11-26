/**
 * g1s7-F3 audit-fix regression suite for scripts/findings-mutate.py —
 * the mutation-sweep's judgment core. The sweep itself costs ~30 min,
 * so these pin the PURE functions through a deterministic Python
 * driver (scripts/findings-mutate-driver.py: JSON in, one JSON object
 * out per command) fed SYNTHETIC TAP. Every rule the auditor demanded
 * gets a named test:
 *   F1  SKIP/TODO tests never join the green-attribution set
 *   F2  isolation re-runs demand the TARGET specifically reproduce
 *       (skip / pass / other-test-failure in isolation => FLAKY, not
 *       killed) and never re-apply the sweep's skip-drift rule
 *   F3  hang attribution requires exactly-one hung suite, every other
 *       rerun clean AND drift/ambiguity-free
 *   F4  the MUTS registry audit FAILS CLOSED (unparseable registry =>
 *       None => refusal, never "no duplicates")
 *   F5  SIGKILL residue: the crash journal recovers pristine source
 *       on the next sweep; spawn tracking is signal-atomic
 *   audit-c1  self-contradictory TAP (a not-ok line under "# fail 0")
 *       is a run-error, never a survived verdict
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const DRIVER = path.join(repoRoot, "scripts", "findings-mutate-driver.py");
const SWEEP = path.join(repoRoot, "scripts", "findings-mutate.py");

function drive<T = Record<string, unknown>>(
  cmd: string,
  payload: unknown,
): T {
  const out = execFileSync(
    "python3",
    [DRIVER, cmd],
    {
      input: JSON.stringify(payload ?? {}),
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return JSON.parse(out) as T;
}

const GREEN = ["TAP version 13", "ok 1 - alpha", "ok 2 - beta", "1..2", "# fail 0"];

test("sweep script and driver exist and compile", () => {
  assert.ok(fs.existsSync(SWEEP), "findings-mutate.py must exist");
  assert.ok(fs.existsSync(DRIVER), "driver must exist next to the sweep");
  execFileSync("python3", ["-m", "py_compile", SWEEP, DRIVER], {
    timeout: 30_000,
  });
});

test("F1: baseline green excludes SKIP/TODO tests; red or ambiguity refuses", () => {
  const g = drive("baseline", { tap: GREEN });
  assert.equal(g["refused"], false);
  assert.deepEqual([...(g["green"] as string[])].sort(), ["alpha", "beta"]);

  const skip = drive("baseline", {
    tap: ["ok 1 - alpha", "ok 2 - gamma # SKIP env-only", "# fail 0"],
  });
  assert.deepEqual(skip["green"], ["alpha"], "SKIPped test never joins green");
  assert.deepEqual(skip["skipped"], ["gamma"]);

  const todo = drive("baseline", {
    tap: ["ok 1 - alpha", "ok 2 - gamma # TODO unfixed", "# fail 0"],
  });
  assert.deepEqual(todo["green"], ["alpha"], "TODO never counts green");

  const red = drive("baseline", {
    tap: ["ok 1 - alpha", "not ok 2 - beta", "# fail 1"],
  });
  assert.ok((red["reasons"] as string[]).some((r) => r.startsWith("not-green")),
    `expected a not-green refusal, got ${JSON.stringify(red["reasons"])}`);

  const dup = drive("baseline", {
    tap: ["ok 1 - alpha", "not ok 2 - alpha", "# fail 1"],
  });
  assert.ok((dup["reasons"] as string[]).some((r) => r.startsWith("ambiguous")),
    "conflicting duplicate refuses the baseline");

  // g1s7-C1-F4: zero-evidence run and disagreeing summaries refuse.
  const empty = drive("baseline", { tap: ["# fail 0"] });
  assert.ok((empty["reasons"] as string[]).some((r) => r.startsWith("no test lines")),
    "an output with no test lines is not a green baseline");

  const conflict = drive("baseline", {
    tap: ["ok 1 - alpha", "# fail 0", "# fail 1"],
  });
  assert.ok((conflict["reasons"] as string[]).some((r) => r.startsWith("disagreeing")),
    "two disagreeing '# fail N' summaries refuse the baseline");

  // g1s7-C1-F9: agreeing duplicates still refuse the baseline.
  const agreeDup = drive("baseline", {
    tap: ["ok 1 - alpha", "ok 2 - alpha", "# fail 0"],
  });
  assert.ok((agreeDup["reasons"] as string[]).some((r) => r.startsWith("multi-sighting")),
    "a name reported twice (even agreeing) poisons attribution at the source");
});

test("F1/audit-c1: sweep verdicts — killed needs a green test red; contradictory fail-summary refuses", () => {
  const killed = drive("sweep", {
    base_tap: GREEN,
    tap: ["ok 1 - alpha", "not ok 2 - beta", "# fail 1"],
  });
  assert.equal(killed["status"], "killed");
  assert.deepEqual(killed["new_fail"], ["beta"]);

  const survived = drive("sweep", { base_tap: GREEN, tap: GREEN });
  assert.equal(survived["status"], "survived");

  const unattributed = drive("sweep", {
    base_tap: GREEN,
    tap: ["ok 1 - alpha", "ok 2 - beta", "not ok 3 - preexisting-untouched", "# fail 1"],
  });
  assert.equal(unattributed["status"], "unattributed", "only non-green tests failed => no kill credit");

  const contradictory = drive("sweep", {
    base_tap: GREEN,
    tap: ["ok 1 - alpha", "not ok 2 - beta", "# fail 0"],
  });
  assert.equal(contradictory["status"], "run-error", "# fail 0 over a not-ok line is a lie, not a survival");

  const crashed = drive("sweep", {
    base_tap: GREEN,
    tap: ["ok 1 - alpha", "ok 2 - beta", "# fail 0"],
    rc: 7,
  });
  assert.equal(crashed["status"], "run-error", "nonzero rc contradicts fail 0");

  const ambiguous = drive("sweep", {
    base_tap: GREEN,
    tap: ["ok 1 - alpha", "not ok 2 - beta", "ok 3 - beta", "# fail 1"],
  });
  assert.equal(ambiguous["status"], "ambiguous", "conflicting duplicate lines poison the verdict");
});

test("F2: SKIP-DRIFT is a sweep-run rule; isolation re-runs demand the target itself reproduce", () => {
  const drift = drive("sweep", {
    base_tap: GREEN,
    tap: ["ok 1 - alpha", "ok 2 - beta # SKIP mutant-silenced", "# fail 0"],
  });
  assert.equal(drift["status"], "skip-drift");
  assert.deepEqual(drift["drift"], ["beta"], "a green test that SKIPs under the mutant is lost coverage, never a silent pass");

  // Isolation: target fails => killed...
  const isoKill = drive("iso", {
    base_tap: GREEN,
    target: "beta",
    iso_tap: ["ok 1 - alpha # SKIP not-target", "not ok 2 - beta", "# fail 1"],
  });
  assert.equal(isoKill["status"], "killed");
  assert.equal(isoKill["detail"], "", "drift rule must NOT fire in isolation (skipping non-targets is the point)");

  // ...but the TARGET skipping, passing, or a different test failing is FLAKY.
  const isoSkip = drive("iso", {
    base_tap: GREEN,
    target: "beta",
    iso_tap: ["ok 1 - alpha # SKIP", "ok 2 - beta # SKIP noise", "# fail 0"],
  });
  assert.equal(isoSkip["status"], "flaky", "target skipped in isolation is NOT a reproduced failure");

  const isoPass = drive("iso", {
    base_tap: GREEN,
    target: "beta",
    iso_tap: ["ok 1 - alpha # SKIP", "ok 2 - beta", "# fail 0"],
  });
  assert.equal(isoPass["status"], "flaky");

  const isoOther = drive("iso", {
    base_tap: GREEN,
    target: "beta",
    iso_tap: ["not ok 1 - alpha # SKIP weird", "ok 2 - beta # SKIP", "# fail 1"],
  });
  assert.equal(isoOther["status"], "flaky", "a different test failing does not reproduce the target");
});

test("F3: hang attribution needs exactly one hung suite and drift-free clean reruns", () => {
  // C2k-F2: the control must run ITS OWN suite's tests only — running
  // the whole combined baseline (including the hung suite's 'alpha')
  // is the crossover shape the isolation rule now refuses.
  const clean = drive("hang", {
    base_tap: GREEN,
    suite_green: { suite0: ["alpha"], suite1: ["beta"] },
    suites: [
      { tap: ["ok 1 - alpha"], timed_out: true },
      { tap: ["ok 1 - beta", "# fail 0"] },
    ],
  });
  assert.equal(clean["attributed"], true, clean["reason"] as string);
  assert.deepEqual(clean["hung"], ["suite0"]);

  // g1s7-C1-F5: NO per-suite membership => hang refused (fail-closed).
  const noMembership = drive("hang", {
    base_tap: GREEN,
    suites: [
      { tap: ["ok 1 - alpha"], timed_out: true },
      { tap: GREEN },
    ],
  });
  assert.equal(noMembership["attributed"], false, "no baseline membership => hang refused");

  // g1s7-C1-F5: hung suite with NO baseline-green tests proves nothing.
  const hungNoGreen = drive("hang", {
    base_tap: GREEN,
    suite_green: { suite0: [], suite1: ["alpha", "beta"] },
    suites: [
      { tap: [], timed_out: true },
      { tap: GREEN },
    ],
  });
  assert.equal(hungNoGreen["attributed"], false, "a green-free suite hanging is not the mutant");

  const twoHung = drive("hang", {
    base_tap: GREEN,
    suite_green: { suite0: ["alpha"], suite1: ["beta"] },
    suites: [
      { tap: ["ok 1 - alpha"], timed_out: true },
      { tap: ["ok 1 - alpha"], timed_out: true },
    ],
  });
  assert.equal(twoHung["attributed"], false, "two suspects: no kill credit");

  const rerunDrift = drive("hang", {
    base_tap: GREEN,
    suite_green: { suite0: ["alpha"], suite1: ["beta"] },
    suites: [
      { tap: ["ok 1 - alpha"], timed_out: true },
      { tap: ["ok 1 - alpha", "ok 2 - beta # SKIP drifted", "# fail 0"] },
    ],
  });
  assert.equal(rerunDrift["attributed"], false, "rerun skip-drift voids hang attribution");

  const rerunRed = drive("hang", {
    base_tap: GREEN,
    suite_green: { suite0: ["alpha"], suite1: ["beta"] },
    suites: [
      { tap: ["ok 1 - alpha"], timed_out: true },
      { tap: ["ok 1 - alpha", "not ok 2 - beta", "# fail 1"] },
    ],
  });
  assert.equal(rerunRed["attributed"], false, "a red rerun is not a clean control");

  const rerunCrash = drive("hang", {
    base_tap: GREEN,
    suite_green: { suite0: ["alpha"], suite1: ["beta"] },
    suites: [
      { tap: ["ok 1 - alpha"], timed_out: true },
      { tap: GREEN, rc: 3 },
    ],
  });
  assert.equal(rerunCrash["attributed"], false, "rc!=0 rerun is not clean despite fail 0");
});

// ---- g1s7 cycle-1 audit fixes (T-C1-F4/F6/F7/F9: judge rules) ----

test("C1-F4: zero-evidence sweep run is run-error, never survived", () => {
  const empty = drive("sweep", { base_tap: GREEN, tap: ["# fail 0"] });
  assert.equal(empty["status"], "run-error",
    "output with no test lines proves nothing — surviving on it was a lie");

  const missing = drive("sweep", {
    base_tap: GREEN,
    tap: ["ok 1 - alpha", "# fail 0"],
  });
  assert.equal(missing["status"], "run-error",
    "a sweep run that never executed baseline-green 'beta' is incomplete, not a survive");

  const conflict = drive("sweep", {
    base_tap: GREEN,
    tap: ["ok 1 - alpha", "ok 2 - beta", "# fail 0", "# fail 1"],
  });
  assert.equal(conflict["status"], "run-error",
    "disagreeing '# fail N' summaries: the run reported itself twice with contradictory results");
});

test("C1-F6: rc=0 with '# fail N>0' is contradictory — refused, never a kill", () => {
  const contrad = drive("sweep", {
    base_tap: GREEN,
    tap: ["ok 1 - alpha", "not ok 2 - beta", "# fail 1"],
    rc: 0,
  });
  assert.equal(contrad["status"], "run-error",
    "process says success, summary says failure — untrustworthy, no kill credit");

  const isoContrad = drive("iso", {
    base_tap: GREEN,
    target: "beta",
    iso_tap: ["ok 1 - alpha # SKIP not-target", "not ok 2 - beta", "# fail 1"],
    rc: 0,
  });
  assert.equal(isoContrad["status"], "run-error",
    "the isolation re-run gets the same contradiction rule");
});

test("C1-F7: directive needs a word boundary; ONLY is not a skip; SKIPPER is not SKIP", () => {
  // " # SKIPPER" is a name fragment: the line is an executed failure
  // and contradicts "# fail 0" => run-error, never hid in skipped.
  const skipper = drive("sweep", {
    base_tap: GREEN,
    tap: ["ok 1 - alpha", "not ok 2 - beta # SKIPPER-ish", "# fail 0"],
  });
  assert.equal(skipper["status"], "run-error",
    "a red name containing '# SKIPPER' is not a SKIP directive");

  // ONLY executed and asserted: a red ONLY line under fail=0 is a
  // contradiction, not a legal directed line.
  const only = drive("sweep", {
    base_tap: GREEN,
    tap: ["ok 1 - alpha", "not ok 2 - beta # ONLY", "# fail 0"],
  });
  assert.equal(only["status"], "run-error",
    "ONLY ran — its failure cannot hide from the contradictory-summary check");

  // A green ONLY line still counts as executed (credits green).
  const onlyGreen = drive("sweep", {
    base_tap: GREEN,
    tap: ["ok 1 - alpha # ONLY", "ok 2 - beta", "# fail 0"],
  });
  assert.equal(onlyGreen["status"], "survived",
    "ONLY executed and passed — the green set stands");
});

test("C1-F9: agreeing duplicate names (multi-sighting) poison attribution everywhere", () => {
  const sweepDup = drive("sweep", {
    base_tap: GREEN,
    tap: ["ok 1 - alpha", "not ok 2 - beta", "ok 3 - beta", "# fail 1"],
  });
  // conflicting dupes were already ambiguous; AGREEMENT case:
  const agreeDup = drive("sweep", {
    base_tap: GREEN,
    tap: ["ok 1 - alpha", "ok 2 - beta", "ok 3 - beta", "# fail 0"],
  });
  assert.equal(agreeDup["status"], "ambiguous",
    "beta ran twice and merged — a survivor cannot be credited as coverage");

  const isoDup = drive("iso", {
    base_tap: GREEN,
    target: "beta",
    iso_tap: ["ok 1 - alpha # SKIP", "not ok 2 - beta", "not ok 3 - beta", "# fail 1"],
    rc: 1,
  });
  assert.notEqual(isoDup["status"], "killed",
    "the isolated 'reproduction' ran the name twice (agreeing) — which instance reproduced?");

  const hangDup = drive("hang", {
    base_tap: GREEN,
    suite_green: { suite0: ["alpha"], suite1: ["beta"] },
    suites: [
      { tap: ["ok 1 - alpha"], timed_out: true },
      { tap: ["ok 1 - alpha", "ok 2 - beta", "ok 3 - beta", "# fail 0"] },
    ],
  });
  assert.equal(hangDup["attributed"], false,
    "a clean-control rerun with multi-sighted names is not trustworthy");
});

// ---- g1s7 cycle-1 audit fixes (T-C1-F1/F2/F8: journal) ----

test("C1-F1: journal key is the ABSOLUTE source path; checkouts never share one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-fmut-key-"));
  try {
    const r = drive("journal_pathkey", { dir });
    assert.equal(r["distinct"], true,
      "two checkouts of intake.ts mapped to the SAME journal — A's recovery would clobber B");
    assert.equal(r["both_absolute"], true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C1-F1: concurrent sweeps are refused by the journal lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-fmut-lock-"));
  try {
    const r = drive("journal_lock", { dir });
    assert.equal(r["parent_got"], true, "first sweep takes the lock");
    assert.equal(r["child_got"], false,
      "a second concurrent sweep must NOT acquire the same journal lock");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C1-F2: a bare import never clears a live crash journal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-fmut-import-"));
  try {
    const r = drive("journal_import", { dir });
    assert.equal(r["armed"], false, "import does not arm the restore hook");
    assert.equal(r["journal_exists_before_exit"], true);
    // The driver process has now EXITED (its atexit ran) — re-check.
    const recheck = drive("journal_import_recheck", { dir });
    assert.equal(recheck["journal_survives"], true,
      "atexit of a process that never mutated source deleted a journal — the SIGKILL recovery record is gone");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C1-F8: atomic journal write; torn journal is destroyed, never applied to src", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-fmut-torn-"));
  try {
    const r = drive("journal", { dir });
    assert.equal(r["torn_raised"], true,
      "a journal body shorter than its declared length is a torn write — recovery must raise, not restore garbage");
    assert.equal(r["torn_journal_gone"], true, "the corrupt journal is destroyed");
    assert.equal(r["torn_src_untouched"], true,
      "src was NOT overwritten from a partial journal");
    assert.equal(r["no_tmp_litter"], true, "atomic write leaves no .tmp residue");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- g1s7 cycle-1 audit fix (T-C1-F3: kill-before-deregister) ----

test("C1-F3: SystemExit unwinding stream_run/build kills the child group before deregistering", () => {
  const s = drive("kill_on_unwind", {});
  assert.equal(s["outcome"], "raised", "the interrupt still propagates (restore hooks run)");
  assert.equal(s["child_killed"], true,
    "child was alive when its pid was dropped — the atexit reaper could never find it again");
  assert.equal(s["children_empty"], true, "tracking left clean");

  const b = drive("build_kill_on_unwind", {});
  assert.equal(b["outcome"], "raised");
  assert.equal(b["child_killed"], true, "build() obeys the same contract");
  assert.equal(b["children_empty"], true);
});

// ---- g1s7 cycle-1 audit fix (T-C1-F10: shared baseline gate) ----

test("C1-F10: the driver pins the REAL baseline gate (baseline_refusals), not a copy", () => {
  const src = fs.readFileSync(DRIVER, "utf8");
  assert.ok(src.includes("mod.baseline_refusals(r)"),
    "cmd_baseline must call the production gate — a reimplementation drifts");
  const sweepSrc = fs.readFileSync(SWEEP, "utf8");
  assert.ok(sweepSrc.includes("reasons = baseline_refusals(r)"),
    "baseline() itself must go through the shared gate");
});

test("F4: MUTS registry audit fails closed — unparseable means None (refusal), never empty (all-clear)", () => {  assert.deepEqual(drive("registry", { src: "MUTS = {'a': ('x','y'), 'b': ('z','w')}" })["dupes"], []);
  assert.deepEqual(drive("registry", { src: "MUTS = {'a': 1, 'b': 2, 'a': 3}" })["dupes"], ["a"]);
  for (const [name, src] of [
    ["no MUTS assignment", "x = 1"],
    ["MUTS not a dict literal", "MUTS = [1, 2]"],
    ["non-string key", "MUTS = {'a': 1, ('t',): 2}"],
  ]) {
    assert.equal(drive("registry", { src })["dupes"], null, `${name}: audit could not run => None`);
  }
});

test("F5: crash journal recovers pristine source after a simulated SIGKILL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-fmut-journal-"));
  try {
    const r = drive("journal", { dir });
    assert.equal(r["existed"], true, "journal armed before apply");
    assert.equal(r["recovered_clean"], false, "journal matching pristine source is a no-op");
    assert.equal(r["gone_after_clean"], true, "no-op clears the journal");
    assert.equal(r["recovered_dirty"], true, "leftover mutant is recovered");
    assert.equal(r["restored"], true, "recovered content is byte-identical to pristine");
    assert.equal(r["gone_after_recover"], true, "journal consumed on recovery");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F5: Popen+tracking happens inside a signal-atomic region", () => {
  const r = drive("spawnmask", {});
  assert.equal(r["sigint_inside"], true, "SIGINT blocked in the spawn region");
  assert.equal(r["sigterm_inside"], true, "SIGTERM blocked in the spawn region");
  assert.equal(r["tracked_in_region"], true, "child registered BEFORE unblocking");
  assert.equal(r["restored_after"], true, "mask restored on exit — no permanent block");
  assert.equal(r["children_empty"], true, "no leak in the driver's own accounting");
});

// ---- g1s7 cycle-2 audit fixes (auditor: gpt-terra) ----

test("C2a-F1: a leftover quarantine keeps refusing EVERY later recovery until handled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-fmut-c2a1-"));
  try {
    const r = drive("journal", { dir });
    assert.equal(r["second_raised"], true,
      "recover() that does not find the journal but finds a quarantine must raise — 'no journal' may never bless a possibly-mutated src/");
    assert.equal(r["second_src_untouched"], true,
      "the quarantine refusal never rewrites src/ itself");
    assert.equal(r["cleared_ok"], true,
      "after manual handling (src restored, quarantine removed) recovery is silent again");
    // C2k-F1: a SAME-LENGTH corrupted body (valid length + end marker,
    // wrong content) must be rejected by the header digest — never
    // restored as the supposedly-pristine source.
    assert.equal(r["digest_raised"], true,
      "C2k-F1: a same-length corrupted journal body must raise JournalCorrupt — length+marker alone accept any crafted corruption");
    assert.equal(r["digest_src_untouched"], true,
      "C2k-F1: the digest refusal never rewrites src/ with corrupted 'pristine' bytes");
    assert.equal(r["digest_quarantined"], true,
      "C2k-F1: the digest-rejected journal is quarantined, not silently deleted");
    assert.equal(r["digest_cleared_ok"], true,
      "C2k-F1: after manual handling of a digest-quarantine recovery is silent again");
    assert.equal(r["inaccess_raised"], true,
      "an INACCESSIBLE journal directory raises JournalRecoverFailed — os.path.exists() swallowing EACCES may not read as 'nothing to recover'");
    assert.equal(r["unlistable_raised"], true,
      "a SEARCHABLE-but-UNLISTABLE journal dir (mode 0111: listdir EACCES, stat works) must refuse — a swallowed listing error would hide the quarantine and bless mutated src/");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C2a-F2: a nonexecuted directed failure never receives kill credit (isolation path)", () => {
  // Auditor repro: isolation target "other" reproduces, while a
  // baseline-green test fails only UNDER a TODO directive (never
  // executed) — that line may not supply the kill.
  const r = drive("iso", {
    base_tap: GREEN, // green = {alpha, beta}
    iso_tap: ["not ok 1 - other", "not ok 2 - alpha # TODO deferred", "1..2", "# fail 1"],
    target: "other",
  });
  assert.equal(r["status"], "unattributed",
    "a directed (TODO/SKIP) not-ok line never executed its assertions — no kill credit");
  // Positive: an UNDIRECTED baseline-green failure still reproduces.
  const real = drive("iso", {
    base_tap: GREEN,
    iso_tap: ["not ok 1 - alpha", "1..1", "# fail 1"],
    target: "alpha",
  });
  assert.equal(real["status"], "killed",
    "the target failing undirected in isolation is still a legitimate kill");
});

test("C2a-F3: a timed-out rerun with red partial TAP is not a pure hang", () => {
  const redPartial = drive("hang", {
    base_tap: GREEN,
    suite_green: { suite0: ["alpha"], suite1: ["beta"] },
    suites: [
      { tap: ["not ok 1 - alpha", "# fail 0"], timed_out: true },
      { tap: ["ok 1 - beta", "# fail 0"] },
    ],
  });
  assert.equal(redPartial["attributed"], false,
    "a suite that was already FAILING before it hung is not attributable as a hang kill");
  const redCount = drive("hang", {
    base_tap: GREEN,
    suite_green: { suite0: ["alpha"], suite1: ["beta"] },
    suites: [
      { tap: ["not ok 1 - alpha", "# fail 1"], timed_out: true },
      { tap: ["ok 1 - beta", "# fail 0"] },
    ],
  });
  assert.equal(redCount["attributed"], false,
    "a timed-out rerun reporting failures before hanging is refused");
  // Positive: a clean spinner still attributes.
  const spinner = drive("hang", {
    base_tap: GREEN,
    suite_green: { suite0: ["alpha"], suite1: ["beta"] },
    suites: [
      { tap: [], timed_out: true },
      { tap: ["ok 1 - beta", "# fail 0"] },
    ],
  });
  assert.equal(spinner["attributed"], true,
    "a silent spinner (no partial TAP) with clean controls remains attributable");
});

test("C2-F4: hang controls must actually run their suite's green tests", () => {
  // Zero-evidence control ('# fail 0' alone) is NOT clean.
  const zeroCtrl = drive("hang", {
    base_tap: GREEN,
    suite_green: { suite0: ["alpha"], suite1: ["beta"] },
    suites: [
      { tap: ["ok 1 - alpha"], timed_out: true },
      { tap: ["# fail 0"] },
    ],
  });
  assert.equal(zeroCtrl["attributed"], false,
    "a control that reported no test lines proves the rerun never ran");

  // Disagreeing '# fail N' in a control voids attribution.
  const conflictCtrl = drive("hang", {
    base_tap: GREEN,
    suite_green: { suite0: ["alpha"], suite1: ["beta"] },
    suites: [
      { tap: ["ok 1 - alpha"], timed_out: true },
      { tap: ["ok 1 - beta", "# fail 1", "# fail 0"] },
    ],
  });
  assert.equal(conflictCtrl["attributed"], false,
    "disagreeing summaries in a rerun are untrustworthy, hung or not");

  // Control green but never executed ITS baseline-green test.
  const missingCtrl = drive("hang", {
    base_tap: GREEN,
    suite_green: { suite0: ["alpha"], suite1: ["beta"] },
    suites: [
      { tap: ["ok 1 - alpha"], timed_out: true },
      { tap: ["ok 1 - gamma # SKIP unrelated", "# fail 0"] },
    ],
  });
  assert.equal(missingCtrl["attributed"], false,
    "a control whose own green test never executed is not a clean control");

  // C2k-F2: a control that ALSO executed the hung suite's baseline-green
  // test proves registration/imports changed — its clean verdict says
  // nothing about the hung suite's isolation. Refuse.
  const crossover = drive("hang", {
    base_tap: GREEN,
    suite_green: { suite0: ["alpha"], suite1: ["beta"] },
    suites: [
      { tap: [], timed_out: true },
      { tap: ["ok 1 - alpha", "ok 2 - beta", "# fail 0"] },
    ],
  });
  assert.equal(crossover["attributed"], false,
    "C2k-F2: a control executing the hung suite's baseline-green test is not clean evidence");

  // C2k-F2 (symmetric): the HUNG suite's partial output already
  // executed a control suite's green test — which suite hung is no
  // longer attributable.
  const hungCrossover = drive("hang", {
    base_tap: GREEN,
    suite_green: { suite0: ["alpha"], suite1: ["beta"] },
    suites: [
      { tap: ["ok 1 - beta"], timed_out: true },
      { tap: ["ok 1 - beta", "# fail 0"] },
    ],
  });
  assert.equal(hungCrossover["attributed"], false,
    "C2k-F2: a hung suite executing a control's green test voids attribution too");

  // Positive control: full clean rerun still attributes.
  const stillOk = drive("hang", {
    base_tap: GREEN,
    suite_green: { suite0: ["alpha"], suite1: ["beta"] },
    suites: [
      { tap: ["ok 1 - alpha"], timed_out: true },
      { tap: ["ok 1 - beta", "# fail 0"] },
    ],
  });
  assert.equal(stillOk["attributed"], true,
    "the tightened rules must not break legitimate attribution");
});

test("C2-F1/F3: unreadable journal raises + preserved; corrupt journal quarantined, never deleted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-fmut-c2-"));
  try {
    const r = drive("journal", { dir });
    assert.equal(r["torn_quarantined"], true,
      "the corrupt journal must be renamed aside with its content intact — deleting it lets the NEXT sweep trust a mutated src/");
    assert.equal(r["unreadable_raised"], true,
      "an OSError reading the journal raises JournalRecoverFailed, never the old silent 'nothing to recover'");
    assert.equal(r["unreadable_preserved"], true,
      "the journal is preserved on every failure path — retry must stay possible");
    assert.equal(r["src_still_mutant"], true,
      "a failed recovery never pretends to have restored anything");
    assert.equal(r["no_tmp_litter"], true,
      "atomic journal writes leave no tmp residue in the JOURNAL dir (the dir they are actually written to)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C2-F2: main() keeps the pristine-build suite membership (no lazy dead-reset)", () => {
  // g1s7 cycle-2 audit: base_suite_green was computed and then
  // immediately RESET to None — every hung mutant hit the
  // "membership untrustworthy" refusal and production hang
  // attribution was DEAD while the pure-function tests passed. Pin
  // the wiring: the reset line must stay gone.
  const src = fs.readFileSync(SWEEP, "utf8");
  assert.ok(!src.includes("base_suite_green = None"),
    "base_suite_green must not be reassigned to None after baseline_suite_green()");
  assert.ok(src.includes("base_suite_green = baseline_suite_green()"),
    "main() must compute per-suite membership from the pristine build");
  assert.ok(/suite_green=base_suite_green/.test(src),
    "judge_hang must receive the pristine membership map");
});

test("C2a2-F2: the ORIGINAL timed-out run is refused on positive '# fail N>0' too", () => {
  // A timed-out full run that already summarised failures is not a
  // trustworthy pure hang — same rule judge_hang applies to reruns
  // (C2a-F3). main()'s orig-run gate must include the fail>0 check.
  const src = fs.readFileSync(SWEEP, "utf8");
  const i0 = src.indexOf("orig_red");
  const gate = i0 >= 0 ? src.slice(i0, src.indexOf("UNATTRIBUTED-HANG", i0)) : "";
  assert.ok(/r\.fail is not None and r\.fail > 0/.test(gate),
    "main()'s timed-out orig-run gate must refuse a partial '# fail N>0' summary");
});

test("C2a3-F1: journal path is TMPDIR-independent (fixed root, no drift mid-sweep)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-fmut-c2a3f1-"));
  try {
    const r = drive("journal", { dir });
    assert.equal(r["tmpdir_stable"], true,
      "changing TMPDIR mid-sweep must NOT move the journal — the recovery scan would miss it");
    assert.equal(r["tmpdir_recover_ok"], true,
      "the journal armed before the TMPDIR change is found and recovered at the stable root");
    const src = fs.readFileSync(SWEEP, "utf8");
    assert.ok(!/_journal_path[\s\S]{0,200}gettempdir/.test(src),
      "_journal_path must not call tempfile.gettempdir() (env-dependent key)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C2a3-F2: a child that exits with a live descendant still gets its group killed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-fmut-c2a3f2-"));
  try {
    const d = drive("descendant_kill", { dir });
    assert.equal(d["rc"], 0);
    assert.equal(d["descendant_spawned"], true,
      "the probe must have OBSERVED the descendant spawn (C2b-F3: a missing pidfile is not proof of cleanup)");
    assert.equal(d["descendant_alive"], false,
      "unconditional killpg-by-number must reap the descendant of an EXITED leader (getpgid ESRCHes after reaping)");
    assert.equal(d["children_empty"], true);
    const src = fs.readFileSync(SWEEP, "utf8");
    assert.ok(/os\.killpg\(pid, signal\.SIGKILL\)/.test(src),
      "_kill_group must try the group BY NUMBER when getpgid fails — a group outlives its leader");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C2a3-F3: durability ordering — fsync dirs around every journal transition", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  // quarantine rename, journal removal after restore, and atomic
  // write replace must each be followed by a dir fsync, and the
  // restore must be durable BEFORE the journal is removed.
  assert.ok(src.includes("_fsync_dir"), "the helper must exist");
  const n = (src.match(/_fsync_dir\(os\.path\.dirname/g) || []).length;
  assert.ok(n >= 3,
    `journal transitions (write-replace, quarantine, post-restore remove) each need a dir fsync, found ${n}`);
  const i0 = src.indexOf("durable BEFORE the journal");
  assert.ok(i0 >= 0, "the C2a3-F3 ordering rule must be documented in recovery");
  // g1s7-C2v: the pre-recover backup call widened the region between
  // the rule comment and the DONE transition.
  const region = src.slice(i0, i0 + 3800);
  const fsyncSrc = region.indexOf("os.fsync(fh.fileno())");
  // C2t-F2: the journal's completion is now the atomic DONE-mark
  // replace; the ordering rule applies to the first journal
  // transition after the restore (mark, then best-effort remove).
  const journalGone = [region.indexOf("_journal_mark_done()"),
    region.indexOf("os.remove(j)")].filter((n) => n >= 0);
  assert.ok(fsyncSrc >= 0 && journalGone.length > 0 && Math.min(...journalGone) > fsyncSrc,
    "the restore write must be fsynced BEFORE any journal transition (DONE-mark/remove)");
});

test("C2a3-F4: the sweep's finally never returns a value (would swallow SystemExit)", () => {
  // A `return` inside a finally swallows an in-flight SystemExit /
  // exception — the signal-handler exit path (g1s7-F3) relies on
  // SystemExit propagating so hooks/atexit run. Pin: no `return`
  // statement may appear in any finally block of the sweep.
  const src = fs.readFileSync(SWEEP, "utf8");
  const lines = src.split("\n");
  let finallyIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const m = /^( *)finally:/.exec(raw);
    if (m) { finallyIndent = m[1]?.length ?? 0; continue; }
    if (finallyIndent < 0) continue;
    const t = raw;
    if (!t.trim()) continue;
    const ind = t.length - (t.trimStart().length);
    if (ind <= finallyIndent) { finallyIndent = -1; continue; }
    assert.ok(!/^\s*return\b/.test(t),
      `line ${i + 1}: 'return' inside finally swallows SystemExit — set a flag and return after the finally`);
  }
  assert.ok(/final_rebuild_failed/.test(src),
    "the final-rebuild failure is signalled by a flag, returned AFTER the finally");
});

test("C2b-F2: _fsync_dir forgives only unsupported-platform errnos, propagates real I/O errors", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-fmut-c2bf2-"));
  try {
    const s = drive("fsync_semantics", { dir });
    assert.equal(s["eio_raised"], true,
      "a real fsync failure (EIO) must propagate — the old blanket 'except OSError: pass' blessed a non-durable journal and let the mutation proceed");
    assert.equal(s["einval_tolerated"], true,
      "platform non-support (EINVAL) stays forgiven");
    assert.equal(s["real_ok"], true, "the untouched real call works");
    const src = fs.readFileSync(SWEEP, "utf8");
    assert.ok(!/except OSError:\s*\n\s*pass/.test(
      src.slice(src.indexOf("def _fsync_dir"), src.indexOf("def _fsync_path"))),
      "no blanket OSError-pass may remain inside _fsync_dir");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C2b-F1: every restore/clear path makes the pristine content durable BEFORE the journal disappears", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  // main()'s two restore sites use the fsyncing writer, not a bare
  // write. (The MUTANT-APPLY write may stay bare: a crash there is
  // exactly what the armed journal recovers.)
  // (C2q-F2 moved the apply site to a newline="" write; the RULE is
  // unchanged: no restore/clear path may be a bare page-cache write.)
  const apply = src.match(/open\(SRC, "w", encoding="utf-8", newline=""\)[\s\S]{0,40}orig\.replace/g) || [];
  assert.equal(apply.length, 1,
    "only the mutant-apply site may remain a non-fsyncing write (newline-pinned)");
  assert.ok(!/open\(SRC, "w"\)\.write\(orig\)(?!\.replace)/.test(src),
    "no restore site may use a bare write — a page-cache write is not a durable restore");
  assert.ok(src.includes("_write_durable(SRC, orig)"),
    "both finally-restores call the fsyncing writer");
  // cur == body clear: fsync SRC before the journal disappears.
  // C2t-F2: "disappears" is now the atomic DONE-mark replace (then a
  // best-effort marker removal) — the fsync-before-completion rule
  // is unchanged, only the completion primitive.
  const i0 = src.indexOf("if cur == body:");
  assert.ok(i0 >= 0, "the matching-content clear path must exist");
  const region = src.slice(i0, i0 + 3600);
  const fsync = region.indexOf("_fsync_path(SRC)");
  const remove = region.indexOf("os.remove(j)");
  const mark = region.indexOf("_journal_mark_done()");
  assert.ok(fsync >= 0 && mark > fsync && remove > mark,
    "the clear-on-match path must fsync SRC before DONE-marking/unlinking the journal (C2b-F1 + C2t-F2)");
  // C2g-F1: the suspect-dist destroy sits between them (destroyed
  // while the journal is still armed, journal gone only after).
  // C2h-F1: destroy is guarded (`and not _destroy_suspect_dist(...)`)
  // so a FAILED destroy raises instead of falling through to the
  // journal completion — it only ever runs after a confirmed destroy.
  assert.ok(fsync < region.indexOf("_destroy_suspect_dist(")
    && region.indexOf("_destroy_suspect_dist(") < mark,
    "C2g-F1: dist destroyed after the SRC fsync and before the journal completion");
  assert.ok(/_DIST_SUSPECT and not _destroy_suspect_dist\(/.test(region),
    "C2h-F1: the journal unlink must be conditional on a SUCCESSFUL destroy");
  // The atexit clear hook must not clear over an un-durable restore.
  const hook = src.slice(src.indexOf("def _journal_clear_hook"),
                         src.indexOf("def _journal_clear_hook") + 2200);
  assert.ok(hook.includes("_RESTORE_FAILED"),
    "the clear hook still honours the failed-restore flag");
  assert.ok(/if _DIST_STILL_SUSPECT:\s*\n\s*return/.test(hook),
    "C2h-F1: the clear hook refuses to clear a live journal while a destroy FAILED this process");
  assert.ok(/if _JOURNAL_LOCK_FD is None:\s*\n\s*return/.test(hook),
    "C2i-F2: the clear hook refuses when the sweep lock was never acquired — only the lock-holding sweep may clear the journal (registry-refusal processes must never touch it)");
});

test("C2b-F3: the descendant probe proves the descendant spawned before its absence counts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-fmut-c2bf3-"));
  try {
    const d = drive("descendant_kill", { dir });
    assert.equal(d["descendant_spawned"], true,
      "spawn evidence is REQUIRED before 'descendant_alive: false' means anything (C2b-F3: no vacuous pass)");
    assert.equal(d["descendant_alive"], false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C2c-F1: atexit restore hook fsyncs the match branch; failure keeps the journal armed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-fmut-c2c1-"));
  try {
    const r = drive("restore_hook", { dir });
    assert.equal(r["failed_flag_on_fsync_error"], true,
      "a failed fsync on the already-matching source must set _RESTORE_FAILED (page-cache match is not durability)");
    assert.equal(r["journal_armed_after_failed_restore"], true,
      "the clear hook must not delete the journal over an un-durable restore");
    assert.equal(r["cleared_when_durable"], true,
      "with a working fsync the clean sweep still clears the journal");
    // C2m-F1: an interrupt (SystemExit) inside the hook must set the
    // failure flag AND propagate — Python continues running the
    // remaining atexit callbacks after one raises, so a silent
    // slip-past let the clear hook delete the journal over
    // un-proven page-cache bytes.
    assert.equal(r["exit_propagated"], true,
      "C2m-F1: the SystemExit must propagate out of the restore hook (the process still dies from its signal)");
    assert.equal(r["exit_sets_failed_flag"], true,
      "C2m-F1: an abnormal (non-OSError) exit from the restore sets _RESTORE_FAILED");
    assert.equal(r["journal_armed_after_exit"], true,
      "C2m-F1: the clear hook must refuse to delete the journal after an interrupted restore");
    // Source pin: the hook's failure guard must be BaseException-wide
    // (SystemExit/KeyboardInterrupt included), placed AFTER the
    // OSError handler, and re-raise.
    const srcText = fs.readFileSync(SWEEP, "utf8");
    const hi = srcText.indexOf("def _restore_src_hook");
    const hook = srcText.slice(hi, hi + 3200);
    assert.ok(/except BaseException:\s*\n(?:\s*#[^\n]*\n)*\s*_RESTORE_FAILED = True\s*\n\s*raise/.test(hook),
      "C2m-F1: _restore_src_hook must catch BaseException, set _RESTORE_FAILED, and re-raise (journal stays armed on ANY abort)");
    assert.ok(hook.indexOf("except OSError:") < hook.indexOf("except BaseException:"),
      "C2m-F1: the OSError handler stays first (user-visible message); BaseException is the catch-all behind it");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C2c-F2: a failing final restore reaps children and WITHHOLDS (not skips) the rebuild", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  const i0 = src.indexOf("FINAL RESTORE FAILED");
  assert.ok(i0 >= 0, "the final restore must be wrapped in a handled try in the outer finally");
  const reapIdx = src.indexOf("reap_active_children()", i0);
  assert.ok(reapIdx > i0 && reapIdx - i0 < 1500,
    "reaping must still run after a failed/interrupted restore (the old code skipped it AND the rebuild)");
  const withhold = src.indexOf("if restore_failed:", reapIdx);
  const buildIdx = src.indexOf("final_rebuild_failed = not _final_rebuild_pristine()", reapIdx);
  assert.ok(withhold >= 0 && buildIdx > withhold,
    "a failed restore must set the failure flag instead of rebuilding over a possibly-mutant source");
  assert.ok(src.indexOf("restore_failed = False", i0 - 200) < i0,
    "restore_failed initialised before the restore attempt in the same finally");
});

test("C2c-F3: the fsync probe restores the REAL fsync before its real-call check", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-fmut-c2c3-"));
  try {
    const s = drive("fsync_semantics", { dir });
    assert.equal(s["real_ok"], true);
    const drv = fs.readFileSync(DRIVER, "utf8");
    const region = drv.slice(drv.indexOf("def cmd_fsync_semantics"),
                             drv.indexOf("def cmd_descendant_kill"));
    const restoreIdx = region.indexOf("os.fsync = real");
    const realProbe = region.indexOf('results["real_ok"]');
    assert.ok(restoreIdx >= 0 && restoreIdx < realProbe,
      "the real-call probe must run with the REAL os.fsync, not under the EINVAL mock (vacuous pass otherwise)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C2d-F1: per-suite hang evidence must be green in the FULL baseline too", () => {
  // A test skipped in the full baseline but executed in the
  // per-suite baseline must NOT supply the sole evidence for a hang.
  const mismatch = drive("hang", {
    base_tap: ["ok 1 - alpha", "ok 2 - beta # SKIP", "# fail 0"],
    suite_green: { suite0: ["beta"], suite1: ["alpha"] },
    suites: [
      { tap: [], timed_out: true },
      { tap: ["ok 1 - alpha", "# fail 0"] },
    ],
  });
  assert.equal(mismatch["attributed"], false,
    "per-suite membership disagreeing with the full baseline voids hang attribution");
  // Positive control: agreeing membership still attributes.
  const agree = drive("hang", {
    base_tap: ["ok 1 - alpha", "ok 2 - beta", "# fail 0"],
    suite_green: { suite0: ["beta"], suite1: ["alpha"] },
    suites: [
      { tap: [], timed_out: true },
      { tap: ["ok 1 - alpha", "# fail 0"] },
    ],
  });
  assert.equal(agree["attributed"], true, "agreeing membership still attributes");
});

test("C2d-F2/C2e-F1/C2f-F1: every path where dist is not known-pristine destroys it", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  const hi = src.indexOf("def _destroy_suspect_dist");
  assert.ok(hi >= 0, "the dist-destruction helper must exist");
  const helper = src.slice(hi, hi + 3600);
  assert.ok(helper.includes("os.remove(DIST)"),
    "the helper must delete DIST — the only artifact compiled from mutated source");
  // C2f-F1: destruction must happen BEFORE the final build starts
  // (SystemExit/OSError from build() must not bypass it) and again
  // on any non-success, inside a finally.
  const fi = src.indexOf("def _final_rebuild_pristine");
  assert.ok(fi >= 0, "the safe final-rebuild helper must exist");
  const fin = src.slice(fi, fi + 2500);
  // C2j-F2: the pre-delete is now the DURABLE destroy helper (unlink
  // + dist-dir fsync), not a bare os.remove — a rolled-back bare
  // unlink could resurrect the mutant entry mid-rebuild.
  assert.ok(fin.includes("_destroy_suspect_dist(") && fin.includes("ok = build(durable=True)")
    && fin.indexOf("_destroy_suspect_dist(") < fin.indexOf("ok = build(durable=True)"),
    "DIST must be durably destroyed BEFORE the final build starts — an interrupt during the final tsc must not leave the last mutant's artifact runnable");
  assert.ok(fin.includes("finally:") && fin.includes("_destroy_suspect_dist("),
    "a raised or failed final build must destroy again inside a finally");
  const i0 = src.indexOf("if restore_failed:");
  assert.ok(i0 >= 0);
  const region = src.slice(i0, i0 + 1600);
  assert.ok(region.includes("_destroy_suspect_dist("),
    "withholding the rebuild must destroy DIST — an ordinary npm test must fail LOUDLY, never silently run the last mutant's JavaScript");
  assert.ok(region.includes("_final_rebuild_pristine("),
    "the restore-OK branch must go through the pre-destroy safe rebuild");
});

test("C2f-F2/C2g-F1: recovery destroys the dead sweep's suspect dist from inside, on every journal branch", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  const gi = src.indexOf("_DIST_SUSPECT = True");
  assert.ok(gi >= 0, "main() must mark dist suspect before recovery");
  assert.ok(src.indexOf("_DIST_SUSPECT = True") < src.indexOf("_journal_recover()", gi - 2000),
    "the suspect mark must be set before _journal_recover() runs in main()");
  // Match-clear branch: destroy must happen BEFORE os.remove(j), and
  // ONLY on a confirmed-successful destroy (C2h-F1).
  const mi = src.indexOf("if cur == body:");
  assert.ok(mi >= 0);
  const matchRegion = src.slice(mi, mi + 4000);
  assert.ok(/if _DIST_SUSPECT and not _destroy_suspect_dist\([\s\S]{0,400}raise JournalRecoverFailed\(\)[\s\S]{0,1400}_journal_mark_done\(\)[\s\S]{0,800}os\.remove\(j\)/.test(matchRegion),
    "C2h-F1 + C2t-F2: the source-matches-clear branch must keep the journal armed (raise) when the destroy FAILS, and DONE-mark + remove only after a confirmed destroy");
  // Dirty-restore branch: destroy BEFORE the journal completion too.
  const di = src.indexOf("RESTORE WRITE FAILED");
  const dirtyRegion = src.slice(di - 200, di + 2600);
  assert.ok(/if _DIST_SUSPECT and not _destroy_suspect_dist\([\s\S]{0,400}raise JournalRecoverFailed\(\)[\s\S]{0,1200}_journal_mark_done\(\)/.test(dirtyRegion),
    "the dirty-restore branch must refuse to clear the journal when the destroy fails (crash-window keeps a marker), and DONE-mark only after a confirmed destroy");
  // C2g-F3: refusal branch destroys too, before returning 1.
  const fi = src.indexOf("JOURNAL RECOVERY FAILED");
  const refuseRegion = src.slice(fi - 400, fi + 200);
  assert.ok(refuseRegion.includes("_destroy_suspect_dist("),
    "a refused recovery must destroy the suspect dist before exiting — mutant JS must not survive the refusal");
});

test("C2g-F2: an interrupt during the final restore destroys dist, then propagates", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  const ci = src.indexOf("except (SystemExit, KeyboardInterrupt) as e:",
                         src.indexOf("FINAL RESTORE FAILED"));
  assert.ok(ci >= 0, "the final restore must catch SystemExit/KeyboardInterrupt (SIGTERM arrives as SystemExit)");
  const catchRegion = src.slice(ci, ci + 700);
  assert.ok(catchRegion.includes("restore_failed = True"),
    "an interrupted restore must take the withhold path");
  const re = src.indexOf("if _interrupted is not None:\n            raise _interrupted");
  assert.ok(re > ci, "the captured interrupt must re-raise after the finally body (exit code 128+signum)");
  const between = src.slice(ci, re);
  assert.ok(between.includes("_destroy_suspect_dist(") || between.includes("restore_failed"),
    "the withhold+destroy path runs before the interrupt propagates — signal exit must never leave the last mutant's dist runnable");
  // C2h-F2: capturing the FIRST interrupt was not enough — a SECOND
  // signal landing anywhere in the finally body (between the capture
  // and the re-raise, e.g. during the destroy or the rebuild) escaped
  // the withhold path again. The whole body now runs inside a
  // signal mask (_spawn_atomic blocks SIGINT/SIGTERM; deferred until
  // unmask), so no second interrupt can land mid-body.
  const wi = src.lastIndexOf("with _spawn_atomic():");
  assert.ok(wi > 0 && wi < ci && wi > src.lastIndexOf("finally:"),
    "C2h-F2: the LAST _spawn_atomic use must be the outer finally's mask (spawn sites aside), opening BEFORE the withhold logic runs");
  assert.ok(/_spawn_atomic\(\):.*\n\s+restore_failed = False/.test(src.slice(wi - 200, wi + 200)),
    "C2h-F2: the mask must open as the FIRST statement of the outer finally (nothing in the body may run unmasked)");
});

test("C2h-F1: _destroy_suspect_dist reports success truthfully, fsyncs the dist dir, and arms the sticky flag on failure", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  const hi = src.indexOf("def _destroy_suspect_dist");
  const helper = src.slice(hi, hi + 3600);
  assert.ok(helper.includes("def _destroy_suspect_dist(why: str) -> bool"),
    "C2h-F1: the helper must RETURN whether DIST is confirmed absent — callers gate the journal unlink on it");
  assert.ok(/return True/.test(helper) && /return False/.test(helper),
    "C2h-F1: success returns True, a failed/unverifiable destroy returns False");
  // C2h-F3: a successful unlink is only durable once the dist PARENT
  // dir is fsynced — a journal-dir fsync says nothing about it.
  assert.ok(helper.includes("_fsync_dir(os.path.dirname(DIST)"),
    "C2h-F3: the dist parent directory must be fsynced after the unlink before the destroy counts as durable");
  assert.ok(helper.includes("_DIST_STILL_SUSPECT = True"),
    "C2h-F1: a failed destroy must arm the sticky suspect flag (the atexit clear hook consumes it)");
  assert.ok(helper.includes("_DIST_STILL_SUSPECT = False"),
    "a confirmed destroy clears the sticky flag");
  // C2i-F1: the already-absent branch must NOT shortcut to success —
  // FileNotFoundError falls through to the (idempotent) dist-dir
  // fsync, so a retried destroy still proves deletion durability.
  assert.ok(/except FileNotFoundError:\s*\n\s*pass/.test(helper),
    "C2i-F1: FileNotFoundError must fall through (pass) into the dir fsync, never return True directly");
  const fnf = helper.indexOf("except FileNotFoundError:");
  assert.ok(helper.indexOf("_fsync_dir(os.path.dirname(DIST)", fnf) > fnf,
    "C2i-F1: the dist-dir fsync must run AFTER the FileNotFoundError fall-through too");
  // C2i-F4 belt: the destroy is a FAST sequence and runs masked —
  // an interrupt may not land between unlink and dir fsync.
  assert.ok(helper.indexOf("with _spawn_atomic():") < helper.indexOf("os.remove(DIST)"),
    "C2i-F4: the unlink+dir-fsync sequence must run inside a signal mask");
});

test("C2i-F3: a journal (or SRC) that fails to decode refuses recovery instead of escaping the handler", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  const ji = src.indexOf("JOURNAL UNREADABLE");
  const before = src.slice(ji - 900, ji);
  assert.ok(/except \(OSError, UnicodeDecodeError\)/.test(before),
    "C2i-F3: reading the journal must catch UnicodeDecodeError (malformed UTF-8 is a ValueError — it escaped the OSError-only handler and skipped the refusal-path dist destroy)");
  const si = src.indexOf("SRC UNREADABLE");
  assert.ok(/except \(OSError, UnicodeDecodeError\)/.test(src.slice(si - 400, si)),
    "C2i-F3 belt: the SRC read while a journal is armed must catch UnicodeDecodeError too");
});

test("C2i-F4: the final rebuild runs OUTSIDE the signal mask (interrupts stay responsive), with the pre-delete inside", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  const lines = src.split("\n");
  const wi = src.lastIndexOf("with _spawn_atomic():");
  assert.ok(wi > 0, "the finally signal mask must exist (C2h-F2)");
  const maskLine = src.slice(0, wi).split("\n").length - 1; // 0-based line of the mask
  const gi = lines.findIndex(l => l === "        if pristine_rebuild_needed:");
  const ci = lines.findIndex((l, i) => i > gi && gi >= 0
    && l === "            final_rebuild_failed = not _final_rebuild_pristine()");
  assert.ok(gi >= 0, "the rebuild guard sits at the finally level (8 spaces) — the mask body is closed before it runs");
  assert.ok(ci === gi + 1, "the rebuild call sits directly under its guard at 12 spaces");
  assert.ok(ci > maskLine, "the rebuild line comes after the mask opened earlier in the finally");
  // Between the mask line and the guard, the rebuild NEED is
  // recorded inside the masked body, but no CALL executes there.
  const between = src.slice(wi, src.indexOf(lines[gi] ?? ""));
  assert.ok(between.includes("pristine_rebuild_needed = True"),
    "the masked body records the rebuild NEED without running the build");
  const callLines = between.split("\n").filter(l =>
    !l.trimStart().startsWith("#") && l.includes("_final_rebuild_pristine()"));
  assert.equal(callLines.length, 0,
    "C2i-F4: the build must NOT be invoked inside the masked body (only outside, unmasked)");
  // The interrupt re-raise also stays OUTSIDE the mask body (8-space
  // if at the finally level), so a deferred signal fires at unmask.
  const reIdx = lines.findIndex((l, i) => i > gi && l === "        if _interrupted is not None:");
  assert.ok(reIdx > ci, "the re-raise check sits at the finally level, after the rebuild");
  // Safety of running unmasked: the masked body pre-destroys DIST
  // durably (C2j-F1) BEFORE recording the need, so a deferred signal
  // firing at unmask can only ever leave a MISSING dist (loud) or
  // this build's partial pristine emit — never the last mutant.
  const fi = src.indexOf("def _final_rebuild_pristine");
  const fin = src.slice(fi, fi + 2500);
  assert.ok(fin.includes("_destroy_suspect_dist(") && fin.includes("ok = build(durable=True)")
    && fin.indexOf("_destroy_suspect_dist(") < fin.indexOf("ok = build(durable=True)"),
    "the durable pre-delete (C2f-F1/C2j-F2) is what makes the unmasked rebuild safe");
  // C2j-F1: the pre-destroy sits INSIDE the masked body, before the
  // flag — otherwise a deferred interrupt exits over the mutant dist.
  const preIdx = between.lastIndexOf("_destroy_suspect_dist(");
  const flagIdx = between.lastIndexOf("pristine_rebuild_needed = True");
  assert.ok(preIdx >= 0 && preIdx < flagIdx,
    "C2j-F1: the masked body must durably destroy DIST BEFORE recording pristine_rebuild_needed — a signal deferred by the mask fires at unmask, before any unmasked pre-delete could run");
});

test("C2j-F2: a successful final rebuild is made DURABLE (artifact + dir fsync) before it may be trusted", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  // C2l-F1: the proof moved INSIDE build(durable=True) — pin it there.
  const bi = src.indexOf("def build(");
  assert.ok(bi >= 0);
  const bfn = src.slice(bi, bi + 3200);
  assert.ok(bfn.includes("os.fsync(fh.fileno())"),
    "C2j-F2: the emitted artifact must be fsynced — the atexit journal clear may not follow a page-cache-only build");
  const fsyncIdx = bfn.indexOf("os.fsync(fh.fileno())");
  assert.ok(bfn.indexOf("_fsync_dir(os.path.dirname(DIST)", fsyncIdx) > fsyncIdx,
    "C2j-F2: the dist parent directory must be fsynced after the artifact (the NEW directory entry is what must survive)");
  assert.ok(bfn.lastIndexOf("return True") > fsyncIdx,
    "C2j-F2: success may only be returned AFTER the durability proof (the only True-return in build() follows the fsyncs)");
  assert.ok(bfn.includes("DURABILITY FAILED"),
    "C2j-F2: a failed durability proof is fail-CLOSED — the unproven artifact must be destroyed by the caller, never trusted with the journal");
  // The caller still destroys fail-closed: the finally in
  // _final_rebuild_pristine covers the durable-False return.
  const fi = src.indexOf("def _final_rebuild_pristine");
  const fin = src.slice(fi, fi + 3400);
  assert.ok(fin.includes("build(durable=True)"),
    "C2l-F1: the final rebuild must request the IN-BUILD durability proof");
  assert.ok(fin.includes("finally:") && fin.indexOf("_destroy_suspect_dist(", fin.indexOf("finally:")) > fin.indexOf("finally:"),
    "C2l-F1: a durable=False return (failed build OR failed proof) destroys inside the finally");
});

test("C2h-F4: registry-refusal paths destroy the suspect dist before returning", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  const ai = src.indexOf("MUTANT REGISTRY AUDIT FAILED");
  assert.ok(ai >= 0);
  const auditRegion = src.slice(ai, ai + 1100);
  assert.ok(auditRegion.includes("_destroy_suspect_dist("),
    "C2h-F4: an unaudited-registry refusal must destroy a possibly mutant-compiled dist before exiting");
  assert.ok(auditRegion.includes("_acquire_sweep_lock()")
    && auditRegion.indexOf("_acquire_sweep_lock()") < auditRegion.indexOf("_destroy_suspect_dist("),
    "C2i-F2: the refusal destroy must happen ONLY after the sweep lock is held — a live sweep may own dist/");
  const dup = src.indexOf("DUPLICATE MUTANT NAMES");
  assert.ok(dup >= 0);
  const dupRegion = src.slice(dup, dup + 700);
  assert.ok(dupRegion.includes("_destroy_suspect_dist("),
    "C2h-F4: a duplicate-names refusal must destroy the suspect dist too — every sweep-start refusal path gets the same hygiene as the C2g-F3 recovery-refusal path");
  assert.ok(dupRegion.includes("_acquire_sweep_lock()")
    && dupRegion.indexOf("_acquire_sweep_lock()") < dupRegion.indexOf("_destroy_suspect_dist("),
    "C2i-F2: same lock-first rule on the duplicate-names refusal path");
});

test("C2e-F2: per-suite membership must partition the full baseline-green set", () => {
  // Overlapping claims (same test claimed by the hung AND a clean suite):
  const overlap = drive("hang", {
    base_tap: ["ok 1 - alpha", "ok 2 - beta", "# fail 0"],
    suite_green: { suite0: ["alpha"], suite1: ["alpha"] },
    suites: [
      { tap: [], timed_out: true },
      { tap: ["ok 1 - alpha", "# fail 0"] },
    ],
  });
  assert.equal(overlap["attributed"], false,
    "overlapping membership must void hang attribution");
  // Uncovered baseline-green name (beta belongs to no suite):
  const uncovered = drive("hang", {
    base_tap: ["ok 1 - alpha", "ok 2 - beta", "# fail 0"],
    suite_green: { suite0: ["beta"], suite1: [] },
    suites: [
      { tap: [], timed_out: true },
      { tap: ["ok 1 - alpha", "# fail 0"] },
    ],
  });
  assert.equal(uncovered["attributed"], false,
    "a baseline-green name claimed by no suite must void attribution");
  // Positive control: a true partition still attributes.
  const okCase = drive("hang", {
    base_tap: ["ok 1 - alpha", "ok 2 - beta", "# fail 0"],
    suite_green: { suite0: ["beta"], suite1: ["alpha"] },
    suites: [
      { tap: [], timed_out: true },
      { tap: ["ok 1 - alpha", "# fail 0"] },
    ],
  });
  assert.equal(okCase["attributed"], true, "a true partition still attributes");
});

test("C2e-F3: a '# fail N' summary contradicting observed red lines is refused", () => {
  const r = drive("sweep", {
    base_tap: ["ok 1 - alpha", "ok 2 - beta", "# fail 0"],
    tap: ["ok 1 - alpha", "not ok 2 - beta", "# fail 7"],
    rc: 1,
  });
  assert.notEqual(r["status"], "killed",
    "'1 observed failure but # fail 7' is self-contradictory — never a kill");
  assert.equal(r["status"], "run-error");
  // Agreement still kills.
  const agree = drive("sweep", {
    base_tap: ["ok 1 - alpha", "ok 2 - beta", "# fail 0"],
    tap: ["ok 1 - alpha", "not ok 2 - beta", "# fail 1"],
    rc: 1,
  });
  assert.equal(agree["status"], "killed", "agreeing summary still credits the kill");
});

test("the real sweep registry is duplicate-free and the gates mention the fixes", () => {
  // Registry health of the REAL file (the driver audits synthetic
  // sources; the real one is pinned here so a copy-pasted duplicate
  // MUTS name fails CI, not the sweep).
  const out = execFileSync(
    "python3",
    ["-c",
      "import importlib.util,json;" +
      `spec=importlib.util.spec_from_file_location('fm', ${JSON.stringify(SWEEP)});` +
      "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);" +
      "print(json.dumps(m._mutant_name_dupes()))",
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.deepEqual(JSON.parse(out), [], "duplicate MUTANT NAMES in findings-mutate.py");

  const src = fs.readFileSync(SWEEP, "utf8");
  for (const needle of [
    "def judge_run(",
    "def judge_hang(",
    "class _spawn_atomic",
    "def _journal_recover(",
    "def attribution_green(",
    "def new_skip_drift(",
  ]) {
    assert.ok(src.includes(needle), `expected ${needle} in findings-mutate.py`);
  }
});

test("C2k-F3/C2l-F1: the durability proof is inside build() — no gap between 'built' and 'proven'", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  const bi = src.indexOf("def build(");
  assert.ok(bi >= 0);
  const bfn = src.slice(bi, bi + 3200);
  const proofIdx = bfn.indexOf("os.fsync(fh.fileno())");
  assert.ok(proofIdx > 0,
    "C2l-F1: the durability proof lives INSIDE build(durable=True), not after it returns");
  const withIdx = bfn.lastIndexOf("with _spawn_atomic():", proofIdx);
  assert.ok(withIdx >= 0,
    "C2k-F3: the durability proof must run inside a _spawn_atomic() signal mask");
  assert.ok(bfn.lastIndexOf("return True") > proofIdx,
    "C2l-F1: the ONLY path to True passes through the masked proof — a signal cannot land between 'build succeeded' and 'proof started', because they are one call");
  assert.ok(bfn.includes("durable: bool = False") && bfn.includes("if durable:"),
    "C2l-F1: the proof is opt-in per call site (mutant builds need no proof; the recovery rebuild demands one)");
  const fin = src.slice(src.indexOf("def _final_rebuild_pristine"), src.indexOf("def build("));
  assert.ok(!fin.includes("os.fsync(fh.fileno())"),
    "C2l-F1: NO post-build fsync may remain in _final_rebuild_pristine — a second, maskless proof reopens the escaped gap");
});

test("C2k-F1: the journal header binds a content digest, not just a length", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  const wi = src.indexOf("def _journal_write");
  const wr = src.slice(wi, wi + 2200);
  assert.ok(wr.includes("hashlib.sha256(body_bytes).hexdigest()"),
    "C2k-F1: the write path must commit to a sha256 of the body bytes");
  const si = src.indexOf("def _journal_split");
  const sp = src.slice(si, si + 2200);
  assert.ok(sp.includes("hashlib.sha256(body.encode(\"utf-8\")).hexdigest() == digest"),
    "C2k-F1: the read path must VERIFY the digest before accepting the body");
  const lenIdx = sp.indexOf("len(body.encode(\"utf-8\")) != declared");
  const digIdx = sp.indexOf(".hexdigest() == digest");
  assert.ok(lenIdx >= 0 && digIdx > lenIdx,
    "C2k-F1: BOTH the length and the digest gate the body (either alone is bypassable)");
});

test("C2n-F1: the dist destroy is pessimistic — a logging failure can never skip the delete or clear the flag", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-fmut-c2n1-"));
  try {
    const r = drive("destroy_print_abort", { dir });
    assert.equal(r["ok_under_broken_stdout"], true,
      "C2n-F1: a raising print (closed stdout) must not abort the destroy — the delete still succeeds");
    assert.equal(r["artifact_gone"], true,
      "C2n-F1: the mutant artifact must be GONE even when every log line fails");
    assert.equal(r["flag_cleared_on_success"], true,
      "C2n-F1: durable absence under broken logging is still a proven destroy (flag cleared legitimately)");
    assert.equal(r["retry_absent_ok"], true,
      "C2n-F1: the already-absent retry branch stays durable-success under broken logging");
    assert.equal(r["armed_on_midway_abort"], true,
      "C2n-F1: an abort INSIDE the destroy finds the flag already armed (set on ENTRY) — the journal cannot be cleared over a half-done destroy");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const src = fs.readFileSync(SWEEP, "utf8");
  const hi = src.indexOf("def _destroy_suspect_dist");
  const helper = src.slice(hi, hi + 3200);
  const flagIdx = helper.indexOf("_DIST_STILL_SUSPECT = True");
  const printIdx = helper.indexOf("_safe_print(");
  assert.ok(flagIdx >= 0 && printIdx >= 0 && flagIdx < printIdx,
    "C2n-F1: the ENTRY pessimism (_DIST_STILL_SUSPECT = True) must run BEFORE the first log call");
  const body = helper.slice(helper.indexOf('"""', helper.indexOf('"""') + 3) + 3);
  assert.ok(!/^\s*print\(/m.test(body),
    "C2n-F1: no bare print( may remain in the destroy body — every log goes through _safe_print");
});

test("C2o-F2: _journal_recover logs only through _safe_print — a broken stdout must not convert a journal refusal (JournalRecoverFailed/JournalCorrupt, both handled by main's refusal path with its dist destroy) into an uncaught BrokenPipeError that skips the dead sweep's mutant-dist cleanup", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  const start = src.indexOf("def _journal_recover(");
  const end = src.indexOf("class JournalCorrupt(Exception):");
  assert.ok(start > 0 && end > start, "the function boundaries must exist");
  const body = src.slice(start, end);
  const bare = body.match(/(?<!_safe_)(?<!\w)print\(/g) || [];
  assert.equal(bare.length, 0,
    "C2o-F2: every log in _journal_recover precedes a refusal raise — all must be _safe_print(, found " + bare.length + " bare print(");
});

test("C2o-F1: the outer finally's failure-path logs are _safe_print — BrokenPipeError from FINAL RESTORE FAILED/INTERRUPTED used to abort the finally body before _destroy_suspect_dist ran, letting atexit clear the journal over a live mutant dist; the same rule covers the reaped-line, FINAL REBUILD FAILED, the recovery-refusal line, the lock-busy refusals and RESTORE FAILED", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  for (const msg of [
    '_safe_print(f"FINAL RESTORE FAILED',
    '_safe_print(f"FINAL RESTORE INTERRUPTED',
    '_safe_print(f"reaped {n}',
    '_safe_print("FINAL REBUILD FAILED',
    '_safe_print(f"JOURNAL RECOVERY FAILED',
    '_safe_print("SWEEP LOCK BUSY',
    '_safe_print("RESTORE FAILED',
  ]) {
    assert.ok(src.includes(msg), `${msg} — safety-critical log must go through _safe_print`);
  }
  // And the region from the restore attempt to the interrupt re-raise
  // contains NO bare print at all.
  const a = src.indexOf("FINAL RESTORE FAILED");
  const b = src.indexOf("raise _interrupted");
  assert.ok(a > 0 && b > a, "finally-region boundaries must exist");
  const region = src.slice(a - 200, b);
  const bare = region.match(/(?<!_safe_)(?<!\w)print\(/g) || [];
  assert.equal(bare.length, 0,
    "C2o-F1: no bare print( may sit between the final restore and the interrupt re-raise, found " + bare.length);
});

test("C2p-F1 (systemic): every log on a REFUSAL/FAILURE path is _safe_print — a bare print before a refusal return/raise (lock acquisition, dist destroy, journal decision) lets BrokenPipeError skip the cleanup. Pinned as an ALLOW-LIST: any bare print( outside this list fails; the list is only informational success-path output (plus _safe_print's own two calls).", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  const lines = src.split("\n");
  const allow = new Set([
    "        print(msg)",                              // inside _safe_print itself
    "            print(msg, file=sys.stderr)",         // inside _safe_print's fallback
    '    print("== PRISTINE BASELINE ==")',            // informational header
    '    print(f"baseline green: {len(r.executed)} executed tests, 0 failures"',
    '        print(f"  {n:26s} {r}")',
    '    print("ALL MUTANTS KILLED (baseline green, every kill attributed)"',
  ]);
  const offenders: string[] = [];
  lines.forEach((ln, i) => {
    if (/(?<!_safe_)(?<![\w.])print\(/.test(ln) && !allow.has(ln)) {
      offenders.push(`${i + 1}: ${ln.trim()}`);
    }
  });
  assert.deepEqual(offenders, [],
    "C2p-F1: bare print( outside the informational allow-list — safety-critical logs must use _safe_print:\\n" + offenders.join("\\n"));
  // Positive: the cycle-15 refusal logs are converted.
  for (const msg of ['_safe_print("MUTANT REGISTRY AUDIT FAILED',
                    '_safe_print("NO MUTANTS SELECTED',
                    '_safe_print(f"FINAL REBUILD DURABILITY FAILED',
                    '_safe_print("BASELINE BUILD FAILED',
                    '_safe_print("BASELINE REFUSED']) {
    assert.ok(src.includes(msg), `refusal log must be _safe_print: ${msg}`);
  }
});

test("C2q-F1: the registry audit fails closed on UnicodeDecodeError — a source that becomes malformed UTF-8 AFTER the module loaded must return None (refusal), not raise past main()'s refusal path", () => {
  // The fixture execs VALID source, then the on-disk file is
  // overwritten with malformed UTF-8 before _mutant_name_dupes()
  // re-reads __file__ — the byte-rotated-checkout shape from the
  // finding. Pre-fix: UnicodeDecodeError escaped the except tuple.
  const valid = "MUTS = {'a': ('x','y'), 'b': ('z','w')}\n";
  const corrupt = "MUTS = {'a': ('\u00ff\u00fe\u0000bad','y')}\n"; // invalid UTF-8 bytes
  const b64 = Buffer.from(Buffer.from(corrupt, "latin1")).toString("base64");
  const r = drive("registry", { src: valid, corrupt_b64: b64 });
  assert.equal(r["dupes"], null,
    `C2q-F1: undecodable source must audit to None (fail-closed refusal), got ${JSON.stringify(r)}`);
  // The same fixture WITHOUT corruption still audits normally.
  const ok = drive("registry", { src: valid });
  assert.deepEqual(ok["dupes"], []);

  // Source pin: the handler must name the error class (a broadened
  // bare `except:` or OSError-only would drift silently).
  const src = fs.readFileSync(SWEEP, "utf8");
  const hi = src.indexOf("def _mutant_name_dupes");
  const body = src.slice(hi, hi + 2600);
  assert.ok(/except \(OSError, SyntaxError, UnicodeDecodeError\)/.test(body),
    "C2q-F1: the audit's except clause must include UnicodeDecodeError");
});

test("C2q-F2: the snapshot/journal/restore chain is BYTE-PRESERVING — a CRLF source round-trips through journal write+recover, _write_durable and the atexit restore hook with its \\r\\n intact (universal-newline translation used to rewrite the whole file to LF)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2q-crlf-"));
  try {
    const r = drive("crlf_roundtrip", { dir });
    for (const k of ["snapshot_exact", "recover_clean_ok",
      "mutant_applied_crlf_intact", "recovered_dirty",
      "recovered_byte_exact", "durable_write_byte_exact",
      "hook_restore_byte_exact", "hook_no_failure",
      "hook_fastpath_no_rewrite", "multiline_snippet_adapted"] as const) {
      assert.equal(r[k], true, `C2q-F2: ${k} must be true, got ${JSON.stringify(r)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Source pins: every text-mode open of SRC / the journal / the
  // restore path must carry newline="" — translation in either
  // direction breaks the byte contract the digest is declared over.
  const src = fs.readFileSync(SWEEP, "utf8");
  const opens = src.split("\n").filter((ln, i, all) => {
    const t = ln.trim();
    if (!/(open\(|fdopen\()/.test(t)) return false;
    if (t.startsWith("#")) return false;
    if (/subprocess|Popen|"rb"|"wb"|\.encode|__file__/.test(t)) return false;
    // text-mode opens on src/journal paths:
    return /SRC|_SRC_RESTORE|fdopen|open\(j[,)]/.test(t) && !/"rb"/.test(t);
  });
  const unguarded = opens.filter((ln) => !ln.includes('newline=""'));
  assert.deepEqual(unguarded, [],
    "C2q-F2: text-mode src/journal opens must set newline=\"\":\\n" +
    unguarded.map((l) => l.trim()).join("\\n"));
  assert.ok(opens.length >= 8,
    `C2q-F2: the pin must actually see the chain (found ${opens.length} guarded opens — did opens move?)`);
});

test("C2r-F1: the atexit journal clear fsyncs the journal's PARENT DIR — a resurrected journal after power loss must never clobber post-sweep edits", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  const hi = src.indexOf("def _journal_clear(");
  assert.ok(hi >= 0);
  const body = src.slice(hi, hi + 1700);
  // C2s-F1 restructured the clear (pending-flag retry), so the pin
  // checks the contract pieces rather than adjacency.
  assert.ok(/os\.remove\(_journal_path\(\)\)/.test(body),
    "C2r-F1: the clear must unlink the journal");
  assert.ok(/_fsync_dir\(os\.path\.dirname\(_journal_path\(\)\)\)/.test(body),
    "C2r-F1: _journal_clear must dir-fsync after the unlink (same contract as the recovery paths) — otherwise the journal can RESURRECT after power loss and the next sweep overwrites newer source with the stale snapshot");
  // The FileNotFoundError path may stay bare: nothing was removed.
});

test("C2r-F2: multi-line LF registry snippets are ADAPTED to a CRLF checkout — before the fix, 26/65 registry entries PATCH-MISSED on a CRLF source (silent sweep degradation)", () => {
  const src = fs.readFileSync(SWEEP, "utf8");
  const hi = src.indexOf("for name in names:");
  const loop = src.slice(hi, hi + 1000);
  assert.ok(/if "\\n" in old and old not in orig and "\\r\\n" in orig:/.test(loop),
    "C2r-F2: the apply loop must adapt LF snippets to the file's CRLF endings before counting");
  assert.ok(/old = old\.replace\("\\n", "\\r\\n"\)/.test(loop) &&
    /new = new\.replace\("\\n", "\\r\\n"\)/.test(loop),
    "C2r-F2: the adaptation must rewrite BOTH sides of the pair");

  // Behavioral: drive the REAL registry against a CRLF copy of SRC —
  // every multi-line old-snippet must find its target after adaptation.
  const crlf = drive("crlf_registry", { sweep: SWEEP });
  assert.ok((crlf["registry_size"] as number) >= 60,
    `C2r-F2: probe must see the full registry, got ${JSON.stringify(crlf)}`);
  assert.equal(crlf["all_adapted"], true,
    `C2r-F2: on a CRLF checkout every registry snippet must find its target after adaptation; unfixable: ${JSON.stringify(crlf["misses"])}`);
});

test("C2s-F1/C2u-F1: the atexit clear NEVER swallows an unfinished clear and NEVER re-arms an ARMED record after completion — a failed verification re-read completes via the DONE marker (an ARMED record is restorable: it would clobber later user edits)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2s-clear-"));
  try {
    const r = drive("clear_durability", { dir });
    for (const k of ["normal_clear_still_works",
      "verify_read_fail_completes_done", "verify_read_fail_edit_survives",
      "hook_normal_clear_works"] as const) {
      assert.equal(r[k], true, `C2s-F1: ${k} must be true, got ${JSON.stringify(r)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Pin: the hook must never re-arm (that was the C2t-era fix that
  // C2u-F1 showed writes a stale RESTORABLE record after a
  // completed sweep), must never swallow quietly, and must complete
  // through _journal_clear() (the DONE-marker path) in its OSError
  // branch.
  const src = fs.readFileSync(SWEEP, "utf8");
  const hi = src.indexOf("def _journal_clear_hook");
  const hookEnd = src.indexOf("\ndef ", hi + 10);
  const hook = src.slice(hi, hookEnd > 0 ? hookEnd : hi + 4200);
  assert.ok(!/except OSError:\s*\n\s*pass/.test(hook),
    "C2s-F1: the clear hook's OSError branch must not pass");
  assert.ok(!/_journal_write\(/.test(hook),
    "C2u-F1: the hook must NEVER write an ARMED journal — after completion only the DONE marker is legal (ARMED means restorable)");
  const bei = hook.indexOf("except OSError as e:");
  assert.ok(bei >= 0 && hook.slice(bei).includes("_journal_clear()"),
    "C2u-F1: the verify-read failure branch must complete via the DONE-marker clear");
});

test("C2u-F2: a stale PID-named journal tmp (SIGKILL + PID reuse) must not poison future journal writes — the writer unlinks its own stale tmp and retries (O_EXCL EEXIST before replace would silently strand ARMED records)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2u-f2-"));
  try {
    const r = drive("clear_durability", { dir });
    for (const k of ["stale_tmp_write_survives", "stale_tmp_dirty_recover",
      "stale_tmp_done_not_armed", "stale_tmp_edit_safe"] as const) {
      assert.equal(r[k], true, `C2u-F2: ${k} must be true, got ${JSON.stringify(r)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Pin: _journal_write_body must catch the O_EXCL collision and
  // retry after removing OUR pid's stale tmp.
  const src = fs.readFileSync(SWEEP, "utf8");
  const wi = src.indexOf("def _journal_write_body");
  const body = src.slice(wi, wi + 3000);
  assert.ok(/except FileExistsError:/.test(body),
    "C2u-F2: the tmp create must handle the stale-tmp EEXIST collision");
  const fe = body.indexOf("except FileExistsError:");
  assert.ok(/os\.remove\(tmp\)/.test(body.slice(fe))
    && /os\.open\(tmp, os\.O_WRONLY \| os\.O_CREAT \| os\.O_EXCL/.test(body.slice(fe)),
    "C2u-F2: the collision handler must unlink our-own-stale tmp and retry the exclusive create exactly once");
});

test("C2t-F1: the journal's completion is an ATOMIC DONE MARKER — a power-loss-resurrected journal from a COMPLETED sweep must never restore and clobber post-sweep edits (bare unlink traded resurrection for clobbering; DONE is neither)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2t-f1-"));
  try {
    const r = drive("clear_durability", { dir });
    for (const k of ["stale_done_never_restores",
      "post_edit_survives_resurrection", "stale_marker_removed",
      "armed_dirty_recovers", "dirty_src_restored"] as const) {
      assert.equal(r[k], true, `C2t-F1: ${k} must be true, got ${JSON.stringify(r)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Pin: recovery must special-case the DONE body BEFORE any
  // restore logic, and the clear must go through the marker.
  const src = fs.readFileSync(SWEEP, "utf8");
  const rec = src.slice(src.indexOf("def _journal_recover"), src.indexOf("def _journal_recover") + 13400);
  assert.ok(/if body == _JOURNAL_DONE_TAG:/.test(rec),
    "C2t-F1: recovery must never restore a DONE marker's body (a completed sweep's record is stale by definition)");
  const doneIdx = rec.indexOf("if body == _JOURNAL_DONE_TAG:");
  const restoreIdx = rec.indexOf('with open(SRC, "w"');
  assert.ok(doneIdx >= 0 && restoreIdx >= 0 && doneIdx < restoreIdx,
    "C2t-F1: the DONE check must come BEFORE the restore write");
  const clr = src.slice(src.indexOf("def _journal_clear("), src.indexOf("def _journal_clear(") + 1400);
  assert.ok(/_journal_mark_done\(\)/.test(clr),
    "C2t-F1: _journal_clear must complete via the DONE marker, not a bare removal of the ARMED record");
});

test("C2t-F2: DONE-mark durability failures are handled by BRANCH, not uniformly — the match branch refuses (authoritative open record), the post-restore branch completes anyway (recovery already durable), and residual ARMED bodies always match-clear safely", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2t-f2-"));
  try {
    const r = drive("clear_durability", { dir });
    for (const k of ["dirty_branch_eio_recovers_anyway",
      "dirty_branch_eio_src_restored", "dirty_branch_eio_journal_remains",
      "dirty_branch_eio_next_matchclears",
      "match_branch_eio_refuses", "match_branch_eio_src_intact",
      "match_branch_eio_journal_kept", "match_branch_healthy_clears"] as const) {
      assert.equal(r[k], true, `C2t-F2: ${k} must be true, got ${JSON.stringify(r)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Pin: the match branch RAISES on a DONE-mark failure (it must
  // not sweep under an unclosable record); the restore branch does
  // NOT raise (the recovery is already durable).
  const src = fs.readFileSync(SWEEP, "utf8");
  const rec = src.slice(src.indexOf("def _journal_recover"), src.indexOf("def _journal_recover") + 13400);
  const marks = [...rec.matchAll(/_journal_mark_done\(\)/g)];
  assert.equal(marks.length, 2,
    "C2t-F2: both completion branches must use the DONE marker");
  const m0 = marks[0]!, m1 = marks[1]!;
  const between = rec.slice(m0.index, m1.index + 1200);
  assert.ok(/raise JournalRecoverFailed\(\) from None/.test(between),
    "C2t-F2: the match branch must refuse the sweep when the record cannot be closed");
  const after = rec.slice(m1.index, m1.index + 1200);
  assert.ok(!/except OSError[\s\S]{0,600}?raise JournalRecoverFailed/.test(after),
    "C2t-F2: the post-restore branch must NOT throw away a completed durable recovery over an unclosable record");
});

test("C2t-F3: a SIGTERM-shaped SystemExit during the DONE-mark must leave disk state match-clear safe (ARMED record survives, never a half-replaced journal) and must propagate, not be swallowed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2t-f3-"));
  try {
    const r = drive("clear_durability", { dir });
    for (const k of ["sigterm_during_mark_propagates",
      "sigterm_state_matchclear_safe", "sigterm_src_intact"] as const) {
      assert.equal(r[k], true, `C2t-F3: ${k} must be true, got ${JSON.stringify(r)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Pin: _journal_clear must catch BaseException, report, and
  // RE-RAISE (signals keep their exit semantics; the ARMED journal
  // survives because the atomic replace never ran).
  const src = fs.readFileSync(SWEEP, "utf8");
  const clr = src.slice(src.indexOf("def _journal_clear("), src.indexOf("def _journal_clear(") + 1400);
  assert.ok(/except BaseException as e:/.test(clr),
    "C2t-F3: the DONE-mark must guard signals too (OSError-only lets SystemExit skip the honest report)");
  const bei = clr.indexOf("except BaseException");
  assert.ok(/^\s*raise\s*$/m.test(clr.slice(bei)),
    "C2t-F3: the BaseException branch must re-raise — swallowing signals at clear time breaks exit semantics");
});

test("C2v-F1: a REAL SIGTERM delivered inside the ARMED->DONE completion must stay pending (completion finishes, marker lands), the exit keeps its semantics, and a destructive restore preserves the divergent source bytes first (no clobber window may survive)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2v-f1-"));
  try {
    const r = drive("clear_durability", { dir });
    for (const k of ["sigterm_in_completion_not_armed",
      "sigterm_edit_survives", "divergent_bytes_preserved_on_restore"] as const) {
      assert.equal(r[k], true, `C2v-F1: ${k} must be true, got ${JSON.stringify(r)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Pin: all three completion sites block SIGINT/SIGTERM across the
  // transition (mask before the DONE-mark, restore after it).
  const src = fs.readFileSync(SWEEP, "utf8");
  const blocks = (src.match(/_block_termination_signals\(\)\n/g) || []).length;
  assert.ok(blocks >= 3,
    `C2v-F1: every completion transition (clear / match / dirty-restore) must mask termination signals, found ${blocks}`);
  const restores = (src.match(/finally:[\s\S]{0,450}_restore_signal_mask\(_sig_old\)/g) || []).length;
  assert.ok(restores >= blocks,
    "C2v-F1: every block must be paired with an unmask in a finally (raise paths included) — a leaked mask would make the process deaf to SIGTERM for its whole lifetime");
  // Pin: the restore is preceded by the divergent-bytes preservation.
  const rec = src.slice(src.indexOf("def _journal_recover("));
  const pres = rec.indexOf("_preserve_divergent_src()");
  const wr = rec.indexOf('with open(SRC, "w"');
  assert.ok(pres >= 0 && wr >= 0 && pres < wr,
    "C2v-F1: the CURRENT (divergent) source bytes must be preserved BEFORE the destructive restore write");
});

test("flake-ledger lead 2: FLAKY-NOT-KILLED must NAME the flake — the sweep-run assertion text is extracted from the failing test's TAP block (only the named test, terminated at '...', empty when absent)", () => {
  const tap = [
    "TAP version 14",
    "# Subtest: test A",
    "not ok 1 - test A",
    "  ---",
    "  failureType: 'testCodeFailure'",
    "  error: 'A: expected true'",
    "  ...",
    "# Subtest: test B",
    "not ok 2 - test B",
    "  ---",
    "  error: 'B: expected false'",
    "  stack: |-",
    "    stack body must not appear",
    "  ...",
    "# fail 2",
  ];
  const b = drive("failure_digest", { tap, target: "test B" });
  assert.equal(b.digest, "error: 'B: expected false'",
    "flake-ledger: the digest carries the NAMED failing test's assertion line only");
  const a = drive("failure_digest", { tap, target: "test A" });
  assert.ok(!String(a.digest).includes("B:") && String(a.digest).includes("A: expected true"),
    "flake-ledger: extraction is scoped to the requested test (a sibling's error must not leak in)");
  const none = drive("failure_digest", { tap: ["ok 1 - test A", "# fail 0"], target: "test A" });
  assert.equal(none.digest, "",
    "flake-ledger: no failing block -> empty digest (best-effort, never a fabricated line)");
  // The FLAKY-NOT-KILLED report must APPEND the digest (the message
  // template is the contract; a refactor that drops it re-blinds us).
  const sweep = fs.readFileSync(SWEEP, "utf8");
  assert.ok(/FLAKY-NOT-KILLED[\s\S]{0,300}\[sweep-run: \{fdig\}\]/.test(sweep),
    "flake-ledger: the flaky verdict line must carry the sweep-run digest");
});

test("C2w-F3: an unexpected exception (KeyboardInterrupt) escaping the DONE-mark must restore the caller's signal mask on EVERY completion path — a leaked mask makes the process deaf to SIGINT/SIGTERM for its lifetime", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2w-f3-"));
  try {
    const r = drive("clear_durability", { dir });
    assert.equal(r["ki_escape_restores_signal_mask"], true,
      "C2w-F3: match / dirty-restore / clear paths must all unmask when an injected KeyboardInterrupt escapes the mark, and the exception must still propagate");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Pin: every block site's unmask sits in a `finally` (control-flow
  // pairing the block-count comparison cannot prove).
  const src = fs.readFileSync(SWEEP, "utf8");
  const blockRe = /_sig_old = _block_termination_signals\(\)\n\s*try:/g;
  const sites = (src.match(blockRe) || []).length;
  assert.ok(sites >= 3,
    `C2w-F3: each masked completion must be block+try (found ${sites})`);
  const maskedRegions = src.split("_sig_old = _block_termination_signals();").slice(1)
    .map((r) => r.slice(0, 2400));
  assert.ok(maskedRegions.every((r) => /finally:[\s\S]{0,450}_restore_signal_mask\(_sig_old\)/.test(r)),
    "C2w-F3: every mask site must unmask in a finally (raise paths included) — not on selected branches");
});
