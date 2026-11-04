# Audit round 4 — P11 executor (src/executor/exec.ts)

**Date:** 2026-11-05 · **Predecessors:** R1, R2, R3 · **Method:** 3 driven
cycles of a hostile-executor model. Rounds 1–3 audited hostile *inputs*
(plans, contexts, port values). Round 4 audits the two things those rounds
**assumed**: (a) what each port answer actually *means*, and (b) whether
the journaled record equals what was *obeyed*.
**Final state: 2082 pass / 0 fail / 14 skipped · `tsc --noEmit` clean ·
76 executor tests.**

## R4-A (HIGH) — an unconfirmed kill was "no effect" and was re-issued

`runner.stop()` resolving `{stopped:false}` reports that the runner
**could not confirm** the kill. It does not report that nothing happened.
The code journaled `no-effect: stop-unconfirmed`, and `no-effect:` is the
marker that makes an action **replayable** (§4 step 2):

```
1st: executed acked=false  notes=["no-effect: stop-unconfirmed"]
2nd: executed/             STOPS=2
```

A second `stop` was issued against the same session — the exact double-kill
the marker exists to prevent, and **the third instance of the R3-B1 bug
class** (an unprovable "nothing happened"). The comment sitting on that
line claimed the opposite of what the code did.

**Fix:** `act-unknown: stop-unconfirmed`. Unconfirmed ⇒ UNKNOWN ⇒ never
replayed; re-killing requires NEW intent (a changed plan ⇒ a new
`actionId`). Verified: `STOPS=1`, second call `refused(already-executed)`.

### R4-A2 — the same path via a hostile getter

A throwing `stopped` getter also landed in the old `no-effect` branch
(`portField` returns `undefined` on a trap, and `undefined !== true`).
Two kills, both journaled "no effect". Same fix; pinned separately.

### R4-A3 — evidence claimed a stop that was never confirmed

`evidenceRefs: ["stop:session"]` was emitted unconditionally, i.e. the
record asserted a confirmed stop for an unconfirmed one. The ref is now
`stop:session-unconfirmed` when `acked` is false.

## R4-B (MEDIUM) — the journaled rationale was shorter than what was obeyed

Structural validation accepts `rationale` as 64 strings × 512 chars and the
joined text is then **obeyed** — it is the `nudge` steer text and the
payload handed to `dispatch.escalate`. R3 bounded the *record* to 4096,
which meant the executor could obey far more than it recorded:

```
R4-B escalate: obeyed 32831 chars → journaled 4096 chars
R4-C nudge:    pushed 32836 chars → journaled 4096 chars
```

A durable record that understates the act is worse than no bound at all:
recovery reasoning §14.3/I5 closes intents against *observed reality*, and
the journal is the reality it reads. R3 fixed the symptom (record size);
R4 fixed the cause — the budget is enforced in `snapshotPlan`
(`plan-invalid:rationale-budget`), so an over-budget rationale is refused
before it is journaled OR obeyed. Now: 0 records, 0 bytes obeyed.

## Cleared (probed, no defect)

- **Round trip through the real `DecisionJournal`.** Intent under the real
  schema: `strategyId:"park:v1"`, `rationale:"x".repeat(4096)`, `actedById:
  "x".repeat(512)` **all accepted**. The executor's own values sit far
  below every ceiling (`actionId ≈ 27`, `attemptId ≤ 512`, `MAX_MODEL`,
  `expectedEvidence ≤ 512`), so the R3 truncation did not silently corrupt
  records on the production journal. Worth pinning — the executor is tested
  against `JournalPort` fakes, which cannot catch a schema mismatch.
- **Unrepresentable `executionSeq`.** `actionId` is 32-bit FNV-1a, so
  seq `n` and `n + 2³²` collide. The caller must serialize per task (N3)
  and cannot reach the collision without owning that counter.
- **Backoff `attemptNumber`.** Parsed with `Math.max(1, parseInt(...))`
  from a `SAFE_ID`-validated `ctx.attemptId`; huge values saturate to the
  60 s cap rather than overflowing.

## Cross-round observation

R3-B1 ("a throw after the effect is not a no-effect"), R4-A ("an
unconfirmed effect is not a no-effect") and R4-A2 (the same via a getter)
are **one bug class, found three times**: the executor writing
`no-effect:` on evidence that does not support it. The invariant is now
stated positively in §4 step 7 as a table with a single rule — *the marker
may be written only when the executor can prove nothing happened* — rather
than as three independent guards. A future port that can answer
"couldn't tell" must journal `act-unknown:`, never `no-effect:`.

## Tests

`R4-A` unconfirmed-kill non-replayability (`stops === 1`, `act-unknown:`
note, honest evidence ref), `R4-A` hostile-getter kill, `R4-B` plan-time
rationale budget (refused, nothing journaled, nothing obeyed). Existing
tests updated where they had pinned the old contract: the `kill`
confirmed/unconfirmed test now asserts `act-unknown:`, and `R3-B4` flipped
from "truncated to 4096" to "refused at plan time".

Gate: **2082 pass / 0 fail / 14 skipped · tsc clean · probes
g1/round2/cycle2/cycle3/cycle4 + replay-b1 converge.**
