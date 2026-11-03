# P10 — Evidence classification & recovery planner (contract & as-built surface)

> Status: CONTRACT (drafted 2026-11-04, implemented 2026-11-04). Module:
> `src/planner/plan.ts`. Consumed by P9/M1 composition; its output is a
> *recommendation* checked by P8 and executed by P11 (docs/11 §11.1 P10 row).
> Parent plan: docs/11 §11.1 P10 row, §9 ladder + hygiene (binding on the
> rule engine), §9.1 self-healing policy, §13.2 I3/I5/I7.

## 0. Purpose & boundary

P10 answers exactly one question: **given the persisted evidence, the P14
acceptance assessment, a validated P15 diagnosis (if any), the episode
authority, and the ledger facts, which recovery recommendation follows —
`finish | continue | investigate | repair | change-approach | escalate`?**

Normative source sentences (docs/11):

- P10 row: "Pure functions combine persisted evidence, P14 assessments,
  validated P15 diagnoses, authority, and ledger facts into
  finish/continue/investigate/repair/change-approach/escalate
  recommendations. No model calls or side effects here; recommendations
  are checked by P8 and executed by P11. Golden fixtures cover uptake
  versus progress and repeated-strategy detection."
- §9.1: "interruption → reconcile execution → evaluate acceptance → finish
  | continue | investigate | repair | change approach | escalate → verify
  task-relevant progress → continue or revise recovery."
- §9: "Choose the least disruptive action supported by evidence."
- §9 hygiene (binding): ≤2 rung-1 nudges per task; uptake ≠ progress (R3);
  same guard ≥2 fires across respawns → no blind same-strategy retry;
  budgets span attempts (I7); steer-induced guard resets count.
- §9.1: "**Authority is granted upfront, not invented during recovery.** …
  absent permission they are not automatic repairs. Model output is
  untrusted advice at this boundary."
- "Escalate only when new authority or a consequential human intent
  decision is needed, external effects remain unsafe to reconcile, an
  external blocker requires human action, or bounded recovery is exhausted
  without a useful safe next step."

Boundary rules (what P10 is NOT):

1. **Pure.** No model calls, no I/O, no subprocesses, no clock reads, no
   randomness. `now` is injected (P14's EV11 pattern). Same input →
   byte-identical output (determinism lets P8/P11 replay a plan decision).
2. **Not a permission.** The recommendation is advice: P8 re-checks it
   against the live ledger and authority (§11.2 "accounting below
   judgment"), P11 executes. A plan that P8 denies changes nothing here.
3. **Not a graph writer.** P10 returns a recommendation; the supervisor
   persists it as an S5 `decision-intent` (§14.3) — the planner itself
   touches no journal (the P4 writer stays exclusive).
4. **Not an executor.** Backoff timing, kill, resume argv, steer files,
   diagnostic dispatch: all P11/P7 mechanics. P10 chooses the action and
   its strategy fingerprint, nothing else.
5. **Never weakens acceptance or guards** (§9.1). The planner consumes the
   P14 verdict; it may not re-interpret, downgrade, or "make allowance"
   for it. A `complete` verdict from a LIVE assessment is the only
   evidence that can produce `finish`; the planner never infers
   completion from anything else (activity, exit code, claims).
6. **Self-contained compartment** (the P14/P8 pattern): `src/planner/`
   imports NOTHING from the repo at runtime (structural input types
   mirror the sibling modules' shapes); nothing outside `src/planner/`
   imports it until P9 wires it. Pinned by guard tests (§10).

## 1. Inputs (structural mirrors — P15 is a typed contract accepting stubs)

P15 is not implemented yet. Per the P10 row, the planner consumes
*validated* P15 diagnoses; "validated" at this stage means: the planner
receives a `DiagnosisFact` structurally mirroring the §14.3
`DiagnosisRecord` payload (src/episode/journal.ts), and re-validates it
defensively — a malformed or out-of-enum diagnosis is DROPPED (advice,
not authority), never obeyed and never a crash. When P15 lands, its
produced records must satisfy exactly this interface; nothing in P10
changes.

```ts
interface PlannerInput {
  taskId: string;
  taskRevision: number;             // §14.4 integer ≥ 1
  // ── persisted evidence (P1/S1 + P5 §14.8 projection) ──────────────
  worker: {
    state: "thinking" | "tool" | "await-approval" | "warned"
         | "stopped" | "dead" | "unknown";   // WORKER_STATES, closed
    detail?: string;
    // facts from WorkerStateEvidence the rules need (caller-projected):
    warnCount: number;              // persisted warns observed (this attempt)
    sameGuardFires: number;         // SAME guard fired across respawns (I7)
    toolCallsThisAttempt: number;
  };
  lastOutcome?: {                   // latest decision-outcome (§14.3)
    action: SupervisorAction;       // what was last tried
    strategyId: string;
    progress: "none" | "uptake" | "task-relevant";
    progressEvidence?: string[];    // refs of task-relevant evidence since
  };
  // ── P14 acceptance (docs/13) — live assessment only ───────────────
  acceptance?: {
    live: boolean;                  // caller ran isStale(); false ⇒ ignored
    assessment: {                   // AcceptanceAssessment (structural)
      verdict: "complete" | "incomplete" | "blocked" | "uncertain";
      remainingWork: string[];
      reasons: string[];
      taskId: string; taskRevision: number;
    };
  };
  // ── P15 diagnosis (validated advice; absent until P15 ships) ──────
  diagnosis?: {
    causeClass: "transient-endpoint" | "premature-stop" | "task-defect"
              | "environment-blocker" | "approval-boundary" | "unknown";
    confidence?: number;            // clamp [0,1]; malformed ⇒ no confidence
    proposedActions?: { rung: number; action: SupervisorAction;
                        strategyId?: string }[];
    evidenceRefs?: string[];
  };
  ambiguousExternalEffect?: boolean;  // I5 latch (P7/P8 reconcile fact)
  ownershipProvable?: boolean;        // I1: false ⇒ never spawn, park-class
  // ── authority & policy (§14.7, granted upfront) ────────────────────
  authority: {
    paths: string[]; notPaths: string[];
    allowInstalls?: boolean; allowNetwork?: boolean;
    allowExternalEffects?: boolean;
    models?: string[];              // approved endpoint ids (model-swap pool)
    diagnostics?: { maxToolCalls: number; maxUsd: number };
  };
  recoveryBudget?: {                // RecoveryBudget, defaults in §3
    maxAttemptsPerTask?: number; maxNudgesPerTask?: number;
    maxStrategyRepeats?: number; maxEpisodeRecoveryUsd?: number;
    maxEpisodeRecoveryTurns?: number;
  };
  // ── ledger facts (P8 snapshot projection for THIS task/episode, I7) ─
  facts: {
    attemptsUsed: number;           // attempts ever started (this task)
    nudgesUsed: number;             // rung-1 actions charged (this task)
    steerGuardResets: number;       // §9: steer-induced guard resets
    strategyUses: Record<string, number>;   // strategyId → uses (task scope)
    recoveryUsdUsed: number; recoveryTurnsUsed: number;
    diagnosticToolCallsUsed: number; diagnosticUsdUsed: number;
    otherApprovedModels: string[];  // approved models not yet tried
  };
  repairTarget?: {                  // required for a `repair` candidate
    paths: string[];                // files the diagnosis implicates
    touchesOutsideAuthority?: boolean;
    externalEffect?: boolean;       // repair would leave the worktree
    installNeeded?: boolean;        // repair needs a dependency install
  };
  now: number;                      // injected clock (interface parity with
                                    // P14 EV11); NO v1 rule reads it —
                                    // backoff timing is P11 mechanics
}
```

Input hygiene (mirrors P14 AC5): `planRecovery()` **never throws**. A
hostile or malformed input (throwing getters, non-array `paths`, NaN
counts, prototype-polluted records) is handled by a validation pass:
missing required numbers default to the FAIL-CLOSED value (0 available
budget / maxed usage), unknown enum strings make the dependent candidate
ineligible, and an input whose *identity* fields (taskId / taskRevision /
worker.state) are unusable yields the §2 ladder's bottom rung —
`escalate` with rationale `bad-input` — because acting on evidence the
planner cannot parse is exactly the "inference from silence" (I3) the
system forbids.

## 2. Output & the decision ladder

```ts
type RecoveryDecision =
  | "finish" | "continue" | "investigate" | "repair"
  | "change-approach" | "escalate";

interface PlanRecommendation {
  decision: RecoveryDecision;
  /** §14.3/§9 action; "hold" is the pinned non-action sentinel (§2.0). */
  action: SupervisorAction | "hold";
  rung: number;                     // 0 (none) | 1–5, consistent with action
  sideEffect: "none" | "worktree-local" | "external";
  strategyId: string;               // fingerprint for P8 repeat limits (§4)
  rationale: string[];              // machine codes, ordered, ladder-visible
  evidenceRefs: string[];           // copied, never invented (§8/I3: S7 refs)
  expectedEvidence?: string;        // §14.3 field for the intent record
  remainingWork?: string[];         // from the live assessment, verbatim
  alternatives: { decision: RecoveryDecision; action: SupervisorAction | "hold";
                  strategyId: string; veto: string }[];  // ranked, with the
                                        // rule that vetoed each — P13 context
  model?: string;                   // model-swap target (validated pool)
  authorityNeeded: "none" | "worktree-local" | "external";
  notAPermission: true;             // structural reminder (P8 re-checks)
}
```

**§2.0 `hold` sentinel.** `action: "hold"` (rung 0, sideEffect none) means
"evidence supports NO intervention — let the run proceed." It is NOT a
member of `SUPERVISOR_ACTIONS`, and that is the point: by the §14.3 rule
("no action executes whose type is not in this enum") a `hold` can never
be executed even if a buggy executor receives it. P11 treats it as a
no-op. It exists because a healthy worker still needs a total planner
answer; the alternative (forcing a nudge) would violate "least disruptive
action supported by evidence" and mint interventions from nothing. A
docs/11 Change Ledger row accompanies P9 wiring; the sentinel ships here
so golden fixtures can pin the no-intervention case.

### The ladder (TOTAL order; first match wins; every rule appends rationale)

Deterministic, evidence-ranked — the recovery-loop sentence of §9.1 as
code. "live complete" means `acceptance.live === true` with a structurally
valid assessment.

| # | condition | decision / action | rationale codes |
|---|-----------|--------------------|-----------------|
| L0 | identity fields unusable (bad-input) | escalate | `bad-input` |
| L1 | live `complete` verdict | finish / accept-finish (rung 0, none) | `verdict:complete` |
| L2 | `ambiguousExternalEffect === true` (I5) | escalate (park-class if ownershipProvable === false → park) | `i5:ambiguous-external-effect` |
| L3 | live `blocked` verdict, or diagnosis `approval-boundary` (confident), or worker `await-approval` | escalate | `verdict:blocked` / `approval-boundary` |
| L4 | recovery budget exhausted (attempts OR episode usd/turns — §3 caps) | escalate; `park` if worker still live and ownership not provable, else plain escalate | `budget:<cap>` |
| L5 | live `uncertain` verdict | investigate (§5 rules) | `verdict:uncertain` |
| L6 | diagnosis-driven recovery (validated diagnosis AND worker ended — `stopped`/`dead`; a LIVE worker's cause is not yet evidence-complete, I3 — fall through to L8–L10) | continue / investigate / repair / change-approach / escalate | `cause:<causeClass>` |
| L7 | live `incomplete` verdict, worker ended (stopped/dead) | continue / evidence-nudge-resume with verbatim remainingWork | `resume:evidence` |
| L8 | worker `warned` (live) or last outcome progress ≠ task-relevant after a steer | §9 uptake/loop rules (§6) | `uptake-not-progress`, `guard:recurrence` |
| L9 | worker live & healthy (`thinking`/`tool`) and nothing above fired | continue / **hold** | `no-intervention-warranted` |
| L10 | `unknown` worker state with no distinguishing signal (never L9 — PC7) | investigate if diagnostics remain, else escalate | `i3:silence` |
| L11 | structural fallback (worker `await-approval`/`stopped`/`dead` with no verdict, no diagnosis, no loop facts — e.g. no assessment was ever produced) | investigate if diagnostics remain, else escalate | `no-acceptance-evidence` |

**L6 diagnosis table** (only *validated* diagnoses reach here; §1):

| causeClass | recommended | fallbacks (in order) |
|------------|-------------|----------------------|
| transient-endpoint | continue / backoff-retry (rung 2) — **only when `ambiguousExternalEffect` is false (I5)** and attempts remain | investigate → escalate |
| premature-stop | continue / evidence-nudge-resume (rung 2) with acceptance remainingWork (or generic if none) | change-approach → escalate |
| task-defect | repair (rung 2, worktree-local) **only if §5 authority gate passes**; else investigate if diagnostics remain | change-approach → escalate |
| environment-blocker | escalate when confident (confidence ≥ 0.7) — human action needed | investigate when unconfident → escalate |
| approval-boundary | escalate (handled at L3 when confident) | investigate when unconfident |
| unknown | investigate (bounded) | escalate |

A diagnosis `proposedActions` list is **advice ranking only**: each
proposed action that is *not* the ladder's own recommendation for that
causeClass appears in `alternatives` with veto `advice-not-authority`
if the planner's evidence rules disqualify it. Model output never
promotes itself into execution (§9.1).

## 3. Budgets & caps (defaults pinned here; policy overrides)

`RecoveryBudget` fields (journal §14.7) get planner defaults when absent
— the "P0 pins exact policy fields and default limits" obligation is met
at this boundary; a stricter policy value always wins:

| field | default | meaning |
|-------|---------|---------|
| maxAttemptsPerTask | 3 | attempts ever STARTED for the task (I7: spans respawns/swaps/restarts — counted from ledger `attemptsUsed`) |
| maxNudgesPerTask | 2 | §9 binding: ≤2 rung-1 nudges per episode per task |
| maxStrategyRepeats | 2 | a strategyId at `>= max` uses is PROHIBITED (§9: same guard ≥2 → no blind same-strategy retry) |
| maxEpisodeRecoveryUsd | no cap | absence = no cap, still charged (I7 backstop stays with P8) |
| maxEpisodeRecoveryTurns | no cap | same |

Exhaustion test at L4 uses ONLY the facts as given (the planner does not
reserve — P8 reserves; the planner refuses the *next* act when the cap is
already reached). `steerGuardResets` counts against `maxNudgesPerTask`
(§9: "Steer-induced guard resets count… otherwise external nudges keep
unproductive workers alive").

Diagnostic cap (L5/L6 investigate): investigation is ineligible when
`diagnosticToolCallsUsed >= authority.diagnostics.maxToolCalls` OR
`diagnosticUsdUsed >= authority.diagnostics.maxUsd` (no `diagnostics`
grant ⇒ investigation NOT permitted — absence of authority is not
permission).

## 4. Strategy fingerprints (repeated-strategy detection)

Every recommendation carries a versioned strategyId built from a CLOSED
template table (no free-text — P8 counts exact ids):

| action | strategyId template |
|--------|--------------------|
| nudge | `nudge:progress:v1` |
| evidence-nudge-resume | `resume:evidence:v1` |
| backoff-retry | `retry:transient:v1` |
| investigate | `investigate:bounded:v1` |
| repair | `repair:task-local:v1` |
| model-swap | `swap:model:<modelId>:v1` (one fingerprint per target) |
| task-rewrite | `rewrite:task:v1` |
| escalate | `escalate:v1` (never repeat-limited — see below) |
| park | `park:v1` |
| accept-finish | `accept:finish:v1` |
| hold | `hold:v1` |

**Repeat rule (PR-S):** a candidate action is ineligible when
`facts.strategyUses[template] >= maxStrategyRepeats`. `escalate`, `park`,
`accept-finish`, and `hold` are EXEMPT (escalation must never be
vetoed-looped into silence; finishing and holding are not interventions
against the loop budget). The ladder then tries the next-supported action;
**when every supported intervention is repeat-vetoed, the answer is
escalate** with the vetoed list in `alternatives` — this is the
repeated-strategy detection the P10 row demands, and it is the only exit:
"repeated generic nudges are not healing" (P15 row) and "no blind
same-strategy retry" (§9).

Near-duplicate nudge text (§9 hygiene) is enforced structurally by
fingerprint identity: the same nudge template *is* the same strategy, so
the repeat cap blocks textual repeats without any semantic comparison —
deliberately mechanical (a model checking text similarity would be model
judgment above the authority line).

## 5. Authority gate for `repair` (absence of authority is not permission)

`repair` is eligible only if ALL hold:

1. A live diagnosis of `task-defect` (or `premature-stop` repair is NOT
   eligible — repair targets defects, not stops) supports it;
2. `repairTarget.paths` is non-empty and every path resolves (lexically,
   `notPaths` first) INSIDE `authority.paths` and outside
   `authority.notPaths`;
3. `repairTarget.touchesOutsideAuthority !== true` and
   `repairTarget.externalEffect !== true` OR
   `authority.allowExternalEffects === true` (shared-environment changes
   need explicit policy — §9.1);
4. installs inside the repair require `authority.allowInstalls === true`
   (repairTarget.installNeeded);
5. the strategy repeat check (§4) passes.

Failure of (2)/(3)/(4) appends rationale `authority:denied:<which>` and
demotes the ladder (investigate → change-approach → escalate). `repair`
rung: 2 (worktree-local); with `externalEffect` + authority: rung 3,
sideEffect `external`, authorityNeeded `external` (docs/11: repair rung
"2–3 by authority").

## 6. Uptake versus progress (R3) — the loop-breaker rule

Input facts: `lastOutcome.progress` as recorded by P11's outcome record
(§14.3 three claims: recorded ≠ available ≠ followed — I6).

- Last action was `nudge` or `evidence-nudge-resume` with recorded
  progress **"uptake"** (steer consumed) and NO task-relevant evidence
  since → a second same-template action is repeat-vetoed (§4); the ladder
  escalates *through* the loop-breaker: investigate (if diagnostics
  remain) → model-swap (if `otherApprovedModels` non-empty and
  swap-eligibility holds) → task-rewrite (budget permitting) → escalate.
  Rationale chain includes `uptake-not-progress`.
- `warned` worker (live, guard fired): the FIRST fire may earn one
  `nudge` if `nudgesUsed + steerGuardResets < maxNudgesPerTask`; the
  SECOND same-guard fire across respawns (`sameGuardFires >= 2`)
  PROHIBITS any further nudge (§9) → investigate/swap/escalate path with
  `guard:recurrence`.
- Progress evidence "task-relevant" after a recovery action RESETS the
  loop expectation: the planner treats the worker as healthy (L9 hold)
  unless a live verdict disagrees. (Fixtures pin both directions.)

## 7. Change-approach rules

`model-swap` (rung 3) requires: `authority.models` present (swap pool =
approved endpoints), `facts.otherApprovedModels` non-empty (a pool member
not yet tried), and attempts remain. Target = the first remaining
approved model in INPUT ORDER (deterministic; no preferences invented).
Rationale `swap:pool`.

`task-rewrite` (rung 4) is eligible when a materially different strategy
is required (loop-breaker or repeated-strategy exhaustion) AND attempts
remain AND rewrite fingerprint unused; it bumps taskRevision — only the
supervisor (P11) actually does that; the plan merely names the action.

`kill` is NOT a planner recommendation (process control is P7/P11
mechanics, and §9 kills only as part of composed rung-2/3 actions);
`merge` belongs to P12's integration contract. The planner's action
vocabulary: the ten it can name (nudge, evidence-nudge-resume,
backoff-retry, investigate, repair, model-swap, task-rewrite, escalate,
park, accept-finish) plus the `hold` sentinel. (`merge`/`kill` appear
never.)

## 8. Fail-closed floor & purity invariants

- **PC1 never-throws** (AC5 mirror): §1 hygiene; output always produced.
- **PC2 deterministic**: same input → deep-equal output; array outputs in
  fixed rule order; no `Date.now()`/`Math.random()`/env/imports-of-life.
- **PC3 no permission**: `notAPermission: true` always; every field the
  plan carries is derived from INPUTS (evidenceRefs copied, never
  invented — an empty refs list stays empty, I3/S7).
- **PC4 verdict integrity**: a dead (stale/unvalidated) assessment is
  IGNORED entirely (not partially trusted); `finish` requires a live
  `complete` — no other input, combination, or diagnosis can produce
  `finish`.
- **PC5 escalate-safe**: escalation can never be vetoed (§4 exemption);
  every veto path bottoms out at escalate/park, so the ladder is total.
- **PC6 authority monotone**: granting MORE authority never makes the
  planner LESS able to escalate; granting LESS never enables
  repair/swap/diagnose.
- **PC7 unknown worker state is never treated as healthy**: `unknown`
  never reaches L9 hold (I3 — silence is not thinking); it routes to
  L10.

## 9. Golden fixtures (test/fixtures/planner/)

JSON fixtures `{name, input, expected}` run by test/planner.test.ts —
`expected` pins decision/action/strategyId plus required rationale codes
and forbidden actions. Coverage per the P10 row and this contract:

| fixture | pins |
|---------|------|
| gf-finish-complete | L1: live complete → accept-finish |
| gf-uncertain-investigate | L5 with diagnostics authority |
| gf-uncertain-no-diagnostics-escalate | absence of authority |
| gf-incomplete-resume | L7 with verbatim remainingWork |
| gf-blocked-escalate | L3 |
| gf-await-approval-escalate | L3 live approval block |
| gf-transient-backoff | L6 transient-endpoint + attempts remain |
| gf-transient-ambiguous-i5 | I5 latch overrides backoff → escalate |
| gf-premature-stop-resume | L6 |
| gf-task-defect-repair-authorized | repair eligibility §5 full pass |
| gf-task-defect-repair-denied-paths | `authority:denied:paths` |
| gf-task-defect-repair-external-ungranted | §5(3) |
| gf-change-approach-swap | loop-breaker model-swap with pool validation |
| gf-change-approach-rewrite-no-pool | swap ineligible → rewrite |
| gf-uptake-not-progress-loopbreaker | §6 fixture (the P10 row special) |
| gf-progress-reset-hold | task-relevant progress → hold |
| gf-guard-recurrence-no-nudge | second same-guard fire prohibits nudge |
| gf-repeated-strategy-escalate | all interventions repeat-vetoed → escalate |
| gf-budget-exhausted-escalate | attempts cap reached |
| gf-unknown-state-investigate | PC7/I3 |
| gf-dead-assessment-ignored | PC4 (stale complete does NOT finish) |
| gf-hold-healthy-worker | L9 |
| gf-ambiguous-external-ownership-unprovable-park | L2 park branch |
| gf-malformed-hostile-input | PC1 (throwing getters etc. → escalate/bad-input) |
| gf-advice-not-authority | diagnosis proposes `kill` → vetoed alternative, ladder answer stands |
| gf-failed-steer-ended-worker | F1: stopped worker + no-progress steer gets the loop-breaker chain, not L11 |
| gf-repair-denied-traversal | F2: `src/../outside.ts` normalizes outside `src/**` → denied |
| gf-repair-notpath-traversal-defeats-target | F2: `src/public/../private/key.ts` normalizes INTO notPaths → denied |
| gf-assessment-missing-fields-ignored | F3: structurally incomplete assessment ⇒ `assessment:invalid`, never finish |
| gf-repair-corrupt-flags-restrict | F4: corrupt restriction flags engage (`authority:denied:external|install`) |
| gf-budget-corrupt-caps-engage | F6: present-invalid caps ⇒ engaged (0) → `budget:attempts` |
| gf-rewrite-zero-repeat-veto | F7: `maxStrategyRepeats:0` vetoes task-rewrite even unused |
| gf-advice-fingerprint-vocabulary | F9: free-text advice strategyId ⇒ template/`""` (closed vocabulary) |
| gf-budget-usd-just-below / gf-budget-usd-at-cap | F10: episode-spend refuses exactly at cap |
| gf-budget-turns-just-below / gf-budget-turns-at-cap | F10: episode-turns refuses exactly at cap |
| gf-budget-episode-caps-absent | F10: absent USD/turn caps mean NO cap (huge usage acts) |

## 10. Compartment guards (mirrors AC9)

- Nothing outside `src/planner/` imports the module (positive fixtures
  for every import shape, same extractor as acceptance.test.ts).
- `src/planner/` imports nothing in the repo at all (structural types
  only, no `import type` even — the module is self-contained by text).

## 11. Open items / wiring notes for P9

1. `hold` sentinel needs a docs/11 Change Ledger row at P9 wiring (§2.0).
2. P8 may want plans to carry the snapshot they were computed against —
   P11 passes the recommendation + actionId to the P8 gate; no schema
   change here until P8/P9 demand one.
3. "Advanced semantic classifiers can follow M1" (P10 row): everything
   here is mechanical; any future semantic layer enters as *evidence
   facts* (input fields), never as a second decision-maker.

## 12. As-built amendments

Appended at implementation (pre-audit). Codes/behaviors the as-built
`src/planner/plan.ts` pins that refine §2–§7:

1. **Sanitize notes are recorded, not silent.** A dead/invalid
   assessment, invalid diagnosis, or invalid outcome is dropped (PC4)
   AND appends `assessment:dead` / `assessment:invalid` /
   `diagnosis:invalid` / `outcome:invalid` to the rationale — so an
   ignored input is visible in P13 context, not invisible.
2. **Chain fallback codes.** When a chain's steps are all vetoed, the
   escalation carries `repeat-limit` only if EVERY veto was a
   `repeat:*`; otherwise the concrete vetoes are appended as
   `veto:<code>` (an escalation caused by missing authority must not be
   mislabeled as a repeat exhaustion).
3. **`swap:pool`** is appended to the rationale whenever the chain's
   chosen action is `model-swap` (§7 required the code; as-built it
   appears exactly on swap picks, with `model` set to the target).
4. **State codes.** L3's worker-state branch uses `state:await-approval`;
   L8 uses `state:warned` (+ `guard:recurrence` on second fire, +
   `uptake-not-progress` when a failed steer is also on record). A
   failed steer with recorded progress `none` codes `steer-no-uptake`
   (§6 named only the uptake case).
5. **L7 fallbacks.** resume vetoed → investigate → swap → rewrite →
   escalate (the table left L7 fallbacks open; as-built reuses the
   loop-breaker chain).
6. **Veto codes for eligibility**: `budget:nudges`,
   `diagnostics:ungranted|tools|usd`, `swap:no-pool`, `swap:no-target`,
   `repeat:<template>`, `guard:recurrence`, `uptake-not-progress`,
   `steer-no-uptake`.
   Advice vetoes are `advice-not-authority` (§2).
7. **`kill`/`merge` advice** appears ONLY as an `advice-not-authority`
   vetoed alternative, never as a recommendation (fixture
   gf-advice-not-authority pins this).
8. **Corrupted `ambiguousExternalEffect`** (present, non-false) latches
   the I5 interlock fail-closed; only `false`/absent clears it.
9. **Hostile-getter inputs** that make sanitization itself throw bottom
   out at escalate `bad-input` (PC1) — recorded in
   gf-malformed-hostile-input.
10. **`guard: recurrence` nudge prohibition** gates `nudge` AND
    `evidence-nudge-resume` (both are steers; §9's prohibition is on
    steering a recurring guard).

Cycle-1 audit amendments (gpt-6.1-sol, 2026-10-29; findings F1–F10 —
all accepted, fixed with regressions gf-* / named tests):

11. **Closed fingerprint vocabulary (F9).** A `strategyId` in the
    output is ONLY a §4 template or a pool-validated swap fingerprint.
    Advice-carried free text is replaced by the action's template; when
    no closed fingerprint applies (e.g. a vetoed pool-less swap), the
    field is `""` — the empty string means "no fingerprint" and is the
    only non-template value that may appear.
12. **Failed-steer loop-breaker is state-independent (F1).** L8's
    `steer-no-uptake`/`uptake-not-progress` chain applies to any state
    that reaches it (ended workers included); only L9's hold is
    live-only.
13. **Repair containment is lexically normalized (F2).** Targets and
    patterns are normalized (`.`/`..` resolution) before matching;
    forms that escape the root or are unsupported (absolute, backslash,
    empty) never match — deny. A traversal resolving into notPaths is
    denied even though the raw prefix looked inside paths.
14. **Restriction flags fail closed by engaging (F4).** For
    repairTarget `touchesOutsideAuthority`/`externalEffect`/
    `installNeeded`, absent/false ⇒ false, present-and-corrupt ⇒ TRUE
    (the restriction engages). Grants keep the opposite polarity
    (corrupt grant ⇒ false) — §1 fail-closed means a damaged safety
    annotation may never clear itself.
15. **Assessment must be structurally complete (F3).** A live
    assessment missing/mistyped `remainingWork` or `reasons` is
    `assessment:invalid` — dropped entirely (PC4), never a partial
    projection that can reach finish.
16. **Grants are OWN properties only (F5).** Every authority field
    (paths/notPaths/allow*/models/diagnostics, incl. the diagnostics
    sub-fields) is read via hasOwnProperty; a prototype-inherited
    grant is ignored (hostile-records hygiene, §1).
17. **Budget caps: absent ≠ corrupt (F6).** Absent caps take the §3
    default (or no cap); present-but-invalid caps engage at 0 — a
    corrupt cap never restores default/unlimited budget.
18. **PC1 boundary covers finalization (F8).** Sanitized arrays are
    built by index iteration — caller-owned array methods
    (`filter`/`map`/`Symbol.iterator`) are never invoked in the
    planner frame — and finalize/evidence-extraction run inside the
    never-throws boundary, so a post-decision hostile object bottoms
    out at `bad-input` instead of throwing.
19. **Assessment arrays validated by index (C2-F1).** `remainingWork`
    and `reasons` are read by index with `typeof === "string"` per
    element — a poisoned `.every`/iterator on the array can no longer
    pass non-string elements through into a finish; any non-string
    element rejects the whole assessment (`assessment:invalid`).
20. **Authority and facts containers are own, plain properties
    (C2-F2).** The top-level `authority`/`facts` containers are read
    via hasOwnProperty AND prototype plainness (`Object.prototype` or
    null): a container inherited from a prototype chain is treated as
    absent — no inherited grant, no inherited ledger or usage counts.
21. **Strategy ledger fails closed (C3).** A missing, non-object,
    array, or prototype-backed `strategyUses` proves nothing: every
    fingerprint is treated as MAXED, so repeat vetoes fire instead of
    an unproven-usage strategy opening. Only a plain own-object ledger
    counts.
22. **Corrupt authority record disqualifies repair (C4).** Repair
    first checks the record's integrity: malformed/absent `paths` or
    `notPaths` (non-array, array-of-non-strings) means the grant is
    NOT an erasable empty set — repair is denied with
    `authority:denied:authority-record`.
23. **Present-undefined is present (C2-F5).** A budget cap property
    that exists with value `undefined` engages at 0 like any other
    invalid value; only a truly ABSENT property takes the default.
24. **Advice actions validated before table lookup (C6).** A
    diagnosis-proposed `action` must be a member of the closed
    supervisor-action vocabulary before any template/decision table
    is consulted, and table reads are own-property-only — prototype
    names (`constructor`, `__proto__`) can never smuggle Object
    members into the fingerprint vocabulary; unknown actions fall
    back to `escalate`.
25. **Steer progress is the recorded classification (C7).**
    `steerWithoutProgress` is decided by `progress` alone — nonempty
    `progressEvidence` never upgrades a `none`/`uptake` steer to
    progress-bearing, so a failed steer cannot re-arm the same nudge.
26. **Nudge ceiling is binding (C2-F8).** Per docs/11 §9 a task gets
    at most 2 rung-1 nudges: a LOOSER policy `maxNudgesPerTask` is
    clamped to 2; a stricter value still wins.
27. **Nested records must be plain records (C3-F1).** Every container
    read (`worker`, `acceptance`, `assessment`, `diagnosis`,
    `lastOutcome`, `authority`, `diagnostics`, `recoveryBudget`,
    `facts`, `repairTarget`, and each `proposedActions` element) is
    now a PLAIN record — non-null object, not an array, prototype
    `Object.prototype` or `null`. A class instance or
    polluted-prototype container is read as ABSENT (§ hostile
    records), so a crafted prototype chain can never pose as a
    record whose fields are then trusted.
28. **Authority lists are copied, never retained (C3-F2).**
    `paths`/`notPaths` are copied by index at sanitize time
    (`copyStrs`: one read per element, reject on any non-string or
    getter throw) and the caller's array object is never stored in
    `Ctx` — containment checks run against the module-owned copies,
    so a poisoned `.some`/iterator on the caller's list bypasses
    neither the allow list nor the deny list.
29. **Snapshot-once, reject-not-filter (C3-F3).** Assessment fields
    (and the input identity fields) are read exactly once via a
    snapshot (`hasOwnProperty` + one guarded read); required arrays
    are validated AND copied in a single pass. A getter that
    alternates values between a validation read and a use read
    (validate-then-re-read) can neither smuggle a non-string past
    the check nor filter a malformed `remainingWork`/`reasons` into
    a passing `complete` assessment — any corrupt element REJECTS
    the whole assessment (`assessment:invalid`).
30. **Ledger reads every own key (C3-F4).** The strategy-use ledger
    is enumerated with `getOwnPropertyNames` (own, string-keyed —
    including NON-ENUMERABLE properties), not `Object.entries`: a
    hidden non-enumerable own count can no longer mask a saturated
    fingerprint and reopen an exhausted strategy.
31. **Corrupt repair-target element disqualifies repair (C3-F5).**
    `repairTarget.paths` is copied with the reject-not-filter
    single-pass reader: any non-string element (or getter throw)
    makes the WHOLE target unusable — repair is denied
    (`authority:denied:paths`), the planner never repairs a
    "valid subset" of a corrupt target list (§5(2) provenance).
32. **Safety flags are presence-aware (C3-F6).** `restrictFlag` and
    `ambiguousLatch` take (object, key) and test presence with
    `hasOwnProperty`: an own property whose value is `undefined` is
    PRESENT-and-corrupt — the restriction/latch ENGAGES, a damaged
    safety annotation may never clear itself by losing its value.
    Only a truly absent property or explicit `false` clears.
33. **Failed-steer code is computed once, everywhere (C3-F7).**
    `steerFailCode()` derives the rationale code from the recorded
    progress (`none` ⇒ `steer-no-uptake`, `uptake` ⇒
    `uptake-not-progress`) and every branch that routes a failed
    steer appends it — both warned branches included (plain warned
    carries the recorded code, not a fixed `uptake-not-progress`;
    the recurrence branch names a simultaneously-applicable failed
    steer alongside `guard:recurrence`).

Cycle-4 audit amendments (2026-11; findings C4-F1–C4-F5 — all
accepted, fixed with regressions gf-c4f*/named tests):

34. **Snapshot-once everywhere (§ hostile inputs, C4-F1).** Every
    decision-driving field is read exactly ONE time and the value
    that passed validation is the value constructed: `worker.state`
    (the enum check and the ladder-driving state share one snapshot,
    so an alternating valid↔valid getter cannot split validation
    from classification), `diagnosis.causeClass`/`confidence`/
    `proposedActions` elements (a getter alternating
    `'task-defect'`→another valid class cannot hand repair authority
    for a cause that was never checked), and `lastOutcome.action`/
    `strategyId`/`progress` (an alternating
    `task-relevant`→`none` getter cannot validate as a healthy
    steer record and then deliver a failed-steer classification).
    This closes the remaining validate-then-re-read TOCTOU surface
    amendment 29 opened.
35. **Array extent is captured once and re-verified (C4-F2).**
    `copyStrs`/`onlyStrs` and the `proposedActions` loop read the
    array `length` ONCE (a hostile length getter that throws ⇒
    reject) and re-verify the extent after copying: any change
    between capture and final check rejects the WHOLE record —
    partial advice/authority read across two extents is malformed
    evidence, never a validated grant. A shrinking element getter
    can no longer truncate the copy mid-iteration.
    **[C5-F1/F2: OVERCLAIMED at cycle 4 — delivered only in
    `copyStrs`; corrected in amendments 39–40.]**
36. **Array elements must be own properties (C4-F3).** Every copied
    array element must be an OWN data property of the array at its
    index (`getOwnPropertyDescriptor`/`hasOwnProperty` per index):
    prototype-inherited strings are never copied into evidence
    refs, grants, or pools, and an accessor element is never
    invoked as a "string" — one descriptor read per element, so a
    hostile element getter never fires twice.
37. **Stated-unprovable ownership disables the spawn ladder (§1/I1,
    C4-F4).** `ownershipProvable` PRESENT-and-not-`true` (incl. a
    corrupt value, present-`undefined`, or a throwing getter —
    fail-closed) is a STATED non-proof of ownership: every
    spawn-class candidate (backoff-retry, evidence-nudge-resume,
    model-swap, task-rewrite) is INELIGIBLE with veto
    `ownership:unprovable` (visible, never silently skipped), and an
    all-blocked chain bottoms out park-class — `park` while the
    worker is live, plain escalate once ended. ABSENT
    `ownershipProvable` is unknown (not a stated denial) and does
    NOT gate the ladder.
38. **Vetoed candidates stay visible through fallback chains
    (C4-F5).** When a chain's head candidate is vetoed and the plan
    falls through to the next chain, the veto travels with it
    (`chainSeed(…, carry)` + `mergeVetoed`, deduped by action,
    first-veto wins): a repeat-vetoed resume on the L7 fallback, or
    an authority-denied repair on the task-defect fallback, remains
    listed in `alternatives` with its veto instead of degrading to
    a bare rationale code. A candidate the planner considered is
    never erased from the plan.

Cycle-5 audit amendments (GPT Sol, 2026-11-03; findings C5-F1–C5-F5
— all accepted, fixed with named regressions; amendments 35/36/38
were OVERCLAIMS of cycle 4 — corrected here and re-delivered in code):

39. **Descriptor-only copying EVERYWHERE, not just copyStrs (C5-F1).**
    Cycle 4 delivered own-descriptor + extent re-verification only in
    `copyStrs`; `onlyStrs` (evidence refs, outcome refs, BOTH model
    pools) still validated with `hasOwnProperty` and then INVOKED the
    getter — a shrink-on-read accessor produced a partial model grant
    that authorized model-swap. Now `onlyStrs` matches `copyStrs`:
    length captured in ONE try-guarded observation (throwing trap ⇒
    empty), each element copied from an own DATA descriptor (an own
    accessor's getter is NEVER invoked — superseding the cycle-1
    F8/C1 expectation that element getters throw inside the boundary
    and bottom out at `bad-input`), and the extent is RE-VERIFIED
    after the copy (any change ⇒ reject the WHOLE list).
40. **proposedActions extent captured in ONE observation (C5-F2).**
    The old validation ternary read `rawPas.length` three times: a
    Proxy returning 2 then 0 iterated nothing, re-verified 0===0, and
    retained an actionable diagnosis with silently-dropped advice.
    Length is now captured once (guarded; unobservable ⇒ the
    diagnosis is rejected, never treated as empty), elements are read
    via own DATA descriptors (accessor advice rows never invoked),
    and the final check compares against the CAPTURED extent.
41. **Advice alternatives merge, not append (C5-F3); ownership read
    is own-gated (C5-F4).** L6 appends advice alternatives through
    `mergeVetoed` (first veto wins) — a rule-vetoed repair is listed
    once with its concrete `authority:denied:*` veto, never a second
    time with `advice-not-authority`. `ownershipProvable` is read
    ONLY when it is an OWN property: an inherited accessor is never
    invoked (a prototype chain may not pose as a stated ownership
    annotation; absent-own ⇒ unknown, no spawn gate).
