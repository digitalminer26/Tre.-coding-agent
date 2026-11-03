/**
 * P10 — recovery planner tests (docs/14; docs/11 §11.1 P10 row).
 *
 * Coverage:
 *  - golden fixtures (docs/14 §9): every gf-* pins decision/action/
 *    strategyId + required rationale codes + forbidden actions.
 *  - purity invariants by name (docs/14 §8): PC1 never-throws (hostile
 *    getters, prototype pollution, frozen/garbage inputs), PC2
 *    determinism (deep-equal reruns, key-order insensitivity), PC3 no
 *    permission (notAPermission, refs copied never invented), PC4 verdict
 *    integrity (finish ONLY from a live complete), PC5 escalate-safe
 *    totality (every fixture yields a recommendation), PC6 authority
 *    monotonicity, PC7 unknown-never-healthy.
 *  - loop-breaker (§6) both directions, budget caps (§3), swap pool
 *    validation (§7), repair gate (§5), advice-not-authority.
 *  - compartment guards (mirrors AC9): src/planner imports NOTHING; the
 *    mirrored enums are pinned 1:1 against the real modules; nothing
 *    outside src/planner imports it (until P9 wires it in).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  planRecovery,
  PLANNER_WORKER_STATES,
  PLANNER_VERDICTS,
  PLANNER_CAUSE_CLASSES,
  PLANNER_SUPERVISOR_ACTIONS,
  REPEAT_EXEMPT,
  STRATEGY_TEMPLATES,
  type PlannerInput,
  type PlanRecommendation,
} from "../src/planner/plan.js";
import { WORKER_STATES } from "../src/fleet/tail.js";
import { VERDICTS } from "../src/acceptance/evaluator.js";
import { SUPERVISOR_ACTIONS } from "../src/episode/journal.js";

// fixtures live in the SOURCE tree (tsc does not copy assets); from
// dist/test/*.js the repo root is two levels up.
const FIXTURE_DIR = fileURLToPath(new URL("../../test/fixtures/planner", import.meta.url));

// ───────────────────────── helpers (mirrors of the fixture shapes) ───────────

const AUTH = (over = {}) => ({
  paths: ["src/**"], notPaths: [], allowInstalls: false, allowNetwork: false,
  allowExternalEffects: false, models: ["alpha", "beta", "gamma"],
  diagnostics: { maxToolCalls: 10, maxUsd: 1 }, ...over,
});
const FACTS = (over = {}) => ({
  attemptsUsed: 1, nudgesUsed: 0, steerGuardResets: 0, strategyUses: {},
  recoveryUsdUsed: 0, recoveryTurnsUsed: 0, diagnosticToolCallsUsed: 0,
  diagnosticUsdUsed: 0, otherApprovedModels: ["beta", "gamma"], ...over,
});
const W = (over: { state?: PlannerInput["worker"]["state"]; sameGuardFires?: number } = {}): PlannerInput["worker"] => ({ state: "stopped", warnCount: 0, sameGuardFires: 0, toolCallsThisAttempt: 3, ...over });
const TASK = { taskId: "task-1", taskRevision: 1, now: 1000 };
const acc = (verdict: string, rw: string[] = [], live = true) =>
  ({ live, assessment: { verdict, remainingWork: rw, reasons: [], taskId: "task-1", taskRevision: 1 } }) as PlannerInput["acceptance"];

const base = (over: Partial<PlannerInput> = {}): PlannerInput => ({
  ...TASK, worker: W(), authority: AUTH(), facts: FACTS(), ...over,
} as PlannerInput);

// ───────────────────────── golden fixtures (docs/14 §9) ─────────────────────

interface Fixture {
  name: string;
  input: PlannerInput;
  expected: {
    decision: string; action: string; strategyId: string;
    rationaleIncludes: string[]; forbidActions: string[];
    model?: string; remainingWork?: string[];
    alternativesInclude?: { action: string; veto: string }[];
  };
}

async function loadFixtures(): Promise<Fixture[]> {
  const names = (await readdir(FIXTURE_DIR)).filter((f) => f.endsWith(".json")).sort();
  const out: Fixture[] = [];
  for (const n of names) {
    out.push(JSON.parse(await readFile(join(FIXTURE_DIR, n), "utf-8")));
  }
  return out;
}

const fixtures = await loadFixtures();

test("golden fixtures cover the docs/14 §9 table", () => {
  const names = new Set(fixtures.map((f) => f.name));
  for (const required of [
    "gf-finish-complete", "gf-uncertain-investigate", "gf-uncertain-no-diagnostics-escalate",
    "gf-incomplete-resume", "gf-blocked-escalate", "gf-await-approval-escalate",
    "gf-transient-backoff", "gf-transient-ambiguous-i5", "gf-premature-stop-resume",
    "gf-task-defect-repair-authorized", "gf-task-defect-repair-denied-paths",
    "gf-task-defect-repair-external-ungranted", "gf-change-approach-swap",
    "gf-change-approach-rewrite-no-pool", "gf-uptake-not-progress-loopbreaker",
    "gf-progress-reset-hold", "gf-guard-recurrence-no-nudge", "gf-repeated-strategy-escalate",
    "gf-budget-exhausted-escalate", "gf-unknown-state-investigate", "gf-dead-assessment-ignored",
    "gf-hold-healthy-worker", "gf-ambiguous-external-ownership-unprovable-park",
    "gf-malformed-hostile-input", "gf-advice-not-authority",
    "gf-failed-steer-ended-worker", "gf-repair-denied-traversal",
    "gf-repair-notpath-traversal-defeats-target", "gf-assessment-missing-fields-ignored",
    "gf-repair-corrupt-flags-restrict", "gf-budget-corrupt-caps-engage",
    "gf-rewrite-zero-repeat-veto", "gf-advice-fingerprint-vocabulary",
    "gf-budget-usd-just-below", "gf-budget-usd-at-cap",
    "gf-budget-turns-just-below", "gf-budget-turns-at-cap",
    "gf-budget-episode-caps-absent",
  ]) {
    assert.ok(names.has(required), `missing fixture ${required}`);
  }
});

for (const fx of fixtures) {
  test(`fixture ${fx.name}`, () => {
    const hostile = (fx.input as unknown as Record<string, unknown>).__hostileGetters as string[] | undefined;
    const input = { ...fx.input } as unknown as Record<string, unknown>;
    delete input.__hostileGetters;
    for (const key of hostile ?? []) {
      Object.defineProperty(input, key, { get() { throw new Error("hostile getter"); } });
    }
    const rec = planRecovery(input as unknown as PlannerInput);
    assert.equal(rec.decision, fx.expected.decision);
    assert.equal(rec.action, fx.expected.action);
    assert.equal(rec.strategyId, fx.expected.strategyId);
    for (const code of fx.expected.rationaleIncludes) {
      assert.ok(rec.rationale.includes(code), `rationale missing ${code}: ${JSON.stringify(rec.rationale)}`);
    }
    for (const banned of fx.expected.forbidActions) {
      assert.notEqual(rec.action, banned);
      // §7: kill/merge never RECOMMENDED. They may appear only as
      // advice-not-authority vetoed alternatives (gf-advice-not-authority).
      assert.ok(!rec.alternatives.some((a) => a.action === banned && a.veto !== "advice-not-authority"),
        `alternative must not execute ${banned}`);
    }
    if (fx.expected.model !== undefined) assert.equal(rec.model, fx.expected.model);
    if (fx.expected.remainingWork !== undefined) assert.deepEqual(rec.remainingWork, fx.expected.remainingWork);
    for (const alt of fx.expected.alternativesInclude ?? []) {
      assert.ok(rec.alternatives.some((a) => a.action === alt.action && a.veto === alt.veto),
        `missing alternative ${alt.action}/${alt.veto} in ${JSON.stringify(rec.alternatives)}`);
    }
  });
}

// ───────────────────────── purity invariants (docs/14 §8) ───────────────────

test("PC1: never throws on hostile inputs", () => {
  const hostile: unknown[] = [
    undefined, null, 0, "", [], true,
    { taskId: null, worker: null, authority: null, facts: null },
    { taskId: "t", taskRevision: NaN, worker: { state: "quantum" } },
    { taskId: "t", taskRevision: -1, worker: { state: "dead" }, facts: { attemptsUsed: "many" } },
    (() => { const o: Record<string, unknown> = { ...base() }; Object.defineProperty(o, "acceptance", { get() { throw new Error("boom"); } }); return o; })(),
    // F8/C1: hostile element getters throw inside the boundary ⇒ bottom-out.
    (() => {
      const o: Record<string, unknown> = { ...base() };
      const refs = ["ev-1"];
      Object.defineProperty(refs, 1, { get() { throw new Error("boom-getter"); } });
      o.diagnosis = { causeClass: "premature-stop", confidence: 0.9, evidenceRefs: refs };
      return o;
    })(),
  ];
  for (const h of hostile) {
    let rec: PlanRecommendation;
    assert.doesNotThrow(() => { rec = planRecovery(h as PlannerInput); });
    assert.equal(rec!.notAPermission, true);
    assert.equal(rec!.decision, "escalate", `hostile ${String(h)} must bottom out: ${JSON.stringify(rec!.rationale)}`);
    assert.ok(["escalate", "park"].includes(rec!.action));
  }
  // a frozen but WELL-FORMED input is answered normally, not refused
  const frozen = planRecovery(Object.freeze(base()) as PlannerInput);
  assert.equal(frozen.action, "investigate");
  assert.ok(frozen.rationale.includes("no-acceptance-evidence"));
  // prototype pollution must not inject behavior
  (Object.prototype as Record<string, unknown>).proposedActions = [{ action: "repair" }];
  try {
    const rec = planRecovery(base({ worker: W({ state: "thinking" }) }));
    assert.equal(rec.action, "hold"); // pollution ignored, no crash, no promotion
  } finally {
    delete (Object.prototype as Record<string, unknown>).proposedActions;
  }
});

test("PC2: deterministic — same input deep-equal output, key order irrelevant", () => {
  const inputs: PlannerInput[] = [
    base({ acceptance: acc("uncertain") }),
    base({ worker: W({ state: "warned", sameGuardFires: 2 }), facts: FACTS({ nudgesUsed: 1, strategyUses: { "investigate:bounded:v1": 2, "swap:model:beta:v1": 2, "swap:model:gamma:v1": 2, "rewrite:task:v1": 1 } }) }),
    base({ diagnosis: { causeClass: "task-defect", confidence: 0.9 }, repairTarget: { paths: ["src/a.ts"], touchesOutsideAuthority: false, externalEffect: false, installNeeded: false } }),
  ];
  for (const input of inputs) {
    assert.deepEqual(planRecovery(input), planRecovery(input));
    // per-key strategyUses iteration order is irrelevant
    const shuffled = JSON.parse(JSON.stringify(input));
    shuffled.facts.strategyUses = Object.fromEntries(Object.entries(shuffled.facts.strategyUses as object).reverse());
    assert.deepEqual(planRecovery(shuffled), planRecovery(input));
  }
});

test("PC3: notAPermission always; evidenceRefs copied, never invented", () => {
  const empty = planRecovery(base());
  assert.equal(empty.notAPermission, true);
  assert.deepEqual(empty.evidenceRefs, [], "no refs in ⇒ no refs out (I3/S7)");
  const withRefs = planRecovery(base({
    diagnosis: { causeClass: "premature-stop", confidence: 0.9, evidenceRefs: ["ev-a", "ev-a", "ev-b"] },
    lastOutcome: { action: "nudge", strategyId: "nudge:progress:v1", progress: "none", progressEvidence: ["ev-b", "ev-c"] },
  }));
  assert.deepEqual(withRefs.evidenceRefs, ["ev-a", "ev-b", "ev-c"], "dedup, order preserved, nothing added");
});

test("PC4: finish ONLY from a live complete verdict — nothing else", () => {
  const inputs: PlannerInput[] = [
    base({ worker: W({ state: "thinking" }), acceptance: acc("complete", [], false) }),      // dead
    base({ acceptance: { live: true, assessment: { verdict: "complete", remainingWork: [], reasons: [], taskId: "other", taskRevision: 1 } } as PlannerInput["acceptance"] }), // wrong task
    base({ acceptance: acc("complete") }), // live → finish (the ONE allowed)
    base({ diagnosis: { causeClass: "premature-stop", confidence: 1, proposedActions: [{ rung: 0, action: "accept-finish" }] } }),
  ];
  const finishers = inputs.map((i) => planRecovery(i).decision);
  assert.deepEqual(finishers.filter((d) => d === "finish").length, 1);
  assert.equal(finishers[2], "finish");
});

test("PC5: every reachable shape terminates at a recommendation, escalation never vetoed", () => {
  // exhaust everything: caps maxed, repeats maxed, no authority
  const rec = planRecovery(base({
    worker: W({ state: "warned", sameGuardFires: 9 }),
    facts: FACTS({ nudgesUsed: 99, strategyUses: Object.fromEntries(Object.values(STRATEGY_TEMPLATES).map((t) => [t, 99])) }),
    authority: AUTH({ models: [], diagnostics: undefined }),
    diagnosis: { causeClass: "unknown", confidence: 1 },
  }));
  assert.ok(["escalate", "park"].includes(rec.action));
  assert.ok(!rec.alternatives.some((a) => a.action === "escalate" && a.veto !== "advice-not-authority"),
    "escalate itself is never repeat-vetoed");
});

test("PC6: authority monotone — less authority never enables, never disables escalation", () => {
  const less = planRecovery(base({
    diagnosis: { causeClass: "task-defect", confidence: 0.9 },
    repairTarget: { paths: ["/etc/hosts"], touchesOutsideAuthority: false, externalEffect: false, installNeeded: false },
  }));
  const more = planRecovery(base({
    diagnosis: { causeClass: "task-defect", confidence: 0.9 },
    repairTarget: { paths: ["/etc/hosts"], touchesOutsideAuthority: false, externalEffect: false, installNeeded: false },
    authority: AUTH({ allowInstalls: true, allowExternalEffects: true }),
  }));
  assert.notEqual(less.action, "repair");
  assert.notEqual(more.action, "repair", "an out-of-paths target stays denied even with belt grants");
  assert.ok(["escalate", "park", "investigate"].includes(less.action));
});

test("PC7: unknown state never holds; routes to investigate-or-escalate (I3)", () => {
  const withDiag = planRecovery(base({ worker: W({ state: "unknown" }) }));
  assert.equal(withDiag.action, "investigate");
  const without = planRecovery(base({ worker: W({ state: "unknown" }), authority: AUTH({ diagnostics: undefined }) }));
  assert.equal(without.action, "escalate");
  assert.notEqual(without.action, "hold");
});

// F8/C1 (cycle-1 audit): caller-owned array METHODS are never invoked in
// the planner frame — a poisoned filter/map/iterator is inert and the
// input is answered normally, strings copied by index.
test("F8: hostile array methods are never called (index-based copy)", () => {
  const refs: unknown[] = ["ev-1", "ev-2"];
  const poison = (name: string) => {
    (refs as unknown as Record<string, unknown>)[name] = () => { throw new Error(`boom-${name}`); };
  };
  ["filter", "map", "forEach", "slice", "concat", "flatMap", "at", "join", "reduce"].forEach(poison);
  const input = base({
    diagnosis: { causeClass: "premature-stop", confidence: 0.9, evidenceRefs: refs as unknown as string[], proposedActions: refs as unknown as PlannerInput["diagnosis"] extends { proposedActions?: infer P } ? P : never },
  });
  let rec: PlanRecommendation;
  assert.doesNotThrow(() => { rec = planRecovery(input as unknown as PlannerInput); });
  assert.equal(rec!.action, "evidence-nudge-resume");
  assert.deepEqual(rec!.evidenceRefs, ["ev-1", "ev-2"]);
  // Symbol.iterator poison: spreading would throw — must be inert too.
  const it: unknown[] = ["ev-3"];
  (it as unknown as Record<symbol, unknown>)[Symbol.iterator] = () => { throw new Error("boom-iter"); };
  const rec2 = planRecovery(base({
    diagnosis: { causeClass: "premature-stop", confidence: 0.9, evidenceRefs: it as unknown as string[] },
  }) as unknown as PlannerInput);
  assert.deepEqual(rec2.evidenceRefs, ["ev-3"]);
});

// F5 (cycle-1 audit): prototype-inherited authority is never a grant.
test("F5: inherited authority grants are ignored (own properties only)", () => {
  const proto = { diagnostics: { maxToolCalls: 10, maxUsd: 1 }, allowExternalEffects: true, models: ["beta"], paths: ["src/**"] };
  const auth = Object.create(proto) as Record<string, unknown>;
  const input = base({ acceptance: acc("uncertain") }) as unknown as Record<string, unknown>;
  input.authority = auth;
  const rec = planRecovery(input as unknown as PlannerInput);
  // no OWN diagnostics grant ⇒ investigate is not permitted; the
  // chainSeed bottom-out escalates with the veto recorded.
  assert.equal(rec.decision, "escalate");
  assert.ok(rec.rationale.includes("veto:diagnostics:ungranted"), JSON.stringify(rec.rationale));
});

// F6 (cycle-1 audit): corrupt explicit caps engage (0), never default.
test("F6: present-invalid budget caps fail closed to engaged, absent defaults", () => {
  // absent attempts cap ⇒ default 3: attemptsUsed 2 still acts.
  const okDefault = planRecovery(base({ acceptance: acc("incomplete", ["work"]) , facts: FACTS({ attemptsUsed: 2 })}));
  assert.equal(okDefault.action, "evidence-nudge-resume");
  // corrupt cap ⇒ engaged (0): escalate even with attemptsUsed 0.
  const corrupt = planRecovery(base({ acceptance: acc("incomplete", ["work"]), recoveryBudget: { maxAttemptsPerTask: "three" } as unknown as PlannerInput["recoveryBudget"], facts: FACTS({ attemptsUsed: 0 }) }));
  assert.equal(corrupt.decision, "escalate");
  assert.ok(corrupt.rationale.includes("budget:attempts"));
});

// F2 (cycle-1 audit): lexical traversal never escapes the authority box.
test("F2: path containment normalizes — traversal is denied, .. inside stays denied", () => {
  const mk = (target: string) => base({
    diagnosis: { causeClass: "task-defect", confidence: 0.9 },
    repairTarget: { paths: [target], touchesOutsideAuthority: false, externalEffect: false, installNeeded: false },
    authority: AUTH({ paths: ["src/**"], notPaths: ["src/private/**"] }),
  });
  // src/../outside.ts normalizes OUTSIDE src/** ⇒ denied.
  assert.ok(planRecovery(mk("src/../outside.ts")).rationale.includes("authority:denied:paths"));
  // src/public/../private/key.ts normalizes INTO notPaths ⇒ denied.
  assert.ok(planRecovery(mk("src/public/../private/key.ts")).rationale.includes("authority:denied:paths"));
  // an in-box traversal that resolves inside authority still repairs.
  const okRec = planRecovery(mk("src/planner/../planner/plan.ts"));
  assert.equal(okRec.action, "repair");
});

// F4 (cycle-1 audit): corrupt restriction flags engage the restriction.
test("F4: corrupt repair restriction flags fail closed (restriction engages)", () => {
  const rec = planRecovery(base({
    diagnosis: { causeClass: "task-defect", confidence: 0.9 },
    repairTarget: { paths: ["src/a.ts"], touchesOutsideAuthority: "yes", externalEffect: "yes", installNeeded: "yes" } as unknown as PlannerInput["repairTarget"],
  }));
  assert.notEqual(rec.action, "repair");
  assert.ok(rec.rationale.includes("authority:denied:external"));
  assert.ok(rec.rationale.includes("authority:denied:install"));
});

// F9 (cycle-1 audit): advice fingerprints enter only via the closed table.
test("F9: advice strategyId outside the closed vocabulary is replaced by the template", () => {
  const rec = planRecovery(base({
    diagnosis: { causeClass: "unknown", confidence: 0.5, proposedActions: [
      { rung: 2, action: "nudge", strategyId: "arbitrary-unversioned-text" },
      { rung: 3, action: "model-swap", strategyId: "swap:model:beta:v1" },
      { rung: 1, action: "nudge", strategyId: "nudge:progress:v1" },
    ], evidenceRefs: ["ev-1"] },
  }));
  const nudgeAlt = rec.alternatives.find((a) => a.action === "nudge");
  assert.equal(nudgeAlt?.strategyId, "nudge:progress:v1"); // template, not advice text
  const swapAlt = rec.alternatives.find((a) => a.action === "model-swap");
  assert.equal(swapAlt?.strategyId, "swap:model:beta:v1"); // pool-validated fingerprint kept
});

// §3 (F10): episode-spend / episode-turn caps refuse exactly at the cap.
test("§3: episode recoveryUsd / recoveryTurns refuse exactly at cap", () => {
  const input = (usd: number, turns: number, cap?: { usd?: number; turns?: number }): PlannerInput => base({
    acceptance: acc("incomplete", ["more work"]),
    recoveryBudget: cap
      ? {
          ...(cap.usd !== undefined ? { maxEpisodeRecoveryUsd: cap.usd } : {}),
          ...(cap.turns !== undefined ? { maxEpisodeRecoveryTurns: cap.turns } : {}),
        } as PlannerInput["recoveryBudget"]
      : undefined,
    facts: FACTS({ recoveryUsdUsed: usd, recoveryTurnsUsed: turns }),
  });
  // just below ⇒ acts; exactly at ⇒ refuse.
  assert.equal(planRecovery(input(0.99, 0, { usd: 1 })).action, "evidence-nudge-resume");
  assert.equal(planRecovery(input(1, 0, { usd: 1 })).rationale.includes("budget:usd"), true);
  assert.equal(planRecovery(input(0, 4, { turns: 5 })).action, "evidence-nudge-resume");
  assert.equal(planRecovery(input(0, 5, { turns: 5 })).rationale.includes("budget:turns"), true);
  // absent caps ⇒ no cap: huge usage still acts.
  assert.equal(planRecovery(input(100000, 90000)).action, "evidence-nudge-resume");
});

// ───────────────────── cycle-2 audit regressions (docs/14 §12 am. 19–26) ────

// C2-F1: assessment arrays are validated by INDEX — a poisoned `.every`
// can no longer pass [123] through into a finish.
test("C2-F1: poisoned .every on assessment arrays cannot produce finish", () => {
  const mkAssessment = () => {
    const rw: unknown[] = [123];
    const rs: unknown[] = [456];
    (rw as unknown as Record<string, unknown>).every = () => true;
    (rs as unknown as Record<string, unknown>).every = () => true;
    return {
      live: true,
      assessment: { verdict: "complete", remainingWork: rw, reasons: rs, taskId: "task-1", taskRevision: 1 },
    };
  };
  const rec = planRecovery(base({ worker: W({ state: "thinking" }), acceptance: mkAssessment() as unknown as PlannerInput["acceptance"] }));
  assert.notEqual(rec.decision, "finish", "non-string elements must reject the whole assessment");
  assert.ok(rec.rationale.includes("assessment:invalid"), JSON.stringify(rec.rationale));
});

// C2-F2: an entirely inherited authority container is ABSENT — no grant
// through the prototype chain (investigate denied).
test("C2-F2: inherited authority container is not a grant", () => {
  const input = {
    ...base({ acceptance: acc("uncertain") }),
  } as unknown as Record<string, unknown>;
  delete input.authority;
  const withInherited = Object.create({ authority: { paths: ["src/**"], notPaths: [], diagnostics: { maxToolCalls: 10, maxUsd: 1 }, models: ["beta"] } });
  const { authority: _drop, ...rest } = base({ acceptance: acc("uncertain") }) as unknown as Record<string, unknown>;
  Object.assign(withInherited, rest);
  // sanity: the plain input with NO authority at all must not investigate
  const rec = planRecovery(input as unknown as PlannerInput);
  assert.notEqual(rec.action, "investigate");
  const rec2 = planRecovery(withInherited as unknown as PlannerInput);
  assert.notEqual(rec2.action, "investigate", "inherited authority object must be ignored");
  assert.ok(rec2.rationale.some((r) => r.startsWith("veto:diagnostics")), JSON.stringify(rec2.rationale));
});

// C2-F2b: an inherited facts container supplies no ledger/usage either.
test("C2-F2b: inherited facts container fails the ledgers closed", () => {
  const withInherited = Object.create({ facts: FACTS() });
  Object.assign(withInherited, TASK, {
    worker: W({ state: "unknown" }),
    authority: AUTH(),
  });
  const rec = planRecovery(withInherited as unknown as PlannerInput);
  // no own facts ⇒ every ledger maxed: investigate repeat-vetoed ⇒ escalate
  assert.equal(rec.action, "escalate", JSON.stringify(rec.rationale));
});

// C2-F3: an absent/malformed strategy ledger proves NOTHING — every
// fingerprint is MAXED, so investigate repeat-vetoes instead of opening.
test("C2-F3: missing/malformed strategy ledger fails closed to maxed usage", () => {
  for (const badLedger of [null, 42, "uses", undefined, ["a"], Object.create({ "investigate:bounded:v1": 2 })]) {
    const rec = planRecovery(base({
      acceptance: acc("uncertain"),
      facts: { ...FACTS(), strategyUses: badLedger as unknown as Record<string, number> },
    } as unknown as Partial<PlannerInput>));
    assert.notEqual(rec.action, "investigate", `ledger ${String(badLedger)} must not open investigate`);
  }
  // a plain-object ledger (null prototype) is fine.
  const ok = planRecovery(base({ acceptance: acc("uncertain"), facts: { ...FACTS(), strategyUses: Object.create(null) } as unknown as PlannerInput["facts"] }));
  assert.equal(ok.action, "investigate");
});

// C2-F4: a corrupt required notPaths/paths list never erases into an
// empty deny/allow set — repair is denied with the authority record named.
test("C2-F4: corrupt authority path lists disqualify repair (fail closed)", () => {
  const mk = (authority: Record<string, unknown>) => base({
    diagnosis: { causeClass: "task-defect", confidence: 0.9 },
    repairTarget: { paths: ["src/private/key.ts"], touchesOutsideAuthority: false, externalEffect: false, installNeeded: false },
    authority: { ...AUTH(), ...authority } as PlannerInput["authority"],
  });
  for (const bad of [{ notPaths: "src/private/**" }, { notPaths: null }, { paths: "src/**" }, { paths: 7 }, { notPaths: undefined }]) {
    const rec = planRecovery(mk(bad) as unknown as PlannerInput);
    assert.notEqual(rec.action, "repair", `${JSON.stringify(bad)} must deny repair`);
    assert.ok(rec.rationale.includes("authority:denied:authority-record"), JSON.stringify(rec.rationale));
  }
});

// C2-F5: an own property with value undefined is PRESENT-but-invalid ⇒
// cap engages at 0; only a truly absent property takes the default.
test("C2-F5: present-undefined caps engage at zero, absent keep defaults", () => {
  const undefCaps = base({
    acceptance: acc("incomplete", ["work"]),
    recoveryBudget: { maxAttemptsPerTask: undefined, maxEpisodeRecoveryUsd: undefined } as unknown as PlannerInput["recoveryBudget"],
    facts: FACTS({ attemptsUsed: 0 }),
  });
  const rec = planRecovery(undefCaps);
  assert.equal(rec.decision, "escalate");
  assert.ok(rec.rationale.includes("budget:attempts"), JSON.stringify(rec.rationale));
});

// C2-F6: prototype-named advice actions cannot smuggle Object members
// into the fingerprint vocabulary (own-only table lookups).
test("C2-F6: prototype-named advice actions get empty fingerprints, not Object members", () => {
  const rec = planRecovery(base({
    diagnosis: { causeClass: "unknown", confidence: 0.5, proposedActions: [
      { rung: 2, action: "constructor" },
      { rung: 2, action: "__proto__" },
    ] as unknown as PlannerInput["diagnosis"] extends { proposedActions?: infer P } ? P : never },
  }));
  for (const alt of rec.alternatives) {
    assert.equal(typeof alt.strategyId, "string", "strategyId must stay a string fingerprint");
    assert.ok(alt.strategyId === "" || /^[a-z-]+:.+:v\d+$/.test(alt.strategyId), `fingerprint vocabulary: ${alt.strategyId}`);
    assert.ok(alt.action === "escalate" || (PLANNER_SUPERVISOR_ACTIONS as readonly string[]).includes(alt.action));
  }
});

// C2-F7: the failed-steer classification is the recorded progress —
// nonempty progressEvidence NEVER upgrades a `none`/`uptake` steer.
test("C2-F7: refs presence cannot upgrade a failed steer classification", () => {
  const conflicting = { action: "nudge", strategyId: "nudge:progress:v1", progress: "none", progressEvidence: ["ev-unverified"] } as const as PlannerInput["lastOutcome"];
  // ended worker: loop-breaker chain, not the L11 silence fallback.
  const ended = planRecovery(base({ worker: W({ state: "stopped" }), lastOutcome: conflicting, facts: FACTS({ nudgesUsed: 1 }) }));
  assert.ok(ended.rationale.includes("steer-no-uptake"), JSON.stringify(ended.rationale));
  assert.equal(ended.action, "investigate");
  // healthy live worker: same — never the hold sentinel.
  const live = planRecovery(base({ worker: W({ state: "thinking" }), lastOutcome: conflicting, facts: FACTS({ nudgesUsed: 1 }) }));
  assert.notEqual(live.action, "hold");
  assert.ok(live.rationale.includes("steer-no-uptake"), JSON.stringify(live.rationale));
  // warned worker: no second nudge from a failed steer.
  const warned = planRecovery(base({ worker: W({ state: "warned" }), lastOutcome: conflicting, facts: FACTS({ nudgesUsed: 1 }) }));
  assert.notEqual(warned.action, "nudge");
  // control: task-relevant WITH refs still holds.
  const ok = planRecovery(base({ worker: W({ state: "thinking" }), lastOutcome: { action: "nudge", strategyId: "nudge:progress:v1", progress: "task-relevant", progressEvidence: ["ev-real"] }, facts: FACTS({ nudgesUsed: 1 }) }));
  assert.equal(ok.action, "hold");
});

// C2-F8: docs/11 §9 caps rung-1 nudges at 2 per task — a LOOSER policy
// value can never raise the binding ceiling.
test("C2-F8: maxNudgesPerTask above the binding ceiling of 2 is clamped", () => {
  const rec = planRecovery(base({
    worker: W({ state: "warned", sameGuardFires: 1 }),
    recoveryBudget: { maxNudgesPerTask: 99 },
    facts: FACTS({ nudgesUsed: 2, steerGuardResets: 0 }),
  }));
  assert.notEqual(rec.action, "nudge", "a third nudge must be impossible regardless of policy");
  // a STRICTER policy value still wins (cap 1 refuses at 1 used).
  const strict = planRecovery(base({
    worker: W({ state: "warned", sameGuardFires: 1 }),
    recoveryBudget: { maxNudgesPerTask: 1 },
    facts: FACTS({ nudgesUsed: 1 }),
  }));
  assert.notEqual(strict.action, "nudge");
});

// ───────────────────────── §6 loop-breaker, §3 caps, §7 pool, §5 gate ───────

test("§6: task-relevant progress resets the loop expectation (hold)", () => {
  const rec = planRecovery(base({
    worker: W({ state: "tool" }),
    lastOutcome: { action: "nudge", strategyId: "nudge:progress:v1", progress: "task-relevant", progressEvidence: ["ev-x"] },
    facts: FACTS({ nudgesUsed: 1 }),
  }));
  assert.equal(rec.action, "hold");
});

test("§3: steerGuardResets counts against the nudge cap", () => {
  const rec = planRecovery(base({
    worker: W({ state: "warned" }),
    facts: FACTS({ nudgesUsed: 1, steerGuardResets: 1 }), // 2 >= maxNudges 2
    authority: AUTH({ diagnostics: undefined, models: [] }),
  }));
  assert.notEqual(rec.action, "nudge");
  const vetoed = rec.alternatives.find((a) => a.action === "nudge");
  assert.equal(vetoed?.veto, "budget:nudges");
});

test("§3: maxStrategyRepeats default (2) prohibits at >=2 uses", () => {
  const used = planRecovery(base({
    acceptance: acc("uncertain"),
    facts: FACTS({ strategyUses: { "investigate:bounded:v1": 2 } }),
  }));
  assert.equal(used.action, "escalate");
  assert.ok(used.alternatives.some((a) => a.action === "investigate" && a.veto === "repeat:investigate:bounded:v1"));
  const under = planRecovery(base({ acceptance: acc("uncertain"), facts: FACTS({ strategyUses: { "investigate:bounded:v1": 1 } }) }));
  assert.equal(under.action, "investigate");
});

test("§3: budget policy overrides win over defaults", () => {
  const tighter = planRecovery(base({
    recoveryBudget: { maxAttemptsPerTask: 1 },
    facts: FACTS({ attemptsUsed: 1 }),
    worker: W({ state: "thinking" }),
    ownershipProvable: true,
  }));
  assert.equal(tighter.action, "escalate");
  assert.ok(tighter.rationale.includes("budget:attempts"));
  // live + ownership not provable ⇒ park branch (L4)
  const parky = planRecovery(base({
    recoveryBudget: { maxAttemptsPerTask: 1 },
    facts: FACTS({ attemptsUsed: 1 }),
    worker: W({ state: "thinking" }),
  }));
  assert.equal(parky.action, "park");
});

test("§7: swap target is the first pool member not yet saturated, in input order", () => {
  const rec = planRecovery(base({
    worker: W({ state: "tool" }),
    lastOutcome: { action: "nudge", strategyId: "nudge:progress:v1", progress: "uptake", progressEvidence: [] },
    authority: AUTH({ diagnostics: undefined, models: ["beta", "gamma"] }),
    facts: FACTS({ nudgesUsed: 1, otherApprovedModels: ["gamma", "beta"] }),
  }));
  assert.equal(rec.action, "model-swap");
  assert.equal(rec.model, "gamma", "order of the remaining list fixes the pick");
  assert.equal(rec.strategyId, "swap:model:gamma:v1");
  assert.ok(rec.rationale.includes("swap:pool"));
});

test("§7: a model outside authority.models is never a swap target", () => {
  const rec = planRecovery(base({
    worker: W({ state: "tool" }),
    lastOutcome: { action: "nudge", strategyId: "nudge:progress:v1", progress: "uptake", progressEvidence: [] },
    authority: AUTH({ diagnostics: undefined, models: ["alpha"] }),
    facts: FACTS({ nudgesUsed: 1, otherApprovedModels: ["not-approved"] }),
  }));
  assert.notEqual(rec.action, "model-swap");
  assert.ok(rec.alternatives.some((a) => a.action === "model-swap" && a.veto === "swap:no-target"));
});

test("§5: repair denied by notPaths even when inside paths", () => {
  const rec = planRecovery(base({
    diagnosis: { causeClass: "task-defect", confidence: 0.9 },
    repairTarget: { paths: ["src/secret.ts"], touchesOutsideAuthority: false, externalEffect: false, installNeeded: false },
    authority: AUTH({ notPaths: ["src/secret.ts"] }),
  }));
  assert.notEqual(rec.action, "repair");
  assert.ok(rec.rationale.includes("authority:denied:paths"));
});

test("§5: install-repair needs allowInstalls", () => {
  const denied = planRecovery(base({
    diagnosis: { causeClass: "task-defect", confidence: 0.9 },
    repairTarget: { paths: ["src/a.ts"], touchesOutsideAuthority: false, externalEffect: false, installNeeded: true },
  }));
  assert.notEqual(denied.action, "repair");
  assert.ok(denied.rationale.includes("authority:denied:install"));
  const allowed = planRecovery(base({
    diagnosis: { causeClass: "task-defect", confidence: 0.9 },
    repairTarget: { paths: ["src/a.ts"], touchesOutsideAuthority: false, externalEffect: false, installNeeded: true },
    authority: AUTH({ allowInstalls: true }),
  }));
  assert.equal(allowed.action, "repair");
});

test("§5: authorized external repair carries external sideEffect (rung 3)", () => {
  const rec = planRecovery(base({
    diagnosis: { causeClass: "task-defect", confidence: 0.9 },
    repairTarget: { paths: ["src/a.ts"], touchesOutsideAuthority: false, externalEffect: true, installNeeded: false },
    authority: AUTH({ allowExternalEffects: true }),
  }));
  assert.equal(rec.action, "repair");
  assert.equal(rec.sideEffect, "external");
  assert.equal(rec.authorityNeeded, "external");
  assert.equal(rec.rung, 3);
});

test("diagnosis advice never executes: veto advice-not-authority", () => {
  const rec = planRecovery(base({
    diagnosis: { causeClass: "unknown", confidence: 0.5, proposedActions: [{ rung: 5, action: "kill" as const }, { rung: 4, action: "totally-made-up" as never }] },
  }));
  assert.equal(rec.action, "investigate");
  const kill = rec.alternatives.find((a) => a.action === "kill");
  assert.ok(kill, "kill appears as a vetoed alternative only");
  assert.equal(kill!.veto, "advice-not-authority");
  const bogus = rec.alternatives.find((a) => a.action === "escalate");
  assert.ok(bogus, "unknown action mapped to escalate placeholder");
});

test("I5 latch: corrupted ambiguous flag latches fail-closed; absent does not", () => {
  const corrupt = planRecovery(base({ worker: W({ state: "thinking" }), ambiguousExternalEffect: "yes" as unknown as boolean }));
  assert.ok(["escalate", "park"].includes(corrupt.action));
  const clean = planRecovery(base({ worker: W({ state: "thinking" }) }));
  assert.equal(clean.action, "hold");
});

test("hold sentinel is outside SUPERVISOR_ACTIONS and never names kill/merge", () => {
  assert.ok(!PLANNER_SUPERVISOR_ACTIONS.includes("hold" as never));
  const rec = planRecovery(base({ worker: W({ state: "thinking" }) }));
  assert.equal(rec.action, "hold");
  assert.equal(rec.rung, 0);
  assert.equal(rec.sideEffect, "none");
});

test("REPEAT_EXEMPT + templates match the contract §4", () => {
  assert.deepEqual([...REPEAT_EXEMPT].sort(), ["accept-finish", "escalate", "hold", "park"]);
  assert.equal((STRATEGY_TEMPLATES as Record<string, string>)["model-swap"], undefined, "model-swap instantiates per-target; no template");
});

// ───────────────────────── compartment guards (mirrors AC9) ──────────────────

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

test("guard: src/planner imports NOTHING — not even node: (pure, docs/14 §0.6)", async () => {
  const files = await walkTs(join("src", "planner"));
  assert.ok(files.length >= 1);
  for (const file of files) {
    const content = await readFile(file, "utf-8");
    assert.deepEqual(specifiersOf(content), [], `${file} must import nothing`);
  }
});

test("guard: nothing outside src/planner imports the planner (until P9 wires it)", async () => {
  const files = await walkTs("src");
  const offenders: string[] = [];
  for (const file of files) {
    if (file.startsWith("src/planner/")) continue;
    const content = await readFile(file, "utf-8").catch(() => "");
    if (specifiersOf(content).some((s) => /(^|\/)planner\//.test(s))) offenders.push(file);
  }
  assert.deepEqual(offenders, [], offenders.join(", "));
});

test("mirror pin: planner enums match the real modules 1:1 (structural mirrors)", () => {
  assert.deepEqual([...PLANNER_WORKER_STATES].sort(), [...WORKER_STATES].sort());
  assert.deepEqual([...PLANNER_VERDICTS].sort(), [...VERDICTS].sort());
  assert.deepEqual([...PLANNER_SUPERVISOR_ACTIONS].sort(), [...SUPERVISOR_ACTIONS].sort());
  assert.deepEqual(PLANNER_CAUSE_CLASSES, ["transient-endpoint", "premature-stop", "task-defect", "environment-blocker", "approval-boundary", "unknown"]);
});
