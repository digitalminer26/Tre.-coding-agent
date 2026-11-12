/**
 * P7 kill-window tests — REAL SIGKILL / group-kill fixtures.
 *
 * The unit suite injects probe/exit evidence and fake pids: it pins the
 * decision matrix, but it never proves the journal-first recovery works
 * against processes that actually exist. These fixtures do: workers are
 * spawned as REAL detached group leaders by the runner's own spawn path,
 * killed for real with SIGKILL — the direct child and (separately) the
 * whole process group — and recovery is asserted against REAL pids and
 * REAL ps/kill(2) probes with no injected verdicts anywhere.
 *
 * The kills land in the windows of the attempt transaction:
 *   W2   fully running (SIGTERM-ignoring worker; runner stop() escalates
 *        to a REAL process-group SIGKILL and reports confirmed group death)
 *   W3   worker killed while the supervisor "restarts" (close + reopen:
 *        journal-first reconcile releases on the real ps truth)
 *   W4   group survivor (leader SIGKILLed, grandchild keeps writing the
 *        session; the fence parks on REAL group liveness until an
 *        external `kill -9 -PGID` sweep + confirmStopped)
 *   W0/W1 crash windows around the fork: the supervisor dies (force
 *        close) after the intent append — either BEFORE the fork (no
 *        process ever existed: W0) or AFTER it but before the "ok"
 *        resolve (a real pid never journalled: W1). Captured by racing a
 *        force-close against the spawn transaction, with the worker's own
 *        pidfile as the fork truth oracle.
 *   F17  hostile state.json cache row vs journal+ps truth (a REAL live
 *        decoy cannot launder ownership into a proven-dead cohort, and
 *        cannot be confirmed away while it lives).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttemptRunner, RunnerError, type AttemptRunnerOptions, type AttemptTask, type WorkerSpawner } from "../src/runner/attempt.js";
import { DecisionJournal, type AttemptRecord } from "../src/episode/journal.js";

// ─────────────────────────── fixtures & helpers ─────────────────────────────

let root: string;
const runners: AttemptRunner[] = [];
const strays = new Set<number>(); // pids discovered by fixtures; swept in after()

const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** REAL detached group-leader worker running a /bin/sh script. */
function shellSpawner(script: string): WorkerSpawner {
  return { kind: "test-shell", spawn: () => ({ command: "/bin/sh", args: ["-c", script], detached: true }) };
}

/** Open a runner over a fresh episode dir (fresh = zero in-memory state,
 *  i.e. exactly what a supervisor restart is to the journal). */
async function openRunner(episodeId: string, spawner: WorkerSpawner, stopTimeoutMs = 5000, spawnBarrier?: AttemptRunnerOptions["spawnBarrier"]): Promise<AttemptRunner> {
  await mkdir(join(root, episodeId), { recursive: true });
  const r = await AttemptRunner.open({
    root,
    episodeId,
    spawner,
    commandCheck: (cmd) => cmd === "/bin/sh",
    stopTimeoutMs,
    ...(spawnBarrier !== undefined ? { spawnBarrier } : {}),
  });
  runners.push(r);
  return r;
}

/** Scheduling-aware wait on a REAL pid (kill-reap latency is scheduling,
 *  not logic — this is a test sync primitive, not a probe substitute). */
async function waitPid(pid: number, want: "dead" | "alive", ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  const aliveNow = (p: number): boolean => {
    try { process.kill(p, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
  };
  for (;;) {
    if (aliveNow(pid) === (want === "alive")) return;
    if (Date.now() > deadline) throw new Error(`pid ${pid} still ${want === "dead" ? "alive" : "dead"} after ${ms}ms`);
    await delay(25);
  }
}

/** kill(-pgid,0) truth: are there REAL processes in the group? */
function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

async function waitGroupGone(pgid: number, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!groupAlive(pgid)) return;
    if (Date.now() > deadline) throw new Error(`group ${pgid} still alive after ${ms}ms`);
    await delay(25);
  }
}

/** Independent liveness truth on a pid via kill(2) — the SAME probe the
 *  runner's defaultPidProbe uses (success ⇒ ours & exists; EPERM ⇒
 *  exists under another uid; ESRCH ⇒ gone). NOT `ps`: exec'ing /bin/ps
 *  is blocked on sandboxed hosts, where it would answer EPERM for EVERY
 *  pid and turn the truth oracle into "everything is dead". */
function psAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Read the episode's attempt records back through the journal reader. */
async function attemptRecords(episodeId: string): Promise<AttemptRecord[]> {
  const journal = await DecisionJournal.forEpisode(join(root, episodeId));
  const { records } = await journal.read();
  return records.filter((r): r is AttemptRecord => r.kind === "attempt" && r.episodeId === episodeId);
}

/** Capture a run()'s rejection (or resolve) without tripping unhandled. */
async function capture(p: Promise<unknown>): Promise<{ rejected: boolean; error?: RunnerError }> {
  try { await p; return { rejected: false }; } catch (e) { return { rejected: true, error: e as RunnerError }; }
}

// ────────────────────────────────── suite ───────────────────────────────────

before(async () => {
  root = await mkdtemp(join(tmpdir(), "tre-killwindow-"));
  await mkdir(join(root, "sessions"), { recursive: true });
});

after(async () => {
  for (const r of runners) { try { r.close(true); } catch { /* best effort */ } }
  // Sweep every process a fixture discovered — tests must not leak.
  for (const pid of strays) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* group may be gone */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ }
  }
  await rm(root, { recursive: true, force: true });
});

describe("W2: real SIGTERM-ignoring worker — runner stop() escalates to a REAL group SIGKILL", () => {
  const episodeId = "kw-w2";

  it("stop() kills the group for real, reports confirmed group death with the real pids, and the fence releases without confirmStopped (journal-first: proven mode + real group death)", async () => {
    const ses = join(root, "sessions", "w2.jsonl");
    const runner = await openRunner(episodeId, shellSpawner(`trap '' TERM; while :; do sleep 0.2; done`), 150);
    const task: AttemptTask = { episodeId, taskId: "t1", session: ses };

    const h = await runner.run(task);
    assert.ok(h.pid !== undefined, "worker forked");
    assert.equal(h.detached, true, "detached group leader (G1)");
    await waitPid(h.pid, "alive");

    // The worker IGNORES SIGTERM — so `escalated:true` proves the
    // SIGKILL group sweep is what actually killed it.
    const stop = await runner.stop(h);
    assert.equal(stop.escalated, true, "TERM-ignoring worker forces the SIGKILL sweep");
    assert.equal(stop.stopped, true, "child + group confirmed gone (kill(-pgid,0) -> ESRCH)");
    assert.equal(stop.groupStatus, "reaped");
    assert.equal(stop.signal, "SIGKILL");
    assert.equal(psAlive(h.pid), false, "ps independently confirms the REAL pid is dead");
    assert.equal(groupAlive(h.pid), false, "kill(-pgid,0) confirms the REAL group is gone");

    // F6: the "ok" resolve journalled the REAL process identity.
    const recs = await attemptRecords(episodeId);
    const ok = recs.find((r) => r.spawnOutcome === "ok");
    assert.ok(ok, "the ok resolve is journalled");
    assert.equal(ok.pid, h.pid);
    assert.equal(ok.pgid, h.pid, "detached group leader: pgid === pid");
    assert.equal(ok.detached, true, "spawn mode journalled (A): proven mode, no survivor class");

    // Journal-first reconcile post-kill: the real group death
    // DISPROVES the claim — decision releases to "spawn". (`blocking`
    // is the advisory superset of not-failed tuples, so the contract
    // here is the decision + zero live claims, not an empty view.)
    const rec = await runner.reconcile(task);
    assert.equal(rec.decision.action, "spawn");
    assert.equal(rec.decision.reasons.length, 0, `nothing parks (got ${JSON.stringify(rec.decision.reasons)})`);
    assert.equal(rec.ownership.live.length, 0, "no live child claims the session");
    assert.equal(rec.ownership.latest?.live, false, "waitpid-class: our own child exited");

    // I1 is satisfied by REAL evidence, so the takeover proceeds WITHOUT
    // confirmStopped — the kill-window recovery path end to end.
    const h2 = await runner.run(task);
    assert.equal(h2.attemptId, "t1-a2", "takeover gets fresh attempt identity (counter advances)");
    assert.notEqual(h2.pid, h.pid);
    assert.notEqual(h2.pid, undefined);
    const stop2 = await runner.stop(h2);
    assert.equal(stop2.stopped, true);

    const after = await attemptRecords(episodeId);
    assert.ok(after.filter((r) => r.attemptId === "t1-a2").length >= 2, "the takeover journalled its own intent + resolve");
  });
});

describe("W3: worker SIGKILLed, supervisor restarts — journal-first reconcile releases on REAL ps truth", () => {
  it("a fresh runner over the same journal probes the real dead pid (journal-first), decides spawn, and re-spawns under a new attemptId", async () => {
    const episodeId = "kw-w3";
    const session = join(root, "sessions", "w3.jsonl");
    const spawner = shellSpawner("sleep 120");
    const runner = await openRunner(episodeId, spawner);
    const task: AttemptTask = { episodeId, taskId: "t1", session };

    const h = await runner.run(task);
    const pid = h.pid!;
    await waitPid(pid, "alive");

    // The kill window: supervisor never sees a clean stop.
    process.kill(pid, "SIGKILL");
    const exit = await h.exited;
    assert.equal(exit.signal, "SIGKILL");
    await waitPid(pid, "dead");
    assert.equal(groupAlive(pid), false, "no survivor: the group died with the leader");

    // Supervisor restart: close this instance, reopen over the SAME journal.
    runner.close();
    const runner2 = await openRunner(episodeId, spawner);

    const rec = await runner2.reconcile(task);
    // Journal-first: the reconcile probed the JOURNAL-recorded pid (real).
    assert.ok(rec.probes.some((p) => p.pid === pid && p.running === false),
      `reconcile probed the real journalled pid to dead (probes: ${JSON.stringify(rec.probes)})`);
    assert.equal(rec.decision.action, "spawn", "leader dead + group gone: the claim is disproven, no park");
    assert.equal(rec.ownership.latest?.live, undefined, "not a child of the RESTARTED supervisor (no waitpid-class claim)");

    // The fence admits the takeover with a fresh identity.
    const h2 = await runner2.run(task);
    assert.equal(h2.attemptId, "t1-a2");
    assert.notEqual(h2.pid, pid);
    strays.add(h2.pid!);
    const stop2 = await runner2.stop(h2);
    assert.equal(stop2.stopped, true);

    const recs = await attemptRecords(episodeId);
    assert.ok(recs.some((r) => r.attemptId === "t1-a1" && r.spawnOutcome === "ok" && r.pid === pid),
      "the dead attempt's identity survives the restart in the journal");
  });
});

describe("W4: REAL group survivor — leader SIGKILLed, grandchild keeps the session open", () => {
  it("the fence parks on REAL group liveness; an external kill -9 -PGID + confirmStopped releases it", async () => {
    const episodeId = "kw-w4";
    const session = join(root, "sessions", "w4.jsonl");
    // Worker: background grandchild in the SAME group appends to the
    // session forever; the leader just waits. kill(leader) leaves it.
    const survivorSpawner: WorkerSpawner = {
      kind: "test-w4",
      spawn: (_t, attemptId) => attemptId === "t1-a2"
        ? { command: "/bin/sh", args: ["-c", "sleep 120"], detached: true }
        : { command: "/bin/sh", args: ["-c", `sh -c 'while :; do echo x >> ${session}; sleep 0.2; done' & wait`], detached: true },
    };
    const runner = await openRunner(episodeId, survivorSpawner, 150);
    const task: AttemptTask = { episodeId, taskId: "t1", session };

    const h = await runner.run(task);
    const leader = h.pid!;
    await waitPid(leader, "alive");
    await waitFor(async () => (await fileLines(session)) > 0, "grandchild starts writing");

    // W4 kill: SIGKILL the LEADER only — the classic takeover hazard.
    process.kill(leader, "SIGKILL");
    const exit = await h.exited;
    assert.equal(exit.signal, "SIGKILL");
    await waitPid(leader, "dead");

    // The group is REALLY alive and the survivor is writing RIGHT NOW:
    const lines1 = await fileLines(session);
    await delay(500);
    const lines2 = await fileLines(session);
    assert.ok(lines2 > lines1, "session file still growing => a REAL survivor owns the path");
    assert.equal(groupAlive(leader), true, "kill(-pgid,0): the REAL group still has members");

    // A replacement attempt stays FENCED: leader exit is not group exit.
    const takeover = await capture(runner.run(task));
    assert.ok(takeover.rejected, "run() must refuse to spawn onto a live group");
    assert.equal(takeover.error?.code, "prior-attempt-running", takeover.error?.message);

    // Reconcile parks, citing the GROUP (the real liveness it probed).
    const rec = await runner.reconcile(task);
    assert.equal(rec.decision.action, "park");
    assert.ok(rec.decision.reasons.some((r) => r.includes("GROUP")), `reason cites the group (got ${rec.decision.reasons.join(" | ")})`);

    // Operator recovery: external `kill -9 -PGID`, then confirmStopped.
    try { process.kill(-leader, "SIGKILL"); } catch { /* already gone */ }
    await waitGroupGone(leader);
    const lines3 = await fileLines(session);
    await delay(500);
    assert.equal(await fileLines(session), lines3, "writes stopped => the sweep killed the REAL grandchild");

    const conf = await runner.confirmStopped(task, h.attemptId, `survivor group ${leader} swept by operator kill -9 -${leader}; kill(-pgid,0) now answers ESRCH and the session file stopped growing`);
    assert.equal(conf.confirmation, true, "the confirmation is journalled");
    assert.equal(conf.spawnOutcome, "failed", "confirmation resolves the tuple without claiming a spawn outcome");
    assert.equal(conf.pid, leader, "the confirmation carries the leader identity it proved gone");
    assert.equal(conf.pgid, leader, "and the group identity (copied from the tuple)");

    // The tuple is closed: reconcile releases, takeover spawns.
    const rec2 = await runner.reconcile(task);
    assert.equal(rec2.decision.action, "spawn");
    const h2 = await runner.run(task);
    assert.equal(h2.attemptId, "t1-a2");
    strays.add(h2.pid!);
    const stop2 = await runner.stop(h2);
    assert.equal(stop2.stopped, true);
  });
});

describe("W0/W1: the fork-then-crash windows — force-close inside the spawn transaction", () => {
  // The supervisor "crash" is a force close(true) landing INSIDE the
  // spawn transaction. Timing a close against a sub-millisecond await
  // chain with wall-clock timers is a coin flip (the ok append wins at
  // every delay >= ~3ms), so the crash is injected at the transaction's
  // own boundaries via the spawnBarrier seam: phase "intent" = the
  // window AFTER the intent is durable but BEFORE the fork (W0); phase
  // "forked" = the window AFTER the process is proven to exist but
  // BEFORE the "ok" resolve append (W1). The worker's own pidfile is
  // the fork-truth oracle independent of the runner: W0 must never
  // produce one, W1 must.
  const crashAt = (phase: "intent" | "forked", onCrash: (h: { pid?: number }) => void): AttemptRunnerOptions["spawnBarrier"] =>
    async (info) => {
      if (phase === "forked") { if (info.phase !== "forked") return; onCrash({ pid: info.pid }); }
      else { if (info.phase !== "intent") return; onCrash({}); }
      await delay(0); // let the close settle; the next closure gate is what aborts
    };

  it("W0: crash between the durable intent and the fork — no process ever existed, the intent parks with zero fabricated identity", async () => {
    const ep = "kw-w0";
    const pf = join(root, "sessions", `${ep}.pid`);
    let crashed = false;
    const runner = await openRunner(ep, shellSpawner(`echo $$ > ${pf}; sleep 120`), 5000, crashAt("intent", () => {
      crashed = true;
      // The supervisor dies here: intent durable, fork not attempted.
      try { runner.close(true); } catch { /* already closed */ }
    }));
    const task: AttemptTask = { episodeId: ep, taskId: "t1", session: join(root, "sessions", `${ep}.jsonl`) };
    const outcome = await capture(runner.run(task));
    assert.ok(crashed, "the barrier fired (the transaction really entered the window)");
    assert.ok(outcome.rejected && outcome.error?.code === "bad-input" && /closed/.test(outcome.error.message), `the next closure gate aborts the transaction (got ${JSON.stringify(outcome.error?.code)}: ${outcome.error?.message})`);

    const recs = await attemptRecords(ep);
    assert.equal(recs.length, 1, `only the intent survives the crash (got ${JSON.stringify(recs.map((r) => r.spawnOutcome))})`);
    assert.equal(recs[0]!.spawnOutcome, null, "the intent is unresolved — that is the park state");
    assert.equal(recs[0]!.pid, undefined, "no identity was ever journalled (the pid enters only with the ok resolve)");
    assert.equal(await waitForPidfile(pf, 300), undefined, "fork truth: NO process ever existed (the pidfile oracle never appeared)");

    // Restart: the journal is intent-only. Reconcile must fabricate
    // nothing and park (I2); the fence refuses the takeover citing the
    // intent; and the tuple cannot be confirmed away (I3).
    const runner2 = await openRunner(ep, shellSpawner("sleep 120"));
    const rec = await runner2.reconcile(task);
    assert.equal(rec.probes.length, 0, "no journalled identity => nothing real to probe (and nothing invented)");
    assert.equal(rec.decision.action, "park", "I2: an unresolved intent never re-spawns blindly");
    const t = await capture(runner2.run(task));
    assert.ok(t.rejected && t.error?.code === "prior-attempt-unresolved", `fence cites the intent (got ${JSON.stringify(t.error?.code)}: ${t.error?.message})`);
    const c = await capture(runner2.confirmStopped(task, "t1-a1", "attempted confirmation of the crashed intent"));
    assert.ok(c.rejected, "an intent with no identity has nothing to probe (I3: silence is not evidence)");
    assert.equal(c.error?.code, "ownership-fence", c.error?.message);
  });

  it("W1: crash after the fork but before the ok resolve — a REAL worker holds the session while the journal has NO identity: park, fabricate nothing, confirm nothing", async () => {
    const ep = "kw-w1";
    const pf = join(root, "sessions", `${ep}.pid`);
    let crashed = false;
    let forkPid = -1;
    const runner = await openRunner(ep, shellSpawner(`echo $$ > ${pf}; sleep 120`), 5000, crashAt("forked", (h) => {
      crashed = true;
      forkPid = h.pid ?? -1;
      // The supervisor dies with a REAL child alive and NO ok record.
      try { runner.close(true); } catch { /* already closed */ }
    }));
    const task: AttemptTask = { episodeId: ep, taskId: "t1", session: join(root, "sessions", `${ep}.jsonl`) };
    const outcome = await capture(runner.run(task));
    assert.ok(crashed, "the barrier fired past the fork");
    assert.ok(outcome.rejected && outcome.error?.code === "bad-input" && /closed/.test(outcome.error.message), `the pre-ok closure gate aborts the transaction (got ${JSON.stringify(outcome.error?.code)}: ${outcome.error?.message})`);

    const recs = await attemptRecords(ep);
    assert.equal(recs.length, 1, `only the intent survives the crash (got ${JSON.stringify(recs.map((r) => r.spawnOutcome))})`);
    assert.equal(recs[0]!.spawnOutcome, null, "the ok resolve never landed — the tuple is unresolved");
    assert.equal(recs[0]!.pid, undefined, "no identity was ever journalled (the pid enters only with the ok resolve)");

    // Fork truth, independent of the runner: a REAL process exists and
    // is still alive behind the unresolved intent.
    const oracle = await waitForPidfile(pf, 2000);
    assert.ok(oracle !== undefined, "the worker really forked (pidfile oracle)");
    assert.equal(oracle, forkPid, "the barrier saw the REAL child pid");
    strays.add(forkPid);
    await waitPid(forkPid, "alive");

    // Restart over the same journal: a REAL worker may hold the session,
    // but the journal journalled no pid, so reconcile has NOTHING real
    // to probe — it must fabricate nothing and park on the intent.
    const runner2 = await openRunner(ep, shellSpawner("sleep 120"));
    const rec = await runner2.reconcile(task);
    assert.equal(rec.probes.length, 0, "no journalled identity => nothing real to probe (and nothing invented)");
    assert.equal(rec.decision.action, "park", "I2: an unresolved intent never re-spawns blindly onto the live worker");

    // The fence refuses the takeover on the intent itself.
    const t = await capture(runner2.run(task));
    assert.ok(t.rejected && t.error?.code === "prior-attempt-unresolved", `fence cites the intent (got ${JSON.stringify(t.error?.code)}: ${t.error?.message})`);

    // And it cannot be confirmed away either: the never-journalled pid is
    // not an identity — confirmation over an identifier-less tuple is
    // evidence-free absence (I3).
    const c = await capture(runner2.confirmStopped(task, "t1-a1", "attempted confirmation of the crashed intent"));
    assert.ok(c.rejected, "an intent with no identity has nothing to probe (I3: silence is not evidence)");
    assert.equal(c.error?.code, "ownership-fence", c.error?.message);

    // Sweep the real survivor the window discovered.
    try { process.kill(-forkPid, "SIGKILL"); } catch { /* gone */ }
    await waitPid(forkPid, "dead");
  });
});

describe("F17: hostile state.json row vs journal + REAL ps truth", () => {
  it("a cache row naming a REAL live decoy cannot make a dead cohort live, cannot be confirmed past, and is never killed", async () => {
    const episodeId = "kw-f17";
    const session1 = join(root, "sessions", "f17-a.jsonl");
    const session2 = join(root, "sessions", "f17-b.jsonl");
    const runner = await openRunner(episodeId, shellSpawner("sleep 120"));
    const t1: AttemptTask = { episodeId, taskId: "t1", session: session1 };
    const t2: AttemptTask = { episodeId, taskId: "t2", session: session2 };

    const dead = await runner.run(t1);   // the cohort we will prove dead
    const decoy = await runner.run(t2);  // a REAL live process (different session)
    await waitPid(dead.pid!, "alive");
    await waitPid(decoy.pid!, "alive");

    const stop = await runner.stop(dead);
    assert.equal(stop.stopped, true, "cohort proven dead by real group death");

    // Hostile cache row: claims the LIVE decoy pid belongs to the dead cohort.
    const statePath = join(root, episodeId, "state.json");
    const st = JSON.parse(await readFile(statePath, "utf8"));
    st.tasks.t1 = { status: "running", pid: decoy.pid, attemptId: dead.attemptId, session: session1 };
    await writeFile(statePath, JSON.stringify(st));

    // Journal-first reconcile (F6): the journalled pid IS probed and
    // answered dead — but the row matching attemptId+session is
    // INDEPENDENT liveness evidence (R6-1/H1-M1 invariant): it could
    // describe a real child whose pid was never durably resolved, and
    // analyze/confirmStopped/the spawn fence must never disagree about
    // a live row. A hostile row is indistinguishable from that
    // legitimate case, so the fail-closed verdict is PARK — releasing
    // on "journal says dead" while confirmStopped still refuses the
    // same live row is exactly the H1-M1 divergence the audit pinned
    // shut. The row cannot resurrect the DEAD pid (the probe verdict
    // for it stays false); it parks on its own live evidence.
    const rec = await runner.reconcile(t1);
    assert.ok(rec.probes.some((p) => p.pid === dead.pid && p.running === false), "reconcile probed the journal pid (journal-first, F6)");
    assert.ok(rec.probes.some((p) => p.pid === decoy.pid && p.running === true), "and probed the matching hint row independently");
    assert.equal(rec.decision.action, "park", "a live candidate identity parks reconcile (I1: fail closed)");
    assert.ok(rec.decision.reasons.some((r) => r.includes(String(decoy.pid)) && r.includes("RUNNING")), `the park reason names the live row (got ${JSON.stringify(rec.decision.reasons)})`);

    // And confirmation may NOT sail past the same live identity either:
    // the decoy row is part of the candidate set, and it is running.
    const c = await capture(runner.confirmStopped(t1, dead.attemptId, "trying to confirm over a hostile hint row"));
    assert.ok(c.rejected, "a live candidate identity blocks confirmation");
    assert.match(c.error?.message ?? "", /RUNNING/, `refusal names the cause (got ${c.error?.message})`);
    assert.equal(psAlive(decoy.pid!), true, "the live decoy survived untouched — confirmStopped NEVER kills");

    // Remove the poison the supported way (stop the decoy's own cohort),
    // then the confirmation succeeds against real death.
    const stop2 = await runner.stop(decoy);
    assert.equal(stop2.stopped, true);
    await waitPid(decoy.pid!, "dead");
    const conf = await runner.confirmStopped(t1, dead.attemptId, `real ps truth: journalled pid ${dead.pid} ESRCH; the decoy hint pid ${decoy.pid} was stopped via its own cohort and now probes dead`);
    assert.equal(conf.confirmation, true);
    assert.equal(conf.pid, dead.pid, "the confirmation carries the REAL dead pid it proved gone");
  });
});

// ───────────────────────────── small test utils ─────────────────────────────

async function fileLines(path: string): Promise<number> {
  try { return (await readFile(path, "utf8")).split("\n").length; } catch { return 0; }
}

async function waitFor(fn: () => Promise<boolean>, what: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`condition never held: ${what}`);
    await delay(25);
  }
}

async function waitForPidfile(path: string, ms: number): Promise<number | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const t = parseInt((await readFile(path, "utf8")).trim(), 10);
      if (Number.isFinite(t)) return t;
    } catch { /* not yet */ }
    if (Date.now() > deadline) return undefined;
    await delay(20);
  }
}
