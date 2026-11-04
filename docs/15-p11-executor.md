# P11 — Recovery action executor (contract & as-built surface)

> Status: CONTRACT (drafted 2026-11-04, implemented 2026-11-04). Module:
> `src/executor/exec.ts`. Consumed by P9/M1 composition, which injects the
> real ports (P7 `AttemptRunner`, P8 `BudgetLedger` + `check`, P3b
> `FileSteeringQueue`, P4 `DecisionJournal`, P13 escalation, P15 dispatch).
> Parent plan: docs/11 §11.1 P11 row, §9 ladder + hygiene, §14.3 decision
> records, §13.2 I2/I5/I6, docs/12 §4 (gate), docs/14 §2 (plan shape).

## 0. Purpose & boundary

P11 answers exactly one question: **given a P10 plan recommendation and the
supervisor's execution context, perform the ONE action the plan specifies,
journal it per §14.3, and report what actually happened — without ever
creating authority, replaying an open action, or throwing at its caller.**

Normative source sentences:

- P11 row (docs/11 §11.1): "Executes authorized plans through P7/P8 with
  durable intent/outcome records: backoff/retry, confirmed-stop resume,
  scoped in-flight steer (P3b), diagnostic/repair dispatch, and later
  model/session/task transitions. **Owns no independent permission grant.**
  … P7 remains the process-control primitive; neither observer nor worker
  may bypass the control plane."
- §14.3: intent BEFORE acting (log-then-act); outcome after the action
  resolves; "an intent with no outcome for its `actionId` is **open**;
  recovery may close it only with observed reality — never by re-issuing
  the action (I5 for `sideEffect:"external"`)."
- §9.1: "Authority is granted upfront, not invented during recovery…
  absence of authority is not permission."
- docs/12 §4: the gate (check → reserve) runs independently of model
  judgment; the executor is its composition point, not its owner.

Boundary rules (what P11 is NOT):

1. **No authority creation.** The executor never widens a grant, never
   mints a receipt of its own, never escalates a side-effect class. A
   missing port (gate/steer/runner/dispatch) for the action the plan names
   is a REFUSAL (`port-missing`), never a degraded execution and never a
   silently skipped act.
2. **Not the planner.** It does not choose actions. It REVALIDATES the
   plan structurally (§2) — a hostile or drifting plan object is refused,
   not executed — and executes at most one action.
3. **Not the ledger.** P8 owns gate semantics; the executor composes
   check→reserve and never writes the ledger itself except through the
   injected gate port.
4. **Not a progress judge.** Outcomes carry `progress:"none"` with ONE
   exception (§6): Uptake/`task-relevant` is the observer+P14's later
   judgment; the executor reports DELIVERY (`acked`, I6), nothing more.
5. **Pure-ports compartment.** `src/executor/exec.ts` imports NOTHING —
   not even `node:` (the P10 pattern). Everything external arrives as an
   injected port (§3). All existing compartment guards (P4/P7/P8/P10)
   stay green unchanged; two new guards pin the executor (§7).

## 1. The one call

```ts
executeRecoveryAction(
  plan: unknown,                 // a P10 PlanRecommendation — treated as HOSTILE input
  ctx: ExecutorContext,          // episode/task binding, authority assertion, injected clock
  ports: ExecutorPorts,          // journal / runner / gate / steer / dispatch / delay
): Promise<ExecutionResult>      // NEVER rejects (§5)
```

`ExecutorContext` (all validated before anything else, fail-closed):

```ts
{ episodeId: string;            // non-empty, safe id
  taskId: string;               // safe id AND equal to plan.taskId (§2)
  attemptId?: string;           // the attempt the action targets, when one exists
  taskRevision?: number;        // integer >= 1
  session?: string;             // required only by `kill` (the runner stops by session)
  now: number;                  // finite, >= 0 — the injected clock (P10/P14 pattern)
  authority: { grantedBy: string };  // non-empty: WHO granted this execution.
                                 // Absence of a granter is not permission.
  executionSeq?: number }       // default 0; ONLY legitimate way to make an
                                 // identical plan content executable twice (§4)
```

## 2. Plan revalidation — the plan is evidence, not an instruction

The plan object is read through a single defensive snapshot (§"hostile
input", same fence P14 S-F2 applied): every property read happens inside
one try/catch, so a throwing getter, a hostile Proxy, or a broken
iterator yields `refused(plan-invalid)`, never a throw and never a
partial read. The snapshot is then judged against CLOSED tables that
mirror P10 (docs/14 §2/§4) — a drift guard test pins table equality
against the real planner exports (§7):

| check | refusal reason |
|---|---|
| object, non-array, non-null | `plan-invalid:shape` |
| `action` ∈ the 12-action `SUPERVISOR_ACTIONS` mirror, or the literal `hold` sentinel | `plan-invalid:action` |
| `action === "hold"` (the docs/14 §2.0 non-action sentinel) | status `held` — nothing journaled, nothing acted |
| `strategyId` equals the strategy-template value for the action (`model-swap` instantiates `swap:model:<model>:v1` from the plan's own `model` — a strategy naming a DIFFERENT model than `plan.model` is a repeat-budget bypass attempt) | `plan-invalid:strategy` |
| `rung` integer equal to the canonical rung for the action (0–5) | `plan-invalid:rung` |
| `decision` equals the canonical decision for the action | `plan-invalid:decision` |
| `sideEffect`/`authorityNeeded` ∈ {none, worktree-local, external}; `authorityNeeded` never below `sideEffect` | `plan-invalid:authority` |
| `notAPermission === true` (the field P10 always sets — its absence means the object was not produced by P10) | `plan-invalid:permission-flag` |
| `rationale`/`evidenceRefs`/`remainingWork` when present: dense arrays of strings, each ≤ 512 chars, ≤ 64 entries; `expectedEvidence` a string ≤ 512 | `plan-invalid:<field>` |
| `model` when the action is `model-swap`: non-empty string ≤ 256 chars | `plan-invalid:model` |

Nothing read out of the plan is ever used raw: strings are re-copied into
fresh values, arrays become fresh dense arrays (`every` index-checked,
the P14 S-F3 discipline).

## 3. Ports (the only way anything happens)

```ts
interface ExecutorPorts {
  journal: {                                   // P4 DecisionJournal-shaped
    append(r: object): Promise<void>;
    read(): Promise<{ records: readonly unknown[] }>;
  };
  runner?: {                                   // P7 AttemptRunner-shaped (subset)
    reconcile(task): Promise<{ decision: { action: "spawn"|"park"|"running"; reasons: string[] } }>;
    run(task): Promise<{ attemptId: string; pid?: number }>;
    resume(task, attemptId): Promise<{ attemptId: string; pid?: number }>;
    stop(handle: { session: string }): Promise<{ stopped: boolean; groupStatus?: string }>;
  };
  gate?: {                                     // P8 check+reserve, P9-composed
    check(policy, request): Promise<{ allowed: boolean; denials: {code; detail}[] }>;
    reserve(policy, request): Promise<void>;   // throws = revoke (policy-revoked etc.)
  };
  steer?: {                                    // P3b FileSteeringQueue-shaped
    push(req: { id; text; source?; attemptId?; taskId? }): void | Promise<void>;
  };
  dispatch?: {                                 // P15 / P13 / graph-owner callbacks
    investigate?(req): Promise<{ evidenceRefs?: string[] } | void>;
    repair?(req): Promise<{ evidenceRefs?: string[] } | void>;
    rewriteTask?(req): Promise<{ taskRevision?: number } | void>;
    escalate?(req): Promise<{ channel?: string } | void>;
    park?(req): Promise<void>;
  };
  delay?: (ms: number) => Promise<void>;       // timer seam for backoff (test seam)
}
```

The ports are structurally satisfied by the real modules; P9's adapter
implements `gate` as `check()` + receipt `verify()` + `BudgetLedger.reserve()`
(docs/12 §4's ordering lives INSIDE the adapter — the executor demands the
pair be atomic and truthful: `reserve` throws iff the action was not
admitted). Ledger action-class mapping (docs/12 `LEDGER_GATED_ACTIONS`):
`backoff-retry`/`model-swap` → `"run"`, `evidence-nudge-resume` →
`"resume"`. Non-spawn actions carry no reservation — P8 only holds worker
capacity; their constraint is the upfront authority surface, revalidation,
and the durable intent.

**Required port per action** (missing → `refused(port-missing:<port>)`):

| action | required | gate |
|---|---|---|
| `nudge` | steer | no (sideEffect none; scoped by attemptId, §14.2) |
| `evidence-nudge-resume` | runner, gate | ledger action `resume` |
| `backoff-retry` | runner, gate | ledger action `run` |
| `model-swap` | runner, gate | ledger action `run` with `model` (P8 `model-not-approved` is the enforcement — the executor never checks the approved list itself) |
| `investigate` | dispatch.investigate | no (§14.7 diagnostics caps are enforced by P15's own dispatch + P8 at its reservation) |
| `repair` | dispatch.repair | no |
| `task-rewrite` | dispatch.rewriteTask | no (the revision bump is the act; the follow-on attempt is the NEXT plan's job) |
| `escalate` | dispatch.escalate | no (escalation must never be veto-looped to silence — docs/14 PC5) |
| `park` | dispatch.park | no |
| `kill` | runner (+ ctx.session) | no (stopping burns nothing) |
| `accept-finish` | none (record-only act) | no |
| `merge` | — | always `refused(merge-unwired)` (P12 is unwired by contract) |

## 4. Ordering — intent-before-act, idempotent actionId

`actionId = a-<taskId>-<action>-<digest>` where digest is FNV-1a over the
**canonical** (sorted-key, JSON) plan snapshot plus `executionSeq`. Same
plan content + same seq ⇒ same actionId ⇒ replay is detected, not re-run.
Re-executing genuinely new intent requires changed plan content (normal:
rationale/evidence move) or an explicit `executionSeq` bump — the ONLY
legitimate disambiguator.

The full ordering (every step journal-typed; `stage` in the result names
the last one reached):

1. **revalidate** (§1 + §2). Refusal journals NOTHING (a refusal before
   any authority assertion has done nothing).
2. **dedup** — `journal.read()`; failure → `refused(journal-unreadable)`
   (fail-closed: no journal, no action). Scan records in order for this
   `actionId` (§14.3 I2):
   - intent open (no later outcome) → `refused(intent-open)` — recovery
     closes open intents with OBSERVED reality, the executor never
     re-issues blindly (I5).
   - closed by an outcome with `acked:true` → `refused(already-executed)`.
   - closed by an outcome with `acked:false` carrying the `no-effect:`
     marker this module writes (§5) → replay is permitted (nothing
     happened; the fresh intent re-opens with a distinct journal id —
     §14.3 duplicate-id reporting stays advisory).
3. **intent** — append the §14.3 `decision-intent` (id
   `<actionId>#i<seq>`, full fields: actionId, attemptId, taskRevision,
   rung, action, strategyId (only when the claim was
   **template-verified** — `spawn-class` actions equal their template's
   id by rule, so the claim is trustworthy; `kill` has no template and
   its smuggled label is omitted rather than laundered into the record,
   R2-G4), expectedEvidence, authority
   `{grantedBy: ctx.authority.grantedBy, sideEffect: plan.sideEffect}`,
   rationale). The journal record is **deep-frozen before append**
   (round-1 F3): no caller-retained reference can rewrite history.
   Append failure → **refuse to act**:
   `refused(intent-journal-failed)` (log-then-act means exactly this).
4. **backoff** — for `backoff-retry` only, after the intent lands and
   before the gate (so a policy change during the wait is judged):
   `delay(base * 2^max(0, attemptNumber-1))`, base default 1000 ms, cap
   60_000 ms; `attemptNumber` parsed from `ctx.attemptId`.
5. **gate** (spawn actions) — `check` then `reserve` with the §14.7
   authority surface from ctx (`policy` passes through opaquely; the
   executor constructs the GateRequest with actionId/action/model/
   strategyId/authority). Every field **read back from the gate is
   getter-guarded** (R1-G1, R2-G2): a live Proxy whose `allowed`/`denials`
   getter throws is treated as a failed check / untrustworthy denial list,
   converted to a clean refusal **before** any journal write — a hostile
   port can neither crash the executor nor strand an intent. Denial or
   revoke → append
   `decision-outcome {acked:false, progress:"none", notes:"no-effect: gate-denied <codes>"}`
   and return `refused(gate-denied)` with the denials attached
   (`resultErrors` only when the port reported errors).
6. **act** — exactly one port call (§3 table). `evidence-nudge-resume`
   and the run-class actions reconcile FIRST: `running` →
   `refused(already-running)` (no second worker — P7's fence is not to be
   poked); `park` → `refused(parked)` (ownership not provable; escalating
   is the next plan's job). `nudge` pushes the deterministic scoped steer
   (id = actionId; text = rationale lines + expectedEvidence; attemptId
   scope → the harness skips it after revision bump, §14.2).
7. **outcome** — append `decision-outcome` (id `<actionId>#o<seq>`,
   `acked` = the act resolved by DELIVERY (I6: queue acceptance / spawn
   ok / stop returned / port resolved — NOT worker uptake),
   `progress:"none"` always (§0.4), evidenceRefs = deterministic
   per-action refs (`attempt:<id>`, `dispatch:<action>`, …) plus any
   evidenceRefs the dispatch port returned (string-checked).

**`no-effect:` vs `act-unknown:` (R3-B1, R4-A).** The `no-effect:` marker
is what permits a replay (§4 step 2), so it may be written ONLY when the
executor can PROVE nothing happened:

| situation | outcome | replayable |
|---|---|---|
| refusal / gate denial / reconcile `running`\|`park` | `acked:false, notes:"no-effect: …"` | yes |
| act threw BEFORE the delivering port call | `acked:false, notes:"no-effect: act-failed <name>"` | yes |
| act threw AFTER the delivering call (effect may have landed) | `acked:false, notes:"act-unknown: act-failed <name>"` | no |
| `kill` delivered but `stopped !== true` (unconfirmed, incl. an unreadable `stopped`) | `acked:false, notes:"act-unknown: stop-unconfirmed"`, evidenceRefs `["stop:session-unconfirmed"]` | no |

The last row is the R4-A correction: a `stop` that returns
`{stopped:false}` reports that the runner could not CONFIRM the kill, not
that the kill never happened — recording it as `no-effect:` re-issued a
kill command against the live session (reproduced: 2 stop calls). An
`acked:false` outcome WITHOUT the `no-effect:` marker is read by the dedup
scan as "not replayable" (§4 step 2); a kill that should be attempted
again must arrive as NEW intent (a new plan ⇒ a new `actionId`), never as
a blind replay of the old one.

If the ACT throws: the outcome in the table above is appended best-effort and the
result is `failed`. If the
OUTCOME append throws (act succeeded, record lost): the result is
`executed` with `outcomeDurable:false` and the append error surfaced —
the action DID happen and must never be silently re-run (§14.3: only
reconcile with observed reality closes it).

## 5. Never throws (the top-level fence)

`executeRecoveryAction` is an async function whose ENTIRE body, including
port construction and every property read of its arguments, runs inside
one try/catch (the P14 S-F2 pattern: the fence must precede the first
property read of hostile input). Any escaped value — throwing getter,
hostile Proxy, poisoned promise, internal bug — is converted to
`{status:"failed", stage:<reached>, error:{name,message}}`. `error` is
built field-by-field through `String()` with own-property guards (the
P14 S-F5 lesson: `String(err.message)` on a throwing-message Error must
not re-throw; each field is tried individually).

`ExecutionResult`:

```ts
{ actionId: string;            // "" when revalidation failed before derivation
  action: string;              // plan action, or "" when unreadable
  status: "executed" | "refused" | "held" | "failed";
  stage: "revalidate" | "context" | "dedup" | "intent" | "backoff" | "gate" | "act" | "outcome";
  reason?: string;             // typed refusal reason (§2/§3/§4)
  denials?: { code: string; detail: string }[];   // gate denials, verbatim
  attemptId?: string;          // spawn/resume result
  evidenceRefs: string[];
  outcomeDurable?: boolean;    // false ONLY when the act happened but its outcome record failed
  error?: { name: string; message: string };
  executedAt: number }         // ctx.now (echoed; never a second clock read)
```

## 6. Progress & ack definitions (pinned)

- `acked:true` = the ACT's own delivery contract resolved (steer queued,
  child spawned ok, stop returned, dispatch port resolved). It is NOT a
  claim of worker attention (I6).
- `progress` is ALWAYS `"none"` from the executor. Uptake and
  task-relevance require observing the worker afterwards — that is P5/P14
  territory. An executor that reported progress would launder hope into
  evidence, which is the exact §9 failure mode ("repeated generic nudges
  are not healing").
- `no-effect:` outcome notes are the marker making a refused act
  replayable (§4 step 2); `act-failed`/`gate-denied` suffixes name why.

## 7. Compartment guards (enforced in test/executor.test.ts)

1. **`src/executor` imports NOTHING** — not even `node:` (mirrors the P10
   guard). The executor is pure-ports.
2. **Nothing outside `src/executor/` imports the executor** (until P9
   wires it), using the C2-F13 specifier extractor with positive fixtures.
3. **Mirror drift guard:** the executor's exported copies of
   `STRATEGY_TEMPLATES`, the action→rung table, the action→decision table,
   and the action enum are deep-equal to the REAL planner exports
   (`src/planner/plan.ts`) — imported from the test (tests are outside
   the compartment). A planner table change that skips the executor
   fails CI.
4. The P4/P7/P8/P10 guards needed NO amendment for P11 — by construction
   (§0.5). The P4 guard's blessed consumer list is unchanged.

## 8. Acceptance exit (P11 row)

- Every §2 revalidation rule, §3 port requirement, and §4 ordering branch
  has a named regression test, including: hostile plan fence (throwing
  getter / Proxy / broken iterator), strategy-mismatch repeat-budget
  bypass refused, rung-decision mismatch refused, intent-journal failure
  blocks the act (zero port calls), intent-open refuse-don't-reissue,
  no-effect replay permitted, acked-done refused, gate denial journals a
  no-effect outcome and acts on nothing, reconcile running/park short
  circuit the spawn, nudge steer carries attemptId scope and actionId as
  requestId, backoff delay lands between intent and gate, model-swap
  passes model to the gate (never self-approves), merge refused,
  accept-finish records without ports, never-throws on injected
  port-throws at every stage, outcome-append failure surfaces
  outcomeDurable:false, idempotent actionId determinism across plan
  object clones, executionSeq disambiguates.
- Full suite green; no pre-existing test edited except suite-count docs.

## 9. As-built amendments

(2026-11-04, implementation day — the suite found four contract gaps
the prose left ambiguous plus one test-infrastructure fix; each is
recorded here per the docs/11 rule.)

1. **§2 strategy-template match exempts `kill` and `merge`.** The rule
   "strategyId equals the strategy-template value for the action" has no
   referent for `kill`/`merge` — `STRATEGY_TEMPLATES` (docs/14 §4) has no
   entry for either, and the planner never emits them. The first
   implementation checked them anyway and refused EVERY kill/merge plan
   with `plan-invalid:strategy` before its §3 port requirement could
   even run (the §8 "merge refused" scenario exposed this). As-built:
   actions without a closed template skip the strategy match; the other
   §2 rules (action enum, decision, rung, authority, permission flag)
   still apply. `merge` is then refused `merge-unwired` at §3 as
   specified; `kill` executes through `runner.stop`.
2. **§1 `ctx.now` is validated on the SINGLE observed read.** The prose
   says the injected clock is "never read twice"; the first
   implementation read once into a local and re-validated the local, so
   a malformed raw `now` (NaN/-1) fell back to local `0` and PASSED.
   As-built: a validation flag is set on the one read; a raw value that
   is not a finite number ≥ 0 refuses `context:now` — the default is
   never an implicit pass.
3. **§1 `ctx.attemptId` is format-checked (SAFE_ID) like episodeId and
   taskId.** The prose pinned only length; an attemptId carrying spaces
   or path syntax would flow into journal records and the runner task.
   As-built: same `^[A-Za-z0-9][A-Za-z0-9._-]*#$` check, refusal
   `context:attemptId`.
4. **§4 replay journal ids are suffixed by per-actionId intent/outcome
   counts.** "Replays append fresh records with the SAME actionId"
   (§4 step 2) — the §14.3 duplicate-id report is advisory (P4), so a
   same-`seq` intent/outcome re-open would collide with the first
   attempt's ids. As-built: the intent lands at `<actionId>#i<seq>r<n>`
   (outcome symmetrically) where n = the count of PRIOR intents /
   outcomes for this actionId — the first execution keeps the bare
   `<seq>` spelling, the first replay is `…r1`. Regression test: the
   no-effect replay asserts four DISTINCT journal ids across two
   attempts.

5. **§8 footnote honored, with one infrastructure exception:** the only
   edit to a pre-existing test file is `test/planner.test.ts`'s fixture
   directory resolution — the old `../../test/fixtures/planner` URL was
   broken under BOTH run modes (it escaped the repo under `tsx` and only
   accidentally worked under `node --test dist/`). It now probes the
   source-tree path first and falls back to the dist-relative path;
   no assertion or fixture changed.

No other deviations. The §7 guards, the E1–E6 invariants, and the §3
port table are as-drafted; the `repair` external rung-3 override and
the template-preserving strategyId (docs/14 repairGate truth — NOT a
`+external` suffix) are pinned as specified.

## 9b. Audit remediation amendments (2026-11-05, audit-p11-executor F1/F3/F5/F6/F7/F9)

The independent audit (docs/audits/audit-p11-executor.md) found six real
gaps; all six are fixed in `src/executor/exec.ts` with regression tests.

6. **§2 identity binding is now enforced (F1, HIGH).** The §1 context
   table always REQUIRED `ctx.taskId` equal to `plan.taskId`; nothing
   checked it, so a plan minted for task B could execute under ctx's
   task A (confused deputy). As-built: a plan carrying `episodeId`,
   `taskId`, or `taskRevision` is compared against the (validated,
   F6-frozen) ctx in `judgePlan` — mismatch is `refused(plan-identity:
   episode|task|revision)` before any port is touched. Plans without the
   optional identity fields remain executable (docs/14 `PlanRecommendation`
   does not emit them today); the digest already covers them because
   actionId hashes the FULL validated snapshot.
7. **§5 fence is fence-safe (F3, LOW).** `instanceof ExecRefusal` at both
   catch sites would itself throw if the rejection value were a revoked
   Proxy whose `getPrototypeOf` traps (an exotic port failure). As-built:
   `isExecRefusal(e)` guards the brand check behind a try/catch —
   a hostile error value falls through to the generic fence path.
8. **§4 step 2 fails closed on a resolving garbage read (F5, MEDIUM).**
   `{records: null}`, a non-object resolution, or non-object records are
   `refused(journal-unreadable)` — coercion to `[]` would re-execute an
   acked action (I2 bypass).
9. **§1 ctx is a single-read frozen snapshot (F6, LOW).** After
   validation the ctx is REPLACED by `Object.freeze`d copies of the
   observed own values (nested authority frozen too); no downstream
   stage re-reads the caller's object, so a mid-flight getter mutation
   cannot split identity between the digest, the intent record, and the
   port request.
10. **§3 intent omits empty strategyId (F7, MEDIUM).** The real P4
    DecisionJournal requires a non-empty `strategyId` when present;
    `kill`/`merge` legitimately have no template (§9.1), so the executor
    now OMITS the field when empty — kill reaches `runner.stop`
    end-to-end against the real journal (pinned by the 12-action
    integration test with on-disk dedup).
11. **§4 reconcile spawns only on the literal 'spawn' (F9, LOW).** Any
    other reconcile value (empty, uppercase, padded, unknown) is
    `refused(reconcile-unknown)` with no spawn — fail-closed matches
    "absence of authority is not permission".
12. **Doc notes the audit raised (no code change):**
    - N3: **the caller MUST serialize** executions per task — dedup is
      read-then-append without a lock; concurrent identical calls can
      both pass (docs/15 is a single-call contract; P9 composition owns
      per-task serialization).
    - N2: `no-effect:` markers on dispatch-port failures are
      **claimed, not proven** — a non-transactional act that applies
      its effect then throws replays the effect. Consumers treating
      `no-effect:` as replay-safe must know the port's transactionality.
    - F8 (cross-component): nudge steer is attempt-scoped in the
      request, but the real P3b queue keys by episode — attempt scoping
      is P3b's owner to enforce (or document as advisory); executor
      carries `attemptId` in the push request unchanged.

## 9c. Audit round-3 amendments (2026-11-05, audit-p11-executor-round3 B1–B4)

Rounds 1–2 hardened the **gate** reads. Round 3 audited the **act site** —
the same class of read, but performed after the effect has landed.

13. **§4/§6 `no-effect:` is claimed only when it is PROVABLE (R3-B1,
    CRITICAL).** The act catch previously journaled
    `no-effect: act-failed <name>` for every throw in the act switch.
    That marker is what permits a replay (§4 step 2), so a port that
    delivered its effect and then failed — a spawn that succeeded whose
    result could not be awaited, an escalation already sent — invited a
    SECOND execution: reproduced as two spawns with two records both
    asserting nothing happened. As-built: an `effectStarted` flag is set
    immediately before each delivering port call; a throw before it keeps
    the `no-effect:` marker (replayable), a throw after it journals
    `act-unknown: act-failed <name>`, which the dedup scan reads as NOT
    replayable. Per §14.3/I5 an action whose effect is unknown stays open
    until recovery closes it against observed reality.
14. **Post-delivery result reads cannot fail the act (R3-B2).** The
    `attemptId` / `stopped` / `taskRevision` / `channel` reads performed
    after the port resolved now go through fence-safe own-property
    helpers (`readAttemptId`, `portField`), so a hostile or revocable
    port value can no longer downgrade a delivered act to a failed one.
15. **The journaled `rationale` is bounded (R3-B3).** Validated as
    ≤ 64 × 512 chars, then joined into ONE field — 32 KiB per durable
    record, with no journal-side limit. Bounded to `MAX_RATIONALE`
    (4096) at the join.
16. **`portEvidence` is dense (R3-B4):** `Object.hasOwn`-guarded like
    the plan arrays (P14 S-F3).

## 9d. Audit round-4 amendments (2026-11-05, audit-p11-executor-round4 R4-A/C)

Round 4 audited what rounds 1–3 assumed rather than checked: the semantic
meaning of each port answer, and the relation between what is JOURNALED
and what is OBEYED.

17. **An unconfirmed kill is `act-unknown`, not `no-effect` (R4-A,
    HIGH).** `runner.stop` resolving `{stopped:false}` means "could not
    confirm", not "did not happen". Journaling it as `no-effect:`
    (which the code did, under a comment asserting the opposite)
    re-issued a kill command against the same session — 2 stop calls,
    both recorded as "no effect". The note is now
    `act-unknown: stop-unconfirmed` and the evidence ref no longer
    claims `stop:session` for a stop that was never confirmed (it is
    `stop:session-unconfirmed`). See the table in §4 step 7.
18. **Everything obeyed must be journalable (R4-B, MEDIUM).** The joined
    `rationale` is BOTH the journal field AND the payload that is obeyed
    (the `nudge` steer text; `dispatch.escalate`'s rationale). Structural
    validation allowed 64 × 512 = 32 KiB while the record was bounded to
    `MAX_RATIONALE`, so the executor could obey 32 KB and journal 4 KB —
    a durable record that UNDERSTATES the act (measured: 32831 obeyed vs
    4096 recorded). The budget is now enforced in `snapshotPlan`, where
    the plan is still refusable (`plan-invalid:rationale-budget`), so a
    truncated record can never be the only trace of a larger act. The
    post-hoc `.slice()` remains as a belt-and-braces clamp.

**Correction to the round-2 report** (no code impact): R2 described a
recursive `deepFreeze` helper and a `resultErrors` field. Neither exists
— the shipped freeze is shallow-but-sufficient (§9b.6) and hostile reads
are dropped rather than surfaced. §9b's substance stands; the two
descriptions did not.
