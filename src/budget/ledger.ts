/**
 * P8 — Budget ledger & spend authority (docs/12, docs/11 §14.1).
 *
 * Two halves in one module (the ledger IS the authority's memory):
 *
 *  1. BudgetLedger — an append-only JSONL ledger of spend, reservations,
 *     reservation closures, and attempt-wallclock windows for one episode.
 *     Same durability discipline as the P4 DecisionJournal (docs/11 §13.1):
 *     fsync-before-return, serialized appends, torn-tail repair on open,
 *     mid-file corruption fails closed, duplicate record ids reported,
 *     duplicate-key JSON refused.
 *
 *  2. check() — the authority gate. A PURE function of (policy, request,
 *     ledger snapshot): every spend-gated spawn must pass it, and passing
 *     mints an opaque capability receipt (module-private WeakMap — not a
 *     forgeable struct). BudgetLedger.reserve() re-runs check() INSIDE the
 *     serialized append queue (refresh-first) before writing the
 *     reservation: check(X)-then-act(Y) and TOCTOU are both structurally
 *     closed. This is the R6/R7 lesson applied pre-emptively.
 *
 * Decisions pinned by the user (docs/12 §7):
 *  D1 rates: in-module DEFAULT_RATES + per-episode overrides; the rate is
 *     FROZEN onto each spend record at ingest — history never reprices.
 *  D2 reservations: P8 owns estimates. The default is derived from the
 *     episode's own per-attempt caps (worst case a spawn can burn); the
 *     caller may only RAISE, never lower; every raise decision is recorded.
 *  D3 capability receipt: opaque handle, WeakMap-backed, digest-bound to
 *     the canonical action spec, expiry-enforced. Scope: run/resume only.
 *
 * Invariants (docs/12 §5) — each has a named test in the P8 suite:
 *  A1 over-spending is impossible at the gate (check fails loud, receipts
 *     are the only admission ticket, re-checked at reservation).
 *  A2 reservations reconcile (every open reservation closes: settled /
 *     released / expired / abandoned — or reconcile() names it as stale).
 *  A3 grants are durable (authority.grantedBy + sideEffect + receipt
 *     digest are written on the reservation record itself).
 *  A4 check is the only path (reserve admits only a minted receipt that
 *     matches the request; there is no append-a-reservation API).
 *  A5 no execution without a durable trail (spawn happens only against a
 *     durably appended reservation — the runner receives the receipt
 *     after reserve() resolves).
 *  A6 attempt accounting per attempt (run reservations consume attempt
 *     slots; resume never does; a failed-spawn release refunds the slot).
 *  A7 projection determinism (same records → byte-identical snapshot).
 *  A8 reservation release never double-counts (holds released exactly
 *     once; spend counted exactly once per session entry id).
 *  A9 no unpriced path (every spend record carries frozen rates and a
 *     computed cost; fallback-priced records are marked and visible).
 *
 * Compartment discipline: node: builtins only — no repo imports (P5
 * pattern). The runner (P7) and the supervisor (P9) receive the receipt
 * as an opaque value typed against a structural interface at their own
 * boundary; nothing under src/ imports this module until P9.
 */
import { appendFile, mkdir, open as fsOpen, readFile, stat, truncate } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

// ───────────────────────────── shared atoms ─────────────────────────────────

/** Schema id pinned per line of the ledger file. */
export const LEDGER_SCHEMA_ID = "tre-budget/1";

/** Errors thrown by the ledger machinery. `code` is stable API. */
export class BudgetLedgerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BudgetLedgerError";
  }
}

function assertSafeId(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\u0000-\u001f]/.test(value)) {
    throw new BudgetLedgerError("bad-input", `${what} must be a non-empty printable string (≤256 chars)`);
  }
  return value;
}

function assertNonNeg(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new BudgetLedgerError("bad-input", `${what} must be a finite non-negative number`);
  }
  return value;
}

function assertInt(value: unknown, what: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new BudgetLedgerError("bad-input", `${what} must be a non-negative integer`);
  }
  return value as number;
}

/** Deterministic clock injection (every timing decision takes `now`). */
export type Clock = () => number;

// ───────────────────────────── pricing (D1) ─────────────────────────────────

/** USD per million tokens. `cacheRead`/`cacheWrite` default to `input`. */
export interface Rate {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** One table entry. Matching precedence: exact model > model prefix
 *  (trailing `*`) > exact provider > fallback. More specific first. */
export interface RateEntry {
  /** Exact model id, or prefix with trailing `*`. */
  model?: string;
  /** Exact provider label. */
  provider?: string;
  rate: Rate;
}

/** Built-in table: the lab is self-hosted, so the shipped default prices
 *  nothing by name — pricing arrives via episode policy overrides. When a
 *  model matches no entry, `FALLBACK_RATE` applies and the record is
 *  marked priced:"fallback" (A9 — visible, never silent). */
export const DEFAULT_RATES: readonly RateEntry[] = Object.freeze([
  { model: "gpt-4o", rate: { input: 2.5, output: 10 } },
  { model: "gpt-4o-mini", rate: { input: 0.15, output: 0.6 } },
  { model: "claude-sonnet*", rate: { input: 3, output: 15 } },
  { model: "claude-*", rate: { input: 3, output: 15 } },
  { provider: "openrouter", rate: { input: 1, output: 4 } },
]);

/** Applied when no entry matches. Zero prices keep self-hosted labs free
 *  while the marker keeps the exposure visible to audit. */
export const FALLBACK_RATE: Rate = Object.freeze({ input: 0, output: 0 });

/** Match one table (exact model > model prefix > exact provider). Pure. */
function matchTable(table: readonly RateEntry[], model: string, provider: string): Rate | undefined {
  for (const entry of table) {
    if (entry.model !== undefined && entry.model === model) return entry.rate;
  }
  for (const entry of table) {
    if (entry.model?.endsWith("*") && entry.model.length > 1 && model.startsWith(entry.model.slice(0, -1))) return entry.rate;
  }
  for (const entry of table) {
    if (entry.provider !== undefined && entry.provider === provider) return entry.rate;
  }
  return undefined;
}

/** Resolve the rate AND its provenance (A9 — the priced marker is
 *  derived, never hand-claimed): override > table > fallback. `overrides`
 *  (episode policy, D1) are consulted BEFORE the built-in table. Pure. */
export function resolveRateSource(model: string, provider: string, overrides?: readonly RateEntry[]): { rate: Rate; priced: SpendPriced } {
  if (overrides) {
    const r = matchTable(overrides, model, provider);
    if (r !== undefined) return { rate: r, priced: "override" };
  }
  const t = matchTable(DEFAULT_RATES, model, provider);
  if (t !== undefined) return { rate: t, priced: "table" };
  return { rate: FALLBACK_RATE, priced: "fallback" };
}

/** Resolve the rate for (model, provider). `overrides` (episode policy,
 *  D1) are consulted BEFORE the built-in table. Pure. */
export function resolveRate(model: string, provider: string, overrides?: readonly RateEntry[]): Rate {
  return resolveRateSource(model, provider, overrides).rate;
}

/** Token usage as it arrives on a session message (structural — mirrors
 *  the wire Usage without importing it; compartment rule). */
export interface UsageIn {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Cost in USD for one usage line at the given (already resolved) rate.
 * Component accounting (matches the codebase's usage normalization where
 * cacheRead ⊆ input): the billable split is
 *   (input − cacheRead − cacheWrite) @ input
 * + cacheRead @ (rate.cacheRead ?? input)
 * + cacheWrite @ (rate.cacheWrite ?? input)
 * + output @ output,
 * all per million. Defensive clamp: cache components never exceed input,
 * the uncached component never goes negative. Pure; deterministic.
 */
export function computeCostUsd(usage: UsageIn, rate: Rate): number {
  const input = Math.max(0, usage.input);
  const output = Math.max(0, usage.output);
  const cacheRead = Math.min(Math.max(0, usage.cacheRead ?? 0), input);
  const cacheWrite = Math.min(Math.max(0, usage.cacheWrite ?? 0), input - cacheRead);
  const plain = input - cacheRead - cacheWrite;
  const rIn = rate.input, rOut = rate.output;
  const rCr = rate.cacheRead ?? rate.input, rCw = rate.cacheWrite ?? rate.input;
  return (plain * rIn + cacheRead * rCr + cacheWrite * rCw + output * rOut) / 1e6;
}

// ─────────────────────────── record types & validation ──────────────────────

export interface LedgerEnvelope {
  schema: typeof LEDGER_SCHEMA_ID;
  /** Caller-stable unique id ("b-<uuid>"). Duplicate ids are REPORTED by
   *  read() and refused on append-within-instance. */
  id: string;
  /** ms epoch, written by the ledger at append (never caller-supplied). */
  ts: number;
  episodeId: string;
  taskId?: string;
  attemptId?: string;
}

/** A9: rate provenance on every spend record. */
export type SpendPriced = "table" | "override" | "fallback";

export interface SpendRecord extends LedgerEnvelope {
  kind: "spend";
  /** Dedup key (§2): the session entry id the usage came from. Manual
   *  spends use their own record id. Re-ingesting the same entry id is a
   *  silent no-op (A8 — counted exactly once). */
  lineId: string;
  model: string;
  provider: string;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** Frozen at ingest (D1): never recomputed, history never reprices. */
  rates: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  costUsd: number;
  priced: SpendPriced;
  /** True when produced by ingestSession/ingestEntries (vs manual). */
  source: "session" | "manual";
  /** Operator note on manual spends (auditable free text). */
  note?: string;
}

/** The two ledger-visible gated actions (docs/12 §4). */
export const LEDGER_GATED_ACTIONS = ["run", "resume"] as const;
export type LedgerGatedAction = (typeof LEDGER_GATED_ACTIONS)[number];

export interface ReservationOpenRecord extends LedgerEnvelope {
  kind: "res-open";
  /** The actionId this reservation exists for (matches decision-intent). */
  actionId: string;
  action: LedgerGatedAction;
  reservedUsd: number;
  reservedTurns: number;
  /** Epoch ms after which the hold is dead for projection purposes. */
  expiresAt: number;
  // ── A3 durable authority trail (P9 copies these onto decision-intent) ──
  grantedBy: string;
  sideEffect: "none" | "worktree-local" | "external";
  /** sha256 hex over the canonical action spec the check was passed for. */
  receiptDigest: string;
  /** D2: was the caller's estimate raised to (or defaulted from) the cap
   *  floor? Always present so the raise decision is auditable. */
  estimateRaised: boolean;
}

export const RESERVATION_CLOSE_REASONS = ["settled", "released", "expired", "abandoned"] as const;
export type ReservationCloseReason = (typeof RESERVATION_CLOSE_REASONS)[number];

export interface ReservationCloseRecord extends LedgerEnvelope {
  kind: "res-close";
  /** The res-open record id. */
  refId: string;
  reason: ReservationCloseReason;
}

/** Per-attempt wallclock window, appended by the supervisor when an
 *  attempt ends (feeds caps.wallclockS at the gate). */
export interface WallclockRecord extends LedgerEnvelope {
  kind: "wallclock";
  seconds: number;
}

export type LedgerRecord = SpendRecord | ReservationOpenRecord | ReservationCloseRecord | WallclockRecord;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f]/.test(v);
}
function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isInt0(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0;
}
function isRate(v: unknown): v is { input: number; output: number; cacheRead?: number; cacheWrite?: number } {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return isNum(r.input) && (r.input as number) >= 0 && isNum(r.output) && (r.output as number) >= 0
    && (r.cacheRead === undefined || (isNum(r.cacheRead) && (r.cacheRead as number) >= 0))
    && (r.cacheWrite === undefined || (isNum(r.cacheWrite) && (r.cacheWrite as number) >= 0));
}

/** Validate one record against its kind. Throws BudgetLedgerError.
 *  Extra fields are allowed (open schema, P4 style); core fields are not. */
export function validateLedgerRecord(record: unknown): asserts record is LedgerRecord {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new BudgetLedgerError("schema", "ledger record must be an object");
  }
  const r = record as Record<string, unknown>;
  if (r.schema !== LEDGER_SCHEMA_ID) throw new BudgetLedgerError("schema", `ledger record: schema must be "${LEDGER_SCHEMA_ID}"`);
  if (!isNonEmptyString(r.id)) throw new BudgetLedgerError("schema", "ledger record: id invalid");
  if (!isNum(r.ts) || (r.ts as number) < 0) throw new BudgetLedgerError("schema", "ledger record: ts invalid");
  if (!isNonEmptyString(r.episodeId)) throw new BudgetLedgerError("schema", "ledger record: episodeId invalid");
  if (r.taskId !== undefined && !isNonEmptyString(r.taskId)) throw new BudgetLedgerError("schema", "ledger record: taskId invalid");
  if (r.attemptId !== undefined && !isNonEmptyString(r.attemptId)) throw new BudgetLedgerError("schema", "ledger record: attemptId invalid");
  switch (r.kind) {
    case "spend": {
      if (!isNonEmptyString(r.lineId)) throw new BudgetLedgerError("schema", "spend: lineId invalid");
      if (!isNonEmptyString(r.model) || !isNonEmptyString(r.provider)) throw new BudgetLedgerError("schema", "spend: model/provider invalid");
      const u = r.usage as Record<string, unknown> | undefined;
      if (!u || !isInt0(u.input) || !isInt0(u.output)) throw new BudgetLedgerError("schema", "spend: usage.input/output invalid");
      if (u.cacheRead !== undefined && !isInt0(u.cacheRead)) throw new BudgetLedgerError("schema", "spend: usage.cacheRead invalid");
      if (u.cacheWrite !== undefined && !isInt0(u.cacheWrite)) throw new BudgetLedgerError("schema", "spend: usage.cacheWrite invalid");
      if (!isRate(r.rates)) throw new BudgetLedgerError("schema", "spend: frozen rates invalid");
      if (!isNum(r.costUsd) || (r.costUsd as number) < 0) throw new BudgetLedgerError("schema", "spend: costUsd invalid");
      if (r.priced !== "table" && r.priced !== "override" && r.priced !== "fallback") throw new BudgetLedgerError("schema", "spend: priced marker invalid");
      if (r.source !== "session" && r.source !== "manual") throw new BudgetLedgerError("schema", "spend: source invalid");
      break;
    }
    case "res-open": {
      if (!isNonEmptyString(r.actionId)) throw new BudgetLedgerError("schema", "res-open: actionId invalid");
      if (r.action !== "run" && r.action !== "resume") throw new BudgetLedgerError("schema", "res-open: action not a gated action");
      if (!isNum(r.reservedUsd) || (r.reservedUsd as number) <= 0) throw new BudgetLedgerError("schema", "res-open: reservedUsd must be > 0");
      if (!isInt0(r.reservedTurns)) throw new BudgetLedgerError("schema", "res-open: reservedTurns invalid");
      if (!isNum(r.expiresAt) || (r.expiresAt as number) <= 0) throw new BudgetLedgerError("schema", "res-open: expiresAt invalid");
      if (!isNonEmptyString(r.grantedBy)) throw new BudgetLedgerError("schema", "res-open: grantedBy invalid (A3)");
      if (r.sideEffect !== "none" && r.sideEffect !== "worktree-local" && r.sideEffect !== "external")
        throw new BudgetLedgerError("schema", "res-open: sideEffect invalid");
      if (!isNonEmptyString(r.receiptDigest) || !/^[0-9a-f]{64}$/.test(r.receiptDigest)) throw new BudgetLedgerError("schema", "res-open: receiptDigest must be sha256 hex");
      if (typeof r.estimateRaised !== "boolean") throw new BudgetLedgerError("schema", "res-open: estimateRaised missing (D2)");
      break;
    }
    case "res-close": {
      if (!isNonEmptyString(r.refId)) throw new BudgetLedgerError("schema", "res-close: refId invalid");
      if (!(RESERVATION_CLOSE_REASONS as readonly string[]).includes(r.reason as string))
        throw new BudgetLedgerError("schema", `res-close: reason must be one of ${RESERVATION_CLOSE_REASONS.join("|")}`);
      break;
    }
    case "wallclock": {
      if (!isNum(r.seconds) || (r.seconds as number) < 0) throw new BudgetLedgerError("schema", "wallclock: seconds invalid");
      break;
    }
    default:
      throw new BudgetLedgerError("schema", `ledger record: unknown kind ${JSON.stringify(String(r.kind))}`);
  }
}

// ───────────────────────────── projections (A7) ─────────────────────────────

export interface Compartment {
  episodeId: string;
  taskId?: string;
  attemptId?: string;
}

export interface CompartmentUsage {
  consumedUsd: number;
  /** Assistant messages (one per spend record), the turn counter. */
  consumedTurns: number;
  /** Sum of OPEN, non-expired reservation holds. Expired holds vanish from
   *  the projection at read-time (stale() still lists them). */
  reservedUsd: number;
  reservedTurns: number;
  /** run-reservations that consumed an attempt slot (A6). Keyed here, not
   *  summed: slot accounting is per task. */
}

export interface BudgetSnapshot {
  /** The clock the projection was taken at (expiry decisions recorded). */
  now: number;
  /** Compartment key (JSON of the 3-tuple) → usage. Deterministic order:
   *  insertion order of first touching record per kind-specific fold. */
  compartments: Map<string, CompartmentUsage>;
  /** Per-task attempt-slot usage from run reservations (A6): a run
   *  reservation consumes a slot when open-or-settled; released/expired
   *  refunds it. */
  attemptsUsed: Map<string, number>;
  /** Total wallclock seconds recorded per task. */
  wallclockS: Map<string, number>;
  /** Wallclock seconds per (episode, task, attempt) — only records that
   *  name an attempt contribute (feeds perAttempt.wallclockS at the gate). */
  attemptWallclockS: Map<string, number>;
  /** Open reservations (holds live; may be expired — see stale()). */
  openReservations: ReservationOpenRecord[];
  /** Attempts EVER named by a res-open record (compartment key), regardless
   *  of expiry/close — the durable "run reserved this attempt first"
   *  trail the resume trap reads (A6). */
  reservedAttempts: Set<string>;
  /** Spend line ids already on the ledger (ingest dedup, A8). */
  seenLineIds: Set<string>;
  /** Spend records whose price came from the fallback (A9 visibility). */
  fallbackPricedCount: number;
  /** Duplicate record ids found in the file (never silently merged). */
  duplicateIds: string[];
}

export const compartmentKey = (c: Compartment): string =>
  JSON.stringify([c.episodeId, c.taskId ?? null, c.attemptId ?? null]);

/** Parent chain for a compartment: a spend in an attempt charges the
 *  attempt, its task, AND the episode. */
function chainOf(c: Compartment): Compartment[] {
  const out: Compartment[] = [{ episodeId: c.episodeId }];
  if (c.taskId !== undefined) out.push({ episodeId: c.episodeId, taskId: c.taskId });
  if (c.taskId !== undefined && c.attemptId !== undefined) out.push({ ...c });
  return out;
}

/**
 * Fold records into a snapshot. Deterministic (A7): pure fold over record
 * order; `now` (injected) resolves expiry. No I/O, no clock reads.
 */
export function projectLedger(records: readonly LedgerRecord[], now: number): BudgetSnapshot {
  const compartments = new Map<string, CompartmentUsage>();
  const attemptsUsed = new Map<string, number>();
  const wallclockS = new Map<string, number>();
  const attemptWallclockS = new Map<string, number>();
  const open = new Map<string, ReservationOpenRecord>(); // res-open id, superseded by close
  const reservedAttempts = new Set<string>(); // every attempt ever reserved (A6 trail)
  const seenLineIds = new Set<string>();
  const duplicateIds: string[] = [];
  const ids = new Set<string>();
  let fallbackPricedCount = 0;

  const touch = (c: Compartment): CompartmentUsage => {
    const key = compartmentKey(c);
    let usage = compartments.get(key);
    if (!usage) {
      usage = { consumedUsd: 0, consumedTurns: 0, reservedUsd: 0, reservedTurns: 0 };
      compartments.set(key, usage);
    }
    return usage;
  };

  for (const record of records) {
    if (ids.has(record.id)) {
      if (!duplicateIds.includes(record.id)) duplicateIds.push(record.id);
      // A duplicate id is REPORTED but the record still folds (it may be a
      // legitimately redelivered line — spend lineId dedup below protects
      // money; id duplication itself is an operator-visible anomaly).
    } else {
      ids.add(record.id);
    }
    switch (record.kind) {
      case "spend": {
        if (record.episodeId === undefined) break;
        if (seenLineIds.has(record.lineId)) break; // A8: counted exactly once
        seenLineIds.add(record.lineId);
        if (record.priced === "fallback") fallbackPricedCount++;
        for (const c of chainOf({ episodeId: record.episodeId, taskId: record.taskId, attemptId: record.attemptId })) {
          const usage = touch(c);
          usage.consumedUsd += record.costUsd;
          usage.consumedTurns += 1;
        }
        break;
      }
      case "res-open": {
        // Holds live on the reservation's OWN compartment (episode, task —
        // an attempt reservation always names its task, else it could only
        // be enforced at episode level).
        if (record.attemptId !== undefined) {
          reservedAttempts.add(JSON.stringify([record.episodeId, record.taskId ?? null, record.attemptId]));
        }
        if (open.has(record.id)) break; // duplicate res-open id: first wins (reported above)
        open.set(record.id, record);
        break;
      }
      case "res-close": {
        open.delete(record.refId);
        break;
      }
      case "wallclock": {
        if (record.taskId !== undefined) wallclockS.set(record.taskId, (wallclockS.get(record.taskId) ?? 0) + record.seconds);
        if (record.taskId !== undefined && record.attemptId !== undefined) {
          const ak = JSON.stringify([record.episodeId, record.taskId, record.attemptId]);
          attemptWallclockS.set(ak, (attemptWallclockS.get(ak) ?? 0) + record.seconds);
        }
        break;
      }
    }
  }

  // Fold live holds AFTER the pass so closes anywhere in the file apply.
  const openReservations: ReservationOpenRecord[] = [];
  for (const reservation of open.values()) {
    if (reservation.expiresAt <= now) continue; // expired hold: invisible to the gate
    openReservations.push(reservation);
    for (const c of chainOf({ episodeId: reservation.episodeId, taskId: reservation.taskId })) {
      const usage = touch(c);
      usage.reservedUsd += reservation.reservedUsd;
      usage.reservedTurns += reservation.reservedTurns;
    }
    if (reservation.action === "run") {
      const taskKey = JSON.stringify([reservation.episodeId, reservation.taskId ?? null]);
      attemptsUsed.set(taskKey, (attemptsUsed.get(taskKey) ?? 0) + 1);
    }
  }

  return { now, compartments, attemptsUsed, wallclockS, attemptWallclockS, openReservations, reservedAttempts, seenLineIds, fallbackPricedCount, duplicateIds };
}

/** Reservations still open at `now` — the reconcile list (A2). Each must
 *  eventually close (settled/released/abandoned) or expire; this is the
 *  supervisor's standing obligation, surfaced here as data. */
export function staleReservations(records: readonly LedgerRecord[], now: number): ReservationOpenRecord[] {
  return projectLedger(records, now).openReservations;
}

// ───────────────────────── policy & the gate check (A1/A4) ──────────────────

/** One numeric cap; `undefined` = uncapped. */
export type Cap = number | undefined;

export interface GatePolicy {
  episodeId: string;
  /** Episode hard caps (docs/12 §2). */
  caps: { usd?: Cap; turns?: Cap; wallclockS?: Cap };
  /** Per-task caps (optional). */
  perTask?: { usd?: Cap; turns?: Cap; attempts?: Cap };
  /** Per-attempt caps (optional). Doubles as the reservation floor for a
   *  spawn (D2 — the estimate a spawn must carry is what it can burn). */
  perAttempt?: { usd?: Cap; turns?: Cap; wallclockS?: Cap };
  /** maxAttemptsPerTask (episode recovery budget, docs/11 §3). */
  maxAttemptsPerTask?: Cap;
  /** policy.authority.allowExternalEffects — an "external" action denies
   *  unless this is true (the authority half of the gate). */
  allowExternalEffects: boolean;
  /** D1 override table, consulted before DEFAULT_RATES. */
  rates?: readonly RateEntry[];
  /** Reservation TTL in ms (default RESERVATION_TTL_MS). Per-policy so a
   *  long attempt can carry a long hold. */
  reservationTtlMs?: number;
}

export interface GateRequest {
  action: LedgerGatedAction;
  actionId: string;
  taskId?: string;
  attemptId?: string;
  /** Caller's authority as held at ask-time (P9's grant, from graph
   *  policy; "external" additionally requires policy.allowExternalEffects). */
  authority: { grantedBy: string; sideEffect: "none" | "worktree-local" | "external" };
  /** Caller estimate (D2): may only RAISE above the floor. Absent = floor. */
  estimate?: { usd?: number; turns?: number };
}

/** Structured denial (stable codes — P9 renders, tests match codes). */
export type DenialCode =
  | "authority-missing"          // grantedBy empty-ish (assertion caught it, defense in depth)
  | "external-not-allowed"
  | "episode-budget-exceeded"
  | "episode-turns-exceeded"
  | "episode-wallclock-exceeded"
  | "task-budget-exceeded"
  | "task-turns-exceeded"
  | "task-attempts-exhausted"
  | "attempt-budget-exceeded"
  | "attempt-turns-exceeded"
  | "attempt-wallclock-exceeded"
  | "estimate-invalid";

export interface Denial {
  code: DenialCode;
  detail: string;
  /** Headroom at check time (same unit as the violated cap), possibly 0.
   *  P9 renders "you have $0.40 left of $2.00" from cap + headroomUsd. */
  cap?: number;
  headroomUsd?: number;
}

export interface CheckResult {
  /** True iff denials is empty; receipt exists iff true. */
  allowed: boolean;
  denials: Denial[];
  /** The effective (raised) reservation the caller asked for — reported
   *  on BOTH outcomes so P9 never guesses the D2 raise. */
  reserve: { usd: number; turns: number };
  /** True if the caller estimate was raised to (or defaulted from) the
   *  cap-derived floor (D2). */
  estimateRaised: boolean;
  /** Expiry (ms epoch) a reservation minted from this check would carry. */
  expiresAt: number;
  /** Present iff allowed. The capability (A4). */
  receipt?: ActionReceipt;
}

export const RESERVATION_TTL_MS = 30 * 60 * 1000; // 30 min default hold

/** D2 floor: estimate usd = per-attempt usd cap (what the action can
 *  burn); falls back to the episode usd cap, then to 0 with an explicit
 *  caller estimate required… A spawn with NO usd cap anywhere is uncapped
 *  by policy, so the gate cannot compute a floor; reserve 0 is meaningless
 *  as a hold, so such episodes reserve a sentinel 0.000001? No — reserve
 *  is only meaningful where caps exist. With no caps, reservedUsd must be
 *  > 0 (schema); the floor falls back to FLOOR_WITHOUT_CAPS so the trail
 *  exists, and the gate cannot be violated by an uncapped episode anyway.
 */
const FLOOR_WITHOUT_CAPS = 0.000001;

/** Canonical string for the digest: the exact spec the receipt binds.
 *  Deterministic (fixed field order, null for absent). */
export function canonicalActionSpec(policy: GatePolicy, request: GateRequest, reserve: { usd: number; turns: number }): string {
  return JSON.stringify([
    policy.episodeId,
    request.taskId ?? null,
    request.attemptId ?? null,
    request.action,
    request.actionId,
    request.authority.grantedBy,
    request.authority.sideEffect,
    reserve.usd,
    reserve.turns,
  ]);
}

/**
 * THE GATE (A1). Pure function of policy + request + snapshot at `now`.
 * Every check — live, refresh-at-reserve, or a test replay — runs the
 * same fold, so the three can never diverge.
 */
export function check(policy: GatePolicy, request: GateRequest, snapshot: BudgetSnapshot, now: number): CheckResult {
  const denials: Denial[] = [];
  const deny = (code: DenialCode, detail: string, extra?: Partial<Denial>) => denials.push({ code, detail, ...extra });

  // ── authority half ──
  const grantedBy = request.authority?.grantedBy;
  if (typeof grantedBy !== "string" || grantedBy.trim() === "") deny("authority-missing", "authority.grantedBy must name the granting surface");
  if (request.authority?.sideEffect === "external" && policy.allowExternalEffects !== true)
    deny("external-not-allowed", "action has sideEffect 'external' but policy.allowExternalEffects is not true");

  // ── D2: effective reservation (caller may only raise) ──
  const floorUsd = policy.perAttempt?.usd ?? policy.caps.usd ?? FLOOR_WITHOUT_CAPS;
  const floorTurns = policy.perAttempt?.turns ?? policy.caps.turns ?? 1;
  const wantUsd = request.estimate?.usd;
  const wantTurns = request.estimate?.turns;
  if (wantUsd !== undefined && (!isNum(wantUsd) || wantUsd < 0)) deny("estimate-invalid", "estimate.usd must be a finite non-negative number");
  if (wantTurns !== undefined && !isInt0(wantTurns)) deny("estimate-invalid", "estimate.turns must be a non-negative integer");
  const reserveUsd = Math.max(wantUsd !== undefined && isNum(wantUsd) ? wantUsd : 0, floorUsd);
  const reserveTurns = Math.max(wantTurns !== undefined && isInt0(wantTurns) ? wantTurns : 0, floorTurns);
  const estimateRaised = reserveUsd > (wantUsd ?? 0) || reserveTurns > (wantTurns ?? 0);
  const reserve = { usd: reserveUsd, turns: reserveTurns };

  // ── budget half: same compartment roll-ups for every cap class ──
  const usageAt = (c: Compartment): CompartmentUsage =>
    snapshot.compartments.get(compartmentKey(c)) ?? { consumedUsd: 0, consumedTurns: 0, reservedUsd: 0, reservedTurns: 0 };
  const episode = usageAt({ episodeId: policy.episodeId });
  const task = request.taskId !== undefined ? usageAt({ episodeId: policy.episodeId, taskId: request.taskId }) : undefined;
  const attempt = request.taskId !== undefined && request.attemptId !== undefined
    ? usageAt({ episodeId: policy.episodeId, taskId: request.taskId, attemptId: request.attemptId })
    : undefined;

  // consumed + new reservation must fit the cap (docs/12 §3).
  const overUsd = (label: string, usage: CompartmentUsage, cap: Cap, code: DenialCode) => {
    if (cap === undefined) return;
    const projected = usage.consumedUsd + usage.reservedUsd + reserveUsd;
    if (projected > cap) deny(code, `${label}: $${projected.toFixed(6)} projected (consumed $${usage.consumedUsd.toFixed(6)} + reserved $${usage.reservedUsd.toFixed(6)} + this $${reserveUsd.toFixed(6)}) exceeds cap $${cap}`, { cap, headroomUsd: Math.max(0, cap - usage.consumedUsd - usage.reservedUsd) });
  };
  const overTurns = (label: string, usage: CompartmentUsage, cap: Cap, code: DenialCode) => {
    if (cap === undefined) return;
    const projected = usage.consumedTurns + usage.reservedTurns + reserveTurns;
    if (projected > cap) deny(code, `${label}: ${projected} projected turns (consumed ${usage.consumedTurns} + reserved ${usage.reservedTurns} + this ${reserveTurns}) exceeds cap ${cap}`, { cap });
  };

  overUsd("episode", episode, policy.caps.usd, "episode-budget-exceeded");
  overTurns("episode", episode, policy.caps.turns, "episode-turns-exceeded");
  if (policy.caps.wallclockS !== undefined) {
    const used = [...snapshot.wallclockS.values()].reduce((a, b) => a + b, 0);
    if (used > policy.caps.wallclockS) deny("episode-wallclock-exceeded", `episode: ${used}s wallclock exceeds cap ${policy.caps.wallclockS}s`, { cap: policy.caps.wallclockS });
  }
  if (request.taskId !== undefined && task !== undefined) {
    overUsd(`task ${request.taskId}`, task, policy.perTask?.usd, "task-budget-exceeded");
    overTurns(`task ${request.taskId}`, task, policy.perTask?.turns, "task-turns-exceeded");
    const attempts = snapshot.attemptsUsed.get(JSON.stringify([policy.episodeId, request.taskId])) ?? 0;
    const max = policy.perTask?.attempts ?? policy.maxAttemptsPerTask;
    if (max !== undefined && attempts + (request.action === "run" ? 1 : 0) > max) {
      deny("task-attempts-exhausted", `task ${request.taskId}: ${attempts} attempt slots used, cap ${max}`, { cap: max }); // A6: run only
    }
  }
  if (attempt !== undefined) {
    overUsd(`attempt ${request.attemptId}`, attempt, policy.perAttempt?.usd, "attempt-budget-exceeded");
    overTurns(`attempt ${request.attemptId}`, attempt, policy.perAttempt?.turns, "attempt-turns-exceeded");
  }
  if (request.attemptId !== undefined && policy.perAttempt?.wallclockS !== undefined) {
    const used = snapshot.attemptWallclockS.get(JSON.stringify([policy.episodeId, request.taskId ?? null, request.attemptId])) ?? 0;
    if (used > policy.perAttempt.wallclockS) deny("attempt-wallclock-exceeded", `attempt ${request.attemptId}: ${used}s wallclock exceeds cap ${policy.perAttempt.wallclockS}s`, { cap: policy.perAttempt.wallclockS });
  }
  if (request.taskId !== undefined && request.attemptId !== undefined && request.action === "resume") {
    // resume into an attempt that was never reserved by a run is the A6
    // trap: no hold ever staked its claim, so nothing binds its future
    // burn. Presence = a res-open EVER named this attempt (survives the
    // reservation closing or expiring — the trail is the point, not the
    // hold).
    const attemptKey = JSON.stringify([policy.episodeId, request.taskId, request.attemptId]);
    if (!snapshot.reservedAttempts.has(attemptKey)) {
      deny("attempt-budget-exceeded", `resume: attempt ${request.attemptId} was never reserved by a run (A6) — run must reserve before resume`);
    }
  }

  // ── mint (A4: only path to a receipt) ──
  const ttl = policy.reservationTtlMs !== undefined ? policy.reservationTtlMs : RESERVATION_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0) throw new BudgetLedgerError("bad-input", "policy.reservationTtlMs must be finite > 0");
  const expiresAt = now + ttl;
  if (denials.length > 0) {
    return { allowed: false, denials, reserve, estimateRaised, expiresAt };
  }
  const digest = createHash("sha256").update(canonicalActionSpec(policy, request, reserve), "utf8").digest("hex");
  const receipt = mintReceipt({
    digest, episodeId: policy.episodeId, taskId: request.taskId, attemptId: request.attemptId,
    action: request.action, actionId: request.actionId, grantedBy: grantedBy!, sideEffect: request.authority.sideEffect,
    reserveUsd, reserveTurns, expiresAt,
  });
  return { allowed: true, denials: [], reserve, estimateRaised, expiresAt, receipt };
}

// ────────────────────────── the capability receipt (D3) ─────────────────────

interface ReceiptInner {
  digest: string;
  episodeId: string;
  taskId?: string;
  attemptId?: string;
  action: LedgerGatedAction;
  actionId: string;
  grantedBy: string;
  sideEffect: "none" | "worktree-local" | "external";
  reserveUsd: number;
  reserveTurns: number;
  expiresAt: number;
}

/**
 * The module-private capability registry (D3). The key set is unreachable
 * from outside this module — a plain object with copied fields is NOT a
 * receipt. Only check() mints; only reserve() (and verifyReceiptFor below)
 * consumes.
 */
const RECEIPTS = new WeakMap<object, ReceiptInner>();

/** The opaque handle. `verify` is the structural seam: P7 declares its own
 *  4-line interface for the parameter and calls verify() before spawning;
 *  it never imports this module. */
export class ActionReceipt {
  /** Verify the handle matches the action about to be executed, at `now`.
   *  Pure, synchronous, no I/O. Expiry enforced here (D3). */
  verify(spec: { action: string; actionId: string; episodeId: string; taskId?: string }, now?: number): { ok: true; inner?: undefined } | { ok: false; reason: string } {
    const inner = RECEIPTS.get(this);
    if (!inner) return { ok: false, reason: "not a minted receipt (WeakMap miss)" };
    if (inner.action !== spec.action) return { ok: false, reason: `receipt is for action '${inner.action}', spec says '${spec.action}'` };
    if (inner.actionId !== spec.actionId) return { ok: false, reason: `receipt is for actionId '${inner.actionId}', spec says '${spec.actionId}'` };
    if (inner.episodeId !== spec.episodeId) return { ok: false, reason: `receipt is bound to episode '${inner.episodeId}'` };
    if (inner.taskId !== spec.taskId) return { ok: false, reason: `receipt is bound to task ${JSON.stringify(inner.taskId ?? null)}` };
    const at = now ?? Date.now();
    if (at >= inner.expiresAt) return { ok: false, reason: `receipt expired at ${inner.expiresAt} (now ${at})` };
    return { ok: true };
  }
}

function mintReceipt(inner: ReceiptInner): ActionReceipt {
  const receipt = new ActionReceipt();
  RECEIPTS.set(receipt, inner);
  return receipt;
}

/** Consume-side accessor for reserve() (and P8 tests). Returns the inner
 *  ONLY if the handle was minted by check() in this process. */
function receiptInner(receipt: ActionReceipt): ReceiptInner {
  if (!(receipt instanceof ActionReceipt)) throw new BudgetLedgerError("bad-input", "reserve: receipt must be an ActionReceipt from check()");
  const inner = RECEIPTS.get(receipt);
  if (!inner) throw new BudgetLedgerError("bad-input", "reserve: receipt was not minted by check() (forged or foreign handle)");
  return inner;
}

// ───────────────────────────── the ledger (durability) ──────────────────────

const idShape = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** §13.1 duplicate-key refusal (P4 pattern): JSON.parse is last-wins, so
 *  a line repeating a key is refused as ambiguous, never folded. The
 *  scanner tracks container context (object vs array) and registers ONLY
 *  strings in key position (`{` or `,` then a later `:`) — string values
 *  never count as keys. Deterministic, pure; an unterminated string
 *  returns what was found so far (JSON.parse decides torn lines).
 */
function duplicateKeyIn(line: string): string | undefined {
  let found: string | undefined;
  const stack: { kind: "o" | "a"; keys?: Set<string> }[] = [];
  let lastSig = "";
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    if (ch === "{") { stack.push({ kind: "o", keys: new Set() }); lastSig = ch; i++; continue; }
    if (ch === "[") { stack.push({ kind: "a" }); lastSig = ch; i++; continue; }
    if (ch === "}" || ch === "]") { stack.pop(); lastSig = ch; i++; continue; }
    if (ch === ":" || ch === ",") { lastSig = ch; i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      let str = "";
      let esc = false;
      let closed = false;
      for (; j < n; j++) {
        const c = line[j]!;
        if (esc) { str += c; esc = false; continue; }
        if (c === "\\") { str += "\\"; esc = true; continue; }
        if (c === '"') { closed = true; break; }
        str += c;
      }
      if (!closed) return found; // unterminated string: torn line, JSON.parse refuses
      const top = stack[stack.length - 1];
      if (top !== undefined && top.kind === "o" && top.keys !== undefined && (lastSig === "{" || lastSig === ",")) {
        if (top.keys.has(str)) found ??= str;
        else top.keys.add(str);
      }
      lastSig = '"';
      i = j + 1;
      continue;
    }
    // number / true / false / null: skip to the next delimiter
    let j = i;
    while (j < n && !/[\s,}\]:"]/.test(line[j]!)) j++;
    lastSig = "v";
    i = j;
  }
  return found;
}

/**
 * Append-only per-episode budget ledger (events/budget.jsonl).
 * Durability per docs/11 §13.1 (P4 DecisionJournal pattern):
 *  - append fsyncs before resolving; I/O failure poisons the instance.
 *  - open() reads (fail closed mid-file corruption; report duplicate ids)
 *    then repairs the tail (truncate unparseable / terminate complete).
 *  - all appends serialize on one queue; ts is ledger-assigned.
 */
export class BudgetLedger {
  private pending: Promise<void> = Promise.resolve();
  private poisoned = false;
  private repaired = false;
  private readonly seenIds = new Set<string>();
  private readonly seenLineIds = new Set<string>();

  private constructor(readonly path: string) {}

  /** True when the last open() actually repaired the tail. */
  get tornTailRepaired(): boolean {
    return this.repaired;
  }

  static async open(path: string): Promise<BudgetLedger> {
    const ledger = new BudgetLedger(path);
    const { records } = await ledger.read();
    for (const record of records) {
      ledger.seenIds.add(record.id);
      if (record.kind === "spend") ledger.seenLineIds.add(record.lineId);
    }
    ledger.repaired = await ledger.repairTail();
    return ledger;
  }

  /** Create (or open) the ledger inside an episode's events/ dir (S4). */
  static async forEpisode(episodePath: string): Promise<BudgetLedger> {
    const dir = `${episodePath}/events`;
    await mkdir(dir, { recursive: true });
    return BudgetLedger.open(`${dir}/budget.jsonl`);
  }

  /** Read the whole file, validating every line. Throws on mid-file
   *  corruption (a torn tail is tolerated for open(); see repairTail).
   *  duplicateIds are reported, not merged. */
  async read(): Promise<{ records: LedgerRecord[]; duplicateIds: string[] }> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { records: [], duplicateIds: [] };
      throw e;
    }
    const records: LedgerRecord[] = [];
    const duplicateIds: string[] = [];
    const seen = new Set<string>();
    const lines = raw.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") {
        if (i === lines.length - 1) continue; // whitespace-only torn tail (repair will cut it)
        throw new BudgetLedgerError("corrupt", `budget.jsonl: blank line ${i + 1} (records are exactly one JSON object per line)`);
      }
      const duplicated = duplicateKeyIn(line);
      if (duplicated !== undefined) {
        if (i === lines.length - 1) continue; // ambiguous unterminated tail: repair drops it
        throw new BudgetLedgerError("corrupt", `budget.jsonl: line ${i + 1} repeats key ${JSON.stringify(duplicated)} (refusing an ambiguous record)`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (i === lines.length - 1) continue; // torn tail — tolerated, repaired on open
        throw new BudgetLedgerError("corrupt", `budget.jsonl: corrupt line ${i + 1} (mid-file corruption)`);
      }
      try {
        validateLedgerRecord(parsed);
      } catch (e) {
        if (i === lines.length - 1) continue; // torn tail tolerated
        throw e instanceof BudgetLedgerError ? new BudgetLedgerError("corrupt", `budget.jsonl: invalid line ${i + 1}: ${(e as Error).message}`) : e;
      }
      const record = parsed as LedgerRecord;
      if (seen.has(record.id)) {
        if (!duplicateIds.includes(record.id)) duplicateIds.push(record.id);
      } else {
        seen.add(record.id);
      }
      records.push(record);
    }
    return { records, duplicateIds };
  }

  /** §13.1 tail repair, ledger edition (idempotent). Mirrors the P4
   *  decision-journal semantics:
   *   - unterminated parseable+valid tail      → terminate (KEEP the record:
   *     a fsynced append that lost only its newline is not lost money);
   *   - unparseable / schema-invalid / ambiguous duplicate-key tail → cut;
   *   - terminated file → untouched. */
  async repairTail(): Promise<boolean> {
    let st;
    try {
      st = await stat(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
    if (st.size === 0) return false;
    const buf = await readFile(this.path);
    if (buf[buf.length - 1] === 0x0a) return false; // terminated — clean
    const lastNL = buf.lastIndexOf(0x0a);
    const tail = buf.subarray(lastNL + 1).toString("utf8");
    if (tail.trim() === "") {
      await truncate(this.path, lastNL + 1);
      return true;
    }
    if (duplicateKeyIn(tail) !== undefined) {
      // Ambiguous record (P4 lesson): cut it rather than terminate into history.
      await truncate(this.path, lastNL + 1);
      return true;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(tail);
    } catch {
      await truncate(this.path, lastNL + 1);
      return true;
    }
    try {
      validateLedgerRecord(parsed);
    } catch {
      await truncate(this.path, lastNL + 1);
      return true;
    }
    await appendFile(this.path, "\n");
    return true;
  }

  /** Serialize one exclusive critical section on the append queue: runs
   *  only after every earlier append/reserve settled, poisons on failure.
   *  All queue users (append, reserve, closeReservation) go through here
   *  so nothing can nest an enqueue inside an enqueued section. */
  private enqueue<T>(section: () => Promise<T>): Promise<T> {
    const operation = this.pending.then(async () => {
      if (this.poisoned) throw new BudgetLedgerError("poisoned", "ledger operation failed earlier; reopen before appending");
      return section();
    });
    this.pending = operation.then(() => {}, () => {});
    return operation;
  }

  /** Serialized append: validate, assign ts (always ledger-assigned),
   *  refuse duplicate ids in-instance. Resolves ONLY after fsync — A5
   *  (the trail exists before the caller proceeds to act).
   *  `exclusiveLineId`: the A8 once-only check for this line id runs
   *  INSIDE the queue (checking at call time races a concurrent ingest);
   *  on success the line id is marked here, so callers never touch
   *  `seenLineIds` themselves. */
  private async append(record: LedgerRecord, clock: Clock, exclusiveLineId?: string): Promise<void> {
    const stamped: LedgerRecord = { ...record, ts: clock() };
    let line: string;
    try {
      line = JSON.stringify(stamped);
    } catch (e) {
      throw new BudgetLedgerError("bad-input", `cannot serialize record (${(e as Error).message})`);
    }
    if (line.includes("\n")) throw new BudgetLedgerError("bad-input", "record serializes across multiple lines");
    validateLedgerRecord(JSON.parse(line) as LedgerRecord);
    return this.enqueue(async () => {
      if (exclusiveLineId !== undefined && this.seenLineIds.has(exclusiveLineId)) {
        throw new BudgetLedgerError("dup-line", `spend lineId ${exclusiveLineId} already on the ledger (A8)`);
      }
      if (this.seenIds.has(stamped.id)) throw new BudgetLedgerError("dup-id", `record id ${stamped.id} already appended in this instance (ledger ids are once-only)`);
      try {
        const handle = await fsOpen(this.path, "a", 0o644);
        try {
          await handle.appendFile(line + "\n", "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (e) {
        this.poisoned = true;
        throw e;
      }
      this.seenIds.add(stamped.id);
      if (exclusiveLineId !== undefined) this.seenLineIds.add(exclusiveLineId);
    });
  }

  /** Raw write INSIDE an already-serialized section (reserve/close use
   *  this from within their enqueue — never call outside one). */
  private async appendInside(stamped: LedgerRecord): Promise<void> {
    let line: string;
    try {
      line = JSON.stringify(stamped);
    } catch (e) {
      throw new BudgetLedgerError("bad-input", `cannot serialize record (${(e as Error).message})`);
    }
    if (line.includes("\n")) throw new BudgetLedgerError("bad-input", "record serializes across multiple lines");
    validateLedgerRecord(JSON.parse(line) as LedgerRecord);
    if (this.seenIds.has(stamped.id)) throw new BudgetLedgerError("dup-id", `record id ${stamped.id} already appended in this instance (ledger ids are once-only)`);
    try {
      const handle = await fsOpen(this.path, "a", 0o644);
      try {
        await handle.appendFile(line + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (e) {
      this.poisoned = true;
      throw e;
    }
    this.seenIds.add(stamped.id);
  }

  /** The durable records, fresh from disk, folded at `now` (re-reads —
   *  snapshots must reflect reality, R6 refresh-first). */
  async snapshotAt(now: number): Promise<BudgetSnapshot> {
    const { records } = await this.read();
    return projectLedger(records, now);
  }

  // ── spend (A9: priced at ingest, or the ingest refuses) ────────────────

  /** One session message shaped for ingest (structural — mirrors the
   *  session MessageEntry without importing P1/P5). */
  static readonly USAGE_ROLES: readonly string[] = ["assistant"];

  /** Ingest session entries (whatever shape — only assistant messages
   *  with a usage block are ledgered; everything else is skipped).
   *  Idempotent by entry id (A8): re-ingesting a session never double-
   *  counts. Returns the records actually appended. */
  async ingestEntries(
    entries: readonly { id: string; message: { role: string; model?: string; provider?: string; usage?: UsageIn; timestamp?: number } }[],
    scope: { episodeId: string; taskId?: string; attemptId?: string },
    options: { rates?: readonly RateEntry[]; clock?: Clock } = {},
  ): Promise<SpendRecord[]> {
    assertSafeId(scope.episodeId, "episodeId");
    if (scope.taskId !== undefined) assertSafeId(scope.taskId, "taskId");
    if (scope.attemptId !== undefined) assertSafeId(scope.attemptId, "attemptId");
    const clock = options.clock ?? Date.now;
    const appended: SpendRecord[] = [];
    for (const entry of entries) {
      assertSafeId(entry.id, "entry id");
      const message = entry.message;
      if (!message || message.role !== "assistant" || !message.usage) continue;
      // A8: dedup BEFORE building the record (cheap, and re-ingest stays
      // a true no-op even across poisoned/reopened states).
      if (this.seenLineIds.has(entry.id)) continue;
      const model = message.model ?? "";
      const provider = message.provider ?? "";
      if (!model || !provider) {
        throw new BudgetLedgerError("bad-input", `spend entry ${entry.id}: assistant message missing model/provider (A9 — an unpriced path is refused)`);
      }
      const { rate, priced } = resolveRateSource(model, provider, options.rates);
      const record: SpendRecord = {
        schema: LEDGER_SCHEMA_ID,
        id: `b-${randomUUID()}`,
        ts: 0, // stamped in append
        episodeId: scope.episodeId,
        ...(scope.taskId !== undefined ? { taskId: scope.taskId } : {}),
        ...(scope.attemptId !== undefined ? { attemptId: scope.attemptId } : {}),
        kind: "spend",
        lineId: entry.id,
        model,
        provider,
        usage: {
          input: assertInt(message.usage.input, "usage.input"),
          output: assertInt(message.usage.output, "usage.output"),
          ...(message.usage.cacheRead !== undefined ? { cacheRead: assertInt(message.usage.cacheRead, "usage.cacheRead") } : {}),
          ...(message.usage.cacheWrite !== undefined ? { cacheWrite: assertInt(message.usage.cacheWrite, "usage.cacheWrite") } : {}),
        },
        rates: { ...rate },
        costUsd: computeCostUsd(message.usage, rate),
        priced,
        source: "session",
      };
      try {
        await this.append(record, clock, entry.id);
      } catch (e) {
        // A8: raced by a concurrent ingest of the same entry id — skip.
        if (e instanceof BudgetLedgerError && e.code === "dup-line") continue;
        throw e;
      }
      appended.push(record);
    }
    return appended;
  }

  /** Read a session .jsonl and ingest its assistant-usage entries (the
   *  supervisor's ingest path). Tolerates the full entry zoo (header,
   *  modelChange, …) — they are skipped, not errors. */
  async ingestSession(
    sessionPath: string,
    scope: { episodeId: string; taskId?: string; attemptId?: string },
    options: { rates?: readonly RateEntry[]; clock?: Clock } = {},
  ): Promise<SpendRecord[]> {
    const raw = await readFile(sessionPath, "utf8");
    const entries: { id: string; message: { role: string; model?: string; provider?: string; usage?: UsageIn } }[] = [];
    const lines = raw.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === "") continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new BudgetLedgerError("corrupt", `session ${sessionPath}: corrupt line ${i + 1} (cannot ingest a torn session file — repair it first)`);
      }
      if (parsed.type === "message" && typeof parsed.id === "string" && parsed.message && typeof parsed.message === "object") {
        entries.push({ id: parsed.id, message: parsed.message as { role: string; model?: string; provider?: string; usage?: UsageIn } });
      }
    }
    return this.ingestEntries(entries, scope, options);
  }

  /** Manual spend (external side effects — API fees, credits). Goes
   *  through the same pricing (manual records carry their own frozen
   *  rates — caller supplies; gate policy rates apply when absent). */
  async recordManualSpend(
    spend: { lineId: string; model: string; provider: string; usage: UsageIn; rates?: Rate; note?: string },
    scope: { episodeId: string; taskId?: string; attemptId?: string },
    options: { rates?: readonly RateEntry[]; clock?: Clock } = {},
  ): Promise<SpendRecord> {
    assertSafeId(spend.lineId, "spend.lineId");
    if (this.seenLineIds.has(spend.lineId)) throw new BudgetLedgerError("dup-line", `spend lineId ${spend.lineId} already on the ledger (A8)`);
    const src = spend.rates !== undefined ? { rate: spend.rates, priced: "override" as SpendPriced } : resolveRateSource(spend.model, spend.provider, options.rates);
    const rate = src.rate;
    const clock = options.clock ?? Date.now;
    const record: SpendRecord = {
      schema: LEDGER_SCHEMA_ID,
      id: `b-${randomUUID()}`,
      ts: 0,
      episodeId: assertSafeId(scope.episodeId, "episodeId"),
      ...(scope.taskId !== undefined ? { taskId: scope.taskId } : {}),
      ...(scope.attemptId !== undefined ? { attemptId: scope.attemptId } : {}),
      kind: "spend",
      lineId: spend.lineId,
      model: assertSafeId(spend.model, "spend.model"),
      provider: assertSafeId(spend.provider, "spend.provider"),
      usage: {
        input: assertInt(spend.usage.input, "usage.input"),
        output: assertInt(spend.usage.output, "usage.output"),
        ...(spend.usage.cacheRead !== undefined ? { cacheRead: assertInt(spend.usage.cacheRead, "usage.cacheRead") } : {}),
        ...(spend.usage.cacheWrite !== undefined ? { cacheWrite: assertInt(spend.usage.cacheWrite, "usage.cacheWrite") } : {}),
      },
      rates: { ...rate },
      costUsd: computeCostUsd(spend.usage, rate),
      priced: src.priced,
      source: "manual",
      ...(spend.note !== undefined ? { note: String(spend.note) } : {}),
    };
    await this.append(record, clock);
    this.seenLineIds.add(spend.lineId);
    return record;
  }

  // ── reservations (A4: the ONLY reservation path) ───────────────────────

  /**
   * Reserve capacity against a check() receipt. Refresh-first (R6/R7):
   * inside the serialized append queue the ledger is RE-READ, the gate
   * RE-RUNS against live state, and the reservation is appended only if
   * the refreshed check still passes. The receipt must match the request
   * it was minted for (digest-bound spec) and not be expired.
   *
   * There is no other way to get a reservation onto this ledger (A4).
   */
  async reserve(
    policy: GatePolicy,
    request: GateRequest,
    receipt: ActionReceipt,
    options: { clock?: Clock } = {},
  ): Promise<ReservationOpenRecord> {
    const clock = options.clock ?? Date.now;
    // Consume-side checks that don't depend on ledger state (fail before
    // any I/O — a forged handle never touches the disk path).
    const inner = receiptInner(receipt);
    const now = clock();
    const specOk = await Promise.resolve(receipt.verify(
      { action: request.action, actionId: request.actionId, episodeId: policy.episodeId, taskId: request.taskId },
      now,
    ));
    if (!specOk.ok) throw new BudgetLedgerError("receipt-invalid", `reserve: ${specOk.reason}`);
    if (inner.grantedBy !== request.authority.grantedBy || inner.sideEffect !== request.authority.sideEffect) {
      throw new BudgetLedgerError("receipt-invalid", "reserve: authority differs from the grant the receipt was minted for");
    }
    // D2 identity: the request must match the spec the check was passed
    // for. The effective reservation may have been RAISED further by the
    // caller-side fold, so equality to the original request is not
    // required — the digest that was BOUND at check time is recomputed
    // from the presented reservation and must match exactly.
    return this.enqueue(async (): Promise<ReservationOpenRecord> => {
      // ── refresh-first (the queue-serialized recheck) ──
      const fresh = await this.snapshotAt(clock());
      const refreshed = check(policy, request, fresh, clock());
      if (!refreshed.allowed) {
        throw new BudgetLedgerError("denied", `reserve: refreshed gate denied — ${refreshed.denials.map((d) => `${d.code}: ${d.detail}`).join("; ")}`);
      }
      if (!refreshed.receipt) throw new BudgetLedgerError("impossible", "refreshed check allowed without minting a receipt");
      // The refreshed spec must digest-match the presented receipt: same
      // action AND same effective reservation (a second caller raising
      // the estimate in the interim = a different spec = rejection).
      const presentedDigest = canonicalActionSpec(policy, request, { usd: inner.reserveUsd, turns: inner.reserveTurns });
      const presentedHash = createHash("sha256").update(presentedDigest, "utf8").digest("hex");
      if (presentedHash !== inner.digest) {
        throw new BudgetLedgerError("receipt-mismatch", "reserve: action spec does not match the receipt's digest (check(X)-then-act(Y) refused)");
      }
      const record: ReservationOpenRecord = {
        schema: LEDGER_SCHEMA_ID,
        id: `b-${randomUUID()}`,
        ts: 0,
        episodeId: policy.episodeId,
        ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
        ...(request.attemptId !== undefined ? { attemptId: request.attemptId } : {}),
        kind: "res-open",
        actionId: request.actionId,
        action: request.action,
        reservedUsd: inner.reserveUsd,
        reservedTurns: inner.reserveTurns,
        expiresAt: inner.expiresAt,
        grantedBy: inner.grantedBy,
        sideEffect: inner.sideEffect,
        receiptDigest: inner.digest,
        estimateRaised: refreshed.estimateRaised,
      };
      await this.appendInside(record);
      return record;
    });
  }

  /** Close an open reservation (A2). Refuses to close a closed or unknown
   *  reservation — double-close would release the same hold twice. */
  async closeReservation(
    refId: string,
    reason: ReservationCloseReason,
    options: { clock?: Clock } = {},
  ): Promise<ReservationCloseRecord> {
    assertSafeId(refId, "refId");
    if (!(RESERVATION_CLOSE_REASONS as readonly string[]).includes(reason)) {
      throw new BudgetLedgerError("bad-input", `close reason must be one of ${RESERVATION_CLOSE_REASONS.join("|")}`);
    }
    const clock = options.clock ?? Date.now;
    return this.enqueue(async (): Promise<ReservationCloseRecord> => {
      const fresh = await this.snapshotAt(clock());
      const open = fresh.openReservations.find((r) => r.id === refId);
      if (!open) {
        throw new BudgetLedgerError("bad-ref", `no open reservation ${refId} (already closed, expired, or never existed)`);
      }
      const record: ReservationCloseRecord = {
        schema: LEDGER_SCHEMA_ID,
        id: `b-${randomUUID()}`,
        ts: 0,
        episodeId: open.episodeId,
        kind: "res-close",
        refId,
        reason,
      };
      await this.appendInside(record);
      return record;
    });
  }

  private async reservationEpisode(refId: string, fresh: BudgetSnapshot): Promise<string | undefined> {
    return fresh.openReservations.find((r) => r.id === refId)?.episodeId;
  }

  /** Append an attempt-wallclock window (supervisor, at attempt end). */
  async recordWallclock(
    scope: { episodeId: string; taskId: string; attemptId?: string },
    seconds: number,
    options: { clock?: Clock } = {},
  ): Promise<WallclockRecord> {
    if (!Number.isFinite(seconds) || seconds < 0) throw new BudgetLedgerError("bad-input", "wallclock seconds must be finite and non-negative");
    const record: WallclockRecord = {
      schema: LEDGER_SCHEMA_ID,
      id: `b-${randomUUID()}`,
      ts: 0,
      episodeId: assertSafeId(scope.episodeId, "episodeId"),
      taskId: assertSafeId(scope.taskId, "taskId"),
      ...(scope.attemptId !== undefined ? { attemptId: scope.attemptId } : {}),
      kind: "wallclock",
      seconds,
    };
    await this.append(record, options.clock ?? Date.now);
    return record;
  }
}
