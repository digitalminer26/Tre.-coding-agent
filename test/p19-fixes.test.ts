/**
 * P19 — named regressions for the two follow-up audit findings on bda9d1f.
 *
 * F1  (supervise.ts, major): the lease was created with writeFile(wx) —
 *     the CREATE was atomic, the WRITE that followed was not. A reader
 *     could observe a partial body ("{"), parse no pid, classify the
 *     lease stale, and TAKE OVER from a live creator. Fix: every lease
 *     publication stages the complete body (open wx + fsync) in a sibling
 *     tmp and links it in — the lease is COMPLETE or ABSENT, never
 *     partial; takeover replacement (under the lock) renames a staged
 *     tmp atomically. Unparseable fresh content (only a legacy/foreign
 *     writer can produce it under this protocol) is AMBIGUOUS: refused
 *     until the mtime abandon bound, then recovery-eligible.
 *
 * F2  (journal.ts, medium): createEpisodeLayout checked graph.json
 *     existence, then renamed — two concurrent first-creations both saw
 *     ENOENT and both renamed, last writer silently won. Fix: first
 *     publication goes through a no-replace link(); a racing loser
 *     judges the WINNER's bytes with the P18-A3 identity rule.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, writeFile, chmod, utimes, readdir, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEpisodeLayout } from "../src/episode/journal.js";
import { runHostEpisode } from "../src/host/supervise.js";

const graphA = (episodeId: string, goal = "p19 goal") => ({
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

// ─── F1: the published lease is COMPLETE or ABSENT ──────────────────────────

test("P19-F1: lease publication is staged+linked — a reader never sees a partial claim", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p19f1-atomic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const epGraph = graphA("ep-f1-atomic");
  await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const worker = await quickWorker(root);
  const leasePath = join(root, epGraph.episodeId, "host.lease");

  // Deterministically split the publisher between staging the tmp and
  // linking it in: while it is paused, the lease path must be ABSENT
  // (no partial marker) and the staged tmp must already hold the
  // COMPLETE, parseable claim. After resuming, the lease is complete.
  const originalLink = fs.promises.link;
  let phase = 0;
  const observations: Array<{ leaseMissing: boolean; tmpSize: number; tmpParses: boolean }> = [];
  (fs.promises as { link: unknown }).link = async function (existingPath: string, newPath: string) {
    if (String(newPath) === leasePath && phase === 0) {
      phase = 1;
      let leaseMissing = false;
      try { await readFile(leasePath, "utf8"); } catch { leaseMissing = true; }
      const raw = await readFile(String(existingPath), "utf8").catch(() => "");
      let tmpParses = false;
      try { tmpParses = typeof (JSON.parse(raw) as { pid?: number }).pid === "number"; } catch { /* not parseable */ }
      observations.push({ leaseMissing, tmpSize: raw.length, tmpParses });
    }
    return (originalLink as (a: string, b: string) => Promise<void>)(existingPath, newPath);
  };
  syncBuiltinESMExports();
  t.after(() => { (fs.promises as { link: unknown }).link = originalLink; syncBuiltinESMExports(); });

  const r = await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} });
  assert.ok(["accepted-finish", "max-iterations"].includes(r.result.stopped), `the run ran to a normal stop after the link resumed (${r.result.stopped})`);
  assert.equal(observations.length, 1, "the publisher's link moment was observed exactly once");
  assert.equal(observations[0]!.leaseMissing, true, "before the link the lease path is ABSENT — never a partial marker");
  assert.ok(observations[0]!.tmpParses && observations[0]!.tmpSize > 20, "the staged tmp holds the COMPLETE claim before it is linked");
});

test("P19-F1: an unparseable FRESH lease is AMBIGUOUS — activation refuses, file untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p19f1-ambig-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const epGraph = graphA("ep-f1-ambig");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  await writeFile(leasePath, "legacy foreign writer, not json"); // fresh mtime
  const worker = await quickWorker(root);
  const lines: string[] = [];
  await assert.rejects(
    () => runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: (l) => lines.push(l) }),
    /contended/,
    "a fresh unparseable lease is never proven-dead — activation fails closed",
  );
  assert.equal(await readFile(leasePath, "utf8"), "legacy foreign writer, not json", "the ambiguous lease is left EXACTLY as found");
  assert.ok(!lines.some((l) => /taking over/.test(l)), "no takeover of ambiguous content");
});

test("P19-F1: an unparseable lease PAST the abandon bound is recovery-eligible (disclosed)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p19f1-ambig-old-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const epGraph = graphA("ep-f1-ambig-old");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const leasePath = join(dir, "host.lease");
  await writeFile(leasePath, "legacy foreign writer, not json");
  const old = Date.now() / 1000 - 60; // past the 10s abandon bound
  await utimes(leasePath, old, old);
  const worker = await quickWorker(root);
  const lines: string[] = [];
  await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => /stale lease .* taking over/.test(l)), "the recovery is disclosed");
  // The recovered lease rode OUR ownership token for the whole run and was
  // released by normal cleanup (the lease path is gone or no longer the
  // ambiguous content) — never left as an unparseable marker.
  const after = await readFile(leasePath, "utf8").catch(() => "");
  assert.notEqual(after, "legacy foreign writer, not json", "the ambiguous content never survives the recovery run");
});

test("P19-F1: an orphaned lease tmp older than the bound is swept; a fresh one survives", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p19f1-sweep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const epGraph = graphA("ep-f1-sweep");
  const dir = await createEpisodeLayout(root, epGraph.episodeId, epGraph as never);
  const oldTmp = join(dir, "host.lease.tmp-111.crash");
  const freshTmp = join(dir, "host.lease.tmp-222.live");
  await writeFile(oldTmp, "{ orphan");
  await writeFile(freshTmp, "{ live-staging");
  const old = Date.now() / 1000 - 60;
  await utimes(oldTmp, old, old);
  const worker = await quickWorker(root);
  await runHostEpisode({ episodesRoot: root, graph: epGraph as never, taskId: "t1", grantedBy: "test", workerCommand: worker, maxIterations: 1, log: () => {} });
  const names = await readdir(dir);
  assert.ok(!names.includes("host.lease.tmp-111.crash"), "the crash-leaked tmp is reclaimed");
  assert.ok(names.includes("host.lease.tmp-222.live"), "a fresh tmp (possibly a live publisher) is never touched");
});

// ─── F2: the FIRST graph.json publish is a no-replace link ─────────────────

test("P19-F2: concurrent first-creation with DIFFERENT seeds — one wins, the loser is refused (no silent overwrite)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p19f2-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gA = graphA("ep-f2", "A: first writer");
  const gB = graphA("ep-f2", "B: racing writer");
  const results = await Promise.allSettled([
    createEpisodeLayout(root, "ep-f2", gA as never),
    createEpisodeLayout(root, "ep-f2", gB as never),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly ONE creator publishes the commit marker");
  assert.equal(rejected.length, 1, "the racing loser is refused, never a silent last-write-wins");
  const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
  assert.match(reason.message, /DIFFERENT graph/, "the loser is refused with the P18-A3 identity error");
  // EITHER seed may win the link race — the invariant is that the file is
  // EXACTLY the winner's desired state (the fulfilled caller's), never a
  // mix and never the loser's.
  const winnerSeed = results.find((r) => r.status === "fulfilled") === results[0] ? gA : gB;
  const final = JSON.parse(await readFile(join(root, "ep-f2", "graph.json"), "utf8")) as { goal: string };
  assert.equal(final.goal, winnerSeed.goal, "the file is EXACTLY the winner's desired state");
});

test("P19-F2: concurrent first-creation with the SAME seed — both succeed (idempotent), one marker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p19f2-same-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const g = graphA("ep-f2-same", "same desired state");
  const results = await Promise.allSettled([
    createEpisodeLayout(root, "ep-f2-same", g as never),
    createEpisodeLayout(root, "ep-f2-same", structuredClone(g) as never),
  ]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"], "identical seeds: both callers succeed");
  const raw = await readFile(join(root, "ep-f2-same", "graph.json"), "utf8");
  assert.equal(JSON.parse(raw).goal, "same desired state");
  const leftovers = (await readdir(join(root, "ep-f2-same"))).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "no staging tmp survives a successful publish");
});

test("P19-F2: the linked marker is complete on first sight (staged write precedes link)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p19f2-complete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const g = graphA("ep-f2-complete");
  // Mirror the publisher's contract at the primitive level: the staged
  // file must be fully serialized+synced BEFORE the link exposes it.
  const target = join(root, "graph.json");
  const tmp = `${target}.tmp-${process.pid}-probe`;
  const handle = await open(tmp, "wx", 0o644);
  await handle.writeFile(JSON.stringify(g, null, 2), "utf8");
  await handle.sync();
  await handle.close();
  await fs.promises.link(tmp, target);
  const seen = await readFile(target, "utf8");
  assert.equal(seen, JSON.stringify(g, null, 2), "the exposed marker is byte-complete");
});
