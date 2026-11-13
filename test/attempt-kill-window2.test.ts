/**
 * P7 kill-window tests — round 2 (Sol audit R1 "TESTS-MISSING").
 *
 * The kill-window suite (attempt-kill-window.test.ts) pins the crash
 * windows via the spawnBarrier seam with close(true) injected. Sol's R1
 * audit listed the unpinned corners around that seam; this file closes
 * them:
 *
 *  T-A  barrier-phase REJECTION without any close(): the intent-phase
 *       throw leaves exactly the unresolved intent durable (no failed
 *       resolve — the barrier sits OUTSIDE the C2-C spawner-throw catch)
 *       and leaves the runner USABLE; the forked-phase throw leaves a
 *       live tracked child behind an unresolved tuple — the fence holds,
 *       and stop() (the sanctioned cleanup) discharges it.
 *  T-B  barrier rejection AFTER close(true): the tracked child was
 *       unrefed (not killed — disclosed detach), the closure gate
 *       prevents the ok append, and a reopened runner over the same
 *       journal stays fenced on the intent.
 *  T-C  a SUSPENDED barrier with queued run()s: the F3 serialization
 *       (spawnActive counts queued+active) refuses ordinary close(),
 *       force-close releases the slot, the queued spawn aborts at its
 *       dequeue gate, and the suspended transaction aborts at its phase
 *       gate once released — one intent record, no ok, ever.
 *  T-D  the F6 exited-own-child probe verdict is EVIDENCE ONLY: an
 *       injected positive probe (the pid-reuse shape) and an
 *       inconclusive probe can neither flip the decision nor resurrect
 *       the waitpid-disproven claim, and probes[] stays pid-deduped.
 *  (+)  W1 whole-group disappearance is asserted in the base suite;
 *       W2's escalated:true is made deterministic here by a READY
 *       marker written strictly AFTER the TERM trap is installed.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttemptRunner, RunnerError, type AttemptRunnerOptions, type AttemptTask, type PidStatus, type WorkerSpawner } from "../src/runner/attempt.js";
import { DecisionJournal, type AttemptRecord } from "../src/episode/journal.js";

// ─────────────────────────── fixtures & helpers ─────────────────────────────

let root: string;
const runners: AttemptRunner[] = [];
const strays = new Set<number>(); // pids discovered by fixtures; swept in after()

const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** Register a forked handle's pid for the after() sweep AT DISCOVERY
 *  (Sol R1 F1 doctrine: before any assertion can fail). */
function track<H extends { pid?: number }>(h: H): H {
  if (h.pid !== undefined) strays.add(h.pid);
  return h;
}

/** REAL detached group-leader worker running a /bin/sh script. */
function shellSpawner(script: string): WorkerSpawner {
  return { kind: "test-shell", spawn: () => ({ command: "/bin/sh", args: ["-c", script], detached: true }) };
}

async function openRunner(episodeId: string, spawner: WorkerSpawner, opts: Partial<Pick<AttemptRunnerOptions, "stopTimeoutMs" | "spawnBarrier" | "probes">> = {}): Promise<AttemptRunner> {
  await mkdir(join(root, episodeId), { recursive: true });
  const r = await AttemptRunner.open({
    root,
    episodeId,
    spawner,
    commandCheck: (cmd) => cmd === "/bin/sh",
    stopTimeoutMs: 5000,
    ...opts,
  });
  runners.push(r);
  return r;
}

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

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

async function attemptRecords(episodeId: string): Promise<AttemptRecord[]> {
  const journal = await DecisionJournal.forEpisode(join(root, episodeId));
  const { records } = await journal.read();
  return records.filter((r): r is AttemptRecord => r.kind === "attempt" && r.episodeId === episodeId);
}

async function capture<T>(p: Promise<T>): Promise<{ rejected: boolean; value?: T; error?: RunnerError }> {
  try { return { rejected: false, value: await p }; } catch (e) { return { rejected: true, error: e as RunnerError }; }
}

async function waitFor(fn: () => Promise<boolean> | boolean, what: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await delay(25);
  }
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "tre-killwindow2-"));
  await mkdir(join(root, "sessions"), { recursive: true });
});

after(async () => {
  for (const r of runners) { try { r.close(true); } catch { /* best effort */ } }
  for (const pid of strays) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* group may be gone */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ }
  }
  await rm(root, { recursive: true, force: true });
});

// ────────────────────────────────── suite ───────────────────────────────────

describe("T-A: barrier-phase rejection WITHOUT close() — crash-injection stays a test-hook contract", () => {
  it("intent-phase throw: exactly the unresolved intent is durable (NO failed-resolve — the barrier is outside the C2-C catch) and the runner stays usable", async () => {
    const ep = "kw2-ta-intent";
    const boom = new Error("boom-intent");
    let fired = false;
    const runner = await openRunner(ep, shellSpawner("sleep 120"), {
      spawnBarrier: async ({ phase }) => {
        if (phase !== "intent" || fired) return;
        fired = true; // single-shot: the follow-up t2 spawn must pass through
        throw boom; // NO close(): the rejection alone must not touch the journal twice
      },
    });
    const task: AttemptTask = { episodeId: ep, taskId: "t1", session: join(root, "sessions", `${ep}.jsonl`) };

    const first = await capture(runner.run(task));
    assert.ok(fired, "the barrier fired at the intent phase");
    assert.ok(first.rejected && first.error === boom, `the barrier rejection surfaces verbatim (got ${JSON.stringify(first.error?.message)})`);

    const recs = await attemptRecords(ep);
    assert.equal(recs.length, 1, `only the intent is durable (got ${JSON.stringify(recs.map((r) => r.spawnOutcome))})`);
    assert.equal(recs[0]!.spawnOutcome, null, "the intent stays unresolved — the barrier throw is NOT routed through the C2-C spawner-throw failed-resolve");

    // Runner usability: the transaction aborted cleanly, so a plain
    // spawn on the same instance proceeds (the prior unresolved tuple
    // would fence a SAME-task run, so this pins usability on a fresh
    // task while the journal keeps its parked intent).
    const t2: AttemptTask = { episodeId: ep, taskId: "t2", session: join(root, "sessions", `${ep}-t2.jsonl`) };
    const h = track(await runner.run(t2));
    assert.equal(h.attemptId, "t2-a1", "the runner is usable after the aborted transaction");
    const stop = await runner.stop(h);
    assert.equal(stop.stopped, true);
  });

  it("forked-phase throw: a LIVE tracked child behind the unresolved tuple — the fence holds until stop() (the sanctioned cleanup) discharges it", async () => {
    const ep = "kw2-ta-forked";
    const pf = join(root, "sessions", `${ep}.pid`);
    const boom = new Error("boom-forked");
    let forkPid = -1;
    const runner = await openRunner(ep, shellSpawner(`echo $$ > ${pf}; sleep 120`), {
      spawnBarrier: async (info) => {
        if (info.phase !== "forked") return;
        forkPid = info.pid;
        if (forkPid > 0) strays.add(forkPid); // register AT DISCOVERY, pre-throw
        throw boom; // NO close(): child stays tracked in an OPEN runner
      },
    });
    const task: AttemptTask = { episodeId: ep, taskId: "t1", session: join(root, "sessions", `${ep}.jsonl`) };

    const first = await capture(runner.run(task));
    assert.ok(first.rejected && first.error === boom, `the barrier rejection surfaces verbatim (got ${JSON.stringify(first.error?.message)})`);

    // The child is REAL and still alive — the rejection killed nothing.
    const oracle = await waitForPidfile(pf, 2000);
    assert.ok(oracle !== undefined && oracle === forkPid, "the fork really happened (oracle == barrier pid)");
    await waitPid(forkPid, "alive");
    assert.ok(groupAlive(forkPid), "the WHOLE GROUP is still alive behind the throw — nothing disappeared on its own; only the test's stop() may end it (I1)");

    const recs = await attemptRecords(ep);
    assert.equal(recs.length, 1, `only the unresolved intent is durable (got ${JSON.stringify(recs.map((r) => r.spawnOutcome))})`);
    assert.equal(recs[0]!.spawnOutcome, null, "a forked-phase throw appends NO resolve of any kind");

    // The fence holds on the live OWN child: same-task run refuses with
    // the session-write-lock error (the children-map check fires before
    // the unresolved-intent branch — pinning the REAL refusal class).
    const t = await capture(runner.run(task));
    assert.ok(t.rejected && t.error?.code === "ownership-fence" && /being written by live attempt t1-a1/.test(t.error.message), `fence refuses onto the live child (got ${JSON.stringify(t.error?.code)}: ${t.error?.message})`);

    // Reconcile sees the live own child (not a probe verdict — waitpid class).
    const rec = await runner.reconcile(task);
    assert.equal(rec.decision.action, "park", "the live tracked child parks");
    assert.equal(rec.ownership.latest?.live, true, "own-child liveness (waitpid-class), not a probe");

    // stop() is the sanctioned cleanup: real group death, then the tuple
    // stays parked (unresolved intents are I2 evidence, not stop-discharged)
    // and the journal gained no ok.
    const stop = await runner.stop({ session: task.session });
    assert.equal(stop.stopped, true, "the barrier-orphan is stoppable through the normal path");
    await waitGroupGone(forkPid);
    const after = await attemptRecords(ep);
    assert.equal(after.filter((r) => r.spawnOutcome === "ok").length, 0, "no ok was EVER appended through the throw+stop path");
  });
});

describe("T-B: barrier rejection AFTER close(true) — detach semantics, no journal mutation, reopen stays fenced", () => {
  it("close(true) inside the barrier unrefs the tracked child (does NOT kill it); the closure gate drops the ok append; a reopened runner fences the intent", async () => {
    const ep = "kw2-tb";
    const pf = join(root, "sessions", `${ep}.pid`);
    const boom = new Error("boom-after-force-close");
    let forkPid = -1;
    const runner = await openRunner(ep, shellSpawner(`echo $$ > ${pf}; sleep 120`), {
      spawnBarrier: async (info) => {
        if (info.phase !== "forked") return;
        forkPid = info.pid;
        if (forkPid > 0) strays.add(forkPid); // register AT DISCOVERY, pre-crash
        runner.close(true); // force-close WHILE the child is tracked...
        await delay(0);    // ...then the transaction resumes and hits the gate
        throw boom;        // surfaces as the run() rejection verbatim
      },
    });
    const task: AttemptTask = { episodeId: ep, taskId: "t1", session: join(root, "sessions", `${ep}.jsonl`) };

    const first = await capture(runner.run(task));
    assert.ok(first.rejected && first.error === boom, `the barrier rejection surfaces verbatim (got ${JSON.stringify(first.error?.message)})`);

    // Detach semantics (the disclosed force-close policy): close(true)
    // UNREFS live children — it does NOT kill them. The worker survives —
    // the WHOLE GROUP (T-G: the group never disappears on its own; the
    // survivor is real process evidence a reopened runner must respect).
    const oracle = await waitForPidfile(pf, 2000);
    assert.ok(oracle !== undefined && oracle === forkPid, "the fork happened (oracle == barrier pid)");
    await waitPid(forkPid, "alive");
    assert.ok(groupAlive(forkPid), "the whole group survived the force-close (detach, not kill)");

    // A closed runner never mutates the journal: the pre-ok gate stopped
    // the transaction BEFORE the ok append.
    const recs = await attemptRecords(ep);
    assert.equal(recs.length, 1, `exactly one record — no ok after force-close (got ${JSON.stringify(recs.map((r) => r.spawnOutcome))})`);
    assert.equal(recs[0]!.spawnOutcome, null, "the sole record is the unresolved intent");

    // Reopen over the same journal: fenced on the intent, nothing to
    // probe (no identity), and nothing confirmable (I3).
    const runner2 = await openRunner(ep, shellSpawner("sleep 120"));
    const rec = await runner2.reconcile(task);
    assert.equal(rec.probes.length, 0, "no journalled identity => zero probes");
    assert.equal(rec.decision.action, "park", "the reopened runner fences the crashed intent");
    const t = await capture(runner2.run(task));
    assert.ok(t.rejected && t.error?.code === "prior-attempt-unresolved", `takeover refused (got ${JSON.stringify(t.error?.code)}: ${t.error?.message})`);
    const c = await capture(runner2.confirmStopped(task, "t1-a1", "attempted confirmation over the force-closed intent"));
    assert.ok(c.rejected && c.error?.code === "ownership-fence", `identity-less tuple is unconfirmable (got ${JSON.stringify(c.error?.code)}: ${c.error?.message})`);

    // Sweep the survivor the detach deliberately left alive.
    try { process.kill(-forkPid, "SIGKILL"); } catch { /* gone */ }
    await waitPid(forkPid, "dead");
  });
});

describe("T-C: suspended barrier — the F3 serialization holds queued spawns, ordinary close(), and force-close/reopen", () => {
  it("a barrier suspended past the fork holds the transaction: queued run() is queued-not-run, close() refuses, close(true)+reopen fences, and both transactions end with ONE intent and no ok", async () => {
    const ep = "kw2-tc";
    const pf = join(root, "sessions", `${ep}.pid`);
    let forkPid = -1;
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const runner = await openRunner(ep, shellSpawner(`echo $$ > ${pf}; sleep 120`), {
      spawnBarrier: async (info) => {
        if (info.phase !== "forked") return;
        forkPid = info.pid;
        if (forkPid > 0) strays.add(forkPid); // register AT DISCOVERY, pre-suspension
        await gate; // SUSPENDED inside the transaction — spawnActive stays held
      },
    });
    const task: AttemptTask = { episodeId: ep, taskId: "t1", session: join(root, "sessions", `${ep}.jsonl`) };

    const p1 = runner.run(task);
    await waitFor(() => forkPid > 0, "the transaction reaches the forked barrier");
    await waitPid(forkPid, "alive");

    // F3: the queued second spawn counts as in-flight; it must sit
    // BEHIND the suspended transaction, not race through the seam.
    let settled2 = false;
    const p2 = runner.run(task).then(
      () => { settled2 = true; },
      () => { settled2 = true; },
    );
    await delay(50);
    assert.equal(settled2, false, "the queued run() is serialized behind the suspended transaction (F3)");

    // Ordinary close() refuses while a transaction is in flight.
    let refused = false;
    try { runner.close(); } catch (e) { refused = (e as RunnerError).code === "ownership-fence"; }
    assert.ok(refused, "close() refuses while the spawn transaction is in flight");

    // Force-close releases the registry slot; the reopen fences the intent.
    runner.close(true);
    const runner2 = await openRunner(ep, shellSpawner("sleep 120"));
    const t = await capture(runner2.run(task));
    assert.ok(t.rejected && t.error?.code === "prior-attempt-unresolved", `reopened runner fences the intent mid-window (got ${JSON.stringify(t.error?.code)}: ${t.error?.message})`);

    // Release the suspended barrier: the OLD transaction resumes on a
    // closed runner and aborts at its pre-ok closure gate — never forking
    // a second worker, never appending ok. The queued p2 aborts at the
    // dequeue gate.
    release();
    const o1 = await capture(p1);
    await p2;
    assert.ok(settled2, "the queued transaction settled after the release");
    assert.ok(o1.rejected && o1.error?.code === "bad-input" && /closed/.test(o1.error.message), `the suspended transaction dies at the closure gate (got ${JSON.stringify(o1.error?.code)}: ${o1.error?.message})`);

    const recs = await attemptRecords(ep);
    assert.equal(recs.length, 1, `ONE intent through the whole window (got ${JSON.stringify(recs.map((r) => r.spawnOutcome))})`);
    assert.equal(recs[0]!.spawnOutcome, null, "no ok — the pre-ok gate held across close/reopen");

    // Sweep the survivor left behind the suspended window.
    try { process.kill(-forkPid, "SIGKILL"); } catch { /* gone */ }
    await waitPid(forkPid, "dead");
  });
});

describe("T-D: the F6 exited-own-child probe is EVIDENCE ONLY — it cannot flip the decision", () => {
  // The kill-window base suite pins the DEAD verdict with real pids.
  // This pins the two shapes it cannot: an injected POSITIVE verdict
  // (the pid-reuse hazard) and an INCONCLUSIVE one, both on the exited
  // own child — plus probe dedupe. The decision is waitpid-class and
  // must not move either way (the own pid is excluded from candidacy;
  // the F6 append is the audit trail only).
  async function runProbeShape(label: string, status: PidStatus | undefined) {
    const ep = `kw2-td-${label}`;
    const verdicts = new Map<number, Promise<PidStatus | undefined>>();
    const runner = await openRunner(ep, shellSpawner("sleep 120"), {
      stopTimeoutMs: 150,
      probes: { pidAlive: (pid) => verdicts.get(pid) ?? Promise.resolve(undefined) },
    });
    const task: AttemptTask = { episodeId: ep, taskId: "t1", session: join(root, "sessions", `${ep}.jsonl`) };

    const h = track(await runner.run(task));
    const pid = h.pid!;
    verdicts.set(pid, Promise.resolve(status)); // the injected verdict for OUR pid

    const stop = await runner.stop(h);
    assert.equal(stop.stopped, true, "real child + group death via the normal stop path");

    const rec = await runner.reconcile(task);
    const mine = rec.probes.filter((p) => p.pid === pid);
    // The F6 audit-trail entry exists only when the probe verdict is
    // DEFINED (an inconclusive probe appends nothing), and never twice:
    // the candidate loop excludes the exited own pid, so the F6 block is
    // the sole entry point for it and dedupe holds.
    const expectEntry = status !== undefined;
    assert.equal(mine.length, expectEntry ? 1 : 0, `${label}: probes[] for the exited own pid ${expectEntry ? "carries the single verdict" : "stays empty (inconclusive appends nothing)"}, got ${JSON.stringify(mine)}`);
    if (status !== undefined) {
      assert.deepEqual({ running: mine[0]!.running, sameUid: mine[0]!.sameUid }, status, `the injected verdict is recorded verbatim in the audit trail`);
    }
    assert.equal(rec.ownership.latest?.live, false, "waitpid-class: the own child exited — unchanged by the injected verdict");
    assert.equal(rec.decision.action, "spawn", `${label}: an injected ${status === undefined ? "inconclusive" : status.running ? "POSITIVE (pid-reuse)" : "negative"} verdict on the exited own child cannot resurrect the claim or flip the decision`);
    assert.equal(rec.decision.reasons.length, 0, `${label}: no park reasons fabricated by the injected verdict`);
  }

  it("injected POSITIVE verdict (pid-reuse shape): recorded as evidence, decision still spawn", () => runProbeShape("positive", { running: true, sameUid: true }));
  it("injected INCONCLUSIVE verdict: recorded (if defined), decision still spawn", () => runProbeShape("inconclusive", undefined));
  it("injected NEGATIVE verdict: the honest case, decision spawn", () => runProbeShape("negative", { running: false, sameUid: true }));
});

describe("(+) W2 trap-readiness: escalated:true with a READY marker written AFTER the trap is installed", () => {
  it("stop() escalation cannot be an artifact of TERM arriving before the trap exists", async () => {
    const ep = "kw2-w2-ready";
    const ready = join(root, "sessions", `${ep}.ready`);
    // The marker is written strictly AFTER the TERM trap is installed:
    // escalated:true can then only mean the TERM was ignored on purpose.
    // Raised from 150 to 600 after 1 full-suite load flake (5/5 isolation passed)
    // — window headroom; semantics unchanged.
    const runner = await openRunner(ep, shellSpawner(`trap '' TERM; : > ${ready}; while :; do sleep 0.2; done`), { stopTimeoutMs: 600 });
    const task: AttemptTask = { episodeId: ep, taskId: "t1", session: join(root, "sessions", `${ep}.jsonl`) };

    const h = track(await runner.run(task));
    await waitFor(async () => { try { await readFile(ready); return true; } catch { return false; } }, "worker announced trap-readiness");
    await waitPid(h.pid!, "alive");

    const stop = await runner.stop(h);
    assert.equal(stop.escalated, true, "TERM was delivered to a trap-ready worker and genuinely ignored -> SIGKILL sweep");
    assert.equal(stop.stopped, true);
    assert.equal(groupAlive(h.pid!), false, "group confirmed gone");
  });
});

async function waitGroupGone(pgid: number, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!groupAlive(pgid)) return;
    if (Date.now() > deadline) throw new Error(`group ${pgid} still alive after ${ms}ms`);
    await delay(25);
  }
}

async function waitForPidfile(path: string, ms: number): Promise<number | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const t = (await readFile(path, "utf8")).trim();
      if (t.length > 0) return Number(t);
    } catch { /* not yet */ }
    if (Date.now() > deadline) return undefined;
    await delay(25);
  }
}
