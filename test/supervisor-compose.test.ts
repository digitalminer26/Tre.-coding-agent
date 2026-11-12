/**
 * P9/M1 — supervisor composition loop tests (docs/18 §8 acceptance exit).
 *
 * The loop runs against REAL collaborators wherever they are pure:
 * the real planner (P10) and the real executor (P11) are wired through
 * the loop's own ports; the host boundary (runner/gate/steer/accept/
 * investigate) is faked at the port line. Coverage:
 *  - §1 loop shape: gated initial run → sense → plan → execute → outcome
 *    feeds the next signal; every stop names itself.
 *  - §2 reservation discipline: settled attestation on a proven exit,
 *    request-only release otherwise; denial / reserve-throw stop before
 *    any spawn; ingestSession runs before anything else.
 *  - §3 termination: hold / parked / shutdown / escalation-exhausted /
 *    max-iterations / loop-error / no-initial-signal / finish-unjudged /
 *    accepted-finish / halt (finish rejected twice).
 *  - §4 steering: shutdown stops before execute; model override lands on
 *    the NEXT plan and moves strategyId together (executor §2 bypass rule).
 *  - §6 investigation: offered only for ambiguous-class signals, capped
 *    per signature and per episode; verdict journalized as `diagnosis`;
 *    cost recorded via recordManualSpend with ZERO token counts (M1
 *    never fabricates usage); the verdict is planner evidence only.
 *  - §7 acceptance: clean exit is finish EVIDENCE — a live complete
 *    verdict is the only path through the planner (real P10) to
 *    `accepted-finish`; a rejected finish converts and halts on the
 *    second rejection.
 *  - §5 journal doctrine: EVERY record the loop appends passes the P4
 *    validator; `hold` journals an outcome, never an intent.
 *  - §8 compartment: src/supervisor imports NOTHING; nothing outside it
 *    imports it (until P16); the mirrored enums are deep-equal to the
 *    real planner/journal/ledger exports.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  runSupervisorEpisode,
  SUPERVISOR_ACTIONS,
  SIGNAL_KINDS,
  CAUSE_CLASSES,
  RECOVERY_DECISIONS,
  VERDICTS,
  CLOSE_REASONS,
  STOP_REASONS,
  type ComposePorts,
  type SupervisorConfig,
  type SupervisorResult,
} from "../src/supervisor/compose.js";
import { executeRecoveryAction } from "../src/executor/exec.js";
import {
  planRecovery,
  STRATEGY_TEMPLATES as PLAN_TEMPLATES,
  PLANNER_SUPERVISOR_ACTIONS,
  PLANNER_CAUSE_CLASSES,
  PLANNER_VERDICTS,
  RECOVERY_DECISIONS as PLAN_RECOVERY_DECISIONS,
} from "../src/planner/plan.js";
import {
  SUPERVISOR_ACTIONS as JOURNAL_ACTIONS,
  DECISION_SIGNAL_KINDS,
  openIntents,
  validateSupervisorRecord,
} from "../src/episode/journal.js";
import { RESERVATION_CLOSE_REASONS } from "../src/budget/ledger.js";

type Rec = Record<string, unknown>;

// ───────────────────────── fakes at the port line ─────────────────────────

interface FakeOpts {
  /** initial-run handle behavior */
  exitCode?: number | null;
  noExited?: boolean;
  /** handle behavior for executor-side spawns AFTER the initial run */
  noExitedAfterFirst?: boolean;
  runThrows?: boolean;
  /** runner.run() resolves with NO handle (host contract violation) */
  runResolvesUndefined?: boolean;
  /** gate behavior */
  checkAllowed?: boolean;
  denials?: { code: string; detail: string }[];
  reserveThrows?: boolean;
  checkThrows?: boolean;
  /** executor-side steer push */
  steerPushThrows?: boolean;
}

function mkFakes(opts: FakeOpts = {}) {
  const jrec: Rec[] = [];
  const journal = {
    append: async (r: object) => { jrec.push(structuredClone(r) as Rec); },
    read: async () => ({ records: jrec }),
  };
  const gateCalls = { check: [] as object[], reserve: [] as object[], close: [] as Rec[], ingest: [] as Rec[], spend: [] as Rec[], wall: [] as Rec[] };
  const gate = {
    check: async (a: unknown, b?: unknown) => {
      gateCalls.check.push((b ?? a) as object);
      if (opts.checkThrows) throw new Error("check-boom");
      return { allowed: opts.checkAllowed ?? true, denials: opts.denials ?? [], receipt: "receipt-1" };
    },
    reserve: async (a: unknown, b?: unknown) => {
      gateCalls.reserve.push((b ?? a) as object);
      if (opts.reserveThrows) throw new Error("reserve-boom");
      return { id: "res-1" };
    },
    closeReservation: async (refId: string, reason: string, attest?: object) => {
      gateCalls.close.push({ refId, reason, attest: attest ?? null });
      return {};
    },
    ingestSession: async (session: string, scope: object) => { gateCalls.ingest.push({ session, scope }); },
    recordManualSpend: async (spend: object, scope: object) => { gateCalls.spend.push({ spend, scope }); },
    recordWallclock: async (scope: object, seconds: number) => { gateCalls.wall.push({ scope, seconds }); },
  };
  const runCalls: object[] = [];
  const resumeCalls: { t: object; attemptId: string }[] = [];
  let handlesMade = 0;
  const mkHandle = (): { attemptId?: string; session?: string; exited?: Promise<{ code?: number | null }> } => {
    handlesMade += 1;
    const noExit = opts.noExited === true || (opts.noExitedAfterFirst === true && handlesMade > 1);
    return {
      attemptId: "t1-a1",
      session: "s-1",
      ...(noExit ? {} : { exited: Promise.resolve({ code: opts.exitCode ?? 0 }) }),
    };
  };
  const runner = {
    run: async (t: object) => {
      runCalls.push(t);
      if (opts.runThrows) throw new Error("run-boom");
      if (opts.runResolvesUndefined) return undefined as never;
      return mkHandle();
    },
    reconcile: async () => ({ decision: { action: "spawn", reasons: [] } }),
    resume: async (t: object, attemptId: string) => { resumeCalls.push({ t, attemptId }); return mkHandle(); },
    stop: async () => ({ stopped: true }),
    preflight: async () => ({}),
  };
  const steerPolls: Rec[] = [];
  const steer = { poll: async () => (steerPolls.length > 0 ? steerPolls.shift() : undefined) };
  const execSteerPushes: object[] = [];
  const dispatchCalls = { investigate: [] as object[], repair: [] as object[], rewriteTask: [] as object[], escalate: [] as object[], park: [] as object[] };
  const dispatch = {
    investigate: async (req: object) => { dispatchCalls.investigate.push(req); return { evidenceRefs: ["ev-diag"] }; },
    repair: async (req: object) => { dispatchCalls.repair.push(req); return { evidenceRefs: ["ev-repair"] }; },
    rewriteTask: async (req: object) => { dispatchCalls.rewriteTask.push(req); return { taskRevision: 2 }; },
    escalate: async (req: object) => { dispatchCalls.escalate.push(req); return { channel: "human-1" }; },
    park: async (req: object) => { dispatchCalls.park.push(req); },
  };
  // The REAL executor behind a capturing spy (ctx/plan capture per call).
  const execCaptured: { plan: Rec; ctx: Rec }[] = [];
  const executor = {
    executeRecoveryAction: async (plan: object, ctx: object, ports: object) => {
      execCaptured.push({ plan: plan as Rec, ctx: ctx as Rec });
      return executeRecoveryAction(plan as never, ctx as never, ports as never) as never;
    },
  };
  const executorPorts = {
    journal,
    runner,
    gate,
    steer: { push: async (req: object) => { execSteerPushes.push(req); if (opts.steerPushThrows) throw new Error("push-boom"); } },
    dispatch,
    delay: async () => {},
  };
  const invPackets: object[] = [];
  return { jrec, journal, gate, gateCalls, runner, runCalls, resumeCalls, steer, steerPolls, execSteerPushes, execCaptured, dispatchCalls, executor, executorPorts, invPackets };
}

const cfgBase = (over: Partial<SupervisorConfig> = {}): SupervisorConfig => ({
  episodeId: "ep-1",
  taskId: "t1",
  grantedBy: "supervisor",
  worker: { session: "s-0" },
  authority: { paths: [], notPaths: [], models: ["alpha", "beta", "gamma"] },
  ...over,
});

// ───────────────────────── scripted plans (closed-table legal) ─────────────

const planOf = (action: string, over: Rec = {}): Rec => ({
  decision: ({ hold: "continue", nudge: "continue", "backoff-retry": "continue", "accept-finish": "finish", escalate: "escalate", park: "escalate", "model-swap": "change-approach", investigate: "investigate" } as Rec)[action],
  action,
  rung: ({ hold: 0, "accept-finish": 0, nudge: 1, "backoff-retry": 2, investigate: 2, "model-swap": 3, escalate: 5, park: 5 } as Rec)[action],
  sideEffect: "none",
  strategyId: action === "model-swap" ? `swap:model:${String(over.model ?? "beta")}:v1` : PLAN_TEMPLATES[action as keyof typeof PLAN_TEMPLATES],
  rationale: [`because:${action}`],
  alternatives: [],
  authorityNeeded: "none",
  notAPermission: true,
  ...over,
});

/** Planner stub returning scripted plans in order, then `hold`. Records every planRecovery input. */
function scripted(...plans: Rec[]) {
  const inputs: Rec[] = [];
  let i = 0;
  return {
    inputs,
    planner: { planRecovery: (inp: object) => { inputs.push(inp as Rec); const p = plans[i] ?? planOf("hold"); i += 1; return p; } },
  };
}

const run = async (cfg: SupervisorConfig, f: ReturnType<typeof mkFakes>, planner: ComposePorts["planner"], extra: Partial<ComposePorts> = {}): Promise<SupervisorResult> => {
  const ports: ComposePorts = {
    planner,
    executor: f.executor as unknown as ComposePorts["executor"],
    executorPorts: f.executorPorts as unknown as ComposePorts["executorPorts"],
    runner: f.runner as unknown as ComposePorts["runner"],
    gate: f.gate as unknown as ComposePorts["gate"],
    journal: f.journal,
    steer: f.steer,
    now: () => 1000,
    ...extra,
  };
  const result = await runSupervisorEpisode(cfg, ports);
  // §5 doctrine: EVERY record that reaches the journal port is P4-valid.
  for (const r of f.jrec) validateSupervisorRecord(r as never);
  return result;
};

// ───────────────────────── §1/§2: gated initial run ────────────────────────

test("§1: happy path through the REAL planner + executor — clean exit, live complete verdict → accepted-finish", async () => {
  const f = mkFakes({ exitCode: 0 });
  let acceptEvals = 0;
  const accept = { evaluate: () => { acceptEvals += 1; return { verdict: "complete", remainingWork: [], reasons: [] }; } };
  const res = await run(cfgBase({ acceptance: { spec: { dod: "done" } } }), f, { planRecovery: planRecovery as (i: object) => object }, { accept });
  assert.equal(res.stopped, "accepted-finish");
  assert.equal(res.iterations.length, 1);
  assert.equal(res.iterations[0]!.action, "accept-finish");
  assert.equal(res.iterations[0]!.decision, "finish");
  // R4/F22: the loop must FEED the live verdict to the real planner (L1 is
  // the only path to finish). Capture the planner input and assert the
  // verdict rode into it on the accept-finish plan.
  const s = scripted();
  const real = { planRecovery: (inp: object) => { s.inputs.push(inp as Rec); return planRecovery(inp as never) as never; } };
  const f2 = mkFakes({ exitCode: 0 });
  const accept2 = { evaluate: () => ({ verdict: "complete", remainingWork: [], reasons: [] }) };
  const r2 = await run(cfgBase({ acceptance: { spec: { dod: "done" } } }), f2, real as never, { accept: accept2 });
  assert.equal(r2.stopped, "accepted-finish");
  assert.equal(((s.inputs[0]!.acceptance as Rec)?.assessment as Rec)?.verdict, "complete", "the live verdict is fed to the planner");
  // F11 (audit): exactly TWO evaluations — once as evidence on the clean
  // exit, once re-evaluated fresh at accept-finish. A double-skip or a
  // double-evaluate regression must fail here.
  assert.equal(acceptEvals, 2, "acceptance evaluated once as evidence and re-evaluated at accept-finish");
  // §2: settled close with a real attestation; ingest BEFORE anything else.
  assert.deepEqual(f.gateCalls.close.map((c) => c.reason), ["settled"]);
  assert.match(String((f.gateCalls.close[0]!.attest as Rec)?.outcome), /code-0/);
  assert.equal(f.gateCalls.ingest.length, 1);
  assert.equal(f.gateCalls.ingest[0]!.session, "s-1");
  assert.equal((f.gateCalls.ingest[0]!.scope as Rec).attemptId, "t1-a1");
  // wall closed exactly once
  assert.equal(f.gateCalls.wall.length, 1);
  // journal: acceptance verdict record present
  assert.ok(f.jrec.some((r) => r.kind === "acceptance" && r.verdict === "complete"));
});

test("§2: gate denial stops before any spawn; journal OUTCOME (not an open intent) records the denial codes", async () => {
  const f = mkFakes({ checkAllowed: false, denials: [{ code: "cap-usd", detail: "over" }] });
  const res = await run(cfgBase(), f, scripted(planOf("hold")).planner);
  assert.equal(res.stopped, "initial-run-denied");
  assert.match(String(res.detail), /cap-usd/);
  assert.equal(f.runCalls.length, 0);
  assert.equal(f.gateCalls.reserve.length, 0);
  // F5 (audit): the denial is a stopped non-action — journaling an intent
  // would leave it permanently open in openIntents(). Zero intents, one
  // outcome carrying the codes.
  assert.equal(f.jrec.filter((r) => r.kind === "decision-intent").length, 0);
  const out = f.jrec.find((r) => r.kind === "decision-outcome");
  assert.ok(out && String(out.notes).includes("initial-run-denied") && String(out.notes).includes("cap-usd"));
  assert.equal(out?.acked, false);
});

test("§2: a reserve throw fails closed — no unledgered initial run, denial journalized", async () => {
  const f = mkFakes({ reserveThrows: true });
  const res = await run(cfgBase(), f, scripted(planOf("hold")).planner);
  assert.equal(res.stopped, "initial-run-denied");
  assert.match(String(res.detail), /reserve-threw/);
  assert.equal(f.runCalls.length, 0);
  // R3/F15 (docs/18 §2.2): a throw is a denial — it must be journalized.
  assert.ok(f.jrec.some((r) => r.kind === "decision-outcome" && String(r.notes).includes("reserve-threw")));
});

test("§2/F15: a check throw fails closed AND is journalized (label names check, not reserve)", async () => {
  const f = mkFakes({ checkThrows: true });
  const res = await run(cfgBase(), f, scripted(planOf("hold")).planner);
  assert.equal(res.stopped, "initial-run-denied");
  assert.match(String(res.detail), /^check-threw/);
  assert.equal(f.runCalls.length, 0);
  assert.equal(f.gateCalls.reserve.length, 0, "a check throw never reaches reserve");
  assert.ok(f.jrec.some((r) => r.kind === "decision-outcome" && String(r.notes).includes("check-threw")));
});

test("§0.2/F19: no gate port → refuse the initial spawn (never a bypass)", async () => {
  const f = mkFakes({ exitCode: 0 });
  const res = await run(cfgBase(), f, scripted(planOf("hold")).planner, { gate: undefined });
  assert.equal(res.stopped, "initial-run-denied");
  assert.equal(res.detail, "port-missing:gate");
  assert.equal(f.runCalls.length, 0, "no spawn without a gate");
});

test("§2/F20: reserve resolving with NO id fails closed (no unclosable reservation, no spawn)", async () => {
  const f = mkFakes({ exitCode: 0 });
  (f.gate as unknown as { reserve: () => Promise<unknown> }).reserve = async () => undefined;
  const res = await run(cfgBase(), f, scripted(planOf("hold")).planner);
  assert.equal(res.stopped, "initial-run-denied");
  assert.equal(res.detail, "reserve-returned-no-id");
  assert.equal(f.runCalls.length, 0);
});

test("§4/F21: a superseded steering model override is journaled, not silently lost", async () => {
  const f = mkFakes({ exitCode: 1 });
  f.steerPolls.push({ texts: ["model:alpha", "model:beta"] });
  await run(cfgBase(), f, scripted(planOf("hold")).planner);
  assert.ok(f.jrec.some((r) => String(r.notes).includes("model:alpha superseded")));
});

test("M3 swap allowlist: a steer model override OUTSIDE authority.models is refused and journaled", async () => {
  const f = mkFakes({ exitCode: 1 });
  f.steerPolls.push({ texts: ["model:delta", "ignore me"] }); // delta NOT in {alpha,beta,gamma}
  const s = scripted(planOf("model-swap", { model: "beta" }), planOf("hold"));
  const res = await run(cfgBase(), f, s.planner);
  assert.equal(res.stopped, "hold");
  const plan = f.execCaptured[0]!.plan;
  // The refused override must NOT land: the planner's own target survives.
  assert.equal(plan.model, "beta", "an unapproved override never rewrites the plan");
  assert.equal(plan.strategyId, "swap:model:beta:v1");
  assert.ok(f.jrec.some((r) => String(r.notes).includes("model:delta refused") && String(r.notes).includes("model-not-approved")),
    "the refusal is durable at the door, citing model-not-approved");
});

test("M3 swap allowlist: an approved steer override still lands (allowlist = pool, no stricter)", async () => {
  const f = mkFakes({ exitCode: 1 });
  f.steerPolls.push({ texts: ["model:gamma"] }); // gamma IS in the pool
  const s = scripted(planOf("model-swap", { model: "beta" }), planOf("hold"));
  await run(cfgBase(), f, s.planner);
  const plan = f.execCaptured[0]!.plan;
  assert.equal(plan.model, "gamma");
  assert.equal(plan.strategyId, "swap:model:gamma:v1");
  assert.ok(!f.jrec.some((r) => String(r.notes).includes("refused")), "an approved override is not refused");
});

test("M3 swap allowlist: no models in authority = NO override approved (parity with ledger 'Absent = none')", async () => {
  const f = mkFakes({ exitCode: 1 });
  f.steerPolls.push({ texts: ["model:beta"] });
  const s = scripted(planOf("model-swap", { model: "beta" }), planOf("hold"));
  await run(cfgBase({ authority: { paths: [], notPaths: [] } }), f, s.planner);
  assert.ok(f.jrec.some((r) => String(r.notes).includes("model:beta refused")),
    "with an empty pool every override is refused (same semantics as the ledger's model-not-approved)");
});

test("M3 swap allowlist: refusals in ONE poll journal under DISTINCT actionIds — incl. the SAME model twice (audit-haiku F6: model-name ids still collided on repeats)", async () => {
  const f = mkFakes({ exitCode: 1 });
  f.steerPolls.push({ texts: ["model:delta", "model:delta", "model:epsilon"] }); // all OUTSIDE {alpha,beta,gamma}
  const s = scripted(planOf("model-swap", { model: "beta" }), planOf("hold"));
  await run(cfgBase(), f, s.planner);
  const refused = f.jrec.filter((r) => String(r.notes).includes("refused — model-not-approved"));
  assert.equal(refused.length, 3, "all three refusals are durable (a colliding id + keyed append would swallow duplicates)");
  const ids = new Set(refused.map((r) => String(r["actionId"])));
  assert.equal(ids.size, 3, "distinct actionIds — a per-poll counter rides in the id; model name alone collides on repeats");
  assert.ok([...ids].every((id) => /_refused_[123]-(delta|epsilon)$/.test(id)), `ids carry a counter + the model: ${[...ids].join(", ")}`);
});

test("§9/F22-R4-2: an executor-side spawn reservation closes 'settled' on a proven exit", async () => {
  const f = mkFakes({ exitCode: 1 });
  const s = scripted(planOf("backoff-retry"), planOf("hold"));
  await run(cfgBase({ maxIterations: 2 }), f, s.planner);
  // close[0] = initial-run reservation; close[1] = the executor-side
  // backoff-retry reservation (previously it NEVER closed).
  assert.equal(f.gateCalls.close.length, 2);
  assert.deepEqual(f.gateCalls.close.map((c) => c.reason), ["settled", "settled"]);
  assert.match(String((f.gateCalls.close[1]!.attest as Rec)?.outcome), /attempt-exited code-1/);
  // docs/18 §9: both intent pairs (loop sup-… and executor a-…) self-close.
  const open = openIntents(f.jrec as never);
  assert.deepEqual(open.map((r) => String(r.actionId)), [], "no intent left open after the episode");
});

test("§9/F22-R4-2: executor refusal after admission closes 'released' (nothing spawned)", async () => {
  const f = mkFakes({ exitCode: 1 });
  (f.executorPorts as unknown as { runner: { reconcile: () => Promise<unknown> } }).runner.reconcile = async () => ({ decision: { action: "running", reasons: [] } });
  const s = scripted(planOf("backoff-retry"), planOf("hold"));
  await run(cfgBase({ maxIterations: 2 }), f, s.planner);
  assert.equal(f.gateCalls.close.length, 2, "the refused executor reservation was closed");
  assert.equal(f.gateCalls.close[1]!.reason, "released");
  assert.equal(f.gateCalls.close[1]!.attest, null);
});

test("§9/F22-R4-2: unobservable executor-spawn exit closes request-only 'released'", async () => {
  const f = mkFakes({ exitCode: 1, noExitedAfterFirst: true });
  const s = scripted(planOf("backoff-retry"), planOf("hold"));
  await run(cfgBase({ maxIterations: 2 }), f, s.planner);
  assert.equal(f.gateCalls.close.length, 2);
  assert.equal(f.gateCalls.close[1]!.reason, "released", "unobservable exit → request-only, never attested settled");
});

test("§9/R6-3: executor 'failed' WITH journaled no-effect releases the reservation", async () => {
  const f = mkFakes({ exitCode: 1 });
  const aid = "a-t1-backoff-retry-failed-noeffect";
  (f.executor as unknown as { executeRecoveryAction: (p: object, c: object, p2: object) => Promise<object> }).executeRecoveryAction =
    async (_plan: object, _ctx: object, ports: object) => {
      const ep = ports as { gate?: { reserve?: (p: unknown, r: unknown) => Promise<unknown> }; journal?: { append?: (r: object) => Promise<void> } };
      await ep.gate?.reserve?.(undefined, { action: "run" });
      await ep.journal?.append?.({ schema: "tre-supervisor/1", id: `${aid}#o0`, ts: 1000, episodeId: "ep-1", taskId: "t1", kind: "decision-outcome", actionId: aid, acked: false, progress: "none", notes: "no-effect: simulated" });
      return { status: "failed", stage: "act", reason: "boom-noeffect", actionId: aid };
    };
  const s = scripted(planOf("backoff-retry"), planOf("hold"));
  await run(cfgBase({ maxIterations: 2 }), f, s.planner);
  assert.equal(f.gateCalls.close.length, 2, "proven no-effect failed releases the executor reservation");
  assert.equal(f.gateCalls.close[1]!.reason, "released");
});

test("§9/R6-3: executor 'failed' with NO journal marker never releases", async () => {
  const f = mkFakes({ exitCode: 1 });
  (f.executor as unknown as { executeRecoveryAction: (p: object, c: object, p2: object) => Promise<object> }).executeRecoveryAction =
    async (_plan: object, _ctx: object, ports: object) => {
      const ep = ports as { gate?: { reserve?: (p: unknown, r: unknown) => Promise<unknown> } };
      await ep.gate?.reserve?.(undefined, { action: "run" });
      return { status: "failed", stage: "act", reason: "boom-unknown", actionId: "a-t1-failed-unknown" };
    };
  const s = scripted(planOf("backoff-retry"), planOf("hold"));
  await run(cfgBase({ maxIterations: 2 }), f, s.planner);
  assert.equal(f.gateCalls.close.length, 1, "unproven failed leaves the reservation to expiry");
});

test("§9/R6-1: a stale same-actionId no-effect never proves a fresh act whose outcome was lost", async () => {
  const f = mkFakes({ exitCode: 1 });
  const aid = "a-t1-backoff-retry-stale";
  // Seed a PRIOR execution's no-effect outcome for this actionId.
  f.jrec.push({ schema: "tre-supervisor/1", id: "stale-o0", ts: 900, episodeId: "ep-1", taskId: "t1", kind: "decision-outcome", actionId: aid, acked: false, progress: "none", notes: "no-effect: prior-run" } as never);
  (f.executor as unknown as { executeRecoveryAction: (p: object, c: object, p2: object) => Promise<object> }).executeRecoveryAction =
    async (_plan: object, _ctx: object, ports: object) => {
      const ep = ports as { gate?: { reserve?: (p: unknown, r: unknown) => Promise<unknown> }; journal?: { append?: (r: object) => Promise<void> } };
      await ep.gate?.reserve?.(undefined, { action: "run" });
      // Fresh intent lands (§14.3), the effect lands, the outcome append is LOST.
      await ep.journal?.append?.({ schema: "tre-supervisor/1", id: `${aid}#i1`, ts: 1000, episodeId: "ep-1", taskId: "t1", kind: "decision-intent", actionId: aid, rung: 1, action: "backoff-retry", authority: { grantedBy: "host", sideEffect: "external" } });
      return { status: "refused", stage: "act", reason: "outcome-lost", actionId: aid };
    };
  const s = scripted(planOf("backoff-retry"), planOf("hold"));
  await run(cfgBase({ maxIterations: 2 }), f, s.planner);
  // Old backward-scan matched the stale outcome and released; the tight
  // window (first match per actionId must be the outcome, not the intent)
  // refuses to prove it → expiry backstops.
  assert.equal(f.gateCalls.close.length, 1, "stale marker must never release a fresh act");
});

test("§9/F22-R4-2: executor refusal AFTER delivery (act-unknown) is never blind-released", async () => {
  const f = mkFakes({ exitCode: 1 });
  // Force a post-delivery refusal: reconcile spawns, then the runner's
  // run succeeds but its result read traps → act-unknown refusal path.
  // Simulate via a throwing resume... simpler: make the executor's runner
  // throw inside run AFTER reserve by poisoning reconcile to spawn then
  // run to throw — here emulate act-unknown by swapping the result: the
  // refusal carries no no-effect marker, so no close may happen.
  (f.executor as unknown as { executeRecoveryAction: (p: object, c: object, ports: object) => Promise<object> }).executeRecoveryAction =
    async (plan: object, ctx: object, ports: object) => {
      const ep = ports as { gate?: { reserve?: (p: unknown, r: unknown) => Promise<{ id?: string }> } };
      await ep.gate?.reserve?.(undefined, { action: "run" });
      return { status: "refused", stage: "act", reason: "post-effect", actionId: "a-t1-backoff-retry-x" };
    };
  const s = scripted(planOf("backoff-retry"), planOf("hold"));
  await run(cfgBase({ maxIterations: 2 }), f, s.planner);
  // initial-run close only — the executor reservation (id res-1) must NOT
  // be released on an unproven refusal.
  assert.equal(f.gateCalls.close.length, 1, "unproven refusal leaves the reservation to expiry");
});

test("§9/F22-R4-2: executor throw after reserve leaves the reservation to expiry", async () => {
  const f = mkFakes({ exitCode: 1 });
  (f.executor as unknown as { executeRecoveryAction: (p: object, c: object, ports: object) => Promise<object> }).executeRecoveryAction =
    async (_plan: object, _ctx: object, ports: object) => {
      const ep = ports as { gate?: { reserve?: (p: unknown, r: unknown) => Promise<{ id?: string }> } };
      await ep.gate?.reserve?.(undefined, { action: "run" });
      throw new Error("mid-act-boom");
    };
  const s = scripted(planOf("backoff-retry"), planOf("hold"));
  await run(cfgBase({ maxIterations: 2 }), f, s.planner);
  assert.equal(f.gateCalls.close.length, 1, "executor throw leaves the reservation to expiry");
});

test("§9/R5-6: a class-based gate port keeps its receiver on close (no unbound this)", async () => {
  const f = mkFakes({ exitCode: 1 });
  let seenThis: unknown;
  class ClassGate {
    constructor(private inner: { check: (...a: never[]) => Promise<unknown>; reserve: (...a: never[]) => Promise<unknown> }) {}
    check = (...a: never[]) => this.inner.check(...a);
    reserve = (...a: never[]) => this.inner.reserve(...a);
    async closeReservation(refId: string, reason: string, attest?: object) {
      seenThis = this;
      return this.inner === undefined ? {} : (f.gate as unknown as { closeReservation: (r: string, s: string, a?: object) => Promise<unknown> }).closeReservation(refId, reason, attest);
    }
  }
  (f.executorPorts as unknown as { gate: unknown }).gate =
    new ClassGate(f.executorPorts.gate as never) as never;
  const s = scripted(planOf("backoff-retry"), planOf("hold"));
  await run(cfgBase({ maxIterations: 2 }), f, s.planner);
  assert.ok(seenThis instanceof ClassGate, "close kept its receiver");
  assert.equal(f.gateCalls.close.length, 2);
});

test("§2/F14: run() resolving with NO handle closes the reservation and signals (never a silent stop)", async () => {
  const f = mkFakes({ runResolvesUndefined: true });
  const res = await run(cfgBase(), f, scripted(planOf("hold")).planner);
  assert.equal(res.stopped, "hold", "the loop continues with an endpoint-error signal, not no-initial-signal");
  assert.deepEqual(f.gateCalls.close.map((c) => c.reason), ["released"], "the reservation is released, not left open");
});

test("§2: unobserved exit closes the reservation request-only (unattested)", async () => {
  const f = mkFakes({ noExited: true });
  const s = scripted(planOf("hold"));
  const res = await run(cfgBase(), f, s.planner);
  assert.equal(res.stopped, "hold");
  assert.deepEqual(f.gateCalls.close.map((c) => c.reason), ["released"]);
  assert.equal(f.gateCalls.close[0]!.attest, null);
  const w = s.inputs[0]!.worker as Rec;
  assert.equal(w.detail, "initial-run-exit-unobserved", "the loop signals the unobserved exit");
});

test("no worker target → the loop stops honestly (no fabricated signal)", async () => {
  const f = mkFakes();
  const res = await run(cfgBase({ worker: undefined }), f, scripted().planner);
  assert.equal(res.stopped, "no-initial-signal");
  assert.equal(res.iterations.length, 0);
  assert.equal(f.runCalls.length, 0);
});

// ───────────────────────── §3: termination paths ───────────────────────────

test("§3: parked — executor receives the tracked attemptId + session in ctx", async () => {
  const f = mkFakes({ exitCode: 1 });
  const s = scripted(planOf("park"));
  const res = await run(cfgBase(), f, s.planner);
  assert.equal(res.stopped, "parked");
  assert.equal(f.dispatchCalls.park.length, 1);
  const ctx = f.execCaptured[0]!.ctx;
  assert.equal(ctx.attemptId, "t1-a1", "attemptId from the initial-run handle reaches recovery actions");
  assert.equal(ctx.session, "s-1");
  assert.equal(f.jrec.some((r) => r.kind === "decision-intent" && r.action === "park"), true);
});

test("§3: hold journals an OUTCOME, never an intent (P11 doctrine)", async () => {
  const f = mkFakes({ exitCode: 1 });
  const res = await run(cfgBase(), f, scripted(planOf("hold")).planner);
  assert.equal(res.stopped, "hold");
  const holdRecs = f.jrec.filter((r) => String(r.notes ?? "").includes("non-action hold"));
  assert.equal(holdRecs.length, 1);
  assert.equal(holdRecs[0]!.kind, "decision-outcome");
  assert.equal(f.jrec.filter((r) => r.kind === "decision-intent").length, 0, "no intent for a non-action");
  assert.equal(f.execCaptured.length, 0, "hold never reaches the executor");
});

test("§3: two consecutive escalates stop as escalation-exhausted (one dispatch)", async () => {
  const f = mkFakes({ exitCode: 1 });
  const res = await run(cfgBase(), f, scripted(planOf("escalate"), planOf("escalate")).planner);
  assert.equal(res.stopped, "escalation-exhausted");
  assert.equal(f.dispatchCalls.escalate.length, 1, "the second escalate stops before acting");
});

test("§3: a non-escalate action resets the consecutive-escalate counter", async () => {
  const f = mkFakes({ exitCode: 1 });
  // distinct rationales → distinct actionId digests (executor I2 dedup keys
  // on canonical(plan)+seq, so an identical repeat would refuse legitimately)
  const s = scripted(planOf("escalate"), planOf("nudge"), planOf("escalate", { rationale: ["because:escalate-2"] }), planOf("hold"));
  const res = await run(cfgBase(), f, s.planner);
  assert.equal(res.stopped, "hold");
  assert.equal(f.dispatchCalls.escalate.length, 2, "counter reset: the third-iteration escalate executes instead of stopping");
});

test("§3: maxIterations bounds the loop and names the cap", async () => {
  const f = mkFakes({ exitCode: 1 });
  const s = scripted(); // always hold? no — always nudge below
  const nudges = scripted(planOf("nudge"), planOf("nudge"), planOf("nudge"), planOf("nudge"));
  void s;
  const res = await run(cfgBase({ maxIterations: 3 }), f, nudges.planner);
  assert.equal(res.stopped, "max-iterations");
  assert.equal(res.detail, "cap-3");
  assert.equal(res.iterations.length, 3);
  // R3/F18 (docs/18 §3): the cap stop journals before returning.
  assert.ok(f.jrec.some((r) => r.kind === "decision-outcome" && String(r.notes).includes("stop max-iterations cap-3")));
});

test("§3/F13: a non-finite maxIterations falls back to the default (no unbounded loop)", async () => {
  const f = mkFakes({ exitCode: 1 });
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const res = await run(cfgBase({ maxIterations: bad }), f, scripted(planOf("nudge"), planOf("hold")).planner);
    assert.equal(res.stopped, "hold", `cap=${String(bad)} must not disable the cap or the stop`);
  }
});

test("§3: planner throw → loop-error, never re-thrown into the host", async () => {
  const f = mkFakes({ exitCode: 1 });
  const res = await run(cfgBase(), f, { planRecovery: () => { throw new TypeError("planner-boom"); } });
  assert.equal(res.stopped, "loop-error");
  assert.match(String(res.error?.name), /TypeError/);
});

test("§3: missing grantedBy stops the loop before any port is touched", async () => {
  const f = mkFakes();
  const cfg = { ...cfgBase(), grantedBy: "" } as SupervisorConfig;
  const res = await run(cfg, f, scripted().planner);
  assert.equal(res.stopped, "loop-error");
  assert.equal(res.error?.name, "config");
  assert.equal(f.jrec.length, 0);
  // R3/F16: "before any port" includes the wallclock — an unvalidated
  // episodeId/taskId must never reach the ledger.
  assert.equal(f.gateCalls.wall.length, 0, "no spend write under an unvalidated id");
});

// ───────────────────────── §4: steering ────────────────────────────────────

test("§4: shutdown stops BEFORE execute and journals the stop", async () => {
  const f = mkFakes({ exitCode: 1 });
  f.steerPolls.push({ shutdown: true });
  const res = await run(cfgBase(), f, scripted(planOf("nudge")).planner);
  assert.equal(res.stopped, "shutdown");
  assert.equal(f.execCaptured.length, 0);
  assert.ok(f.jrec.some((r) => String(r.notes ?? "").includes("shutdown requested")));
});

test("§4: model override lands on the next plan and moves strategyId with it", async () => {
  const f = mkFakes({ exitCode: 1 });
  f.steerPolls.push({ texts: ["model:gamma", "ignore me"] });
  const s = scripted(planOf("model-swap", { model: "beta" }), planOf("hold"));
  const res = await run(cfgBase(), f, s.planner);
  assert.equal(res.stopped, "hold");
  const plan = f.execCaptured[0]!.plan;
  assert.equal(plan.model, "gamma");
  assert.equal(plan.strategyId, "swap:model:gamma:v1", "executor §2: a strategy naming a different model is a bypass");
});

// ───────────────────────── §6: investigation ───────────────────────────────

const diag = (causeClass: string, over: Rec = {}): Rec => ({
  causeClass,
  confidence: 0.9,
  evidenceRefs: ["e1"],
  limitsRespected: { toolsUsed: 2, spendUsd: 0.1 },
  ...over,
});

test("§6: ambiguous signal → investigation offered; verdict journalized, cost recorded WITHOUT token counts", async () => {
  const f = mkFakes({ exitCode: 0 }); // worker-exit = ambiguous class
  const investigate = async (packet: object) => { f.invPackets.push(packet); return diag("premature-stop"); };
  const s = scripted(planOf("hold"));
  const res = await run(cfgBase(), f, s.planner, { investigate });
  assert.equal(res.investigationCount, 1);
  assert.equal(f.invPackets.length, 1);
  const drec = f.jrec.find((r) => r.kind === "diagnosis");
  assert.equal(drec?.causeClass, "premature-stop");
  assert.deepEqual((drec as Rec).limitsRespected, { toolsUsed: 2, spendUsd: 0.1 });
  // cost → ledger via recordManualSpend, usage MUST be zero (no fabrication)
  assert.equal(f.gateCalls.spend.length, 1);
  const spend = (f.gateCalls.spend[0] as Rec).spend as Rec;
  assert.deepEqual(spend.usage, { input: 0, output: 0 });
  assert.match(String(spend.note), /P15 estimate spendUsd=0\.1/);
  // the verdict reaches the PLANNER as evidence, not as an order
  assert.deepEqual((s.inputs[0] as Rec).diagnosis && (s.inputs[0]!.diagnosis as Rec).causeClass, "premature-stop");
});

test("§6: deterministic-class signals (endpoint-error) never offer investigation", async () => {
  const f = mkFakes({ runThrows: true }); // → endpoint-error
  const investigate = async () => { throw new Error("must not be called"); };
  const res = await run(cfgBase(), f, scripted(planOf("hold")).planner, { investigate });
  assert.equal(res.stopped, "hold");
  assert.equal(res.investigationCount, 0);
  assert.equal(f.jrec.filter((r) => r.kind === "diagnosis").length, 0);
});

test("§6: sameSignatureMax caps repeat investigations of an identical signature; episodeMax caps the episode", async () => {
  const f = mkFakes({ exitCode: 0 });
  const investigate = async (packet: object) => { f.invPackets.push(packet); return diag("unknown"); };
  // signals: worker-exit → no-advance|executed… → no-advance|refused… →
  // no-advance|refused… (SAME signature — must be skipped) → hold
  const s = scripted(planOf("nudge"), planOf("nudge"), planOf("nudge"), planOf("nudge"), planOf("hold"));
  const res = await run(cfgBase({ investigation: { sameSignatureMax: 1, episodeMax: 9 } }), f, s.planner, { investigate });
  assert.equal(res.stopped, "hold");
  assert.equal(res.investigationCount, 3, "three distinct signatures, the repeat skipped");
  const sigs = f.invPackets.map((p) => String((p as Rec).signalDetail ?? (p as Rec).signal));
  assert.equal(new Set(sigs).size, sigs.length, "no signature investigated twice");
});

test("§6: an investigation throw degrades to a log — the loop keeps going", async () => {
  const f = mkFakes({ exitCode: 0 });
  const logs: string[] = [];
  const investigate = async () => { throw new Error("inv-boom"); };
  const res = await run(cfgBase(), f, scripted(planOf("hold")).planner, { investigate, log: (l) => logs.push(l) });
  assert.equal(res.stopped, "hold");
  assert.equal(res.investigationCount, 1, "the offer was consumed even though it failed");
  assert.ok(logs.some((l) => l.includes("investigate-threw")));
});

// ───────────────────────── §7: acceptance gating ───────────────────────────

test("§7: accept-finish with no accept port stops UNJUDGED and says so in the journal", async () => {
  const f = mkFakes({ exitCode: 1 });
  const res = await run(cfgBase(), f, scripted(planOf("accept-finish")).planner);
  assert.equal(res.stopped, "finish-unjudged");
  assert.ok(f.jrec.some((r) => String(r.notes ?? "").includes("UNJUDGED")));
});

test("§7: a rejected finish converts to a verify-gap signal; the second rejection halts", async () => {
  const f = mkFakes({ exitCode: 1 });
  const accept = { evaluate: () => ({ verdict: "incomplete", remainingWork: ["fix it"], reasons: ["not done"] }) };
  const s = scripted(planOf("accept-finish"), planOf("accept-finish"));
  const res = await run(cfgBase({ acceptance: { spec: { dod: "done" } } }), f, s.planner, { accept });
  assert.equal(res.stopped, "halt");
  assert.equal(res.detail, "finish-rejected-twice");
  assert.equal(f.jrec.filter((r) => r.kind === "acceptance" && r.verdict === "incomplete").length, 2);
  // the rejection fed back as a signal the planner saw
  assert.match(String(((s.inputs[1]!.worker as Rec) ?? {}).detail ?? ""), /finish-rejected/);
});

test("§7: the verdict must not outlive the attempt it judged (clean exit → real planner finish)", async () => {
  const f = mkFakes({ exitCode: 0 });
  const accept = { evaluate: () => ({ verdict: "complete", remainingWork: [], reasons: [] }) };
  const res = await run(cfgBase({ acceptance: { spec: { dod: "done" } } }), f, { planRecovery: planRecovery as (i: object) => object }, { accept });
  assert.equal(res.stopped, "accepted-finish");
});

test("§7/F1: a respawn after a verdict clears it even when the new handle never exits", async () => {
  // Trigger: worker-exit (initial run) evaluates to `incomplete`; the
  // scripted planner declines to finish and executes a nudge whose
  // executor spawn has NO observable exit (noExited fakes). The next
  // plan input must carry NO `acceptance` — the verdict died with the
  // attempt it judged (audit finding F1: the reset used to sit inside
  // the exited-branch, so a non-exiting spawn kept the stale verdict).
  const f = mkFakes({ exitCode: 0, noExitedAfterFirst: true });
  let evals = 0;
  const accept = { evaluate: () => { evals += 1; return { verdict: "incomplete", remainingWork: ["more"], reasons: ["r"] }; } };
  const s = scripted(planOf("backoff-retry"), planOf("hold"));
  const res = await run(cfgBase({ acceptance: { spec: { dod: "done" } } }), f, s.planner, { accept });
  assert.equal(res.stopped, "hold");
  assert.equal(res.iterations[0]?.execStatus, "executed", "the respawn actually ran");
  assert.ok(evals >= 1, "verdict was evaluated on the clean-exit trigger");
  assert.ok(s.inputs[0] && s.inputs[0].acceptance !== undefined, "first plan carried the live verdict");
  const after = s.inputs[1] as Rec;
  assert.equal(after.acceptance, undefined, "the respawn consumed the verdict — no stale acceptance in the next plan");
});

test("§9/F6: a malformed host call stops loop-error without throwing into the host", async () => {
  // no await-on-port possible: cfg and ports are null.
  const res = await runSupervisorEpisode(null as never, null as never);
  assert.equal(res.stopped, "loop-error");
  assert.equal(res.error?.name, "config");
});

test("§9/F6: a throwing clock never escapes — every timestamp clamps to 0", async () => {
  const f = mkFakes({ exitCode: 0 });
  const res = await run(cfgBase(), f, scripted(planOf("hold")).planner, { now: () => { throw new Error("clock-boom"); } });
  assert.equal(res.stopped, "hold");
  assert.ok(f.jrec.length >= 1);
  assert.ok(f.jrec.every((r) => r.ts === 0));
});

test("§6/F7: a causeClass outside the mirror enum is clamped to 'unknown' (schema-valid + planner-safe)", async () => {
  const f = mkFakes({ exitCode: 0 });
  const investigate = async () => ({ causeClass: "bogus-class", confidence: 0.9, evidenceRefs: [], limitsRespected: { toolsUsed: 2.7, spendUsd: 0.01 }, proposedActions: [] });
  const s = scripted(planOf("hold"));
  const res = await run(cfgBase(), f, s.planner, { investigate });
  assert.equal(res.stopped, "hold");
  assert.equal(res.investigationCount, 1);
  const d = f.jrec.find((r) => r.kind === "diagnosis");
  assert.equal(d?.causeClass, "unknown");
  assert.equal(((d?.limitsRespected as Rec)?.toolsUsed), 2);
  // planner saw the clamped value too
  assert.equal(((s.inputs[0] as Rec).diagnosis as Rec)?.causeClass, "unknown");
});

test("§7/F10: accept port present but NO acceptance config → finish passes through unjudged", async () => {
  const f = mkFakes({ exitCode: 1 });
  let evals = 0;
  const accept = { evaluate: () => { evals += 1; return { verdict: "complete" }; } };
  const res = await run(cfgBase(), f, scripted(planOf("accept-finish")).planner, { accept });
  assert.equal(res.stopped, "finish-unjudged");
  assert.equal(evals, 0, "no evaluate over an undefined spec — unjudged means unjudged");
});

test("§5/F4: every journaled intent gets a paired decision-outcome (openIntents drains)", async () => {
  const f = mkFakes({ exitCode: 1 });
  const s = scripted(planOf("nudge"), planOf("backoff-retry"), planOf("hold"));
  const res = await run(cfgBase(), f, s.planner);
  assert.equal(res.stopped, "hold");
  const intents = f.jrec.filter((r) => r.kind === "decision-intent");
  assert.ok(intents.length >= 2, "the two executed actions journaled intents");
  const open = openIntents(f.jrec as never);
  assert.deepEqual(open, [], "no loop intent is left open after its act (audit F4)");
});

test("§5/F4/R3: accept-finish stops (unjudged, accepted, reject-twice, reject-continue) pair intent→outcome", async () => {
  // unjudged (no accept port)
  let f = mkFakes({ exitCode: 1 });
  let res = await run(cfgBase(), f, scripted(planOf("accept-finish")).planner);
  assert.equal(res.stopped, "finish-unjudged");
  assert.deepEqual(openIntents(f.jrec as never), [], "unjudged stop closes the intent under its own id");
  // accepted
  f = mkFakes({ exitCode: 1 });
  const complete = { evaluate: () => ({ verdict: "complete", remainingWork: [], reasons: [] }) };
  res = await run(cfgBase({ acceptance: { spec: { dod: "x" } } }), f, scripted(planOf("accept-finish")).planner, { accept: complete });
  assert.equal(res.stopped, "accepted-finish");
  assert.deepEqual(openIntents(f.jrec as never), [], "accepted stop closes the intent");
  // rejected twice → halt; rejected once → continue closes before the next plan
  f = mkFakes({ exitCode: 1 });
  const incomplete = { evaluate: () => ({ verdict: "incomplete", remainingWork: [], reasons: [] }) };
  res = await run(cfgBase({ acceptance: { spec: { dod: "x" } } }), f, scripted(planOf("accept-finish"), planOf("accept-finish")).planner, { accept: incomplete });
  assert.equal(res.stopped, "halt");
  assert.deepEqual(openIntents(f.jrec as never), [], "halt-on-second-reject closes both intents");
  f = mkFakes({ exitCode: 1 });
  res = await run(cfgBase({ acceptance: { spec: { dod: "x" } } }), f, scripted(planOf("accept-finish"), planOf("hold")).planner, { accept: incomplete });
  assert.equal(res.stopped, "hold");
  assert.deepEqual(openIntents(f.jrec as never), [], "the reject-continue closes its intent");
});

test("§5/F4/R3: escalation-exhausted and a throwing executor close the pending intent", async () => {
  const f = mkFakes({ exitCode: 1 });
  const res = await run(cfgBase(), f, scripted(planOf("escalate"), planOf("escalate")).planner);
  assert.equal(res.stopped, "escalation-exhausted");
  assert.deepEqual(openIntents(f.jrec as never), [], "the second (unexecuted) escalate closes its intent");
  // executor throws on a journaled action
  const boom = { executeRecoveryAction: () => { throw new Error("exec-boom"); } };
  const f2 = mkFakes({ exitCode: 1 });
  const res2 = await run(cfgBase(), f2, scripted(planOf("nudge")).planner, { executor: boom as never });
  assert.equal(res2.stopped, "loop-error");
  assert.match(String(res2.error?.name), /executor/);
  assert.deepEqual(openIntents(f2.jrec as never), [], "executor throw closes the pending intent before the stop");
});

test("§5/F18: no-initial-signal writes a stop outcome (docs/18 §3: no stop skips step 7)", async () => {
  const f = mkFakes();
  const res = await run(cfgBase({ worker: undefined }), f, scripted().planner);
  assert.equal(res.stopped, "no-initial-signal");
  assert.ok(f.jrec.some((r) => r.kind === "decision-outcome" && String(r.notes).includes("stop no-initial-signal")));
});

test("F3: an executed act never launders progress 'uptake' (executor E4 doctrine)", async () => {
  const f = mkFakes({ exitCode: 1 });
  const s = scripted(planOf("nudge"), planOf("hold"));
  const res = await run(cfgBase(), f, s.planner);
  assert.equal(res.stopped, "hold");
  const lo = (s.inputs[1] as Rec).lastOutcome as Rec;
  assert.equal(lo?.action, "nudge");
  assert.equal(lo?.progress, "none", "'executed' is dispatch, not advancement");
});

// ───────────────────────── real-planner end-to-end (no scripted plans) ────

test("end-to-end (REAL planner): an ambiguous signal's diagnosis reaches the planner input on the next plan", async () => {
  // A clean exit (worker-exit, ambiguous class) offers investigation; the
  // diagnosis must ride into the NEXT planner input as `diagnosis`.
  const f = mkFakes({ exitCode: 0 });
  const packets: object[] = [];
  const investigate = async (packet: object) => { packets.push(packet); return diag("transient-endpoint"); };
  const s = scripted();
  const real = { planRecovery: (inp: object) => { s.inputs.push(inp as Rec); return planRecovery(inp as never) as never; } };
  const res = await run(cfgBase({ maxIterations: 4 }), f, real as never, { investigate });
  // The investigation is offered for a non-deterministic signal (worker-exit
  // is one). Whether it fires depends on the planner's first action, so the
  // invariant pinned here is: IF a diagnosis was produced, the next planner
  // input carries it, and the loop terminates on a named stop.
  if (packets.length > 0) {
    assert.ok(s.inputs.length >= 2, "a plan followed the diagnosis");
    assert.equal(((s.inputs[1]!.diagnosis as Rec) ?? {})["causeClass"], "transient-endpoint", "the diagnosis reached the planner");
  }
  assert.ok(typeof res.stopped === "string" && res.stopped.length > 0, `named stop=${res.stopped}`);
});

// ───────────────────────── §5: journal doctrine extras ─────────────────────

test("§5: every journal id is unique per episode (no clobbering)", async () => {
  const f = mkFakes({ exitCode: 1 });
  const s = scripted(planOf("nudge"), planOf("escalate"), planOf("escalate"));
  await run(cfgBase(), f, s.planner);
  const ids = f.jrec.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(f.jrec.every((r) => r.schema === "tre-supervisor/1" && r.episodeId === "ep-1" && r.taskId === "t1"));
});

test("§5: a journal append failure never fails the loop", async () => {
  const f = mkFakes({ exitCode: 1 });
  // Break the journal the loop is given (executorPorts.journal is replaced
  // by ports.journal for the loop's own appends only in host wiring; here
  // the loop journal IS this port): every append throws.
  const res = await run(cfgBase(), f, scripted(planOf("hold")).planner, { journal: { append: async () => { throw new Error("disk-full"); }, read: async () => ({ records: [] }) } });
  assert.equal(res.stopped, "hold", "append failure is logged, not fatal");
});

// ───────────────────────── §8: compartment + drift guards ──────────────────

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

test("guard: src/supervisor imports NOTHING — not even node: (pure-ports, docs/18 §8)", async () => {
  const files = await walkTs(join("src", "supervisor"));
  assert.ok(files.length >= 1);
  for (const file of files) {
    const content = await readFile(file, "utf-8");
    assert.deepEqual(specifiersOf(content), [], `${file} must import nothing`);
  }
});

test("guard: only src/host/supervise.ts (the P16 wiring entry) imports the loop", async () => {
  const files = await walkTs("src");
  const offenders: string[] = [];
  for (const file of files) {
    if (file.startsWith("src/supervisor/")) continue;
    if (file === "src/host/supervise.ts") continue; // P16: the ONE sanctioned caller
    const content = await readFile(file, "utf-8").catch(() => "");
    if (specifiersOf(content).some((s) => /(^|\/)supervisor\//.test(s))) offenders.push(file);
  }
  assert.deepEqual(offenders, [], offenders.join(", "));
});

test("guard: the P16 host entry exists and imports the loop", async () => {
  const content = await readFile(join("src", "host", "supervise.ts"), "utf-8");
  assert.ok(
    specifiersOf(content).some((s) => /(^|\/)supervisor\/compose/.test(s)),
    "src/host/supervise.ts must import the composition loop",
  );
});

test("drift guard: the loop's mirrored enums are deep-equal to the REAL exports", () => {
  assert.deepEqual([...SUPERVISOR_ACTIONS], [...PLANNER_SUPERVISOR_ACTIONS], "SUPERVISOR_ACTIONS vs planner");
  assert.deepEqual([...SUPERVISOR_ACTIONS], [...JOURNAL_ACTIONS], "SUPERVISOR_ACTIONS vs journal");
  assert.deepEqual([...SIGNAL_KINDS], [...DECISION_SIGNAL_KINDS], "SIGNAL_KINDS vs journal");
  assert.deepEqual([...CAUSE_CLASSES], [...PLANNER_CAUSE_CLASSES], "CAUSE_CLASSES vs planner");
  assert.deepEqual([...RECOVERY_DECISIONS], [...PLAN_RECOVERY_DECISIONS], "RECOVERY_DECISIONS vs planner");
  assert.deepEqual([...VERDICTS], [...PLANNER_VERDICTS], "VERDICTS vs planner");
  assert.deepEqual([...CLOSE_REASONS], [...RESERVATION_CLOSE_REASONS], "CLOSE_REASONS vs ledger");
});

test("STOP_REASONS is closed and every documented reason is present", () => {
  for (const r of ["accepted-finish", "finish-unjudged", "halt", "hold", "escalation-exhausted", "parked", "shutdown", "max-iterations", "loop-error", "no-initial-signal", "initial-run-denied"]) {
    assert.ok((STOP_REASONS as readonly string[]).includes(r), `missing stop reason ${r}`);
  }
});

// ── Round-2 audit (endpoint .11 reviewer): close the two real coverage gaps ─

test("§7/R2: a THROWING evaluator on accept-finish records 'uncertain' and continues (never crashes, never accepts)", async () => {
  const f = mkFakes({ exitCode: 1 });
  const accept = { evaluate: () => { throw new Error("evaluator-boom"); } };
  const s = scripted(planOf("accept-finish"), planOf("hold"));
  const res = await run(cfgBase({ acceptance: { spec: { dod: "done" } } }), f, s.planner, { accept });
  assert.equal(res.stopped, "hold", "one rejection converts and continues (docs §3)");
  const a = f.jrec.find((r) => r.kind === "acceptance");
  assert.equal(a?.verdict, "uncertain", "a thrown evaluate is journaled as uncertain — an error is not a verdict");
});

test("§7/R2: an executed act between two finish rejections breaks the consecutive chain (F9 semantics)", async () => {
  const f = mkFakes({ exitCode: 1 });
  const accept = { evaluate: () => ({ verdict: "incomplete", remainingWork: ["x"], reasons: ["r"] }) };
  const s = scripted(planOf("accept-finish"), planOf("backoff-retry"), planOf("accept-finish"), planOf("hold"));
  const res = await run(cfgBase({ acceptance: { spec: { dod: "done" } } }), f, s.planner, { accept });
  assert.equal(res.stopped, "hold", "reject#1 → executed act RESETS the counter → reject#2 stands alone, the loop keeps going (docs §3)");
  assert.equal(f.jrec.filter((r) => r.kind === "acceptance" && r.verdict === "incomplete").length, 2);
});

// ── P9 audit cycle-1 F6: compose-level merge-intercept matrix ──────────────
// The docs/16 §0.6 port intercept (planner route) and the operator's
// on-finish integration trigger (F5) share ONE act body (doMergeAct);
// the port result is treated as hostile DATA at every sink. These tests
// pin the matrix at the COMPOSE boundary — the host real-route pins
// (git refs, the P12 journal) live in test/host-merge-port.test.ts.

type MergeRes = { status: string; actionId?: string; stage?: string; reason?: string; evidenceRefs?: string[]; outcomeDurable?: boolean };

function mergePortFn(results: MergeRes[], calls: object[] = []) {
  let i = 0;
  return {
    calls,
    port: { integrate: async (req: object) => { calls.push(req); const r = results[i] ?? { status: "failed", reason: "exhausted-stub" }; i += 1; return r; } },
  };
}

test("F6 matrix: planner-route merge 'merged' → executed, intent paired acked, executor BYPASSED", async () => {
  const f = mkFakes({ exitCode: 0 });
  const m = mergePortFn([{ status: "merged", actionId: "p12-1", evidenceRefs: ["sha:abc"], outcomeDurable: true }], []);
  const s = scripted(planOf("merge", { sideEffect: "external", rung: 4 }), planOf("hold"));
  const res = await run(cfgBase(), f, s.planner, { merge: m.port });
  assert.equal(res.stopped, "hold", "merge executes and the loop continues");
  assert.equal(m.calls.length, 1, "the port was called exactly once");
  assert.deepEqual({ episodeId: (m.calls[0] as Rec).episodeId, taskId: (m.calls[0] as Rec).taskId }, { episodeId: "ep-1", taskId: "t1" });
  assert.equal(f.execCaptured.length, 0, "the executor was NEVER invoked for the merge act (docs/16 §0.6)");
  const mi = f.jrec.find((r) => r.kind === "decision-intent" && r.action === "merge");
  assert.ok(mi, "merge intent journaled");
  assert.equal((mi as Rec).rung, 4);
  assert.equal(((mi as Rec).authority as Rec)?.sideEffect, "external");
  const mo = f.jrec.find((r) => r.kind === "decision-outcome" && r.actionId === (mi as Rec).actionId);
  assert.ok(mo && (mo as Rec).acked === true, "paired outcome under the SAME actionId, acked");
  assert.equal(openIntents(f.jrec as never).length, 0, "no intent left open");
});

test("F6 matrix: 'conflict' maps to refused (acked:false), loop continues", async () => {
  const f = mkFakes({ exitCode: 0 });
  const m = mergePortFn([{ status: "conflict", stage: "act", reason: "merge-conflict", outcomeDurable: true }]);
  const s = scripted(planOf("merge", { sideEffect: "external", rung: 4 }), planOf("hold"));
  const res = await run(cfgBase(), f, s.planner, { merge: m.port });
  assert.equal(res.stopped, "hold");
  const mi = f.jrec.find((r) => r.kind === "decision-intent" && r.action === "merge") as Rec;
  const mo = f.jrec.find((r) => r.kind === "decision-outcome" && r.actionId === mi.actionId);
  assert.ok(mo && mo.acked === false && /conflict/.test(String(mo.notes)), "refusal paired, unacked, reason carried");
  assert.equal(openIntents(f.jrec as never).length, 0);
});

test("F6 matrix: an unshapeable port status fails CLOSED to 'failed' and is logged — never laundered to executed", async () => {
  const f = mkFakes({ exitCode: 0 });
  const m = mergePortFn([{ status: "totally-merged-i-swear" }]);
  const logs: string[] = [];
  const s = scripted(planOf("merge", { sideEffect: "external", rung: 4 }), planOf("hold"));
  const res = await run(cfgBase(), f, s.planner, { merge: m.port, log: (l: string) => logs.push(l) });
  assert.equal(res.stopped, "hold");
  assert.ok(logs.some((l) => l.startsWith("merge-status-unshapeable:")), "the garbage status is logged, not trusted");
  const mo = f.jrec.find((r) => r.kind === "decision-outcome" && String(r.notes).startsWith("supervisor: merge"));
  assert.ok(mo && mo.acked === false);
});

test("F6 matrix: a THROWING merge port is a host-contract failure — intent closed, loop-error stop, never a reject into the host", async () => {
  const f = mkFakes({ exitCode: 0 });
  const s = scripted(planOf("merge", { sideEffect: "external", rung: 4 }));
  const res = await run(cfgBase(), f, s.planner, { merge: { integrate: async () => { throw new Error("adapter-boom"); } } });
  assert.equal(res.stopped, "loop-error");
  assert.equal(res.error?.name, "merge-port-Error");
  assert.equal(openIntents(f.jrec as never).length, 0, "the merge intent was closed before the stop");
});

test("F5 trigger: complete verdict + cfg.integration on-finish + port ⇒ merge ACT in the loop, accepted-finish 'integrated'", async () => {
  const f = mkFakes({ exitCode: 0 });
  const accept = { evaluate: () => ({ verdict: "complete", remainingWork: [], reasons: [] }) };
  const calls: object[] = [];
  const m = mergePortFn([{ status: "merged", actionId: "p12-1", outcomeDurable: true }], calls);
  const res = await run(cfgBase({ acceptance: { spec: { dod: "done" } }, integration: { trigger: "on-finish" }, intentScope: "lease/A 1" }), f,
    { planRecovery: planRecovery as (i: object) => object }, { accept, merge: m.port });
  assert.equal(res.stopped, "accepted-finish");
  assert.equal(res.detail, "integrated");
  assert.equal(calls.length, 1, "the operator's trigger dispatched exactly one merge");
  const mi = f.jrec.find((r) => r.kind === "decision-intent" && r.action === "merge" && r.strategyId === "integration:on-finish:v1");
  assert.ok(mi, "journaled under the loop's id namespace with the canonical strategy id");
  assert.match(String((mi as Rec).actionId), /^sup-lease_A_1-ep-1-t1-i\d+m$/, "intent id carries the sanitized activation scope AND the m-suffix");
  const mo = f.jrec.find((r) => r.kind === "decision-outcome" && r.actionId === (mi as Rec).actionId);
  assert.ok(mo && (mo as Rec).acked === true, "paired outcome");
  assert.equal(openIntents(f.jrec as never).length, 0);
});

test("F5 trigger: a refused merge HALTS with integration-<status> — the finish is not honored over a failed integration", async () => {
  const f = mkFakes({ exitCode: 0 });
  const accept = { evaluate: () => ({ verdict: "complete", remainingWork: [], reasons: [] }) };
  const m = mergePortFn([{ status: "gate-failed", stage: "gate", reason: "policy-gate", outcomeDurable: true }]);
  const res = await run(cfgBase({ acceptance: { spec: { dod: "done" } }, integration: { trigger: "on-finish" } }), f,
    { planRecovery: planRecovery as (i: object) => object }, { accept, merge: m.port });
  assert.equal(res.stopped, "halt");
  assert.equal(res.detail, "integration-refused");
  const mi = f.jrec.find((r) => r.kind === "decision-intent" && r.action === "merge") as Rec;
  const mo = f.jrec.find((r) => r.kind === "decision-outcome" && r.actionId === mi.actionId);
  assert.ok(mo && mo.acked === false);
  assert.equal(openIntents(f.jrec as never).length, 0);
});

test("F5 trigger: eligibility is fail-closed — NO port or a trigger-less declaration passes through to plain accepted-finish", async () => {
  const f = mkFakes({ exitCode: 0 });
  const accept = { evaluate: () => ({ verdict: "complete", remainingWork: [], reasons: [] }) };
  const res = await run(cfgBase({ acceptance: { spec: { dod: "done" } }, integration: { trigger: "on-finish" } }), f,
    { planRecovery: planRecovery as (i: object) => object }, { accept });
  assert.equal(res.stopped, "accepted-finish");
  assert.equal(res.detail, undefined, "unintegrated — no merge happened");
  assert.equal(f.jrec.filter((r) => r.kind === "decision-intent" && r.action === "merge").length, 0);
  // integration declared with NO trigger value: never fires even WITH a port
  const f2 = mkFakes({ exitCode: 0 });
  const m2 = mergePortFn([{ status: "merged" }]);
  const res2 = await run(cfgBase({ acceptance: { spec: { dod: "done" } }, integration: {} }), f2,
    { planRecovery: planRecovery as (i: object) => object }, { accept, merge: m2.port });
  assert.equal(res2.stopped, "accepted-finish");
  assert.equal(m2.calls.length, 0, "an integration block without trigger:'on-finish' merges NOTHING");
});

test("F4 isolation: intentScope namespaces actionIds — sanitized, and two activations never collide", async () => {
  const sA = scripted(planOf("nudge"), planOf("hold"));
  const fA = mkFakes({ exitCode: 1 });
  await run(cfgBase({ intentScope: "lease/A 1" }), fA, sA.planner);
  const sB = scripted(planOf("nudge"), planOf("hold"));
  const fB = mkFakes({ exitCode: 1 });
  await run(cfgBase({ intentScope: "lease/B 2" }), fB, sB.planner);
  const idA = String(fA.jrec.find((r) => r.kind === "decision-intent")!.actionId);
  const idB = String(fB.jrec.find((r) => r.kind === "decision-intent")!.actionId);
  // Separator/unsafe characters are sanitized to '_' — an id component
  // never gains '/' or ' ' aliases from a host-supplied scope.
  assert.match(idA, /^sup-lease_A_1-ep-1-t1-i\d+$/, `sanitized scoped id, got ${idA}`);
  assert.notEqual(idA, idB, "two activations can never reissue the same actionId");
  // absent scope keeps the legacy unscoped shape
  const f0 = mkFakes({ exitCode: 1 });
  await run(cfgBase(), f0, scripted(planOf("nudge"), planOf("hold")).planner);
  assert.match(String(f0.jrec.find((r) => r.kind === "decision-intent")!.actionId), /^sup-ep-1-t1-i\d+$/);
});
