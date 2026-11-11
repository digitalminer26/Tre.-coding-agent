/**
 * P9/M2 — The shared-supervision scheduler core. Contract: docs/20.
 *
 * Doctrine mirrors compose.ts exactly: this module imports NOTHING at
 * runtime — not even `node:` (the src/supervisor compartment guard walks
 * every file in the directory). Every collaborator arrives as a port,
 * every closed set is a local mirror (drift-pinned by
 * test/host-schedule.test.ts), and the recovery loop itself is INJECTED
 * (`deps.loop` = runSupervisorEpisode) — M2-10: the loop body is not
 * touched by M2, it is instantiated N times.
 *
 * What lives here (docs/20 §3–§6; D1–D6 resolutions are binding):
 *  - the ready-set computation and the DETERMINISTIC admission order
 *    (§3.1: (dependsOn-depth, taskId lexicographic) — no clock, no map
 *    order, no arrival order);
 *  - the four-check admission gate (§3.2: capacity → pair (activation) →
 *    worktree → headroom) with closed refusal reasons and once-per-
 *    state-change denial journaling;
 *  - the loop-stop → task-status mapping (§3.3) and the quiescence /
 *    episode-terminal rule (§3.4: terminal events are processed BEFORE
 *    the quiesce decision — no TOCTOU "nothing runnable");
 *  - the capacity file contract (§4.1, `tre-capacity/1`): all-or-
 *    nothing, fail-closed to serialize, disclosures from the closed
 *    token set; `maxParallel` can only LOWER admission (docs/20 §12);
 *  - swap re-admission accounting (§4.3) via CapacitySlots;
 *  - the global observer slot + the no-starvation fairness queue (§5,
 *    D1: one slot per episode, least-grants-first ⇒ granted within W);
 *  - the scheduler's four journal kinds (§9), quiescence semantics, and
 *    a loop-structure backstop ON ADMISSIONS (per-loop maxIterations is
 *    untouched, §1.1).
 *
 * P8 owns money (D5/D6): a ledger-cited admission denial always outranks
 * the scheduler's capacity verdict — never a false `capacity:full` when
 * the truth is "the ledger would not cover this task". D6's mapping of
 * recoveryBudget → ledger episode caps happens at policy derivation in
 * the HOST (gatePolicyFromGraph); planner classification keeps reading
 * the raw recoveryBudget, so its behavior is unchanged.
 *
 * Journal authority note: the four `sched-*` kinds are NOT P4
 * SupervisorRecord kinds — appending them is the host journal adapter's
 * job (the scheduler only hands records to `deps.journal`); the loop's
 * own records stay under docs/18 §8.4's kinds.
 */

// ─── Mirrored closed sets (pinned by test/host-schedule.test.ts) ──────────

/** Mirror of `TASK_STATUSES` (the S3 episode-journal module, §14.4). */
export const TASK_STATUSES_MIRROR = [
  'queued', 'ready', 'running', 'paused', 'done', 'failed', 'parked',
] as const;
export type TaskStatusMirrored = (typeof TASK_STATUSES_MIRROR)[number];

/** The scheduler's CLOSED stop reasons (docs/20 §3.4). */
export const SCHED_STOP_REASONS = ['quiesced-complete', 'quiesced-blocked', 'shutdown'] as const;
export type SchedStopReason = (typeof SCHED_STOP_REASONS)[number];

/** The scheduler's CLOSED journal kinds (docs/20 §9 — additive superset
 *  of docs/18 §8.4's loop kinds; the scheduler appends nothing else). */
export const SCHED_JOURNAL_KINDS = ['sched-admit', 'sched-deny', 'sched-observer-grant', 'scope-overlap'] as const;
export type SchedJournalKind = (typeof SCHED_JOURNAL_KINDS)[number];

/** The CLOSED capacity disclosure tokens (docs/20 §4.1) — exactly these;
 *  the first three each mean serialize, `full` denies one admission. */
export const CAPACITY_DISCLOSURES = [
  'capacity:missing', 'capacity:invalid', 'capacity:stale', 'capacity:bad-entry', 'capacity:full',
] as const;
export type CapacityDisclosure = (typeof CAPACITY_DISCLOSURES)[number];

/** CLOSED admission refusal reasons (docs/20 §3.2 + §6). `capacity:full`
 *  is the ONLY scheduler-owned refusal — a headroom denial always rides
 *  its ledger-cited codes (D5), never the scheduler's own verdict. */
export const ADMISSION_REFUSALS = [
  'capacity:full', 'worktree-refused', 'budget-headroom', 'pair-collision', 'scope-invalid',
] as const;
export type AdmissionRefusal = (typeof ADMISSION_REFUSALS)[number];

/** Mirror of compose.ts `STOP_REASONS` (the loop contract, docs/18 §3) —
 *  drift-pinned so a loop-contract change breaks the scheduler tests. */
export const LOOP_STOP_REASONS_MIRROR = [
  'accepted-finish', 'finish-unjudged', 'halt', 'hold', 'escalation-exhausted',
  'parked', 'shutdown', 'max-iterations', 'loop-error', 'no-initial-signal',
  'initial-run-denied', 'completed',
] as const;

/** Task-id grammar the scheduler admits at activation (docs/20 §7: the
 *  P6 bad-id grammar — validated BEFORE any worktree add). */
export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ─── §3.3: loop stop → task status (the whole table, as a pure function) ──

/**
 * Map a loop stop (docs/18 §3) to the scheduler's derived task status
 * (docs/20 §3.3). The loop contract is closed, so an unmapped stop is a
 * contract break and fails closed to `failed`.
 */
export function mapLoopStop(stopped: string): TaskStatusMirrored {
  switch (stopped) {
    case 'accepted-finish':
    case 'completed':
      return 'done';
    case 'parked':
      return 'parked';
    case 'shutdown':
      return 'paused';
    default:
      // halt | hold | escalation-exhausted | initial-run-denied |
      // no-initial-signal | max-iterations | loop-error |
      // finish-unjudged → failed (the loop's disclosure rides as evidence)
      return 'failed';
  }
}

// ─── §4.1: the capacity file (all-or-nothing, fail-closed serialize) ──────

export interface CapacityView {
  /** endpoint id -> maxConcurrent (the required "*" catch-all included
   *  when valid). NEVER invented: empty on every file failure mode. */
  caps: Record<string, number>;
  /** disclosure tokens from CAPACITY_DISCLOSURES (deduped). */
  disclosures: CapacityDisclosure[];
}

/**
 * Parse the capacity file. EVERY whole-file failure mode returns an
 * EMPTY caps map (= serialize everywhere) plus its disclosure; partial
 * trust of a corrupt file is the doctrine violation this function exists
 * to prevent (all-or-nothing, same rule as the ledger fold, docs/20
 * §4.1). A single bad ENTRY only serializes that endpoint.
 */
export function parseCapacity(raw: string | undefined, now: number): CapacityView {
  const fail = (d: CapacityDisclosure): CapacityView => ({ caps: {}, disclosures: [d] });
  if (raw === undefined) return fail('capacity:missing');
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return fail('capacity:invalid'); }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail('capacity:invalid');
  const o = v as Record<string, unknown>;
  if (o['schema'] !== 'tre-capacity/1') return fail('capacity:invalid');
  const measuredAt = o['measuredAt']; const ttlS = o['ttlS']; const endpoints = o['endpoints'];
  if (typeof measuredAt !== 'number' || !Number.isFinite(measuredAt) || measuredAt < 0) return fail('capacity:invalid');
  if (typeof ttlS !== 'number' || !Number.isFinite(ttlS) || ttlS < 0) return fail('capacity:invalid');
  if (endpoints === null || typeof endpoints !== 'object' || Array.isArray(endpoints)) return fail('capacity:invalid');
  if (now - measuredAt > ttlS * 1000) return fail('capacity:stale');
  const caps: Record<string, number> = {}; const disclosures: CapacityDisclosure[] = [];
  for (const [ep, entry] of Object.entries(endpoints as Record<string, unknown>)) {
    const mc = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? (entry as { maxConcurrent?: unknown }).maxConcurrent : undefined;
    if (typeof mc !== 'number' || !Number.isSafeInteger(mc) || mc < 1) {
      if (!disclosures.includes('capacity:bad-entry')) disclosures.push('capacity:bad-entry');
      // A bad entry SERIALIZES that endpoint itself — it must never
      // inherit the (possibly larger) catch-all capacity (docs/20 §4.1:
      // "that endpoint serializes", fail-closed, not fall-through).
      caps[ep] = 1;
      continue;
    }
    caps[ep] = mc;
  }
  // The "*" catch-all is REQUIRED (docs/20 §4.1): without it an unknown
  // endpoint would run on an inferred capacity — refuse the whole file.
  if (caps['*'] === undefined) return fail('capacity:invalid');
  return { caps, disclosures };
}

/** Resolve the cap for an endpoint: exact entry, then catch-all, then
 *  serialize (1). Never anything else. */
export function capFor(caps: Record<string, number>, endpointId: string): number {
  const c = caps[endpointId] ?? caps['*'];
  return typeof c === 'number' && Number.isSafeInteger(c) && c >= 1 ? c : 1;
}

/** A graph task targets an endpoint by its model id (docs/20 §4: the
 *  capacity file is keyed by endpoint id == the model string). Absent
 *  model = the catch-all endpoint. */
export function endpointOfModel(model: string | undefined): string {
  return typeof model === 'string' && model.length > 0 ? model : '*';
}

// ─── §4.3: slot accounting (admission-lifetime, NOT a ledger concept) ─────

/**
 * Concurrency accounting for one episode: per-endpoint caps (from the
 * capacity view) plus an optional episode ceiling that can only LOWER
 * admission (docs/20 §12: --max-parallel never raises a measured cap).
 * In-memory only; the scheduler re-derives the live set on restart (§8).
 * A held slot is the task-loop lifetime (admit → terminal); swap
 * re-admission uses acquire/release on the target endpoint (§4.3).
 */
export class CapacitySlots {
  private used = new Map<string, number>();
  private total = 0;
  constructor(private readonly caps: Record<string, number>, private readonly maxParallel?: number) {}
  /** Acquire a slot on `endpoint`; false when full (endpoint cap or the
   *  episode ceiling). No partial state on a failed acquire. */
  tryAcquire(endpoint: string): boolean {
    if (this.maxParallel !== undefined && this.total >= this.maxParallel) return false;
    const usedE = this.used.get(endpoint) ?? 0;
    if (usedE >= capFor(this.caps, endpoint)) return false;
    this.used.set(endpoint, usedE + 1);
    this.total += 1;
    return true;
  }
  release(endpoint: string): void {
    const usedE = this.used.get(endpoint) ?? 0;
    if (usedE < 1) return; // no slot held on this endpoint — a stale/double
    // release must NOT corrupt the episode-ceiling count (an undercount
    // would silently over-admit every later task in the episode).
    if (usedE <= 1) this.used.delete(endpoint); else this.used.set(endpoint, usedE - 1);
    if (this.total > 0) this.total -= 1;
  }
  /** AUDIT C1-3 (round 3): seed occupancy from durable evidence at
   *  restart (§8: "a task with an open run reservation is treated as
   *  occupying its endpoint slot until reconcile proves otherwise").
   *  A reservation fact, not a request: the cap is NOT consulted and
   *  nothing is refused — a cap-1 endpoint seeded with one occupant
   *  must deny the next admission there, exactly like a live loop. */
  reserve(endpoint: string): void {
    this.used.set(endpoint, (this.used.get(endpoint) ?? 0) + 1);
    this.total += 1;
  }
  /** §4.3 swap re-admission: move ONE held slot from `from` to `target`
   *  atomically. The task keeps occupying exactly one slot throughout —
   *  the episode ceiling (`maxParallel`) never denies a pure endpoint
   *  change — while the TARGET endpoint's own cap is still enforced
   *  (fail-closed on a full target). False = target full or nothing held
   *  on `from`; no partial state either way. */
  transfer(from: string, target: string): boolean {
    if (from === target) return true;
    const usedFrom = this.used.get(from) ?? 0;
    if (usedFrom < 1) return false;
    const usedTarget = this.used.get(target) ?? 0;
    if (usedTarget >= capFor(this.caps, target)) return false;
    if (usedFrom <= 1) this.used.delete(from); else this.used.set(from, usedFrom - 1);
    this.used.set(target, usedTarget + 1);
    return true;
  }
  usedOf(endpoint: string): number { return this.used.get(endpoint) ?? 0; }
  live(): number { return this.total; }
}

// ─── §5: the global observer slot + no-starvation fairness (D1) ───────────

/**
 * One GLOBAL observer slot (D1: default 1 per episode; the slot count
 * is clamped to 1 — the resolution is binding and P15 consumes no
 * worker capacity slot, §4.3) with a deterministic, starvation-free
 * grant rule. Fairness is an EPOCH over CURRENT waiters, not lifetime
 * totals (the lifetime-total rule let a recently-joined task starve an
 * older waiter past the W bound — audited): every task carries the
 * grant-turn it was last served (or joined) at; the waiter with the
 * biggest deficit (current turn − last served) wins; ties break by
 * (signal seq, taskId, arrival). Deficits equalize under max-deficit-
 * first service, so any waiting task is granted within W grants (W =
 * waiting count) — the §5 no-starvation bound.
 * Grants are disclosed (onGrant → the scheduler journals
 * `sched-observer-grant`); a diagnosis that waits is visible.
 */
export class ObserverQueue {
  private grants = new Map<string, number>();
  /** grant-turn at which each tracked task was last served (or first
   *  joined the queue — a joiner starts even, it does not inherit stale
   *  deficits, and does not reset on re-request it earned by waiting). */
  private lastServed = new Map<string, number>();
  private turn = 0;
  private waiting: { taskId: string; seq: number; order: number; resolve: () => void }[] = [];
  private inFlight = 0;
  private seqCounter = 0;
  private readonly slots: number;
  constructor(slots = 1, private readonly onGrant?: (taskId: string) => void) {
    this.slots = typeof slots === 'number' && Number.isSafeInteger(slots) && slots >= 1 ? 1 : 1;
  }
  /** Resolves when the task's observer turn comes; call release() when
   *  the investigation settles. */
  request(taskId: string, seq: number): Promise<void> {
    if (!this.lastServed.has(taskId)) this.lastServed.set(taskId, this.turn);
    const order = (this.seqCounter += 1);
    const safeSeq = typeof seq === 'number' && Number.isFinite(seq) ? seq : 0;
    return new Promise<void>((resolve) => {
      this.waiting.push({ taskId, seq: safeSeq, order, resolve });
      this.pick();
    });
  }
  release(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
    this.pick();
  }
  /** Deterministic grant order over the current waiters (pure view):
   *  biggest service-deficit first. */
  pickOrder(): string[] {
    return [...this.waiting]
      .sort((a, b) => {
        const da = this.turn - (this.lastServed.get(a.taskId) ?? 0);
        const db = this.turn - (this.lastServed.get(b.taskId) ?? 0);
        if (da !== db) return db - da;
        if (a.seq !== b.seq) return a.seq - b.seq;
        if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;
        return a.order - b.order;
      })
      .map((w) => w.taskId);
  }
  waitingCount(): number { return this.waiting.length; }
  grantedCount(taskId: string): number { return this.grants.get(taskId) ?? 0; }
  private pick(): void {
    while (this.inFlight < this.slots && this.waiting.length > 0) {
      const head = this.pickOrder()[0]!;
      const idx = this.waiting.findIndex((w) => w.taskId === head);
      const chosen = this.waiting[idx]!;
      this.waiting.splice(idx, 1);
      this.inFlight += 1;
      this.lastServed.set(chosen.taskId, this.turn);
      this.turn += 1;
      this.grants.set(chosen.taskId, (this.grants.get(chosen.taskId) ?? 0) + 1);
      if (this.onGrant !== undefined) { try { this.onGrant(chosen.taskId); } catch { /* disclosure only */ } }
      chosen.resolve();
    }
  }
}

// ─── §3.1: ready set (pure over (graph, derived fates)) ───────────────────

export interface SchedTaskLike {
  id: string;
  dependsOn?: string[];
  model?: string;
  session?: string;
  worktreePath?: string;
  scope?: { files?: string[]; notFiles?: string[] };
  status?: string;
  /** derived evidence the host re-read from durable records on restart
   *  (docs/20 §8): the acceptance verdict that made a seeded `done`.
   *  AUDIT-R1 — without it a restarted scheduler could never unblock
   *  the dependents of previously-accepted work. */
  result?: { acceptance?: string };
  /** AUDIT C1-3 (round 3): §8 restart occupancy — set by the host when
   *  durable evidence (a ledger open run reservation reconcile could
   *  not clear) says this seeded task may still occupy a worker slot on
   *  its endpoint. The scheduler reserves that slot before admitting
   *  anything else; the reservation is evidence, not a request. */
  occupies?: { endpoint?: string };
}
export interface SchedGraphLike {
  episodeId: string;
  tasks: SchedTaskLike[];
}
export interface TaskFate {
  status: TaskStatusMirrored;
  detail?: string;
  /** the acceptance verdict that made a `done` (docs/20 §3.1: a
   *  dependent requires `result.acceptance === "complete"`). */
  acceptance?: string;
}

/** Defensive cycle re-check (docs/20 §3.1: the P4 guard is the
 *  authority; the scheduler refuses cyclic input it was handed rather
 *  than run it). Returns a task id ON a cycle, undefined when acyclic. */
export function findCycle(tasks: SchedTaskLike[]): string | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 'visiting' | 'done'>();
  let culprit: string | undefined;
  const visit = (id: string): void => {
    if (culprit !== undefined) return;
    const s = state.get(id);
    if (s === 'done') return;
    if (s === 'visiting') { culprit = id; return; }
    state.set(id, 'visiting');
    const t = byId.get(id);
    for (const d of t?.dependsOn ?? []) if (byId.has(d)) visit(d);
    state.set(id, 'done');
  };
  for (const t of tasks) visit(t.id);
  return culprit;
}

/** Dependency depth for the deterministic sort key (a dependency on an
 *  unknown id extends depth but never satisfies readiness). */
export function depthOf(taskId: string, byId: Map<string, SchedTaskLike>, seen: Set<string> = new Set()): number {
  if (seen.has(taskId)) return 0; // acyclic by contract; belt only
  seen.add(taskId);
  const deps = byId.get(taskId)?.dependsOn ?? [];
  let d = 0;
  for (const dep of deps) {
    const branch = 1 + depthOf(dep, byId, new Set(seen));
    if (branch > d) d = branch;
  }
  return d;
}

/**
 * The ready set (docs/20 §3.1): a still-QUEUED task whose every
 * dependency is `done` WITH acceptance `complete`. A dependency that
 * failed, parked, or finished unaccepted NEVER satisfies — dependents
 * stay blocked, they never speculatively run. Output order is
 * (depth, taskId lexicographic) — deterministic (A7-style).
 */
export function computeReady(tasks: SchedTaskLike[], fates: Map<string, TaskFate>): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const satisfied = (depId: string): boolean => {
    const f = fates.get(depId);
    return f !== undefined && f.status === 'done' && f.acceptance === 'complete';
  };
  const ready = tasks
    .filter((t) => {
      const cur = fates.get(t.id);
      if (cur !== undefined) return cur.status === 'queued';
      return t.status === undefined || t.status === 'queued';
    })
    .filter((t) => (t.dependsOn ?? []).every(satisfied))
    .map((t) => ({ id: t.id, depth: depthOf(t.id, byId) }));
  ready.sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ready.map((r) => r.id);
}

// ─── §7: graph-level activation refusals (throw = setup failure, exit 1) ──

/**
 * Validate the graph for scheduler admission BEFORE any spawn (docs/20
 * §7): duplicate task ids, duplicate session paths, ids outside the P6
 * grammar, cycles. Throws `sched: <refusal>`; the host maps it to the
 * setup-failure exit. (Worktree paths derive from task ids —
 * `<ep>/wt/<taskId>` — so id uniqueness subsumes worktree uniqueness;
 * a graph that pins explicit paths is checked by the host caller.)
 */
export function validateScheduleGraph(graph: SchedGraphLike): void {
  const seenId = new Set<string>(); const seenSession = new Set<string>();
  for (const t of graph.tasks) {
    if (typeof t.id !== 'string' || !TASK_ID_RE.test(t.id)) throw new Error(`sched: bad-task-id:${String(t.id).slice(0, 64)}`);
    if (seenId.has(t.id)) throw new Error(`sched: duplicate-task-id:${t.id}`);
    seenId.add(t.id);
    if (typeof t.session === 'string' && t.session.length > 0) {
      if (seenSession.has(t.session)) throw new Error(`sched: duplicate-session:${t.session.slice(0, 128)}`);
      seenSession.add(t.session);
    }
  }
  const cyc = findCycle(graph.tasks);
  if (cyc !== undefined) throw new Error(`sched: cycle:${cyc}`);
}

// ─── §3.2 advisory scope-overlap (closed, deterministic, non-blocking) ────

/** Coarse segment overlap of two scope patterns (docs/20 §3.2: ADVISORY
 *  only — enforcement stays with the worker sandbox + git). Patterns
 *  split on "/"; `*` matches one segment, `**` any depth from here. */
export function patternsOverlap(a: string, b: string): boolean {
  const sa = a.split('/'); const sb = b.split('/');
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    if (sa[i] === '**' || sb[i] === '**') return true;
    if (segOverlap(sa[i]!, sb[i]!)) continue;
    return false;
  }
  return true;
}

/** Segment-level overlap: equal, either side `*` (a whole-segment
 *  wildcard), or a glob segment matching the other (`*.ts` vs `a.ts`).
 *  `*` never crosses `/` — a segment wildcard only. */
function segOverlap(x: string, y: string): boolean {
  if (x === y || x === '*' || y === '*') return true;
  if (!x.includes('*') && !y.includes('*')) return false;
  const glob = x.includes('*') ? x : y;
  const other = x.includes('*') ? y : x;
  if (other.includes('*')) return true; // two patterns: conservatively overlap
  const re = new RegExp('^' + glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^/]*') + '$');
  return re.test(other);
}

/** Pairs of concurrently-admitted tasks with overlapping writable scope
 *  (each pair once, ordered) — journalized `scope-overlap`, never a
 *  refusal. */
export function scopeOverlapPairs(tasks: { id: string; files?: string[] }[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!, b = tasks[j]!;
      let hit = false;
      for (const fa of a.files ?? []) {
        for (const fb of b.files ?? []) { if (patternsOverlap(fa, fb)) { hit = true; break; } }
        if (hit) break;
      }
      if (hit) out.push(a.id < b.id ? [a.id, b.id] : [b.id, a.id]);
    }
  }
  return out;
}

// ─── The scheduler episode (event-driven, docs/20 §3.4) ───────────────────

export interface SchedLoopResultLike {
  stopped: string;
  detail?: string;
  iterations?: unknown[];
  investigationCount?: number;
}

/** What the scheduler hands the host's port-builder per task: the
 *  fairness-queued observer thunk and the §4.3 swap re-admission. */
export interface SchedulerLoopHooks {
  /** the loop's investigate port: a THUNK through the scheduler's
   *  fairness queue over the single global observer slot (§5). The
   *  host's per-loop `investigate` port IS this function. */
  investigate(packet: object, limits: object): Promise<object>;
  /** §4.3 swap re-admission: the host's runner wrapper calls this before
   *  a model-swap resumes on a new endpoint; false = the swap fails as a
   *  denied action (the planner treats it like any denial, budget
   *  untouched). On success the task's held slot moves to the target. */
  capacitySwap(model: string | undefined, current: string | undefined): boolean;
}

export interface SchedulerDeps {
  graph: { read(): Promise<SchedGraphLike> };
  /** runSupervisorEpisode, injected (M2-10: the scheduler instantiates
   *  the loop, it never edits it). */
  loop: (cfg: object, ports: object) => Promise<SchedLoopResultLike>;
  /** host mappers: graph task -> the loop's (cfg, ports). `ports` MUST
   *  use hooks.investigate (and may use hooks.capacitySwap inside the
   *  runner wrapper). */
  loopConfig: (task: SchedTaskLike) => object;
  loopPorts: (task: SchedTaskLike, hooks: SchedulerLoopHooks) => object;
  /** raw capacity-file bytes (the host reads the file; undefined =
   *  missing → serialize + disclose). */
  capacity: { read(): Promise<string | undefined> };
  /** episode ceiling — can only LOWER the capacity file (docs/20 §12). */
  maxParallel?: number;
  /** P6 worktree provisioning per admitted task (docs/20 §3.2.3); a
   *  refusal PARKS that task, siblings unaffected. */
  worktrees?: { ensure(taskId: string): Promise<{ path?: string; refused?: string }>; release?(taskId: string): Promise<void> };
  /** P8 headroom view (docs/20 §3.2.4 + §6: reserve-first doctrine —
   *  the scheduler asks the ledger for standing coverage, never an
   *  estimate of its own invention). */
  ledger?: { headroom(): { usdOk: boolean; turnsOk: boolean } };
  /** D5 resolver: the REAL gate check for this task's admission floor
   *  (the host runs the ledger's check over the task's reservation
   *  floor). A denial's codes CITE the ledger and outrank capacity.
   *  AUDIT C1-4 (round 3): §6's exit test is "N+1 tasks each
   *  individually affordable but collectively over budget leave the
   *  remainder UNADMITTED with a ledger-cited denial" — but the loop's
   *  reserve (the act boundary) may not exist yet when a sibling's
   *  check runs, so a check over durable state alone cannot see the
   *  aggregate. The scheduler discloses the facts only IT knows —
   *  `admitted`: the tasks it has already admitted this episode whose
   *  reservations may be outstanding. The host folds them into the
   *  standing coverage; the scheduler still mints NOTHING (§6: no new
   *  budget surface). Absent/ignored by older hosts: behavior is
   *  unchanged (the ledger's own reserve denial then ends the attempt
   *  path — still safe, just not the §6-cited admission denial). */
  admissionCheck?: (task: SchedTaskLike, ctx?: { admitted: string[] }) => Promise<{ allowed: boolean; codes: string[] }>;
  /** the acceptance verdict for a done-shaped loop stop — the host
   *  re-reads the JOURNALED acceptance record (trichotomy: records
   *  decide `done`, not the in-memory result). Absent = the stop's own
   *  evidence (`accepted-finish` ⇒ complete). */
  acceptanceFor?: (task: SchedTaskLike, res: SchedLoopResultLike) => Promise<string | undefined>;
  /** scheduler-level operator shutdown steer (docs/20 §3.4). */
  shutdown?: { poll(): Promise<boolean> };
  journal?: { append(record: object): Promise<void> };
  /** M2 audit cycle 2 (R2): live-set projection observer. Called by the
   *  scheduler on each admission and each terminal transition (and after
   *  a successful swap) with the CURRENT live set (taskId -> endpoint) —
   *  the scheduler's in-memory `running` map is the ONLY source, so the
   *  projection stays derived, never an input (docs/20 §12: "rebuilt
   *  from the scheduler's in-memory live set on each write"). The host
   *  uses it to rebuild the S6 state.json `slots` projection mid-run
   *  instead of only at episode end. DISCLOSURE-ONLY: invoked
   *  synchronously and fire-and-forget (never awaited — no new await
   *  point on the admission path, so the F1 stop-flag window stays
   *  closed), and a throwing projector never affects scheduling.
   *  Absent = no projection (behavior unchanged). */
  onLiveSet?: (live: { taskId: string; endpoint: string }[]) => void;
  /** AUDIT R4-F3 (round 4) + F3 (haiku55 round 5): per-activation
   *  identity (the host's lease token — `token` from claimLease) is
   *  REQUIRED. Journal action ids are counters per activation, so a
   *  restart replaying the same episode minted the SAME actionIds as
   *  its predecessor (durable-evidence identity collision — probe P3:
   *  two activations of one episode on a shared journal emitted
   *  identical kind/actionId/seq). An opt-in prefix left the SHIPPED
   *  DEFAULT on the collision path; docs/20 §8 explicitly permits
   *  re-admission after a crash, so uniqueness across activations is
   *  the contract, not a courtesy. The host MUST pass the lease token;
   *  a missing/blank activation is an activation refusal (throws,
   *  setup-failure exit). Every action id — admit, deny, observer
   *  grant, and scope-overlap — carries the slug. */
  activation: string;
  /** raw P15 call (the host's observer resource); fairness is layered
   *  over it here — the loops only ever see hooks.investigate. */
  investigate?: (task: SchedTaskLike, packet: object, limits: object) => Promise<object>;
  observerSlots?: number;
  /** loop-structure backstop for the SCHEDULER: a cap on ADMISSIONS
   *  (per-loop maxIterations stays per loop, docs/20 §1.1). */
  maxIterations?: number;
  clock: { now(): number };
  log?: (line: string) => void;
}

export interface SchedulerTaskOutcome {
  status: TaskStatusMirrored;
  detail?: string;
  stopped?: string;
  iterations?: number;
  investigations?: number;
  /** denial reasons seen for this task (deduped, latest state). */
  denials: string[];
}

export interface SchedulerResult {
  stopped: SchedStopReason;
  detail?: string;
  tasks: Record<string, SchedulerTaskOutcome>;
  admissions: number;
  denials: { taskId: string; reason: string; detail?: string }[];
  disclosures: CapacityDisclosure[];
  observerGrants: number;
}

const DEFAULT_SCHED_MAX_ADMISSIONS = 256;

function isObj(v: unknown): v is Record<string, unknown> {
  try { return typeof v === 'object' && v !== null && !Array.isArray(v); } catch { return false; }
}
function sstr(v: unknown, max = 240): string | undefined {
  try { return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined; } catch { return undefined; }
}

/**
 * Run one scheduled episode (docs/20 §2–§6). Activation refusals (bad
 * graph: duplicate ids/sessions, cycle, bad grammar, episodeId
 * mismatch) THROW — the host maps them to the setup-failure exit (1).
 * Every runtime outcome is a named SchedulerResult; a throwing loop
 * becomes a `loop-error` stop mapped per §3.3 (the scheduler never
 * re-throws a loop failure).
 */
export async function runSchedulerEpisode(
  episodeInput: { episodeId: string },
  deps: SchedulerDeps,
): Promise<SchedulerResult> {
  const log = deps.log ?? (() => { /* no sink */ });
  const graph = await deps.graph.read();
  validateScheduleGraph(graph);
  if (graph.episodeId !== episodeInput.episodeId) {
    throw new Error(`sched: episodeId-mismatch:${String(graph.episodeId).slice(0, 64)}`);
  }
  const now = (): number => { try { const t = deps.clock.now(); return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : 0; } catch { return 0; } };

  // §4.1: the capacity view is read ONCE per activation (the file is
  // operator-owned; a rebuild is a fresh activation with a fresh read).
  // AUDIT F3 (haiku55 round 5): the activation identity is checked
  // BEFORE anything is touched (an activation refusal throws → the
  // host's setup-failure exit; nothing spawns).
  if (typeof deps.activation !== "string" || deps.activation.trim() === "") {
    throw new Error('sched: activation-required');
  }
  let raw: string | undefined;
  try { raw = await deps.capacity.read(); } catch { raw = undefined; }
  const cap = parseCapacity(raw, now());
  const disclosures = [...cap.disclosures];
  for (const d of disclosures) log(d);
  const slots = new CapacitySlots(cap.caps, deps.maxParallel);
  // AUDIT R4-F3 (round 4) + F3 (haiku55 round 5): the activation is
  // REQUIRED (checked above), so every action id in this run carries
  // the lease-token slug — the per-task seq counters restart at 0 every
  // activation and a restart replaying the same episode would mint the
  // SAME journal actionIds as its predecessor (deny/admit/grant/overlap
  // alike). Prefix the lease token (slugged to the journal id alphabet).
  const actSlug = deps.activation.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const actPrefix = `${actSlug}-`;
  let observerGrants = 0;
  const observer = new ObserverQueue(deps.observerSlots ?? 1);

  const tasks = graph.tasks;
  const fates = new Map<string, TaskFate>();
  const outcomes = new Map<string, SchedulerTaskOutcome>();
  // AUDIT R4-F2 (round 4): occupancy is INDEPENDENT of the seeded
  // status. The old code honored `occupies` only inside the terminal
  // branch, so a seed still marked `running` (reconcile not yet
  // conclusive) reserved nothing and another task took its endpoint
  // slot — exactly the double-spawn §8 forbids. Evidence is evidence:
  // reserve first, interpret the fate after.
  for (const t of tasks) {
    if (t.occupies !== undefined) {
      slots.reserve(endpointOfModel(t.occupies.endpoint ?? t.model));
    }
  }
  for (const t of tasks) {
    const initial = sstr(t.status, 32);
    // AUDIT F2 (haiku55 round 5): a seeded `running` whose reconcile
    // verdict never landed (no occupies evidence) was SILENTLY IGNORED
    // — no fate, no slot — so a possibly-live worker's endpoint was
    // treated as free and a new task was admitted onto a cap-1
    // endpoint (double-spawn, the exact §8 violation). A task whose
    // worker MAY still run is parked, never double-spawned: fail
    // closed. With occupies evidence the slot was already reserved in
    // the occupancy pass above (R4-F2, must not regress); the fate is
    // still parked — the evidence reserves, reconcile decides.
    if (initial === 'running') {
      // Without occupies evidence nothing reserved this endpoint yet —
      // reserve it NOW (fail closed): until reconcile proves the old
      // worker dead, its slot is not handed out (§8: a task whose
      // worker may still run is never double-spawned onto its
      // endpoint). Evidence-present was already reserved by the
      // occupancy pass; this branch must not double-reserve it.
      if (t.occupies === undefined) slots.reserve(endpointOfModel(t.model));
      const dwhy = t.occupies !== undefined
        ? 'reconcile-pending:occupies-evidence'
        : 'reconcile-pending:no-evidence';
      fates.set(t.id, { status: 'parked', detail: dwhy });
      outcomes.set(t.id, { status: 'parked', detail: dwhy, denials: [] });
      continue;
    }
    if (initial === 'paused' || initial === 'done' || initial === 'failed' || initial === 'parked') {
      // AUDIT-R1: carry the durable acceptance evidence into the fate —
      // a seeded `done` whose verdict is `complete` gates its dependents
      // OPEN (§3.1); `done` with no/other verdict gates them CLOSED.
      const acceptance = initial === 'done' ? sstr(t.result?.acceptance, 32) : undefined;
      // AUDIT C1-7 (round 3): a seeded `done` whose durable verdict is
      // NOT `complete` is the same evidence that turns a fresh finish
      // to `failed` (§3.3) — §8 rewrites derived status from evidence,
      // so normalize identically. Left as `done`, an all-seeded graph
      // reported quiesced-COMPLETE on unaccepted work (a false-green
      // episode; §3.4 maps that to success).
      let status = initial as TaskStatusMirrored;
      let sdetail: string | undefined;
      if (initial === 'done' && acceptance !== 'complete') {
        status = 'failed';
        sdetail = `unaccepted:${acceptance ?? 'missing'}`;
      }
      // AUDIT C1-3 (round 3): §8 restart occupancy — reserved in the
      // occupancy pass ABOVE (R4-F2), regardless of this seeded status.
      fates.set(t.id, { status, ...(acceptance !== undefined ? { acceptance } : {}), ...(sdetail !== undefined ? { detail: sdetail } : {}) });
      outcomes.set(t.id, { status, denials: [], ...(sdetail !== undefined ? { detail: sdetail } : {}) });
    }
  }
  const running = new Map<string, { endpoint: string; task: SchedTaskLike }>();
  /** R2: publish the live set to the host's projection observer. Called
   *  at every admission, terminal, rollback and successful swap — the
   *  ONLY events that change `running`. Synchronous + try-wrapped:
   *  disclosure-only, never an await (the F1 stop-flag window stays
   *  closed), never fatal. */
  const project = (): void => {
    if (deps.onLiveSet === undefined) return;
    try { deps.onLiveSet([...running.entries()].map(([taskId, r]) => ({ taskId, endpoint: r.endpoint }))); }
    catch { /* projection is disclosure only */ }
  };
  // AUDIT C1-4 (round 3): EVERY task admitted this episode (a finished
  // loop's ledger reservation may still be unsettled) — the aggregate
  // the host's admissionCheck folds into standing coverage.
  const admittedEver: string[] = [];
  const denials: { taskId: string; reason: string; detail?: string }[] = [];
  const lastDenial = new Map<string, string>();
  // scope-overlap pairs already journaled this episode (AUDIT F4, round 2)
  const overlapJournalized = new Set<string>();
  let admissions = 0; let schedSeq = 0; let observerSeq = 0; let denySeq = 0;
  let shutdownRequested = false;
  // AUDIT C1-2 (round 3): ANY await since the shutdown flag was last
  // polled can let host state flip — journal appends (including the
  // ones on DENIAL paths), admission checks, worktree ensures. The
  // flag is scheduler-scoped: refreshShutdown() clears it, every
  // awaiting primitive sets it, and decide() re-polls before each
  // admission exactly when it is set. (A per-pass local missed
  // denial-path awaits and re-based incorrectly per decide call.)
  // AUDIT R4-F1 (round 4): `awaitSincePoll` REMOVED. It could not
  // express the hazard: (a) a journal append that YIELDS then REJECTS
  // skipped the flag-setting (the await interleaves regardless of the
  // outcome), and (b) an async shutdown poll that captured `false`
  // before yielding means "no await since the last poll" was simply
  // not evidence of no interleaving. The pre-admit shutdown re-check
  // is now UNCONDITIONAL (correctness beats one cheap poll per
  // admission); C1-2's flag machinery is subsumed by it.
  // AUDIT C1-1 (round 3): a successful capacitySwap frees a slot on the
  // SOURCE endpoint mid-pass; the wall must re-decide even though no
  // TERMINAL event happened (docs/20 §3.4 — admission must not stay
  // possible while the wall sleeps). The ping survives decide() running
  // when the swap fires, so the wake can never be missed.
  let pingDecide = false;

  const journal = async (kind: SchedJournalKind, rec: Record<string, unknown>): Promise<void> => {
    if (deps.journal === undefined) return;
    try { await deps.journal.append({ kind, episodeId: graph.episodeId, ts: now(), seq: (schedSeq += 1), ...rec }); }
    catch (e) { log(`sched-journal-failed: ${(e as Error)?.name ?? 'error'}`); } // disclosure-only, never fatal
  };

  const denialsFor = (taskId: string): string[] => denials.filter((d) => d.taskId === taskId).map((d) => d.reason);

  // AUDIT F3 (round 2): the dedup guard runs BEFORE any record is made
  // — both the journal AND the returned/outcome denials carry one entry
  // per state change. (The pre-fix order pushed the outcome denial
  // first, so repeated decide passes accumulated duplicates even while
  // the journal stayed singular.)
  const denyOnce = async (taskId: string, reason: string, detail?: string): Promise<void> => {
    if (lastDenial.get(taskId) === reason) return; // once per STATE change, not per poll (§3.2.1)
    lastDenial.set(taskId, reason);
    denials.push({ taskId, reason, ...(detail !== undefined ? { detail } : {}) });
    // AUDIT C1-5 (round 3): a task can be denied, re-decided with a
    // CHANGED reason, and denied again — every journal record needs its
    // own identity, so the deny actionId carries the episode-wide
    // denial sequence (the static `-deny` id collided across states).
    denySeq += 1;
    await journal('sched-deny', { taskId, actionId: `sched-${actPrefix}${graph.episodeId}-${taskId}-deny-${denySeq}`, reason, ...(detail !== undefined ? { detail } : {}) });
    log(`sched-deny ${taskId}: ${reason}${detail !== undefined ? ` (${detail})` : ''}`);
  };

  // Terminal-event queue: finish() enqueues and wakes the wall; the
  // decision loop drains terminals BEFORE the quiesce check (§3.4 —
  // no TOCTOU "nothing runnable" while a loop just exited).
  let pendingTerminal = 0;
  let wake: (() => void) | undefined;
  const wakeNow = (): void => { const w = wake; wake = undefined; if (w !== undefined) w(); };

  // AUDIT F3 (round 2): one poll helper shared by the wall AND the
  // decide pass — a flag set during decide()'s awaits (e.g. by an
  // awaited admissionCheck) must stop the NEXT admission, not wait for
  // the wall's next outer iteration. AUDIT C1-2 (round 3): polling
  // CLEARS nothing — AUDIT R4-F1 (round 4): the flag this helper used
  // to clear is gone; the pre-admit re-check is unconditional now.
  const refreshShutdown = async (): Promise<void> => {
    if (shutdownRequested || deps.shutdown === undefined) return;
    try { if (await deps.shutdown.poll()) { shutdownRequested = true; log('sched: shutdown requested'); } } catch { /* a throwing poll is not a shutdown */ }
  };

  const finish = async (t: SchedTaskLike, res: SchedLoopResultLike): Promise<void> => {
    const held = running.get(t.id);
    let status = mapLoopStop(res.stopped);
    let acceptance: string | undefined;
    if (status === 'done') {
      if (deps.acceptanceFor !== undefined) {
        try { acceptance = sstr(await deps.acceptanceFor(t, res), 32); } catch { acceptance = undefined; }
      } else {
        acceptance = res.stopped === 'accepted-finish' ? 'complete' : undefined;
      }
      // §3.1/§3.3: `done` requires the acceptance verdict `complete`
      // (trichotomy — the journaled verdict decides, not the stop word).
      if (acceptance !== 'complete') status = 'failed';
    }
    const detail = sstr(res.detail);
    fates.set(t.id, { status, ...(acceptance !== undefined ? { acceptance } : {}), ...(detail !== undefined ? { detail } : {}) });
    outcomes.set(t.id, {
      status,
      ...(status === 'failed' && acceptance !== undefined ? { detail: `unaccepted:${acceptance}` } : detail !== undefined ? { detail } : {}),
      stopped: sstr(res.stopped, 64),
      ...(Array.isArray(res.iterations) ? { iterations: res.iterations.length } : {}),
      ...(typeof res.investigationCount === 'number' ? { investigations: res.investigationCount } : {}),
      denials: denialsFor(t.id),
    });
    lastDenial.delete(t.id);
    // NOW the task is terminal: drop it from the live set and free its
    // slot (admission-lifetime, §4.3), then wake the wall.
    if (running.get(t.id) === held) running.delete(t.id);
    if (held !== undefined) slots.release(held.endpoint);
    // R2: the terminal transition changed the live set — republish.
    project();
    pendingTerminal += 1;
    wakeNow();
  };

  const runOne = (t: SchedTaskLike, endpoint: string): void => {
    running.set(t.id, { endpoint, task: t });
    project(); // R2: the loop started — the live set changed
    const hooks: SchedulerLoopHooks = {
      investigate: async (packet, limits) => {
        const seq = (observerSeq += 1);
        // §5: enter the fairness queue; the grant is disclosed. The
        // loop's own caps (docs/18 §6) stay per-loop, below this thunk.
        await observer.request(t.id, seq);
        observerGrants += 1;
        await journal('sched-observer-grant', { taskId: t.id, actionId: `sched-${actPrefix}${graph.episodeId}-${t.id}-observer-${observerGrants}`, grants: observerGrants });
        try {
          if (deps.investigate === undefined) throw new Error('no observer resource');
          return await deps.investigate(t, packet, limits);
        } finally { observer.release(); }
      },
      capacitySwap: (model, current) => {
        const target = endpointOfModel(model);
        const h = running.get(t.id);
        const held = current ?? h?.endpoint ?? endpoint;
        if (target === held) return true; // same endpoint: nothing to move
        // AUDIT F5: a pure endpoint change must not temporarily consume
        // a SECOND slot — the episode ceiling would deny swaps once the
        // ceiling was full. transfer() checks the TARGET endpoint's cap
        // without touching total occupancy (docs/20 §4.3).
        if (!slots.transfer(held, target)) {
          if (!disclosures.includes('capacity:full')) disclosures.push('capacity:full');
          log(`capacity:full swap ${t.id}: ${target}`);
          return false;
        }
        if (h !== undefined) h.endpoint = target;
        project(); // R2: the live set's endpoint occupancy moved — republish
        // AUDIT C1-1 (round 3): the swap FREED a slot on `held` — a
        // denied queued task may now be admissible on that endpoint.
        // §3.4: the wall must not sleep while admission is possible, so
        // wake it (ping survives decide() running right now — no lost
        // wake between "check" and "register").
        // AUDIT R4-F4 (round 4): mutation-proven by the C1-1 handshake —
        // deleting these two lines fails that test (the waiter's
        // bounded handshake times out instead of starting while the
        // swapper still runs).
        pingDecide = true;
        wakeNow();
        return true;
      },
    };
    // The loop is a black box (M2-10). A throw anywhere becomes the
    // §3.3 loop-error mapping — it never escapes the scheduler.
    void (async () => {
      let res: SchedLoopResultLike;
      try {
        res = await deps.loop(deps.loopConfig(t), deps.loopPorts(t, hooks));
      } catch (e) {
        res = { stopped: 'loop-error', detail: `loop-threw-${(e as Error)?.name ?? 'error'}` };
      }
      if (!isObj(res)) res = { stopped: 'loop-error', detail: 'loop-returned-non-object' };
      await finish(t, res);
    })();
  };

  // The decision step (§3.2): recompute ready, admit while capacity +
  // headroom + provisioning allow. Checks run in contract order; the
  // slot is taken FIRST so N ready tasks inside one decision respect
  // each other, and every later refusal releases it immediately.
  const decide = async (): Promise<void> => {
    // AUDIT F3: a scheduler-level shutdown stops NEW admissions
    // immediately; already-running loops are steered down by the host
    // and drained (docs/20 §3.4 — "shutdown" is an operator stop, not
    // a reason to keep admitting).
    if (shutdownRequested) return;
    const budget = deps.maxIterations ?? DEFAULT_SCHED_MAX_ADMISSIONS;
    // AUDIT F3 (round 2) + C1-2 (round 3): the flag can only change
    // through OUR poll, so a re-check is required exactly when ANY
    // await has happened since the last poll — journal appends on the
    // denial paths included (a per-pass local missed those and re-based
    // per decide call). With no await there is no interleaving.
    for (const id of computeReady(tasks, fates)) {
      // AUDIT: the backstop caps ADMISSIONS themselves — checked per
      // admission, not once per pass, so a fat pass (N ready at full
      // capacity) cannot overshoot the cap by more than one decision.
      if (admissions >= budget) break;
      const t = tasks.find((x) => x.id === id)!;
      const endpoint = endpointOfModel(t.model);
      const gotSlot = slots.tryAcquire(endpoint);
      // check 4 (evaluated BEFORE journalizing any denial, so the
      // ledger's citation outranks the scheduler's verdict — D5):
      let headroomOk = true; let headroomCodes: string[] = [];
      if (deps.ledger !== undefined) {
        let h: { usdOk: boolean; turnsOk: boolean };
        try { h = deps.ledger.headroom(); } catch (e) { h = { usdOk: false, turnsOk: false }; log(`ledger-headroom-threw: ${(e as Error)?.name ?? 'error'}`); }
        if (!(h.usdOk && h.turnsOk)) { headroomOk = false; headroomCodes = ['episode-budget-exceeded']; }
      }
      if (deps.admissionCheck !== undefined && headroomOk) {
        let chk: { allowed: boolean; codes: string[] };
        // AUDIT C1-4 (round 3): disclose who is already admitted (their
        // loop reserves may be outstanding — even a loop that already
        // FINISHED, so `running` alone under-counts) so the host's gate
        // enforces the AGGREGATE, not just this task in isolation (§6).
        try { chk = await deps.admissionCheck(t, { admitted: [...admittedEver] }); } catch (e) { chk = { allowed: false, codes: [`admission-check-threw-${(e as Error)?.name ?? 'error'}`] }; }
        if (!chk.allowed) { headroomOk = false; headroomCodes = chk.codes.length > 0 ? chk.codes : ['ledger-denied']; }
      }
      if (!headroomOk) {
        if (gotSlot) slots.release(endpoint);
        // D5: a headroom denial rides the LEDGER's codes — it is NOT
        // `capacity:full` and does not pretend to be concurrency.
        await denyOnce(t.id, headroomCodes.join(',') || 'budget-headroom');
        continue;
      }
      if (!gotSlot) {
        if (!disclosures.includes('capacity:full')) disclosures.push('capacity:full');
        await denyOnce(t.id, 'capacity:full');
        continue;
      }
      // check 3: worktree provisioning (P6 owns all gates; a refusal
      // PARKS this task with the P6 reason as evidence — siblings
      // unaffected, docs/20 §3.2.3).
      if (deps.worktrees !== undefined) {
        let wr: { path?: string; refused?: string };
        try { wr = await deps.worktrees.ensure(t.id); } catch (e) { wr = { refused: `ensure-threw-${(e as Error)?.name ?? 'error'}` }; }
        if (wr.refused !== undefined || wr.path === undefined) {
          if (gotSlot) slots.release(endpoint);
          const why = wr.refused ?? 'ensure-returned-no-path';
          const dwhy = `worktree-refused:${why}`.slice(0, 200);
          fates.set(t.id, { status: 'parked', detail: dwhy });
          // AUDIT C1-8 (round 3): record the refusal FIRST — the old
          // order snapshotted denialsFor(id) before denyOnce pushed it,
          // so the parked outcome omitted its own refusal forever.
          await denyOnce(t.id, 'worktree-refused', why);
          outcomes.set(t.id, { status: 'parked', detail: dwhy, denials: denialsFor(t.id) });
          continue;
        }
      }
      // AUDIT F3 (round 2) + R4-F1 (round 4): the shutdown flag is
      // re-read UNCONDITIONALLY at the last moment BEFORE committing an
      // admission — host code can raise the flag during any await
      // above, and a journal append that yields-then-rejects left the
      // old `awaitSincePoll` bookkeeping false (the await interleaves
      // regardless of the append's outcome). One cheap poll per
      // admission is the correct price; already-running loops still
      // drain (docs/20 §3.4).
      await refreshShutdown();
      if (shutdownRequested) {
        if (gotSlot) slots.release(endpoint);
        return;
      }
      // AUDIT F1 (haiku55 round 5): remember the pre-admission state so
      // a post-journal rollback is a true inverse — the denial HISTORY
      // (the `denials` array) is durable disclosure and survives; the
      // per-task derived state is restored exactly.
      const preFate = fates.get(t.id);
      const preOutcome = outcomes.get(t.id);
      const preLastDenial = lastDenial.get(t.id);
      fates.set(t.id, { status: 'running' });
      outcomes.set(t.id, { status: 'running', denials: denialsFor(t.id) });
      lastDenial.delete(t.id);
      admissions += 1;
      // AUDIT C1-4 (round 3): register the live entry HERE, not inside
      // runOne — a loop can finish as a microtask during the journal
      // await below and delete its entry, making the aggregate invisible
      // to the NEXT task's admissionCheck (3 admits seen 0-in-flight).
      // finish() guards on entry identity, so the early set is safe.
      running.set(t.id, { endpoint, task: t });
      admittedEver.push(t.id);
      await journal('sched-admit', { taskId: t.id, actionId: `sched-${actPrefix}${graph.episodeId}-${t.id}-admit-${admissions}`, endpoint });
      // AUDIT F1 (haiku55 round 5): COMMIT-TIME poll. The flag as
      // observed at the instant this admission's own sched-admit record
      // completed. The pinned F3 (r2)/R4-F1 (r4) contract says a flag
      // raised during THIS admission's own admit append never rolls
      // this admission back (the task starts; only the NEXT admission
      // stops) — this is the only moment that distinction is
      // observable, because after the append resolves the two histories
      // ("flag set by my admit append" vs "flag set later, in the
      // overlap window") are otherwise indistinguishable.
      await refreshShutdown();
      const flagAtCommit = shutdownRequested;
      // advisory scope-overlap (§3.2): journalize, permit, never block.
      // AUDIT F4 (round 2): every admit recomputed ALL concurrent pairs,
      // so three simultaneous overlapping tasks journaled the earliest
      // pair again (and reused its actionId). Journal only pairs NOT
      // already journaled — once per pair, per episode.
      const concurrent = [{ id: t.id, files: t.scope?.files }, ...[...running.keys()].filter((id2) => id2 !== t.id).map((id2) => {
        const ct = tasks.find((x) => x.id === id2);
        return { id: id2, files: ct?.scope?.files };
      })];
      for (const [a, b] of scopeOverlapPairs(concurrent)) {
        const key = `${a}+${b}`;
        if (overlapJournalized.has(key)) continue;
        overlapJournalized.add(key);
        // AUDIT C1-6 (round 3): `-` is LEGAL inside task ids, so the
        // old `-`-joined actionId collided across distinct pairs
        // (`a`+`b-c` vs `a-b`+`c` both produced `...-overlap-a-b-c`).
        // `+` is excluded from TASK_ID_RE → the pair is unambiguous.
        await journal('scope-overlap', { taskId: a, actionId: `sched-${actPrefix}${graph.episodeId}-overlap-${key}`, pair: key });
        log(`scope-overlap ${a} ${b}`);
      }
      // AUDIT F1 (haiku55 round 5): the scope-overlap loop is the LAST
      // await between the pre-admit re-check and the loop start — a
      // flag raised DURING an overlap append used to still reach
      // runOne (probe P1b: b's loop started after the operator
      // stopped, episode reported "quiesced-complete"). Re-poll at the
      // true last moment and ROLL THE ADMISSION BACK when the flag was
      // raised strictly AFTER this admission's commit record: the loop
      // never starts, the slot returns, the derived fate reverts
      // (docs/20 §8: an admitted-but-never-started task is simply
      // re-admitted — idempotent). The sched-admit record stays in the
      // journal: the admission happened; its non-execution is the
      // crash window §8 names. `flagAtCommit` keeps the r2/r4 contract
      // (a flag from this admission's own admit append starts this
      // loop, stops the next). After this poll there is NO await
      // before `deps.loop` is invoked (runOne runs its async body
      // synchronously up to the loop call).
      await refreshShutdown();
      if (shutdownRequested && !flagAtCommit) {
        // Full inverse of the commit block above. The `denials` array
        // is untouched (history is disclosure-only durable); the
        // per-task derived state restores to the pre-admission snapshots.
        running.delete(t.id);
        slots.release(endpoint);
        project(); // R2: the rolled-back admission left the live set
        if (preFate === undefined) fates.delete(t.id); else fates.set(t.id, preFate);
        if (preOutcome === undefined) outcomes.delete(t.id); else outcomes.set(t.id, preOutcome);
        if (preLastDenial === undefined) lastDenial.delete(t.id); else lastDenial.set(t.id, preLastDenial);
        if (admittedEver[admittedEver.length - 1] === t.id) admittedEver.pop();
        admissions -= 1;
        log(`sched: shutdown during the post-admit journal window — admit ${t.id} rolled back (never started)`);
        return;
      }
      runOne(t, endpoint);
    }
  };

  // ── the event-driven wall (§3.4) ────────────────────────────────────────
  const snapshot = (): Record<string, SchedulerTaskOutcome> => Object.fromEntries([...outcomes]);
  for (;;) {
    await refreshShutdown(); // AUDIT F3 (round 2): shared with decide()'s last-moment check
    // AUDIT F1: drain terminal events and RE-RUN the decision step
    // until the state is stable, and only then judge quiescence
    // (§3.4: a slot freed or a dependent unblocked by a loop that
    // finished DURING decide()'s awaits must be admitted before the
    // episode may be called done — no TOCTOU "nothing runnable").
    // Events are CONSUMED by each decide() pass (fates are already
    // updated when finish() lands them), so pendingTerminal resets
    // before the re-decide — no busy spin while long loops run.
    for (;;) {
      await decide();
      if (running.size === 0) {
        if (pendingTerminal === 0 && !pingDecide) break; // stable: nothing running, nothing pending
        pendingTerminal = 0; pingDecide = false; // terminals landed (or a swap freed capacity) during decide() — recompute ready FIRST
        continue;
      }
      if (pendingTerminal === 0 && !pingDecide) break; // work genuinely in flight: outer path waits
      pendingTerminal = 0; pingDecide = false; // freed during decide(): one more admission pass, then wait
    }
    if (running.size === 0) {
      if (shutdownRequested) {
        const remaining = tasks.some((t) => { const f = fates.get(t.id); return f === undefined || f.status === 'queued' || f.status === 'running'; });
        return { stopped: 'shutdown', ...(remaining ? { detail: 'deferred-blocked' } : {}), tasks: snapshot(), admissions, denials, disclosures, observerGrants };
      }
      const allDone = tasks.length > 0 && tasks.every((t) => fates.get(t.id)?.status === 'done');
      return { stopped: allDone ? 'quiesced-complete' : 'quiesced-blocked', tasks: snapshot(), admissions, denials, disclosures, observerGrants };
    }
    // In-flight loops: wait for the next terminal event (or any wake).
    // `pendingTerminal > 0` means a finish() landed between decide()
    // returning and this wait — never sleep on a known event.
    if (pendingTerminal === 0) await new Promise<void>((r) => { wake = r; });
  }
}
