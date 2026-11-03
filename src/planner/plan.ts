/**
 * P10 — Evidence classification & recovery planner (docs/14; docs/11 §11.1
 * P10 row, §9 ladder + hygiene, §9.1, §13.2 I3/I5/I7).
 *
 * Contracts (docs/14):
 *   `planRecovery(input: PlannerInput): PlanRecommendation` — pure
 *     function: persisted evidence + P14 acceptance + validated P15
 *     diagnosis + episode authority + ledger facts → exactly one bounded
 *     recovery recommendation (or the `hold` sentinel).
 *   `STRATEGY_TEMPLATES` — the closed fingerprint table (§4; P8 counts
 *     exact ids — no free text ever leaves this module).
 *   `PLANNER_WORKER_STATES` / `PLANNER_VERDICTS` — structural mirrors
 *     pinned 1:1 against src/fleet/tail.ts and src/acceptance/evaluator.ts
 *     by test/planner.test.ts.
 *
 * Invariants (docs/14 §8):
 *   PC1 never-throws — hostile/malformed input is validated, never obeyed;
 *     unusable identity bottoms out at escalate `bad-input`.
 *   PC2 deterministic — same input → deep-equal output; no clock, no
 *     randomness, no env, no iteration-order dependence.
 *   PC3 no permission — `notAPermission: true` always; evidenceRefs are
 *     copied from inputs, never invented (I3/S7 — an empty list stays
 *     empty).
 *   PC4 verdict integrity — only a LIVE `complete` acceptance produces
 *     `finish`; a dead/unvalidated assessment is ignored entirely.
 *   PC5 escalate-safe — escalate/park/accept-finish/hold are exempt from
 *     repeat vetoes; every veto path bottoms out at escalate/park.
 *   PC6 authority monotone — LESS authority never enables
 *     repair/swap/investigate; MORE never disables escalate.
 *   PC7 `unknown` worker state never reaches the healthy-hold rung (I3:
 *     silence is not thinking).
 *   I5 — the plan never spawns, and an ambiguous external effect latches
 *     the planner out of every retry (escalate/park only).
 *   I7 — budget facts arrive as the ledger projection for THIS task and
 *     span attempts; the planner refuses the next act at the cap (it does
 *     not reserve — P8 reserves).
 *
 * Self-containment (docs/14 §0.6): this module imports NOTHING from the
 * repo — not even `import type`. The input types structurally mirror
 * `AcceptanceAssessment` (src/acceptance/evaluator.ts),
 * `WorkerState` (src/fleet/tail.ts), and `DiagnosisRecord` /
 * `SupervisorAction` / `RecoveryBudget` (the episode journal module); the
 * mirrors are pinned by tests so a divergent rename fails the suite.
 */

// ─── Mirrored closed enums ─────────────────────────────────────────────────

/** Mirror of `WorkerState` (src/fleet/tail.ts WORKER_STATES, closed set). */
export const PLANNER_WORKER_STATES = [
  'thinking',
  'tool',
  'await-approval',
  'warned',
  'stopped',
  'dead',
  'unknown',
] as const;
export type PlannerWorkerState = (typeof PLANNER_WORKER_STATES)[number];

/** Mirror of `AcceptanceVerdict` (src/acceptance/evaluator.ts VERDICTS). */
export const PLANNER_VERDICTS = ['complete', 'incomplete', 'blocked', 'uncertain'] as const;
export type PlannerVerdict = (typeof PLANNER_VERDICTS)[number];

/** Mirror of `DiagnosisRecord.causeClass` (the episode journal module). */
export const PLANNER_CAUSE_CLASSES = [
  'transient-endpoint',
  'premature-stop',
  'task-defect',
  'environment-blocker',
  'approval-boundary',
  'unknown',
] as const;
export type PlannerCauseClass = (typeof PLANNER_CAUSE_CLASSES)[number];

/** Mirror of `SupervisorAction` (the episode journal module SUPERVISOR_ACTIONS). */
export const PLANNER_SUPERVISOR_ACTIONS = [
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
export type PlannerSupervisorAction = (typeof PLANNER_SUPERVISOR_ACTIONS)[number];

/** Mirror of `SideEffectClass` (the episode journal module). */
export type PlannerSideEffect = 'none' | 'worktree-local' | 'external';

/** The decision vocabulary of the P10 row (docs/11: finish/continue/
 *  investigate/repair/change-approach/escalate). */
export const RECOVERY_DECISIONS = [
  'finish', 'continue', 'investigate', 'repair', 'change-approach', 'escalate',
] as const;
export type RecoveryDecision = (typeof RECOVERY_DECISIONS)[number];

// ─── Strategy fingerprints (docs/14 §4 — closed template table) ───────────

/**
 * action → strategyId template. P8 counts exact ids, so nothing outside
 * this table may appear in a plan (`model-swap` instantiates
 * `swap:model:<id>:v1` with the validated target).
 */
export const STRATEGY_TEMPLATES = {
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
} as const satisfies Record<string, string>;

/** §4: escalation must never be veto-looped into silence; finishing and
 *  holding are not interventions against the loop budget. The chain never
 *  proposes these actions, so no veto path can reach them (PC5). */
export const REPEAT_EXEMPT: ReadonlySet<string> = new Set([
  'escalate', 'park', 'accept-finish', 'hold',
]);

const swapTemplate = (modelId: string): string => `swap:model:${modelId}:v1`;

// ─── Input (docs/14 §1) ────────────────────────────────────────────────────

export interface PlannerInput {
  taskId: string;
  taskRevision: number;
  worker: {
    state: PlannerWorkerState;
    detail?: string;
    warnCount: number;
    sameGuardFires: number;
    toolCallsThisAttempt: number;
  };
  lastOutcome?: {
    action: PlannerSupervisorAction;
    strategyId: string;
    progress: 'none' | 'uptake' | 'task-relevant';
    progressEvidence?: string[];
  };
  acceptance?: {
    live: boolean;
    assessment: {
      verdict: PlannerVerdict;
      remainingWork: string[];
      reasons: string[];
      taskId: string;
      taskRevision: number;
    };
  };
  diagnosis?: {
    causeClass: PlannerCauseClass;
    confidence?: number;
    proposedActions?: { rung: number; action: PlannerSupervisorAction; strategyId?: string }[];
    evidenceRefs?: string[];
  };
  ambiguousExternalEffect?: boolean;
  ownershipProvable?: boolean;
  authority: {
    paths: string[];
    notPaths: string[];
    allowInstalls?: boolean;
    allowNetwork?: boolean;
    allowExternalEffects?: boolean;
    models?: string[];
    diagnostics?: { maxToolCalls: number; maxUsd: number };
  };
  recoveryBudget?: {
    maxAttemptsPerTask?: number;
    maxNudgesPerTask?: number;
    maxStrategyRepeats?: number;
    maxEpisodeRecoveryUsd?: number;
    maxEpisodeRecoveryTurns?: number;
  };
  facts: {
    attemptsUsed: number;
    nudgesUsed: number;
    steerGuardResets: number;
    strategyUses: Record<string, number>;
    recoveryUsdUsed: number;
    recoveryTurnsUsed: number;
    diagnosticToolCallsUsed: number;
    diagnosticUsdUsed: number;
    otherApprovedModels: string[];
  };
  repairTarget?: {
    paths: string[];
    touchesOutsideAuthority?: boolean;
    externalEffect?: boolean;
    installNeeded?: boolean;
  };
  now: number;
}

// ─── Output (docs/14 §2) ───────────────────────────────────────────────────

export interface PlanAlternative {
  decision: RecoveryDecision;
  action: PlannerSupervisorAction | 'hold';
  strategyId: string;
  veto: string;
}

export interface PlanRecommendation {
  decision: RecoveryDecision;
  /** §14.3/§9 action; `hold` is the pinned non-action sentinel (§2.0) —
   *  not a member of SUPERVISOR_ACTIONS, so no executor can run it. */
  action: PlannerSupervisorAction | 'hold';
  rung: number;
  sideEffect: PlannerSideEffect;
  strategyId: string;
  rationale: string[];
  evidenceRefs: string[];
  expectedEvidence?: string;
  remainingWork?: string[];
  alternatives: PlanAlternative[];
  model?: string;
  authorityNeeded: PlannerSideEffect;
  notAPermission: true;
}

// ─── Action tables ─────────────────────────────────────────────────────────

const ACTION_DECISION: Record<PlannerSupervisorAction | 'hold', RecoveryDecision> = {
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
};

/** docs/11 §9 + §375: rungs for the P0-extended actions. */
const ACTION_RUNG: Record<PlannerSupervisorAction | 'hold', number> = {
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
};

const EXPECTED_EVIDENCE: Partial<Record<PlannerSupervisorAction | 'hold', string>> = {
  'nudge': 'uptake: next tool call of a different family or a changed batch signature',
  'evidence-nudge-resume': 'uptake: first post-resume tool call cites the remainingWork items',
  'backoff-retry': 'attempt record: spawn outcome ok and endpoint reachable',
  'investigate': 'bounded diagnosis record: a causeClass or an explicit exhaustion marker',
  'repair': 'the gate/check on the repaired paths passes',
  'model-swap': 'task-relevant evidence from the swapped endpoint',
  'task-rewrite': 'an acceptance milestone against the rewritten task revision',
};

// ─── Input validation (§1 hygiene — never throws, fail-closed) ─────────────

type SanitizedDiagnosis = {
  causeClass: PlannerCauseClass;
  confidence: number;
  proposedActions: { rung: number; action: string; strategyId?: string }[];
  evidenceRefs: string[];
};

type SanitizedAssessment = {
  verdict: PlannerVerdict;
  remainingWork: string[];
  taskId: string;
  taskRevision: number;
};

type Ctx = {
  bad: string[] | null;
  note: string | undefined;
  state: PlannerWorkerState;
  sameGuardFires: number;
  lastOutcome: { action: string; strategyId: string; progress: 'none' | 'uptake' | 'task-relevant'; progressEvidence: string[] } | undefined;
  assessment: SanitizedAssessment | undefined;
  diagnosis: SanitizedDiagnosis | undefined;
  ambiguous: boolean;
  ownershipProvable: boolean;
  authority: {
    paths: string[]; notPaths: string[];
    /** C2: false when the required `paths`/`notPaths` lists are absent,
     *  non-array, or not all-string — the authority record is unusable and
     *  every gated action (repair) is denied; empty-but-valid stays true. */
    grantOk: boolean;
    allowInstalls: boolean; allowExternalEffects: boolean;
    models: string[];
    diagnostics: { maxToolCalls: number; maxUsd: number } | undefined;
  };
  caps: { maxAttempts: number; maxNudges: number; maxRepeats: number; maxUsd: number; maxTurns: number };
  facts: {
    attemptsUsed: number; nudgesUsed: number; steerGuardResets: number;
    strategyUses: Map<string, number>;
    /** C3: true when the required strategy-use ledger is absent/malformed
     *  ⇒ every fingerprint counts as MAXED usage (repeat veto), never 0. */
    ledgerBroken: boolean;
    recoveryUsdUsed: number; recoveryTurnsUsed: number;
    diagnosticToolCallsUsed: number; diagnosticUsdUsed: number;
    otherApprovedModels: string[];
  };
  repairTarget: { paths: string[]; touchesOutsideAuthority: boolean; externalEffect: boolean; installNeeded: boolean } | undefined;
};

const MAXED = Number.POSITIVE_INFINITY;

const isStr = (v: unknown): v is string => typeof v === 'string';
/**
 * F8/C3: caller-owned arrays are iterated by index + typeof only — never
 * through caller-supplied methods (a hostile `filter`/iterator would run
 * in this module's frame). Non-array ⇒ []. Elements that are not strings
 * are dropped. May throw on hostile element getters — sanitize() runs
 * inside planRecovery's fail-closed boundary (PC1).
 */
const onlyStrs = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const e = v[i];
    if (typeof e === 'string') out.push(e);
  }
  return out;
};
const num = (v: unknown): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? v : undefined;
/** required ledger number: malformed/missing ⇒ fail-closed (usage maxed). */
const numMaxed = (v: unknown): number => num(v) ?? MAXED;
const flag = (v: unknown, dflt: boolean): boolean => typeof v === 'boolean' ? v : dflt;
/**
 * F4/C5: RESTRICTION flags fail closed the other way than grants — absent
 * ⇒ false, explicit false ⇒ false, but present-and-corrupt ("yes", 1,
 * null) ⇒ TRUE: a damaged safety annotation may never clear itself.
 * A corrupt restriction is NEVER coerced away.
 */
const restrictFlag = (v: unknown): boolean => v !== undefined && v !== false;
/**
 * F5: grants exist only as validated OWN properties — an inherited
 * (prototype-polluted) `diagnostics` / `models` / `allow*` is never an
 * effective grant (§1 hostile-records hygiene).
 */
const own = (o: object, k: string): unknown =>
  Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined;
/** C2: own-property container read: an inherited container object is
 *  treated as ABSENT (returns undefined), never as a grant/ledger. */
const ownObj = (o: object, k: string): Record<string, unknown> | undefined => {
  const v = own(o, k);
  return v !== undefined && typeof v === 'object' ? v as Record<string, unknown> : undefined;
};
/**
 * F6/C2: budget caps — ABSENT (no own property) means default (or no cap);
 * a PRESENT own property with any invalid value — including `undefined` —
 * fails closed to 0 (the cap is engaged), never to the default. Presence
 * is tracked separately from value for exactly this reason (§12(17)/§12(23)).
 */
const capOf = (o: object, k: string, dflt: number): number =>
  Object.prototype.hasOwnProperty.call(o, k) ? (num((o as Record<string, unknown>)[k]) ?? 0) : dflt;
/**
 * C1/C2: all-string check by INDEX — never calls a caller-owned `.every`
 * (a poisoned `every` made `[123]` pass an Array.isArray + every check).
 */
const allStrs = (v: unknown[]): boolean => {
  for (let i = 0; i < v.length; i++) if (typeof v[i] !== 'string') return false;
  return true;
};
/**
 * C6/C2: own-property-only table lookup — `STRATEGY_TEMPLATES["constructor"]`
 * and `ACTION_DECISION["__proto__"]` are inherited Object members, NOT
 * fingerprints; an unknown key yields undefined, never a function/object.
 */
const tableGet = <T extends object>(t: T, k: unknown): T[keyof T] | undefined =>
  (typeof k === 'string' && Object.prototype.hasOwnProperty.call(t, k))
    ? (t as Record<string, unknown>)[k] as T[keyof T] | undefined
    : undefined;
/**
 * F2: lexical normalization into the authority namespace. Rejects absolute
 * paths, backslashes, empty results, and any `..` that would escape the
 * root. Returns null for unsupported/escaping forms (deny, fail-closed).
 */
const normPath = (p: string): string | null => {
  if (typeof p !== 'string' || p.length === 0 || p.startsWith('/') || p.includes('\\')) return null;
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null; // escapes the root
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.length === 0 ? null : out.join('/');
};
const isLive = (s: PlannerWorkerState): boolean =>
  s === 'thinking' || s === 'tool' || s === 'warned';
const isEnded = (s: PlannerWorkerState): boolean => s === 'stopped' || s === 'dead';

/**
 * Fail-closed boolean for the I5 latch: a CORRUPTED (present, non-boolean)
 * ambiguous flag latches — a damaged safety interlock may never clear
 * itself. Absent means "no latch fact recorded" (false).
 */
const ambiguousLatch = (v: unknown): boolean => v !== undefined && v !== false;

function sanitize(raw: PlannerInput): Ctx {
  // C2: EVERY load-bearing container is read as an OWN property of its
  // parent — a prototype-polluted input cannot supply identity, authority,
  // ledgers, or a healthy assessment through the prototype chain (§12(20)).
  const rawObj = raw && typeof raw === 'object' ? raw : ({} as PlannerInput);
  // Identity fields are load-bearing (§1): unusable ⇒ bottom rung later.
  const taskIdOk = isStr(own(rawObj, 'taskId')) && (rawObj.taskId as string).length > 0;
  const rev = num(own(rawObj, 'taskRevision'));
  const revOk = rev !== undefined && Number.isInteger(rev) && rev >= 1;
  const w = ownObj(rawObj, 'worker');
  const stateOk = w !== undefined && PLANNER_WORKER_STATES.includes(own(w, 'state') as PlannerWorkerState);
  const bad = (taskIdOk && revOk && stateOk) ? null : ['identity'];

  let note: string | undefined;

  // acceptance: only a live, identity-matching, enum-valid, STRUCTURALLY
  // COMPLETE assessment survives; anything else is ignored ENTIRELY
  // (PC4 — dead evidence is not partially trusted; F3 — a projection
  // missing required fields is not a contract assessment).
  // C1: required arrays are validated by INDEX (allStrs) — a poisoned
  // caller-owned `.every` can no longer pass `[123]` through.
  let assessment: SanitizedAssessment | undefined;
  const acc = ownObj(rawObj, 'acceptance');
  if (acc !== undefined) {
    const a = ownObj(acc, 'assessment');
    if (own(acc, 'live') !== true) {
      note = 'assessment:dead';
    } else if (
      a !== undefined
      && (PLANNER_VERDICTS as readonly string[]).includes(own(a, 'verdict') as string)
      && own(a, 'taskId') === rawObj.taskId && own(a, 'taskRevision') === rawObj.taskRevision
      && Array.isArray(own(a, 'remainingWork')) && allStrs(own(a, 'remainingWork') as unknown[])
      && Array.isArray(own(a, 'reasons')) && allStrs(own(a, 'reasons') as unknown[])
    ) {
      assessment = {
        verdict: own(a, 'verdict') as PlannerVerdict,
        remainingWork: onlyStrs(own(a, 'remainingWork')),
        taskId: own(a, 'taskId') as string,
        taskRevision: own(a, 'taskRevision') as number,
      };
    } else {
      note = 'assessment:invalid';
    }
  }

  // diagnosis: validated advice (§1). Malformed ⇒ dropped, never obeyed.
  let diagnosis: SanitizedDiagnosis | undefined;
  const d = ownObj(rawObj, 'diagnosis');
  if (d !== undefined) {
    if ((PLANNER_CAUSE_CLASSES as readonly string[]).includes(own(d, 'causeClass') as string)) {
      const conf = num(own(d, 'confidence'));
      // F8/C3: index-based copy — caller-owned array methods are never
      // invoked in this frame.
      const pas: SanitizedDiagnosis['proposedActions'] = [];
      const rawPas = own(d, 'proposedActions');
      if (Array.isArray(rawPas)) {
        for (let i = 0; i < rawPas.length; i++) {
          const pa = rawPas[i];
          if (pa !== undefined && pa !== null && typeof pa === 'object' && isStr(own(pa as object, 'action'))) {
            const paO = pa as Record<string, unknown>;
            pas.push({ rung: num(own(paO, 'rung')) ?? 0, action: own(paO, 'action') as string, strategyId: isStr(own(paO, 'strategyId')) ? (own(paO, 'strategyId') as string) : undefined });
          }
        }
      }
      diagnosis = {
        causeClass: own(d, 'causeClass') as PlannerCauseClass,
        confidence: conf === undefined ? 0 : Math.min(1, conf),
        proposedActions: pas,
        evidenceRefs: onlyStrs(own(d, 'evidenceRefs')),
      };
    } else {
      note = note ?? 'diagnosis:invalid';
    }
  }

  const progressVals: readonly string[] = ['none', 'uptake', 'task-relevant'];
  let lastOutcome: Ctx['lastOutcome'];
  const lo = ownObj(rawObj, 'lastOutcome');
  if (lo !== undefined) {
    const loProgress = own(lo, 'progress');
    if (isStr(own(lo, 'action')) && isStr(own(lo, 'strategyId')) && progressVals.includes(loProgress as string)) {
      lastOutcome = {
        action: own(lo, 'action') as string, strategyId: own(lo, 'strategyId') as string,
        progress: loProgress as 'none' | 'uptake' | 'task-relevant',
        progressEvidence: onlyStrs(own(lo, 'progressEvidence')),
      };
    } else {
      note = note ?? 'outcome:invalid';
    }
  }

  // F5/C2: the authority CONTAINER itself must be an own property, and
  // `paths`/`notPaths` must be own, present, all-string arrays: a corrupt
  // or missing required grant/deny list fails the gate closed rather than
  // erasing into an empty allow/deny set (§12(22)).
  const auth = ownObj(rawObj, 'authority') ?? ({} as PlannerInput['authority']);
  const authOwn = (k: string): unknown => own(auth, k);
  const pathsRaw = authOwn('paths');
  const notPathsRaw = authOwn('notPaths');
  const pathsOk = Array.isArray(pathsRaw) && allStrs(pathsRaw);
  const notPathsOk = Array.isArray(notPathsRaw) && allStrs(notPathsRaw);
  const dRaw = authOwn('diagnostics');
  const diagGrant = dRaw && typeof dRaw === 'object'
    ? { maxToolCalls: num(own(dRaw as object, 'maxToolCalls')) ?? 0, maxUsd: num(own(dRaw as object, 'maxUsd')) ?? 0 }
    : undefined;

  // F6/C2: absent caps ⇒ default; a PRESENT own property with any invalid
  // value (including explicit undefined) ⇒ 0 (engaged).
  const rb = ownObj(rawObj, 'recoveryBudget') ?? {};
  const caps = {
    maxAttempts: capOf(rb, 'maxAttemptsPerTask', 3),
    // C8: docs/11 §9 pins ≤2 rung-1 nudges per task as a BINDING ceiling —
    // a looser policy value can never raise it; stricter values still win.
    maxNudges: Math.min(capOf(rb, 'maxNudgesPerTask', 2), 2),
    maxRepeats: capOf(rb, 'maxStrategyRepeats', 2),
    maxUsd: capOf(rb, 'maxEpisodeRecoveryUsd', MAXED),
    maxTurns: capOf(rb, 'maxEpisodeRecoveryTurns', MAXED),
  };

  const f = ownObj(rawObj, 'facts') ?? ({} as PlannerInput['facts']);
  // C3: the strategy-use ledger is REQUIRED. An absent/malformed ledger
  // (missing, null, non-object, array, or not an own property) means the
  // planner cannot prove any strategy is unused ⇒ every fingerprint is
  // treated as MAXED (fail closed toward the repeat veto), never as zero.
  const suRaw = own(f, 'strategyUses');
  // Plainness matters too: `Object.create({ 'investigate:bounded:v1': 2 })`
  // is an object whose counts are INHERITED — Object.entries would drop
  // them and silently read as "unused". A usable ledger must have
  // Object.prototype/null as prototype so entries() is the whole truth.
  const suProtoOk = suRaw !== undefined && typeof suRaw === 'object' && !Array.isArray(suRaw)
    && (Object.getPrototypeOf(suRaw) === Object.prototype || Object.getPrototypeOf(suRaw) === null);
  const ledgerBroken = !suProtoOk;
  const uses = new Map<string, number>();
  if (!ledgerBroken && suRaw) {
    for (const [k, v] of Object.entries(suRaw as Record<string, unknown>)) {
      // malformed per-template counts fail closed toward the veto.
      uses.set(k, num(v) ?? MAXED);
    }
  }

  const rt = ownObj(rawObj, 'repairTarget');
  const repairTarget = rt !== undefined && Array.isArray(rt.paths)
    ? {
        paths: onlyStrs(rt.paths),
        // F4: restriction flags fail closed — corrupt ⇒ the restriction
        // engages (true), never coerced to false.
        touchesOutsideAuthority: restrictFlag(rt.touchesOutsideAuthority),
        externalEffect: restrictFlag(rt.externalEffect),
        installNeeded: restrictFlag(rt.installNeeded),
      }
    : undefined;

  return {
    bad,
    note,
    state: (stateOk ? own(w!, 'state') : 'unknown') as PlannerWorkerState,
    sameGuardFires: numMaxed(own(w ?? {}, 'sameGuardFires')),
    lastOutcome,
    assessment,
    diagnosis,
    ambiguous: ambiguousLatch(own(rawObj, 'ambiguousExternalEffect')),
    ownershipProvable: flag(own(rawObj, 'ownershipProvable'), false),
    authority: {
      paths: pathsOk ? (pathsRaw as string[]) : [],
      notPaths: notPathsOk ? (notPathsRaw as string[]) : [],
      grantOk: pathsOk && notPathsOk,
      allowInstalls: flag(authOwn('allowInstalls'), false),
      allowExternalEffects: flag(authOwn('allowExternalEffects'), false),
      models: onlyStrs(authOwn('models')),
      diagnostics: diagGrant,
    },
    caps,
    facts: {
      attemptsUsed: numMaxed(own(f, 'attemptsUsed')),
      nudgesUsed: numMaxed(own(f, 'nudgesUsed')),
      steerGuardResets: numMaxed(own(f, 'steerGuardResets')),
      strategyUses: uses,
      ledgerBroken,
      recoveryUsdUsed: numMaxed(own(f, 'recoveryUsdUsed')),
      recoveryTurnsUsed: numMaxed(own(f, 'recoveryTurnsUsed')),
      diagnosticToolCallsUsed: numMaxed(own(f, 'diagnosticToolCallsUsed')),
      diagnosticUsdUsed: numMaxed(own(f, 'diagnosticUsdUsed')),
      otherApprovedModels: onlyStrs(own(f, 'otherApprovedModels')),
    },
    repairTarget,
  };
}

// ─── Eligibility checks (§4 repeat rule, §5 authority gate, §7 pool) ───────

type Elig = { ok: true; strategyId: string; model?: string; veto?: undefined }
  | { ok: false; veto: string; strategyId?: string };

const elNo = (veto: string, strategyId?: string): Elig => ({ ok: false, veto, strategyId });
const elYes = (strategyId: string, model?: string): Elig =>
  ({ ok: true, strategyId, ...(model !== undefined ? { model } : {}) });

function stratOk(c: Ctx, template: string): Elig {
  // C3: a missing/malformed ledger proves nothing about usage ⇒ every
  // fingerprint is MAXED (repeat veto), never "unused".
  const used = c.facts.ledgerBroken ? MAXED : (c.facts.strategyUses.get(template) ?? 0);
  return used < c.caps.maxRepeats ? elYes(template) : elNo(`repeat:${template}`, template);
}

function elNudge(c: Ctx): Elig {
  if (steerWithoutProgress(c)) return elNo('uptake-not-progress', STRATEGY_TEMPLATES['nudge']);
  if (c.sameGuardFires >= 2) return elNo('guard:recurrence', STRATEGY_TEMPLATES['nudge']);
  if (c.facts.nudgesUsed + c.facts.steerGuardResets >= c.caps.maxNudges) {
    return elNo('budget:nudges', STRATEGY_TEMPLATES['nudge']);
  }
  return stratOk(c, STRATEGY_TEMPLATES['nudge']);
}

function elResume(c: Ctx): Elig {
  // §9/§6 + §12(10): the second same-guard fire prohibits ANY further
  // steer — nudge and evidence-nudge-resume alike.
  if (c.sameGuardFires >= 2) return elNo('guard:recurrence', STRATEGY_TEMPLATES['evidence-nudge-resume']);
  return stratOk(c, STRATEGY_TEMPLATES['evidence-nudge-resume']);
}

const elRetry = (c: Ctx): Elig => stratOk(c, STRATEGY_TEMPLATES['backoff-retry']);

function elInvestigate(c: Ctx): Elig {
  if (!c.authority.diagnostics) return elNo('diagnostics:ungranted', STRATEGY_TEMPLATES['investigate']);
  if (c.facts.diagnosticToolCallsUsed >= c.authority.diagnostics.maxToolCalls) {
    return elNo('diagnostics:tools', STRATEGY_TEMPLATES['investigate']);
  }
  if (c.facts.diagnosticUsdUsed >= c.authority.diagnostics.maxUsd) {
    return elNo('diagnostics:usd', STRATEGY_TEMPLATES['investigate']);
  }
  return stratOk(c, STRATEGY_TEMPLATES['investigate']);
}

/** §7: first remaining approved model in INPUT ORDER (deterministic). */
function swapCandidates(c: Ctx): string[] {
  if (c.authority.models.length === 0) return [];
  const pool = new Set(c.authority.models);
  return c.facts.otherApprovedModels.filter((m) => pool.has(m) && m !== undefined);
}

function elSwap(c: Ctx): Elig {
  if (c.authority.models.length === 0) return elNo('swap:no-pool');
  const candidates = swapCandidates(c);
  if (candidates.length === 0) return elNo('swap:no-target');
  for (const m of candidates) {
    const r = stratOk(c, swapTemplate(m));
    if (r.ok) return elYes(r.strategyId, m);
  }
  return elNo(`repeat:${swapTemplate(candidates[0]!)}`, swapTemplate(candidates[0]!));
}

function elRewrite(c: Ctx): Elig {
  // §7: the rewrite fingerprint must be UNUSED (stricter than §4 default)
  // AND it still passes the §4 repeat rule — F7: task-rewrite is not
  // exempt, so maxStrategyRepeats=0 vetoes even an unused fingerprint.
  // C3: a broken ledger cannot prove "unused" ⇒ veto.
  const t = STRATEGY_TEMPLATES['task-rewrite'];
  const used = c.facts.ledgerBroken ? MAXED : (c.facts.strategyUses.get(t) ?? 0);
  if (used >= 1) return elNo(`repeat:${t}`, t);
  return stratOk(c, t);
}

/** Lexical path match on NORMALIZED forms (§5 containment is lexical —
 *  F2): exact, directory prefix, or trailing-`**` glob. A null input
 *  (unsupported/escaping form) never matches. */
function pathMatches(pattern: string, p: string): boolean {
  const npat = normPath(pattern);
  const ntgt = normPath(p);
  if (npat === null || ntgt === null) return false;
  if (npat === ntgt) return true;
  const dir = npat.endsWith('/**') ? npat.slice(0, -3) : npat;
  return ntgt === dir || ntgt.startsWith(dir.endsWith('/') ? dir : dir + '/');
}

/** §5 authority gate — ALL must hold; every failure is named. */
function repairGate(c: Ctx): { ok: true; strategyId: string; external: boolean } | { ok: false; denials: string[] } {
  const denials: string[] = [];
  const rt = c.repairTarget;
  // C4: the authority record itself must be well-formed — a corrupt or
  // missing required `paths`/`notPaths` list never erases into an empty
  // allow/deny set; repair is simply ineligible.
  if (!c.authority.grantOk) {
    denials.push('authority-record');
  } else if (!rt || rt.paths.length === 0) {
    // (2) paths non-empty, inside authority.paths, outside notPaths.
    denials.push('paths');
  } else {
    const inside = (p: string): boolean => c.authority.paths.some((pat) => pathMatches(pat, p));
    const outside = (p: string): boolean => c.authority.notPaths.some((pat) => pathMatches(pat, p));
    if (!rt.paths.every(inside) || rt.paths.some(outside)) denials.push('paths');
  }
  // (3) containment / explicit external policy.
  if (rt && (rt.touchesOutsideAuthority || (rt.externalEffect && !c.authority.allowExternalEffects))) {
    denials.push('external');
  }
  // (4) installs need explicit grant.
  if (rt && rt.installNeeded && !c.authority.allowInstalls) denials.push('install');
  if (denials.length > 0) return { ok: false, denials };
  // (5) repeat check.
  const s = stratOk(c, STRATEGY_TEMPLATES['repair']);
  if (!s.ok) return { ok: false, denials: [s.veto] };
  return { ok: true, strategyId: STRATEGY_TEMPLATES['repair'], external: !!rt?.externalEffect };
}

// ─── Ladder helpers ────────────────────────────────────────────────────────

/**
 * §6: a steer whose recorded outcome is not task-relevant evidence.
 * C7: the classification — not the mere presence of reference strings —
 * decides: recorded progress `none`/`uptake` is a failed steer even when
 * progressEvidence is nonempty (unverified refs never upgrade the
 * recorded classification; §12(24)).
 */
function steerWithoutProgress(c: Ctx): boolean {
  const lo = c.lastOutcome;
  if (!lo) return false;
  if (lo.action !== 'nudge' && lo.action !== 'evidence-nudge-resume') return false;
  return lo.progress !== 'task-relevant';
}

type Seed = {
  decision: RecoveryDecision;
  action: PlannerSupervisorAction | 'hold';
  strategyId: string;
  rationale: string[];
  alternatives: PlanAlternative[];
  model?: string;
  remainingWork?: string[];
  sideEffect?: PlannerSideEffect;
  authorityNeeded?: PlannerSideEffect;
  rung?: number;
  expectedEvidence?: string;
};

type Step = { action: PlannerSupervisorAction; check: (c: Ctx) => Elig };

const STEP_RETRY: Step = { action: 'backoff-retry', check: elRetry };
const STEP_RESUME: Step = { action: 'evidence-nudge-resume', check: elResume };
const STEP_NUDGE: Step = { action: 'nudge', check: elNudge };
const STEP_INVESTIGATE: Step = { action: 'investigate', check: elInvestigate };
const STEP_SWAP: Step = { action: 'model-swap', check: elSwap };
const STEP_REWRITE: Step = { action: 'task-rewrite', check: elRewrite };

/** First eligible step, collecting vetoes (§4: the ladder tries the next
 *  supported action; all-vetoed ⇒ escalate with the vetoed list). */
function chainPick(c: Ctx, steps: Step[]): { chosen: { action: PlannerSupervisorAction; strategyId: string; model?: string }; vetoed: PlanAlternative[] } | { chosen: undefined; vetoed: PlanAlternative[] } {
  const vetoed: PlanAlternative[] = [];
  for (const s of steps) {
    const r = s.check(c);
    if (r.ok) {
      return { chosen: { action: s.action, strategyId: r.strategyId, ...(r.model !== undefined ? { model: r.model } : {}) }, vetoed };
    }
    vetoed.push({
      decision: ACTION_DECISION[s.action],
      action: s.action,
      // F9: no fingerprint from the closed table (e.g. a pool-less swap)
      // ⇒ "" (no fingerprint), not the free-text "advice".
      strategyId: r.strategyId ?? STRATEGY_TEMPLATES[s.action as keyof typeof STRATEGY_TEMPLATES] ?? '',
      veto: r.veto,
    });
  }
  return { chosen: undefined, vetoed };
}

const escalationSeed = (rationale: string[], vetoed: PlanAlternative[], extra?: Partial<Seed>): Seed => ({
  decision: 'escalate',
  action: 'escalate',
  strategyId: STRATEGY_TEMPLATES['escalate'],
  rationale,
  alternatives: vetoed,
  ...extra,
});

/** Chain-or-escalate: §4 — when every supported intervention is
 *  repeat-vetoed (or gated out), the answer is escalate. */
function chainSeed(base: string[], steps: Step[]): (c: Ctx) => Seed {
  return (c) => {
    const { chosen, vetoed } = chainPick(c, steps);
    if (!chosen) {
      const allRepeat = vetoed.length > 0 && vetoed.every((v) => v.veto.startsWith('repeat:'));
      return escalationSeed(
        [...base, ...(allRepeat ? ['repeat-limit'] : vetoed.map((v) => `veto:${v.veto}`))],
        vetoed,
      );
    }
    if (chosen.action === 'model-swap') base = [...base, 'swap:pool'];
    return {
      decision: ACTION_DECISION[chosen.action],
      action: chosen.action,
      strategyId: chosen.strategyId,
      rationale: base,
      alternatives: vetoed,
      ...(chosen.model !== undefined ? { model: chosen.model } : {}),
    };
  };
}

/** F9/C3: is a strategyId a fingerprint from the closed table, or a
 *  pool-validated swap fingerprint (§4)? Free-text advice never is.
 *  Type predicate so callers narrow `string | undefined`. */
function isClosedFingerprint(c: Ctx, sid: unknown): sid is string {
  if (!isStr(sid)) return false;
  for (const t of Object.values(STRATEGY_TEMPLATES)) if (t === sid) return true;
  for (const m of c.authority.models) if (swapTemplate(m) === sid) return true;
  return false;
}

/** §2: advice ranking only — proposed actions that are not the ladder's
 *  own answer appear as alternatives vetoed `advice-not-authority`.
 *  F9: an advice-carried strategyId enters the output ONLY if it is a
 *  closed fingerprint; anything else takes the action's template or the
 *  empty string ("" = no fingerprint, docs/14 §2 amendment 11). */
function adviceAlternatives(c: Ctx, chosenAction: string): PlanAlternative[] {
  const out: PlanAlternative[] = [];
  const seen = new Set<string>();
  for (const pa of c.diagnosis?.proposedActions ?? []) {
    if (pa.action === chosenAction || seen.has(pa.action)) continue;
    seen.add(pa.action);
    // C6: validate the action enum BEFORE any table lookup, and resolve
    // every table through own-property-only access — `constructor` and
    // `__proto__` are inherited Object members, not fingerprints (§12(25)).
    const known = (PLANNER_SUPERVISOR_ACTIONS as readonly string[]).includes(pa.action);
    const a = pa.action as PlannerSupervisorAction;
    const templ = known ? tableGet(STRATEGY_TEMPLATES, pa.action) : undefined;
    const sid = isClosedFingerprint(c, pa.strategyId) ? pa.strategyId : (templ ?? '');
    out.push({
      decision: known ? (tableGet(ACTION_DECISION, a) ?? 'escalate') : 'escalate',
      action: known ? a : 'escalate',
      strategyId: sid,
      veto: 'advice-not-authority',
    });
  }
  return out;
}

function evidenceRefsOf(c: Ctx): string[] {
  // Copied, never invented (PC3/I3-S7): diagnosis refs then outcome refs.
  const refs: string[] = [];
  for (const r of [...(c.diagnosis?.evidenceRefs ?? []), ...(c.lastOutcome?.progressEvidence ?? [])]) {
    if (!refs.includes(r)) refs.push(r);
  }
  return refs;
}

// ─── The ladder (docs/14 §2 — TOTAL order, first match wins) ───────────────

function badInputPlan(): PlanRecommendation {
  return finalize({
    decision: 'escalate', action: 'escalate', strategyId: STRATEGY_TEMPLATES['escalate'],
    rationale: ['bad-input'], alternatives: [],
  });
}

/** §3 confidence bar for treating a diagnosis as actionable. */
const CONFIDENCE_BAR = 0.7;

function decide(c: Ctx): Seed {
  // L0 — identity unusable: acting on evidence the planner cannot parse
  // is inference from silence (I3). Bottom rung.
  if (c.bad) {
    return escalationSeed(['bad-input'], []);
  }

  // L1 — the ONLY path to finish: a live `complete` verdict (PC4).
  if (c.assessment?.verdict === 'complete') {
    return {
      decision: 'finish', action: 'accept-finish', strategyId: STRATEGY_TEMPLATES['accept-finish'],
      rationale: ['verdict:complete'], alternatives: [],
    };
  }

  // L2 — I5 latch: an ambiguous external effect parks (ownership not
  // provable) or escalates; no automated action may risk compounding it.
  if (c.ambiguous) {
    if (!c.ownershipProvable) {
      return escalationSeed(['i5:ambiguous-external-effect', 'park:ownership'], [], { action: 'park', strategyId: STRATEGY_TEMPLATES['park'] });
    }
    return escalationSeed(['i5:ambiguous-external-effect'], []);
  }

  // L3 — approval boundaries are human territory (§9.1).
  if (c.assessment?.verdict === 'blocked') {
    return escalationSeed(['verdict:blocked'], []);
  }
  if (c.diagnosis?.causeClass === 'approval-boundary' && c.diagnosis.confidence >= CONFIDENCE_BAR) {
    return escalationSeed(['approval-boundary'], []);
  }
  if (c.state === 'await-approval') {
    return escalationSeed(['state:await-approval'], []);
  }

  // L4 — budget exhaustion (§3): refuse the next act at the cap.
  if (c.facts.attemptsUsed >= c.caps.maxAttempts) {
    return budgetEscalation(c, 'budget:attempts');
  }
  if (c.facts.recoveryUsdUsed >= c.caps.maxUsd) {
    return budgetEscalation(c, 'budget:usd');
  }
  if (c.facts.recoveryTurnsUsed >= c.caps.maxTurns) {
    return budgetEscalation(c, 'budget:turns');
  }

  // L5 — uncertain verdict: bounded investigation if permitted.
  if (c.assessment?.verdict === 'uncertain') {
    return chainSeed(['verdict:uncertain'], [STEP_INVESTIGATE])(c);
  }

  // L6 — diagnosis-driven recovery, ended workers only (a LIVE worker's
  // cause is not yet evidence-complete — I3 — fall through to L8–L10).
  if (c.diagnosis && isEnded(c.state)) {
    const seed = causeRule(c);
    seed.alternatives = [...seed.alternatives, ...adviceAlternatives(c, seed.action)];
    return seed;
  }

  // L7 — live `incomplete` verdict on an ended worker: resume with the
  // verbatim remainingWork.
  if (c.assessment?.verdict === 'incomplete' && isEnded(c.state)) {
    const rw = c.assessment.remainingWork;
    const base = rw.length > 0 ? ['resume:evidence'] : ['resume:evidence', 'resume:generic'];
    const picked = chainPick(c, [STEP_RESUME]);
    if (picked.chosen) {
      return {
        decision: 'continue', action: 'evidence-nudge-resume', strategyId: picked.chosen.strategyId,
        rationale: base, alternatives: picked.vetoed,
        remainingWork: [...rw],
      };
    }
    return chainSeed([...base, ...picked.vetoed.map((v) => `veto:${v.veto}`)], [STEP_INVESTIGATE, STEP_SWAP, STEP_REWRITE])(c);
  }

  // L8 — loop facts on a live worker (§6). Recurrence is checked first:
  // the second same-guard fire across respawns prohibits nudging.
  if (c.state === 'warned' && c.sameGuardFires >= 2) {
    return chainSeed(['state:warned', 'guard:recurrence'], [STEP_INVESTIGATE, STEP_SWAP, STEP_REWRITE])(c);
  }
  if (c.state === 'warned') {
    return chainSeed(steerWithoutProgress(c) ? ['state:warned', 'uptake-not-progress'] : ['state:warned'],
      [STEP_NUDGE, STEP_INVESTIGATE, STEP_SWAP, STEP_REWRITE])(c);
  }
  // F1/C1: the failed-steer branch applies to ANY state that reached here
  // (ended workers included — a stopped worker with a no-progress steer
  // gets the loop-breaker chain, not the L11 silence fallback). The chain
  // holds no live-only actions (investigate/swap/rewrite all work on an
  // ended worker).
  if (steerWithoutProgress(c)) {
    const code = c.lastOutcome?.progress === 'uptake' ? 'uptake-not-progress' : 'steer-no-uptake';
    return chainSeed([code], [STEP_INVESTIGATE, STEP_SWAP, STEP_REWRITE])(c);
  }

  // L9 — live & healthy and nothing above fired: the `hold` sentinel
  // (§2.0). Not an intervention; cannot be executed by any executor.
  if (c.state === 'thinking' || c.state === 'tool') {
    return {
      decision: 'continue', action: 'hold', strategyId: STRATEGY_TEMPLATES['hold'],
      rationale: ['no-intervention-warranted'], alternatives: [],
    };
  }

  // L10 — unknown state is NEVER healthy (PC7/I3): investigate, else
  // escalate. Silence is not thinking.
  if (c.state === 'unknown') {
    return chainSeed(['i3:silence'], [STEP_INVESTIGATE])(c);
  }

  // L11 — structural fallback: ended (or any remaining) worker with no
  // verdict, no diagnosis, no loop facts.
  return chainSeed(['no-acceptance-evidence'], [STEP_INVESTIGATE])(c);
}

function budgetEscalation(c: Ctx, code: string): Seed {
  if (isLive(c.state) && !c.ownershipProvable) {
    return escalationSeed([code, 'park:ownership'], [], { action: 'park', strategyId: STRATEGY_TEMPLATES['park'] });
  }
  return escalationSeed([code], []);
}

/** §2 L6 cause table. `proposedActions` never promote themselves. */
function causeRule(c: Ctx): Seed {
  const d = c.diagnosis!;
  const cause = `cause:${d.causeClass}`;
  switch (d.causeClass) {
    case 'transient-endpoint':
      return chainSeed([cause], [STEP_RETRY, STEP_INVESTIGATE])(c);
    case 'premature-stop': {
      const seed = chainSeed([cause], [STEP_RESUME, STEP_SWAP, STEP_REWRITE])(c);
      if (seed.action === 'evidence-nudge-resume') {
        seed.remainingWork = [...(c.assessment?.remainingWork ?? [])];
        if (seed.remainingWork.length === 0) seed.rationale = [cause, 'resume:generic'];
      }
      return seed;
    }
    case 'task-defect': {
      const gate = repairGate(c);
      if (gate.ok) {
        return {
          decision: 'repair', action: 'repair', strategyId: gate.strategyId,
          rationale: [cause], alternatives: [],
          sideEffect: gate.external ? 'external' : 'worktree-local',
          authorityNeeded: gate.external ? 'external' : 'worktree-local',
          ...(gate.external ? { rung: 3 } : {}),
        };
      }
      const denials = gate.denials.map((x) => (x.startsWith('repeat') ? x : `authority:denied:${x}`));
      return chainSeed([cause, ...denials], [STEP_INVESTIGATE, STEP_SWAP, STEP_REWRITE])(c);
    }
    case 'environment-blocker':
      if (d.confidence >= CONFIDENCE_BAR) {
        return escalationSeed([cause, 'human-action-required'], []);
      }
      return chainSeed([cause, 'confidence:below-bar'], [STEP_INVESTIGATE])(c);
    case 'approval-boundary':
      // Confident case was handled at L3; unconfident ⇒ bounded look.
      return chainSeed([cause, 'confidence:below-bar'], [STEP_INVESTIGATE])(c);
    case 'unknown':
      return chainSeed([cause], [STEP_INVESTIGATE])(c);
  }
}

// ─── Finalize ──────────────────────────────────────────────────────────────

function finalize(seed: Seed): PlanRecommendation {
  const action = seed.action;
  const rec: PlanRecommendation = {
    decision: seed.decision,
    action,
    rung: seed.rung ?? ACTION_RUNG[action],
    sideEffect: seed.sideEffect ?? 'none',
    strategyId: seed.strategyId,
    rationale: seed.rationale,
    evidenceRefs: [],
    alternatives: seed.alternatives,
    authorityNeeded: seed.authorityNeeded ?? 'none',
    notAPermission: true,
  };
  if (seed.expectedEvidence !== undefined) rec.expectedEvidence = seed.expectedEvidence;
  if (seed.model !== undefined) rec.model = seed.model;
  if (seed.remainingWork !== undefined) rec.remainingWork = seed.remainingWork;
  return rec;
}

// ─── Entry point ───────────────────────────────────────────────────────────

/**
 * Pure classification function (docs/14 §0). NEVER throws (PC1); same
 * input → deep-equal output (PC2); the recommendation is advice that P8
 * re-checks and P11 executes — it is not a permission (PC3) and never a
 * verdict (PC4/I7). A hostile or malformed input bottoms out at
 * `escalate` with rationale `bad-input`.
 */
export function planRecovery(input: PlannerInput): PlanRecommendation {
  let c: Ctx;
  try {
    c = sanitize(input);
  } catch {
    return badInputPlan();
  }
  let seed: Seed;
  try {
    seed = decide(c);
  } catch {
    return badInputPlan();
  }
  // F8/C3: finalize + evidence extraction run INSIDE the fail-closed
  // boundary — nothing after validation may throw past PC1.
  try {
    if (c.note) seed.rationale = [...seed.rationale, c.note];
    const rec = finalize(seed);
    rec.evidenceRefs = evidenceRefsOf(c);
    const exp = EXPECTED_EVIDENCE[rec.action];
    if (exp !== undefined) rec.expectedEvidence = exp;
    return rec;
  } catch {
    return badInputPlan();
  }
}
