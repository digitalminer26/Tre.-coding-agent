/**
 * P15 — Investigation & Recovery Agent tests (docs/17; docs/11 §11 P15 row).
 *
 * Coverage:
 *  - golden rule-table fixtures (docs/17 §3.1): priority order, explicit
 *    vs text-derived confidences, confirmation upgrades, probe-loop flow;
 *  - invariants by name: INV-1 never-throws (Proxy/getter/hostile packets,
 *    throwing ports), INV-2 advice ceiling, INV-3 bounded loop, INV-4
 *    closed merge, INV-5 refs copied never invented, INV-6 determinism,
 *    INV-7 record validity against the REAL validateSupervisorRecord;
 *  - compartment guards (INV-8/INV-9, mirrors the planner pattern):
 *    src/investigation imports NOTHING; nothing outside it imports it yet;
 *    mirrored enums pinned 1:1 against the real modules;
 *  - proposed-action table pins (§6) with the planner's OWN rungs and
 *    strategy ids (drift-pinned).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  investigate,
  CAUSE_CLASSES,
  ACTIONS,
  WORKER_STATES,
  SIGNAL_KINDS,
  STRATEGY,
  RUNG,
  CONFIDENCE_BAR,
  JUDGE_CONFIDENCE_CAP,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MAX_USD,
  type InvestigationPacket,
  type InvestigationPorts,
  type DiagnosisRecordFields,
} from "../src/investigation/agent.js";
import {
  validateSupervisorRecord,
  DECISION_SIGNAL_KINDS,
  SUPERVISOR_ACTIONS,
  DECISION_SCHEMA_ID,
} from "../src/episode/journal.js";
import { WORKER_STATES as TAIL_WORKER_STATES } from "../src/fleet/tail.js";
import {
  PLANNER_CAUSE_CLASSES,
  PLANNER_SUPERVISOR_ACTIONS,
  STRATEGY_TEMPLATES,
  ACTION_RUNG,
} from "../src/planner/plan.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

function clock(t: number = NOW): InvestigationPorts["now"] {
  return () => t;
}

/** Scripted probe port: results keyed by probe id; records every request. */
function scriptedTools(
  results: Record<string, unknown | (() => unknown)>,
  log: { probe: string; episodeId: string }[] = [],
) {
  return {
    log,
    async run(req: { probe: string; episodeId: string; taskId?: string; attemptId?: string }): Promise<unknown> {
      log.push({ probe: req.probe, episodeId: req.episodeId });
      const r = results[req.probe];
      if (typeof r === "function") return (r as () => unknown)();
      return r;
    },
  };
}

const basePacket = (over: Partial<InvestigationPacket> = {}): InvestigationPacket => ({
  id: "act-1#diag",
  episodeId: "ep-1",
  taskId: "task-1",
  attemptId: "att-1",
  ...over,
});

function assertValid(rec: DiagnosisRecordFields): void {
  // The journal's own validator (throws on violation) — INV-7.
  validateSupervisorRecord(rec as never);
}

// ───────────────────────── golden rule table (docs/17 §3.1/§6) ─────────────

test("gf-approval-explicit: facts.approvalPending => approval-boundary 0.95, escalate", async () => {
  const rec = await investigate(basePacket({ facts: { approvalPending: true }, evidenceRefs: ["approval:ask-9"] }), { now: clock() });
  assert.equal(rec.causeClass, "approval-boundary");
  assert.equal(rec.confidence, 0.95);
  assert.ok(rec.evidenceRefs.includes("rule:approval-pending:explicit"));
  assert.ok(rec.evidenceRefs.includes("approval:ask-9"));
  assert.deepEqual(rec.proposedActions, [{ rung: 5, action: "escalate", strategyId: "escalate:v1" }]);
  assert.deepEqual(rec.limitsRespected, { toolsUsed: 0, spendUsd: 0 });
  assertValid(rec);
});

test("gf-approval-signal: signal worker-blocked-on-approval => 0.6 tentative (escalate still, sub-bar table)", async () => {
  const rec = await investigate(basePacket({ signal: { kind: "worker-blocked-on-approval" } }), { now: clock() });
  assert.equal(rec.causeClass, "approval-boundary");
  assert.equal(rec.confidence, 0.6);
  assert.ok(rec.evidenceRefs.includes("rule:approval-pending:signal"));
  // Sub-bar approval-boundary: the §6 table has one row — escalate is a
  // rung-5 action but the planner re-gates on confidence (docs/14 §2).
  assert.deepEqual(rec.proposedActions, [{ rung: 5, action: "escalate", strategyId: "escalate:v1" }]);
});

test("gf-env-explicit: diskFull 0.95 / permissionDenied 0.9 / missingBinary 0.85 priority + escalate (>=bar)", async () => {
  for (const [facts, conf] of [
    [{ diskFull: true }, 0.95],
    [{ permissionDenied: true }, 0.9],
    [{ missingBinary: true }, 0.85],
  ] as const) {
    const rec = await investigate(basePacket({ facts }), { now: clock() });
    assert.equal(rec.causeClass, "environment-blocker");
    assert.equal(rec.confidence, conf);
    assert.deepEqual(rec.proposedActions, [{ rung: 5, action: "escalate", strategyId: "escalate:v1" }]);
    assert.equal(rec.limitsRespected.toolsUsed, 0); // at/above bar: no probes
    assertValid(rec);
  }
});

test("gf-env-text-derived: 'no space left on device' => tentative 0.6, investigate (below bar)", async () => {
  const rec = await investigate(basePacket({ errors: [{ source: "bash", text: "write: no space left on device" }] }), { now: clock() });
  assert.equal(rec.causeClass, "environment-blocker");
  assert.equal(rec.confidence, 0.6);
  assert.ok(rec.evidenceRefs.includes("rule:environment-blocker:text-derived"));
  assert.ok(rec.evidenceRefs.includes("text:diskFull"));
  assert.deepEqual(rec.proposedActions, [{ rung: 2, action: "investigate", strategyId: "investigate:bounded:v1" }]);
});

test("gf-endpoint-explicit: rateLimited => transient 0.9 backoff-retry, no probes", async () => {
  const rec = await investigate(basePacket({ facts: { rateLimited: true } }), { now: clock() });
  assert.equal(rec.causeClass, "transient-endpoint");
  assert.equal(rec.confidence, 0.9);
  assert.ok(rec.evidenceRefs.includes("rule:endpoint-failure:rate-limited"));
  assert.deepEqual(rec.proposedActions, [{ rung: 2, action: "backoff-retry", strategyId: "retry:transient:v1" }]);
});

test("gf-endpoint-signal: signal endpoint-error => tentative 0.6", async () => {
  const rec = await investigate(basePacket({ signal: { kind: "endpoint-error" } }), { now: clock() });
  assert.equal(rec.causeClass, "transient-endpoint");
  assert.equal(rec.confidence, 0.6);
  assert.ok(rec.evidenceRefs.includes("rule:endpoint-failure:signal"));
});

test("gf-endpoint-runEnd: runEndReason transport-error => tentative 0.6", async () => {
  const rec = await investigate(basePacket({ runEndReason: "transport-error" }), { now: clock() });
  assert.equal(rec.causeClass, "transient-endpoint");
  assert.equal(rec.confidence, 0.6);
});

test("gf-gate-failed: explicit gatePass=false => task-defect 0.85, repair worktree-local", async () => {
  const rec = await investigate(basePacket({ facts: { gatePass: false } }), { now: clock() });
  assert.equal(rec.causeClass, "task-defect");
  assert.equal(rec.confidence, 0.85);
  assert.ok(rec.evidenceRefs.includes("rule:gate-failed"));
  assert.deepEqual(rec.proposedActions, [{ rung: 2, action: "repair", strategyId: "repair:task-local:v1", authorityNeeded: "worktree-local" }]);
});

test("gf-premature: stopped worker + incomplete => 0.65; verdict-less => 0.55; actions [resume, investigate]", async () => {
  const a = await investigate(basePacket({ workerState: "stopped", acceptance: { verdict: "incomplete" } }), { now: clock() });
  assert.equal(a.causeClass, "premature-stop");
  assert.equal(a.confidence, 0.65);
  const b = await investigate(basePacket({ workerState: "dead" }), { now: clock() });
  assert.equal(b.confidence, 0.55);
  assert.deepEqual(b.proposedActions, [
    { rung: 2, action: "evidence-nudge-resume", strategyId: "resume:evidence:v1" },
    { rung: 2, action: "investigate", strategyId: "investigate:bounded:v1" },
  ]);
  // guardFires >= 2 is an equivalent trigger
  const c = await investigate(basePacket({ guardFires: 2 }), { now: clock() });
  assert.equal(c.causeClass, "premature-stop");
});

test("gf-no-evidence: empty packet => unknown 0.3 + exhaustion marker (no ports => no probes)", async () => {
  const rec = await investigate(basePacket({ id: undefined as unknown as string, episodeId: undefined as unknown as string }), { now: clock() });
  assert.equal(rec.causeClass, "unknown");
  assert.equal(rec.confidence, 0.3);
  assert.ok(rec.evidenceRefs.includes("investigation:exhausted"));
  assert.deepEqual(rec.proposedActions, [{ rung: 2, action: "investigate", strategyId: "investigate:bounded:v1" }]);
  // envelope fallbacks still validate (INV-7)
  assert.equal(rec.id, "d-investigation");
  assert.equal(rec.episodeId, "episode-unknown");
  assertValid(rec);
});

test("gf-priority: approval > env > endpoint > gate > premature (env text beats endpoint text)", async () => {
  const rec = await investigate(basePacket({
    errors: [{ source: "bash", text: "HTTP 429 too many requests" }, { source: "bash", text: "command not found: tsc" }],
  }), { now: clock() });
  assert.equal(rec.causeClass, "environment-blocker");
  assert.ok(rec.evidenceRefs.includes("text:missingBinary"));
  assert.ok(rec.evidenceRefs.includes("text:rateLimited"));
});

// ───────────────────────── probe loop (docs/17 §5) ─────────────────────────

test("probe-confirmation: text-derived transient + probe-endpoint(endpointReachable) => 0.95, ONE probe", async () => {
  const log: { probe: string; episodeId: string }[] = [];
  const tools = scriptedTools({ "probe-endpoint": { facts: { endpointReachable: true }, evidenceRef: "probe:ep:alive", usd: 0.02 } }, log);
  const rec = await investigate(basePacket({ errors: [{ source: "fetch", text: "HTTP 429 from upstream" }] }), { now: clock(), tools });
  assert.equal(rec.causeClass, "transient-endpoint");
  assert.equal(rec.confidence, 0.95);
  assert.deepEqual(log.map((l) => l.probe), ["probe-endpoint"]); // class-first, then the bar stops the loop
  assert.ok(rec.evidenceRefs.includes("probe:ep:alive"));
  assert.deepEqual(rec.limitsRespected, { toolsUsed: 1, spendUsd: 0.02 });
  assertValid(rec);
});

test("probe-confirmation: premature-stop + probe-worker-tail(workerClaimedComplete) => 0.8", async () => {
  const log: { probe: string; episodeId: string }[] = [];
  const tools = scriptedTools({ "probe-worker-tail": { facts: { workerClaimedComplete: true } } }, log);
  const rec = await investigate(basePacket({ workerState: "stopped", acceptance: { verdict: "incomplete" } }), { now: clock(), tools });
  assert.equal(rec.causeClass, "premature-stop");
  assert.equal(rec.confidence, 0.8);
  assert.deepEqual(log.map((l) => l.probe), ["probe-worker-tail"]); // class-first
});

test("probe-confirmation: text env + probe-env(diskFull explicit) => explicit rule 0.95", async () => {
  const tools = scriptedTools({ "probe-env": { facts: { diskFull: true } } });
  const rec = await investigate(basePacket({ errors: [{ source: "bash", text: "no space left on device" }] }), { now: clock(), tools });
  assert.equal(rec.causeClass, "environment-blocker");
  assert.equal(rec.confidence, 0.95);
  assert.ok(rec.evidenceRefs.includes("rule:environment-blocker:disk-full"));
});

test("probe-exhaustion: unknown + empty probe results => all four probes run once, exhaustion marker", async () => {
  const log: { probe: string; episodeId: string }[] = [];
  const tools = scriptedTools({}, log); // undefined result -> not an object -> failed
  const rec = await investigate(basePacket(), { now: clock(), tools });
  assert.deepEqual(log.map((l) => l.probe).sort(), ["probe-endpoint", "probe-env", "probe-gate-rerun", "probe-worker-tail"]);
  assert.equal(rec.causeClass, "unknown");
  assert.ok(rec.evidenceRefs.includes("investigation:exhausted"));
  assert.equal(rec.limitsRespected.toolsUsed, 4);
  // 0.02 + 0.02 + 0.10 + 0.01
  assert.equal(rec.limitsRespected.spendUsd, 0.15);
  assertValid(rec);
});

test("probe-throw is a failed probe, never a failed investigation (INV-1 half)", async () => {
  const tools = { async run(): Promise<unknown> { throw new Error("tool exploded"); } };
  const rec = await investigate(basePacket({ workerState: "stopped" }), { now: clock(), tools });
  assert.ok(rec.evidenceRefs.some((r) => r.startsWith("probe:") && r.endsWith(":failed")));
  assertValid(rec);
});

// ───────────────────────── INV-3 bounded ────────────────────────────────────

test("INV-3: zero limits => ZERO port calls, skipped-budget markers", async () => {
  const log: { probe: string; episodeId: string }[] = [];
  const tools = scriptedTools({}, log);
  const rec = await investigate(basePacket(), { now: clock(), tools }, { limits: { maxToolCalls: 0, maxUsd: 0 } });
  assert.deepEqual(log, []);
  assert.deepEqual(rec.limitsRespected, { toolsUsed: 0, spendUsd: 0 });
  assert.ok(rec.evidenceRefs.some((r) => r.endsWith(":skipped-budget")));
});

test("INV-3: maxUsd=0.03 => endpoint + worker-tail run, env & gate-rerun skipped without counting", async () => {
  const log: { probe: string; episodeId: string }[] = [];
  const tools = scriptedTools({}, log);
  const rec = await investigate(basePacket(), { now: clock(), tools }, { limits: { maxUsd: 0.03 } });
  assert.deepEqual(log.map((l) => l.probe), ["probe-endpoint", "probe-worker-tail"]);
  assert.deepEqual(rec.limitsRespected, { toolsUsed: 2, spendUsd: 0.03 });
  assert.ok(rec.evidenceRefs.includes("probe:probe-env:skipped-budget"));
  assert.ok(rec.evidenceRefs.includes("probe:probe-gate-rerun:skipped-budget"));
});

test("INV-3: maxToolCalls=1 => exactly one probe, even when the loop wants more", async () => {
  const log: { probe: string; episodeId: string }[] = [];
  const tools = scriptedTools({}, log);
  const rec = await investigate(basePacket(), { now: clock(), tools }, { limits: { maxToolCalls: 1 } });
  assert.equal(log.length, 1);
  assert.equal(rec.limitsRespected.toolsUsed, 1);
});

test("INV-3: each probe AT MOST ONCE across the whole loop", async () => {
  const seen: string[] = [];
  const tools = {
    async run(req: { probe: string }): Promise<unknown> {
      assert.ok(!seen.includes(req.probe), `probe ${req.probe} ran twice`);
      seen.push(req.probe);
      return { facts: {} };
    },
  };
  await investigate(basePacket({ signal: { kind: "endpoint-error" } }), { now: clock(), tools });
  // every id unique
  assert.equal(new Set(seen).size, seen.length);
});

test("INV-3: a reported probe usd BELOW its estimate cannot refund it (cycle-A5 F2: max(reported, estimate))", async () => {
  const tools = scriptedTools({ "probe-endpoint": { facts: { endpointReachable: true }, usd: 0.005 } });
  const rec = await investigate(basePacket({ errors: [{ source: "fetch", text: "429" }] }), { now: clock(), tools });
  // 0.005 < the 0.02 estimate: the estimate stands (a report may only ADD)
  assert.equal(rec.limitsRespected.spendUsd, 0.02);
});

test("INV-3/F2: a 0-usd report cannot refund the charge and re-open the budget", async () => {
  const log: { probe: string; episodeId: string }[] = [];
  const tools = scriptedTools({
    "probe-worker-tail": { facts: {}, usd: 0 },
    "probe-endpoint": { facts: { endpointReachable: true }, usd: 0 },
    "probe-env": { facts: {}, usd: 0 },
    "probe-gate-rerun": { facts: {}, usd: 0 },
  }, log);
  // budget 0.04: endpoint(0.02)+env(0.02) fit; gate-rerun(0.10) never starts
  const rec = await investigate(basePacket({ workerState: "stopped" }), { now: clock(), tools }, { limits: { maxUsd: 0.04 } });
  assert.ok(!log.some((l) => l.probe === "probe-gate-rerun"), "the 0.10 probe cannot hide behind 0-reports");
  assert.ok(rec.limitsRespected.spendUsd >= 0.02, "spend reflects estimates, not refunds");
});

test("F4: an over-reported probe usd stands in full (recorded honestly, finite)", async () => {
  const tools = scriptedTools({ "probe-endpoint": { facts: { endpointReachable: true }, usd: 1e12 } });
  const rec = await investigate(basePacket({ errors: [{ source: "fetch", text: "429" }] }), { now: clock(), tools });
  assert.equal(rec.limitsRespected.spendUsd, 1e12);
});

test("INV-3: hostile limits (negative/NaN/Infinity) fall back to defaults, never below the floor", async () => {
  const log: { probe: string; episodeId: string }[] = [];
  const tools = scriptedTools({}, log);
  const rec = await investigate(basePacket(), { now: clock(), tools }, { limits: { maxToolCalls: -5, maxUsd: Number.NaN } as never });
  // -5 clamps to 0 => no calls; NaN maxUsd => default 0.5
  assert.equal(log.length, 0);
  assert.ok(rec.evidenceRefs.some((r) => r.endsWith(":skipped-budget")));
  assertValid(rec);
});

// ───────────────────────── INV-2 advice ceiling ─────────────────────────────

test("INV-2: judge fills ONLY unknown; a reported confidence of 1 is clamped to 0.69", async () => {
  let judgeCalls = 0;
  const judge = {
    async judge(): Promise<unknown> {
      judgeCalls++;
      return { causeClass: "task-defect", confidence: 1 };
    },
  };
  const rec = await investigate(basePacket(), { now: clock(), judge });
  assert.equal(judgeCalls, 1);
  assert.equal(rec.causeClass, "task-defect");
  assert.equal(rec.confidence, 0.69);
  assert.ok(rec.evidenceRefs.includes("judge:advisory"));
  assert.ok(JUDGE_CONFIDENCE_CAP < CONFIDENCE_BAR);
  assertValid(rec);
});

test("INV-2: a deterministic class is NEVER overwritten by the judge (judge not even consulted)", async () => {
  let called = false;
  const judge = { async judge(): Promise<unknown> { called = true; return { causeClass: "unknown", confidence: 0.5 }; } };
  const rec = await investigate(basePacket({ facts: { diskFull: true } }), { now: clock(), judge });
  assert.equal(called, false);
  assert.equal(rec.causeClass, "environment-blocker");
});

test("INV-2: hostile judge (bad class / throw / non-object) leaves the record honest", async () => {
  const badClass = { async judge(): Promise<unknown> { return { causeClass: "merge-everything", confidence: 0.99 }; } };
  const r1 = await investigate(basePacket(), { now: clock(), judge: badClass });
  assert.equal(r1.causeClass, "unknown");
  assert.ok(!r1.evidenceRefs.includes("judge:advisory"));

  const thrower = { async judge(): Promise<never> { throw new Error("judge down"); } };
  const r2 = await investigate(basePacket(), { now: clock(), judge: thrower });
  assert.equal(r2.causeClass, "unknown");
  assertValid(r2);

  const nan = { async judge(): Promise<unknown> { return { causeClass: "unknown", confidence: Number.NaN }; } };
  const r3 = await investigate(basePacket(), { now: clock(), judge: nan });
  assert.equal(r3.causeClass, "unknown");
  assert.equal(r3.confidence, 0); // missing/NaN confidence reads as pure uncertainty (docs/17 §4)
});

// ───────────────────────── INV-4 closed merge ───────────────────────────────

test("INV-4: a probe result cannot inject causeClass, actions, or non-boolean facts", async () => {
  const tools = scriptedTools({
    "probe-endpoint": {
      causeClass: "task-defect",
      proposedActions: [{ rung: 5, action: "escalate" }],
      facts: { gatePass: "yes please", escalate: true, command: "rm -rf /", diskFull: true },
      evidenceRef: 42,
    },
  });
  const rec = await investigate(basePacket(), { now: clock(), tools });
  assert.equal(rec.causeClass, "environment-blocker"); // ONLY the boolean diskFull merged
  assert.equal(rec.confidence, 0.95);
  assert.ok(!rec.evidenceRefs.includes(42 as never));
  // and nothing in the record resembles an injected ref or action
  assert.ok(rec.evidenceRefs.every((r) => typeof r === "string"));
  assertValid(rec);
});

test("INV-4: packet facts merge ONLY closed keys at boolean type", async () => {
  const packet = basePacket({ facts: { diskFull: true, approvalPending: "true", causeClass: "task-defect" } as never });
  const rec = await investigate(packet, { now: clock() });
  assert.equal(rec.causeClass, "environment-blocker");
  assert.equal(rec.confidence, 0.95);
});

// ───────────────────────── INV-5 refs copied, never invented ────────────────

test("INV-5: packet refs are copied verbatim (non-strings dropped); markers trace to observations", async () => {
  const rec = await investigate(basePacket({
    evidenceRefs: ["sig:guard-7", 11, "tail:att-1#L20-31", { evil: true }] as never,
    errors: [{ source: "fetch", text: "HTTP 503 service unavailable" }],
  }), { now: clock() });
  assert.ok(rec.evidenceRefs.includes("sig:guard-7"));
  assert.ok(rec.evidenceRefs.includes("tail:att-1#L20-31"));
  // every entry is a string the packet held or a module marker
  for (const r of rec.evidenceRefs) {
    assert.equal(typeof r, "string");
    const known = ["rule:", "text:", "probe:", "judge:", "investigation:", "bad-input:", "refs:", "packet:"].some((p) => r.startsWith(p));
    assert.ok(known || r === "sig:guard-7" || r === "tail:att-1#L20-31", `unexplained ref: ${r}`);
  }
});

test("INV-5: a probe evidenceRef is copied; a missing one yields probe:<id>:ran", async () => {
  const tools = scriptedTools({ "probe-endpoint": { facts: {}, evidenceRef: "probe:ep:log-9" } });
  const rec = await investigate(basePacket({ signal: { kind: "endpoint-error" } }), { now: clock(), tools });
  assert.ok(rec.evidenceRefs.includes("probe:ep:log-9"));
  assert.ok(!rec.evidenceRefs.includes("probe:probe-endpoint:ran"));
});

// ───────────────────────── INV-6 determinism ────────────────────────────────

test("INV-6: same packet + scripted ports => deep-equal records except ts", async () => {
  const script: Record<string, unknown> = {
    "probe-endpoint": { facts: { endpointReachable: false }, usd: 0.02 },
    "probe-env": { facts: { missingBinary: true } },
    "probe-worker-tail": { facts: { workerClaimedComplete: true } },
  };
  const a = await investigate(basePacket({ signal: { kind: "endpoint-error" }, evidenceRefs: ["x:1"] }),
    { now: () => 111, tools: scriptedTools(structuredClone(script)) });
  const b = await investigate(basePacket({ signal: { kind: "endpoint-error" }, evidenceRefs: ["x:1"] }),
    { now: () => 999, tools: scriptedTools(structuredClone(script)) });
  assert.notEqual(a.ts, b.ts);
  assert.deepEqual({ ...a, ts: 0 }, { ...b, ts: 0 });
});

test("INV-6: no Date() — a hostile clock (throws / NaN) fails closed to ts 0", async () => {
  const rec = await investigate(basePacket(), { now: () => { throw new Error("no clock"); } });
  assert.equal(rec.ts, 0);
  const rec2 = await investigate(basePacket(), { now: () => Number.NaN });
  assert.equal(rec2.ts, 0);
  assertValid(rec);
  assertValid(rec2);
});

// ───────────────────────── INV-1 never-throws (hostile everything) ──────────

test("INV-1: Proxy packet whose traps all throw still yields a valid record", async () => {
  const hostile = new Proxy({}, {
    get() { throw new Error("trap"); },
    getOwnPropertyDescriptor() { throw new Error("trap"); },
    has() { throw new Error("trap"); },
    ownKeys() { throw new Error("trap"); },
  });
  const rec = await investigate(hostile as unknown as InvestigationPacket, { now: clock() });
  assert.equal(rec.causeClass, "unknown");
  assertValid(rec);
});

test("INV-1: accessor properties are NEVER invoked; inherited properties are never read", async () => {
  let getterFired = false;
  const p: Record<string, unknown> = { id: "act-x", episodeId: "ep-x" };
  Object.defineProperty(p, "facts", { get() { getterFired = true; return { diskFull: true }; }, enumerable: true });
  const rec = await investigate(p as unknown as InvestigationPacket, { now: clock() });
  assert.equal(getterFired, false);
  assert.equal(rec.causeClass, "unknown");
  // inherited facts (prototype pollution style) are not read either
  const proto = { facts: { approvalPending: true } };
  const child = Object.create(proto) as Record<string, unknown>;
  child.id = "act-y"; child.episodeId = "ep-y";
  const rec2 = await investigate(child as unknown as InvestigationPacket, { now: clock() });
  assert.equal(rec2.causeClass, "unknown");
  // Object.prototype pollution mid-run is still invisible (own-data only)
  const saved = Object.getOwnPropertyDescriptor(Object.prototype, "approvalPending");
  Object.defineProperty(Object.prototype, "approvalPending", { value: true, configurable: true, writable: true });
  try {
    const rec3 = await investigate(basePacket({ facts: {} }), { now: clock() });
    assert.equal(rec3.causeClass, "unknown");
  } finally {
    if (saved) Object.defineProperty(Object.prototype, "approvalPending", saved);
    else delete (Object.prototype as { approvalPending?: unknown }).approvalPending;
  }
});

test("INV-1: garbage packets (null, arrays, strings, numbers, arrays-as-objects) => valid unknown record", async () => {
  for (const g of [null, undefined, 42, "packet", [], [1, 2, 3], new Date(), Symbol("s")]) {
    const rec = await investigate(g as unknown as InvestigationPacket, { now: clock() });
    assertValid(rec);
    assert.equal(rec.causeClass, "unknown");
  }
});

test("INV-1: hostile errors array (getter indices, lying length via Proxy, non-plain entries)", async () => {
  const errs: unknown[] = [];
  Object.defineProperty(errs, "0", { get() { throw new Error("idx trap"); }, enumerable: true });
  const p1 = basePacket({ errors: errs as never });
  assertValid(await investigate(p1, { now: clock() }));

  // A Proxy whose length lies (claims 500, yields nothing) — the copy
  // re-verifies length after reading and drops the whole array (P10 C5-F2).
  const liar = new Proxy([1, 2], {
    get(t, k) { if (k === "length") return 500; return Reflect.get(t, k); },
    getOwnPropertyDescriptor(t, k) {
      if (k === "length") return { value: 500, configurable: true };
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
  });
  const rL = await investigate(basePacket({ errors: liar as never, evidenceRefs: liar as never }), { now: clock() });
  assertValid(rL);
  assert.equal(rL.causeClass, "unknown");

  const sparse = new Array(1_000_000).fill({ source: "x", text: "no space left on device" });
  const r2 = await investigate(basePacket({ errors: sparse }), { now: clock() });
  assert.equal(r2.causeClass, "environment-blocker"); // bounded scan: first MAX_ERRS only

  const fns = [() => "no space left on device", "not-an-object"] as never;
  const r3 = await investigate(basePacket({ errors: fns }), { now: clock() });
  assert.equal(r3.causeClass, "unknown"); // non-plain entries dropped
});

test("INV-1: port returning hostile results (primitives, promise-rejection, frozen traps)", async () => {
  for (const r of ["rm -rf /", 7, null, true, new Map(), Promise.reject(new Error("x"))]) {
    const tools = { run: async () => r };
    const rec = await investigate(basePacket({ workerState: "stopped" }), { now: clock(), tools });
    assertValid(rec);
  }
});

// ───────────────────────── staleness marker ─────────────────────────────────

test("stale envelope flag => packet:stale marker, classification unchanged", async () => {
  const plain = await investigate(basePacket({ workerState: "stopped" }), { now: clock() });
  const stale = await investigate(basePacket({ workerState: "stopped", stale: true }), { now: clock() });
  assert.ok(stale.evidenceRefs.includes("packet:stale"));
  assert.ok(!plain.evidenceRefs.includes("packet:stale"));
  assert.equal(stale.causeClass, plain.causeClass);
});

// ───────────────────────── text-derivation table ────────────────────────────

test("text table: direct endpoint markers derive without context; generic words need endpoint context (docs/17 §3.3)", async () => {
  const direct = await investigate(basePacket({ errors: [{ source: "fetch", text: "connect ECONNREFUSED 127.0.0.1:8080" }] }), { now: clock() });
  assert.equal(direct.causeClass, "transient-endpoint");
  assert.ok(direct.evidenceRefs.includes("text:endpointUnreachable"));

  const generic = await investigate(basePacket({ errors: [{ source: "bash", text: "test timed out after 30000ms" }] }), { now: clock() });
  assert.ok(!generic.evidenceRefs.includes("text:endpointUnreachable"));

  const withCtx = await investigate(basePacket({
    signal: { kind: "endpoint-error" } as never,
    // explicit signal alone already classifies; the derivation must ALSO fire here
    signalDetail: "request timed out",
  }), { now: clock() });
  assert.ok(withCtx.evidenceRefs.includes("text:endpointUnreachable"));
});

// ──────────────── audit cycle-A4 fixes (fence traps, budgets, refs) ─────────

test("A4-R1: revoked-proxy packet (getPrototypeOf trap) => valid record + bad-input:packet", async () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke(); // revoke BEFORE the call: typeof on a revoked proxy throws
  const rec = await investigate(proxy as never, { now: clock() });
  assertValid(rec);
  assert.equal(rec.causeClass, "unknown");
  assert.ok(rec.evidenceRefs.includes("bad-input:packet"));
});

test("A4-R1: isPlainObj survives a getPrototypeOf trap that throws", async () => {
  const trap = new Proxy({}, {
    getPrototypeOf() { throw new Error("proto trap"); },
  });
  // facts/signal/errors all route through isPlainObj — a throwing
  // getPrototypeOf trap reads as "not a plain object", never a throw.
  const rec = await investigate(basePacket({
    facts: trap as never, signal: trap as never, acceptance: trap as never,
    errors: [trap] as never,
  }), { now: clock() });
  assertValid(rec);
});

test("A4-R1: tools:null and a throwing `run` getter never crash the loop", async () => {
  // `tools: null` used to pass the old `!== undefined` guard and crash on `.run`.
  const rec1 = await investigate(basePacket({ workerState: "stopped" }), { now: clock(), tools: null as never });
  assertValid(rec1);
  const throwing = { get run(): never { throw new Error("run trap"); } };
  const rec2 = await investigate(basePacket({ workerState: "stopped" }), { now: clock(), tools: throwing });
  assertValid(rec2);
  // getter is resolved ONCE — a getter that counts would be hit once, but
  // a throwing one must be swallowed with zero probes attempted.
  let hits = 0;
  const counting = { get run(): never { hits += 1; throw new Error("x"); } };
  await investigate(basePacket({ workerState: "stopped" }), { now: clock(), tools: counting });
  assert.equal(hits, 1, "the run getter is resolved exactly once, never re-invoked per probe");
});

test("A4-R1: options/limits handles with throwing getters fall back to defaults", async () => {
  const opts = { get limits(): never { throw new Error("limits trap"); } };
  const log: { probe: string; episodeId: string }[] = [];
  const rec = await investigate(basePacket(), { now: clock(), tools: scriptedTools({}, log) }, opts as never);
  assertValid(rec);
  // hostile-but-present limits handle is disclosed, defaults still applied
  assert.ok(rec.evidenceRefs.includes("bad-input:limits"));
  assert.equal(log.length > 0, true, "default budget still allows probes");
});

test("A4-R2: fractional maxToolCalls FLOORS — 2.5 admits TWO probes, never three", async () => {
  const log: { probe: string; episodeId: string }[] = [];
  const tools = scriptedTools({}, log);
  const rec = await investigate(basePacket(), { now: clock(), tools }, { limits: { maxToolCalls: 2.5 } as never });
  assert.equal(log.length, 2);
  assert.equal(rec.limitsRespected.toolsUsed, 2);
});

test("A4-R3: a negative reported probe usd is REJECTED (estimate stands; never a refund below 0)", async () => {
  const tools = scriptedTools({ "probe-endpoint": { facts: { endpointReachable: true }, usd: -5 } });
  const rec = await investigate(basePacket({ errors: [{ source: "fetch", text: "429 rate limited" }] }), { now: clock(), tools });
  // probe-endpoint estimate 0.02 stands — no refund, no negative spend
  assert.equal(rec.limitsRespected.spendUsd, 0.02);
  assert.ok(rec.limitsRespected.spendUsd >= 0);
});

test("A4-R4: marker-reserving truncation — overflowing packet refs evict OTHER REFS, never markers; refs:truncated disclosed", async () => {
  const flood = Array.from({ length: 200 }, (_, i) => `pkt:ref-${i}`);
  const rec = await investigate(basePacket({
    facts: { approvalPending: true }, // rule marker + escalate
    evidenceRefs: flood,
  }), { now: clock() });
  assert.ok(rec.evidenceRefs.length <= 64);
  assert.ok(rec.evidenceRefs.includes("rule:approval-pending:explicit"), "rule marker survives a 200-ref flood");
  assert.ok(rec.evidenceRefs.includes("refs:truncated"), "overflow is disclosed");
  // markers come first: everything before the packet refs is module-owned
  assert.equal(rec.evidenceRefs[0], "rule:approval-pending:explicit");
  const firstPkt = rec.evidenceRefs.findIndex((r) => r.startsWith("pkt:"));
  assert.ok(rec.evidenceRefs.slice(0, firstPkt).every((r) => !r.startsWith("pkt:")));
});

test("A4-R4: judge:advisory is reserved against a ref flood too", async () => {
  const flood = Array.from({ length: 200 }, (_, i) => `pkt:x-${i}`);
  const judge = { async judge(): Promise<unknown> { return { causeClass: "premature-stop", confidence: 0.5 }; } };
  const rec = await investigate(basePacket({ workerState: "running", evidenceRefs: flood }), { now: clock(), judge });
  assert.ok(rec.evidenceRefs.includes("judge:advisory"));
  assert.ok(rec.evidenceRefs.includes("refs:truncated"));
});

test("A4-R4: exactly-filling packet refs still disclose refs:truncated (no crowding out)", async () => {
  // 64 refs, no markers besides rule/refs: unknown packet yields
  // investigation:exhausted marker (1) + 64 packet refs => 63 packet kept.
  const flood = Array.from({ length: 64 }, (_, i) => `pkt:y-${i}`);
  const rec = await investigate(basePacket({ evidenceRefs: flood }), { now: clock() });
  assert.ok(rec.evidenceRefs.includes("refs:truncated"));
  assert.ok(rec.evidenceRefs.includes("investigation:exhausted"));
  assert.equal(rec.evidenceRefs.length, 64);
});

// ───────────────────────── Cycle-A5 adversarial fixes ───────────────────────

test("A5-F1: a method-style `now` (uses `this`) keeps its receiver — no silent ts=0", async () => {
  const ports = {
    t: 1_700_000_099_000,
    now(this: { t: number }): number { return this.t; },
  };
  const rec = await investigate(basePacket(), ports as unknown as InvestigationPorts);
  assert.equal(rec.ts, 1_700_000_099_000);
});

test("A5-F1: a throwing method-style `now` still fails closed to 0 (INV-1)", async () => {
  const ports = {
    now(): number { throw new Error("clock trap"); },
  };
  const rec = await investigate(basePacket(), ports as unknown as InvestigationPorts);
  assert.equal(rec.ts, 0);
  assertValid(rec);
});

test("A5-F3: packet refs with module-reserved prefixes are dropped and disclosed refs:spoofed", async () => {
  const rec = await investigate(
    basePacket({ evidenceRefs: ["judge:advisory", "probe:probe-env:ran", "rule:gate-failed", "pkt:ok-1"] }),
    { now: clock() },
  );
  // nothing consulted or ran — the forged markers must NOT appear
  assert.ok(!rec.evidenceRefs.includes("judge:advisory"), "no judge ran; cannot appear");
  assert.ok(!rec.evidenceRefs.includes("probe:probe-env:ran"));
  assert.ok(!rec.evidenceRefs.includes("rule:gate-failed"));
  assert.ok(rec.evidenceRefs.includes("refs:spoofed"), "the forgery attempt is disclosed");
  assert.ok(rec.evidenceRefs.includes("pkt:ok-1"), "benign refs pass through");
  assertValid(rec);
});

test("A5-F3: reserved-prefix spoofing cannot displace the exhaustion marker under a flood", async () => {
  const flood = Array.from({ length: 200 }, (_, i) => (i % 2 ? `pkt:z-${i}` : `bad-input:packet-${i}`));
  const rec = await investigate(basePacket({ evidenceRefs: flood }), { now: clock() });
  assert.ok(rec.evidenceRefs.includes("investigation:exhausted"));
  assert.ok(rec.evidenceRefs.includes("refs:spoofed"));
  assert.ok(!rec.evidenceRefs.some((r) => r.startsWith("bad-input:packet-")), "forged bad-input refs dropped");
});

test("A5-F3: when spoofing AND truncation are both due, neither disclosure is lost", async () => {
  // 64 refs (the copyStrs window, no ingestion overflow): 1 forged +
  // 63 unique pkt refs. After the exhausted marker, capacity forces
  // both disclosures — spoofing reserves the truncated slot so neither
  // disappears un-disclosed.
  const refs = ["judge:advisory", ...Array.from({ length: 63 }, (_, i) => `pkt:w-${i}`)];
  const rec = await investigate(basePacket({ evidenceRefs: refs }), { now: clock() });
  assert.ok(rec.evidenceRefs.includes("refs:spoofed"));
  assert.ok(rec.evidenceRefs.includes("refs:truncated"), "the evicted pkt ref is disclosed");
  assert.ok(rec.evidenceRefs.includes("investigation:exhausted"));
  assert.ok(!rec.evidenceRefs.includes("judge:advisory"));
});

test("A5-F5: duplicate packet refs that all fit do NOT cry refs:truncated", async () => {
  const refs = Array.from({ length: 60 }, (_, i) => `pkt:d-${i % 10}`); // 60 slots (inside the 64 window), 10 unique
  const rec = await investigate(basePacket({ facts: { approvalPending: true }, evidenceRefs: refs }), { now: clock() });
  assert.ok(!rec.evidenceRefs.includes("refs:truncated"), "10 unique refs fit — no truncation");
  assert.ok(!rec.evidenceRefs.includes("refs:spoofed"), "duplicates are not spoofing");
  const pkt = rec.evidenceRefs.filter((r) => r.startsWith("pkt:"));
  assert.equal(pkt.length, 10);
  assert.equal(new Set(pkt).size, 10);
});

test("A5-F6: explicit `undefined` limit VALUES are absent fields, not bad input", async () => {
  const rec = await investigate(basePacket(), { now: clock() }, { limits: { maxToolCalls: undefined, maxUsd: undefined } as never });
  assert.ok(!rec.evidenceRefs.includes("bad-input:limits"), "undefined === absent (docs/17 §0 rule 5)");
  assertValid(rec);
});

test("A5-F6: a present-but-garbage limit value still marks bad-input:limits", async () => {
  const rec = await investigate(basePacket(), { now: clock() }, { limits: { maxToolCalls: "2" } as never });
  assert.ok(rec.evidenceRefs.includes("bad-input:limits"));
});

test("A5-R1: a flood larger than the ingestion window discloses refs:truncated", async () => {
  // 200 entries, first 64 ALL fit: they are never seen, so the old
  // capacity check (usable ≤ 64) could never fire — the flood vanished
  // with no disclosure. The ingestion window now forces it.
  const flood = Array.from({ length: 200 }, (_, i) => `pkt:r1-${i}`);
  const rec = await investigate(basePacket({ facts: { approvalPending: true }, evidenceRefs: flood }), { now: clock() });
  assert.ok(rec.evidenceRefs.includes("refs:truncated"), "invisible entries are disclosed");
  assert.ok(rec.evidenceRefs.includes("rule:approval-pending:explicit"), "markers still survive");
  assert.ok(rec.evidenceRefs.length <= 64);
  assertValid(rec);
});

test("A5-R1 (discriminating): unique refs hidden past a duplicate-filled window ARE disclosed", async () => {
  // The first 64 entries carry only 2 distinct refs, so the copied window
  // fits capacity (uniqueUsable = 2). 100 NEW unique refs sit beyond the
  // window and were silently lost before A5-R1. Only the ingestion-overflow
  // flag can disclose them — this test fails if that OR is removed.
  const window = Array.from({ length: 64 }, (_, i) => `pkt:win-${i % 2}`);
  const hidden = Array.from({ length: 100 }, (_, i) => `pkt:hidden-${i}`);
  const rec = await investigate(basePacket({ facts: { approvalPending: true }, evidenceRefs: [...window, ...hidden] }), { now: clock() });
  assert.ok(rec.evidenceRefs.includes("refs:truncated"), "hidden unique content must be disclosed");
  assertValid(rec);
});

test("A5-R1+F5: a >64 flood of pure duplicates discloses NOTHING (F5 still rules)", async () => {
  // 200 slots, 5 unique — every dropped entry beyond the window is a
  // duplicate of a copied ref, so no unique content was lost and
  // `refs:truncated` would be a lie (the naive blind-overflow check
  // regressed exactly this).
  const dupes = Array.from({ length: 200 }, (_, i) => `pkt:r1c-${i % 5}`);
  const rec = await investigate(basePacket({ facts: { approvalPending: true }, evidenceRefs: dupes }), { now: clock() });
  assert.ok(!rec.evidenceRefs.includes("refs:truncated"), "no unique content lost — no truncation");
  assert.equal(rec.evidenceRefs.filter((r) => r.startsWith("pkt:")).length, 5);
});

test("A5-R1: the ingestion window boundary does not fire a phantom truncated", async () => {
  // 63 unique refs + the exhausted marker = exactly 64: everything fits
  // and NO disclosure is due — the boundary must not misfire overflow.
  const refs = Array.from({ length: 63 }, (_, i) => `pkt:r1b-${i}`);
  const rec = await investigate(basePacket({ evidenceRefs: refs }), { now: clock() });
  assert.ok(!rec.evidenceRefs.includes("refs:truncated"), "exact fit is not an overflow");
  assert.ok(rec.evidenceRefs.includes("investigation:exhausted"));
  assert.equal(rec.evidenceRefs.length, 64);
});

test("A5-R1: non-array evidenceRefs stays clean (no overflow phantoms)", async () => {
  const rec = await investigate(basePacket({ evidenceRefs: "not-an-array" as never }), { now: clock() });
  assert.ok(!rec.evidenceRefs.includes("refs:truncated"));
});

test("A6-F1: a sparse huge-length array returns fast and discloses the unvisited tail", async () => {
  // A packet may declare length up to 2^32-1 with NO entries behind
  // them; the pre-A6 per-index walk stalled investigate() ~40min at
  // max length. The scan budget bounds the walk and the unvisited
  // tail is disclosed (never silently dropped).
  const sparse: string[] = []; sparse.length = 4294967295;
  const t0 = Date.now();
  const rec = await investigate(basePacket({ facts: { approvalPending: true }, evidenceRefs: sparse }), { now: clock() });
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `bounded scan must return fast (took ${ms}ms)`);
  assert.ok(rec.evidenceRefs.includes("bad-input:scan-budget"), "exhausted budget is disclosed");
  assert.ok(rec.evidenceRefs.includes("refs:truncated"), "unvisited tail forces truncation");
  assertValid(rec);
});

test("A6-F1: the scan budget does not fire for arrays within it (no phantom)", async () => {
  // 1024 dense entries = exactly the budget: every index is visited,
  // so no scan-budget marker — capacity truncation still applies.
  const refs = Array.from({ length: 1024 }, (_, i) => `pkt:a6b-${i}`);
  const rec = await investigate(basePacket({ facts: { approvalPending: true }, evidenceRefs: refs }), { now: clock() });
  assert.ok(!rec.evidenceRefs.includes("bad-input:scan-budget"), "exact budget fit is not exhaustion");
  assert.ok(rec.evidenceRefs.includes("refs:truncated"), "capacity truncation still disclosed");
});

test("A6-F1: budget-exhausted duplicates still disclose (unvisited tail cannot be proven duplicate)", async () => {
  // 1024 duplicates (within budget, all seen) + a declared length past
  // it: entries 1024.. were never visited, so F5's "duplicates lose
  // nothing" cannot rule out unique content — disclosure is mandatory.
  const dupes = Array.from({ length: 1024 }, () => "pkt:a6d");
  dupes.length = 1025; // 1 unvisited entry the scan can never see
  const rec = await investigate(basePacket({ facts: { approvalPending: true }, evidenceRefs: dupes }), { now: clock() });
  assert.ok(rec.evidenceRefs.includes("bad-input:scan-budget"));
  assert.ok(rec.evidenceRefs.includes("refs:truncated"));
});

// ────────────────────── cycle-A7 findings (audit + fixes) ──────────────────

test("A7-F1 (INV-1): a revoked array as evidenceRefs never throws and is disclosed", async () => {
  // Array.isArray throws on a REVOKED Proxy (the trap is in the IsArray
  // intrinsic) — the pre-A7 fence called it unguarded and investigate()
  // rejected, leaving P9 with no record.
  const { proxy, revoke } = Proxy.revocable<string[]>([], {});
  revoke();
  const rec = await investigate(basePacket({ evidenceRefs: proxy as never }), { now: clock() });
  assert.ok(rec.evidenceRefs.includes("bad-input:packet"));
  assertValid(rec);
});

test("A7-F1 (INV-1): a revoked array as errors never throws and is disclosed", async () => {
  const { proxy, revoke } = Proxy.revocable<unknown[]>([], {});
  revoke();
  const rec = await investigate(basePacket({ errors: proxy as never }), { now: clock() });
  assert.ok(rec.evidenceRefs.includes("bad-input:packet"));
  assertValid(rec);
});

test("A7-F2: a lying length getter discards refs but discloses refs:dropped", async () => {
  // length reads 100 first, 101 at re-verify: the pre-A7 copy returned
  // an empty result with ALL flags false — the refs vanished silently,
  // contrary to docs/17 §0 rule 5.
  const arr = Array.from({ length: 100 }, (_, i) => `pkt:a7f2-${i}`);
  let reads = 0;
  const liar = new Proxy(arr, {
    get(t, k) { if (k === "length") { reads++; return reads === 1 ? t.length : t.length + 1; } return Reflect.get(t, k); },
  });
  const rec = await investigate(basePacket({ evidenceRefs: liar as never }), { now: clock() });
  assert.ok(rec.evidenceRefs.includes("refs:dropped"), "the discard must be disclosed");
  assert.ok(!rec.evidenceRefs.some((r) => r.startsWith("pkt:a7f2-")), "discarded refs are not emitted");
  assertValid(rec);
});

test("A7-F3 (INV-3): a maxUsd descriptor trap fails the budget CLOSED, not to the default", async () => {
  // Pre-A7: the trap read as {present:false} -> DEFAULT_MAX_USD, so a
  // caller who asked for $0 got $0.50 of probes with no marker.
  const hostile = new Proxy({ maxUsd: 0 }, { getOwnPropertyDescriptor(t, k) { if (k === "maxUsd") throw new Error("boom"); return Reflect.getOwnPropertyDescriptor(t, k); } });
  let calls = 0;
  const rec = await investigate(basePacket({ workerState: "running" }),
    { now: clock(), tools: { run: async () => { calls++; return { facts: {}, usd: 0 }; } } },
    { limits: hostile as never });
  assert.equal(calls, 0, "no probe may run under a trapped budget");
  assert.equal(rec.limitsRespected.toolsUsed, 0);
  assert.ok(rec.evidenceRefs.includes("bad-input:limits"));
  assertValid(rec);
});

test("A7-F7: a packet descriptor trap (proto passes) marks bad-input:packet", async () => {
  // Pre-A7 only a throwing getPrototypeOf marked; docs/17 §0 rule 5
  // promises disclosure for ANY trapping proxy.
  const packet = new Proxy({ episodeId: "ep-1" }, {
    getOwnPropertyDescriptor(t, k) { if (k !== "episodeId") throw new Error("boom"); return Reflect.getOwnPropertyDescriptor(t, k); },
  });
  const rec = await investigate(packet as never, { now: clock() });
  assert.ok(rec.evidenceRefs.includes("bad-input:packet"));
  assertValid(rec);
});

test("A7-F9: cumulative spend clamps to MAX_SAFE_INTEGER (reported figure stays exact)", async () => {
  const rec = await investigate(basePacket({ workerState: "running" }),
    { now: clock(), tools: { run: async () => ({ facts: {}, usd: Number.MAX_SAFE_INTEGER / 2 }) } },
    { limits: { maxUsd: Number.MAX_SAFE_INTEGER } });
  assert.ok(rec.limitsRespected.toolsUsed >= 3, "several probes must run to exercise the SUM");
  assert.equal(rec.limitsRespected.spendUsd, Number.MAX_SAFE_INTEGER);
  assertValid(rec);
});

// ───────────────────────── INV-7 record validity + freeze ───────────────────

test("INV-7: every golden record passes the REAL validateSupervisorRecord round-trip", async () => {
  const recs: DiagnosisRecordFields[] = [];
  for (const p of [
    basePacket({ facts: { approvalPending: true } }),
    basePacket({ facts: { diskFull: true } }),
    basePacket({ facts: { gatePass: false } }),
    basePacket({ workerState: "stopped" }),
    basePacket({ signal: { kind: "endpoint-error" } }),
    basePacket(),
  ]) recs.push(await investigate(p, { now: clock() }));
  for (const rec of recs) {
    assert.doesNotThrow(() => validateSupervisorRecord(rec as never));
    const roundTripped = JSON.parse(JSON.stringify(rec));
    assert.doesNotThrow(() => validateSupervisorRecord(roundTripped));
    assert.equal(rec.schema, DECISION_SCHEMA_ID);
    assert.equal(rec.kind, "diagnosis");
  }
});

test("record is frozen end-to-end (advice, not a live object)", async () => {
  const rec = await investigate(basePacket({ facts: { gatePass: false } }), { now: clock() });
  assert.ok(Object.isFrozen(rec));
  assert.ok(Object.isFrozen(rec.evidenceRefs));
  assert.ok(Object.isFrozen(rec.proposedActions));
  for (const pa of rec.proposedActions) assert.ok(Object.isFrozen(pa));
  assert.ok(Object.isFrozen(rec.limitsRespected));
});

// ───────────────────────── drift guards (the planner is the consumer) ──────

test("mirror pin: P15 closed sets match the real modules 1:1", () => {
  assert.deepEqual([...CAUSE_CLASSES].sort(), [...PLANNER_CAUSE_CLASSES].sort());
  assert.deepEqual([...ACTIONS].sort(), [...SUPERVISOR_ACTIONS].sort());
  assert.deepEqual([...ACTIONS].sort(), [...PLANNER_SUPERVISOR_ACTIONS].sort());
  assert.deepEqual([...SIGNAL_KINDS].sort(), [...DECISION_SIGNAL_KINDS].sort());
  assert.deepEqual([...WORKER_STATES].sort(), [...TAIL_WORKER_STATES].sort());
});

test("mirror pin: proposed-action rungs and strategy ids are the planner's own values", () => {
  for (const action of Object.keys(RUNG) as (keyof typeof RUNG)[]) {
    assert.equal(RUNG[action], (ACTION_RUNG as Record<string, number>)[action], `rung drift on ${action}`);
  }
  for (const [action, id] of Object.entries(STRATEGY)) {
    assert.equal(id, (STRATEGY_TEMPLATES as Record<string, string>)[action], `strategy drift on ${action}`);
  }
  assert.equal(CONFIDENCE_BAR, 0.7);
  assert.ok(JUDGE_CONFIDENCE_CAP < CONFIDENCE_BAR, "judge cap must stay strictly below the planner bar");
  assert.deepEqual([DEFAULT_MAX_TOOL_CALLS, DEFAULT_MAX_USD], [20, 0.5]);
});

// ───────────────────────── compartment guards (INV-8 / INV-9) ───────────────

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

test("INV-9 guard: src/investigation imports NOTHING — not even node: (pure, docs/17 §0.6)", async () => {
  const files = await walkTs(join("src", "investigation"));
  assert.ok(files.length >= 1);
  for (const file of files) {
    const content = await readFile(file, "utf-8");
    assert.deepEqual(specifiersOf(content), [], `${file} must import nothing`);
  }
});

test("INV-9 guard: nothing outside src/investigation imports it (until P9 wires it)", async () => {
  const files = await walkTs("src");
  const offenders: string[] = [];
  for (const file of files) {
    if (file.startsWith("src/investigation/")) continue;
    const content = await readFile(file, "utf-8").catch(() => "");
    if (specifiersOf(content).some((s) => /(^|\/)investigation\//.test(s))) offenders.push(file);
  }
  assert.deepEqual(offenders, [], offenders.join(", "));
});

test("INV-8 guard: the module never mentions fs/child_process/env/journal APIs (no authority, source scan)", async () => {
  const files = await walkTs(join("src", "investigation"));
  for (const file of files) {
    const content = await readFile(file, "utf-8");
    const stripped = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // comments carry contract prose
    for (const forbidden of ["require(", "process.", "child_process", "appendFile", "DecisionJournal", "spawn(", "fetch("]) {
      assert.ok(!stripped.includes(forbidden), `${file} must not contain ${forbidden}`);
    }
  }
});
