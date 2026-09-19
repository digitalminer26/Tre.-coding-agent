/**
 * WS5 — session persistence: JSONL append-only session + replay/resume.
 *
 * L2: structure adapted from @earendil-works/pi-agent-core 0.85.1 (MIT,
 *      © Mario Zechner) — session storage as an append-only JSONL log (one
 *      entry per line) and "resume = replay" (rebuild the context from the
 *      log, honoring compaction boundaries).
 *      Simplified: four entry kinds only — header, message, modelChange,
 *      compaction (no bashExecution/custom/branchSummary entries); branching
 *      (/tree-style forking) is a later replay concern on the same log.
 *
 * Design (docs/01-walkthrough-harness-llm.md §7, §9 "Sessions: Copy"):
 *  - One `.jsonl` file per session; every entry is one self-contained JSON
 *    line; nothing ever gets rewritten.
 *  - Resume = replay: `loadSession` + `replayContext` rebuild the exact
 *    `AgentMessage[]` context, including compaction boundaries (WS9 writes
 *    those entries; the type and the seam are defined here per PLAN.md).
 *  - Durability: each entry is one append on a held FileHandle, so a killed
 *    process loses at most the in-flight line. A torn trailing line is
 *    detected and dropped on replay; mid-file corruption throws (loud).
 *  - I3 at the boundary: replaying a torn tail is data (droppedTornTail),
 *    not an exception; structural corruption is.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { makeSummaryMessage } from "../context/compact.js";
import type { AgentMessage, UserMessage } from "../types.js";

/** Bump when the on-disk entry shape changes; replay rejects other versions. */
export const SESSION_FORMAT_VERSION = 1;

// ─────────────────────── default location (D20 boundary) ───────────────────────

/**
 * D20 boundary: sessions live OUTSIDE any repository — the agent under test
 * must never be able to read or edit its own session history. `--session-auto`
 * (WS6 CLI) resolves each run's session file here, in `~/.tre/sessions/`,
 * named `tre-<UTC yyyyMMdd>-<HHmmss>-<pid>.jsonl`. Pure: no I/O — the caller
 * creates the parent directory so the first write cannot fail.
 */
export function defaultSessionPath(now?: Date, pid?: number): string {
  const d = now ?? new Date();
  const p = pid ?? process.pid;
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
  const time = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
  return join(homedir(), ".tre", "sessions", `tre-${date}-${time}-${p}.jsonl`);
}

// ─────────────────────────── entry types (wire format) ───────────────────────────

export interface SessionHeaderEntry {
  type: "header";
  version: number;
  /** Session id — conventionally the file name (`<id>.jsonl`). */
  id: string;
  createdAt: number;
  cwd?: string;
}

export interface MessageEntry {
  type: "message";
  id: string;
  message: AgentMessage;
}

export interface ModelChangeEntry {
  type: "modelChange";
  id: string;
  /** Model id as requested on the wire. */
  model: string;
  /** Provider label, e.g. "vks-llama". */
  provider: string;
  timestamp: number;
}

/**
 * Compaction boundary. WS9 (context management) writes this between turns;
 * WS5 defines the type and the replay seam (PLAN.md WS5).
 * Replay: the context becomes [summary-as-user-message] + every entry from
 * `firstKeptEntryId` (by file order) onward — earlier entries are replaced
 * by the summary.
 */
export interface CompactionEntry {
  type: "compaction";
  id: string;
  summary: string;
  /** Id of the first entry still kept verbatim (a message or earlier compaction). */
  firstKeptEntryId: string;
  /** Context tokens before compaction (telemetry for WS9's trigger). */
  tokensBefore: number;
  timestamp: number;
}

export type SessionEntry =
  | SessionHeaderEntry
  | MessageEntry
  | ModelChangeEntry
  | CompactionEntry;

/** Model identity as recorded by a modelChange entry (resolved from
 *  models.json by the CLI on resume — apiKeys never land in the session file). */
export interface SessionModel {
  id: string;
  provider: string;
}

export interface LoadedSession {
  header: SessionHeaderEntry;
  /** All entries, in file order (including the header). */
  entries: SessionEntry[];
  /** True when the file ended in a torn (unparseable) trailing line, which was dropped. */
  droppedTornTail: boolean;
}

export interface SessionReplay extends LoadedSession {
  /** Rebuilt LLM context: message entries only, compaction boundaries honored. */
  context: AgentMessage[];
  /** Parallel to `context`: the entry id each context message came from
   *  (message entry → its id; compaction summary → the entry's id). WS9's
   *  compaction needs this to write `firstKeptEntryId` for kept messages. */
  contextEntryIds: string[];
  /** Last modelChange in the log, if any. */
  model?: SessionModel;
}

// ──────────────────────────────── the session ────────────────────────────────

/**
 * An open session: appends one JSON line per entry on a held FileHandle.
 * One process per session file (append is the only mutation; there is no
 * locking — the log's immutability is what makes it safe).
 */
export class Session {
  readonly path: string;
  private handle: FileHandle | null;

  private constructor(
    path: string,
    private readonly header: SessionHeaderEntry,
    handle: FileHandle,
  ) {
    this.path = path;
    this.handle = handle;
  }

  /** The session id (from the header line). */
  get id(): string {
    return this.header.id;
  }

  /** Create a new session file (header line, plus an initial modelChange).
   *  Throws if the file exists — use `Session.open` to resume an existing one. */
  static async create(
    path: string,
    opts: { cwd?: string; model?: SessionModel } = {},
  ): Promise<Session> {
    await mkdir(dirname(path), { recursive: true });
    // "wx" = O_CREAT|O_EXCL: fails with EEXIST if the file is there.
    const handle = await open(path, "wx");
    try {
      const header: SessionHeaderEntry = {
        type: "header",
        version: SESSION_FORMAT_VERSION,
        id: randomUUID(),
        createdAt: Date.now(),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      };
      await handle.appendFile(JSON.stringify(header) + "\n");
      if (opts.model) {
        const change: ModelChangeEntry = {
          type: "modelChange",
          id: randomUUID(),
          model: opts.model.id,
          provider: opts.model.provider,
          timestamp: Date.now(),
        };
        await handle.appendFile(JSON.stringify(change) + "\n");
      }
      return new Session(path, header, handle);
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  /** Open an existing session for appending (resume). Validates header + version. */
  static async open(path: string): Promise<Session> {
    const { header } = await loadSession(path);
    const handle = await open(path, "a");
    return new Session(path, header, handle);
  }

  /** Append one message to the log. Resolves with the new entry's id. */
  appendMessage(message: AgentMessage): Promise<string> {
    return this.write({ type: "message", id: randomUUID(), message });
  }

  /** Record a model switch (the CLI resolves it against models.json on resume). */
  appendModelChange(model: SessionModel): Promise<string> {
    return this.write({
      type: "modelChange",
      id: randomUUID(),
      model: model.id,
      provider: model.provider,
      timestamp: Date.now(),
    });
  }

  /**
   * Append a compaction boundary (WS9 writes these). `firstKeptEntryId`
   * must reference an entry id already in this session — otherwise the
   * session is unreplayable (replay throws).
   */
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
  ): Promise<string> {
    return this.write({
      type: "compaction",
      id: randomUUID(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      timestamp: Date.now(),
    });
  }

  /** Flush + release the file handle. Appends after close() throw. */
  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    if (handle) await handle.close();
  }

  private async write(
    entry: Extract<SessionEntry, { id: string }>,
  ): Promise<string> {
    const handle = this.handle;
    if (!handle) throw new Error("session is closed");
    // One append per entry: a kill between appends can only tear the last line.
    await handle.appendFile(JSON.stringify(entry) + "\n");
    return entry.id;
  }
}

// ─────────────────────────────── replay (resume) ───────────────────────────────

/**
 * Read + parse a session file. A torn trailing line — an unparseable last
 * line without a trailing newline, i.e. the last append was interrupted — is
 * dropped and reported via `droppedTornTail`; any other unparseable line is
 * structural corruption and throws.
 */
export async function loadSession(path: string): Promise<LoadedSession> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`session: cannot read ${path}: ${String(err)}`);
  }
  const lines = raw.split("\n");
  // A torn tail is an unparseable LAST line WITHOUT a trailing newline —
  // the append was interrupted before the "\n". A complete (newline-terminated)
  // but invalid line, anywhere, is structural corruption.
  const completeTail = raw.length === 0 || raw.endsWith("\n");
  if (completeTail && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) {
    throw new Error(`session: ${path} is empty (no header)`);
  }

  const entries: SessionEntry[] = [];
  let droppedTornTail = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") {
      throw new Error(`session: blank line at line ${i + 1} of ${path}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (i === lines.length - 1 && !completeTail) {
        // Torn tail: the last append was interrupted. Everything before it is intact.
        droppedTornTail = true;
        continue;
      }
      throw new Error(`session: corrupt line ${i + 1} in ${path}`);
    }
    entries.push(parsed as SessionEntry);
  }

  const header = entries[0] as SessionHeaderEntry | undefined;
  if (!header || header.type !== "header") {
    throw new Error(`session: first line of ${path} is not a header`);
  }
  if (header.version !== SESSION_FORMAT_VERSION) {
    throw new Error(
      `session: unsupported format version ${String(header.version)} in ${path}`,
    );
  }
  return { header, entries, droppedTornTail };
}

/**
 * Rebuild the LLM context from a session's entries, honoring compaction
 * boundaries (the seam WS9's compaction relies on):
 *   context = [summary-as-user-message] + entries from firstKeptEntryId onward
 * A compaction may keep an earlier compaction's summary (chain-safe).
 * Pure: no I/O.
 */
export interface ReplayWithIds {
  context: AgentMessage[];
  /** Parallel to `context`: the entry id each message came from. */
  contextEntryIds: string[];
}

export function replayContextWithIds(entries: SessionEntry[]): ReplayWithIds {
  interface Retained {
    id: string;
    message: AgentMessage;
  }
  let retained: Retained[] = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      retained.push({ id: entry.id, message: entry.message });
    } else if (entry.type === "compaction") {
      const idx = retained.findIndex((r) => r.id === entry.firstKeptEntryId);
      if (idx === -1) {
        throw new Error(
          `session: compaction ${entry.id} references unknown entry ${entry.firstKeptEntryId}`,
        );
      }
      retained = [
        { id: entry.id, message: summaryMessage(entry) },
        ...retained.slice(idx),
      ];
    }
    // header / modelChange carry no LLM context
  }
  return { context: retained.map((r) => r.message), contextEntryIds: retained.map((r) => r.id) };
}

export function replayContext(entries: SessionEntry[]): AgentMessage[] {
  return replayContextWithIds(entries).context;
}

/** How a compaction summary re-enters the context: as a user message. */
export function summaryMessage(entry: CompactionEntry): UserMessage {
  // Same marker/format as the live path (compact.ts makeSummaryMessage) so a
  // replayed summary is indistinguishable from the one the run produced.
  return makeSummaryMessage(entry.summary, entry.timestamp);
}

/**
 * One-shot resume (the WS6 CLI path): load the file, rebuild the context,
 * and report the last model change.
 */
export async function replaySession(path: string): Promise<SessionReplay> {
  const loaded = await loadSession(path);
  let model: SessionModel | undefined;
  for (const entry of loaded.entries) {
    if (entry.type === "modelChange") {
      model = { id: entry.model, provider: entry.provider };
    }
  }
  const replayed = replayContextWithIds(loaded.entries);
  const result: SessionReplay = {
    header: loaded.header,
    entries: loaded.entries,
    droppedTornTail: loaded.droppedTornTail,
    context: replayed.context,
    contextEntryIds: replayed.contextEntryIds,
  };
  if (model) result.model = model;
  return result;
}
