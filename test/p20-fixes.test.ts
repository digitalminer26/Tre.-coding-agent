/**
 * P20 — named regressions for the 3 findings of the re-audit of 58c588f.
 *
 * F1  (supervise.ts, major): the takeover-lock STEAL was an unfenced
 *     read-age→rm→mkdir. A recovery that froze between its age-read and
 *     its mkdir could rm a FRESH lock (its holder's recovery completed,
 *     released, and a new creator published), then mkdir its own and
 *     steal the takeover — reproduced as 2 activations + 2 disclosed
 *     takeovers of one lease + "claim replaced mid-swap". Fix: a lock
 *     carries an ownership STAMP (its token); a lock whose stamp names a
 *     LIVE pid is never torn down whatever its age; after mkdir the
 *     acquirer stamps, re-reads the stamp, and re-verifies the takeover
 *     premise (the lease is still EXACTLY the observed stale claim and
 *     still stale) before swapping; replaceLeaseUnderLock re-checks after
 *     the rename that the lease is still our claim. The lock is released
 *     on EVERY path (a refuse-throw no longer wedges recovery behind a
 *     stamp naming our own live pid).
 *
 * F2  (supervise.ts, major): the lease-pid extractor regex-scanned
 *     `"pid":<digits>` anywhere in the bytes — a TRUNCATED body like
 *     `{"pid":2147483647` (unparseable JSON) yielded a pid, bypassed the
 *     ambiguity guards, and was taken over immediately (reproduced: 245ms,
 *     not the abandon bound). Fix: a pid is trustworthy ONLY when the
 *     whole body parses as a JSON object with a positive safe-integer
 *     pid; anything else is AMBIGUOUS content — takeover-eligible only
 *     past the mtime abandon bound.
 *
 * F3  (supervise.ts, medium): the tmp sweep judged on AGE ONLY — a
 *     live-but-paused (SIGSTOP) publisher's staged tmp that aged past the
 *     bound was unlinked under it and the resumed publisher died at
 *     link() with ENOENT (reproduced). Fix: the sweep is PID-AWARE (a tmp
 *     naming a live pid is never touched; a provably-dead owner's tmp is
 *     garbage at any age; an uninterpretable pid is unknown and falls
 *     back to the age bound) AND a vanished stage is a RETRY (link ENOENT
 *     → relink once from a fresh stage), not a crash.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, writeFile, chmod, utimes, readdir, rm, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEpisodeLayout } from "../src/episode/journal.js";
import { runHostEpisode } from "../src/host/supervise.js";

const graphA = (episodeId: string, goal = "p20 goal") => ({
  schema: "tre-graph/1" as const,
  episodeId,
  goal,
  tasks: [{ id: "t1", persona: "worker", promptRef: "prompts/t1.md", dependsOn: [], acceptance: { criteria: [], requiredChecks: [], artifacts: [] } }],
  policy: { baseCommit: "abc", gate: { cmd: "true" } },
});

async function quickWorker(root: string): Promise<string> {
  const worker = join(root, "worker.sh");
  await writeFile(worker, "#!/bin/sh\nexit 0\n");
  await chmod(worker, 0o755);
  return worker;
}

const origLink = fs.promises.link.bind(fs.promises);
const origRename = fs.promises.rename.bind(fs.promises);
const origRm = fs.promises.rm.bind(fs.promises);
const origReadFile = fs.promises.readFile.bind(fs.promises);
const origUnlink = fs.promises.unlink.bind(fs.promises);
const origKill = process.kill.bind(process) as typeof process.kill;
function restoreFs(): void {
  const p = fs.promises as { link: unknown; rename: unknown; rm: unknown; readFile: unknown; unlink: unknown };
  p.link = origLink;
  p.rename = origRename;
  p.rm = origRm;
  p.readFile = origReadFile;
  // P20c7: the unlink patch (release-retry tests) leaked into later
  // tests without this — restore it.
  p.unlink = origUnlink;
  syncBuiltinESMExports();
}
const deferred = <T = void>() => {
  let resolve!: (v: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

// ─── F2: a pid is only trusted when the WHOLE body parses ───────────────────

test("P20-F2: a truncated body with pid digits is AMBIGUOUS — never taken over (no premature takeover)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20-f2-trunc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  restoreFs();
  const epGraph = graphA("ep-f2-trunc");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const malformed = `{"pid":${process.pid}`; // TRUNCATED JSON — the exact reproduced body
  await writeFile(leasePath, malformed); // fresh mtime: ambiguous, never proven-dead
  const worker = await quickWorker(root);
  const lines: string[] = [];
  const t0 = Date.now();
  await assert.rejects(
    () => runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: (l) => lines.push(l) }),
    /contended/,
    "an ambiguous fresh lease is never proven-dead — activation fails closed (the old regex extracted the pid and took over in ~245ms)",
  );
  assert.ok(!lines.some((l) => /taking over/.test(l)), "no takeover of a truncated body — whatever digits it contains");
  assert.equal(await readFile(leasePath, "utf8"), malformed, "the ambiguous lease is left EXACTLY as found");
});

test("P20-F2: a truncated body is a valid claim ONLY past the abandon bound (disclosed takeover)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20-f2-trunc-old-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  restoreFs();
  const epGraph = graphA("ep-f2-trunc-old");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  await writeFile(leasePath, `{"pid":${process.pid}`);
  const old = Date.now() / 1000 - 60; // past the 10s abandon bound
  await utimes(leasePath, old, old);
  const worker = await quickWorker(root);
  const lines: string[] = [];
  await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => /stale lease .* taking over/.test(l)), "aging past the bound licenses the takeover — disclosed");
  // The episode COMPLETES — its lease is released (unlinked) at the end,
  // so what must hold is: the lease was ours at swap (the takeover line
  // above), and any surviving claim is ours, never the truncated body.
  const after = await readFile(leasePath, "utf8").catch(() => "");
  if (after !== "") assert.equal(JSON.parse(after).pid, process.pid, "a surviving claim is OURS (complete JSON) — never the truncated body");
});

test("P20-F2: an out-of-range pid in otherwise-valid JSON is AMBIGUOUS, not a holder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20-f2-range-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  restoreFs();
  const epGraph = graphA("ep-f2-range");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  await writeFile(leasePath, '{"pid":99999999999999999999}'); // parses, but NOT a safe integer
  const worker = await quickWorker(root);
  await assert.rejects(
    () => runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }),
    /contended/,
    "an unrepresentable pid cannot prove a holder dead or alive — ambiguous, fail closed",
  );
});

test("P20-F2: a COMPLETE body with a dead pid is still taken over immediately (strict parse keeps real staleness fast)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20-f2-dead-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  restoreFs();
  const epGraph = graphA("ep-f2-dead");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  await writeFile(leasePath, JSON.stringify({ pid: 111, token: "dead-owner", episodeId: "ep-f2-dead", claimedAt: 1 }) + "\n");
  const worker = await quickWorker(root);
  const lines: string[] = [];
  const t0 = Date.now();
  await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => /stale lease .* taking over/.test(l)), "dead-holder takeover is disclosed");
  assert.ok(Date.now() - t0 < 10_000, "a TRUSTWORTHY dead-pid claim does not wait out the abandon bound — strict parsing is not blanket suspicion");
});

// ─── F1: the takeover-lock steal is fenced ──────────────────────────────────

test("P20-F1: a takeover paused past the steal bound does NOT lose its lock to a contender (stamp names a live holder)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20-f1-steal-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  const epGraph = graphA("ep-f1-steal");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const lockPath = join(dir, "host.lease.lock");
  // Stale claim: complete JSON, dead pid — recovery-eligible immediately.
  await writeFile(leasePath, JSON.stringify({ pid: 111, token: "dead-owner" }) + "\n");
  const worker = await quickWorker(root);

  // C: the first recovery takes the lock and freezes INSIDE the swap.
  // P20c6-F1 REPAIR: the swap is no longer a rename OVER the lease — it
  // moves the stale claim ASIDE (`leasePath.reclaim-*`) then links its
  // claim with no-replace. The freeze lands inside the move step, so C
  // holds the takeover lock the whole freeze window exactly as before.
  const parked = deferred();
  let resumed = false;
  let renames = 0;
  (fs.promises as { rename: unknown }).rename = async function (a: string | Uint8Array | null, b: string | Uint8Array | null) {
    if (String(b).startsWith(leasePath + ".reclaim-") && ++renames === 1) {
      await parked.promise; // freeze INSIDE the swap — the lock is held the whole time
      return origRename(a as string, b as string);
    }
    return origRename(a as string, b as string);
  };
  syncBuiltinESMExports();

  const cRun = runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "C", workerCommand: worker, maxIterations: 1, log: () => {} });
  // Wait until C is parked: it has acquired the lock (stamp written) and
  // reached the rename interception inside replaceLeaseUnderLock.
  let lockSeen = false;
  for (let i = 0; i < 400 && !lockSeen; i++) {
    try { await stat(lockPath); lockSeen = true; } catch { await new Promise((r) => setTimeout(r, 10)); }
  }
  assert.ok(lockSeen, "the first recovery acquired the takeover lock");
  // A contender: age C's lock PAST the 30s steal bound while C is frozen.
  const aged = new Date(Date.now() - 31_000);
  await utimes(lockPath, aged, aged);
  const dRun = runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "D", workerCommand: worker, maxIterations: 1, log: () => {} });
  const dResult = await dRun.then((r) => ({ status: "fulfilled" as const, stop: r.result.stopped }), (e: Error) => ({ status: "rejected" as const, message: e.message }));
  // D must have backed off WITHOUT tearing C's lock down: the stamp names
  // C's (live) pid, so even past the age bound the lock is not reclaimable.
  assert.deepEqual(dResult.status, "rejected", "the contender fails closed instead of stealing the takeover");
  assert.match((dResult as { message: string }).message, /contended/, "the contender timed out waiting — never took the lock");
  const stampNow = await readFile(join(lockPath, "owner"), "utf8");
  assert.equal(stampNow.split(".")[0], String(process.pid), "C's stamp survived the steal window — the lock was never removed and re-created");
  parked.resolve();
  const cResult = await cRun;
  resumed = true;
  assert.ok(["accepted-finish", "max-iterations"].includes(cResult.result.stopped), `exactly ONE takeover completed (${cResult.result.stopped}) — the reproduced 2-activations/2-takeovers outcome cannot recur`);
  assert.equal(renames >= 1, true);
  void resumed;
});

test("P20-F1: a stale lock stamped with a LIVE pid is never torn down, whatever its age", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20-f1-live-stamp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  restoreFs();
  const epGraph = graphA("ep-f1-live-stamp");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const lockPath = join(dir, "host.lease.lock");
  await writeFile(leasePath, JSON.stringify({ pid: 111, token: "dead-owner" }) + "\n");
  // A lock past the steal bound whose stamp names a LIVE pid (this test
  // process): the unfenced code would rm -rf it on the first attempt.
  await mkdir(lockPath);
  await writeFile(join(lockPath, "owner"), `${process.pid}.live-holder`);
  const aged = new Date(Date.now() - 31_000);
  await utimes(lockPath, aged, aged);
  const worker = await quickWorker(root);
  await assert.rejects(
    () => runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }),
    /contended/,
    "a live holder's lock is waited out, never stolen — recovery fails closed at the attempt budget",
  );
  const names = await readdir(dir);
  assert.ok(names.includes("host.lease.lock"), "the live holder's lock survived untouched");
  assert.equal(await readFile(leasePath, "utf8"), JSON.stringify({ pid: 111, token: "dead-owner" }) + "\n", "the stale claim was not touched behind the live lock");
});

test("P20-F1: an abandoned lock with NO stamp (legacy format) is still reclaimed past the bound — recovery proceeds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20-f1-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  restoreFs();
  const epGraph = graphA("ep-f1-legacy");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const lockPath = join(dir, "host.lease.lock");
  await writeFile(leasePath, JSON.stringify({ pid: 111, token: "dead-owner" }) + "\n");
  await mkdir(lockPath); // no owner stamp: a crash from the pre-P20 protocol
  const aged = new Date(Date.now() - 31_000);
  await utimes(lockPath, aged, aged);
  const worker = await quickWorker(root);
  const lines: string[] = [];
  await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => /takeover lock abandoned .* reclaimed/.test(l), "the legacy lock was reclaimed (disclosed)"));
  assert.ok(lines.some((l) => /stale lease .* taking over/.test(l)), "recovery completed behind the reclaimed lock");
  const after = await readFile(leasePath, "utf8").catch(() => "");
  if (after !== "") assert.equal(JSON.parse(after).pid, process.pid, "a surviving claim is OURS (the release at completion may already have removed it)");
});

test("P20-F1: a claim replaced under us MID-SWAP makes the taker walk away (identity check after rename)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20-f1-midswap-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  const epGraph = graphA("ep-f1-midswap");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  await writeFile(leasePath, JSON.stringify({ pid: 111, token: "dead-owner" }) + "\n");
  const worker = await quickWorker(root);
  // Simulate a lock-thief winning mid-swap. P20c6-F1 REPAIR: the swap
  // no longer renames OVER the lease — it moves the stale claim aside
  // then no-replace link()s its own. The thief strikes in that window:
  // after our move-aside (lease absent) it re-presents a foreign claim,
  // so our link must fail EEXIST and the taker walks away.
  const foreign = join(dir, "thief-claim");
  await writeFile(foreign, JSON.stringify({ pid: 112, token: "thief" }) + "\n");
  let did = false;
  (fs.promises as { rename: unknown }).rename = async function (a: string | Uint8Array | null, b: string | Uint8Array | null) {
    const r = await origRename(a as string, b as string);
    if (!did && String(b).startsWith(leasePath + ".reclaim-")) {
      did = true;
      await origRename(foreign, leasePath); // the thief re-presents before our link lands
    }
    return r;
  };
  syncBuiltinESMExports();
  await assert.rejects(
    () => runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }),
    /replaced mid-swap/,
    "the taker detects the re-presented lease (no-replace link EEXIST) and refuses to proceed believing it holds the episode",
  );
  assert.equal(JSON.parse(await readFile(leasePath, "utf8")).token, "thief", "the run walked away; the foreign claim stands untouched (the loser does not fight back)");
});

test("P20-F1: a refuse-throw UNDER the takeover lock releases the lock (no self-wedge for the next recovery)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20-f1-release-"));
  t.after(() => { restoreFs(); process.kill = origKill; return rm(root, { recursive: true, force: true }); });
  const epGraph = graphA("ep-f1-release");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const lockPath = join(dir, "host.lease.lock");
  const stale = JSON.stringify({ pid: 111, token: "dead-owner" }) + "\n";
  await writeFile(leasePath, stale);
  const worker = await quickWorker(root);
  // REPAIRED after the cycle-4 audit: the old injection flipped the lease
  // BYTES, but the fence requires cur0.raw === raw — a byte flip makes the
  // fence take the normal retry branch, so the claimed throw never
  // executed. The fence re-reads the SAME bytes and then judges liveness:
  // flip process.kill so pid 111 is alive ONLY for the fence's check (the
  // 2nd liveness call for that pid; the loop-top observation is the 1st).
  // refuseLive now throws while the lock is held — the exact path the
  // pre-P20 code leaked the stamped lock on.
  let killCalls = 0;
  (process as { kill: unknown }).kill = function (pid: number, sig?: string | number) {
    if (pid === 111 && sig === 0 && ++killCalls === 2) return true; // fence sees it LIVE
    return (origKill as (p: number, s?: string | number) => boolean)(pid, sig);
  } as typeof process.kill;
  await assert.rejects(
    () => runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }),
    /already activated by pid 111/,
    "the under-lock fence re-check met a LIVE holder and refused (a genuine throw under the lock)",
  );
  assert.ok(killCalls >= 2, "both liveness checks happened (loop-top dead, fence live)");
  let lockStillThere = true;
  try { await stat(lockPath); } catch { lockStillThere = false; }
  assert.equal(lockStillThere, false, "the takeover lock was RELEASED by the refusing path (the pre-P20 code left it stamped to our own live pid — a self-wedge)");
  assert.equal(await origReadFile(leasePath, "utf8"), stale, "the refusing recovery left the observed lease untouched");
});

// ─── F3: the pid-aware sweep + stage-retry ──────────────────────────────────

test("P20-F3: the tmp sweep is pid-aware — dead owner gone at any age, LIVE owner never touched, unknown judged by age", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20-f3-sweep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  restoreFs();
  const epGraph = graphA("ep-f3-sweep");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const old = Date.now() / 1000 - 60;
  const fresh = Date.now() / 1000;
  const cases: Array<[string, boolean]> = [
    ["host.lease.tmp-111.dead-fresh", true],   // dead owner, fresh — swept at ANY age
    ["host.lease.tmp-1.live-old", false],       // pid 1 is alive — never touched, whatever its age (the reproduced unlink)
    ["host.lease.tmp-99999999999999999999.unknown-old", true],  // uninterpretable pid + aged — age bound rules
    ["host.lease.tmp-99999999999999999998.unknown-fresh", false], // uninterpretable + fresh — unknown is not dead
  ] as const;
  for (const [n] of cases) {
    await writeFile(join(dir, n), "{ staged");
    const age = n.includes("-old") ? old : fresh;
    await utimes(join(dir, n), age, age);
  }
  const worker = await quickWorker(root);
  await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} });
  const names = new Set(await readdir(dir));
  for (const [n, swept] of cases) {
    assert.equal(names.has(n), !swept, `${n} ${swept ? "was reclaimed" : "survived"} per the pid-aware rules`);
  }
});

test("P20-F3: a staged tmp removed mid-publish (by anything) is RETRIED, not a crash — the lease still gets published", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20-f3-retry-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  const epGraph = graphA("ep-f3-retry");
  await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(root, epGraph.episodeId, "host.lease");
  const worker = await quickWorker(root);
  // The sweeper (or a thief) unlinks our stage between write and link:
  // the resumed publisher must relink from a FRESH stage, not die ENOENT.
  let n = 0;
  const sawRetry = deferred<boolean>();
  (fs.promises as { link: unknown }).link = async function (a: string | Uint8Array | null, b: string | Uint8Array | null) {
    if (String(b) === leasePath && ++n === 1) {
      await fs.promises.unlink(String(a)).catch(() => {}); // yank the stage
      const e: NodeJS.ErrnoException = new Error("simulated sweeper unlink");
      e.code = "ENOENT";
      sawRetry.resolve(String(a).includes(".tmp-"));
      throw e;
    }
    return origLink(a as string, b as string);
  } as typeof fs.promises.link;
  syncBuiltinESMExports();
  const r = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} });
  assert.equal(await sawRetry.promise, true, "the yanked path was a staged tmp link");
  assert.ok(n >= 2, "the publisher retried instead of crashing at ENOENT");
  assert.ok(["accepted-finish", "max-iterations"].includes(r.result.stopped), "the run completed normally on the retried lease");
});

// ─── Cycle 3 (audit of 5ab10ea): named regressions for findings 1-4 ────────

const origRmC3 = fs.promises.rm.bind(fs.promises);
const origReadC3 = fs.promises.readFile.bind(fs.promises);

test("P20c3-F1: delayed lock-reclaim does NOT double-admit — the swap winner whose lock was reclaimed under it walks away", async (t) => {
  // Mirrors the auditor's race repro EXACTLY: A freezes inside its steal-rm;
  // B steals (sees the aged foreign lock, no stamp), takes the lock, and
  // freezes inside its swap-rename; A resumes — rm'ing B's fresh lock,
  // mkdir-ing its own — and completes its takeover; B's rename then lands.
  // Pre-P20c3 BOTH passed every lease check and both ran (2 renames, 2
  // admissions). The fix: after the swap each contender checks its OWN
  // lock still carries its stamp — the one whose lock was reclaimed under
  // it refuses to proceed. At most ONE admission may complete.
  const root = await mkdtemp(join(tmpdir(), "p20c3-f1-race-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c3-f1");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const lockPath = join(dir, "host.lease.lock");
  await writeFile(leasePath, JSON.stringify({ pid: 2147483647, token: "dead" }));
  await mkdir(lockPath);
  await utimes(lockPath, 1, 1); // aged past every bound
  const worker = await quickWorker(root);

  const rmPaused = deferred(); let allowRm = false;
  let rmCount = 0;
  (fs.promises as { rm: unknown }).rm = async function (p: string | URL, opts?: unknown) {
    if (String(p) === lockPath && ++rmCount === 1) {
      rmPaused.resolve();
      while (!allowRm) await new Promise((r) => setTimeout(r, 5));
    }
    return (origRmC3 as (p: string | URL, o?: unknown) => Promise<void>)(p, opts);
  } as typeof fs.promises.rm;
  const renamePaused = deferred(); let allowRename = false;
  let renameCount = 0;
  // P20c6-F1 REPAIR: the swap's first step is now the MOVE-ASIDE of the
  // stale claim (`leasePath` -> `leasePath.reclaim-*`), not a rename
  // OVER the lease — freeze there to hold B inside its swap.
  (fs.promises as { rename: unknown }).rename = async function (a: string | URL, b: string | URL) {
    if (String(b).startsWith(leasePath + ".reclaim-") && ++renameCount === 1) {
      renamePaused.resolve();
      while (!allowRename) await new Promise((r) => setTimeout(r, 5));
    }
    return (origRename as (a: string | URL, b: string | URL) => Promise<void>)(a, b);
  } as typeof fs.promises.rename;
  syncBuiltinESMExports();

  const aRun = runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "A", workerCommand: worker, maxIterations: 1, log: () => {} });
  await rmPaused.promise;                       // A frozen at its steal-rm
  const bRun = runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "B", workerCommand: worker, maxIterations: 1, log: () => {} });
  await renamePaused.promise;                   // B frozen inside its swap
  allowRm = true;                               // A resumes: tears B's lock, takes over
  for (let i = 0; i < 400; i++) {               // wait for A's claim to land
    const cur = await origReadC3(leasePath, "utf8").catch(() => "");
    if (cur.includes("claimedAt")) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  allowRename = true;                           // B's delayed rename lands on top
  const results = await Promise.allSettled([aRun, bRun]);
  const admissions = results.filter((r) => r.status === "fulfilled").length;
  assert.ok(admissions <= 1, `at most ONE takeover admission completes (observed ${admissions} — the reproduced double-admission)`);
  assert.equal(renameCount, 2, "both contenders did swap — the fence must catch the second, not be bypassed by timing");
  const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (loser !== undefined) assert.match(String(loser.reason), /mid-swap|P20c3-F1/, "the loser walks away with the named fence error");
});

test("P20c3-F2: a transient stamp READ error after a won exclusive stamp-write does NOT wedge the lock — ownership stands", async (t) => {
  // Auditor's stamp-error repro: one injected EIO on the first owner-stamp
  // read. Pre-P20c3 the acquirer discarded a PROVABLY-won lock (its wx
  // create had succeeded), left the stamped lock on disk naming its own
  // live pid — un-stealable — and every later activation wedged. Post-fix:
  // a read error cannot disprove the exclusive create; the takeover
  // completes and the lock is released.
  const root = await mkdtemp(join(tmpdir(), "p20c3-f2-stamp-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c3-f2");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const stampPath = join(dir, "host.lease.lock", "owner");
  await writeFile(leasePath, JSON.stringify({ pid: 2147483647, token: "dead" }));
  const worker = await quickWorker(root);
  let injected = false;
  (fs.promises as { readFile: unknown }).readFile = async function (p: string | URL, ...args: unknown[]) {
    if (String(p) === stampPath && !injected) {
      injected = true;
      throw Object.assign(new Error("transient stamp read I/O error"), { code: "EIO" });
    }
    return (origReadC3 as (p: string | URL, ...a: unknown[]) => Promise<unknown>)(p, ...args);
  } as typeof fs.promises.readFile;
  syncBuiltinESMExports();
  const results: string[] = [];
  for (let i = 0; i < 2; i++) {
    results.push(await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: `probe${i}`, workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => "completed", (e: Error) => e.message));
  }
  restoreFs();
  assert.equal(injected, true, "the EIO injection actually fired at the stamp verification read");
  assert.deepEqual(results, ["completed", "completed"], `a transient stamp-read error wedges nothing — both activations run (observed ${JSON.stringify(results)})`);
  assert.equal(await origReadC3(stampPath, "utf8").then(() => "exists", () => "gone"), "gone", "no lock survives the completed runs (released stamp-conditionally)");
  void leasePath;
});

test("P20c3-F3: release requires the TOP-LEVEL token to match — an EMBEDDED occurrence never releases a foreign lease", async (t) => {
  // Auditor's release-embed repro: between our claim and our release, a
  // foreign writer replaces the lease with {pid:1, token:'foreign',
  // previous:{token: <ours>}}. Pre-P20c3 raw.includes(token) matched the
  // NESTED occurrence and unlinked a lease that was never ours. Post-fix:
  // the body must parse with token === ours AT TOP LEVEL.
  const root = await mkdtemp(join(tmpdir(), "p20c3-f3-embed-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c3-f3");
  await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(root, epGraph.episodeId, "host.lease");
  const worker = await quickWorker(root);
  let planted = false;
  let plantedBody = "";
  (fs.promises as { readFile: unknown }).readFile = async function (p: string | URL, ...args: unknown[]) {
    if (String(p) === leasePath && !planted) {
      const raw = await origReadC3(leasePath, "utf8") as string;
      const ours = (JSON.parse(raw) as { token: string }).token;
      plantedBody = JSON.stringify({ pid: 1, token: "foreign", previous: { token: ours } });
      await fs.promises.writeFile(leasePath, plantedBody);
      planted = true;
      return plantedBody;
    }
    return (origReadC3 as (p: string | URL, ...a: unknown[]) => Promise<unknown>)(p, ...args);
  } as typeof fs.promises.readFile;
  syncBuiltinESMExports();
  await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} });
  restoreFs();
  assert.equal(planted, true, "the foreign lease was planted at our own release-read");
  const survivor = await readFile(leasePath, "utf8").catch(() => "");
  assert.equal(survivor, plantedBody, "the foreign lease SURVIVES our release despite the embedded token (reproduced violation)");
});

// ─── Cycle 4 (audit of 2e63d2c): named regressions for findings 1-3 ────────

test("P20c4-F1: a failed post-swap admission self-releases — no abandoned live-pid lease, episode stays recoverable", async (t) => {
  // The auditor's walkaway-wedge, EXACT schedule: A freezes inside its
  // steal-rm; B steals and freezes inside its swap-rename; A resumes
  // (tears B's lock, completes its takeover); B's delayed rename lands
  // and B's post-swap check sees its lock stamp gone. Pre-P20c4 B threw
  // and WALKED AWAY with its own just-renamed claim on disk naming B's
  // LIVE pid, never marked held — every later activation in this process
  // refused "already activated in this process" until exit (reproduced).
  // Post-P20c4: B self-releases (strictly its own claim), the throw
  // leaves no live-pid lease, and a subsequent activation completes.
  const root = await mkdtemp(join(tmpdir(), "p20c4-f1-wedge-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c4-f1");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const lockPath = join(dir, "host.lease.lock");
  await writeFile(leasePath, JSON.stringify({ pid: 2147483647, token: "dead" }));
  await mkdir(lockPath);
  await utimes(lockPath, 1, 1);
  const worker = await quickWorker(root);
  const rmPaused = deferred(); let allowRm = false; let rmCount = 0;
  (fs.promises as { rm: unknown }).rm = async function (p: string | URL, o?: unknown) {
    if (String(p) === lockPath && ++rmCount === 1) { rmPaused.resolve(); while (!allowRm) await new Promise((r) => setTimeout(r, 5)); }
    return (origRmC3 as (p: string | URL, o?: unknown) => Promise<void>)(p, o);
  } as typeof fs.promises.rm;
  const renPaused = deferred(); let allowRen = false; let renCount = 0;
  // P20c6-F1 REPAIR: freeze B inside its swap at the MOVE-ASIDE step
  // (lease -> lease.reclaim-*), the first rename the new swap performs.
  (fs.promises as { rename: unknown }).rename = async function (a: string | URL, b: string | URL) {
    if (String(b).startsWith(leasePath + ".reclaim-") && ++renCount === 1) { renPaused.resolve(); while (!allowRen) await new Promise((r) => setTimeout(r, 5)); }
    return (origRename as (a: string | URL, b: string | URL) => Promise<void>)(a, b);
  } as typeof fs.promises.rename;
  syncBuiltinESMExports();
  const run = (who: string) => runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: who, workerCommand: worker, maxIterations: 1, log: () => {} });
  const settle = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => `ERR: ${e.message}`); // attached AT CREATION — attaching late races an unhandled rejection (node test runner)
  const aRun = settle(run("A"));
  await rmPaused.promise;
  const bRun = settle(run("B"));
  await renPaused.promise;
  allowRm = true;   // A resumes: steals B's lock, completes its takeover
  for (let i = 0; i < 400; i++) { // let A's takeover land before B's delayed rename
    const cur = await origReadC3(leasePath, "utf8").catch(() => "");
    if (cur.includes("claimedAt")) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  allowRen = true;  // B's claim lands on top; B's fence sees its stamp lost
  const a = await aRun;
  const b = await bRun;
  restoreFs();
  assert.equal(a, "ok", "A (the reclaim winner) completes");
  assert.match(String(b), /replaced mid-swap/, "B walks away with the named fence error");
  // The wedge assertion: NOTHING naming this live process survives.
  const leftover = await origReadC3(leasePath, "utf8").catch(() => "");
  if (leftover !== "") {
    const pid = (JSON.parse(leftover) as { pid?: number }).pid;
    assert.notEqual(pid, process.pid, "a failed admission leaves NO lease naming our live pid (the reproduced walkaway-wedge)");
  }
  const retry = await run("retry").then(() => "ok", (e: Error) => `ERR: ${e.message}`);
  assert.equal(retry, "ok", "a subsequent activation completes — the failed admission wedged nothing");
});

test("P20c4-F2: a transient EIO on the POST-SWAP stamp read does NOT fail the activation — ownership stands", async (t) => {
  // The auditor moved the reproduced self-wedge to the NEW post-swap
  // stamp read: one injected EIO made the takeover throw AND left the
  // lease naming our live pid (the retry refused). Post-fix the same
  // rule as the initial stamp read applies: a read error cannot disprove
  // the lock we won with a successful wx-create — only ENOENT (torn
  // down) says "not ours". The activation completes and releases.
  const root = await mkdtemp(join(tmpdir(), "p20c4-f2-eio-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c4-f2");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const stampPath = join(dir, "host.lease.lock", "owner");
  await writeFile(leasePath, JSON.stringify({ pid: 2147483647, token: "dead" }));
  const worker = await quickWorker(root);
  let stampReads = 0;
  (fs.promises as { readFile: unknown }).readFile = async function (p: string | URL, ...args: unknown[]) {
    if (String(p) === stampPath && ++stampReads === 2) { // the POST-SWAP read (1st = initial verification)
      throw Object.assign(new Error("transient post-swap stamp EIO"), { code: "EIO" });
    }
    return (origReadC3 as (p: string | URL, ...a: unknown[]) => Promise<unknown>)(p, ...args);
  } as typeof fs.promises.readFile;
  syncBuiltinESMExports();
  const first = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "eio", workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => "ok", (e: Error) => `ERR: ${e.message}`);
  restoreFs();
  assert.equal(stampReads >= 2, true, "the EIO actually fired on the post-swap stamp read");
  assert.equal(first, "ok", "a transient verification error never fails an activation we provably won (the reproduced POST_SWAP_EIO_WEDGE)");
  const retry = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "retry", workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => "ok", (e: Error) => `ERR: ${e.message}`);
  assert.equal(retry, "ok", "and the next activation runs normally — no wedge");
  void leasePath;
});

test("P20c4-F3: post-swap identity is STRICT — a foreign body embedding our token does not admit activation", async (t) => {
  // The auditor's POST_SWAP_EMBED: right after our swap-rename, a
  // foreign writer installs {pid:1, token:"foreign", previous:{token:
  // <ours>}} keeping the lock stamp intact. Pre-P20c4 the post-swap
  // check was includes(token) — the EMBEDDED occurrence passed and the
  // run completed against a foreign lease (reproduced). Post-fix the
  // claim must parse with token === ours AT TOP LEVEL: the run refuses
  // and the foreign lease survives (we never fight back).
  const root = await mkdtemp(join(tmpdir(), "p20c4-f3-embed-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c4-f3");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  await writeFile(leasePath, JSON.stringify({ pid: 2147483647, token: "dead" }));
  const worker = await quickWorker(root);
  let planted = false;
  // P20c6-F1 REPAIR: the swap's claim lands via a no-replace link of the
  // `.takeover`-suffixed stage (the fast-path stage has a different
  // suffix, so the plant fires ONLY on the takeover claim).
  (fs.promises as { link: unknown }).link = async function (a: string | URL, b: string | URL) {
    const r = await origLink(a as string, b as string);
    if (String(b) === leasePath && String(a).endsWith(".takeover") && !planted) {
      const ours = JSON.parse(await origReadC3(leasePath, "utf8") as string).token as string;
      await fs.promises.writeFile(leasePath, JSON.stringify({ pid: 1, token: "foreign", previous: { token: ours } }));
      planted = true;
    }
    return r;
  } as typeof fs.promises.link;
  syncBuiltinESMExports();
  await assert.rejects(
    () => runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }),
    /replaced mid-swap/,
    "the embed is detected: top-level token is foreign — activation refused (reproduced violation)",
  );
  restoreFs();
  const survivor = JSON.parse(await readFile(leasePath, "utf8"));
  assert.equal(survivor.token, "foreign", "the foreign lease survives untouched");
  assert.equal(planted, true, "the embed actually fired after our swap");
});

// ─── Cycle 6 (R4 audit of 1c64566): named regressions for findings 1-2 ─────


test("P20c6-F1: a fresh publish NEVER runs ahead of a live takeover lock (reproduced OVERLAPPING_WORKERS)", async (t) => {
  // The auditor's overlap: a recovery holds the takeover lock mid-swap
  // (its swap has removed/replaced the lease view), and a second process
  // fast-pathed an exclusive claim against the ABSENT lease — two workers
  // admitted. Post-fix the fast path (and every under-lock re-publish
  // from the loop top) yields while the lock dir exists: with the lease
  // absent but the lock LIVE (fresh stamp naming a live pid), a creator
  // fails closed at the attempt budget and never publishes.
  const root = await mkdtemp(join(tmpdir(), "p20c6-f1-lockfast-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  restoreFs();
  const epGraph = graphA("ep-c6-f1-lockfast");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const lockPath = join(dir, "host.lease.lock");
  // Lease ABSENT (a swap in flight removed it); takeover lock held by a
  // LIVE acquirer with a fresh stamp.
  await mkdir(lockPath);
  await writeFile(join(lockPath, "owner"), `${process.pid}.recovering`);
  const worker = await quickWorker(root);
  await assert.rejects(
    () => runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }),
    /contended/,
    "the creator waits out the live takeover lock and fails closed (40 attempts) instead of publishing under it",
  );
  let leaseThere = true;
  try { await stat(leasePath); } catch { leaseThere = false; }
  assert.equal(leaseThere, false, "NO claim was published while the takeover lock was live (the reproduced second admission cannot form)");
  const stampNow = await readFile(join(lockPath, "owner"), "utf8");
  assert.equal(stampNow, `${process.pid}.recovering`, "the recovery's lock survived untouched");
});

test("P20c6-F1/F2: a takeover whose claim-link FAILS mid-swap restores the moved-aside original — the previous owner's claim never strands", async (t) => {
  // New swap shape: move the stale claim aside, no-replace link our own.
  // Inject a TRANSIENT link failure on the takeover stage (not EEXIST):
  // the shared anomaly exit must (a) self-release (nothing of ours is
  // linked -> "absent"), (b) link the moved-aside ORIGINAL back (FIFO
  // order guarantees the lease is absent), and (c) leave NO `.reclaim-`
  // garbage — the episode keeps the exact claim that existed before.
  const root = await mkdtemp(join(tmpdir(), "p20c6-f1-restore-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c6-f1-restore");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const stale = JSON.stringify({ pid: 111, token: "dead-owner" }) + "\n";
  await writeFile(leasePath, stale);
  const worker = await quickWorker(root);
  let fired = false;
  (fs.promises as { link: unknown }).link = async function (a: string | URL, b: string | URL) {
    // ONLY the takeover claim-link (its stage carries the .takeover
    // suffix); fail it once with a non-EEXIST errno.
    if (String(b) === leasePath && String(a).endsWith(".takeover") && !fired) {
      fired = true;
      throw Object.assign(new Error("simulated mid-swap link EIO"), { code: "EIO" });
    }
    return origLink(a as string, b as string);
  } as typeof fs.promises.link;
  syncBuiltinESMExports();
  const err = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} })
    .then(() => null, (e: Error) => e.message);
  restoreFs();
  assert.ok(err !== null && /anomaly \(claim link failed/.test(err), `the takeover fails with the named anomaly error (got: ${String(err).slice(0, 120)})`);
  assert.match(err, /self-release absent/, "the self-release outcome is reported honestly (nothing of ours was linked)");
  assert.match(err, /moved-aside original restored/, "the ORIGINAL claim was linked back (no-replace) — the lease is never left absent by our failure");
  assert.equal(await readFile(leasePath, "utf8"), stale, "the episode holds EXACTLY the previous owner's claim again (byte-identical, so its abandon-bound eligibility survives)");
  const names = await readdir(dir);
  assert.ok(!names.some((n) => n.includes(".reclaim-")), "no moved-aside garbage survives the anomaly exit");
  assert.ok(!names.some((n) => n.endsWith(".takeover")), "the failed takeover stage is cleaned up");
});

test("P20c6-F2: a TRANSIENT error on the final release is RETRIED — the claim is released and nothing is disclosed", async (t) => {
  // Pre-P20c6 the outer-finally release was a single read+unlink in one
  // swallow-everything catch: ONE transient unlink EIO silently left our
  // claim (naming our LIVE pid) on disk — the next activation in this
  // process refused "already activated" until exit (reproduced
  // CLEANUP_UNLINK_EIO). The shared release primitive retries: the
  // second attempt lands and the episode ends lease-free and silent.
  const root = await mkdtemp(join(tmpdir(), "p20c6-f2-retry-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c6-f2-retry");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const worker = await quickWorker(root);
  let n = 0;
  (fs.promises as { unlink: unknown }).unlink = async function (p: string | URL) {
    if (String(p) === leasePath && ++n === 1) {
      throw Object.assign(new Error("simulated release EIO"), { code: "EIO" });
    }
    return origUnlink(p as string);
  } as typeof fs.promises.unlink;
  syncBuiltinESMExports();
  const lines: string[] = [];
  const r = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: (l) => lines.push(l) });
  restoreFs();
  assert.ok(["accepted-finish", "max-iterations"].includes(r.result.stopped), "the episode completed normally");
  assert.ok(n >= 2, "the release actually retried past the injected EIO");
  assert.ok(!lines.some((l) => /release FAILED/.test(l)), "a RETRIED release discloses nothing — it succeeded");
  let gone = false;
  try { await stat(leasePath); } catch { gone = true; }
  assert.ok(gone, "the claim is GONE — a transient error no longer strands a live-pid lease");
});

test("P20c6-F2: a PERSISTENT release failure is DISCLOSED on the log — never a silent swallow", async (t) => {
  // The honest-message half of F2: when every retry fails, the outcome
  // is "failed" and the outer finally MUST say so (the pre-P20c6 code
  // reported nothing — the caller believed the release was a no-op).
  const root = await mkdtemp(join(tmpdir(), "p20c6-f2-persist-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c6-f2-persist");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const worker = await quickWorker(root);
  (fs.promises as { unlink: unknown }).unlink = async function (p: string | URL) {
    if (String(p) === leasePath) throw Object.assign(new Error("persistent release EIO"), { code: "EIO" });
    return origUnlink(p as string);
  } as typeof fs.promises.unlink;
  syncBuiltinESMExports();
  const lines: string[] = [];
  const r = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: (l) => lines.push(l) });
  restoreFs();
  assert.ok(["accepted-finish", "max-iterations"].includes(r.result.stopped), "the episode itself still completes (release is post-result)");
  assert.ok(lines.some((l) => /P20c6-F2: lease release FAILED/.test(l)), "the persistent failure is surfaced honestly on the log");
  const leftover = JSON.parse(await readFile(leasePath, "utf8"));
  assert.equal(leftover.pid, process.pid, "the claim persists (naming our pid) — exactly the state the disclosure describes; takeover reclaims it with disclosure after we exit");
});

// ─── Cycle 7 (R4 audit of 3317730): named regressions for findings 1-4 ─────

import { spawn } from "node:child_process";

// A pid we can PROVE dead (a reaped child), for reconcile/steal tests.
async function deadPid(): Promise<number> {
  const p = spawn("/bin/sh", ["-c", "exit 0"]);
  await new Promise((r) => p.on("exit", r));
  return p.pid as number;
}

test("P20c7-F1/F2: a dead mover's `.reclaim-` artifact is RESTORED to the vacant lease path (restore-if-vacant) and the episode re-takes it — no wedge, no blind sweep", async (t) => {
  // The reproduced wedge: a takeover moved the previous owner's claim to
  // `host.lease.reclaim-<pid>.<token>` and died before its relink. The
  // OLD sweep unlinked that artifact sight-unseen — the only recovery
  // source, gone. New contract: reconcileReclaims links it back to the
  // vacant lease path (no-replace) BEFORE any unlink is considered, the
  // restored stale claim is then judged normally (dead holder → re-take
  // under the lock), and the artifact name is reclaimed in the same
  // pass. The activation completes with no steal/abandon-bound wait.
  const root = await mkdtemp(join(tmpdir(), "p20c7-reconcile-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c7-reconcile");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const dead = await deadPid();
  const moved = JSON.stringify({ pid: 111, token: "prev-owner" });
  const artifact = join(dir, `host.lease.reclaim-${dead}.frozentoken`);
  await writeFile(artifact, moved); // lease path ABSENT: the wedge state
  const worker = await quickWorker(root);
  const r = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} });
  assert.ok(["accepted-finish", "max-iterations"].includes(r.result.stopped), "the activation completes — the wedge is gone");
  const names = await readdir(dir);
  assert.ok(!names.some((n) => n.includes(".reclaim-")), "the dead mover's artifact was restored AND reclaimed (never unlinked sight-unseen, never stranded)");
  const cur = await readFile(leasePath, "utf8").catch(() => "");
  assert.ok(cur === "" || JSON.parse(cur).pid === process.pid, cur === "" ? "the restored claim was re-taken by this process and released normally at exit" : "the restored stale claim is held by this process");
});

test("P20c7-F2: crashed mover's full wedge state (lease absent + dead-stamped AGED lock + artifact) recovers — the reconcile runs before the lock-blocked publish", async (t) => {
  // The exact state R4's F2 reproduced: lease ABSENT, takeover lock
  // still standing stamping a now-DEAD mover, and the `.reclaim-`
  // recovery source on disk. Pre-P20c7 the creator failed closed and
  // only the 30s steal bound restored service. Here the lock is aged
  // deterministically; with the reconcile running FIRST the restored
  // claim is refused-live and the lock is taken through the normal
  // steal path — activation completes, artifact reclaimed.
  const root = await mkdtemp(join(tmpdir(), "p20c7-wedge-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c7-wedge");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const lockPath = join(dir, "host.lease.lock");
  const dead = await deadPid();
  const artifact = join(dir, `host.lease.reclaim-${dead}.frozentoken`);
  await writeFile(artifact, JSON.stringify({ pid: 2147483647, token: "future-owner" }));
  await mkdir(lockPath);
  await writeFile(join(lockPath, "owner"), `${dead}.mover-token.dead`);
  await utimes(lockPath, 1, 1); // aged past the 30s steal bound (deterministic)
  const worker = await quickWorker(root);
  const r = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} });
  assert.ok(["accepted-finish", "max-iterations"].includes(r.result.stopped), "the wedge self-heals: the creator completes through the aged dead-stamped lock");
  const cur = await readFile(leasePath, "utf8").catch(() => "");
  assert.ok(cur === "" || JSON.parse(cur).pid === process.pid, cur === "" ? "the activation completed and released normally at exit" : "the activation holds the lease");
  const names = await readdir(dir);
  assert.ok(!names.some((n) => n.includes(".reclaim-")), "the dead mover's artifact was reclaimed (restored-then-superseded)");
});

test("P20c7-F4: a mid-swap occupant is CLASSIFIED — a takeover whose restore hits EEXIST reports the occupant's live pid honestly", async (t) => {
  // Mechanism: the takeover acquires its OWN lock and swaps; right after
  // its move-aside a rival reclaims the lock dir and dies before
  // stamping (the P20c5-F4 state — reproduced by removing the lock dir
  // inside the rename patch), so the post-swap stamp check fails. On the
  // anomaly path the restore-link then hits EEXIST under a LIVE rival
  // claim. The message must name the occupant's pid (never a blanket
  // "absent-rival" — R4 F4), the rival lease must be untouched, and the
  // artifact (garbage behind a live occupant) must be reclaimed.
  const root = await mkdtemp(join(tmpdir(), "p20c7-f4-live-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c7-f4-live");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const lockPath = join(dir, "host.lease.lock");
  await writeFile(leasePath, JSON.stringify({ pid: 111, token: "stale" }));
  const worker = await quickWorker(root);
  const rivalProc = spawn("/bin/sh", ["-c", "sleep 30"]); // a genuinely LIVE pid
  t.after(() => { try { rivalProc.kill("SIGKILL"); } catch { /* gone */ } });
  await new Promise((r) => setTimeout(r, 50));
  const rival = JSON.stringify({ pid: rivalProc.pid, token: "rival-live" });
  let lockStolen = false;
  (fs.promises as { rename: unknown }).rename = async function (a: string | URL, b: string | URL) {
    const res = await (origRename as (a: string | URL, b: string | URL) => Promise<void>)(a, b);
    // The move-aside just landed: a thief rmdir's our lock and dies
    // before stamping — the post-swap stamp read gets ENOENT.
    if (!lockStolen && String(b).startsWith(leasePath + ".reclaim-")) {
      lockStolen = true;
      await origRm(lockPath, { recursive: true, force: true });
    }
    return res;
  } as typeof fs.promises.rename;
  let restoreHit = false;
  (fs.promises as { link: unknown }).link = async function (a: string | URL, b: string | URL) {
    const d = String(b);
    if (d === leasePath && String(a).includes(".reclaim-") && !restoreHit) {
      restoreHit = true;
      await writeFile(leasePath, rival); // our failure window: a LIVE rival claims the path
      throw Object.assign(new Error("simulated EEXIST"), { code: "EEXIST" });
    }
    return origLink(a as string, d);
  } as typeof fs.promises.link;
  syncBuiltinESMExports();
  const err = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => null, (e: Error) => e.message);
  restoreFs();
  assert.ok(err !== null, "the takeover fails (stamp lost mid-swap)");
  assert.ok(restoreHit, "the anomaly restore actually ran (the test drove the intended path)");
  assert.match(err as string, /moved-aside original occupied by a live claim \(pid \d+\)/, `the F4 classification names the occupant's live pid (got: ${String(err).slice(0, 160)})`);
  assert.equal(await readFile(leasePath, "utf8"), rival, "the rival's lease was never touched");
  const names = await readdir(dir);
  assert.ok(!names.some((n) => n.includes(".reclaim-")), "the artifact behind a live occupant is reclaimed");
});

test("P20c7-F3: a restore that ERRORED keeps the recovery source — `gone` is NEVER unlinked when the link failed with a non-EEXIST/ENOENT errno", async (t) => {
  // The mirror of the P20c6 restore test: there the restore SUCCEEDED
  // (lease linked back, artifact cleaned); here the restore itself hits
  // a transient EIO. Pre-P20c7 the anomaly exit unlinked `gone`
  // regardless — destroying the sole recovery source (R4 F3). New
  // contract: the message reports "restore failed (EIO) — recovery
  // source preserved for reconcile" and the artifact SURVIVES
  // byte-intact for a later activation to re-link.
  const root = await mkdtemp(join(tmpdir(), "p20c7-f3-preserve-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c7-f3-preserve");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const lockPath = join(dir, "host.lease.lock");
  const stale = JSON.stringify({ pid: 111, token: "stale-owner" });
  await writeFile(leasePath, stale);
  const worker = await quickWorker(root);
  let lockStolen = false;
  (fs.promises as { rename: unknown }).rename = async function (a: string | URL, b: string | URL) {
    const res = await (origRename as (a: string | URL, b: string | URL) => Promise<void>)(a, b);
    if (!lockStolen && String(b).startsWith(leasePath + ".reclaim-")) {
      lockStolen = true;
      await origRm(lockPath, { recursive: true, force: true }); // force the post-swap stamp loss
    }
    return res;
  } as typeof fs.promises.rename;
  let restoreHit = false;
  (fs.promises as { link: unknown }).link = async function (a: string | URL, b: string | URL) {
    const d = String(b);
    if (d === leasePath && String(a).includes(".reclaim-") && !restoreHit) {
      restoreHit = true;
      throw Object.assign(new Error("simulated restore EIO"), { code: "EIO" }); // transient: the source must survive
    }
    return origLink(a as string, d);
  } as typeof fs.promises.link;
  syncBuiltinESMExports();
  const err = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => null, (e: Error) => e.message);
  restoreFs();
  assert.ok(err !== null, "the takeover fails (stamp lost, restore errored)");
  assert.ok(restoreHit, "the anomaly restore actually ran (the test drove the intended path)");
  assert.match(err as string, /moved-aside original restore failed \(EIO\) — recovery source preserved for reconcile/, `honest restore outcome (got: ${String(err).slice(0, 160)})`);
  const names = await readdir(dir);
  const kept = names.filter((n) => n.includes(".reclaim-"));
  assert.equal(kept.length, 1, "the recovery source SURVIVED the failed restore (P20c7-F3)");
  assert.equal(await readFile(join(dir, kept[0]!), "utf8"), stale, "byte-identical previous owner's claim — reconcile can restore it");
});