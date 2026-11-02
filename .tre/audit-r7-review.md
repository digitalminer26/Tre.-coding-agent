# R7 audit — review of R6 fixes

Verdict: behavioral fixes PASS; requested regression coverage remains incomplete (one medium finding). No new ownership bypass reproduced in the checked paths. This is a focused audit of the latest R6 changes, not a fresh certification of the entire accumulated uncommitted diff (897 source / 915 test changed lines).

Implementation and committed-suite test sources were not modified during this audit.

## R7-1 — Medium: requested refresh-first regression still missing

Location: test/attempt-runner.test.ts:1599–1630.

The R5-1 title says a refresh is queued before confirmation, but the body calls confirmStopped first, waits until confirmation owns the queue, then calls writeStateHint. It tests confirmation-first ordering only. The R6 audit explicitly requested a refresh-first regression; the latest fix added three R6 tests but did not add that ordering.

Independent audit experiment now checks the missing ordering: block the first readState inside writeStateHint, request confirmation while refresh owns the queue, release refresh, and assert the live identity is written, confirmation refuses ownership-fence, no confirmation record is appended, and reconcile parks. This passes, so this finding is a regression-coverage gap, not a demonstrated implementation bug.

Suggested fix: add that discriminating test to test/attempt-runner.test.ts and rename the existing R5-1 test to accurately describe confirmation-first ordering. Audit artifact: .tre/tmp/r7-audit-repro.mjs.

RESOLVED (fix pass): the R5-1 test is renamed to "queued AFTER a confirmation" (test/attempt-runner.test.ts:1599), and a new `R7-1` regression (test/attempt-runner.test.ts:1637) pins the true refresh-FIRST ordering: the refresh holds the queue, confirmation queues behind it, and the confirmation must refuse ownership-fence on the refreshed pid 777777 with no closure record appended and reconcile still parking. Runner suite 86/86; full suite 1697 pass / 0 fail / 14 skipped.

## Resolved findings

- R6-1: analyze excludes only the exited own child's pid instead of skipping the tuple's entire probe loop; the own-exit fence branch now honors independent positive/inconclusive evidence. Own-exited child plus live, foreign-uid live, and inconclusive hint experiments all make reconcile park, confirm refuse, and run refuse. Existing 85 runner tests pass.
- R6-2: confirmation validates canonical caller session against canonical journal-bound session before probing or mutation. Wrong-session calls with either own-row or cross-task live hints refuse bad-input and append no closure. The actual session still parks.
- R6-3: the comment at src/runner/attempt.ts:1245–1255 now explicitly limits supported state writers to the runner's serialized paths and describes revalidation as best-effort rather than atomic. This satisfies the documentation option in R6. The old external-write injection still permits confirmation then reconcile parks, as expected outside that contract. This is not hard atomicity against external writers.

## Verification

- npm run build: PASS.
- node --test dist/test/attempt-runner.test.js: 85 passed, 0 failed.
- node .tre/tmp/r6-audit-repro.mjs: PASS (including acknowledged external-writer limitation).
- node .tre/tmp/r7-audit-repro.mjs: six adversarial cases PASS: refresh-first; own-exited plus live/foreign/inconclusive hints; wrong session with own/cross-task hints.
- npm test: 1710 tests, 1696 passed, 0 failed, 14 skipped; quality-check passed.
- git diff --check: PASS.

Injected pid statuses are deterministic test inputs, not observations that those numeric pids identify real workers. Real spawned sleepers are stopped before fixture cleanup.
