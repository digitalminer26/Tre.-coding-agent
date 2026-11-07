/**
 * P7 — attempt runner & ownership recovery (docs/11 §11.1 P7, §13.2 I1/I2,
 * §14.1 attempt identity, §14.5 derived ownership, S6 pid hints).
 *
 * Covers the process-control primitives:
 *  - run(): intent-before-act (I2) journal discipline, attemptId
 *    allocation from ALL sources (§14.1), S6 hint write, exit evidence.
 *  - stop(): SIGTERM→SIGKILL process-group escalation, resolves only on
 *    confirmed exit; refusal to stop what we did not spawn.
 *  - Ownership fences (I1): live child, foreign live child on the same
 *    session path, discovered-RUNNING via injected probe, unresolved
 *    spawn intent — NO refusal ever spawns or kills.
 *  - reconcile(): spawn / park / running classification; park is the
 *    conservative fallback whenever liveness is unprovable (I3).
 *  - confirmStopped(): evidence REQUIRED; refuses to confirm away a live
 *    child or a RUNNING pid hint; clears the stale hint on success.
 *  - Boundary guard: nothing outside src/runner/ consumes the runner yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn as procSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AttemptRunner,
  RunnerError,
  attemptNumber,
  nextAttemptId,
  treWorkerSpawner,
  validateSpawnSpec,
  canonicalPath,
  type AttemptTask,
  type PidStatus,
} from "../src/runner/attempt.js";
import {
  createEpisodeLayout,
  episodeDir,
  DecisionJournal,
  newDecisionId,
  readEpisodeState,
  writeEpisodeState,
  STATE_SCHEMA_ID,
  GRAPH_SCHEMA_ID,
  type AttemptRecord,
  type EpisodeGraph,
} from "../src/episode/journal.js";

// ────────────────────────────── fixtures ────────────────────────────────────

const graph: EpisodeGraph = {
  schema: GRAPH_SCHEMA_ID,
  episodeId: "ep-p7",
  goal: "exercise the attempt runner",
  tasks: [{ id: "t1", persona: "implementer", promptRef: "prompts/t1.md", dependsOn: [] }, { id: "t2", persona: "implementer", promptRef: "prompts/t2.md", dependsOn: [] }],
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tre-p7-"));
  const dir = episodeDir(root, "ep-p7");
  await createEpisodeLayout(root, "ep-p7", graph);
  const session = join(dir, "sessions", "t1.jsonl");
  await writeFile(session, ""); // the session file itself is the worker's business
  return { root, dir, session };
}

const task = (session: string, over: Partial<AttemptTask> = {}): AttemptTask => ({
  episodeId: "ep-p7", taskId: "t1", session, ...over,
});

/** Worker that just sleeps — stopped by the runner. */
const sleepSpawner = (secs = 30) => ({ kind: "test-sleep", spawn: () => ({ command: "/bin/sleep", args: [String(secs)] }) });
/** Worker that exits immediately with a code. */
const exitSpawner = (code: number) => ({ kind: "test-exit", spawn: () => ({ command: "/bin/sh", args: ["-c", `exit ${code}`] }) });
/** Worker that ignores SIGTERM — forces SIGKILL escalation. */
const stubbornSpawner = () => ({ kind: "test-stubborn", spawn: () => ({ command: "/bin/sh", args: ["-c", "trap '' TERM; sleep 30"] }) });

const probe = (verdict: PidStatus | undefined) => async () => verdict;

async function openRunner(root: string, probes?: (pid: number) => Promise<PidStatus | undefined>) {
  return AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner(), ...(probes ? { probes: { pidAlive: probes } } : {}) });
}

/** Append an attempt record out-of-band (simulating a previous supervisor's
 *  durable history the fresh runner must reconcile against). */
async function seedAttemptRecord(dir: string, rec: Partial<AttemptRecord> & { attemptId: string; sessionPath: string }): Promise<void> {
  const journal = await DecisionJournal.forEpisode(dir);
  const full: AttemptRecord = {
    schema: "tre-supervisor/1", id: newDecisionId(), ts: Date.now(), episodeId: "ep-p7", taskId: "t1",
    kind: "attempt", spawnOutcome: null, ...rec,
  };
  await journal.append(full);
}

// ────────────────────────────── pure helpers ────────────────────────────────

test("attemptId allocation: numeric max over ALL candidates, never lexicographic (§14.1)", () => {
  assert.equal(attemptNumber("t2-a10"), 10);
  assert.equal(attemptNumber("t2-a9"), 9);
  assert.equal(attemptNumber("t2"), 0);
  assert.equal(nextAttemptId("t2", "t2-a9", "t2-a10", undefined), "t2-a11");
  assert.equal(nextAttemptId("t2"), "t2-a1");
  // caller proposals are candidates for max+1 only — the runner allocates
  assert.equal(nextAttemptId("t2", "t2-a99"), "t2-a100");
});

test("treWorkerSpawner: CLI-compatible argv (F8) — XOR --session/--resume, no --attempt-id; identity via env", () => {
  const s = treWorkerSpawner("tre.", ["--flag"]);
  const t: AttemptTask = { episodeId: "e", taskId: "t1", session: "/x/y/s1.jsonl" };
  const fresh = s.spawn(t, "t1-a1");
  assert.equal(fresh.command, "tre.");
  assert.deepEqual(fresh.args, ["--flag", "--session", "/x/y/s1.jsonl"]);
  assert.ok(!fresh.args.includes("--attempt-id"), "the real CLI rejects --attempt-id (F8)");
  assert.equal(fresh.env?.TRE_ATTEMPT_ID, "t1-a1", "attempt identity rides in the env");
  assert.equal(fresh.env?.TRE_EPISODE_ID, "e");
  const r = s.spawn(t, "t1-a2", { resume: true });
  assert.deepEqual(r.args, ["--flag", "--resume", "/x/y/s1.jsonl"]);
  assert.ok(!r.args.includes("--session"), "--resume and --session are mutually exclusive per the CLI (F8)");
});

// ────────────────────────────── happy paths ─────────────────────────────────

test("run(): intent durable before spawn, resolve 'ok' after, S6 hint written; stop() gives exit evidence", async (t) => {
  const { root, dir, session } = await fixture();
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner() });
  t.after(() => runner.close(true));

  const h = await runner.run(task(session));
  assert.equal(h.attemptId, "t1-a1");
  assert.ok(typeof h.pid === "number" && h.pid > 0);
  assert.equal(h.detached, true);

  const records = await runner.records();
  const attempts = records.filter((r) => r.kind === "attempt") as AttemptRecord[];
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.spawnOutcome, null, "intent record BEFORE the act (I2)");
  assert.equal(attempts[1]!.spawnOutcome, "ok");
  assert.notEqual(attempts[0]!.id, attempts[1]!.id, "resolve is a NEW record, never an edit of the intent");
  assert.equal(attempts[1]!.attemptId, "t1-a1");

  // S6 hint: pid + attemptId + session, status running
  const st = await readEpisodeState(join(dir, "state.json"));
  assert.equal(st.tasks["t1"]?.attemptId, "t1-a1");
  assert.equal(st.tasks["t1"]?.pid, h.pid);
  assert.equal(st.tasks["t1"]?.session, session);
  assert.equal(st.tasks["t1"]?.status, "running");

  // reconcile while live: running, never spawn
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "running");
  assert.equal(rec.ownership.live.length, 1);

  const stop = await runner.stop(h);
  assert.equal(stop.stopped, true);
  assert.equal(stop.escalated, false, "sleep dies to SIGTERM — no escalation");
  assert.equal(stop.signal, "SIGTERM");
  assert.equal(stop.attemptId, "t1-a1");

  // after exit: waitpid-class disproof — reconcile says spawn is permitted
  const after = await runner.reconcile(task(session));
  assert.equal(after.decision.action, "spawn", `expected spawn, got ${JSON.stringify(after.decision)}`);
  assert.equal(after.ownership.latest?.live, false);
  assert.equal(after.ownership.latest?.signal, "SIGTERM");
});

test("run(): exit code surfaces via waitForExit (own-child evidence beats pid hints)", async (t) => {
  const { root, session } = await fixture();
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: exitSpawner(3) });
  t.after(() => runner.close(true));
  const h = await runner.run(task(session));
  const ev = await runner.waitForExit(h);
  assert.equal(ev.code, 3);
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "spawn");
  assert.equal(rec.ownership.latest?.exitCode, 3);
});

test("run(): attemptId derives from durable records, state hint, AND caller proposal (§14.1)", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a7", sessionPath: session, spawnOutcome: "failed" });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t1: { status: "paused", attemptId: "t1-a12", session } },
  });
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner() });
  t.after(async () => { try { await runner.stop({ session }); } catch { /* not started */ } runner.close(true); });
  // caller proposing a LOWER id must not reset the counter
  const h = await runner.run(task(session, { attemptId: "t1-a3" }));
  assert.equal(h.attemptId, "t1-a13", "max(a7 record, a12 hint, a3 proposal) + 1");
});

test("stop(): stubborn worker escalates to SIGKILL of the process group", async (t) => {
  const { root, session } = await fixture();
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: stubbornSpawner(), stopTimeoutMs: 150 });
  t.after(() => runner.close(true));
  const h = await runner.run(task(session));
  const stop = await runner.stop(h);
  assert.equal(stop.escalated, true);
  assert.equal(stop.signal, "SIGKILL");
});

test("stop()/waitForExit(): refuse for sessions this instance never spawned", async () => {
  const { root, session } = await fixture();
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner() });
  try {
    await assert.rejects(runner.stop({ session }), (e: RunnerError) => e.code === "not-running");
    await assert.rejects(runner.waitForExit({ session }), (e: RunnerError) => e.code === "not-running");
  } finally { runner.close(); }
});

// ────────────────────────── ownership fences (I1) ───────────────────────────

test("fence: run() refuses while a live child owns the session; resume of the same live attempt is already-running", async (t) => {
  const { root, session } = await fixture();
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner() });
  t.after(() => runner.close(true));
  await runner.run(task(session));
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "ownership-fence");
  await assert.rejects(runner.resume(task(session), "t1-a1"), (e: RunnerError) => e.code === "already-running");
  // a different task on the SAME session path is fenced too (§14.5: joins on session)
  await assert.rejects(runner.run(task(session, { taskId: "t2" })), (e: RunnerError) => e.code === "ownership-fence");
  await runner.stop({ session });
});

test("fence: discovered-RUNNING pid hint (probe) blocks a fresh spawn — park, never take over by killing (I1)", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok" });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t1: { status: "running", attemptId: "t1-a1", pid: 999998, session } },
  });
  const runner = await openRunner(root, probe({ running: true, sameUid: true }));
  t.after(() => runner.close(true));
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-running");
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "park");
  assert.match(rec.decision.reasons.join(" "), /discovered RUNNING/);
  assert.deepEqual(rec.probes, [{ pid: 999998, running: true, sameUid: true }], "probes recorded as audit trail");
  // confirm cannot wave away a RUNNING worker
  await assert.rejects(runner.confirmStopped(task(session), "t1-a1", "trust me"), (e: RunnerError) => e.code === "ownership-fence");
});

test("fence: FOREIGN-uid hit on our pid hint is unprovable → park (I3: silence is not evidence)", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok" });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t1: { status: "running", attemptId: "t1-a1", pid: 7, session } },
  });
  const runner = await openRunner(root, probe({ running: true, sameUid: false }));
  t.after(() => runner.close(true));
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-unresolved");
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "park");
  assert.match(rec.decision.reasons.join(" "), /FOREIGN-uid/);
});

test("fence: probe says the hint pid is GONE (ps answered) — disproof; a new attempt may spawn", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok" });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t1: { status: "running", attemptId: "t1-a1", pid: 999997, session } },
  });
  const runner = await openRunner(root, probe({ running: false, sameUid: false }));
  t.after(async () => { try { await runner.stop({ session }); } catch { /* noop */ } runner.close(true); });
  const h = await runner.run(task(session));
  assert.equal(h.attemptId, "t1-a2", "dead-worker derivation continues the sequence");
});

// ────────────────────── unresolved intents (I2) ─────────────────────────────

test("unresolved spawn intent: no blind re-spawn; park; confirmStopped(evidence) unblocks the next attempt", async (t) => {
  const { root, dir, session } = await fixture();
  // a previous supervisor crashed between intent and resolve — and
  // left its S6 hint row behind (the realistic crash shape). The tuple
  // journalled its identifiers (pid/pgid), which the cycle-2 contract
  // REQUIRES: an identifier-less unresolved tuple can never be
  // confirmed (unverified absence — finding B refuses it).
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: null, pid: 999993, pgid: 999993 });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t1: { status: "running", attemptId: "t1-a1", pid: 999993, session } },
  });
  const runner = await openRunner(root, killProbe); // deterministic kill(pid,0): 999993 is dead ⇒ negative evidence
  t.after(async () => { try { await runner.stop({ session }); } catch { /* noop */ } runner.close(true); });

  await assert.rejects(runner.run(task(session)), (e: RunnerError) => {
    if (e.code !== "prior-attempt-unresolved") throw e;
    assert.match(e.message, /no blind re-spawn/);
    return true;
  });
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "park");

  // evidence-bearing confirmation resolves the tuple...
  const confirmed = await runner.confirmStopped(task(session), "t1-a1", "machine rebooted during intent; verified no tre. worker via ps(1) sweep");
  assert.equal(confirmed.spawnOutcome, "failed");
  assert.equal(confirmed.attemptId, "t1-a1", "same tuple identity");
  // ...and clears the stale hint
  const st = await readEpisodeState(join(dir, "state.json"));
  assert.equal(st.tasks["t1"]?.status, "paused");
  assert.equal(st.tasks["t1"]?.pid, undefined, "stale pid hint cleared");

  // now a fresh attempt may spawn
  const h = await runner.run(task(session));
  assert.equal(h.attemptId, "t1-a2");
  await runner.stop(h);
});

test("confirmStopped: evidence is REQUIRED; refuses unknown / already-failed attempts; cannot confirm a live child", async (t) => {
  const { root, session } = await fixture();
  const runner = await openRunner(root);
  t.after(() => runner.close(true));

  await assert.rejects(runner.confirmStopped(task(session), "t1-a1", "  "), (e: RunnerError) => e.code === "bad-input");
  await assert.rejects(runner.confirmStopped(task(session), "t1-a1", "evidence"), (e: RunnerError) => e.code === "bad-input", "no record at all");

  const dir2 = episodeDir(root, "ep-p7");
  await seedAttemptRecord(dir2, { attemptId: "t1-a9", sessionPath: session, spawnOutcome: "failed" });
  await assert.rejects(runner.confirmStopped(task(session), "t1-a9", "already dead"), (e: RunnerError) => e.code === "bad-input", "already resolved failed");

  const h = await runner.run(task(session)); // t1-a10 live
  await assert.rejects(runner.confirmStopped(task(session), "t1-a10", "i feel like it stopped"), (e: RunnerError) => e.code === "ownership-fence", "live child: stop(), never confirm it away");
  await runner.stop(h);
});

// ────────────────────────────── resume ──────────────────────────────────────

test("resume(): same attemptId gets a new intent/resolve pair under the SAME tuple; unknown attempt refused; session binding enforced (§14.1)", async (t) => {
  const { root, dir, session } = await fixture();
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner() });
  t.after(() => runner.close(true));

  await assert.rejects(runner.resume(task(session), "t1-a1"), (e: RunnerError) => e.code === "bad-input", "never recorded — start with run()");

  await runner.run(task(session));
  await runner.stop({ session });

  // session-binding: resume on a different session path would split the fence
  await assert.rejects(runner.resume(task("/somewhere/else.jsonl"), "t1-a1"), (e: RunnerError) => {
    if (e.code !== "bad-input") throw e;
    assert.match(e.message, /split the ownership fence/);
    return true;
  });

  const h = await runner.resume(task(session), "t1-a1");
  assert.equal(h.attemptId, "t1-a1", "attemptId stable across --resume");
  const attempts = (await runner.records()).filter((r) => r.kind === "attempt") as AttemptRecord[];
  // run: intent+ok, stop leaves records alone; resume: intent+ok again — 4, all same tuple
  assert.equal(attempts.length, 4);
  assert.ok(attempts.every((a) => a.attemptId === "t1-a1"));
  assert.equal(attempts[2]!.spawnOutcome, null);
  assert.equal(attempts[3]!.spawnOutcome, "ok");
  await runner.stop(h);
});

// ─────────────────────── instance & input discipline ────────────────────────

test("one runner per episode per process (exclusive journal writer); close refuses while a child is live", async (t) => {
  const { root, session } = await fixture();
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner() });
  t.after(() => runner.close(true));
  await assert.rejects(AttemptRunner.open({ root, episodeId: "ep-p7" }), (e: RunnerError) => e.code === "ownership-fence");
  const h = await runner.run(task(session));
  assert.equal(runner.hasLiveChildren, true);
  assert.throws(() => runner.close(), (e: RunnerError) => e.code === "ownership-fence");
  await runner.stop(h);
  runner.close();
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "bad-input", "closed runner");
  // reopened after close works
  const again = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner() });
  again.close();
});

test("bad input is rejected before any mutation: episode mismatch, unsafe taskId, malformed attemptId, taskRevision < 1", async () => {
  const { root, session } = await fixture();
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner() });
  try {
    await assert.rejects(runner.run(task(session, { episodeId: "someone-elses-episode" })), (e: RunnerError) => e.code === "bad-input");
    await assert.rejects(runner.run(task(session, { taskId: "../escape" })), (e: RunnerError) => e.code === "bad-input");
    await assert.rejects(runner.run(task(session, { attemptId: "not-an-attempt" })), (e: RunnerError) => e.code === "bad-input");
    await assert.rejects(runner.run(task(session, { taskRevision: 0 })), (e: RunnerError) => e.code === "bad-input");
    assert.deepEqual((await runner.records()).filter((r) => r.kind === "attempt"), [], "rejections must not touch the journal");
  } finally { runner.close(); }
});

test("spawn-failed: bad spawner spec and missing binary resolve the intent as 'failed' (no dangling unresolved)", async () => {
  const { root, session } = await fixture();
  const runner = await AttemptRunner.open({
    root, episodeId: "ep-p7",
    spawner: { kind: "bad", spawn: () => ({ command: "", args: [] }) },
  });
  try {
    await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "spawn-failed");
    const attempts = (await runner.records()).filter((r) => r.kind === "attempt") as AttemptRecord[];
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]!.spawnOutcome, null);
    assert.equal(attempts[1]!.spawnOutcome, "failed", "failed spawn resolves the intent (I2)");
    // A (audit cycle-2): a spawn-machinery failure carries spawnEvidence
    // and is NEVER a confirmation.
    assert.equal(attempts[1]!.spawnEvidence, true, "spawn-machinery failure is spawn evidence");
    assert.equal(attempts[1]!.confirmation, undefined, "spawnEvidence is not a confirmation");
  } finally { runner.close(); }

  const runner2 = await AttemptRunner.open({
    root, episodeId: "ep-p7",
    spawner: { kind: "missing", spawn: () => ({ command: "/nonexistent-binary-tre-p7", args: [] }) },
  });
  try {
    await assert.rejects(runner2.run(task(session, { taskId: "t2" })), (e: RunnerError) => e.code === "spawn-failed");
    const attempts = (await runner2.records()).filter((r) => r.kind === "attempt" && r.taskId === "t2") as AttemptRecord[];
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1]!.spawnOutcome, "failed");
  } finally { runner2.close(); }
});

test("validateSupervisorRecord accepts every record shape P7 writes (P4 journal is the authority)", async (t) => {
  const { root, session } = await fixture();
  // AttemptRunner.open + run go through DecisionJournal.append, which
  // validates BEFORE writing — a durable read-back proves acceptance.
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner() });
  t.after(() => runner.close(true));
  const h = await runner.run(task(session, { taskRevision: 2, model: "openai/gpt-4o", worktreePath: "/tmp/wt" }));
  const records = await runner.records(); // read() schema-validates every line
  const a = records.filter((r) => r.kind === "attempt") as AttemptRecord[];
  assert.equal(a[0]!.taskRevision, 2);
  assert.equal(a[0]!.model, "openai/gpt-4o");
  assert.equal(a[0]!.worktreePath, "/tmp/wt");
  await runner.stop(h);
});

// ─────────────────── audit-finding regression tests ────────────────────────

// F-4: session paths are canonicalized at every entry point
test("F4: run with an UNCANONICAL session spelling is the SAME identity as the canonical one (.. traversal)", async (t) => {
  const { root, session } = await fixture();
  // the audit's exact repro: "/sessions/t1.jsonl" vs
  // "/sessions/../sessions/t1.jsonl" both spawned a worker.
  const { basename } = await import("node:path");
  // raw concatenation — join() would normalize the ".." away
  const viaTraversal = `${session.slice(0, session.length - basename(session).length)}../sessions/${basename(session)}`;
  assert.notEqual(viaTraversal, session, "the fixture spelling really is a different string");
  assert.equal(canonicalPath(viaTraversal), session, "but canonicalizes to the same file");
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner() });
  t.after(() => runner.close(true));
  const h = await runner.run(task(viaTraversal)); // uncanonical (..-traversal) spelling
  assert.equal(h.session, canonicalPath(session), "handle carries the canonical path");
  const rec = await runner.reconcile(task(session)); // canonical spelling
  assert.equal(rec.decision.action, "running", "the uncanonical run IS this session's owner — the fence sees ONE identity");
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "ownership-fence", "canonical run() against the uncanonical-spelling child still fences");
  await runner.stop(h);
});

// F-6: resolved-failed outcomes never block
test("F6: a resolved 'failed' outcome is negative evidence — never blocks reconcile or a later spawn", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "failed" });
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner(), probes: { pidAlive: async () => undefined } });
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "spawn", "a failed spawn owns nothing: inconclusive probes must not park it");
  const h = await runner.run(task(session));
  assert.equal(h.attemptId, "t1-a2");
  await runner.stop(h);
});

// F-3: confirming an old tuple cannot hide a newer live tuple (audit repro:
// fresh supervisor, stale ok tuple, newer tuple whose worker is STILL alive)
test("F3: confirmStopped of an OLD tuple keeps a newer tuple's live claim (generation, not ts, decides ownership)", async (t) => {
  const { root, dir, session } = await fixture();
  // stale tuple a1: spawned ok long ago, pid since dead (machine reboot)
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", ts: 1_000_000, pid: 999991, pgid: 999991, detached: true });
  // newer tuple a2: spawned ok by a supervisor that has since gone away,
  // but whose worker (a real sleep) is STILL alive.
  const runner1 = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner(60), probes: { pidAlive: async (p: number) => (p === 999991 ? { running: false, sameUid: false } : undefined) } });
  const h = await runner1.run(task(session));
  runner1.close(true); // lost-supervisor detach: the journal stays
  t.after(() => { try { process.kill(h.pid!, "SIGKILL"); } catch { /* already gone */ } });

  const recsOpen = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner() });
  const recs1 = await recsOpen.records();
  const a2recs1 = recs1.filter((r) => r.kind === "attempt" && r.attemptId === "t1-a2" && r.spawnOutcome === "ok") as AttemptRecord[];
  assert.equal(a2recs1[0]!.detached, true, "A (audit): the ok resolve stamps the spawn mode alongside pid/pgid");
  recsOpen.close();
  const a2recs = recs1.filter((r) => r.kind === "attempt" && r.attemptId === "t1-a2") as AttemptRecord[];
  assert.equal(a2recs.length, 2);
  assert.ok(a2recs.every((r) => r.spawnGen === 1), "spawn gen allocated from the session's records (legacy a1 = 0 → a2 = 1)");

  const runner = await AttemptRunner.open({
    root, episodeId: "ep-p7", spawner: sleepSpawner(),
    // composite probe: the a2 worker is RUNNING; everything else gets
    // the deterministic kill(pid,0) verdict (the default `ps` probe is
    // EPERM-blocked in sandboxes and INCONCLUSIVE blocks confirm).
    probes: { pidAlive: async (p: number) => (p === h.pid ? { running: true, sameUid: true } : killProbe(p)) },
  });
  t.after(() => runner.close(true));
  const before = await runner.reconcile(task(session));
  assert.equal(before.decision.action, "park", "the newer tuple's worker is discovered RUNNING (I1: park, never take over)");
  assert.ok(before.decision.reasons.some((r) => /t1-a2.*RUNNING/.test(r)), `reason cites the live a2 worker, got: ${JSON.stringify(before.decision.reasons)}`);
  assert.equal(before.ownership.blocking.length, 1, "exactly ONE blocking tuple: the live generation-1 a2");
  assert.equal(before.ownership.blocking[0]!.record.attemptId, "t1-a2");

  // confirm the OLD tuple (pid 999991 probes dead → allowed)
  const confirmedA1 = await runner.confirmStopped(task(session), "t1-a1", "audited: the a1-era worker is long gone (machine reboot verified via ps sweep)");
  // A (audit cycle-2): the confirmation is tagged — its append position
  // says WHEN the death was observed and must never anchor spawn order.
  assert.equal(confirmedA1.confirmation, true, "confirmStopped stamps the resolve as a confirmation");
  assert.equal(confirmedA1.spawnEvidence, undefined, "a confirmation is NOT spawn evidence");

  // THE BUG THIS GUARDS: the confirmation is a record with the LATEST ts.
  // Under pure-ts "newest per session" a1 becomes newest, a2's live claim
  // is dropped from the fence, and a fresh spawn proceeds over a running
  // worker. With generation ownership a2 keeps blocking.
  const after = await runner.reconcile(task(session));
  assert.equal(after.decision.action, "park", "the ts-fresh a1 confirmation (gen 0, failed outcome) never displaces the live gen-1 claim from the fence");
  assert.equal(after.ownership.blocking.length, 1, "still exactly ONE blocking tuple — the confirmation added none, dropped none");
  assert.equal(after.ownership.blocking[0]!.record.attemptId, "t1-a2");
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-running", "a confirmation of a1 cannot release the session whose worker is alive");
});

// F-5: stop() group verification — kill(-pgid,0), not leader-exit alone
test("F5: stop() reports groupStatus via kill(-pgid,0): group reaped ⇒ stopped:true; SIGKILL escalation on a TERM-ignoring leader", async (t) => {
  const { root, session } = await fixture();
  // A busy-loop leader with NO children that ignores TERM: a group-wide
  // TERM cannot end it by killing a victim child (the old fixture flaked
  // because TERM killed the foreground `sleep`, and sh then exited on its
  // own before the escalation timeout — escalated raced false). Only a
  // SIGKILL sweep ends it, so escalation AND group reaping are certain.
  const runner = await AttemptRunner.open({
    root, episodeId: "ep-p7", stopTimeoutMs: 200,
    spawner: { kind: "grp", spawn: () => ({ command: "/bin/sh", args: ["-c", "trap '' TERM INT; i=0; while :; do i=$((i+1)); done"] }) },
  });
  t.after(() => runner.close(true));
  const h = await runner.run(task(session));
  // let the leader install its trap before signalling: a TERM that
  // lands during sh's fork→exec window (before `trap '' TERM` runs)
  // kills it by default disposition — that startup race, not the
  // runner, decides `escalated` if stop() fires immediately.
  await new Promise((r) => setTimeout(r, 250));
  const stop = await runner.stop(h);
  assert.equal(stop.escalated, true, "TERM ignored by the leader; the SIGKILL group sweep happened");
  assert.equal(stop.stopped, true);
  assert.equal(stop.groupStatus, "reaped", "kill(-pgid,0) ESRCH after the sweep — group death CONFIRMED, not leader-exit-only");
});

// F5 audit (full finding, restart path): leader exit ALONE must never
// release ownership while the recorded process GROUP survives. Audit
// repro: /bin/sh -c 'sleep & exit' — the leader dies, the grandchild
// lives in the group; journal-first group probing keeps the fence.
test("F5b: leader self-exits leaving a live group: reconcile parks, run/confirmStopped refuse — across reopen (pgid consulted, not just pid)", async (t) => {
  const { root, session } = await fixture();
  const runner1 = await AttemptRunner.open({
    root, episodeId: "ep-p7",
    spawner: { kind: "orphan", spawn: () => ({ command: "/bin/sh", args: ["-c", "sleep 300 & exit 0"] }) },
  });
  const h = await runner1.run(task(session));
  const pgid = h.pid!; // detached ⇒ pgid === leader pid; group holds the grandchild
  t.after(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* may already be reaped */ } });
  await runner1.waitForExit(h); // leader EXITED (waitpid-class)

  const r1 = await runner1.reconcile(task(session));
  assert.equal(r1.decision.action, "park", "leader dead but group alive ⇒ park (audit F5: leader exit is not group death)");
  assert.ok(r1.decision.reasons.some((x) => x.includes("GROUP")), `reason cites the group, got ${JSON.stringify(r1.decision.reasons)}`);
  await assert.rejects(runner1.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-running", "fence refuses re-spawn onto the live group");
  await assert.rejects(runner1.confirmStopped(task(session), h.attemptId, "leader exited"), (e: RunnerError) => e.code === "ownership-fence", "confirmStopped cannot confirm away a live GROUP");

  // The audit's exact restart: close, reopen, and the NEW instance must
  // consult the journal pgid — a dead leader pid alone is NOT disproof.
  await runner1.close();
  // Reopen with the deterministic kill(pid,0) probe: the default `ps`
  // probe is EPERM-blocked in sandboxes and would answer INCONCLUSIVE
  // for the dead leader (the cycle-2 gate refuses confirm on that).
  const runner2 = await AttemptRunner.open({ root, episodeId: "ep-p7", probes: { pidAlive: killProbe } });
  t.after(() => runner2.close(true));
  const r2 = await runner2.reconcile(task(session));
  assert.equal(r2.decision.action, "park", "reopen: journal pgid still has members ⇒ park (restart analysis consults pgid)");

  // External recovery: kill the group, then confirm + spawn proceed.
  process.kill(-pgid, "SIGKILL");
  for (let i = 0; i < 100; i++) { try { process.kill(-pgid, 0); await new Promise((r) => setTimeout(r, 20)); } catch { break; } }
  await runner2.confirmStopped(task(session), h.attemptId, "SIGKILL -pgid reaped the survivor group; kill(-pgid,0) now ESRCH");
  const r3 = await runner2.reconcile(task(session));
  assert.equal(r3.decision.action, "spawn", "group reaped ⇒ ownership released");
});

// F-9: hint advancement vs stale writers
test("F9: writeStateHint advances to a legitimately newer attempt, refuses a stale rewind", async (t) => {
  const { root, dir, session } = await fixture();
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner() });
  t.after(() => runner.close(true));
  const h1 = await runner.run(task(session)); // a1 row written
  assert.equal(h1.stateWarning, undefined);
  // stale writer: an a0-era hint for the same task must be refused...
  const warn = await runner.writeStateHint(task(session), "t1-a0", 4242, "running");
  assert.ok(warn && /refusing to rewind/.test(warn), "stale lower-numbered writer refused");
  const st1 = await readEpisodeState(join(dir, "state.json"));
  assert.equal(st1.tasks.t1?.attemptId, "t1-a1", "refused writer left the row alone");
  await runner.stop(h1);
  // legitimate advancement: manually seeding a fresh attempt record then
  // hinting the newer attempt must SUCCEED (the finding-9 repro: a2 run
  // after a1 stop had stateWarning).
  const h2 = await runner.run(task(session)); // a2 via the real path
  assert.equal(h2.stateWarning, undefined, "a2's hint write is a clean advancement, no stateWarning");
  const st2 = await readEpisodeState(join(dir, "state.json"));
  assert.equal(st2.tasks.t1?.attemptId, "t1-a2");
  assert.equal(st2.tasks.t1?.pid, h2.pid);
  await runner.stop(h2);
});

// F-8: validateSpawnSpec enforces the CLI contract on CUSTOM spawners
test("F8: validateSpawnSpec refuses --attempt-id and --resume+--session argv", () => {
  const ok = (cmd: string, args: string[]) => validateSpawnSpec({ command: cmd, args }, () => true);
  assert.equal(ok("tre.", ["--session", "/x/s1"]), undefined);
  assert.equal(ok("tre.", ["--resume", "/x/s1"]), undefined);
  assert.match(ok("tre.", ["--session", "/x", "--attempt-id", "a1"]) ?? "", /--attempt-id/);
  assert.match(ok("tre.", ["--resume", "/x", "--session", "/x"]) ?? "", /mutually exclusive/);
});

// F-g: concurrent open() on one episode JOINS instead of double-opening
test("Fg: concurrent AttemptRunner.open() for the same episode yields ONE instance (no double journal writer)", async (t) => {
  const { root } = await fixture();
  const [r1, r2] = await Promise.all([AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner() }), AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner() })]);
  assert.equal(r1, r2, "the second open joins the pending first, same instance");
  r1.close(true);
  // and a sequential open AFTER the instance is closed gets a fresh one
  const r3 = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner() });
  t.after(() => r3.close(true));
  assert.notEqual(r3, r1);
});

// ─────────────── p7-remediation-audit cycle-1 regression tests ─────────────

/** Accurate same-uid liveness probe (kill(pid,0)): running iff ESRCH
 *  is NOT returned. Deterministic where `ps` is blocked/inconclusive. */
// H1-m5 (audit): I3-faithful — ONLY ESRCH is deterministic-negative.
// Any other kill() error (e.g. EPERM on a foreign-uid process) is
// INCONCLUSIVE (undefined), matching .tre/audit/p7-audit-verify.ts.
const killProbe = async (p: number): Promise<PidStatus | undefined> => {
  try { process.kill(p, 0); return { running: true, sameUid: true }; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH" ? { running: false, sameUid: true } : undefined; }
};

// C1-F1(a): tuple state selected by generation + append order — a
// seeded record with a FUTURE timestamp must not hide a real resumed
// generation appended after it (audit repro: ts=Date.now()+100000).
test("C1-F1: a future-ts failed record cannot hide a live resumed generation across reopen (causal selection, not wall clock)", async (t) => {
  const { root, session } = await fixture();
  await seedAttemptRecord(join(root, "ep-p7"), { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "failed", spawnGen: 1, ts: Date.now() + 100_000 });
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner(60), probes: { pidAlive: killProbe } });
  const h = await runner.resume(task(session), "t1-a1"); // real sleep, generation 2
  t.after(() => { try { process.kill(h.pid!, "SIGKILL"); } catch { /* gone */ } });
  assert.ok((h.pid ?? 0) > 0);
  runner.close(true); // lost-supervisor detach
  const runner2 = await AttemptRunner.open({ root, episodeId: "ep-p7", probes: { pidAlive: killProbe } });
  t.after(() => runner2.close(true));
  const rec = await runner2.reconcile(task(session));
  assert.equal(rec.decision.action, "park", "the resumed gen-2 process is the tuple's latest — discovered RUNNING ⇒ park (the higher-ts seeded record would have said spawn)");
  await assert.rejects(runner2.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-running", "a second worker must not start while the resumed generation is live");
});

// C1-F1(b): equal-millisecond intent + outcome pair — the outcome sits
// later in the journal, so latest-per-tuple must pick the FAILED
// outcome (id "d-a" sorts before "d-z" lexically; lexical order is not
// causal order) and must NOT park.
test("C1-F1: equal-ts intent/outcome pair resolves by JOURNAL POSITION, not id/ts — reconcile spawns, never parks", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { id: "d-z", attemptId: "t1-a1", sessionPath: session, spawnOutcome: null, spawnGen: 1, ts: 123 });
  await seedAttemptRecord(dir, { id: "d-a", attemptId: "t1-a1", sessionPath: session, spawnOutcome: "failed", spawnGen: 1, ts: 123 });
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner(), probes: { pidAlive: killProbe } });
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "spawn", "the later-appended failed outcome wins over its equal-ts intent");
  const h = await runner.run(task(session));
  assert.equal(h.attemptId, "t1-a2");
  await runner.stop(h);
});

// C1-F2: legacy generation-zero history — confirming an old dead tuple
// with a fresh timestamp must NOT supersede a discovered-LIVE newer
// legacy tuple (audit repro: a2 owns a real detached sleep).
test("C1-F2: legacy gen-0 — confirmation of a dead old tuple never supersedes a live newer tuple (log position + liveness, not ts)", async (t) => {
  const { root, dir, session } = await fixture();
  const child = procSpawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
  const alivePid = child.pid!;
  child.unref();
  t.after(() => { try { process.kill(-alivePid, "SIGKILL"); } catch { /* gone */ } });
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", ts: 1, pid: 999991, pgid: 999991, detached: true });
  await seedAttemptRecord(dir, { attemptId: "t1-a2", sessionPath: session, spawnOutcome: "ok", ts: 2, pid: alivePid, pgid: alivePid });
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner(), probes: { pidAlive: killProbe } });
  t.after(() => runner.close(true));
  const before = await runner.reconcile(task(session));
  assert.equal(before.decision.action, "park", "a2 discovered live ⇒ park before anything else");
  await runner.confirmStopped(task(session), "t1-a1", "pid 999991 ESRCH — the old process is gone");
  const after = await runner.reconcile(task(session));
  assert.equal(after.decision.action, "park", "the fresh-ts confirmation of a1 must NOT drop a2's live claim");
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-running", "run refuses while a2's real process is alive");
  // recovery: kill a2's group ⇒ ownership released, spawn allowed
  for (let i = 0; i < 100; i++) { try { process.kill(-alivePid, "SIGKILL"); await new Promise((r) => setTimeout(r, 20)); } catch { break; } }
  await runner.confirmStopped(task(session), "t1-a2", "SIGKILL -pgid reaped the survivor group; kill(-pgid,0) ESRCH");
  const rec3 = await runner.reconcile(task(session));
  assert.equal(rec3.decision.action, "spawn", "all legacy claims resolved ⇒ spawn");
});

// C1-F3: close() must refuse while a spawn transaction is in flight
// (queued OR active) — the writer slot stays reserved until it settles.
test("C1-F3: close() refuses during an active AND a queued spawn transaction; succeeds after they settle", async (t) => {
  const { root, session } = await fixture();
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner(60), probes: { pidAlive: killProbe } });
  // gate the FIRST journal append (the intent) to hold a transaction open
  const j = runner as unknown as { journal: { append: (r: AttemptRecord) => Promise<void> } };
  const origAppend = j.journal.append.bind(j.journal);
  let releaseAppend!: () => void;
  let first = true;
  j.journal.append = async (rec: AttemptRecord) => {
    if (first) { first = false; await new Promise<void>((res) => { releaseAppend = res; }); }
    await origAppend(rec);
  };
  const p1 = runner.run(task(session));               // active: paused at intent append
  const p2 = runner.run(task(session, { taskId: "t2", session: join(root, "ep-p7", "sessions", "t2.jsonl") })); // queued behind p1
  for (let i = 0; i < 200 && typeof releaseAppend !== "function"; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(typeof releaseAppend, "function", "the first intent append reached the gate");
  assert.throws(() => runner.close(), (e: RunnerError) => e.code === "ownership-fence" && /spawn transaction/.test(e.message), "close refuses while the transaction is active");
  releaseAppend();
  const h = await p1;
  t.after(() => { try { process.kill(h.pid!, "SIGKILL"); } catch { /* gone */ } });
  const h2 = await p2;
  try {
    assert.throws(() => runner.close(), (e: RunnerError) => e.code === "ownership-fence", "close refuses while children are live");
  } finally { /* expected */ }
  await runner.stop(h);
  await runner.stop(h2);
  runner.close(); // settled & drained: plain close now succeeds
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "bad-input", "closed runner refuses");
});

// C1-F4: confirmStopped is serialized with run/resume on the SAME
// spawn mutex. Audit repro: stale confirm of gen-1 (probe delayed)
// racing a real resume to gen-2 — the confirmation must not land a
// stale failed record + hint clear over the live gen-2 worker.
test("C1-F4: confirmStopped serializes with resume — stale confirmation cannot clobber a live same-attempt resume or its hint", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1, pid: 999991, pgid: 999991, detached: true });
  let spawnCount = 0;
  const countingSpawner = { kind: "c1-f4", spawn: () => { spawnCount += 1; return { command: "/bin/sleep", args: ["60"] }; } };
  // gate the dead-PID probe so the confirmation pauses INSIDE its check
  let releaseProbe!: () => void;
  const gate = new Promise<void>((res) => { releaseProbe = res; });
  const gatedProbe = async (p: number): Promise<PidStatus | undefined> => {
    if (p === 999991) await gate;
    return killProbe(p);
  };
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: countingSpawner, probes: { pidAlive: gatedProbe } });
  const confirmP = runner.confirmStopped(task(session), "t1-a1", "old pid gone (audit stale-confirm race)");
  await new Promise((r) => setImmediate(r));
  const resumeP = runner.resume(task(session), "t1-a1");   // queues behind the mutex
  releaseProbe();
  const confirmed = await confirmP;
  const h = await resumeP;
  t.after(async () => { try { await runner.stop(h); } catch { /* already stopped */ } runner.close(true); });
  assert.equal(confirmed.spawnOutcome, "failed");
  assert.equal(spawnCount, 1, "exactly ONE process spawned — the serialized order is confirm-then-resume, no interleaved overwrite");
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "running", "the gen-2 worker owns the session afterwards");
  const st = await readEpisodeState(join(dir, "state.json"));
  assert.equal(st.tasks.t1?.attemptId, "t1-a1");
  assert.equal(st.tasks.t1?.pid, h.pid, "the final hint row describes the LIVE resumed process, not a cleared stale row");
});

// C1-F5: undeterminable GROUP (EPERM on kill(-pgid,0)) with a dead
// leader parks EVERY entry point — reconcile, run, AND resume (the
// audit: run spawned a real worker while reconcile parked).
test("C1-F5: EPERM/unknown group liveness parks reconcile AND refuses run/resume (every fence branch agrees)", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1, pid: 999991, pgid: 999991 });
  // intercept ONLY the signal-0 group probe for pgid 999991
  const origKill = process.kill;
  const patched = ((pid: number, sig?: NodeJS.Signals | number) => {
    if (pid === -999991 && (sig === 0 || sig === undefined)) {
      const e = Object.assign(new Error("operation not permitted"), { code: "EPERM" }) as NodeJS.ErrnoException & Error;
      throw e;
    }
    return (origKill as (p: number, s?: NodeJS.Signals | number) => boolean)(pid, sig);
  }) as typeof process.kill;
  process.kill = patched;
  t.after(() => { process.kill = origKill; });
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner(), probes: { pidAlive: async (p: number) => (p === 999991 ? { running: false, sameUid: true } : undefined) } });
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "park", "unknown group liveness ⇒ park");
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-unresolved", "run must NOT spawn onto an undeterminable group");
  await assert.rejects(runner.resume(task(session), "t1-a1"), (e: RunnerError) => e.code === "prior-attempt-unresolved", "resume parks too");
  await assert.rejects(runner.confirmStopped(task(session), "t1-a1", "leader pid ESRCH"), (e: RunnerError) => e.code === "ownership-fence", "confirmStopped refuses on unknown group (unchanged)");
  const recsAfter = await runner.records();
  const attemptsAfter = recsAfter.filter((r) => r.kind === "attempt" && r.attemptId === "t1-a1" && r.spawnOutcome === "ok");
  assert.equal(attemptsAfter.length, 1, "NO new spawn happened for the fenced tuple");
});

// C1-F6: corrupt / half-written / wrong-identity state.json is a
// NON-authoritative cache — warn and rebuild from the journal, never
// fail reconcile or block a run (S6 contract).
test("C1-F6: corrupt, half-written and wrong-identity state.json degrade to journal-led recovery with a warning", async (t) => {
  const { root, dir, session } = await fixture();
  const warnings: string[] = [];
  const onWarning = (w: Error): void => { warnings.push(w.message); };
  process.on("warning", onWarning);
  t.after(() => process.off("warning", onWarning));

  // (a) half-written JSON
  await writeFile(join(dir, "state.json"), '{"tasks":');
  const r1 = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner(), probes: { pidAlive: killProbe } });
  const rec1 = await r1.reconcile(task(session));
  assert.equal(rec1.decision.action, "spawn", "corrupt cache: journal says nothing is live ⇒ spawn");
  const h = await r1.run(task(session));
  assert.ok((h.pid ?? 0) > 0, "run proceeds despite the corrupt cache");
  await r1.stop(h);
  r1.close();

  // (b) wrong-identity cache (valid shape, foreign episodeId)
  const r2 = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner(), probes: { pidAlive: killProbe } });
  await writeEpisodeState(join(dir, "state.json"), { schema: STATE_SCHEMA_ID, episodeId: "ep-someone-elses", tasks: { t1: { status: "running", attemptId: "t1-a1", session } } });
  const rec2 = await r2.reconcile(task(session)); // the foreign row claims t1 running — must NOT throw nor be believed
  assert.ok(["spawn", "park"].includes(rec2.decision.action), `journal-led decision, got ${rec2.decision.action}`);
  await new Promise((r) => setImmediate(r));
  assert.ok(warnings.some((w) => w.includes("state.json")), `a state.json warning surfaced, got ${JSON.stringify(warnings)}`);
  r2.close();
});

// C1-F7: stop() with a TERM-ignoring SURVIVING GRANDCHILD: the
// post-exit SIGKILL sweep must be reported as an escalation.
test("C1-F7: surviving grandchild after group SIGTERM — stop() reports escalated:true and confirmed group reap", async (t) => {
  const { root, session } = await fixture();
  const marker = join(root, "grandchild-ready");
  const grandchild = `trap '' TERM; touch '${marker}'; i=0; while [ $i -lt 200000000 ]; do i=$((i+1)); done`;
  const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`; // POSIX-safe nesting
  const parentScript = `sh -c ${sq(grandchild)} & wait`;
  const runner = await AttemptRunner.open({
    root, episodeId: "ep-p7",
    spawner: { kind: "c1-f7", spawn: () => ({ command: "/bin/sh", args: ["-c", parentScript] }) },
    probes: { pidAlive: killProbe },
  });
  const h = await runner.run(task(session));
  const leaderPid = h.pid!;
  t.after(() => { try { process.kill(-leaderPid, "SIGKILL"); } catch { /* gone */ } });
  // readiness-synchronized: wait for the grandchild's marker
  for (let i = 0; i < 250 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(existsSync(marker), "grandchild reported readiness");
  const res = await runner.stop(h);
  assert.equal(res.stopped, true, "stop completes only on confirmed group death");
  assert.equal(res.escalated, true, "the post-exit SIGKILL sweep IS an escalation (audit: was reported false)");
  assert.equal(res.groupStatus, "reaped", "group verified reaped via kill(-pgid,0) ESRCH");
  // the grandchild is really gone
  let survivors = 0;
  try { process.kill(-leaderPid, 0); survivors = 1; } catch { survivors = 0; }
  assert.equal(survivors, 0, "no survivor after the sweep");
});

// C2-B (cycle-2 audit): an unresolved intent whose spawn crashed BEFORE
// the ok append journalled no pgid — the group was never recorded.
// Leader death alone is NOT group death: confirm must probe the leader
// pid AS a hypothetical group and refuse unless ESRCH proves the whole
// (unrecorded) group is gone.
test("C2-B: unresolved intent without journalled pgid — confirm refuses unless the unrecorded group is disproven (ESRCH)", async (t) => {
  const { root, dir, session } = await fixture();
  // crash-between-intent-and-ok shape: intent + nothing else (no ok,
  // so no pid/pgid ever recorded). Even with a dead hint pid, there is
  // NOTHING group-checkable: F-gate (no pid & no pgid) refuses.
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: null });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t1: { status: "running", attemptId: "t1-a1", pid: 999995, session } },
  });
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner(), probes: { pidAlive: killProbe } });
  t.after(() => runner.close(true));
  await assert.rejects(
    runner.confirmStopped(task(session), "t1-a1", "rebooted; hint pid is dead"),
    (e: RunnerError) => e.code === "ownership-fence",
    "identifier-less unresolved tuple: unverified absence — refuse",
  );

  // Same crash, but the crash WROTE a pid (e.g. a later tool stamped
  // it) and no pgid: the hypothetical-group check decides. G3 (P7
  // audit): the check is only SOUND when the journal evidences the
  // detached spawn mode (pgid===pid only holds for a detached leader) —
  // without that evidence confirm REFUSES (the group identity is
  // unknown: a non-detached leader inherits a foreign group). With
  // journalled detached:true + a dead leader whose kill(-pid,0) answers
  // ESRCH, the only consistent group story is no-survivors: confirm
  // proceeds.
  await seedAttemptRecord(dir, { attemptId: "t1-a2", sessionPath: session, spawnOutcome: null, pid: 999996 });
  await assert.rejects(
    runner.confirmStopped(task(session), "t1-a2", "pid dead but spawn mode never recorded"),
    (e: RunnerError) => e.code === "ownership-fence" && /detached/.test(e.message),
    "G3: no detached evidence ⇒ the hypothetical pgid===pid group is unsound — refuse",
  );
  // Stamp the spawn mode into the tuple's journal, then confirm: pid
  // 999996 ESRCH; kill(-999996,0) ESRCH too — no group survives.
  await seedAttemptRecord(dir, { attemptId: "t1-a2", sessionPath: session, spawnOutcome: null, pid: 999996, detached: true });
  const rec = await runner.confirmStopped(task(session), "t1-a2", "pid 999996 ESRCH; kill(-999996,0) ESRCH too — no group survives");
  assert.equal(rec.spawnOutcome, "failed");
  assert.equal(rec.confirmation, true);
});

// C2-D (cycle-2 audit): a NON-detached child shares a FOREIGN group.
// Its exit disproves only the leader — stop() must report stopped:false
// (group death is not possessed), never the old stopped:true claim.
test("C2-D (G1): detached:false violates the group-leader contract — spawn refuses, no legacy survivor in new journals", async (t) => {
  const { root, session } = await fixture();
  const runner = await AttemptRunner.open({
    root, episodeId: "ep-p7",
    spawner: { kind: "non-detached", spawn: () => ({ command: "/bin/sleep", args: ["30"], detached: false }) },
    probes: { pidAlive: killProbe },
  });
  t.after(() => { runner.close(true); });
  // G1: every managed worker MUST lead its own process group so stop()
  // can sweep the whole tree — the contract is enforced at validateSpawnSpec.
  await assert.rejects(
    runner.run(task(session)),
    (e: RunnerError) => e.code === "spawn-failed" && /detached/.test(e.message),
    "detached:false is rejected before the process is created",
  );
  // the pre-spawn intent resolved `failed` — nothing parks in the journal
  const recs = (await runner.records()).filter((r) => r.kind === "attempt") as AttemptRecord[];
  assert.equal(recs.length, 2, "intent + failed resolve");
  assert.equal(recs[recs.length - 1]!.spawnOutcome, "failed");
});

// G1 survivor class: a LEGACY journal (pre-contract) whose ok tuple says
// detached:false with no pgid. The child's waitpid-class exit disproves
// only the leader — the inherited group may hold forked survivors and no
// group-death evidence can ever exist. stop() reports the honest verdict;
// reconcile parks; run() on the same task refuses ACROSS instances.
test("G1 survivor: legacy non-detached ok tuple keeps ownership after leader exit — reconcile/run/confirm all refuse", async (t) => {
  const { root, dir, session } = await fixture();
  const runner = await AttemptRunner.open({
    root, episodeId: "ep-p7",
    spawner: { kind: "sleep30", spawn: () => ({ command: "/bin/sleep", args: ["30"] }) },
    probes: { pidAlive: killProbe },
  });
  t.after(() => { runner.close(true); }); // idempotent
  const h = await runner.run(task(session)); // spawn normally (detached, gen >= 1)
  const pid = h.pid;
  await runner.stop(h); // TERM the whole group; sleep dies with it
  await runner.waitForExit(h);
  // Release the exclusive journal writer so a second supervisor can open.
  await runner.close(true);
  // Rewrite the journal's ok tuple into the LEGACY non-detached shape:
  // detached:false, pgid stripped — exactly what a pre-contract supervisor
  // journalled for a child that shared its parent's group.
  const j = await DecisionJournal.forEpisode(dir);
  const recs = (await j.read()).records.filter((r) => r.kind === "attempt" && r.attemptId === h.attemptId) as AttemptRecord[];
  const ok = recs.find((r) => r.spawnOutcome === "ok")!;
  await j.append({ ...ok, id: newDecisionId(), ts: Date.now(), detached: false, pgid: undefined });
  // reconcile on the SAME instance still sees the exited child; a FRESH
  // supervisor (journal-derived classification, reopen-proof) must park
  // even though the leader probe answers dead.
  const runner2 = await AttemptRunner.open({
    root, episodeId: "ep-p7",
    spawner: exitSpawner(0),
    probes: { pidAlive: async (p: number) => p === pid ? { running: false, sameUid: true } : undefined },
  });
  t.after(() => runner2.close(true));
  const rec2 = await runner2.reconcile(task(session));
  assert.equal(rec2.decision.action, "park", "G1: dead leader + survivor-class tuple parks, never 'spawn'");
  await assert.rejects(
    runner2.run(task(session)),
    (e: RunnerError) => e.code === "prior-attempt-unresolved" && /detached:false asserts an inherited foreign group/.test(e.message),
    "G1: the fence holds across reopen for survivor-class tuples (R5: message quotes the offending record)",
  );
  // confirmStopped refuses too: leader death is not group death for a
  // tuple whose journal says the group was INHERITED.
  await assert.rejects(
    runner2.confirmStopped(task(session), h.attemptId, "leader pid ESRCH"),
    (e: RunnerError) => e.code === "ownership-fence" && /NON-detached/.test(e.message),
    "G1: no confirmation over a survivor-class tuple",
  );
});

// Follow-up audit: durable recovery must distinguish successive process
// spawns under resume()'s stable attemptId, not just tuple-wide history.
for (const generated of [false, true]) {
  test(`G1 survivor cannot be superseded (${generated ? "generation" : "legacy"} ordering)`, async (t) => {
    const { root, dir, session } = await fixture();
    await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: 999991, detached: false, ...(generated ? { spawnGen: 1 } : {}) });
    await seedAttemptRecord(dir, { attemptId: "t1-a2", sessionPath: session, spawnOutcome: "ok", pid: 999992, pgid: 999992, detached: true, ...(generated ? { spawnGen: 2 } : {}) });
    const runner = await openRunner(root, probe({ running: false, sameUid: true }));
    t.after(() => runner.close(true));
    const rec = await runner.reconcile(task(session));
    assert.equal(rec.decision.action, "park");
    assert.ok(rec.ownership.blocking.some((v) => v.record.attemptId === "t1-a1" && v.ownership === true));
    assert.ok(!rec.ownership.superseded.some((v) => v.record.attemptId === "t1-a1"));
    await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-unresolved");
    await assert.rejects(runner.resume(task(session), "t1-a1"), (e: RunnerError) => e.code === "prior-attempt-unresolved");
  });

  for (const detached of [undefined, false, true]) {
    test(`G3 resume uses current mode, not old detached evidence (${generated ? "generation" : "legacy"}, mode=${detached})`, async (t) => {
      const { root, dir, session } = await fixture();
      await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: 999991, pgid: 999991, detached: true, ...(generated ? { spawnGen: 1 } : {}) });
      await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: null, pid: 999992, ...(detached === undefined ? {} : { detached }), ...(generated ? { spawnGen: 2 } : {}) });
      const runner = await openRunner(root, probe({ running: false, sameUid: true }));
      t.after(() => runner.close(true));
      if (detached === true) {
        const rec = await runner.confirmStopped(task(session), "t1-a1", "current detached leader and private group ESRCH");
        assert.equal(rec.confirmation, true);
        // H2-6 (haiku cycle 2): the true branch demonstrates the PASS
        // side of the contract (current detached evidence confirms AND
        // releases the fence) — assert the release, not just the record.
        const after = await runner.reconcile(task(session));
        assert.equal(after.decision.action, "spawn", "confirmation released the tuple — fence open");
        assert.deepEqual(after.ownership.blocking.map((v) => v.record.attemptId).filter((id) => id === "t1-a1"), [], "a1 no longer blocking");
      } else {
        await assert.rejects(runner.confirmStopped(task(session), "t1-a1", "only leader death known"), (e: RunnerError) => e.code === "ownership-fence");
        assert.equal((await runner.reconcile(task(session))).decision.action, "park");
      }
    });
  }

  test(`G2 historical ok cannot authenticate an unresolved resume (${generated ? "generation" : "legacy"})`, async (t) => {
    const { root, dir, session } = await fixture();
    // a1's only successful generation predates a2. Its unobserved
    // later resume must not borrow that success for a new anchor.
    await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: 999991, pgid: 999991, detached: true, ...(generated ? { spawnGen: 1 } : {}) });
    await seedAttemptRecord(dir, { attemptId: "t1-a2", sessionPath: session, spawnOutcome: "ok", pid: 999992, pgid: 999992, detached: true, ...(generated ? { spawnGen: 2 } : {}) });
    await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: null, pid: 999994, pgid: 999994, detached: true, ...(generated ? { spawnGen: 4 } : {}) });
    const runner = await openRunner(root, async (pid) => pid === 999992 ? undefined : { running: false, sameUid: true });
    t.after(() => runner.close(true));
    await runner.confirmStopped(task(session), "t1-a1", "current resume group ESRCH, no ok observed");
    const rec = await runner.reconcile(task(session));
    assert.equal(rec.decision.action, "park");
    assert.deepEqual(rec.ownership.blocking.map((v) => v.record.attemptId), ["t1-a2"]);
    assert.ok(!rec.ownership.superseded.some((v) => v.record.attemptId === "t1-a2"));
    await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-unresolved");
  });

  test(`G2 confirmed never-ok fresh attempt cannot supersede an inconclusive owner (${generated ? "generation" : "legacy"})`, async (t) => {
    const { root, dir, session } = await fixture();
    await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: 999991, pgid: 999991, ...(generated ? { spawnGen: 1 } : {}) });
    await seedAttemptRecord(dir, { attemptId: "t1-a2", sessionPath: session, spawnOutcome: null, pid: 999992, pgid: 999992, ...(generated ? { spawnGen: 2 } : {}) });
    const runner = await openRunner(root, async (pid) => pid === 999991 ? undefined : { running: false, sameUid: true });
    t.after(() => runner.close(true));
    await runner.confirmStopped(task(session), "t1-a2", "group ESRCH; spawn was never observed ok");
    const rec = await runner.reconcile(task(session));
    assert.equal(rec.decision.action, "park");
    assert.deepEqual(rec.ownership.blocking.map((v) => v.record.attemptId), ["t1-a1"]);
  });
}

for (const later of ["resume", "confirmation"] as const) {
  test(`G1 historical survivor survives a later ${later} in the same tuple`, async (t) => {
    const { root, dir, session } = await fixture();
    await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: 999991, detached: false, spawnGen: 1 });
    await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: later === "resume" ? "ok" : "failed", pid: 999992, pgid: 999992, detached: true, spawnGen: 2, ...(later === "confirmation" ? { confirmation: true } : {}) });
    const runner = await openRunner(root, probe({ running: false, sameUid: true }));
    t.after(() => runner.close(true));
    assert.equal((await runner.reconcile(task(session))).decision.action, "park");
    await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-unresolved");
    await assert.rejects(runner.confirmStopped(task(session), "t1-a1", "later detached group gone"), (e: RunnerError) => e.code === "ownership-fence");
  });
}

test("G2 legacy success anchor does NOT supersede an inconclusive older tuple (H2-3 strict doctrine)", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a2", sessionPath: session, spawnOutcome: "ok", pid: 999992, pgid: 999992, detached: true });
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: 999991, pgid: 999991, detached: true });
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: null, pid: 999993, pgid: 999993, detached: true });
  const runner = await openRunner(root, async (pid) => pid === 999992 ? undefined : { running: false, sameUid: true });
  t.after(() => runner.close(true));
  await runner.confirmStopped(task(session), "t1-a1", "current unobserved resume group gone");
  const rec = await runner.reconcile(task(session));
  // H2-3 (haiku cycle 2): a1's unresolved resume confirms (its group is
  // journalled + ESRCH), but a2's liveness probe is INCONCLUSIVE —
  // ordering releases only DETERMINISTICALLY dead tuples. The previous
  // expectation (a2 superseded by a1's success anchor ⇒ spawn) was the
  // fail-open the finding names: a silently unproven owner released.
  assert.equal(rec.decision.action, "park", "inconclusive a2 stays protected — park, never blind-spawn");
  assert.ok(rec.ownership.blocking.some((v) => v.record.attemptId === "t1-a2"), "the inconclusive a2 remains in blocking");
  assert.ok(!rec.ownership.superseded.some((v) => v.record.attemptId === "t1-a2"), "a2 is NOT superseded on inconclusive liveness");
});

test("confirmation refuses foreign-UID running pid evidence", async (t) => {
  const { root, dir, session } = await fixture();
  // H3-4 (audit cycle 12): seed with journalled group identity
  // (detached:true + pgid — 999991 is dead so its private group is
  // reaped) so the tuple is NOT survivor-class: the refusal below then
  // provably comes from the foreign-UID probe logic, not from the
  // unknown-group gate masking it.
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: 999991, pgid: 999991, detached: true });
  const runner = await openRunner(root, probe({ running: true, sameUid: false }));
  t.after(() => runner.close(true));
  assert.equal((await runner.reconcile(task(session))).decision.action, "park");
  await assert.rejects(runner.confirmStopped(task(session), "t1-a1", "foreign uid is not negative evidence"), (e: RunnerError) => e.code === "ownership-fence" && /FOREIGN uid/.test(e.message), "must refuse as foreign-uid RUNNING, not as a generic inconclusive");
});

test("detached pid-only ok record retains its surviving real process group", async (t) => {
  const { root, dir, session } = await fixture();
  const marker = join(dir, "descendant.pid");
  const child = procSpawn("/bin/sh", ["-c", `sleep 30 & echo $! > '${marker}'; exit 0`], { detached: true, stdio: "ignore" });
  let survivor: number | undefined;
  let runner: AttemptRunner | undefined;
  t.after(() => {
    if (survivor) { try { process.kill(survivor, "SIGKILL"); } catch { /* gone */ } }
    if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
    runner?.close(true);
  });
  await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
  const { readFile } = await import("node:fs/promises");
  survivor = Number((await readFile(marker, "utf8")).trim());
  assert.equal((await killProbe(survivor))?.running, true);
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: child.pid, detached: true });
  runner = await openRunner(root, killProbe);
  assert.equal((await runner.reconcile(task(session))).decision.action, "park");
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-running");
  await assert.rejects(runner.resume(task(session), "t1-a1"), (e: RunnerError) => e.code === "prior-attempt-running");
  await assert.rejects(runner.confirmStopped(task(session), "t1-a1", "only leader is gone"), (e: RunnerError) => e.code === "ownership-fence");
});

// H1-M1/M3 (haiku cycle 1): a LIVE historical ok worker recorded under
// the same tuple as a later dead resume must be DISCOVERED (every tuple
// pid gets probed, not just latest) and fence run()/confirmStopped().
test("H1-M1: live historical ok pid hidden behind a later dead resume is discovered and blocks run/confirm", async (t) => {
  const { root, dir, session } = await fixture();
  const survivor = procSpawn("/bin/sleep", ["30"], { stdio: "ignore" });
  const spid = survivor.pid!;
  t.after(() => { try { process.kill(spid, "SIGKILL"); } catch { /* gone */ } });
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: spid });
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: 999991, pgid: 999991, detached: true, spawnGen: 2 });
  const runner = await openRunner(root, killProbe);
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "park", "the surviving historical worker is discovered even though the LATEST record's group is reaped");
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-running");
  await assert.rejects(runner.confirmStopped(task(session), "t1-a1", "latest resume group ESRCH"), (e: RunnerError) => e.code === "ownership-fence", "confirm must resolve EVERY journalled pid — the survivor is running");
});

// H1-M3 (haiku cycle 1): a historical DETACHED group that still has
// members while the latest record's own group is reaped — confirmation
// refuses on the unproven historical group (the cycle-2 guard, live-tested).
test("H1-M3: historical detached group alive under a reaped latest group refuses confirmation", async (t) => {
  const { root, dir, session } = await fixture();
  const grp = procSpawn("/bin/sh", ["-c", "sleep 30 & exit 0"], { detached: true, stdio: "ignore" });
  const gpid = grp.pid!;
  t.after(() => { try { process.kill(-gpid, "SIGKILL"); } catch { /* gone */ } });
  await new Promise<void>((resolve, reject) => { grp.once("exit", () => resolve()); grp.once("error", reject); });
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: gpid, pgid: gpid, detached: true });
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: 999992, pgid: 999992, detached: true, spawnGen: 2 });
  const runner = await openRunner(root, killProbe);
  t.after(() => runner.close(true));
  assert.equal((await runner.reconcile(task(session))).decision.action, "park", "analyze sees the historical group's survivors");
  await assert.rejects(runner.confirmStopped(task(session), "t1-a1", "latest group 999992 ESRCH"), (e: RunnerError) => e.code === "ownership-fence" && /historical process group/.test(e.message));
});

// H2-1 (haiku cycle 2): a resolved-FAILED latest record must not delete
// a DISCOVERED-LIVE process in the same tuple. The ok record journalled
// a (since-reaped) pgid different from its still-live pid — so only the
// PID probe can find the worker. Pre-fix the failed latest exempted the
// tuple from blocking entirely and run() spawned over the live worker.
test("H2-1: live historical pid under a later FAILED latest IN THE SAME TUPLE blocks reconcile/run", async (t) => {
  const { root, dir, session } = await fixture();
  const survivor = procSpawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  const spid = survivor.pid!;
  t.after(() => { try { process.kill(-spid, "SIGKILL"); } catch { /* gone */ } });
  // gen-1 spawned ok: live pid, private group ALREADY REAPED (999991 is
  // dead) — the only evidence of the worker is the pid probe.
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1, pid: spid, pgid: 999991, detached: true });
  // gen-2 resume FAILED to spawn: the tuple's LATEST record is failed.
  // Pre-fix the F6 failed-exemption dropped the whole tuple from
  // `blocking` even though its own probe said RUNNING — run() spawned
  // over the live worker.
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "failed", spawnGen: 2 });
  const runner = await openRunner(root, killProbe);
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "park", "the live a1 pid is discovered despite the failed a2 latest (F6 exemption is not a delete)");
  assert.ok(rec.decision.reasons.some((r) => /t1-a1.*RUNNING/.test(r)), `reason cites a1, got ${JSON.stringify(rec.decision.reasons)}`);
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-running");
});

// H2-2 (haiku cycle 2): a RESOLVED ok tuple that journalled a pid but
// NEITHER pgid NOR detached:true has an unknown spawn mode / unknown
// group — same fail-closed class as G1: reconcile parks (ownership),
// run refuses, confirmStopped refuses even with the leader proven dead.
for (const generated of [false, true]) {
  test(`H2-2: ok pid-only tuple with no journalled group identity is survivor-class (${generated ? "generation" : "legacy"})`, async (t) => {
    const { root, dir, session } = await fixture();
    const survivor = procSpawn("/bin/sleep", ["30"], { stdio: "ignore" });
    const spid = survivor.pid!;
    t.after(() => { try { process.kill(spid, "SIGKILL"); } catch { /* gone */ } });
    await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: spid, ...(generated ? { spawnGen: 1 } : {}) });
    const runner = await openRunner(root, killProbe);
    t.after(() => runner.close(true));
    const rec = await runner.reconcile(task(session));
    assert.equal(rec.decision.action, "park", "unknown group identity ⇒ unprovable ownership ⇒ park");
    assert.ok(rec.ownership.blocking.some((v) => v.record.attemptId === "t1-a1" && v.ownership === true), "view carries derived ownership:true");
    await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-running", "discovered running while alive");
    // kill the survivor; the CLASS still refuses confirmation — leader
    // death cannot disprove an unknown group (manual repair is the only
    // way out, exactly like G1).
    process.kill(spid, "SIGKILL");
    for (let i = 0; i < 100; i++) { try { process.kill(spid, 0); await new Promise((r) => setTimeout(r, 20)); } catch { break; } }
    await assert.rejects(runner.confirmStopped(task(session), "t1-a1", "leader ESRCH — insufficient for an unknown group"), (e: RunnerError) => e.code === "ownership-fence" && /NO journalled group identity/.test(e.message));
    assert.equal((await runner.reconcile(task(session))).decision.action, "park", "dead leader does not clear the class");
  });
}

// H3-6 (audit cycle 12): H2-1 variant where the historical pid probe is
// INCONCLUSIVE (returns undefined) instead of RUNNING. The failed latest
// must not be treated as disproven: the tuple stays blocking (park),
// run() refuses with the inconclusive wording, and a NEWER generated
// tuple does NOT release it either — an undeterminable pid is never a
// deterministic negative, so ordering cannot supersede it (strict F
// doctrine). The tuple is already resolved (latest = failed), so
// confirmStopped is not even the exit: it refuses bad-input "already
// resolved". Release requires the probe to turn deterministically dead.
test("H3-6: historical pid with INCONCLUSIVE probe under a failed latest parks and refuses on inconclusive wording", async (t) => {
  const { root, dir, session } = await fixture();
  const survivor = procSpawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  const spid = survivor.pid!;
  t.after(() => { try { process.kill(-spid, "SIGKILL"); } catch { /* gone */ } });
  // ok record with a PROVEN group identity (pgid journalled, reaped):
  // not survivor-class, so the only live question is the pid probe —
  // which the runner cannot judge (EPERM-class undefined).
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1, pid: spid, pgid: 999991 });
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "failed", spawnGen: 2 });
  const inconclusive = async (pid: number): Promise<PidStatus | undefined> => (pid === spid ? undefined : { running: false, sameUid: true });
  const runner = await openRunner(root, inconclusive);
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "park", "an undeterminable historical pid is UNPROVEN liveness — never 'spawn'");
  assert.ok(rec.probes.some((p) => p.pid === spid && p.running === undefined), "the inconclusive verdict is recorded in the probe trail");
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-unresolved" && /inconclusive/.test(e.message), "fence cites the INCONCLUSIVE verdict, not 'RUNNING'");
  // Strict doctrine: a newer spawned-ok tuple must NOT supersede the
  // inconclusive a1 view — release requires deterministic negative.
  await seedAttemptRecord(dir, { attemptId: "t1-a2", sessionPath: session, spawnOutcome: "ok", spawnGen: 3, pid: 999993, pgid: 999993, detached: true });
  const rec2 = await runner.reconcile(task(session));
  assert.equal(rec2.decision.action, "park", "ordering does not supersede an inconclusive view");
  assert.ok(!rec2.ownership.superseded.some((v) => v.record.attemptId === "t1-a1" && v.probe && v.probe.running === undefined), "no inconclusive-probe view is superseded by ordering");
});

// H3-7 (audit cycle 12) / H3-R4 (audit review): PURE generation-ordering
// supersession with NON-survivor-class seeds (both tuples journalled
// detached:true + pgid, both dead) — the ONLY mechanism in play is
// generation ordering. The existing G1 "cannot be superseded
// (generation)" test seeds a1 as survivor-class (detached:false), so its
// non-supersession passed trivially via the ownership skip regardless of
// ordering; this test pins the ordering release ITSELF — and per R4 it
// appends the higher-generation anchor BEFORE the lower-generation
// record, so the assertion proves release by GENERATION, not by append
// order: a gen-2 anchor written first must still supersede a gen-1
// record appended later.
test("H3-7/R4: generation supersedes despite reversed append order (anchor appended first)", async (t) => {
  const { root, dir, session } = await fixture();
  // R4: higher-gen anchor FIRST, lower-gen record second.
  await seedAttemptRecord(dir, { attemptId: "t1-a2", sessionPath: session, spawnOutcome: "ok", pid: 999992, pgid: 999992, detached: true, spawnGen: 2 });
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: 999991, pgid: 999991, detached: true, spawnGen: 1 });
  const runner = await openRunner(root, probe({ running: false, sameUid: true }));
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.ok(rec.ownership.superseded.some((v) => v.record.attemptId === "t1-a1"), "gen-1 tuple released by the gen-2 anchor despite the anchor being appended FIRST (generation, not append order)");
  assert.ok(!rec.ownership.blocking.some((v) => v.record.attemptId === "t1-a1"), "superseded tuple is not blocking");
  assert.ok(!rec.ownership.superseded.some((v) => v.record.attemptId === "t1-a1" && v.ownership === true), "the release is NOT the survivor-ownership path");
  const h = await runner.run(task(session)); // fence opens: no survivor, ordering released a1
  await runner.stop(h);
  await runner.waitForExit(h);
});

// H3-R1 (audit review): PID laundering across spawn generations. A
// legacy identifier-less ok claim (gen 1: pid, no pgid, no mode) is
// survivor-class. A LATER spawn (gen 2) that journals the SAME numeric
// pid WITH proven group identity is a DIFFERENT process (PID reuse) —
// scoped per-cohort proof means it can never rehabilitate the gen-1
// claim. Pre-R1, the tuple-level union laundered it: the gen-2 ok made
// the pid "proven" and the fence opened. Now the tuple stays
// survivor-class: ownership, park, run/confirm refuse.
test("H3-R1: a later-generation proven record cannot launder an earlier identifier-less claim (PID reuse)", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: 999991, spawnGen: 1 }); // unproven cohort
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: 999991, pgid: 999991, detached: true, spawnGen: 2 }); // different cohort
  const runner = await openRunner(root, probe({ running: false, sameUid: true }));
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "park", "R1: cross-gen laundering must NOT open the fence — the gen-1 claim survives into ownership");
  assert.ok(rec.ownership.blocking.some((v) => v.record.attemptId === "t1-a1" && v.ownership === true), "R1: the tuple carries survivor ownership despite the gen-2 proven record");
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-unresolved", "R1: run refuses onto the laundered tuple");
  await assert.rejects(runner.confirmStopped(task(session), "t1-a1", "later generation dead"), (e: RunnerError) => e.code === "ownership-fence", "R1: confirm refuses — the legacy cohort taint is permanent");
});

// H3-R1 complement: SAME-cohort enrichment still works — an intent
// whose pid was journalled mode-unrecorded and whose OWN ok resolve
// (same spawnGen/legacy cohort) re-records the pid proven is NOT
// survivor-class (the pre-P8 journal keeps its enrichment semantics).
test("H3-R1b: same-cohort ok resolve enriches the mode-unrecorded intent (no survivor class)", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: null, pid: 999991 }); // legacy intent, mode unrecorded
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", pid: 999991, detached: true }); // same legacy cohort, proven mode
  const runner = await openRunner(root, probe({ running: false, sameUid: true }));
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.ok(!rec.ownership.blocking.some((v) => v.ownership === true), "R1b: same-spawn enrichment — no survivor ownership");
  assert.equal(rec.decision.action, "spawn", "R1b: dead proven worker — the fence opens");
});

// H3-R2/F1 (audit cycle R1): the F6 failed-latest exemption must not
// erase an OBSERVED-OK-without-identifiers claim through the blocking
// filter. Sequence: a1 ok (no identifiers) -> a1 failed (no
// identifiers, later gen) -> a2 proven dead ok. Pre-fix, `blocking`
// consulted only the view's latest record (failed => "process never
// existed") and dropped a1 — permitting a spawn with zero death
// evidence for the process the journal positively observed. Now the
// identifier-less observed-ok keeps a1 blocking.
test("H3-F1: a failed latest does not exempt an identifier-less observed-ok tuple from blocking", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok" }); // observed, zero identifiers
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "failed", spawnGen: 2 }); // failed latest, zero identifiers
  await seedAttemptRecord(dir, { attemptId: "t1-a2", sessionPath: session, spawnOutcome: "ok", pid: 999992, pgid: 999992, detached: true, spawnGen: 3 });
  const runner = await openRunner(root, probe({ running: false, sameUid: true }));
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.ok(rec.ownership.blocking.some((v) => v.record.attemptId === "t1-a1"), "F1: the observed-ok tuple stays BLOCKING despite the failed latest");
  assert.equal(rec.decision.action, "park", "F1: no spawn decision without death evidence");
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-unresolved", "F1: run refuses — the observation was never disproven");
});

// ───────────────────────────── boundary guard ───────────────────────────────

// H3-R2 (audit review): an OBSERVED-OK tuple with NO identifiers (no
// pid, no pgid, no spawnGen-derived proof) is never released by append
// ordering alone — the journal positively observed a process and a
// later anchor says nothing about its death. It stays fenced (park)
// across reopen; only manual journal repair clears it. (Contrast: a
// NEVER-OBSERVED-OK intent retains the F1/F2 ordering escape.)
test("H3-R2: identifier-less observed-ok tuple is never superseded by a later anchor (reopen-stable)", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok" }); // legacy ok, zero identifiers
  await seedAttemptRecord(dir, { attemptId: "t1-a2", sessionPath: session, spawnOutcome: "ok", pid: 999992, pgid: 999992, detached: true, spawnGen: 2 });
  const runner = await openRunner(root, probe({ running: false, sameUid: true }));
  const rec = await runner.reconcile(task(session));
  assert.ok(!rec.ownership.superseded.some((v) => v.record.attemptId === "t1-a1"), "R2: the observed-ok no-identifier tuple is NOT released by the later anchor");
  assert.ok(rec.ownership.blocking.some((v) => v.record.attemptId === "t1-a1"), "it stays in the fence");
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-unresolved", "run refuses onto the fenced path");
  await runner.close(true);
  // Reopen: journal-derived classification, not in-memory state.
  const runner2 = await openRunner(root, probe({ running: false, sameUid: true }));
  t.after(() => runner2.close(true));
  const rec2 = await runner2.reconcile(task(session));
  assert.ok(!rec2.ownership.superseded.some((v) => v.record.attemptId === "t1-a1"), "R2: still not superseded after reopen");
  assert.equal(rec2.decision.action, "park", "R2: parks across reopen — append ordering never erases an observation");
});

// H3-R2/F6 (audit cycle R2): cohort-scoped protection. Inside ONE
// tuple, a spawn observed ok whose OWN cohort journalled no pid is
// identified only by records OF THAT COHORT (or an S6 hint row when
// the tuple journalled no pid at all). Identifiers belonging to a
// DIFFERENT spawn cohort describe OTHER processes: seeding `g1: ok,
// no identifiers` then `g2: failed, pid, pgid, detached:true` (P
// deterministically dead) must NOT launder the g1 observation —
// pre-fix the tuple-wide probe plus the failed-latest exemption
// dropped the tuple with zero death evidence for g1.
test("H3-F6: a newer cohort's identifiers cannot launder an older cohort's observed-ok claim", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1 }); // observed, zero identifiers
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "failed", spawnGen: 2, pid: 999991, pgid: 999991, detached: true }); // dead deterministically
  const runner = await openRunner(root, probe({ running: false, sameUid: true }));
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "park", "F6: the g2 negative says nothing about g1's process — park");
  assert.ok(rec.ownership.blocking.some((v) => v.record.attemptId === "t1-a1"), "F6: tuple stays blocking via the cohort claim");
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-unresolved" && /HISTORICAL spawn/.test(e.message), "F7: the diagnostic names the historical observed-ok claim (not the failed latest)");
  // F7: reconcile's park reason must describe the claim truthfully.
  assert.match(rec.decision.reasons.join(" "), /HISTORICAL spawn observed ok WITHOUT a journalled pid/, "F7: truthful park reason");
  assert.doesNotMatch(rec.decision.reasons.join(" "), /spawned ok but NO pid/, "F7: never claims the LATEST spawned ok");
  // F7: confirmStopped refuses — confirming cannot reach a claim with
  // no probeable identity.
  await assert.rejects(runner.confirmStopped(task(session), "t1-a1", "g2 pid ESRCH"), (e: RunnerError) => e.code === "ownership-fence" && /HISTORICAL spawn observed ok WITHOUT a journalled pid/.test(e.message), "F6/F7: refusal names the undisprovable cohort claim");
});

// F6 companion (same-cohort enrichment pass): the claim is discharged
// ONLY when the cohort itself gains identity — a journal pid ON THE OK
// RECORD'S OWN cohort, with proven mode (detached:true), so the tuple
// is (a) no longer identifier-less and (b) not survivor-class. Then a
// deterministic negative probe of that pid is real death evidence and
// the ordering fence opens for the newer tuple.
test("H3-F6 companion: same-cohort enrichment (pid on the ok record's own cohort) discharges the claim", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1, pid: 999991, detached: true }); // same-cohort identifier (manual journal repair)
  await seedAttemptRecord(dir, { attemptId: "t1-a2", sessionPath: session, spawnOutcome: "ok", spawnGen: 2, pid: 999992, pgid: 999992, detached: true });
  const runner = await openRunner(root, probe({ running: false, sameUid: true }));
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "spawn", "enriched cohort + deterministic negative — the fence opens");
  const h = await runner.run(task(session));
  assert.equal(h.attemptId, "t1-a3", "spawn proceeds after enrichment");
});


// ── Audit cycle R3 fixes (F10/F11/F12), cycle R4 ──────────────────────────

// F10: a state.json hint row identifies the tuple's LATEST spawn cohort
// only — failed generations count. gen1 ok-without-pid + gen2 failed
// means the hint (gen2's spawn) can NEVER enrich gen1's claim: analyze,
// confirmStopped, and run() must ALL refuse (no laundering).
test("R4-F10: hint never back-assigns past a failed generation — the older ok-without-pid cohort stays protected", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1 });
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "failed", spawnGen: 2 });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t1: { status: "running", attemptId: "t1-a1", session, pid: 999991 } },
  });
  const runner = await openRunner(root, probe({ running: false, sameUid: true }));
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.ok(rec.ownership.blocking.some((b) => b.protectedOk !== undefined), "gen-1 ok-without-pid stays protected despite the hint");
  await assert.rejects(
    runner.confirmStopped(task(session), "t1-a1", "sweep done; hint pid dead"),
    (e: RunnerError) => e.code === "ownership-fence" && /HISTORICAL spawn observed ok WITHOUT/.test(e.message),
    "confirmStopped refuses: the hint is gen-2's identity, not gen-1's",
  );
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-unresolved");
});

// F11: an explicit pgid IS probeable identity — group death (ESRCH)
// discharges the observed-ok claim even with no leader pid journalled.
test("R4-F11: explicit pgid without pid is probeable identity — deterministic group death discharges the ok claim", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1, pgid: 999991, detached: true });
  const runner = await AttemptRunner.open({
    root, episodeId: "ep-p7", spawner: sleepSpawner(),
    probes: { pidAlive: async () => ({ running: false, sameUid: true }) },
  });
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.ok(!rec.ownership.blocking.some((b) => b.protectedOk !== undefined), "the pgid cohort is probeable — never an unprobeable-ok claim (F11)");
  const confirmed = await runner.confirmStopped(task(session), "t1-a1", "pgid 999991 group ESRCH — deterministic group death");
  assert.equal(confirmed.confirmation, true, "deterministic group death discharges the claim");
  const h = await runner.run(task(session));
  assert.equal(h.attemptId, "t1-a2", "the fence opens after group death is proven");
});

// F12: ONE identity-enrichment contract — a hint-only ok tuple where
// analyze probes the hint (dead) and confirmStopped accepts the SAME
// identity: reconcile spawn-class, confirm succeeds, and a subsequent
// run() proceeds (consumers never disagree).
test("R4-F12: hint-enriched ok tuple — confirm and analyze agree (confirm then run proceeds)", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1 });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t1: { status: "running", attemptId: "t1-a1", session, pid: 999991 } },
  });
  const runner = await openRunner(root, probe({ running: false, sameUid: true }));
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "spawn", "analyze: the hint identity was probed dead — spawn-class");
  const confirmed = await runner.confirmStopped(task(session), "t1-a1", "full sweep complete; hint identity 999991 ESRCH");
  assert.equal(confirmed.confirmation, true);
  const h = await runner.run(task(session));
  assert.equal(h.attemptId, "t1-a2", "post-confirmation run proceeds — no consumer disagreement");
});

// F12 guard: an UNRESOLVED tuple with a hint-only identity must NEVER
// confirm — the hint names at most the leader, spawn mode unrecorded.
test("R4-F12 guard: unresolved intent with hint-only identity still refuses (G3 doctrine holds)", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: null });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t1: { status: "running", attemptId: "t1-a1", session, pid: 999995 } },
  });
  const runner = await openRunner(root, async (p: number) => p === 999995 ? { running: false, sameUid: true } : undefined);
  t.after(() => runner.close(true));
  await assert.rejects(
    runner.confirmStopped(task(session), "t1-a1", "hint pid dead"),
    (e: RunnerError) => e.code === "ownership-fence" && /UNRESOLVED with NO journalled identity/.test(e.message),
  );
});


// F17 (audit cycle R4): deterministic GROUP death is accepted
// CONSISTENTLY — reconcile AND the spawn fence must both treat a
// leader-less claim (ok, pgid journalled, NO pid anywhere) with a
// negative group probe (kill(-pgid,0) ESRCH) as disproven. Direct-run
// coverage: run() spawns WITHOUT any confirmation round-trip (the R3
// fence parked here while reconcile spawned — consumer divergence).
test("R4-F17: group-only death accepted by the spawn fence directly — run() proceeds with pgid-ESRCH and no pid, no confirm needed", async (t) => {
  const { root, dir, session } = await fixture();
  // pgid 999991 is a reserved-dead group: kill(-999991,0) ESRCHes
  // deterministically (same convention as the F11 test).
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1, pgid: 999991, detached: true });
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner(), probes: { pidAlive: killProbe } });
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "spawn", "analyze: negative group probe discharges the leader-less claim");
  assert.ok(!rec.ownership.blocking.some((b) => b.protectedOk !== undefined), "an explicit pgid is probeable identity, never an unprobeable-ok claim");
  // THE DIRECT-RUN REGRESSION: the fence must accept the same evidence
  // analyze accepted — BEFORE F17 it threw prior-attempt-unresolved
  // ("no pid was ever recorded") while reconcile said spawn.
  const h = await runner.run(task(session));
  assert.equal(h.attemptId, "t1-a2", "the fence accepted the group-death evidence: run() spawned without confirmation");
  await runner.stop(h);
});

// F15 (audit cycle R4): a historical `confirmation:true` alone is NOT
// proof the cohort-wide closure contract was satisfied. A journal of
// [g1 ok/NO-identity, g2 ok/dead-pid, g2 confirmation] (the exact
// pre-R5 confirmStopped output — it only ever checked the LATEST
// cohort) must keep the g1 claim protected forever: the confirmation
// copies gen-2 identity, which says nothing about gen-1's process.
test("R4-F15: a confirmation copying gen-2 identity cannot launder a gen-1 identifier-less ok claim (no positional laundering)", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1 }); // the undischarged g1 claim
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 2, pid: 999991, pgid: 999991, detached: true });
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "failed", spawnGen: 2, pid: 999991, pgid: 999991, detached: true, confirmation: true }); // pre-R5-style: copies g2 only
  const runner = await openRunner(root, probe({ running: false, sameUid: true }));
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.ok(rec.ownership.blocking.some((b) => b.protectedOk !== undefined), "the g1 claim survives the g2 confirmation: closure is evidence-carried, not position-carried");
  await assert.rejects(
    runner.confirmStopped(task(session), "t1-a1", "confirmation of the g1 cohort"),
    (e: RunnerError) => e.code === "ownership-fence" && /HISTORICAL spawn observed ok WITHOUT/.test(e.message),
    "confirmStopped refuses — the g1 cohort has no identity ANY confirmation of it ever probed",
  );
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-unresolved");
});

// F15 positive half: a confirmation of a hint-identified tuple STAMPS
// the probed-dead identity onto the confirmation record itself, so the
// closure survives reopen — a fresh instance reads the journal-carried
// evidence, not a positional rule.
test("R4-F15b: confirmation of a hint-identified tuple stamps the probed identity — closure is reopen-stable", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1 });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t1: { status: "running", attemptId: "t1-a1", session, pid: 999991 } },
  });
  const runner = await openRunner(root, probe({ running: false, sameUid: true }));
  const confirmed = await runner.confirmStopped(task(session), "t1-a1", "hint identity 999991 probed ESRCH");
  assert.equal(confirmed.confirmation, true);
  assert.equal(confirmed.pid, 999991, "the confirmation RECORD carries the identity that was probed dead — not just a positional flag");
  runner.close(true);
  // Reopen: a NEW instance must see the journal-stamped closure and
  // spawn — without the stamp this tuple is identity-less again.
  const runner2 = await openRunner(root, probe({ running: false, sameUid: true }));
  t.after(() => runner2.close(true));
  const after = await runner2.reconcile(task(session));
  assert.equal(after.decision.action, "spawn", "the stamped identity discharges the claim for every later reader (evidence-carried closure)");
});

// F16 (audit cycle R4): protection, analyze, and confirmation share the
// ACTUAL accepted identity set — EVERY hint row matching attemptId +
// sessionPath across ALL task keys. A live row under another task key
// must block confirmStopped too (R3 enriched analyze with it but
// confirmation probed only the own-task row: confirm succeeded while
// analyze parked and run refused — consumer disagreement).
test("R4-F16: every accepted hint row is confirmation evidence — a live row under another task key blocks confirm", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1 });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7",
    tasks: {
      t3: { status: "running", attemptId: "t1-a1", session, pid: 999992 }, // first match — dead
      t1: { status: "running", attemptId: "t1-a1", session, pid: 999991 }, // own key — dead
      t2: { status: "running", attemptId: "t1-a1", session, pid: 777777 }, // non-first, non-own matching row — LIVE
    },
  });
  let alivePid = 777777;
  const runner = await openRunner(root, async (p: number) => ({ running: p === alivePid, sameUid: true }));
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "park", "analyze probes the FULL accepted set — the live t2 row parks");
  await assert.rejects(
    runner.confirmStopped(task(session), "t1-a1", "own-row 999991 is dead"),
    (e: RunnerError) => e.code === "ownership-fence" && /777777/.test(e.message) && /RUNNING/.test(e.message),
    "confirmation shares the set: the accepted t2 row is alive — refuse (R3 accepted here: the disagreement)",
  );
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-running", "run agrees with analyze AND confirmation");
  // Agreement under full death: once the whole accepted set is negative, confirm succeeds and run proceeds.
  alivePid = -1;
  const confirmed = await runner.confirmStopped(task(session), "t1-a1", "full sweep: BOTH accepted rows (777777, 999991) ESRCH");
  assert.equal(confirmed.confirmation, true, "all accepted identities negative ⇒ closure");
  const h = await runner.run(task(session));
  assert.equal(h.attemptId, "t1-a2", "consumers never disagree: confirm then run proceed together");
  await runner.stop(h);
});

// F16 companion: an INCONCLUSIVE accepted-row probe is not acceptance.
test("R4-F16b: an inconclusive accepted-hint probe refuses confirmation (deterministic negative required for every accepted identity)", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1 });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t1: { status: "running", attemptId: "t1-a1", session, pid: 999993 } },
  });
  const runner = await openRunner(root, async (p: number) => (p === 999993 ? undefined : { running: false, sameUid: true }));
  t.after(() => runner.close(true));
  await assert.rejects(
    runner.confirmStopped(task(session), "t1-a1", "hint row probe inconclusive"),
    (e: RunnerError) => e.code === "ownership-fence" && /999993/.test(e.message) && /INCONCLUSIVE/.test(e.message),
  );
});

// F18 (audit cycle R4): explicit stale-refresh policy — a tuple whose
// LATEST record is a confirmation is CLOSED; re-writing a pid hint for
// it would re-create an identity for a proven-dead cohort. The write is
// REFUSED (warning, state untouched); clearing stays allowed and fresh
// tuples are unaffected.
test("R5-1: a refresh queued AFTER a confirmation cannot recreate the hint after the tuple closes", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1, pid: 999991, pgid: 999991, detached: true });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t1: { status: "running", attemptId: "t1-a1", session, pid: 999991 } },
  });
  const runner = await openRunner(root, probe({ running: false, sameUid: true }));
  t.after(() => runner.close(true));
  const internals = runner as unknown as { readState: () => Promise<unknown> };
  const originalReadState = internals.readState.bind(runner);
  let entered!: () => void;
  let release!: () => void;
  const atRead = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let block = true;
  internals.readState = async function() {
    if (block) { block = false; entered(); await gate; }
    return originalReadState();
  };
  const confirmation = runner.confirmStopped(task(session), "t1-a1", "journal pid/group 999991 dead");
  await atRead; // confirmation owns the queue, paused before its state snapshot
  const refresh = runner.writeStateHint(task(session), "t1-a1", 777777, "running"); // queued behind confirmation
  release();
  const confirmed = await confirmation;
  const warning = await refresh;
  assert.equal(confirmed.confirmation, true);
  assert.ok(warning && /CLOSED/.test(warning), "queued refresh re-reads closure after confirmation and refuses");
  const state = await readEpisodeState(join(dir, "state.json"));
  assert.equal(state.tasks.t1?.pid, undefined, "confirmation's clear remains final");
  assert.equal((await runner.reconcile(task(session))).decision.action, "spawn");
});

// R7-1 (audit): the TRUE refresh-FIRST ordering. A hint refresh that
// owns the transaction queue BEFORE the confirmation is requested must
// have its written identity visible to the queued confirmation —
// confirmation sees the refreshed live row, refuses, and appends no
// closure. The existing R5-1 test (confirmation queued first) does NOT
// discriminate this ordering.
test("R7-1: a refresh queued BEFORE confirmation blocks the confirmation with the refreshed live identity", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1, pid: 999991, pgid: 999991, detached: true });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t1: { status: "running", attemptId: "t1-a1", session, pid: 999991 } },
  });
  // 999991 probes DEAD; 777777 (the refreshed hint) probes LIVE.
  const runner = await openRunner(root, async (p: number) => ({ running: p === 777777, sameUid: true }));
  t.after(() => runner.close(true));
  const internals = runner as unknown as { readState: () => Promise<unknown> };
  const originalReadState = internals.readState.bind(runner);
  let entered!: () => void;
  let release!: () => void;
  const atRead = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let block = true;
  internals.readState = async function() {
    if (block) { block = false; entered(); await gate; }
    return originalReadState();
  };
  const refresh = runner.writeStateHint(task(session), "t1-a1", 777777, "running");
  await atRead; // the REFRESH owns the queue, paused before its state snapshot
  const confirmation = runner.confirmStopped(task(session), "t1-a1", "journal pid/group 999991 dead"); // queued behind the refresh
  release();
  assert.equal(await refresh, undefined, "the refresh lands first");
  const stateAfterRefresh = await readEpisodeState(join(dir, "state.json"));
  assert.equal(stateAfterRefresh.tasks.t1?.pid, 777777, "the live hint is durable before confirmation runs");
  await assert.rejects(
    confirmation,
    (e: RunnerError) => e.code === "ownership-fence" && /777777/.test(e.message),
    "the queued confirmation sees the refreshed live identity and refuses",
  );
  assert.equal((await runner.records()).some((r) => r.kind === "attempt" && (r as AttemptRecord).confirmation === true), false, "no closure appended");
  assert.equal((await runner.reconcile(task(session))).decision.action, "park", "the refreshed live hint still owns the session");
});

test("R5-2: accepted cross-task hint inserted during confirmation invalidates the snapshot", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1 });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t1: { status: "running", attemptId: "t1-a1", session, pid: 999991 } },
  });
  const runner = await openRunner(root, probe({ running: false, sameUid: true }));
  t.after(() => runner.close(true));
  const internals = runner as unknown as { readState: () => Promise<unknown> };
  const originalReadState = internals.readState.bind(runner);
  let reads = 0;
  internals.readState = async function() {
    reads += 1;
    if (reads === 2) {
      await writeEpisodeState(join(dir, "state.json"), {
        schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: {
          t1: { status: "running", attemptId: "t1-a1", session, pid: 999991 },
          t2: { status: "running", attemptId: "t1-a1", session, pid: 777777 },
        },
      });
    }
    return originalReadState();
  };
  await assert.rejects(
    runner.confirmStopped(task(session), "t1-a1", "initial hint identity was dead"),
    (e: RunnerError) => e.code === "ownership-fence" && /changed during confirmation/.test(e.message),
    "confirmation must not close a tuple after the accepted identity set changes",
  );
  const latest = (await runner.records()).at(-1) as AttemptRecord;
  assert.notEqual(latest.confirmation, true, "no confirmation record appended on a changed snapshot");
});

test("R5-3: journalled pid plus live matching hint blocks analyze, run, and confirmation consistently", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1, pid: 999991, pgid: 999991, detached: true });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t1: { status: "running", attemptId: "t1-a1", session, pid: 777777 } },
  });
  const runner = await openRunner(root, async (p: number) => ({ running: p === 777777, sameUid: true }));
  t.after(() => runner.close(true));
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "park", "analyze includes matching hint identities despite journalled pid evidence");
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-running");
  await assert.rejects(runner.confirmStopped(task(session), "t1-a1", "journal identity dead"), (e: RunnerError) => e.code === "ownership-fence" && /777777.*RUNNING/.test(e.message));
});

test("R4-F18: writeStateHint refuses a pid refresh over a CLOSED (confirmed) tuple — no identity re-creation", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1 });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t1: { status: "running", attemptId: "t1-a1", session, pid: 999991 } },
  });
  const runner = await openRunner(root, probe({ running: false, sameUid: true }));
  t.after(() => runner.close(true));
  await runner.confirmStopped(task(session), "t1-a1", "hint identity 999991 ESRCH — tuple closed");
  // Wedged writer lands late with a NEW pid for the CLOSED cohort:
  const warn = await runner.writeStateHint(task(session), "t1-a1", 777777, "running");
  assert.ok(warn && /CLOSED/.test(warn), "pid write over a closed tuple is refused with the F18 policy warning");
  const st1 = await readEpisodeState(join(dir, "state.json"));
  assert.ok(st1.tasks.t1?.pid === undefined, "the refused write left the cleared row untouched — no identity re-created");
  // Clearing (pid=undefined) stays allowed even for a closed tuple:
  const clearWarn = await runner.writeStateHint(task(session), "t1-a1", undefined, "paused");
  assert.equal(clearWarn, undefined, "clearing a closed tuple's row is a no-op toward the dead cohort, not enrichment");
  // Fresh tuples are unaffected: an open tuple accepts its hint.
  await seedAttemptRecord(dir, { attemptId: "t1-a3", sessionPath: session, spawnOutcome: "ok", spawnGen: 3 });
  const freshWarn = await runner.writeStateHint(task(session), "t1-a3", 777777, "running");
  assert.equal(freshWarn, undefined, "an unclosed tuple's hint write proceeds normally");
});

// F19 (audit cycle R4): witness completeness — every ownership throw
// cites the OFFENSE RECORD's UUID and ISO timestamp, so an operator
// can locate exactly the record that owns the fence.
test("R4-F19: every ownership refusal cites the offense record's UUID and ISO timestamp", async (t) => {
  const { root, dir, session } = await fixture();
  // (1) survivor class: pid journalled with NO pgid/detached — mode never recorded.
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1, pid: 555555, ts: 1735689600000 });
  const runner = await openRunner(root, probe({ running: false, sameUid: true }));
  t.after(() => runner.close(true));
  const recs = await runner.records();
  const survivor = recs.find((r) => r.kind === "attempt" && (r as AttemptRecord).spawnGen === 1) as AttemptRecord;
  const iso = new Date(survivor.ts).toISOString();
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  await assert.rejects(
    runner.confirmStopped(task(session), "t1-a1", "sweep done"),
    (e: RunnerError) => e.message.includes(survivor.id) && e.message.includes(iso),
    "survivor-class refusal quotes the offense record UUID + ISO ts",
  );
  await runner.close(true);

  // (2) unprobeable-ok: ok WITHOUT any identity — the fence refusal
  // (run) and the confirmation refusal both quote the ok record.
  const { root: root2, dir: dir2, session: session2 } = await fixture();
  await seedAttemptRecord(dir2, { attemptId: "t1-a1", sessionPath: session2, spawnOutcome: "ok", spawnGen: 1, ts: 1735689600000 });
  const runner2 = await openRunner(root2, probe({ running: false, sameUid: true }));
  t.after(() => runner2.close(true));
  const okRec = (await runner2.records()).find((r) => r.kind === "attempt") as AttemptRecord;
  const iso2 = new Date(okRec.ts).toISOString();
  await assert.rejects(
    runner2.run(task(session2)),
    (e: RunnerError) => e.code === "prior-attempt-unresolved" && e.message.includes(okRec.id) && e.message.includes(iso2),
    "spawn-fence ok-without-pid refusal quotes the offense record UUID + ISO ts",
  );
  await assert.rejects(
    runner2.confirmStopped(task(session2), "t1-a1", "sweep done"),
    (e: RunnerError) => e.code === "ownership-fence" && e.message.includes(okRec.id) && e.message.includes(iso2),
    "confirmation refusal quotes the same witness",
  );
});

// R6-1: an EXITED own child disproves only its own pid. An independent
// matching hint identity that is live (or inconclusive) still blocks
// reconcile, the spawn fence, and confirmation alike.
test("R6-1: own child exited + independent live hint → reconcile parks, run refuses, confirm refuses", async (t) => {
  const { root, dir, session } = await fixture();
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner(), probes: { pidAlive: async (p: number) => ({ running: p === 777777, sameUid: true }) } });
  t.after(() => runner.close(true));
  const h = await runner.run(task(session));
  await runner.stop(h);
  assert.equal(await runner.writeStateHint(task(session), h.attemptId, 777777, "running"), undefined, "hint write over an open tuple is accepted");
  const rec = await runner.reconcile(task(session));
  assert.equal(rec.decision.action, "park", "independent live hint parks reconcile despite the exited own child");
  await assert.rejects(runner.confirmStopped(task(session), h.attemptId, "own child stopped"), (e: RunnerError) => e.code === "ownership-fence" && /777777/.test(e.message));
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-running", "the fence agrees with reconcile");
  void dir;
});

test("R6-1 companion: exited own child + independent INCONCLUSIVE hint → run refuses (no bypass)", async (t) => {
  const { root, session } = await fixture();
  const runner = await AttemptRunner.open({ root, episodeId: "ep-p7", spawner: sleepSpawner(), probes: { pidAlive: async (p: number) => (p === 666666 ? undefined : { running: false, sameUid: true }) } });
  t.after(() => runner.close(true));
  const h = await runner.run(task(session));
  await runner.stop(h);
  await runner.writeStateHint(task(session), h.attemptId, 666666, "running");
  await assert.rejects(runner.run(task(session)), (e: RunnerError) => e.code === "prior-attempt-unresolved" && /666666/.test(e.message));
});

// R6-2: confirmation of a tuple must name its JOURNAL-BOUND session.
test("R6-2: confirmStopped against a different session path is refused before any probe or append", async (t) => {
  const { root, dir, session } = await fixture();
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1, pid: 999991, pgid: 999991, detached: true });
  await writeEpisodeState(join(dir, "state.json"), {
    schema: STATE_SCHEMA_ID, episodeId: "ep-p7", tasks: { t2: { status: "running", attemptId: "t1-a1", session, pid: 777777 } },
  });
  const runner = await openRunner(root, async (p: number) => ({ running: p === 777777, sameUid: true }));
  t.after(() => runner.close(true));
  const before = (await runner.records()).length;
  await assert.rejects(
    runner.confirmStopped(task(session + ".other"), "t1-a1", "wrong path supplied"),
    (e: RunnerError) => e.code === "bad-input" && /durably bound/.test(e.message),
  );
  assert.equal((await runner.records()).length, before, "no confirmation appended");
  assert.equal((await runner.reconcile(task(session))).decision.action, "park", "the live hint on the bound session still parks");
});

test("P7 guard: nothing outside src/runner/ imports the attempt runner yet (primitives only)", () => {
  // Same discipline as the P4/P6 guards: the runner is a process-control
  // PRIMITIVE. The supervisor (P9) will be the first external consumer;
  // this alarm re-arms if anything else wires in early.
  let hits = "";
  try {
    hits = execFileSync("grep", ["-rn", "--include=*.ts", "-e", "runner/attempt", "src/"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8",
    });
  } catch (e) {
    const err = e as { status?: number };
    if (err.status !== 1) throw e;
  }
  const offenders = hits.split("\n").filter(Boolean).filter((line) => !line.startsWith("src/runner/"))
    // P16: the host entry (docs/18 §0.1) is the sanctioned consumer —
    // it opens the AttemptRunner and adapts it to the loop's RunnerPort.
    .filter((line) => !line.startsWith("src/host/supervise.ts:")); // W1-minor: ':' pins the EXACT file (a src/host/supervise.ts.bak sibling must still trip the alarm)
  assert.deepEqual(offenders, [], "the attempt runner's only external consumer is the P16 host entry (src/host/supervise.ts)");
});
