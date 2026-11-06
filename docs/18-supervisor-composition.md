# 18. P9/M1 — Supervisor Composition Contract (the closed recovery loop, wired)

Status: **M1 spec — this document is the contract M1 implements.**
Scope: M1 ONLY (the single-worker closed loop). M2–M5 (Telegram bridge,
multi-worker fleet, dashboard, CLI attach) are NOT in scope and nothing
here pre-implements them.
Depends on: P7 `src/runner/` (AttemptRunner, child supervision),
P8 `src/budget/` (BudgetLedger: gate, holds, receipts),
P10 `src/planner/` (planRecovery, RECOVERY_DECISIONS),
P11 `src/executor/` (executeAction, LEDGER_ACTION),
P14 `src/acceptance/` (evaluateCompletion),
P15 `src/investigation/` (investigate),
P4 `src/episode/` (DecisionJournal), P3b `src/steer/` (FileSteeringQueue).
Authority doctrine: `docs/11` §11 (P9 row), §14.3 (signals + receipts),
`docs/12` §4 (gate composition), §11.2 (compartment rules).

---

## 0. What M1 is, in one paragraph

M1 is the ONE place in the codebase where the recovery modules are
composed: a single-threaded loop that takes a terminal worker signal,
turns it into a plan (P10), executes it under the ledger gate (P8) via
the executor (P11) or the runner (P7, through the same gate), evaluates
acceptance (P14), and re-senses — bounded, journal-logged, and with
every spend flowing through the ledger. M1 holds no policy of its own:
classification is P10, budget is P8, action semantics is P11, child
lifecycle is P7. M1's unique obligations are the ones NO other module
can have: closing reservations with REAL receipts, writing run-boundary
episode spend, driving the investigation (P15) and its verdict ledger,
consuming steering, and stopping.

### 0.1 Module shape (M1 decision, recorded)

`src/supervisor/compose.ts` — **pure composition, zero repo imports.**
Like P10/P11/P15, the composition module imports NOTHING (not even
`node:`). Every collaborator arrives as a port (duck-typed interface
mirrored locally; the test file binds the REAL modules and drift-guards
the mirrors). This keeps the composition honest (it cannot reach
anything a port did not hand it), keeps the build flat, and makes every
authority it holds explicit in the ports type — which is exactly what
the audit reads. A thin host (`bin/` or a caller's process, M2+) wires
the real singletons and owns timers/IO; M1 ships the loop + a demo host
used only inside tests.

### 0.2 Ports (the full authority surface)

```ts
interface SupervisorLoopDeps {
  planner: { planRecovery(input: object): object };      // P10 (sync, pure)
  executor?: { executeAction(input: object, ports: object): Promise<ExecOutcome> }; // P11
  runner?: { runAttempt(task: object, ctx: object): Promise<AttemptResult>;
             drainPendingIntents(ctx: object): Promise<DrainReport[]> }; // P7
  gate?: { check(ref: unknown, req: object): Promise<CheckResult>;
           reserve(ref: unknown, req: object): Promise<ActionReceipt>;
           closeReservation(ref: unknown, req: object): Promise<unknown>;
           ingestEntries(ref?: unknown): Promise<number>;      // P8
           recordWallclock?(req: object): Promise<unknown>;    // P8 wallclock
           ingestSession?(req: {episodeId, taskRef, gitRef?, sessionLogPath?}): Promise<unknown>; // run-boundary spend
           snapshotAt?(ref: unknown, episodeId: string): Promise<Snapshot | null>; };
  accept?: { evaluateCompletion(input: object): object };     // P14 (sync, pure)
  investigate?: (req: object, limits?: object) => Promise<object>; // P15
  journal?: { append(ref?: unknown, record: object): Promise<unknown>;
             read(ref?: unknown, episodeId?: string): Promise<unknown[]> }; // P4
  steer?: { request(overrides?, id?): Promise<unknown>;
            shutdown?(): Promise<unknown>;
            queueDir?: string };                              // P3b
  now?: () => number;          // injectable clock (tests)
  log?: (line: string) => void;
}
```

Anything absent is a hole, not an excuse: an action whose executor
refuses `port-missing:*` becomes a recorded `refused` outcome, never a
crash and never a bypass.

---

## 1. The loop (exact shape, M1)

```
run(episode)                                  # once per episode
 ├ A  preflight: drainPendingIntents (P7) → ledger.ingestEntries()
 ├ B  first run: runner.runAttempt under the gate (episode+task budget)
 └ C  recovery loop while not terminal:
     1 sense     — the terminal AttemptResult (result/error/exitCode/
                   transcriptRefs), or the failure signature
                   `supervisor-loop-error` when the loop itself throws.
     2 diagnose? — if the input is UNKNOWN-class material AND an
                   investigate port exists → run P15 with its own
                   episode caps → ledger verdict.
     3 plan      — P10 planRecovery(signal + classification + counts
                   + evidenceRefs from the investigation).
     4 steer     — drain the P3b queue: pending steering overrides the
                   plan inputs; a queued shutdown stops the loop here.
     5 execute   — P11 executeAction for template-backed actions
                   (backoff-retry, model-swap, evidence-nudge-resume);
                   directly via P7 runner for start-worker-class;
                   investigate → P15; halt/escalate/wait-for-human/
                   no-op → stop.
     6 accept?   — on finish: P14 evaluateCompletion gates the finish.
     7 journal   — append the loop's SupervisorRecord (journal port).
     8 loop      — the outcome is the next signal.
 └ D  close: recordManualSpend run-boundary episode wall; journal flush.
```

Ordering rules (pinned by tests):

- **R1-sense-before-plan**: nothing is planned from a signal the runner
  did not produce. The loop never invents a failure.
- **R2-diagnose-before-plan**: a classification of `unknown` is the
  planner's call, not the loop's; the loop only *offers* diagnosis
  evidence when `rootCauseHint` is missing.
- **R3-one-executor**: every action goes through the executor or the
  runner — both gated by the same ledger. The loop NEVER calls
  `gate.reserve` for an action it does not intend to close (§2).

---

## 2. Reservation discipline (the M1-specific contract)

P11 already closes its own reservations (I4). M1 adds the two paths
where the reserver is M1 itself:

1. **start / resume-via-runner**: M1 composes the `GateRequest`
   (`action: 'start'|'resume'`, `actionId = sup:<episode>:<seq>`), runs
   check → reserve, spawns via the runner port, **closes the
   reservation with the real usage from the AttemptResult**
   (`closed: true, usage: {inputTokens, outputTokens, costUsd}`), or
   `unattested: true` when the child died before reporting usage (M1
   never guesses usage — an unattested release is a request-only
   release the ledger re-checks on the next reserve).
   *Implementation note (compose.ts): the runner's AttemptHandle carries
   no usage, so the loop attests the proven EXIT (`outcome`/`evidence`
   from the exit code/signal) and the real spend flows through
   `ingestSession(session, scope)` before the close. Close is attested
   on a proven exit, request-only otherwise.
2. **check→denied**: reserve is never attempted after a denied check;
   the denial is journalized as an outcome, the loop stops or steers
   per §3.

Drift/rollback rule (R6/R7 doctrine, inherited): between check and
reserve, M1 re-runs `ingestEntries` and re-checks; a denial appearing
between check and reserve REVOKES the spawn (mirrors executor E4).

---

## 3. Termination (M1 must stop — five named stops)

| Stop | Trigger | Loop outcome |
|---|---|---|
| **halt** | planner verdict `halt` (escalate-adjacent) or action `halt` | stopped: halt |
| **escalation-exhausted** | `escalate` action with `escalateBlocked`, or a second consecutive escalate for the same cause | stopped: escalation-exhausted |
| **shutdown** | P3b shutdown flag (consumed at step 4, before execute) | stopped: shutdown |
| **accepted-finish** | `finish` action + acceptance pass (P14) | stopped: finish |
| **finish-rejected** | `finish` action + acceptance FAIL (missingEvidence/contradiction) | the finish does NOT stop the loop; a continue is planned against it (M1 treats a false finish as a premature-stop-class signal, once per finish attempt) |
| loop-error | the loop's own throw | stopped: supervisor-loop-error (journalized; the loop never re-throws into the host) |
| iteration-cap | `maxIterationsPerRun` reached | stopped: max-iterations |

Plus the inherited caps (planner-observed, so the plan changes before
M1 sees it): sameActionMax, totalActionsMax, escalateMax,
investigateSameSignatureMax, investigateEpisodeMax, and the ledger's
own budget denials. M1 adds **one** cap of its own: `maxIterationsPerRun`
(default 64) — the loop-structure cap the planner's caps cannot express
(alternating actions that each stay under their own same-action cap).

No stop may ever skip step 7 (journalize) or step D (close episode
wall).

---

## 4. Steering (P3b) in the loop

Step 4 consumes ONE steering request per iteration via the queue port:
- `shutdown()` present and the queue holds a shutdown → stop (§3).
- a pending request overrides the next signal's plan inputs
  (`overrides.model` → model-swap target; `interruptRequested` → treated
  as a fresh signal at the next sense step).
- steering NEVER bypasses the gate: it changes what is planned, not
  whether the gate is asked. A steer that would violate budget is
  denied by the gate like any action, and the denial is journalized.

---

## 5. Observation + journal contract (S7, docs/11 §8)

Per iteration, M1 emits ONE journal record via the journal port
(P4 `append`), kind-tagged in `SupervisorRecord` shape:
`{ episodeId, taskId, signal, classification, action, reason,
evidenceRefs, actionId, at }` — same fields P11 already writes (mirror
pinned). M1-only kinds (`start`, `resume`, `escalate`, `halt`,
`shutdown`, `loop-error`) carry the reservation `actionId`
(`sup:<episode>:<seq>`) so a closed reservation is always traceable to
its journal record, and §14.3's `receiptDigest` rides in `evidenceRefs`
when the ledger returned a digest — M1 never writes into the receipt.

The ledger stays the truth: journal records are evidence, the ledger is
authority (docs/12 §3). If the journal port throws, the loop logs and
continues (append-failure ≠ recovery-failure); if the LEDGER port
throws, that iteration's action is refused (no unledgered execution —
fail-closed).

---

## 6. Investigation (P15) in the loop — and its verdict ledger

- M1 calls investigate at step 2 only when the signal carries no root
  cause (planner would classify `unknown`) and P15 caps allow it.
- M1 enforces the **P15 caps locally** (the ledger gates only
  `run`/`resume` — `LEDGER_GATED_ACTIONS`, docs/12 §4 — so an
  investigation never carries a reservation): per-signature
  (`sameSignatureMax`, default 1) and per-episode (`episodeMax`,
  default 2) offer caps in the loop, PLUS the planner's own
  diagnostics budget (`authority.diagnostics` vs
  `facts.diagnosticToolCallsUsed/UsdUsed`), which M1 feeds every
  iteration. When local caps are spent the loop simply proceeds with
  the evidence it has — the degraded journal-window path, by
  construction.
- M1 caps investigation COST independently (docs/17 §6): P15's own
  `limitsRespected.{toolsUsed,spendUsd}` feed the planner's
  `facts.diagnosticToolCallsUsed/diagnosticUsdUsed` every iteration
  (the planner then refuses to re-propose investigate past the grant),
  and M1 mirrors the spend to the ledger via
  `recordManualSpend({episodeId, taskId, spend:{lineId,
  model:'investigation', provider:'supervisor', usage:{input:0,
  output:0}, note:'P15 estimate spendUsd=…'}})`. P15 reports USD
  estimates, not tokens, so the manual record is OBSERVATION (usage 0,
  the note carries the estimate) — M1 never fabricates token counts.
- **Verdict ledger (M1-owned, M1-specific obligation)**: every
  investigation gets exactly one `diagnosis` journal record appended by
  M1 (the P15 record IS the verdict — M1 adds no confidence of its own;
  a missing field reads as 0). M1 NEVER executes P15's
  `proposedActions`: they ride into the NEXT iteration's planner input
  as `diagnosis.proposedActions` + `rootCauseHint`-equivalent evidence —
  the planner still owns the decision (docs/17 INV-2: advice ceiling).
  P15 has no stop-authority: there is no `stopRecommended` field in
  `DiagnosisRecordFields`; a diagnosis never terminates the loop by
  itself.

---

## 7. Acceptance (P14) in the loop

Step 6: when the planner proposes `finish` (or the runner reports
success — `result==='success'` implies finish evidence), M1 runs
`evaluateCompletion` over the accumulated evidenceRefs (transcript refs
+ gate digests + investigation evidence, all refs M1 collected) against
the task's DoD. A fail converts the finish (§3 table). A pass stops the
loop with `accepted-finish`. The acceptance verdict is journalized
(signal: `acceptance-verdict`). With no accept port, finish passes
through unjudged and the loop records that as a warn-rung signal
(P14 exists precisely so this never stays silent).

---

## 8. Compartment audit (M1's own obligations, docs/11 §11.2)

1. **Authority**: composition module imports nothing (§0.1). The host
   (M2+) is the only place singletons meet.
2. **Budget truth**: every token/cost the loop spawns, investigates,
   or wallclocks reaches the ledger — start/resume via reservation
   close, investigation via recordManualSpend, episode wall via
   recordWallclock + run-boundary ingestSession. No path exists that
   spawns without closing its reservation (pinned by tests).
3. **Evidence ownership**: M1 references evidence (refs, digests); it
   never mints evidence for another module (no fabricated evidenceRefs
   — every ref in a journal record was handed to M1 by the port that
   owns it).
4. **Journal discipline**: M1 writes only its own SupervisorRecords;
   signal kinds outside DECISION_SIGNAL_KINDS are M1's own three:
   `investigation-verdict`, `acceptance-verdict`,
   `supervisor-loop-error` — an additive superset, pinned.
5. **No child authority**: M1 spawns only through the runner port; it
   has no child_process, no fs, no net in the composition module.
6. **One loop per episode**: M1 is the single writer of decisions for
   an episode; the planner's staleness rule and the ledger's
   serialized queue make a second loop redundant, not dangerous —
   M1 simply is not built for it (M4 fleet scope).

## 9. Tests (M1 acceptance — test/supervisor.test.ts)

- loop-shape: signal→plan→execute→journal order; loop-error stop;
  iteration cap; journalize-before-stop on all five stops.
- reservation discipline: start/resume close with real usage;
  unattested on child death; check-denied never reserves;
  re-check-between-check-and-reserve revocation.
- steering: model override lands on the next plan; shutdown stops at
  step 4; steer cannot bypass the gate (denial journalized).
- investigation: offered only on unknown; caps enforced via ledger
  denial → degraded classify path; usage recorded via
  recordManualSpend; verdict ledger one-per-investigation;
  stopRecommended stops without planner involvement; recommendedActions
  never auto-executed (planner sees them as evidence only).
- acceptance: pass stops; fail converts to continue-once (premature
  finish); missing accept port journalizes warn-rung.
- guards (repo doctrine): compose.ts imports NOTHING; nothing outside
  src/supervisor imports it (until M2 wires the host); mirror pins for
  the enums used (actions, verdicts, cause classes, templates keys) vs
  the real planner/executor/journal exports.
- full-suite green + `tsc` clean.

## 10. Out of scope for M1 (M2–M5)

Telegram bridge (M2), fleet dashboard + multi-episode (M4), CLI attach
(M5), staging/rollback + fleet budget layer (M3). The loop signature
already accommodates them (the signal could come from Telegram or the
fleet tail; nothing changes in the loop body), but M1 ships exactly
one host path and it lives in the test file.

---

## 11. Known open items (round-4/5 audit dispositions)

- **Executor-side reservations close through the supervisor (rounds 4-5).**
  `backoff-retry`, `model-swap` and `evidence-nudge-resume` reserve
  through the executor's GatePort; the loop WRAPS that port, captures the
  open record's id, and closes it after the act: attested `settled` on a
  proven exit, request-only `released` on an unobserved exit, and
  `released` on a refusal or failure that the executor journaled
  `no-effect:` for (SAME actionId — the journal marker, not the result
  status, is the proof, because the result object is port-returned data).
  The proof is window-tight (round 6): actionIds are content digests, so
  an identical repeated plan collides; walking backward over the
  actionId's records, the FIRST match must be the fresh decision-outcome
  — hitting the fresh decision-intent first means the outcome append was
  lost and the release is refused (a stale no-effect from a prior
  execution can never prove a fresh act). The scan is capped and errs
  conservative. An effect-UNKNOWN stop (executor throw, unmarked or
  unprovable refusal/failure) is never blindly released — ledger expiry
  backstops it. The close goes
  through the SAME port that issued the id (receiver-preserving call);
  when that port has no close door, expiry backstops and the loop logs.
  The executor stays a pure single-act module: its GatePort gained
  optional `closeReservation`/`release` doors for host compat, and the
  executor itself never calls them.
- **Dual intent journaling (by design).** For each journaled action the
  loop writes its `sup-…-i{seq}` decision-intent/outcome pair and the
  executor writes its own `a-…` pair. Both pairs self-close (openIntents
  shows neither open), so the loop's record is the supervisor DECISION
  while the executor's is the ACT. The executor's actionId is a content
  digest the loop cannot precompute, so the two pairs are independent
  by contract and are not deduplicated.
