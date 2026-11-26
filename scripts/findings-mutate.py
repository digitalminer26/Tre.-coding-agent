#!/usr/bin/env python3
"""Findings-module mutation audit (g1s3 cycle-7, extended g1s4-c7;
g1s6-c2 audit fix 3: baseline + attribution contract;
g1s7-F3 audit: TAP attribution integrity — see judge()).

Revert each intake guard individually; the findings test suites MUST fail
(every guard needs a test pinning it). A SURVIVOR is an unguarded code
path — treat it like a red test.

KILL ATTRIBUTION CONTRACT (audit g1s6-c2 finding 3 — "the gate can
report false kills"): "ALL MUTANTS KILLED" is only meaningful on top of
a GREEN PRISTINE BASELINE and only when each kill is ATTRIBUTED to the
mutant:

  1. PRISTINE BASELINE FIRST. Before any mutant runs, the pristine
     source is built and ALL suites are run. Unless the baseline is
     green (0 failures, every test line individually green, exit 0,
     no timeout) the sweep ABORTS with exit 1 — a pre-existing failure
     would otherwise be attributed to every mutant as a free kill.
  2. PER-KILL ATTRIBUTION. A mutant's kill is only counted for tests
     that were GREEN IN BASELINE (the baseline is per-test, not just
     aggregate) AND reproduce: the first new failing test is re-run IN
     ISOLATION (`--test-name-pattern`) and must fail again. A mutant
     whose failures are all baseline-failures or none of which
     reproduce is NOT a kill (FLAKY-NOT-KILLED).
  3. HANGS ARE ATTRIBUTED OR NOTHING. A suite timeout used to be
     auto-tagged `KILLED(hang)`. Node 20's runner buffers a test FILE's
     TAP until the file finishes, so a deadlocked child yields no
     per-test stream to name the spinner from. A timeout is therefore
     only a kill when it can be ATTRIBUTED by suite: each suite file is
     re-run individually (same deadline) — EXACTLY one must hang, every
     other must complete green, and the hung suite must be entirely
     baseline-green. Anything else is UNATTRIBUTED-HANG — a FAILED
     verdict, not a kill. The same integrity rules apply to those
     per-suite reruns: a rerun with ambiguous duplicate lines or a
     baseline-green test that SKIPPED (SKIP-DRIFT) voids the hang
     attribution (g1s7-F3 audit fix 3).

TAP ATTRIBUTION INTEGRITY (g1s7-F3 + audit fixes 1-2): test names are
the attribution keys, so the parser distrusts them where TAP allows
ambiguity — duplicate names with conflicting status (AMBIGUOUS-TAP,
hard refusal in baseline AND mutant runs), and "# SKIP/TODO" lines that
say "ok" but never executed (excluded from the green-attribution set;
baseline-green tests that SKIP under a mutant yield SKIP-DRIFT, never
a kill or a silent SURVIVED). The rules live in judge_run()/judge_hang()
and are unit-pinned by test/findings-mutate.test.ts with synthetic TAP.

BUILD/TYPE ERRORS ARE NOT KILLS (g1s5-c1 audit finding 2): `tsc` reports
type errors but STILL EMITS JavaScript, so a mutant that fails typecheck
still runs its tests. The old script counted any tsc failure as
"KILLED(type)" — which masked a real survivor (receipt-bind-off: the
type error was inside the mutant, the emitted JS behaved, and 0 tests
failed). The kill criterion is now BEHAVIORAL: the emitted JS must fail
a test. A "[tsc-error]" tag is printed for the record (a non-type-clean
mutant is sloppy — prefer patches that compile), but the verdict comes
from the tests.

Self-contained (g1s4 audit fix F5): the pristine source is read from
src/findings/intake.ts into MEMORY at start and restored from memory
after every mutant — there is deliberately no .bak file, because a stale
backup snapshot would silently revert live edits when the audit finished.

Suites covered (all of them, per mutant — a guard may be pinned by any
suite): dist/test/findings-intake.test.js, findings-intake-probes.test.js,
findings-records.test.js, findings-s5log.test.js.

Usage:  python3 scripts/findings-mutate.py [name-substr ...]
Exit:   0 = baseline green + all killed, 1 = baseline red / survivors /
        patch-misses / unattributed hangs.

Execution hygiene (laptop-CPU incident, post-audit): every test run is a
child in its OWN process group and a timed-out run SIGKILLs the whole
group — a deadlocked mutant grandchild must never be leaked as an
orphan spinner. After the sweep exits (success OR crash), any surviving
`node --test` descendant of this script is reaped in the finally block.
Spawn+tracking is signal-atomic (SIGINT/SIGTERM blocked between Popen
and ACTIVE_CHILDREN registration, g1s7-F3 audit fix 3).

Source-restore honesty (g1s7-F3 audit fix 4): SIGTERM/SIGINT handlers
and atexit cover every Python-reachable exit, but SIGKILL (and power
loss) runs NO cleanup — "always restores pristine source" would be a
lie. Instead, pristine bytes are journalled to a fixed tmp path before
ANY mutant is applied, and the NEXT sweep start recovers src/ from a
leftover journal. Worst case after SIGKILL: a dirty tree until the
next sweep, never forever.

ACCEPTED RESIDUAL RISKS (g1s7-C2w audit — deliberately NOT fixed; the
cycle was closed here after 12 rounds of hardening, these are the two
known limitations, accepted on the record):

  C2w-F1 (power-loss window on the BACKUP layer only): before a
  destructive recovery restore, the divergent current bytes are saved
  to <journal>.pre-recover.<pid> (file fsynced). If fsyncing the
  BACKUP'S PARENT DIRECTORY fails, the restore proceeds anyway
  (warned): refusing would regress the C2t-F2 contract that a
  fsync-dir fault never undoes a completed durable recovery. On power
  loss in that window the backup's DIRECTORY ENTRY may not survive —
  the divergent bytes are then lost. The journal contract itself is
  unaffected (the snapshot restore remains durable; no ARMED record
  is stranded; nothing is clobbered that this layer did not already
  warn about). Risk accepted: it needs power loss within one fsync
  window of a recovery that itself only happens after a SIGKILL.

  C2w-F2 (backup overwrite under PID reuse): the backup name is
  PID-keyed and a pre-existing name is treated as our own SIGKILLed
  leftover (remove + rewrite). With PID reuse INSIDE the 7-day
  retention, a new recovery can overwrite an OLD backup — possibly
  the only retained copy of earlier user edits. Accepted: it
  requires a recovery to run again with the same PID within 7 days
  while the previous recovery's printed backup path was never read;
  recoveries print the path, backups are 7-day-reaped by design.

  Everything else on the completion paths (signal atomicity of
  ARMED->DONE->removed, mask pairing via try/finally on every exit —
  g1s7-C2v-F1 / C2w-F3, journal durability ordering) is pinned by
  test/findings-mutate.test.ts and exercised by the real-signal
  driver probes (scripts/findings-mutate-driver.py clear_durability).

FLAKE LEDGER (pre-existing, TS-side, tracked — do not re-hunt blindly):
'g1s6-c2 MAJOR-2: two PROCESSES appending one journal' intermittently
fails in FULL SWEEP runs (seen under auditor-vocab-off and
artifact-cap-off, different mutants each time) but NEVER in isolation
— ~100 stress runs incl. 72-way parallel and 8x CPU-load contention,
zero reproductions. The sweep's isolation gate correctly refuses to
credit such a kill (FLAKY-NOT-KILLED), so a flake shows as a RED
sweep, not a silent pass. Leads, in order: (1) the fence refuses a
contended append after JOURNAL_LOCK_TIMEOUT_MS=2000ms — under full
sweep load both children could exceed it, making the test's
refusals>=2 floor fail while every record stays whole (the child
asserts k.code==0 first, so a refused child is 'child failed');
(2) capture the failing assertion's message in the sweep's isolation
rerun instead of discarding it, so the NEXT occurrence names itself.
A red sweep that is exactly this test = rerun once; two consecutive
reds = chase lead (2). CI: .github/workflows/ci.yml.
"""
from __future__ import annotations

import ast
import errno
import hashlib
import os
import re
import signal
import subprocess
import sys
import threading
import time

SRC = "src/findings/intake.ts"
# g6-F5 (audit cycle 1): the compiled output of the module under test —
# every mutant's build must EMIT this file with the mutation present,
# or the mutant was never actually exercised (a failed/stale build must
# never be silently tested as if it were the mutant).
DIST = "dist/src/findings/intake.js"
SUITES = [
    "dist/test/findings-intake.test.js",
    "dist/test/findings-intake-probes.test.js",
    "dist/test/findings-records.test.js",
    "dist/test/findings-s5log.test.js",
]

# Pristine findings runs in ~6 s; 120 s is a hang detector, not a slow
# pass (g6). Streaming keeps partial output even after SIGKILL.
RUN_TIMEOUT_S = 120
BUILD_TIMEOUT_S = 180  # tsc wedged is also a leaked-spinner hazard

MUTS = {
    "auditor-envelope-off": ("  if (env.length > 0) {", "  if (false) {"),
    "foreign-episode-off": ("  if (act.episodeId !== episodeId) {", "  if (false) {"),
    "payload-shape-off": ("  if (!okPayload) throw new MalformedOwnerActError", "  if (false) throw new MalformedOwnerActError"),
    "spool-absent-off": ('  if (spool.state === "absent") {', '  if (false) {'),
    "spool-mismatch-off": ('  if (spool.state === "mismatch") {', '  if (false) {'),
    # g1s4-c7: two "if (vf.length > 0)" sites exist (auditor stage 4.5 +
    # owner stage 9) — anchor long enough to hit the OWNER path only. The
    # auditor path has its own mutant below ("auditor-vocab-off").
    "vocab-owner-off": (
        "const vf = vocabValidate(h);\n  if (vf.length > 0) {",
        "const vf = vocabValidate(h);\n  if (false) {"),
    "claim-equal-off": ("  if (!claimEqual(hClaim as string, payload.claim)) {", "  if (false) {"),
    "cure-identity-off": ("    if (cureAct === undefined) {", "    if (false) {"),
    "corr-bad-target-off": ("      target === undefined ||\n      !closedRejectedRefuted(prefix, correctionOf)", "      false"),
    "corr-ambiguity-off": ("    if (sibling !== undefined) {", "    if (false) {"),
    "corr-severity-off": ("    if (SEVERITY_RANK[proposedSeverity] < SEVERITY_RANK[target.severity]) {", "  if (false) {"),
    "corr-route-off": ("    if (proposedRoute !== target.route) {", "    if (false) {"),
    # g1s5-c1 C1-F1: the old g1s3-c7 note claiming stage-9 reproWireShapeOk
    # was an equivalent mutant ("stage 4 vocabValidate calls the SAME
    # predicate") was FALSE — vocabValidate checks only repro.kind
    # membership, while reproWireShapeOk additionally requires the three
    # operand strings (and non-empty ones unless kind:"none"). A header
    # with a closed kind and missing/empty/non-string operands passes
    # vocab and is refused ONLY by this guard — so it is reachable and
    # MUST be mutated. Killed by the repro-wire-shape test (minor severity
    # so the NDR-b floor cannot cover for it).
    "repro-shape-off": ("  if (!reproWireShapeOk(repro)) {", "  if (false) {"),
    # g1s5-c1 (C1b): entry-mode actor guards — two of three mutated.
    # The supervisor-derived guard (`mode === "supervisor-derived" &&
    # actor !== "supervisor"`) is a PROVABLY EQUIVALENT mutant: with it
    # removed, an auditor-endpoint presenting supervisor-derived is
    # still refused by the auditor guard (mode !== "auditor-intake"),
    # an owner-cli by the owner guard (mode !== "owner-act"), and the
    # supervisor actor passes it trivially — no input changes outcome.
    # Kept in source as defense-in-depth; not mutant-able with a kill.
    "entrymode-audoff-off": (
        '  if (actor === "auditor-endpoint" && mode !== "auditor-intake") return null;',
        "  /* mutant */"),
    "entrymode-owncli-off": (
        '  if (actor === "owner-cli" && mode !== "owner-act") return null;',
        "  /* mutant */"),
    # g1s5-c1 (C1b): NDR-t(2) route×surface pairing guard in
    # vocabValidate — pinned by the ndr-t(2) test, previously unmutated.
    "vocab-rtxsurface-off": (
        "    if (!isRouteSurfaceValid(h[\"route\"] as Route, h[\"surface\"] as Surface)) {",
        "    if (false) {"),
    # g1s5-c1 (C1b): vocab's repro-must-be-object guard — removal shifts
    # the malformed-input diagnostic to stage 9's finding-intake-invalid
    # (behavior change: field-level vocab failure disappears); pinned by
    # the ndr-t bad-repro tests.
    "vocab-repro-object-off": (
        "  if (repro === null || typeof repro !== \"object\") {\n    fails.push({ field: \"repro\", value: repro, closedSet: [\"<object>\"] });\n  } else {",
        "  if (false) {\n    fails.push({ field: \"repro\", value: repro, closedSet: [\"<object>\"] });\n  } else {"),
    "repro-floor-off": ("  if (!isFindingReproSatisfied({ severity, repro })) {", "  if (false) {"),
    "mint-collision-off": ("  if (taken.has(id)) {", "  if (false) {"),
    # g1s5-c1 finding D2: mintFindingId has TWO guards — the collision
    # refusal above AND the conforming-shape refusal below. Only the
    # collision line had a mutant; a shape-guard revert (accept
    # "not-an-ulid") was unmutated. The shape guard IS pinned (the
    # ndr-a/R7 test injects a non-conforming mint and asserts the
    # throw), so this mutant dies. NOTE (call-site equivalence): the
    # four mintFindingId CALL SITES (gate journal, filing refusal,
    # filing applied, auditor applied) cannot be mutants-with-kills —
    # replacing the call with plain mintUlid() there is behaviorally
    # IDENTICAL (the default mint is mintUlid and the guard operates
    # on its output); a seam to inject a deterministic mint per call
    # site does not exist and building one would be test-only API
    # surface. Pinned at the primitive, which is the single choke
    # point all four sites flow through.
    "mint-shape-off": ("  if (!isUlid(id)) {", "  if (false) {"),
    "embed-lossless-off": ('    if (Buffer.from(s, "utf8").equals(draftBytes)) return s;', "    return s;"),
    "prefixlines-len-off": ("  if (input.prefixLines.length !== prefix.length) {", "  if (false) {"),
    # ---- g1s4-c7: mutants for the round-2 guard additions ----
    "evidence-distinct-floor-off": (
        "      !e.every((x, i, arr) => arr.indexOf(x) === i)) {",
        "      !e.every(() => true)) {"),
    # g1s5-c1 (C2-F1): the old replacement `true)` made the whole
    # condition ALWAYS refuse (killed by every happy-path filing test —
    # the wrong reason: it tested always-refuse, not distinct-off).
    # Now correctly disables ONLY the distinctness disjunct: `false)`.
    # Killed by the g1s4-c3 duplicate-evidenceRefs test (owner path).
    "evidence-distinct-owner-off": (
        "      !(h[\"evidenceRefs\"] as unknown[]).every(\n        (x, i, arr) => (arr as unknown[]).indexOf(x) === i,\n      )) {",
        "      false) {"),
    "originref-shape-off": (
        '    fails.push("originRef");',
        "    /* mutant */;"),
    "ts-stamp-off": (
        "    ts: input.now,",
        "    ts: candidate.ts,"),
    "auditor-vocab-off": (
        "  if (vf.length > 0) {\n    throw new IntakeInputError(\n      `auditor submission fails the closed vocabulary:",
        "  if (false) {\n    throw new IntakeInputError(\n      `auditor submission fails the closed vocabulary:"),
    "auditor-mode-off": (
        '  if (mode !== "auditor-intake") {',
        "  if (false) {"),
    "receipt-bind-off": (
        "      candidate.originRef.receiptId !== input.receiptId) {",
        "      false) {"),
    "schema-floor-off": ("  if (floor.length > 0) {", "  if (false) {"),
    "artifact-cap-off": ("  if (opts.artifactBytes.length > DRAFT_CAP_BYTES) {", "  if (false) {"),
    "artifact-empty-off": ("  if (opts.artifactBytes.length === 0) {", "  if (false) {"),
    # g1s5-c1 finding 3: revert syncDirEntry to swallow-ALL open errors
    # (the pre-fix behavior) — the syncdir-fault-throws test must kill it.
    # (The fsync-side narrowing is defense-in-depth: no portable way to
    # fault ONLY the fsync of an openable dir, so it stays unmutated.)
    "syncdir-swallow-all-off": (
        "    if (isDirFsyncPlatformRefusal(e)) return;",
        "    return; /* mutant: swallow-all (pre-fix) */"),
    # g1s5-c3 (C3-F1): re-wrap spoolPath's hex validation inside the
    # io-catch — the bad-digest IntakeInputError gets laundered into a
    # retryable SpoolIoError. Killed by spool-a-bad-digest-input-channel.
    "readspool-validate-in-catch-off": (
        "  const p = spoolPath(episodeDir, draftSha256);\n  let raw: Buffer;\n  try {\n    raw = readFileSync(p);",
        "  let raw: Buffer;\n  try {\n    raw = readFileSync(spoolPath(episodeDir, draftSha256));"),
    # g1s5-c4: ENOTDIR back into the platform-refusal set (C4-F1) —
    # killed by the C4-F1 broken-path-component test.
    "enotdir-platform-refusal-on": (
        '  return code === "EINVAL" || code === "ENOTSUP" || code === "ENOSYS" || code === "EPERM" || code === "EISDIR";',
        '  return code === "EINVAL" || code === "ENOTSUP" || code === "ENOSYS" || code === "EPERM" || code === "EISDIR" || code === "ENOTDIR";'),
    # g1s5-c4: gate error message extraction back to the raw cast (C4-F2)
    # — killed by the C4-F2 non-Error-throw journaling test.
    "gate-error-raw-cast-off": (
        "    gateError = describeIoError(e);",
        "    gateError = (e as Error).message;"),
    # g1s5-c4: drop the content-consistency loop (C4-F3) — killed by the
    # C4-F3 equal-length-divergent test.
    "prefix-content-check-off": (
        "    const claimed = prefix[i] as PrefixRecord;",
        "    const claimed = (JSON.parse(line) ?? {}) as PrefixRecord; /* mutant: always agrees */"),
    # g1s6 (audit F2): full-record equality back to IDENTITY-only —
    # same id/kind, different op/key-set passes. Killed by the
    # g1s6-F2 same-identity-divergent-fields test.
    "prefix-identity-only-off": (
        "    if (!deepEqualJson(parsed, claimed)) {",
        "    if (parsed === null || typeof parsed !== \"object\" || (parsed as { id?: unknown }).id !== claimed.id || (parsed as { kind?: unknown }).kind !== claimed.kind) {"),
    # g1s6 (audit F1): reuse-path read back to the raw call — the
    # EACCES fault escapes the intake untyped. Killed by
    # g1s6-F1 spool-reuse-unreadable-spoolio. The fsync side of the
    # reuse durability block is the documented unmutateable floor
    # (same reasoning as syncDirEntry's fsync side — no portable way
    # to fault ONLY the fsync of an openable file).
    "spool-reuse-read-raw-off": (
        "      let prior: Buffer;\n      try {\n        prior = readFileSync(p);\n      } catch (e2) {\n        throw spoolIoWrapping(\n          e2,\n          `spoolDraft: existing entry ${path.basename(p)} could not be read for dedup comparison: `,\n        );\n      }",
        "      const prior = readFileSync(p); /* mutant: raw read, untyped fault escape */"),
    # ================= g6 (audit cycle 1) ===========================
    # g6-F3: single-call write (the pre-fix primitive) — a SHORT write
    # return then acks a PREFIX. Killed behaviorally by the g6-F3 seam
    # probe (2-chunk short write -> file must still be complete).
    "write-once-off": (
        "  let offset = 0;\n  while (offset < buf.length) {\n    const written = seamWrite(fd, buf, offset);\n    if (written <= 0) {\n      throw new SpoolIoError(`writeSync made no progress at offset ${offset} of ${buf.length} bytes — never acked`);\n    }\n    offset += written;\n  }",
        "  seamWrite(fd, buf); /* mutant: pre-fix single writeSync, short write acked */"),
    # g6-F3 half 2: the zero-progress guard removal must not hang the
    # suite — the probe asserts the injected 0-return THROWS SpoolIoError;
    # with the guard off the loop spins, and the streamed timeout is
    # ATTRIBUTED to the probe test (audit g1s6-c2 fix 3).
    "write-progress-guard-off": (
        "    if (written <= 0) {\n      throw new SpoolIoError(`writeSync made no progress at offset ${offset} of ${buf.length} bytes — never acked`);\n    }",
        "    if (written < 0) { /* mutant: 0-progress tolerated */ }"),
    # g7-F3: syncDirEntry's close-fault tracking removed (fault
    # swallowed) — platform-refused fsync + throwing close dies
    # silently. Killed by the g7-F3 dir close-fault probe.
    "syncdir-close-raw-off": (
        "    try {\n      seamClose(dirFd);\n    } catch (ce) {\n      closeFault = ce;\n      hadCloseFault = true;\n    }",
        "    try {\n      seamClose(dirFd);\n    } catch (ce) {\n      /* mutant: close fault swallowed (g6-F3 silent) */\n    }"),
    # g6-F2: journal closeChecked removal — journal close fault escapes.
    "journal-closechecked-off": (
        "    jPrimary = closeChecked(jfd, jPrimary, jHadErr); // g6-F2",
        "    closeSync(jfd); // mutant: bare close (pre-fix), raw escape + masking"),
    # g6-F2: owner artifact closeChecked removal.
    "owner-artifact-closechecked-off": (
        "      aPrimary = closeChecked(fd, aPrimary, aHadErr); // g6-F2\n    }\n    if (aHadErr) {\n      if (aPrimary instanceof SpoolIoError) throw aPrimary;\n      throw spoolIoWrapping(\n        aPrimary,\n        `finding artifact write failed — admission NEVER acked: `,\n      );",
        "      closeSync(fd); // mutant: bare close under finally\n    }\n    if (aHadErr) {\n      if (aPrimary instanceof SpoolIoError) throw aPrimary;\n      throw spoolIoWrapping(\n        aPrimary,\n        `finding artifact write failed — admission NEVER acked: `,\n      );"),
    # g6-F2: auditor artifact closeChecked removal.
    "auditor-artifact-closechecked-off": (
        "      aPrimary = closeChecked(fd, aPrimary, aHadErr); // g6-F2\n    }\n    if (aHadErr) {\n      if (aPrimary instanceof SpoolIoError) throw aPrimary;\n      throw spoolIoWrapping(\n        aPrimary,\n        `auditor artifact write failed — admission NEVER acked: `,\n      );",
        "      closeSync(fd); // mutant: bare close under finally\n    }\n    if (aHadErr) {\n      if (aPrimary instanceof SpoolIoError) throw aPrimary;\n      throw spoolIoWrapping(\n        aPrimary,\n        `auditor artifact write failed — admission NEVER acked: `,\n      );"),
    # g6-F2 (cause chain): the outer wrap silently DROPS the primary
    # fault (message only, no cause) — the retry layer loses the
    # identifiable fault. Killed by the g6-F2+F5 cause-chain probes.
    "wrap-cause-drop-owner-off": (
        "      throw spoolIoWrapping(\n        aPrimary,\n        `finding artifact write failed — admission NEVER acked: `,\n      );",
        "      throw new SpoolIoError(`finding artifact write failed — admission NEVER acked: ${describeIoError(aPrimary)}`);"),
    "wrap-cause-drop-spool-off": (
        "    throw spoolIoWrapping(\n      wPrimary,\n      `spoolDraft: write/fsync of the new entry failed — never acked undurable: `,\n    );",
        "    throw new SpoolIoError(`spoolDraft: write/fsync of the new entry failed — never acked undurable: ${describeIoError(wPrimary)}`);"),
    # g6-F1: parent syncs back OFF (the pre-fix visibility-conditional
    # collapsed to "skip when the dir existed" — the existsSync test is
    # gone, so removal of the line is the faithful revert). Killed by
    # the fsync-observer probes (existing-dir spool, owner artifact,
    # auditor artifact, gate journal).
    "f1-parent-sync-off-spool-reuse": (
        "      syncPathChain(dirPath);\n      return sha; // verified existing entry reused (content-addressing dedup)",
        "      syncDirEntry(dirPath); // mutant: chain walk skipped (g7-F2 truncate)\n      return sha; // verified existing entry reused (content-addressing dedup)"),
    "f1-parent-sync-off-spool-new": (
        "  syncPathChain(dirPath);\n  return sha;\n}",
        "  syncDirEntry(dirPath); // mutant: chain walk skipped\n  return sha;\n}"),
    "f1-parent-sync-off-journal": (
        "  syncPathChain(dirPath); // MAJOR-9 + g7-F2: full chain, not dir + one parent",
        "  syncDirEntry(dirPath); // mutant: chain walk skipped"),
    "f1-parent-sync-off-owner": (
        "        `finding artifact write failed — admission NEVER acked: `,\n      );\n    }\n    syncPathChain(artDir); // MAJOR-9 + g7-F2: full chain before ack",
        "        `finding artifact write failed — admission NEVER acked: `,\n      );\n    }\n    syncDirEntry(artDir); // mutant: chain walk skipped"),
    "f1-parent-sync-off-auditor": (
        "        `auditor artifact write failed — admission NEVER acked: `,\n      );\n    }\n    syncPathChain(artDir); // MAJOR-9 + g7-F2: full chain before ack",
        "        `auditor artifact write failed — admission NEVER acked: `,\n      );\n    }\n    syncDirEntry(artDir); // mutant: chain walk skipped"),
    # g7-F2: the chain walk truncates at the TARGET directory (the
    # pre-g7 shape only reached one parent; stopping entirely at the
    # target loses every ancestor name too). Killed by the observer
    # probes (parent/ancestor inode must appear in the fsync set).
    "chain-walk-truncate-off": (
        "    syncDirEntry(d);\n    const parent = path.dirname(d);\n    if (parent === d) break; // reached the filesystem root",
        "    syncDirEntry(d);\n    break; // mutant: chain walk truncated at the target"),
    # g6-F1 (Terra): torn-tail detection forced OFF — a retry appends
    # behind a partial record (unreadable merged line). Killed by the
    # torn-journal quarantine probe.
    "torn-tail-detect-off": (
        "    endsWithNewline = last[0] === 0x0a;",
        "    endsWithNewline = true; // mutant: torn tail never detected"),
    # g1s6-c2 MAJOR-2: the cross-process single-writer fence skipped
    # entirely — an unguarded tail-check/append. Killed by the live-
    # holder REFUSAL probe and the two-process race probe.
    "journal-lock-acquire-off": (
        "  const fence = acquireJournalLock(journalPath);",
        "  const fence = { lockPath: \"\", holderId: \"\" } as JournalFenceToken; // mutant: acquire skipped"),
    # g1s6-c2 MAJOR-2: the fence is taken but NEVER released — the
    # next writer starves/timeouts and the leak is observable. Killed
    # by the stale-takeover probe (fence-leak assert) and the
    # two-process probe (post-run leak assert).
    "journal-lock-release-off": (
        "  try {\n    unlinkSync(token.lockPath);\n  } catch (e) {",
        "  try {\n    void token; // mutant: fence never released\n  } catch (e) {"),
    # g1s6-c2 MINOR-4: attachDeepestCause reverts to CLOBBERING an
    # occupied non-Error/cyclic cause slot. Killed by the MINOR-4
    # non-Error-cause and cyclic-chain probes.
    "cause-slot-overwrite-old": (
        "      // non-Error tail or cycle: the slot is OCCUPIED — attaching here\n      // would overwrite it (MINOR-4: evidence destruction, not a\n      // silent attach point). Refuse; the compound path keeps both.\n      return false;",
        "      // mutant: old blind attach point — overwrites the occupied slot\n      break;"),
    # g1s6-c2 MINOR-4: the compound drops the closeCause own-property
    # — the close fault survives only as message text. Killed by the
    # frozen-primary and non-Error/cyclic MINOR-4 probes.
    "closecause-prop-off": (
        "        Object.defineProperty(compound, \"closeCause\", {",
        "        Object.defineProperty(compound, \"__dropped\", {"),
    # g1s6-c2 MINOR-6: the hadCloseFault flag stops being set — a
    # fault is recorded but the sentinel (reverted shape) decides.
    # Killed by the null-carrying-close probe.
    "syncdir-hadcloseflag-off": (
        "      closeFault = ce;\n      hadCloseFault = true;",
        "      closeFault = ce; // mutant: sentinel flag never set\n      void hadCloseFault;"),
    # g6: file fsync removals — MAJOR-8 regressions, killed by the
    # fsync-observer probes (the artifact/spool FILE inode must be in
    # the observed set before ack).
    "fsync-off-spool-new": (
        "    writeFully(fd, bytes); // g6-F3: short writes looped, never acked short\n    seamFsync(fd); // durable BEFORE the act append",
        "    writeFully(fd, bytes); /* mutant: no file fsync */"),
    "fsync-off-journal": (
        "      writeFully(jfd, JSON.stringify(journal) + \"\\n\"); // g6-F3\n      seamFsync(jfd);",
        "    writeFully(jfd, JSON.stringify(journal) + \"\\n\"); /* mutant: no file fsync */"),
    "fsync-off-owner": (
        "      writeFully(fd, draftBytes); // g6-F3\n      seamFsync(fd);",
        "      writeFully(fd, draftBytes); /* mutant: no file fsync */"),
    "fsync-off-auditor": (
        "      writeFully(fd, opts.artifactBytes); // g6-F3\n      seamFsync(fd);",
        "      writeFully(fd, opts.artifactBytes); /* mutant: no file fsync */"),
    # seam bypass: production calls the seams directly (pass-through
    # indirection) — a mutant calling the raw syscalls makes the whole
    # observation/fault-injection layer vacuous. Killed by EVERY seam
    # probe (the seam is never reached -> injector/observer asserts).
    "seam-bypass-off": (
        "    const written = seamWrite(fd, buf, offset);",
        "    const written = writeSync(fd, buf, offset); /* mutant: seam bypassed */"),
    # journal append mode "a" -> "w": the SECOND refusal TRUNCATES the
    # journal (durable decision history destroyed). Killed by the
    # two-refusals journal probe.
    "journal-append-mode-off": (
        '    jfd = openSync(journalPath, "a+");',
        '    jfd = openSync(journalPath, "w+"); /* mutant: truncating append */'),
}


# g1s7-C2h-F1: sticky flag — set when a destroy FAILED (DIST may still
# hold mutant JS), cleared on any successful destroy/absent. The atexit
# journal-clear hook refuses to clear a live journal while set.
_DIST_STILL_SUSPECT = False


def _safe_print(msg: str) -> None:
    """g1s7-C2n-F1: logging must NEVER veto a safety-critical path.
    A print on a closed/broken stdout raises BrokenPipeError — in the
    middle of _destroy_suspect_dist that aborted the delete while the
    process continued into the atexit hooks, which then blessed the
    page-cache-pristine source and cleared the journal over a live
    mutant artifact. Progress reporting is best-effort: swallow ANY
    logging failure (even a second try to stderr) — the fs ops that
    follow are what matter."""
    try:
        print(msg)
    except Exception:
        try:
            import sys
            print(msg, file=sys.stderr)
        except Exception:
            pass  # no working log channel; the destroy still runs


def _destroy_suspect_dist(why: str) -> bool:
    """g1s7-C2d-F2 / C2e-F1: DIST is the ONLY artifact compiled from
    (possibly) mutated source — everything else compiles from
    unmutated files. When the final rebuild was withheld OR failed,
    DIST on disk is NOT known-pristine. Deleting it converts a silent
    mutant run into a loud module-not-found; `npm test` and the next
    sweep both rebuild first.

    g1s7-C2h-F1 audit: returns True only when DIST is confirmed absent
    afterwards (removed or already gone). A FAILED deletion returns
    False — callers that are about to remove the recovery marker MUST
    treat that as 'keep the journal armed' and retry on the next
    sweep; silently continuing would clear the only marker while
    mutant JS stays runnable.
    g1s7-C2h-F3 audit: the dist parent directory is fsynced after a
    successful unlink so the DELETION is durable before any later
    journal unlink is trusted (a journal-dir fsync says nothing about
    a dist-dir entry).
    g1s7-C2i-F1 audit: the already-absent branch must NOT skip the
    dir fsync — 'absent in the page cache' is not 'deletion durable'.
    A previous attempt may have unlinked DIST and then FAILED its
    dir fsync; the retry that sees FileNotFoundError used to declare
    success and clear the journal, and a power loss could resurrect
    the mutant artifact with no marker. The dir fsync is idempotent,
    so it runs on BOTH branches: success is now 'absent AND the
    dist-dir entry is proven durable'.
    g1s7-C2i-F4 audit: the whole sequence runs inside a signal mask —
    these are FAST fs ops (no build), and an interrupt landing between
    the unlink and the dir fsync would leave the deletion unproven
    while the sticky flag stays clear (the atexit hook would then
    clear the journal over a resurrectable artifact).

    g1s7-C2n-F1 audit: the destroy is now PESSIMISTIC by
    construction. _DIST_STILL_SUSPECT is set True on ENTRY (before
    any print or fs op), so ANY abort — a BrokenPipeError from the
    progress print on a closed stdout, an interrupt slipping past the
    mask, an unexpected error class — leaves the flag set and the
    journal armed; only a COMPLETED durable destroy may clear it.
    The prints also go through _safe_print: losing a log line to a
    broken pipe must never cancel the safety-critical delete.
    Success semantics are unchanged (return True only when the
    absence is durable); only the default on every abnormal path
    flipped from 'optimistic False' to 'armed'."""
    global _DIST_STILL_SUSPECT
    _DIST_STILL_SUSPECT = True  # C2n-F1: armed until PROVEN otherwise
    _safe_print(f"final dist destroying ({why})")
    with _spawn_atomic():
        try:
            os.remove(DIST)
        except FileNotFoundError:
            pass  # C2i-F1: absent is NOT yet durable — fall into the fsync
        except OSError as e2:
            _DIST_STILL_SUSPECT = True
            _safe_print(f"DIST DESTROY FAILED ({DIST}): {e2} — mutant-compiled "
                        "artifact may remain; run a clean rebuild")
            return False
        try:
            _fsync_dir(os.path.dirname(DIST) or ".")
        except OSError as e:
            # Unlink succeeded (or the file was already gone); the
            # durability proof failed. The file is absent NOW but a
            # rollback could resurrect it — treat as not durable.
            _safe_print(f"DIST DIR FSYNC FAILED: {e} — recovery marker kept")
            _DIST_STILL_SUSPECT = True
            return False
    _DIST_STILL_SUSPECT = False
    _safe_print("dist artifact destroyed — a later test run fails loudly "
                "instead of silently running the last mutant's build")
    return True


def _final_rebuild_pristine() -> bool:
    """g1s7-C2f-F1 audit: the suspect dist must be destroyed BEFORE
    the final build starts. `final_rebuild_failed = not build()` only
    cleans up when build() RETURNS False — a SIGTERM/SIGINT
    SystemExit or an OSError from Popen leaves the finally-block
    before any cleanup runs, with the LAST MUTANT's artifact still
    on disk. Pre-deleting DIST makes every abnormal path safe: after
    the delete, whatever sits there is at most THIS build's partial
    emit from the already-restored pristine source — never the last
    mutant. A failed/raised build destroys again so the survivor is
    at worst a MISSING dist (a loud failure), never stale JS.

    g1s7-C2j-F2 audit: BOTH halves are now durable. The pre-delete
    goes through _destroy_suspect_dist (unlink + dist-dir fsync — a
    bare unlink could be rolled back by a crash and resurrect the
    mutant entry even while a pristine build was 'in progress'), and
    a SUCCESSFUL build fsyncs the emitted artifact and its parent
    directory before returning True: the atexit journal clear only
    ever follows a pristine dist that is actually on platter. A
    durability failure on the fresh artifact is fail-closed — destroy
    (durable) and return False, so the sweep exits 1 loudly instead
    of clearing the journal over a page-cache-only build.

    g1s7-C2l-F1 audit: the durability proof is NOT a separate step
    after build() — it runs inside build(durable=True), masked,
    before build() may return True. A post-build proof leaves a
    gap: a SIGINT/SIGTERM SystemExit landing between build()
    returning and the fsyncs starting sees ok already True (so the
    finally does not destroy) yet the proof never ran — atexit could
    clear the journal over an unproven artifact. With the proof
    inside build(), "returned True" MEANS "proven durable": there is
    no instruction pointer position where the artifact is claimed
    durable but unproven. A durability failure returns False and the
    finally below destroys (durable) exactly like any failed build."""
    if not _destroy_suspect_dist(
            "pre-rebuild safety (C2f-F1/C2j-F2) — durable absence before the pristine build"):
        return False
    ok = False
    try:
        ok = build(durable=True)
    finally:
        if not ok:
            # Covers returned-False AND raised (SystemExit/OSError)
            # AND a failed durability proof (returned False from
            # inside build): the exception keeps propagating
            # untouched after the destroy (the C2a3-F4 contract
            # stays intact).
            _destroy_suspect_dist("final rebuild did not complete successfully")
    return ok


def build(durable: bool = False) -> bool:
    # CONTRACT: every spawned child has a deadline AND is tracked for
    # guaranteed reaping (group-kill) — tsc included; a wedged compiler
    # must not outlive the script either.
    # g1s7-C2l-F1 audit: `durable=True` makes the durability proof part
    # of build() ITSELF (masked, before returning) — "build() returned
    # True" then MEANS "the emitted artifact is on platter". A separate
    # post-build proof always leaves a gap: a SIGINT/SIGTERM SystemExit
    # landing between build() returning and the fsyncs starting escapes
    # both the caller's failure destroy (ok is already True) and the
    # proof itself, and atexit could clear the journal over an
    # unproven artifact. No gap can exist when the proof cannot be
    # skipped between the return and the proof.
    # g1s7-F3 audit fix 3: Popen AND tracking inside one signal-atomic
    # region — no interrupt may land between spawn and registration.
    with _spawn_atomic():
        p = subprocess.Popen(["node_modules/.bin/tsc"], stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True,
                             start_new_session=True)
        ACTIVE_CHILDREN.add(p.pid)
    try:
        p.communicate(timeout=BUILD_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        _kill_group(p.pid)
        try:
            p.communicate(timeout=10)
        except Exception:
            pass
    finally:
        # g1s7-C1-F3 audit: an interrupt (SystemExit from the signal
        # handler) unwinding through communicate() must NOT deregister
        # a LIVE child — kill the group BEFORE discarding the pid, or
        # the atexit reaper can never find it again.
        # g1s7-C2a3-F2 audit: UNCONDITIONAL group kill — tsc's child
        # exiting with a grandchild still in the group must not drop
        # the group uncleaned (dead group => killpg no-op).
        _kill_group(p.pid)
        if p.poll() is None:
            try:
                p.communicate(timeout=10)
            except Exception:
                pass
        ACTIVE_CHILDREN.discard(p.pid)
    if p.returncode != 0:
        return False
    if durable:
        # g1s7-C2l-F1: the proof runs masked, INSIDE build() — a
        # deferred signal fires at unmask over a PROVEN artifact, and
        # no signal can land between "the build succeeded" and "the
        # proof started" because there is no such gap. A platform
        # without pthread_sigmask degrades to unmasked (the sweep
        # lock still serialises writers; the journal re-checks
        # integrity on the next run).
        with _spawn_atomic():
            try:
                with open(DIST, "rb") as fh:
                    os.fsync(fh.fileno())
                _fsync_dir(os.path.dirname(DIST) or ".")
            except OSError as e:
                _safe_print(f"FINAL REBUILD DURABILITY FAILED ({e}) — dist must be "
                      "destroyed by the caller, journal stays armed; the "
                      "sweep exits 1 instead of clearing the journal over "
                      "a page-cache-only build")
                return False
    return True


class RunResult:
    """Outcome of one streamed test run.

    - `lines`: every stdout line received BEFORE the deadline (streamed
      to a pipe by the child; we collect it in a reader thread, so a
      SIGKILL on timeout still leaves the partial TAP we did receive).
    - `timed_out`: the run was killed at RUN_TIMEOUT_S.
    - `rc`: exit code (None while unknown).
    - `results`: {test_name: "ok"|"not ok"} parsed from the TAP.
    - `skipped`: {test_name: directive} for every line carrying a
      "# SKIP/TODO/ONLY" directive (g1s7-F3): a skipped test line is
      emitted as "ok N - name # SKIP ..." — parsed blind it joins the
      GREEN set, so a killing test that a mutant caused to SKIP would
      flip a real kill to SURVIVED without anyone seeing the test
      stopped running. Skip status is kept SEPARATE from results so
      drift (green -> skipped under a mutant) is detectable.
    - `dups`: test names seen MORE THAN ONCE with conflicting status
      (g1s7-F3): the dict would silently overwrite an earlier "not
      ok" with a later "ok" — attribution by name is ambiguous and
      the run's parse is not trustworthy.
    - `fail`: number of "# fail N" (None if the summary never arrived).
    - `fail_conflict`: MORE THAN ONE "# fail N" line with disagreeing
      values (g1s7-C1-F4 audit): two reporters, two stories — the run
      is untrustworthy, never last-wins.
    - `sightings`: {test_name: how many result lines carried it}
      (g1s7-C1-F9 audit): AGREEMENT duplicates still poison
      attribution — when a name ran twice (cross-suite copy-paste or
      renamed nested subtest) a mutant can kill one instance while
      the other passes, and the merged map shows only the survivor.
      Attribution must refuse to credit kills for multi-sighting
      names, exactly like conflicting duplicates.
    - `executed`: names whose line carried NO did-not-run directive
      (g1s7-F3 audit): "ok" WITH "# SKIP"/"# TODO" proves the test
      never ran, so it must never join a green-attribution set even
      though the line says ok. ("# ONLY" ran and asserted — it stays
      executed; its ambiguity is reported separately.)
    """
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.timed_out = False
        self.rc: int | None = None
        self.results: dict[str, str] = {}
        self.skipped: dict[str, str] = {}
        self.dups: list[str] = []
        self.executed: set[str] = set()
        self.fail: int | None = None
        self.fail_conflict = False
        self.sightings: dict[str, int] = {}

    def parse(self) -> None:
        # TAP test-result lines: "ok N - name" / "not ok N - name"
        # (suite-nested test lines have leading "    ").
        # g1s6-c2 FIX: the OLD regex `(.+?)(?: .*)?$` truncated every
        # name at its FIRST space — distinct tests collided on the
        # truncated keys and a later "ok" silently OVERWROTE an
        # earlier "not ok", turning real kills into UNATTRIBUTED-FAIL
        # / FLAKY misclassifications. Capture the FULL name, then
        # strip only a trailing TAP directive (" # SKIP ..." etc).
        # g1s7-F3: the DIRECTIVE is recorded (skip status is not
        # "passed"), and a name whose SECOND sighting disagrees is
        # recorded as an ambiguous duplicate — never silently
        # overwritten.
        self.sightings: dict[str, int] = {}
        for ln in self.lines:
            m = re.match(r"\s*(not ok|ok) \d+ - (.+)$", ln)
            if m:
                full = m.group(2)
                # g1s7-C1-F7 audit: the directive must be a WHOLE WORD
                # ("# SKIPPER" is a test-name fragment, not a SKIP
                # directive). ONLY ran and asserted, BEGIN/END are
                # suite bookkeeping — neither is a did-not-run
                # directive, so neither may join `skipped` (F7: an
                # ONLY-tagged red line was escaping the
                # contradictory-summary check by hiding in `skipped`).
                dm = re.match(r"^(.*?) # (SKIP|TODO|ONLY|BEGIN|END)(?![A-Za-z0-9_])(.*)$",
                              full)
                if dm:
                    name = dm.group(1).rstrip()
                    directive = dm.group(2)
                    status = "ok" if m.group(1) == "ok" else "not ok"
                    if directive in ("SKIP", "TODO"):
                        self.skipped[name] = (directive + dm.group(3)).strip()
                        executed = False  # the test never ran
                    elif directive == "BEGIN" or directive == "END":
                        # Suite bookkeeping, never a test: exclude it
                        # from the attribution map entirely (counting
                        # it as a passing test would inflate the
                        # completeness gate below).
                        continue
                    else:  # ONLY — ran and asserted; ambiguity reported separately
                        executed = True
                else:
                    name = full.rstrip()
                    status = "not ok" if m.group(1) == "not ok" else "ok"
                    executed = True
                self.sightings[name] = self.sightings.get(name, 0) + 1
                if name in self.results and self.results[name] != status:
                    self.dups.append(name)
                    continue  # keep the FIRST sighting — never overwrite
                self.results.setdefault(name, status)
                if executed:
                    self.executed.add(name)
                else:
                    self.executed.discard(name)  # first ran, later skipped? distrust
        # g1s7-C1-F4 audit: MULTIPLE "# fail N" summaries that
        # DISAGREE mean two reporters of one run contradicted each
        # other — the summary is untrustworthy, last-wins was a lie.
        fails = [int(m.group(1)) for m in
                 (re.match(r"# fail (\d+)", ln) for ln in self.lines) if m]
        self.fail = fails[-1] if fails else None
        self.fail_conflict = len(set(fails)) > 1


ACTIVE_CHILDREN: set[int] = set()


def _proc_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by someone else
    except OSError:
        return False


def _kill_group(pid: int) -> None:
    """SIGKILL a child's whole process group (the `node --test` runner
    AND its per-file grandchildren). Falls back to killing just the
    child if the group is already gone or not ours.
    g1s7-C2a3-F2 audit: MUST be called even when the IMMEDIATE child
    has already exited — an exited leader leaves its descendants
    running in the (still-live) group, and dropping the pid without a
    group kill breaks the no-surviving-descendants contract. A dead+
    reaped group simply ProcessLookups and no-ops."""
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
        return
    except OSError:
        pass
    # g1s7-C2a3-F2 audit: every child here is spawned with
    # start_new_session=True, so its PGID EQUALS its PID — and a
    # process GROUP survives (and stays kill-via-killpg) until its
    # LAST member exits, even after the leader was already reaped
    # (os.getpgid() of a reaped pid ESRCHes, which used to short-
    # circuit this into a bare os.kill on a dead pid while the
    # leader's descendants kept spinning). Try the group by number
    # FIRST, then the bare pid as the last resort.
    try:
        os.killpg(pid, signal.SIGKILL)
    except OSError:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def reap_active_children() -> int:
    """Kill every tracked child group still alive. Returns how many were
    reaped. Called from atexit AND the sweep's finally block — a leaked
    `node --test` descendant must never outlive the script that spawned
    it (laptop-CPU incident: deadlocked mutant grandchildren spinning
    after the sweep exited)."""
    reaped = 0
    for pid in sorted(ACTIVE_CHILDREN):
        _kill_group(pid)
        reaped += 1
    ACTIVE_CHILDREN.clear()
    return reaped


import atexit  # noqa: E402  (after the helper it guards)

atexit.register(reap_active_children)

# g1s7-F3: an interrupting signal (SIGTERM from a harness timeout,
# SIGINT from ^C) kills the process WITHOUT running finally/atexit by
# default — a killed sweep left a MUTANT applied to src/ once (found:
# auditor-envelope-off still patched in). Register a default handler
# that exits via SystemExit so the sweep's finally (restore + rebuild)
# and the atexit reaper both run.
_SRC_RESTORE = {"orig": None, "path": None}
_RESTORE_FAILED = False  # g1s7-C1-F2: atexit journal-clear guard


# g1s7-C2a3-F1 audit: tempfile.gettempdir() HONOURS TMPDIR — a sweep
# killed with a mutant applied under TMPDIR=/tmp/a, followed by a run
# under TMPDIR=/tmp/b, finds NO journal AND takes a different lock,
# reading the mutated source as pristine. The journal/lock location
# must be ENVIRONMENT-INDEPENDENT: one fixed root per machine, so the
# crash record is findable no matter what env the next invocation
# carries. Tests may retarget the root by assigning _JOURNAL_ROOT.
_JOURNAL_ROOT = "/tmp"


def _journal_path() -> str:
    """Persistent crash journal for the applied-mutant window.
    g1s7-F3 audit fix 4 (SIGKILL honesty): SIGTERM/SIGINT handlers and
    atexit CANNOT run under SIGKILL — "always restores" was too
    strong. Before ANY mutant is applied, the pristine bytes are
    journalled; the next sweep start recovers from a leftover journal.

    g1s7-C1-F1 audit: the key hashes the ABSOLUTE RESOLVED path of
    SRC (os.path.realpath) — hashing the relative constant made EVERY
    checkout share one journal, so a SIGKILLed sweep in checkout A
    could overwrite checkout B's source with A's content. realpath
    also folds symlinked checkouts onto the same identity.
    g1s7-C1-F1 also demands concurrency control: _acquire_sweep_lock()
    below serialises sweeps over one journal — never two writers."""
    import hashlib
    digest = hashlib.sha1(os.path.realpath(SRC).encode()).hexdigest()[:12]
    return os.path.join(_JOURNAL_ROOT, f"findings-mutate-{digest}.journal")


_JOURNAL_LOCK_FD = None

# g1s7-C2g-F1: production main() sets this True before _journal_recover().
# A sweep process knows any journal it finds was left by a DEAD sweep, so
# dist/ is suspect (the dead sweep may have built the mutant before dying).
# Unit/driver probes leave it False so a probe never deletes the live dist.
_DIST_SUSPECT = False


def _acquire_sweep_lock() -> bool:
    """Exclusive, process-lifetime lock guarding the journal (F1: two
    concurrent sweeps consuming/overwriting one another's journal).
    flock is released by the OS even on SIGKILL, so a dead sweep can
    never hold it. Fail-CLOSED: any error acquiring the lock refuses
    the sweep rather than sharing a journal."""
    global _JOURNAL_LOCK_FD
    import fcntl
    if _JOURNAL_LOCK_FD is not None:
        return True
    fd = None
    try:
        fd = os.open(_journal_path() + ".lock",
                     os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode())
        _JOURNAL_LOCK_FD = fd
        return True
    except (ImportError, OSError):
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        return False


def _journal_recover() -> bool:
    """Restore src/ from a leftover journal (previous sweep died
    between apply and restore). Returns True if a restore happened.
    Called ONCE at sweep start, before arming; a journal whose SRC is
    already pristine just gets cleared.

    g1s7-C1-F8 audit: refuses a RECOVER whose content would be
    partial — the journal carries a length-prefixed integrity header
    written atomically by _journal_write; a body whose length does
    not match the header (torn write under SIGKILL) is QUARANTINED
    (renamed, never applied) and reported as a hard failure (the
    source in the mutant state cannot be trusted).

    g1s7-C2 audit fixes:
      C2-F1: an OSError during recovery (journal unreadable, restore
        write failed) RAISES JournalRecoverFailed instead of the old
        `return False` — returning False means "nothing to recover"
        and main() would read the possibly-mutated source as pristine.
        The journal is PRESERVED on every failure path (never deleted)
        so a retry is possible.
      C2-F3: the corrupt journal is QUARANTINED (renamed aside with
        the pid), never deleted: a sweep that merely refused and left
        must still find the record on the NEXT run. Deleting it made
        the following sweep treat a mutated src/ as pristine.
      C2-F1b: SRC unreadable while a journal exists is NOT "pristine,
        nothing to undo" — restoring a source we cannot even verify
        requires the manual path; raises."""
    j = _journal_path()
    # g1s7-C2a-F1 audit: a QUARANTINE from an earlier refused sweep IS
    # an outstanding recovery — recovery cannot simply "not find j"
    # and bless a possibly-mutated src/. Any leftover corrupt record
    # for this journal hard-refuses until manually handled.
    # g1s7-C2a2-F1 audit: a SEARCHABLE-but-UNLISTABLE journal dir
    # (mode 0111) makes listdir fail with EACCES while stat(j) of a
    # known name still works — swallowing that error hid quarantines
    # and blessed a possibly-mutated src/. Only a genuinely missing
    # dir (ENOENT/ENOTDIR) means "no quarantine can exist"; any other
    # listing error means we CANNOT PROVE it and must refuse.
    try:
        jdir = os.path.dirname(j)
        quars = sorted(f for f in os.listdir(jdir)
                       if f.startswith(os.path.basename(j) + ".corrupt."))
    except (FileNotFoundError, NotADirectoryError):
        quars = []
    except OSError as e:
        _safe_print(f"QUARANTINE SCAN FAILED ({jdir}): {e} — cannot prove no "
              "corrupt journal is pending; sweep refused")
        raise JournalRecoverFailed() from None
    if quars:
        _safe_print(f"QUARANTINED CORRUPT JOURNAL PRESENT ({jdir}): {quars[:3]} — "
              "an earlier sweep died with an unverifiable journal; src/ may "
              "hold a mutant. Restore src/ from git and remove the "
              "quarantine file(s) to clear.")
        raise JournalCorrupt()
    # g1s7-C2a-F4 audit: os.path.exists() swallows EACCES/ENOTDIR on
    # the path walk — an INACCESSIBLE journal is not an ABSENT one.
    # Only ENOENT/ENOTDIR on the final component means "nothing to
    # recover"; any other stat error raises.
    try:
        os.stat(j)
    except (FileNotFoundError, NotADirectoryError):
        return False
    except OSError as e:
        _safe_print(f"JOURNAL STAT FAILED ({j}): {e} — cannot prove there is "
              "nothing to recover; sweep refused")
        raise JournalRecoverFailed() from None
    try:
        try:
            # g1s7-C2q-F2: newline="" — a journal written with CRLF
            # inside the body must read back byte-identically or its
            # declared length/digest would false-quarantine.
            with open(j, encoding="utf-8", newline="") as fh:
                saved = fh.read()
        except (OSError, UnicodeDecodeError) as e:
            # g1s7-C2i-F3 audit: malformed UTF-8 raised UnicodeDecodeError
            # (a ValueError, NOT an OSError) and escaped both this
            # function and main()'s refusal handler — the journal
            # stayed, the refusal-path dist destroy never ran, and the
            # dead sweep's mutant JS remained runnable. Decode errors
            # are deterministic: refusing (journal preserved) retries
            # safely and main() destroys the suspect dist.
            _safe_print(f"JOURNAL UNREADABLE ({j}): {e} — cannot verify src/, "
                  "sweep refused; the journal is preserved for retry")
            raise JournalRecoverFailed() from None
        body, ok = _journal_split(saved)
        if not ok:
            q = f"{j}.corrupt.{os.getpid()}"
            os.replace(j, q)
            _fsync_dir(os.path.dirname(j))  # quarantine durable (C2a3-F3)
            _safe_print(f"JOURNAL CORRUPT ({j}): torn write — quarantined to {q}, "
                  "refusing to restore from partial content; src/ may "
                  "still hold a mutant, restore it from git before the "
                  "next sweep")
            raise JournalCorrupt()
        try:
            # g1s7-C2q-F2: newline="" — byte-exact compare vs body.
            with open(SRC, encoding="utf-8", newline="") as fh:
                cur = fh.read()
        except (OSError, UnicodeDecodeError) as e:
            # C2i-F3 belt: SRC decode failure is just as unverifiable
            # as an unreadable SRC (C2-F1b) — refuse, keep the journal.
            _safe_print(f"SRC UNREADABLE ({SRC}): {e} while journal {j} is armed — "
                  "refusing to proceed on unverifiable source")
            raise JournalRecoverFailed() from None
        if cur == body:
            # g1s7-C2b-F1 audit: matching bytes in the PAGE CACHE are
            # not a durable restore — a power loss after this clear
            # could leave the mutant on disk with no journal. Prove
            # the pristine content is on platter BEFORE removing the
            # recovery record.
            try:
                _fsync_path(SRC)
            except OSError as e:
                _safe_print(f"SRC FSYNC FAILED ({SRC}): {e} — journal kept armed; "
                      "cannot prove the matching content is durable")
                raise JournalRecoverFailed() from None
            # g1s7-C2g-F1 audit: SRC matching the journal body says
            # nothing about dist/ — the dead sweep may have BUILT a
            # mutant and restored src/ before dying, leaving mutant
            # JS runnable with a journal that now "matches". Destroy
            # the suspect artifact BEFORE unlinking the journal (the
            # C2a3-F3 durable-before-disappear rule): a crash in the
            # window leaves the journal armed, so the next sweep
            # re-runs this (idempotent) destroy; a crash the other
            # way had no marker at all while mutant JS stayed live.
            # g1s7-C2h-F1 audit: if the destroy FAILED (or its dir
            # fsync did), mutant JS is still runnable — clearing the
            # marker now would hide it forever, so refuse the sweep
            # and keep the journal armed for retry.
            if _DIST_SUSPECT and not _destroy_suspect_dist(
                    "crash-recovery journal seen — dist may hold the dead sweep's last mutant build"):
                _safe_print("recovery refuses to clear the journal: the suspect dist could not be destroyed")
                raise JournalRecoverFailed()
            # g1s7-C2t-F2 audit: never a bare unlink here either — an
            # unproven removal resurrects the ARMED record, whose
            # snapshot may be stale by the time it resurfaces. The
            # completion is an atomic ARMED->DONE replace (durability
            # proven by the replace's own dir fsync); removing the
            # DONE marker afterwards is best-effort — a lingering or
            # RESURRECTED DONE marker is harmless (never restored).
            _sig_old = _block_termination_signals()
            try:
                try:
                    _journal_mark_done()
                except OSError as e:
                    # Refuse, do not proceed: an ARMED record we could not
                    # close is an AUTHORITATIVE record — continuing the
                    # sweep would run mutations under an open record whose
                    # completion cannot be proven.
                    _safe_print(f"JOURNAL DONE-MARK FAILED in match-clear ({e}) — "
                          "sweep refused; the ARMED journal's snapshot equals "
                          "the current (verified-matching) source, so nothing "
                          "is lost — retry once the fs can persist")
                    raise JournalRecoverFailed() from None
                try:
                    os.remove(j)
                    _fsync_dir(os.path.dirname(j))
                except OSError:
                    pass  # lingering DONE marker is harmless (never restored)
            finally:
                # g1s7-C2w-F3: unmask on EVERY exit — including an
                # unexpected exception (KeyboardInterrupt, injected
                # SystemExit, a fault from _journal_mark_done itself).
                # A manual unmask per raise-path cannot prove pairing;
                # a leaked mask makes the caller deaf to SIGTERM.
                _restore_signal_mask(_sig_old)
            return False
        # g1s7-C2t-F1 audit: the DONE marker is the ONLY legal
        # content that must never be restored. A DONE journal (or a
        # power-loss-resurrected one) belongs to a COMPLETED sweep —
        # its age makes any restore blind clobbering, so it is
        # removed, never applied — even if src/ meanwhile differs.
        if body == _JOURNAL_DONE_TAG:
            try:
                os.remove(j)
                _fsync_dir(os.path.dirname(j))
            except OSError as e:
                _safe_print(f"DONE-MARKER REMOVAL FAILED ({j}): {e} — harmless, "
                      "a DONE journal is never restored; retry later")
            _safe_print(f"STALE DONE MARKER {j} (completed sweep) — removed; "
                  "nothing to recover")
            return False
        # g1s7-C2a3-F3 audit ordering rule: the RESTORED source must
        # be durable BEFORE the journal disappears — remove-then-crash
        # used to leave (no journal) + (mutant still on disk if the
        # restore had not hit platter). fsync first, then unlink.
        # g1s7-C2v-F1: the divergent CURRENT bytes are preserved
        # first (a restore is destructive and ARMED cannot tell a
        # user edit from a leftover mutant), then the termination
        # signals are blocked across restore->DONE so no catchable
        # signal strands an ARMED record over a completed restore.
        try:
            _preserve_divergent_src()
        except OSError as e:
            _safe_print(f"PRE-RECOVER BACKUP FAILED ({SRC}): {e} — refusing "
                  "the destructive restore; the journal stays armed")
            raise JournalRecoverFailed() from None
        _sig_old = _block_termination_signals()
        try:
            try:
                # g1s7-C2q-F2: newline="" — restore the journalled bytes.
                with open(SRC, "w", encoding="utf-8", newline="") as fh:
                    fh.write(body)
                    fh.flush()
                    os.fsync(fh.fileno())
            except OSError as e:
                _safe_print(f"RESTORE WRITE FAILED ({SRC}): {e} — journal {j} kept "
                      "armed; src/ may still hold a mutant")
                raise JournalRecoverFailed() from None
            # g1s7-C2g-F1 audit: same ordering as the match branch — the
            # suspect dist is destroyed while the journal is still armed
            # (crash-window keeps a recovery marker), and the journal
            # disappears only after it. g1s7-C2h-F1: a failed destroy
            # keeps the journal armed (raise) — the restored SOURCE is
            # durable, but mutant JS without a marker is the exact
            # hazard this ordering exists to prevent.
            if _DIST_SUSPECT and not _destroy_suspect_dist(
                    "crash recovery undid the source — dist may hold the dead sweep's last mutant build"):
                _safe_print("recovery restored the source but refuses to clear the journal: the suspect dist could not be destroyed")
                raise JournalRecoverFailed()
            # g1s7-C2t-F2 audit: same durable completion as the match
            # branch (atomic ARMED->DONE replace; the restored source
            # was already fsynced BEFORE this point — the ordering rule
            # holds: the recovery record disappears only after the
            # restored bytes are durable).
            # g1s7-C2v-F1: the signals blocked before the restore stay
            # blocked across this transition — no catchable SystemExit
            # may strand an ARMED record over a completed restore; the
            # pending signal is delivered at unmask below (exit
            # semantics preserved, journal already in its final state).
            try:
                _journal_mark_done()
            except OSError as e:
                # The SOURCE is already durably restored and matches the
                # snapshot; an un-closeable record re-armed with the SAME
                # body simply match-clears on the next run — refusing
                # here would throw away a completed, durable recovery.
                _safe_print(f"JOURNAL DONE-MARK FAILED after restore ({e}) — the "
                      "recovery is durable (source restored+fsynced); the "
                      "journal's snapshot now equals src/, next sweep "
                      "match-clears it")
            else:
                try:
                    os.remove(j)
                    _fsync_dir(os.path.dirname(j))
                except OSError:
                    pass  # lingering DONE marker is harmless
        finally:
            # g1s7-C2w-F3: unmask on EVERY exit path (normal, raise,
            # and unexpected exception inside mark/destroy) — the mask
            # must never leak to a caller that catches the exception.
            _restore_signal_mask(_sig_old)
        _safe_print(f"RECOVERED {SRC} from crash journal {j} "
              "(a previous sweep died with a mutant applied)")
        return True
    except (JournalCorrupt, JournalRecoverFailed):
        raise
    except OSError as e:
        # Belt: ANY other filesystem error mid-recovery is fatal to the
        # sweep, never the old silent False (C2-F1).
        _safe_print(f"JOURNAL RECOVERY ERROR: {e} — sweep refused")
        raise JournalRecoverFailed() from None


class JournalCorrupt(Exception):
    """Journal body disagrees with its length header (torn write)."""


class JournalRecoverFailed(Exception):
    """Recovery could not be completed or verified; the journal is
    preserved and the sweep must be refused (g1s7-C2-F1): a silent
    'nothing to recover' over a possibly-mutated source attributes
    everything that follows to the wrong baseline."""


_JOURNAL_MAGIC = "FJ2\n"
_JOURNAL_END = "FJ2-END"
_JOURNAL_DIGEST_HEX = hashlib.sha256().hexdigest()  # 64 chars: the canonical digest width


def _journal_split(saved: str):
    """Split a journal into (body, integrity_ok). Format:
    'FJ2\\n<declared-byte-length>\\n<sha256-hex>\\n' + body + 'FJ2-END'.
    _journal_recover treats a legacy header-less journal (and the
    pre-checksum FJ1 format, whose integrity was UNVERIFIABLE —
    g1s7-C2k-F1) as a hard shape failure too — never restored blind.
    Both the declared byte length AND the digest must match: length
    alone accepts a crafted same-length corruption, digest length
    alone does not prove the body is complete — together, any
    modification of the body is detected and quarantined."""
    if not saved.startswith(_JOURNAL_MAGIC):
        return "", False
    rest = saved[len(_JOURNAL_MAGIC):]
    nl = rest.find("\n")
    if nl < 0:
        return "", False
    try:
        declared = int(rest[:nl])
    except ValueError:
        return "", False
    rest2 = rest[nl + 1:]
    nl2 = rest2.find("\n")
    if nl2 < 0:
        return "", False
    digest = rest2[:nl2]
    if len(digest) != len(_JOURNAL_DIGEST_HEX) or any(
            c not in "0123456789abcdef" for c in digest):
        return "", False
    body = rest2[nl2 + 1:]
    if not body.endswith(_JOURNAL_END):
        return "", False
    body = body[:-len(_JOURNAL_END)]
    if len(body.encode("utf-8")) != declared:
        return "", False
    return body, hashlib.sha256(body.encode("utf-8")).hexdigest() == digest


# g1s7-C2b-F2 audit: "ignore every OSError" turned a REAL I/O failure
# (EIO/EDQUET/ENOSPC) into a silent pass — the journal could report a
# durable rename while the directory entry never reached platter.
# Only errnos that mean "this platform/fs does not support the call"
# are forgiven; anything else propagates to the caller (which refuses
# the mutation / recovery).
_FSYNC_UNSUPPORTED = frozenset({
    errno.EINVAL,
    getattr(errno, "ENOTSUP", None),
    getattr(errno, "EOPNOTSUPP", None),
    errno.ENOSYS,
}) - {None}


def _fsync_dir(path: str) -> None:
    """g1s7-C2a3-F3 audit: a rename is only as durable as the
    DIRECTORY entry for it — fsync the containing dir after every
    replace/remove that recovery depends on (the journal appearing,
    the quarantine moving, the restored src). g1s7-C2b-F2: platform
    non-support is forgiven; a REAL error (EIO etc.) RAISES."""
    try:
        dfd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError as e:
        if e.errno in _FSYNC_UNSUPPORTED:
            return
        raise


def _fsync_path(path: str) -> None:
    """fsync an existing file (no write): used where the content is
    already what we want but its DURABILITY is unproven (g1s7-C2b-F1:
    a restore whose bytes matched page-cache was skipped, then the
    journal was removed — power loss left the mutant on disk with no
    recovery record)."""
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_durable(path: str, data: str) -> None:
    """Write + fsync as one operation: every restore site in main()
    used a plain write (page cache), so 'restored' was only ever a
    promise about RAM (g1s7-C2b-F1)."""
    # g1s7-C2q-F2: newline="" — durable restores are byte-preserving
    # (universal-newline translation would rewrite CRLF sources).
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())


def _block_termination_signals():
    """g1s7-C2v-F1 audit: block the CATCHABLE termination signals
    across an atomic journal completion transition. A SystemExit
    raised between "the source is restored" and "the DONE marker
    landed" left the ARMED (RESTORABLE) record behind after a
    completed restore — a user edit made afterwards was then
    'recovered' OVER by the stale snapshot (no write error needed,
    so this was not the documented persistent-EIO residual). Blocked
    signals stay PENDING and are delivered at unmask, preserving
    exit semantics. SIGKILL cannot be blocked anywhere; on a
    platform without sigmask support we proceed unmasked — the
    pre-recover byte preservation is the backstop there."""
    try:
        return signal.pthread_sigmask(signal.SIG_BLOCK, {
            signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT})
    except (OSError, ValueError, AttributeError):
        return None


def _restore_signal_mask(old) -> None:
    """Unmask; a pending signal is DELIVERED here (the registered
    handler may raise SystemExit — that is intended: the transition
    completed before unmask, the exit happens right after with the
    journal in its safe final state)."""
    if old is None:
        return
    try:
        signal.pthread_sigmask(signal.SIG_SETMASK, old)
    except (OSError, ValueError, AttributeError):
        pass


def _preserve_divergent_src() -> None:
    """g1s7-C2v-F1: before recovery overwrites SRC with the snapshot,
    durably preserve the CURRENT bytes in the journal dir. An ARMED
    record cannot distinguish 'user edit' from 'leftover mutant' —
    that ambiguity is irreducible — so every remaining clobber
    window (SIGKILL inside the DONE mark, persistent write error,
    no-sigmask platform) is made NON-DESTRUCTIVE: the overwritten
    bytes live on at <journal>.pre-recover.<pid> and the path is
    printed. Backups older than 7 days are reaped best-effort."""
    j = _journal_path()
    d = os.path.dirname(j)
    try:
        cutoff = time.time() - 7 * 86400
        for nm in os.listdir(d):
            if nm.startswith("findings-mutate-") and ".pre-recover." in nm:
                try:
                    if os.stat(os.path.join(d, nm)).st_mtime < cutoff:
                        os.remove(os.path.join(d, nm))
                except OSError:
                    pass
    except OSError:
        pass
    keep = f"{j}.pre-recover.{os.getpid()}"
    with open(SRC, "rb") as fin:
        data = fin.read()
    try:
        fd = os.open(keep, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        os.remove(keep)  # our own stale backup from a SIGKILLed sweep
        fd = os.open(keep, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    try:
        _fsync_dir(d)
    except OSError as e:
        # The backup bytes are written+fsynced; only the directory
        # entry durability is unproven (e.g. injected fsync-dir EIO
        # from the driver). Refusing recovery over the backup's
        # belt-and-suspenders durability would regress the C2t-F2
        # contract (a DONE-mark fs failure must not undo a durable
        # restore) — warn and proceed; the journal still completes.
        _safe_print(f"pre-recover: backup dir fsync failed ({e}) — the "
                    "backup file exists but its directory entry may not "
                    "be durable after power loss")
    _safe_print(f"pre-recover: the CURRENT {SRC} bytes (they differ from "
                f"the snapshot) were saved to {keep} before the restore")


_JOURNAL_DONE_TAG = "FJ-DONE"


def _journal_write_body(body: str) -> None:
    """Atomically (re)write the journal with BODY as the recovery body.
    (g1s7-C1-F8 audit): write to a UNIQUE tmp file, fsync, then
    os.replace — a SIGKILL during the write leaves either the OLD
    journal or the COMPLETE new one, never empty/partial. A failure
    to persist RAISES (the caller must refuse to apply the mutant —
    journal-less mutation risks an unrecoverable dirty tree).
    g1s7-C2a3-F3: the containing dir is fsynced after the replace —
    otherwise a power loss can lose the journal entry WHILE the
    mutation proceeds (the whole point of the journal evaporates).

    g1s7-C2k-F1 audit: the header carries a sha256 of the body next
    to the declared length. A length+end-marker header alone accepts
    any SAME-LENGTH corruption (a bit flip, a crafted overwrite) as
    pristine — the corrupted bytes would then be written over src/
    as the supposedly-pristine recovery source and become the next
    sweep's baseline. The digest makes body integrity verifiable,
    not just body length."""
    j = _journal_path()
    body_bytes = body.encode("utf-8")
    body_len = len(body_bytes)
    body_digest = hashlib.sha256(body_bytes).hexdigest()
    payload = (f"{_JOURNAL_MAGIC}{body_len}\n{body_digest}\n"
               + body + _JOURNAL_END)
    tmp = f"{j}.{os.getpid()}.tmp"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        # g1s7-C2u-F2 audit: the tmp is PID-named, so a SIGKILLed
        # earlier process (or plain PID reuse) can leave a stale tmp
        # that poisons EVERY future journal write with EEXIST —
        # before os.replace, i.e. completions silently stop landing.
        # A tmp named with OUR pid is ours-or-stale by definition:
        # no other live process may legitimately own it (sweeps
        # serialize on the journal flock). Unlink and retry once.
        os.remove(tmp)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        # g1s7-C2q-F2: newline="" — the journal body must be the
        # exact pristine bytes (its digest is declared over them).
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, j)
        _fsync_dir(os.path.dirname(j))
    finally:
        try:
            os.remove(tmp)  # no-op after a successful replace
        except FileNotFoundError:
            pass


def _journal_write(orig: str) -> None:
    """ARMED journal: the pristine snapshot, written before any
    mutation is applied. An ARMED journal whose body differs from
    src/ means a crash left a MUTANT applied — recovery restores."""
    _journal_write_body(orig)


def _journal_mark_done() -> None:
    """g1s7-C2t-F1/F2 audit: COMPLETION replaces the journal with a
    DONE marker by one atomic write+replace — never a bare unlink
    whose durability the dir fsync could not always prove. A
    resurrected DONE marker is HARMLESS by construction: recovery
    never restores from DONE (a completed sweep's marker is stale by
    the time it resurfaces, and stale content must never be written
    over user edits). The invariant: the journal is either DONE
    (never clobbers), or ARMED with the snapshot of a mutation that
    may still be on disk (restore semantics) — never a third,
    ambiguous state."""
    _journal_write_body(_JOURNAL_DONE_TAG)


def _journal_clear() -> None:
    """Successful sweep exit: ARMED -> DONE (atomic, durable), then a
    best-effort removal of the harmless marker. g1s7-C2r-F1: the
    completion is never just an unlink (resurrection race).
    g1s7-C2t-F1/F3: if even the DONE replace fails (EIO, signal),
    whatever remains on disk is SAFE: the old ARMED journal's body
    equals the verified-pristine src (next sweep match-clears it),
    and every failure prints honestly. Removal of a DONE marker may
    fail forever harmlessly — the next recovery retries it."""
    _sig_old = _block_termination_signals()
    try:
        _journal_mark_done()
    except OSError as e:
        _safe_print(f"JOURNAL DONE-MARK FAILED ({e}) - the ARMED journal "
                    "remains (its snapshot equals the verified-pristine "
                    "source; the next sweep match-clears it)")
        return
    except BaseException as e:
        _safe_print(f"JOURNAL DONE-MARK INTERRUPTED ({type(e).__name__}) - "
                    "the ARMED journal remains (match-clear safe)")
        raise
    finally:
        # g1s7-C2v-F1: signals stay blocked across the whole
        # ARMED->DONE->removed transition; a pending SIGTERM is
        # delivered HERE (after the marker landed), never inside it.
        _restore_signal_mask(_sig_old)
    try:
        os.remove(_journal_path())
        _fsync_dir(os.path.dirname(_journal_path()))
    except OSError:
        pass  # a lingering DONE marker is harmless, retried next run


def _restore_src_hook() -> None:
    # g1s7-C1-F2 audit: the atexit chain must tell SUCCESS from
    # FAILURE — a failed restore leaves the journal ARMED (so the
    # next sweep recovers), while a successful restore (or a bare
    # import that never mutated anything) clears it.
    # g1s7-C2c-F1 audit: matching bytes in the PAGE CACHE are not
    # proof of durability (main()'s _write_durable may have flushed
    # but failed its fsync). The match branch fsyncs too; ANY fsync
    # failure sets _RESTORE_FAILED so the journal stays armed.
    global _RESTORE_FAILED
    if _SRC_RESTORE["orig"] is not None and _SRC_RESTORE["path"] is not None:
        try:
            # g1s7-C2q-F2: newline="" — the fast-path comparison must
            # see the SAME bytes the snapshot holds (universal-newline
            # translation would force a needless rewrite of a CRLF
            # file that is already byte-identical to orig).
            with open(_SRC_RESTORE["path"], encoding="utf-8", newline="") as _fh:
                same = _fh.read() == _SRC_RESTORE["orig"]
            if not same:
                # g1s7-C2q-F2: newline="" — byte-preserving restore.
                with open(_SRC_RESTORE["path"], "w", encoding="utf-8", newline="") as fh:
                    fh.write(_SRC_RESTORE["orig"])
                    fh.flush()
                    os.fsync(fh.fileno())
            else:
                _fsync_path(_SRC_RESTORE["path"])
        except OSError:
            _RESTORE_FAILED = True
            _safe_print("RESTORE FAILED — journal kept armed for next-sweep recovery")
        except BaseException:
            # g1s7-C2m-F1 audit: SIGINT/SIGTERM raising SystemExit
            # INSIDE the restore (e.g. during its fsync) used to slip
            # past the OSError-only handler. Python's atexit then
            # ran the REMAINING callbacks as if the restore had
            # finished, and _journal_clear_hook — reading matching
            # PAGE-CACHE bytes — deleted the journal although the
            # restore's durability was never proven; a power loss
            # resurrected the mutant source with no marker. ANY
            # abnormal exit from the restore sets the failure flag
            # (the clear hook then refuses) and propagates. The
            # safe default on every abort is: journal stays armed.
            _RESTORE_FAILED = True
            raise


def _journal_clear_hook() -> None:
    """atexit companion to _restore_src_hook: clear the journal ONLY
    when a sweep actually ran AND the source is verified pristine
    again. g1s7-C1-F2 audit: a bare import (or a driver command)
    that never applied a mutant must never clear a live journal, and
    a FAILED restore must keep it armed.

    g1s7-C2i-F2 audit: additionally refuses when the sweep lock was
    never acquired — without it this process cannot prove the journal
    is not a LIVE sweep's (the registry-refusal paths exit before
    recovery); only the lock-holding sweep may ever clear it.

    g1s7-C2h-F1 audit: additionally refuses while _DIST_STILL_SUSPECT
    is set — a destroy attempt FAILED this process, so dist/ may hold
    mutant JavaScript. Clearing the journal then would leave that
    artifact runnable with no recovery marker; keeping it armed makes
    the NEXT sweep retry the destroy before it trusts anything."""
    if _JOURNAL_LOCK_FD is None:
        return
    if _DIST_STILL_SUSPECT:
        return
    if _SRC_RESTORE["orig"] is not None and not _RESTORE_FAILED:
        try:
            # g1s7-C2q-F2: newline="" — compare the SAME bytes that
            # were written (translation would false-mismatch CRLF).
            with open(_SRC_RESTORE["path"], encoding="utf-8", newline="") as fh:
                if fh.read() == _SRC_RESTORE["orig"]:
                    _journal_clear()
        except OSError as e:
            # g1s7-C2u-F1 audit: this branch used to RE-ARM the
            # journal — right when clearing meant an unproven
            # unlink, WRONG now: _journal_clear() is OSError-total
            # (it prints and leaves the safe state itself), so the
            # only way to land here is a failed verification
            # RE-READ. Re-arming would write an ARMED record for a
            # COMPLETED sweep — and an ARMED record is restorable:
            # after the user edits the source, the next sweep would
            # "recover" the stale snapshot OVER the edits. The
            # restore's durability was already proven by the
            # sibling _restore_src_hook (it raises the failure flag
            # on ANY error, and we only run when it stayed unset),
            # so the honest completion is the DONE marker — via
            # _journal_clear(), which never resurrects an ARMED
            # record and marks completion best-effort-honestly.
            _safe_print(f"CLEAR VERIFY RE-READ FAILED ({e}) — completing "
                        "via the DONE marker; the restore was already "
                        "proven durable (never re-arm after completion: a "
                        "stale ARMED record clobbers later user edits)")
            _journal_clear()


# LIFO order: restore registered FIRST => runs LAST; the clear hook
# runs BEFORE it sees... no — atexit runs LIFO, so register the
# clear hook first and the restore hook last: restore runs first,
# then the clear hook checks the restored source.
atexit.register(_journal_clear_hook)
atexit.register(_restore_src_hook)


def _interrupt(signum, _frame):
    raise SystemExit(128 + signum)


class _spawn_atomic:
    """Block SIGINT/SIGTERM around Popen+tracking so an interrupt
    cannot land between spawning a child and registering its group in
    ACTIVE_CHILDREN (an untracked live child would outlive the sweep).
    Main-thread only (pthread_sigmask); silently no-ops where the
    platform forbids it."""

    def __enter__(self) -> "_spawn_atomic":
        self._old = None
        try:
            self._old = signal.pthread_sigmask(
                signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
        except (AttributeError, ValueError, OSError):
            self._old = None
        return self

    def __exit__(self, *exc) -> bool:
        if self._old is not None:
            try:
                signal.pthread_sigmask(signal.SIG_SETMASK, self._old)
            except OSError:
                pass
        return False


def stream_run(argv: list[str], timeout: int) -> RunResult:
    """Run argv to completion or deadline, collecting stdout lines as they
    arrive. Streaming (vs capture_output) is what makes hang attribution
    possible: after the timeout-SIGKILL the partial TAP is still ours.

    The child runs in its OWN process group: `node --test` spawns one
    child per test file, and a deadlocked mutant grandchild spins at
    100% CPU — `proc.kill()` alone reaps only the runner and LEAKS the
    spinner as an orphan (observed burning the user's laptop after the
    sweep finished). Timeout kills the whole group. The child pid is
    registered in ACTIVE_CHILDREN so the atexit/finally sweep reaps it
    even if this function is interrupted."""
    res = RunResult()
    # g1s7-F3 audit fix 3: block SIGINT/SIGTERM between Popen and
    # ACTIVE_CHILDREN.add — an interrupt landing there would leave a
    # live, untracked child group outliving the sweep.
    with _spawn_atomic():
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL,
                                text=True, errors="replace", start_new_session=True)
        ACTIVE_CHILDREN.add(proc.pid)

    def reader() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            res.lines.append(line.rstrip("\n"))

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    try:
        res.rc = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        res.timed_out = True
        _kill_group(proc.pid)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.communicate()
    finally:
        # g1s7-C1-F3 audit: SystemExit unwinding through wait() must
        # kill the group BEFORE dropping the pid from tracking — an
        # untracked live child would outlive the sweep.
        # g1s7-C2a3-F2 audit: the group kill is now UNCONDITIONAL —
        # the immediate child exiting does NOT mean the group is
        # empty (it can leave descendants spinning in the still-live
        # group; the pgid persists until its last member dies, so
        # killpg reaches them; a fully-dead group ProcessLookups to a
        # no-op). PID-reuse into a new group leader inside this
        # microsecond window is possible in theory and accepted.
        _kill_group(proc.pid)
        if proc.poll() is None:
            try:
                proc.wait(timeout=10)
            except Exception:
                pass
        ACTIVE_CHILDREN.discard(proc.pid)
    t.join(timeout=5)
    res.parse()
    return res


def full_run() -> RunResult:
    return stream_run(["node", "--test", *SUITES], RUN_TIMEOUT_S)


def baseline_refusals(r: RunResult) -> list[str]:
    """Pure baseline-gate verdict (g1s7-C1-F10 audit fix): every
    refusal condition in ONE function shared by baseline() AND the
    driver — the driver cannot drift from the production gate because
    there is only one implementation. Returns a list of reasons;
    empty means green. (Build success is I/O, checked by baseline().)

    Conditions:
      timeout                 — pristine suites must complete
      dups                    — conflicting duplicate names (untrustworthy)
      multi-sighting          — a name reported >1x with ANY status
                                (g1s7-C1-F9): attribution across the
                                merged map is ambiguous at the source
      fail_conflict           — disagreeing "# fail N" summaries (F4)
      no test lines           — zero-evidence run is not green (F4)
      rc != 0 / fail != 0/red — the classic not-green gate
    """
    reasons = []
    if r.timed_out:
        reasons.append("timeout")
    if r.dups:
        reasons.append(f"ambiguous ({len(set(r.dups))} conflicting names)")
    multi = sorted(n for n, c in r.sightings.items() if c > 1)
    if multi:
        reasons.append(f"multi-sighting ({len(multi)} name(s) reported >1x)")
    if r.fail_conflict:
        reasons.append("disagreeing '# fail N' summaries")
    if not r.results:
        reasons.append("no test lines reported (zero-evidence run)")
    red = sorted(n for n, s in r.results.items() if s != "ok")
    if r.rc != 0 or r.fail != 0 or red:
        reasons.append(f"not-green (rc={r.rc}, fail={r.fail}, red={len(red)})")
    return reasons


def baseline() -> RunResult | None:
    """Build pristine and run ALL suites. Returns the green baseline Run
    Result, or None (after printing why) if the baseline is not green.
    A green baseline requires: no timeout, exit 0, summary "# fail 0",
    every individual test line green, at least one test line, no
    multi-sighting name, and no disagreeing "# fail" summaries — every
    condition lives in baseline_refusals() (g1s7-C1-F10 audit fix:
    ONE implementation shared with the driver — the driver cannot
    drift from the production gate)."""
    print("== PRISTINE BASELINE ==")
    if not build():
        _safe_print("BASELINE BUILD FAILED — sweep refused (pristine source must compile)")
        return None
    r = full_run()
    reasons = baseline_refusals(r)
    if reasons:
        _safe_print("BASELINE REFUSED: " + "; ".join(reasons))
        _safe_print("  the sweep cannot attribute anything against an "
              "untrustworthy baseline — fix this first")
        red = sorted(n for n, s in r.results.items() if s != "ok")
        for n in red[:10]:
            _safe_print(f"  red in baseline: {n}")
        return None
    print(f"baseline green: {len(r.executed)} executed tests, 0 failures"
          + (f" ({len(r.skipped)} skipped/not-run — excluded from attribution)"
             if r.skipped else ""))
    return r


def baseline_suite_green() -> dict | None:
    """Per-SUITE baseline-green membership (g1s7-C1-F5 audit fix):
    run each suite file individually on the pristine build and map
    suite path -> its executed green tests. judge_hang() refuses a
    kill unless the HUNG suite itself contains baseline-green tests —
    a suite with nothing green in it hanging proves nothing about the
    mutant. Returns None if any per-suite baseline run is not clean
    (membership is then untrustworthy and hang attribution is off —
    judge_hang fails closed on None)."""
    out: dict[str, set] = {}
    for s in SUITES:
        sr = stream_run(["node", "--test", s], RUN_TIMEOUT_S)
        reasons = baseline_refusals(sr)
        if reasons:
            _safe_print(f"BASELINE SUITE RUN FAILED ({os.path.basename(s)}): "
                  + "; ".join(reasons) + " — hang attribution disabled")
            return None
        out[s] = attribution_green(sr)
    return out


def _js_regex_escape(s: str) -> str:
    """Escape JS regex metacharacters (the set node's RegExp uses).
    Test names quote literal parentheses/brackets; unescaped they form
    groups/classes that can never match the text they quote."""
    return re.sub(r"[.*+?^${}()|\[\]\\]", r"\\\g<0>", s)


def _failure_digest(r: "RunResult", name: str) -> str:
    """FLAKE LEDGER lead 2: the first assertion message node's TAP
    printed under a failing test ("error: ..." within its YAML-ish
    diagnostic block). The FLAKY-NOT-KILLED line previously discarded
    this — a sweep-only flake could never name itself. Best-effort:
    '' when the stream never carried it."""
    out: list[str] = []
    inside = False
    for ln in r.lines:
        m = re.match(r"\s*not ok \d+ - ", ln)
        if inside and not re.match(r"\s*(not ok|ok) \d+ - ", ln):
            if re.match(r"\s*\.\.\.", ln):
                break
            t = ln.strip()
            if t.startswith(("error:", "code:", "name:", "failureType:")):
                out.append(t)
            if len(out) >= 3:
                break
        elif m:
            inside = f" - {name}" in ln
    return "; ".join(out)[:200]


def attribution_green(r: RunResult) -> set[str]:
    """Baseline-green tests whose assertions ACTUALLY EXECUTED
    (g1s7-F3 audit fix 2): ok-status AND in r.executed. A test that
    SKIPs/TODOs in the baseline never ran — it must never join the set
    a mutant failure is credited against."""
    return {n for n, s in r.results.items()
            if s == "ok" and n in r.executed and n not in r.skipped}


def new_skip_drift(r: RunResult, baseline_green: set[str], base_skipped: dict) -> list[str]:
    """Baseline-green tests that SKIP/TODO under the mutant
    (g1s7-F3): coverage vanished — ok # SKIP proves nothing, so no
    kill is possible and the verdict must be SKIP-DRIFT, never a
    silent membership in the green set."""
    return sorted(t for t in r.skipped
                  if t in baseline_green and t not in base_skipped)


def judge_run(r: RunResult, baseline_green: set[str], base_skipped: dict,
              require_iso_fail: str | None = None):
    """Pure verdict for one non-timeout test run against a green
    baseline — the single source of truth for sweep AND isolation
    re-runs (g1s7-F3 audit fix 5: main()'s inline branch tree lifted
    out so a synthetic TAP unit test can pin every rule).

    Returns (status, detail, new_fail):
      "ambiguous"    conflicting duplicate TAP names — untrustworthy
      "skip-drift"   baseline-green tests stopped executing (detail: names)
      "run-error"    unparsable output / crash outside the harness /
                     contradictory summary (rc=0 with fail>0,
                     disagreeing "# fail" summaries, no test evidence)
      "survived"     summary "# fail 0" AND every baseline-green test
                     still EXECUTED in this run (completeness —
                     g1s7-C1-F4: "not ok"-free output with zero tests
                     is NO evidence, never a survive)
      "unattributed" failures exist but none is baseline-green
      "flaky"        require_iso_fail did not reproduce (detail: why)
      "killed"       new_fail non-empty (reproduced when required)

    g1s7-C1-F9 audit: names seen MULTIPLE times (sightings > 1), even
    with agreeing status, refuse attribution — a mutant may have
    killed one instance while a same-named sibling passed; the merged
    map cannot say which instance produced a status, so neither
    survives, kills, nor isolation may be credited on them.
    """
    if require_iso_fail is not None and (
            r.timed_out or r.results.get(require_iso_fail) != "not ok"
            or require_iso_fail in r.skipped):
        return ("flaky", "did not reproduce in isolation", [])
    if r.dups:
        return ("ambiguous", f"conflicting duplicate names: {sorted(set(r.dups))[:3]}", [])
    multi = sorted(n for n, c in r.sightings.items() if c > 1)
    if multi:
        return ("ambiguous",
                f"multi-sighting names (ran >1x, merged statuses): {multi[:3]}", [])
    # g1s7-C1-F4 audit: two "# fail N" summaries that disagree mean
    # the run reported itself twice with contradictory results.
    if r.fail_conflict:
        return ("run-error", "disagreeing '# fail N' summaries", [])
    # g1s7-C1-F4 audit: a run that reported NO test lines at all is
    # not evidence of anything — "survived" on empty output was a lie.
    if require_iso_fail is None and not r.results:
        return ("run-error", "no test lines reported — zero evidence run", [])
    # Drift is a SWEEP-run rule: an isolation re-run deliberately
    # SKIPs every non-matching test, so drift there is meaningless
    # (the target's own skip is caught by require_iso_fail above).
    if require_iso_fail is None:
        drift = new_skip_drift(r, baseline_green, base_skipped)
        if drift:
            return ("skip-drift", str(drift[:3]), [])
        # g1s7-C1-F4 audit: COMPLETENESS — a sweep run that omits a
        # baseline-green test (mutant crashed the file, renamed the
        # test, or swallowed the runner) may never be credited with a
        # verdict; the green set must have run AGAIN.
        missing = sorted(baseline_green - r.executed)
        if missing:
            return ("run-error",
                    f"baseline-green test(s) never executed: {missing[:3]}", [])
    # g1s7-C1-F6 audit: rc=0 with "# fail N>0" is SELF-CONTRADICTORY
    # (the process says success, the summary says failure) — the same
    # class as the fail=0-with-red-lines rule below: refuse it.
    if r.rc == 0 and r.fail is not None and r.fail > 0:
        return ("run-error", f"contradictory: rc=0 but '# fail {r.fail}'", [])
    if r.fail is None or (r.fail == 0 and r.rc != 0):
        return ("run-error", f"rc={r.rc} fail={r.fail}", [])
    if r.fail == 0:
        # g1s7-F3 audit: a TAP that printed "not ok" lines but
        # summarises "# fail 0" is SELF-CONTRADICTORY — the summary
        # reporter was disturbed (possibly by the mutant itself).
        # A near-kill must never be flipped to SURVIVED by a lying
        # summary line: refuse the verdict. ("not ok … # SKIP/TODO"
        # is legal TAP — a directed line is excluded from green by
        # r.skipped, so it is not a contradiction.)
        red = [n for n, s in r.results.items() if s != "ok" and n not in r.skipped]
        if red:
            return ("run-error",
                    f"contradictory TAP: fail=0 but not-ok lines {red[:3]}", [])
        return ("survived", "", [])
    # g1s7-C2e-F3 audit: the reconciliation must run BOTH ways. With
    # "# fail N > 0" the observed evidence must AGREE with the summary:
    # every executed failing test emits exactly one not-ok line (and
    # "# fail" counts exactly those lines — SKIP/TODO-directed red
    # lines are excluded, verified against node 20 TAP), so N must
    # equal the number of non-directed red result lines. "1 observed,
    # # fail 7" means the summary line (or the stream) was disturbed —
    # possibly by the mutant itself — and a kill credited on such
    # evidence is not attributable. Refuse (fail-closed).
    red_seen = sum(1 for n, s in r.results.items()
                   if s != "ok" and n not in r.skipped)
    if r.fail != red_seen:
        return ("run-error",
                f"contradictory TAP: '# fail {r.fail}' but {red_seen} "
                "non-directed not-ok line(s) observed", [])
    # g1s7-C2a-F2 audit: a directed ("not ok … # SKIP/TODO") line
    # never EXECUTED its assertions, so it can never contribute a
    # kill — the sweep-level drift rule already says so, and the
    # isolation path deliberately skips drift, so the exclusion must
    # live HERE: a nonexecuted directed failure may not receive kill
    # credit for a test that never ran (nor mask an unattributed run).
    new_fail = sorted(t for t, s in r.results.items()
                      if s != "ok" and t in baseline_green
                      and t not in r.skipped)
    if not new_fail:
        preexisting = sum(1 for t, s in r.results.items()
                          if s != "ok" and t not in baseline_green)
        return ("unattributed",
                f"fail={r.fail} with no baseline-green test failing "
                f"(preexisting={preexisting}, unpinned)", [])
    return ("killed", "", new_fail)


def judge_hang(per_suite: list, baseline_green: set[str], base_skipped: dict,
               suite_green: dict | None = None):
    """Pure hang attribution (g1s7-F3 audit fix 3): a timeout credits a
    kill ONLY when exactly one suite hung, every other suite completed
    CLEAN, and NO rerun showed ambiguous duplicate lines or skip-drift
    on baseline-green tests — integrity rules apply to the per-suite
    reruns too, not just the sweep run.

    g1s7-C1-F5 audit: with `suite_green` (suite path -> that suite's
    baseline-green test names, from the per-suite baseline reruns)
    the hung suite must ALSO contain at least one baseline-green
    test — a suite with no green tests in the baseline (all skipped,
    or empty) hanging proves nothing about the mutant and is refused.
    Without suite_green the caller established no membership and hang
    attribution is REFUSED outright (fail-closed, never a silent
    pass). Multi-sighting reruns are ambiguous like in judge_run.

    per_suite: [(suite, RunResult)] in sweep order. Returns
    (attributed, hung_or_bad_suites, clean_count, reason).
    """
    hung: list[str] = []
    clean = 0
    # g1s7-C2e-F2 audit: per-suite membership must be a PARTITION of
    # the full baseline-green set: every name claimed by AT MOST one
    # suite, and every baseline-green name claimed by SOME suite.
    # Overlapping claims mean the hung suite's "evidence" could just
    # as well belong to a clean control; an uncovered baseline-green
    # name means the individual reruns registered tests differently
    # from the combined run — in both cases membership cannot
    # attribute a hang, so refuse outright (fail-closed).
    if suite_green is not None:
        seen_by: dict[str, str] = {}
        for s_g, names in suite_green.items():
            for n in names:
                if n in seen_by:
                    return (False, [s_g], clean,
                            f"per-suite membership overlap: '{n}' claimed by "
                            f"both {seen_by[n]} and {s_g} — combined-run and "
                            "individual registrations disagree, hang refused")
                seen_by[n] = s_g
            out_e = sorted(set(names) - baseline_green)
            if out_e:
                return (False, [s_g], clean,
                        f"suite {s_g} membership cites {out_e[:3]} not green "
                        "in the full baseline — hang refused")
        uncovered = sorted(baseline_green - set(seen_by))
        if uncovered:
            return (False, [], clean,
                    f"baseline-green test(s) {uncovered[:3]} belong to NO "
                    "suite's membership — per-suite baselines are not a "
                    "partition of the combined baseline, hang refused")
    for suite, sr in per_suite:
        # g1s7-C2-F4 audit: EVERY rerun (hung or control) with
        # disagreeing '# fail N' summaries is untrustworthy.
        if sr.fail_conflict:
            return (False, [suite], clean,
                    f"rerun of {suite} reported disagreeing '# fail N' summaries")
        if sr.dups:
            return (False, [suite], clean,
                    f"rerun of {suite} reported conflicting duplicate TAP names")
        multi = sorted(n for n, c in sr.sightings.items() if c > 1)
        if multi:
            return (False, [suite], clean,
                    f"rerun of {suite} multi-sighting names {multi[:3]}")
        drift = new_skip_drift(sr, baseline_green, base_skipped)
        if drift:
            return (False, [suite], clean,
                    f"rerun of {suite} skipped baseline-green test(s) {drift[:3]}")
        if sr.timed_out:
            # g1s7-C2a-F3 audit: a timed-out rerun whose PARTIAL TAP
            # already shows an executed (undirected) failure is not a
            # pure spinner — the run was failing before it hung, so
            # "the mutant hangs this suite" is not what the evidence
            # says. A partial summary claiming "# fail 0" next to red
            # lines is the same self-contradiction judge_run refuses.
            # Either way the timeout is untrustworthy: refuse.
            hung_red = [n for n, v in sr.results.items()
                        if v != "ok" and n not in sr.skipped]
            if hung_red:
                return (False, [suite], clean,
                        f"timed-out rerun of {suite} already reported "
                        f"failures {hung_red[:3]} — not a pure hang")
            if sr.fail is not None and sr.fail > 0:
                return (False, [suite], clean,
                        f"timed-out rerun of {suite} reported '# fail "
                        f"{sr.fail}' before hanging — not a pure hang")
            if suite_green is None:
                return (False, [suite], clean,
                        "no per-suite baseline membership — hang refused")
            ev = suite_green.get(suite) or set()
            # g1s7-C2d-F1 audit: the per-suite membership must AGREE
            # with the full pristine baseline used for attribution.
            # A test skipped in the FULL baseline that executed in
            # the separate per-suite run proves the two baselines
            # disagree — that membership cannot credit a kill, and a
            # hung suite whose only "green" evidence is NOT green in
            # the full baseline proves nothing. Refuse (fail-closed).
            outside = sorted(ev - baseline_green)
            if outside:
                return (False, [suite], clean,
                        f"hung suite {suite} cites tests {outside[:3]} that "
                        "are NOT green in the full baseline — per-suite "
                        "membership disagrees, hang refused")
            if not ev:
                return (False, [suite], clean,
                        f"hung suite {suite} has no baseline-green tests")
            # g1s7-C2k-F2 audit (symmetric): a hung suite whose partial
            # run already executed baseline-green tests claimed by a
            # DIFFERENT suite proves registration/imports changed —
            # which suite actually hung is no longer attributable.
            foreign_h = sorted(
                n for n in sr.executed
                if n in seen_by and seen_by[n] != suite)
            if foreign_h:
                return (False, [suite], clean,
                        f"hung suite {suite} executed baseline-green "
                        f"test(s) {foreign_h[:3]} claimed by another "
                        "suite — membership disagrees under the mutant, "
                        "hang refused")
            hung.append(suite)
        else:
            # A clean rerun: exit 0, "# fail 0", no *undirected* red
            # line ("not ok … # SKIP/TODO" is legal TAP — same rule as
            # judge_run). Names reported but NOT executed must have
            # been skipped in the baseline too (drift was voided
            # above); a newly-skipped green test never reaches here.
            # g1s7-C2-F4 audit: a control with NO test lines at all
            # ('# fail 0' alone) is zero evidence — the rerun must
            # have actually run its suite's baseline-green tests, or
            # "clean" means nothing and the timeout next door is not
            # attributable.
            red = [n for n, v in sr.results.items()
                   if v != "ok" and n not in sr.skipped]
            if (sr.rc == 0 and not red and sr.fail == 0
                    and sr.results
                    and set(sr.results) - sr.executed <= set(base_skipped)):
                if suite_green is not None:
                    own = suite_green.get(suite) or set()
                    out2 = sorted(own - baseline_green)
                    if out2:
                        return (False, [suite], clean,
                                f"control {suite} cites tests {out2[:3]} that "
                                "are NOT green in the full baseline — "
                                "membership disagrees, attribution refused")
                    missing = sorted(own - sr.executed)
                    if missing:
                        return (False, [suite], clean,
                                f"control rerun of {suite} never executed "
                                f"its baseline-green test(s) {missing[:3]}")
                    # g1s7-C2k-F2 audit: a control must prove ITS OWN
                    # suite is unaffected — executing a baseline-green
                    # test CLAIMED BY ANOTHER SUITE (in particular the
                    # hung one) means registration/imports changed
                    # under the mutant: the control's clean verdict
                    # says nothing about the hung suite's isolation,
                    # so the timeout is not attributable. Refuse.
                    foreign = sorted(
                        n for n in sr.executed
                        if n in seen_by and seen_by[n] != suite)
                    if foreign:
                        return (False, [suite], clean,
                                f"control {suite} executed baseline-green "
                                f"test(s) {foreign[:3]} claimed by another "
                                "suite — the control proves nothing about "
                                "the hung suite's isolation, hang refused")
                clean += 1
    if len(hung) == 1 and clean == len(per_suite) - 1:
        return (True, hung, clean, "")
    return (False, hung, clean, "exactly-one-clean-hang attribution not met")


def run_suite_subset(names: list[str], pattern: str | None) -> RunResult:
    argv = ["node", "--test"]
    if pattern is not None:
        argv += ["--test-name-pattern", pattern]
    return stream_run(argv + names, RUN_TIMEOUT_S)


def _mutant_name_dupes() -> list[str] | None:
    """g1s7-F3: duplicate MUTANT NAMES in the MUTS literal. Python
    silently keeps the LAST entry for a repeated dict-literal key, so a
    copy-pasted mutant name makes its sibling untestable while the
    sweep still reports full coverage.

    g1s7-F3 audit fix 4: the registry is parsed with `ast` from this
    file's own source — every literal key occurrence in the MUTS
    assignment, in document order. A regex scan could silently miss
    keys (multi-line entries, alternate spacing, later reformatting),
    and a silently-empty audit is exactly the failure mode it guards.

    Returns the sorted list of names defined MORE THAN ONCE, or None
    when the audit COULD NOT RUN (unreadable source, no MUTS
    assignment, AST parse failure, unexpected shape). Callers must
    treat None as a hard refusal — never as "no duplicates".
    The audit only sees literal keys: a mutant added at runtime
    (MUTS[...]=...) is outside its contract.
    """
    try:
        with open(__file__, encoding="utf-8") as fh:
            tree = ast.parse(fh.read(), filename=__file__)
    except (OSError, SyntaxError, UnicodeDecodeError) as e:
        # g1s7-C2q-F1 audit: a SyntaxError-only handler let
        # UnicodeDecodeError (a ValueError, not an OSError) escape
        # the audit BEFORE main() could acquire the sweep lock and
        # destroy a dead sweep's suspect dist — an uncaught traceback
        # left the mutant JS runnable, the exact hazard the refusal
        # path exists to prevent. The on-disk source can differ from
        # the loaded module (edited/rotated between exec and read);
        # an UNREADABLE/undecodable registry means the audit cannot
        # run -> None -> fail-closed refusal.
        return None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "MUTS" for t in node.targets
        ):
            if not isinstance(node.value, ast.Dict):
                return None
            keys = [
                k.value
                for k in node.value.keys
                if isinstance(k, ast.Constant) and isinstance(k.value, str)
            ]
            if len(keys) != len(node.value.keys):
                return None  # non-string key — audit shape unexpected
            seen: dict[str, int] = {}
            for key in keys:
                seen[key] = seen.get(key, 0) + 1
            return sorted(n for n, c in seen.items() if c > 1)
    return None


def main() -> int:
    # g1s7-F3: refuse a sweep whose mutant registry is ambiguous.
    # g1s7-F3 audit fix 4: fail-CLOSED registry audit — None means the
    # audit could not run, which refuses the sweep just like actual
    # duplicates (a silently-unaudited registry is the bug it guards).
    dupes = _mutant_name_dupes()
    if dupes is None:
        _safe_print("MUTANT REGISTRY AUDIT FAILED — MUTS literal could not be "
              "parsed from this file's source; refusing an unaudited sweep")
        # g1s7-C2h-F4 audit: an unaudited refusal used to skip the
        # dist hygiene every OTHER sweep-start refusal performs — a
        # previous SIGKILLED sweep may have left dist/ compiled from
        # its last mutant. Destroy it loudly.
        # g1s7-C2i-F2 audit: ONLY with the sweep lock held. Without
        # it, a *live* sweep may own dist/ right now (its compiled
        # module or its final build) — destroying "our" dead sweep's
        # artifact would sabotage a running one. Lock busy therefore
        # means "not ours to destroy"; the journal stays armed and
        # the next lock-holding sweep does the hygiene.
        if not _acquire_sweep_lock():
            _safe_print("SWEEP LOCK BUSY — a live sweep owns dist/; refusing to touch it")
            return 1
        _destroy_suspect_dist("mutant registry audit failed — sweep refused before recovery")
        return 1
    if dupes:
        _safe_print(f"DUPLICATE MUTANT NAMES in MUTS (later entry silently "
              f"shadows the earlier — coverage would be a lie): {dupes}")
        # g1s7-C2h-F4 audit: same refusal-path dist hygiene as the
        # audit-failure branch above and the C2g-F3 recovery-refusal
        # path — the sweep never ran, but a dead sweep's mutant build
        # may still be sitting in dist/. g1s7-C2i-F2: lock-held only.
        if not _acquire_sweep_lock():
            _safe_print("SWEEP LOCK BUSY — a live sweep owns dist/; refusing to touch it")
            return 1
        _destroy_suspect_dist("duplicate mutant names — sweep refused before recovery")
        return 1
    # g1s7-F3 audit fix 4: a SIGKILLED previous sweep cannot run any
    # Python cleanup — recover src/ from the crash journal FIRST so
    # `orig` below is the pristine source, not a leftover mutant.
    # g1s7-C1-F1 audit: the journal is sweep-exclusive — take the
    # flock FIRST (a concurrent sweep must never share it); recovery
    # of a torn journal is a hard stop (C1-F8).
    if not _acquire_sweep_lock():
        _safe_print("SWEEP LOCK BUSY — another findings-mutate sweep holds the "
              "journal for this source (concurrent sweeps are refused)")
        return 1
    # g1s7-C2g-F1 audit: from here on, ANY journal found belongs to a
    # DEAD sweep, so dist/ may hold its last mutant build. Recovery
    # destroys that suspect artifact INSIDE itself — before the journal
    # disappears — covering BOTH the dirty-restore branch and the
    # source-matches-clear branch (the old `if _recovered:` in main
    # missed the match-clear path: src can match the journal body
    # while dist still holds the dead sweep's mutant build).
    global _DIST_SUSPECT
    _DIST_SUSPECT = True
    try:
        _journal_recover()
    except (JournalCorrupt, JournalRecoverFailed) as e:
        # g1s7-C2-F1/F3: recovery failure is a HARD stop — src/ may
        # hold a leftover mutant and the journal record is preserved
        # (quarantined if corrupt), so the next run can still see it.
        # g1s7-C2g-F3: dist is suspect on this path too — the dead
        # sweep may have BUILT its mutant before dying. Destroy it
        # before refusing: a later `npm test` fails loudly instead of
        # silently running the dead sweep's mutant JavaScript. src/
        # recovery stays a manual (git) operation.
        _destroy_suspect_dist("journal recovery refused — dist may hold the dead sweep's mutant build")
        _safe_print(f"JOURNAL RECOVERY FAILED ({type(e).__name__}) — sweep refused; "
              "restore src/ from git before the next sweep")
        return 1
    # g1s7-C2q-F2 audit: the snapshot must be BYTE-PRESERVING. Plain
    # open(SRC).read() applies universal-newline conversion (\r\n ->
    # \n), so a CRLF checkout was journalled/restored as LF: every
    # restored file differed from its original bytes across its whole
    # extent — a sweep silently "fixed" line endings, and crash
    # recovery restored text that never existed on disk. newline=""
    # disables translation in BOTH directions: read, journal, and
    # every write below now round-trip the exact bytes.
    with open(SRC, encoding="utf-8", newline="") as _fh:
        orig = _fh.read()
    # g1s7-F3: arm the interrupt-safe restore (see _restore_src_hook) —
    # a SIGTERM/SIGINT sweep must never leave a mutant applied to src/.
    _SRC_RESTORE["orig"] = orig
    _SRC_RESTORE["path"] = SRC
    for _sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(_sig, _interrupt)
        except (ValueError, OSError):
            pass  # non-main thread / platform without the signal
    names = list(MUTS)
    args = sys.argv[1:]
    if args:
        names = [n for n in names if any(a in n for a in args)]
        # g6-F4 (audit cycle 1): an EMPTY selection must never produce
        # a vacuous "ALL MUTANTS KILLED" — zero mutants tested is zero
        # evidence, not success.
        if not names:
            _safe_print("NO MUTANTS SELECTED (filter matched nothing) — refusing vacuous verdict")
            return 1

    # ---- audit g1s6-c2 fix 3, part 1: green pristine baseline FIRST.
    base = baseline()
    if base is None:
        return 1
    # g1s7-F3 audit fix 2: attribution set is EXECUTED green only —
    # baseline SKIP/TODO tests never ran and can never be credited.
    baseline_green = attribution_green(base)
    # g1s7-C1-F5 audit: per-suite membership must come from the
    # PRISTINE build, computed HERE — the hang branch runs while dist
    # holds a MUTANT build, so a lazy compute there would pollute
    # membership with mutant-compiled suite results.
    base_suite_green = baseline_suite_green()

    results = []
    try:
        for name in names:
            old, new = MUTS[name]
            if "\n" in old and old not in orig and "\r\n" in orig:
                # g1s7-C2r-F2 audit: the registry is authored with LF
                # snippets; on a CRLF checkout EVERY multi-line
                # snippet PATCH-MISSED (26/65 here) — a CRLF sweep
                # silently degraded to single-line mutants only.
                # Adapt the pair to the file's line endings; single-
                # line snippets are unaffected ("\n" not in old).
                # NB: orig is read with newline="" (C2q-F2), so on a
                # CRLF file the LF snippet genuinely is NOT in orig
                # and this guard fires; on an LF or mixed file where
                # the snippet already matches, nothing is rewritten.
                old = old.replace("\n", "\r\n")
                new = new.replace("\n", "\r\n")
            n = orig.count(old)
            if n == 0:
                results.append((name, "PATCH-MISS"))
                continue
            # g1s7-F3 audit fix 4: journal pristine BEFORE applying a
            # mutant — if this process is SIGKILLed with the mutant
            # applied, the next sweep's _journal_recover() undoes it.
            # g1s7-C1-F8 audit: the journal write is atomic
            # (tmp+fsync+os.replace) and a FAILURE is fatal to this
            # mutant — mutating without a durable recovery record is
            # exactly the SIGKILL hazard the journal exists for.
            try:
                _journal_write(orig)
            except OSError as e:
                results.append((name, f"JOURNAL-FAIL << could not persist "
                                      f"recovery record ({e}) — mutant not applied"))
                continue
            # g1s7-C2q-F2: newline="" — write NO translation; the
            # mutated bytes are orig's bytes with one snippet swapped,
            # CRLF intact (a translated write would flip line endings
            # on the restored-copy comparison and the journal digest).
            with open(SRC, "w", encoding="utf-8", newline="") as _fh:
                _fh.write(orig.replace(old, new, 1))
            # g6-F5 (audit cycle 1): delete the compiled module BEFORE
            # building so a build that fails to emit can never leave a
            # STALE pristine (or previous-mutant) dist to be silently
            # tested and attributed to this mutant. (The mutation text
            # itself is NOT searched in the emitted JS — TS syntax is
            # stripped on emit — but deletion + freshness IS: dist/
            # missing or unchanged after the build means the tests
            # would run code that was never compiled from this mutant.)
            mtime_before = None
            try:
                mtime_before = os.stat(DIST).st_mtime_ns
                os.remove(DIST)
            except FileNotFoundError:
                pass
            try:
                built = build()
                try:
                    fresh = os.stat(DIST).st_mtime_ns != mtime_before
                except FileNotFoundError:
                    fresh = False
                if not fresh:
                    results.append((name, "UNEMITTED << build left no fresh module JS (stale/failed emit)"))
                    continue
                tag = "" if built else "[tsc-error] "
                r = full_run()
                if r.timed_out:
                    # ---- audit fix 3, part 3 (g1s7-F3 audit fix 3):
                    # a timeout is a kill ONLY when the spin can be
                    # ATTRIBUTED. Node 20's runner buffers a test
                    # file's TAP until the FILE finishes, so a
                    # deadlocked child yields no per-test stream —
                    # attribution is by re-running each suite file
                    # individually (same deadline) and applying
                    # judge_hang(): exactly one hang, all others clean,
                    # and NO rerun may show ambiguous duplicate lines
                    # or skip-drift (the same integrity rules as the
                    # sweep run — a hang never bypasses them).
                    # g1s7-C1-F5 audit: the ORIGINAL timed-out run's
                    # partial TAP is checked too (dups / multi-sighting
                    # / drift there void attribution), and the hung
                    # suite must contain baseline-green tests — via
                    # per-suite baseline membership, computed lazily
                    # (only a timed-out mutant run pays for it).
                    # g1s7-C2a-F3 audit: the timed-out run's partial
                    # TAP must not contain executed failures or a
                    # contradictory summary either (fail_conflict /
                    # red-under-fail-0) — a run that was already
                    # failing before it hung is not a hang kill.
                    orig_red = [n for n, v in r.results.items()
                                if v != "ok" and n not in r.skipped]
                    if r.dups or any(c > 1 for c in r.sightings.values()) \
                            or r.fail_conflict \
                            or orig_red \
                            or (r.fail is not None and r.fail > 0) \
                            or new_skip_drift(r, baseline_green, base.skipped):
                        results.append((name, "UNATTRIBUTED-HANG << the timed-out "
                                              "run's own partial TAP is ambiguous or "
                                              "drifted — refuse to credit the timeout"))
                        continue
                    if base_suite_green is None:
                        # g1s7-C1-F5: membership MUST come from the
                        # pristine build (computed up front); if that
                        # compute failed, hang attribution stays off.
                        results.append((name, "UNATTRIBUTED-HANG << per-suite "
                                              "baseline membership untrustworthy — "
                                              "refuse to credit the timeout"))
                        continue
                    per_suite = [(s, stream_run(["node", "--test", s], RUN_TIMEOUT_S))
                                 for s in SUITES]
                    ok_hang, hung, clean, why = judge_hang(
                        per_suite, baseline_green, base.skipped,
                        suite_green=base_suite_green)
                    if ok_hang:
                        suite = os.path.basename(hung[0]).replace(".test.js", "")
                        results.append((name, f"{tag}KILLED(hang:attributed {suite})"))
                    else:
                        results.append((name, f"{tag}UNATTRIBUTED-HANG << "
                                              f"hung={[os.path.basename(h) for h in hung]} "
                                              f"clean={clean}/{len(SUITES)} ({why}) — "
                                              "refuse to credit the timeout"))
                    continue
                # ---- g1s7-F3 / audit fix 5: one pure judge for every
                # non-timeout run (AMBIGUOUS-TAP, SKIP-DRIFT,
                # RUN-ERROR, SURVIVED, UNATTRIBUTED-FAIL).
                status, detail, new_fail = judge_run(r, baseline_green, base.skipped)
                if status == "ambiguous":
                    results.append((name, f"{tag}AMBIGUOUS-TAP << {detail} — attribution untrustworthy"))
                    continue
                if status == "skip-drift":
                    results.append((name, f"{tag}SKIP-DRIFT << baseline-green test(s) SKIPPED under "
                                          f"the mutant (kill impossible — coverage vanished): {detail}"))
                    continue
                if status == "run-error":
                    results.append((name, f"{tag}RUN-ERROR << investigate ({detail})"))
                    continue
                if status == "survived":
                    results.append((name, f"{tag}SURVIVED << UNGUARDED"))
                    continue
                if status == "unattributed":
                    # every observed failure was red in the baseline
                    # (impossible after the green-baseline gate, but
                    # pinned explicitly) or the summary disagrees with
                    # the per-test lines.
                    results.append((name, f"{tag}UNATTRIBUTED-FAIL << {detail}"))
                    continue
                # ---- audit fix 3, part 2: reproduce the kill in
                # ISOLATION so an unrelated flake is not credited.
                # g1s6-c2 FIX: --test-name-pattern is a JAVASCRIPT
                # REGEX. Test names contain literal parentheses
                # ("(g1s5-c1 finding 3)", "(dir is a regular file)"),
                # which as unescaped regex GROUPS can never match the
                # very text they quote — node then SKIPS the test and
                # emits "ok N - name # SKIP test name does not match
                # pattern", which parses as "ok": a deterministic kill
                # was being MISREPORTED as FLAKY-NOT-KILLED. Escape
                # metacharacters so the pattern is the literal name.
                iso = run_suite_subset(SUITES, _js_regex_escape(new_fail[0]))
                # g1s7-F3: the ISOLATED re-run must FAIL the test, not
                # skip it (a "not ok ... # SKIP" line would otherwise
                # count as a reproduced failure) and must not be
                # ambiguous (conflicting duplicate lines). Same judge
                # as the sweep run — isolation gets identical
                # integrity rules (audit fix 5).
                iso_status, iso_detail, _ = judge_run(
                    iso, baseline_green, base.skipped, require_iso_fail=new_fail[0])
                if iso_status != "killed":
                    # FLAKE LEDGER lead 2: name the flake — the
                    # sweep-run assertion text for the very test that
                    # failed there, which isolation then threw away.
                    fdig = _failure_digest(r, new_fail[0])
                    results.append((name, f"{tag}FLAKY-NOT-KILLED << {new_fail[0]!r} failed in "
                                          f"the sweep run but not reproduced in isolation "
                                          f"({iso_status}: {iso_detail})"
                                          + (f" [sweep-run: {fdig}]" if fdig else "")))
                    continue
                shown = new_fail[0] if len(new_fail) == 1 else f"{new_fail[0]} (+{len(new_fail) - 1} more)"
                results.append((name, f"{tag}KILLED(test:{shown})"))
            finally:
                _write_durable(SRC, orig)  # restore from memory, fsynced (g1s7-C2b-F1); SIGKILL -> journal
    finally:
        # g1s7-C2c-F2 audit: a failing restore must NOT skip the child
        # reaping or the final-rebuild verdict below. Attempt the
        # durable restore; on error, remember it, still reap, and let
        # the rebuild proceed ONLY from a source we know is pristine
        # (a rebuild over a possibly-still-mutant source would
        # silently bless the mutant build). The atexit restore hook
        # still retries the source, and the journal stays armed when
        # the restore hook fails (C2c-F1).
        with _spawn_atomic():  # g1s7-C2h-F2: mask interrupts across the ENTIRE finally body
            restore_failed = False
            _interrupted = None
            try:
                _write_durable(SRC, orig)
            except OSError as e:
                restore_failed = True
                _safe_print(f"FINAL RESTORE FAILED ({e}) — journal stays armed; "
                      "dist rebuild withheld (source may still hold a mutant)")
            except (SystemExit, KeyboardInterrupt) as e:
                # g1s7-C2g-F2 audit: SIGTERM/SIGINT during the final
                # restore raised SystemExit from _interrupt; the old
                # `except OSError` let it escape the finally BEFORE any
                # dist destruction — SRC ended pristine (atexit) while
                # dist still held the last mutant. Capture it, run the
                # same withhold+destroy path, and re-raise after the
                # finally so the signal's exit code propagates intact
                # (the C2a3-F4 contract).
                _interrupted = e
                restore_failed = True
                _safe_print(f"FINAL RESTORE INTERRUPTED ({type(e).__name__}) — "
                      "dist treated as suspect (source may still hold a mutant)")
            # Contract: no spawned child outlives the sweep — kill any
            # tracked group still alive (atexit covers abnormal exit; this
            # covers the normal path explicitly).
            n = reap_active_children()
            if n:
                _safe_print(f"reaped {n} leaked child process group(s)")
            # g1s5-c1 finding D1: restoring src/ alone leaves dist/ compiled
            # from the LAST MUTANT (tsc emits JS even on type errors, and the
            # last mutant's build was never rebuilt-over). Rebuild from the
            # restored pristine source so a mutate run never leaves a
            # mutant-compiled dist behind (npm test after test:findings would
            # otherwise run mutant-compiled code silently).
            # g6-F5: the FINAL pristine rebuild is part of the contract —
            # if it fails, dist may still hold a mutant build and the
            # verdict below cannot be trusted. Fail loudly.
            # g1s7-C2a3-F4 audit: this must NOT be a `return` inside the
            # finally — returning there REPLACES a pending SystemExit
            # (SIGTERM/SIGINT) or any loop exception, silently converting
            # "interrupted/aborted" into "normal exit 1". Record it; the
            # caller site returns 1 ONLY on the normal-completion path,
            # while an unwinding interrupt/exception propagates untouched.
            # g1s7-C2c-F2 audit: with a FAILED final restore the source is
            # NOT known pristine — rebuilding now could bake a MUTANT into
            # dist and the (green!) rebuild would hide it. Withhold the
            # rebuild; atexit restores+fsyncs the source and the journal
            # stays armed until that succeeds, so the NEXT sweep recovers
            # and rebuilds. This is tracked as a failure.
            pristine_rebuild_needed = False
            if restore_failed:
                final_rebuild_failed = True
                # g1s7-C2d-F2 audit: withholding the rebuild alone left
                # the LAST MUTANT's compiled dist on disk with no marker
                # — an ordinary `npm test` before the next sweep would
                # silently run mutant JavaScript. Destroy the suspect
                # artifacts instead: a missing dist fails LOUDLY, which
                # is strictly better than a silently mutant build. (The
                # next sweep rebuilds pristine from the recovered src.)
                # ONLY DIST is suspect: it is the artifact compiled from
                # the mutated source; the test JS compiles from
                # unmutated test files.
                _destroy_suspect_dist("final restore failed — source not known pristine")
            else:
                # g1s7-C2f-F1 audit: destruction of the suspect dist
                # happens INSIDE _final_rebuild_pristine() — BEFORE the
                # build starts (covers SystemExit/OSError raised from
                # build()) and again if the build did not succeed. The
                # old post-build cleanup ran only when build() returned
                # False; an interrupt during the final tsc bypassed it.
                # g1s7-C2i-F4 audit: the mask must NOT cover the
                # rebuild — a tsc hung inside a full SIGINT/SIGTERM
                # mask made an ordinary interrupt wait out the whole
                # BUILD_TIMEOUT (up to 180 s of apparent unresponsive-
                # ness, inherited by the child too), defeating the
                # interrupt's purpose. Safety does not need it: DIST
                # was destroyed INSIDE the mask (withhold path) or is
                # destroyed by _final_rebuild_pristine's pre-delete —
                # unmasked again, the only survivor of a killed build
                # is at worst THIS build's partial emit from the
                # restored pristine source, and its finally destroys
                # even that. So: record the need here, rebuild outside.
                # g1s7-C2j-F1 audit: 'outside' opened a NEW hole — a
                # signal deferred by the mask fires AT unmask, before
                # _final_rebuild_pristine's pre-delete ever runs;
                # the process then exits with the LAST MUTANT's dist
                # intact while atexit (source pristine, no sticky
                # flag) clears the journal. So the pre-destroy must
                # happen INSIDE the mask, here: it is a fast fs op
                # (the destroy is self-masked), and once DIST is gone
                # every later exit — deferred signal, crash, or the
                # unmasked rebuild itself — leaves at worst a MISSING
                # dist (loud) or this build's partial pristine emit,
                # never a silent mutant.
                _destroy_suspect_dist(
                    "masked pre-rebuild (C2j-F1) — a deferred interrupt must never exit over the last mutant build")
                pristine_rebuild_needed = True
        # g1s7-C2i-F4: unmasked by design — see the branch above. A
        # signal deferred by the mask fires HERE (right after unmask),
        # before the rebuild starts; a signal arriving during the
        # rebuild takes the _final_rebuild_pristine finally path.
        if pristine_rebuild_needed:
            final_rebuild_failed = not _final_rebuild_pristine()
            if final_rebuild_failed:
                _safe_print("FINAL REBUILD FAILED — dist destroyed; verdict withheld")
        # g1s7-C2g-F2: the captured interrupt propagates ONLY after
        # reap + dist destruction have run — the exit status is still
        # the signal's (128+signum), never a swallowed normal exit.
        # (Re-raise stays OUTSIDE the mask so any still-pending
        # deferred signal fires at the unmask, not after the rebuild.)
        if _interrupted is not None:
            raise _interrupted

    if final_rebuild_failed:
        return 1

    for n, r in results:
        print(f"  {n:26s} {r}")
    # g1s6 (audit F3) + g1s6-c2 (fix 3): the ONLY passing verdict is a
    # BEHAVIORALLY ATTRIBUTED kill. "SURVIVED"/"MISS"/"RUN-ERROR"/
    # "UNATTRIBUTED-*"/"FLAKY-*" — or anything else — is a failure;
    # listing only the known bad strings let an unknown outcome fall
    # through to "ALL MUTANTS KILLED" with exit 0.
    # g1s6-c2 FIX: substring "KILLED" is NOT the test — "FLAKY-NOT-
    # KILLED" contains it, so flaky verdicts slipped through the gate
    # and the sweep printed the success banner while the summary
    # showed non-kills. A kill is a verdict that BEGINS with
    # "KILLED(" (after the optional [tsc-error] tag).
    def _is_kill(r: str) -> bool:
        body = r[len("[tsc-error] "):] if r.startswith("[tsc-error] ") else r
        return body.startswith("KILLED(")

    bad = [n for n, r in results if not _is_kill(r)]
    print("ALL MUTANTS KILLED (baseline green, every kill attributed)"
          if not bad else "NON-KILLS: " + ", ".join(bad))
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
