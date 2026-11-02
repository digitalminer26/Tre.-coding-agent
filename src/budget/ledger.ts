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
 *  D2 reservations: P8 owns per-action-class defaults (RESERVE_DEFAULTS,
 *     exported). The caller may only RAISE an estimate above the class
 *     default, never lower it; every applied raise is recorded durably on
 *     the reservation (estimateRaised). A policy cap BELOW the class
 *     default is a DENIAL (reserve-default-exceeds-cap) — never a silent
 *     redefinition of the estimate.
 *  D3 capability receipt: opaque handle, WeakMap-backed, digest-bound to
 *     the canonical request snapshot (every checked authority + budget
 *     field), expiry-enforced at mint, at verify, and AGAIN inside the
 *     serialized admission queue before append. Scope: run/resume only.
 *
 * Invariants (docs/12 §4 — the pinned meanings; each has named tests):
 *  A1 budgets span attempts/restarts: durable totals rebuild from the log;
 *     attempt-start anchors + recorded windows + live elapsed count a
 *     dead supervisor toward the attempt it spans (no free time).
 *  A2 reservation honesty: a durable intent keeps charging until an
 *     evidence-backed terminal close — receipt/hold expiry NEVER evaporates
 *     an open reservation (it only blocks NEW admission); a release
 *     happens exactly once; actionId is unique per ledger with defined
 *     idempotent redelivery (identical spec = no-op success, different
 *     spec = refused).
 *  A3 absence ≠ permission: the full EpisodeAuthority denial surface
 *     (paths/notPaths globs canonicalized against a trusted root incl.
 *     `..`-traversal and absolute escapes, installs, network, external
 *     effects, approved models, per-diagnosis maxToolCalls/maxUsd);
 *     default closed when the authority object is absent. Checked fields
 *     are bound into the receipt digest and onto the durable record.
 *  A4 gate bypass structurally impossible: the only reservation path takes
 *     a minted receipt and re-runs the gate inside the serialized queue.
 *  A5 I5: no P8 path closes an open action; an open (even expired) action
 *     stays on the reconcile list until an evidence-backed terminal close.
 *  A6 unknown cost is NEVER zero: an unpriced model records the NONNUMERIC
 *     state priced:"unknown" (no costUsd field) and blocks USD admission
 *     wherever a USD cap exists; turn/time gates still bite.
 *  A7 projection determinism (same records + same now → identical fold).
 *  A8 counted exactly once: spend lineIds dedup INSIDE the queue; run
 *     attempt slots count every durable reservation (open OR settled);
 *     only a justified 'released' (failed-spawn) close refunds a slot.
 *  A9 strategy-repeat limit: the Nth same-strategyId reservation denies
 *     with a typed reason (policy.maxStrategyRepeats).
 *
 * Compartment discipline: node: builtins only — no repo imports (P5
 * pattern). The runner (P7) and the supervisor (P9) receive the receipt
 * as an opaque value typed against a structural interface at their own
 * boundary; nothing under src/ imports this module until P9.
 */
import { appendFile, mkdir, open as fsOpen, readFile, stat, truncate } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, posix } from "node:path/posix";

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
 *  only the named cloud models. A model that matches NO entry is
 *  priced:"unknown" — the NONNUMERIC cost state of A6, never a $0 rate
 *  dressed up as a price (the removed FALLBACK_RATE was the audit bug). */
export const DEFAULT_RATES: readonly RateEntry[] = Object.freeze([
  { model: "gpt-4o", rate: { input: 2.5, output: 10 } },
  { model: "gpt-4o-mini", rate: { input: 0.15, output: 0.6 } },
  { model: "claude-sonnet*", rate: { input: 3, output: 15 } },
  { model: "claude-*", rate: { input: 3, output: 15 } },
  { provider: "openrouter", rate: { input: 1, output: 4 } },
]);

/** Applied when no entry matches. RETAINED ONLY as an explicit, opt-in
 *  operator choice: passing it as a rate override is a deliberate decision
 *  to price something at zero. The resolver NEVER applies it implicitly —
 *  an unmatched model is priced:"unknown" (A6: unknown ≠ zero). */
export const FALLBACK_RATE: Rate = Object.freeze({ input: 0, output: 0 });

/** Match one table (exact model > model prefix > exact provider). Pure.
 *  Prefix ties resolve by TABLE ORDER (first matching prefix wins) —
 *  specificity is order, pinned by test (a broad `foo*` before
 *  `foo-special*` selects the broad rate: order is the contract). */
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

/** Resolve the rate AND its provenance (A6/A9 — the priced marker is
 *  derived, never hand-claimed): override > table > unknown. `overrides`
 *  (episode policy, D1) are consulted BEFORE the built-in table. When
 *  NOTHING matches there is NO rate: the caller must record the NONNUMERIC
 *  `priced:"unknown"` state (never a numeric fallback — the audit's
 *  "unknown charged as zero" bug). Pure. */
export function resolveRateSource(model: string, provider: string, overrides?: readonly RateEntry[]): { rate?: Rate; priced: SpendPriced } {
  if (overrides) {
    const r = matchTable(overrides, model, provider);
    if (r !== undefined) return { rate: r, priced: "override" };
  }
  const t = matchTable(DEFAULT_RATES, model, provider);
  if (t !== undefined) return { rate: t, priced: "table" };
  return { priced: "unknown" };
}

/** Resolve the rate for (model, provider); `undefined` when unpriced
 *  (A6 — the absence is meaningful and must be handled, never coerced
 *  to a number). `overrides` (episode policy, D1) are consulted BEFORE
 *  the built-in table. Pure. */
export function resolveRate(model: string, provider: string, overrides?: readonly RateEntry[]): Rate | undefined {
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

/** A6/A9 pricing provenance on every spend record. `"unknown"` is the
 *  NONNUMERIC cost state — such a record carries NO costUsd/rates field
 *  and blocks USD admission wherever a USD cap exists (unknown ≠ zero,
 *  unknown ≠ free). An operator who truly means "this model is free"
 *  declares it with an explicit zero-rate entry in the policy override
 *  table (provenance "override") — never inferred from a missing price. */
export type SpendPriced = "table" | "override" | "unknown";

export interface SpendRecord extends LedgerEnvelope {
  kind: "spend";
  /** Dedup key (§2): the session entry id the usage came from. Manual
   *  spends use their own lineId. Re-ingesting the same entry id is a
   *  silent no-op (A8 — guarded INSIDE the serialized queue). */
  lineId: string;
  model: string;
  provider: string;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** Frozen at ingest (D1): never recomputed, history never reprices.
   *  Absent exactly when priced === "unknown" (no rate exists to freeze). */
  rates?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** Absent exactly when priced === "unknown" (A6: the unknown cost is
   *  the ABSENCE of a number, never the number zero). */
  costUsd?: number;
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
  /** Epoch ms after which the RECEIPT stops admitting NEW work. It never
   *  removes the durable hold (A2): an expired-but-open reservation keeps
   *  charging and stays on the reconcile list until an evidence-backed
   *  terminal close. */
  expiresAt: number;
  // ── A3 durable authority trail (P9 copies these onto decision-intent) ──
  grantedBy: string;
  sideEffect: "none" | "worktree-local" | "external";
  /** sha256 hex over the canonical request snapshot the check was passed for. */
  receiptDigest: string;
  /** D2: was the caller's estimate raised to (or defaulted from) the
   *  P8-owned class default? Always present so the raise is auditable. */
  estimateRaised: boolean;
  /** §14.3 strategyId (A9 repeat counts). */
  strategyId?: string;
  // ── A3: the checked authority surface, durable (mutation-proof audit) ──
  /** Canonicalized paths the action was granted to touch. */
  paths?: string[];
  install?: boolean;
  network?: boolean;
  model?: string;
  /** Diagnostic tool calls the action was granted. */
  toolCalls?: number;
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
      if (r.priced !== "table" && r.priced !== "override" && r.priced !== "unknown") throw new BudgetLedgerError("schema", "spend: priced marker invalid");
      if (r.priced === "unknown") {
        // A6: unknown is the ABSENCE of a number — a record claiming
        // unknown while carrying a cost/rates is a contract lie.
        if (r.costUsd !== undefined || r.rates !== undefined) throw new BudgetLedgerError("schema", "spend: priced 'unknown' must carry no costUsd/rates (A6)");
      } else {
        if (!isRate(r.rates)) throw new BudgetLedgerError("schema", "spend: frozen rates invalid");
        if (!isNum(r.costUsd) || (r.costUsd as number) < 0) throw new BudgetLedgerError("schema", "spend: costUsd invalid");
      }
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
      if (r.strategyId !== undefined && !isNonEmptyString(r.strategyId)) throw new BudgetLedgerError("schema", "res-open: strategyId invalid");
      if (r.paths !== undefined && (!Array.isArray(r.paths) || r.paths.some((p) => !isNonEmptyString(p) || !p.startsWith("/"))))
        throw new BudgetLedgerError("schema", "res-open: paths must be an array of canonical absolute strings (A3)");
      if (r.install !== undefined && typeof r.install !== "boolean") throw new BudgetLedgerError("schema", "res-open: install must be a boolean");
      if (r.network !== undefined && typeof r.network !== "boolean") throw new BudgetLedgerError("schema", "res-open: network must be a boolean");
      if (r.model !== undefined && !isNonEmptyString(r.model)) throw new BudgetLedgerError("schema", "res-open: model invalid");
      if (r.toolCalls !== undefined && !isInt0(r.toolCalls)) throw new BudgetLedgerError("schema", "res-open: toolCalls invalid");
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
  /** A6: folded count of priced:"unknown" spend records in this
   *  compartment. Nonzero + a USD cap = USD admission denied (unknown
   *  never grants USD headroom — conservative, not free). */
  unknownSpend: number;
  /** Assistant messages (one per spend record), the turn counter. */
  consumedTurns: number;
  /** Sum of OPEN reservation holds (episode AND task AND attempt chain).
   *  Expiry NEVER removes a hold (A2): only an evidence-backed res-close
   *  does. */
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
  /** Open reservations — every unclosed hold, expired or not (A2: an
   *  open reservation never evaporates; expiry only blocks NEW admission). */
  openReservations: ReservationOpenRecord[];
  /** Every actionId ever reserved → its durable record (first wins).
   *  The uniqueness / idempotent-redelivery source for reserve(). */
  actionIds: Map<string, ReservationOpenRecord>;
  /** Same-strategyId reservation counts per (episode, task, strategyId)
   *  (A9 repeat limits). */
  strategyUses: Map<string, number>;
  /** Attempts EVER named by a res-open record (compartment key), regardless
   *  of expiry/close — the durable "run reserved this attempt first"
   *  trail the resume trap reads (A6). */
  reservedAttempts: Set<string>;
  /** Spend line ids already on the ledger (ingest dedup, A8). */
  seenLineIds: Set<string>;
  /** Spend records in the NONNUMERIC unknown cost state (A6 visibility:
   *  never silently free — USD admission is conservative around these). */
  unpricedCount: number;
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
  const runOpens = new Map<string, ReservationOpenRecord>(); // durable run reservations
  const closedRefs = new Set<string>(); // first-close-wins (never double-refund)
  const reasonIsReleasedRef = new Map<string, string>(); // refId → first close reason
  const actionIds = new Map<string, ReservationOpenRecord>(); // A2 uniqueness source
  const strategyUses = new Map<string, number>(); // A9 repeat counts
  const reservedAttempts = new Set<string>(); // every attempt ever reserved (A6 trail)
  const seenLineIds = new Set<string>();
  const duplicateIds: string[] = [];
  const ids = new Set<string>();
  let unpricedCount = 0;

  const touch = (c: Compartment): CompartmentUsage => {
    const key = compartmentKey(c);
    let usage = compartments.get(key);
    if (!usage) {
      usage = { consumedUsd: 0, unknownSpend: 0, consumedTurns: 0, reservedUsd: 0, reservedTurns: 0 };
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
        const unknownCost = record.priced === "unknown"; // A6: no number exists
        if (unknownCost) unpricedCount++;
        for (const c of chainOf({ episodeId: record.episodeId, taskId: record.taskId, attemptId: record.attemptId })) {
          const usage = touch(c);
          if (!unknownCost) usage.consumedUsd += record.costUsd ?? 0;
          if (unknownCost) usage.unknownSpend += 1;
          usage.consumedTurns += 1;
        }
        break;
      }
      case "res-open": {
        // Holds live on the reservation's OWN compartment chain (episode,
        // task AND attempt — the reservation trail names its task).
        if (record.attemptId !== undefined) {
          reservedAttempts.add(JSON.stringify([record.episodeId, record.taskId ?? null, record.attemptId]));
        }
        // A2 actionId uniqueness source (first record wins; reserve()
        // enforces idempotent redelivery against this inside the queue).
        if (!actionIds.has(record.actionId)) actionIds.set(record.actionId, record);
        // A9: strategy repeat counts over durable reservations.
        if (record.strategyId !== undefined) {
          const sk = JSON.stringify([record.episodeId, record.taskId ?? null, record.strategyId]);
          strategyUses.set(sk, (strategyUses.get(sk) ?? 0) + 1);
        }
        // A8: a DURABLE run reservation consumes an attempt slot whether
        // it is open, settled, or closed-expired — an attempt that was
        // reserved was an attempt used (audit: settled runs must NOT
        // refund the slot; only a justified 'released' refund below).
        if (record.action === "run") {
          const taskKey = JSON.stringify([record.episodeId, record.taskId ?? null]);
          attemptsUsed.set(taskKey, (attemptsUsed.get(taskKey) ?? 0) + 1);
          runOpens.set(record.id, record);
        }
        if (open.has(record.id)) break; // duplicate res-open id: first wins (reported above)
        open.set(record.id, record);
        break;
      }
      case "res-close": {
        if (closedRefs.has(record.refId)) break; // first close wins: never double-refund
        closedRefs.add(record.refId);
        // A8: refund ONLY the justified failed-spawn/release case; the
        // res-open may appear later in the file than its close, so the
        // refund decision is deferred to the post-pass below.
        if (!reasonIsReleasedRef.has(record.refId)) reasonIsReleasedRef.set(record.refId, record.reason);
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
  // A2 (docs/12 §4): an OPEN reservation keeps charging until an
  // evidence-backed terminal close — receipt/hold expiry NEVER evaporates
  // a durable hold (expiry only blocks NEW admission in reserve()).
  // Holds charge the reservation's full compartment chain — episode, task
  // AND attempt (audit: attempt holds must hit the attempt compartment).
  const openReservations: ReservationOpenRecord[] = [];
  for (const reservation of open.values()) {
    openReservations.push(reservation);
    for (const c of chainOf({ episodeId: reservation.episodeId, taskId: reservation.taskId, attemptId: reservation.attemptId })) {
      const usage = touch(c);
      usage.reservedUsd += reservation.reservedUsd;
      usage.reservedTurns += reservation.reservedTurns;
    }
  }

  // A1/F17 (docs/12 §2): supervisor downtime counts toward the attempt it
  // spans. Every OPEN reservation that names an attempt anchors that
  // attempt; elapsed time from the earliest anchor to `now` is live
  // wallclock (a dead supervisor buys no free time). Recorded windows
  // (completed, evidence-backed) sum on top; overlapping open holds on
  // one attempt dedupe to the earliest anchor. Determinism holds: the
  // fold is a pure function of (records, now) — A7.
  const liveStart = new Map<string, number>();
  for (const reservation of open.values()) {
    if (reservation.attemptId === undefined || !(reservation.ts > 0)) continue;
    const key = JSON.stringify([reservation.episodeId, reservation.taskId ?? null, reservation.attemptId]);
    const prev = liveStart.get(key);
    if (prev === undefined || reservation.ts < prev) liveStart.set(key, reservation.ts);
  }
  for (const [key, startedAt] of liveStart) {
    const elapsed = Math.max(0, (now - startedAt) / 1000);
    if (elapsed <= 0) continue;
    const [, taskId] = JSON.parse(key) as [string, string | null, string];
    attemptWallclockS.set(key, (attemptWallclockS.get(key) ?? 0) + elapsed);
    if (taskId !== null) wallclockS.set(taskId, (wallclockS.get(taskId) ?? 0) + elapsed);
  }

  // A8: refund a run slot ONLY for a justified 'released' (failed-spawn)
  // close — settled/expired/abandoned keep the slot consumed (audit:
  // settled runs must never re-open the attempt budget). Deferred here so
  // close-records BEFORE their res-open in the file still refund (first
  // close per refId wins; closedRefs guarantees single refund).
  for (const [refId, run] of runOpens) {
    if (reasonIsReleasedRef.get(refId) !== "released") continue;
    const taskKey = JSON.stringify([run.episodeId, run.taskId ?? null]);
    attemptsUsed.set(taskKey, Math.max(0, (attemptsUsed.get(taskKey) ?? 0) - 1));
  }

  return { now, compartments, attemptsUsed, wallclockS, attemptWallclockS, openReservations, actionIds, strategyUses, reservedAttempts, seenLineIds, unpricedCount, duplicateIds };
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
  /** A9 (docs/12 §9): the Nth same-`strategyId` reservation denies with a
   *  typed reason. Undefined = unlimited (counts stay visible). */
  maxStrategyRepeats?: Cap;
  /** policy.authority.allowExternalEffects — an "external" action denies
   *  unless this is true (the authority half of the gate). */
  allowExternalEffects: boolean;
  /** A3 (docs/12 §1/§4, §14.7 EpisodeAuthority): the granted authority
   *  surface. ABSENT means default-closed on the whole surface — any
   *  request that declares paths / installs / network / a model /
   *  diagnostic tool calls denies. A field that is present but not
   *  granted is denial, never silence. */
  authority?: {
    /** Trusted root that request paths are resolved against (A3: `..`
     *  traversal and absolute escapes are refused against this root). */
    root?: string;
    /** Granted path globs (posix-ish; `**` any-depth, `*` one segment).
     *  Absent/empty = nothing granted. */
    paths?: readonly string[];
    /** Denied globs — win over `paths` even when a broader grant matches. */
    notPaths?: readonly string[];
    /** Package installs granted. Absent = false. */
    allowInstalls?: boolean;
    /** Network access granted. Absent = false. */
    allowNetwork?: boolean;
    /** Approved models for swaps. Absent = NO model is approved. */
    approvedModels?: readonly string[];
    /** Per-diagnosis caps (docs/12 §1). */
    diagnostics?: { maxToolCalls?: number; maxUsd?: number };
  };
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
  /** Caller estimate (D2): may only RAISE above the class default. */
  estimate?: { usd?: number; turns?: number };
  // ── the §14.7 authority surface (A3) — every field binds into the ──────
  // ── receipt digest, so mutation between check and reserve refuses ──────
  /** File paths the action will touch (canonicalized against authority.root). */
  paths?: string[];
  /** Action performs package installs. */
  install?: boolean;
  /** Action performs network access. */
  network?: boolean;
  /** Model the action will use (for swaps). */
  model?: string;
  /** Tool calls a diagnostic action will make (vs diagnostics.maxToolCalls). */
  toolCalls?: number;
  /** §14.3 strategyId — repeat counts feed A9. */
  strategyId?: string;
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
  | "estimate-invalid"
  // ── A3 authority surface (docs/12 §1/§4) ──
  | "path-not-granted"            // request path outside granted globs / inside notPaths / escapes root
  | "install-not-allowed"
  | "network-not-allowed"
  | "model-not-approved"
  | "diagnostic-limit-exceeded"   // toolCalls over authority.diagnostics.maxToolCalls
  // ── A9 strategy repeats (§9) ──
  | "strategy-repeat-exceeded"
  // ── D2: cap BELOW the P8 class default is a denial, never a silent redefinition ──
  | "reserve-default-exceeds-cap";

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

/** D2 (docs/12 §7, settled decision 2): the P8-owned per-action-class
 *  reservation defaults. The caller may only RAISE an estimate above the
 *  class default, never lower it below it; a policy cap BELOW the class
 *  default is a DENIAL (reserve-default-exceeds-cap), never a silent
 *  redefinition. Exported: the raise semantics are module contract. */
export const RESERVE_DEFAULTS: Readonly<Partial<Record<LedgerGatedAction, { usd: number; turns: number }>>> = Object.freeze({
  run: Object.freeze({ usd: 0.25, turns: 1 }),
  resume: Object.freeze({ usd: 0.05, turns: 1 }),
});

/** The class default floor for an action. Pure. */
export function reserveDefault(action: LedgerGatedAction): { usd: number; turns: number } {
  const d = RESERVE_DEFAULTS[action];
  return d ? { usd: d.usd, turns: d.turns } : { usd: 0, turns: 1 };
}

/** A3: canonicalize a request path against the trusted root. Relative
 *  paths resolve under the root; absolute paths must stay inside it.
 *  `..` segments are resolved lexically; a path that escapes the root
 *  canonicalizes to `undefined` (denied — a symlink check is the
 *  executor's job at act-time; the gate refuses every textual escape).
 *  Pure, synchronous, no I/O. */
export function canonicalizePath(p: string, root: string): string | undefined {
  if (typeof p !== "string" || p === "" || p.includes("\0")) return undefined;
  const r = posix.normalize(root);
  const joined = posix.isAbsolute(p) ? posix.normalize(p) : posix.normalize(posix.join(r, p));
  if (joined === r) return joined;
  if (!joined.startsWith(r.endsWith("/") ? r : r + "/")) return undefined; // escape
  return joined;
}

/** A3: match a canonical absolute path against a granted/denied glob,
 *  both resolved against the authority root. `**` spans segments,
 *  `*` matches within one segment. Globs may be relative (resolved
 *  under root) or absolute. Pure. */
export function globMatch(glob: string, canonicalPath: string, root: string): boolean {
  const anchored = posix.isAbsolute(glob) ? posix.normalize(glob) : posix.normalize(posix.join(posix.normalize(root), glob));
  const re = new RegExp(
    "^" +
      anchored
        .split("/")
        .map((seg) => seg.replace(/[.+^$${}()|[\]\\]/g, (m) => "\\" + m).replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*"))
        .filter((s, i) => i === 0 || s !== "")
        .join("/") +
      "/?$",
  );
  return re.test(canonicalPath);
}

/** Boundary validation (audit C1-NaN: an invalid cap used to MINT an
 *  allow receipt with a NaN reservation). Rejects non-finite/negative
 *  policy values BEFORE any receipt exists. Throws — a malformed policy
 *  is a caller bug, not a denial. Pure, synchronous. */
export function validateGatePolicy(policy: GatePolicy): GatePolicy {
  assertSafeId(policy.episodeId, "policy.episodeId");
  const num = (v: Cap, what: string) => {
    if (v !== undefined && (!Number.isFinite(v) || (v as number) < 0))
      throw new BudgetLedgerError("bad-input", `policy: ${what} must be finite and non-negative (got ${String(v)})`);
  };
  const int = (v: Cap, what: string) => {
    if (v !== undefined && (!Number.isInteger(v) || (v as number) < 0))
      throw new BudgetLedgerError("bad-input", `policy: ${what} must be a non-negative integer (got ${String(v)})`);
  };
  num(policy.caps?.usd, "caps.usd");
  int(policy.caps?.turns, "caps.turns");
  num(policy.caps?.wallclockS, "caps.wallclockS");
  num(policy.perTask?.usd, "perTask.usd");
  int(policy.perTask?.turns, "perTask.turns");
  int(policy.perTask?.attempts, "perTask.attempts");
  num(policy.perAttempt?.usd, "perAttempt.usd");
  int(policy.perAttempt?.turns, "perAttempt.turns");
  num(policy.perAttempt?.wallclockS, "perAttempt.wallclockS");
  int(policy.maxAttemptsPerTask, "maxAttemptsPerTask");
  int(policy.maxStrategyRepeats, "maxStrategyRepeats");
  const ttl = policy.reservationTtlMs;
  if (ttl !== undefined && (!Number.isFinite(ttl) || (ttl as number) <= 0))
    throw new BudgetLedgerError("bad-input", "policy.reservationTtlMs must be finite > 0");
  if (policy.rates !== undefined) {
    if (!Array.isArray(policy.rates)) throw new BudgetLedgerError("bad-input", "policy.rates must be an array");
    for (const entry of policy.rates) {
      if (entry === null || typeof entry !== "object") throw new BudgetLedgerError("bad-input", "policy.rates entry must be an object");
      if (entry.model === undefined && entry.provider === undefined)
        throw new BudgetLedgerError("bad-input", "policy.rates entry needs model or provider");
      if (!isRate(entry.rate)) throw new BudgetLedgerError("bad-input", "policy.rates entry rate must be finite non-negative numbers");
    }
  }
  const a = policy.authority;
  if (a !== undefined) {
    if (a.root !== undefined && (typeof a.root !== "string" || !isAbsolute(a.root)))
      throw new BudgetLedgerError("bad-input", "policy.authority.root must be an absolute path");
    for (const g of [a.paths, a.notPaths, a.approvedModels] as const) {
      if (g !== undefined && (!Array.isArray(g) || g.some((s) => typeof s !== "string" || s === "")))
        throw new BudgetLedgerError("bad-input", "policy.authority glob/model lists must be arrays of non-empty strings");
    }
    if (a.diagnostics !== undefined) {
      const m = a.diagnostics.maxToolCalls, mu = a.diagnostics.maxUsd;
      if (m !== undefined && (!Number.isFinite(m) || m < 0)) throw new BudgetLedgerError("bad-input", "authority.diagnostics.maxToolCalls must be finite non-negative");
      if (mu !== undefined && (!Number.isFinite(mu) || mu < 0)) throw new BudgetLedgerError("bad-input", "authority.diagnostics.maxUsd must be finite non-negative");
    }
  }
  return policy;
}

/** Canonical string for the digest: the exact spec the receipt binds.
 *  Deterministic (fixed field order, null for absent). Binds EVERY
 *  checked field (A3): paths, install, network, model, toolCalls,
 *  strategyId — mutating any of them between check and reserve changes
 *  the digest and is refused. */
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
    request.paths ?? null,
    request.install ?? null,
    request.network ?? null,
    request.model ?? null,
    request.toolCalls ?? null,
    request.strategyId ?? null,
  ]);
}

/**
 * THE GATE (A1). Pure function of policy + request + snapshot at `now`.
 * Every check — live, refresh-at-reserve, or a test replay — runs the
 * same fold, so the three can never diverge.
 */
export function check(policy: GatePolicy, request: GateRequest, snapshot: BudgetSnapshot, now: number): CheckResult {
  // Boundary validation (audit C1-F18): a malformed policy (NaN caps etc.)
  // throws BEFORE any receipt can be minted — an allow built on garbage
  // input is not a safe allow.
  validateGatePolicy(policy);
  const denials: Denial[] = [];
  const deny = (code: DenialCode, detail: string, extra?: Partial<Denial>) => denials.push({ code, detail, ...extra });

  // ── authority half ──
  const grantedBy = request.authority?.grantedBy;
  if (typeof grantedBy !== "string" || grantedBy.trim() === "") deny("authority-missing", "authority.grantedBy must name the granting surface");
  if (request.authority?.sideEffect === "external" && policy.allowExternalEffects !== true)
    deny("external-not-allowed", "action has sideEffect 'external' but policy.allowExternalEffects is not true");

  // ── D2: effective reservation (P8 class default is the floor; the ──
  // ── caller may only RAISE, and a cap below the floor is a DENIAL) ──
  const classDefault = reserveDefault(request.action);
  const floorUsd = classDefault.usd;
  const floorTurns = classDefault.turns;
  const wantUsd = request.estimate?.usd;
  const wantTurns = request.estimate?.turns;
  if (wantUsd !== undefined && (!isNum(wantUsd) || wantUsd < 0)) deny("estimate-invalid", "estimate.usd must be a finite non-negative number");
  if (wantTurns !== undefined && !isInt0(wantTurns)) deny("estimate-invalid", "estimate.turns must be a non-negative integer");
  const reserveUsd = Math.max(wantUsd !== undefined && isNum(wantUsd) ? wantUsd : 0, floorUsd);
  const reserveTurns = Math.max(wantTurns !== undefined && isInt0(wantTurns) ? wantTurns : 0, floorTurns);
  const estimateRaised = reserveUsd > (wantUsd ?? 0) || reserveTurns > (wantTurns ?? 0);
  const reserve = { usd: reserveUsd, turns: reserveTurns };
  // A cap BELOW the class default cannot be honoured without silently
  // redefining the estimate (the audit's F20 bug): deny, never adapt.
  if (policy.perAttempt?.usd !== undefined && policy.perAttempt.usd < floorUsd)
    deny("reserve-default-exceeds-cap", `perAttempt.usd cap ${policy.perAttempt.usd} is below the ${request.action} class default ${floorUsd} (D2) — raise the cap or the policy drops the action`, { cap: policy.perAttempt.usd });
  if (policy.perAttempt?.turns !== undefined && policy.perAttempt.turns < floorTurns)
    deny("reserve-default-exceeds-cap", `perAttempt.turns cap ${policy.perAttempt.turns} is below the ${request.action} class default ${floorTurns} (D2)`, { cap: policy.perAttempt.turns });
  if (policy.caps.usd !== undefined && policy.caps.usd < floorUsd)
    deny("reserve-default-exceeds-cap", `caps.usd ${policy.caps.usd} is below the ${request.action} class default ${floorUsd} (D2)`, { cap: policy.caps.usd });
  if (policy.caps.turns !== undefined && policy.caps.turns < floorTurns)
    deny("reserve-default-exceeds-cap", `caps.turns ${policy.caps.turns} is below the ${request.action} class default ${floorTurns} (D2)`, { cap: policy.caps.turns });

  // ── A3: the full EpisodeAuthority denial surface (docs/12 §1/§4) ──
  // Absence of the authority object = DEFAULT CLOSED on every declared
  // demand: any request carrying paths/install/network/model/toolCalls
  // denies. A demand that is present but ungranted is a typed denial.
  const auth = policy.authority;
  const root = auth?.root ?? "/";
  if (request.paths !== undefined && request.paths.length > 0) {
    if (!auth) {
      deny("path-not-granted", `authority absent: ${request.paths.length} path(s) requested but nothing is granted (default closed)`);
    } else {
      for (const p of request.paths) {
        const canon = canonicalizePath(p, root);
        if (canon === undefined) {
          deny("path-not-granted", `path ${JSON.stringify(p)} escapes the authority root ${JSON.stringify(root)} (traversal/absolute outside root refused)`);
          continue;
        }
        const deniedGlob = (auth.notPaths ?? []).find((g) => globMatch(g, canon, root));
        if (deniedGlob !== undefined) {
          deny("path-not-granted", `path ${JSON.stringify(p)} (canonical ${JSON.stringify(canon)}) matches denied glob ${JSON.stringify(deniedGlob)}`);
          continue;
        }
        if (!(auth.paths ?? []).some((g) => globMatch(g, canon, root))) {
          deny("path-not-granted", `path ${JSON.stringify(p)} (canonical ${JSON.stringify(canon)}) matches no granted glob`);
        }
      }
    }
  }
  if (request.install === true && auth?.allowInstalls !== true)
    deny("install-not-allowed", "action performs package installs but authority.allowInstalls is not true");
  if (request.network === true && auth?.allowNetwork !== true)
    deny("network-not-allowed", "action performs network access but authority.allowNetwork is not true");
  if (request.model !== undefined) {
    if (!auth || !(auth.approvedModels ?? []).some((m) => m === request.model))
      deny("model-not-approved", `model ${JSON.stringify(request.model)} is not in authority.approvedModels`);
  }
  if (request.toolCalls !== undefined) {
    const max = auth?.diagnostics?.maxToolCalls;
    if (!isInt0(request.toolCalls)) deny("diagnostic-limit-exceeded", `toolCalls must be a non-negative integer (got ${String(request.toolCalls)})`);
    else if (max === undefined || request.toolCalls > max)
      deny("diagnostic-limit-exceeded", `diagnostic action requests ${request.toolCalls} tool calls, authority allows ${max === undefined ? "none" : max}`);
    const maxUsd = auth?.diagnostics?.maxUsd;
    if (maxUsd !== undefined && reserveUsd > maxUsd)
      deny("diagnostic-limit-exceeded", `diagnostic action reserves ${reserveUsd.toFixed(6)}, authority allows ${maxUsd}`);
  }

  // ── budget half: same compartment roll-ups for every cap class ──
  const usageAt = (c: Compartment): CompartmentUsage =>
    snapshot.compartments.get(compartmentKey(c)) ?? { consumedUsd: 0, unknownSpend: 0, consumedTurns: 0, reservedUsd: 0, reservedTurns: 0 };
  const episode = usageAt({ episodeId: policy.episodeId });
  const task = request.taskId !== undefined ? usageAt({ episodeId: policy.episodeId, taskId: request.taskId }) : undefined;
  const attempt = request.taskId !== undefined && request.attemptId !== undefined
    ? usageAt({ episodeId: policy.episodeId, taskId: request.taskId, attemptId: request.attemptId })
    : undefined;

  // consumed + new reservation must fit the cap (docs/12 §3).
  // A6 (unknown cost): a compartment carrying priced:"unknown" spend has
  // an UNBOUNDED USD exposure — no number exists for it, so USD admission
  // anywhere a USD cap exists is CONSERVATIVE: denied, never assumed $0.
  const overUsd = (label: string, usage: CompartmentUsage, cap: Cap, code: DenialCode) => {
    if (cap === undefined) return;
    if (usage.unknownSpend > 0) {
      deny(code, `${label}: ${usage.unknownSpend} unpriced (priced:"unknown") record(s) — unknown cost is never zero (A6); USD admission is blocked while any cap exists`, { cap, headroomUsd: 0 });
      return;
    }
    const projected = usage.consumedUsd + usage.reservedUsd + reserveUsd;
    if (projected > cap) deny(code, `${label}: ${projected.toFixed(6)} projected (consumed ${usage.consumedUsd.toFixed(6)} + reserved ${usage.reservedUsd.toFixed(6)} + this ${reserveUsd.toFixed(6)}) exceeds cap ${cap}`, { cap, headroomUsd: Math.max(0, cap - usage.consumedUsd - usage.reservedUsd) });
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

  // ── A9 (docs/12 §9): strategy-repeat limit over durable reservations ──
  if (request.strategyId !== undefined && policy.maxStrategyRepeats !== undefined) {
    const used = snapshot.strategyUses.get(JSON.stringify([policy.episodeId, request.taskId ?? null, request.strategyId])) ?? 0;
    if (used + 1 > policy.maxStrategyRepeats)
      deny("strategy-repeat-exceeded", `strategy ${JSON.stringify(request.strategyId)} already used ${used} time(s), cap ${policy.maxStrategyRepeats} — the next repeat needs a different fingerprint`, { cap: policy.maxStrategyRepeats });
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
    // A3/F1: the immutable canonical request snapshot — reserve() compares
    // against THESE frozen values, never against a live request reference.
    ...(request.paths !== undefined ? { paths: [...request.paths] } : {}),
    ...(request.install !== undefined ? { install: request.install } : {}),
    ...(request.network !== undefined ? { network: request.network } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.toolCalls !== undefined ? { toolCalls: request.toolCalls } : {}),
    ...(request.strategyId !== undefined ? { strategyId: request.strategyId } : {}),
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
  // ── A3/F1: immutable canonical request snapshot bound at check time ──
  paths?: string[];
  install?: boolean;
  network?: boolean;
  model?: string;
  toolCalls?: number;
  strategyId?: string;
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
        if (esc) {
          // F13: decode escape sequences so `"\u0073econds"` and
          // `"seconds"` collapse to the SAME key (JSON's own equivalence)
          // instead of evading duplicate detection as raw spellings.
          if (c === "u") {
            const hex = line.slice(j + 1, j + 5);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              // surrogate pairs collapse when adjacent; a lone surrogate is
              // kept as its code point (JSON.parse still validates).
              str += String.fromCharCode(parseInt(hex, 16));
              j += 4;
            } else {
              str += "u"; // invalid escape: JSON.parse refuses anyway
            }
          } else if (c === "n") str += "\n";
          else if (c === "t") str += "\t";
          else if (c === "r") str += "\r";
          else if (c === "b") str += "\b";
          else if (c === "f") str += "\f";
          else str += c; // \" \\ \/ and anything else: the char itself
          esc = false;
          continue;
        }
        if (c === "\\") { esc = true; continue; }
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
   *  corruption. F12: only an actually UNTERMINATED EOF fragment is
   *  tolerated as a torn tail (repair may keep or cut it); a file that
   *  ends with a newline has no tail — a malformed/schema-invalid/
   *  duplicate-key final record is corruption and refuses, even when it
   *  is last. (A whitespace-only trailing line is not a record; repair
   *  cuts it.) duplicateIds are reported, not merged. */
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
    const endsNL = raw.endsWith("\n");
    const lines = raw.split("\n");
    if (endsNL) lines.pop();
    const isTornTail = (i: number, line: string) => i === lines.length - 1 && (!endsNL || line.trim() === "");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") {
        if (isTornTail(i, line)) continue; // whitespace-only torn/last line (repair will cut it)
        throw new BudgetLedgerError("corrupt", `budget.jsonl: blank line ${i + 1} (records are exactly one JSON object per line)`);
      }
      const duplicated = duplicateKeyIn(line);
      if (duplicated !== undefined) {
        if (isTornTail(i, line)) continue; // ambiguous UNTERMINATED tail: repair drops it
        throw new BudgetLedgerError("corrupt", `budget.jsonl: line ${i + 1} repeats key ${JSON.stringify(duplicated)} (refusing an ambiguous record)`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (isTornTail(i, line)) continue; // torn tail — tolerated, repaired on open
        throw new BudgetLedgerError("corrupt", `budget.jsonl: corrupt line ${i + 1} (mid-file corruption)`);
      }
      try {
        validateLedgerRecord(parsed);
      } catch (e) {
        if (isTornTail(i, line)) continue; // torn tail tolerated
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
   *   - terminated file → untouched.
   *  F14: every repair mutation is fsynced through the file handle BEFORE
   *  the promise resolves — a repair that returns without syncing is a
   *  repair the crash can undo. Repair I/O failure propagates (a ledger
   *  that cannot repair itself must not pretend otherwise). */
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

    const cutTo = async (len: number): Promise<true> => {
      const handle = await fsOpen(this.path, "r+");
      try {
        await handle.truncate(len);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    };

    if (tail.trim() === "") return cutTo(lastNL + 1);
    if (duplicateKeyIn(tail) !== undefined) {
      // Ambiguous record (P4 lesson): cut it rather than terminate into history.
      return cutTo(lastNL + 1);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(tail);
    } catch {
      return cutTo(lastNL + 1);
    }
    try {
      validateLedgerRecord(parsed);
    } catch {
      return cutTo(lastNL + 1);
    }
    // Terminate the kept record — through a synced handle (F14), so the
    // newline is durable before open() reports the repair.
    const handle = await fsOpen(this.path, "a");
    try {
      await handle.appendFile("\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
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
    Object.assign(record, stamped); // F15: the caller's returned record carries the ledger-assigned ts
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
   *  this from within their enqueue — never call outside one).
   *  F15: ts is stamped HERE, from the injected clock, immediately
   *  before validation/write — the durable record can never carry 0. */
  private async appendInside(record: LedgerRecord, clock: Clock): Promise<void> {
    const stamped: LedgerRecord = { ...record, ts: clock() };
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
    Object.assign(record, stamped); // F15: the returned record carries the ledger-assigned ts
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
        rates: rate ? { ...rate } : undefined,
        costUsd: rate ? computeCostUsd(message.usage, rate) : undefined,
        priced,
        source: "session",
      };
      // A6: strip the undefined-valued keys (JSON would drop them anyway);
      // an unknown record carries NO costUsd/rates at all.
      if (priced === "unknown") {
        delete (record as Partial<SpendRecord>).rates;
        delete (record as Partial<SpendRecord>).costUsd;
      }
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
      rates: rate ? { ...rate } : undefined,
      costUsd: rate ? computeCostUsd(spend.usage, rate) : undefined,
      priced: src.priced,
      source: "manual",
      ...(spend.note !== undefined ? { note: String(spend.note) } : {}),
    };
    // A6: an unknown manual record carries NO costUsd/rates at all.
    if (src.priced === "unknown") {
      delete (record as Partial<SpendRecord>).rates;
      delete (record as Partial<SpendRecord>).costUsd;
    }
    // F16: the once-only guard runs INSIDE the serialized queue (the
    // pre-check above is only a fast path — two racing calls with the
    // same lineId now produce exactly one durable record).
    await this.append(record, clock, spend.lineId);
    return record;
  }

  // ── reservations (A4: the ONLY reservation path) ───────────────────────

  /**
   * Reserve capacity against a check() receipt. Refresh-first (R6/R7):
   * inside the serialized append queue the ledger is RE-READ, the gate
   * RE-RUNS against live state, and the reservation is appended only if
   * the refreshed check still passes. The receipt must match the request
   * it was minted for (digest-bound spec) and not be expired — expiry is
   * re-verified INSIDE the queue (audit F5: a clock that turns evil
   * between call time and admission can no longer slip an expired
   * receipt past the gate).
   *
   * actionId uniqueness is enforced inside the queue (audit F3): an
   * identical redelivery of a reserved actionId is an idempotent no-op
   * success returning the existing record; a DIFFERENT spec for a used
   * actionId is refused — a used identity never authorizes a second
   * external-effect issue.
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
    // F1: the PRESENTED request must equal the frozen snapshot the receipt
    // was minted from, field by field. The old code recomputed the digest
    // from the live request's fields — circular, so a mutated
    // request.estimate sailed through. Compare primitives, not references.
    const sameOpt = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    if (
      !sameOpt(request.paths, inner.paths) ||
      !sameOpt(request.install, inner.install) ||
      !sameOpt(request.network, inner.network) ||
      !sameOpt(request.model, inner.model) ||
      !sameOpt(request.toolCalls, inner.toolCalls) ||
      !sameOpt(request.strategyId, inner.strategyId) ||
      request.attemptId !== inner.attemptId
    ) {
      throw new BudgetLedgerError("receipt-mismatch", "reserve: request fields differ from the canonical snapshot the receipt was minted for (A3/F1)");
    }
    const presentedDigest = canonicalActionSpec(policy, request, { usd: inner.reserveUsd, turns: inner.reserveTurns });
    const presentedHash = createHash("sha256").update(presentedDigest, "utf8").digest("hex");
    if (presentedHash !== inner.digest) {
      throw new BudgetLedgerError("receipt-mismatch", "reserve: action spec does not match the receipt's digest (check(X)-then-act(Y) refused)");
    }
    return this.enqueue(async (): Promise<ReservationOpenRecord> => {
      // ── F5: expiry re-verified INSIDE the serialized queue ──
      const admissionAt = clock();
      if (admissionAt >= inner.expiresAt) {
        throw new BudgetLedgerError("receipt-invalid", `reserve: receipt expired at ${inner.expiresAt} (admission time ${admissionAt}) — re-check with a live clock`);
      }
      // ── F3: actionId uniqueness / idempotent redelivery, inside the ──
      // queue so two racing reserves of the same actionId serialize.
      const prior = (await this.snapshotAt(admissionAt)).actionIds.get(request.actionId);
      if (prior !== undefined) {
        if (
          prior.action === request.action &&
          prior.reservedUsd === inner.reserveUsd &&
          prior.reservedTurns === inner.reserveTurns &&
          prior.receiptDigest === inner.digest
        ) {
          return prior; // idempotent redelivery: same spec, no second record
        }
        throw new BudgetLedgerError("action-used", `reserve: actionId ${request.actionId} is already reserved by ${prior.id} (a used action identity never authorizes another issue)`);
      }
      // ── refresh-first (the queue-serialized recheck) ──
      const fresh = await this.snapshotAt(admissionAt);
      const refreshed = check(policy, request, fresh, admissionAt);
      if (!refreshed.allowed) {
        throw new BudgetLedgerError("denied", `reserve: refreshed gate denied — ${refreshed.denials.map((d) => `${d.code}: ${d.detail}`).join("; ")}`);
      }
      if (!refreshed.receipt) throw new BudgetLedgerError("impossible", "refreshed check allowed without minting a receipt");
      // F1: the refreshed EFFECTIVE reservation must equal the receipt's —
      // a policy/estimate change between check and reserve that moves the
      // hold amount is refused, not silently overwritten with old amounts.
      if (refreshed.reserve.usd !== inner.reserveUsd || refreshed.reserve.turns !== inner.reserveTurns) {
        throw new BudgetLedgerError("receipt-mismatch", `reserve: refreshed gate would reserve ${refreshed.reserve.usd}/${refreshed.reserve.turns}t but the receipt binds ${inner.reserveUsd}/${inner.reserveTurns}t (spec changed — re-check)`);
      }
      const record: ReservationOpenRecord = {
        schema: LEDGER_SCHEMA_ID,
        id: `b-${randomUUID()}`,
        ts: 0, // stamped by appendInside from the clock (F15)
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
        // A3 durable authority trail: every checked surface field.
        ...(inner.strategyId !== undefined ? { strategyId: inner.strategyId } : {}),
        ...(inner.paths !== undefined ? { paths: inner.paths.map((p) => canonicalizePath(p, policy.authority?.root ?? "/") ?? p) } : {}),
        ...(inner.install !== undefined ? { install: inner.install } : {}),
        ...(inner.network !== undefined ? { network: inner.network } : {}),
        ...(inner.model !== undefined ? { model: inner.model } : {}),
        ...(inner.toolCalls !== undefined ? { toolCalls: inner.toolCalls } : {}),
      };
      await this.appendInside(record, clock);
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
        ts: 0, // stamped by appendInside from the clock (F15)
        episodeId: open.episodeId,
        kind: "res-close",
        refId,
        reason,
      };
      await this.appendInside(record, clock);
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
