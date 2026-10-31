/**
 * P3b — file-backed steering delivery (docs/11 §3/S2, §14.2, §13.1, §13.3).
 *
 * `FileSteeringQueue` implements the loop's `SteeringQueue` seam over a JSONL
 * file appended by the supervisor (`--steer-file <path>`):
 *
 *  - Offset-tolerant incremental drain: only bytes past the persisted cursor
 *    are DELIVERED; a torn trailing line is held (never delivered, never
 *    repaired — §13.1 repair belongs to the exclusive writer). Truncation
 *    (size < offset) or in-place replacement (head fingerprint or mtime
 *    moved at the same size) reconciles the cursor to 0 and rescans — the
 *    §13.1-aware reader rule, same as the P5 tailer.
 *  - Malformed lines: skipped, never fatal; counted and warned (docs/11 §3:
 *    "skipped count logged to stderr"). Validation follows the §14.2 table:
 *    missing/non-string `id` or `text`, a `priority` other than "steer", or
 *    a non-object line → malformed.
 *  - Scoped requests (§14.2): managed mode (`attemptId` given) enforces the
 *    mismatch rule — a line whose `attemptId` ≠ the run's attempt identity
 *    is skipped and counted as `scopeMismatch`, never injected and never
 *    silently acked (stale guidance after a task rewrite / session swap
 *    stays pending-unrecorded; the supervisor reconciles per S2 scoping).
 *    Unmanaged (standalone `--steer-file`) → the check is OFF.
 *  - Dedup by request id over the SESSION TRANSCRIPT (I4): at startup and
 *    before every drain window the session file is scanned incrementally
 *    for persisted `steering.requestId` envelopes (the P3a `MessageEntry`
 *    field). Same id + same text → already recorded: no-op re-delivery
 *    (counted `dedupAcked`). Same id + different text → `conflictRejected`
 *    with a stderr warning — NOT injected, NOT acked; the supervisor
 *    decides (retire the id or escalate). Offsets are an optimization,
 *    never delivery authority: the transcript dedups across restarts AND
 *    compaction boundaries.
 *  - Crash-eligibility (§13.3 rows 1/2): the PERSISTED offset advances only
 *    past lines whose injected steers were observed recorded in the
 *    session. Crash before persist → offset stayed behind → the request is
 *    eligible again after restart (no lost-and-unrecorded state). Crash
 *    after persist → re-delivery dedups to a no-op (no duplicate transcript
 *    insertion).
 *  - Delivery claims DEDUPLICATED TRANSCRIPT INSERTION ONLY — never
 *    exactly-once execution (I6). The ack is the persisted envelope itself;
 *    the CLI persist tap fsyncs request-carrying steer appends before the
 *    queue can observe them (§13.1: steer receipts sync before ack).
 *
 * `push()` keeps the shared-driver contract (TTY/Telegram steer routes
 * through the same per-turn queue): pushed items are memory-only and drain
 * first, file entries after. A file steer never arrives via `push()`.
 *
 * Drain is synchronous (the `SteeringQueue` interface, P3a) — so all file
 * I/O here is the sync fs family; each drain reads only the bytes appended
 * since the last one (the whole file is opened, the slice delivered from
 * the cursor; O(size) read, O(appended) delivery).
 *
 * Compartment: src/steer imports only node: builtins (types are type-only
 * imports, erased at runtime). Nothing outside src/cli/ may import this
 * module until P9 wires the supervisor in — the test suite pins both.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { SteerEntry } from "../types.js";
import type { SteeringQueue } from "../loop/agent-loop.js";

/** One accepted line of the steer file (docs/11 §3 S2 schema). */
export interface SteerRequest {
  /** Client-assigned, unique per file; the ack correlation key. */
  id: string;
  /** Unix seconds, informational. */
  ts?: number;
  /** Injected exactly as given (no harness templating). */
  text: string;
  /** Provenance label; default "file" (§14.2 table). */
  source?: string;
  /** v1 only "steer"; anything else is skipped + counted. */
  priority?: string;
  /** Managed mode only: the attempt this steer targets (scope check). */
  attemptId?: string;
  /** Scheduling label only — the harness never interprets it. */
  taskId?: string;
}

export interface FileSteeringQueueOptions {
  /** The steer file (created empty at startup if absent — §3). */
  path: string;
  /** Session JSONL scanned for persisted `steering.requestId` envelopes. */
  sessionPath: string;
  /**
   * Managed mode: this run's attempt identity (§14.1). Absent → unmanaged
   * (standalone `--steer-file`): the `attemptId` mismatch check is OFF.
   */
  attemptId?: string;
  /** Warning sink (the CLI passes stderr). Default: silent. */
  warn?: (message: string) => void;
  /** Offset-state path. Default: `<path>.offset.json`. */
  statePath?: string;
}

/** Cumulative counters (docs/11 §3: skipped lines are counted, never silent). */
export interface FileSteeringStats {
  /** Complete steer-file lines read (all classes). */
  linesRead: number;
  /** Steers injected (new, in-scope, non-duplicate) into a drain. */
  injected: number;
  /** Malformed lines (unparseable or failing the §14.2 validation table). */
  malformed: number;
  /** Managed-mode lines whose attemptId ≠ this run's, skipped (§14.2). */
  scopeMismatch: number;
  /** Re-deliveries of an id already recorded with the same text — acked no-ops. */
  dedupAcked: number;
  /** Same id + different text → rejected (not injected, not acked). */
  conflictRejected: number;
}

/** Persisted reader cursor (JSON; tmp+fsync+rename — process-death durable).
 *  The persisted offset is ALWAYS a line boundary: at save time it is
 *  clamped back to the last delivered newline (`offset - heldLen`), so the
 *  held partial's bytes sit AT OR AFTER the persisted offset and are
 *  re-read from the file on restart — the partial itself needs no
 *  persistence (a persisted partial could not survive the pending-line
 *  rollback anyway: the rolled-back offset may precede the partial's
 *  bytes, and re-reading them from the file while also re-joining a saved
 *  partial would duplicate them). The head fingerprint IS persisted: it is
 *  a function of the file's first bytes only (independent of the offset),
 *  so restoring it keeps same-size in-place replacement detected across a
 *  restart — otherwise the divergence check would only re-arm after the
 *  first post-restart scan, and a replacement at the persisted size would
 *  slice the new content from mid-line (§13.1). */
interface OffsetState {
  /** Byte offset of the first NOT-yet-read byte — ALWAYS at a line
   *  boundary (never past a consumed partial). */
  offset: number;
  /** Base64 head fingerprint at save time (""/absent = not established;
   *  a first scan after a restart then re-fingerprints the file). */
  headB64?: string;
}

/** Prefix bytes fingerprinted for in-place-replacement detection (P5 rule). */
const HEAD_LEN = 64;

/** Per-file incremental scan cursor (one per watched JSONL file). */
interface ScanCursor {
  /** Byte offset of the first not-yet-delivered byte (partial excluded). */
  offset: number;
  /** Base64 of the held partial tail (bytes read, no newline yet). */
  partialB64: string;
  /** Base64 of the first HEAD_LEN bytes at the last scan ("" = unset). */
  headB64: string;
}

const freshCursor = (): ScanCursor => ({ offset: 0, partialB64: "", headB64: "" });

interface ScanResult {
  /** Complete lines (no terminator), in file order. */
  lines: string[];
  /** Absolute byte offset just past the last delivered line. */
  end: number;
  /** True when this scan restarted from 0 (shrink/replacement/disappear):
   *  the caller's derived state must be rebuilt from the delivered lines. */
  resumed: boolean;
  /** True when the file was readable this scan. */
  scanned: boolean;
}

/**
 * Incremental, §13.1-aware JSONL scan of one file: deliver only complete
 * lines past the cursor; hold a partial tail; reconcile (rescan from 0,
 * `resumed` set) when the file shrank, was replaced in place (head
 * fingerprint moved at any size), or disappeared after having content.
 */
function scanJsonl(path: string, cursor: ScanCursor): ScanResult {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    // Unreadable/absent. If we had consumed bytes (or remembered an
    // identity), the file vanished: a §13.1 replacement signal — reset
    // for the next successful scan.
    if (cursor.offset > 0 || cursor.headB64 !== "") {
      cursor.offset = 0;
      cursor.partialB64 = "";
      cursor.headB64 = "";
      return { lines: [], end: 0, resumed: true, scanned: false };
    }
    return { lines: [], end: 0, resumed: false, scanned: false };
  }

  // Reconcile BEFORE parsing: the append-only contract broken under the
  // reader (shrink OR in-place replacement at ANY size) resets the cursor
  // to 0 and rescans the whole file THIS call — re-delivered lines settle
  // through the transcript/pending dedup and are never re-injected. The
  // head fingerprint is checked against the buffer already in hand (free):
  // a replacement that leaves the file larger than the offset still moves
  // the head, which a size-only shrink check would miss.
  let resumed = false;
  if (cursor.offset > 0 && (buf.length < cursor.offset || headDiverges(cursor.headB64, buf))) {
    cursor.offset = 0;
    cursor.partialB64 = "";
    resumed = true;
  }

  const held = Buffer.from(cursor.partialB64, "base64");
  const all = Buffer.concat([held, buf.subarray(cursor.offset, buf.length)]);
  const lastNL = all.lastIndexOf(0x0a);
  const lines: string[] = [];
  if (lastNL < 0) {
    // No complete line yet: hold everything. The held bytes are consumed
    // into the partial (offset advances) so the next scan reads only the
    // NEW bytes and joins them — never re-prepending the held fragment.
    // (Invariant: the partial's bytes sit immediately BEFORE `offset`, at
    // [offset - heldLen, offset). saveState relies on this to clamp the
    // persisted offset back to the partial's line start.)
    cursor.partialB64 = all.toString("base64");
    cursor.offset = buf.length;
    if (cursor.headB64 === "") cursor.headB64 = headOf(buf);
    return { lines: [], end: buf.length, resumed, scanned: true };
  }
  for (const line of all.subarray(0, lastNL).toString("utf8").split("\n")) lines.push(line);
  cursor.partialB64 = all.subarray(lastNL + 1).toString("base64");
  // Absolute offset just past the last newline: the scan window started
  // (logically) at cursor.offset - held.length; the newline sits at
  // lastNL within the window.
  const endOff = cursor.offset - held.length + lastNL + 1;
  cursor.offset = endOff;
  cursor.headB64 = headOf(buf);
  return { lines, end: endOff, resumed, scanned: true };
}

/** First HEAD_LEN bytes of a buffer as base64 (clamped to the size). */
function headOf(buf: Buffer): string {
  return buf.subarray(0, HEAD_LEN).toString("base64");
}

/**
 * True when the stored head no longer matches the file: replacement is
 * detected by prefix mismatch (a short stored head from a short file must
 * still prefix the grown file — appends never move the head).
 */
function headDiverges(storedB64: string, buf: Buffer): boolean {
  if (storedB64 === "") return false; // identity not yet established
  const stored = Buffer.from(storedB64, "base64");
  if (buf.length < stored.length) return true; // fingerprint no longer fits
  return !buf.subarray(0, stored.length).equals(stored);
}

/**
 * File-backed `SteeringQueue` (docs/11 §3/S2). One instance per run — one
 * consumer per steer file, and the (steer file, session file) pair has
 * exactly one harness at a time (ownership fence, §13.2 I1).
 */
export class FileSteeringQueue implements SteeringQueue {
  readonly path: string;
  readonly sessionPath: string;
  /** Managed mode: set when the run carries an attempt identity (§14.1). */
  readonly attemptId: string | undefined;

  private readonly statePath: string;
  private readonly warn: (message: string) => void;

  /** Items pushed via `push()` (shared drivers), drained before file lines. */
  private readonly mem: (string | SteerEntry)[] = [];

  /** Steer-file read cursor (persisted across restarts). */
  private cursor: ScanCursor = freshCursor();
  /** Session scan cursor (in-memory: the transcript itself is authority). */
  private sessionCursor: ScanCursor = freshCursor();
  /**
   * Request ids recorded in the session transcript: id → normalized text
   * (incremental scan; rebuilt on a session rescan — §14.2: offsets are
   * an optimization, the transcript is the dedup authority).
   */
  private readonly recorded = new Map<string, string>();
  /**
   * Ids injected by this process but NOT yet observed recorded → the line
   * byte-start and the injected text. Holds the persisted offset back to
   * the START of any unrecorded line (§13.3 rows 1/2), and gives the
   * re-read guard
   * the pending text to compare against (a rescan must not mistake a
   * handed-off-but-unrecorded injection for a text conflict on redelivery
   * of the SAME text — that settles as an acked no-op).
   */
  private readonly pendingInjected = new Map<string, { lineStart: number; text: string; source: string }>();
  /** Ids whose re-delivery was conflict-rejected (warn once per id). */
  private readonly conflicted = new Set<string>();
  /** Ids settled out-of-scope at first read (warn once per id). */
  private readonly scopeWarned = new Set<string>();

  /** Accepted file entries awaiting the next drain handoff. */
  private ready: SteerEntry[] = [];

  private readonly stats: FileSteeringStats = {
    linesRead: 0,
    injected: 0,
    malformed: 0,
    scopeMismatch: 0,
    dedupAcked: 0,
    conflictRejected: 0,
  };

  private closed = false;

  constructor(opts: FileSteeringQueueOptions) {
    this.path = resolve(opts.path);
    this.sessionPath = resolve(opts.sessionPath);
    this.attemptId = opts.attemptId;
    this.warn = opts.warn ?? (() => {});
    this.statePath = resolve(opts.statePath ?? `${this.path}.offset.json`);
    // §3: "File is created by the harness at startup if absent (empty)."
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      if (!existsSync(this.path)) writeFileSync(this.path, "", { flag: "ax" }); // never truncates an existing file
    } catch (err) {
      // mkdir/create failure: the first scan reports reads; warns flow.
      this.warnOnce(`steer-file: cannot create ${this.path} (${String(err)})`);
    }
    this.loadState();
    // Startup dedup scan (§14.2: "at startup and before each drain window").
    this.scanTranscript();
  }

  /** Cumulative counters (the CLI prints a one-liner at run end). */
  getStats(): Readonly<FileSteeringStats> {
    return { ...this.stats };
  }

  /**
   * `SteeringQueue.push` — memory items from shared drivers (TTY/Telegram
   * steer). File steers never take this path (the supervisor appends).
   */
  push(text: string | SteerEntry): void {
    if (this.closed) return;
    this.mem.push(text);
  }

  /**
   * `SteeringQueue.drain` — scan the transcript (dedup + settle), scan the
   * steer file (new lines → validation, scope, dedup, injection), persist
   * the safe offset, then hand off: pushed items first, file entries after.
   */
  drain(): (string | SteerEntry)[] {
    if (this.closed) return [];
    this.scanTranscript();
    this.readSteerFile();
    this.settlePending();
    this.saveState();
    const out: (string | SteerEntry)[] = this.mem.splice(0, this.mem.length);
    out.push(...this.ready.splice(0, this.ready.length));
    return out;
  }

  /** Stop consuming (run end); persists the final offset. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.saveState();
  }

  // ─────────────────────────── internals ───────────────────────────

  private loadState(): void {
    let raw: string;
    try {
      raw = readFileSync(this.statePath, "utf8");
    } catch {
      return; // no state → fresh cursor (offset 0)
    }
    try {
      const parsed = JSON.parse(raw) as OffsetState;
      if (Number.isInteger(parsed.offset) && parsed.offset >= 0) {
        this.cursor.offset = parsed.offset;
        // The persisted offset is a line boundary (saveState clamps it back
        // over any held partial), and the head fingerprint is a function of
        // the file's first bytes only — both restore cleanly. A same-size
        // in-place replacement across the restart is caught by the restored
        // head (§13.1); an absent/corrupt head just re-arms the check on
        // the first post-restart scan (conservative, deduped).
        if (typeof parsed.headB64 === "string") this.cursor.headB64 = parsed.headB64;
      }
    } catch {
      // A corrupt state file means NO state (offset 0): the full rescan
      // dedups against the transcript, so redelivery is harmless.
      this.cursor = freshCursor();
    }
  }

  /**
   * Persist the reader cursor. The offset never advances past a line whose
   * injected steer is still unobserved in the session (§13.3 rows 1/2).
   * tmp + fsync + rename (process-death durability — the P4/P5 pattern).
   */
  private saveState(): void {
    // The scanned offset sits PAST the held partial (its bytes are at
    // [offset - heldLen, offset) — scanJsonl consumes them into the
    // partial). Persisting that offset would lose the partial on restart:
    // a fresh cursor at the persisted offset skips the partial's bytes in
    // the file, losing the in-flight line (or reframing the next line's
    // bytes). Clamp back over the partial so the persisted offset is a
    // line boundary and the partial is re-read from the file on restart.
    let safeOffset = this.cursor.offset - Buffer.byteLength(this.cursor.partialB64, "base64");
    for (const p of this.pendingInjected.values()) {
      if (p.lineStart < safeOffset) safeOffset = p.lineStart;
    }
    // The head fingerprint is offset-independent (first 64 bytes), so it
    // persists safely alongside a clamped offset — restoring it keeps the
    // same-size replacement check armed across restarts.
    const state: OffsetState =
      this.cursor.headB64 === "" ? { offset: safeOffset } : { offset: safeOffset, headB64: this.cursor.headB64 };
    const tmp = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(tmp, JSON.stringify(state) + "\n");
      const fd = openSync(tmp, "r+");
      try {
        // fsync before rename: state must survive process death (§13.1).
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.statePath);
    } catch (err) {
      // A failed state write is SAFE by construction: the persisted offset
      // stays at its previous (≤) value, so the next start redelivers from
      // there and the transcript dedup settles every re-read (rows 1/2).
      this.warnOnce(`steer-file: offset state write failed (${String(err)}) — a restart rescans from the last persisted offset (transcript deduped)`);
    }
  }

  /** Scan the session transcript (incrementally) for recorded request ids. */
  private scanTranscript(): void {
    const res = scanJsonl(this.sessionPath, this.sessionCursor);
    if (!res.scanned && !res.resumed) return;
    if (res.resumed) this.recorded.clear();
    for (const line of res.lines) {
      const rec = extractRecordedSteer(line);
      if (rec !== undefined) this.recorded.set(rec.requestId, rec.text);
    }
  }

  /** Read new steer-file lines; apply the §14.2 validation/dedup/scope table. */
  private readSteerFile(): void {
    const res = scanJsonl(this.path, this.cursor);
    if (!res.scanned && !res.resumed) return;
    // A `resumed` scan (the append-only contract broken under the reader)
    // needs no special state: every injection this process made is already
    // in `pendingInjected` (set at injection, cleared when the transcript
    // records it), so re-delivered lines settle through the normal dedup
    // and pending-guard paths below.
    // Absolute line offsets: `res.end` is past the batch; walk back by the
    // UTF-8 byte length of each line plus its terminator.
    let pos = res.end - res.lines.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
    if (res.lines.length > 0) this.stats.linesRead += res.lines.length;
    for (const line of res.lines) {
      const lineStart = pos;
      pos += Buffer.byteLength(line, "utf8") + 1;
      this.acceptLine(line, lineStart);
    }
  }

  /** Settle injections the transcript now proves recorded (ack correlation). */
  private settlePending(): void {
    for (const id of [...this.pendingInjected.keys()]) {
      if (this.recorded.has(id)) this.pendingInjected.delete(id);
    }
  }

  /** One complete steer line: validate → scope → dedup → inject, or count. */
  private acceptLine(line: string, lineStart: number): void {
    if (line.trim() === "") return;
    let req: SteerRequest;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.countMalformed("not an object");
        return;
      }
      req = parsed as SteerRequest;
    } catch {
      this.countMalformed("unparseable JSON");
      return;
    }
    // §14.2 validation table.
    if (typeof req.id !== "string" || req.id === "") {
      this.countMalformed("missing id");
      return;
    }
    if (typeof req.text !== "string") {
      this.countMalformed(`missing text (id ${req.id})`);
      return;
    }
    if (req.priority !== undefined && req.priority !== "steer") {
      this.countMalformed(`unknown priority ${JSON.stringify(req.priority)} (v1 allows only "steer") (id ${req.id})`);
      return;
    }
    if (req.source !== undefined && typeof req.source !== "string") {
      this.countMalformed(`non-string source (id ${req.id})`);
      return;
    }
    // Managed-mode scope check (§14.2): mismatch — including a missing
    // attemptId, since the supervisor always writes it — is skipped and
    // counted, NEVER injected and never silently treated as acked.
    if (this.attemptId !== undefined && req.attemptId !== this.attemptId) {
      this.stats.scopeMismatch += 1;
      if (!this.scopeWarned.has(req.id)) {
        this.scopeWarned.add(req.id);
        this.warn(
          `steer-file: steer ${req.id} targets attempt ${JSON.stringify(req.attemptId ?? null)} ≠ this run ${JSON.stringify(this.attemptId)} — skipped as scope_mismatch (stays pending-unrecorded; count ${this.stats.scopeMismatch})`,
        );
      }
      return;
    }
    // Transcript dedup by request id (I4).
    const text = normalizeText(req.text);
    const rec = this.recorded.get(req.id);
    if (rec !== undefined) {
      if (rec === text) {
        // Same id + same text: already recorded — no-op re-delivery (ack).
        this.stats.dedupAcked += 1;
        this.pendingInjected.delete(req.id);
        return;
      }
      this.rejectConflict(req.id, "the recorded envelope");
      return;
    }
    // Re-read while still pending-unrecorded (a supervisor retry racing
    // the persist, a rescan, or a redelivery after an aborted run took a
    // handed-off steer with it):
    //  - still queued in `ready` (this batch, not yet handed off) → the
    //    existing entry covers it: counted ack, never a duplicate.
    //  - handed off but never recorded (an abort dropped it) → eligible
    //    again: re-inject (offset stays held back by pendingInjected).
    const pending = this.pendingInjected.get(req.id);
    if (pending !== undefined) {
      if (pending.text === text) {
        if (this.ready.some((e) => e.requestId === req.id)) {
          this.stats.dedupAcked += 1;
          return;
        }
        this.stats.injected += 1;
        this.pendingInjected.set(req.id, { lineStart, text, source: pending.source });
        this.ready.push({ text: req.text, requestId: req.id, source: pending.source });
        return;
      }
      this.rejectConflict(req.id, "the still-pending injection");
      return;
    }
    // New request → inject with envelope provenance: requestId = the line
    // id, source default "file" (§14.2). The line's START offset holds the
    // persisted cursor back until the transcript records the id: crash
    // before the record → the whole line is re-read on restart (§13.3).
    const source = typeof req.source === "string" && req.source !== "" ? req.source : "file";
    this.pendingInjected.set(req.id, { lineStart, text, source });
    this.stats.injected += 1;
    this.ready.push({ text: req.text, requestId: req.id, source });
  }

  private rejectConflict(id: string, against: string): void {
    this.stats.conflictRejected += 1;
    if (!this.conflicted.has(id)) {
      this.conflicted.add(id);
      this.warn(
        `steer-file: REJECTED steer ${id} — same request id, different text than ${against} (not injected, not acked; the supervisor must retire the id or escalate) (count ${this.stats.conflictRejected})`,
      );
    }
  }

  private countMalformed(why: string): void {
    this.stats.malformed += 1;
    this.warnOnce(`steer-file: malformed line — ${why}, skipped (count ${this.stats.malformed})`);
  }

  private warnedKeys = new Set<string>();
  private warnOnce(message: string): void {
    // One warning per distinct cause (the counter keeps climbing in stats;
    // a streaming stderr would spam per malformed line otherwise).
    const key = message.replace(/count \d+\)/, ")");
    if (this.warnedKeys.has(key)) return;
    if (this.warnedKeys.size > 64) this.warnedKeys.clear();
    this.warnedKeys.add(key);
    this.warn(message);
  }
}

/**
 * Extract (requestId, text) from one session JSONL line when it is a
 * steering envelope (the P3a `MessageEntry.steering` shape); undefined for
 * everything else. Malformed lines are ignored (the session writer owns
 * that file's validity).
 */
function extractRecordedSteer(line: string): { requestId: string; text: string } | undefined {
  if (line.trim() === "") return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (obj === null || typeof obj !== "object") return undefined;
  const entry = obj as { type?: unknown; steering?: unknown; message?: unknown };
  if (entry.type !== "message" || entry.steering === null || typeof entry.steering !== "object") {
    return undefined;
  }
  const meta = entry.steering as { requestId?: unknown };
  if (typeof meta.requestId !== "string" || meta.requestId === "") return undefined;
  const msg = entry.message as { content?: unknown } | undefined;
  return { requestId: meta.requestId, text: normalizeText(contentToText(msg?.content)) };
}

/** Message content → comparable text. Steers carry plain text; a block
 *  array joins its text blocks (a steer rewritten by compaction is
 *  compared on its surviving text — §14.2 "including past compaction
 *  boundaries" concerns SCAN reach, not rewritten text). */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b !== null && typeof b === "object" && (b as { type?: unknown }).type === "text"
          ? String((b as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

/** Comparison normalization: trailing newlines added by an editor do not
 *  make a different request; anything else does (text is injected as-is). */
function normalizeText(text: string): string {
  return text.replace(/\n+$/, "");
}
