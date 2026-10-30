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
import { appendFile, mkdir, open, readFile, readdir, truncate } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { makeSummaryMessage } from "../context/compact.js";
import type {
  AgentMessage,
  GuardEvidence,
  ProgressKind,
  ProgressMode,
  SteeringMeta,
  StopReason,
  UserMessage,
  Usage,
} from "../types.js";

/** Bump when the on-disk entry shape changes; replay rejects other versions. */
export const SESSION_FORMAT_VERSION = 1;

// ─────────────────────── default location (D20 boundary) ───────────────────────

/**
 * D20 boundary: sessions live OUTSIDE any repository — the agent under test
 * must never find its session history among the project files it operates
 * on. (Repo-level isolation only: the C38 implicit `~/.tre` root makes the
 * session dir read+write reachable from the tools — non-sensitive session
 * files included; the sensitive-filename gate covers the credential files,
 * not transcripts.) `--session-auto`
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

/** Per-model totals aggregated from every readable session JSONL file. */
export type ModelTokenTotals = Record<string, { total: number; promptNew: number; promptCached: number; generated: number }>;

/**
 * The directories `/usage` scans by default, given the launch root. Sessions
 * live in TWO places the agent actually writes to:
 *   - `~/.tre/sessions/` and `<root>/.tre/sessions/` — the `--session-auto`
 *     convention (`defaultSessionPath`), flat `.jsonl` files.
 *   - `~/.tre/delegation/` and `<root>/.tre/delegation/` — the
 *     parallel-delegation fanout writes each worker's log as
 *     `<task>/logs/<id>.session` (nested, not flat).
 * A bare `tre.` (no session flag) writes NEITHER, so both are included for
 * completeness; the delegation tree is where most real usage actually lands.
 */
export function defaultUsageDirs(root: string): string[] {
  return [
    join(homedir(), ".tre", "sessions"),
    join(root, ".tre", "sessions"),
    join(root, ".tre", "delegation"),
    join(homedir(), ".tre", "delegation"),
  ];
}

/**
 * Recursively collect session files (`.jsonl` / `.session`) under `dir`.
 * `node_modules` and `.git` subtrees are pruned (they are never session
 * stores and can be huge). A missing/unreadable directory yields nothing —
 * absence is data, not an error.
 */
async function collectSessionFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      out.push(...await collectSessionFiles(join(dir, e.name)));
    } else if (e.isFile() && (e.name.endsWith(".jsonl") || e.name.endsWith(".session"))) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/**
 * Sum the token usage reported by assistant messages across every session log
 * under the given directory (or directories), bucketed by model id. Sessions
 * are JSONL — one entry per line — so each file is split on real NEWLINES.
 * Both on-disk spellings are accepted: `.jsonl` (the `--session-auto` /
 * `defaultSessionPath` convention) and `.session` (the parallel-delegation
 * fanout). Files that cannot be read, or any line that is not a well-formed
 * assistant entry with usage (torn tails, legacy shapes, other entry kinds),
 * are skipped — a partial log must never poison the totals. Overlapping
 * directories are de-duplicated so a file is counted once.
 */
export async function aggregateSessionUsage(
  directories: string | string[] = join(homedir(), ".tre", "sessions"),
): Promise<ModelTokenTotals> {
  const dirs = Array.isArray(directories) ? directories : [directories];
  const totals: ModelTokenTotals = {};
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const file of await collectSessionFiles(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);
      let lines: string[];
      try { lines = (await readFile(file, "utf8")).split("\n"); }
      catch { continue; }
      for (const line of lines) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as SessionEntry;
          if (entry.type !== "message" || entry.message.role !== "assistant" || !entry.message.usage) continue;
          const usage: Usage = entry.message.usage;
          const bucket = totals[entry.message.model] ??= { total: 0, promptNew: 0, promptCached: 0, generated: 0 };
          const cached = Math.min(usage.input, usage.cacheRead ?? 0);
          bucket.total += usage.totalTokens;
          bucket.promptNew += usage.input - cached;
          bucket.promptCached += cached;
          bucket.generated += usage.output;
        } catch { /* Ignore torn tails and malformed/legacy entries. */ }
      }
    }
  }
  return totals;
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
  /** P3a (docs/11 §14.2): steering provenance, set when the message was
   *  injected via steering. Model-invisible: replay rebuilds a plain
   *  `message` from `.message` and never reads this field. */
  steering?: SteeringMeta;
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

/**
 * D33 (docs/08 §10) — a guard stop (loop/stall) recorded by the driver when
 * an agent_end carried evidence. Harness metadata, NOT LLM context: replay
 * ignores it like modelChange (the model must not see "you were stopped for
 * looping" as a context mutation), and it is never referenced by a
 * compaction's firstKeptEntryId. Additive entry type: SESSION_FORMAT_VERSION
 * stays 1 — loadSession casts blindly and both replay paths skip unknown
 * types by fall-through, so old readers ignore it and new readers handle
 * old files.
 */
export interface GuardStopEntry {
  type: "guardStop";
  id: string;
  timestamp: number;
  evidence: GuardEvidence;
}

/**
 * P1 (docs/11 §14.6) — a persisted no-progress warning (F1). Written by the
 * driver when the loop emits `progress_nudge`, closing the §2 gap: the
 * supervisor tails warn evidence from the file, in every mode (the live
 * event was previously the only channel and died with the process).
 * Harness metadata, NOT LLM context: replay ignores it like guardStop, and
 * it is never referenced by a compaction's firstKeptEntryId. Additive entry
 * type — SESSION_FORMAT_VERSION stays 1 (old readers fall through).
 */
export interface ProgressNudgeEntry {
  type: "progressNudge";
  id: string;
  timestamp: number;
  /** Which no-progress condition fired. */
  kind: ProgressKind;
  /** The mode the run was in when it fired (event parity, §14.6). */
  mode: ProgressMode;
  /** Loop turn the condition fired on. */
  turn: number;
  /** The count that crossed the threshold (turns, or edits of target). */
  count: number;
  /** Normalized target path — only for "no-verification". */
  target?: string;
  /** §14.1 run identity; absent for unmanaged runs and pre-P2 files. */
  runId?: string;
}

/** §14.1: driver-allocated run identity (UUID), attached to the terminal entry. */
export interface RunEndEntry {
  type: "runEnd";
  id: string;
  timestamp: number;
  /** §14.1 runId — one per driver invocation against this session. */
  runId: string;
  /**
   * Why the RUN ended (docs/11 §2): "the run ended and why", NEVER "the
   * task passed" — acceptance stays supervisor-side. Driver-writable
   * reasons only ("crashed" is reserved for a reconciling supervisor and
   * is never written by the driver — a crashed driver cannot write its
   * own terminal record). Absence classifies `unknown`, never `crashed`.
   */
  reason: DriverRunEndReason;
}

/**
 * Driver-writable `runEnd` reasons: the StopReason set minus "toolUse"
 * (a tool-use stop never terminates a run, so it never appears).
 */
export type DriverRunEndReason = Exclude<StopReason, "toolUse">;

/**
 * Narrow a loop StopReason to a driver-writable runEnd reason. "toolUse"
 * must never terminate a run (§2); if one ever leaks through, the honest
 * answer is NO terminal record (absence → `unknown`), not a wrong reason.
 */
export function driverRunEndReason(reason: StopReason): DriverRunEndReason | undefined {
  return reason === "toolUse" ? undefined : reason;
}

export type SessionEntry =
  | SessionHeaderEntry
  | MessageEntry
  | ModelChangeEntry
  | CompactionEntry
  | GuardStopEntry
  | ProgressNudgeEntry
  | RunEndEntry;

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

  /** Open an existing session for appending (resume). Validates header + version.
   *
   *  Repair-then-append (docs/11 §13.1): a prior crash can interrupt the
   *  last append anywhere after the previous "\n", leaving the file without
   *  a terminating newline. Two tail classes, two repairs — appended
   *  anything must land on a valid boundary or the next append welds lines
   *  and the session becomes permanently unloadable ("corrupt line N"):
   *   - the tail is a PARTIAL line (unparseable) → truncate it away;
   *   - the tail is a COMPLETE record that lost only its "\n" (parses) →
   *     KEEP it (loadSession/replaySession already count it as an entry)
   *     and terminate the line before any further appends.
   *  Repair only ever runs when the file is otherwise loadable: a load
   *  error (mid-file corruption, bad header) throws before the file is
   *  touched. Process-death durability only — see docs/11 §13.1. */
  static async open(path: string): Promise<Session> {
    const { header } = await loadSession(path);
    const raw = await readFile(path);
    if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) {
      const lastNL = raw.lastIndexOf(0x0a);
      const tail = raw.subarray(lastNL + 1);
      let tailParses = false;
      try {
        JSON.parse(tail.toString("utf8"));
        tailParses = true;
      } catch {
        tailParses = false;
      }
      if (tailParses) {
        // Complete record, missing only its terminator: terminate it.
        await appendFile(path, "\n");
      } else {
        // Partial record: drop it, back to the last valid boundary.
        await truncate(path, lastNL + 1);
      }
    }
    const handle = await open(path, "a");
    return new Session(path, header, handle);
  }

  /** Append one message to the log. Resolves with the new entry's id. */
  appendMessage(message: AgentMessage, steering?: SteeringMeta): Promise<string> {
    return this.write({
      type: "message",
      id: randomUUID(),
      message,
      ...(steering !== undefined ? { steering } : {}),
    });
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

  /**
   * Append a guard-stop evidence entry (D33, docs/08 §10). Written by the
   * driver on the agent_end that carried `evidence` — one greppable line
   * naming the guard, the trigger, and the count, so a resumed session is
   * diagnosable without signature archaeology. Replay ignores the entry
   * (see GuardStopEntry).
   */
  appendGuardStop(evidence: GuardEvidence): Promise<string> {
    return this.write({
      type: "guardStop",
      id: randomUUID(),
      timestamp: Date.now(),
      evidence,
    });
  }

  /**
   * Append a no-progress warning entry (P1, docs/11 §14.6). Written by the
   * driver on EVERY `progress_nudge` event, in every mode — one greppable
   * line naming the condition, the count, and (for no-verification) the
   * target, so warn evidence survives the process for supervisor tailing.
   * Replay ignores the entry (see ProgressNudgeEntry).
   */
  appendProgressNudge(nudge: {
    kind: ProgressKind;
    mode: ProgressMode;
    turn: number;
    count: number;
    target?: string;
    runId?: string;
  }): Promise<string> {
    return this.write({
      type: "progressNudge",
      id: randomUUID(),
      timestamp: Date.now(),
      ...nudge,
    });
  }

  /**
   * Append the terminal record for one run (P2, docs/11 §2/§13.4):
   * "the run ended and why" — never "the task passed". Written by the
   * driver at agent_end (every exit path that reaches agent_end); the
   * supervisor's classifier treats a file whose tail has no runEnd as
   * `unknown` — never `crashed` (a crashed driver cannot write its own
   * terminal record; only a reconciling supervisor may record `crashed`,
   * and it does so in ITS journal, never in the worker session file).
   * Replay ignores the entry like guardStop/progressNudge.
   */
  appendRunEnd(runId: string, reason: DriverRunEndReason): Promise<string> {
    return this.write({
      type: "runEnd",
      id: randomUUID(),
      timestamp: Date.now(),
      runId,
      reason,
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
    // header / modelChange / guardStop / progressNudge carry no LLM context
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
