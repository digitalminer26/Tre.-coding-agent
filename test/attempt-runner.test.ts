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
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", ts: 1_000_000, pid: 999991 });
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
const killProbe = async (p: number): Promise<PidStatus> => {
  try { process.kill(p, 0); return { running: true, sameUid: true }; } catch { return { running: false, sameUid: true }; }
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
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", ts: 1, pid: 999991 });
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
  await seedAttemptRecord(dir, { attemptId: "t1-a1", sessionPath: session, spawnOutcome: "ok", spawnGen: 1, pid: 999991 });
  let spawnCount = 0;
  const countingSpawner = { kind: "c1-f4", spawn: () => { spawnCount += 1; return { command: "/bin/sleep", args: ["60"] }; } };
  // gate the dead-PID probe so the confirmation pauses INSIDE its check
  let releaseProbe!: () => void;
  const gate = new Promise<void>((res) => { releaseProbe = res; });
  const gatedProbe = async (p: number): Promise<PidStatus> => {
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
  // it) and no pgid: the hypothetical-group check decides. Use a REAL
  // process that shares its parent group: killing the leader leaves
  // the group alive (kill(pid,0) would say 'running', but the audit
  // case is leader-dead/group-uncertain) — so instead use a dead pid
  // whose ESRCH-group proves the only consistent group story: confirm
  // proceeds.
  await seedAttemptRecord(dir, { attemptId: "t1-a2", sessionPath: session, spawnOutcome: null, pid: 999996 });
  const rec = await runner.confirmStopped(task(session), "t1-a2", "pid 999996 ESRCH; kill(-999996,0) ESRCH too — no group survives");
  assert.equal(rec.spawnOutcome, "failed");
  assert.equal(rec.confirmation, true);
});

// C2-D (cycle-2 audit): a NON-detached child shares a FOREIGN group.
// Its exit disproves only the leader — stop() must report stopped:false
// (group death is not possessed), never the old stopped:true claim.
test("C2-D: non-detached stop() reports stopped:false — leader exit is not group death", async (t) => {
  const { root, session } = await fixture();
  const runner = await AttemptRunner.open({
    root, episodeId: "ep-p7",
    spawner: { kind: "non-detached", spawn: () => ({ command: "/bin/sleep", args: ["30"], detached: false }) },
    probes: { pidAlive: killProbe },
  });
  t.after(() => { runner.close(true); });
  const h = await runner.run(task(session));
  assert.equal(h.detached, false, "handle reports the actual spawn mode");
  const res = await runner.stop(h);
  assert.equal(res.stopped, false, "D: no private group exists to sweep — group death is NOT claimed");
  assert.equal(res.code, null, "ended by signal");
  // the ok resolve stamped the mode for the audit trail
  const recs = (await runner.records()).filter((r) => r.kind === "attempt" && r.spawnOutcome === "ok") as AttemptRecord[];
  assert.equal(recs[recs.length - 1]!.detached, false, "spawn mode journalled on the ok resolve");
});

// ───────────────────────────── boundary guard ───────────────────────────────


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
  const offenders = hits.split("\n").filter(Boolean).filter((line) => !line.startsWith("src/runner/"));
  assert.deepEqual(offenders, [], "the attempt runner must have no consumers outside src/runner/ until the supervisor (P9) lands");
});
