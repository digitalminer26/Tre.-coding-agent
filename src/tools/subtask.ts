/**
 * The `subtask` tool — first-class subtask tracking for multi-part work.
 *
 * The agent breaks a request into subtasks (create them up front), marks
 * them in-progress as it starts and done/failed as it finishes. The list is
 * persisted to `~/.tre/subtasks/<session-id>.json` (session-scoped, the same
 * scheme as the workers registry in src/cli/workers.ts) so it survives
 * across runs, and every successful call returns the full list in
 * `details.subtasks` — the TUI's `applyEvent` (tool_execution_end) reads it
 * to drive the `subtasks` bottom field (`subtasks: 2/5 <active name>`).
 *
 * The tool is constructed with the session id (createSubtaskTool) — the
 * model never sees it, mirroring createBashTool's cwd injection.
 *
 * Cross-process safety: each read-modify-write takes a per-session lock
 * file (`<list>.lock`, O_EXCL) so a second process operating on the SAME
 * session id (two tre. invocations sharing a session file) serializes on
 * the file instead of losing each other's updates — the in-process
 * `executionMode: "sequential"` only serializes one process's batch. The
 * holder HEARTBEATS the lock (mtime refresh every LOCK_REFRESH_MS) for as
 * long as it holds it, so a LIVE holder — even one whose critical section
 * runs longer than the stale window — is never mistaken for a dead one:
 * only a holder that has been SILENT for `staleAfterMs` (crashed, kill -9)
 * is claimable. The lock is best-effort (an unacquirable lock degrades to
 * the old behavior rather than failing the call).
 *
 * I3: never throws for expected failures — bad args, unknown ids, corrupt
 * or unwritable files all become isError RESULTS the model reads. Writes are
 * atomic (tmp + rename) so a crash mid-write cannot leave a corrupt file.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { SubtaskInfo, Tool, ToolResult } from "../types.js";

/** The subtask dir: `~/.tre/subtasks/` (`home` is injectable for tests). */
export function subtaskDir(home: string = homedir()): string {
  return join(home, ".tre", "subtasks");
}

/** The list-file path for one session: `<dir>/<session-id>.json`. */
export function subtaskFilePath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.json`);
}

/** The per-session lock-file path: `<dir>/<session-id>.json.lock`. */
export function subtaskLockPath(dir: string, sessionId: string): string {
  return `${subtaskFilePath(dir, sessionId)}.lock`;
}

/**
 * The on-disk shape. `items` is the ordered subtask list (ids are 1-based
 * positions, assigned by `create`); `updatedAt` is the last write (ms).
 */
export interface SubtaskFile {
  items: SubtaskInfo[];
  updatedAt: number;
}

const STATUSES: readonly SubtaskInfo["status"][] = [
  "queued",
  "in-progress",
  "done",
  "failed",
];

/**
 * Validate + coerce an unknown parsed value into a `SubtaskFile`, or null
 * when it is not one (a corrupt/hand-edited file). Pure — no I/O — so tests
 * can exercise it directly. Missing/invalid `items` (non-array) reject; each
 * item gets safe defaults (id falls back to its 1-based position, unknown
 * status → "queued") so one bad field does not drop the whole list.
 */
export function normalizeSubtaskFile(parsed: unknown): SubtaskFile | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (!Array.isArray(o.items)) return null;
  const items: SubtaskInfo[] = [];
  for (let i = 0; i < o.items.length; i++) {
    const it = o.items[i];
    if (it === null || typeof it !== "object" || Array.isArray(it)) continue;
    const r = it as Record<string, unknown>;
    const id =
      typeof r.id === "number" && Number.isFinite(r.id) ? Math.round(r.id) : i + 1;
    const name = typeof r.name === "string" ? r.name : "";
    const status = STATUSES.includes(r.status as SubtaskInfo["status"])
      ? (r.status as SubtaskInfo["status"])
      : "queued";
    items.push({ id, name, status });
  }
  const updatedAt =
    typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt) ? o.updatedAt : 0;
  return { items, updatedAt };
}

/**
 * Read the subtask list for `sessionId` from `dir`. I3: never throws — a
 * missing file yields an EMPTY list (not null: "no subtasks yet" is a valid
 * state), and a corrupt file yields the empty list too. NOTE: this LENIENT
 * reader is for read-only consumers; destructive read-modify-writes (the
 * tool's create/mark) use `readSubtaskState` instead, which distinguishes
 * corrupt from missing so a bad read can never silently destroy the file it
 * failed to read.
 */
export function readSubtasks(dir: string, sessionId: string): SubtaskFile {
  const empty: SubtaskFile = { items: [], updatedAt: 0 };
  try {
    const raw = readFileSync(subtaskFilePath(dir, sessionId), "utf8");
    const norm = normalizeSubtaskFile(JSON.parse(raw));
    return norm ?? empty;
  } catch {
    return empty;
  }
}

/**
 * The read state of the persisted list — the three cases a destructive
 * write must distinguish (audit fix: `readSubtasks` collapsed them, so a
 * corrupt file was silently treated as "no subtasks yet" and the next
 * `create` OVERWROTE the only copy of the user's list):
 * - `missing` — no file (a true first use; safe to create).
 * - `ok` — a valid list (the normal read-modify-write).
 * - `corrupt` — a file that exists but cannot be read or is not a valid
 *   list. The caller must NOT silently replace it: `create`/`mark` refuse
 *   with a result that names the file (the user can inspect or delete it),
 *   so a bad read can never destroy the data it failed to read.
 */
export type SubtaskReadState =
  | { status: "missing" }
  | { status: "ok"; file: SubtaskFile }
  | { status: "corrupt" };

/** Read the list, distinguishing missing / valid / corrupt (never throws). */
export function readSubtaskState(dir: string, sessionId: string): SubtaskReadState {
  let raw: string;
  try {
    raw = readFileSync(subtaskFilePath(dir, sessionId), "utf8");
  } catch {
    return { status: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "corrupt" };
  }
  const norm = normalizeSubtaskFile(parsed);
  return norm === null ? { status: "corrupt" } : { status: "ok", file: norm };
}

/**
 * Write the subtask list for `sessionId` to `dir` atomically (tmp + rename
 * — a reader never sees a half-written file). Best-effort (I3): the parent
 * dir is created when missing, and ANY failure (read-only home, disk full)
 * is swallowed — the call still reports the in-memory list, it just does
 * not persist. Returns true when the file was written.
 */
export function writeSubtasks(dir: string, sessionId: string, file: SubtaskFile): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const file_ = subtaskFilePath(dir, sessionId);
    const tmp = `${file_}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
    renameSync(tmp, file_);
    return true;
  } catch {
    return false;
  }
}

/** A claimed lock: the file path + the token written into it. */
export interface SubtaskLock {
  lock: string;
  token: string;
  /** Stops the heartbeat (called by `releaseSubtaskLock` and on abort). */
  stopHeartbeat: () => void;
}

/** How often the holder refreshes the lock's mtime (the heartbeat). */
const LOCK_REFRESH_MS = 5_000;

/** A lock file's content: the holder's pid + claim time (diagnostics). */
function lockToken(): string {
  return `${process.pid}:${Date.now()}`;
}

/**
 * Claim the per-session lock file `<list>.lock` (O_EXCL — atomic on every
 * filesystem Node supports) and START HEARTBEATING it: a refresh interval
 * re-touches the lock's mtime every `LOCK_REFRESH_MS` for as long as the
 * lock is held. That is what makes the stale claim below safe — a LIVE
 * holder always looks fresh, no matter how long its critical section runs,
 * so only a holder that has been SILENT for `staleAfterMs` (crashed,
 * kill -9 — its interval died with it) is ever claimable. (An mtime-only
 * claim check without the heartbeat would let a second process steal a
 * live lock the moment a call ran longer than the window.)
 *
 * `signal` (the run's abort) stops the heartbeat early — an aborted run
 * must not keep re-touching a lock it no longer needs (the release in the
 * caller's `finally` removes the file outright).
 *
 * Returns the claim when acquired, null when the lock could not be
 * acquired (a LIVE holder, or the dir is not writable — the caller then
 * proceeds WITHOUT the lock: the degraded behavior is the pre-lock
 * behavior, never a failed call).
 */
export function acquireSubtaskLock(
  dir: string,
  sessionId: string,
  staleAfterMs = 30_000,
  signal?: AbortSignal,
  /** Injectable heartbeat period (tests use a short value); default 5s. */
  refreshMs = LOCK_REFRESH_MS,
): SubtaskLock | null {
  const lock = subtaskLockPath(dir, sessionId);
  const token = lockToken();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(dir, { recursive: true }); // openSync does not create parents
      const fd = openSync(lock, "wx");
      fsyncSync(fd);
      writeFileSync(fd, token, "utf8");
      closeSync(fd);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // The dir cannot be created/written (read-only home): no lock at all.
        return null;
      }
      // EEXIST: a lock is present — stale? A lock whose mtime is older than
      // `staleAfterMs` belongs to a SILENT holder: a live one heartbeats
      // within LOCK_REFRESH_MS, so anything older than the (much larger)
      // stale window is dead. Claim it and retry.
      try {
        const st = statSync(lock);
        if (Date.now() - st.mtimeMs < staleAfterMs) return null;
        unlinkSync(lock);
      } catch {
        // The lock vanished between the open and the stat (the other
        // process released it) — retry the claim.
      }
      continue;
    }
    // Claimed — heartbeat until release/abort. unref'd so the interval
    // never keeps the process alive.
    const heartbeat = setInterval(() => {
      try {
        // Refresh ONLY our own lock — if it was stale-claimed and re-created
        // by another process meanwhile, re-touching it would extend THEIR
        // hold (the token check mirrors releaseSubtaskLock).
        if (readFileSync(lock, "utf8") !== token) return;
        const now = new Date();
        utimesSync(lock, now, now);
      } catch {
        // The lock is gone (released/stale-claimed) — nothing to refresh.
      }
    }, refreshMs);
    (heartbeat as { unref?: () => void }).unref?.();
    const stopHeartbeat = (): void => {
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", stopHeartbeat);
    };
    signal?.addEventListener("abort", stopHeartbeat, { once: true });
    return { lock, token, stopHeartbeat };
  }
  return null;
}

/**
 * Release a lock claimed by `acquireSubtaskLock`. Best-effort (I3): a lock
 * that is already gone (stale-claimed by another process while we were
 * working) is NOT re-created — only the exact token we wrote is removed, so
 * a re-claimed lock belonging to someone else survives.
 */
export function releaseSubtaskLock(claim: SubtaskLock | null): void {
  if (claim === null) return;
  claim.stopHeartbeat();
  try {
    if (readFileSync(claim.lock, "utf8") !== claim.token) return;
    unlinkSync(claim.lock);
  } catch {
    // Already gone (released / stale-claimed) — nothing to do.
  }
}

/**
 * The one-line-per-item summary the model reads, plus the trailing
 * `progress: done/total` line. Shared by every action's result so the model
 * always sees the same shape.
 */
export function formatSubtaskSummary(items: SubtaskInfo[]): string {
  if (items.length === 0) return "(no subtasks)";
  const done = items.filter((i) => i.status === "done").length;
  const lines = items.map(
    (i) => `${i.id}. ${i.name} (${i.status})`,
  );
  lines.push(`progress: ${done}/${items.length}`);
  return lines.join("\n");
}

/** Sanitize a string for use as a filename component (I3: never throws). */
function safeStemPart(s: string): string {
  const clean = s.replace(/[^A-Za-z0-9._-]/g, "_");
  return clean.length > 0 ? clean : "default";
}

/**
 * Derive a collision-resistant filename stem from a session id.
 * `sessionId` is the session file's full (absolute) path — or a bare
 * basename. The stem is the sanitized basename PLUS a short SHA-256 of the
 * FULL path, so two sessions in different directories that share a filename
 * get DIFFERENT stems (basename-only scoping would collide them onto one
 * list — the audit finding). The hash is stable for a given path, so a
 * resumed session keeps the same list file.
 */
export function subtaskKey(sessionId: string): string {
  const base = safeStemPart(basename(sessionId));
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
  return `${base}-${digest}`;
}

const text = (t: string): ToolResult["content"] => [{ type: "text", text: t }];

/**
 * Build the `subtask` tool bound to a session. `sessionId` is the session
 * file's PATH (the driver injects it — the model never sees it). The list
 * file is keyed by `subtaskKey(sessionId)` — the sanitized basename plus a
 * short hash of the full path — so two sessions in different directories
 * with the same filename do NOT collide onto one list. `home` is injectable
 * for tests (default `os.homedir()`).
 *
 * `persist: false` makes the tool IN-MEMORY-ONLY: the list lives in the
 * tool's closure and is never written to disk. The driver uses this for
 * sessionless runs (no session file) — the old behavior keyed every such
 * run under the shared "default" file, so two unrelated sessionless runs
 * on the same machine clobbered each other's lists. In-memory is the safe
 * default: the list still works for the run's lifetime (create → mark →
 * list round-trips), it just does not survive the process.
 */
export function createSubtaskTool(
  sessionId: string,
  home: string = homedir(),
  persist: boolean = true,
): Tool {
  const dir = subtaskDir(home);
  const sid = subtaskKey(sessionId);
  // In-memory list for `persist: false` (sessionless runs).
  let mem: SubtaskFile = { items: [], updatedAt: 0 };
  const writeLocal = (f: SubtaskFile): void => {
    if (persist) {
      writeSubtasks(dir, sid, f);
    } else {
      mem = f;
    }
  };
  return {
    name: "subtask",
    description:
      "Track subtasks for multi-part work. Actions: 'create' (items: string[] — " +
      "replaces the whole list, e.g. when planning a task), 'list' (shows the " +
      "current list), 'mark' (id + status — update one subtask). Statuses: " +
      "queued, in-progress, done, failed. Returns the current list with a " +
      "progress line (done/total). The TUI shows progress in the bottom " +
      "display.",
    // Subtask operations are read-modify-write on one per-session file;
    // serialize batches to prevent lost updates and temp-file rename races.
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "'create' | 'list' | 'mark'",
          enum: ["create", "list", "mark"],
        },
        items: {
          type: "array",
          items: { type: "string" },
          description: "Subtask names (for 'create' — replaces the whole list)",
        },
        id: {
          type: "integer",
          description: "Subtask id (for 'mark')",
        },
        status: {
          type: "string",
          description: "New status (for 'mark')",
          enum: ["queued", "in-progress", "done", "failed"],
        },
      },
      required: ["action"],
    },
    async execute(_toolCallId, args, signal): Promise<ToolResult> {
      const action = typeof args.action === "string" ? args.action : "";
      // Cross-process guard: serialize this read-modify-write on the
      // per-session lock file (acquireSubtaskLock) so a second process on
      // the same session id cannot interleave its read/write with ours.
      // The run's abort signal stops the lock's heartbeat early. In-memory
      // mode (persist: false) has no shared file — no lock.
      const claim = persist ? acquireSubtaskLock(dir, sid, 30_000, signal) : null;
      try {
        const read = persist ? readSubtaskState(dir, sid) : ({ status: "ok", file: mem } as const);
        if (read.status === "corrupt") {
          // A file that exists but cannot be read or is not a valid list.
          // Refuse rather than treat it as empty: silently replacing it
          // (the old behavior) would destroy the only copy of the user's
          // list on the next create/mark.
          return {
            content: text(
              `subtask: the subtask file ${subtaskFilePath(dir, sid)} exists but could not be read ` +
                "as a valid list — refusing to overwrite it. Inspect or delete the file, then retry.",
            ),
            isError: true,
          };
        }
        const file = read.status === "ok" ? read.file : { items: [], updatedAt: 0 };
        if (action === "create") {
          const raw = Array.isArray(args.items) ? args.items : [];
          const names = raw.filter((n): n is string => typeof n === "string" && n.trim() !== "");
          if (names.length === 0) {
            return {
              content: text("subtask: 'create' needs a non-empty 'items' array of subtask names"),
              isError: true,
            };
          }
          const items: SubtaskInfo[] = names.map((name, i) => ({
            id: i + 1,
            name,
            status: "queued",
          }));
          const next: SubtaskFile = { items, updatedAt: Date.now() };
          writeLocal(next);
          return {
            content: text(`created ${items.length} subtask(s):\n${formatSubtaskSummary(items)}`),
            details: { subtasks: items },
          };
        }
        if (action === "list") {
          return {
            content: text(formatSubtaskSummary(file.items)),
            details: { subtasks: file.items },
          };
        }
        if (action === "mark") {
          const id = typeof args.id === "number" && Number.isFinite(args.id) ? Math.round(args.id) : NaN;
          const status = typeof args.status === "string" ? args.status : "";
          if (!Number.isFinite(id)) {
            return { content: text("subtask: 'mark' needs a numeric 'id'"), isError: true };
          }
          if (!(STATUSES as readonly string[]).includes(status)) {
            return {
              content: text(`subtask: 'mark' needs a 'status' (queued | in-progress | done | failed)`),
              isError: true,
            };
          }
          const idx = file.items.findIndex((i) => i.id === id);
          if (idx < 0) {
            const known = file.items.map((i) => i.id).join(", ");
            return {
              content: text(`subtask: no subtask with id ${id}${known ? ` (known ids: ${known})` : " (no subtasks yet — use 'create' first)"}`),
              isError: true,
            };
          }
          const items = file.items.map((i) => (i.id === id ? { ...i, status: status as SubtaskInfo["status"] } : i));
          const next: SubtaskFile = { items, updatedAt: Date.now() };
          writeLocal(next);
          return {
            content: text(`${id}. ${items[idx]!.name} → ${status}\n${formatSubtaskSummary(items)}`),
            details: { subtasks: items },
          };
        }
        return {
          content: text(`subtask: unknown action '${action}' (use create | list | mark)`),
          isError: true,
        };
      } catch (err) {
        // I3: the tool must never throw — an unexpected failure is a result
        // the model reads and can react to.
        return {
          content: text(`subtask: ${String(err)}`),
          isError: true,
        };
      } finally {
        releaseSubtaskLock(claim);
      }
    },
  };
}

/** The bare (unbound) tool — used when no session id is available.
 *  In-memory-only (`persist: false`): sessionless runs must NOT share the
 *  "default" file, or unrelated runs on the same machine would clobber
 *  each other's lists. The list works for the run's lifetime; it does not
 *  survive the process. */
export const subtaskTool: Tool = createSubtaskTool("default", homedir(), false);
