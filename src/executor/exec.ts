/**
 * P11 — Recovery action executor (docs/15; docs/11 §11.1 P11 row, §14.3
 * intent/outcome, §9.1, §13.2 I2/I5/I6, docs/12 §4 gate composition).
 *
 * Contract (docs/15):
 *   `executeRecoveryAction(plan, ctx, ports): Promise<ExecutionResult>` —
 *     consumes ONE P10 PlanRecommendation (hostile input: revalidated,
 *     never obeyed) and performs exactly the action it specifies through
 *     injected ports, journaling a §14.3 decision-intent BEFORE the act
 *     and a decision-outcome after it. NEVER rejects.
 *
 * Invariants (docs/15 §0/§5/§6):
 *   E1 no authority creation — a missing port for the named action is a
 *     refusal (port-missing), never a degraded execution. The executor
 *     never widens a grant and never self-approves (model lists, caps,
 *     and external-effect policy live in P8's gate).
 *   E2 log-then-act — an intent that fails to journal blocks the act
 *     (zero port calls). An open intent for the same actionId refuses
 *     (I2/I5): recovery closes open intents with observed reality, this
 *     module never re-issues blindly.
 *   E3 idempotent actionId — FNV-1a over the canonical plan snapshot +
 *     executionSeq; identical content replays as refused, never re-run.
 *     An outcome carrying the `no-effect:` marker re-opens replay.
 *   E4 ack ≠ attention — `acked:true` means the act's own DELIVERY
 *     contract resolved (I6); `progress` is ALWAYS "none" (uptake is
 *     P5/P14's later judgment — reporting it would launder hope into
 *     evidence, §9).
 *   E5 never throws — the whole body runs inside one fence (P14 S-F2:
 *     the fence precedes the first property read of hostile input); any
 *     escaped value becomes {status:"failed", stage, error}.
 *   E6 an act that happened with a lost outcome record reports
 *     outcomeDurable:false — it must never be silently re-run (§14.3).
 *
 * Self-containment (docs/15 §0.5, the P10 pattern): this module imports
 * NOTHING from the repo — not even `import type`, not even `node:`. The
 * port interfaces structurally mirror P7 AttemptRunner, P8 BudgetLedger
 * gate, P3b FileSteeringQueue, P4 DecisionJournal, P15 dispatch, and the
 * P10 planner action tables; the mirrors (tables AND enums) are pinned by
 * test/executor.test.ts (drift guard, docs/15 §7).
 *
 * Audit remediation (docs/audits/audit-p11-executor.md; docs/15 §9b):
 * F1 plan-identity binding vs ctx, F3 fence-safe instanceof + isPlainObj,
 * F5 fail-closed garbage journal read, F6 frozen single-read ctx, F7
 * empty-strategyId intent omission (kill e2e), F9 literal-'spawn'
 * reconcile — all with regression tests in test/executor.test.ts.
 */

// ─── Mirrors of the P10 planner tables (pinned by test/executor.test.ts) ───

/** Mirror of `PLANNER_SUPERVISOR_ACTIONS` / journal `SUPERVISOR_ACTIONS`. */
export const SUPERVISOR_ACTIONS = [
  'nudge',
  'evidence-nudge-resume',
  'model-swap',
  'task-rewrite',
  'escalate',
  'kill',
  'park',
  'merge',
  'backoff-retry',
  'investigate',
  'repair',
  'accept-finish',
] as const;
export type SupervisorAction = (typeof SUPERVISOR_ACTIONS)[number];
type PlanAction = SupervisorAction | 'hold';

/** Mirror of `RECOVERY_DECISIONS` (docs/14 §3). */
export const RECOVERY_DECISIONS = [
  'finish', 'continue', 'investigate', 'repair', 'change-approach', 'escalate',
] as const;
export type RecoveryDecision = (typeof RECOVERY_DECISIONS)[number];

/** Mirror of `PlannerSideEffect` / journal `SideEffectClass`. */
export type SideEffectClass = 'none' | 'worktree-local' | 'external';
const SIDE_EFFECT_ORDER: readonly SideEffectClass[] = ['none', 'worktree-local', 'external'];

/** Mirror of `STRATEGY_TEMPLATES` (docs/14 §4; model-swap has NO entry —
 *  it instantiates `swap:model:<id>:v1` from the plan's own model). */
export const STRATEGY_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  'nudge': 'nudge:progress:v1',
  'evidence-nudge-resume': 'resume:evidence:v1',
  'backoff-retry': 'retry:transient:v1',
  'investigate': 'investigate:bounded:v1',
  'repair': 'repair:task-local:v1',
  'task-rewrite': 'rewrite:task:v1',
  'escalate': 'escalate:v1',
  'park': 'park:v1',
  'accept-finish': 'accept:finish:v1',
  'hold': 'hold:v1',
});

/** Mirror of `ACTION_DECISION` (planner; drift guard docs/15 §7.3). */
export const ACTION_DECISION: Readonly<Record<PlanAction, RecoveryDecision>> = Object.freeze({
  'nudge': 'continue',
  'evidence-nudge-resume': 'continue',
  'backoff-retry': 'continue',
  'investigate': 'investigate',
  'repair': 'repair',
  'model-swap': 'change-approach',
  'task-rewrite': 'change-approach',
  'escalate': 'escalate',
  'park': 'escalate',
  'accept-finish': 'finish',
  'hold': 'continue',
  'kill': 'escalate',
  'merge': 'escalate',
});

/** Mirror of `ACTION_RUNG` (planner; drift guard docs/15 §7.3). The
 *  `repair`/`merge` entries are the CANONICAL (non-external) rungs — a
 *  repair seed instantiated by the planner with an external effect
 *  carries rung 3, accepted here by the repair override (§2). */
export const ACTION_RUNG: Readonly<Record<PlanAction, number>> = Object.freeze({
  'hold': 0,
  'accept-finish': 0,
  'nudge': 1,
  'evidence-nudge-resume': 2,
  'backoff-retry': 2,
  'investigate': 2,
  'repair': 2,
  'model-swap': 3,
  'task-rewrite': 4,
  'escalate': 5,
  'park': 5,
  'kill': 5,
  'merge': 4,
});

/** Mirror of the planner's per-action side-effect classification: the
 *  class a seed carries when the planner sets no override (repair is
 *  'worktree-local' for a contained repair, upgraded to 'external' by
 *  the seed when the repair touches outside authority). Pinned by the
 *  drift guard against the planner's finalize() defaults (docs/15 §7.3). */
export const ACTION_SIDE_EFFECT: Readonly<Record<PlanAction, SideEffectClass>> = Object.freeze({
  'nudge': 'none',
  'evidence-nudge-resume': 'none',
  'backoff-retry': 'none',
  'investigate': 'none',
  'repair': 'worktree-local',
  'model-swap': 'none',
  'task-rewrite': 'none',
  'escalate': 'none',
  'park': 'none',
  'accept-finish': 'none',
  'hold': 'none',
  'kill': 'none',
  'merge': 'none',
});

/** Ledger gating map (docs/12 §4): ONLY these actions carry a P8
 *  reservation. The executor never derives the class itself elsewhere. */
const LEDGER_ACTION: Partial<Record<PlanAction, 'run' | 'resume'>> = {
  'backoff-retry': 'run',
  'model-swap': 'run',
  'evidence-nudge-resume': 'resume',
};

// ─── Port interfaces (structural mirrors — everything external) ────────────

/** Mirror of the P4 DecisionJournal surface the executor needs. */
export interface JournalPort {
  append(record: object): Promise<void>;
  read(): Promise<{ records: readonly unknown[] }>;
}

/** Mirror of the P7 AttemptRunner subset (docs/15 §3). ReconcileResult /
 *  StopResult shapes trimmed to the fields the executor reads. */
export interface RunnerPort {
  reconcile(task: object): Promise<{ decision: { action: 'spawn' | 'park' | 'running'; reasons: string[] } }>;
  run(task: object): Promise<{ attemptId: string; pid?: number }>;
  resume(task: object, attemptId: string): Promise<{ attemptId: string; pid?: number }>;
  /** A3 (re-audit): `attemptId` pins the stop to the attempt the plan
   *  targets — a runner must refuse to act on a successor attempt. */
  stop(handle: { session: string; attemptId?: string }): Promise<{ stopped: boolean }>;
}

/** Mirror of the P8 gate (docs/12 §4 check→reserve composition lives in
 *  P9's adapter; the executor demands the pair be atomic and truthful:
 *  `reserve` throws iff the action was NOT admitted). */
export interface GatePort {
  check(policy: unknown, request: GateRequest): Promise<{ allowed: boolean; denials: { code: string; detail: string }[] }>;
  reserve(policy: unknown, request: GateRequest): Promise<void>;
  /** Audit R4-2: optional host close doors. The executor itself NEVER
   *  calls them — the supervisor loop wraps this port, holds the open
   *  record's id, and closes the reservation when it senses the spawned
   *  attempt's exit (settled, attested) or proves nothing spawned
   *  (released). Without a close door the ledger's expiry backstops. */
  closeReservation?(refId: string, reason: 'settled' | 'released', attest?: { outcome: string; evidence: string }): Promise<unknown>;
  /** Alternate close name some hosts expose. */
  release?(refId: string, reason: 'settled' | 'released', attest?: { outcome: string; evidence: string }): Promise<unknown>;
}

/** Mirror of `GateRequest` (src/budget/ledger.ts), trimmed to what the
 *  executor constructs. Opaque pass-through of the policy; the executor
 *  never inspects it (E1). */
export interface GateRequest {
  action: 'run' | 'resume';
  actionId: string;
  taskId?: string;
  attemptId?: string;
  authority: { grantedBy: string; sideEffect: SideEffectClass };
  model?: string;
  strategyId?: string;
}

/** Mirror of the P3b FileSteeringQueue push (scoped steer entry). */
export interface SteerPort {
  push(req: { id: string; text: string; source?: string; attemptId?: string; taskId?: string }): void | Promise<void>;
}

/** Mirror of the P15/P13/graph-owner dispatch callbacks. */
export interface DispatchPorts {
  investigate?(req: object): Promise<{ evidenceRefs?: string[] } | void>;
  repair?(req: object): Promise<{ evidenceRefs?: string[] } | void>;
  rewriteTask?(req: object): Promise<{ taskRevision?: number } | void>;
  escalate?(req: object): Promise<{ channel?: string; error?: string } | void>;
  park?(req: object): Promise<void>;
}

export interface ExecutorPorts {
  journal: JournalPort;
  runner?: RunnerPort;
  gate?: GatePort;
  steer?: SteerPort;
  dispatch?: DispatchPorts;
  /** Timer seam for backoff (docs/15 §3); defaults to setTimeout. */
  delay?: (ms: number) => Promise<void>;
}

// ─── Context & result ──────────────────────────────────────────────────────

export interface ExecutorContext {
  episodeId: string;
  taskId: string;
  /** The attempt the action targets, when one exists. */
  attemptId?: string;
  taskRevision?: number;
  /** Required only by `kill` (the runner stops by session). */
  session?: string;
  /** The injected clock (P10/P14 pattern) — never read twice. */
  now: number;
  /** WHO granted this execution. Absence of a granter is not permission
   *  (§9.1): an empty grantedBy fails the context closed. */
  authority: { grantedBy: string };
  /** Default 0; the ONLY legitimate way to make identical plan content
   *  executable twice (docs/15 §4). */
  executionSeq?: number;
}

export type ExecutionStage =
  | 'context' | 'revalidate' | 'dedup' | 'intent' | 'backoff' | 'gate' | 'act' | 'outcome';

export type ExecutionStatus = 'executed' | 'refused' | 'held' | 'failed';

export interface ExecutionResult {
  /** "" when failure happened before derivation. */
  actionId: string;
  /** plan action, or "" when unreadable. */
  action: string;
  status: ExecutionStatus;
  stage: ExecutionStage;
  reason?: string;
  /** Gate denials, verbatim from the gate port. */
  denials?: { code: string; detail: string }[];
  /** spawn/resume result. */
  attemptId?: string;
  evidenceRefs: string[];
  /** false ONLY when the act happened but its outcome record failed (E6). */
  outcomeDurable?: boolean;
  error?: { name: string; message: string };
  /** ctx.now echoed — never a second clock read. */
  executedAt: number;
}

// ─── Validation primitives ─────────────────────────────────────────────────

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_STR = 512;
const MAX_ARR = 64;
const MAX_MODEL = 256;
/** Audit R3: the journaled `rationale` is a JOINED text field — it was
 *  previously unbounded (64 lines x 512 chars = 32 KiB per record). */
const MAX_RATIONALE = 4096;

const isStr = (v: unknown, max = MAX_STR): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

/** Audit F3: `Array.isArray` on a REVOKED Proxy throws (the [[IsArray]]
 *  fundamental traps the revoke) — so the plainness test itself must be
 *  inside the fence. A revoked/unanswerable object is simply not a plain
 *  object (fail-closed), never a throw out of the caller's catch. */
const isPlainObj = (v: unknown): v is Record<string, unknown> => {
  try { return typeof v === 'object' && v !== null && !Array.isArray(v); } catch { return false; }
};

/** Dense array of non-empty strings, own-index iterated (P14 S-F3). */
function copyStrings(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length > MAX_ARR) return undefined;
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    if (!Object.hasOwn(v, i)) return undefined;
    const s = v[i];
    if (typeof s !== 'string' || s.length === 0 || s.length > MAX_STR) return undefined;
    out.push(s);
  }
  return out;
}

/** FNV-1a (32-bit) over a string — deterministic id digest (E3). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Canonical JSON: sorted keys, total (handles undefined/nested). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x)).join(',')}]`;
  if (isPlainObj(v)) {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Build an error descriptor FIELD BY FIELD (P14 S-F5: a throwing
 *  `.message`/`.name` must not re-throw out of the fence). */
function describeError(e: unknown): { name: string; message: string } {
  const out = { name: 'unknown', message: 'unknown' };
  if (isPlainObj(e)) {
    try { if (isStr(e.name, 256)) out.name = String(e.name); } catch { /* keep default */ }
    try {
      const m = (e as Record<string, unknown>).message;
      if (typeof m === 'string' && m.length > 0) out.message = m.slice(0, MAX_STR);
    } catch { /* keep default */ }
  } else {
    try { const s = String(e); if (s.length > 0) { out.name = 'error'; out.message = s.slice(0, MAX_STR); } } catch { /* keep default */ }
  }
  return out;
}

// ─── Hostile-input snapshot (§2): every property read inside one fence ─────

interface Snapshot {
  action: string;
  decision: string;
  rung: number;
  sideEffect: string;
  strategyId: string;
  authorityNeeded: string;
  notAPermission: boolean;
  rationale?: string[];
  evidenceRefs?: string[];
  remainingWork?: string[];
  expectedEvidence?: string;
  model?: string;
  /** F1 (audit): plan-carried identity, verified against ctx (§1/§2). */
  episodeId?: string;
  taskId?: string;
  taskRevision?: number;
}

/** Read a spawn/resume attemptId from port-returned data WITHOUT throwing.
 *  Audit R3: this read must never throw AFTER the effect landed — a throw
 *  here used to be misreported as "no effect" (replayable) and re-spawned. */
function readAttemptId(res: unknown): string | undefined {
  try {
    if (!isPlainObj(res)) return undefined;
    const a = (res as Record<string, unknown>).attemptId;
    return isStr(a, MAX_STR) ? a : undefined;
  } catch { return undefined; }
}

/** Own-property read from PORT-returned data that survives hostile getters
 *  (the R3 mirror of `own`, which only serves plan/ctx input). */
function portField(o: unknown, key: string): unknown {
  try {
    return isPlainObj(o) && Object.hasOwn(o as object, key) ? (o as Record<string, unknown>)[key] : undefined;
  } catch { return undefined; }
}

/** Own-property read that survives hostile getters. */
function own(o: Record<string, unknown>, key: string): unknown {
  try { return Object.hasOwn(o, key) ? o[key] : undefined; } catch { return undefined; }
}

interface SnapOutcome { snap?: Snapshot; error?: string; }

function snapshotPlan(plan: unknown): SnapOutcome {
  try {
    if (!isPlainObj(plan)) return { error: 'plan-invalid:shape' };
    const action = own(plan, 'action');
    const decision = own(plan, 'decision');
    const rung = own(plan, 'rung');
    const sideEffect = own(plan, 'sideEffect');
    const strategyId = own(plan, 'strategyId');
    const authorityNeeded = own(plan, 'authorityNeeded');
    const notAPermission = own(plan, 'notAPermission');
    const model = own(plan, 'model');
    const expectedEvidence = own(plan, 'expectedEvidence');
    const rationale = own(plan, 'rationale');
    const evidenceRefs = own(plan, 'evidenceRefs');
    const remainingWork = own(plan, 'remainingWork');
    const episodeId = own(plan, 'episodeId');
    const taskId = own(plan, 'taskId');
    const taskRevision = own(plan, 'taskRevision');
    const snap: Snapshot = {
      action: typeof action === 'string' ? action : '',
      decision: typeof decision === 'string' ? decision : '',
      rung: typeof rung === 'number' ? rung : Number.NaN,
      sideEffect: typeof sideEffect === 'string' ? sideEffect : '',
      strategyId: typeof strategyId === 'string' ? strategyId : '',
      authorityNeeded: typeof authorityNeeded === 'string' ? authorityNeeded : '',
      notAPermission: notAPermission === true,
    };
    if (model !== undefined) snap.model = typeof model === 'string' ? model : '';
    if (expectedEvidence !== undefined) snap.expectedEvidence = typeof expectedEvidence === 'string' ? expectedEvidence : '';
    if (rationale !== undefined) snap.rationale = rationale as string[]; // validated below
    if (evidenceRefs !== undefined) snap.evidenceRefs = evidenceRefs as string[];
    if (remainingWork !== undefined) snap.remainingWork = remainingWork as string[];
    // Validate the copied optional fields (raw values are never kept).
    if (rationale !== undefined) {
      const r = copyStrings(rationale);
      if (r === undefined) return { error: 'plan-invalid:rationale' };
      // R4-B/C (MEDIUM): the rationale is OBEYED — it is the steer text
      // (`nudge`) and the payload handed to `dispatch.escalate` — and it is
      // also a durable journal field. Structural validation allowed
      // 64 x 512 = 32 KiB while the record is bounded to MAX_RATIONALE, so
      // an executor could obey 32 KB and journal 4 KB, leaving a record
      // that UNDERSTATES what was done (measured: 32831 obeyed vs 4096
      // recorded). Anything obeyed must be journalable: enforce the budget
      // HERE, where the plan is still refusable, instead of truncating
      // after the fact.
      if (r.join(' ').length > MAX_RATIONALE) return { error: 'plan-invalid:rationale-budget' };
      snap.rationale = r;
    }
    if (evidenceRefs !== undefined) {
      const r = copyStrings(evidenceRefs);
      if (r === undefined) return { error: 'plan-invalid:evidenceRefs' };
      snap.evidenceRefs = r;
    }
    if (remainingWork !== undefined) {
      const r = copyStrings(remainingWork);
      if (r === undefined) return { error: 'plan-invalid:remainingWork' };
      snap.remainingWork = r;
    }
    // F1 (audit): plan-carried identity. A plan that CLAIMS identity is
    // held to it: safe format here, equality against ctx in judgePlan
    // (§1 "equal to plan.taskId"). A plan with no identity fields is
    // exactly what P10 emits today (PlanRecommendation carries none), so
    // absence is not a mismatch — the ctx is then the sole identity
    // authority. Either way nothing identity-like is ever copied FROM a
    // hostile plan into a record (E1).
    if (episodeId !== undefined) {
      if (typeof episodeId !== 'string' || !SAFE_ID.test(episodeId)) return { error: 'plan-invalid:episodeId' };
      snap.episodeId = episodeId;
    }
    if (taskId !== undefined) {
      if (typeof taskId !== 'string' || !SAFE_ID.test(taskId)) return { error: 'plan-invalid:taskId' };
      snap.taskId = taskId;
    }
    if (taskRevision !== undefined) {
      if (!Number.isInteger(taskRevision) || (taskRevision as number) < 1) return { error: 'plan-invalid:taskRevision' };
      snap.taskRevision = taskRevision as number;
    }
    if (expectedEvidence !== undefined && !isStr(expectedEvidence)) return { error: 'plan-invalid:expectedEvidence' };
    return { snap };
  } catch {
    return { error: 'plan-invalid:shape' };
  }
}

/** Judge the snapshot against the closed tables (§2). Returns a refusal
 *  reason or undefined. `hold` is judged by the caller first.
 *  F1 (audit): a plan that carries identity is verified against the
 *  (already validated, F6-frozen) ctx — mismatch is a confused-deputy
 *  refusal, never a silent re-binding to ctx's identity. */
function judgePlan(snap: Snapshot, ctx: ExecutorContext): string | undefined {
  const action = snap.action as PlanAction;
  if (snap.episodeId !== undefined && snap.episodeId !== ctx.episodeId) return 'plan-identity:episode';
  if (snap.taskId !== undefined && snap.taskId !== ctx.taskId) return 'plan-identity:task';
  if (snap.taskRevision !== undefined && snap.taskRevision !== ctx.taskRevision) {
    return 'plan-identity:revision'; // ctx lacking a revision cannot verify the plan's claim
  }
  if (!(SUPERVISOR_ACTIONS as readonly string[]).includes(action)) return 'plan-invalid:action';
  // strategyId must equal the closed template for the action; model-swap
  // instantiates its own template — a strategy naming a DIFFERENT model
  // is a repeat-budget bypass attempt (§2).
  if (action === 'model-swap') {
    if (!isStr(snap.model, MAX_MODEL)) return 'plan-invalid:model';
    if (snap.strategyId !== `swap:model:${snap.model}:v1`) return 'plan-invalid:strategy';
  } else if (action !== 'repair' && action !== 'kill' && action !== 'merge') {
    if (typeof snap.strategyId !== 'string' || snap.strategyId !== STRATEGY_TEMPLATES[action]) return 'plan-invalid:strategy';
  }
  // repair: the template id is carried for BOTH containment classes
  // (planner repairGate → finalize); containment is expressed by
  // sideEffect + the rung-3 override, never by mutating the strategyId.
  if (action === 'repair' && snap.strategyId !== STRATEGY_TEMPLATES['repair']) {
    return 'plan-invalid:strategy';
  }
  // rung: canonical table, with the documented repair-external override.
  let expectedRung = ACTION_RUNG[action];
  if (action === 'repair' && snap.sideEffect === 'external') expectedRung = 3;
  if (!Number.isInteger(snap.rung) || snap.rung < 0 || snap.rung > 5 || snap.rung !== expectedRung) {
    return 'plan-invalid:rung';
  }
  if (snap.decision !== ACTION_DECISION[action]) return 'plan-invalid:decision';
  if (!(SIDE_EFFECT_ORDER as readonly string[]).includes(snap.sideEffect)) return 'plan-invalid:authority';
  if (!(SIDE_EFFECT_ORDER as readonly string[]).includes(snap.authorityNeeded)) return 'plan-invalid:authority';
  if (SIDE_EFFECT_ORDER.indexOf(snap.authorityNeeded as SideEffectClass) <
      SIDE_EFFECT_ORDER.indexOf(snap.sideEffect as SideEffectClass)) {
    return 'plan-invalid:authority';
  }
  // The field P10 ALWAYS sets; its absence means the object was not
  // produced by P10 (E1: absence of provenance is not permission).
  if (snap.notAPermission !== true) return 'plan-invalid:permission-flag';
  return undefined;
}

// ─── Journal record builders (§14.3) ───────────────────────────────────────

const SCHEMA_ID = 'tre-supervisor/1';

interface IntentRec {
  schema: string; id: string; ts: number; episodeId: string; taskId: string;
  kind: 'decision-intent';
  actionId: string; attemptId?: string; taskRevision?: number; rung: number;
  action: string; strategyId?: string; expectedEvidence?: string;
  authority: { grantedBy: string; sideEffect: SideEffectClass };
  rationale: string;
}

interface OutcomeRec {
  schema: string; id: string; ts: number; episodeId: string; taskId: string;
  kind: 'decision-outcome';
  actionId: string; acked: boolean; progress: 'none';
  evidenceRefs?: string[]; notes?: string;
}

// ─── The executor ──────────────────────────────────────────────────────────

/** Refusal/hold/failed quick-builders (all echo the single clock). */
function refused(stage: ExecutionStage, reason: string, now: number, action = '', actionId = '', extra?: Partial<ExecutionResult>): ExecutionResult {
  return { actionId, action, status: 'refused', stage, reason, evidenceRefs: [], executedAt: now, ...extra };
}

/**
 * Execute the ONE action a P10 plan recommendation specifies (docs/15 §1).
 * The plan is HOSTILE input; the ctx is validated first; the whole body —
 * including every property read of the arguments — runs inside one fence,
 * so this function NEVER rejects (E5).
 */
export async function executeRecoveryAction(
  plan: unknown,
  ctx: ExecutorContext,
  ports: ExecutorPorts,
): Promise<ExecutionResult> {
  let stage: ExecutionStage = 'context';
  let action = '';
  let actionId = '';
  let now = 0;
  try {
    // ── 0. context (fail-closed before anything else) ────────────────────
    // F6 (audit): every field of ctx is read EXACTLY ONCE (fence-safe
    // `own`), validated, then rebound to a frozen local snapshot. No
    // downstream stage (digest, records, gate/dispatch requests) ever
    // re-reads the caller's mutable object — a trusted port that mutates
    // ctx mid-flight cannot split identity within one execution.
    if (!isPlainObj(ctx)) throw new ExecRefusal('context:shape');
    const cRaw = ctx as Record<string, unknown>;
    const cEp = own(cRaw, 'episodeId');
    const cTk = own(cRaw, 'taskId');
    const cNow = own(cRaw, 'now');
    if (typeof cEp !== 'string' || !SAFE_ID.test(cEp)) throw new ExecRefusal('context:episodeId');
    if (typeof cTk !== 'string' || !SAFE_ID.test(cTk)) throw new ExecRefusal('context:taskId');
    if (typeof cNow !== 'number' || !Number.isFinite(cNow) || cNow < 0) throw new ExecRefusal('context:now');
    now = cNow;
    const cAuth = own(cRaw, 'authority');
    const cGrantedBy = isPlainObj(cAuth) ? own(cAuth as Record<string, unknown>, 'grantedBy') : undefined;
    if (!isPlainObj(cAuth) || !isStr(cGrantedBy, MAX_STR)) throw new ExecRefusal('context:authority');
    const cSeqRaw = own(cRaw, 'executionSeq');
    const seq = cSeqRaw === undefined ? 0 : cSeqRaw;
    if (!Number.isInteger(seq) || (seq as number) < 0) throw new ExecRefusal('context:executionSeq');
    const cAttempt = own(cRaw, 'attemptId');
    if (cAttempt !== undefined && !(isStr(cAttempt, MAX_STR) && SAFE_ID.test(cAttempt))) throw new ExecRefusal('context:attemptId');
    const cRev = own(cRaw, 'taskRevision');
    if (cRev !== undefined && (!Number.isInteger(cRev) || (cRev as number) < 1)) throw new ExecRefusal('context:taskRevision');
    const cSession = own(cRaw, 'session');
    if (cSession !== undefined && !isStr(cSession, MAX_STR)) throw new ExecRefusal('context:session');
    if (!isPlainObj(ports)) throw new ExecRefusal('context:ports');
    ctx = Object.freeze({
      episodeId: cEp, taskId: cTk, now,
      authority: Object.freeze({ grantedBy: cGrantedBy as string }),
      executionSeq: seq as number,
      ...(cAttempt !== undefined ? { attemptId: cAttempt as string } : {}),
      ...(cRev !== undefined ? { taskRevision: cRev as number } : {}),
      ...(cSession !== undefined ? { session: cSession as string } : {}),
    } satisfies ExecutorContext);

    // ── 1. revalidate the plan (§2) ──────────────────────────────────────
    stage = 'revalidate';
    const so = snapshotPlan(plan);
    if (so.error !== undefined || so.snap === undefined) {
      return refused('revalidate', so.error ?? 'plan-invalid:shape', now);
    }
    const snap = so.snap;
    action = snap.action;
    if (action === 'hold') {
      // docs/14 §2.0 non-action sentinel: nothing journaled, nothing acted.
      return { actionId: '', action: 'hold', status: 'held', stage: 'revalidate', evidenceRefs: [], executedAt: now };
    }
    const invalid = judgePlan(snap, ctx);
    if (invalid !== undefined) return refused('revalidate', invalid, now, action);
    // `model` is meaningful ONLY for model-swap (judgePlan checked it);
    // an unrelated plan field must never leak into the runner task or
    // the gate request (E1: nothing out of the plan is obeyed).
    if (snap.action !== 'model-swap') delete (snap as { model?: string }).model;
    // resume targets an EXISTING nudge — without ctx.attemptId there is
    // nothing to attach to, and starting a fresh nudge under the "resume"
    // name would let the plan wording lie about what happened.
    if (snap.action === 'evidence-nudge-resume' && ctx.attemptId === undefined) {
      return refused('revalidate', 'resume requires ctx.attemptId', now, action);
    }

    const sideEffect = snap.sideEffect as SideEffectClass;
    // actionId: canonical(plan snapshot)+seq digest — deterministic across
    // object clones (E3). The snapshot (validated copies) is canonicalized,
    // never the raw plan.
    actionId = `a-${ctx.taskId}-${snap.action}-${fnv1a(canonical({ p: snap, seq }))}`;

    // ── required ports (§3) — missing = refusal, never degraded ──────────
    const need = (has: boolean, name: string): void => {
      if (!has) throw new ExecRefusal(`port-missing:${name}`);
    };
    const journal = isPlainObj(ports.journal) && typeof ports.journal?.append === 'function' && typeof ports.journal?.read === 'function'
      ? ports.journal : undefined;
    if (journal === undefined) throw new ExecRefusal('port-missing:journal');
    const runner = isPlainObj(ports.runner) ? ports.runner : undefined;
    const gate = isPlainObj(ports.gate) && typeof ports.gate?.check === 'function' && typeof ports.gate?.reserve === 'function'
      ? ports.gate : undefined;
    const steer = isPlainObj(ports.steer) && typeof ports.steer?.push === 'function' ? ports.steer : undefined;
    const dispatch = isPlainObj(ports.dispatch) ? ports.dispatch : undefined;
    const gated = LEDGER_ACTION[snap.action as PlanAction];
    switch (snap.action) {
      case 'nudge': need(steer !== undefined, 'steer'); break;
      case 'evidence-nudge-resume':
      case 'backoff-retry':
      case 'model-swap':
        need(runner !== undefined, 'runner'); need(gate !== undefined, 'gate'); break;
      case 'investigate': need(dispatch !== undefined && typeof dispatch.investigate === 'function', 'dispatch.investigate'); break;
      case 'repair': need(dispatch !== undefined && typeof dispatch.repair === 'function', 'dispatch.repair'); break;
      case 'task-rewrite': need(dispatch !== undefined && typeof dispatch.rewriteTask === 'function', 'dispatch.rewriteTask'); break;
      case 'escalate': need(dispatch !== undefined && typeof dispatch.escalate === 'function', 'dispatch.escalate'); break;
      case 'park': need(dispatch !== undefined && typeof dispatch.park === 'function', 'dispatch.park'); break;
      case 'kill': need(runner !== undefined, 'runner'); need(ctx.session !== undefined, 'session'); break;
      case 'merge': throw new ExecRefusal('merge-unwired'); // P12 unwired by contract
      case 'accept-finish': break; // record-only
    }

    // ── 2. dedup (§14.3 I2) ──────────────────────────────────────────────
    stage = 'dedup';
    let records: readonly unknown[];
    try {
      const r = await journal.read();
      // F5 (audit): a read that RESOLVES garbage is as unreadable as one
      // that throws — coercing `{records: null}` to [] would re-execute a
      // previously acked action (I2 bypass). Records that are not all
      // plain objects mean a corrupted stream: fail the stage closed.
      if (!isPlainObj(r) || !Array.isArray(r.records)) {
        return refused('dedup', 'journal-unreadable', now, action, actionId);
      }
      records = r.records;
      for (const raw of records) {
        if (!isPlainObj(raw)) return refused('dedup', 'journal-unreadable', now, action, actionId);
      }
    } catch {
      return refused('dedup', 'journal-unreadable', now, action, actionId);
    }
    let open = false;
    let done = false;
    let noEffect = false;
    let nIntent = 0;
    let nOutcome = 0;
    try {
      for (const raw of records) {
        if (!isPlainObj(raw)) continue;
        if ((raw as Record<string, unknown>).actionId !== actionId) continue;
        const kind = (raw as Record<string, unknown>).kind;
        if (kind === 'decision-intent') { open = true; done = false; noEffect = false; nIntent++; }
        else if (kind === 'decision-outcome') {
          open = false;
          nOutcome++;
          const acked = (raw as Record<string, unknown>).acked === true;
          const notes = (raw as Record<string, unknown>).notes;
          if (acked) { done = true; noEffect = false; }
          else if (typeof notes === 'string' && notes.startsWith('no-effect:')) { done = false; noEffect = true; }
          else { done = true; noEffect = false; } // un-acked without marker: not replayable
        }
      }
    } catch {
      return refused('dedup', 'journal-unreadable', now, action, actionId);
    }
    if (open) return refused('dedup', 'intent-open', now, action, actionId);
    if (done) return refused('dedup', 'already-executed', now, action, actionId);
    // noEffect ⇒ replay permitted: the fresh intent re-opens with a
    // distinct journal id (§4 step 2); duplicate-id reporting stays
    // advisory (§14.3), so replays suffix by the per-actionId counts.
    const intentSuffix = nIntent === 0 ? `${seq}` : `${seq}r${nIntent}`;
    const outcomeSuffix = nOutcome === 0 ? `${seq}` : `${seq}r${nOutcome}`;

    // ── 3. intent BEFORE act (§14.3, E2) ─────────────────────────────────
    stage = 'intent';
    const intent: IntentRec = {
      schema: SCHEMA_ID, id: `${actionId}#i${intentSuffix}`, ts: now,
      episodeId: ctx.episodeId, taskId: ctx.taskId,
      kind: 'decision-intent', actionId,
      rung: snap.rung, action: snap.action,
      authority: { grantedBy: ctx.authority.grantedBy, sideEffect },
      rationale: (snap.rationale !== undefined ? snap.rationale.join(' ') : action).slice(0, MAX_RATIONALE),
    };
    // F7 (audit): the real DecisionJournal's record schema requires a
    // NON-EMPTY strategyId when the field is present; kill/merge
    // legitimately have no template (§7.1). Omit the field rather than
    // send '' — the journal accepts absence, so the kill path reaches
    // the port instead of dying at intent.
    // R2-G4 (audit): kill/merge skip the template equality check in
    // judgePlan (they HAVE no template), so a hostile plan could smuggle
    // arbitrary text into the journaled strategyId. The field is only
    // ever set from a strategy the executor recognizes (a template or
    // the model-swap instantiation); claims for kill/merge are omitted.
    if (snap.strategyId !== '' && snap.action !== 'kill' && snap.action !== 'merge') intent.strategyId = snap.strategyId;
    if (ctx.attemptId !== undefined) intent.attemptId = ctx.attemptId;
    if (ctx.taskRevision !== undefined) intent.taskRevision = ctx.taskRevision;
    if (snap.expectedEvidence !== undefined) intent.expectedEvidence = snap.expectedEvidence;
    // Audit R1-G3 (hardening): freeze before append — a port that retains
    // the record by reference cannot later mutate what it "stored".
    Object.freeze(intent.authority); Object.freeze(intent);
    try {
      await journal.append(intent);
    } catch (e) {
      // log-then-act means exactly this: no intent, no act (E2).
      return refused('intent', 'intent-journal-failed', now, action, actionId, { error: describeError(e) });
    }

    // ── 4. backoff (intent landed, gate not yet judged) ──────────────────
    if (snap.action === 'backoff-retry') {
      stage = 'backoff';
      let attemptNumber = 1;
      const m = /(?:^|-)a(\d+)$/.exec(ctx.attemptId ?? '');
      if (m !== null) attemptNumber = Math.max(1, parseInt(m[1] ?? '1', 10));
      const ms = Math.min(1000 * 2 ** Math.max(0, attemptNumber - 1), 60_000);
      const delay = typeof ports.delay === 'function'
        ? ports.delay : (d: number) => new Promise<void>((res) => { setTimeout(res, d); });
      try {
        await delay(ms);
      } catch (e) {
        await appendNoEffect(journal, ctx, actionId, outcomeSuffix, now, `no-effect: act-failed delay-${describeError(e).name}`);
        return { actionId, action, status: 'failed', stage: 'backoff', error: describeError(e), evidenceRefs: [], executedAt: now };
      }
    }

    // ── 5. gate (spawn actions): check → reserve (§14.3/docs/12 §4) ──────
    const gateReq: GateRequest = {
      action: gated ?? 'run', actionId, taskId: ctx.taskId,
      authority: { grantedBy: ctx.authority.grantedBy, sideEffect },
      strategyId: snap.strategyId,
    };
    if (ctx.attemptId !== undefined) gateReq.attemptId = ctx.attemptId;
    if (snap.model !== undefined) gateReq.model = snap.model;
    if (gated !== undefined) {
      stage = 'gate';
      let checkRes: { allowed: boolean; denials: { code: string; detail: string }[] };
      try {
        checkRes = await gate!.check(undefined, gateReq);
      } catch (e) {
        await appendNoEffect(journal, ctx, actionId, outcomeSuffix, now, `no-effect: gate-check-failed ${describeError(e).name}`);
        return refused('gate', 'gate-check-failed', now, action, actionId, { error: describeError(e) });
      }
      // Audit R2-G2: the RESULT judgment itself is port-returned data —
      // a live Proxy whose `allowed` getter throws (after `then` passed
      // the await) must not escape with the intent stranded open.
      let allowed = false;
      try { allowed = checkRes?.allowed === true; } catch { /* treat as failed check */ }
      if (!allowed) {
        // Audit R1-G1: denial normalization reads port-returned data —
        // a hostile denials array (throwing element getter) must not
        // escape into the top-level fence with the no-effect outcome
        // un-written (that strands the intent open for a clean denial).
        let denials: { code: string; detail: string }[] = [];
        try {
          denials = (Array.isArray(checkRes?.denials) ? checkRes.denials : [])
            .map((d) => (isPlainObj(d) && typeof d.code === 'string'
              ? { code: String(d.code), detail: typeof d.detail === 'string' ? d.detail.slice(0, MAX_STR) : '' }
              : { code: 'unknown', detail: '' }));
        } catch { denials = [{ code: 'malformed-denials', detail: '' }]; }
        await appendNoEffect(journal, ctx, actionId, outcomeSuffix, now, `no-effect: gate-denied ${denials.map((d) => d.code).join(',') || 'none'}`);
        return refused('gate', 'gate-denied', now, action, actionId, { denials });
      }
      try {
        // Audit R4-2: resolve VALUE is ignored (void-or-record hosts).
        // The reservation's close is owned by the SUPERVISOR loop, which
        // wraps this gate port and holds the open record's id — the
        // executor stays a pure single-act module (docs/18 §9).
        await gate!.reserve(undefined, gateReq);
      } catch (e) {
        // reserve throws iff the action was NOT admitted (port contract).
        await appendNoEffect(journal, ctx, actionId, outcomeSuffix, now, `no-effect: gate-denied reserve-revoked-${describeError(e).name}`);
        return refused('gate', 'gate-denied', now, action, actionId, { error: describeError(e) });
      }
    }

    // ── 6. act: exactly one port call (§3 table) ─────────────────────────
    stage = 'act';
    const runnerTask = {
      episodeId: ctx.episodeId, taskId: ctx.taskId,
      ...(ctx.attemptId !== undefined ? { attemptId: ctx.attemptId } : {}),
      ...(ctx.taskRevision !== undefined ? { taskRevision: ctx.taskRevision } : {}),
      ...(snap.model !== undefined ? { model: snap.model } : {}),
    };
    let acked = false;
    // R3: set immediately BEFORE the delivering port call. Once true, a
    // subsequent throw can no longer prove "nothing happened".
    let effectStarted = false;
    let attemptOut: string | undefined;
    let actEvidence: string[] = [];
    let actNotes: string | undefined;
    try {
      switch (snap.action) {
        case 'nudge': {
          const lines = [...(snap.rationale ?? [])];
          if (snap.expectedEvidence !== undefined) lines.push(snap.expectedEvidence);
          effectStarted = true;
          await steer!.push({
            id: actionId, text: lines.join('\n'), source: 'supervisor',
            attemptId: ctx.attemptId, taskId: ctx.taskId,
          });
          acked = true;
          actEvidence = [`steer:${actionId}`];
          break;
        }
        case 'evidence-nudge-resume':
        case 'backoff-retry':
        case 'model-swap': {
          const rec = await runner!.reconcile(runnerTask);
          // Audit R3: reconcile's verdict is port-returned data read after
          // an awaited port call — a throwing getter here used to land in
          // the act catch below and be reported as `no-effect`, an
          // unfounded claim (reconcile may have touched the runner).
          const decision = portField(portField(rec, 'decision'), 'action');
          // F9 (audit): spawn ONLY on the literal 'spawn' — an unknown
          // decision (mis-typed/extended runner) refuses instead of
          // falling open into a spawn.
          if (decision !== 'spawn') {
            const why = decision === 'running' ? 'already-running'
              : decision === 'park' ? 'parked'
              : 'reconcile-unknown';
            await appendNoEffect(journal, ctx, actionId, outcomeSuffix, now,
              `no-effect: ${why}`);
            return refused('act', why, now, action, actionId);
          }
          effectStarted = true;
          const res = snap.action === 'evidence-nudge-resume'
            ? await runner!.resume(runnerTask, ctx.attemptId ?? '')
            : await runner!.run(runnerTask);
          // Audit R3 (CRITICAL): the effect has LANDED by now — the spawn
          // or resume happened. Reading `res.attemptId` may throw (hostile
          // or merely revocable port value). Doing that throw inside the
          // act catch made the module journal `no-effect: act-failed` and
          // so PERMIT a replay, spawning a SECOND worker for an action
          // that already happened (E3/I5 violation, reproduced: 2 spawns).
          // The read is therefore fence-safe and cannot fail the act.
          acked = true;
          attemptOut = readAttemptId(res);
          actEvidence = attemptOut !== undefined ? [`attempt:${attemptOut}`] : ['spawn:ok'];
          break;
        }
        case 'investigate': {
          const fn = dispatch!.investigate;
          if (typeof fn !== 'function') throw new ExecRefusal('port-missing:dispatch.investigate');
          effectStarted = true;
          const r = await fn.call(dispatch, { episodeId: ctx.episodeId, taskId: ctx.taskId, attemptId: ctx.attemptId, actionId, expectedEvidence: snap.expectedEvidence });
          acked = true;
          actEvidence = ['dispatch:investigate', ...portEvidence(r)];
          break;
        }
        case 'repair': {
          const fn = dispatch!.repair;
          if (typeof fn !== 'function') throw new ExecRefusal('port-missing:dispatch.repair');
          effectStarted = true;
          const r = await fn.call(dispatch, { episodeId: ctx.episodeId, taskId: ctx.taskId, attemptId: ctx.attemptId, actionId, sideEffect });
          acked = true;
          actEvidence = ['dispatch:repair', ...portEvidence(r)];
          break;
        }
        case 'task-rewrite': {
          const fn = dispatch!.rewriteTask;
          if (typeof fn !== 'function') throw new ExecRefusal('port-missing:dispatch.rewriteTask');
          effectStarted = true;
          const r = await fn.call(dispatch, { episodeId: ctx.episodeId, taskId: ctx.taskId, actionId, remainingWork: snap.remainingWork ?? [] });
          // Audit R3: the revision bump IS the act — it already happened.
          // These result reads must not throw into the act catch (which
          // would claim `no-effect` for a completed rewrite).
          acked = true;
          const rev = portField(r, 'taskRevision');
          actEvidence = ['dispatch:task-rewrite', ...(Number.isInteger(rev) ? [`revision:${String(rev)}`] : [])];
          break;
        }
        case 'escalate': {
          const fn = dispatch!.escalate;
          if (typeof fn !== 'function') throw new ExecRefusal('port-missing:dispatch.escalate');
          effectStarted = true;
          const r = await fn.call(dispatch, { episodeId: ctx.episodeId, taskId: ctx.taskId, actionId, rationale: snap.rationale ?? [] });
          // Audit R3: the escalation is already out — a hostile `channel`
          // read must not downgrade a delivered escalation to no-effect.
          acked = true;
          const chRaw = portField(r, 'channel');
          const ch = isStr(chRaw, MAX_STR) ? chRaw : undefined;
          actEvidence = ['dispatch:escalate', ...(ch !== undefined ? [`channel:${String(ch)}`] : [])];
          break;
        }
        case 'park': {
          const fn = dispatch!.park;
          if (typeof fn !== 'function') throw new ExecRefusal('port-missing:dispatch.park');
          effectStarted = true;
          await fn.call(dispatch, { episodeId: ctx.episodeId, taskId: ctx.taskId, actionId });
          acked = true;
          actEvidence = ['dispatch:park'];
          break;
        }
        case 'kill': {
          if (ctx.session === undefined) throw new ExecRefusal('port-missing:session');
          // R4-A (HIGH): the stop handle REQUESTS a kill; a `stopped:false`
          // (or an unreadable `stopped`) answer means the runner could not
          // CONFIRM it — it does not mean nothing happened. Journaling this
          // as `no-effect:` made the kill REPLAYABLE and re-issued a kill
          // command against the same session (reproduced: 2 stop calls,
          // both recorded as "no effect"). §14.3/I5: unconfirmed is
          // UNKNOWN — never re-issued blindly. The comment that used to sit
          // here claimed the opposite of what the code did.
          // A3 (re-audit): the stop ALSO carries ctx.attemptId when the
          // plan targets one, so the runner can refuse (throw) a stop
          // whose attemptId no longer matches the tracked attempt — a
          // stale plan can never signal a successor. The refusal throws
          // AFTER `effectStarted` (nothing was sent, but the executor
          // cannot prove the port refused rather than partially acted),
          // so the catch records act-unknown — non-replayable, which is
          // exactly the conservative outcome an unobservable act wants.
          effectStarted = true;
          const r = await runner!.stop({ session: ctx.session, ...(ctx.attemptId !== undefined ? { attemptId: ctx.attemptId } : {}) });
          const stopped = portField(r, 'stopped'); // fence-safe: hostile getter → undefined
          acked = stopped === true;              // delivery = confirmed stop
          if (!acked) actNotes = 'act-unknown: stop-unconfirmed';
          // Evidence names the pin actually applied: an attempt-pinned
          // stop says `stop:attempt-*`; a session-scoped stop (no
          // attemptId in the plan) says `stop:session-*` (R4-E).
          actEvidence = [`stop:${ctx.attemptId !== undefined ? 'attempt' : 'session'}-${acked ? 'confirmed' : 'unconfirmed'}`];
          break;
        }
        case 'accept-finish': {
          // record-only act: the outcome record IS the act.
          acked = true;
          actEvidence = [...(snap.evidenceRefs ?? [])];
          break;
        }
        default:
          throw new ExecRefusal('plan-invalid:action');
      }
    } catch (e) {
      if (isExecRefusal(e)) {
        // port-missing discovered at act time (session). Round-4 audit:
        // every ExecRefusal raised inside the switch fires BEFORE its
        // `effectStarted = true` (checked against all six no-effect
        // writers), so the marker is provable. This guard keeps a future
        // edit from breaking that silently.
        if (effectStarted) {
          await appendNoEffect(journal, ctx, actionId, outcomeSuffix, now, `act-unknown: ${e.reason}`);
        } else {
          await appendNoEffect(journal, ctx, actionId, outcomeSuffix, now, `no-effect: ${e.reason}`);
        }
        return refused('act', e.reason, now, action, actionId);
      }
      const err = describeError(e);
      // Audit R3 (CRITICAL): only a throw raised BEFORE the delivering
      // port call can honestly claim `no-effect:`. A port may deliver
      // its effect and THEN fail (a spawn that succeeded whose result
      // cannot be awaited, an escalation already sent whose channel read
      // traps). Claiming no-effect there made the action REPLAYABLE and
      // a second call spawned a SECOND worker for work that had already
      // happened (reproduced: 2 spawns, both records saying "no effect").
      // Per §14.3/I5 an action whose effect is UNKNOWN must never be
      // re-issued; it stays non-replayable until recovery closes it
      // against observed reality.
      if (!effectStarted) {
        await appendNoEffect(journal, ctx, actionId, outcomeSuffix, now, `no-effect: act-failed ${err.name}`);
        return { actionId, action, status: 'failed', stage: 'act', error: err, evidenceRefs: [], executedAt: now };
      }
      try {
        const rec: OutcomeRec = {
          schema: SCHEMA_ID, id: `${actionId}#o${outcomeSuffix}`, ts: now,
          episodeId: ctx.episodeId, taskId: ctx.taskId,
          kind: 'decision-outcome', actionId, acked: false, progress: 'none' as const,
          notes: `act-unknown: act-failed ${err.name}`.slice(0, MAX_STR),
        };
        Object.freeze(rec);
        await journal.append(rec);
      } catch { /* best-effort: a lost record leaves the intent open — also non-replayable */ }
      return { actionId, action, status: 'failed', stage: 'act', error: err, evidenceRefs: [], executedAt: now };
    }

    // ── 7. outcome (§14.3; ack = delivery, progress: "none" always, E4) ──
    stage = 'outcome';
    const outcome: OutcomeRec = {
      schema: SCHEMA_ID, id: `${actionId}#o${outcomeSuffix}`, ts: now,
      episodeId: ctx.episodeId, taskId: ctx.taskId,
      kind: 'decision-outcome', actionId, acked, progress: 'none',
    };
    const refs = actEvidence.length > 0 ? actEvidence : ['none'];
    Object.freeze(refs); // R1-G3
    if (refs.length > 0) outcome.evidenceRefs = refs;
    if (actNotes !== undefined) outcome.notes = actNotes;
    Object.freeze(outcome); // R1-G3
    try {
      await journal.append(outcome);
    } catch (e) {
      // E6: the act happened; the record is lost. NEVER silently re-run —
      // surface it, do not convert to failed.
      return {
        actionId, action, status: 'executed', stage: 'outcome', attemptId: attemptOut,
        evidenceRefs: refs, outcomeDurable: false, error: describeError(e), executedAt: now,
      };
    }
    return { actionId, action, status: 'executed', stage: 'outcome', attemptId: attemptOut, evidenceRefs: refs, outcomeDurable: true, executedAt: now };
  } catch (e) {
    // E5 top-level fence: nothing escapes as a rejection.
    if (isExecRefusal(e)) {
      if (e.reason.startsWith('context:')) {
        return refused('context', e.reason.slice('context:'.length), now, action, actionId);
      }
      return refused(stage, e.reason, now, action, actionId);
    }
    return { actionId, action, status: 'failed', stage, error: describeError(e), evidenceRefs: [], executedAt: now };
  }
}

/** Audit F3: `e instanceof ExecRefusal` runs `getPrototypeOf` on the
 *  error value — a REVOKED Proxy throws there, inside the catch,
 *  escaping the §5 "NEVER rejects" fence. instanceof is only consulted
 *  behind a fence; an unanswerable error value is simply not a refusal. */
function isExecRefusal(e: unknown): e is ExecRefusal {
  try { return e instanceof ExecRefusal; } catch { return false; }
}

/** Best-effort no-effect outcome (§4/§6: the marker makes the act
 *  replayable). Never throws — its failure changes nothing. */
async function appendNoEffect(
  journal: JournalPort, ctx: ExecutorContext, actionId: string, outcomeSuffix: string, now: number, notes: string,
): Promise<void> {
  try {
    const rec: OutcomeRec = {
      schema: SCHEMA_ID, id: `${actionId}#o${outcomeSuffix}`, ts: now,
      episodeId: ctx.episodeId, taskId: ctx.taskId,
      kind: 'decision-outcome', actionId, acked: false, progress: 'none' as const,
      notes: notes.slice(0, MAX_STR),
    };
    Object.freeze(rec); // R1-G3
    await journal.append(rec);
  } catch { /* best-effort: a lost no-effect record leaves the intent
                open, which refuses replay — conservative by design. */ }
}

/** String-checked evidenceRefs returned by a dispatch port (§4 step 7).
 *  Audit R3: `Array.isArray` and the index reads run on PORT-returned data
 *  AFTER the act resolved; the outer try/catch keeps a hostile getter from
 *  escaping, and `Object.hasOwn` keeps a sparse/hostile array dense. */
function portEvidence(r: unknown): string[] {
  try {
    if (!isPlainObj(r)) return [];
    const refs = (r as Record<string, unknown>).evidenceRefs;
    if (!Array.isArray(refs)) return [];
    const out: string[] = [];
    for (let i = 0; i < refs.length && out.length < MAX_ARR; i++) {
      if (!Object.hasOwn(refs, i)) continue;
      const s = refs[i];
      if (typeof s === 'string' && s.length > 0 && s.length <= MAX_STR) out.push(s);
    }
    return out;
  } catch { return []; }
}

/** Internal control-flow refusal (caught by the fence). */
class ExecRefusal extends Error {
  constructor(readonly reason: string) { super(reason); }
}
