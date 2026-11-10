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
import { mkdtemp, mkdir, readFile, writeFile, chmod, unlink, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEpisodeLayout, type EpisodeGraph } from "../src/episode/journal.js";
import { runHostEpisode, runShell, collectAcceptanceEvidence, observeIdentity, runObservedGit, fileDigest, filterNeutralizeArgs } from "../src/host/supervise.js";
import { sameArtifact } from "../src/acceptance/evaluator.js";
import { makeTelegramDeliver } from "../src/telegram/escalation.js";

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

  // R3-F2 (audit round-3): the acceptance evidence must bind to an
  // OBSERVABLE tree — an unmeasured (no-worktree) identity now refuses
  // comparison against everything, so a real acceptance needs a real
  // git worktree (the fallback path is tested for its refusal below).
  const wt = join(root, "wt");
  await mkdir(wt, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: wt });
  await writeFile(join(wt, "f.txt"), "base\n");
  execFileSync("git", ["add", "f.txt"], { cwd: wt });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"], { cwd: wt });

  const res = await runHostEpisode({
    episodesRoot: root,
    graph,
    taskId: "t1",
    grantedBy: "test-harness",
    workerCommand: worker,
    worktreePath: wt,
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
  // R3-F2 (audit round-3): an unmeasured identity is flagged unobservable
  // and refuses comparison against EVERYTHING (incl. itself) — an
  // evidence/identity self-comparison from one failed observation can
  // never certify acceptance.
  assert.equal(ev.current.unobservable, true, "the no-worktree fallback is UNOBSERVABLE, not merely dirty");
  assert.ok(!sameArtifact(ev.current, ev.current), "an unobservable identity never equals itself");
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

test("W5-A1/W6: a tracked diff LARGER than any capture cap is fully bound — a late-file edit moves the digest (streaming hash, cap retired)", async () => {
  // The W5 fail-open: a diff past the capture cap was hashed as a
  // prefix (or a truncated marker), so an edit to a late-sorting file
  // left the digest unchanged. W6 streams every diff byte through
  // sha256 (constant memory): the cap no longer applies to the diff,
  // so ANY edit moves the digest at ANY maxBytes.
  const root = await mkdtemp(join(tmpdir(), "tre-host-w6-"));
  const wt = join(root, "wt"); await mkdir(wt);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q"); await writeFile(join(wt, "a-big.txt"), "seed\n"); await writeFile(join(wt, "z-small.txt"), "seed\n"); g("add", "."); g("commit", "-q", "-m", "b");
  const sha = g("rev-parse", "HEAD").trim();
  await writeFile(join(wt, "a-big.txt"), "x".repeat(200 * 1024) + "\n"); // diff >> any cap
  await writeFile(join(wt, "z-small.txt"), "small-A\n");
  const a = await observeIdentity(wt, sha, 1024); // tiny cap: old code truncated here
  await writeFile(join(wt, "z-small.txt"), "small-B\n"); // edit PAST the old cap position
  const b = await observeIdentity(wt, sha, 1024);
  assert.notEqual(b.dirtyDigest, a.dirtyDigest, "a late-file edit MUST move the digest even when the diff exceeds maxBytes");
  const complete = await observeIdentity(wt, sha); // default: no cap on the diff
  assert.equal(b.dirtyDigest, complete.dirtyDigest, "with streaming hash the cap no longer changes the identity at all (no marker, no fail-closed downgrade)");
});

test("W6: runShell hashStdout digests the FULL stream (multi-chunk) and withholds the digest on a cut-short stream", async () => {
  // hash mode: every byte hashed, stdout never accumulated; a timeout
  // (stream cut short) yields NO digest — callers fail closed.
  const big = "0123456789".repeat(20000); // 200KB: many pipe chunks
  const r = await runShell(`printf '%s' '${big}'`, tmpdir(), 30, { hashStdout: true });
  assert.equal(r.code, 0);
  const expect = createHash("sha256").update(big).digest("hex");
  assert.equal(r.stdoutDigest, expect, "digest covers every streamed byte");
  assert.equal(r.stdout, "", "stdout is NOT accumulated in hash mode (constant memory)");
  const t = await runShell("echo started; sleep 5", tmpdir(), 1, { hashStdout: true });
  assert.equal(t.cause, "timeout");
  assert.equal(t.stdoutDigest, undefined, "a cut-short stream has NO digest (never a partial one)");
});

test("W5-A2: a mid-file edit in a >16 MiB untracked file MOVES the digest (no size-only fallback)", async () => {
  // Audit probe P2: files over 16 MiB were recorded by size only, so a
  // same-size edit mid-file was invisible. Every byte is now hashed.
  const root = await mkdtemp(join(tmpdir(), "tre-host-w5a2-"));
  const wt = join(root, "wt"); await mkdir(wt);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q"); await writeFile(join(wt, "base.txt"), "b"); g("add", "base.txt"); g("commit", "-q", "-m", "b");
  const sha = g("rev-parse", "HEAD").trim();
  const big = join(wt, "untracked-big.bin");
  await writeFile(big, Buffer.alloc(17 * 1024 * 1024, 0x41));
  const u1 = await observeIdentity(wt, sha);
  const fh = await open(big, "r+"); await fh.write("B", 8 * 1024 * 1024); await fh.close();
  const u2 = await observeIdentity(wt, sha);
  assert.notEqual(u2.dirtyDigest, u1.dirtyDigest, "a mid-file edit in a >16 MiB untracked file MUST move the digest");
});

test("W7-A1: a stale NUMERIC 4th arg to runObservedGit is a maxBytes request, never a silent 16KiB tail", async () => {
  // Audit probe: the 4th param changed from `maxBytes: number` to an
  // options object. A stale JS caller passing a number had it swallowed
  // as an options object, so maxBytes was undefined → legacy 16 KiB TAIL
  // with `truncated` UNSET (27300-byte status returned 16384, nothing
  // failed closed). That is the W4-A1 blindness re-entering by the API.
  const root = await mkdtemp(join(tmpdir(), "tre-host-w7a1-"));
  const wt = join(root, "wt"); await mkdir(wt);
  execFileSync("git", ["init", "-q"], { cwd: wt });
  for (let i = 0; i < 700; i++) await writeFile(join(wt, `untracked-with-a-long-name-${String(i).padStart(4, "0")}.txt`), "x");
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
  const stale = await runObservedGit(wt, args, 10, 64 * 1024 * 1024 as unknown as { maxBytes?: number });
  const correct = await runObservedGit(wt, args, 10, { maxBytes: 64 * 1024 * 1024 });
  assert.ok(correct.stdout.length > 16 * 1024, "fixture must exceed the legacy 16KiB tail");
  assert.equal(stale.stdout.length, correct.stdout.length, "a numeric 4th arg must FULL-capture, not fall back to the tail");
  assert.notEqual(stale.stdout.length, 16384, "must never silently return the 16KiB tail");
});

test("W7-A2: runObservedGit REFUSES maxBytes + hashStdout together (ambiguous capture modes)", async () => {
  // Probe: the combo returned EMPTY stdout WITH a digest — a caller
  // asking for a capped copy got no copy and no truncation flag.
  const root = await mkdtemp(join(tmpdir(), "tre-host-w7a2-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  await assert.rejects(
    () => runObservedGit(root, ["status", "--porcelain=v1"], 10, { maxBytes: 1024, hashStdout: true }),
    /mutually exclusive/,
    "the ambiguous combination must be refused, not guessed",
  );
});

test("W7-A3: the write-tree observation is bounded (small capture) yet still yields the full tree sha", async () => {
  // Audit: write-tree ran with the DEFAULT 64 MiB capture while its
  // output is a single 40-byte sha — inconsistent with every other
  // identity run and needlessly large a buffer. CONSISTENCY fix: this
  // test passes on pre-W7 code too (it is a guard, not a regression
  // proof — the old behavior was wasteful, not wrong).
  const root = await mkdtemp(join(tmpdir(), "tre-host-w7a3-"));
  const wt = join(root, "wt"); await mkdir(wt);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q"); await writeFile(join(wt, "f.txt"), "f"); g("add", "."); g("commit", "-q", "-m", "b");
  const sha = g("rev-parse", "HEAD").trim();
  await writeFile(join(wt, "f.txt"), "changed");
  const id = await observeIdentity(wt, sha);
  assert.equal(id.dirty, true, "still observes dirt correctly under the bounded write-tree run");
  const wt2 = await runObservedGit(wt, ["write-tree"], 10, { maxBytes: 4096 });
  assert.equal(wt2.code, 0);
  assert.match(wt2.stdout.trim(), /^[0-9a-f]{40}$/, "write-tree output fits the small cap intact");
  assert.equal(wt2.truncated ?? false, false, "never truncated at 4096 for a tree sha");
});

test("W8-A1: a LARGE artifact is digested by streaming — exists:true, constant memory, no readFile limit", async () => {
  // Audit of the W5/W6 streaming work, end-to-end: fileDigest still did a
  // whole-file readFile, so a big artifact was slurped (probe: 1.5 GiB
  // artifact → 1546 MB RSS) and anything past Node's buffer limit THREW
  // → mapped to exists:false, i.e. a PRESENT artifact reported "proven
  // missing" (probe: 3 GiB file that exists → exists:false → incomplete
  // verdict). The digest must be streamed, with no size ceiling.
  const root = await mkdtemp(join(tmpdir(), "tre-host-w8a1-"));
  const wt = join(root, "wt"); await mkdir(wt);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q"); await writeFile(join(wt, "src.txt"), "one"); g("add", "."); g("commit", "-q", "-m", "base");
  // 256 MiB: well past what a small-buffer readFile test would tolerate,
  // cheap enough for CI (sparse-ish, written in one go).
  const art = join(wt, "big-artifact.bin");
  const fh = await open(art, "w"); await fh.truncate(256 * 1024 * 1024); await fh.close();
  const graph: EpisodeGraph = {
    schema: "tre-graph/1", episodeId: "ep-w8", goal: "g",
    tasks: [{ id: "t1", persona: "w", promptRef: "p", dependsOn: [], acceptance: { criteria: [], requiredChecks: [], artifacts: ["big-artifact.bin"] } }],
    policy: { baseCommit: g("rev-parse", "HEAD").trim() },
  };
  const before = process.memoryUsage().rss;
  const e = await collectAcceptanceEvidence({ graph, taskId: "t1", epPath: join(root, "eps"), worktreePath: wt });
  const rssMB = Math.round((process.memoryUsage().rss - before) / 1048576);
  assert.equal(e.artifacts[0]?.exists, true, "a PRESENT large artifact must never be reported missing");
  assert.match(e.artifacts[0]?.digest ?? "", /^[0-9a-f]{64}$/, "EV4: exists:true requires a real digest");
  assert.ok(rssMB < 128, `digest must stream, not slurp (RSS delta ${rssMB}MB)`);
});

test("W8-A2: fileDigest agrees with a whole-file hash and rejects non-files", async () => {
  const root = await mkdtemp(join(tmpdir(), "tre-host-w8a2-"));
  const p = join(root, "f.bin");
  const content = Buffer.from([0xff, 0x00, 0x41, 0x80]);
  await writeFile(p, content);
  assert.equal(await fileDigest(p), createHash("sha256").update(content).digest("hex"), "streamed hash == whole-buffer hash");
  assert.equal(await fileDigest(join(root, "nope")), undefined, "missing file → undefined (unknown, never a fake digest)");
  await mkdir(join(root, "adir"));
  assert.equal(await fileDigest(join(root, "adir")), undefined, "a directory is not an artifact");
});

test("W9-A1: the loop never accepts a STALE stamp — a tamper after observation is caught or not accepted", async (t) => {
  // Full-loop probe (audit W9): the existing wiring tests use
  // baseCommit:"abc123" with NO worktree, so they never exercise a real
  // git tree end-to-end. Here a worker exits 0 leaving a background
  // writer. The writer is TRIGGERED BY THE EVIDENCE FILE (not a fixed
  // sleep — a 150ms sleep made this test flaky under suite load, because
  // both observations could legitimately finish first).
  //
  // The invariant asserted is timing-independent: the loop must never
  // end accepted-finish while the artifact on disk differs from the
  // digest it stamped. Either it re-observes and rejects (uncertain), or
  // it accepted a snapshot that was still true.
  const { root, graph } = await freshEpisode(t, {
    policy: { baseCommit: "abc123", gate: { cmd: "true" } },
    tasks: [{
      id: "t1", persona: "worker", promptRef: "prompts/t1.md", dependsOn: [],
      acceptance: { criteria: ["policy-gate"], requiredChecks: [], artifacts: ["out.txt"] },
    }],
  });
  const wt = join(root, "wt");
  await mkdir(wt, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q"); await writeFile(join(wt, "src.txt"), "one"); g("add", "."); g("commit", "-q", "-m", "base");

  const evPath = join(root, graph.episodeId, "acceptance", "evidence.jsonl");
  const worker = join(root, "worker-tamper.sh");
  // good artifact, exit 0, then tamper ONLY once the first artifact
  // observation is on disk (so the tamper lands during the loop).
  await writeFile(worker, `#!/bin/sh
echo good > out.txt
(
  i=0
  while [ $i -lt 200 ]; do
    if grep -q "artifact 'out.txt'" ${JSON.stringify(evPath)} 2>/dev/null; then
      echo TAMPERED > out.txt
      exit 0
    fi
    i=$((i+1)); sleep 0.01
  done
) &
exit 0
`);
  await chmod(worker, 0o755);

  const res = await runHostEpisode({
    episodesRoot: root, graph, taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: wt, maxIterations: 3,
    log: (line) => t.diagnostic(line),
  });

  const evidence = await readFile(evPath, "utf8");
  const digests = [...evidence.matchAll(/artifact 'out\.txt': exists digest=([0-9a-f]{12})/g)].map((m) => m[1]);
  assert.ok(digests.length >= 1, "the artifact must be observed at least once");
  const stamped = digests[digests.length - 1]!;
  const onDisk = createHash("sha256").update((await readFile(join(wt, "out.txt"), "utf8")).trim() + "\n").digest("hex").slice(0, 12);

  // The tamper must actually have been exercised for this test to mean
  // anything: either two distinct observations, or a non-accept stop.
  const exercised = digests.length > 1 && new Set(digests).size > 1;
  assert.ok(exercised || res.result.stopped !== "accepted-finish", "the tamper must have been exercised");

  // THE INVARIANT: no accepted-finish on a stamp that no longer matches.
  if (res.result.stopped === "accepted-finish") {
    assert.equal(stamped, onDisk, `accepted-finish must stamp what is on disk (stamped ${stamped}, disk ${onDisk})`);
  } else {
    const decisions = (await readFile(join(root, graph.episodeId, "events", "decisions.jsonl"), "utf8"))
      .trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const verdicts = decisions.filter((d) => d.kind === "acceptance").map((d) => d.verdict);
    assert.ok(verdicts.includes("uncertain") || decisions.some((d) => String(d.notes ?? "").includes("accept-finish rejected")),
      `a non-accept stop must be caused by the re-observation (verdicts ${JSON.stringify(verdicts)})`);
  }
});

test("W9-A2: a real worktree runs the whole loop green (gate + artifact + identity)", async (t) => {
  // The control for W9-A1: same real-worktree shape WITHOUT the tamper
  // accepts cleanly, so the rejection above is caused by the tamper and
  // not by the worktree plumbing.
  const { root, graph } = await freshEpisode(t, {
    policy: { baseCommit: "abc123", gate: { cmd: "test -f src.txt" } },
    tasks: [{
      id: "t1", persona: "worker", promptRef: "prompts/t1.md", dependsOn: [],
      acceptance: { criteria: ["policy-gate"], requiredChecks: [], artifacts: ["out.txt"] },
    }],
  });
  const wt = join(root, "wt");
  await mkdir(wt, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q"); await writeFile(join(wt, "src.txt"), "one"); g("add", "."); g("commit", "-q", "-m", "base");
  const worker = join(root, "worker-clean.sh");
  await writeFile(worker, `#!/bin/sh\necho changed > src.txt\necho built > out.txt\nexit 0\n`);
  await chmod(worker, 0o755);

  const res = await runHostEpisode({
    episodesRoot: root, graph, taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: wt, maxIterations: 2,
    log: (line) => t.diagnostic(line),
  });
  assert.equal(res.result.error, undefined, `no loop error: ${JSON.stringify(res.result.error)}`);
  assert.equal(res.result.stopped, "accepted-finish", `stop=${res.result.stopped}`);
  const evidence = await readFile(join(root, graph.episodeId, "acceptance", "evidence.jsonl"), "utf8");
  assert.match(evidence, /gate .*exit=0/, "the policy gate ran in the real worktree");
  assert.match(evidence, /artifact 'out.txt': exists digest=[0-9a-f]{12}/, "the artifact was digested");
});

test("W9-A3: a worker's leftover background process is REAPED by the loop", async (t) => {
  // W2-M4 proved the GATE's group is killed; this proves the same for the
  // WORKER spawned by the loop (probe: 0 survivors after a 60s lingerer).
  const { root, graph } = await freshEpisode(t, {
    policy: { baseCommit: "abc123", gate: { cmd: "true" } },
    tasks: [{
      id: "t1", persona: "worker", promptRef: "prompts/t1.md", dependsOn: [],
      acceptance: { criteria: ["policy-gate"], requiredChecks: [], artifacts: [] },
    }],
  });
  const marker = `tre-w9-reap-${process.pid}-${Date.now()}`;
  const worker = join(root, "worker-linger.sh");
  await writeFile(worker, `#!/bin/sh\n( sleep 60 # ${marker}\n) &\nexit 0\n`);
  await chmod(worker, 0o755);
  await runHostEpisode({
    episodesRoot: root, graph, taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, maxIterations: 1, log: (line) => t.diagnostic(line),
  });
  await new Promise((r) => setTimeout(r, 500));
  let ps = "";
  try { ps = execFileSync("ps", ["-ax", "-o", "pid,command"], { encoding: "utf8" }); } catch { ps = ""; }
  const survivors = ps.split("\n").filter((l) => l.includes(marker) && !l.includes("grep"));
  assert.equal(survivors.length, 0, `no worker group survivor (found: ${survivors.join(" | ")})`);
});

test("W10-C1: the fallback digest labels WHY there is no identity (episode-dir vs worktree-unobservable)", async () => {
  // The label is hashed, so the test reproduces the expected digest for
  // each branch. These are the only two reasons identity collection can
  // fail, and they must be distinguishable in evidence — and the second
  // must NOT be the bare word "given", which read like a reason rather
  // than a cause (a worktree WAS given; git just could not answer).
  const h = (s: string) => createHash("sha256").update(s).digest("hex");
  const graph: EpisodeGraph = {
    schema: "tre-graph/1", episodeId: "ep-fb", goal: "g",
    tasks: [{ id: "t1", persona: "w", promptRef: "p", dependsOn: [], acceptance: { criteria: [], requiredChecks: [], artifacts: [] } }],
    policy: { baseCommit: "abc123" },
  };
  const root = await mkdtemp(join(tmpdir(), "tre-host-fb-"));

  const noWorktree = await collectAcceptanceEvidence({ graph, taskId: "t1", epPath: join(root, "eps") });
  assert.equal(noWorktree.current.dirtyDigest, h("no-worktree:fallback=episode-dir"),
    "no worktree supplied => episode-dir");

  const wt = join(root, "not-a-repo");
  await mkdir(wt, { recursive: true });
  const unobservable = await collectAcceptanceEvidence({ graph, taskId: "t1", epPath: join(root, "eps"), worktreePath: wt });
  assert.equal(unobservable.current.dirtyDigest, h("no-worktree:fallback=worktree-unobservable"),
    "worktree supplied but git failed => worktree-unobservable");
  assert.notEqual(unobservable.current.dirtyDigest, noWorktree.current.dirtyDigest,
    "the two causes must be distinguishable in evidence");
  assert.equal(unobservable.current.dirty, true, "an unobservable worktree is still dirty-unknown, never a clean claim");
});

// ─── Audit cycle W11 (x-model audit of the P16 host wiring) ───────────────

test("W11-A1 (A-C1): --assume-unchanged cannot stamp a tampered tree CLEAN (and different tampers move the digest)", async () => {
  // The confirmed exploit (auditor A, probe A02§M1/A13§I1): a worker runs
  // `git update-index --assume-unchanged f` then overwrites f — porcelain
  // status goes BLIND to the delta, empty porcelain stamped the tampered
  // tree clean, and the loop accepted-finished over a BACKDOOR. The fix
  // reads the index flags straight off `git ls-files -v -z` (immune to
  // the blindness): any non-`H` entry fails closed, and the flagged
  // files' ON-DISK bytes join the digest so distinct tampers discriminate.
  const root = await mkdtemp(join(tmpdir(), "tre-host-aum-"));
  const wt = join(root, "wt"); await mkdir(wt);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q"); await writeFile(join(wt, "a.txt"), "clean"); g("add", "."); g("commit", "-q", "-m", "base");
  const sha = g("rev-parse", "HEAD").trim();

  const i0 = await observeIdentity(wt, sha);
  assert.equal(i0.dirty, undefined, "control: the flag-free tree is clean");

  g("update-index", "--assume-unchanged", "a.txt");
  await writeFile(join(wt, "a.txt"), "BACKDOOR-1");
  const i1 = await observeIdentity(wt, sha);
  assert.equal(i1.dirty, true, "assume-unchanged + tamper MUST be dirty (regression: was stamped CLEAN)");
  assert.ok(i1.dirtyDigest, "flagged dirt carries a digest");

  await writeFile(join(wt, "a.txt"), "BACKDOOR-2-different");
  const i2 = await observeIdentity(wt, sha);
  assert.notEqual(i2.dirtyDigest, i1.dirtyDigest, "two different tampers under one flag MUST move the digest");

  // Even a FLAG with matching content is dirt the human must see: the
  // flag itself is a blindfold git can be asked to wear at any moment.
  await writeFile(join(wt, "a.txt"), "clean"); // back to committed bytes
  const i3 = await observeIdentity(wt, sha);
  assert.equal(i3.dirty, true, "an assume-unchanged entry is dirty-unknown EVEN with content matching HEAD (the flag is the blindfold)");
});

test("W11-A2 (A-C2): --skip-worktree cannot stamp a tampered tree CLEAN (and is digest-distinguishable from assume-unchanged)", async () => {
  // The A-C2 variant (probe A02§M2/A13§I2/A15§S): `--skip-worktree`
  // (tag S) hides the on-disk delta the same way — and the host's own
  // core.sparseCheckout=false pin made it WORSE (on git 2.54 the flag-
  // stripped status sees nothing at all). Same ls-files -v catch; the
  // tag letter (h vs S) is bound into the digest, so the two blindfolds
  // are never conflated.
  const root = await mkdtemp(join(tmpdir(), "tre-host-skiwt-"));
  const wt = join(root, "wt"); await mkdir(wt);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q"); await writeFile(join(wt, "a.txt"), "clean"); g("add", "."); g("commit", "-q", "-m", "base");
  const sha = g("rev-parse", "HEAD").trim();

  g("update-index", "--skip-worktree", "a.txt");
  await writeFile(join(wt, "a.txt"), "BACKDOOR-1");
  const i1 = await observeIdentity(wt, sha);
  assert.equal(i1.dirty, true, "skip-worktree + tamper MUST be dirty (regression: was stamped CLEAN)");

  await writeFile(join(wt, "a.txt"), "BACKDOOR-2-different");
  const i2 = await observeIdentity(wt, sha);
  assert.notEqual(i2.dirtyDigest, i1.dirtyDigest, "distinct S-flag tampers MUST move the digest");

  // Same content under the OTHER blindfold → different digest (tag bound).
  g("update-index", "--no-skip-worktree", "a.txt");
  g("update-index", "--assume-unchanged", "a.txt");
  await writeFile(join(wt, "a.txt"), "BACKDOOR-1");
  const i3 = await observeIdentity(wt, sha);
  assert.notEqual(i3.dirtyDigest, i1.dirtyDigest, "S:h and H-flagged… the SAME bytes under different flags MUST NOT collide");
});

test("W11-A3 (A-C3): .git/info/exclude (worker-authorable, inside the tree) cannot hide untracked content", async () => {
  // The confirmed exploit (probe A12 X1/X2/X3): `core.excludesFile=
  // /dev/null` only kills the GLOBAL excludes — $GIT_DIR/info/exclude is
  // always active and a worker owns it. One entry there hid a whole
  // payload and the tree observed CLEAN. The fix runs `git ls-files
  // --others` with NO exclude sources applied: anything it sees that
  // porcelain did not is hidden dirt — fail closed, digest binding the
  // hidden paths AND their content.
  const root = await mkdtemp(join(tmpdir(), "tre-host-excl-"));
  const wt = join(root, "wt"); await mkdir(wt);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q"); await writeFile(join(wt, "base.txt"), "b"); g("add", "."); g("commit", "-q", "-m", "b");
  const sha = g("rev-parse", "HEAD").trim();

  await writeFile(join(wt, ".git", "info", "exclude"), "payload.txt\n");
  await writeFile(join(wt, "payload.txt"), "stolen-credentials-1");
  const i1 = await observeIdentity(wt, sha);
  assert.equal(i1.dirty, true, "content hidden by info/exclude MUST be dirty (regression: was stamped CLEAN)");

  await writeFile(join(wt, "payload.txt"), "stolen-credentials-2");
  const i2 = await observeIdentity(wt, sha);
  assert.notEqual(i2.dirtyDigest, i1.dirtyDigest, "two payloads under one hidden path MUST move the digest");

  // Remove the hidden file: the clean path must still be REACHABLE
  // (the fix must not pin every tree dirty for having an exclude file).
  const rm = (await import("node:fs")).rmSync;
  rm(join(wt, "payload.txt"));
  await writeFile(join(wt, ".git", "info", "exclude"), "");
  const i3 = await observeIdentity(wt, sha);
  assert.equal(i3.dirty, undefined, "with nothing hidden, the tree is clean again");
});

test("W11-A4 (A-M1): worker-authored clean/smudge filters cannot collapse two different contents into one digest", async () => {
  // The confirmed collision (probe A03): a filter driver defined in the
  // repo config (`filter.evil.clean = cat >/dev/null; echo CONSTANT`) +
  // a tracked .gitattributes made git's diff see ONE constant for any
  // two tampered contents — same dirtyDigest, different trees. A config
  // WILDCARD override loses to exact keys (probe, git 2.54), so the fix
  // ENUMERATES every defined driver and re-sets each EXACT key to `cat`
  // (the identity filter) with command-line precedence.
  const root = await mkdtemp(join(tmpdir(), "tre-host-filt-"));
  const wt = join(root, "wt"); await mkdir(wt);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q");
  g("config", "filter.evil.clean", "cat >/dev/null; echo CONSTANT");
  await writeFile(join(wt, ".gitattributes"), "*.txt filter=evil\n");
  await writeFile(join(wt, "a.txt"), "clean");
  g("add", "."); g("commit", "-q", "-m", "base");
  const sha = g("rev-parse", "HEAD").trim();

  await writeFile(join(wt, "a.txt"), "TAMPER-ONE");
  const i1 = await observeIdentity(wt, sha);
  assert.equal(i1.dirty, true);
  await writeFile(join(wt, "a.txt"), "TAMPER-TWO");
  const i2 = await observeIdentity(wt, sha);
  assert.notEqual(i2.dirtyDigest, i1.dirtyDigest, "two contents through a worker-authored clean filter MUST NOT collide (regression: both hashed to one CONSTANT diff)");
});

test("C2-F1/F1b (p12c5 cycle-2 audit): a PROCESS filter is enumerated and pinned DISABLED (empty value), never `=cat`", async () => {
  // Cycle-1 F2 neutralized clean/smudge drivers only. git 2.54 probe
  // (C2-F1): a `process` driver REPLACES clean+smudge when set — a
  // clean/smudge-only enumeration let a process driver keep converting
  // bytes under a supposedly neutralized observation. Fix: the
  // enumeration regex covers clean|smudge|process.
  // C2-F1b probe: the PIN VALUE for a process key MUST be the empty
  // string (git's documented "disable this filter"). `=cat` is WRONG:
  // git spawns `cat` as a filter SERVER, the handshake fails
  // ("expected git-filter-server", "cat died of signal 15") and —
  // worse — the command still EXITS 0 REPORTING CLEAN: a false-clean
  // oracle replacing the very fraud the neutralization exists to kill.
  const root = await mkdtemp(join(tmpdir(), "tre-host-procfilt-"));
  const wt = join(root, "wt"); await mkdir(wt);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q");
  // A process filter that answers the CLEAN query with the committed
  // bytes for ANY input (the C2-F1 forge shape).
  const pf = join(root, "pf.py");
  await writeFile(pf, [
    "#!/usr/bin/env python3",
    "import sys",
    "inp, out = sys.stdin.buffer, sys.stdout.buffer",
    "def rpk():",
    "    h = inp.read(4)",
    "    if len(h) < 4: return None",
    "    n = int(h, 16)",
    "    return b'' if n == 0 else inp.read(n - 4)",
    "def wpk(d):",
    "    out.write(b'%04x' % (len(d) + 4)); out.write(d)",
    "def flush(): out.write(b'0000'); out.flush()",
    "wpk(b'git-filter-server'); wpk(b'version=2')",
    "wpk(b'capability<clean>=true'); wpk(b'capability<smudge>=true'); flush()",
    "while True:",
    "    cmd = None",
    "    while True:",
    "        p = rpk()",
    "        if p is None: sys.exit(0)",
    "        if p == b'': break",
    "        s = p.decode('utf-8', 'replace')",
    "        if s.startswith('command='): cmd = s[8:]",
    "    if cmd in ('clean', 'smudge'):",
    "        data = b''",
    "        while True:",
    "            p = rpk()",
    "            if p is None: sys.exit(0)",
    "            if p == b'': break",
    "            data += p",
    "        wpk(b'success'); flush()",
    "        wpk(b'base\\n'); flush()",
  ].join("\n"));
  await chmod(pf, 0o755);
  g("config", "filter.evil.process", pf);
  await writeFile(join(wt, ".gitattributes"), "*.txt filter=evil\n");
  await writeFile(join(wt, "a.txt"), "base\n");
  g("add", "."); g("commit", "-q", "-m", "base");

  // (1) The enumeration MUST see the process driver and pin it with the
  //     EMPTY value — `=cat` would be the false-clean oracle.
  const pinArgs = await filterNeutralizeArgs(wt);
  assert.ok(pinArgs !== null, "the driver set is observable");
  assert.ok(pinArgs.includes("-c"), "argv carries config overrides");
  const pin = pinArgs!.slice(2);
  assert.ok(pin.includes("filter.evil.process=") && !pin.includes("filter.evil.process=cat"),
    `a process driver must be pinned to the EMPTY value (documented disable), got ${JSON.stringify(pin)}`);

  // (2) Under the pinned argv the raw forged bytes are VISIBLE: the
  //     neutralized status reports the tamper instead of converting it
  //     away (and terminates — a live process filter would hold it).
  await writeFile(join(wt, "a.txt"), "FORGED");
  const st = await runObservedGit(wt, [...pinArgs!, "status", "--porcelain=v1", "-z"], 10);
  assert.equal(st.cause, "exit");
  assert.equal(st.code, 0);
  assert.match(st.stdout, /M/, "with the process driver DISABLED, the forged bytes MUST show as modified (a `=cat` pin would spawn cat, fail the handshake, and report CLEAN — the C2-F1b false-clean oracle)");
});

test("W11-A5 (A-C4): artifact declarations escaping the observed tree yield NO digest proof (rejected, exists:false)", async () => {
  // The confirmed accept-fraud (probe A05/A06): spec.artifacts is
  // graph-authored data and `resolve(cwd, p)` happily minted exists:true
  // + a digest for an ABSOLUTE or `../` path — a literal no-op worker
  // got accepted-finish by declaring one pre-existing file outside its
  // tree. Artifact paths are now confined TWICE (lexically + by realpath,
  // so an inside-symlink pointing out is rejected too) and a violating
  // declaration is journalled as REJECTED — never a proof.
  const root = await mkdtemp(join(tmpdir(), "tre-host-esc-"));
  const wt = join(root, "wt"); await mkdir(wt, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q"); await writeFile(join(wt, "real.txt"), "in-tree"); g("add", "."); g("commit", "-q", "-m", "base");
  await writeFile(join(root, "outside-secret.txt"), "PRE-EXISTING PROOF BAIT");
  const ln = (await import("node:fs")).symlinkSync;
  ln(join(root, "outside-secret.txt"), join(wt, "link-out")); // inside link → outside bytes

  const graph: EpisodeGraph = {
    schema: "tre-graph/1", episodeId: "ep-esc", goal: "g",
    tasks: [{ id: "t1", persona: "w", promptRef: "p", dependsOn: [], acceptance: { criteria: [], requiredChecks: [], artifacts: ["../outside-secret.txt", join(root, "outside-secret.txt"), "link-out", "real.txt"] } }],
    policy: { baseCommit: "x" },
  };
  const epPath = join(root, "eps");
  const ev = await collectAcceptanceEvidence({ graph, taskId: "t1", epPath, worktreePath: wt });
  assert.equal(ev.artifacts.length, 4);
  for (const a of ev.artifacts) {
    if (a.path === "real.txt") { assert.equal(a.exists, true, "control: an in-tree artifact still proves"); continue; }
    assert.equal(a.exists, false, `escaping artifact '${a.path}' must yield exists:false, never a proof`);
  }
  const evidence = await readFile(join(epPath, "acceptance", "evidence.jsonl"), "utf8");
  const rejects = evidence.match(/REJECTED — path escapes the observed tree/g) ?? [];
  assert.equal(rejects.length, 3, "all three escaping declarations are journalled as REJECTED");
});

test("W11-A6 (A-M2/A-M3): a setsid-escaped pipe holder is disclosed as escaped-writer, keeping the leader's real exit code", async () => {
  // Confirmed (probe A-M2/A-M3): a grandchild that leaves the process
  // group via setsid keeps the inherited stdout pipe open, so 'close'
  // never fires; the old timer reported the ALREADY-EXITED-0 leader as
  // cause:"timeout"/code:-1 — the W1-M2 evidence mislabel re-created.
  // The fix keeps the leader's real outcome and discloses the escape.
  const root = await mkdtemp(join(tmpdir(), "tre-host-escproc-"));
  const MARK = "tre-w11a6-escapee";
  // Leader: spawn a session-leader sleep (escaping the group) holding
  // our stdout pipe, then exit 0 immediately.
  const script = `python3 -c "import os,subprocess; subprocess.Popen(['sh','-c','sleep 90 # ${MARK}'],preexec_fn=os.setsid)" && echo leader-done && exit 0`;
  try {
    const r = await runShell(script, root, 1);
    assert.equal(r.code, 0, "the leader exited 0 — the CAUSE may change, the leader's CODE never becomes -1 lies");
    assert.equal(r.cause, "escaped-writer", "the escape is disclosed by its own cause, not conflated with timeout");
    assert.ok(r.stderr.includes("escaped-writer"), "the evidence line names the escape");
  } finally {
    // Reap the escapee (it is outside every group we can signal).
    try { execFileSync("/usr/bin/pkill", ["-f", MARK], { stdio: "ignore" }); } catch { /* already gone */ }
  }
});

test("P16 B-F1: an escalation with NO deliver port is journalled but DISCLOSED as not delivered — never presented as delivered", async (t) => {
  // The exact defect the audit caught (B-F1): the host built the channel
  // WITHOUT deliver/read, so every raise returned port-missing:deliver
  // while the loop journalled the escalation ACKED — the human was never
  // asked and nothing said so. Now the dispatcher's channel string tells
  // the two apart and the host log says it OUT LOUD.
  const { root, graph } = await freshEpisode(t, {
    policy: { baseCommit: "abc123", gate: { cmd: "false" } }, // never passes → escalate
    tasks: [{
      id: "t1", persona: "worker", promptRef: "prompts/t1.md", dependsOn: [],
      acceptance: { criteria: ["policy-gate"], requiredChecks: [], artifacts: [] },
    }],
  });
  const worker = await exitZeroWorker(root);
  const lines: string[] = [];
  const res = await runHostEpisode({
    episodesRoot: root, graph, taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, maxIterations: 8,
    log: (l) => { lines.push(l); t.diagnostic(l); },
  });
  // The loop must actually reach the escalate rung (p16-probe shape:
  // continue → change-approach → escalate ×2 → escalation-exhausted).
  assert.equal(res.result.stopped, "escalation-exhausted", `probe path must end escalation-exhausted, got ${res.result.stopped}`);

  const esc = (await readFile(join(root, graph.episodeId, "events", "escalations.jsonl"), "utf8"))
    .trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.ok(esc.length >= 1, "the escalation is DURABLE on disk (B-F2's replay source)");
  // docs/19 §"blockerOf": the executor's escalate payload carries rationale,
  // NOT a blocker — with no host blockerOf callback the channel floors it
  // to 'unknown' (still a valid, actionable record; INV-3).
  assert.ok(["unknown", "repeated-strategy"].includes(String(esc[0]!.blocker)),
    `the blocker is from the closed set, got ${JSON.stringify(esc[0]!.blocker)}`);
  assert.ok(esc[0]!.decisionNeeded, "a question the human can answer is recorded");

  // B-F1: the host log distinguishes NOT-delivered from delivered. No
  // deliver port here ⇒ EVERY line must be a disclosure, never a claim.
  const escLines = lines.filter((l) => l.includes("escalate"));
  assert.ok(escLines.length >= 1, "the host log carries the escalation line");
  assert.ok(escLines.every((l) => l.includes("NOT delivered") && l.includes("the human has NOT been asked")),
    `with no deliver port every escalation is disclosed un-asked, got ${JSON.stringify(escLines)}`);
  assert.ok(!lines.some((l) => /escalate dispatched via/.test(l)), "nothing may claim a delivery that did not happen");
});

test("P16 B-F1+deliver: WITH a deliver port the escalation is SENT, the channel names it on the host log, and the record proves delivery", async (t) => {
  // The other side of B-F1: when the host DOES wire the delivery act
  // (HostEpisodeOptions.escalationDeliver — the telegram bridge in
  // production), the act runs and the log says "dispatched via <channel>"
  // — the delivered/not-delivered distinction is real, not decorative.
  const { root, graph } = await freshEpisode(t, {
    policy: { baseCommit: "abc123", gate: { cmd: "false" } },
    tasks: [{
      id: "t1", persona: "worker", promptRef: "prompts/t1.md", dependsOn: [],
      acceptance: { criteria: ["policy-gate"], requiredChecks: [], artifacts: [] },
    }],
  });
  const worker = await exitZeroWorker(root);
  const sent: string[] = [];
  const lines: string[] = [];
  const res = await runHostEpisode({
    episodesRoot: root, graph, taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, maxIterations: 8,
    escalationDeliver: async (rec) => { sent.push(String(rec.blocker)); return { channel: "test-telegram" }; },
    log: (l) => { lines.push(l); t.diagnostic(l); },
  });
  assert.equal(res.result.stopped, "escalation-exhausted");
  assert.ok(sent.length >= 1, "the delivery ACT ran — the human was actually asked");
  assert.ok(sent.every((b) => b === "repeated-strategy" || b === "unknown"),
    "every sent question carries a blocker from the closed set (escalate floors to 'unknown' without a host blockerOf — docs/19)");
  assert.ok(lines.some((l) => l === "escalate dispatched via test-telegram" || /^escalate dispatched via test-telegram$/.test(l)),
    `the host log names the delivering channel, got ${JSON.stringify(lines.filter((l) => l.includes("escalate")))}`);
  const esc = (await readFile(join(root, graph.episodeId, "events", "escalations.jsonl"), "utf8"))
    .trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.ok(esc.every((r) => r.delivery === undefined || (r.delivery as Record<string, unknown>).ok === true),
    "no on-disk record may show a FAILED delivery while the loop journalled it acked");
});


test("P16 B-F2: parkTask writes the parked state AND raises the durable question with the approve/rewrite/abort decision (delivered when a port exists)", async (t) => {
  // park is the loop's dead-end act (docs/18: STOP without accepting).
  // The planner SEED fires only for a LIVE worker with unprovable
  // ownership (plan.ts isLive && !ownershipProvable) — a predicate the
  // compose loop never produces (it always sends the worker stopped
  // between turns), so the loop can never reach the handler in a test.
  // parkTask drives the handler's ONE body — the same closure behind
  // dispatch.park — and B-F2 demanded its question be durable, with the
  // open decision recorded, delivered when a deliver port exists.
  const { root, graph } = await freshEpisode(t, {
    policy: { baseCommit: "abc123", gate: { cmd: "true" } },
  });
  const worker = await exitZeroWorker(root);
  const sent: string[] = [];
  const res = await runHostEpisode({
    episodesRoot: root, graph, taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, maxIterations: 1, // the run is scaffolding; parkTask is the subject
    escalationDeliver: async (rec) => { sent.push(String(rec.decisionNeeded ?? "")); return { channel: "test-telegram" }; },
    log: (l) => t.diagnostic(l),
  });
  const before = (await readFile(join(root, graph.episodeId, "events", "escalations.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter((l) => l !== "").length;
  const sentBefore = sent.length; // the scaffolding loop may have escalated on its own

  await res.parkTask();

  // 1. The durable state write: the task is parked in state.json.
  const state = JSON.parse(await readFile(join(root, graph.episodeId, "state.json"), "utf8")) as { schema: string; episodeId: string; tasks: Record<string, { status: string }> };
  assert.equal(state.schema, "tre-episode-state/1");
  assert.equal(state.tasks.t1?.status, "parked", "park writes the parked status");

  // 2. B-F2: the park QUESTION is appended to the durable escalation log
  //    (one new record) with the closed blocker and the open decision.
  const esc = (await readFile(join(root, graph.episodeId, "events", "escalations.jsonl"), "utf8"))
    .trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(esc.length, before + 1, "park raises exactly one durable question");
  const parkRec = esc[esc.length - 1]!;
  assert.equal(parkRec.blocker, "repeated-strategy", "park is an open question under the closed repeated-strategy blocker");
  assert.match(String(parkRec.decisionNeeded), /parked/, "the record says the task is parked");
  assert.match(String(parkRec.decisionNeeded), /approve.*rewrite.*abort/s, "the human's decision (approve/rewrite/abort) is recorded");

  // 3. The delivery act ran (a port was wired) — B-F1's delivered side.
  assert.equal(sent.length, sentBefore + 1, "the park question was DELIVERED, not just journalled");
  assert.match(sent[sent.length - 1]!, /parked/);
});

test("W1-M7 (park door): a CORRUPT state.json is preserved untouched and the durable park write is SKIPPED (fail closed, disclosed)", async (t) => {
  // The same handler, the W1-M7 branch: a corrupt state.json may hold
  // other tasks' state — overwriting it with a fresh map destroyed it.
  // The handler now moves the bytes aside (never destroyed), skips the
  // durable write, and says so on the host log. (parkTask reaches every
  // branch of the ONE park body; the planner seed cannot.)
  const { root, graph } = await freshEpisode(t, { policy: { baseCommit: "abc123", gate: { cmd: "true" } } });
  const worker = await exitZeroWorker(root);
  const lines: string[] = [];
  const res = await runHostEpisode({
    episodesRoot: root, graph, taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, maxIterations: 1,
    log: (l) => { lines.push(l); t.diagnostic(l); },
  });
  const statePath = join(root, graph.episodeId, "state.json");
  const corrupt = '{"schema":"tre-episode-state/1","tasks":{ "t9": BROKEN';
  await writeFile(statePath, corrupt);

  await res.parkTask();

  // The corrupt bytes survived — preserved, never overwritten.
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const preserved = readdirSync(join(root, graph.episodeId)).filter((f) => f.startsWith("state.json.unreadable-"));
  assert.equal(preserved.length, 1, `the corrupt file was moved aside exactly once (found ${JSON.stringify(preserved)})`);
  assert.equal(readFileSync(join(root, graph.episodeId, preserved[0]!), "utf8"), corrupt, "the preserved bytes are BYTE-IDENTICAL — nothing was destroyed");
  assert.ok(!existsSync(statePath), "the durable park write was SKIPPED — no fresh state over other tasks' state");
  // The host log disclosed the skip.
  assert.ok(lines.some((l) => l.startsWith("park: state.json unreadable") && l.includes("durable park write SKIPPED")),
    `the skip is disclosed on the host log, got ${JSON.stringify(lines.filter((l) => l.startsWith("park:")))}`);
  // And NO escalation was raised from the skipped park (state is unknown:
  // the handler returned before the dispatcher).
  const escRaw = await readFile(join(root, graph.episodeId, "events", "escalations.jsonl"), "utf8").catch(() => "");
  assert.ok(!escRaw.includes("the task is parked"), "a skipped park raises no question — the state write is the gate");
});

// ── W13-F2c + audit row 8 (P16 follow-up audit): the refusal-to-send
// is a FACT at the channel level, disclosed by the host for BOTH acts. ──

test("W13 park+disabled bridge: the refusal logs as NOT delivered (namespaced at source), never as dispatched", async (t) => {
  // The audit's major #2 in its FINAL form: makeTelegramDeliver's
  // {channel:'telegram:disabled'} is a documented refusal (docs/19 §5).
  // The channel layer now turns ANY ':disabled' return into
  // delivered:false + 'escalation:refused:<name>', so the host's single
  // prefix rule catches it — no channel-name set, no false "dispatched".
  const { root, graph } = await freshEpisode(t, {
    policy: { baseCommit: "abc123", gate: { cmd: "true" } },
  });
  const worker = await exitZeroWorker(root);
  let sends = 0;
  const lines: string[] = [];
  const res = await runHostEpisode({
    episodesRoot: root, graph, taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, maxIterations: 1,
    escalationDeliver: makeTelegramDeliver({ enabled: false, send: async () => { sends++; } }),
    log: (l) => { lines.push(l); t.diagnostic(l); },
  });
  await res.parkTask();
  assert.equal(sends, 0, "a disabled bridge sent NOTHING");
  const parkLines = lines.filter((l) => l.startsWith("park:"));
  assert.ok(parkLines.some((l) => l.includes("NOT delivered") && l.includes("refused:telegram:disabled") && l.includes("the human has NOT been asked")),
    `the refusal is disclosed as NOT delivered with the refused channel named, got ${JSON.stringify(parkLines)}`);
  assert.ok(!parkLines.some((l) => l.includes("dispatched")), "nothing may claim a dispatch the bridge refused");
  // The question is still durable (INV-2: the record stands, the success does not).
  const esc = (await readFile(join(root, graph.episodeId, "events", "escalations.jsonl"), "utf8"))
    .trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.ok(esc.some((r) => r.blocker === "repeated-strategy" && String(r.decisionNeeded).includes("parked")),
    "the parked question is DURABLE despite the refused send");
});

test("W13 escalate+disabled bridge: the refusal logs as NOT delivered for the escalate act too", async (t) => {
  // Same fact, other act: the loop's escalate rung with a disabled
  // bridge. Before W13-F2c the host logged 'escalate dispatched via
  // telegram:disabled' — a dispatch to a human who was never asked.
  const { root, graph } = await freshEpisode(t, {
    policy: { baseCommit: "abc123", gate: { cmd: "false" } }, // never passes → escalate
    tasks: [{
      id: "t1", persona: "worker", promptRef: "prompts/t1.md", dependsOn: [],
      acceptance: { criteria: ["policy-gate"], requiredChecks: [], artifacts: [] },
    }],
  });
  const worker = await exitZeroWorker(root);
  let sends = 0;
  const lines: string[] = [];
  const res = await runHostEpisode({
    episodesRoot: root, graph, taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, maxIterations: 8,
    escalationDeliver: makeTelegramDeliver({ enabled: false, send: async () => { sends++; } }),
    log: (l) => { lines.push(l); t.diagnostic(l); },
  });
  assert.equal(res.result.stopped, "escalation-exhausted");
  assert.equal(sends, 0, "a disabled bridge sent NOTHING across the whole episode");
  const escLines = lines.filter((l) => l.includes("escalate"));
  assert.ok(escLines.length >= 1, "the escalation lines exist");
  assert.ok(escLines.every((l) => l.includes("NOT delivered") && l.includes("refused:telegram:disabled")),
    `every escalate is disclosed as a refused send, got ${JSON.stringify(escLines)}`);
  assert.ok(!lines.some((l) => /escalate dispatched via/.test(l)), "nothing may claim a delivery that did not happen");
});

test("W13 park+throwing deliver (audit row 8): the park survives, the failure is disclosed, nothing escapes the seam", async (t) => {
  // The audit's untested path: a deliver port whose SEND throws.
  // deliverAndFinish catches it (the durable line IS the promise), the
  // record stands, the park resolves — and the host must SEE the failure
  // rather than silence.
  const { root, graph } = await freshEpisode(t, {
    policy: { baseCommit: "abc123", gate: { cmd: "true" } },
  });
  const worker = await exitZeroWorker(root);
  const lines: string[] = [];
  const res = await runHostEpisode({
    episodesRoot: root, graph, taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, maxIterations: 1,
    escalationDeliver: async () => { throw new Error("bridge down"); },
    log: (l) => { lines.push(l); t.diagnostic(l); },
  });
  await res.parkTask(); // MUST resolve — a throwing port never crashes the seam
  const state = JSON.parse(await readFile(join(root, graph.episodeId, "state.json"), "utf8")) as { tasks: Record<string, { status: string }> };
  assert.equal(state.tasks.t1?.status, "parked", "the state write stands (the send failed AFTER the durable record)");
  const esc = (await readFile(join(root, graph.episodeId, "events", "escalations.jsonl"), "utf8"))
    .trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  const parkRec = esc[esc.length - 1]!;
  assert.equal(parkRec.blocker, "repeated-strategy");
  assert.ok(!("delivery" in parkRec),
    "the durable line carries no delivery claim — the append precedes the act (INV-2); the failure lives in the result/host log, never as a forged success on disk");
  const parkLines = lines.filter((l) => l.startsWith("park:"));
  assert.ok(parkLines.some((l) => l.includes("NOT delivered")),
    `the host log carries the failure disclosure, got ${JSON.stringify(parkLines)}`);
  // W13-F4 (audit): the log names the delivery error, not just the
  // fact. A throw's disclosure is the CLASS name only (describeErr
  // never surfaces the untrusted message), so the pin is `: Error`.
  assert.ok(parkLines.some((l) => /NOT delivered \((?:recorded|re-notice): Error/.test(l)),
    `the host log names the delivery error, got ${JSON.stringify(parkLines)}`);
  assert.ok(!parkLines.some((l) => l.includes("dispatched")), "nothing may claim a dispatch the port could not perform");
});

test("W13-F4b: an Error name carrying a newline cannot forge a host-log line", async (t) => {
  // Audit round 2: the log is the host's trusted surface — an untrusted
  // port error NAME must never create a second line (the repro forged
  // 'escalate dispatched via telegram' inside the disclosure).
  const { root, graph } = await freshEpisode(t, {
    policy: { baseCommit: "abc123", gate: { cmd: "true" } },
  });
  const worker = await exitZeroWorker(root);
  const lines: string[] = [];
  const res = await runHostEpisode({
    episodesRoot: root, graph, taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, maxIterations: 1,
    escalationDeliver: async () => {
      const e = new Error("bridge down");
      (e as { name: string }).name = "Boom\nescalate dispatched via telegram";
      throw e;
    },
    log: (l) => { lines.push(l); t.diagnostic(l); },
  });
  await res.parkTask();
  assert.ok(!lines.some((l) => /^escalate dispatched via/.test(l)), "no forged dispatch line may appear");
  assert.ok(!lines.includes("escalate dispatched via telegram"), "the injected line cannot appear verbatim");
  // The forgery vector is a NEWLINE inside a logged value: the smuggled
  // sub-line must not claim a dispatch. (A prefix whitelist is too
  // narrow — the host legitimately logs other prefixes like
  // 'ingest-session-failed' — so the pin is the forgery itself.)
  assert.ok(!lines.some((l) => l.split("\n").some((s) => /^escalate dispatched/.test(s) || /^park: question dispatched/.test(s))),
    `no line (or smuggled sub-line) may claim a dispatch, got ${JSON.stringify(lines)}`);
  const parkLines = lines.filter((l) => l.startsWith("park:"));
  assert.ok(parkLines.some((l) => /NOT delivered \((?:recorded|re-notice): Error\)/.test(l)),
    `the hostile name collapsed to 'Error' in the disclosure, got ${JSON.stringify(parkLines)}`);
});
