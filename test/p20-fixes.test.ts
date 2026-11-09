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
import { basename, join, resolve } from "node:path";

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
const origOpen = fs.promises.open.bind(fs.promises);
const origReaddir = fs.promises.readdir.bind(fs.promises);
const origRealpath = fs.promises.realpath.bind(fs.promises);
const origKill = process.kill.bind(process) as typeof process.kill;
function restoreFs(): void {
  const p = fs.promises as { link: unknown; rename: unknown; rm: unknown; readFile: unknown; unlink: unknown; readdir: unknown; open: unknown; realpath: unknown };
  p.link = origLink;
  p.rename = origRename;
  p.rm = origRm;
  p.readFile = origReadFile;
  p.readdir = origReaddir;
  p.open = origOpen;
  // P20c7: the unlink patch (release-retry tests) leaked into later
  // tests without this — restore it.
  p.unlink = origUnlink;
  // P20c11: the realpath patch (canonical-identity tests) must unwind the
  // same way — restoreFs is the t.after safety net for them too.
  p.realpath = origRealpath;
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
      await parked.promise; // freeze before the move: lock remains held
      return origRename(a as string, b as string);
    }
    return origRename(a as string, b as string);
  };
  syncBuiltinESMExports();

  const cRun = runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "C", workerCommand: worker, maxIterations: 1, log: () => {} });
  // Wait until C is parked: it has acquired the lock (stamp written) and
  // reached the rename interception inside replaceLeaseUnderLock; the
  // move itself is held until the contender has completed.
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
// ─── Cycle 8 (R5 audit of 43faec0): named regressions for findings 1-5 ─────

test("P20c8-F1: a reconcile restore whose link ERRORED (EIO) PRESERVES the recovery source — never a fall-through unlink", async (t) => {
  // The reproduced R5-F1: the lease is ABSENT, a dead mover's
  // `.reclaim-` artifact is the sole recovery source, and the
  // restore-if-vacant link hits a transient EIO. Pre-P20c8 the
  // reconcile swallowed the link error and UNCONDITIONALLY unlinked
  // the source — the wedge became permanent (reproduced: two
  // reconcilers both failing their links lost the previous owner's
  // claim forever). New contract: an unexpected link errno preserves
  // the source byte-intact; the next reconcile (same run, loop 2) or
  // the next activation re-links it.
  const root = await mkdtemp(join(tmpdir(), "p20c8-f1-eio-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c8-f1-eio");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const dead = await deadPid();
  const moved = JSON.stringify({ pid: 111, token: "prev-owner" });
  const artifact = join(dir, `host.lease.reclaim-${dead}.frozentoken`);
  await writeFile(artifact, moved); // lease ABSENT: the wedge state
  const worker = await quickWorker(root);
  let eioUsed = false;
  (fs.promises as { link: unknown }).link = async function (a: string | URL, b: string | URL) {
    // Only the reconcile's restore link (source -> lease path) errors.
    if (!eioUsed && String(a).includes(".reclaim-") && String(b) === leasePath) {
      eioUsed = true;
      throw Object.assign(new Error("simulated reconcile EIO"), { code: "EIO" });
    }
    return origLink(a as string, String(b));
  } as typeof fs.promises.link;
  syncBuiltinESMExports();
  const err = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => null, (e: Error) => e.message);
  restoreFs();
  assert.ok(eioUsed, "the reconcile's restore link really ran and errored (the test drove the intended path)");
  assert.ok(err !== null, "activation fails closed while the recovery source cannot be reconciled");
  assert.match(err as string, /cannot reconcile recovery source.*restore link failed: EIO/);
  const names = await readdir(dir);
  const kept = names.filter((n) => n.includes(".reclaim-"));
  assert.equal(kept.length, 1, "the recovery source SURVIVED the errored restore (pre-P20c8: unlinked sight-unseen — the wedge was permanent)");
  assert.equal(await readFile(join(dir, kept[0]!), "utf8"), moved, "byte-identical previous owner's claim preserved for a later reconcile");
});

test("P20c9-F1: reconciliation EIO fails closed instead of publishing over a hidden live claim", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20c9-f1-live-hidden-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c9-f1-live-hidden");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const dead = await deadPid();
  const artifact = join(dir, `host.lease.reclaim-${dead}.source`);
  const live = JSON.stringify({ pid: process.pid, token: "hidden-live-owner" });
  await writeFile(artifact, live);
  const worker = await quickWorker(root);
  let eioUsed = false;
  (fs.promises as { link: unknown }).link = async function (a: string | URL, b: string | URL) {
    if (!eioUsed && String(a) === artifact && String(b) === leasePath) {
      eioUsed = true;
      throw Object.assign(new Error("simulated restore EIO"), { code: "EIO" });
    }
    return origLink(a as string, String(b));
  } as typeof fs.promises.link;
  syncBuiltinESMExports();
  const err = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => null, (e: Error) => e.message);
  restoreFs();
  assert.ok(eioUsed, "restore EIO was injected");
  assert.match(err ?? "", /cannot reconcile recovery source.*restore link failed: EIO/);
  assert.equal(await readFile(artifact, "utf8"), live, "the only live-holder claim remains intact");
  await assert.rejects(readFile(leasePath, "utf8"), { code: "ENOENT" }, "no fresh lease may be published over an unresolved live recovery source");
});

test("P20c9-F2: an old same-pid staged tmp is reclaimed; a current tmp remains protected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20c9-f2-old-tmp-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c9-f2-old-tmp");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const oldTmp = `${leasePath}.tmp-${process.pid}.old-token`;
  await writeFile(oldTmp, "abandoned stage");
  await utimes(oldTmp, 1, 1);
  const worker = await quickWorker(root);
  await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} });
  await assert.rejects(readFile(oldTmp, "utf8"), { code: "ENOENT" }, "pre-start same-pid tmp is cleaned, not preserved by pidAlive(process.pid)");
});

test("P20c8-F2: a FRESH takeover lock stamped by a dead pid is cleared immediately — no 30s steal-bound wedge", async (t) => {
  // The reproduced R5-F2 wedge: lease ABSENT, takeover lock standing
  // with a stamp naming a provably DEAD acquirer, created YOUNGER than
  // the 30s steal bound (no aging here — determinism must not lean on
  // it), plus a dead-owner `.reclaim-` source. Pre-P20c8 the reconcile
  // restored the claim, then the creator yielded to the lock for the
  // FULL steal bound (the disclosure promised immediate self-heal and
  // lied) — the activation failed "contended". A dead-stamped lock is
  // held by NOBODY (a frozen thief's stamp names a LIVE pid): it is
  // cleared on sight and the episode self-heals at once.
  const root = await mkdtemp(join(tmpdir(), "p20c8-f2-lock-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c8-f2-lock");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const lockPath = join(dir, "host.lease.lock");
  const dead = await deadPid();
  const artifact = join(dir, `host.lease.reclaim-${dead}.frozentoken`);
  await writeFile(artifact, JSON.stringify({ pid: 111, token: "prev-owner" }));
  await mkdir(lockPath); // FRESH lock — pre-P20c8: 30s of "contended"
  await writeFile(join(lockPath, "owner"), `${dead}.dead-mover.dead`);
  const worker = await quickWorker(root);
  const lines: string[] = [];
  const r = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: (l) => lines.push(l) });
  assert.ok(["accepted-finish", "max-iterations"].includes(r.result.stopped), "the wedge self-heals through the dead-stamped lock with NO age (pre-P20c8: failed 'contended')");
  assert.ok(lines.some((l) => /stamped by dead pid/.test(l) && /cleared immediately/.test(l)), `the dead-stamped lock was cleared on sight (logs: ${lines.filter((l) => /lock/.test(l)).join(" | ").slice(0, 200)})`);
  const names = await readdir(dir);
  assert.ok(!names.some((n) => n.includes(".reclaim-")), "the restored-then-superseded artifact was reclaimed");
  const cur = await readFile(leasePath, "utf8").catch(() => "");
  assert.ok(cur === "" || JSON.parse(cur).pid === process.pid, "the lease ended vacant or held by this process — never a foreign claim");
});

test("P20c9-F3: a same-process live mover's old-mtime recovery source is never stolen by a second reconcile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20c9-f3-active-mover-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c9-f3-active-mover");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const leaseBody = JSON.stringify({ pid: 111, token: "stale-original" });
  await writeFile(leasePath, leaseBody);
  await utimes(leasePath, 1, 1); // rename preserves this OLD mtime
  const worker = await quickWorker(root);
  let moved!: string;
  const movedPause = deferred();
  const resume = deferred();
  let paused = false;
  (fs.promises as { rename: unknown }).rename = async function (a: string | URL, b: string | URL) {
    if (!paused && String(a) === leasePath && String(b).includes(".reclaim-")) {
      paused = true;
      moved = String(b);
      const result = await origRename(a as string, String(b));
      movedPause.resolve();
      await resume.promise;
      return result;
    }
    return origRename(a as string, String(b));
  } as typeof fs.promises.rename;
  syncBuiltinESMExports();
  const run = () => runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} });
  const first = run().then(() => null, (e: Error) => e.message);
  await movedPause.promise;
  assert.equal((await stat(moved)).mtimeMs, 1000, "renamed artifact inherited source mtime");
  const second = await run().then(() => null, (e: Error) => e.message);
  assert.ok(second !== null, "second activation is refused while first mover is live");
  assert.ok(await stat(moved).then(() => true, () => false), "the in-flight mover's recovery source was not restored or removed");
  resume.resolve();
  const firstErr = await first;
  restoreFs();
  assert.equal(firstErr, null, `first recovery completes (got ${String(firstErr)})`);
});

test("P20c10-F1d: aliased episodes roots cannot evade active recovery protection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20c10-f1-alias-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c10-f1-alias");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const leaseBody = JSON.stringify({ pid: 111, token: "stale-original" });
  await writeFile(leasePath, leaseBody);
  await utimes(leasePath, 1, 1);
  const worker = await quickWorker(root);
  let moved!: string;
  const movedPause = deferred();
  const resume = deferred();
  let paused = false;
  (fs.promises as { rename: unknown }).rename = async function (a: string | URL, b: string | URL) {
    if (!paused && String(a) === leasePath && String(b).includes(".reclaim-")) {
      paused = true;
      moved = String(b);
      const result = await origRename(a as string, String(b));
      movedPause.resolve();
      await resume.promise;
      return result;
    }
    return origRename(a as string, String(b));
  } as typeof fs.promises.rename;
  syncBuiltinESMExports();
  const first = runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => null, (e: Error) => e.message);
  await movedPause.promise;
  // A genuine symlink alias: a different path string for the same directory.
  const aliasParent = await mkdtemp(join(tmpdir(), "p20c10-alias-link-"));
  t.after(() => rm(aliasParent, { recursive: true, force: true }));
  const alias = join(aliasParent, "episodes-alias");
  await fs.promises.symlink(root, alias);
  assert.notEqual(alias, root, "the supplied root differs as a string");
  const second = await runHostEpisode({ episodesRoot: alias, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => null, (e: Error) => e.message);
  assert.ok(second !== null, "a symlinked root resolves to the same in-process protection identity");
  assert.ok(await stat(moved).then(() => true, () => false), "the live mover's recovery source was not restored or removed through an aliased root");
  resume.resolve();
  const firstErr = await first;
  restoreFs();
  assert.equal(firstErr, null, `first recovery completes (got ${String(firstErr)})`);
});

test("P20c10-F1e: a transient realpath failure fails the activation closed — no incompatible identity, no worker, no lease", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20c10-f1e-realpath-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c10-f1e-realpath");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const worker = await quickWorker(root);
  const origRealpath = fs.promises.realpath.bind(fs.promises);
  let injected = false;
  (fs.promises as { realpath: unknown }).realpath = async function (p: string | URL, ...rest: unknown[]) {
    if (!injected && resolve(String(p)) === resolve(dir)) {
      injected = true;
      throw Object.assign(new Error("simulated realpath EIO"), { code: "EIO" });
    }
    return origRealpath(p as string, ...(rest as []));
  };
  syncBuiltinESMExports();
  const err = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => null, (e: Error) => e.message);
  (fs.promises as { realpath: unknown }).realpath = origRealpath;
  syncBuiltinESMExports();
  assert.ok(injected, "the realpath failure was injected");
  assert.match(err ?? "", /canonical identity/, "the activation refuses rather than keying protection on a fallback");
  await assert.rejects(readFile(leasePath, "utf8"), { code: "ENOENT" }, "no lease published under an unresolved identity");
});

test("P20c10-F2: directory inspection failures fail closed — no sweep and no fresh lease on unreadable ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p20c10-f2-readdir-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c10-f2-readdir");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const source = join(dir, "host.lease.reclaim-2147483647.dead");
  await writeFile(source, JSON.stringify({ pid: process.pid, token: "hidden-live" }));
  const worker = await quickWorker(root);
  let readdirErrors = 0;
  (fs.promises as { readdir: unknown }).readdir = async function (p: string | URL, ...rest: unknown[]) {
    if (resolve(String(p)) === resolve(dir) && readdirErrors++ === 0) {
      throw Object.assign(new Error("simulated directory EIO"), { code: "EIO" });
    }
    return origReaddir(p as Parameters<typeof origReaddir>[0], ...(rest as Parameters<typeof origReaddir> extends [unknown, ...infer R] ? R : never)) as never;
  } as typeof fs.promises.readdir;
  syncBuiltinESMExports();
  const err = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => null, (e: Error) => e.message);
  restoreFs();
  assert.match(err ?? "", /cannot inspect/, "an unreadable recovery directory fails closed before publishing");
  assert.ok(await stat(source).then(() => true, () => false), "no sweep may destroy an uninspected recovery source");
  await assert.rejects(readFile(leasePath, "utf8"), { code: "ENOENT" }, "no fresh lease may be published over uninspected ownership");
});

test("P20c8-F3: a same-pid artifact that PREDATES this process is an ABANDONED namesake workspace — reconciled, not skipped", async (t) => {
  // Pid reuse onto OUR OWN pid: the OS recycles pids, so a
  // `.reclaim-<our pid>` artifact with an mtime BEFORE this process
  // started cannot be our in-flight swap — it is a long-dead namesake's
  // abandoned workspace. Pre-P20c8 reconcile skipped every own-pid
  // artifact, so the wedge (lease absent + the CURRENT owner's claim
  // frozen in the artifact) persisted forever. New incarnation rule:
  // own-pid artifacts are ours only when mtime >= procStartMs. Here the
  // pre-start artifact carries the LIVE current owner's claim: restoring
  // it makes the truth visible — activation must refuse the live holder
  // (fail closed), never publish over it.
  const root = await mkdtemp(join(tmpdir(), "p20c8-f3-incarnation-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c8-f3-incarnation");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const rivalProc = spawn("/bin/sh", ["-c", "sleep 30"]); // a genuinely LIVE pid
  t.after(() => { try { rivalProc.kill("SIGKILL"); } catch { /* gone */ } });
  await new Promise((r) => setTimeout(r, 50));
  const rival = JSON.stringify({ pid: rivalProc.pid, token: "current-owner" });
  const artifact = join(dir, `host.lease.reclaim-${process.pid}.namesake-token`); // OUR pid, foreign workspace
  await writeFile(artifact, rival);
  await utimes(artifact, 1, 1); // mtime 1970: provably PRE-START
  const worker = await quickWorker(root);
  await assert.rejects(
    () => runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }),
    /already activated by pid \d+/,
    "the restored live claim is refused fail-closed (pre-P20c8: own pid skipped the artifact forever — the wedge persisted AND a publish raced the hidden live owner)",
  );
  assert.equal(await readFile(leasePath, "utf8"), rival, "the current owner's restored claim stands at the lease path, untouched");
});

test("P20c8-F4: the pre-move re-verify refuses a LIVE claim naming THIS process — no own-pid exemption", async (t) => {
  // A second invocation of THIS process admitted through the disclosed
  // delayed-lock-removal race holds a live claim naming our pid. The
  // pre-P20c8 pre-move re-verify skipped `prePid === process.pid`, so a
  // takeover admitted earlier moved that live same-pid claim aside
  // anyway (INV-B violated before any check→act narrowing). Injection:
  // a foreign-token, same-pid claim appears between the under-lock
  // eligibility verdict and the pre-move re-verify (staged takeover tmp
  // opened = the exact point after the eligibility decision). The move
  // must be REFUSED and the claim left byte-intact.
  const root = await mkdtemp(join(tmpdir(), "p20c8-f4-premove-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c8-f4-premove");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const stale = JSON.stringify({ pid: 111, token: "stale-owner" });
  await writeFile(leasePath, stale);
  const worker = await quickWorker(root);
  const recycled = JSON.stringify({ pid: process.pid, token: "recycled-namesake-live" }); // same pid, FOREIGN token: live namesake claim
  const origOpen = fs.promises.open.bind(fs.promises);
  let injected = false;
  (fs.promises as { open: unknown }).open = async function (...args: Parameters<typeof fs.promises.open>) {
    if (!injected && String(args[0]).includes(".takeover")) {
      injected = true; // eligibility decided; we are past the under-lock re-verify, before the move
      await writeFile(leasePath, recycled); // the second invocation's live claim appears
    }
    return origOpen(...args);
  } as typeof fs.promises.open;
  syncBuiltinESMExports();
  const err = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => null, (e: Error) => e.message);
  restoreFs();
  assert.ok(injected, "the injection ran (the takeover reached the pre-move window)");
  assert.ok(err !== null, "the takeover is refused");
  assert.match(err as string, /refused pre-move re-verify \(a live pid \d+ holds the lease/, `the refusal names the live holder (got: ${String(err).slice(0, 180)})`);
  assert.equal(await readFile(leasePath, "utf8"), recycled, "the live same-pid claim was NEVER moved aside");
  const names = await readdir(dir);
  assert.ok(!names.some((n) => n.includes(".reclaim-")), "nothing was moved: no artifact was created");
});

test("P20c8-F5a: an occupant that VANISHED after the restore's EEXIST is disclosed honestly — `gone` is preserved, never deleted on an unproven supersede", async (t) => {
  // The restore-link races the path occupied (EEXIST), but by the time
  // the occupant is read the path is ABSENT again. Pre-P20c8 the
  // occupant read's fallback treated ANY read error as "occupied" and
  // unlinked the moved original — destroying the recovery source on an
  // outcome that proves NO superseding state (a release leaves the path
  // vacant; the moved claim is its last copy). New contract: honest
  // disclosure ("lease path absent at observation") and the source
  // survives for reconcile.
  const root = await mkdtemp(join(tmpdir(), "p20c8-f5a-vanished-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c8-f5a-vanished");
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
      await origRm(lockPath, { recursive: true, force: true }); // force the post-swap stamp loss -> anomaly path
    }
    return res;
  } as typeof fs.promises.rename;
  let restoreHit = false;
  (fs.promises as { link: unknown }).link = async function (a: string | URL, b: string | URL) {
    const d = String(b);
    if (d === leasePath && String(a).includes(".reclaim-") && !restoreHit) {
      restoreHit = true;
      await writeFile(leasePath, JSON.stringify({ pid: 222, token: "brief-rival" })); // an occupant existed at link time...
      await origUnlink(leasePath); // ...and vanished before the classification read
      throw Object.assign(new Error("simulated EEXIST"), { code: "EEXIST" });
    }
    return origLink(a as string, d);
  } as typeof fs.promises.link;
  syncBuiltinESMExports();
  const err = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => null, (e: Error) => e.message);
  restoreFs();
  assert.ok(restoreHit, "the anomaly restore actually ran (the test drove the intended path)");
  assert.ok(err !== null, "the takeover failed (stamp lost mid-swap)");
  assert.match(err as string, /moved-aside original the occupant vanished after EEXIST \(lease path absent at observation\) — recovery source preserved/, `honest vanished-occupant disclosure (got: ${String(err).slice(0, 200)})`);
  const names = await readdir(dir);
  const kept = names.filter((n) => n.includes(".reclaim-"));
  assert.equal(kept.length, 1, "`gone` SURVIVED the unproven supersede (pre-P20c8: deleted on a blanket 'occupied')");
  assert.equal(await readFile(join(dir, kept[0]!), "utf8"), stale, "byte-identical moved original — reconcile or the next owner can still use it");
});

test("P20c8-F5b: an UNREADABLE occupant (EIO) is disclosed and keeps `gone` — an error cannot prove a supersede", async (t) => {
  // Same anomaly, but the occupant read itself errors: an EIO cannot
  // establish that ANY claim outranks the moved original. Pre-P20c8
  // reported it as "occupied" and deleted the source. New contract:
  // "occupant unreadable (EIO) — recovery source preserved".
  const root = await mkdtemp(join(tmpdir(), "p20c8-f5b-unreadable-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c8-f5b-unreadable");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const lockPath = join(dir, "host.lease.lock");
  const stale = JSON.stringify({ pid: 111, token: "stale-owner" });
  await writeFile(leasePath, stale);
  const worker = await quickWorker(root);
  let lockStolen = false;
  let armed = false;
  let unreadableHit = false;
  (fs.promises as { rename: unknown }).rename = async function (a: string | URL, b: string | URL) {
    const res = await (origRename as (a: string | URL, b: string | URL) => Promise<void>)(a, b);
    if (!lockStolen && String(b).startsWith(leasePath + ".reclaim-")) {
      lockStolen = true;
      armed = true; // every later lease-path read is the occupant classification
      await origRm(lockPath, { recursive: true, force: true });
    }
    return res;
  } as typeof fs.promises.rename;
  (fs.promises as { readFile: unknown }).readFile = async function (p: string | URL, ...rest: unknown[]) {
    if (armed && String(p) === leasePath) {
      unreadableHit = true;
      throw Object.assign(new Error("simulated occupant EIO"), { code: "EIO" });
    }
    return (origReadFile as (p: string | URL, ...r: unknown[]) => Promise<unknown>)(p, ...rest);
  } as typeof fs.promises.readFile;
  let restoreHit = false;
  (fs.promises as { link: unknown }).link = async function (a: string | URL, b: string | URL) {
    const d = String(b);
    if (d === leasePath && String(a).includes(".reclaim-") && !restoreHit) {
      restoreHit = true;
      throw Object.assign(new Error("simulated EEXIST"), { code: "EEXIST" }); // an occupant exists at link time
    }
    return origLink(a as string, d);
  } as typeof fs.promises.link;
  syncBuiltinESMExports();
  const err = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => null, (e: Error) => e.message);
  restoreFs();
  assert.ok(restoreHit && unreadableHit, "the anomaly restore ran and the occupant read errored (intended path driven)");
  assert.ok(err !== null, "the takeover failed (stamp lost mid-swap)");
  assert.match(err as string, /moved-aside original occupant unreadable \(EIO\) — recovery source preserved/, `honest unreadable-occupant disclosure (got: ${String(err).slice(0, 200)})`);
  const names = await readdir(dir);
  const kept = names.filter((n) => n.includes(".reclaim-"));
  assert.equal(kept.length, 1, "`gone` preserved — an unreadable occupant proves no supersede");
  assert.equal(await readFile(join(dir, kept[0]!), "utf8"), stale, "byte-identical moved original survives");
});

test("P20c8-F5c: malformed occupant content is classified AMBIGUOUS — never a definitive 'stale'", async (t) => {
  // The occupant observed at the lease path is nonempty but unparseable:
  // the protocol calls such content AMBIGUOUS everywhere else (P20-F2),
  // so the classification must not report it as definitively "stale"
  // (pre-P20c8). The occupant IS observed present, so `gone` is still
  // superseded garbage — the fix is honesty in the message.
  const root = await mkdtemp(join(tmpdir(), "p20c8-f5c-ambiguous-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c8-f5c-ambiguous");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const lockPath = join(dir, "host.lease.lock");
  const stale = JSON.stringify({ pid: 111, token: "stale-owner" });
  await writeFile(leasePath, stale);
  const worker = await quickWorker(root);
  const ambiguous = `{"pid":${process.pid}`; // the P20-F2 truncated body
  let lockStolen = false;
  (fs.promises as { rename: unknown }).rename = async function (a: string | URL, b: string | URL) {
    const res = await (origRename as (a: string | URL, b: string | URL) => Promise<void>)(a, b);
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
      await writeFile(leasePath, ambiguous);
      throw Object.assign(new Error("simulated EEXIST"), { code: "EEXIST" });
    }
    return origLink(a as string, d);
  } as typeof fs.promises.link;
  syncBuiltinESMExports();
  const err = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => null, (e: Error) => e.message);
  restoreFs();
  assert.ok(restoreHit, "the anomaly restore actually ran (the test drove the intended path)");
  assert.ok(err !== null, "the takeover failed (stamp lost mid-swap)");
  assert.match(err as string, /moved-aside original occupied by ambiguous content \(no trustworthy pid\)/, `ambiguous content classified honestly (got: ${String(err).slice(0, 200)})`);
  assert.equal(await readFile(leasePath, "utf8"), ambiguous, "the ambiguous occupant was left untouched");
  const names = await readdir(dir);
  assert.ok(!names.some((n) => n.includes(".reclaim-")), "an OBSERVED occupant outranks the moved copy: `gone` reclaimed");
});

// ─── P20c11 (R6 audit): an UNREADABLE lease is not an EMPTY lease ───────────

test("P20c11-F1: persistent lease-read failure fails closed — an aged LIVE claim is never taken over", async (t) => {
  // The reproduced takeover: a live holder's claim ages past ABANDON
  // (lease mtime is never refreshed), a contender's readLease hits a
  // persistent non-ENOENT error, the old code classified the lease
  // abandoned-EMPTY, took over, and admitted a SECOND worker under the
  // live holder. New contract: a read error that outlives 3 bounded
  // retries THROWS — ownership that cannot be read cannot be judged.
  const root = await mkdtemp(join(tmpdir(), "p20c11-f1-readEIO-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c11-f1-readEIO");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const liveClaim = JSON.stringify({ pid: process.pid, token: "live-original", episodeId: "ep-c11-f1-readEIO", claimedAt: Date.now() - 60_000 });
  await writeFile(leasePath, liveClaim);
  const old = Date.now() / 1000 - 60; // past the 10s abandon bound — the exact pre-condition of the takeover
  await utimes(leasePath, old, old);
  const marker = join(root, "worker-started");
  const worker = join(root, "worker.sh");
  await writeFile(worker, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
  await chmod(worker, 0o755);
  let injectedReads = 0;
  (fs.promises as { readFile: unknown }).readFile = async function (p: string | URL, ...rest: unknown[]) {
    const raw = await origReadFile(p as Parameters<typeof origReadFile>[0], ...(rest as Parameters<typeof origReadFile> extends [unknown, ...infer R] ? R : never)) as string;
    if (resolve(String(p)) === resolve(leasePath) && raw === liveClaim) {
      injectedReads++; // ONLY the original live claim is unreadable; a replacement claim would read fine
      throw Object.assign(new Error("simulated lease EIO"), { code: "EIO" });
    }
    return raw;
  } as typeof fs.promises.readFile;
  syncBuiltinESMExports();
  const err = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => null, (e: Error) => e.message);
  restoreFs();
  assert.ok(injectedReads >= 3, `the error outlived the bounded retries (got ${injectedReads} injected reads)`);
  assert.match(err ?? "", /ownership is unreadable/, "a persistent lease-read error refuses activation rather than guessing EMPTY");
  assert.ok(!fs.existsSync(marker), "the second worker NEVER started under the live holder");
  assert.equal(await readFile(leasePath, "utf8"), liveClaim, "the unreadable live claim is left EXACTLY as found");
});

test("P20c11-F2: the tmp-stage sweep's own directory read fails closed — no sweep and no publish on the second readdir", async (t) => {
  // P20c10-F2 fails the FIRST readdir (reconcile). The second readdir
  // (the tmp sweep's inspection) is a separate fail-closed decision with
  // its own branch — removing it must be caught here: the sweep would
  // otherwise run blind and the fresh publish would proceed over
  // uninspected ownership.
  const root = await mkdtemp(join(tmpdir(), "p20c11-f2-readdir2-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c11-f2-readdir2");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  // A dead-owner staged tmp: a BLIND sweep (the mutation this test
  // kills) would unlink it, and the activation would proceed to publish.
  const deadStage = join(dir, "host.lease.tmp-99999999.deadstage");
  await writeFile(deadStage, "partial");
  const worker = await quickWorker(root);
  let readdirCalls = 0;
  (fs.promises as { readdir: unknown }).readdir = async function (p: string | URL, ...rest: unknown[]) {
    if (resolve(String(p)) === resolve(dir) && readdirCalls++ === 1) {
      // the SECOND readdir of the episode dir (the first is reconcile's)
      throw Object.assign(new Error("simulated sweep-inspection EIO"), { code: "EIO" });
    }
    return origReaddir(p as Parameters<typeof origReaddir>[0], ...(rest as Parameters<typeof origReaddir> extends [unknown, ...infer R] ? R : never)) as never;
  } as typeof fs.promises.readdir;
  syncBuiltinESMExports();
  const err = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} }).then(() => null, (e: Error) => e.message);
  restoreFs();
  assert.ok(readdirCalls >= 2, "the test actually reached the sweep's readdir (got " + readdirCalls + " calls)");
  assert.match(err ?? "", /cannot inspect tmp stages/, "the sweep fails closed on its own inspection error");
  assert.ok(await stat(deadStage).then(() => true, () => false), "no sweep destroys an uninspected stage");
  await assert.rejects(readFile(leasePath, "utf8"), { code: "ENOENT" }, "no fresh lease is published over an uninspected directory");
});

test("P20c11-F3: the realpath failure (P20c10-F1e) starts NO worker, and the NEXT activation succeeds cleanly", async (t) => {
  // P20c10-F1e asserted the refusal and no lease; this closes its two
  // remaining gaps: independently proving no WORKER ran, and that the
  // fail-closed was transient-safe (the episode is not wedged — the
  // next activation claims and completes).
  const root = await mkdtemp(join(tmpdir(), "p20c11-f3-realpath-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c11-f3-realpath");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const marker1 = join(root, "worker1-started");
  const worker1 = join(root, "worker1.sh");
  await writeFile(worker1, `#!/bin/sh\ntouch '${marker1}'\nexit 0\n`);
  await chmod(worker1, 0o755);
  const origRealpath = fs.promises.realpath.bind(fs.promises);
  let injected = false;
  (fs.promises as { realpath: unknown }).realpath = async function (p: string | URL, ...rest: unknown[]) {
    if (!injected && resolve(String(p)) === resolve(dir)) {
      injected = true;
      throw Object.assign(new Error("simulated realpath EIO"), { code: "EIO" });
    }
    return origRealpath(p as string, ...(rest as []));
  };
  syncBuiltinESMExports();
  const err = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker1, maxIterations: 1, log: () => {} }).then(() => null, (e: Error) => e.message);
  restoreFs();
  assert.ok(injected, "the realpath failure was injected");
  assert.match(err ?? "", /canonical identity/, "the activation refuses to key protection on an unresolved identity");
  assert.ok(!fs.existsSync(marker1), "the failed activation started NO worker");
  await assert.rejects(readFile(leasePath, "utf8"), { code: "ENOENT" }, "no lease published under an unresolved identity");
  // Not wedged: the next activation (no injection) claims and completes.
  const marker2 = join(root, "worker2-started");
  const worker2 = join(root, "worker2.sh");
  await writeFile(worker2, `#!/bin/sh\ntouch '${marker2}'\nexit 0\n`);
  await chmod(worker2, 0o755);
  await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker2, maxIterations: 1, log: () => {} });
  assert.ok(fs.existsSync(marker2), "the next activation ran its worker");
  await assert.rejects(readFile(leasePath, "utf8"), { code: "ENOENT" }, "and released cleanly");
});

test("P20c11-F4: a paused publisher's LIVE stage survives a later activation's sweep (in-process stage protection)", async (t) => {
  // P20c9-F2 (despite its title) only deleted an orphan; it never drove a
  // CONCURRENT stage. Here invocation A pauses inside its staged-publish
  // open(): its tmp predates invocation B's procStart, so B's own-pid
  // sweep rule ("pre-start same-pid tmp = dead namesake") would unlink
  // it — except the in-memory ACTIVE_STAGE_PATHS set (canonical episode
  // dir + basename, registered before the stage is opened) protects it.
  const root = await mkdtemp(join(tmpdir(), "p20c11-f4-livestage-"));
  t.after(() => { restoreFs(); return rm(root, { recursive: true, force: true }); });
  restoreFs();
  const epGraph = graphA("ep-c11-f4-livestage");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  const worker = await quickWorker(root);
  let stagePath = "";
  let opened = false;
  let created!: () => void;
  const createdP = new Promise<void>((r) => { created = r; });
  let gateOpen!: () => void;
  const gateP = new Promise<void>((r) => { gateOpen = r; });
  let sweepSeen = false;
  let gatePassed = false;
  const unlinkAttempts: string[] = [];
  (fs.promises as { open: unknown }).open = async function (p: string | URL, ...rest: unknown[]) {
    const handle = await origOpen(p as Parameters<typeof origOpen>[0], ...(rest as Parameters<typeof origOpen> extends [unknown, ...infer R] ? R : never)) as Awaited<ReturnType<typeof origOpen>>;
    if (!opened && resolve(String(p)).startsWith(resolve(leasePath) + ".tmp-")) {
      opened = true;
      stagePath = resolve(String(p));
      created();          // the stage exists with a now()-old mtime…
      await gateP;        // …and A freezes before writing/linking
    }
    return handle;
  } as typeof fs.promises.open;
  (fs.promises as { readdir: unknown }).readdir = async function (p: string | URL, ...rest: unknown[]) {
    const r = await origReaddir(p as Parameters<typeof origReaddir>[0], ...(rest as Parameters<typeof origReaddir> extends [unknown, ...infer R] ? R : never)) as Awaited<ReturnType<typeof origReaddir>>;
    if (!sweepSeen && opened && resolve(String(p)) === resolve(dir)) sweepSeen = true; // B has begun inspecting this episode dir
    return r as never;
  } as typeof fs.promises.readdir;
  (fs.promises as { unlink: unknown }).unlink = async function (p: string | URL) {
    // Record only DURING B's sweep window: after gateOpen(), A's own
    // staged-publish finally unlinks its stage as normal cleanup.
    if (sweepSeen && !gatePassed && stagePath !== "" && resolve(String(p)) === stagePath) unlinkAttempts.push(String(p));
    return origUnlink(p as Parameters<typeof origUnlink>[0]) as never;
  } as typeof fs.promises.unlink;
  syncBuiltinESMExports();
  const runOpts = () => ({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} });
  const a = runHostEpisode(runOpts()).then(() => "ok", (e: Error) => e.message);
  await createdP;
  const b = runHostEpisode(runOpts()); // B starts AFTER A's stage was created
  // wait for B to pass the inspection, then give its sweep its decisions
  for (let i = 0; i < 400 && !sweepSeen; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(sweepSeen, "invocation B reached the episode-directory inspection");
  await new Promise((r) => setTimeout(r, 150)); // B's sweep window
  gatePassed = true;
  gateOpen();
  const aResult = await a;
  await b;
  restoreFs();
  assert.equal(unlinkAttempts.length, 0, `B never tried to unlink A's live stage (attempts: ${unlinkAttempts.join(",")})`);
  assert.ok(aResult === "ok" || String(aResult).includes("contended"), `A resolves cleanly either way (won or disclosed contention), got: ${String(aResult).slice(0, 120)}`);
});
