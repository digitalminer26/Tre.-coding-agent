/**
 * P5 — fleet observation primitives (docs/11 §2, §8/S7, §13.1, §13.2, §14.8).
 *
 * Read-only ingestion for the supervisor: an offset-persistent JSONL tailer
 * over worker session files (the tokenomics reporter pattern, §2 "Tail
 * semantics"), entry-id dedup with a deterministic replay projection
 * (§13.2 I6), the §14.8 `workerState` closed-set classification —
 * rules-only with mandatory `unknown`/`stale` where evidence ends
 * (I3: a precise state derived from silence is a spec violation) — and S7
 * observation-envelope emission (§8) as a per-worker observe doc plus the
 * per-episode `tre-fleet/1` envelope stream.
 *
 * Contracts this file honors:
 *  - Observation-only: never opens a worker file for writing and never
 *    repairs a torn tail (§13.1 repair stays with the exclusive writer —
 *    the worker). A partial trailing line is held in a private buffer and
 *    its bytes are NOT reflected in the persisted offset, so a crash
 *    mid-line loses nothing and redelivers nothing.
 *  - §13.1 reconcile on the consumer side: truncation (size < offset) or
 *    in-place replacement (size equal, head fingerprint or mtime moved)
 *    resets the cursor to 0 and re-reads — the tail repair the worker
 *    performs looks exactly like this. Ids are regenerated from content,
 *    so the dedup layer reconciles by replayed content, not by previously
 *    delivered ids.
 *  - §13.2 I6: the replay projection is deterministic (order-independent
 *    sort; identical projections for identical entry sets regardless of
 *    arrival order or source file).
 *  - Durability of our OWN writes: envelope appends are fsynced before
 *    return; JSON docs go through tmp + fsync + rename (process-death
 *    durability — same bound as the P4 journal, not power-failure).
 *
 * Primitives only: nothing outside src/fleet/ imports this until the
 * supervisor (P6+) wires it in — the test suite enforces that promise.
 */
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { open, readFile, rename, stat, writeFile } from "node:fs/promises";

// ─────────────────────────── JsonlTailer ───────────────────────────

/** Options for one tailer instance (one watched file). */
export interface JsonlTailerOptions {
  /** Directory holding the offset-state file (default: alongside the log). */
  stateDir?: string;
}

/** Persisted cursor state (per watched file; JSON so it survives restarts). */
interface TailState {
  /** Byte offset of the first NOT-yet-read byte (covers the held partial). */
  offset: number;
  /** mtimeMs at last read — detects in-place replacement when size collides. */
  mtimeMs: number;
  /** Base64 of the first HEAD_LEN bytes at last read (cheap change signal). */
  head: string;
  /**
   * Base64 of the bytes after the last newline that were READ but not yet
   * delivered (the held partial). Persisting it means a restart neither
   * redelivers nor duplicates a torn line: the offset covers the partial,
   * so the next read starts strictly after it and the join continues
   * across process boundaries.
   */
  partialB64?: string;
}

/** Prefix bytes fingerprinted for replacement detection. */
const HEAD_LEN = 64;

/** One complete line delivered by the tailer. */
export interface TailedLine {
  /** Raw line text (no trailing newline). */
  text: string;
  /** Byte offset of the line start in the file. */
  offset: number;
  /**
   * Dedup key (§2: entry `id` is the dedup key everywhere). Copied from
   * the parsed line when it carries a non-empty string `id`; otherwise a
   * content fingerprint (stable for identical text, regenerated from
   * content on a §13.1 rescan).
   */
  id: string;
  /** Parsed JSON object (null when the line is not a JSON object). */
  json: Record<string, unknown> | null;
  /** Path of the watched file. */
  file?: string;
  /** True when the line arrived on a §13.1 rescan pass (redelivered set). */
  resume: boolean;
}

/**
 * Offset-persistent JSONL tailer (the tokenomics reporter pattern).
 *
 * Delivers only newline-terminated lines; a partial trailing line is held
 * in a private buffer until the newline lands. Reconciles §13.1:
 *  - size < offset (truncate — torn-tail repair)     → full rescan;
 *  - size === offset but head/mtime moved (in-place rewrite the size check
 *    alone cannot see)                                → full rescan;
 *  - each line must decode as valid UTF-8 — invalid bytes are counted in
 *    the offset and the line dropped, never poisoning the cursor.
 * State (offset + mtime + head fingerprint) persists next to the log so a
 * process restart resumes by byte offset, redelivering nothing.
 */
export class JsonlTailer {
  private partial: Uint8Array<ArrayBuffer> = new Uint8Array(0); // bytes after the last newline
  private state: TailState | null = null;
  private stateLoaded = false;
  private readonly statePath: string;

  constructor(
    readonly path: string,
    opts?: JsonlTailerOptions,
  ) {
    const base = opts?.stateDir ?? parentDirOf(path);
    this.statePath = joinPath(base, `${fileNameOf(path)}.offset.json`);
  }

  /**
   * Read and deliver every complete line appended since the last poll.
   * Never mutates the watched file. Returns [] when nothing was appended.
   */
  async poll(): Promise<TailedLine[]> {
    if (!this.stateLoaded) {
      this.stateLoaded = true;
      try {
        const raw = await readFile(this.statePath, "utf-8");
        const parsed = JSON.parse(raw) as TailState;
        if (
          typeof parsed.offset === "number" &&
          parsed.offset >= 0 &&
          typeof parsed.mtimeMs === "number" &&
          typeof parsed.head === "string"
        ) {
          this.state = parsed;
          if (typeof parsed.partialB64 === "string" && parsed.partialB64.length > 0) {
            try {
              this.partial = new Uint8Array(Buffer.from(parsed.partialB64, "base64"));
            } catch {
              this.partial = new Uint8Array(0);
            }
          }
        }
      } catch {
        /* missing or corrupt state is equivalent to reading from 0. */
      }
    }

    const info = await stat(this.path).catch(() => null);
    if (!info || !info.isFile()) {
      // Gone (or never created): drop the cursor AND the held partial — a
      // successor file at this path must be read from 0.
      this.state = null;
      this.partial = new Uint8Array(0);
      return [];
    }

    let resumeFrom = 0;
    let rescan = false;
    if (this.state) {
      if (info.size < this.state.offset) {
        rescan = true; // truncation: a repair rewrote the tail
      } else if (info.size === this.state.offset) {
        const head = await readHead(this.path, HEAD_LEN);
        if (head.mtimeMs !== this.state.mtimeMs || toB64(head.bytes) !== this.state.head) {
          rescan = true; // in-place rewrite with identical size
        }
      }
      if (rescan) {
        this.partial = new Uint8Array(0);
      } else {
        resumeFrom = this.state.offset;
      }
    }

    let fresh: Uint8Array<ArrayBuffer>;
    if (info.size > resumeFrom) {
      const fh = await open(this.path, "r");
      try {
        const len = info.size - resumeFrom;
        const buf = new Uint8Array(len);
        const { bytesRead } = await fh.read(buf, 0, len, resumeFrom);
        fresh = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    } else {
      fresh = new Uint8Array(0);
    }

    // Merge any held partial with the fresh bytes (the newline may have landed).
    const merged = concat(this.partial, fresh);
    const lines: TailedLine[] = [];
    if (merged.length > 0) {
      const { done, rest } = splitCompleteLines(merged);
      const firstLineStart = resumeFrom - this.partial.length;
      this.partial = rest;
      let cursor = firstLineStart;
      for (const raw of done) {
        const lineStart = cursor;
        cursor += raw.length + 1; // + newline
        if (raw.length === 0) continue;
        const decoded = decodeLine(raw);
        if (decoded === null) continue; // invalid UTF-8: counted, dropped
        const json = parseObject(decoded);
        lines.push({
          text: decoded,
          offset: lineStart,
          json,
          id:
            json !== null && typeof json.id === "string" && json.id.length > 0
              ? json.id
              : fingerprint(decoded),
          resume: rescan,
          file: this.path,
        });
      }
    }

    // Offset covers everything read INCLUDING the held partial (which is
    // persisted alongside) so neither a repeat poll nor a restart can
    // re-read — and therefore duplicate — a torn line.
    const newOffset = info.size;
    const head = await readHead(this.path, HEAD_LEN);
    this.state = {
      offset: newOffset,
      mtimeMs: head.mtimeMs,
      head: toB64(head.bytes),
      partialB64: this.partial.length > 0 ? toB64(this.partial) : undefined,
    };
    await writeJsonSynced(this.statePath, this.state);
    return lines;
  }

  /** Current persisted cursor offset (null before the first successful poll). */
  currentOffset(): number | null {
    return this.state ? this.state.offset : null;
  }

  /**
   * Forget the cursor (and any held partial), on disk too: the next poll
   * reads the whole file from 0. Synchronous so callers can assert the
   * state file is gone the moment reset() returns.
   */
  reset(): void {
    this.state = null;
    this.stateLoaded = true; // do not re-load what we just deleted
    this.partial = new Uint8Array(0);
    try {
      rmSync(this.statePath, { force: true });
    } catch {
      /* best effort — in-memory cursor is already cleared. */
    }
  }
}

// ─────────────────────────── replay projection ───────────────────────────

/** Minimal structural shape of a session entry (the §2 bus — tolerant cast). */
export interface SessionEntryShape {
  type: string;
  id?: string;
  timestamp?: number;
  [key: string]: unknown;
}

/** Shape of an assistant message carrying toolCall blocks. */
export interface ToolCallMessageShape {
  role: string;
  model?: string;
  content: { type: string; id?: string; name?: string; arguments?: unknown }[];
  stopReason?: string;
}

/** One entry inside a replay projection. */
export interface ReplayEntry {
  id: string;
  entry: SessionEntryShape;
  /** Where the first delivery came from (projection-order only). */
  sourceFile: string;
  /** Byte offset of the entry line in its source file. */
  offset: number;
}

/**
 * Deterministic replay projection with entry-id dedup (§2, §13.2 I6).
 * `replay` is order-independent (sort by first-seen timestamp, then id):
 * the same entry set always yields the identical array, so a supervisor
 * recovery replay and a live tail agree (§13.2 I6 "same inputs → same
 * projection").
 */
export interface ReplayProjection {
  /** Deduped entries by id — FIRST delivery wins (append-only truth). */
  entries: Map<string, ReplayEntry>;
  /** Ids delivered more than once (redelivered after a §13.1 rescan etc.). */
  duplicates: { id: string; count: number }[];
  /** Deterministic replay array — file-position fields EXCLUDED so two
   *  files carrying the same entries produce a deep-equal projection (I6). */
  replay: { id: string; entry: SessionEntryShape }[];
  /** Total lines ever folded in (including duplicates and parse failures). */
  linesSeen: number;
}

/**
 * Fold tailed lines into a deterministic replay projection. Call again with
 * the previous projection to accumulate (deduped by entry id — §2: entry
 * `id` is the dedup key everywhere).
 */
export function projectSessionReplay(
  lines: readonly TailedLine[],
  previous?: ReplayProjection,
): ReplayProjection {
  const entries = new Map(previous?.entries ?? []);
  const dupCounts = new Map<string, number>();
  for (const d of previous?.duplicates ?? []) dupCounts.set(d.id, d.count);
  let linesSeen = previous?.linesSeen ?? 0;

  for (const line of lines) {
    linesSeen++;
    if (line.json === null) continue;
    const prior = entries.get(line.id);
    if (prior) {
      dupCounts.set(line.id, (dupCounts.get(line.id) ?? 1) + 1);
      continue; // first wins
    }
    entries.set(line.id, {
      id: line.id,
      entry: line.json as SessionEntryShape,
      sourceFile: line.file ?? "",
      offset: line.offset,
    });
  }

  const replay = [...entries.values()]
    .sort((a, b) => {
      const ta = typeof a.entry.timestamp === "number" ? a.entry.timestamp : Number.MAX_SAFE_INTEGER;
      const tb = typeof b.entry.timestamp === "number" ? b.entry.timestamp : Number.MAX_SAFE_INTEGER;
      if (ta !== tb) return ta - tb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((e) => ({ id: e.id, entry: e.entry }));

  const duplicates = [...dupCounts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  return { entries, duplicates, replay, linesSeen };
}

// ─────────────────────────── §14.8 classification ───────────────────────────

/** §14.8 closed set (S7). */
export type WorkerState =
  | "thinking"
  | "tool"
  | "await-approval"
  | "warned"
  | "stopped"
  | "dead"
  | "unknown";

/** The §14.8 workerState values as a frozen set (contract for importers). */
export const WORKER_STATES: readonly WorkerState[] = Object.freeze([
  "thinking",
  "tool",
  "await-approval",
  "warned",
  "stopped",
  "dead",
  "unknown",
] as const);

/** Persisted warn kinds, envelope spelling. */
export type WarnKind = "progress_nudge" | "same_error_warn" | "same_family_warn";

/** One persisted warn observation. */
export interface WarnEvidence {
  kind: WarnKind;
  detail: string;
  /** Fold order (arrival index) of the warn record. */
  seq: number;
  timestamp: number;
}

/** Accumulated evidence classification may rest on (all evidence-based). */
export interface WorkerStateEvidence {
  recordCount: number;
  /** Order index of the last record folded in (-1 when none). */
  lastSeq: number;
  /** Newest timestamp seen on any record (null when none). */
  lastRecordTimestamp: number | null;
  /** Tool calls never answered by a toolResult, in arrival order. */
  pendingToolCalls: { id: string; name: string; seq: number }[];
  /** Name of the most recent tool call (pending or answered). */
  lastTool: string | null;
  /** Last persisted warn entry (toolResult details / progressNudge). */
  lastWarn: WarnEvidence | null;
  /** Order index of the last assistant message (-1 when none). */
  lastAssistantSeq: number;
  /** Order index of the last successful tool result (-1 when none). */
  lastSuccessToolSeq: number;
  /** Last run-terminal record — guardStop or runEnd (null when none). */
  lastRunEnd: { seq: number; timestamp: number; runId: string; reason: string; writtenBy?: string } | null;
  /** Last guardStop record (null when none). */
  lastGuardStop: { seq: number; timestamp: number; reason: string } | null;
  toolCallsObserved: number;
  toolResultsObserved: number;
  usageInput: number;
  usageOutput: number;
}

/** Fresh empty evidence accumulator. */
export function emptyWorkerEvidence(): WorkerStateEvidence {
  return {
    recordCount: 0,
    lastSeq: -1,
    lastRecordTimestamp: null,
    pendingToolCalls: [],
    lastTool: null,
    lastWarn: null,
    lastAssistantSeq: -1,
    lastSuccessToolSeq: -1,
    lastRunEnd: null,
    lastGuardStop: null,
    toolCallsObserved: 0,
    toolResultsObserved: 0,
    usageInput: 0,
    usageOutput: 0,
  };
}

/**
 * Fold one entry into evidence (pure; returns a fresh snapshot). `seq` is a
 * caller-monotonic arrival order (file order — arrival order IS the story
 * warn sequencing depends on; determinism for replay comes from the
 * projection feeding this with the same entry set in the same order).
 */
export function foldEntry(
  prev: WorkerStateEvidence,
  entry: SessionEntryShape,
  seq: number,
): WorkerStateEvidence {
  const ts = typeof entry.timestamp === "number" ? entry.timestamp : null;
  const next: WorkerStateEvidence = {
    ...prev,
    recordCount: prev.recordCount + 1,
    lastSeq: seq,
    lastRecordTimestamp:
      ts !== null && (prev.lastRecordTimestamp === null || ts > prev.lastRecordTimestamp)
        ? ts
        : prev.lastRecordTimestamp,
    pendingToolCalls: [...prev.pendingToolCalls],
  };

  const message = entry.type === "message" ? (entry.message as Record<string, unknown> | undefined) : undefined;

  if (message) {
    const role = message.role;
    if (role === "assistant") {
      next.lastAssistantSeq = seq;
      const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
      for (const block of content) {
        if (block && block.type === "toolCall" && typeof block.id === "string") {
          const name = typeof block.name === "string" ? block.name : "unknown";
          next.pendingToolCalls.push({ id: block.id, name, seq });
          next.lastTool = name;
          next.toolCallsObserved += 1;
        }
      }
      const usage = message.usage as { input?: number; output?: number } | undefined;
      if (usage && typeof usage.input === "number" && isFinite(usage.input)) next.usageInput += usage.input;
      if (usage && typeof usage.output === "number" && isFinite(usage.output)) next.usageOutput += usage.output;
    } else if (role === "toolResult") {
      next.toolResultsObserved += 1;
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
      next.pendingToolCalls = next.pendingToolCalls.filter((t) => t.id !== callId);
      // §14.8: warn evidence rides the toolResult DETAILS (the error flag
      // alone is not the warn entry) — check the flags independent of it.
      const details = (message.details ?? {}) as Record<string, unknown>;
      const name = typeof message.toolName === "string" ? message.toolName : "unknown";
      if (details.sameFamilyWarn === true) {
        next.lastWarn = { kind: "same_family_warn", detail: name, seq, timestamp: ts ?? 0 };
      } else if (details.sameErrorWarn === true) {
        next.lastWarn = { kind: "same_error_warn", detail: name, seq, timestamp: ts ?? 0 };
      }
      if (message.isError !== true) {
        next.lastSuccessToolSeq = seq;
      }
    }
  } else if (entry.type === "guardStop") {
    const reason =
      typeof entry.reason === "string" && entry.reason.length > 0
        ? entry.reason
        : typeof (entry.evidence as Record<string, unknown> | undefined)?.guard === "string"
          ? String((entry.evidence as Record<string, unknown>).guard)
          : "guard-stop";
    next.lastGuardStop = { seq, timestamp: ts ?? 0, reason };
    // guardStop IS a run-terminal record (§14.8 stopped ← guardStop/runEnd).
    next.lastRunEnd = { seq, timestamp: ts ?? 0, runId: typeof entry.runId === "string" ? entry.runId : "", reason, writtenBy: undefined };
  } else if (entry.type === "progressNudge") {
    next.lastWarn = {
      kind: "progress_nudge",
      detail: typeof entry.kind === "string" ? entry.kind : "unknown",
      seq,
      timestamp: ts ?? 0,
    };
  } else if (entry.type === "runEnd") {
    next.lastRunEnd = {
      seq,
      timestamp: ts ?? 0,
      runId: typeof entry.runId === "string" ? entry.runId : "",
      reason: typeof entry.reason === "string" ? entry.reason : "unknown",
      writtenBy: typeof entry.writtenBy === "string" ? entry.writtenBy : undefined,
    };
  }

  return next;
}

/**
 * Ephemeral/process evidence supplied by the caller. A file tail cannot
 * know liveness (§2 "not recorded" list), so the supervisor passes what it
 * actually observes; `processRunning: false` REQUIRES positive confirmation
 * the process is gone (I3 — never infer from silence).
 */
export interface ClassifyEvidenceOptions {
  /** A tool_execution_start without end is in flight (ephemeral §14.8). */
  toolRunning?: boolean;
  /** Name of the running tool when known. */
  toolName?: string;
  /** The worker is blocked on an approval prompt (ephemeral). */
  awaitApproval?: boolean;
  /** An LLM response stream is open without end (ephemeral). */
  llmStreaming?: boolean;
  /** true = alive, false = CONFIRMED gone, undefined = not observed. */
  processRunning?: boolean;
}

/** Result of §14.8 classification. */
export interface WorkerStateClassification {
  state: WorkerState;
  /** Short machine-readable detail (tool name, runEnd reason, warn kind). */
  detail: string;
  /** The rule that fired — audit trail so views can show WHY (§8). */
  classifiedFrom: string;
}

/**
 * §14.8 classification — deterministic rules over persisted evidence plus
 * caller-supplied process/ephemeral facts. Nothing else may lift a worker
 * out of `unknown` (I3): clean silence is `unknown`, NEVER `thinking`.
 *
 * §14.8 mapping order: `dead` (supervisor-written `crashed` terminal, or
 * process confirmed gone without terminal record) → `stopped` (guardStop
 * OR runEnd at the tail) → ephemeral tool/approval/streaming → persisted
 * toolCall with no result → `warned` (last persisted warn with no later
 * successful activity) → otherwise `unknown`.
 */
export function classifyWorkerState(
  evidence: WorkerStateEvidence,
  opts?: ClassifyEvidenceOptions,
): WorkerStateClassification {
  if (evidence.recordCount === 0) {
    return { state: "unknown", detail: "", classifiedFrom: "no entries" };
  }
  // Supervisor-written crash terminal — dead even though a record exists.
  if (evidence.lastRunEnd && evidence.lastRunEnd.reason === "crashed") {
    return { state: "dead", detail: "crashed", classifiedFrom: "supervisor-written crashed runEnd" };
  }
  if (evidence.lastGuardStop && evidence.lastGuardStop.seq === evidence.lastSeq) {
    return { state: "stopped", detail: evidence.lastGuardStop.reason, classifiedFrom: "guardStop at log tail" };
  }
  if (evidence.lastRunEnd && evidence.lastRunEnd.seq === evidence.lastSeq) {
    return { state: "stopped", detail: evidence.lastRunEnd.reason, classifiedFrom: "runEnd at log tail" };
  }
  if (opts?.processRunning === false) {
    return { state: "dead", detail: "no-terminal-record", classifiedFrom: "process confirmed gone without terminal record" };
  }
  if (opts?.toolRunning === true) {
    return { state: "tool", detail: opts.toolName ?? "unknown", classifiedFrom: "ephemeral tool_execution_start without end" };
  }
  if (opts?.awaitApproval === true) {
    return { state: "await-approval", detail: opts.toolName ?? "", classifiedFrom: "ephemeral approval prompt" };
  }
  if (opts?.llmStreaming === true) {
    return { state: "thinking", detail: "", classifiedFrom: "ephemeral open LLM stream" };
  }
  if (evidence.pendingToolCalls.length > 0) {
    const last = evidence.pendingToolCalls[evidence.pendingToolCalls.length - 1]!;
    return { state: "tool", detail: last.name, classifiedFrom: "toolCall with no matching toolResult" };
  }
  // §14.8 warned ← last persisted warn with no later successful tool call
  // (or later assistant activity) superseding it.
  if (
    evidence.lastWarn &&
    evidence.lastSuccessToolSeq <= evidence.lastWarn.seq &&
    evidence.lastAssistantSeq <= evidence.lastWarn.seq
  ) {
    const w = evidence.lastWarn;
    return { state: "warned", detail: `${w.kind}:${w.detail}`, classifiedFrom: "last persisted warn with no later successful activity" };
  }
  return { state: "unknown", detail: "", classifiedFrom: "no distinguishing evidence" };
}

/** Fold an ordered entry list into evidence (arrival order). */
export function evidenceFromEntries(entries: readonly SessionEntryShape[]): WorkerStateEvidence {
  let evidence = emptyWorkerEvidence();
  for (let i = 0; i < entries.length; i++) evidence = foldEntry(evidence, entries[i]!, i);
  return evidence;
}

// ─────────────────────────── S7 observe envelope (§8) ───────────────────────────

/** §8 workerState closed set spelling for the envelope field. */
export type EnvelopeWorkerState = WorkerState;

/**
 * Per-worker S7 observation document. Mirrors the §8 envelope identity
 * fields plus the evidence the classification rested on (so a view never
 * re-derives state on its own — §8 "interpretation is centralized once").
 */
export interface WorkerEnvelope {
  schema: "tre.observe.v1";
  workerId: string;
  episodeId?: string;
  taskId?: string;
  /** Monotonic per-worker document revision (incremented on every write). */
  revision: number;
  /** Observation time (ms epoch). */
  ts: number;
  /** The §14.8 classification. */
  state: EnvelopeWorkerState;
  /** Machine-readable classification detail (tool name / reason / warn kind). */
  detail: string;
  /** §14.8 envelope-level staleness flag (NOT a workerState value). */
  stale: boolean;
  /** Seconds since the watched log was last written (undefined = unknown). */
  secondsSinceLogActivity?: number;
  /** The evidence the classification rested on, incl. `classifiedFrom`. */
  evidence: WorkerStateEvidence & { classifiedFrom: string };
  /** Replay facts of this projection (dedup audit). */
  projection: { entries: number; duplicates: { id: string; count: number }[]; linesSeen: number };
}

/** Options for one envelope projection. */
export interface EnvelopeOptions {
  /** Observation time (default Date.now()). */
  now?: number;
  /** Staleness threshold, default 300000 (§14.8 staleAfterMs). */
  staleAfterMs?: number;
  /** Override the watched-log mtime (ms epoch) — e.g. caller already stat'd. */
  logMtimeMs?: number;
  /** Episode / task identity stamps (§8). */
  episodeId?: string;
  taskId?: string;
  /** When set, the envelope doc is atomically written to <stateDir>/<workerId>.observe.json. */
  stateDir?: string;
}

/** Default §14.8 staleness window. */
export const DEFAULT_STALE_AFTER_MS = 300_000;

/**
 * Project one worker's tailed lines (the whole current knowledge of this
 * worker — caller feeds the accumulated lines) into an S7 observation
 * envelope: §14.8 classification + staleness flag + evidence audit trail.
 * With `stateDir`, the doc is written atomically (tmp + fsync + rename).
 */
export async function projectWorkerEnvelope(
  lines: readonly TailedLine[],
  workerId: string,
  opts?: EnvelopeOptions,
): Promise<WorkerEnvelope> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workerId)) throw new Error("workerId must be a safe path component");
  const now = opts?.now ?? Date.now();
  const staleAfter = opts?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  const projection = projectSessionReplay(lines);
  // Arrival order for evidence (fold order IS story order).
  let evidence = emptyWorkerEvidence();
  let seq = -1;
  for (const line of lines) {
    if (line.json === null) continue;
    if (isProjectionDuplicate(line.id, line, projection)) {
      // Duplicate arrival: still counts for story order of LATER records
      // but does not re-fold the same entry.
      seq++;
      continue;
    }
    seq++;
    evidence = foldEntry(evidence, line.json as SessionEntryShape, seq);
  }

  const cls = classifyWorkerState(evidence);

  const logPath = lines.length > 0 ? lines[lines.length - 1]!.file : undefined;
  let logMtimeMs: number | undefined = opts?.logMtimeMs;
  if (logMtimeMs === undefined && logPath) {
    const info = await stat(logPath).catch(() => null);
    logMtimeMs = info && info.isFile() ? info.mtimeMs : undefined;
  }
  const secondsSinceLogActivity =
    logMtimeMs === undefined ? undefined : Math.max(0, Math.round((now - logMtimeMs) / 1000));
  const stale = logMtimeMs === undefined ? true : now - logMtimeMs > staleAfter;

  let revision = 1;
  const envelope: WorkerEnvelope = {
    schema: "tre.observe.v1",
    workerId,
    revision,
    ts: now,
    state: cls.state,
    detail: cls.detail,
    stale,
    evidence: { ...evidence, classifiedFrom: cls.classifiedFrom },
    projection: {
      entries: projection.entries.size,
      duplicates: projection.duplicates,
      linesSeen: projection.linesSeen,
    },
  };
  if (opts?.episodeId) envelope.episodeId = opts.episodeId;
  if (opts?.taskId) envelope.taskId = opts.taskId;
  if (secondsSinceLogActivity !== undefined) envelope.secondsSinceLogActivity = secondsSinceLogActivity;

  if (opts?.stateDir) {
    const docPath = joinPath(opts.stateDir, `${workerId}.observe.json`);
    const prior = await readJsonOrNull(docPath);
    if (prior && typeof prior.revision === "number" && prior.revision >= 0) revision = prior.revision + 1;
    envelope.revision = revision;
    await writeJsonSynced(docPath, envelope);
  }
  return envelope;
}

/** True when this line's entry was already seen earlier in the same slice. */
function isProjectionDuplicate(id: string, line: TailedLine, projection: ReplayProjection): boolean {
  const keep = projection.entries.get(id);
  return !(keep && keep.sourceFile === (line.file ?? "") && keep.offset === line.offset);
}

/** Validate a foreign payload as a WorkerEnvelope (throws on any violation). */
export function parseWorkerEnvelope(rec: unknown): WorkerEnvelope {
  if (typeof rec !== "object" || rec === null) throw new Error("envelope missing required object");
  const r = rec as Record<string, unknown>;
  if (typeof r.workerId !== "string" || r.workerId.length === 0) throw new Error("envelope missing required field: workerId");
  if (typeof r.revision !== "number" || !Number.isInteger(r.revision) || r.revision < 0) {
    throw new Error("envelope missing required field: revision (non-negative integer)");
  }
  if (typeof r.ts !== "number" || !isFinite(r.ts)) throw new Error("envelope missing required field: ts (finite number)");
  if (typeof r.state !== "string" || !WORKER_STATES.includes(r.state as WorkerState)) {
    throw new Error(`envelope missing required field: state (one of ${WORKER_STATES.join("|")})`);
  }
  if (typeof r.stale !== "boolean") throw new Error("envelope missing required field: stale (boolean)");
  if (typeof r.evidence !== "object" || r.evidence === null) throw new Error("envelope missing required field: evidence");
  if (r.schema !== "tre.observe.v1") throw new Error(`envelope.schema must be "tre.observe.v1" (got ${JSON.stringify(r.schema)})`);
  const env = structuredClone(r) as unknown as WorkerEnvelope;
  if (typeof env.detail !== "string") env.detail = "";
  return env;
}

// ─────────────────────────── live-worker marker (§3 S2/S7 liveness) ───────────────────────────

/** What a worker publishes while alive (pid is a hint, not ownership — §7). */
export interface LiveMarkerInfo {
  workerId: string;
  pid: number;
  commandFingerprint: string;
  startedAt: number;
  episodeId?: string;
}

/** A marker read back, with its staleness verdict. */
export interface LiveMarkerRecord extends LiveMarkerInfo {
  /** Heartbeat time written into the marker (ms epoch). */
  heartbeatTs: number;
  /** True when heartbeatTs is within `staleAfterMs` of the read time. */
  fresh: boolean;
  ageMs: number;
}

/** Live markers older than this are stale (dead-pid false-positive guard). */
export const LIVE_MARKER_STALE_MS = 60_000;

function liveMarkerPath(dir: string, workerId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workerId)) throw new Error("workerId must be a safe path component");
  return joinPath(dir, `${workerId}.live.json`);
}

/** Publish (atomically replace) this worker's live marker. */
export async function writeLiveMarker(dir: string, info: LiveMarkerInfo, now?: number): Promise<void> {
  const doc = { schema: "tre.live.v1" as const, ...info, heartbeatTs: now ?? Date.now() };
  await writeJsonSynced(liveMarkerPath(dir, info.workerId), doc);
}

/**
 * Read a worker's live marker; undefined when absent or corrupt (a corrupt
 * marker is treated as absent — rebuild-from-files, §7 "corrupt file means
 * rebuild, never a failed run"). `fresh` guards the dead-pid false positive:
 * a stale marker may describe a recycled PID, so staleness, not existence,
 * must gate any "worker should be alive" inference.
 */
export async function readLiveMarker(
  dir: string,
  workerId: string,
  now?: number,
  staleAfterMs?: number,
): Promise<LiveMarkerRecord | undefined> {
  const doc = await readJsonOrNull(liveMarkerPath(dir, workerId));
  if (!doc) return undefined;
  if (doc.schema !== "tre.live.v1") return undefined;
  if (typeof doc.workerId !== "string" || typeof doc.pid !== "number" || typeof doc.heartbeatTs !== "number") {
    return undefined;
  }
  const t = now ?? Date.now();
  const ageMs = Math.max(0, t - doc.heartbeatTs);
  const record: LiveMarkerRecord = {
    workerId: doc.workerId,
    pid: doc.pid,
    commandFingerprint: typeof doc.commandFingerprint === "string" ? doc.commandFingerprint : "",
    startedAt: typeof doc.startedAt === "number" ? doc.startedAt : 0,
    heartbeatTs: doc.heartbeatTs,
    fresh: ageMs <= (staleAfterMs ?? LIVE_MARKER_STALE_MS),
    ageMs,
  };
  if (typeof doc.episodeId === "string") record.episodeId = doc.episodeId;
  return record;
}

// ─────────────────────────── §8 episode envelope stream ───────────────────────────

/** §8 observation envelope: one normalized fleet record (append-only stream). */
export interface FleetEnvelope {
  schema: "tre-fleet/1";
  episodeId: string;
  workerId: string;
  taskId?: string;
  /** Per-episode stream sequence (monotonic; interleave key with ts). */
  seq: number;
  /** Emission time (ms epoch). */
  ts: number;
  workerState: EnvelopeWorkerState;
  workerStateDetail?: string;
  /** Envelope-level staleness flag (§14.8), not a workerState value. */
  stale: boolean;
  source: { kind: "session"; entryId: string } | { kind: "decision"; id: string };
  /** The underlying entry/decision, verbatim (§8). */
  event: unknown;
}

/** Validate a foreign payload as a FleetEnvelope (throws on any violation). */
export function parseFleetEnvelope(rec: unknown): FleetEnvelope {
  if (typeof rec !== "object" || rec === null) throw new Error("envelope missing required object");
  const r = rec as Record<string, unknown>;
  if (typeof r.episodeId !== "string" || r.episodeId.length === 0) throw new Error("envelope missing required field: episodeId");
  if (typeof r.workerId !== "string" || r.workerId.length === 0) throw new Error("envelope missing required field: workerId");
  if (typeof r.seq !== "number" || !Number.isInteger(r.seq) || r.seq < 0) throw new Error("envelope missing required field: seq (non-negative integer)");
  if (typeof r.ts !== "number" || !isFinite(r.ts)) throw new Error("envelope missing required field: ts (finite number)");
  if (typeof r.workerState !== "string" || !WORKER_STATES.includes(r.workerState as WorkerState)) {
    throw new Error(`envelope missing required field: workerState (one of ${WORKER_STATES.join("|")})`);
  }
  if (typeof r.stale !== "boolean") throw new Error("envelope missing required field: stale (boolean)");
  const src = r.source as Record<string, unknown> | undefined;
  if (!src || typeof src !== "object") throw new Error('envelope missing required field: source (kind "session"|"decision")');
  if (src.kind === "session" && typeof src.entryId !== "string") throw new Error("session source missing required field: entryId");
  if (src.kind === "decision" && typeof src.id !== "string") throw new Error("decision source missing required field: id");
  if (!("event" in r)) throw new Error("envelope missing required field: event");
  if (r.schema !== "tre-fleet/1") throw new Error(`envelope.schema must be "tre-fleet/1" (got ${JSON.stringify(r.schema)})`);
  const env: FleetEnvelope = {
    schema: "tre-fleet/1",
    episodeId: r.episodeId,
    workerId: r.workerId,
    seq: r.seq,
    ts: r.ts,
    workerState: r.workerState as WorkerState,
    stale: r.stale,
    source: src as FleetEnvelope["source"],
    event: r.event,
  };
  if (typeof r.taskId === "string" && r.taskId.length > 0) env.taskId = r.taskId;
  if (typeof r.workerStateDetail === "string") env.workerStateDetail = r.workerStateDetail;
  return env;
}

/**
 * Per-episode S7 observer (§8 Delivery): tails worker session files and
 * appends the normalized `tre-fleet/1` envelope stream to
 * <episodeDir>/events/fleet.jsonl. Supervisor decisions interleave via
 * emitDecision().
 *
 * SINGLE-WRITER CONTRACT: one supervisor per episodeDir (S3) — same
 * caller contract as the P4 decision journal; seq is recovered from the
 * stream's high-water mark after a restart. Observation-only: watched
 * session files are never written or repaired by this class.
 */
export class FleetObserver {
  private readonly slots = new Map<string, { tailer: JsonlTailer; evidence: WorkerStateEvidence; opts: { taskId?: string; staleAfterMs?: number } }>();
  private seq = 0;
  private seqLoaded = false;

  constructor(readonly episodeDir: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileNameOf(episodeDir))) {
      throw new Error("episodeDir basename must be a safe path component");
    }
  }

  /** Start tailing one worker's session file (offset state lives under events/). */
  watchWorker(workerId: string, sessionFile: string, opts?: { taskId?: string; staleAfterMs?: number }): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workerId)) throw new Error("workerId must be a safe path component");
    if (this.slots.has(workerId)) throw new Error(`worker ${workerId} is already watched`);
    this.slots.set(workerId, {
      tailer: new JsonlTailer(sessionFile, { stateDir: joinPath(this.episodeDir, "events") }),
      evidence: emptyWorkerEvidence(),
      opts: { ...opts },
    });
  }

  watchedWorkers(): string[] {
    return [...this.slots.keys()];
  }

  /**
   * Poll every watched worker, classify each new record (§14.8, at that
   * point of the stream), and append the new envelopes (fsynced before
   * return). Returns the envelopes written.
   */
  async refresh(opts?: { processRunning?: boolean; now?: number; staleAfterMs?: number }): Promise<FleetEnvelope[]> {
    const now = opts?.now ?? Date.now();
    const emitted: FleetEnvelope[] = [];
    for (const [workerId, slot] of this.slots) {
      const lines = await slot.tailer.poll();
      const mtime = await logMtimeMs(slot.tailer.path);
      const staleAfter = opts?.staleAfterMs ?? slot.opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
      const stale = mtime === null ? true : now - mtime > staleAfter;
      for (const line of lines) {
        if (line.json === null) continue;
        slot.evidence = foldEntry(slot.evidence, line.json as SessionEntryShape, slot.evidence.lastSeq + 1);
        const cls = classifyWorkerState(slot.evidence, { processRunning: opts?.processRunning });
        const env: FleetEnvelope = {
          schema: "tre-fleet/1",
          episodeId: fileNameOf(this.episodeDir),
          workerId,
          seq: await this.nextSeq(),
          ts: now,
          workerState: cls.state,
          stale,
          source: { kind: "session", entryId: line.id },
          event: line.json,
        };
        if (slot.opts.taskId) env.taskId = slot.opts.taskId;
        if (cls.detail) env.workerStateDetail = cls.detail;
        emitted.push(env);
      }
    }
    if (emitted.length > 0) {
      await appendSynced(
        joinPath(joinPath(this.episodeDir, "events"), "fleet.jsonl"),
        emitted.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    }
    return emitted;
  }

  /**
   * Append a supervisor-decision envelope (§8: decisions interleave with
   * session records; source {kind:"decision", id}). The decision body is
   * verbatim — record validation of decision bodies is the P4 journal
   * writer's job, not this emitter's.
   */
  async emitDecision(
    id: string,
    decision: Record<string, unknown>,
    opts?: { workerId?: string; taskId?: string; now?: number },
  ): Promise<FleetEnvelope> {
    if (typeof id !== "string" || id.length === 0) throw new Error("decision id is required");
    const env: FleetEnvelope = {
      schema: "tre-fleet/1",
      episodeId: fileNameOf(this.episodeDir),
      workerId: opts?.workerId ?? "supervisor",
      seq: await this.nextSeq(),
      ts: opts?.now ?? Date.now(),
      workerState: "unknown",
      stale: false,
      source: { kind: "decision", id },
      event: decision,
    };
    if (opts?.taskId) env.taskId = opts.taskId;
    await appendSynced(joinPath(this.episodeDir, "events", "fleet.jsonl"), JSON.stringify(env) + "\n");
    return env;
  }

  /** Current evidence for one watched worker (post-refresh view; no I/O). */
  evidenceOf(workerId: string): WorkerStateEvidence {
    const slot = this.slots.get(workerId);
    if (!slot) throw new Error(`worker ${workerId} is not watched`);
    return slot.evidence;
  }

  private async nextSeq(): Promise<number> {
    if (!this.seqLoaded) {
      this.seqLoaded = true;
      // Recover the high-water mark from the stream itself: the envelope
      // file is the record; seq only needs to stay monotonic per episode.
      const text = await readFile(joinPath(this.episodeDir, "events", "fleet.jsonl"), "utf-8").catch(() => "");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { seq?: number };
          if (typeof parsed.seq === "number" && parsed.seq >= this.seq) this.seq = parsed.seq + 1;
        } catch {
          /* torn line in our own stream: skip for the max scan. */
        }
      }
    }
    return this.seq++;
  }
}

// ─────────────────────────── shared helpers ───────────────────────────

function fileNameOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
function parentDirOf(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx > 0 ? p.slice(0, idx) : ".";
}
function joinPath(a: string, ...rest: string[]): string {
  let out = a;
  for (const b of rest) out = out.endsWith("/") ? out + b : `${out}/${b}`;
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  if (a.length === 0) return b as Uint8Array<ArrayBuffer>;
  if (b.length === 0) return a as Uint8Array<ArrayBuffer>;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Split on newlines: only COMPLETE lines plus the trailing remainder. */
function splitCompleteLines(data: Uint8Array): { done: Uint8Array[]; rest: Uint8Array<ArrayBuffer> } {
  const done: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a) {
      done.push(data.slice(start, i));
      start = i + 1;
    }
  }
  return { done, rest: data.slice(start) };
}

/** Strict UTF-8 decode (invalid bytes → null → caller drops the line). */
const strictDecoder = new TextDecoder("utf-8", { fatal: true });
function decodeLine(raw: Uint8Array): string | null {
  try {
    return strictDecoder.decode(raw);
  } catch {
    return null;
  }
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function fingerprint(s: string): string {
  return `fp-${createHash("sha256").update(s).digest("hex").slice(0, 16)}`;
}

async function readHead(path: string, len: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; mtimeMs: number }> {
  const fh = await open(path, "r");
  try {
    const info = await fh.stat();
    const headLen = Math.min(len, info.size);
    const bytes = new Uint8Array(headLen);
    if (headLen > 0) await fh.read(bytes, 0, headLen, 0);
    return { bytes, mtimeMs: info.mtimeMs };
  } finally {
    await fh.close();
  }
}

async function logMtimeMs(path: string): Promise<number | null> {
  const info = await stat(path).catch(() => null);
  return info && info.isFile() ? info.mtimeMs : null;
}

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function readJsonOrNull(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Append + fsync before return (same durability bound as the P4 journal). */
async function appendSynced(path: string, data: string): Promise<void> {
  const fh = await open(path, "a");
  try {
    await fh.appendFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** tmp + fsync + rename (atomic replacement; process-death durability). */
async function writeJsonSynced(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(value) + "\n");
  const fh = await open(tmp, "r+");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}
