# R5 review of R4 F15–F19 changes

> STATUS (superseded): the findings below were fixed in the working tree; see
> audit-r6-review.md (its own findings fixed per audit-r7/r8) and
> audit-r8-review.md (current verdict: PASS). All R5 regressions pass;
> repros .tre/tmp/r5-audit-repro.mjs — r7-audit-repro.mjs all green.

Verdict: REJECT pending ownership/refresh fixes.
Scope: src/runner/attempt.ts and test/attempt-runner.test.ts; reviewed current working tree, which also contains earlier H3/R1–R3 changes. Implementation and existing tests were not modified.

## R5-1 — Major: CLOSED-tuple refresh policy has a check/write race

Locations: src/runner/attempt.ts:1277–1304; confirmation append/clear at 1233–1240.

writeStateHint checks the journal outside enqueueSpawn, then awaits readState and writes state.json. A refresh can pass the check while the tuple is open, suspend, allow confirmStopped to append its confirmation and clear the hint, and then write a pid into the CLOSED tuple. It returns undefined (success), not the promised refusal. Reconcile then parks on the recreated identity.

Deterministic reproducer pauses the real writeStateHint at its async readState boundary (private method interception in JS, no implementation changes): start refresh with pid 777777; let confirmation of dead pid 999991 finish; release refresh. Result: confirmation=true, refresh warning=undefined, state pid=777777, reconcile=park.

Suggested fix: serialize public hint refreshes with the ownership transaction, with an internal already-locked hint writer for spawn/confirmation call sites to avoid recursive mutex deadlock. Include the CLOSED check, state read, and write in the same transaction. Add the overlapping refresh/confirmation regression, not just a refresh invoked after confirmation returns.

## R5-2 — Major: confirmation mixes state snapshots and misses accepted cross-task identities

Locations: src/runner/attempt.ts:1071–1072, 1097–1116, 1219–1235.

hintIds is derived from the first state read. At the second state read, confirmation adds only the own-task row; newly present cross-task matching rows are ignored. Final revalidation checks only journal changes, not state identity changes. A matching live t2 hint introduced between reads therefore survives without being probed; confirmStopped still appends confirmation=true, while the next reconcile parks on that live pid.

Reproducer: initial t1 hint pid 999991 (dead); immediately before the second read, update state with matching t2 hint pid 777777 (live). Confirmation succeeds. Reconcile subsequently reports park with pid 777777 running=true. The script schedules an ordinary writeEpisodeState at the actual async read boundary to make the race deterministic.

Suggested fix: use one shared candidate collector for protection/probing and serialize supported hint writers with confirmation; revalidate identity membership before appending if external state writers are supported. Merely recomputing at the second read still leaves the later probe/append interval unprotected. Add cross-task insertion/replacement during confirmation and require either refusal/retry or probing every newly accepted identity.

## R5-3 — Major, retained gap: analyze/run ignore own-row evidence that confirmation treats as authoritative

Locations: src/runner/attempt.ts:1112–1116 versus 1669–1675.

Confirmation deliberately adds a matching own-task hint even when journal pid evidence exists, citing a worker whose pid never reached the journal. Analyze includes hint candidates only when the journal candidate list is empty. This violates the claimed shared actual identity set.

Sequential repro (no race): journal ok pid=999991, pgid=999991, detached=true (dead); own-task matching hint pid=777777 (live). Reconcile says spawn; confirmStopped refuses ownership-fence naming the RUNNING pid; run successfully spawns t1-a2. Thus the spawn fence admits a second worker under the very evidence confirmation interprets as a live worker. This behavior predates the latest edit but remains relevant to F16's contract.

Suggested fix: centralize the process-evidence set, distinct from cohort enrichment eligibility. If this own-row hint is credible liveness evidence, analyze/fence must probe and honor it too. If hints lose authority once journal identity exists, enforce that consistently and document the safety justification rather than retaining a confirmation-only exception.

## Test coverage observation

The new F16 multi-row test inserts t2/live FIRST and t1/dead second. The old narrow implementation (first matching row plus own-task row) already probes both in this shape. It does not discriminate the full-set fix. Add three matching rows with first+own dead and a non-first/non-own row live (and an inconclusive variant).

## Verification

- npm run build: PASS.
- node --test dist/test/attempt-runner.test.js: 79 pass, 0 fail.
- git diff --check: PASS.
- node .tre/tmp/r5-audit-repro.mjs: all three finding assertions reproduced.
- R5-3 also performs real run()/stop(): run returns t1-a2 despite confirmation refusing the live hint.

Reproducer: .tre/tmp/r5-audit-repro.mjs. It uses deterministic injected pid verdicts and controlled async scheduling; it does not claim the synthetic pid is an actual OS process. Only the test sleeper spawned for the direct-run assertion is real, and it is stopped afterward.

F15 cohort-scoped closure and F17 direct-run group-only death had no additional reproduced finding in this review. Full repository suite was not rerun for this read-only audit; the targeted runner suite and build were rerun.
