/**
 * Re-audit regressions (attempt lifecycle):
 *   A1  close(true) must not release the episode writer slot while an
 *       accepted journal append is still in flight.
 *   A2  stop() must still sweep a tracked process group after its
 *       direct child has exited (no `not-running` dead end).
 *   A3  a stale handle (earlier attempt on the same session) must not
 *       act on the successor attempt.
 * Real processes, real kill(2) truth; no injected verdicts.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttemptRunner, RunnerError, type AttemptRunnerOptions, type AttemptTask, type WorkerSpawner } from "../src/runner/attempt.js";
import { DecisionJournal, type AttemptRecord } from "../src/episode/journal.js";

let root: string;
const runners: AttemptRunner[] = [];
const strays = new Set<number>();
const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

function shellSpawner(script: string): WorkerSpawner {
  return { kind: "reaudit-shell", spawn: () => ({ command: "/bin/sh", args: ["-c", script], detached: true }) };
}

async function openRunner(episodeId: string, spawner: WorkerSpawner, opts: Partial<AttemptRunnerOptions> = {}): Promise<AttemptRunner> {
  await mkdir(join(root, episodeId), { recursive: true });
  const r = await AttemptRunner.open({ root, episodeId, spawner, commandCheck: (c) => c === "/bin/sh", stopTimeoutMs: 150, ...opts });
  runners.push(r);
  return r;
}

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

async function waitFor(fn: () => Promise<boolean>, what: string, ms = 6000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`never held: ${what}`);
    await delay(25);
  }
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "tre-reaudit-"));
});

after(async () => {
  for (const r of runners) { try { r.close(true); } catch { /* best effort */ } }
  for (const pid of strays) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  await rm(root, { recursive: true, force: true });
});

describe("A2: stop() sweeps the tracked group after the leader has exited", () => {
  it("leader SIGKILLed pre-stop: stop() VERIFIES only (never signals a leaderless pgid), reports the honest unknown, then confirms after the operator sweep and latches", async () => {
    const episodeId = "ra-a2";
    const ses = join(root, "sessions", "a2.jsonl");
    const ready = join(root, "a2.ready");
    await mkdir(join(root, "sessions"), { recursive: true });
    const runner = await openRunner(episodeId, shellSpawner(
      `sh -c 'trap "" TERM; : > ${ready}; while :; do sleep 1; done' & wait`));
    const task: AttemptTask = { episodeId, taskId: "t1", session: ses };
    const h = await runner.run(task);
    strays.add(h.pid!);
    await waitFor(async () => { try { await readFile(ready, "utf8"); return true; } catch { return false; } }, "grandchild ready");
    process.kill(h.pid!, "SIGKILL");
    await h.exited;
    assert.ok(groupAlive(h.pid!), "precondition: the real group still has a grandchild");

    // F1 (cycle-2): the leader is reaped, so this stop must NOT signal
    // the group number (it may one instant be recycled for strangers).
    // Spy on process.kill to prove ZERO signals leave this call.
    const origKill = process.kill.bind(process);
    const signals: string[] = [];
    (process as { kill: unknown }).kill = ((target: number, sig?: number | string) => {
      signals.push(`${String(target)}:${String(sig ?? "signal0")}`);
      return origKill(target as never, sig as never);
    }) as typeof process.kill;
    let first: Awaited<ReturnType<typeof runner.stop>>;
    try { first = await runner.stop(h); } finally { (process as { kill: unknown }).kill = origKill; }
    assert.equal(first.attemptId, h.attemptId);
    assert.equal(first.stopped, false, "a live group under a leaderless number is NOT ours to kill");
    assert.equal(first.groupStatus, "unknown", "ownership unprovable => unknown, never swept, never reaped-laundered");
    assert.equal(first.escalated, false, "no escalation happened — nothing was signalled");
    assert.deepEqual(signals.filter((s) => !s.endsWith(":0")), [], "only probe-0 touched the group — no signal was ever sent to a leaderless number");
    assert.ok(groupAlive(h.pid!), "the grandchild survived untouched");

    // Operator path (W4 doctrine): sweep the group with positive
    // evidence, then stop() PROVES death by probe and latches.
    try { process.kill(-h.pid!, "SIGKILL"); } catch { /* gone */ }
    for (let i = 0; groupAlive(h.pid!) && i < 60; i++) await delay(25);
    const second = await runner.stop(h);
    assert.equal(second.stopped, true, "kill(-pgid,0) -> ESRCH: confirmed gone");
    assert.equal(second.groupStatus, "reaped");

    // Latch: after confirmation the number is NEVER probed or signalled
    // again — a recycled pgid can never be reached by stop().
    const signals2: string[] = [];
    (process as { kill: unknown }).kill = ((target: number, sig?: number | string) => {
      signals2.push(`${String(target)}:${String(sig ?? "signal0")}`);
      return origKill(target as never, sig as never);
    }) as typeof process.kill;
    let third: Awaited<ReturnType<typeof runner.stop>>;
    try { third = await runner.stop(h); } finally { (process as { kill: unknown }).kill = origKill; }
    assert.equal(third.groupStatus, "reaped", "the latched verdict re-answers");
    assert.equal(third.stopped, true);
    assert.deepEqual(signals2, [], "post-latch stop performs NO kill(2) at all — the number is retired");
  });
});

describe("A3: a stale handle cannot act on a successor attempt", () => {
  it("stop()/waitForExit() with an old attemptId refuse; the current attempt is untouched; session-only stays explicit", async () => {
    const episodeId = "ra-a3";
    const ses = join(root, "sessions", "a3.jsonl");
    await mkdir(join(root, "sessions"), { recursive: true });
    const runner = await openRunner(episodeId, shellSpawner("sleep 120"));
    const task: AttemptTask = { episodeId, taskId: "t1", session: ses };

    const a1 = await runner.run(task);
    strays.add(a1.pid!);
    const s1 = await runner.stop(a1);
    assert.equal(s1.stopped, true);

    const a2 = await runner.run(task);
    strays.add(a2.pid!);
    assert.equal(a2.attemptId, "t1-a2");

    await assert.rejects(runner.stop({ session: ses, attemptId: a1.attemptId }), (e: RunnerError) => e.code === "not-running" && /successor/.test(e.message));
    await assert.rejects(runner.waitForExit({ session: ses, attemptId: a1.attemptId }), (e: RunnerError) => e.code === "not-running");

    // The successor is still alive: the stale handle did not signal it.
    await delay(100);
    assert.equal((await Promise.race([a2.exited.then(() => "exited"), delay(50).then(() => "alive")])), "alive");

    const s2 = await runner.stop(a2);
    assert.equal(s2.attemptId, "t1-a2");
    assert.equal(s2.stopped, true);
  });
});

describe("A1: close(true) keeps the writer slot until accepted journal writes drain", () => {
  it("a reopen joins the drain: the replacement never observes the journal before the in-flight append lands", async () => {
    const episodeId = "ra-a1";
    const orig = DecisionJournal.prototype.append;
    let entered!: () => void;
    let release!: () => void;
    const seen = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    let once = true;
    DecisionJournal.prototype.append = async function (record) {
      if (once && record.episodeId === episodeId) { once = false; entered(); await gate; }
      return orig.call(this, record);
    };
    try {
      const runner = await openRunner(episodeId, shellSpawner("sleep 120"));
      const task: AttemptTask = { episodeId, taskId: "t1", session: join(root, "sessions", "a1.jsonl") };
      const pending = runner.run(task).catch((e: RunnerError) => e);
      await seen;
      runner.close(true);

      let reopened = false;
      const replacementP = openRunner(episodeId, shellSpawner("sleep 120")).then((r) => { reopened = true; return r; });
      await delay(150);
      assert.equal(reopened, false, "reopen waits while the closed writer still has an accepted append in flight");

      release();
      const replacement = await replacementP;
      const landed = await replacement.records();
      assert.equal(landed.length, 1, "the accepted intent landed before the replacement's first read");
      assert.equal((landed[0] as AttemptRecord).spawnOutcome, null);
      const err = await pending;
      assert.ok(err instanceof RunnerError, "the old run is refused at the next closure gate");
    } finally {
      DecisionJournal.prototype.append = orig;
    }
  });
});

// ── cycle-3 review (findings 1 & 2): signalling authority is gated centrally.
// Deterministic: process.kill is replaced by a recorder for the whole test
// (restored in finally), so NO real process group can ever be signalled and
// the test proves exactly which kill(2) the runner would have sent.
type Verdict = "reaped" | "alive" | "unknown";
interface RigRunner {
  groupAlive(pgid: number): Verdict;
  signalGroup(e: unknown, sig: string): boolean;
  probeGroup(e: unknown): Verdict;
  stop(h: unknown): Promise<{ stopped: boolean; groupStatus: string; escalated: boolean }>;
}
async function withRecordedKill(body: (sent: string[]) => Promise<void>): Promise<void> {
  const realKill = process.kill.bind(process);
  const sent: string[] = [];
  (process as { kill: unknown }).kill = ((target: number, sig?: number | string) => {
    sent.push(`${String(target)}:${sig === undefined || sig === 0 || sig === "0" ? "probe0" : String(sig)}`);
    if (sig === undefined || sig === 0 || sig === "0") {
      // probe: answered by the injected verdict queue in the rig, never by the OS
      return true;
    }
    return true; // recorded, never delivered
  }) as typeof process.kill;
  try { await body(sent); } finally { (process as { kill: unknown }).kill = realKill; }
}
function rigEntry(): Record<string, unknown> & { settle: (v: unknown) => void } {
  let settle!: (v: unknown) => void;
  const exitPromise = new Promise((r) => { settle = r; });
  return { attemptId: "t-a1", pgid: 424242, exited: false, child: { pid: 424242 }, task: {}, exitPromise, settle };
}
function rigRunner(verdicts: Verdict[]): RigRunner {
  const r = Object.create(AttemptRunner.prototype) as RigRunner & Record<string, unknown>;
  (r as unknown as Record<string, unknown>).assertOpen = (): void => {};
  (r as unknown as Record<string, unknown>).stopTimeoutMs = 50;
  (r as unknown as Record<string, unknown>).resolveTarget = (): unknown => (r as unknown as Record<string, unknown>).__entry;
  r.groupAlive = (): Verdict => verdicts.shift() ?? "reaped";
  return r;
}

describe("F1 (cycle-3 review): group signalling authority is gated at the kill(2) site", () => {
  it("a sibling stop latches death; a concurrent stop still in flight sends no kill(2) and does not re-probe", async () => {
    await withRecordedKill(async (sent) => {
      const entry = rigEntry();
      const r = rigRunner(["reaped", "alive"]);
      (r as unknown as Record<string, unknown>).__entry = entry;
      assert.equal(r.probeGroup(entry), "reaped", "sibling observes ESRCH");
      assert.equal(entry.groupDeathConfirmed, true, "first ESRCH latches");
      assert.equal(r.signalGroup(entry, "SIGKILL"), false, "latched: signalGroup refuses");
      assert.equal(r.probeGroup(entry), "reaped", "latched: the stranger-'alive' answer is never consulted");
      assert.deepEqual(sent, [], "no kill(2) of any kind reached the number");
    });
  });

  it("stop() whose leader is reaped while its TERM window is open: a survivor probe is 'unknown' and no SIGKILL is sent", async () => {
    await withRecordedKill(async (sent) => {
      const entry = rigEntry();
      // TERM was sent while alive (recorded); the leader is then reaped; the group probes alive.
      const r = rigRunner(["alive", "alive", "alive"]);
      (r as unknown as Record<string, unknown>).__entry = entry;
      (r as unknown as Record<string, unknown>).terminate = async (e: Record<string, unknown>): Promise<boolean> => {
        // The REAL gate sends the TERM while the leader is unreaped: the
        // recorder sees it because signalGroup calls process.kill.
        if (!r.signalGroup(e, "SIGTERM")) throw new Error("TERM must be permitted while the leader is unreaped");
        e.exited = true; (e.settle as (v: unknown) => void)({ code: 0, signal: null }); // reaped in the window
        return false;
      };
      const res = await r.stop({ session: "s" });
      assert.equal(res.stopped, false);
      assert.equal(res.groupStatus, "unknown", "alive under a reaped leader is unprovable");
      assert.equal(res.escalated, false, "no escalation after the leader was reaped");
      assert.deepEqual(sent.filter((x) => x.endsWith(":SIGKILL")), [], "no SIGKILL to the historical number");
      assert.deepEqual(sent.filter((x) => x.endsWith(":SIGTERM")), ["-424242:SIGTERM"], "only the pre-reap TERM was ever sent");
    });
  });

  it("signalGroup refuses every signal once the leader is reaped or death is latched (the single authority gate)", async () => {
    await withRecordedKill(async (sent) => {
      const reaped = rigEntry(); reaped.exited = true;
      const latched = rigEntry(); latched.groupDeathConfirmed = true;
      const r = rigRunner([]);
      assert.equal(r.signalGroup(reaped, "SIGTERM"), false);
      assert.equal(r.signalGroup(reaped, "SIGKILL"), false);
      assert.equal(r.signalGroup(latched, "SIGKILL"), false);
      assert.deepEqual(sent, [], "the gate refused before any kill(2)");
    });
  });
});

// ── cycle-4 review (F1 hang, F3 concurrency): the integration path.
// These drive the REAL terminate()/exit race/probe logic of two concurrent
// stop() calls and a denied-KILL stop(); only process.kill and the probe
// verdicts are injected.
describe("F3/F1 (cycle-4 review): real stop() integration under concurrency and denied signals", () => {
  it("two CONCURRENT stop() calls on a live leader: one probe, a latch, no SIGKILL, both honest", async () => {
    await withRecordedKill(async (sent) => {
      const entry = rigEntry();
      // Scripted probe sequence: the first ESRCH latches; any later "alive"
      // (a stranger in a recycled group) must never be consulted.
      const script: Verdict[] = ["reaped", "alive", "alive"];
      let probes = 0;
      const r = rigRunner([]);
      r.groupAlive = (): Verdict => { probes++; return script.shift() ?? "alive"; };
      (r as unknown as Record<string, unknown>).__entry = entry;
      const a = r.stop({ session: "s" });
      const b = r.stop({ session: "s" });
      // The leader is reaped while BOTH stops are suspended in terminate().
      entry.exited = true;
      (entry.settle as (v: unknown) => void)({ code: 0, signal: null });
      const [ra, rb] = await Promise.all([a, b]);
      assert.equal(ra.stopped, true);
      assert.equal(rb.stopped, true, "the second stop sees the latch, not a stranger 'alive'");
      assert.equal(probes, 1, "exactly one group probe: the latch answered the other");
      assert.deepEqual(sent.filter((x) => x.endsWith(":SIGKILL")), [], "no SIGKILL under concurrency");
    });
  });

  it("a DENIED KILL (EPERM) on a leader that never exits still returns, bounded, as unknown", async () => {
    const realKill = process.kill.bind(process);
    const sent: string[] = [];
    (process as { kill: unknown }).kill = ((target: number, sig?: number | string) => {
      sent.push(`${String(target)}:${String(sig ?? 0)}`);
      if (sig === "SIGKILL") throw Object.assign(new Error("denied"), { code: "EPERM" });
      return true;
    }) as typeof process.kill;
    try {
      const entry = rigEntry();
      const r = rigRunner(["alive"]);
      (r as unknown as Record<string, unknown>).__entry = entry;
      (r as unknown as Record<string, unknown>).stopTimeoutMs = 10;
      const t0 = Date.now();
      // Independent deadline: a regressed stop() (bounded wait disabled)
      // would hang forever, and node:test's default timeout is infinite —
      // race against our own deadline so the failure is deterministic and
      // self-explanatory instead of a suite-wide stall.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("stop() exceeded the 4s bounded deadline — denied-KILL hang regression")), 4000);
      });
      let res: Awaited<ReturnType<typeof r.stop>>;
      try {
        res = await Promise.race([r.stop({ session: "s" }), deadline]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const took = Date.now() - t0;
      assert.equal(res.stopped, false);
      assert.equal(res.groupStatus, "unknown", "an un-killable, un-exited leader is unknown, not swept");
      assert.equal(res.escalated, true, "the escalation was attempted");
      assert.ok(took < 4000, `bounded by POST_KILL_EXIT_WAIT_MS, took ${took}ms`);
      assert.ok(sent.includes("-424242:SIGKILL"), "the KILL was attempted (and denied)");
    } finally {
      (process as { kill: unknown }).kill = realKill;
    }
  });
});
