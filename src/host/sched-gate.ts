/**
 * R4-F5: ledger-backed aggregate scheduler admission preflight.
 * Durable consumption/holds are read fresh. Previously admitted tasks
 * without a correlated episode-local reservation contribute pending floors.
 * The candidate is a NEW intent: check() charges its floor and attempt
 * slot even if the same task has historical (including released) intents.
 * This preflight never reserves; the loop must reserve with a live recheck.
 */
import {
  check as ledgerCheck,
  compartmentKey,
  reserveDefault,
  projectLedger,
  type LedgerRecord,
  type BudgetSnapshot,
  type CompartmentUsage,
  type GatePolicy,
} from "../budget/ledger.js";

export interface SnapshotSource {
  snapshotAt(now: number): Promise<BudgetSnapshot>;
  /** Needed for episode-scoped wallclock: the generic snapshot's task-only
   * totals lose episode identity. BudgetLedger supplies fresh raw records.
   */
  read?: () => Promise<{ records: LedgerRecord[] }>;
}
export interface SchedTaskView {
  id: string;
  model?: string;
  attemptId?: string;
}
export interface AggregateAdmissionDeps {
  /** One adapter per activation. Identify the FIRST reservation belonging
   * to this activation's admission, not a historical action for this task.
   * Without authoritative correlation a sibling keeps its pending floor.
   */
  reservationActionIdOf?: (taskId: string) => string | undefined;
  ledger: SnapshotSource;
  policy: GatePolicy;
  now: () => number;
  /** Resolve by id: siblings disclose ids only, not complete task views. */
  actionOf?: (task: SchedTaskView) => "run" | "resume";
  /** Optional raised estimate; validated and clamped to the class minimum. */
  attemptOf?: (taskId: string) => string | undefined;
  floorOf?: (taskId: string) => { usd: number; turns: number };
  log?: (line: string) => void;
}
const EMPTY_USAGE: CompartmentUsage = {
  consumedUsd: 0, unknownSpend: 0, consumedTurns: 0, reservedUsd: 0, reservedTurns: 0,
};

/** Historical evidence discharges a previous admission's pending placeholder,
 * not a new candidate's liability. Releases legitimately refund siblings.
 * The ledger may contain several episodes with overlapping task names.
 */
export function durableReservedTaskIds(snapshot: BudgetSnapshot, episodeId: string): Set<string> {
  const out = new Set<string>();
  for (const rec of snapshot.actionIds.values()) {
    if (rec.episodeId === episodeId && rec.taskId) out.add(rec.taskId);
  }
  return out;
}

/** Pure episode/task roll-up. Reject invalid synthetic usage before it can
 * poison comparison arithmetic. Class floors are enforced by the adapter.
 */
export function foldPendingFloors(
  snapshot: BudgetSnapshot,
  policy: GatePolicy,
  pending: { taskId: string; usd: number; turns: number }[],
): BudgetSnapshot {
  const compartments = new Map(snapshot.compartments);
  const bump = (key: string, usd: number, turns: number): void => {
    const cur = compartments.get(key) ?? EMPTY_USAGE;
    const reservedUsd = cur.reservedUsd + usd;
    const reservedTurns = cur.reservedTurns + turns;
    if (!Number.isFinite(reservedUsd) || !Number.isSafeInteger(reservedTurns)) throw new Error("invalid pending aggregate");
    compartments.set(key, { ...cur, reservedUsd, reservedTurns });
  };
  for (const p of pending) {
    if (!Number.isFinite(p.usd) || p.usd < 0 || !Number.isSafeInteger(p.turns) || p.turns < 0) throw new Error("invalid pending floor");
    bump(compartmentKey({ episodeId: policy.episodeId }), p.usd, p.turns);
    bump(compartmentKey({ episodeId: policy.episodeId, taskId: p.taskId }), p.usd, p.turns);
  }
  return { ...snapshot, compartments };
}

export function makeLedgerAdmissionCheck(
  deps: AggregateAdmissionDeps,
): (task: SchedTaskView, ctx?: { admitted: string[] }) => Promise<{ allowed: boolean; codes: string[] }> {
  return async (task, ctx) => {
    // Logging must never turn a fail-closed verdict into an exception.
    const log = (line: string): void => { try { deps.log?.(line); } catch { /* best effort */ } };
    try {
      const now = deps.now();
      let snapshot: BudgetSnapshot;
      if (deps.ledger.read) {
        const { records } = await deps.ledger.read();
        snapshot = projectLedger(records.filter((r) => r.episodeId === deps.policy.episodeId), now);
      } else {
        if (deps.policy.caps.wallclockS !== undefined) throw new Error("episode wallclock requires scoped records");
        snapshot = await deps.ledger.snapshotAt(now);
      }
      const actionOf = (id: string): "run" | "resume" => {
        const action = deps.actionOf?.({ id }) ?? "run";
        if (action !== "run" && action !== "resume") throw new Error("invalid action class");
        return action;
      };
      const floor = (id: string): { usd: number; turns: number } => {
        const minimum = reserveDefault(actionOf(id));
        const estimate = deps.floorOf ? deps.floorOf(id) : minimum;
        if (!estimate || typeof estimate !== "object") throw new Error("invalid reservation estimate");
        if (!Number.isFinite(estimate.usd) || estimate.usd < 0 || !Number.isSafeInteger(estimate.turns) || estimate.turns < 0) throw new Error("invalid reservation estimate");
        return { usd: Math.max(minimum.usd, estimate.usd), turns: Math.max(minimum.turns, estimate.turns) };
      };
      const durable = new Set<string>();
      for (const id of new Set(ctx?.admitted ?? [])) {
        const actionId = deps.reservationActionIdOf?.(id);
        const rec = actionId === undefined ? undefined : snapshot.actionIds.get(actionId);
        if (rec?.episodeId === deps.policy.episodeId && rec.taskId === id) durable.add(id);
      }
      const pending = [...new Set(ctx?.admitted ?? [])]
        .filter((id) => id !== task.id && !durable.has(id))
        .sort()
        .map((taskId) => ({ taskId, ...floor(taskId) }));
      const folded = foldPendingFloors(snapshot, deps.policy, pending);
      // Normal admission semantics charge a new candidate, including its
      // attempt slot. Any receipt minted by this pure check is discarded:
      // the loop must obtain its own receipt and reserve at the act boundary.
      const estimate = floor(task.id);
      const attemptId = task.attemptId ?? deps.attemptOf?.(task.id);
      if (actionOf(task.id) === "resume" && !attemptId) throw new Error("resume needs attempt context");
      const verdict = ledgerCheck(deps.policy, {
        action: actionOf(task.id), actionId: `sched-admit-${task.id}`,
        taskId: task.id, estimate,
        ...(attemptId !== undefined ? { attemptId } : {}),
        authority: { grantedBy: "host-sched-gate", sideEffect: "none" },
        ...(task.model !== undefined ? { model: task.model } : {}),
      }, folded, now);
      const codes = [...new Set(verdict.denials.map((d) => d.code))];
      // Without attempt context the ledger cannot compare a raised estimate
      // against that compartment. Preserve all canonical ledger diagnoses.
      if (attemptId === undefined) {
        if (estimate.usd > (deps.policy.perAttempt?.usd ?? Infinity) && !codes.includes("attempt-budget-exceeded")) codes.push("attempt-budget-exceeded");
        if (estimate.turns > (deps.policy.perAttempt?.turns ?? Infinity) && !codes.includes("attempt-turns-exceeded")) codes.push("attempt-turns-exceeded");
      }
      const allowed = verdict.allowed && codes.length === 0;
      if (!allowed) log(`sched-gate deny ${task.id}: ${codes.join(",")}; pending: ${pending.map((p) => `${p.taskId}@${p.usd}`).join(",")}`);
      return { allowed, codes };
    } catch (e) {
      log(`sched-gate unavailable: ${(e as Error)?.name ?? "error"}`);
      return { allowed: false, codes: ["ledger-unavailable"] };
    }
  };
}
