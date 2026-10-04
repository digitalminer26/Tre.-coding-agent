/**
 * Worker registry — the completed-worker LIFECYCLE at the registry level
 * (src/cli/workers.ts). Companion to the main.ts fix that stops one-shot
 * workers from deleting their status file on exit: `done`/`failed` files
 * now STAY on disk until the TUI's pruneWorkerDir reclaims them after the
 * stale TTL. These tests pin that contract from the reader/pruner side:
 *
 *   - a done/failed file persists and is readable (status + model kept);
 *   - a FRESH done file survives pruneWorkerDir (no premature reclamation);
 *   - a STALE done file is dropped by readWorkerStatuses AND deleted by
 *     pruneWorkerDir (the only path back to a clean dir);
 *   - done and running files coexist; after the TTL only the freshened
 *     running one remains;
 *   - a corrupt file next to valid ones is ignored by the reader and
 *     removed by the pruner.
 *
 * All tests use a FIXED `now` passed explicitly to the reader/pruner —
 * deterministic, no real-time sleeps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { join } from "node:path";
import {
  WORKER_STALE_MS,
  pruneWorkerDir,
  readWorkerStatuses,
  workerFilePath,
  writeWorkerStatus,
} from "../src/cli/workers.js";
import type { WorkerStatus } from "../src/types.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/** A minimal WorkerStatus (id/model/status are the required contract fields). */
const status = (over: Partial<WorkerStatus> = {}): WorkerStatus => ({
  id: "w1",
  model: "gpt-6-luna",
  endpoint: "http://a/v1",
  status: "running",
  turn: 3,
  activity: "bash",
  updatedAt: 0,
  startedAt: 0,
  cwd: "/w",
  task: "t",
  ...over,
});

/** A fresh temp worker dir; cleaned up after the test. */
const tmpDir = (t: { after: (fn: () => void) => void }): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-worker-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const find = (statuses: WorkerStatus[], id: string): WorkerStatus | undefined =>
  statuses.find((s) => s.id === id);

// ── 1+2: done/failed files persist and are readable ────────────────────────

test("a done status file persists: readWorkerStatuses returns it with status and model", (t) => {
  const dir = tmpDir(t);
  const now = Date.now();
  assert.ok(writeWorkerStatus(dir, status({ status: "done", updatedAt: now, startedAt: now })));
  const got = readWorkerStatuses(dir, now);
  assert.equal(got.length, 1);
  const first = got[0];
  assert.ok(first);
  assert.equal(first.status, "done");
  assert.equal(first.model, "gpt-6-luna");
  assert.equal(first.id, "w1");
  assert.equal(fs.existsSync(workerFilePath(dir, "w1")), true, "file still on disk");
});

test("a failed status file persists the same way (status 'failed')", (t) => {
  const dir = tmpDir(t);
  const now = Date.now();
  assert.ok(writeWorkerStatus(dir, status({ status: "failed", updatedAt: now, startedAt: now })));
  const got = readWorkerStatuses(dir, now);
  assert.equal(got.length, 1);
  const first = got[0];
  assert.ok(first);
  assert.equal(first.status, "failed");
  assert.equal(first.model, "gpt-6-luna");
  assert.ok(fs.existsSync(workerFilePath(dir, "w1")), "file still on disk");
});

// ── 3: a fresh done file SURVIVES pruneWorkerDir ───────────────────────────

test("a fresh done file survives pruneWorkerDir (now ≈ updatedAt)", (t) => {
  const dir = tmpDir(t);
  const now = Date.now();
  assert.ok(writeWorkerStatus(dir, status({ status: "done", updatedAt: now, startedAt: now })));
  const removed = pruneWorkerDir(dir, now);
  assert.equal(removed, 0, "nothing stale to prune");
  assert.ok(fs.existsSync(workerFilePath(dir, "w1")), "done file NOT deleted");
  const got = readWorkerStatuses(dir, now);
  assert.equal(got.length, 1);
  const first = got[0];
  assert.ok(first);
  assert.equal(first.status, "done");
});

test("the exact stale-TTL boundary remains fresh (reader and pruner agree)", (t) => {
  const dir = tmpDir(t);
  const now = Date.now();
  const boundary = now - WORKER_STALE_MS;
  assert.ok(writeWorkerStatus(dir, status({ status: "done", updatedAt: boundary, startedAt: boundary })));
  assert.equal(readWorkerStatuses(dir, now).length, 1, "age exactly TTL is not stale");
  assert.equal(pruneWorkerDir(dir, now), 0, "strictly greater-than TTL required to prune");
  assert.ok(fs.existsSync(workerFilePath(dir, "w1")));
});

// ── 4: a STALE done file is dropped by the reader AND deleted by the pruner ─

test("a stale done file is dropped by readWorkerStatuses and deleted by pruneWorkerDir", (t) => {
  const dir = tmpDir(t);
  const now = Date.now();
  const staleAt = now - WORKER_STALE_MS - 1_000;
  assert.ok(
    writeWorkerStatus(dir, status({ status: "done", updatedAt: staleAt, startedAt: staleAt })),
  );
  // The reader drops it (stale as of `now`).
  assert.deepEqual(readWorkerStatuses(dir, now), [], "stale done entry dropped");
  // The pruner deletes the file.
  const removed = pruneWorkerDir(dir, now);
  assert.equal(removed, 1, "stale file removed");
  assert.ok(!fs.existsSync(workerFilePath(dir, "w1")), "stale file gone from disk");
  assert.equal(readWorkerStatuses(dir, now).length, 0);
});

test("a stale running file (crashed worker) is dropped and reclaimed", (t) => {
  const dir = tmpDir(t);
  const now = Date.now();
  const staleAt = now - WORKER_STALE_MS - 1;
  assert.ok(writeWorkerStatus(dir, status({ id: "crashed", status: "running", updatedAt: staleAt })));
  assert.deepEqual(readWorkerStatuses(dir, now), [], "stale crashed worker is no longer live");
  assert.equal(pruneWorkerDir(dir, now), 1);
  assert.ok(!fs.existsSync(workerFilePath(dir, "crashed")));
});

// ── 5: done + running coexist; after the TTL only the freshened running one ─

test("done + running in one dir: both fresh, then only the freshened running one", (t) => {
  const dir = tmpDir(t);
  const now = Date.now();
  assert.ok(
    writeWorkerStatus(dir, status({ id: "done-w", status: "done", updatedAt: now, startedAt: now })),
  );
  assert.ok(
    writeWorkerStatus(dir, status({ id: "run-w", status: "running", updatedAt: now, startedAt: now })),
  );
  // Both are fresh as of `now`.
  const fresh = readWorkerStatuses(dir, now);
  assert.equal(fresh.length, 2);
  assert.ok(find(fresh, "done-w"), "done worker present while fresh");
  assert.ok(find(fresh, "run-w"), "running worker present while fresh");

  // Time passes beyond the TTL; the running worker refreshes itself,
  // the done worker does not (it is finished — nobody rewrites it).
  const later = now + WORKER_STALE_MS + 1_000;
  assert.ok(
    writeWorkerStatus(dir, status({ id: "run-w", status: "running", updatedAt: later, startedAt: now })),
  );
  const afterTtl = readWorkerStatuses(dir, later);
  assert.equal(afterTtl.length, 1, "only the freshened running worker remains");
  const only = afterTtl[0];
  assert.ok(only);
  assert.equal(only.id, "run-w");
  assert.equal(only.status, "running");
  // The stale done file is still on disk (pruning is the TUI's job, not the
  // reader's) — but the pruner reclaims it.
  assert.ok(fs.existsSync(workerFilePath(dir, "done-w")), "stale done file still on disk");
  assert.equal(pruneWorkerDir(dir, later), 1, "pruner reclaims the stale done file");
  assert.ok(!fs.existsSync(workerFilePath(dir, "done-w")));
  assert.ok(fs.existsSync(workerFilePath(dir, "run-w")), "fresh running file untouched");
});

// ── 6: a corrupt file is ignored by the reader and removed by the pruner ───

test("a corrupt file next to valid ones is ignored by the reader, removed by the pruner", (t) => {
  const dir = tmpDir(t);
  const now = Date.now();
  assert.ok(
    writeWorkerStatus(dir, status({ id: "good", status: "done", updatedAt: now, startedAt: now })),
  );
  fs.writeFileSync(path.join(dir, "junk.json"), "{ not valid json", "utf8");
  // Reader: the corrupt file is skipped, the valid one is returned.
  const got = readWorkerStatuses(dir, now);
  assert.equal(got.length, 1);
  const first = got[0];
  assert.ok(first);
  assert.equal(first.id, "good");
  // Pruner: removes exactly the junk file; the fresh valid file survives.
  const removed = pruneWorkerDir(dir, now);
  assert.equal(removed, 1, "only the corrupt file removed");
  assert.ok(!fs.existsSync(path.join(dir, "junk.json")), "corrupt file gone");
  assert.ok(fs.existsSync(workerFilePath(dir, "good")), "valid file untouched");
  assert.equal(readWorkerStatuses(dir, now).length, 1);
});

test("parseable but invalid JSON status is skipped then pruned", (t) => {
  const dir = tmpDir(t);
  const now = Date.now();
  fs.writeFileSync(path.join(dir, "invalid.json"), JSON.stringify({ model: "missing-id" }), "utf8");
  assert.deepEqual(readWorkerStatuses(dir, now), []);
  assert.equal(pruneWorkerDir(dir, now), 1);
  assert.ok(!fs.existsSync(path.join(dir, "invalid.json")));
});

test("non-JSON entries and interrupted temp files are ignored by registry read/prune", (t) => {
  const dir = tmpDir(t);
  const now = Date.now();
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a status", "utf8");
  fs.writeFileSync(path.join(dir, "worker.json.123.tmp"), "partial", "utf8");
  assert.deepEqual(readWorkerStatuses(dir, now), []);
  assert.equal(pruneWorkerDir(dir, now), 0);
  assert.ok(fs.existsSync(path.join(dir, "notes.txt")));
  assert.ok(fs.existsSync(path.join(dir, "worker.json.123.tmp")));
});

test("missing worker dir is a soft no-op for reader and pruner", (t) => {
  const dir = join(tmpDir(t), "missing");
  assert.deepEqual(readWorkerStatuses(dir, Date.now()), []);
  assert.equal(pruneWorkerDir(dir, Date.now()), 0);
});

test("worker statuses are returned oldest-start first", (t) => {
  const dir = tmpDir(t);
  const now = Date.now();
  assert.ok(writeWorkerStatus(dir, status({ id: "new", startedAt: now, updatedAt: now })));
  assert.ok(writeWorkerStatus(dir, status({ id: "old", startedAt: now - 10, updatedAt: now })));
  assert.deepEqual(readWorkerStatuses(dir, now).map((s) => s.id), ["old", "new"]);
});
