/**
 * P15 — Investigation & Recovery Agent (docs/17; docs/11 §11 P15 row,
 * §9.1 self-healing policy, §14.3 `kind:"diagnosis"` record, §14.7
 * `authority.diagnostics`, §14.8 workerState).
 *
 * One question, one bounded answer: given an interruption signal and a
 * bounded evidence packet, what cause class best explains the stopped
 * worker — as a §14.3 diagnosis record that is ADVICE ONLY (docs/11
 * §0.7: no authority transfer). The caller (P9) appends the record;
 * P10 re-validates it; P8 gates whatever action follows.
 *
 * Invariants (docs/17 §7 — each has named tests):
 *  INV-1 never-throws: hostile/getter/Proxy packets and throwing ports
 *      still yield a record that passes validateSupervisorRecord.
 *  INV-2 advice ceiling: the judge fills in ONLY `unknown`, its
 *      confidence is clamped below the planner bar (0.69 < 0.7), and
 *      it can never overwrite a deterministic classification.
 *  INV-3 bounded: toolsUsed ≤ min(maxToolCalls, probes); every probe
 *      runs AT MOST ONCE; no probe starts when its estimate would
 *      cross maxUsd; zero limits ⇒ zero port calls.
 *  INV-4 closed merge: probe results merge only the §3.2 fact keys at
 *      boolean type — nothing else in a result reaches the classifier.
 *  INV-5 refs copied: packet refs are copied, never invented; the
 *      module's own markers (rule:/text:/probe:/judge:/…) are the
 *      only other entries and each names an observation it made.
 *  INV-6 determinism: same packet + same scripted ports ⇒ deep-equal
 *      records except ts (injected clock; no Date() here).
 *  INV-7 record validity: every returned record is self-checked and
 *      passes the journal schema (pinned by test against the REAL
 *      validateSupervisorRecord).
 *  INV-8 no authority: no journal append, no runner call, no fs, no
 *      child process, no env reads — the module performs ONLY its two
 *      injected port calls.
 *  INV-9 compartment: imports NOTHING at runtime — not even node:
 *      builtins (stricter than P10; the guard test enforces).
 *
 * Closed-set mirrors (PLANNER_/journal) are pinned 1:1 by the drift
 * guard in test/investigation.test.ts — the same pattern as P11.
 */

// ─── Closed vocabularies (mirrors — drift-pinned by test) ──────────────────

/** Mirror of `PLANNER_CAUSE_CLASSES` (src/planner/plan.ts) / the §14.3
 *  diagnosis causeClass enum. Extensible ONLY via a docs/11 Change
 *  Ledger row (the journal validator is the hard gate). */
export const CAUSE_CLASSES = [
  'transient-endpoint',
  'premature-stop',
  'task-defect',
  'environment-blocker',
  'approval-boundary',
  'unknown',
] as const;
type CauseClass = (typeof CAUSE_CLASSES)[number];

/** Mirror of `SUPERVISOR_ACTIONS` (the episode journal module). */
export const ACTIONS = [
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
type SupervisorAction = (typeof ACTIONS)[number];

/** Mirror of `WORKER_STATES` (src/fleet/tail.ts, docs/11 §14.8). */
export const WORKER_STATES = [
  'thinking',
  'tool',
  'await-approval',
  'warned',
  'stopped',
  'dead',
  'unknown',
] as const;

/** Mirror of `DECISION_SIGNAL_KINDS` (the episode journal module). */
export const SIGNAL_KINDS = [
  'guard-stop',
  'warn-rung',
  'semantic-loop',
  'verify-gap',
  'no-advance',
  'endpoint-error',
  'budget-threshold',
  'worker-exit',
  'worker-blocked-on-approval',
] as const;

/** Mirror of the planner's STRATEGY_TEMPLATES entries used here
 *  (docs/14 §4) — proposed actions carry the planner's OWN strategy ids
 *  so P8's repeat counting sees one vocabulary. */
export const STRATEGY = {
  'evidence-nudge-resume': 'resume:evidence:v1',
  'backoff-retry': 'retry:transient:v1',
  'investigate': 'investigate:bounded:v1',
  'repair': 'repair:task-local:v1',
  'escalate': 'escalate:v1',
} as const;

/** Mirror of the planner's ACTION_RUNG rows used here (docs/14). */
export const RUNG: Record<SupervisorAction, number> = {
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
  'accept-finish': 0,
};

/** The planner's actionable-confidence bar (docs/14 §3). Kept HERE as
 *  the loop's "good enough" signal; the planner re-applies its own. */
export const CONFIDENCE_BAR = 0.7;
/** INV-2: strictly below the bar — a judge opinion alone can never
 *  cross into the planner's actionable zone. */
export const JUDGE_CONFIDENCE_CAP = 0.69;

// ─── Boundaries (hostile input) ─────────────────────────────────────────────

const MAX_STR = 1024;
const MAX_REFS = 64;
const MAX_ERRS = 8;
const MAX_TEXT = 16_000;
const MAX_FACT_KEYS = 64;

/** §14.7 defaults. */
export const DEFAULT_MAX_TOOL_CALLS = 20;
export const DEFAULT_MAX_USD = 0.5;

// ─── The closed fact set (docs/17 §3.2) — the ONLY mergeable input ────────

export interface FactPatch {
  approvalPending?: boolean;
  diskFull?: boolean;
  permissionDenied?: boolean;
  missingBinary?: boolean;
  rateLimited?: boolean;
  endpointHttp5xx?: boolean;
  endpointUnreachable?: boolean;
  endpointReachable?: boolean;
  gatePass?: boolean;
  workerClaimedComplete?: boolean;
}
const FACT_KEYS: readonly (keyof FactPatch)[] = [
  'approvalPending', 'diskFull', 'permissionDenied', 'missingBinary',
  'rateLimited', 'endpointHttp5xx', 'endpointUnreachable', 'endpointReachable',
  'gatePass', 'workerClaimedComplete',
];

// ─── Ports (docs/17 §4/§5) ─────────────────────────────────────────────────

/** Diagnostic probe port. The module requests ONLY a probe from the
 *  closed table below; results are hostile until fenced-filtered.
 *  P9 wires this THROUGH P8's diagnostics grant (read-only by
 *  contract); the module never executes anything itself. */
export interface DiagnosticToolPort {
  run(req: { probe: string; episodeId: string; taskId?: string; attemptId?: string }):
    Promise<unknown> | unknown;
}

/** Advisory model judge. Consulted ONLY for an `unknown` outcome;
 *  output clamped below the planner bar (INV-2). */
export interface JudgePort {
  judge(req: { episodeId: string; taskId?: string; facts: FactPatch;
    workerState?: string; signal?: string }): Promise<unknown> | unknown;
}

export interface InvestigationPorts {
  /** REQUIRED — the module has no clock of its own (INV-6). */
  now: () => number;
  tools?: DiagnosticToolPort;
  judge?: JudgePort;
}

// ─── Input (docs/17 §1) — every field is hostile ───────────────────────────

export interface InvestigationPacket {
  id: string;
  episodeId: string;
  taskId?: string;
  attemptId?: string;
  signal?: { kind?: string };
  workerState?: string;
  /** §14.8 envelope stale flag — true ⇒ `packet:stale` marker (the
   *  planner has its own staleness anchor, docs/14 §5; classification
   *  is unchanged). */
  stale?: boolean;
  runEndReason?: string;
  signalDetail?: string;
  errors?: { source?: string; text?: string }[];
  guardFires?: number;
  facts?: FactPatch;
  acceptance?: { verdict?: string; remainingWork?: string[] };
  evidenceRefs?: string[];
}

export interface InvestigationLimits {
  maxToolCalls?: number;
  maxUsd?: number;
}

export interface InvestigationOptions {
  limits?: InvestigationLimits;
}

// ─── Output (docs/17 §2) — the §14.3 diagnosis record ──────────────────────

export interface DiagnosisProposedAction {
  rung: number;
  action: SupervisorAction;
  strategyId?: string;
  authorityNeeded?: 'none' | 'worktree-local' | 'external';
}

export interface DiagnosisRecordFields {
  schema: 'tre-supervisor/1';
  kind: 'diagnosis';
  id: string;
  ts: number;
  episodeId: string;
  taskId?: string;
  attemptId?: string;
  causeClass: CauseClass;
  confidence: number;
  evidenceRefs: string[];
  proposedActions: DiagnosisProposedAction[];
  limitsRespected: { toolsUsed: number; spendUsd: number };
}

// ─── Hostile-input fence (the P10 snapshot pattern) ────────────────────────

type Desc = { value?: unknown; present: boolean; threw?: boolean };

/** Own DATA descriptor only — an own accessor's getter is NEVER
 *  invoked; an inherited property is never read.
 *  Cycle-A7 F3/F7: a THROWING getOwnPropertyDescriptor trap is
 *  hostile input, not an absent field — `threw: true` lets callers
 *  disclose it instead of silently falling back to defaults. */
function ownData(obj: unknown, key: string): Desc {
  if (typeof obj !== 'object' || obj === null) return { present: false };
  try {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    if (d === undefined || !('value' in d)) return { present: false };
    return { value: d.value, present: true };
  } catch {
    return { present: false, threw: true };
  }
}

/** `Array.isArray` is NOT trap-safe: it throws on a REVOKED Proxy
 *  (cycle-A7 F1, critical: a revoked array as `evidenceRefs`/`errors`
 *  propagated out of investigate() and broke INV-1 — the trap sits in
 *  the IsArray intrinsic itself, so the value must be probed before
 *  the array test, exactly like isPlainObj fences getPrototypeOf).
 *  A revoked array passes `typeof 'object'` and throws here. */
function isArraySafe(v: unknown): v is unknown[] {
  if (typeof v !== 'object' || v === null) return false;
  try {
    return Array.isArray(v);
  } catch {
    return false; // revoked/trapping array
  }
}

/** True ONLY when the IsArray intrinsic itself throws (a revoked proxy
 *  or a trapping target) — a plain non-array answers false, so hostile
 *  handles are distinguishable from harmless garbage (cycle-A7 F1). */
function arrayTrap(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  try {
    Array.isArray(v);
    return false;
  } catch {
    return true;
  }
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
function boundedStr(v: unknown): string | undefined {
  if (!isStr(v)) return undefined;
  return v.length > MAX_STR ? v.slice(0, MAX_STR) : v;
}
function finiteAtMost(v: unknown, hi: number, lo: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(hi, Math.max(lo, v));
}
/** Integer variant for budgets: the old ternary check let a fractional
 *  2.5 through and `toolsUsed >= 2.5` admitted a THIRD probe (audit
 *  R1: non-integer maxToolCalls bypassed INV-3 by one call). A
 *  fractional budget floors to the integer below. */
function finiteAtMostInt(v: unknown, hi: number, lo: number): number | undefined {
  const n = finiteAtMost(v, hi, lo);
  return n === undefined ? undefined : Math.floor(n);
}
function isPlainObj(v: unknown): v is Record<string, unknown> {
  // Hostile proxies: `IsArray`, `getPrototypeOf`, and revoked targets can
  // all THROW from inside these intrinsics (audit R1: `getPrototypeOf`
  // trap). The fence treats a throwing trap as "not a plain object" —
  // INV-1 never propagates a caller-side trap across this boundary.
  try {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

/** Read ONE property off a caller-owned handle (ports/options) whose
 *  GETTER may throw. Own-data descriptors keep the fence for data;
 *  this is for the two handles where the fence itself must reach
 *  through a hostile object (audit R1: throwing `tools`/`limits`
 *  getters). A trap that throws reads as `undefined` (absent). */
function safeRead(obj: unknown, key: string): unknown {
  try {
    if (obj === undefined || obj === null) return undefined;
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Copy a string array fence-safely: length observed ONCE and
 *  re-verified after the copy (P10 C5-F2); non-strings dropped.
 *  Returns `overflow: true` when an entry beyond the `MAX_REFS` copy
 *  window carried a string NO copied entry had — unique content the
 *  caller can never see (cycle-A5 R1: a flood larger than the window
 *  was previously dropped at ingestion with no disclosure). Pure
 *  duplicates past the window disclose nothing (cycle-A5 F5: nothing
 *  unique was lost). The post-window scan is BUDGETED (cycle-A6 F1):
 *  a packet may declare `length` up to 2^32-1 with NO entries behind
 *  them, and an unbounded per-index walk (getOwnPropertyDescriptor
 *  every hole) let a hostile packet stall investigate() for minutes
 *  — measured 3.9s at 100M holes, ~40min at max length. The scan
 *  visits at most COPY_SCAN_BUDGET indices; exhausting the budget
 *  with entries left unvisited counts as overflow (content we cannot
 *  account for is DISCLOSED, never silently dropped) and marks
 *  `bad-input:scan-budget` at the assembly site. Memory stays
 *  bounded (64-entry set) in all paths.
 *  Cycle-A7 F2: the discard paths (descriptor trap, length-getter
 *  throw, re-verify mismatch) used to return an empty result with ALL
 *  flags false — the packet's refs vanished with NO disclosure,
 *  contrary to docs/17 §0 rule 5. Every such path now sets
 *  `dropped: true` (unique content may have been read and then thrown
 *  away; it can never be proven duplicate, so the F5 waiver cannot
 *  apply), disclosed as `refs:dropped`. An array handle whose IsArray
 *  probe throws (revoked/trapping) sets `hostile: true` — a plain
 *  non-array is NOT hostile; a hostile handle is disclosed as
 *  `bad-input:packet` (cycle-A7 F1). */
const COPY_SCAN_BUDGET = MAX_REFS * 16; // 1024 indices; the tail discloses via overflow + bad-input:scan-budget
function copyStrs(raw: unknown): { refs: string[]; overflow: boolean; scanExhausted: boolean; dropped: boolean; hostile: boolean } {
  if (!isArraySafe(raw)) {
    // Hostile-but-present (revoked/trapping array; `arrayTrap` answers
    // false for a plain non-array) vs absent/plain garbage.
    const hostile = arrayTrap(raw);
    return { refs: [], overflow: false, scanExhausted: false, dropped: false, hostile };
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
  const seen = new Set<string>();
  let overflow = false;
  let scanExhausted = false;
  let scanned = 0;
  for (let i = 0; i < n; i++) {
    if (scanned >= COPY_SCAN_BUDGET) {
      scanExhausted = true; // cycle-A6 F1: entries remain unvisited
      break;
    }
    scanned++;
    let d: PropertyDescriptor | undefined;
    try {
      d = Object.getOwnPropertyDescriptor(raw, i);
    } catch {
      ok = false; // a per-index getOwnPropertyDescriptor trap (audit R1)
      break;
    }
    if (d === undefined || !('value' in d)) continue;
    const s = boundedStr(d.value);
    if (s === undefined) continue;
    if (out.length < MAX_REFS) {
      out.push(s);
      seen.add(s);
    } else if (!seen.has(s)) {
      overflow = true;
    }
  }
  if (!ok) return { refs: [], overflow: false, scanExhausted: false, dropped: true, hostile: false };
  try {
    if ((raw as unknown[]).length !== n) return { refs: [], overflow: false, scanExhausted: false, dropped: true, hostile: false };
  } catch {
    return { refs: [], overflow: false, scanExhausted: false, dropped: true, hostile: false };
  }
  return { refs: out, overflow, scanExhausted, dropped: false, hostile: false };
}

/** Merge ONLY the closed fact keys at boolean type (INV-4). Both the
 *  packet's `facts` and probe results pass through here; anything
 *  else in either object is dropped without being read. */
function mergeFacts(target: Map<string, boolean>, raw: unknown): void {
  if (!isPlainObj(raw)) return;
  let merged = 0;
  for (const k of FACT_KEYS) {
    const d = ownData(raw, k);
    if (d.present && typeof d.value === 'boolean') {
      target.set(k, d.value);
      if (++merged >= MAX_FACT_KEYS) break;
    }
  }
}

// ─── Text-pattern derivation (docs/17 §3.3) — closed substring table ──────
// Fixed literals, lowercased haystack, `includes` only: no regexes on
// caller data. Derivations are TENTATIVE facts, visible as text: markers.

const TEXT_PATTERNS: readonly (readonly [keyof FactPatch, readonly string[]])[] = [
  ['rateLimited', ['429', 'rate limit', 'too many requests', 'quota exceeded']],
  ['endpointHttp5xx', ['bad gateway', 'service unavailable', 'overloaded', 'status 500', 'status 502', 'status 503', 'status 504']],
  ['endpointUnreachable', ['econnrefused', 'econnreset', 'socket hang up', 'fetch failed', 'could not connect', 'name resolution']],
  ['permissionDenied', ['eacces', 'permission denied']],
  ['diskFull', ['enospc', 'no space left']],
  ['missingBinary', ['command not found', 'spawn enoent']],
  ['approvalPending', ['awaiting approval', 'waiting for approval', 'approval required']],
];
/** Generic connect-failure words: derive endpointUnreachable ONLY with
 *  endpoint context (same unit carries a rateLimited/endpointHttp5xx
 *  marker, or signal.kind = endpoint-error) — docs/17 §3.3. */
const EP_UNREACHABLE_GENERIC: readonly string[] = ['timed out', 'timeout'];

/** Per-source-unit derivation; markers push in table order on first
 *  derivation (deterministic). */
function deriveTextUnit(unit: string, out: Set<string>, markers: string[], signalEndpoint: boolean): void {
  if (unit.length === 0) return;
  let ctx = signalEndpoint;
  for (const [key, subs] of TEXT_PATTERNS) {
    if (key === 'rateLimited' || key === 'endpointHttp5xx') {
      for (const s of subs) if (unit.includes(s)) { ctx = true; break; }
    }
  }
  for (const [key, subs] of TEXT_PATTERNS) {
    if (out.has(key)) continue;
    if (key === 'endpointUnreachable') {
      let hit = subs.some((s) => unit.includes(s));
      if (!hit && ctx) hit = EP_UNREACHABLE_GENERIC.some((s) => unit.includes(s));
      if (hit) { out.add(key); markers.push(`text:${key}`); continue; }
      continue;
    }
    for (const s of subs) {
      if (unit.includes(s)) {
        out.add(key);
        markers.push(`text:${key}`);
        break;
      }
    }
  }
}

// ─── The probe table (docs/17 §5) — closed, run-once ───────────────────────

interface Probe {
  id: string;
  estimateUsd: number;
  /** The class this probe confirms; consulted probes first when that
   *  class is the current candidate. */
  forClass: CauseClass;
}
const PROBES: readonly Probe[] = [
  { id: 'probe-endpoint', estimateUsd: 0.02, forClass: 'transient-endpoint' },
  { id: 'probe-env', estimateUsd: 0.02, forClass: 'environment-blocker' },
  { id: 'probe-gate-rerun', estimateUsd: 0.10, forClass: 'task-defect' },
  { id: 'probe-worker-tail', estimateUsd: 0.01, forClass: 'premature-stop' },
];

// ─── Classification (docs/17 §3) — pure, deterministic ─────────────────────

interface ClassInput {
  signalKind?: string;
  workerState?: string;
  runEndReason?: string;
  guardFires: number;
  acceptanceVerdict?: string;
}

interface ClassResult {
  cause: CauseClass;
  conf: number;
  /** rule:<id> marker for the rule that fired (undefined = no rule). */
  rule: string | undefined;
}

const ENDED_STATES: readonly string[] = ['stopped', 'warned', 'dead'];
const ENDED_SIGNALS: readonly string[] = [
  'guard-stop', 'worker-exit', 'no-advance', 'verify-gap', 'semantic-loop', 'warn-rung',
];
const ENDPOINT_END_REASONS: readonly string[] = ['endpoint-error', 'transport-error'];

function classify(explicit: Map<string, boolean>, derived: Set<string>, c: ClassInput): ClassResult {
  const ex = (k: keyof FactPatch) => explicit.get(k) === true;

  // 1 — approval boundary.
  if (ex('approvalPending')) return { cause: 'approval-boundary', conf: 0.95, rule: 'approval-pending:explicit' };
  if (derived.has('approvalPending') || c.signalKind === 'worker-blocked-on-approval' || c.workerState === 'await-approval') {
    return { cause: 'approval-boundary', conf: 0.6, rule: 'approval-pending:signal' };
  }

  // 2 — environment blocker (explicit facts are confirmed; text is not).
  if (ex('diskFull')) return { cause: 'environment-blocker', conf: 0.95, rule: 'environment-blocker:disk-full' };
  if (ex('permissionDenied')) return { cause: 'environment-blocker', conf: 0.9, rule: 'environment-blocker:permission' };
  if (ex('missingBinary')) return { cause: 'environment-blocker', conf: 0.85, rule: 'environment-blocker:missing-binary' };
  if (derived.has('diskFull') || derived.has('permissionDenied') || derived.has('missingBinary')) {
    return { cause: 'environment-blocker', conf: 0.6, rule: 'environment-blocker:text-derived' };
  }

  // 3 — endpoint failure.
  if (ex('rateLimited')) return { cause: 'transient-endpoint', conf: 0.9, rule: 'endpoint-failure:rate-limited' };
  if (ex('endpointHttp5xx')) return { cause: 'transient-endpoint', conf: 0.85, rule: 'endpoint-failure:http-5xx' };
  if (ex('endpointUnreachable')) return { cause: 'transient-endpoint', conf: 0.85, rule: 'endpoint-failure:unreachable' };
  if (derived.has('rateLimited') || derived.has('endpointHttp5xx') || derived.has('endpointUnreachable')) {
    return { cause: 'transient-endpoint', conf: 0.6, rule: 'endpoint-failure:text-derived' };
  }
  if (c.signalKind === 'endpoint-error' || (c.runEndReason !== undefined && ENDPOINT_END_REASONS.includes(c.runEndReason))) {
    return { cause: 'transient-endpoint', conf: 0.6, rule: 'endpoint-failure:signal' };
  }

  // 4 — deterministic gate failure is a task defect (explicit facts only;
  // never text-derived: "the gate failed" is not a substring finding).
  if (explicit.get('gatePass') === false) return { cause: 'task-defect', conf: 0.85, rule: 'gate-failed' };

  // 5 — premature stop: an ended/abnormal worker that has NOT passed
  // acceptance. Tentative by design — the probe loop confirms.
  const ended = (c.workerState !== undefined && ENDED_STATES.includes(c.workerState))
    || (c.signalKind !== undefined && ENDED_SIGNALS.includes(c.signalKind))
    || c.guardFires >= 2;
  if (ended && c.acceptanceVerdict !== 'complete') {
    return { cause: 'premature-stop', conf: c.acceptanceVerdict === 'incomplete' ? 0.65 : 0.55, rule: 'premature-stop' };
  }

  return { cause: 'unknown', conf: 0.3, rule: undefined };
}

/** §3.1 confirmations — probe facts the current class can upgrade on. */
function applyConfirmations(cur: ClassResult, explicit: Map<string, boolean>): ClassResult {
  if (cur.cause === 'transient-endpoint') {
    if (explicit.get('endpointReachable') === true) return { ...cur, conf: Math.max(cur.conf, 0.95) };
    if (explicit.get('endpointReachable') === false) return { ...cur, conf: Math.max(cur.conf, 0.9) };
  }
  if (cur.cause === 'premature-stop' && explicit.get('workerClaimedComplete') === true) {
    return { ...cur, conf: Math.max(cur.conf, 0.8) };
  }
  return cur;
}

// ─── Proposed actions (docs/17 §6) — built-in table ONLY ───────────────────

function proposedFor(cause: CauseClass, conf: number): DiagnosisProposedAction[] {
  const pa = (action: SupervisorAction, authorityNeeded?: 'none' | 'worktree-local' | 'external'): DiagnosisProposedAction =>
    authorityNeeded === undefined
      ? { rung: RUNG[action], action, strategyId: STRATEGY[action as keyof typeof STRATEGY] }
      : { rung: RUNG[action], action, strategyId: STRATEGY[action as keyof typeof STRATEGY], authorityNeeded };
  switch (cause) {
    case 'transient-endpoint': return [pa('backoff-retry')];
    case 'premature-stop': return [pa('evidence-nudge-resume'), pa('investigate')];
    case 'task-defect': return [pa('repair', 'worktree-local')];
    case 'environment-blocker': return [conf >= CONFIDENCE_BAR ? pa('escalate') : pa('investigate')];
    case 'approval-boundary': return [pa('escalate')];
    case 'unknown': return [pa('investigate')];
  }
}

// ─── Record self-check (INV-7 belt) — mirrors the journal's §14.3 schema ──

function selfCheck(r: DiagnosisRecordFields): boolean {
  if (r.schema !== 'tre-supervisor/1' || r.kind !== 'diagnosis') return false;
  if (!isStr(r.id) || r.id.length === 0 || r.id.length > MAX_STR) return false;
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts) || r.ts < 0) return false;
  if (!isStr(r.episodeId) || r.episodeId.length === 0 || r.episodeId.length > MAX_STR) return false;
  if (r.taskId !== undefined && (!isStr(r.taskId) || r.taskId.length === 0 || r.taskId.length > MAX_STR)) return false;
  if (r.attemptId !== undefined && (!isStr(r.attemptId) || r.attemptId.length === 0 || r.attemptId.length > MAX_STR)) return false;
  if (!CAUSE_CLASSES.includes(r.causeClass)) return false;
  if (typeof r.confidence !== 'number' || !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1) return false;
  if (!Array.isArray(r.evidenceRefs) || r.evidenceRefs.length > MAX_REFS) return false;
  for (const s of r.evidenceRefs) if (!isStr(s)) return false;
  if (!Array.isArray(r.proposedActions)) return false;
  for (const p of r.proposedActions) {
    if (!isPlainObj(p) || !Number.isInteger(p.rung) || p.rung < 0 || p.rung > 5) return false;
    if (!(ACTIONS as readonly string[]).includes(p.action)) return false;
    if (p.strategyId !== undefined && (!isStr(p.strategyId) || p.strategyId.length === 0 || p.strategyId.length > MAX_STR)) return false;
    if (p.authorityNeeded !== undefined && p.authorityNeeded !== 'none' && p.authorityNeeded !== 'worktree-local' && p.authorityNeeded !== 'external') return false;
  }
  const lr = r.limitsRespected;
  if (!isPlainObj(lr) || !Number.isInteger(lr.toolsUsed) || (lr as { toolsUsed: number }).toolsUsed < 0) return false;
  if (typeof lr.spendUsd !== 'number' || !Number.isFinite(lr.spendUsd) || lr.spendUsd < 0) return false;
  return true;
}

// ─── Port-call helpers (never throw; results fenced) ───────────────────────

/** Resolve a port method OFF a hostile handle: `tools.run` / `judge.judge`
 *  may be getters whose traps THROW, and even `typeof x.run` triggers
 *  them (audit R1). The resolved function is captured ONCE and the
 *  handle is never touched again. Returns undefined when the handle is
 *  absent, unusable, or its method is missing/not a function.
 *  Audit A5/F1: the FULL argument list is forwarded with the handle as
 *  receiver — a method-style clock (`now() { return this.t }`) lost its
 *  `this` when the first fix call-dropped the receiver, silently
 *  zeroing ts for every class-method caller. */
function resolvePortMethod(handle: unknown, method: string): ((...args: unknown[]) => Promise<unknown> | unknown) | undefined {
  if (handle === undefined) return undefined;
  if (handle === null || typeof handle !== 'object') return undefined;
  const fn = safeRead(handle, method);
  if (typeof fn !== 'function') return undefined;
  // Keep the handle as the call receiver (real ports may use `this`);
  // the CALL itself sits inside callProbe/callJudge's try.
  return (...args: unknown[]) => (fn as (...a: unknown[]) => Promise<unknown> | unknown).apply(handle, args);
}

async function callProbe(toolsRun: (req: unknown) => Promise<unknown> | unknown, probe: Probe, ep: string, taskId: string | undefined, attemptId: string | undefined):
  Promise<{ ok: boolean; facts: Map<string, boolean>; evidenceRef?: string; usd?: number }> {
  const facts = new Map<string, boolean>();
  try {
    const req: { probe: string; episodeId: string; taskId?: string; attemptId?: string } = { probe: probe.id, episodeId: ep };
    if (taskId !== undefined) req.taskId = taskId;
    if (attemptId !== undefined) req.attemptId = attemptId;
    const raw = await toolsRun(req);
    if (!isPlainObj(raw)) return { ok: false, facts };
    mergeFacts(facts, ownData(raw, 'facts').value);
    const ref = boundedStr(ownData(raw, 'evidenceRef').value);
    // docs/17 §5: `usd` must be finite and NON-NEGATIVE — a negative
    // report is rejected (the full charged estimate stands), never
    // applied as a refund below the probe's actual cost (audit R3).
    const usdSlot = ownData(raw, 'usd');
    let usd: number | undefined;
    if (usdSlot.present && typeof usdSlot.value === 'number' && Number.isFinite(usdSlot.value) && usdSlot.value >= 0) {
      usd = Math.min(usdSlot.value, Number.MAX_SAFE_INTEGER);
    }
    return { ok: true, facts, evidenceRef: ref !== undefined && ref.length > 0 ? ref : undefined, usd };
  } catch {
    return { ok: false, facts };
  }
}

async function callJudge(judgeJudge: (req: unknown) => Promise<unknown> | unknown, ep: string, taskId: string | undefined, facts: FactPatch, workerState: string | undefined, signal: string | undefined):
  Promise<{ cause: CauseClass; conf: number } | undefined> {
  try {
    const req: { episodeId: string; taskId?: string; facts: FactPatch; workerState?: string; signal?: string } = { episodeId: ep, facts };
    if (taskId !== undefined) req.taskId = taskId;
    if (workerState !== undefined) req.workerState = workerState;
    if (signal !== undefined) req.signal = signal;
    const raw = await judgeJudge(req);
    if (!isPlainObj(raw)) return undefined;
    const cc = ownData(raw, 'causeClass').value;
    if (!isStr(cc) || !(CAUSE_CLASSES as readonly string[]).includes(cc)) return undefined;
    const conf = finiteAtMost(ownData(raw, 'confidence').value, JUDGE_CONFIDENCE_CAP, 0);
    // INV-2: the ceiling applies to ANY judge output, including a
    // reported 1.0; a missing confidence reads as 0 (pure uncertainty).
    return { cause: cc as CauseClass, conf: conf ?? 0 };
  } catch {
    return undefined;
  }
}

// ─── Main (docs/17 §3 loop) ────────────────────────────────────────────────

export async function investigate(
  packet: InvestigationPacket,
  ports: InvestigationPorts,
  options?: InvestigationOptions,
): Promise<DiagnosisRecordFields> {
  // ── ports handle (audit R1: `ports` itself may be a hostile object
  // whose getters — or typeof's [[GetPrototypeOf]] — throw; every
  // handle read goes through safeRead) ──
  let portsObj: InvestigationPorts | undefined;
  try {
    portsObj = (typeof ports === 'object' && ports !== null) ? ports : undefined;
  } catch {
    portsObj = undefined;
  }
  // ── ts (INV-6: injected clock, never Date()). Audit A5/F1: resolved
  // through resolvePortMethod so a method-style clock keeps its
  // receiver. ──
  let ts = 0;
  try {
    const now = resolvePortMethod(portsObj, 'now');
    if (now !== undefined) {
      const t = now();
      if (typeof t === 'number' && Number.isFinite(t) && t >= 0) ts = t;
    }
  } catch { /* fail-closed at 0 */ }

  // ── fence-read the packet. A REVOKED proxy survives `typeof` on this
  // V8 but throws from [[GetPrototypeOf]] (and any own-property read);
  // a trapping proxy can throw from either. A proto read that throws
  // while typeof passed is hostile-present: mark bad-input:packet. ──
  let p: InvestigationPacket;
  let badPacket = false;
  try {
    if (typeof packet === 'object' && packet !== null) {
      Object.getPrototypeOf(packet); // trap probe: revoked proxies throw HERE
      p = packet;
    } else {
      p = {} as InvestigationPacket; // primitives: absent evidence, no marker
    }
  } catch {
    p = {} as InvestigationPacket;
    badPacket = true;
  }
  // Cycle-A7 F7: a packet whose getOwnPropertyDescriptor TRAP throws
  // is hostile input even when the proto trap passes — docs/17 §0 rule
  // 5 promises disclosure for trapping proxies, but previously only a
  // throwing getPrototypeOf marked. Any field read that hit a throwing
  // descriptor trap flips `badPacket` (fail-safe: fields fall back to
  // absent AND `bad-input:packet` is disclosed).
  let fieldTrap = false;
  const pd = (key: string): Desc => {
    const d = ownData(p, key);
    if (d.threw) fieldTrap = true;
    return d;
  };
  const id = boundedStr(pd('id').value);
  const episodeId = boundedStr(pd('episodeId').value);
  const taskId = boundedStr(pd('taskId').value);
  const attemptId = boundedStr(pd('attemptId').value);

  const signalRaw = pd('signal').value;
  let signalKind: string | undefined;
  if (isPlainObj(signalRaw)) {
    const k = boundedStr(ownData(signalRaw, 'kind').value);
    if (k !== undefined && (SIGNAL_KINDS as readonly string[]).includes(k)) signalKind = k;
  }
  const wsRaw = boundedStr(pd('workerState').value);
  const workerState = wsRaw !== undefined && (WORKER_STATES as readonly string[]).includes(wsRaw) ? wsRaw : undefined;
  const runEndReasonRaw = boundedStr(pd('runEndReason').value);
  const runEndReason = runEndReasonRaw; // free text (bounded); matched by exact value only
  const signalDetail = boundedStr(pd('signalDetail').value);
  const guardFiresN = finiteAtMost(pd('guardFires').value, Number.MAX_SAFE_INTEGER, 0) ?? 0;
  const staleFlag = pd('stale').value === true;

  const accRaw = pd('acceptance').value;
  let acceptanceVerdict: string | undefined;
  if (isPlainObj(accRaw)) {
    const v = boundedStr(ownData(accRaw, 'verdict').value);
    if (v === 'complete' || v === 'incomplete' || v === 'blocked' || v === 'uncertain') acceptanceVerdict = v;
  }

  const explicit = new Map<string, boolean>();
  mergeFacts(explicit, pd('facts').value);

  // Text derivation (docs/17 §3.3): errors + signalDetail, bounded.
  const derived = new Set<string>();
  const derivedMarkers: string[] = [];
  {
    const units: string[] = [];
    let total = 0;
    const errsSlot = pd('errors');
    const errsRaw = errsSlot.value;
    // Cycle-A7 F1: a REVOKED array (or any trap on IsArray) throws from
    // Array.isArray itself — isArraySafe probes first; a hostile-but-
    // present handle is disclosed, never propagated (INV-1).
    if (isArraySafe(errsRaw)) {
      let n = 0;
      try { const len = (errsRaw as unknown[]).length; if (Number.isInteger(len) && len >= 0) n = Math.min(len, MAX_ERRS); } catch { n = 0; }
      for (let i = 0; i < n; i++) {
        let d: PropertyDescriptor | undefined;
        try {
          d = Object.getOwnPropertyDescriptor(errsRaw, i);
        } catch {
          break; // per-index descriptor trap (audit R1): stop collecting
        }
        if (d === undefined || !('value' in d) || !isPlainObj(d.value)) continue;
        const t = boundedStr(ownData(d.value, 'text').value);
        if (t !== undefined && total < MAX_TEXT) { units.push(t.toLowerCase()); total += t.length; }
      }
    }
    if (signalDetail !== undefined && total < MAX_TEXT) units.push(signalDetail.toLowerCase());
    const signalEndpoint = signalKind === 'endpoint-error';
    for (const u of units) deriveTextUnit(u.slice(0, MAX_TEXT), derived, derivedMarkers, signalEndpoint);
    // Cycle-A7 F1: `errors` is a HOSTILE array handle (revoked /
    // IsArray trap — distinct from a plain non-array) — text
    // derivation saw nothing; disclose via badPacket.
    if (arrayTrap(errsRaw)) fieldTrap = true;
  }
  // Explicit facts shadow text derivations (the derived set stays for
  // markers only; classification prefers explicit).

  // Packet refs: copied, never invented (INV-5).
  const refsSlot = pd('evidenceRefs');
  const refsIn = copyStrs(refsSlot.value);
  const packetRefs = refsIn.refs;
  if (refsIn.hostile) fieldTrap = true; // cycle-A7 F1: revoked refs array

  // ── limits (INV-3) ──
  let badLimits = false;
  let limRaw: InvestigationLimits | undefined;
  {
    // A `limits` getter that THROWS is distinguishable from an absent
    // property and is hostile input: mark it (audit R1 — fail-closed to
    // defaults AND disclose).
    let threw = false;
    let optionsRaw: unknown;
    try {
      optionsRaw = (options === undefined || options === null) ? undefined : (options as { limits?: unknown }).limits;
    } catch {
      threw = true;
      optionsRaw = undefined;
    }
    if (threw) badLimits = true;
    if (optionsRaw !== undefined && optionsRaw !== null) {
      limRaw = isPlainObj(optionsRaw) ? optionsRaw as InvestigationLimits : undefined;
      if (limRaw === undefined) badLimits = true; // hostile handle present but unusable
    }
  }
  let badMaxCalls = false;
  const maxToolCallsSlot = limRaw !== undefined ? ownData(limRaw, 'maxToolCalls') : { present: false, value: undefined };
  // Cycle-A7 F3 (major): a getOwnPropertyDescriptor TRAP on the field
  // reads as `{present:false}` — the old code fell through to the
  // DEFAULT budget, so a hostile `limits` proxy spent money the caller
  // never authorized ($0.15 spent under `maxUsd:0` in the A7 repro).
  // A trapping field is hostile input: mark AND fail-closed to ZERO
  // (never the default) — docs/17 §0 rule 4/5.
  if (maxToolCallsSlot.threw) badMaxCalls = true;
  const maxToolCallsRaw = maxToolCallsSlot.present ? finiteAtMostInt(maxToolCallsSlot.value, PROBES.length, 0) : undefined;
  // Audit A5/F6: an explicit `undefined` VALUE is an absent field
  // (docs/17 §0 rule 5: missing/undefined fields drop silently) — only
  // a present field with a non-undefined, non-coercible value is
  // hostile input.
  if (maxToolCallsSlot.present && maxToolCallsSlot.value !== undefined && maxToolCallsRaw === undefined) badMaxCalls = true;
  const maxToolCalls = maxToolCallsSlot.threw ? 0 : (maxToolCallsRaw ?? Math.min(DEFAULT_MAX_TOOL_CALLS, PROBES.length));
  let badMaxUsd = false;
  const maxUsdSlot = limRaw !== undefined ? ownData(limRaw, 'maxUsd') : { present: false, value: undefined };
  if (maxUsdSlot.threw) badMaxUsd = true; // cycle-A7 F3: trap != absent (fail-closed, see above)
  const maxUsdRaw = maxUsdSlot.present ? finiteAtMost(maxUsdSlot.value, Number.MAX_SAFE_INTEGER, 0) : undefined;
  if (maxUsdSlot.present && maxUsdSlot.value !== undefined && maxUsdRaw === undefined) badMaxUsd = true;
  const maxUsd = maxUsdSlot.threw ? 0 : (maxUsdRaw ?? DEFAULT_MAX_USD);

  // ── classify → confirm → probe loop (docs/17 §3/§5) ──
  const ctx: ClassInput = { workerState, runEndReason, guardFires: guardFiresN, acceptanceVerdict };
  if (signalKind !== undefined) ctx.signalKind = signalKind;
  let cur = applyConfirmations(classify(explicit, derived, ctx), explicit);

  const markers: string[] = [];
  if (cur.rule !== undefined) markers.push(`rule:${cur.rule}`);
  markers.push(...derivedMarkers);
  if (staleFlag) markers.push('packet:stale');

  let toolsUsed = 0;
  let spendUsd = 0;
  const probeEvidence: string[] = [];
  const tried = new Set<string>();
  // Audit R1 (HIGH): the old `tools !== undefined && typeof tools.run
  // === 'function'` guard let `tools: null` THROUGH (null !== undefined)
  // and then crashed on `.run`; it also INVOKED a `run` getter trap on
  // a hostile handle. resolvePortMethod fences both and binds `this`.
  const toolsRun = resolvePortMethod(safeRead(portsObj, 'tools'), 'run');

  while (cur.conf < CONFIDENCE_BAR && toolsRun !== undefined) {
    // Order: probes confirming the CURRENT class first, then table order.
    let next: Probe | undefined;
    for (const pr of PROBES) if (tried.has(pr.id) === false && pr.forClass === cur.cause) { next = pr; break; }
    if (next === undefined) for (const pr of PROBES) if (tried.has(pr.id) === false) { next = pr; break; }
    if (next === undefined) break;
    // Charge-first budget check: never start a probe whose estimate
    // would cross the cap (INV-3). Skip WITHOUT counting as used.
    if (spendUsd + next.estimateUsd > maxUsd + 1e-9 || toolsUsed >= maxToolCalls) {
      markers.push(`probe:${next.id}:skipped-budget`);
      tried.add(next.id); // a skipped probe is never re-considered
      continue;
    }
    tried.add(next.id);
    toolsUsed += 1;
    spendUsd += next.estimateUsd; // charge BEFORE the call (no refund)
    const res = await callProbe(toolsRun, next, episodeId ?? '', taskId, attemptId);
    if (!res.ok) {
      markers.push(`probe:${next.id}:failed`);
      continue;
    }
    mergeFacts(explicit, mapToObj(res.facts));
    // Audit A5/F2+F4: a port-reported `usd` may only ADD to the
    // estimate, never replace it downward. `max(reported, estimate)`
    // closes the refund bypass (reporting 0 used to erase the charge
    // and re-open the budget for another probe), and an over-report
    // is recorded honestly — the full reported amount stands (a real
    // overage is evidence, not something to clamp away) while
    // callProbe's MAX_SAFE_INTEGER ceiling keeps the arithmetic finite.
    if (res.usd !== undefined) spendUsd = spendUsd - next.estimateUsd + Math.max(res.usd, next.estimateUsd);
    // Cycle-A7 F9 (minor): per-probe usd is capped at MAX_SAFE_INTEGER
    // but the SUM across probes could drift past it, where doubles lose
    // integer exactness — the REPORTED figure would be unreliable
    // (honesty contract). Clamp the cumulative total; over-reporting
    // beyond $9 quadrillion is disclosed as the clamp value.
    if (spendUsd > Number.MAX_SAFE_INTEGER) spendUsd = Number.MAX_SAFE_INTEGER;
    if (res.evidenceRef !== undefined) probeEvidence.push(res.evidenceRef);
    else markers.push(`probe:${next.id}:ran`);
    // Re-classify with the new facts; text-derived facts never change an
    // explicit classification (the explicit map only ever grows).
    cur = applyConfirmations(classify(explicit, derived, ctx), explicit);
    if (cur.rule !== undefined && !markers.includes(`rule:${cur.rule}`)) markers.push(`rule:${cur.rule}`);
  }

  // ── judge: fills in ONLY `unknown`, clamped below the bar (INV-2) ──
  let judgeUsed = false;
  const judgeJudge = resolvePortMethod(safeRead(portsObj, 'judge'), 'judge');
  if (cur.cause === 'unknown' && judgeJudge !== undefined) {
    const factsObj = mapToObj(explicit) as FactPatch;
    const j = await callJudge(judgeJudge, episodeId ?? '', taskId, factsObj, workerState, signalKind);
    if (j !== undefined) {
      cur = { cause: j.cause, conf: j.conf, rule: cur.rule };
      judgeUsed = true;
      // INV-2 provenance marker is MODULE-origin: reserved with the
      // other markers (below), never evicted by packet refs.
      markers.push('judge:advisory');
    }
  }

  // ── exhaustion marker (docs/11 §14.3 expectedEvidence) ──
  if (cur.cause === 'unknown') markers.push('investigation:exhausted');
  if (badLimits || badMaxCalls || badMaxUsd) markers.push('bad-input:limits');
  if (badPacket || fieldTrap) markers.push('bad-input:packet');
  // cycle-A6 F1: the evidenceRefs scan hit its index budget, so part
  // of the array was never visited — disclosed, never silently dropped.
  if (refsIn.scanExhausted) markers.push('bad-input:scan-budget');
  // cycle-A7 F2: a trap/length-mismatch discards everything copyStrs
  // read — disclose the drop (rule 5), distinct from truncated/spoofed.
  if (refsIn.dropped) markers.push('refs:dropped');

  // ── assemble the record (INV-5) ──
  // Audit R4: markers (rule:/text:/probe:/judge:/bad-input:/…) are
  // MODULE-origin evidence and are reserved BEFORE packet refs, so a
  // hostile packet overflowing evidenceRefs can never evict the record's
  // own provenance.
  // Audit A5/F3: packet refs may not CARRY module-origin prefixes — a
  // packet that listed `judge:advisory` used to forge "the judge was
  // consulted". Reserved-prefix packet refs are dropped and disclosed
  // with `refs:spoofed`.
  // Audit A5/F5: the truncation decision counts UNIQUE refs (duplicates
  // consume no slot), so a ref flood of repeats no longer cries
  // `refs:truncated` when everything unique fits.
  // Audit A5-R1: an ingestion-window overflow (more than MAX_REFS raw
  // entries — the flood was never even seen) is itself disclosed:
  // `refsIn.overflow` forces the disclosure even though `usable`
  // (bounded by MAX_REFS) could never exceed capacity on its own.
  // Cycle-A6 F1: an exhausted scan budget does too — entries past the
  // budget were never visited, so we can only disclose, never prove
  // nothing unique was lost.
  const RESERVED_PREFIXES = ['rule:', 'text:', 'probe:', 'judge:', 'investigation:', 'bad-input:', 'packet:', 'refs:'];
  const seen = new Set<string>();
  const refsOut: string[] = [];
  const pushRef = (r: string): boolean => {
    if (seen.has(r)) return true;
    if (refsOut.length >= MAX_REFS) return false;
    seen.add(r);
    refsOut.push(r);
    return true;
  };
  for (const r of [...markers, ...probeEvidence]) pushRef(r);
  const usable = packetRefs.filter((r) => !RESERVED_PREFIXES.some((pre) => r.startsWith(pre)));
  const spoofedCount = packetRefs.length - usable.length;
  // One marker per disclosure; each is pushed BEFORE the refs it names
  // fill the remaining slots, so a disclosure can never be crowded out
  // by the very overflow it reports. The truncation capacity reserves
  // the refs:spoofed slot too — otherwise the last usable ref vanishes
  // un-disclosed when both disclosures are due.
  const uniqueUsable = new Set(usable).size;
  const disclosureSlots = spoofedCount > 0 ? 1 : 0;
  if (refsIn.overflow || refsIn.scanExhausted || uniqueUsable > MAX_REFS - refsOut.length - disclosureSlots) pushRef('refs:truncated');
  if (spoofedCount > 0) pushRef('refs:spoofed');
  for (const r of usable) pushRef(r);

  const rec: DiagnosisRecordFields = {
    schema: 'tre-supervisor/1',
    kind: 'diagnosis',
    id: id !== undefined && id.length > 0 ? id : 'd-investigation',
    ts,
    episodeId: episodeId !== undefined && episodeId.length > 0 ? episodeId : 'episode-unknown',
    causeClass: cur.cause,
    confidence: Math.round(Math.min(1, Math.max(0, cur.conf)) * 1e6) / 1e6,
    evidenceRefs: refsOut,
    proposedActions: proposedFor(cur.cause, cur.conf),
    limitsRespected: { toolsUsed, spendUsd: Math.round(Math.max(0, spendUsd) * 1e6) / 1e6 },
  };
  if (taskId !== undefined && taskId.length > 0) rec.taskId = taskId;
  if (attemptId !== undefined && attemptId.length > 0) rec.attemptId = attemptId;

  // INV-7 belt: a self-check failure means a module bug — degrade to a
  // minimal honest record rather than an invalid one.
  if (!selfCheck(rec)) {
    const fallback: DiagnosisRecordFields = {
      schema: 'tre-supervisor/1', kind: 'diagnosis',
      id: isStr(rec.id) && rec.id.length > 0 ? rec.id : 'd-investigation',
      ts: typeof rec.ts === 'number' && Number.isFinite(rec.ts) && rec.ts >= 0 ? rec.ts : 0,
      episodeId: isStr(rec.episodeId) && rec.episodeId.length > 0 ? rec.episodeId : 'episode-unknown',
      causeClass: 'unknown', confidence: 0,
      evidenceRefs: ['investigation:exhausted', 'bad-input:self-check'],
      proposedActions: [{ rung: RUNG['investigate'], action: 'investigate', strategyId: STRATEGY['investigate'] }],
      limitsRespected: { toolsUsed: 0, spendUsd: 0 },
    };
    Object.freeze(fallback);
    return fallback;
  }

  Object.freeze(rec);
  Object.freeze(rec.evidenceRefs);
  Object.freeze(rec.proposedActions);
  for (const pa of rec.proposedActions) Object.freeze(pa);
  Object.freeze(rec.limitsRespected);
  return rec;
}

function mapToObj(m: Map<string, boolean>): Record<string, boolean> {
  const o: Record<string, boolean> = {};
  for (const [k, v] of m) o[k] = v;
  return o;
}
