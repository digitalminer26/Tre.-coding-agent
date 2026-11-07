/**
 * P9/M1 — Supervisor composition: the single-worker closed recovery loop.
 * Contract: docs/18 (docs/11 §11 P9 row). This module is the ONE place the
 * recovery modules meet, and it imports NOTHING at runtime — not even
 * `node:` (guard test). Every collaborator arrives as a port:
 *   planner (P10) · executor (P11) · runner (P7) · gate (P8, host-adapter)
 *   accept (P14) · investigate (P15) · journal (P4) · steer (P3b).
 *
 * The loop (docs/18 §1): sense (terminal attempt / refusal outcome) →
 * diagnose-if-unknown (P15, local caps) → plan (P10) → steer poll (P3b:
 * shutdown / model override) → execute (P11, or the gated initial run via
 * P7) → accept? (P14 gates `accept-finish`) → journal (P4, schema-valid
 * SupervisorRecords) → loop (the outcome is the next signal).
 *
 * M1 obligations that live nowhere else:
 *  - reservation discipline (docs/18 §2): the initial run reserves under
 *    the gate and closes with a real attestation on a confirmed exit, or
 *    request-only (unattested) when the child's outcome is unproven;
 *  - termination (docs/18 §3): every stop names itself, journals first,
 *    and closes the episode wall; the loop NEVER re-throws into the host;
 *  - investigation verdict ledger (docs/18 §6): one `diagnosis` journal
 *    record per investigation, cost recorded via recordManualSpend, and
 *    the verdict is handed to the PLANNER as evidence — never auto-executed;
 *  - acceptance gate on finish (docs/18 §7): a rejected finish converts
 *    to a premature-stop-class signal, once per attempt.
 *
 * Journal authority: every record this module appends passes the P4
 * validator (kinds: decision-intent / decision-outcome / diagnosis /
 * acceptance — no invented kinds; M1 events ride inside those).
 */

// ─── Mirrored closed enums (pinned 1:1 by test/supervisor-compose.test.ts) ─

/** Mirror of `PLANNER_SUPERVISOR_ACTIONS` / journal `SUPERVISOR_ACTIONS`. */
export const SUPERVISOR_ACTIONS = [
  'nudge', 'evidence-nudge-resume', 'model-swap', 'task-rewrite', 'escalate',
  'kill', 'park', 'merge', 'backoff-retry', 'investigate', 'repair', 'accept-finish',
] as const;
export type SupervisorAction = (typeof SUPERVISOR_ACTIONS)[number];

/** Mirror of `RECOVERY_DECISIONS` (planner / executor). */
export const RECOVERY_DECISIONS = ['finish', 'continue', 'investigate', 'repair', 'change-approach', 'escalate'] as const;

/** Mirror of `PLANNER_CAUSE_CLASSES` / journal causeClass. */
export const CAUSE_CLASSES = [
  'transient-endpoint', 'premature-stop', 'task-defect', 'environment-blocker', 'approval-boundary', 'unknown',
] as const;

/** Mirror of `PLANNER_VERDICTS` (acceptance verdicts). */
export const VERDICTS = ['complete', 'incomplete', 'blocked', 'uncertain'] as const;
export type AcceptanceVerdict = (typeof VERDICTS)[number];

/** Mirror of `DECISION_SIGNAL_KINDS` (journal, closed set). The loop maps
 *  every outcome into this vocabulary — it never invents signal kinds. */
export const SIGNAL_KINDS = [
  'guard-stop', 'warn-rung', 'semantic-loop', 'verify-gap', 'no-advance',
  'endpoint-error', 'budget-threshold', 'worker-exit', 'worker-blocked-on-approval',
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** Mirror of `RESERVATION_CLOSE_REASONS` (P8). */
export const CLOSE_REASONS = ['settled', 'released', 'expired', 'abandoned'] as const;

// ─── Ports (the full authority surface, docs/18 §0.2) ──────────────────────

export interface GateRequestLike {
  action: string;
  actionId: string;
  taskId?: string;
  attemptId?: string;
  authority: { grantedBy: string; sideEffect: 'none' | 'worktree-local' | 'external' };
  model?: string;
  strategyId?: string;
}

export interface GatePort {
  /** host adapter: BudgetSnapshot refresh + check() → CheckResult shape. */
  check(request: GateRequestLike): Promise<{ allowed: boolean; denials?: { code: string; detail: string }[]; receipt?: unknown }>;
  /** host adapter: ledger.reserve(policy, request, receipt) — throws iff
   *  the action is NOT admitted. Resolves with the open record; the real
   *  ledger ALWAYS returns it (its signature is Promise<ReservationOpen-
   *  Record>), so a missing id is a host-contract violation (logged). */
  reserve(request: GateRequestLike, receipt: unknown): Promise<{ id?: string } | void>;
  /** host adapter: ledger.closeReservation(refId, reason, attest?). */
  closeReservation(refId: string, reason: typeof CLOSE_REASONS[number], attest?: { outcome: string; evidence: string }): Promise<unknown>;
  /** host adapter: ledger.ingestSession (idempotent by entry id). */
  ingestSession?(sessionPath: string, scope: { episodeId: string; taskId?: string; attemptId?: string }): Promise<unknown>;
  /** host adapter: ledger.recordManualSpend. */
  recordManualSpend?(spend: { lineId: string; model: string; provider: string; usage: { input: number; output: number }; note?: string }, scope: { episodeId: string; taskId?: string }): Promise<unknown>;
  /** host adapter: ledger.recordWallclock. */
  recordWallclock?(scope: { episodeId: string; taskId: string }, seconds: number): Promise<unknown>;
}

export interface AttemptHandleLike {
  attemptId?: string;
  session?: string;
  exited?: Promise<{ code?: number | null; signal?: string | null }>;
}

export interface RunnerPort {
  run(task: { episodeId: string; taskId: string; session: string; attemptId?: string; model?: string; worktreePath?: string }): Promise<AttemptHandleLike>;
  /** P7 reconcile — passed through to the executor untouched. */
  reconcile?(task: object): Promise<{ decision?: { action?: string } } & object>;
  resume?(task: object, attemptId: string): Promise<AttemptHandleLike>;
  stop?(handle: { session: string }): Promise<{ stopped?: boolean } | unknown>;
  /** host preflight: drainPendingIntents / reconcile (docs/18 step A). */
  preflight?(ctx: { episodeId: string; taskId: string }): Promise<unknown>;
}

export interface JournalPort { append(record: object): Promise<void>; read?(): Promise<unknown>; }

export interface SteerPort {
  /** host adapter over FileSteeringQueue.drain(): texts pending this
   *  iteration + a shutdown flag. */
  poll(): Promise<{ texts?: string[]; shutdown?: boolean } | void>;
}

export interface ExecutorPortsBase {
  journal: JournalPort;
  gate?: unknown;
  steer?: unknown;
  dispatch?: object;
  delay?: (ms: number) => Promise<void>;
}

export interface ComposePorts {
  planner: { planRecovery(input: object): object };
  executor: { executeRecoveryAction(plan: object, ctx: object, ports: object): Promise<ExecResultLike> };
  executorPorts: ExecutorPortsBase;
  runner?: RunnerPort;
  gate?: GatePort;
  // P16: the host's accept port collects REAL evidence (runs the policy
  // gate, observes artifacts) before evaluating, so it may be async —
  // the loop awaits; a synchronous port stays valid (await on a value).
  accept?: { evaluate(input: object): { verdict?: string; remainingWork?: string[]; reasons?: string[] } | object | Promise<{ verdict?: string; remainingWork?: string[]; reasons?: string[] } | object> };
  investigate?: (packet: object, limits: { maxToolCalls?: number; maxUsd?: number }) => Promise<object>;
  journal: JournalPort;
  steer?: SteerPort;
  now: () => number;
  log?: (line: string) => void;
}

export interface ExecResultLike {
  actionId?: string;
  action?: string;
  status?: string;
  stage?: string;
  reason?: string;
  denials?: { code: string; detail: string }[];
  attemptId?: string;
  evidenceRefs?: string[];
  error?: { name?: string; message?: string };
}

// ─── Config & result ───────────────────────────────────────────────────────

export interface SupervisorConfig {
  episodeId: string;
  taskId: string;
  taskRevision?: number;
  /** The grant identity for every gate request + journal record. */
  grantedBy: string;
  /** Worker spawn target for the initial run (docs/18 step B). */
  worker?: { session: string; attemptId?: string; model?: string; worktreePath?: string };
  /** Authority surface passed through to the planner verbatim. */
  authority: object;
  /** P14 inputs (spec + artifact identity); absent = finish unjudged. */
  acceptance?: { spec: object; current?: object };
  recoveryBudget?: object;
  /** docs/18 §3: the loop-structure cap the planner caps cannot express. */
  maxIterations?: number;
  /** docs/18 §6 local enforcement (the planner's diagnostic budget still
   *  gates what the PLAN may propose; these bound the loop's own offers). */
  investigation?: { sameSignatureMax?: number; episodeMax?: number; limits?: { maxToolCalls?: number; maxUsd?: number } };
}

export const STOP_REASONS = [
  'accepted-finish', 'finish-unjudged', 'halt', 'hold', 'escalation-exhausted',
  'parked', 'shutdown', 'max-iterations', 'loop-error', 'no-initial-signal',
  'initial-run-denied', 'completed',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export interface SupervisorIteration {
  seq: number;
  signal: string;
  decision: string;
  action: string;
  strategyId?: string;
  execStatus?: string;
  execReason?: string;
}

export interface SupervisorResult {
  stopped: StopReason;
  detail?: string;
  iterations: SupervisorIteration[];
  investigationCount: number;
  error?: { name: string; message: string };
}

// ─── Internal state ────────────────────────────────────────────────────────

interface LoopSignal {
  kind: SignalKind;
  detail?: string;
  /** true once this signal has consumed a model override from steering. */
  overrideModel?: string;
}

const MAX_DETAIL = 240;
const DEFAULT_MAX_ITERATIONS = 64;

function isObj(v: unknown): v is Record<string, unknown> {
  try { return typeof v === 'object' && v !== null && !Array.isArray(v); } catch { return false; }
}
function str(v: unknown, max = MAX_DETAIL): string | undefined {
  return typeof v === 'string' && v.length > 0 ? (v.length > max ? v.slice(0, max) : v) : undefined;
}

/** P11's ExecutionResult → the next loop signal (docs/18 §1 step 8).
 *  Closed mapping: the loop never invents failures it did not observe. */
function signalFromExec(res: ExecResultLike | undefined, exit: { code?: number | null; signal?: string | null } | undefined): LoopSignal {
  if (exit !== undefined) {
    if (typeof exit.code === 'number' && exit.code === 0) return { kind: 'worker-exit', detail: 'exit-0' };
    if (typeof exit.code === 'number') return { kind: 'endpoint-error', detail: `exit-${exit.code}` };
    return { kind: 'endpoint-error', detail: `killed-${exit.signal ?? 'signal'}` };
  }
  if (res === undefined) return { kind: 'no-advance', detail: 'no-outcome' };
  if (res.status === 'refused') {
    if ((res.stage ?? '').includes('gate') || (res.reason ?? '').includes('gate')) return { kind: 'budget-threshold', detail: str(res.reason) ?? 'gate-refused' };
    return { kind: 'no-advance', detail: `refused-${str(res.reason) ?? 'unknown'}` };
  }
  if (res.status === 'failed') return { kind: 'endpoint-error', detail: `failed-${str(res.error?.message) ?? 'act'}` };
  if (res.status === 'held') return { kind: 'no-advance', detail: 'held' };
  // executed with no attempt and no exit: the worker may still be running;
  // the loop's next sense is bounded by the iteration cap, not by spin.
  return { kind: 'no-advance', detail: 'executed-no-visible-exit' };
}

// ─── The loop ──────────────────────────────────────────────────────────────

/** Run the closed recovery loop for ONE task in ONE episode (docs/18 §1).
 *  Never throws: every internal failure stops with `loop-error`. */
export async function runSupervisorEpisode(cfg: SupervisorConfig, ports: ComposePorts): Promise<SupervisorResult> {
  // AC6 (docs/18 §9): a malformed host call must never throw into the host.
  // A null cfg/ports cannot journal (no port), so it stops with a plain
  // loop-error result BEFORE any port is touched.
  if (!isObj(cfg) || !isObj(ports)) {
    return { stopped: 'loop-error', iterations: [], investigationCount: 0, error: { name: 'config', message: 'cfg and ports are required objects' } };
  }
  // A throwing clock must not escape (docs/18 §9 loop-error contract):
  // every wall/record timestamp goes through this clamp.
  const safeNow = (): number => { try { const t = ports.now(); return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : 0; } catch { return 0; } };
  const started = safeNow();
  const iterations: SupervisorIteration[] = [];
  const inv = {
    sameSignatureMax: isObj(cfg.investigation) ? (typeof cfg.investigation['sameSignatureMax'] === 'number' ? Math.max(0, Math.trunc(cfg.investigation['sameSignatureMax'] as number)) : 1) : 1,
    episodeMax: isObj(cfg.investigation) ? (typeof cfg.investigation['episodeMax'] === 'number' ? Math.max(0, Math.trunc(cfg.investigation['episodeMax'] as number)) : 2) : 2,
  };
  const investigationBySignature = new Map<string, number>();
  let investigationCount = 0;
  let consecutiveEscalate = 0;
  let finishRejects = 0;
  let seq = 0;
  let lastSignal: LoopSignal | undefined;
  let lastAttemptId: string | undefined;
  let lastSession: string | undefined;
  let lastOutcome: { action: string; strategyId: string; progress: 'none' | 'uptake' | 'task-relevant' } | undefined;
  let lastDiagnosis: Record<string, unknown> | undefined;
  const strategyUses: Record<string, number> = {};
  let recoveryTurnsUsed = 0;
  let diagnosticToolCallsUsed = 0;
  let diagnosticUsdUsed = 0;
  let attemptsUsed = 0;
  let nudgesUsed = 0;
  const evidence: string[] = [];

  const log = (line: string) => { try { ports.log?.(line); } catch { /* logging is not authority */ } };
  let recSeq = 0;

  /** Journal append is best-effort: append failure ≠ recovery failure
   *  (docs/18 §5), and a ledger/journal throw must never escape. */
  const journalAppend = async (record: Record<string, unknown>): Promise<void> => {
    try { await ports.journal.append(record); }
    catch (e) { log(`journal-append-failed: ${(e as Error)?.name ?? 'error'}`); }
  };
  // R5-3/R5-4 + R6-1/R6-2: the journal is the proof of no-effect. A
  // refused/failed result is only released when the executor journaled
  // `no-effect:` for the SAME actionId — res itself is port-returned data
  // and untrusted. R6: a bare backward scan for the last matching outcome
  // is NOT tight enough: actionId is a content digest (exec.ts:631) and an
  // identical repeated plan collides, so a stale `no-effect:` from a prior
  // execution could prove a LATER act (whose own outcome append was lost)
  // was no-effect when its effect actually landed. The proof window: the
  // executor always appends its fresh intent BEFORE the outcome (§14.3),
  // so walking backward over this actionId's records, the FIRST match must
  // be a decision-outcome; hitting a decision-intent first means the
  // outcome write was lost (effect unknown → expiry backstops). A stale
  // outcome from a prior execution sits before the fresh intent and is
  // never reached. The scan is capped (R6-2): past the cap it is
  // conservative false, never a full-journal walk per act.
  const journaledNoEffect = async (actionId: string | undefined): Promise<boolean> => {
    if (actionId === undefined) return false;
    try {
      if (typeof ports.journal.read !== 'function') return false;
      const read = await ports.journal.read();
      const recs = (read as { records?: unknown })?.records;
      if (!Array.isArray(recs)) return false;
      const MAX_SCAN = 4096;
      for (let i = recs.length - 1, seen = 0; i >= 0 && seen < MAX_SCAN; i -= 1, seen += 1) {
        const r = recs[i] as Record<string, unknown> | undefined;
        if (r?.actionId !== actionId) continue;
        if (r.kind === 'decision-outcome') return typeof r.notes === 'string' && /(^| )no-effect:/.test(r.notes);
        if (r.kind === 'decision-intent') return false;
      }
      return false;
    } catch { return false; }
  };

  // R3/F17 (I2 pairing on EVERY exit): the id of a journaled
  // decision-intent that has not yet received its decision-outcome.
  // Any return/continue/throw that skips the executor must close it
  // first, or openIntents() reports a permanently open action.
  let pendingIntentId: string | undefined;
  const closeIntent = async (acked: boolean, notes: string): Promise<void> => {
    if (pendingIntentId === undefined) return;
    const id = pendingIntentId;
    pendingIntentId = undefined;
    await journalAppend({ ...envelope(), kind: 'decision-outcome', actionId: id, acked, progress: 'none', notes: notes.slice(0, 4096) });
  };

  // docs/18 §7: the planner's L1 rule (its ONLY path to `finish`) fires
  // only on a live `complete` assessment in ITS input — so M1 runs
  // evaluateCompletion on the clean-exit trigger and feeds the verdict
  // to the planner as evidence. Without this wiring a clean exit can
  // never be accepted (and would escalate). One evaluation per trigger;
  // the accept-finish branch re-evaluates fresh before honoring it.
  let acceptanceAssessment: { verdict: string; remainingWork: string[]; reasons: string[] } | undefined;
  const evaluateAcceptance = async (): Promise<void> => {
    if (ports.accept === undefined || cfg.acceptance === undefined) return;
    let verdict: string | undefined;
    let remaining: string[] = [];
    let reasons: string[] = [];
    try {
      const a = await ports.accept.evaluate({ taskId: cfg.taskId, taskRevision: cfg.taskRevision ?? 1, spec: cfg.acceptance.spec, ...(cfg.acceptance.current !== undefined ? { current: cfg.acceptance.current } : {}), gates: [], artifacts: [], claims: [], blockers: [], evidenceRefs: [...evidence], now: safeNow() });
      if (isObj(a)) {
        verdict = str(a['verdict'], 32);
        if (Array.isArray(a['remainingWork'])) remaining = (a['remainingWork'] as unknown[]).filter((r): r is string => typeof r === 'string');
        if (Array.isArray(a['reasons'])) reasons = (a['reasons'] as unknown[]).filter((r): r is string => typeof r === 'string');
      }
    } catch { log('acceptance-evaluate-failed'); return; }
    if (!(VERDICTS as readonly string[]).includes(verdict ?? '') || verdict === undefined) { log('acceptance-verdict-unreadable'); return; }
    // the verdict is journalized (docs/18 §7).
    await journalAppend({ ...envelope(), kind: 'acceptance', taskRevision: cfg.taskRevision ?? 1, verdict, criteria: [], remainingWork: remaining });
    acceptanceAssessment = { verdict, remainingWork: remaining, reasons };
  };
  const envelope = () => ({ schema: 'tre-supervisor/1', id: `d-${String((cfg as { episodeId?: unknown }).episodeId ?? 'x')}-${String((cfg as { taskId?: unknown }).taskId ?? 'x')}-${recSeq += 1}`, ts: safeNow(), episodeId: String((cfg as { episodeId?: unknown }).episodeId ?? ''), taskId: String((cfg as { taskId?: unknown }).taskId ?? '') });

  const finish = async (stopped: StopReason, detail?: string, error?: { name: string; message: string }): Promise<SupervisorResult> => {
    // step D (docs/18): close the episode wall — best-effort, always.
    if (ports.gate?.recordWallclock) {
      const seconds = Math.max(0, (safeNow() - started) / 1000);
      try { await ports.gate.recordWallclock({ episodeId: cfg.episodeId, taskId: cfg.taskId }, seconds); }
      catch (e) { log(`wallclock-close-failed: ${(e as Error)?.name ?? 'error'}`); }
    }
    return { stopped, ...(detail !== undefined ? { detail } : {}), iterations, investigationCount, ...(error !== undefined ? { error } : {}) };
  };

  try {
    if (typeof cfg.episodeId !== 'string' || cfg.episodeId.length === 0 || typeof cfg.taskId !== 'string' || cfg.taskId.length === 0 || typeof cfg.grantedBy !== 'string' || cfg.grantedBy.length === 0) {
      // R3/F16: an invalid identity writes NOTHING — no wallclock under
      // unvalidated ids either (finish() would spend the gate port).
      return { stopped: 'loop-error' as StopReason, iterations, investigationCount, error: { name: 'config', message: 'episodeId, taskId and grantedBy are required' } };
    }
    // R3/F13: a non-finite or non-integer cap (NaN, Infinity, 0.5) makes
    // `seq > cap` never fire → unbounded loop. Fall back to the default
    // rather than trust the host's number.
    const maxIterations = Number.isSafeInteger(cfg.maxIterations) && (cfg.maxIterations as number) >= 0
      ? (cfg.maxIterations as number)
      : DEFAULT_MAX_ITERATIONS;

    // ── step A: preflight (drain pending intents / reconcile) ───────────
    try { await ports.runner?.preflight?.({ episodeId: cfg.episodeId, taskId: cfg.taskId }); }
    catch (e) { log(`preflight-failed: ${(e as Error)?.name ?? 'error'}`); }

    // ── step B: initial run under the gate (docs/18 §2.1) ───────────────
    if (ports.runner && cfg.worker) {
      const task = { episodeId: cfg.episodeId, taskId: cfg.taskId, session: cfg.worker.session, ...(cfg.worker.attemptId ? { attemptId: cfg.worker.attemptId } : {}), ...(cfg.worker.model ? { model: cfg.worker.model } : {}), ...(cfg.worker.worktreePath ? { worktreePath: cfg.worker.worktreePath } : {}) };
      const req: GateRequestLike = { action: 'run', actionId: `sup-${cfg.episodeId}-${cfg.taskId}-start-0`, taskId: cfg.taskId, authority: { grantedBy: cfg.grantedBy, sideEffect: 'none' }, ...(cfg.worker.model ? { model: cfg.worker.model } : {}), strategyId: 'start:initial:v1' };
      let refId: string | undefined;
      let reserved = false;
      // R4/F19 (docs/18 §0.2): an absent port is a recorded refusal, never
      // a bypass — no gate means no ledgered initial run, so refuse.
      if (!ports.gate) {
        await journalAppend({ ...envelope(), kind: 'decision-outcome', actionId: req.actionId, acked: false, progress: 'none', notes: 'supervisor: initial-run-denied port-missing:gate' });
        return await finish('initial-run-denied', 'port-missing:gate');
      }
      {
        let chk: { allowed?: boolean; denials?: { code: string }[]; receipt?: unknown } | undefined;
        try {
          chk = await ports.gate.check(req);
        } catch (e) {
          // R3/F15: a throw is a DENIAL and must be journalized (docs/18
          // §2.2) under the same actionId as the checked-denial path.
          await journalAppend({ ...envelope(), kind: 'decision-outcome', actionId: req.actionId, acked: false, progress: 'none', notes: `supervisor: initial-run-denied check-threw-${(e as Error)?.name ?? 'error'}`.slice(0, 4096) });
          return await finish('initial-run-denied', `check-threw-${(e as Error)?.name ?? 'error'}`);
        }
        if (chk?.allowed !== true) {
          const codes = (chk?.denials ?? []).map((d) => d.code).join(',') || 'none';
          // F5: the denial is a STOPPED non-action, not an intent —
          // journaling an intent here would leave it permanently open
          // (I2 openIntents) for an action that will never run.
          await journalAppend({ ...envelope(), kind: 'decision-outcome', actionId: req.actionId, acked: false, progress: 'none', notes: `supervisor: initial-run-denied ${codes}`.slice(0, 4096) });
          return await finish('initial-run-denied', codes);
        }
        try {
          const openRec = await ports.gate.reserve(req, chk.receipt);
          reserved = true;
          refId = isObj(openRec) ? str(openRec['id']) : undefined;
          if (refId === undefined) {
            // R4/F20: without an id nothing can be closed later. Refuse the
            // spawn (fail closed) instead of leaving an unclosable
            // reservation open.
            await journalAppend({ ...envelope(), kind: 'decision-outcome', actionId: req.actionId, acked: false, progress: 'none', notes: 'supervisor: initial-run-denied reserve-returned-no-id' });
            return await finish('initial-run-denied', 'reserve-returned-no-id');
          }
        } catch (e) {
          // Ledger throws fail closed: no unledgered initial run (docs/18 §5),
          // and the denial is journalized (docs/18 §2.2, R3/F15).
          await journalAppend({ ...envelope(), kind: 'decision-outcome', actionId: req.actionId, acked: false, progress: 'none', notes: `supervisor: initial-run-denied reserve-threw-${(e as Error)?.name ?? 'error'}`.slice(0, 4096) });
          return await finish('initial-run-denied', `reserve-threw-${(e as Error)?.name ?? 'error'}`);
        }
      }
      let handle: AttemptHandleLike | undefined;
      try {
        handle = await ports.runner.run(task);
      } catch (e) {
        if (reserved && refId) { try { await ports.gate?.closeReservation(refId, 'released', undefined); } catch { /* request-only release */ } }
        lastSignal = { kind: 'endpoint-error', detail: `initial-run-threw-${(e as Error)?.name ?? 'error'}` };
      }
      if (handle === undefined) {
        // R3/F14: run() resolved with no handle (contract violation, not
        // a throw) — the reservation must still close and the stop must
        // carry a signal, never a silent 'no-initial-signal' with an
        // open reservation.
        if (reserved && refId) { try { await ports.gate?.closeReservation(refId, 'released', undefined); } catch { /* request-only release */ } }
        lastSignal = { kind: 'endpoint-error', detail: 'initial-run-returned-no-handle' };
      }
      if (handle !== undefined) {
        attemptsUsed += 1;
        acceptanceAssessment = undefined; // a verdict must not outlive the attempt it judged
        let exit: { code?: number | null; signal?: string | null } | undefined;
        try { exit = await handle.exited; } catch { exit = undefined; }
        // ingest the real spend before anything else (refresh-first).
        const session = str(handle.session) ?? task.session;
        const attemptId = str(handle.attemptId);
        if (attemptId !== undefined) lastAttemptId = attemptId;
        lastSession = session;
        try { await ports.gate?.ingestSession?.(session, { episodeId: cfg.episodeId, taskId: cfg.taskId, ...(attemptId ? { attemptId } : {}) }); }
        catch { log('ingest-session-failed (initial run)'); }
        // close the reservation: attested on a PROVEN exit, else
        // request-only (unattested — the ledger re-checks on next reserve).
        if (reserved && refId) {
          const proven = exit !== undefined && (typeof exit.code === 'number' || exit.signal != null);
          try {
            await ports.gate!.closeReservation(refId, proven ? 'settled' : 'released', proven
              ? { outcome: `attempt-exited code-${exit!.code ?? 'null'} signal-${exit!.signal ?? 'null'}`, evidence: `session:${session}` }
              : undefined);
          } catch (e) { log(`close-reservation-failed: ${(e as Error)?.name ?? 'error'}`); }
        }
        lastSignal = exit === undefined
          ? { kind: 'endpoint-error', detail: 'initial-run-exit-unobserved' }
          : signalFromExec(undefined, exit);
      }
    }

    // ── step C: the recovery loop ───────────────────────────────────────
    while (lastSignal !== undefined) {
      seq += 1;
      // R3/F18 (docs/18 §3: "No stop may ever skip step 7 (journalize)"):
      // every stop that returns writes a decision-outcome first.
      if (seq > maxIterations) {
        await journalAppend({ ...envelope(), kind: 'decision-outcome', actionId: `sup-${cfg.episodeId}-${cfg.taskId}-stop-${seq}`, acked: false, progress: 'none', notes: `supervisor: stop max-iterations cap-${maxIterations}` });
        return await finish('max-iterations', `cap-${maxIterations}`);
      }
      const signal = lastSignal;
      const cur: SupervisorIteration = { seq, signal: `${signal.kind}:${signal.detail ?? ''}`, decision: '', action: '' };
      iterations.push(cur);

      // 4a. steering poll (docs/18 §4): shutdown stops BEFORE execute;
      // pending texts may override the next plan's model target only.
      let overrideModel: string | undefined;
      if (ports.steer) {
        let steered: { texts?: string[]; shutdown?: boolean } | void;
        try { steered = await ports.steer.poll(); } catch { steered = undefined; }
        if (steered?.shutdown === true) {
          await journalAppend({ ...envelope(), kind: 'decision-outcome', actionId: `sup-shutdown-${seq}`, acked: false, progress: 'none', notes: 'supervisor: shutdown requested via steering' });
          return await finish('shutdown');
        }
        for (const t of steered?.texts ?? []) {
          const m = /^model:([A-Za-z0-9][A-Za-z0-9._-]{0,255})$/.exec(t ?? '');
          // R4/F21: a superseded override is recorded, never silently lost.
          if (m) {
            if (overrideModel !== undefined) {
              await journalAppend({ ...envelope(), kind: 'decision-outcome', actionId: `sup-steer-${seq}-${overrideModel}`, acked: false, progress: 'none', notes: `supervisor: steer model:${overrideModel} superseded by a later model override` });
            }
            overrideModel = m[1];
          }
        }
      }

      // docs/18 §7: a clean worker exit is finish EVIDENCE, not a verdict.
      // Evaluate once per trigger; the verdict rides into the plan input
      // (planner L1 is the only path to `finish` — PC4).
      if (signal.kind === 'worker-exit' && acceptanceAssessment === undefined) {
        await evaluateAcceptance();
      }

      // 2. diagnose-if-unknown (docs/18 §6): offered only for
      // ambiguous-class signals — the kinds that carry their own cause
      // (endpoint failure, budget, approval boundary) leave nothing for
      // P15 to learn. Bounded per signature and per episode; the verdict
      // is EVIDENCE for the planner, never an order to execute.
      const DETERMINISTIC_SIGNAL_KINDS: readonly string[] = ['endpoint-error', 'budget-threshold', 'worker-blocked-on-approval'];
      if (ports.investigate !== undefined && !DETERMINISTIC_SIGNAL_KINDS.includes(signal.kind)) {
        const signature = `${signal.kind}|${signal.detail ?? ''}`;
        const seen = investigationBySignature.get(signature) ?? 0;
        if (seen < inv.sameSignatureMax && investigationCount < inv.episodeMax && (lastDiagnosis === undefined || lastDiagnosis['signature'] !== signature)) {
          investigationBySignature.set(signature, seen + 1);
          investigationCount += 1;
          const packet = { id: `inv-${cfg.episodeId}-${seq}`, episodeId: cfg.episodeId, taskId: cfg.taskId, signal: { kind: signal.kind }, signalDetail: signal.detail, evidenceRefs: [...evidence] };
          let diag: Record<string, unknown> | undefined;
          try {
            const raw = await ports.investigate(packet, cfg.investigation?.limits ?? {});
            diag = isObj(raw) ? raw : undefined;
          } catch (e) { log(`investigate-threw: ${(e as Error)?.name ?? 'error'}`); }
          if (diag !== undefined) {
            // F7: the verdict is a MIRROR enum — a host P15 returning a
            // causeClass outside CAUSE_CLASSES would make the diagnosis
            // record schema-invalid (silently dropped) AND leak a value
            // the planner cannot classify. Normalize before BOTH sinks.
            const causeClassRaw = str(diag['causeClass'], 64);
            const causeClass = (CAUSE_CLASSES as readonly string[]).includes(causeClassRaw ?? '') ? causeClassRaw as typeof CAUSE_CLASSES[number] : 'unknown';
            const confidence = typeof diag['confidence'] === 'number' && Number.isFinite(diag['confidence'] as number) ? Math.min(1, Math.max(0, diag['confidence'] as number)) : 0;
            const dEvidence = Array.isArray(diag['evidenceRefs']) ? (diag['evidenceRefs'] as unknown[]).filter((r): r is string => typeof r === 'string') : [];
            const limits = isObj(diag['limitsRespected']) ? diag['limitsRespected'] as Record<string, unknown> : undefined;
            const toolsUsed = typeof limits?.['toolsUsed'] === 'number' && Number.isFinite(limits['toolsUsed']) ? Math.max(0, Math.trunc(limits['toolsUsed'] as number)) : 0;
            const spendUsd = typeof limits?.['spendUsd'] === 'number' && Number.isFinite(limits['spendUsd']) ? Math.max(0, limits['spendUsd'] as number) : 0;
            diagnosticToolCallsUsed += toolsUsed;
            diagnosticUsdUsed += spendUsd;
            // verdict ledger: ONE diagnosis record per investigation (the
            // P15 record IS the verdict — M1 adds no confidence of its own).
            await journalAppend({ ...envelope(), kind: 'diagnosis', ...(str(diag['attemptId'], 256) !== undefined ? { attemptId: str(diag['attemptId'], 256) } : {}), causeClass, confidence, ...(dEvidence.length > 0 ? { evidenceRefs: dEvidence } : {}), ...(limits !== undefined ? { limitsRespected: { toolsUsed, spendUsd } } : {}) });
            // investigation cost → the ledger, per docs/18 §6.
            try {
              await ports.gate?.recordManualSpend?.({ lineId: `sup-inv-${cfg.episodeId}-${seq}`, model: 'investigation', provider: 'supervisor', usage: { input: 0, output: 0 }, note: `P15 estimate spendUsd=${spendUsd} toolsUsed=${toolsUsed}` }, { episodeId: cfg.episodeId, taskId: cfg.taskId });
            } catch { log('investigation-spend-not-recorded'); }
            evidence.push(...dEvidence.map((r) => `inv:${r}`));
            lastDiagnosis = { signature, causeClass, confidence, evidenceRefs: dEvidence, proposedActions: Array.isArray(diag['proposedActions']) ? diag['proposedActions'] : [] };
          }
        }
      }

      // 3. plan (P10 owns classification AND the action choice).
      const planInput = {
        taskId: cfg.taskId,
        taskRevision: cfg.taskRevision ?? 1,
        worker: { state: 'stopped', detail: signal.detail, warnCount: signal.kind === 'warn-rung' ? 1 : 0, sameGuardFires: signal.kind === 'guard-stop' ? 2 : 0, toolCallsThisAttempt: 0 },
        ...(lastOutcome !== undefined ? { lastOutcome: { action: lastOutcome.action, strategyId: lastOutcome.strategyId, progress: lastOutcome.progress } } : {}),
        ...(acceptanceAssessment !== undefined ? { acceptance: { live: true, assessment: { verdict: acceptanceAssessment.verdict, taskId: cfg.taskId, taskRevision: cfg.taskRevision ?? 1, remainingWork: acceptanceAssessment.remainingWork, reasons: acceptanceAssessment.reasons } } } : {}),
        ...(lastDiagnosis !== undefined && typeof lastDiagnosis['causeClass'] === 'string'
          ? { diagnosis: { causeClass: lastDiagnosis['causeClass'], confidence: lastDiagnosis['confidence'] as number, evidenceRefs: lastDiagnosis['evidenceRefs'] as string[], ...(Array.isArray(lastDiagnosis['proposedActions']) && (lastDiagnosis['proposedActions'] as unknown[]).length > 0 ? { proposedActions: lastDiagnosis['proposedActions'] } : {}) } }
          : {}),
        authority: cfg.authority,
        ...(cfg.recoveryBudget !== undefined ? { recoveryBudget: cfg.recoveryBudget } : {}),
        facts: { attemptsUsed, nudgesUsed, steerGuardResets: 0, strategyUses: { ...strategyUses }, recoveryUsdUsed: diagnosticUsdUsed, recoveryTurnsUsed, diagnosticToolCallsUsed, diagnosticUsdUsed, otherApprovedModels: Array.isArray((cfg.authority as { models?: unknown } | undefined)?.models) ? (cfg.authority as { models: unknown[] }).models.filter((m): m is string => typeof m === 'string') : [] },
        now: safeNow(),
      };
      let plan: Record<string, unknown>;
      try { const p = ports.planner.planRecovery(planInput); plan = isObj(p) ? { ...p } as Record<string, unknown> : {}; }
      catch (e) {
        await closeIntent(false, `supervisor: planner threw (${(e as Error)?.name ?? 'error'})`);
        return await finish('loop-error', undefined, { name: `planner-${(e as Error)?.name ?? 'error'}`, message: str((e as Error)?.message) ?? 'planner threw' });
      }
      // steer model override lands on the NEXT plan only (docs/18 §4) —
      // the planner still owns the decision. The strategyId is the
      // instantiated template (executor §2: a strategy naming a
      // different model is a repeat-budget bypass, so both move together).
      if (overrideModel !== undefined && plan['action'] === 'model-swap') {
        plan['model'] = overrideModel;
        plan['strategyId'] = `swap:model:${overrideModel}:v1`;
      }
      const action = str(plan['action'], 64) ?? 'hold';
      const decision = str(plan['decision'], 64) ?? 'continue';
      const strategyId = str(plan['strategyId'], 200) ?? `loop:v${seq}`;
      cur.decision = decision; cur.action = action; cur.strategyId = strategyId;

      // 7. journal the decision BEFORE acting (docs/18 §5). `hold` is the
      // planner's non-action sentinel and is NOT a journal action enum
      // member — it journals as an outcome, never an intent (P11 doctrine).
      const isJournalAction = (SUPERVISOR_ACTIONS as readonly string[]).includes(action);
      const rungRaw = typeof plan['rung'] === 'number' ? Math.min(5, Math.max(0, Math.trunc(plan['rung']))) : 1;
      const rationaleJoined = Array.isArray(plan['rationale']) ? plan['rationale'].filter((r): r is string => typeof r === 'string').join('\n').slice(0, 4096) : undefined;
      if (isJournalAction) {
        const intentId = `sup-${cfg.episodeId}-${cfg.taskId}-i${seq}`;
        pendingIntentId = intentId;
        await journalAppend({
          ...envelope(), kind: 'decision-intent',
          actionId: intentId,
          rung: rungRaw,
          action,
          ...(strategyId !== undefined ? { strategyId } : {}),
          ...(rationaleJoined !== undefined && rationaleJoined.length > 0 ? { rationale: rationaleJoined } : {}),
          observation: { signals: [{ kind: signal.kind }], context: {} },
          authority: { grantedBy: cfg.grantedBy, sideEffect: (str(plan['sideEffect'], 32) === 'external' || str(plan['sideEffect'], 32) === 'worktree-local') ? str(plan['sideEffect'], 32) as 'worktree-local' | 'external' : 'none' },
        });
      } else {
        await journalAppend({ ...envelope(), kind: 'decision-outcome', actionId: `sup-${cfg.episodeId}-${cfg.taskId}-i${seq}`, acked: false, progress: 'none', notes: `supervisor: non-action ${action} (decision ${decision})` });
      }

      // 5/6. execute / stops.
      if (action === 'hold') return await finish('hold', decision);
      if (action === 'accept-finish') {
        // docs/18 §7 + config contract: no accept port OR no acceptance
        // config ⇒ finish passes through UNJUDGED (warn-rung). An
        // evaluate() over an undefined spec is not a verdict.
        if (!ports.accept || cfg.acceptance === undefined) {
          // R3/F17: the outcome goes under the SAME actionId as the
          // intent (a foreign id left the intent open forever).
          await closeIntent(false, 'supervisor: finish accepted UNJUDGED (no accept port or acceptance config — warn-rung)');
          return await finish('finish-unjudged');
        }
        let verdict: string | undefined;
        let remaining: string[] = [];
        let reasons: string[] = [];
        try {
          const a = await ports.accept.evaluate({ taskId: cfg.taskId, taskRevision: cfg.taskRevision ?? 1, spec: cfg.acceptance.spec, ...(cfg.acceptance.current !== undefined ? { current: cfg.acceptance.current } : {}), gates: [], artifacts: [], claims: [], blockers: [], evidenceRefs: [...evidence], now: safeNow() });
          verdict = isObj(a) ? str(a['verdict'], 32) : undefined;
          remaining = isObj(a) && Array.isArray(a['remainingWork']) ? (a['remainingWork'] as unknown[]).filter((r): r is string => typeof r === 'string') : [];
          reasons = isObj(a) && Array.isArray(a['reasons']) ? (a['reasons'] as unknown[]).filter((r): r is string => typeof r === 'string') : [];
        } catch { verdict = undefined; }
        await journalAppend({ ...envelope(), kind: 'acceptance', taskRevision: cfg.taskRevision ?? 1, verdict: (VERDICTS as readonly string[]).includes(verdict ?? '') ? verdict : 'uncertain', criteria: [], remainingWork: remaining });
        if (verdict === 'complete') {
          await closeIntent(true, 'supervisor: accept-finish executed (verdict complete)');
          return await finish('accepted-finish');
        }
        finishRejects += 1;
        if (finishRejects >= 2) {
          await closeIntent(false, 'supervisor: accept-finish rejected (finish-rejected-twice)');
          return await finish('halt', 'finish-rejected-twice');
        }
        // docs §3: a false finish converts to ONE planned continue per
        // finish attempt. The fresh verdict replaces the stale one so
        // the next plan sees current evidence (F9).
        if ((VERDICTS as readonly string[]).includes(verdict ?? '') && verdict !== undefined) {
          acceptanceAssessment = { verdict, remainingWork: remaining, reasons };
        } else {
          acceptanceAssessment = undefined;
        }
        lastOutcome = { action: 'accept-finish', strategyId, progress: 'none' };
        lastSignal = { kind: 'verify-gap', detail: `finish-rejected-${verdict ?? 'error'}` };
        // R3/F17: the reject-continue skips the executor, so close the
        // intent before continuing or it stays open forever.
        await closeIntent(false, `supervisor: accept-finish rejected (${verdict ?? 'error'}) — converted to continue`);
        continue;
      }
      if (action === 'park') {
        const parkRes = await ports.executor.executeRecoveryAction(plan, { episodeId: cfg.episodeId, taskId: cfg.taskId, now: safeNow(), authority: { grantedBy: cfg.grantedBy }, ...(lastAttemptId !== undefined ? { attemptId: lastAttemptId } : {}), ...(lastSession !== undefined ? { session: lastSession } : {}) }, { ...ports.executorPorts, journal: ports.journal });
        await closeIntent(parkRes?.status === 'executed', `supervisor: park ${str(parkRes?.status, 32) ?? 'unknown'}`);
        return await finish('parked');
      }
      if (action === 'escalate') {
        consecutiveEscalate += 1;
        if (consecutiveEscalate >= 2) {
          await closeIntent(false, 'supervisor: escalate exhausted (consecutive) — not executed');
          return await finish('escalation-exhausted', str(signal.detail));
        }
      } else {
        consecutiveEscalate = 0;
      }

      // wrap the executor runner so the loop can sense the child's exit
      // (docs/18 §1 step 8: the outcome IS the next signal). Full
      // pass-through of the P7 surface (reconcile/resume/stop) — the
      // wrapper adds sensing only, never policy.
      let spawnedHandle: AttemptHandleLike | undefined;
      const underlying = (ports.executorPorts as { runner?: RunnerPort }).runner ?? ports.runner;
      const execRunner: RunnerPort | undefined = underlying === undefined ? undefined : {
        run: async (t) => { const h = await underlying.run(t); spawnedHandle = h; return h; },
        ...(underlying.reconcile ? { reconcile: (t: object) => underlying.reconcile!(t) } : {}),
        ...(underlying.resume ? { resume: async (t: object, attemptId: string) => { const h = await underlying.resume!(t, attemptId); spawnedHandle = h; return h; } } : {}),
        ...(underlying.stop ? { stop: (h: { session: string }) => underlying.stop!(h) } : {}),
        ...(underlying.preflight ? { preflight: (c: { episodeId: string; taskId: string }) => underlying.preflight!(c) } : {}),
      };
      // R4-2/R5 (docs/18 §11): wrap the executor's gate port so the LOOP owns
      // the close of executor-side reservations. The executor keeps the
      // atomic check→reserve admission (docs/12 §4); the wrapper only
      // captures the open record's id. The close happens after the act:
      // attested 'settled' on a proven exit, request-only 'released' when
      // the spawn is sensed but its exit is unobservable, and 'released'
      // on a provable no-effect refusal — never a blind release while the
      // effect is unknown (ledger expiry backstops that instead).
      let execResId: string | undefined;
      const baseExecGate = (ports.executorPorts as { gate?: { check?: (p: unknown, r: unknown) => Promise<unknown>; reserve?: (p: unknown, r: unknown) => Promise<unknown>; closeReservation?: (refId: string, reason: string, attest?: object) => Promise<unknown>; release?: (refId: string, reason: string, attest?: object) => Promise<unknown> } }).gate;
      const execGate = baseExecGate !== undefined && typeof baseExecGate.check === 'function' && typeof baseExecGate.reserve === 'function'
        ? {
            check: (p: unknown, r: unknown) => baseExecGate.check!(p, r),
            reserve: async (p: unknown, r: unknown) => {
              const openRec = await baseExecGate.reserve!(p, r);
              if (isObj(openRec)) { const idv = str(openRec['id']); if (idv !== undefined) execResId = idv; }
              return openRec;
            },
          }
        : undefined;
      const closeExecRes = async (reason: 'settled' | 'released', attest?: { outcome: string; evidence: string }): Promise<void> => {
        if (execResId === undefined) return;
        // R5-1: a free-function call drops `this` on class-based ports.
        // Same-port-only close (R5-2): the id came from baseExecGate, so
        // only its doors may close it — never the loop's own gate.
        const door = typeof baseExecGate?.closeReservation === 'function'
          ? { fn: baseExecGate.closeReservation, recv: baseExecGate }
          : (typeof baseExecGate?.release === 'function'
            ? { fn: baseExecGate.release, recv: baseExecGate }
            : undefined);
        if (door === undefined) { log('exec-reservation-no-close-door (expiry backstops)'); return; }
        try { await door.fn.call(door.recv, execResId, reason, attest); } catch (e) { log(`exec-reservation-close-failed: ${(e as Error)?.name ?? 'error'}`); }
      };
      let res: ExecResultLike;
      try {
        res = await ports.executor.executeRecoveryAction(plan, { episodeId: cfg.episodeId, taskId: cfg.taskId, now: safeNow(), authority: { grantedBy: cfg.grantedBy }, ...(lastAttemptId !== undefined ? { attemptId: lastAttemptId } : {}), ...(lastSession !== undefined ? { session: lastSession } : {}) }, { ...ports.executorPorts, journal: ports.journal, ...(execRunner !== undefined ? { runner: execRunner } : {}), ...(execGate !== undefined ? { gate: execGate } : {}) });
      } catch (e) {
        // R3/F17: an executor throw skips the pairing site below — close
        // the intent before this stop too (the outer catch is the backstop
        // for throws it cannot see, e.g. park).
        await closeIntent(false, `supervisor: executor threw (${(e as Error)?.name ?? 'error'})`);
        // R4-2: a thrown executor may have reserved with an unknown effect
        // — never a blind release; ledger expiry backstops.
        if (execResId !== undefined) log('exec-reservation-effect-unknown (expiry backstops)');
        return await finish('loop-error', undefined, { name: `executor-${(e as Error)?.name ?? 'error'}`, message: str((e as Error)?.message) ?? 'executor threw' });
      }
      cur.execStatus = str(res?.status, 32); cur.execReason = str(res?.reason, 120);

      // docs §3: a false finish converts ONE planned continue per finish
      // attempt — the reject counter is CONSECUTIVE, so any other action
      // executing breaks the chain (a stale episode-wide count would halt
      // spuriously across attempts).
      if (action !== 'accept-finish' && res?.status === 'executed') finishRejects = 0;

      // Journal pairing (I2 `openIntents`, docs/11): a journaled intent
      // gets its outcome under the SAME actionId right after the act —
      // otherwise every loop intent stays open forever and a host
      // reconcile would hunt actions that already ran. `acked` reflects
      // the executor's disposition; progress is 'none' per E4.
      if (isJournalAction) {
        await closeIntent(res?.status === 'executed', `supervisor: ${action} ${str(res?.status, 32) ?? 'unknown'}${str(res?.reason, 120) !== undefined ? ` (${str(res?.reason, 120)})` : ''}`);
      }

      // sense: the SPAWN — not the exit — consumes an attempt and
      // invalidates the prior verdict (docs/18 §7: a verdict must not
      // outlive the attempt it judged, whether or not the exit is
      // observable through the handle).
      let exit: { code?: number | null; signal?: string | null } | undefined;
      if (spawnedHandle !== undefined) {
        attemptsUsed += 1;
        acceptanceAssessment = undefined;
        const s = str(spawnedHandle.session);
        const aid = str(spawnedHandle.attemptId);
        if (aid !== undefined) lastAttemptId = aid;
        if (s !== undefined) lastSession = s;
        if (spawnedHandle.exited) {
          try { exit = await spawnedHandle.exited; } catch { exit = undefined; }
        }
        try { await ports.gate?.ingestSession?.(s ?? '', { episodeId: cfg.episodeId, taskId: cfg.taskId, ...(aid ? { attemptId: aid } : {}) }); } catch { /* refresh-first: next reserve re-reads */ }
        // R4-2: settled+attested on a PROVEN exit, request-only 'released'
        // when the spawn happened but the exit is unobservable — identical
        // semantics to the initial-run close above.
        const proven = exit !== undefined && (typeof exit.code === 'number' || exit.signal != null);
        await closeExecRes(proven ? 'settled' : 'released', proven
          ? { outcome: `attempt-exited code-${exit!.code ?? 'null'} signal-${exit!.signal ?? 'null'}`, evidence: `session:${s ?? 'unknown'}` }
          : undefined);
      } else if (res?.status === 'refused' && execResId !== undefined) {
        // R5-3/R5-4: a refusal is provably no-effect ONLY when the executor
        // journaled its no-effect marker for THIS actionId. 'gate'-stage
        // refusals never reached reserve; 'act' refusals went through the
        // executor's effectStarted guard (act-unknown vs no-effect). But
        // res itself is port-returned data (the real executor sits behind
        // the loop's executor port), so its status/stage/reason are NOT
        // trusted — the journal marker is the proof. Anything unproven
        // (including a hostile or foreign refused result) is
        // effect-unknown: log and let expiry backstop, never blind-release.
        if (await journaledNoEffect(res?.actionId)) {
          await closeExecRes('released', undefined);
        } else {
          log('exec-reservation-effect-unknown (expiry backstops)');
        }
      } else if (res?.status === 'failed' && execResId !== undefined) {
        // A no-effect failure journals no-effect: but res is port-returned
        // data and a foreign 'failed' proves nothing about the act — the
        // journal marker is the proof here too. Effect may have landed
        // (act-unknown): never a blind release.
        if (await journaledNoEffect(res?.actionId)) {
          await closeExecRes('released', undefined);
        } else {
          log('exec-reservation-effect-unknown (expiry backstops)');
        }
      }
      strategyUses[strategyId] = (strategyUses[strategyId] ?? 0) + 1;
      recoveryTurnsUsed += 1;
      if (action === 'nudge') nudgesUsed += 1;
      evidence.push(...(Array.isArray(res?.evidenceRefs) ? res.evidenceRefs.filter((r): r is string => typeof r === 'string') : []));
      // progress is EVIDENCE, not hope (executor E4: the executor always
      // journals progress 'none'; only P14/P5 may upgrade it). An
      // 'executed' status means the act was dispatched, not that the
      // worker advanced — laundering 'uptake' here defeats the planner's
      // repeat-veto (docs/18 §3 inherited caps).
      lastOutcome = { action, strategyId, progress: 'none' };
      lastSignal = signalFromExec(res, exit);
    }
    await journalAppend({ ...envelope(), kind: 'decision-outcome', actionId: `sup-${cfg.episodeId}-${cfg.taskId}-stop-end`, acked: false, progress: 'none', notes: 'supervisor: stop no-initial-signal' });
    return await finish('no-initial-signal');
  } catch (e) {
    const error = { name: str((e as Error)?.name, 128) ?? 'loop-error', message: str((e as Error)?.message) ?? 'unknown' };
    // R3/F17 backstop: a throw past the local pairing sites (e.g. from
    // the park call) must not leave the iteration's intent open.
    await closeIntent(false, `supervisor: loop error before outcome (${error.name})`).catch(() => undefined);
    seq += 1;
    await journalAppend({ ...envelope(), kind: 'decision-outcome', actionId: `sup-${cfg.episodeId}-${cfg.taskId}-looperr-${seq}`, acked: false, progress: 'none', notes: `supervisor-loop-error: ${error.name} ${error.message}`.slice(0, 4096) });
    return await finish('loop-error', undefined, error);
  }
}
