// Generates test/fixtures/planner/*.json from the CURRENT implementation.
// Regeneration is a CONTRACT CHECK: review the printed table against
// docs/14 §2/§9 before committing changed expectations.
import { planRecovery } from '../dist/src/planner/plan.js';
import { writeFileSync } from 'node:fs';

const AUTH = (over = {}) => ({
  paths: ['src/**'], notPaths: [], allowInstalls: false, allowNetwork: false,
  allowExternalEffects: false, models: ['alpha', 'beta', 'gamma'],
  diagnostics: { maxToolCalls: 10, maxUsd: 1 }, ...over,
});
const FACTS = (over = {}) => ({
  attemptsUsed: 1, nudgesUsed: 0, steerGuardResets: 0, strategyUses: {},
  recoveryUsdUsed: 0, recoveryTurnsUsed: 0, diagnosticToolCallsUsed: 0,
  diagnosticUsdUsed: 0, otherApprovedModels: ['beta', 'gamma'], ...over,
});
const W = (over = {}) => ({ state: 'stopped', warnCount: 0, sameGuardFires: 0, toolCallsThisAttempt: 3, ...over });
const TASK = { taskId: 'task-1', taskRevision: 1, now: 1000 };
const acc = (verdict, rw = [], live = true) => ({ live, assessment: { verdict, remainingWork: rw, reasons: [], taskId: 'task-1', taskRevision: 1 } });

const cases = {
  'gf-finish-complete': { ...TASK, worker: W(), acceptance: acc('complete'), authority: AUTH(), facts: FACTS() },
  'gf-uncertain-investigate': { ...TASK, worker: W(), acceptance: acc('uncertain'), authority: AUTH(), facts: FACTS() },
  'gf-uncertain-no-diagnostics-escalate': { ...TASK, worker: W(), acceptance: acc('uncertain'), authority: AUTH({ diagnostics: undefined }), facts: FACTS() },
  'gf-incomplete-resume': { ...TASK, worker: W(), acceptance: acc('incomplete', ['add test for reset()', 'update docs']), authority: AUTH(), facts: FACTS() },
  'gf-blocked-escalate': { ...TASK, worker: W(), acceptance: acc('blocked'), authority: AUTH(), facts: FACTS() },
  'gf-await-approval-escalate': { ...TASK, worker: W({ state: 'await-approval' }), authority: AUTH(), facts: FACTS() },
  'gf-transient-backoff': { ...TASK, worker: W(), diagnosis: { causeClass: 'transient-endpoint', confidence: 0.9, evidenceRefs: ['ev-tail-1'] }, authority: AUTH(), facts: FACTS() },
  'gf-transient-ambiguous-i5': { ...TASK, worker: W(), ambiguousExternalEffect: true, ownershipProvable: true, diagnosis: { causeClass: 'transient-endpoint', confidence: 0.9 }, authority: AUTH(), facts: FACTS() },
  'gf-premature-stop-resume': { ...TASK, worker: W(), acceptance: acc('incomplete', ['finish wiring exports']), diagnosis: { causeClass: 'premature-stop', confidence: 0.8 }, authority: AUTH(), facts: FACTS() },
  'gf-task-defect-repair-authorized': { ...TASK, worker: W(), diagnosis: { causeClass: 'task-defect', confidence: 0.85, evidenceRefs: ['ev-gate-3'] }, repairTarget: { paths: ['src/planner/plan.ts'], touchesOutsideAuthority: false, externalEffect: false, installNeeded: false }, authority: AUTH(), facts: FACTS() },
  'gf-task-defect-repair-denied-paths': { ...TASK, worker: W(), diagnosis: { causeClass: 'task-defect', confidence: 0.85 }, repairTarget: { paths: ['/etc/hosts'], touchesOutsideAuthority: false, externalEffect: false, installNeeded: false }, authority: AUTH(), facts: FACTS() },
  'gf-task-defect-repair-external-ungranted': { ...TASK, worker: W(), diagnosis: { causeClass: 'task-defect', confidence: 0.85 }, repairTarget: { paths: ['src/planner/plan.ts'], touchesOutsideAuthority: false, externalEffect: true, installNeeded: false }, authority: AUTH(), facts: FACTS() },
  'gf-change-approach-swap': { ...TASK, worker: W({ state: 'warned' }), lastOutcome: { action: 'nudge', strategyId: 'nudge:progress:v1', progress: 'uptake', progressEvidence: [] }, authority: AUTH({ diagnostics: undefined }), facts: FACTS({ nudgesUsed: 1 }) },
  'gf-change-approach-rewrite-no-pool': { ...TASK, worker: W({ state: 'warned' }), lastOutcome: { action: 'nudge', strategyId: 'nudge:progress:v1', progress: 'uptake', progressEvidence: [] }, authority: AUTH({ models: [], diagnostics: undefined }), facts: FACTS({ nudgesUsed: 1, otherApprovedModels: [] }) },
  'gf-investigate-cap-tools-escalate': { ...TASK, worker: W({ state: 'warned', sameGuardFires: 2 }), authority: AUTH(), facts: FACTS({ nudgesUsed: 1, diagnosticToolCallsUsed: 10 }) },
  'gf-swap-repeat-next-model': { ...TASK, worker: W({ state: 'warned' }), lastOutcome: { action: 'nudge', strategyId: 'nudge:progress:v1', progress: 'uptake', progressEvidence: [] }, authority: AUTH({ diagnostics: undefined }), facts: FACTS({ nudgesUsed: 1, strategyUses: { 'swap:model:beta:v1': 2 } }) },
  'gf-uptake-not-progress-loopbreaker': { ...TASK, worker: W({ state: 'tool' }), lastOutcome: { action: 'nudge', strategyId: 'nudge:progress:v1', progress: 'uptake', progressEvidence: [] }, authority: AUTH({ diagnostics: undefined }), facts: FACTS({ nudgesUsed: 1 }) },
  'gf-progress-reset-hold': { ...TASK, worker: W({ state: 'tool' }), lastOutcome: { action: 'nudge', strategyId: 'nudge:progress:v1', progress: 'task-relevant', progressEvidence: ['ev-progress-7'] }, authority: AUTH(), facts: FACTS({ nudgesUsed: 1 }) },
  'gf-guard-recurrence-no-nudge': { ...TASK, worker: W({ state: 'warned', sameGuardFires: 2 }), authority: AUTH(), facts: FACTS({ nudgesUsed: 1 }) },
  'gf-repeated-strategy-escalate': { ...TASK, worker: W({ state: 'warned', sameGuardFires: 2 }), authority: AUTH(), facts: FACTS({ nudgesUsed: 1, strategyUses: { 'investigate:bounded:v1': 2, 'swap:model:beta:v1': 2, 'swap:model:gamma:v1': 2, 'rewrite:task:v1': 1 } }) },
  'gf-budget-exhausted-escalate': { ...TASK, worker: W(), acceptance: acc('incomplete', ['more work']), authority: AUTH(), facts: FACTS({ attemptsUsed: 3 }) },
  'gf-budget-live-ownership-unprovable-park': { ...TASK, worker: W({ state: 'tool' }), ownershipProvable: false, recoveryBudget: { maxEpisodeRecoveryUsd: 1 }, authority: AUTH(), facts: FACTS({ recoveryUsdUsed: 5 }) },
  'gf-first-guard-fire-nudge': { ...TASK, worker: W({ state: 'warned', sameGuardFires: 1 }), authority: AUTH(), facts: FACTS({ nudgesUsed: 0 }) },
  'gf-bad-input-identity': { ...TASK, taskId: '', worker: W(), authority: AUTH(), facts: FACTS() },
  'gf-unknown-state-investigate': { ...TASK, worker: W({ state: 'unknown' }), authority: AUTH(), facts: FACTS() },
  'gf-dead-assessment-ignored': { ...TASK, worker: W({ state: 'thinking' }), acceptance: acc('complete', [], false), authority: AUTH(), facts: FACTS() },
  'gf-hold-healthy-worker': { ...TASK, worker: W({ state: 'thinking' }), authority: AUTH(), facts: FACTS() },
  'gf-ambiguous-external-ownership-unprovable-park': { ...TASK, worker: W(), ambiguousExternalEffect: true, ownershipProvable: false, authority: AUTH(), facts: FACTS() },
  'gf-malformed-hostile-input': { ...TASK, worker: W(), acceptance: { live: true, assessment: { verdict: 'complete', remainingWork: 'not-an-array', reasons: null, taskId: 'WRONG', taskRevision: 99 } }, diagnosis: { causeClass: 'not-a-real-cause' }, facts: FACTS({ attemptsUsed: -5 }), authority: AUTH(), ownershipProvable: false, __hostileGetters: ['recoveryBudget', 'repairTarget'] },
  'gf-advice-not-authority': { ...TASK, worker: W(), diagnosis: { causeClass: 'unknown', confidence: 0.5, proposedActions: [{ rung: 5, action: 'kill' }, { rung: 2, action: 'investigate', strategyId: 'investigate:bounded:v1' }], evidenceRefs: ['ev-diag-9'] }, authority: AUTH(), facts: FACTS() },
  'gf-diagnosis-live-worker-falls-through': { ...TASK, worker: W({ state: 'thinking' }), diagnosis: { causeClass: 'transient-endpoint', confidence: 0.95 }, authority: AUTH(), facts: FACTS() },
  'gf-failed-steer-no-uptake': { ...TASK, worker: W({ state: 'tool' }), lastOutcome: { action: 'nudge', strategyId: 'nudge:progress:v1', progress: 'none', progressEvidence: [] }, authority: AUTH(), facts: FACTS({ nudgesUsed: 1 }) },
  'gf-stale-assessment-invalid-ignored': { ...TASK, worker: W({ state: 'thinking' }), acceptance: { live: true, assessment: { verdict: 'complete', remainingWork: [], reasons: [], taskId: 'task-1', taskRevision: 2 } }, authority: AUTH(), facts: FACTS() },
  // Cycle-1 audit regressions (docs/14 §12 amendments 11–18):
  'gf-failed-steer-ended-worker': { ...TASK, worker: W({ state: 'stopped' }), lastOutcome: { action: 'nudge', strategyId: 'nudge:progress:v1', progress: 'none', progressEvidence: [] }, authority: AUTH(), facts: FACTS({ nudgesUsed: 1 }) },
  'gf-repair-denied-traversal': { ...TASK, worker: W(), diagnosis: { causeClass: 'task-defect', confidence: 0.85 }, repairTarget: { paths: ['src/../outside.ts'], touchesOutsideAuthority: false, externalEffect: false, installNeeded: false }, authority: AUTH({ paths: ['src/**'], notPaths: ['src/private/**'] }), facts: FACTS() },
  'gf-repair-notpath-traversal-defeats-target': { ...TASK, worker: W(), diagnosis: { causeClass: 'task-defect', confidence: 0.85 }, repairTarget: { paths: ['src/public/../private/key.ts'], touchesOutsideAuthority: false, externalEffect: false, installNeeded: false }, authority: AUTH({ paths: ['src/**'], notPaths: ['src/private/**'] }), facts: FACTS() },
  'gf-assessment-missing-fields-ignored': { ...TASK, worker: W({ state: 'thinking' }), acceptance: { live: true, assessment: { verdict: 'complete', taskId: 'task-1', taskRevision: 1 } }, authority: AUTH(), facts: FACTS() },
  'gf-repair-corrupt-flags-restrict': { ...TASK, worker: W(), diagnosis: { causeClass: 'task-defect', confidence: 0.85 }, repairTarget: { paths: ['src/planner/plan.ts'], touchesOutsideAuthority: 'yes', externalEffect: 'yes', installNeeded: 'yes' }, authority: AUTH(), facts: FACTS() },
  'gf-budget-corrupt-caps-engage': { ...TASK, worker: W(), acceptance: acc('incomplete', ['more work']), recoveryBudget: { maxAttemptsPerTask: 'x', maxEpisodeRecoveryUsd: 'x', maxEpisodeRecoveryTurns: null }, authority: AUTH(), facts: FACTS({ attemptsUsed: 0 }) },
  'gf-rewrite-zero-repeat-veto': { ...TASK, worker: W({ state: 'warned' }), lastOutcome: { action: 'nudge', strategyId: 'nudge:progress:v1', progress: 'uptake', progressEvidence: ['ev-x'] }, recoveryBudget: { maxStrategyRepeats: 0 }, authority: AUTH({ models: [], diagnostics: undefined }), facts: FACTS({ nudgesUsed: 1, otherApprovedModels: [], strategyUses: { 'rewrite:task:v1': 0 } }) },
  'gf-advice-fingerprint-vocabulary': { ...TASK, worker: W(), diagnosis: { causeClass: 'unknown', confidence: 0.5, proposedActions: [{ rung: 2, action: 'nudge', strategyId: 'arbitrary-unversioned-text' }, { rung: 3, action: 'model-swap', strategyId: 'swap:model:beta:v1' }], evidenceRefs: ['ev-diag-10'] }, authority: AUTH(), facts: FACTS() },
  // F10: episode-spend / episode-turn boundary semantics (§3).
  'gf-budget-usd-just-below': { ...TASK, worker: W(), acceptance: acc('incomplete', ['more work']), recoveryBudget: { maxEpisodeRecoveryUsd: 1 }, authority: AUTH(), facts: FACTS({ recoveryUsdUsed: 0.999 }) },
  'gf-budget-usd-at-cap': { ...TASK, worker: W(), acceptance: acc('incomplete', ['more work']), recoveryBudget: { maxEpisodeRecoveryUsd: 1 }, authority: AUTH(), facts: FACTS({ recoveryUsdUsed: 1 }) },
  'gf-budget-turns-just-below': { ...TASK, worker: W(), acceptance: acc('incomplete', ['more work']), recoveryBudget: { maxEpisodeRecoveryTurns: 5 }, authority: AUTH(), facts: FACTS({ recoveryTurnsUsed: 4 }) },
  'gf-budget-turns-at-cap': { ...TASK, worker: W(), acceptance: acc('incomplete', ['more work']), recoveryBudget: { maxEpisodeRecoveryTurns: 5 }, authority: AUTH(), facts: FACTS({ recoveryTurnsUsed: 5 }) },
  'gf-budget-episode-caps-absent': { ...TASK, worker: W(), acceptance: acc('incomplete', ['more work']), authority: AUTH(), facts: FACTS({ recoveryUsdUsed: 100000, recoveryTurnsUsed: 90000 }) },
  // Cycle-2 audit regressions (docs/14 §12 amendments 19–26):
  'gf-c3-ledger-missing-maxed': { ...TASK, worker: W(), acceptance: acc('uncertain'), authority: AUTH(), facts: (() => { const { strategyUses: _drop, ...rest } = FACTS(); return rest; })() },
  'gf-c4-corrupt-notpaths-denied': { ...TASK, worker: W(), diagnosis: { causeClass: 'task-defect', confidence: 0.85 }, repairTarget: { paths: ['src/private/key.ts'], touchesOutsideAuthority: false, externalEffect: false, installNeeded: false }, authority: AUTH({ notPaths: 'src/private/**' }), facts: FACTS() },
  'gf-c6-prototype-named-advice': { ...TASK, worker: W(), diagnosis: { causeClass: 'unknown', confidence: 0.5, proposedActions: [{ rung: 2, action: 'constructor' }, { rung: 2, action: '__proto__' }], evidenceRefs: ['ev-diag-11'] }, authority: AUTH(), facts: FACTS() },
  'gf-c7-refs-cannot-upgrade-failed-steer': { ...TASK, worker: W({ state: 'stopped' }), lastOutcome: { action: 'nudge', strategyId: 'nudge:progress:v1', progress: 'none', progressEvidence: ['ev-unverified'] }, authority: AUTH(), facts: FACTS({ nudgesUsed: 1 }) },
  'gf-c8-nudge-ceiling-binding': { ...TASK, worker: W({ state: 'warned', sameGuardFires: 1 }), recoveryBudget: { maxNudgesPerTask: 99 }, authority: AUTH(), facts: FACTS({ nudgesUsed: 2 }) },
  // Cycle-3 audit regressions (docs/14 §12 amendments 27–33) — the
  // JSON-serializable cases; adversarial shapes (defineProperty, class
  // instances, alternating getters) are pinned by named unit tests
  // C3-F1..F7 in test/planner.test.ts instead.
  'gf-c3f1-array-assessment-rejected': { ...TASK, worker: W({ state: 'stopped' }), acceptance: { live: true, assessment: [] }, authority: AUTH(), facts: FACTS() },
  'gf-c3f5-corrupt-repair-paths-denied': { ...TASK, worker: W(), diagnosis: { causeClass: 'task-defect', confidence: 0.85 }, repairTarget: { paths: ['src/a.ts', 42], touchesOutsideAuthority: false, externalEffect: false, installNeeded: false }, authority: AUTH(), facts: FACTS() },
  'gf-c3f7-warned-steer-no-uptake': { ...TASK, worker: W({ state: 'warned' }), lastOutcome: { action: 'nudge', strategyId: 'nudge:progress:v1', progress: 'none' }, authority: AUTH({ diagnostics: undefined, models: [] }), facts: FACTS() },
  'gf-c3f7-warned-uptake-not-progress': { ...TASK, worker: W({ state: 'warned' }), lastOutcome: { action: 'nudge', strategyId: 'nudge:progress:v1', progress: 'uptake' }, authority: AUTH({ diagnostics: undefined, models: [] }), facts: FACTS() },
  'gf-c3f7-recurrence-names-failed-steer': { ...TASK, worker: W({ state: 'warned', sameGuardFires: 2 }), lastOutcome: { action: 'nudge', strategyId: 'nudge:progress:v1', progress: 'none' }, authority: AUTH({ diagnostics: undefined, models: [] }), facts: FACTS() },
  // Cycle-4 audit regressions (docs/14 §12 amendments 34–38) — the
  // JSON-serializable cases; TOCTOU getter shapes (C4-F1/F2) are pinned
  // by named unit tests C4-F1..F2 in test/planner.test.ts.
  'gf-c4f4-transient-unprovable-investigate': { ...TASK, worker: W(), diagnosis: { causeClass: 'transient-endpoint', confidence: 0.9 }, ownershipProvable: false, authority: AUTH(), facts: FACTS() },
  'gf-c4f4-live-all-blocked-park': { ...TASK, worker: W({ state: 'tool' }), lastOutcome: { action: 'nudge', strategyId: 'nudge:progress:v1', progress: 'none', progressEvidence: [] }, ownershipProvable: false, authority: AUTH({ diagnostics: undefined }), facts: FACTS({ nudgesUsed: 1 }) },
  'gf-c4f5-resume-veto-visible': { ...TASK, worker: W(), acceptance: acc('incomplete', ['finish the exports']), facts: FACTS({ strategyUses: { 'resume:evidence:v1': 2 } }) },
};

for (const [name, inputRaw] of Object.entries(cases)) {
  const input = inputRaw;
  const hostile = input.__hostileGetters;
  // For hostile fixtures, apply the getters BEFORE deriving expectations,
  // so the fixture pins the PC1 bottom-out (bad-input), not the naive path.
  const probe = { ...input };
  delete probe.__hostileGetters;
  for (const key of hostile ?? []) {
    Object.defineProperty(probe, key, { get() { throw new Error('hostile getter'); } });
  }
  const rec = planRecovery(probe);
  const fixture = {
    name, input,
    expected: {
      decision: rec.decision, action: rec.action, strategyId: rec.strategyId,
      rationaleIncludes: rec.rationale,
      forbidActions: ['kill', 'merge'],
      ...(rec.model !== undefined ? { model: rec.model } : {}),
      ...(rec.remainingWork !== undefined ? { remainingWork: rec.remainingWork } : {}),
      ...(rec.alternatives.length > 0 ? { alternativesInclude: rec.alternatives } : {}),
    },
  };
  writeFileSync(`test/fixtures/planner/${name}.json`, JSON.stringify(fixture, null, 2) + '\n');
  console.log(name.padEnd(46), rec.decision.padEnd(15), rec.action.padEnd(22), JSON.stringify(rec.rationale));
}
