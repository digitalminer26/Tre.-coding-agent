/**
 * P11 — recovery action executor tests (docs/15 §8 acceptance exit).
 *
 * Coverage (every §8-named scenario, by name):
 *  - §2 revalidation: every table rule, hostile plan fence (throwing
 *    getter / Proxy / broken records), strategy-mismatch repeat-budget
 *    bypass refused, rung/decision mismatch refused, permission-flag
 *    absence refused, authority inversion refused, repair external
 *    override (rung 3, template strategyId — NOT a "+external" suffix).
 *  - §3 port requirements: port-missing refusals journal NOTHING and
 *    touch nothing; merge refused (P12 unwired); accept-finish records
 *    without ports.
 *  - §4 ordering: intent-before-act (append failure blocks the act,
 *    zero port calls), intent-open refuse-don't-reissue, acked-done
 *    refused, no-effect replay permitted with distinct journal ids,
 *    gate denial journals no-effect and acts on nothing, reconcile
 *    running/park short-circuit the spawn, nudge steer carries
 *    attemptId scope + actionId as requestId, backoff delay lands
 *    between intent and gate, model-swap passes model to the gate
 *    (never self-approves), idempotent actionId across plan clones,
 *    executionSeq disambiguates.
 *  - §5 never-throws: injected port throws at EVERY stage, hostile
 *    Proxy ctx, describeError field-by-field (P14 S-F5).
 *  - §6: acked = delivery only; progress "none" always; outcome-append
 *    failure surfaces outcomeDurable:false without re-running.
 *  - §7 compartment guards: src/executor imports NOTHING; nothing
 *    outside src/executor imports it; mirror drift guard pins the
 *    executor tables against the REAL planner exports.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  executeRecoveryAction,
  SUPERVISOR_ACTIONS as EXEC_ACTIONS,
  STRATEGY_TEMPLATES as EXEC_TEMPLATES,
  ACTION_DECISION as EXEC_DECISION,
  ACTION_RUNG as EXEC_RUNG,
  RECOVERY_DECISIONS as EXEC_RECOVERY_DECISIONS,
  type ExecutorContext,
  type ExecutorPorts,
  type ExecutionResult,
  type GatePort,
  type JournalPort,
  type RunnerPort,
} from "../src/executor/exec.js";
import {
  STRATEGY_TEMPLATES as PLAN_TEMPLATES,
  ACTION_DECISION as PLAN_DECISION,
  ACTION_RUNG as PLAN_RUNG,
  RECOVERY_DECISIONS as PLAN_RECOVERY_DECISIONS,
  PLANNER_SUPERVISOR_ACTIONS,
} from "../src/planner/plan.js";
import { SUPERVISOR_ACTIONS as JOURNAL_ACTIONS } from "../src/episode/journal.js";

// ───────────────────────── fixtures & fakes ────────────────────────────────

type Rec = Record<string, unknown>;

/** A plan the closed tables accept (unless `over` breaks them). Built
 *  from the EXECUTOR tables — the drift-guard test pins these against
 *  the real planner, so the fixtures can't silently diverge. */
function planFor(action: string, over: Rec = {}): Rec {
  const model = over.model ?? "beta";
  const strategyId = action === "model-swap" ? `swap:model:${String(model)}:v1` : EXEC_TEMPLATES[action];
  const base: Rec = {
    decision: (EXEC_DECISION as Rec)[action],
    action,
    rung: (EXEC_RUNG as Rec)[action],
    sideEffect: "none",
    strategyId,
    rationale: [`because:${action}`],
    evidenceRefs: [],
    alternatives: [],
    authorityNeeded: "none",
    notAPermission: true,
  };
  if (action === "model-swap") base.model = model;
  return { ...base, ...over };
}

const ctx = (over: Partial<ExecutorContext> = {}): ExecutorContext => ({
  episodeId: "ep-1",
  taskId: "task-1",
  now: 1000,
  authority: { grantedBy: "supervisor" },
  ...over,
});

interface FakeOpts {
  failAppend?: (rec: Rec) => boolean;
  failRead?: boolean;
  hostileRecords?: boolean;
  prefill?: Rec[];
  reconcileAction?: "spawn" | "park" | "running";
  reconcileThrows?: boolean;
  runThrows?: boolean;
  resumeThrows?: boolean;
  stopThrows?: boolean;
  stopStopped?: boolean;
  checkAllowed?: boolean;
  checkThrows?: boolean;
  reserveThrows?: boolean;
  denials?: { code: string; detail: string }[];
  steerThrows?: boolean;
  /** Throw after the effect landed (the act delivered, then failed). */
  steerThrowsAfterEffect?: boolean;
  delayThrows?: boolean;
  investigateThrows?: boolean;
  repairThrows?: boolean;
  escalateThrows?: boolean;
}

function mkFakes(opts: FakeOpts = {}) {
  const log: string[] = [];
  const calls = {
    run: [] as object[], resume: [] as { t: object; attemptId: string }[], stop: [] as object[],
    gateCheck: [] as object[], gateReserve: [] as object[], steer: [] as object[],
    investigate: [] as object[], repair: [] as object[], rewriteTask: [] as object[],
    escalate: [] as object[], park: [] as object[],
  };
  const journal: JournalPort & { records: Rec[] } = {
    records: [...(opts.prefill ?? [])] as Rec[],
    append: async (rec: object) => {
      const r = rec as Rec;
      if (opts.failAppend?.(r)) throw new Error("append-denied");
      journal.records.push(r);
      log.push(`journal:${String(r.kind)}`);
    },
    read: async () => {
      if (opts.failRead) throw new Error("read-denied");
      if (opts.hostileRecords) return { records: [{ get actionId(): string { throw new Error("record-boom"); } }] };
      return { records: journal.records };
    },
  };
  const runner: RunnerPort = {
    reconcile: async () => {
      log.push("runner:reconcile");
      if (opts.reconcileThrows) throw new Error("reconcile-boom");
      return { decision: { action: opts.reconcileAction ?? "spawn", reasons: [] } };
    },
    run: async (t) => {
      log.push("runner:run");
      calls.run.push(t);
      if (opts.runThrows) throw new Error("run-boom");
      return { attemptId: "task-1-a9", pid: 111 };
    },
    resume: async (t, attemptId) => {
      log.push("runner:resume");
      calls.resume.push({ t, attemptId });
      if (opts.resumeThrows) throw new Error("resume-boom");
      return { attemptId: "task-1-a9" };
    },
    stop: async (h) => {
      log.push("runner:stop");
      calls.stop.push(h);
      if (opts.stopThrows) throw new Error("stop-boom");
      return { stopped: opts.stopStopped ?? true };
    },
  };
  const gate: GatePort = {
    check: async (_p, req) => {
      log.push("gate:check");
      calls.gateCheck.push(req);
      if (opts.checkThrows) throw new Error("check-boom");
      return { allowed: opts.checkAllowed ?? true, denials: opts.denials ?? [] };
    },
    reserve: async (_p, req) => {
      log.push("gate:reserve");
      calls.gateReserve.push(req);
      if (opts.reserveThrows) throw new Error("reserve-boom");
    },
  };
  const steer = {
    push: async (req: object) => {
      log.push("steer:push");
      calls.steer.push(req);
      if (opts.steerThrows) throw new Error("steer-boom");
      if (opts.steerThrowsAfterEffect) throw new Error("steer-boom");
    },
  };
  const dispatch = {
    investigate: async (req: object) => {
      log.push("dispatch:investigate");
      calls.investigate.push(req);
      if (opts.investigateThrows) throw new Error("investigate-boom");
      return { evidenceRefs: ["ev-diag", 42, "", "ev-2"] as unknown as string[] }; // string-checked (§7)
    },
    repair: async (req: object) => {
      log.push("dispatch:repair");
      calls.repair.push(req);
      if (opts.repairThrows) throw new Error("repair-boom");
      return { evidenceRefs: ["ev-repair"] };
    },
    rewriteTask: async (req: object) => {
      log.push("dispatch:rewriteTask");
      calls.rewriteTask.push(req);
      return { taskRevision: 2 };
    },
    escalate: async (req: object) => {
      log.push("dispatch:escalate");
      calls.escalate.push(req);
      if (opts.escalateThrows) throw new Error("escalate-boom");
      return { channel: "human-1" };
    },
    park: async (req: object) => {
      log.push("dispatch:park");
      calls.park.push(req);
    },
  };
  const ports: ExecutorPorts = {
    journal, runner, gate, steer, dispatch,
    delay: async (ms: number) => {
      log.push(`delay:${ms}`);
      if (opts.delayThrows) throw new Error("timer-boom");
    },
  };
  return { ports, log, journal, calls };
}

const intents = (j: { records: Rec[] }) => j.records.filter((r) => r.kind === "decision-intent");
const outcomes = (j: { records: Rec[] }) => j.records.filter((r) => r.kind === "decision-outcome");

const exec = async (plan: unknown, over: Partial<ExecutorContext> = {}, opts: FakeOpts = {})
  : Promise<{ res: ExecutionResult; f: ReturnType<typeof mkFakes> }> => {
  const f = mkFakes(opts);
  const res = await executeRecoveryAction(plan, ctx(over), f.ports);
  return { res, f };
};

// ───────────────────────── §2 revalidation ─────────────────────────────────

test("§2: garbage plans are refused by shape with nothing touched", async () => {
  for (const bad of [null, undefined, 42, "plan", [], true]) {
    const { res, f } = await exec(bad);
    assert.equal(res.status, "refused", String(bad));
    assert.equal(res.stage, "revalidate");
    assert.match(String(res.reason), /^plan-invalid:shape/);
    assert.equal(res.actionId, "");
    assert.equal(f.journal.records.length, 0, "a revalidation refusal journals nothing");
    assert.deepEqual(f.log, []);
  }
});

test("§2: hold sentinel → held, nothing journaled, nothing acted", async () => {
  const { res, f } = await exec(planFor("hold"));
  assert.equal(res.status, "held");
  assert.equal(res.action, "hold");
  assert.equal(res.actionId, "");
  assert.equal(f.journal.records.length, 0);
  assert.deepEqual(f.log, []);
});

test("§2: unknown action refused even with every other field consistent", async () => {
  const { res, f } = await exec(planFor("reboot-cluster"));
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "plan-invalid:action");
  assert.equal(res.action, "reboot-cluster");
  assert.equal(f.journal.records.length, 0);
});

test("§2: strategy-template mismatch refused (repeat-budget discipline)", async () => {
  const { res } = await exec(planFor("nudge", { strategyId: "nudge:progress:v2" }));
  assert.equal(res.reason, "plan-invalid:strategy");
});

test("§2: model-swap strategy naming a DIFFERENT model is refused (bypass)", async () => {
  const { res } = await exec(planFor("model-swap", { model: "beta", strategyId: "swap:model:evil:evil" }));
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "plan-invalid:strategy");
});

test("§2: model-swap requires a valid model", async () => {
  const noModel = planFor("model-swap");
  delete noModel.model; // base builder used the default; strip it
  assert.equal((await exec(noModel)).res.reason, "plan-invalid:model");
  const huge = planFor("model-swap", { model: "m".repeat(257), strategyId: `swap:model:${"m".repeat(257)}:v1` });
  assert.equal((await exec(huge)).res.reason, "plan-invalid:model");
});

test("§2: rung and decision must equal the canonical table values", async () => {
  assert.equal((await exec(planFor("nudge", { rung: 3 }))).res.reason, "plan-invalid:rung");
  assert.equal((await exec(planFor("nudge", { rung: 1.5 }))).res.reason, "plan-invalid:rung");
  assert.equal((await exec(planFor("nudge", { decision: "escalate" }))).res.reason, "plan-invalid:decision");
});

test("§2: authority classes validated and never inverted", async () => {
  assert.equal((await exec(planFor("repair", { sideEffect: "external", rung: 3, authorityNeeded: "none" }))).res.reason, "plan-invalid:authority");
  assert.equal((await exec(planFor("nudge", { sideEffect: "sideways" }))).res.reason, "plan-invalid:authority");
  // authorityNeeded ABOVE sideEffect is fine
  const { res } = await exec(planFor("nudge", { authorityNeeded: "external" }));
  assert.equal(res.status, "executed");
});

test("§2: missing/false notAPermission = absent provenance = refusal", async () => {
  const absent = planFor("nudge");
  delete absent.notAPermission;
  assert.equal((await exec(absent)).res.reason, "plan-invalid:permission-flag");
  assert.equal((await exec(planFor("nudge", { notAPermission: false }))).res.reason, "plan-invalid:permission-flag");
});

test("§2: oversized / sparse / non-string list fields refused per field", async () => {
  assert.equal((await exec(planFor("nudge", { rationale: ["x".repeat(513)] }))).res.reason, "plan-invalid:rationale");
  const sparse = ["a", "c"];
  delete sparse[1];
  assert.equal((await exec(planFor("nudge", { rationale: sparse }))).res.reason, "plan-invalid:rationale");
  assert.equal((await exec(planFor("nudge", { evidenceRefs: ["ok", 7] }))).res.reason, "plan-invalid:evidenceRefs");
  assert.equal((await exec(planFor("task-rewrite", { remainingWork: [[]] }))).res.reason, "plan-invalid:remainingWork");
  assert.equal((await exec(planFor("nudge", { expectedEvidence: 99 }))).res.reason, "plan-invalid:expectedEvidence");
  assert.equal((await exec(planFor("nudge", { rationale: Array(65).fill("ok") }))).res.reason, "plan-invalid:rationale");
});

test("§2: external repair keeps the TEMPLATE strategyId with the rung-3 override", async () => {
  const { res, f } = await exec(
    planFor("repair", { sideEffect: "external", authorityNeeded: "external", rung: 3 }),
    {}, {},
  );
  assert.equal(res.status, "executed");
  assert.equal(res.evidenceRefs[0], "dispatch:repair");
  const req = f.calls.repair[0] as Rec;
  assert.equal(req.sideEffect, "external");
});

test("§2: the old '+external' strategyId suffix is NOT accepted (repairGate truth)", async () => {
  const { res } = await exec(planFor("repair", { sideEffect: "external", authorityNeeded: "external", rung: 3, strategyId: "repair:task-local:v1+external" }));
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "plan-invalid:strategy");
  // and external repair with the canonical RUNG 2 is a drift → refused
  assert.equal((await exec(planFor("repair", { sideEffect: "external", authorityNeeded: "external" }))).res.reason, "plan-invalid:rung");
});

test("§2: hostile plan fence — throwing getters and Proxy never throw out", async () => {
  const getterPlan = {
    get action(): string { throw new Error("gotcha"); },
    strategyId: "nudge:progress:v1",
  };
  const proxyPlan = new Proxy({} as Rec, {
    get(): never { throw new Error("proxy-boom"); },
    has(): never { throw new Error("has-boom"); },
  });
  for (const plan of [getterPlan, proxyPlan]) {
    const { res, f } = await exec(plan);
    assert.equal(res.status, "refused");
    assert.match(String(res.reason), /^plan-invalid:/);
    assert.equal(f.journal.records.length, 0);
  }
});

test("§1: resume without ctx.attemptId is refused (nothing to attach to)", async () => {
  const { res, f } = await exec(planFor("evidence-nudge-resume"));
  assert.equal(res.status, "refused");
  assert.equal(res.stage, "revalidate");
  assert.match(String(res.reason), /attemptId/);
  assert.equal(f.journal.records.length, 0);
});

// ───────────────────────── §3 port requirements ────────────────────────────

test("§3: every missing required port is a refusal that journals nothing", async () => {
  const cases: { action: string; drop: (p: ExecutorPorts) => void; want: string; ctxOver?: Partial<ExecutorContext> }[] = [
    { action: "nudge", drop: (p) => { delete p.steer; }, want: "port-missing:steer" },
    { action: "evidence-nudge-resume", drop: (p) => { delete p.runner; }, want: "port-missing:runner", ctxOver: { attemptId: "task-1-a2" } },
    { action: "evidence-nudge-resume", drop: (p) => { delete p.gate; }, want: "port-missing:gate", ctxOver: { attemptId: "task-1-a2" } },
    { action: "backoff-retry", drop: (p) => { delete p.gate; }, want: "port-missing:gate" },
    { action: "backoff-retry", drop: (p) => { delete p.runner; }, want: "port-missing:runner" },
    { action: "model-swap", drop: (p) => { delete p.runner; }, want: "port-missing:runner" },
    { action: "model-swap", drop: (p) => { delete p.gate; }, want: "port-missing:gate" },
    { action: "investigate", drop: (p) => { delete p.dispatch; }, want: "port-missing:dispatch.investigate" },
    { action: "repair", drop: (p) => { p.dispatch = { ...p.dispatch, repair: undefined }; }, want: "port-missing:dispatch.repair" },
    { action: "task-rewrite", drop: (p) => { p.dispatch = { ...p.dispatch, rewriteTask: undefined }; }, want: "port-missing:dispatch.rewriteTask" },
    { action: "escalate", drop: (p) => { p.dispatch = { ...p.dispatch, escalate: undefined }; }, want: "port-missing:dispatch.escalate" },
    { action: "park", drop: (p) => { p.dispatch = { ...p.dispatch, park: undefined }; }, want: "port-missing:dispatch.park" },
    { action: "kill", drop: (p) => { delete p.runner; }, want: "port-missing:runner", ctxOver: { session: "sess-1" } },
    { action: "kill", drop: () => { /* session lives on ctx */ }, want: "port-missing:session" },
  ];
  for (const c of cases) {
    const f = mkFakes();
    c.drop(f.ports);
    const res = await executeRecoveryAction(planFor(c.action), ctx(c.ctxOver), f.ports);
    assert.equal(res.status, "refused", `${c.action} ${c.want}`);
    assert.equal(res.reason, c.want);
    assert.equal(f.journal.records.length, 0, `${c.action} port-missing journals nothing`);
    assert.equal(f.log.length, 0, `${c.action} port-missing touches nothing`);
  }
});

test("§3: missing journal port refuses before any derivation", async () => {
  const res = await executeRecoveryAction(planFor("nudge"), ctx(), { runner: mkFakes().ports.runner } as unknown as ExecutorPorts);
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "port-missing:journal");
});

test("§3: merge is always refused (P12 unwired by contract)", async () => {
  const { res, f } = await exec(planFor("merge"));
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "merge-unwired");
  assert.equal(f.journal.records.length, 0);
});

// ───────────────────────── §4 dedup ────────────────────────────────────────

test("§4: idempotent actionId — identical plan content clones hash equal", async () => {
  const a = await exec(planFor("nudge", { rationale: ["same"] }));
  const b = await exec(planFor("nudge", { rationale: ["same"] }));
  assert.equal(a.res.actionId, b.res.actionId);
  assert.match(a.res.actionId, /^a-task-1-nudge-[0-9a-f]{8}$/);
  // second run (fresh fakes each) sees the acked outcome? no — fresh journals;
  // replay detection is exercised below via prefill.
});

test("§4: same content in the SAME journal → already-executed, port untouched", async () => {
  const f = mkFakes();
  const first = await executeRecoveryAction(planFor("nudge", { rationale: ["once"] }), ctx(), f.ports);
  assert.equal(first.status, "executed");
  const second = await executeRecoveryAction(planFor("nudge", { rationale: ["once"] }), ctx(), f.ports);
  assert.equal(second.status, "refused");
  assert.equal(second.reason, "already-executed");
  assert.equal(second.actionId, first.actionId);
  assert.equal(f.calls.steer.length, 1, "the act ran exactly once");
});

test("§4: executionSeq is the ONLY legitimate disambiguator", async () => {
  const f = mkFakes();
  const plan = planFor("nudge", { rationale: ["twice"] });
  const first = await executeRecoveryAction(plan, ctx(), f.ports);
  const blocked = await executeRecoveryAction(plan, ctx(), f.ports);
  assert.equal(blocked.status, "refused");
  const bumped = await executeRecoveryAction(plan, ctx({ executionSeq: 1 }), f.ports);
  assert.equal(bumped.status, "executed");
  assert.notEqual(bumped.actionId, first.actionId);
  assert.equal(f.calls.steer.length, 2);
});

test("§4: open intent refuses re-issue (I5) without touching act ports", async () => {
  const f1 = mkFakes();
  const first = await executeRecoveryAction(planFor("escalate"), ctx(), f1.ports);
  const openIntent = intents(f1.journal)[0] as Rec;
  const { res, f } = await exec(planFor("escalate"), {}, { prefill: [openIntent] });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "intent-open");
  assert.equal(res.actionId, first.actionId);
  assert.equal(f.calls.escalate.length, 0);
  assert.equal(f.journal.records.length, 1, "the refusal itself journals nothing new (only the prefilled open intent)");
});

test("§4: un-acked outcome WITHOUT the no-effect marker is not replayable", async () => {
  const f1 = mkFakes();
  await executeRecoveryAction(planFor("park"), ctx(), f1.ports);
  const done = { ...(outcomes(f1.journal)[0] as Rec) }; // copy: R1-G3 froze the retained record
  done.acked = false; // e.g. hand-closed by recovery
  const { res, f } = await exec(planFor("park"), {}, { prefill: [done] });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "already-executed");
  assert.equal(f.calls.park.length, 0);
});

test("§4: no-effect outcome permits replay with a DISTINCT journal id", async () => {
  // R3 split this test in two. A throw BEFORE the delivering call is a
  // provable no-effect (replayable). A throw AFTER it is UNKNOWN and is
  // NOT replayable — that half moved to R3-B1.
  // seed a genuine no-effect pair (gate denial), which IS replayable
  const g = mkFakes({ checkAllowed: false });
  const denied = await executeRecoveryAction(planFor("backoff-retry"), ctx({ attemptId: "task-1-a1" }), g.ports);
  assert.equal(denied.status, "refused");
  const marked = outcomes(g.journal)[0] as Rec;
  assert.equal(marked.acked, false);
  assert.match(String(marked.notes), /^no-effect: gate-denied/);
  // replay against the SAME journal: nothing happened, so it may re-run
  const f2 = mkFakes({ prefill: g.journal.records });
  const replay = await executeRecoveryAction(planFor("backoff-retry"), ctx({ attemptId: "task-1-a1" }), f2.ports);
  assert.equal(replay.actionId, denied.actionId);
  const ids = f2.journal.records.map((r) => r.id);
  assert.equal(new Set(ids).size, 4, "intent/outcome re-open with distinct ids");
});

test("§4: journal read failure fails closed (no action, no intent)", async () => {
  const { res, f } = await exec(planFor("backoff-retry"), {}, { failRead: true });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "journal-unreadable");
  assert.equal(f.log.length, 0);
});

test("§4: hostile journal records (throwing getter) fail closed too", async () => {
  const { res, f } = await exec(planFor("nudge"), {}, { hostileRecords: true });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "journal-unreadable");
  assert.equal(f.calls.steer.length, 0);
});

// ───────────────────────── §4/§14.3 intent-before-act ──────────────────────

test("§4: intent append failure BLOCKS the act — zero port calls", async () => {
  const { res, f } = await exec(planFor("backoff-retry"), {}, { failAppend: (r) => r.kind === "decision-intent" });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "intent-journal-failed");
  assert.equal(res.error?.name, "Error");
  assert.equal(f.log.length, 0, "log-then-act: no steer, no gate, no runner (E2)");
});

test("§14.3: the intent record carries the full field set", async () => {
  const { res, f } = await exec(planFor("evidence-nudge-resume"), { attemptId: "task-1-a2", taskRevision: 2 }, {});
  assert.equal(res.status, "executed");
  const intent = intents(f.journal)[0] as Rec;
  assert.equal(intent.schema, "tre-supervisor/1");
  assert.equal(intent.kind, "decision-intent");
  assert.equal(intent.id, `${res.actionId}#i0`);
  assert.equal(intent.ts, 1000);
  assert.equal(intent.episodeId, "ep-1");
  assert.equal(intent.taskId, "task-1");
  assert.equal(intent.attemptId, "task-1-a2");
  assert.equal(intent.taskRevision, 2);
  assert.equal(intent.action, "evidence-nudge-resume");
  assert.equal(intent.rung, 2);
  assert.equal(intent.strategyId, "resume:evidence:v1");
  assert.deepEqual(intent.authority, { grantedBy: "supervisor", sideEffect: "none" });
  assert.equal(typeof intent.rationale, "string");
});

// ───────────────────────── §3/§4 per-action paths ──────────────────────────

test("nudge: scoped steer carries attemptId scope and actionId requestId", async () => {
  const { res, f } = await exec(planFor("nudge", { expectedEvidence: "uptake: next tool call" }), { attemptId: "task-1-a1" });
  assert.equal(res.status, "executed");
  assert.equal(res.evidenceRefs[0], `steer:${res.actionId}`);
  const req = f.calls.steer[0] as Rec;
  assert.equal(req.id, res.actionId);
  assert.equal(req.attemptId, "task-1-a1");
  assert.equal(req.taskId, "task-1");
  assert.equal(req.source, "supervisor");
  assert.equal(req.text, "because:nudge\nuptake: next tool call");
  // sideEffect-none: the gate is NOT consulted for nudge (§3 table)
  assert.equal(f.calls.gateCheck.length, 0);
});

test("nudge: a stray model field on a non-swap plan never leaks anywhere", async () => {
  const { res, f } = await exec(planFor("nudge", { model: "evil-model" }), {}, {});
  assert.equal(res.status, "executed");
  const dumped = JSON.stringify({ steer: f.calls.steer, journal: f.journal.records });
  assert.ok(!dumped.includes("evil-model"), "nothing out of the plan is obeyed (E1)");
});

test("backoff-retry: delay lands BETWEEN intent and gate; size from attempt number", async () => {
  const { res, f } = await exec(planFor("backoff-retry"), { attemptId: "task-1-a3" });
  assert.equal(res.status, "executed");
  assert.deepEqual(f.log, [
    "journal:decision-intent", "delay:4000", "gate:check", "gate:reserve",
    "runner:reconcile", "runner:run", "journal:decision-outcome",
  ]);
  const req = f.calls.gateCheck[0] as Rec;
  assert.equal(req.action, "run");
  assert.equal(req.actionId, res.actionId);
});

test("backoff-retry: without attemptId the base delay is 1000 ms", async () => {
  const { f } = await exec(planFor("backoff-retry"));
  assert.ok(f.log.includes("delay:1000"), f.log.join(","));
});

test("backoff: delay port failure → failed@backoff with a no-effect outcome", async () => {
  const { res, f } = await exec(planFor("backoff-retry"), {}, { delayThrows: true });
  assert.equal(res.status, "failed");
  assert.equal(res.stage, "backoff");
  const o = outcomes(f.journal)[0] as Rec;
  assert.equal(o.acked, false);
  assert.match(String(o.notes), /^no-effect: act-failed delay/);
  assert.ok(!f.log.includes("gate:check"), "the gate is never reached");
});

test("model-swap: model goes to the GATE and the runner task; never self-approved", async () => {
  const { res, f } = await exec(planFor("model-swap", { model: "gamma" }));
  assert.equal(res.status, "executed");
  const req = f.calls.gateCheck[0] as Rec;
  assert.equal(req.model, "gamma");
  assert.equal(req.strategyId, "swap:model:gamma:v1");
  assert.equal(req.action, "run");
  assert.equal((f.calls.run[0] as Rec).model, "gamma");
  assert.equal(res.attemptId, "task-1-a9");
  assert.equal(res.evidenceRefs[0], "attempt:task-1-a9");
});

test("model-swap: gate denial refuses and the runner is never spawned", async () => {
  const { res, f } = await exec(planFor("model-swap", { model: "gamma" }), {}, {
    checkAllowed: false, denials: [{ code: "model-not-approved", detail: "gamma not in grant" }],
  });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "gate-denied");
  assert.deepEqual(res.denials, [{ code: "model-not-approved", detail: "gamma not in grant" }]);
  assert.equal(f.calls.run.length, 0);
  const o = outcomes(f.journal)[0] as Rec;
  assert.equal(o.acked, false);
  assert.match(String(o.notes), /no-effect: gate-denied model-not-approved/);
});

test("gate: check throwing → refused gate-check-failed with a no-effect record", async () => {
  const { res, f } = await exec(planFor("backoff-retry"), {}, { checkThrows: true });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "gate-check-failed");
  assert.match(String((outcomes(f.journal)[0] as Rec).notes), /gate-check-failed/);
  assert.equal(f.calls.run.length, 0);
});

test("gate: reserve revoke (throws after allowed) → gate-denied, nothing runs", async () => {
  const { res, f } = await exec(planFor("backoff-retry"), {}, { reserveThrows: true });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "gate-denied");
  assert.match(String(res.error?.message), /reserve-boom/);
  assert.equal(f.calls.run.length, 0);
  assert.match(String((outcomes(f.journal)[0] as Rec).notes), /reserve-revoked/);
});

test("reconcile running → already-running, no second spawn (P7 fence)", async () => {
  const { res, f } = await exec(planFor("backoff-retry"), {}, { reconcileAction: "running" });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "already-running");
  assert.equal(f.calls.run.length, 0);
  assert.match(String((outcomes(f.journal)[0] as Rec).notes), /no-effect: already-running/);
});

test("reconcile park → refused parked (next plan escalates)", async () => {
  const { res, f } = await exec(planFor("model-swap", { model: "beta" }), {}, { reconcileAction: "park" });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "parked");
  assert.equal(f.calls.run.length, 0);
  assert.match(String((outcomes(f.journal)[0] as Rec).notes), /no-effect: parked/);
});

test("evidence-nudge-resume: ledger action 'resume', ctx.attemptId reaches runner.resume", async () => {
  const { res, f } = await exec(planFor("evidence-nudge-resume"), { attemptId: "task-1-a2" });
  assert.equal(res.status, "executed");
  assert.equal(f.calls.resume.length, 1);
  assert.equal(f.calls.run.length, 0);
  assert.equal(f.calls.resume[0]?.attemptId, "task-1-a2");
  assert.equal((f.calls.gateCheck[0] as Rec).action, "resume");
  assert.equal((f.calls.gateCheck[0] as Rec).attemptId, "task-1-a2");
});

test("investigate: dispatch once; port evidence string-checked and carried", async () => {
  const { res, f } = await exec(planFor("investigate"), { attemptId: "task-1-a1" });
  assert.equal(res.status, "executed");
  assert.equal(f.calls.investigate.length, 1);
  assert.equal((f.calls.investigate[0] as Rec).actionId, res.actionId);
  // 42 and "" were dropped by the string check (§4 step 7)
  assert.deepEqual(res.evidenceRefs, ["dispatch:investigate", "ev-diag", "ev-2"]);
});

test("task-rewrite: revision bump from the port becomes evidence", async () => {
  const { res, f } = await exec(planFor("task-rewrite", { remainingWork: ["pin the parser"] }));
  assert.equal(res.status, "executed");
  assert.ok(res.evidenceRefs.includes("revision:2"));
  assert.deepEqual((f.calls.rewriteTask[0] as Rec).remainingWork, ["pin the parser"]);
});

test("escalate: channel from the port becomes evidence", async () => {
  const { res } = await exec(planFor("escalate"));
  assert.ok(res.evidenceRefs.includes("dispatch:escalate"));
  assert.ok(res.evidenceRefs.includes("channel:human-1"));
});

test("kill: runner.stop by session; confirmed stop acks, unconfirmed is act-unknown", async () => {
  const ok = await exec(planFor("kill"), { session: "sess-1" });
  assert.equal(ok.res.status, "executed");
  assert.deepEqual(ok.f.calls.stop[0], { session: "sess-1" });
  assert.equal((outcomes(ok.f.journal)[0] as Rec).acked, true);

  const bad = await exec(planFor("kill"), { session: "sess-1" }, { stopStopped: false });
  assert.equal(bad.res.status, "executed"); // the stop WAS delivered
  const o = outcomes(bad.f.journal)[0] as Rec;
  assert.equal(o.acked, false);
  // R4-A: an unconfirmed stop is UNKNOWN, not a no-effect (which would
  // make the kill replayable).
  assert.equal(o.notes, "act-unknown: stop-unconfirmed");
});

test("accept-finish: record-only — no ports beyond the journal are needed", async () => {
  const f = mkFakes();
  const res = await executeRecoveryAction(
    planFor("accept-finish", { evidenceRefs: ["acc:verdict-1"] }), ctx(), { journal: f.journal },
  );
  assert.equal(res.status, "executed");
  assert.equal(res.outcomeDurable, true);
  assert.deepEqual(res.evidenceRefs, ["acc:verdict-1"]);
  assert.deepEqual(f.log, ["journal:decision-intent", "journal:decision-outcome"]);
});

test("accept-finish without evidence still records evidenceRefs ['none']", async () => {
  const { res } = await exec(planFor("accept-finish", { evidenceRefs: [] }));
  assert.deepEqual(res.evidenceRefs, ["none"]);
});

// ───────────────────────── §5/§6 failure handling ──────────────────────────

test("§6: outcome is progress:'none' + acked=delivery on every executed act", async () => {
  const { f } = await exec(planFor("investigate"));
  const o = outcomes(f.journal)[0] as Rec;
  assert.equal(o.progress, "none");
  assert.equal(o.acked, true);
  assert.equal(o.id, `${undefined === o.actionId ? "" : String(o.actionId)}#o0`);
});

test("§5: act port throws → failed@act, outcome never claims a delivered act", async () => {
  const { res, f } = await exec(planFor("nudge"), {}, { steerThrows: true });
  assert.equal(res.status, "failed");
  assert.equal(res.stage, "act");
  assert.equal(res.error?.message, "steer-boom");
  const o = outcomes(f.journal)[0] as Rec;
  assert.equal(o.acked, false);
  // R3: the delivering call was entered, so "no effect" is NOT provable —
  // the record must not carry the replay-permitting marker.
  assert.doesNotMatch(String(o.notes), /^no-effect:/);
  assert.match(String(o.notes), /^act-unknown: act-failed Error/);
});

test("§5: runner.run throws after the reservation → failed@act, never retried", async () => {
  const { res, f } = await exec(planFor("backoff-retry"), {}, { runThrows: true });
  assert.equal(res.status, "failed");
  assert.equal(res.stage, "act");
  assert.equal(f.calls.run.length, 1);
});

test("§6/E6: outcome-append failure → executed with outcomeDurable:false, no re-run", async () => {
  const f = mkFakes({ failAppend: (r) => r.kind === "decision-outcome" });
  const res = await executeRecoveryAction(planFor("nudge"), ctx(), f.ports);
  assert.equal(res.status, "executed");
  assert.equal(res.outcomeDurable, false);
  assert.equal(res.error?.message, "append-denied");
  assert.equal(f.calls.steer.length, 1, "the act ran exactly once");
  const retry = await executeRecoveryAction(planFor("nudge"), ctx(), f.ports);
  assert.equal(retry.status, "refused", "open intent: recovery observes reality, never re-issues");
  assert.equal(retry.reason, "intent-open");
  assert.equal(f.calls.steer.length, 1);
});

test("§5: describeError is field-by-field (P14 S-F5): throwing message must not escape", async () => {
  const hostile = { name: "Boom", get message(): never { throw new Error("message-boom"); } };
  const f = mkFakes();
  f.ports.steer = { push: async () => { throw hostile; } };
  const res = await executeRecoveryAction(planFor("nudge"), ctx(), f.ports);
  assert.equal(res.status, "failed");
  assert.equal(res.error?.name, "Boom");
  assert.equal(res.error?.message, "unknown");
});

test("§5: stringly-thrown values are described as {name:'error'}", async () => {
  const f = mkFakes();
  f.ports.steer = { push: () => { throw "plain-string"; } };
  const res = await executeRecoveryAction(planFor("nudge"), ctx(), f.ports);
  assert.deepEqual(res.error, { name: "error", message: "plain-string" });
});

test("§5: hostile ctx (throwing Proxy) never rejects — fails closed at context", async () => {
  const hostileCtx = new Proxy({} as ExecutorContext, {
    get(): never { throw new Error("ctx-boom"); },
    has(): never { throw new Error("has-boom"); },
  });
  const f = mkFakes();
  const res = await executeRecoveryAction(planFor("nudge"), hostileCtx, f.ports);
  assert.ok(["refused", "failed"].includes(res.status));
  assert.equal(res.stage, "context");
  assert.equal(f.log.length, 0);
});

test("§1: context validation matrix refuses with stage 'context'", async () => {
  const cases: { over: Partial<ExecutorContext>; want: string }[] = [
    { over: { authority: { grantedBy: "" } }, want: "authority" },
    { over: { episodeId: "bad id" }, want: "episodeId" },
    { over: { taskId: "" }, want: "taskId" },
    { over: { now: Number.NaN }, want: "now" },
    { over: { now: -1 }, want: "now" },
    { over: { executionSeq: -1 }, want: "executionSeq" },
    { over: { executionSeq: 1.5 }, want: "executionSeq" },
    { over: { attemptId: "has space" }, want: "attemptId" },
    { over: { taskRevision: 0 }, want: "taskRevision" },
    { over: { session: "" }, want: "session" },
  ];
  for (const c of cases) {
    const { res, f } = await exec(planFor("nudge"), c.over);
    assert.equal(res.status, "refused", String(c.want));
    assert.equal(res.stage, "context");
    assert.ok(String(res.reason).startsWith(c.want), `${c.want}: ${res.reason}`);
    assert.equal(f.journal.records.length, 0);
  }
});

test("§5: injected throws at EVERY stage never reject (stage → status map)", async () => {
  const runs: { name: string; plan: Rec; ctxOver: Partial<ExecutorContext>; opts: FakeOpts; stage: string }[] = [
    { name: "dedup", plan: planFor("nudge"), ctxOver: {}, opts: { failRead: true }, stage: "dedup" },
    { name: "intent", plan: planFor("nudge"), ctxOver: {}, opts: { failAppend: (r) => r.kind === "decision-intent" }, stage: "intent" },
    { name: "backoff", plan: planFor("backoff-retry"), ctxOver: {}, opts: { delayThrows: true }, stage: "backoff" },
    { name: "gate-check", plan: planFor("backoff-retry"), ctxOver: {}, opts: { checkThrows: true }, stage: "gate" },
    { name: "gate-reserve", plan: planFor("backoff-retry"), ctxOver: {}, opts: { reserveThrows: true }, stage: "gate" },
    { name: "act-reconcile", plan: planFor("model-swap", { model: "beta" }), ctxOver: {}, opts: { reconcileThrows: true }, stage: "act" },
    { name: "act-resume", plan: planFor("evidence-nudge-resume"), ctxOver: { attemptId: "task-1-a2" }, opts: { resumeThrows: true }, stage: "act" },
    { name: "act-stop", plan: planFor("kill"), ctxOver: { session: "s" }, opts: { stopThrows: true }, stage: "act" },
    { name: "act-investigate", plan: planFor("investigate"), ctxOver: {}, opts: { investigateThrows: true }, stage: "act" },
    { name: "act-repair", plan: planFor("repair"), ctxOver: {}, opts: { repairThrows: true }, stage: "act" },
    { name: "act-escalate", plan: planFor("escalate"), ctxOver: {}, opts: { escalateThrows: true }, stage: "act" },
    { name: "outcome", plan: planFor("nudge"), ctxOver: {}, opts: { failAppend: (r) => r.kind === "decision-outcome" }, stage: "outcome" },
  ];
  for (const r of runs) {
    const { res } = await exec(r.plan, r.ctxOver, r.opts);
    assert.equal(res.stage, r.stage, r.name);
    assert.ok(["failed", "refused", "executed"].includes(res.status), `${r.name}: ${res.status}`);
  }
});

test("§1: executedAt echoes ctx.now — never a second clock read", async () => {
  const { res } = await exec(planFor("nudge"), { now: 12345 });
  assert.equal(res.executedAt, 12345);
});

// ───────────────────────── §7 compartment guards ───────────────────────────

const MODULE_SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+|\bexport\s*\[\s*\]\s*from\s*)["']([^"']+)["']/g;
function specifiersOf(content: string): string[] {
  return [...content.matchAll(MODULE_SPEC_RE)].map((m) => m[1]!);
}

async function walkTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { recursive: true })) {
    const p = join(dir, String(e));
    if (p.endsWith(".ts")) out.push(p.replace(/\\/g, "/").replace(/^\.\//, ""));
  }
  return out.sort();
}

test("guard: src/executor imports NOTHING — not even node: (pure-ports, docs/15 §0.5)", async () => {
  const files = await walkTs(join("src", "executor"));
  assert.ok(files.length >= 1);
  for (const file of files) {
    const content = await readFile(file, "utf-8");
    assert.deepEqual(specifiersOf(content), [], `${file} must import nothing`);
  }
});

test("guard: only the P16 host entry imports the executor (wired by src/host/supervise.ts)", async () => {
  const files = await walkTs("src");
  const offenders: string[] = [];
  for (const file of files) {
    if (file.startsWith("src/executor/")) continue;
    if (file === "src/host/supervise.ts") continue; // P16: the sanctioned host entry
    const content = await readFile(file, "utf-8").catch(() => "");
    if (specifiersOf(content).some((s) => /(^|\/)executor\//.test(s))) offenders.push(file);
  }
  assert.deepEqual(offenders, [], offenders.join(", "));
});

test("drift guard: executor mirror tables are deep-equal to the REAL planner exports", () => {
  assert.deepEqual({ ...EXEC_TEMPLATES }, { ...PLAN_TEMPLATES }, "STRATEGY_TEMPLATES drifted");
  assert.deepEqual({ ...EXEC_DECISION }, { ...PLAN_DECISION }, "ACTION_DECISION drifted");
  assert.deepEqual({ ...EXEC_RUNG }, { ...PLAN_RUNG }, "ACTION_RUNG drifted");
  assert.deepEqual([...EXEC_RECOVERY_DECISIONS].sort(), [...PLAN_RECOVERY_DECISIONS].sort(), "RECOVERY_DECISIONS drifted");
});

test("mirror pin: executor action enum matches the journal + planner enums 1:1", () => {
  assert.deepEqual([...EXEC_ACTIONS].sort(), [...JOURNAL_ACTIONS].sort());
  assert.deepEqual([...EXEC_ACTIONS].sort(), [...PLANNER_SUPERVISOR_ACTIONS].sort());
});

test("drift guard: model-swap instantiates swap:model:<id>:v1 (the swapTemplate shape)", () => {
  // the executor accepts the template the planner's swapTemplate produces
  // (pinned structurally: strategy MUST equal swap:model:<model>:v1).
  assert.match("swap:model:x-9:v1", /^swap:model:[^:]+:v1$/);
  assert.equal((EXEC_TEMPLATES as Rec)["model-swap"], undefined, "model-swap has NO static template");
});

// ───────────────── audit fixes (docs/audits/audit-p11-executor.md) ─────────

test("F1: plan-carried identity is verified against ctx (confused-deputy refused)", async () => {
  const mismatches: { over: Rec; want: string }[] = [
    { over: { taskId: "task-2" }, want: "plan-identity:task" },
    { over: { episodeId: "ep-2" }, want: "plan-identity:episode" },
    { over: { taskRevision: 3 }, want: "plan-identity:revision" }, // ctx has no revision: cannot verify
  ];
  for (const m of mismatches) {
    const { res, f } = await exec(planFor("repair", m.over));
    assert.equal(res.status, "refused", JSON.stringify(m.over));
    assert.equal(res.reason, m.want);
    assert.equal(res.stage, "revalidate");
    assert.equal(f.journal.records.length, 0, "identity refusal journals nothing");
    assert.deepEqual(f.log, []);
  }
  // matching identity executes
  const ok = await exec(planFor("repair", { taskId: "task-1", episodeId: "ep-1", taskRevision: 2 }), { taskRevision: 2 });
  assert.equal(ok.res.status, "executed");
  // malformed identity claims fail the shape (safe-id / revision>=1)
  for (const bad of [{ taskId: "" }, { taskId: "bad id" }, { episodeId: "" }, { taskRevision: 0 }]) {
    const { res } = await exec(planFor("repair", bad));
    assert.equal(res.status, "refused", JSON.stringify(bad));
    assert.match(String(res.reason), /^plan-invalid:/);
  }
  // identity feeds the actionId digest: the SAME content with vs without
  // a (matching) plan-claimed taskId yields different actionIds.
  const a = await exec(planFor("repair"));
  const b = await exec(planFor("repair", { taskId: "task-1" }));
  assert.equal(a.res.status, "executed"); assert.equal(b.res.status, "executed");
  assert.notEqual(a.res.actionId, b.res.actionId, "plan identity feeds the dedup digest");
});

test("F3: revoked-Proxy error values never escape the §5 fence", async () => {
  const revocable = () => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; };
  // act-stage port throws a revoked proxy → the catch's instanceof runs on it
  const f = mkFakes();
  const hostileDispatch = { ...f.ports.dispatch, repair: async () => { throw revocable(); } };
  const res = await executeRecoveryAction(planFor("repair"), ctx(), { ...f.ports, dispatch: hostileDispatch });
  assert.equal(res.status, "failed");
  assert.equal(res.stage, "act");
  // read() rejecting with a revoked proxy → refused, never a rejection
  const res2 = await executeRecoveryAction(planFor("repair"), ctx(), {
    journal: { append: async () => {}, read: async () => { throw revocable(); } },
    dispatch: { repair: async () => {} },
  });
  assert.equal(res2.status, "refused");
  assert.equal(res2.reason, "journal-unreadable");
  // ctx whose getter THROWS a revoked proxy (the audit probe-rerun): fence holds
  const ctxRev = new Proxy(ctx(), { get() { throw revocable(); } }) as ExecutorContext;
  const res3 = await executeRecoveryAction(planFor("repair"), ctxRev, { journal: mkFakes().ports.journal });
  assert.ok(res3.status === "refused" || res3.status === "failed", `escaped fence: ${res3.status}`);
});

test("F5: journal read() resolving garbage → journal-unreadable (no dedup bypass)", async () => {
  const garbages: unknown[] = [{ records: null }, { records: "x" }, {}, null, 7, "ok", { records: [1] }, { records: [null] }];
  for (const g of garbages) {
    const acted: string[] = [];
    const res = await executeRecoveryAction(planFor("repair"), ctx(), {
      journal: { append: async () => {}, read: async () => g as never },
      dispatch: { repair: async () => { acted.push("repair"); } },
    });
    assert.equal(res.status, "refused", JSON.stringify(g));
    assert.equal(res.stage, "dedup", JSON.stringify(g));
    assert.equal(res.reason, "journal-unreadable", JSON.stringify(g));
    assert.deepEqual(acted, [], `garbage read must act on nothing: ${JSON.stringify(g)}`);
  }
});

test("F6: mid-flight ctx mutation cannot split identity (frozen single-read snapshot)", async () => {
  const c = ctx(); // the caller's live object
  const seen: Rec[] = [];
  const journal: JournalPort = {
    append: async (rec) => { seen.push(rec as Rec); },
    read: async () => { // a "trusted" port mutating ctx mid-flight
      (c as unknown as Rec).taskId = "task-2";
      (c as unknown as Rec).episodeId = "ep-evil";
      c.authority.grantedBy = "evil";
      (c as unknown as Rec).session = "sess-stolen";
      return { records: [] };
    },
  };
  const f = mkFakes();
  const res = await executeRecoveryAction(planFor("repair"), c, { journal, dispatch: f.ports.dispatch });
  assert.equal(res.status, "executed");
  const intent = seen.find((r) => r.kind === "decision-intent")!;
  const outcome = seen.find((r) => r.kind === "decision-outcome")!;
  assert.equal(intent.taskId, "task-1", "intent keeps the validated identity");
  assert.equal(intent.episodeId, "ep-1");  assert.equal((intent.authority as { grantedBy: string }).grantedBy, "supervisor");
  assert.equal(outcome.taskId, "task-1");
  assert.equal((f.calls.repair[0] as Rec).taskId, "task-1", "dispatch request keeps it too");
  assert.ok(res.actionId.startsWith("a-task-1-repair-"));
});

test("F9: unknown reconcile decision refuses (spawn only on literal 'spawn')", async () => {
  for (const decision of ["maybe", "", "SPAWN", "spawn "] as const) {
    const { res, f } = await exec(planFor("backoff-retry"), { attemptId: "task-1-a1" }, {
      reconcileAction: decision as unknown as "spawn",
    });
    assert.equal(res.status, "refused", String(decision));
    assert.equal(res.stage, "act");
    assert.equal(res.reason, "reconcile-unknown");
    assert.equal(f.calls.run.length, 0, `must not spawn on ${String(decision)}`);
    const noEffect = outcomes(f.journal).find((r) => String(r.notes ?? "").startsWith("no-effect: reconcile-unknown"));
    assert.ok(noEffect !== undefined, "no-effect marker journals the refused act");
  }
  // a decision object that is undefined outright (mis-typed runner)
  {
    const f = mkFakes();
    const res = await executeRecoveryAction(planFor("backoff-retry"), ctx({ attemptId: "task-1-a1" }), {
      ...f.ports,
      runner: { ...f.ports.runner!, reconcile: async () => ({ decision: undefined }) as never },
    });
    assert.equal(res.status, "refused");
    assert.equal(res.reason, "reconcile-unknown");
  }
  // literal 'spawn' still executes
  const ok = await exec(planFor("backoff-retry"), { attemptId: "task-1-a1" }, { reconcileAction: "spawn" });
  assert.equal(ok.res.status, "executed");
});

test("F7: kill (no strategy template) journals an intent the REAL schema accepts", async () => {
  // A journal port enforcing the real rule: strategyId, if present, must be non-empty.
  const strict = {
    append: async (rec: object) => {
      if ("strategyId" in rec && (rec as Rec).strategyId === "") throw new Error("$.strategyId: must be non-empty");
    },
    read: async () => ({ records: [] }),
  };
  const { res, f } = await exec(planFor("kill"), { session: "sess-1" }, {});
  void strict;
  assert.equal(res.status, "executed");
  const intent = intents(f.journal)[0];
  assert.ok(intent !== undefined);
  assert.ok(!("strategyId" in intent), "empty strategyId is OMITTED from the intent, not sent as ''");
});

test("integration: executor → REAL DecisionJournal, all 12 actions + dedup on disk", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: pjoin } = await import("node:path");
  const { DecisionJournal } = await import("../src/episode/journal.js");
  const dir = await mkdtemp(pjoin(tmpdir(), "p11-real-journal-"));
  try {
    const real = await DecisionJournal.open(pjoin(dir, "decisions.jsonl"));
    const journal: JournalPort = {
      append: (rec) => real.append(rec as never),
      read: async () => await real.read(),
    };
    const f = mkFakes();
    const ports: ExecutorPorts = { journal, runner: f.ports.runner, gate: f.ports.gate, steer: f.ports.steer, dispatch: f.ports.dispatch, delay: async () => {} };
    // every journalable action end-to-end against the real validator
    const runs: { plan: Rec; ctxOver: Partial<ExecutorContext>; want: ExecutionResult["status"] }[] = [
      { plan: planFor("nudge"), ctxOver: {}, want: "executed" },
      { plan: planFor("evidence-nudge-resume"), ctxOver: { attemptId: "task-1-a1" }, want: "executed" },
      { plan: planFor("backoff-retry"), ctxOver: { attemptId: "task-1-a1" }, want: "executed" },
      { plan: planFor("investigate"), ctxOver: {}, want: "executed" },
      { plan: planFor("repair"), ctxOver: {}, want: "executed" },
      { plan: planFor("task-rewrite"), ctxOver: {}, want: "executed" },
      { plan: planFor("escalate"), ctxOver: {}, want: "executed" },
      { plan: planFor("park"), ctxOver: {}, want: "executed" },
      { plan: planFor("model-swap"), ctxOver: {}, want: "executed" },
      { plan: planFor("kill"), ctxOver: { session: "sess-1" }, want: "executed" },
      { plan: planFor("accept-finish"), ctxOver: {}, want: "executed" },
      { plan: planFor("merge"), ctxOver: {}, want: "refused" }, // merge-unwired (P12)
      { plan: planFor("hold"), ctxOver: {}, want: "held" },
    ];
    const statusBy: string[] = [];
    for (const r of runs) {
      const res = await executeRecoveryAction(r.plan, ctx(r.ctxOver), ports);
      statusBy.push(`${String(r.plan.action)}=${res.status}`);
      assert.equal(res.status, r.want, `${String(r.plan.action)}: ${res.reason ?? res.stage} ${JSON.stringify(res.error ?? "")}`);
    }
    const { records } = await real.read();
    const ji = records.filter((r) => r.kind === "decision-intent");
    const jo = records.filter((r) => r.kind === "decision-outcome");
    assert.equal(ji.length, 11, `11 executed actions journal exactly one intent: ${statusBy.join(",")}`);
    assert.equal(jo.length, 11, "one outcome each (merge/hold journal nothing)");
    const kill = ji.find((r) => r.action === "kill") as unknown as Rec;
    assert.ok(kill !== undefined && !("strategyId" in kill), "kill intent survives the real schema with strategyId absent");
    // dedup works against the disk journal: replay of the same plan refuses
    const replay = await executeRecoveryAction(planFor("nudge"), ctx(), ports);
    assert.equal(replay.status, "refused");
    assert.equal(replay.reason, "already-executed");
    // …and the ONLY legitimate re-run lever is executionSeq
    const seq2 = await executeRecoveryAction(planFor("nudge"), ctx({ executionSeq: 1 }), ports);
    assert.equal(seq2.status, "executed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ──────────── Round-2 audit remediation (R1) ───────────────────────────────

test("R1-G1: hostile denials array (throwing element getter) → clean gate-denied with no-effect outcome", async () => {
  // A gate returning allowed:false whose `denials` is a booby-trapped
  // array: reading index 0 throws. Pre-fix, normalization escaped to
  // the top fence as failed/gate with the intent stranded OPEN (a clean
  // denial turned into an open intent = replay strand).
  const hostile = new Proxy([1], {
    get(t, k) { if (k === "0") throw new Error("denial-booby"); return Reflect.get(t, k); },
    getOwnPropertyDescriptor() { return { configurable: true, enumerable: true, value: undefined }; },
    has() { return true; },
  });
  const f = mkFakes();
  const res = await executeRecoveryAction(planFor("backoff-retry"), ctx({ attemptId: "task-1-a1" }), {
    ...f.ports,
    gate: {
      check: async () => ({ allowed: false, denials: hostile as never }),
      reserve: async () => {},
    },
  });
  assert.equal(res.status, "refused");
  assert.equal(res.stage, "gate");
  assert.equal(res.reason, "gate-denied");
  assert.deepEqual(res.denials, [{ code: "malformed-denials", detail: "" }]);
  assert.equal(f.calls.run.length, 0);
  // the no-effect outcome MUST have been journaled (intent not stranded)
  const oc = outcomes(f.journal).find((r) => String(r.notes ?? "").startsWith("no-effect: gate-denied"));
  assert.ok(oc !== undefined, "no-effect outcome lands despite hostile denials");
  // replay is permitted (no-effect marker) — not stranded as intent-open
  const replay = await executeRecoveryAction(planFor("backoff-retry"), ctx({ attemptId: "task-1-a1" }), {
    ...f.ports,
    gate: { check: async () => ({ allowed: true, denials: [] }), reserve: async () => {} },
  });
  assert.ok(replay.status === "executed" || replay.status === "refused" && replay.reason !== "intent-open");
});

test("R1-G3: journal records are frozen before handoff (retaining port cannot mutate the record)", async () => {
  const kept: Rec[] = [];
  const journal: JournalPort = {
    append: async (rec) => {
      kept.push(rec as Rec); // retain by reference and try to deface it
      try { (rec as Rec).rationale = "MUTATED"; (rec as Rec).taskId = "evil"; } catch { /* frozen */ }
      try { ((rec as Rec).authority as Rec).grantedBy = "evil"; } catch { /* frozen */ }
    },
    read: async () => ({ records: [] }),
  };
  const f = mkFakes();
  const res = await executeRecoveryAction(planFor("accept-finish"), ctx(), { journal, dispatch: f.ports.dispatch });
  assert.equal(res.status, "executed");
  const intent = kept.find((r) => r.kind === "decision-intent")!;
  assert.ok(Object.isFrozen(intent), "intent frozen before append");
  assert.ok(Object.isFrozen(intent.authority), "nested authority frozen");
  assert.equal(intent.taskId, "task-1", "retained ref still carries the true identity");
  assert.notEqual(intent.rationale, "MUTATED");
  const outcome = kept.find((r) => r.kind === "decision-outcome")!;
  assert.ok(Object.isFrozen(outcome), "outcome frozen before append");
  assert.ok(Object.isFrozen(outcome.evidenceRefs), "evidenceRefs frozen");
});

test("R2-G2: gate result with a throwing 'allowed' getter (live Proxy) → refused, no stranded intent", async () => {
  const f = mkFakes();
  const live = new Proxy({ denials: [] }, {
    get(t, k) {
      if (k === "then") return undefined;
      if (k === "allowed") throw new Error("allowed-booby");
      return Reflect.get(t, k);
    },
  });
  const res = await executeRecoveryAction(planFor("backoff-retry"), ctx({ attemptId: "task1-a1" }), {
    ...f.ports,
    gate: { check: async () => live as never, reserve: async () => {} },
  });
  assert.equal(res.status, "refused");
  assert.equal(res.stage, "gate");
  assert.equal(res.reason, "gate-denied");
  assert.equal(f.calls.run.length, 0);
  // the intent is closed with a no-effect outcome, not stranded open
  const kinds = f.journal.records.map((r) => r.kind);
  assert.deepEqual(kinds, ["decision-intent", "decision-outcome"]);
  assert.match(String(outcomes(f.journal)[0]?.notes), /^no-effect: gate-denied/);
});

test("R2-G4: kill with a smuggled junk strategyId — omitted from the intent (not template-verified for kill)", async () => {
  // judgePlan exempts kill/merge from the template-equality rule (they
  // have no template), so pre-fix ANY smuggled strategyId text survived
  // into the journaled record. It must be omitted, like the empty case.
  const { res, f } = await exec(planFor("kill", { strategyId: "pretend:legit:v1" }), { session: "sess-1" }, {});
  assert.equal(res.status, "executed");
  const intent = intents(f.journal)[0] as Rec;
  assert.ok(intent !== undefined && !("strategyId" in intent), "unrecognized strategyId claims for kill never reach the record");
});

// ──────────── Round-3 audit remediation (R3) ───────────────────────────────

test("R3-B1: an act that threw AFTER landing is not replayable (no second spawn)", async () => {
  // The spawn SUCCEEDS, then the port's result value cannot even be
  // awaited (revoked proxy). Pre-fix the act catch journaled
  // `no-effect: act-failed`, which made the action replayable: a second
  // call spawned a SECOND worker for work that already happened.
  let spawns = 0;
  const { proxy, revoke } = Proxy.revocable({ attemptId: "a1" }, {});
  revoke();
  const journal: JournalPort = {
    append: async (rec) => { kept.push(rec as Rec); },
    read: async () => ({ records: kept.slice() }),
  };
  const kept: Rec[] = [];
  const f = mkFakes();
  const ports = {
    ...f.ports,
    journal,
    gate: { check: async () => ({ allowed: true, denials: [] }), reserve: async () => {} },
    delay: async () => {},
    runner: {
      reconcile: async () => ({ decision: { action: "spawn" as const, reasons: [] } }),
      run: async () => { spawns++; return proxy as never; },
      resume: async () => ({ attemptId: "a1" }),
      stop: async () => ({ stopped: true }),
    },
  };
  const first = await executeRecoveryAction(planFor("backoff-retry"), ctx({ attemptId: "task-1-a1" }), ports);
  assert.equal(first.status, "failed");
  assert.equal(spawns, 1, "the spawn did land");
  const rec = outcomes({ records: kept })[0]!;
  assert.ok(!String(rec.notes ?? "").startsWith("no-effect:"), `act-failure must NOT claim no-effect, got ${rec.notes}`);
  assert.match(String(rec.notes), /^act-unknown:/);
  // …and the retry is refused, not re-executed
  const second = await executeRecoveryAction(planFor("backoff-retry"), ctx({ attemptId: "task-1-a1" }), ports);
  assert.equal(second.status, "refused");
  assert.equal(second.reason, "already-executed");
  assert.equal(spawns, 1, "no second worker was spawned");
});

test("R3-B2: a delivered escalate whose result read throws stays non-replayable", async () => {
  const kept: Rec[] = [];
  const { proxy, revoke } = Proxy.revocable({ channel: "#ops" }, {});
  revoke();
  let escalations = 0;
  const f = mkFakes();
  const res = await executeRecoveryAction(planFor("escalate"), ctx(), {
    journal: { append: async (r) => { kept.push(r as Rec); }, read: async () => ({ records: kept.slice() }) },
    dispatch: { escalate: async () => { escalations++; return proxy as never; } },
  });
  assert.equal(escalations, 1);
  assert.ok(res.status === "executed" || res.status === "failed");
  const oc = kept.filter((r) => r.kind === "decision-outcome")[0]!;
  assert.ok(!String(oc.notes ?? "").startsWith("no-effect:"), "delivered escalation never says no-effect");
});

test("R3-B4/R4-B: the rationale is refused at plan time, not silently truncated", async () => {
  // R3 bounded the JOINED rationale to 4096 — but the joined rationale is
  // also what is OBEYED (steer text / escalate payload). Truncating after
  // the fact let the executor obey 32 KB and journal 4 KB, so the durable
  // record understated the act. The budget is now enforced where the plan
  // is still refusable.
  const kept: Rec[] = [];
  const big = "z".repeat(512);
  const res = await executeRecoveryAction(
    planFor("accept-finish", { rationale: Array.from({ length: 64 }, () => big) }), ctx(),
    { journal: { append: async (r) => { kept.push(r as Rec); }, read: async () => ({ records: [] }) } });
  assert.equal(res.status, "refused");
  assert.equal(res.reason, "plan-invalid:rationale-budget");
  assert.equal(kept.length, 0, "a refused plan journals nothing and obeys nothing");
  // and the budget is generous enough that a normal plan is unaffected
  const ok = await executeRecoveryAction(planFor("accept-finish", { rationale: ["short"] }), ctx(),
    { journal: { append: async (r) => { kept.push(r as Rec); }, read: async () => ({ records: [] }) } });
  assert.equal(ok.status, "executed");
});

test("R4-A: an UNCONFIRMED kill is act-unknown, never replayable", async () => {
  // stop() resolving {stopped:false} means the runner could not confirm the
  // kill — NOT that nothing happened. Recorded as `no-effect:` it made the
  // kill replayable and re-issued a kill command (2 stop calls, both
  // journaled "no effect").
  let stops = 0;
  const kept: Rec[] = [];
  const ports = {
    journal: { append: async (r: object) => { kept.push(r as Rec); }, read: async () => ({ records: kept.slice() }) },
    runner: {
      reconcile: async () => ({ decision: { action: "spawn", reasons: [] } }),
      run: async () => ({ attemptId: "a1" }),
      resume: async () => ({ attemptId: "a1" }),
      stop: async () => { stops++; return { stopped: false }; },
    },
  } as unknown as ExecutorPorts;
  const c = ctx({ session: "sess-1" });
  const plan = planFor("kill");
  const first = await executeRecoveryAction(plan, c, ports);
  assert.equal(first.status, "executed");
  const o = kept.filter((r) => r.kind === "decision-outcome")[0]!;
  assert.equal(o.acked, false);
  assert.match(String(o.notes), /^act-unknown: stop-unconfirmed/);
  assert.doesNotMatch(String(o.notes), /^no-effect:/);
  assert.deepEqual(o.evidenceRefs, ["stop:session-unconfirmed"], "evidence must not claim a confirmed stop");
  // replay: UNKNOWN effect ⇒ refused, and the runner is NOT commanded twice
  const second = await executeRecoveryAction(plan, c, ports);
  assert.equal(second.status, "refused");
  assert.equal(second.reason, "already-executed");
  assert.equal(stops, 1, "the kill was never re-issued");
});

test("R4-A: a hostile `stopped` getter is unconfirmed, not a second kill", async () => {
  let stops = 0;
  const kept: Rec[] = [];
  const ports = {
    journal: { append: async (r: object) => { kept.push(r as Rec); }, read: async () => ({ records: kept.slice() }) },
    runner: {
      reconcile: async () => ({ decision: { action: "spawn", reasons: [] } }),
      run: async () => ({ attemptId: "a1" }),
      resume: async () => ({ attemptId: "a1" }),
      stop: async () => { stops++; return { get stopped(): boolean { throw new Error("booby"); } } as never; },
    },
  } as unknown as ExecutorPorts;
  const c = ctx({ session: "sess-1" });
  const plan = planFor("kill");
  const first = await executeRecoveryAction(plan, c, ports);
  assert.equal(first.status, "executed");
  const o = kept.filter((r) => r.kind === "decision-outcome")[0]!;
  assert.match(String(o.notes), /^act-unknown:/);
  const second = await executeRecoveryAction(plan, c, ports);
  assert.equal(second.status, "refused");
  assert.equal(stops, 1);
});

// ── A3 (re-audit): the kill carries the attempt pin ──

test("A3: a kill with ctx.attemptId pins the stop handle and the evidence says attempt", async () => {
  let seen: { session: string; attemptId?: string } | undefined;
  const kept: Rec[] = [];
  const ports = {
    journal: { append: async (r: object) => { kept.push(r as Rec); }, read: async () => ({ records: kept.slice() }) },
    runner: {
      reconcile: async () => ({ decision: { action: "spawn", reasons: [] } }),
      run: async () => ({ attemptId: "a1" }),
      resume: async () => ({ attemptId: "a1" }),
      stop: async (h: { session: string; attemptId?: string }) => { seen = h; return { stopped: true, attemptId: h.attemptId }; },
    },
  } as unknown as ExecutorPorts;
  const res = await executeRecoveryAction(planFor("kill"), ctx({ session: "sess-1", attemptId: "task-1-a1" }), ports);
  assert.equal(res.status, "executed");
  assert.deepEqual(seen, { session: "sess-1", attemptId: "task-1-a1" }, "the runner receives the attempt pin");
  const o = kept.filter((r) => r.kind === "decision-outcome")[0]!;
  assert.deepEqual(o.evidenceRefs, ["stop:attempt-confirmed"]);
});

test("F2 (cycle-2): stopped:true from a runner that ignores the attestation is NEVER attempt-confirmed", async () => {
  // A structurally compatible runner may accept {session, attemptId} and
  // answer {stopped:true} without attesting WHICH attempt it stopped (or
  // attest a successor). The journal may not claim a pinned confirmation
  // it cannot prove: acked=false, act-unknown, non-replayable.
  const kept: Rec[] = [];
  const ports = {
    journal: { append: async (r: object) => { kept.push(r as Rec); }, read: async () => ({ records: kept.slice() }) },
    runner: {
      reconcile: async () => ({ decision: { action: "spawn", reasons: [] } }),
      run: async () => ({ attemptId: "a1" }),
      resume: async () => ({ attemptId: "a1" }),
      stop: async () => ({ stopped: true }), // no attemptId attestation
    },
  } as unknown as ExecutorPorts;
  const res = await executeRecoveryAction(planFor("kill"), ctx({ session: "sess-1", attemptId: "task-1-a1" }), ports);
  assert.equal(res.status, "executed");
  const o = kept.filter((r) => r.kind === "decision-outcome")[0]!;
  assert.equal(o.acked, false, "confirmation requires the attestation to match the pin");
  assert.match(String(o.notes), /^act-unknown: stop-unconfirmed/);
  assert.deepEqual(o.evidenceRefs, ["stop:attempt-unconfirmed"]);
  const again = await executeRecoveryAction(planFor("kill"), ctx({ session: "sess-1", attemptId: "task-1-a1" }), ports);
  assert.equal(again.status, "refused", "unconfirmed acts are never replayed");
});

test("F2 (cycle-2): attestation naming a DIFFERENT attempt (a successor) is unconfirmed", async () => {
  const kept: Rec[] = [];
  const ports = {
    journal: { append: async (r: object) => { kept.push(r as Rec); }, read: async () => ({ records: kept.slice() }) },
    runner: {
      reconcile: async () => ({ decision: { action: "spawn", reasons: [] } }),
      run: async () => ({ attemptId: "a1" }),
      resume: async () => ({ attemptId: "a1" }),
      stop: async () => ({ stopped: true, attemptId: "task-1-a2" }), // stopped a successor
    },
  } as unknown as ExecutorPorts;
  const res = await executeRecoveryAction(planFor("kill"), ctx({ session: "sess-1", attemptId: "task-1-a1" }), ports);
  assert.equal(res.status, "executed");
  const o = kept.filter((r) => r.kind === "decision-outcome")[0]!;
  assert.equal(o.acked, false);
  assert.deepEqual(o.evidenceRefs, ["stop:attempt-unconfirmed"]);
});

test("A3: a runner refusing a stale pin throws after the act began — act-unknown, never retried", async () => {
  let stops = 0;
  const kept: Rec[] = [];
  const ports = {
    journal: { append: async (r: object) => { kept.push(r as Rec); }, read: async () => ({ records: kept.slice() }) },
    runner: {
      reconcile: async () => ({ decision: { action: "spawn", reasons: [] } }),
      run: async () => ({ attemptId: "a1" }),
      resume: async () => ({ attemptId: "a1" }),
      stop: async () => { stops++; throw Object.assign(new Error("refusing to act on a successor attempt"), { code: "not-running" }); },
    },
  } as unknown as ExecutorPorts;
  const c = ctx({ session: "sess-1", attemptId: "task-1-a9" });
  const plan = planFor("kill");
  const first = await executeRecoveryAction(plan, c, ports);
  assert.equal(first.status, "failed");
  assert.equal(first.stage, "act");
  const o = kept.filter((r) => r.kind === "decision-outcome")[0]!;
  assert.match(String(o.notes), /^act-unknown:/, "a post-marker throw never claims no-effect");
  const second = await executeRecoveryAction(plan, c, ports);
  assert.equal(second.status, "refused");
  assert.equal(stops, 1, "the refused kill is never re-issued");
});
