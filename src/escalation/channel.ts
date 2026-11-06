/**
 * P13/M1 — human escalation channel (contract: docs/19).
 *
 * The durable, actionable record of "a human must decide": blocker,
 * decision needed, evidence, attempts — appended BEFORE delivery, deduped
 * per (episode, task, blocker), never spamming (docs/11 §9 anti-loop
 * hygiene applies to the supervisor's own notices). Delivery is an
 * injected port (the ONE consumer lives outside this module); this module
 * never sends anything, never touches fs/process/network (INV-1), and is
 * a total function over hostile input (INV-4): every path yields a valid
 * record, a clean null, or a disclosed degradation — never a throw of
 * the module's own making.
 *
 * The hostile-input fence is the P15 pattern (docs/17 §"Hostile-input
 * fence"): own DATA descriptors only (accessors never invoked, inherited
 * props never read), arrays copied under a once-observed re-verified
 * length with a bounded scan budget, revoked/trapping handles disclosed
 * (`bad-input:packet`) and never fatal. The module imports NOTHING but
 * node:crypto (INV-8, guarded by test).
 */
import { createHash } from 'node:crypto';

// ─── Closed sets (INV-3) ───────────────────────────────────────────────────

export const ESCALATION_SCHEMA = 'tre-escalation/1' as const;

export const BLOCKERS = [
  'budget-exhausted',
  'repeated-strategy',
  'approval-boundary',
  'environment-blocker',
  'gate-defect',
  'ambiguous-effect',
  'bad-input',
  'unknown',
] as const;
export type Blocker = (typeof BLOCKERS)[number];

export const DECISIONS = ['approve', 'deny', 'rewrite', 'abort', 'resume-with-note'] as const;
export type Decision = (typeof DECISIONS)[number];

/** docs/19 §2: every blocker carries a default "decision needed" — the
 *  channel never leaves the human without an actionable question. */
const DEFAULT_DECISION_NEEDED: Record<Blocker, string> = {
  'budget-exhausted': 'raise the budget, rewrite the task, or abort',
  'repeated-strategy': 'approve a new approach, rewrite the task, or abort',
  'approval-boundary': 'grant the approval or deny it',
  'environment-blocker': 'fix the environment or abort',
  'gate-defect': 'repair the gate or override with evidence',
  'ambiguous-effect': 'confirm the effect landed or authorize the retry',
  'bad-input': 'correct the task inputs',
  unknown: 'review the evidence and decide',
};

// Bounds (INV-4)
const MAX_STR = 240;
const MAX_EVIDENCE = 16;
const MAX_ATTEMPTS = 10;
const COPY_SCAN_BUDGET = MAX_EVIDENCE * 16;
const DEFAULT_MAX_REDELIVER = 3;

// ─── Hostile-input fence (the P15 pattern, docs/17) ────────────────────────

function ownData(obj: unknown, key: string): { value?: unknown; present: boolean; threw?: boolean; accessor?: boolean } {
  if (typeof obj !== 'object' || obj === null) return { present: false };
  try {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    if (d === undefined) return { present: false };
    if (!('value' in d)) return { present: false, accessor: true }; // cycle-2 F3: a get/set field is present-but-not-data — the CALLER must disclose it
    return { value: d.value, present: true };
  } catch {
    return { present: false, threw: true };
  }
}

function isArraySafe(v: unknown): v is unknown[] {
  if (typeof v !== 'object' || v === null) return false;
  try {
    return Array.isArray(v);
  } catch {
    return false; // revoked/trapping array
  }
}

/** True ONLY for a hostile-present handle (revoked proxy / trapping
 *  target) whose IsArray or getPrototypeOf intrinsic THROWS. Plain
 *  garbage answers false (A8-F2: hostile must be distinguishable). */
function trapPresent(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  try {
    Array.isArray(v);
    Object.getPrototypeOf(v);
    return false;
  } catch {
    return true;
  }
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
  try {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

function boundedStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return v.length > MAX_STR ? v.slice(0, MAX_STR) : v;
}

type StrCopy = { strs: string[]; overflow: boolean; dropped: boolean; hostile: boolean; skipped: boolean; clipped: boolean; nonArray: boolean };

/** Copy a string array fence-safely: length observed ONCE and re-verified
 *  after the copy; per-index descriptor traps, length lies, and scan-budget
 *  exhaustion all DISCLOSE (P15 A6/A7 pattern, docs/19 §7). */
function copyStrs(raw: unknown, clipAt?: number): StrCopy {
  if (!isArraySafe(raw)) {
    // Cycle-3 F6: a PRESENT non-array (evidence:"x") is untrusted data
    // that did not survive — nonArray discloses it, never a silent [].
    const nonArray = raw !== undefined && raw !== null && !trapPresent(raw);
    return { strs: [], overflow: false, dropped: false, hostile: trapPresent(raw), skipped: false, clipped: false, nonArray };
  }
  let n = 0;
  let ok = true;
  try {
    const len = (raw as unknown[]).length;
    ok = Number.isInteger(len) && len >= 0;
    n = ok ? (len as number) : 0;
  } catch {
    ok = false;
  }
  const out: string[] = [];
  let overflow = false;
  let skipped = false; // cycle-3 F6: a present non-string entry was dropped
  let clipped = false; // cycle-3 F6: an entry was shortened to MAX_STR
  let scanned = 0;
  for (let i = 0; i < n && ok; i++) {
    if (scanned >= COPY_SCAN_BUDGET) {
      overflow = true; // entries remain unvisited: disclosed, never silently dropped
      break;
    }
    scanned++;
    let d: PropertyDescriptor | undefined;
    try {
      d = Object.getOwnPropertyDescriptor(raw, i);
    } catch {
      ok = false;
      break;
    }
    if (d === undefined) continue; // deleted hole: benign
    if (!('value' in d)) {
      // An ACCESSOR mid-evidence is not data a human wrote — evidence
      // arrays are values; a get/set descriptor is hostile input and the
      // whole array drops (never invoke it, never silently skip it).
      ok = false;
      break;
    }
    const rawV = d.value;
    const s = boundedStr(rawV);
    if (s === undefined) {
      if (rawV !== undefined) skipped = true; // present garbage: disclosed
      continue;
    }
    if (rawV.length > MAX_STR || (clipAt !== undefined && rawV.length > clipAt)) clipped = true;
    if (out.length < MAX_EVIDENCE) out.push(s);
    else overflow = true;
  }
  if (!ok) return { strs: [], overflow: false, dropped: true, hostile: true, skipped: false, clipped: false, nonArray: false };
  try {
    if ((raw as unknown[]).length !== n) return { strs: [], overflow: false, dropped: true, hostile: true, skipped: false, clipped: false, nonArray: false };
  } catch {
    return { strs: [], overflow: false, dropped: true, hostile: true, skipped: false, clipped: false, nonArray: false };
  }
  return { strs: out, overflow, dropped: false, hostile: false, skipped, clipped, nonArray: false };
}

type AttemptCopy = { attempts: { action: string; strategyId?: string; detail?: string }[]; overflow: boolean; dropped: boolean; hostile: boolean; skipped: boolean; clipped: boolean; nonArray: boolean };

/** Same fence for the attempts array (objects of bounded strings). */
function copyAttempts(raw: unknown): AttemptCopy {
  if (!isArraySafe(raw)) {
    // Cycle-3 F6: a present non-array discloses, never a silent [].
    const nonArray = raw !== undefined && raw !== null && !trapPresent(raw);
    return { attempts: [], overflow: false, dropped: false, hostile: trapPresent(raw), skipped: false, clipped: false, nonArray };
  }
  let n = 0;
  let ok = true;
  try {
    const len = (raw as unknown[]).length;
    ok = Number.isInteger(len) && len >= 0;
    n = ok ? (len as number) : 0;
  } catch {
    ok = false;
  }
  const out: { action: string; strategyId?: string; detail?: string }[] = [];
  let scanned = 0;
  let overflow = false;
  let skipped = false; // cycle-3 F6: a present-but-usable attempt entry was dropped
  let clipped = false; // cycle-3 F6: a field shortened at MAX_STR
  const clippedIf = (v: unknown) => typeof v === 'string' && v.length > MAX_STR;
  for (let i = 0; i < n && ok; i++) {
    if (scanned >= COPY_SCAN_BUDGET) {
      overflow = true; // cycle-2 F8: entries remain unvisited — disclosed, never silent
      break;
    }
    scanned++;
    let d: PropertyDescriptor | undefined;
    try {
      d = Object.getOwnPropertyDescriptor(raw, i);
    } catch {
      ok = false;
      break;
    }
    if (d === undefined) continue; // deleted hole: benign
    if (!('value' in d)) {
      ok = false; // accessor entry: hostile, the array drops (see copyStrs)
      break;
    }
    const v = d.value;
    if (!isPlainObj(v)) {
      if (v !== undefined) skipped = true; // present garbage: disclosed (cycle-3 F6)
      continue;
    }
    const aOwn = ownData(v, 'action');
    if (aOwn.accessor) skipped = true; // cycle-3 F6: an accessor field is disclosed, not silent
    const action = boundedStr(aOwn.value);
    if (action === undefined) {
      if (aOwn.present) skipped = true;
      continue;
    }
    if (clippedIf(aOwn.value)) clipped = true;
    const sidOwn = ownData(v, 'strategyId');
    const detOwn = ownData(v, 'detail');
    if (sidOwn.accessor || detOwn.accessor) skipped = true; // cycle-3 F6
    const sid = boundedStr(sidOwn.value);
    const det = boundedStr(detOwn.value);
    // cycle-4 F5: a present but non-string strategyId/detail is skipped WITH disclosure (skipped), never silently.
    if ((sidOwn.present && sid === undefined && !sidOwn.accessor) || (detOwn.present && det === undefined && !detOwn.accessor)) skipped = true;
    if (clippedIf(sidOwn.value) || clippedIf(detOwn.value)) clipped = true;
    if (out.length < MAX_ATTEMPTS) {
      out.push({ action, ...(sid !== undefined ? { strategyId: sid } : {}), ...(det !== undefined ? { detail: det } : {}) });
    } else {
      overflow = true; // cycle-2 F8: more attempts than MAX_ATTEMPTS — the human is told
    }
  }
  if (!ok) return { attempts: [], overflow: false, dropped: true, hostile: true, skipped: false, clipped: false, nonArray: false };
  try {
    if ((raw as unknown[]).length !== n) return { attempts: [], overflow: false, dropped: true, hostile: true, skipped: false, clipped: false, nonArray: false };
  } catch {
    return { attempts: [], overflow: false, dropped: true, hostile: true, skipped: false, clipped: false, nonArray: false };
  }
  return { attempts: out, overflow, dropped: false, hostile: false, skipped, clipped, nonArray: false };
}

/** Copy an unknown array (host replay) fence-safely: elements are copied
 *  by index under a bounded walk; the entries themselves are validated
 *  LATER by the view logic (a record is data, not a live handle, by then). */
/** Replay cap (F2): lines beyond it are NOT read. Reported as `truncated`
 *  so the caller can disclose it — a silent drop would hide open questions
 *  (or, worse, show answered ones as open, since resolutions are newer). */
const REPLAY_CAP = 100_000;

type LineCopy = { items: unknown[]; truncated: boolean };

function copyUnknownArr(raw: unknown): LineCopy | undefined {
  if (!isArraySafe(raw)) return undefined;
  let n = 0;
  let ok = true;
  try {
    const len = (raw as unknown[]).length;
    ok = Number.isInteger(len) && len >= 0;
    n = ok ? (len as number) : 0;
  } catch {
    ok = false;
  }
  if (!ok) return { items: [], truncated: true };
  const out: unknown[] = [];
  // TAIL-first copy: for an append-only log the NEWEST lines carry the
  // current state (open questions, recent resolutions). Dropping the
  // head loses stale history; dropping the tail would hide open work.
  const start = n > REPLAY_CAP ? n - REPLAY_CAP : 0;
  let truncated = start > 0;
  for (let i = start; i < n; i++) {
    try {
      const d = Object.getOwnPropertyDescriptor(raw, i);
      if (d === undefined) continue; // deleted hole: benign
      if (!('value' in d)) {
        truncated = true; // accessor entry: hostile line — stop the walk and disclose
        break;
      }
      out.push(d.value);
    } catch {
      truncated = true; // unreadable entry: remaining lines are unverifiable
      break;
    }
  }
  try {
    if ((raw as unknown[]).length !== n) truncated = true; // length moved mid-scan
  } catch {
    truncated = true;
  }
  return { items: out, truncated };
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface EscalationAttempt {
  action: string;
  strategyId?: string;
  detail?: string;
}

export interface EscalationRecord {
  schema: typeof ESCALATION_SCHEMA;
  kind: 'escalation';
  id: string;
  escalationId: string;
  ts: number;
  episodeId: string;
  taskId: string;
  attemptId?: string;
  blocker: Blocker;
  decisionNeeded: string;
  evidence: string[];
  attempts: EscalationAttempt[];
  reNotice: number;
  deliveredCount: number;
  /** Loop-c3 F1: this line was appended while its delivery count was
   *  UNVERIFIABLE (a truncated replay could not see the key's history).
   *  Replay treats such a line as NON-authoritative for the count — the
   *  key stays unverifiable, so the refusal line can never mint a fresh
   *  budget for a later raise (the exact bypass the c3 audit found).
   *  Additive and monotone: forging it can only REFUSE delivery. */
  countUnverifiable?: true;
  /** sha256 hex of the question-relevant fields (blocker|sorted evidence|
   *  attempts count|decisionNeeded) — the re-notice "is this new state?" test. */
  evidenceDigest: string;
  provenance: 'P13/M1';
}

export interface ResolutionRecord {
  schema: typeof ESCALATION_SCHEMA;
  kind: 'resolution';
  id: string;
  ref: string;
  decision: Decision;
  by: string;
  note?: string;
  ts: number;
  /** Cycle-3 F5: what the fence did NOT carry through the answer (e.g. a
   *  dropped accessor note). Lets a caller tell the human said nothing
   *  apart from the human said something we could not read (disclosure rule). */
  disclosed?: string[];
}

export interface RaiseRequest {
  episodeId: string;
  taskId: string;
  attemptId?: string;
  blocker?: string;
  decisionNeeded?: string;
  evidence?: unknown;
  attempts?: unknown;
  /** force: override the dedup redeliver suppression ONCE (still bounded by
   *  maxRedeliver — force never defeats the anti-spam CAP). */
  force?: boolean;
}

export interface RaiseResult {
  record: EscalationRecord;
  delivered: boolean;
  reason?: 're-notice' | 'redeliver-cap';
  channel?: string;
  delivery?: { ok: boolean; error?: string };
  disclosed?: string[]; // e.g. bad-input:packet / bad-input:evidence|attempts|force|blocker|attemptId|decisionNeeded|by|note / evidence:dropped|skipped|clipped|truncated / attempts:* / decisionNeeded:clipped / attemptId:clipped / by:clipped / note:clipped / replay:truncated / delivery:unverifiable-count (loop-c2 F2: truncated window, no local proof of the count) (delivery failure is the `delivery` FIELD — there is no delivery:failed marker; no 'scan-budget' marker — exhaustion emits '…:truncated'; docs/17 is the scan-budget doc)
}

export interface DeliverPort {
  deliver(rec: EscalationRecord): Promise<{ channel?: string } | void>;
}

export interface EscalationDeps {
  /** Durable append. A THROW fails the raise (durability is non-negotiable). */
  append(rec: object): Promise<void>;
  /** Host-side replay for pending(); absent → pending() reports [] unless
   *  an in-process fallback is wired (docs/19 §3). */
  read?(): Promise<unknown[]>;
  /** The delivery ACT (INV-1): the module builds and appends, the port sends. */
  deliver?: (rec: EscalationRecord) => Promise<{ channel?: string } | void>;
  /** REQUIRED host clock (INV-7): no Date() of its own. */
  now(): number;
  maxRedeliver?: number;
}

export interface EscalationChannel {
  /** durable record → dedup → deliver. null ONLY for an invalid identity
   *  (writes NOTHING). Appends then (maybe) delivers; never throws for
   *  hostile input — an append throw is the host's, and propagates. */
  raise(req: RaiseRequest): Promise<RaiseResult | null>;
  /** Record a human decision. null = bad input (nothing appended). */
  resolve(escalationId: string, res: { decision: string; by: string; note?: string }): Promise<ResolutionRecord | null>;
  /** Open questions, replay order. Degrades to [] on any read failure. */
  pending(): Promise<EscalationRecord[]>;
  /** F2: pending() plus whether the replay was COMPLETE. `complete:false`
   *  means open questions may be missing (replay cap / unreadable entry /
   *  no read port) — the host must say so, not show the list as the truth. */
  pendingStatus(): Promise<{ open: EscalationRecord[]; complete: boolean }>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function sha16(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function safeTs(now: () => number): number {
  try {
    const t = now();
    return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? Math.min(t, Number.MAX_SAFE_INTEGER) : 0;
  } catch {
    return 0;
  }
}

function isEscalationId(v: unknown): v is string {
  return typeof v === 'string' && /^esc-[0-9a-f]{16}$/.test(v);
}

function escalationIdFor(episodeId: string, taskId: string, blocker: Blocker): string {
  // Cycle-2 F4: length-prefix each field — an unescaped '|' let
  // ('a|b','c') and ('a','b|c') hash to ONE escalationId, merging two
  // distinct questions into one dedup key (and one resolve closing both).
  return 'esc-' + sha16(`${episodeId.length}:${episodeId}${taskId.length}:${taskId}:${blocker}`);
}

function evidenceDigestOf(rec: { blocker: string; decisionNeeded: string; evidence: string[]; attempts: EscalationAttempt[] }): string {
  // Cycle-2 F5: EVERY free-text part is length-encoded (len + '\x1f' + s).
  // An unescaped join let ['x,y'] and ['x','y'] digest identically, so a
  // genuinely new evidence state was suppressed as 're-notice' (INV-5).
  const enc = (s: string) => `${Buffer.byteLength(s)}\x1f${s}`;
  const att = rec.attempts.map((a) => `${enc(a.action)}${enc(a.strategyId ?? '')}${enc(a.detail ?? '')}`).join(';');
  const ev = [...rec.evidence].sort().map(enc).join(',');
  return sha16(`${rec.blocker}|${ev}|${rec.attempts.length}|${att}|${enc(rec.decisionNeeded)}`);
}

/** Validate an untrusted replayed line into an EscalationRecord, or
 *  undefined (skip — foreign/corrupt line). Own-data fence, closed sets. */
function parseEscalationLine(line: unknown): EscalationRecord | undefined {
  if (!isPlainObj(line)) return undefined;
  // A1 (audit): schema/kind are read through the own-data fence like every
  // other field — a replayed line is HOSTILE INPUT (the log may carry
  // foreign/appended lines); a trapping accessor on 'schema' must skip the
  // line, never throw out of pending()/raise (INV-4, total function).
  const schemaV = ownData(line, 'schema');
  if (schemaV.threw || schemaV.value !== ESCALATION_SCHEMA) return undefined;
  const kindV = ownData(line, 'kind');
  if (kindV.threw || kindV.value !== 'escalation') return undefined;
  const episodeId = boundedStr(ownData(line, 'episodeId').value);
  const taskId = boundedStr(ownData(line, 'taskId').value);
  if (episodeId === undefined || episodeId === '' || taskId === undefined || taskId === '') return undefined;
  const blockerRaw = boundedStr(ownData(line, 'blocker').value);
  const blocker: Blocker = (BLOCKERS as readonly string[]).includes(blockerRaw ?? '') ? (blockerRaw as Blocker) : 'unknown';
  const idRaw = boundedStr(ownData(line, 'id').value);
  const escRaw = boundedStr(ownData(line, 'escalationId').value);
  if (!isEscalationId(escRaw)) return undefined;
  // Cycle-2 F7 (fabrication guard vs the log): a replayed line is only
  // believed if its escalationId is the hash of its OWN content — a
  // foreign line claiming 'esc-1111...1' can no longer whitelist a
  // resolve() for an id that was never raised.
  const escalationId = escRaw;
  if (escalationIdFor(episodeId, taskId, blocker) !== escalationId) return undefined;
  const id = (idRaw !== undefined && idRaw.startsWith(escalationId) ? idRaw : undefined) ?? `${escalationId}#0`;
  const tsRaw = ownData(line, 'ts').value;
  const ts = typeof tsRaw === 'number' && Number.isFinite(tsRaw) && tsRaw >= 0 ? Math.min(tsRaw, Number.MAX_SAFE_INTEGER) : 0;
  const decisionNeededRaw = boundedStr(ownData(line, 'decisionNeeded').value);
  const evCopy = copyStrs(ownData(line, 'evidence').value);
  const attCopy = copyAttempts(ownData(line, 'attempts').value);
  const reNoticeRaw = ownData(line, 'reNotice').value;
  const reNotice = typeof reNoticeRaw === 'number' && Number.isInteger(reNoticeRaw) && reNoticeRaw >= 0 ? Math.min(reNoticeRaw, 1_000_000) : 0;
  const delRaw = ownData(line, 'deliveredCount').value;
  const deliveredCount = typeof delRaw === 'number' && Number.isInteger(delRaw) && delRaw >= 0 ? Math.min(delRaw, 1_000_000) : 0;
  // Loop-c3 F1: the refusal marker is read through the same fence.
  // Loop-c4 F2 (audit): the marker is fail-closed on ANY present value —
  // forging it with a non-boolean ('true', 1, {}, a getter) must still
  // refuse (additive + monotone: it can only ever REFUSE delivery), and an
  // accessor or a throwing descriptor is unreadable => refuse too. Only an
  // ABSENT field, an explicit `undefined`, or literal `false` verifies.
  const cuOwn = ownData(line, 'countUnverifiable');
  const countUnverifiable = cuOwn.threw === true || cuOwn.accessor === true
    || (cuOwn.present && cuOwn.value !== undefined && cuOwn.value !== false);
  const attemptId = boundedStr(ownData(line, 'attemptId').value);
  const dn = decisionNeededRaw !== undefined && decisionNeededRaw !== '' ? decisionNeededRaw : DEFAULT_DECISION_NEEDED[blocker];
  const recOut: EscalationRecord = {
    schema: ESCALATION_SCHEMA,
    kind: 'escalation',
    id,
    escalationId,
    ts,
    episodeId,
    taskId,
    ...(attemptId !== undefined && attemptId !== '' ? { attemptId } : {}),
    blocker,
    decisionNeeded: dn,
    evidence: evCopy.strs,
    attempts: attCopy.attempts,
    reNotice,
    deliveredCount,
    ...(countUnverifiable ? { countUnverifiable: true as const } : {}),
    // Recomputed from the RESOLVED fields — identical to what raise
    // baked in for the same line, so cross-restart dedup agrees.
    evidenceDigest: evidenceDigestOf({ blocker, decisionNeeded: dn, evidence: evCopy.strs, attempts: attCopy.attempts }),
    provenance: 'P13/M1',
  };
  return recOut;
}

function parseResolutionLine(line: unknown): ResolutionRecord | undefined {
  if (!isPlainObj(line)) return undefined;
  // A1 (audit): same own-data fence as parseEscalationLine — a throwing
  // accessor on schema/kind skips the line, never throws (INV-4).
  const schemaV = ownData(line, 'schema');
  if (schemaV.threw || schemaV.value !== ESCALATION_SCHEMA) return undefined;
  const kindV = ownData(line, 'kind');
  if (kindV.threw || kindV.value !== 'resolution') return undefined;
  const ref = ownData(line, 'ref').value;
  if (!isEscalationId(ref)) return undefined;
  const decisionRaw = boundedStr(ownData(line, 'decision').value);
  if (!(DECISIONS as readonly string[]).includes(decisionRaw ?? '')) return undefined;
  const by = boundedStr(ownData(line, 'by').value);
  if (by === undefined || by === '') return undefined;
  const id = boundedStr(ownData(line, 'id').value);
  const tsRaw = ownData(line, 'ts').value;
  const ts = typeof tsRaw === 'number' && Number.isFinite(tsRaw) && tsRaw >= 0 ? Math.min(tsRaw, Number.MAX_SAFE_INTEGER) : 0;
  const note = boundedStr(ownData(line, 'note').value);
  return {
    schema: ESCALATION_SCHEMA,
    kind: 'resolution',
    id: id !== undefined && id !== '' ? id : `res-${ref}-${ts}`,
    ref,
    decision: decisionRaw as Decision,
    by,
    ...(note !== undefined && note !== '' ? { note } : {}),
    ts,
  };
}

/** Cycle-4 F4: does the line CLAIM the escalation schema (either kind)?
 *  A trap anywhere → false (it could not be read; unreadable handles it). */
function claimsSchema(line: unknown): boolean {
  if (!isPlainObj(line)) return false;
  try {
    const k = ownData(line, 'kind');
    if (k.threw) return true; // a trapping kind descriptor is itself unreadable
    return k.value === 'escalation' || k.value === 'resolution';
  } catch {
    return true;
  }
}

/** Cycle-4 (audit MED-4): the ONE field a resolution line needs to close a
 *  question is a well-formed `ref` (everything else — decision, by — is
 *  bookkeeping the closing action does not depend on; the resolution
 *  RECORD with its strict fields is appended by resolve() itself, so this
 *  lenient read fabricates nothing). A line whose ref traps/fails is still
 *  rejected: only schema/kind/ref must hold for the lenient close. */
function lenientResolutionRef(line: unknown): string | undefined {
  if (!isPlainObj(line)) return undefined;
  try {
    const schemaV = ownData(line, 'schema');
    if (schemaV.threw || schemaV.value !== ESCALATION_SCHEMA) return undefined;
    const kindV = ownData(line, 'kind');
    if (kindV.threw || kindV.value !== 'resolution') return undefined;
    const ref = ownData(line, 'ref').value;
    return isEscalationId(ref) ? ref : undefined;
  } catch {
    return undefined;
  }
}

// ─── The channel ───────────────────────────────────────────────────────────

export function makeEscalationChannel(deps: EscalationDeps): EscalationChannel {
  const maxRedeliverRaw = deps.maxRedeliver;
  const maxRedeliver = typeof maxRedeliverRaw === 'number' && Number.isFinite(maxRedeliverRaw) && maxRedeliverRaw >= 0
    ? Math.min(Math.trunc(maxRedeliverRaw), 1000)
    : DEFAULT_MAX_REDELIVER;

  /** In-process mirror of the open set (escalationId -> latest record +
   *  delivered count). Backs dedup when the host has no `read()` and
   *  accelerates it when it does (replay `read()` is the source of truth
   *  across restarts; the mirror is the fast path + the no-read fallback). */
  const openMirror = new Map<string, { rec: EscalationRecord; delivered: number }>();

  /** Every escalationId this channel has SEEN appended (raised or
   *  replayed). Answers to never-raised ids are rejected (B4): an answer
   *  to a question nobody asked is a fabrication. Grows monotonically —
   *  double-resolve and late answers stay legal. */
  const seenEver = new Set<string>();

  /** Cycle-1 F6: highest reNotice ever SEEN for a key (raised or replayed),
   *  surviving resolution. escalationId is content-derived, so a re-raise of
   *  the same question after a resolve would regenerate `esc…#0` verbatim —
   *  two log lines with one id (docs/19: id is distinct per append). The
   *  floor keeps the sequence monotonic per key for this process's life. */
  const noticeFloor = new Map<string, number>();

  /** Cycle-3 F2: per-escalationId delivery count for the process lifetime,
   *  SURVIVING resolve (openMirror is cleared on resolve, so the cap was
   *  bypassable by resolving between raises). Seeded from replay so the
   *  durable count wins; the ledger only ratchets upward. */
  const deliveryLedger = new Map<string, number>();
  /** Cycle-4 (audit HIGH-2): replayOpen DELETES resolved keys from its
   *  open set, so seeding the ledger from `open` alone loses the durable
   *  delivery count of every RESOLVED question — after a restart, a new
   *  evidence raise re-delivers and the INV-5 cap resets. This map keeps
   *  the max deliveredCount of EVERY escalation line the scan saw,
   *  resolved or not; every successful replay ratchets the ledger from it. */
  const ledgerMaxScan = new Map<string, number>();
  /** Loop-c3 F1: keys whose delivery count THIS process has proven
   *  unverifiable (a truncated window hid their history). Sticky for the
   *  process lifetime AND carried on every line written under the state
   *  (countUnverifiable), so the refusal survives restarts: a refusal line
   *  back inside the window must not read as a deliveredCount-0 proof. */
  const unverifiableKeys = new Set<string>();

  /** Audit cycle-1 F1 (INV-5): the dedup decision, the cap check, and the
   *  ledger reservation run AFTER `await replayOpen()` but BEFORE the
   *  `await deps.append()` — two CONCURRENT raises of one key (two
   *  dispatches for one task) could both pass the cap before either
   *  appended, minting duplicate deliveries. raise/resolve are serialized
   *  per channel through this promise-chain mutex; a failed link never
   *  wedges the queue. (Pending reads are not serialized: they observe a
   *  settled prefix and never mutate the maps.) */
  let opQueue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = opQueue.then(task, task);
    opQueue = run.then(() => undefined, () => undefined);
    return run;
  };
  /** Loop-c2 F1 (audit): the mutex covers replay→decide→build→APPEND→
   *  reservation ONLY. `deliver` (a port to the human world — a stuck
   *  Telegram send must not wedge every other raise/resolve, and INV-2
   *  makes the durable line the promise, not the send) runs after the
   *  queue is released: raisePrepare returns everything the off-queue
   *  deliverAndFinish needs. The cap still holds: the ledger/mirror
   *  reservation happens BEFORE the release point, so a concurrent raise
   *  of the same key sees the committed count while the first send is
   *  still in flight. */
  type PreparedRaise = { rec: EscalationRecord; shouldDeliver: boolean; allowedByDedup: boolean; disclosed: string[]; reason?: RaiseResult['reason'] };
  let resSeq = 0; // cycle-2 F11: per-process monotonic suffix for resolution line ids
  // Cycle-3 F10: a per-process random salt makes resolution ids distinct
  // across restarts/colliding processes (resSeq resets to 0 after a restart).
  const resSalt = Math.random().toString(36).slice(2, 10);

  const raise = (req: RaiseRequest): Promise<RaiseResult | null> =>
    enqueue(() => raisePrepare(req)).then((p) => (p === null ? null : deliverAndFinish(p)));
  const raisePrepare = async (req: RaiseRequest): Promise<PreparedRaise | null> => {
    if (!isPlainObj(req)) return null;
    // Cycle-3 F1: identity is NEVER truncated. A >MAX_STR episodeId/taskId
    // would hash distinct-but-collide after clipping, merging two episodes'
    // questions into one key (and one resolve dismissing both). An
    // oversized identity is an INVALID identity: write nothing (compose
    // R3/F16 — the same rule as a missing/throwing identity).
    const episodeRaw = ownData(req, 'episodeId').value;
    const taskRaw = ownData(req, 'taskId').value;
    if (typeof episodeRaw === 'string' && episodeRaw.length > MAX_STR) return null;
    if (typeof taskRaw === 'string' && taskRaw.length > MAX_STR) return null;
    const episodeId = boundedStr(episodeRaw);
    const taskId = boundedStr(taskRaw);
    // Invalid identity writes NOTHING (compose R3/F16).
    if (episodeId === undefined || episodeId === '' || taskId === undefined || taskId === '') return null;

    const disclosed: string[] = [];
    const hostilePacket = trapPresent(req);

    const blockerOwn = ownData(req, 'blocker');
    const blockerRaw = boundedStr(blockerOwn.value);
    const blocker: Blocker = (BLOCKERS as readonly string[]).includes(blockerRaw ?? '') ? (blockerRaw as Blocker) : 'unknown';
    if (blockerOwn.accessor || blockerOwn.threw) disclosed.push('bad-input:blocker'); // cycle-4 F3: a throwing descriptor is disclosed, never a silent floor
    // Loop-c2 F3: a PRESENT non-string is untrusted data that did not
    // survive the fence — disclosed, never a silent floor to 'unknown'.
    if (blockerOwn.value !== undefined && typeof blockerOwn.value !== 'string') disclosed.push('bad-input:blocker');

    const attemptIdOwn = ownData(req, 'attemptId');
    if (attemptIdOwn.accessor || attemptIdOwn.threw) disclosed.push('bad-input:attemptId'); // cycle-4 F3
    const attemptIdRaw = boundedStr(attemptIdOwn.value);
    // Cycle-3 F6 (audit round 3): a bounded shortening of a scalar is
    // disclosed like a clipped evidence entry — never a silent slice.
    if (typeof attemptIdOwn.value === 'string' && attemptIdOwn.value.length > MAX_STR) disclosed.push('attemptId:clipped');
    if (attemptIdOwn.value !== undefined && typeof attemptIdOwn.value !== 'string') disclosed.push('bad-input:attemptId'); // loop-c2 F3
    const decisionOwn = ownData(req, 'decisionNeeded');
    if (decisionOwn.accessor || decisionOwn.threw) disclosed.push('bad-input:decisionNeeded'); // cycle-4 F3
    const decisionRaw = boundedStr(decisionOwn.value);
    if (typeof decisionOwn.value === 'string' && decisionOwn.value.length > MAX_STR) disclosed.push('decisionNeeded:clipped'); // cycle-3 F6
    if (decisionOwn.value !== undefined && typeof decisionOwn.value !== 'string') disclosed.push('bad-input:decisionNeeded'); // loop-c2 F3
    const decisionNeeded = decisionRaw !== undefined && decisionRaw !== '' ? decisionRaw : DEFAULT_DECISION_NEEDED[blocker];

    const evOwn = ownData(req, 'evidence');
    if (evOwn.accessor) disclosed.push('bad-input:evidence'); // cycle-2 F3: a get/set field is untrusted data — disclose, don't drop silently
    if (evOwn.threw) disclosed.push('evidence:dropped'); // cycle-4 F3: a throwing descriptor is untrusted-present — never a silent []
    const evCopy = copyStrs(evOwn.value);
    if (evCopy.hostile) disclosed.push('bad-input:packet');
    if (evCopy.dropped) disclosed.push('evidence:dropped');
    if (evCopy.nonArray) disclosed.push('evidence:dropped'); // cycle-3 F6: present non-array evidence is disclosed
    if (evCopy.skipped) disclosed.push('evidence:skipped'); // cycle-3 F6: non-string entries dropped
    if (evCopy.clipped) disclosed.push('evidence:clipped'); // cycle-3 F6: an entry shortened at MAX_STR
    if (evCopy.overflow) disclosed.push('evidence:truncated');
    let evidence = evCopy.strs;
    // F3 (cycle-1)/F9 (cycle-2): the docs-19 bounds contract appends the
    // marker 'truncated' on overflow. It is a plain string a caller could
    // forge with evidence:['truncated'] — accepted risk (docs/19 §2): an
    // attacker who controls evidence text can write any words; `disclosed`
    // carries the STRUCTURAL signal for machines.
    if (evCopy.overflow) evidence = [...evidence, 'truncated'];

    const attOwn = ownData(req, 'attempts');
    if (attOwn.accessor) disclosed.push('bad-input:attempts');
    if (attOwn.threw) disclosed.push('attempts:dropped'); // cycle-4 F3
    const attCopy = copyAttempts(attOwn.value);
    if (attCopy.hostile && !disclosed.includes('bad-input:packet')) disclosed.push('bad-input:packet');
    if (attCopy.dropped) disclosed.push('attempts:dropped');
    if (attCopy.nonArray) disclosed.push('attempts:dropped'); // cycle-3 F6
    if (attCopy.skipped) disclosed.push('attempts:skipped'); // cycle-3 F6
    if (attCopy.clipped) disclosed.push('attempts:clipped'); // cycle-3 F6
    if (attCopy.overflow) disclosed.push('attempts:truncated'); // cycle-2 F8

    const forceOwn = ownData(req, 'force');
    if (forceOwn.accessor) disclosed.push('bad-input:force'); // cycle-3 F11: consistent with every other field
    if (forceOwn.threw) disclosed.push('bad-input:force'); // cycle-4 F3
    // Loop-c2 F3: force is a boolean or it is untrusted-present garbage —
    // force:'yes' silently false is exactly the hidden loss INV-4 forbids.
    if (forceOwn.value !== undefined && typeof forceOwn.value !== 'boolean') disclosed.push('bad-input:force');
    const force = forceOwn.value === true;

    if (hostilePacket && !disclosed.includes('bad-input:packet')) disclosed.push('bad-input:packet');

    // A trapping top-level handle degrades to an honest minimal record —
    // the identity fields survived the fence (they were read through it),
    // the rest of the packet is untrusted (P15: disclose, never fatal).
    const ts = safeTs(deps.now);
    const escalationId = escalationIdFor(episodeId, taskId, blocker);

    // Dedup state (docs/19 §3: fence → prior-state lookup → dedup decision
    // → build → append → deliver; append still strictly precedes the act —
    // INV-2 — but the deliveredCount baked into the durable line is the
    // post-attempt count, so the INV-5 cap survives restarts). The durable
    // log is preferred when the replay SUCCEEDS — a key absent from a
    // successful replay is closed or absent and the mirror must not
    // resurrect it. A FAILED read is not authoritative: fall back to the
    // in-process mirror. The mirror may know state the last appended line
    // doesn't (deliveries after the prior append in this lifetime): the
    // newer record wins, deliveries take the max.
    let prior: { rec: EscalationRecord; delivered: number } | undefined = openMirror.get(escalationId);
    let shouldDeliverEarly = true;
    let reasonEarly: RaiseResult['reason'] | undefined;
    // Loop-c3 F1: WHY the early refusal fired — an unverifiable budget is
    // overridden by a same-digest re-notice (which never delivers), so the
    // c1-F1 dedup contract survives the sticky refusal.
    let unverifiableEarly = false;
    if (deps.read !== undefined) {
      const { open, ok, truncated } = await replayOpen();
      if (ok && !truncated) {
        const fromLog = open.get(escalationId);
        const mirrored = openMirror.get(escalationId);
        if (fromLog !== undefined) {
          prior = {
            rec: mirrored !== undefined && mirrored.rec.reNotice >= fromLog.reNotice ? mirrored.rec : fromLog,
            delivered: Math.max(fromLog.deliveredCount, mirrored?.delivered ?? 0),
          };
        } else {
          prior = undefined;
        }
        // Cycle-3 F2: seed the lifetime ledger from the durable log —
        // deliveries recorded there count even after the key left openMirror.
        // Cycle-4 HIGH-2: ALSO from ledgerMaxScan (every escalation line,
        // including ones a later resolution line deleted from `open`).
        for (const [k, v] of open) {
          const cur = deliveryLedger.get(k) ?? 0;
          if (v.deliveredCount > cur) deliveryLedger.set(k, v.deliveredCount);
        }
        for (const [k, v] of ledgerMaxScan) {
          const cur = deliveryLedger.get(k) ?? 0;
          if (v > cur) deliveryLedger.set(k, v);
        }
        // Loop-c3 F1: a complete replay of a log that ONCE truncated still
        // contains gaps (the lost lines are lost forever) — a key flagged
        // countUnverifiable keeps its refusal even when the current window
        // parses cleanly. Fail closed on the count, always — UNLESS this
        // process has proven deliveries or a CREDIBLE mirror record of the
        // key (in-process truth beats a stale refusal carried in at restart).
        if (unverifiableKeys.has(escalationId) && (deliveryLedger.get(escalationId) ?? 0) === 0 && (mirrored === undefined || mirrored.rec.countUnverifiable === true)) {
          shouldDeliverEarly = false;
          reasonEarly = 'redeliver-cap';
          unverifiableEarly = true;
          disclosed.push('delivery:unverifiable-count');
        }
      } else if (ok && truncated) {
        // Cycle-1 F1 + cycle-2 F6: truncation is NOT authoritative for
        // ABSENCE (keep the mirror prior), but an in-window line IS
        // authoritative for presence — after a restart (empty mirror) the
        // surviving open record must drive dedup, or every raise of an
        // unchanged question re-delivers and the INV-5 cap resets.
        const fromLog = open.get(escalationId);
        const mirrored = openMirror.get(escalationId);
        if (fromLog !== undefined) {
          prior = {
            rec: mirrored !== undefined && mirrored.rec.reNotice >= fromLog.reNotice ? mirrored.rec : fromLog,
            delivered: Math.max(fromLog.deliveredCount, mirrored?.delivered ?? 0),
          };
        }
        // Loop-c2 F2 (audit): a key ABSENT from a truncated window may
        // have been delivered past the cap in lines the scan never saw.
        // If nothing in this process's ledger proves a prior delivery
        // either, the count is UNVERIFIABLE — deliver nothing (INV-5
        // fails closed; the record still appends and the host sees the
        // disclosure). A key this lifetime HAS delivered (ledger > 0)
        // keeps its in-process truth and the normal cap applies.
        // Loop-c3 F1: a refusal line back INSIDE the window is not budget
        // proof either — its deliveredCount: 0 was written precisely because
        // the truth was unknowable. In-process truth (a CREDIBLE mirror, a
        // proven delivery) still outranks a carried-in refusal (c1-F1
        // re-notice). A mirror holding ONLY the refusal record (0 delivered,
        // countUnverifiable) is not proof — that is the refusal itself.
        const noProcessProof = (mirrored === undefined || mirrored.rec.countUnverifiable === true) && (deliveryLedger.get(escalationId) ?? 0) === 0;
        let unverifiableCount = false;
        // Loop-c4 F1 (audit): a LEGACY log (written before the marker
        // existed) — or any log whose marker was stripped — holds a line
        // whose deliveredCount: 0 was itself written under an unverifiable
        // budget (that is the only way a key shows reNotice > 0 with count
        // 0 while nothing in THIS process proves a delivery). The line's
        // 0 is not budget proof; fail closed like a marked refusal.
        const legacyRefusal = fromLog !== undefined && fromLog.reNotice > 0 && fromLog.deliveredCount === 0;
        if (noProcessProof && (unverifiableKeys.has(escalationId) || fromLog?.countUnverifiable === true || legacyRefusal || (fromLog === undefined && !seenEver.has(escalationId)))) {
          unverifiableCount = true;
        }
        // Cycle-3 F2/F3: the window is partial truth — seed the ledger
        // from it but do NOT treat it as the whole picture.
        // Cycle-4 HIGH-2 + A10: ledgerMaxScan covers the RESOLVED keys in
        // the window; deliveries beyond the window stay unverified (the
        // 'replay:truncated' disclosure says so — the cap never resets).
        for (const [k, v] of open) {
          const cur = deliveryLedger.get(k) ?? 0;
          if (v.deliveredCount > cur) deliveryLedger.set(k, v.deliveredCount);
        }
        for (const [k, v] of ledgerMaxScan) {
          const cur = deliveryLedger.get(k) ?? 0;
          if (v > cur) deliveryLedger.set(k, v);
        }
        disclosed.push('replay:truncated');
        if (unverifiableCount) {
          // Loop-c3 F1: sticky for the process AND written on the line, so
          // the refusal survives the next restart too.
          unverifiableKeys.add(escalationId);
          shouldDeliverEarly = false;
          reasonEarly = 'redeliver-cap';
          unverifiableEarly = true;
          disclosed.push('delivery:unverifiable-count'); // loop-c2 F2 marker
        }
      }
    }

    // Dedup decision (INV-5) — before the build, so the durable line
    // carries the true post-attempt count.
    const baseDelivered = Math.max(prior?.delivered ?? 0, deliveryLedger.get(escalationId) ?? 0);
    let shouldDeliver = true;
    let reason: RaiseResult['reason'] | undefined;
    if (!shouldDeliverEarly) {
      // Loop-c2 F2: the truncated-window unverifiable count refuses before
      // any other rule — an unprovable budget is spent, never granted.
      shouldDeliver = false;
      reason = reasonEarly;
      // Loop-c3 F1: but a same-digest re-notice never delivers — the cap
      // is not what stops it, so the refusal is mislabeled for it.
      if (unverifiableEarly && prior !== undefined && !force && prior.rec.evidenceDigest === evidenceDigestOf({ blocker, decisionNeeded, evidence, attempts: attCopy.attempts })) {
        reason = 're-notice';
      }
    } else if (baseDelivered >= maxRedeliver) {
      shouldDeliver = false;
      reason = 'redeliver-cap';
    } else if (prior !== undefined) {
      const sameDigest = prior.rec.evidenceDigest === evidenceDigestOf({ blocker, decisionNeeded, evidence, attempts: attCopy.attempts });
      if (sameDigest && !force) {
        shouldDeliver = false;
        reason = 're-notice';
      }
    }
    // A missing deliver port is disclosed, and never counts as an attempt.
    const allowedByDedup = shouldDeliver;
    if (shouldDeliver && deps.deliver === undefined) shouldDeliver = false;

    const rawReNotice = prior !== undefined ? (prior.rec.reNotice ?? 0) + 1 : 0;
    const reNotice = Math.max(rawReNotice, (noticeFloor.get(escalationId) ?? -1) + 1);
    noticeFloor.set(escalationId, reNotice);
    const deliveredCount = shouldDeliver ? baseDelivered + 1 : baseDelivered;

    const rec: EscalationRecord = {
      schema: ESCALATION_SCHEMA,
      kind: 'escalation',
      id: `${escalationId}#${reNotice}`,
      escalationId,
      ts,
      episodeId,
      taskId,
      ...(attemptIdRaw !== undefined && attemptIdRaw !== '' ? { attemptId: attemptIdRaw } : {}),
      blocker,
      decisionNeeded,
      evidence,
      attempts: attCopy.attempts,
      reNotice,
      deliveredCount,
      // Loop-c3 F1: an unverifiable-count refusal carries its own evidence
      // — replay must never read this line's deliveredCount as budget proof.
      ...(unverifiableKeys.has(escalationId) ? { countUnverifiable: true as const } : {}),
      evidenceDigest: evidenceDigestOf({ blocker, decisionNeeded, evidence, attempts: attCopy.attempts }),
      provenance: 'P13/M1',
    };

    // INV-2: append BEFORE delivery — durability precedes the act.
    // (An append throw propagates: durability is non-negotiable.)
    await deps.append(rec);
    openMirror.set(escalationId, { rec, delivered: deliveredCount });
    seenEver.add(escalationId);
    if (deliveredCount > (deliveryLedger.get(escalationId) ?? 0)) deliveryLedger.set(escalationId, deliveredCount); // cycle-3 F2

    // Loop-c2 F1 release point: the durable line + the cap reservation are
    // committed; the queue is released and the (possibly slow) send runs
    // off-queue. A queued raise that starts now already sees this count.
    return { rec, shouldDeliver, allowedByDedup, disclosed, ...(reason !== undefined ? { reason } : {}) };
  };

  const deliverAndFinish = async (p: PreparedRaise): Promise<RaiseResult> => {
    const { rec, shouldDeliver, allowedByDedup, disclosed, reason: reasonForFinish } = p;
    let delivered = false;
    let channel: string | undefined;
    let delivery: RaiseResult['delivery'] | undefined;
    if (deps.deliver === undefined) {
      if (allowedByDedup) delivery = { ok: false, error: 'port-missing:deliver' };
    } else if (shouldDeliver) {
      try {
        const r = await deps.deliver(rec);
        // B3 (audit): the port's RETURN is untrusted too. `void` is an
        // honest "sent"; a plain object carries the channel name. A
        // primitive or an accessor trap on 'channel' is a port defect —
        // disclosed as a FAILED delivery (INV-2: a false success would
        // hide a human-visible failure from the host and pending()).
        if (r === undefined || r === null) {
          delivered = true;
          delivery = { ok: true };
        } else if (typeof r === 'object') {
          // The fence applies to the port's return like any input: the
          // channel name is read via ownData (an accessor DROPS — the act
          // succeeded, the name is just untrusted; only a proxy trap that
          // throws getOwnPropertyDescriptor, or a non-object, is a defect).
          const chOwn = ownData(r, 'channel');
          const chRaw = chOwn.threw ? undefined : boundedStr(chOwn.value);
          channel = chRaw !== undefined && chRaw !== '' ? chRaw : undefined;
          delivered = true;
          delivery = { ok: true };
        } else {
          delivery = { ok: false, error: 'deliver:non-record' };
        }
      } catch (e) {
        // The count stands (the durable line IS the promise — INV-2):
        // a failed attempt is disclosed, the record never vanishes.
        delivery = { ok: false, error: describeErr(e) };
      }
    }

    const out: RaiseResult = {
      record: Object.freeze(rec) as EscalationRecord,
      delivered,
      ...(reasonForFinish !== undefined ? { reason: reasonForFinish } : {}),
      ...(channel !== undefined ? { channel } : {}),
      ...(delivery !== undefined ? { delivery } : {}),
      ...(disclosed.length > 0 ? { disclosed } : {}),
    };
    return out;
  };

  const resolve = (escalationId: string, res: { decision: string; by: string; note?: string }): Promise<ResolutionRecord | null> => enqueue(() => resolveInner(escalationId, res));
  const resolveInner = async (escalationId: string, res: { decision: string; by: string; note?: string }): Promise<ResolutionRecord | null> => {
    if (!isEscalationId(escalationId)) return null;
    if (!isPlainObj(res)) return null;
    const resolveDisclosed: string[] = []; // cycle-3 F5: disclosures on the ResolutionRecord
    // B4 (audit): an answer to a question that was never asked is a
    // fabrication. F1 (audit): but with NO read port the channel cannot
    // verify anything — a restarted host would reject every legitimate
    // answer. So: no read port → accept a well-formed id (the answer is
    // appended durably; pending() later shows it as closed/unknown to the
    // replay). A read port that answered and lacks the id → reject; a
    // TRUNCATED replay that lacks it → reject too (it may sit past the cap).
    // Cycle-3 audit: F1's relaxation (no read port → accept any well-formed
    // id) let a forged resolution through — the B4 fabrication guard must
    // hold. So an unknown id is ALWAYS rejected; the restart case is served
    // by the host providing `read` (documented requirement, docs/19 §3).
    const k = await knownEver(escalationId);
    if (!k.known) return null;
    const decisionRaw = boundedStr(ownData(res, 'decision').value);
    if (!(DECISIONS as readonly string[]).includes(decisionRaw ?? '')) return null;
    const byOwn = ownData(res, 'by');
    const by = boundedStr(byOwn.value);
    if (by === undefined || by === '') return null;
    if (typeof byOwn.value === 'string' && byOwn.value.length > MAX_STR) resolveDisclosed.push('by:clipped'); // cycle-3 F6
    if (byOwn.accessor || byOwn.threw) resolveDisclosed.push('bad-input:by'); // cycle-4 F3
    const noteOwn = ownData(res, 'note');
    if (noteOwn.accessor) resolveDisclosed.push('bad-input:note'); // cycle-3 F5: dropped with disclosure
    const note = boundedStr(noteOwn.value);
    if (typeof noteOwn.value === 'string' && noteOwn.value.length > MAX_STR) resolveDisclosed.push('note:clipped'); // cycle-3 F6
    if (noteOwn.threw) resolveDisclosed.push('bad-input:note');
    if (noteOwn.value !== undefined && typeof noteOwn.value !== 'string') resolveDisclosed.push('bad-input:note'); // loop-c2 F3
    const ts = safeTs(deps.now);
    resSeq += 1; // cycle-2 F11: same person/decision/note in one tick gets distinct ids
    const rec: ResolutionRecord = {
      schema: ESCALATION_SCHEMA,
      kind: 'resolution',
      id: `res-${escalationId}-${ts}-${sha16(`${resSalt}|${by}|${decisionRaw}|${ts}|${note ?? ''}|${resSeq}`).slice(0, 8)}`,
      ref: escalationId,
      decision: decisionRaw as Decision,
      by,
      ...(note !== undefined && note !== '' ? { note } : {}),
      ...(resolveDisclosed.length > 0 ? { disclosed: resolveDisclosed } : {}),
      ts,
    };
    await deps.append(rec);
    openMirror.delete(escalationId);
    return rec;
  };

  /** Replay the log into the OPEN set + an `ok` flag: a FAILED read is not
   *  authoritative (dedup falls back to the mirror; pending() degrades to
   *  [] — never a crash, never a stale ghost presented as the truth). */
  const replayOpen = async (): Promise<{ open: Map<string, EscalationRecord>; ok: boolean; truncated: boolean; seen: Set<string>; lenientClosed: number; unreadable: number }> => {
    const out = new Map<string, EscalationRecord>();
    const seen = new Set<string>();
    let lenientClosed = 0; // cycle-4 F4: closes the strict parse could not justify
    let unreadable = 0;    // cycle-4 F4: lines the scan saw but could not read at all
    if (deps.read === undefined) return { open: out, ok: false, truncated: false, seen, lenientClosed, unreadable };
    let copy: LineCopy | undefined;
    try {
      copy = copyUnknownArr(await deps.read());
    } catch {
      return { open: out, ok: false, truncated: false, seen, lenientClosed, unreadable };
    }
    if (copy === undefined) return { open: out, ok: false, truncated: false, seen, lenientClosed, unreadable };
    for (const line of copy.items) {
      const esc = parseEscalationLine(line);
      if (esc !== undefined) {
        seen.add(esc.escalationId);
        seenEver.add(esc.escalationId);
        if ((noticeFloor.get(esc.escalationId) ?? -1) < esc.reNotice) noticeFloor.set(esc.escalationId, esc.reNotice);
        if ((ledgerMaxScan.get(esc.escalationId) ?? -1) < esc.deliveredCount) ledgerMaxScan.set(esc.escalationId, esc.deliveredCount); // cycle-4 HIGH-2
        // Loop-c3 F1: a line that admits an unverifiable count keeps the
        // key unverifiable — its deliveredCount is NOT seeded as authority.
        if (esc.countUnverifiable === true) {
          unverifiableKeys.add(esc.escalationId);
          out.set(esc.escalationId, esc);
          continue;
        }
        out.set(esc.escalationId, esc);
        continue;
      }
      // Cycle-4 (audit MED-4): replay must apply the SAME tolerance the
      // reader applies. A resolution line the reader would honor (grammar
      // valid, ref well-formed) but this strict parse rejects (e.g. a bad
      // 'by') must still close the question — otherwise a proven-answered
      // question resurrects into pending() forever.
      let res = parseResolutionLine(line);
      if (res === undefined) {
        const lenient = lenientResolutionRef(line);
        if (lenient !== undefined) {
          lenientClosed += 1;
          out.delete(lenient);
          continue;
        }
      }
      if (res !== undefined) {
        out.delete(res.ref);
        continue;
      }
      // Neither parse accepted the line (foreign entry, corruption, or a
      // resolution whose ref traps). A 'kind' that claims the schema but
      // fails everything else is the concerning class — count it. MED-4:
      // a scan that silently ignored such lines must not report complete.
      // Loop-c2 F5 (audit): a Proxy whose getPrototypeOf throws fails
      // isPlainObj INSIDE claimsSchema (→ false) even though the line is
      // unreadable-hostile. trapPresent names exactly that class.
      if (trapPresent(line) || claimsSchema(line)) unreadable += 1;
    }
    return { open: out, ok: true, truncated: copy.truncated, seen, lenientClosed, unreadable };
  };

  /** F6 + B4: ONE replay per operation, shared. `resolve` consults the
   *  in-process set first (no read at all for a known id); only an unknown
   *  id triggers a replay, and that replay is not repeated for the same
   *  call. A failed/absent read is not authoritative for "never raised". */
  const knownEver = async (escalationId: string): Promise<{ known: boolean; verified: boolean }> => {
    if (seenEver.has(escalationId)) return { known: true, verified: true };
    if (deps.read === undefined) return { known: false, verified: false };
    const r = await replayOpen();
    if (!r.ok) return { known: false, verified: false };
    // cycle-4 F4: a scan that lenient-closed or could not read lines is not
    // fully verified — but a well-formed ref still matched/fails honestly,
    // so membership stands; verification strength drops.
    return { known: r.seen.has(escalationId), verified: !r.truncated && r.unreadable === 0 };
  };

  const pending = async (): Promise<EscalationRecord[]> => {
    if (deps.read !== undefined) {
      const { open, ok } = await replayOpen();
      if (ok) return [...open.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    }
    return [...openMirror.values()].map((e) => e.rec).sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  };

  /** F2: the same view as pending(), plus whether it is COMPLETE. An
   *  incomplete view must be shown as such — never as the full queue. */
  const pendingStatus = async (): Promise<{ open: EscalationRecord[]; complete: boolean }> => {
    if (deps.read !== undefined) {
      const r = await replayOpen();
      // Cycle-1 F4: ONE replay per call — the fallback reads the mirror
      // directly instead of re-entering pending() (which would replay again).
      // cycle-4 F4: 'complete' means the WHOLE scan was readable — a
      // truncated tail, an unreadable schema line, or a lenient-only close
      // all make the view partial truth (docs/19 INV-4).
      if (r.ok) return { open: [...r.open.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id)), complete: !r.truncated && r.unreadable === 0 && r.lenientClosed === 0 };
    }
    // No usable replay → the in-process mirror is all we know: never "complete".
    return { open: [...openMirror.values()].map((e) => e.rec).sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id)), complete: false };
  };

  return { raise, resolve, pending, pendingStatus };
}

function describeErr(e: unknown): string {
  // Cycle-1 F3: the thrown value is untrusted — a revoked Proxy throws at
  // `instanceof` ([[GetPrototypeOf]]), and an Error subclass can trap `name`.
  // This runs INSIDE a catch block, so it must never throw itself (INV-4).
  try {
    if (e instanceof Error) {
      const name = typeof e.name === 'string' && e.name.length > 0 && e.name.length <= 64 ? e.name : 'Error';
      return name;
    }
  } catch {
    return 'unthrowable';
  }
  return 'unknown';
}

// ─── Dispatcher (docs/15 DispatchPorts-shaped, for the loop host) ──────────

export interface DispatcherDeps {
  channel: EscalationChannel;
  /** Host mapping from loop context to a closed blocker. Called with the
   *  dispatch request (executor payload); returning undefined/unknown
   *  yields blocker 'unknown' (the floor — never a suppressed notice). */
  blockerOf?(req: Record<string, unknown>): string | undefined;
}

export interface EscalationDispatcher {
  escalate(req: { episodeId?: string; taskId?: string; actionId?: string; rationale?: string[]; [k: string]: unknown }): Promise<{ channel: string }>;
  park(req: { episodeId?: string; taskId?: string; actionId?: string; [k: string]: unknown }): Promise<void>;
}

/**
 * The composition seam: conforms to the executor's DispatchPorts
 * (escalate/park), so a host wires it as `executorPorts.dispatch` and the
 * loop's rung-5 actions produce durable, delivered escalations. The
 * dispatcher NEVER throws for hostile request content — it raises what it
 * can (identity comes from the executor's validated ctx) and swallows
 * deliver-internal failures the channel already disclosed (the executor's
 * own journal remains the loop's proof; the escalation record is the
 * outside-world artifact). An APPEND throw propagates: no durability, no
 * false ack.
 */
export function makeEscalationDispatcher(deps: DispatcherDeps): EscalationDispatcher {
  const escalate = async (req: { episodeId?: string; taskId?: string; actionId?: string; rationale?: string[]; [k: string]: unknown }): Promise<{ channel: string }> => {
    if (!isPlainObj(req)) return { channel: 'escalation:invalid' };
    // Cycle-4 F1 (audit HIGH-1): the dispatcher must apply the channel's F1
    // identity rule BEFORE clipping — a >MAX_STR identity clipped here would
    // hash into a shared dedup key and merge two episodes' questions (and a
    // silent re-notice of someone else's). Invalid identity: refuse.
    const epRaw = ownData(req, 'episodeId').value;
    const tkRaw = ownData(req, 'taskId').value;
    if ((typeof epRaw === 'string' && epRaw.length > MAX_STR) || (typeof tkRaw === 'string' && tkRaw.length > MAX_STR)) return { channel: 'escalation:invalid' };
    const episodeId = boundedStr(epRaw) ?? '';
    const taskId = boundedStr(tkRaw) ?? '';
    const actionIdOwn = ownData(req, 'actionId');
    // Loop-c4 F3 (audit): the evidence entry is 'action:'+actionId — the
    // channel clips every entry at MAX_STR, so the RAW bound must leave
    // room for the prefix or the id is silently cut with no marker.
    const ACTION_PREFIX_LEN = 7;
    const actionIdRawStr = typeof actionIdOwn.value === 'string' ? (actionIdOwn.value as string) : undefined;
    const actionId = actionIdRawStr !== undefined
      ? (actionIdRawStr.length > MAX_STR - ACTION_PREFIX_LEN ? actionIdRawStr.slice(0, MAX_STR - ACTION_PREFIX_LEN) : actionIdRawStr)
      : boundedStr(actionIdOwn.value);
    // Cycle-4 F6 (audit MED-6): clips in the dispatcher are disclosed as
    // evidence markers (the dispatcher has no `disclosed` channel of its own).
    // Loop-c4 F3: the clip test covers the COMPOSED entry, not just the raw id.
    const actionIdClipped = actionIdRawStr !== undefined && actionIdRawStr.length + ACTION_PREFIX_LEN > MAX_STR;
    // Loop-c5 F2 (audit): a PRESENT-but-unusable actionId (non-string, an
    // accessor, a throwing descriptor) must not vanish silently (INV-4) —
    // same rule the 'rationale' path follows: drop WITH a marker.
    const actionIdDropped = actionId === undefined
      && (actionIdOwn.accessor === true || actionIdOwn.threw === true
          || (actionIdOwn.present && actionIdOwn.value !== undefined));
    // Fence-safe copy (never `.map` across a hostile array): rationale
    // entries become evidence refs under the same bounds as the channel.
    const ratOwn = ownData(req, 'rationale');
    let blocker: string | undefined;
    if (deps.blockerOf !== undefined) {
      try {
        const mapped = deps.blockerOf(req);
        blocker = typeof mapped === 'string' ? mapped : undefined;
      } catch {
        blocker = undefined; // a throwing mapper is a host defect; floor to 'unknown'
      }
    }
    // Cycle-2 F3: an accessor 'rationale' is untrusted-present — it drops
    // to nothing ONLY with a structural marker in the evidence.
    const ev = ratOwn.accessor || ratOwn.threw // cycle-4 F3: a throwing descriptor drops WITH the marker
      ? { strs: [] as string[], overflow: false, dropped: true, hostile: true, skipped: false, clipped: false, nonArray: false }
      : copyStrs(ratOwn.value, 80); // the dispatcher slices rationale at 80 — the clip must disclose
    if (ev.nonArray) { ev.dropped = true; ev.strs = []; } // cycle-3 F6: rationale:"text" is disclosed, not silently empty
    const evidenceSrc: string[] = [];
    // Cycle-2 F1: leave room for BOTH the 'action:' evidence and the
    // marker — otherwise our own list overflows the channel cap and the
    // marker is pushed out of the record entirely.
    // Loop-c2 F4 (audit): slots are reserved for the markers FIRST —
    // computing 'room' before any entry is pushed means the markers can
    // never be squeezed out of the record by a full rationale list (the
    // old last-slot-wins overwrite lost 'actionId:clipped' when BOTH
    // 'rationale:truncated' and the channel's own 'truncated' marker
    // competed for the tail).
    const entryClipped0 = ev.clipped;
    const markersPre: string[] = [];
    if (ev.dropped || ev.hostile) markersPre.push('rationale:dropped');
    else if (ev.overflow || ev.skipped || ev.clipped || entryClipped0) markersPre.push('rationale:truncated');
    if (actionIdClipped) markersPre.push('actionId:clipped');
    if (actionIdDropped) markersPre.push('actionId:dropped'); // loop-c5 F2
    const room = MAX_EVIDENCE - (actionId !== undefined ? 1 : 0) - markersPre.length;
    for (const r of ev.strs) {
      if (evidenceSrc.length >= Math.max(0, room)) break;
      // F3 (audit): a rationale that is literally 'truncated' is ordinary
      // text. The overflow marker comes ONLY from the copy's structural
      // signal below, never from a value a caller can forge.
      evidenceSrc.push(`rationale:${r.slice(0, 80)}`);
    }
    // Structural disclosure of what the fence did NOT carry through:
    // overflow (more entries than fit) and hostile drops each push the
    // marker from the copy's OWN flag — never from caller text (F3).
    // Cycle-2 F1: the marker must survive even when the evidence list is
    // already full — a shortened rationale that LOOKS complete is exactly
    // the disclosure failure this seam exists to prevent. When full, the
    // last real entry yields its slot to the marker.
    // Cycle-4 F6 (audit MED-6): EVERY loss on this path gets a marker —
    // per-entry slices at 80, skipped non-strings, and the actionId clip —
    // never a silently shortened 'rationale:' or a vanished entry. The
    // marker list is appended in order; on a full list the LAST marker
    // wins its slot (the strongest signal is 'actionId:clipped' last).
    // (source entries beyond the copy budget are disclosed by ev.overflow)
    // Cycle-1/audit (rec R4 fold + F2): the 80-slice clip flag comes from
    // copyStrs' OWN scan (clipAt=80) — no second scan, no raw Array.isArray
    // (a revoked 'rationale' proxy threw on the bare IsArray before).
    // The entry-loop may have overflowed its own room (more source entries
    // than fit) — that is itself 'rationale:truncated'; markers now always
    // land, and the channel's own cap copy can no longer evict them (the
    // array we hand raise() is ≤ MAX_EVIDENCE including markers).
    const markers: string[] = [...markersPre];
    if (ev.strs.length > evidenceSrc.length && !markers.includes('rationale:truncated') && !markers.includes('rationale:dropped')) markers.push('rationale:truncated');
    for (const marker of markers) {
      if (evidenceSrc.length < MAX_EVIDENCE - (actionId !== undefined ? 1 : 0)) evidenceSrc.push(marker);
      else evidenceSrc[evidenceSrc.length - 1] = marker; // last resort (markers > room)
    }
    const res = await deps.channel.raise({
      episodeId,
      taskId,
      ...(blocker !== undefined ? { blocker } : {}),
      ...(actionId !== undefined ? { evidence: [`action:${actionId}`, ...evidenceSrc] } : { evidence: evidenceSrc }),
    });
    if (res === null) return { channel: 'escalation:invalid' };
    return { channel: res.channel ?? (res.delivered ? 'escalation' : `escalation:${res.reason ?? 'recorded'}`) };
  };

  const park = async (req: { episodeId?: string; taskId?: string; actionId?: string; [k: string]: unknown }): Promise<void> => {
    if (!isPlainObj(req)) return;
    // Cycle-4 F1 (audit HIGH-1): same rule as escalate — an oversized
    // identity is refused, never clipped into a shared key.
    const epRaw2 = ownData(req, 'episodeId').value;
    const tkRaw2 = ownData(req, 'taskId').value;
    if ((typeof epRaw2 === 'string' && epRaw2.length > MAX_STR) || (typeof tkRaw2 === 'string' && tkRaw2.length > MAX_STR)) return;
    const episodeId = boundedStr(epRaw2) ?? '';
    const taskId = boundedStr(tkRaw2) ?? '';
    // Loop-c4 F3 (audit): same composed-entry bound as escalate — a
    // 235+ char id would be cut by the channel with no marker.
    // Loop-c5 F1/F2 (audit): park ALSO discloses through the evidence —
    // 'actionId:clipped' on a composed clip, 'actionId:dropped' when the
    // field was present but unusable. Silent loss is the INV-4 failure.
    const parkActionOwn = ownData(req, 'actionId');
    const parkActionRaw = typeof parkActionOwn.value === 'string' ? (parkActionOwn.value as string) : undefined;
    const parkActionId = parkActionRaw !== undefined
      ? (parkActionRaw.length > MAX_STR - 7 ? parkActionRaw.slice(0, MAX_STR - 7) : parkActionRaw)
      : boundedStr(parkActionOwn.value);
    const parkMarkers: string[] = [];
    if (parkActionRaw !== undefined && parkActionRaw.length + 7 > MAX_STR) parkMarkers.push('actionId:clipped');
    if (parkActionId === undefined && (parkActionOwn.accessor === true || parkActionOwn.threw === true || (parkActionOwn.present && parkActionOwn.value !== undefined))) parkMarkers.push('actionId:dropped');
    const parkEvidence: string[] = [];
    if (parkActionId !== undefined) parkEvidence.push(`action:${parkActionId}`);
    for (const m of parkMarkers) {
      if (parkEvidence.length < MAX_EVIDENCE) parkEvidence.push(m);
      else parkEvidence[parkEvidence.length - 1] = m;
    }
    await deps.channel.raise({
      episodeId,
      taskId,
      blocker: 'repeated-strategy',
      decisionNeeded: 'the task is parked — approve a new approach, rewrite it, or abort',
      ...(parkEvidence.length > 0 ? { evidence: parkEvidence } : {}),
    });
  };

  return { escalate, park };
}
