# R8 audit — refresh-first regression fix

Verdict: PASS. No actionable findings in the latest test-only fix. R7-1 is resolved.

Scope: the R5-1 title correction and new R7-1 test in test/attempt-runner.test.ts:1599–1677, plus the R7 report's resolution note. This is not a new audit of the entire accumulated uncommitted runner implementation.

## Review

- Existing R5-1 title now correctly describes confirmation-first ordering.
- R7-1 starts writeStateHint, waits for its first readState barrier, and only then requests confirmation. With the current queue implementation that barrier is inside the refresh transaction, so the test pins refresh-first ownership without sleeps or scheduler timing assumptions.
- Probe inputs distinguish the old dead journal identity (999991) from the refreshed live hint (777777).
- Assertions cover successful refresh, the persisted live hint, confirmation refusal naming the refreshed pid, no confirmation journal record, and reconcile parking. The no-closure assertion prevents a refusal after a durable closure from passing unnoticed.
- The state read after refresh checks persistence; the stronger sequencing guarantee comes from the transaction queue and the gate, not from that assertion's wording that confirmation has not yet run.
- No real worker is spawned by this seeded test. Runner cleanup is registered.

## Mutation check

Created disposable compiled copies of runner and test modules. In the runner copy only, replaced public writeStateHint's enqueueSpawn wrapper with a direct call to writeStateHintLocked. Ran only R7-1 against that copy.

Result: correctly FAILS with `Missing expected rejection: the queued confirmation sees the refreshed live identity and refuses`. This demonstrates that the new test detects removal of refresh serialization. Disposable compiled copies were removed before the full suite; source files were not modified.

## Verification

- npm run build: PASS.
- node --test dist/test/attempt-runner.test.js: 86 passed, 0 failed.
- R7-1 isolated run repeated 15 times: 15/15 PASS.
- Mutation check: expected failure observed.
- npm test: 1711 tests, 1697 passed, 0 failed, 14 skipped; quality gate passed.
- git diff --check: PASS.

Logs: .tre/tmp/r8-runner.log, .tre/tmp/r8-repeat.log (last isolated run), .tre/tmp/r8-mutation.log, .tre/tmp/r8-full.log.

Implementation and test source files were left unchanged during this audit. The R7 report's approximate new-test line reference says 1634; the declaration is at 1637. This does not affect the resolution or test behavior.
