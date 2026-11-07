/**
 * P16 — host wiring integration: the supervisor composition loop driven
 * through src/host/supervise.ts (runHostEpisode) over the REAL modules —
 * FileSteeringQueue (P3b), DecisionJournal (P4), AttemptRunner (P7), the
 * executor dispatcher (P11), the planner (P10), the acceptance evaluator
 * (P14) behind the host's REAL evidence-collecting accept port, the
 * escalation channel (P13), and the budget ledger (P8).
 *
 * Proves the loop is not dead code and the P16 port is honest:
 *  1. happy path: exit-0 worker + a policy gate the host actually RUNS
 *     (graph.policy.gate.cmd) ⇒ the evaluator receives typed, current
 *     evidence, returns 'complete', the loop stops 'accepted-finish', and
 *     the REAL P4 journal carries the acceptance + finish records.
 *  2. honest path: a failing policy gate ⇒ the evaluator says incomplete
 *     (host-collected FAIL evidence, never fabricated), the loop keeps
 *     recovering, and hits the max-iterations cap — the verdict gate is
 *     load-bearing.
 *  3. refusal path: a task naming a model the graph authority does not
 *     approve ⇒ 'initial-run-denied' with NOTHING spawned (the ledger is
 *     consulted before the runner).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEpisodeLayout, type EpisodeGraph } from "../src/episode/journal.js";
import { runHostEpisode, runShell, collectAcceptanceEvidence, observeIdentity } from "../src/host/supervise.js";

async function freshEpisode(t: { diagnostic: (m: string) => void }, graphOver: Partial<EpisodeGraph>): Promise<{ root: string; graph: EpisodeGraph }> {
  const root = await mkdtemp(join(tmpdir(), "tre-host-"));
  const graph: EpisodeGraph = {
    schema: "tre-graph/1",
    episodeId: "ep-host",
    goal: "prove the wiring",
    tasks: [{
      id: "t1",
      persona: "worker",
      promptRef: "prompts/t1.md",
      dependsOn: [],
      acceptance: { criteria: [], requiredChecks: [], artifacts: [] },
    }],
    ...graphOver,
  };
  await createEpisodeLayout(root, graph.episodeId, graph);
  t.diagnostic(`episode root: ${root}`);
  return { root, graph };
}

/** A real script stands in for the worker CLI: exit 0 (the loop only
 *  needs a real process with a real exit; P7 proves the spawn plumbing). */
async function exitZeroWorker(root: string, extra = ""): Promise<string> {
  const p = join(root, "worker.sh");
  await writeFile(p, `#!/bin/sh\n${extra}exit 0\n`);
  await chmod(p, 0o755);
  return p;
}

test("host wiring: exit-0 worker + passing policy gate ⇒ accepted-finish with a real acceptance record", async (t) => {
  // The criterion IS the policy-gate id (EV7: a deterministic criterion
  // is funded by a current PASS gate of the same id), so the host-run
  // policy gate is the ONE piece of current evidence complete needs.
  const { root, graph } = await freshEpisode(t, {
    policy: { baseCommit: "abc123", gate: { cmd: "true" } },
    tasks: [{
      id: "t1", persona: "worker", promptRef: "prompts/t1.md", dependsOn: [],
      acceptance: { criteria: ["policy-gate"], requiredChecks: [], artifacts: [] },
    }],
  });
  const worker = await exitZeroWorker(root);

  const res = await runHostEpisode({
    episodesRoot: root,
    graph,
    taskId: "t1",
    grantedBy: "test-harness",
    workerCommand: worker,
    maxIterations: 3,
    log: (line) => t.diagnostic(line),
  });

  assert.equal(res.result.error, undefined, `no loop error: ${JSON.stringify(res.result.error)}`);
  assert.equal(res.result.stopped, "accepted-finish", `stop=${res.result.stopped} detail=${res.result.detail ?? ""} iters=${JSON.stringify(res.result.iterations)}`);
  assert.ok(res.result.iterations.length >= 1, "the loop ran at least one iteration");

  // The REAL P4 journal must carry the journaled acceptance verdict and
  // the finish decision-outcome.
  const journalRaw = await readFile(join(root, graph.episodeId, "events", "decisions.jsonl"), "utf8");
  const lines = journalRaw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const acceptance = lines.find((l) => l.kind === "acceptance");
  assert.ok(acceptance, "an acceptance record must be journaled");
  assert.equal(acceptance!.verdict, "complete", `acceptance verdict: ${JSON.stringify(acceptance)}`);
  const finish = lines.filter((l) => l.kind === "decision-outcome" && String(l.notes ?? "").includes("finish"));
  assert.ok(finish.length >= 1, "the finish decision-outcome must be journaled");

  // P16: the host's evidence collection is durable — the gate run is
  // appended under the episode dir and referenced by the verdict.
  const evidence = await readFile(join(root, graph.episodeId, "acceptance", "evidence.jsonl"), "utf8");
  assert.match(evidence, /gate .*exit=0/, "the policy-gate run must be recorded as evidence");
});

test("host wiring: a FAILING policy gate yields an honest non-complete verdict and keeps the loop working", async (t) => {
  // Same shape as the happy path but the policy gate exits non-zero: the
  // host must hand the evaluator a current FAIL (typed evidence), the
  // verdict must NOT be complete, and the loop must NOT accept — with no
  // recovery available in-test it stops at the iteration cap.
  const { root, graph } = await freshEpisode(t, {
    policy: { baseCommit: "abc123", gate: { cmd: "exit 1" } },
    tasks: [{
      id: "t1", persona: "worker", promptRef: "prompts/t1.md", dependsOn: [],
      acceptance: { criteria: ["policy-gate"], requiredChecks: [], artifacts: [] },
    }],
  });
  const worker = await exitZeroWorker(root);

  const res = await runHostEpisode({
    episodesRoot: root,
    graph,
    taskId: "t1",
    grantedBy: "test-harness",
    workerCommand: worker,
    maxIterations: 2,
    log: (line) => t.diagnostic(line),
  });

  assert.notEqual(res.result.stopped, "accepted-finish", "a current gate FAIL must never be accepted");

  const journalRaw = await readFile(join(root, graph.episodeId, "events", "decisions.jsonl"), "utf8");
  const lines = journalRaw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const acceptance = lines.find((l) => l.kind === "acceptance");
  assert.ok(acceptance, "the attempted acceptance is still journaled");
  assert.ok(acceptance!.verdict === "incomplete" || acceptance!.verdict === "uncertain",
    `failing evidence yields a non-complete verdict, got ${String(acceptance!.verdict)}`);

  const evidence = await readFile(join(root, graph.episodeId, "acceptance", "evidence.jsonl"), "utf8");
  assert.match(evidence, /exit=1/, "the failed gate run is recorded as evidence");
});

test("host wiring: an unapproved model denies the initial run and spawns NOTHING", async (t) => {
  // The task names a model; the graph authority approves a DIFFERENT one
  // ⇒ the ledger check denies the initial run (fail closed) before the
  // runner is ever reached.
  const { root, graph } = await freshEpisode(t, {
    policy: { authority: { paths: [], notPaths: [], models: ["approved-model"] } },
    tasks: [{
      id: "t1", persona: "worker", promptRef: "prompts/t1.md", dependsOn: [], model: "unapproved-model",
      acceptance: { criteria: [], requiredChecks: [], artifacts: [] },
    }],
  });
  const worker = await exitZeroWorker(root);

  const res = await runHostEpisode({
    episodesRoot: root,
    graph,
    taskId: "t1",
    grantedBy: "test-harness",
    workerCommand: worker,
    log: (line) => t.diagnostic(line),
  });

  assert.equal(res.result.stopped, "initial-run-denied", `stop=${res.result.stopped} detail=${res.result.detail ?? ""}`);
  assert.equal(res.result.iterations.length, 0, "no loop iteration runs when the initial run is denied");

  // Nothing spawned: no attempts log, no attempt dirs.
  const attemptLog = await readFile(join(root, graph.episodeId, "events", "attempts.jsonl"), "utf8").catch(() => "");
  assert.equal(attemptLog.trim(), "", "the runner must never have been reached");

  // The denial IS journaled (docs/18 §2.2): a decision-outcome naming it.
  const journalRaw = await readFile(join(root, graph.episodeId, "events", "decisions.jsonl"), "utf8");
  const denial = journalRaw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((l) => l.kind === "decision-outcome" && String(l.notes ?? "").includes("initial-run-denied"));
  assert.ok(denial, "the initial-run denial must be journalized");
  assert.match(String(denial!.notes), /model-not-approved/, `denial codes: ${String(denial!.notes)}`);
});


// ─── W1 audit-cycle regressions (cycle W1 findings M2/M1/C1/minor-9) ───

test("W1-M2: runShell timeout SIGKILLs the whole process group and labels the cause", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tre-host-kill-"));
  // A leader that NEVER exits (the real timeout shape): the timer must
  // group-SIGKILL it and label the cause. (The W1-era "sleep & true"
  // hang-shape is W2-M4's territory now — the leader's exit reaps the
  // group immediately, so it no longer times out at all.)
  const r = await runShell("sleep 602", root, 1);
  assert.equal(r.cause, "timeout", `cause=${r.cause} code=${r.code}`);
  assert.equal(r.code, -1, "timeout is reported as -1 exit WITH the timeout cause (no conflation)");
  assert.match(r.stderr, /timeout/);
  await new Promise((res) => setTimeout(res, 400));
  let ps = "";
  try { ps = execFileSync("ps", ["-axo", "pid,command"], { encoding: "utf8" }); }
  catch { t.diagnostic("ps unavailable — survivor scan skipped"); return; }
  const survivors = ps.split("\n").filter((l) => l.includes("sleep 602"));
  assert.deepEqual(survivors, [], "no group member survives the timeout SIGKILL");
});

test("W1-M2: a signal death is labeled cause=signal, not conflated with timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "tre-host-signal-"));
  const r = await runShell("kill -TERM $$", root, 10);
  assert.equal(r.cause, "signal");
  assert.equal(r.code, -1);
});

test("W1-C1: evidence identity + artifacts come from the WORKTREE, not the episode dir", async () => {
  const root = await mkdtemp(join(tmpdir(), "tre-host-wt-"));
  const wt = join(root, "wt");
  await mkdir(wt, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: wt });
  await writeFile(join(wt, "out.txt"), "built");
  execFileSync("git", ["add", "out.txt"], { cwd: wt });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"], { cwd: wt });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();

  const graph: EpisodeGraph = {
    schema: "tre-graph/1", episodeId: "ep-wt", goal: "g",
    tasks: [{ id: "t1", persona: "w", promptRef: "p", dependsOn: [], acceptance: { criteria: [], requiredChecks: [], artifacts: ["out.txt"] } }],
    policy: { baseCommit: "not-a-real-sha" }, // DELIBERATELY not the worktree HEAD
  };
  const ev = await collectAcceptanceEvidence({ graph, taskId: "t1", epPath: join(root, "eps"), worktreePath: wt });
  assert.equal(ev.current.sha, sha, "identity is the WORKTREE HEAD, never the baseCommit fallback");
  assert.equal(ev.current.dirty, undefined, "a clean committed worktree is clean");
  assert.equal(ev.artifacts.length, 1);
  assert.equal(ev.artifacts[0]?.exists, true, "the artifact is found IN THE WORKTREE");
});

test("W1-C1: with NO worktree the fallback identity is disclosed dirty-unknown, never clean baseCommit", async () => {
  const root = await mkdtemp(join(tmpdir(), "tre-host-nowt-"));
  const graph: EpisodeGraph = {
    schema: "tre-graph/1", episodeId: "ep-nowt", goal: "g",
    tasks: [{ id: "t1", persona: "w", promptRef: "p", dependsOn: [], acceptance: { criteria: [], requiredChecks: [], artifacts: [] } }],
    policy: { baseCommit: "abc123" },
  };
  const ev = await collectAcceptanceEvidence({ graph, taskId: "t1", epPath: join(root, "eps") });
  assert.equal(ev.current.sha, "abc123");
  assert.equal(ev.current.dirty, true, "the episode dir is NOT the task's tree: the fallback is dirty (unknown), never a clean claim");
  assert.ok(ev.current.dirtyDigest, "the fallback carries an explicit unknown digest");
});

test("W1-M1 + minor-9: dirty identity has a CONTENT-bound digest (porcelain collisions fail closed)", async () => {
  const root = await mkdtemp(join(tmpdir(), "tre-host-dirty-"));
  const wt = join(root, "wt");
  await mkdir(wt, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: wt });
  await writeFile(join(wt, "a.txt"), "one");
  execFileSync("git", ["add", "a.txt"], { cwd: wt });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"], { cwd: wt });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();
  const g: EpisodeGraph = { schema: "tre-graph/1", episodeId: "ep-d", goal: "g", tasks: [{ id: "t1", persona: "w", promptRef: "p", dependsOn: [], acceptance: { criteria: [], requiredChecks: [], artifacts: [] } }] };

  await writeFile(join(wt, "a.txt"), "two");
  const e1 = await collectAcceptanceEvidence({ graph: g, taskId: "t1", epPath: join(root, "eps1"), worktreePath: wt });
  assert.equal(e1.current.sha, sha);
  assert.equal(e1.current.dirty, true, "an uncommitted delta is dirty");
  assert.ok(e1.current.dirtyDigest && e1.current.dirtyDigest.length === 64);

  // The exact minor-9 collision: a DIFFERENT edit to the SAME path
  // shares the porcelain line; the content-bound digest distinguishes.
  await writeFile(join(wt, "a.txt"), "three");
  const e2 = await collectAcceptanceEvidence({ graph: g, taskId: "t1", epPath: join(root, "eps2"), worktreePath: wt });
  assert.notEqual(e1.current.dirtyDigest, e2.current.dirtyDigest, "content edits collide never");
});

test("W1-M1: observeIdentity marks the tree dirty-unknown when git status fails (fail CLOSED)", async () => {
  const root = await mkdtemp(join(tmpdir(), "tre-host-statusfail-"));
  await mkdir(join(root, ".git"), { recursive: true }); // HEAD answers, status will fail
  await writeFile(join(root, ".git", "index.lock"), ""); // classic status-failer
  const id = await observeIdentity(root, "cafe123");
  assert.equal(id.sha, "cafe123");
  assert.equal(id.dirty, true, "a tree whose status cannot be verified is NEVER stamped clean");
  assert.ok(id.dirtyDigest && id.dirtyDigest.length === 64, "the unknown carries an explicit digest");
});

test("W2-M4: a CLEAN exit still reaps the process group (no grandchild outlives exit-0)", async () => {
  // The exact W2 shape: shell exits 0 while a backgrounded survivor
  // lingers in the group. Pre-fix, only the TIMEOUT path group-killed —
  // this survivor would outlive the "success" and keep mutating the
  // tree the evidence just stamped.
  const root = await mkdtemp(join(tmpdir(), "tre-host-reap-"));
  const marker = `tre-w2-reap-${process.pid}-${Date.now()}`;
  const r = await runShell(`( sleep 60 # ${marker}\n) &\nsleep 61 &\necho done\nexit 0`, root, 10);
  assert.equal(r.cause, "exit", "the leader exited 0 (a 'success')");
  assert.equal(r.code, 0);
  // Give SIGKILL one moment to land, then scan the process table.
  await new Promise((res) => setTimeout(res, 400));
  let survivor = "";
  try { survivor = execFileSync("ps", ["-ax", "-o", "pid,command"], { encoding: "utf8" }); } catch { survivor = ""; }
  const lines = survivor.split("\n").filter((l) => l.includes("sleep 61") && !l.includes("grep"));
  assert.equal(lines.length, 0, `no group survivor after clean exit (found: ${lines.join(" | ")})`);
  void marker;
});

test("W2-H1: dirty identity digest is CONTENT-addressed (write-tree), not diff OUTPUT — hostile repo diff config cannot bend it", async () => {
  const root = await mkdtemp(join(tmpdir(), "tre-host-cfg-"));
  const wt = join(root, "wt");
  await mkdir(wt, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: wt });
  await writeFile(join(wt, "a.txt"), "one");
  execFileSync("git", ["add", "a.txt"], { cwd: wt });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"], { cwd: wt });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();

  const graph: EpisodeGraph = {
    schema: "tre-graph/1", episodeId: "ep-cfg", goal: "g",
    tasks: [{ id: "t1", persona: "w", promptRef: "p", dependsOn: [], acceptance: { criteria: [], requiredChecks: [], artifacts: [] } }],
  };
  // Staged edit, identity under the repo's DEFAULT config…
  await writeFile(join(wt, "a.txt"), "two");
  execFileSync("git", ["add", "a.txt"], { cwd: wt });
  const e1 = await collectAcceptanceEvidence({ graph, taskId: "t1", epPath: join(root, "eps"), worktreePath: wt });
  assert.equal(e1.current.sha, sha);
  assert.equal(e1.current.dirty, true);

  // …the SAME content with a hostile repo config that rewrites diff
  // OUTPUT bytes (`git diff --binary HEAD` was the W1 digest input and
  // bends under these): the content-addressed digest must not move.
  const cfg = await readFile(join(wt, ".git", "config"), "utf8");
  await writeFile(join(wt, ".git", "config"), cfg + "\n[diff]\n\tmnemonicPrefix = true\n\tnoprefix = true\n\tignoreSubmodules = all\n[status]\n\tshowUntrackedFiles = no\n", "utf8");
  const e2 = await collectAcceptanceEvidence({ graph, taskId: "t1", epPath: join(root, "eps"), worktreePath: wt });
  assert.equal(e2.current.dirtyDigest, e1.current.dirtyDigest, "same content, hostile diff config — digest MUST NOT move");

  // And a genuinely different staged edit still moves it (no collision).
  await writeFile(join(wt, "a.txt"), "three");
  execFileSync("git", ["add", "a.txt"], { cwd: wt });
  const e3 = await collectAcceptanceEvidence({ graph, taskId: "t1", epPath: join(root, "eps"), worktreePath: wt });
  assert.notEqual(e3.current.dirtyDigest, e2.current.dirtyDigest, "staged content is bound into the digest");
});

test("W2-M5: the policy gate runs under the SAME unified env (GIT_ENV) as the identity observation — and ambient host env is EXCLUDED (audit W3-A4)", async () => {
  // The gate's env is constructed by the host (GIT_ENV), so a marker
  // ONLY that env carries must reach the gate's shell. This pins the
  // unification: the old gate env had PATH alone; a drift back to
  // inherited-env or PATH-only fails here.
  // W3-A4: the EXCLUSION half used to be untested — a secret set in the
  // test process env must NOT reach the gate. A regression to a full
  // inherited env fails the "(unset)" assertion below.
  const root = await mkdtemp(join(tmpdir(), "tre-host-env-"));
  const graph: EpisodeGraph = {
    schema: "tre-graph/1", episodeId: "ep-env", goal: "g",
    tasks: [{ id: "t1", persona: "w", promptRef: "p", dependsOn: [], acceptance: { criteria: [], requiredChecks: [], artifacts: [] } }],
    policy: { gate: { cmd: 'echo "p=$GIT_PORCELAIN n=$GIT_CONFIG_NOSYSTEM t=$GIT_TERMINAL_PROMPT a=${TRE_W3_AMBIENT:-(unset)}"' } },
  };
  assert.ok(!(await import("node:process")).env["GIT_PORCELAIN"], "the marker is NOT in the test process env (no false positive)");
  (await import("node:process")).env["TRE_W3_AMBIENT"] = "sekret-must-not-leak";
  try {
    await mkdir(join(root, "eps"), { recursive: true }); // the gate spawns WITHIN epPath
    const ev = await collectAcceptanceEvidence({ graph, taskId: "t1", epPath: join(root, "eps") });
    const row = ev.gates.find((g) => g.gateId === "policy-gate");
    assert.ok(row !== undefined && row.pass, "the marker-echo gate exits 0");
    const evidence = await readFile(join(root, "eps", "acceptance", "evidence.jsonl"), "utf8");
    assert.ok(evidence.includes("p=1 n=1 t=0"), `gate saw the unified GIT_ENV (evidence: ${evidence.slice(-300)})`);
    assert.ok(evidence.includes("a=(unset)"), "ambient host env is EXCLUDED from the gate (W3-A4)");
    assert.ok(!evidence.includes("sekret-must-not-leak"), "the ambient secret never appears in the evidence");
  } finally {
    delete (await import("node:process")).env["TRE_W3_AMBIENT"];
  }
});

test("W3-A1: untracked file CONTENT is bound into the dirty digest (two contents, one path — the digests move)", async () => {
  // The audit experiment that found the gap, as a regression test:
  // `?? path` porcelain is IDENTICAL for two different contents, so the
  // pre-W3 digest collided. The identity a gate PASS is stamped on must
  // measure every byte that differs between the trees — untracked too.
  const root = await mkdtemp(join(tmpdir(), "tre-host-ut-"));
  const wt = join(root, "wt"); await mkdir(wt);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q"); await writeFile(join(wt, "base.txt"), "b"); g("add", "base.txt"); g("commit", "-q", "-m", "b");
  const sha = g("rev-parse", "HEAD").trim();

  await writeFile(join(wt, "new.txt"), "content-one");
  const i1 = await observeIdentity(wt, sha);
  assert.equal(i1.dirty, true);
  await writeFile(join(wt, "new.txt"), "content-TWO-different");
  const i2 = await observeIdentity(wt, sha);
  assert.notEqual(i2.dirtyDigest, i1.dirtyDigest, "different untracked content under the same path MUST move the digest");

  // Same content again → stable (no spurious movement from mtime/size churn).
  await writeFile(join(wt, "new.txt"), "content-TWO-different");
  const i3 = await observeIdentity(wt, sha);
  assert.equal(i3.dirtyDigest, i2.dirtyDigest, "identical content is digest-stable");

  // Deleting the untracked file returns the tree to CLEAN (no digest at
  // all) — the identity path for "no dirt" must be reachable again.
  const rmSync = (await import("node:fs")).rmSync;
  rmSync(join(wt, "new.txt"));
  const i4 = await observeIdentity(wt, sha);
  assert.notEqual(i4.dirty, true, "tree with the untracked file removed is clean again");
  // A symlinked untracked entry binds its OWN content — the target
  // string via readlink (W4-A2): retargeting the link MOVES the digest,
  // while churn in the target's bytes does NOT (never followed).
  const lnSync = (await import("node:fs")).symlinkSync;
  const outside = join(root, "outside.txt");
  await writeFile(outside, "outside-A");
  lnSync(outside, join(wt, "link"));
  const i5 = await observeIdentity(wt, sha);
  await writeFile(outside, "outside-B"); // target churn: link content unchanged
  const i6 = await observeIdentity(wt, sha);
  assert.equal(i5.dirtyDigest, i6.dirtyDigest, "target-byte churn MUST NOT move the digest — the link is never followed");
  await unlink(join(wt, "link"));
  lnSync(join(root, "other-target.txt"), join(wt, "link")); // retarget
  const i7 = await observeIdentity(wt, sha);
  assert.notEqual(i7.dirtyDigest, i6.dirtyDigest, "retargeting the symlink MUST move the digest (link content = target string, W4-A2)");
});

test("W4-A1: runShell full-capture keeps the FRONT up to maxBytes and flags truncation (tail mode unchanged)", async () => {
  // The audit cycle W4 finding: the legacy 16KiB TAIL cap dropped the
  // front of `git status`/`git diff` output on dirty trees, blinding
  // the identity digest to the earliest entries. Full-capture mode
  // (maxBytes) keeps the front and DISCLOSES a cap hit; the legacy
  // tail mode must stay byte-for-byte unchanged for display callers.
  const gen = "seq -w 1 2000 | while read i; do echo line-$i-padding-padding-padding-padding; done";
  const tail = await runShell(gen, "/", 30);
  assert.ok(tail.stdout.endsWith("line-2000-padding-padding-padding-padding\n"), `tail mode still keeps the LAST 16KiB (got: ${tail.stdout.slice(0, 24)}...)`);
  assert.equal(tail.stdout.length, 16 * 1024, "tail mode caps at exactly 16KiB");
  assert.equal(tail.truncated, undefined, "tail mode never reports truncated");
  const full = await runShell(gen, "/", 30, { maxBytes: 1024 });
  assert.ok(full.stdout.startsWith("line-0001-padding"), "full mode keeps the FRONT");
  assert.equal(full.stdout.length, 1024, "full mode caps at maxBytes");
  assert.equal(full.truncated, true, "a cap hit is DISCLOSED as truncated (fail-closed input upstream)");
  const noCap = await runShell("echo small", "/", 30, { maxBytes: 1024 });
  assert.equal(noCap.stdout.trim(), "small");
  assert.equal(noCap.truncated, undefined, "under the cap: no truncated flag");
});

test("W4-A1: identity digests bind the FIRST-listed entry on trees big enough to have overflowed the old 16KiB cap", async () => {
  // Exact audit reproduction, as a regression test: 600 untracked files
  // (status -z output > 16KiB) — editing the FIRST-listed file used to
  // leave the digest unchanged; same for a large tracked diff.
  const root = await mkdtemp(join(tmpdir(), "tre-host-w4-"));
  const wt = join(root, "wt"); await mkdir(wt);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q"); await writeFile(join(wt, "base.txt"), "b"); g("add", "base.txt"); g("commit", "-q", "-m", "b");
  const sha = g("rev-parse", "HEAD").trim();

  const names = Array.from({ length: 600 }, (_, i) => `untracked_file_with_long_name_${String(i).padStart(4, "0")}.txt`);
  for (const n of names) await writeFile(join(wt, n), "x");
  const u1 = await observeIdentity(wt, sha);
  await writeFile(join(wt, names[0] ?? names[1] ?? "impossible.txt"), "CHANGED");
  const u2 = await observeIdentity(wt, sha);
  assert.notEqual(u2.dirtyDigest, u1.dirtyDigest, "edit to the FIRST-listed of 600 untracked files MUST move the digest (the W4-A1 repro)");
  for (const n of names) await unlink(join(wt, n));

  for (let i = 0; i < 40; i++) await writeFile(join(wt, `t${String(i).padStart(2, "0")}.txt`), "line\n".repeat(800));
  g("add", "."); g("commit", "-q", "-m", "tracked");
  const sha2 = g("rev-parse", "HEAD").trim();
  for (let i = 0; i < 40; i++) await writeFile(join(wt, `t${String(i).padStart(2, "0")}.txt`), "changed\n".repeat(800));
  const d1 = await observeIdentity(wt, sha2);
  await writeFile(join(wt, "t00.txt"), "changed-AGAIN\n".repeat(800));
  const d2 = await observeIdentity(wt, sha2);
  assert.notEqual(d2.dirtyDigest, d1.dirtyDigest, "edit to the FIRST-listed file of a >16KiB tracked diff MUST move the digest");
});

test("W4-A1: a truncated observation FAILS CLOSED to dirty-unknown (tiny capture cap never digests partial state as complete)", async () => {
  // The fail-closed contract of full-capture: when the capture cap cuts
  // the status output, the identity must NOT be a digest of the partial
  // list (that is the W4-A1 bug class) — it lands dirty-UNKNOWN.
  const root = await mkdtemp(join(tmpdir(), "tre-host-w4cap-"));
  const wt = join(root, "wt"); await mkdir(wt);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q"); await writeFile(join(wt, "base.txt"), "b"); g("add", "base.txt"); g("commit", "-q", "-m", "b");
  const sha = g("rev-parse", "HEAD").trim();
  await writeFile(join(wt, "u1.txt"), "one");
  await writeFile(join(wt, "u2.txt"), "two");

  const full = await observeIdentity(wt, sha); // default 64MiB cap: complete
  const capped = await observeIdentity(wt, sha, 16); // 16 bytes: status is cut
  assert.equal(capped.dirty, true, "a truncated observation is dirty, never clean");
  assert.notEqual(capped.dirtyDigest, full.dirtyDigest, "the capped identity is NOT the digest of the partial list");
  // Determinism of the fail-closed path (same tree, same cap, same answer):
  const capped2 = await observeIdentity(wt, sha, 16);
  assert.equal(capped2.dirtyDigest, capped.dirtyDigest, "fail-closed identity is deterministic");
});
