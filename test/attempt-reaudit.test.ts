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
  it("TERM-ignoring grandchild survives a SIGKILLed leader; stop() sweeps the real group and a retry is truthful", async () => {
    const episodeId = "ra-a2";
    const ses = join(root, "sessions", "a2.jsonl");
    const ready = join(root, "a2.ready");
    const grandpid = join(root, "a2.grand");
    await mkdir(join(root, "sessions"), { recursive: true });
    const runner = await openRunner(episodeId, shellSpawner(
      `sh -c 'trap "" TERM; echo $$ > ${grandpid}; : > ${ready}; while :; do sleep 1; done' & wait`));
    const task: AttemptTask = { episodeId, taskId: "t1", session: ses };
    const h = await runner.run(task);
    strays.add(h.pid!);
    await waitFor(async () => { try { await readFile(ready, "utf8"); return true; } catch { return false; } }, "grandchild ready");
    process.kill(h.pid!, "SIGKILL");
    await h.exited;
    assert.ok(groupAlive(h.pid!), "precondition: the real group still has a grandchild");

    const first = await runner.stop(h);
    assert.equal(first.attemptId, h.attemptId);
    assert.equal(first.stopped, true, "group swept and confirmed gone");
    assert.equal(first.groupStatus, "reaped");
    assert.equal(first.escalated, true, "TERM-ignoring survivor forces the SIGKILL sweep");
    assert.equal(groupAlive(h.pid!), false, "kill(-pgid,0) confirms the real group is gone");

    // Retry after the group is gone: honest, not a not-running dead end.
    const again = await runner.stop(h);
    assert.equal(again.groupStatus, "reaped");
    assert.equal(again.stopped, true);
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
