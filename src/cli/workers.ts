/**
 * Worker registry — the shared on-disk state that gives the TUI visibility
 * into `tre. run` workers running on OTHER endpoints.
 *
 * WHY THIS EXISTS (endpoint visibility): when a user fans out work across
 * multiple independent endpoints (one `tre. run` per endpoint), the
 * orchestrator's TUI has no way to see which endpoints are working or how
 * far each worker has gotten. This module is the bridge: a worker writes a
 * small JSON status file into a shared dir (`~/.tre/workers/`) on startup,
 * refreshes it as it works, and marks it done/failed on exit. The TUI polls
 * the dir and renders the live set in a `workers` bottom field.
 *
 * The CONTRACT is `WorkerStatus` (src/types.ts). This module owns the
 * registry mechanics — the dir, the per-worker file, the atomic write, the
 * read-and-prune-stale — so the WRITER (cli/main.ts) and the READER
 * (tui/state.ts + tui/run.tsx) share one implementation and neither imports
 * the other.
 *
 * I3 throughout: a missing/corrupt/unwritable dir or file is DATA, never a
 * crash. `writeWorkerStatus` is best-effort (returns a bool);
 * `readWorkerStatuses` returns `[]` on any failure and drops stale/corrupt
 * entries. A worker that crashes without cleaning up is reclaimed by the
 * STALE TTL (the TUI stops showing it after `WORKER_STALE_MS` of silence).
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkerStatus } from "../types.js";

/** The dir name under `~/.tre/` that holds the per-worker status files. */
export const WORKER_DIR_NAME = "workers";

/**
 * A worker whose status file has not been refreshed within this window is
 * STALE — it crashed or was killed (it never wrote "done"/"failed"). The
 * reader drops stale entries and `pruneWorkerDir` deletes their files, so a
 * dead worker never lingers in the TUI. Generous enough to absorb a single
 * slow LLM turn (the writer refreshes every turn), tight enough that a dead
 * worker disappears within a minute or two.
 */
export const WORKER_STALE_MS = 90_000;

/** The worker dir: `~/.tre/workers/` (`home` is injectable for tests). */
export function workerDir(home: string = homedir()): string {
  return join(home, ".tre", WORKER_DIR_NAME);
}

/** The status-file path for one worker: `<dir>/<id>.json`. */
export function workerFilePath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/**
 * A stable, collision-resistant worker id: `worker-<pid>-<time36>`. The pid
 * is unique per process; the time suffix disambiguates rapid relaunches that
 * reuse a pid. The id is also the filename stem, so it must stay within the
 * filesystem's filename charset (it is — digits, dashes, base36).
 */
export function workerId(pid: number = process.pid): string {
  return `worker-${pid}-${Date.now().toString(36)}`;
}

/**
 * Write `status` to its file atomically (write a temp file, then rename over
 * the target — a reader never sees a half-written file). Best-effort (I3):
 * the parent dir is created when missing, and ANY failure (read-only home,
 * disk full) is swallowed — the worker keeps running, it just is not visible
 * for that tick. Returns true when the file was written, false otherwise.
 */
export function writeWorkerStatus(dir: string, status: WorkerStatus): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const file = workerFilePath(dir, status.id);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(status, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Remove one worker's status file (the worker calls this on exit). No-op
 *  (false) when the file is already gone. */
export function removeWorkerStatus(dir: string, id: string): boolean {
  try {
    unlinkSync(workerFilePath(dir, id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate + coerce an unknown parsed value into a `WorkerStatus`, or null
 * when it is not one (a corrupt/hand-edited file). Pure — no I/O — so the
 * reader can share it and tests can exercise it directly. Missing/invalid
 * required fields (id, model, status) reject; the rest get safe defaults so
 * one bad field does not drop an otherwise-valid entry.
 */
export function normalizeWorkerStatus(parsed: unknown): WorkerStatus | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.length === 0) return null;
  if (typeof o.model !== "string" || o.model.length === 0) return null;
  const status =
    o.status === "running" || o.status === "done" || o.status === "failed"
      ? o.status
      : "running";
  const num = (v: unknown, d: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  const str = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
  return {
    id: o.id,
    model: o.model,
    endpoint: str(o.endpoint, ""),
    status,
    turn: num(o.turn, 0),
    activity: str(o.activity, ""),
    updatedAt: num(o.updatedAt, 0),
    startedAt: num(o.startedAt, 0),
    cwd: str(o.cwd, ""),
    task: str(o.task, ""),
  };
}

/**
 * Read every live worker status in `dir` (default `~/.tre/workers/`). A
 * missing dir, an unreadable file, a corrupt file, or a STALE entry (no
 * refresh within `WORKER_STALE_MS` of `now`) is skipped — the result is the
 * set of workers that are genuinely live, oldest-start first. Never throws.
 * `now` is injectable for tests.
 */
export function readWorkerStatuses(dir: string = workerDir(), now: number = Date.now()): WorkerStatus[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: WorkerStatus[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const s = normalizeWorkerStatus(parsed);
    if (s === null) continue;
    if (now - s.updatedAt > WORKER_STALE_MS) continue;
    out.push(s);
  }
  out.sort((a, b) => a.startedAt - b.startedAt);
  return out;
}

/**
 * Delete the STALE files in `dir` (no refresh within `WORKER_STALE_MS` of
 * `now`), returning how many were removed. The TUI calls this opportunistically
 * so a crashed worker's file does not accumulate. A missing dir or an
 * unwritable file is a no-op (I3). `now` is injectable for tests.
 */
export function pruneWorkerDir(dir: string = workerDir(), now: number = Date.now()): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // A file we cannot even parse is junk — remove it.
      try {
        unlinkSync(file);
        removed += 1;
      } catch {
        /* leave it */
      }
      continue;
    }
    const s = normalizeWorkerStatus(parsed);
    const stale = s === null || now - s.updatedAt > WORKER_STALE_MS;
    if (stale) {
      try {
        unlinkSync(file);
        removed += 1;
      } catch {
        /* leave it */
      }
    }
  }
  return removed;
}
