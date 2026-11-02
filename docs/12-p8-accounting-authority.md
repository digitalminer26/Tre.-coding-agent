# P8 — Durable accounting & authority enforcement (build plan, DRAFT)

Status: **draft for approval** — written 2026-11-02 on top of `c4322a9`
(P7 accepted). Consumes contracts already pinned at P0: §14.3 decision
records (`decision-intent`/`decision-outcome`, `actionId`, `strategyId`),
§14.7 policy shapes (`RecoveryBudget`, `EpisodeAuthority`, `TaskBudget`),
§13.2 invariants I5 (ambiguous external effects never auto-retry) and I7
(budgets span attempts). Gate consumers (P10/P11) are not started; P8 must
be independently testable *before* P9 wires any of it (same standard as P7).

## 0. Why P8 is next

Dependency graph: `P4 → P8` is satisfied; every remaining unstarted
compartment funnels through P8 — P10 planner needs ledger facts, P11
executor gates through P8 authority, P9/M1 needs P7+P8 (+P10/P14/P15
contracts). P8 is the only unblocked unstarted compartment.

## 1. Scope (from the P8 row, sharpened)

One module, `src/budget/ledger.ts` (working name — final name pinned at
implementation), two cohesive halves sharing durable state:

1. **Ledger (accounting).** Per-task and per-episode accumulation of
   spend (USD), tokens (using `Usage` from `src/types.ts`), turns, wallclock,
   recovery attempts, per-`strategyId` repeat counts, nudge counts, and
   diagnostic tool-call/spend — accumulated **across attempts, respawns,
   model swaps, and supervisor restarts** (I7). Plus *reservations*: an
   action reserves its worst-case cost BEFORE acting and settles on the
   outcome record; unsettled reservations survive restart and keep counting
   (unknown cost is charged, never waived — the ledger's I3 analogue).
2. **Authority (gating).** A pure decision function
   `check(authority, action) → allow | deny(reason)` over
   `EpisodeAuthority` (§14.7): path globs (`paths`/`notPaths`),
   `allowInstalls`, `allowNetwork`, `allowExternalEffects`, approved
   `models` for swaps, per-diagnosis `maxToolCalls`/`maxUsd`.
   **Absence of a grant is denial** — the default is closed, and a deny is
   data (a typed reason fed to P10/P13), not an exception. Model judgment
   never overrides: the gate is called by P8 code paths, not by callers
   who could have skipped it (guardrail design, mirrors `src/tools/safety.ts`).

Explicit non-goals (this pass): no scheduler, no model calls, no process
control (P7), no merge/integration (P12), no UI (P13). P8 is called by
P10 (as facts) and P11 (as gate) — P8 itself calls nobody except P4/P5
readers.

## 2. Durable state design

Reuses P4's append-only `DecisionJournal` — **no new file format**:

- Ledger state is a **projection of the decision log** (intents +
  outcomes + attempt records), exactly like P5's fleet projection. The
  log is the single writer's append-only truth; a rebuild-on-open
  re-derives the ledger deterministically. No separate ledger.json to
  drift (avoids the P7 state.json-hint failure class: derived caches that
  outrank their source).
- `actionId` (§14.3) is the reconcile key: intent-without-outcome =
  **open** action; its reservation counts. A restart never re-issues an
  open external-effect action (I5) — reconcile closes it only with
  observed evidence, same rule as P7's spawn reconcile.
- Usage ingestion: worker session entries carry `usage` (assistant
  messages) and `runEnd` (P2). P8 consumes them through P5's `JsonlTailer`
  (offset-cursor, never mutates the session — §13.1 observation-only),
  keyed by attempt→task mapping from the attempt records. Pricing: a
  static per-model rate table in the module (USD/1k tokens), overridable
  per episode policy; a model with no rate entry is `cost:"unknown"` →
  charged against turns/time limits but flagged, never silently free
  (I3: unknown ≠ zero).
- Wallclock: `maxWallclockPerAttemptS` measured from attempt-record ts,
  persisted — supervisor downtime counts toward the attempt it spans
  (a dead supervisor must not buy free time).

## 3. Public surface (draft — pin at implementation)

```ts
class BudgetLedger {
  static open(episodePath, deps: { tailerFactory?, now?, rates? }): Promise<BudgetLedger>;
  // facts (P10 consumes; all derived, none hand-settable)
  taskSpend(taskId): { usd: UsdCost; turns: number; attempts: number; nudges: number; openReservations: UsdCost };
  episodeSpend(): { usd: UsdCost; recoveryTurns: number; wallclockS: number };
  strategyUses(taskId, strategyId): number;
  openActions(taskId?): OpenAction[];          // intents w/o outcomes (I2 reconcile input)
  // intent lifecycle (P11 calls BEFORE/AFTER acting; log-then-act)
  reserve(action: ActionSpec): Promise<void>;  // appends decision-intent AFTER gate approval
  settle(actionId, outcome): Promise<void>;    // appends decision-outcome, releases reservation
  // the gate (P10/P11/P7 spawn path consults; never self-authorizing)
  check(action: ActionSpec): AuthorityVerdict; // allow | deny(typed reasons[])
  checkRecovery(action: ActionSpec): BudgetVerdict; // limits incl. reservation headroom
}
```

`ActionSpec` = `{ taskId, attemptId?, taskRevision, action: SupervisorAction, rung, strategyId, sideEffect, paths?, model?, endpoint?, toolCalls?, estUsd? }` —
typed against the P4 `SUPERVISOR_ACTIONS` enum and §14.3 fields, not a
parallel invention.

## 4. Invariants & failure doctrine (the audit surface — name them up front)

| # | invariant | reproduction to test |
|---|-----------|---------------------|
| A1 | Budgets span attempts/restarts (I7): rebuild from log reproduces per-task totals across ≥2 attempts incl. a supervisor restart mid-attempt | respawn/swap accounting fixture |
| A2 | Reservation honesty: intent w/o outcome keeps reserving; settle releases exactly the reservation (never below zero, never double on redelivered outcome — actionId dedup) | kill between reserve and settle |
| A3 | Absence ≠ permission: every deny path (unlisted path, install, network off, external effects, unapproved model, over-limit) has a positive test; default-closed when `authority` object is absent entirely | empty-policy matrix |
| A4 | Gate bypass is structurally impossible: no public path appends an intent or spawns without `check` having returned allow *for that actionId* (reserve takes a gate receipt, not a boolean from the caller) | API-shape test + guard: nothing mutates decisions.jsonl outside the module |
| A5 | I5: an open external-effect action is never re-issued by any P8 code path; only reconcile-with-evidence closes it | crash-after-intent fixture |
| A6 | Unknown cost is never zero: unpriced model → `cost:"unknown"` flagged; turn/time gates still bite | unknown-model fixture |
| A7 | Projection-from-log determinism: two rebuilds of the same log are byte-identical (no clocks, no iteration-order leaks) | replay-fixture determinism |
| A8 | Observation-only: ledger never writes/repairs a worker session (§13.1); consumes via tailer interfaces only | injection test that session bytes are untouched |
| A9 | Strategy-repeat limit (§9): the Nth same-`strategyId` is denied with a typed reason pointing at the fingerprint history | repeat-nudge fixture |

## 5. Test strategy (P6/P7-proven loop)

1. Implement + unit tests; every invariant above has a named test that
   **fails when its guard is reverted** (mutation sweep, P6 standard).
2. Adversarial audit cycles (implement-audit skill, ≥2 independent model
   families; P7 lesson: same-family early cycles under-caught) probing:
   reserve/settle races, restart windows, gate-receipt forging, rate-table
   abuse, path-glob traversal (`../`, absolute vs repo-relative, symlinks —
   canonicalize like P7 did for session paths).
3. Repro harnesses live in `.tre/tmp/` (now gitignored); consolidated
   verdicts committed as `.tre/audit-p8-*-review.md` (matches R-series).
4. P8 row flips `done` only on PASS with fresh-family confirmation —
   P9 wiring is blocked until then (same bar that caught P7 cycle 1).

## 6. Estimated shape

`src/budget/ledger.ts` ~900–1,200 lines + ~60–80 tests (P7 ran 2× that
because ownership/liveness is inherently adversarial; P8 is mostly pure
projection + pure gate, with the journal queue already battle-tested at
P4). Suite budget: full `npm test` green before/after; compartment guard
check (nothing outside `src/budget/` imports it; it imports P4/P5/types
only) via the existing `scripts/check-deps.mjs`-style guard pattern.

## 7. Decisions — SETTLED 2026-11-02 (user)

1. **Rate table: in-module defaults + per-episode policy override.**
   `DEFAULT_RATES` keyed by model/provider pattern lives in the module;
   `EpisodePolicy.budget?.rates` (additive optional field, P0-compatible)
   overrides per episode. Rate is **frozen onto each ledger contribution**
   at ingest time (tokenomics-style): editing a table entry never reprices
   history (A7 determinism).
2. **Reservation estimates: P8 owns them.** Per-action-class defaults in
   the module (`RESERVE_DEFAULTS`); the caller may only *increase* an
   estimate, never lower it below the class default. A caller-provided
   estimate below default is raised silently to default and the raise is
   recorded on the intent (auditable, never a silent discount).
3. **Gate receipt: capability pattern (option 3).** `check()` returns an
   opaque `ActionReceipt` minted via a module-private WeakMap (not a
   forgeable struct). `reserve(action, receipt)` re-validates the receipt
   AND re-runs the gate inside the serialized journal queue (refresh-first,
   R6/R7 lesson). The receipt binds the canonicalized action spec —
   check(X)-then-act(Y) fails loud. **Scope: `run`/`resume` only** —
   `stop`/`reconcile`/`confirmStopped` stay ungated (stop can't overspend;
   reconcile is read-only; confirm has its own R4–R8 evidence gate). The
   P7 additive change (`run(task, receipt)` required param + exported
   `verifyReceipt` called before spawn) lands as its own small commit
   with forge/mismatch/expiry tests; P7's acceptance is not reopened —
   the seam delta is audited within P8's cycles. P7 imports NOTHING from
   P8: the receipt type + verifier live in `src/budget/` and P7 receives
   them as an opaque parameter typed against a 4-line structural interface
   declared in `src/runner/` (structural typing, no import edge).

Implementation consequence: `docs/11` §14.3's `authority.grantedBy` field
on `decision-intent` becomes load-bearing (it carries the receipt's grant
reference) — recorded here so the field's meaning is pinned before P9.
