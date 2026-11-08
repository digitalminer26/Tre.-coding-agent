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
function restoreFs(): void {
  const p = fs.promises as { link: unknown; rename: unknown; rm: unknown; readFile: unknown };
  p.link = origLink;
  p.rename = origRename;
  p.rm = origRm;
  p.readFile = origReadFile;
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
  const parked = deferred();
  let resumed = false;
  let renames = 0;
  (fs.promises as { rename: unknown }).rename = async function (a: string | Uint8Array | null, b: string | Uint8Array | null) {
    if (String(b) === leasePath && ++renames === 1) {
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
  // Simulate a lock-thief winning mid-swap: after OUR rename installs our
  // claim, a foreign claim is renamed over it before we re-read.
  const foreign = join(dir, "thief-claim");
  await writeFile(foreign, JSON.stringify({ pid: 112, token: "thief" }) + "\n");
  let did = false;
  (fs.promises as { rename: unknown }).rename = async function (a: string | Uint8Array | null, b: string | Uint8Array | null) {
    const r = await origRename(a as string, b as string);
    if (!did && String(b) === leasePath) {
      did = true;
      await origRename(foreign, leasePath); // the stomp: our claim is replaced after the swap
    }
    return r;
  };
  syncBuiltinESMExports();
  await assert.rejects(
    () => runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }),
    /replaced mid-swap/,
    "the taker detects it no longer owns the lease and refuses to proceed believing it holds the episode",
  );
  assert.equal(JSON.parse(await readFile(leasePath, "utf8")).token, "thief", "the run walked away; the foreign claim stands untouched (the loser does not fight back)");
});

test("P20-F1: a refuse-throw UNDER the takeover lock releases the lock (no self-wedge for the next recovery)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20-f1-release-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  const epGraph = graphA("ep-f1-release");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const lockPath = join(dir, "host.lease.lock");
  const stale = JSON.stringify({ pid: 111, token: "dead-owner" }) + "\n";
  await writeFile(leasePath, stale);
  const worker = await quickWorker(root);
  // Deterministic mid-recovery flip to a LIVE-same-process claim: the
  // first two reads of the lease (loop-top observation, then the fence
  // re-read is the SECOND) see the dead claim; the fence re-read sees
  // OUR pid → refuseSameProcess throws while the lock is held. The old
  // code left the lock (and its stamp naming our own live pid) on disk,
  // wedging the next recovery. Assert the finally released it.
  const origReadFile = fs.promises.readFile.bind(fs.promises);
  let reads = 0;
  (fs.promises as { readFile: unknown }).readFile = function (p: string | URL | Uint8Array | number, ...rest: unknown[]) {
    if (String(p) === leasePath) {
      reads++;
      if (reads >= 2) return Promise.resolve(Buffer.from(JSON.stringify({ pid: process.pid, token: "planted" }) + "\n"));
    }
    return (origReadFile as (a: unknown, b?: unknown) => Promise<unknown>)(p, ...rest) as Promise<Buffer>;
  };
  syncBuiltinESMExports();
  await assert.rejects(
    () => runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }),
    /already activated in this process/,
    "the under-lock fence re-check met a same-process claim and refused",
  );
  assert.ok(reads >= 2, "the fence re-read happened while the lock was held");
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
  (fs.promises as { rename: unknown }).rename = async function (a: string | URL, b: string | URL) {
    if (String(b) === leasePath && ++renameCount === 1) {
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
