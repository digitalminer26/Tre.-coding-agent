# P11 Executor Audit — `src/executor/exec.ts`

> **Status 2026-11-05: F1, F3, F5, F6, F7, F9 FIXED** in
> `src/executor/exec.ts` with regression tests (suite 67/67; full repo
> suite green). Fix details recorded as docs/15 §9b amendments 6–12,
> including the doc-only dispositions for N2/N3/F8. Fixes followed the
> recommended order below. Not fixed here (by design): N1 reservation
> close (P9 adapter), F8 queue-internal scoping (P3b owner — executor
> passes attemptId in the request), N4 (correct as-built).


Date: audit of the uncommitted P11 implementation (860 lines) against
`docs/15-p11-executor.md`, cross-referenced with `src/budget/ledger.ts`
(P8), `src/runner/attempt.ts` (P7), `src/planner/plan.ts` (P10),
`src/steer/file-queue.ts` (P3b), `src/episode/journal.ts`.

Method: full read of every execution stage + 8 adversarial probes run
against the **real** module (hostile Proxies, concurrent double-execute,
effect-then-throw replay, mid-flight ctx mutation, and the REAL
`DecisionJournal` / `FileSteeringQueue` ports). Baseline health:
`tsc --noEmit` clean; `node --test` executor suite 60/60 pass (vitest
cannot collect this file — it is a node:test suite; `npm test` runs the
compiled dist copy and is the correct gate).

**Verdict: ship-with-fixes.** The fail-closed core is genuinely strong
(E1/E2/E4/E6 all hold under probe), but there is 1 HIGH spec-compliance
gap (F1), 2 MEDIUM findings (F7 kills `kill` end-to-end; F5 dedup
bypass via malformed read), and a set of LOW/notes.

---

## HIGH

### F1 — `plan.taskId` / `plan.episodeId` equality is never checked (confused-deputy)

Spec is explicit, twice: `docs/15` §1 — `ctx.taskId`: *"safe id AND
equal to plan.taskId (§2)"* — and the same line is repeated at §3's
`ExecutionResult.taskId` (line 69 and 397 of docs/15).

Implementation: `snapshotPlan()` copies only the judged fields
(`action decision rung sideEffect strategyId authorityNeeded
notAPermission model expectedEvidence rationale evidenceRefs
remainingWork`). It **never reads `plan.taskId` or `plan.episodeId`**,
and `judgePlan()` has no equality check. `grep -n taskId` over exec.ts
shows only shape validation of `ctx.taskId` (line 485–494) — nothing
compares the plan's identity to the context's.

Consequence: a plan object produced for task A (or replayed from an
episode-2 fork of an episode-1 task) executes under task B's identity:
`actionId = a-<ctx.taskId>-…`, intent/outcome records carry
`ctx.taskId`, dispatch requests carry `ctx.taskId`. The plan is supposed
to be HOSTILE input; its identity binding is exactly the thing E1 says
must be *verified*, not assumed. The supervisor wiring is the current
caller and it passes matching values, so this is latent — but it
violates the contract and defeats spec §2's intent.

Fix: in `snapshotPlan` also copy `episodeId`/`taskId`/`revision`
(validated safe strings) and in `judgePlan` (or right after) refuse
`plan-identity:episode` / `plan-identity:task` on mismatch against
`ctx`. Note the snapshot must keep them for the actionId digest too —
identity should feed dedup so the same plan under two tasks yields
different actionIds.

## MEDIUM

### F7 — `kill` is un-executable against the real journal (intent rejected)

`judgePlan` exempts `kill`/`merge` from the strategy-template match
(docs/15 §7.1 documents the amendment — `STRATEGY_TEMPLATES` has no
kill entry), so `snap.strategyId` may legitimately be `''`. The intent
builder then copies `strategyId: snap.strategyId` into the record —
and the REAL `DecisionJournal` validator refuses it:

```
probe: real-journal kill  →  refused / stage=intent
error: "decision record: schema invalid: $.strategyId: must be non-empty"
```

Failure direction is safe (`stops: 0` — no intent ⇒ no act, E2 held),
but the documented kill path (`runner.stop`) is dead end-to-end: every
kill plan dies at intent before the port is reachable. Either the
executor omits `strategyId` when empty (and the journal accepts its
absence) or defines a canonical `kill:v1` template on both sides. The
probe shows the executor's own tables allow what the journal forbids —
a mirror drift the drift-guard tests don't cover (they pin tables, not
record-schema compatibility). Add an integration test: executor → real
`DecisionJournal` for ALL 12 actions.

### F5 — malformed (non-throwing) journal read silently bypasses dedup

§4 requires refusing when the journal is unreadable. A `read()` that
*resolves garbage* is coerced to empty:

```ts
records = Array.isArray(r?.records) ? r.records : [];
```

probe: `{read: async()=>({records:null})}` → `executed`, effects=1 —
no `journal-unreadable` refusal. A flaky/partial journal that returns
`{records: null}` (or a truncated array) defeats I2: a previously
executed, acked action re-executes. Throw is handled; garbage isn't.
Fix: treat a non-array `records` (and, ideally, records not all
plain objects) as unreadable → `refused('dedup','journal-unreadable')`.

## LOW

### F3 — the §5 "NEVER rejects" fence itself rejects on a revoked-Proxy error value

`probe-rerun`: hostile ctx whose getter throws a **revoked** Proxy →
the returned promise **rejects**. Cause: the top-level catch runs
`e instanceof ExecRefusal` (line ~816); `instanceof` on a revoked proxy
invokes `getPrototypeOf`, which throws a `TypeError` inside the catch —
escaping the fence. `describeError` is safe (field-by-field, each in
its own try), but `instanceof` runs first. All other hostile shapes
(pass-through Proxy, throwing-getter Proxy, revoked Proxy *plan* →
`refused/revalidate/plan-invalid:shape`) stay inside the fence; the
existing suite tests throwing-getter ctx but not revoked-proxy errors.
Fix: `if (ExecRefusal.isInstance?.(e) …)` is no help — instead wrap the
`instanceof` in try/catch or check `e?.constructor?.name` behind a
guard before falling through to `describeError`.

### F6 — ctx is re-read after validation; mid-flight mutation splits identity

The actionId digest is computed from the validated `ctx.taskId`, but
intent/outcome records and every dispatch request re-read `ctx.taskId`
/ `ctx.authority.grantedBy` *after* `journal.read()` awaited. Probe: a
`journal.read` hook that mutates `ctx.taskId='task-2'`,
`grantedBy='different-owner'` yields
`actionId=a-task-1-repair-…` while the intent authority says
`different-owner` and the repair request targets `task-2`. A trusted
port can desynchronize identity within one execution. Fix: freeze a
local snapshot of ctx fields right after validation (same discipline
already applied to the plan).

### F9 — unknown `reconcile` decision is treated as spawn

`RunnerPort` types the decision as `'spawn' | 'park' | 'running'`; the
switch handles `running`→refuse, `park`→refuse, and **anything else
falls through to spawn** (probe: `decision:'unknown'` → spawns, status
`executed`). Fail-open against a mis-typed/extended runner. Fix: spawn
only on the literal `'spawn'`; otherwise `refused('act','reconcile-unknown')`.

### F8 — nudge into a real P3b queue is not attempt-scoped (cross-component gap)

Probe with the real `FileSteeringQueue` bound to attempt `task-1-a2`:
a nudge carrying `attemptId: task-1-a1` is pushed and drained normally.
The executor trusts `ctx.attemptId` (correct locally — the plan can't
inject it), but no layer between executor and worker validates the
attempt binding; this is the P3b-audit F2 memory-push handoff seen from
the other end. Owner: queue/drain scoping, not exec.ts. Note only.

## Info / design notes

- **N1 — reservation closure is nobody's job yet.** The executor
  reserves (spawn actions) and never closes; `closeReservation` is
  referenced only by `ledger.ts` and its tests — the runner doesn't
  call it either. Per docs/12 §4 the check→reserve composition (and by
  extension attested close) lives in the P9 adapter; confirm the
  adapter wires reservation close on attempt terminal, or reservations
  age out by expiry instead of settlement.
- **N2 — at-least-once dispatch is inherent and correctly marked.**
  effect-then-throw probe: dispatch applies the effect then the port
  throws → outcome `no-effect: act-failed Error`, replay re-fires the
  effect (effects=2). Honest marker, but downstream consumers of
  `no-effect:` should read it as "no-effect *claimed*", not "no-effect
  *proven*" for dispatch ports with non-transactional acts.
- **N3 — concurrency is not serialized.** Two simultaneous identical
  calls both pass dedup (read-then-append with no lock) → effects=2.
  docs/15 defines a single-call contract; acceptable if the supervisor
  serializes per task. Worth a doc note at §4 ("caller MUST serialize").
- **N4 — un-acked, unmarked outcome ⇒ treated as executed (not
  replayable).** Correct fail-safe choice, already commented.

## What the probes confirmed as WORKING (against spec)

- **§2 hostile-input fence**: top-level Proxy plan, throwing `action`
  getter, prototype-chain getter, revoked Proxy plan — all →
  `refused(revalidate, plan-invalid:*)`, never a throw, never a partial
  read. `snapshotPlan` wraps every read in one fence; copies are fresh,
  dense-array-checked (`copyStrings` own-index loop, P14 S-F3).
- **E1**: plan fields never obeyed — `model` deleted from the snapshot
  unless the action is `model-swap`; policy passed to the gate as
  opaque `undefined`; `notAPermission !== true` →
  `plan-invalid:permission-flag` (absence of provenance ≠ permission).
- **`hold` sentinel** → status `held`, nothing journaled, nothing acted.
- **E2 intent-before-act**: intent append failure ⇒ zero acts (real
  journal kill probe: `stops: 0`).
- **Gate path (§14.3/docs/12 §4)**: check→denials (sanitized, verbatim
  codes) → no-effect marker → refused; reserve-throw ⇒ refused with
  `reserve-revoked-*` marker. Only the three spawn-side actions are
  gated (`LEDGER_ACTION = run/run/resume`); **kill correctly never
  gates** (docs/15 §3 line 162: "no — stopping burns nothing") and
  `acked = stopped === true` with `no-effect: stop-unconfirmed` marker.
- **§4 dedup**: deterministic `actionId` (FNV-1a over canonical JSON
  of the validated snapshot + `executionSeq`); clone-identical plans
  dedup; `intent-open` refused; `already-executed` refused; `no-effect`
  replays with `r<n>` journal-id suffix; `executionSeq` is the only
  legitimate re-execute lever. `GateRequest` mirror matches
  `ledger.ts:815` field-for-field.
- **E4**: outcome `progress` is the literal `'none'`, type-level and
  runtime; `acked` maps strictly to delivery (queue push / child
  spawned / confirmed stop / dispatch resolved), never worker attention
  (I6).
- **E6**: outcome-append failure returns `status:'executed',
  outcomeDurable:false` — never converted to failed, never re-run.
- **Backoff**: intent lands first; exponential capped 60 s; delay-port
  failure → no-effect marker, `failed/backoff`.
- **`describeError`** field-by-field with per-field try/catch (P14
  S-F5); stringly-thrown → `{name:'error'}`.
- **Compartment §7**: `src/executor` imports NOTHING (not even
  `node:`); guard test present; mirrors pinned against planner exports.
- `merge` → `merge-unwired` refusal (P12 contract) — correct today,
  but see F7: if/when wired, it hits the same strategyId-emptiness
  journal wall.

## Recommended fix order

1. **F1** identity equality (+ fold identity into the actionId digest).
2. **F7** strategyId emptiness vs journal schema (+ 12-action
   integration test against the real journal).
3. **F5** garbage `records` ⇒ journal-unreadable.
4. **F3** fence-safe `instanceof`; **F6** snapshot ctx after validation.
5. **F9** spawn only on literal `'spawn'`.
6. Doc notes: N3 (caller serialization), N2 (no-effect semantics), F8
   (queue scoping owner).
