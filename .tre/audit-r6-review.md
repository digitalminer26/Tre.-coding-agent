# R6 audit of R5 fixes

> STATUS (superseded): R6-1 and R6-2 fixed in the working tree; R6-3 resolved
> via the explicit writer-contract documentation option. See
> audit-r7-review.md (R7-1 coverage gap, since fixed) and audit-r8-review.md
> (current verdict: PASS). Repro .tre/tmp/r6-audit-repro.mjs is green with
> corrected expectations.

Verdict: REJECT. Two major evidence-consistency gaps remain; external-writer atomicity also needs an explicit contract.

Scope: latest changes in src/runner/attempt.ts and test/attempt-runner.test.ts. Existing implementation/tests left unchanged. New audit artifact: .tre/tmp/r6-audit-repro.mjs.

## R6-1 — Major: own-child exit bypasses independent live hint evidence

Location: src/runner/attempt.ts:1686–1687 (and own-exit continuation in fenceOrThrow).

analyze skips the entire candidate probe loop whenever view.live is defined, including false. Own-child exit proves the death of that particular child, not every independent matching hint identity. R5's newly documented policy treats these matching rows as independent process evidence, and confirmStopped does probe them.

Repro: run a real sleeper, stop it (own child/group dead), call the public writeStateHint with the same attemptId/session and injected-live pid 777777. The write succeeds because the tuple has not been confirmed. Reconcile returns spawn, confirmation refuses ownership-fence on pid 777777, and a real run succeeds (t1-a3 in the reproducer). The spawned sleepers are stopped.

Fix: own-child exit must discharge only that child's identity; continue collecting/probing other accepted identities and honor their positive/inconclusive evidence in blocking and fence logic. Removing just the skip is insufficient if a.live===false still bypasses a non-negative probe later. Add own-exited-child plus distinct live/inconclusive hint regressions, with confirmation/reconcile/run agreement.

## R6-2 — Major: confirmation's caller session can hide recorded-session hints

Locations: src/runner/attempt.ts:1029–1032, 1117–1118, 1241–1242.

confirmStopped locates the tuple by episode/task/attempt, but never validates t.session against latest.sessionPath. Candidate hint collection and final hint validation use the caller's t.session, whereas analyze uses the journalled view.record.sessionPath. resume already enforces the journal session binding.

Repro: journal ok pid/group 999991 (injected dead, group ESRCH); matching hints t1=999991 and t2=777777 (injected live) on the recorded session. Reconcile parks. Call confirmStopped with session+'.other' and the same task/attempt. It succeeds and appends confirmation=true because no hints match the unrelated supplied path; reconcile of the real session still parks on 777777.

Fix: reject a confirmation whose canonical caller session differs from the journal-bound session, before probes/mutations, and derive identity collection from the recorded binding. Add wrong-session confirmation regressions for live cross-task and own-row hints.

## R6-3 — Medium / contract gap: external state revalidation is not atomic with closure

Locations: src/runner/attempt.ts:1236–1248.

The new final state read detects edits during the earlier probe interval but does not serialize external writers with the durable append. An edit after that read and before the append escapes. Public writeStateHint now shares the queue correctly; the remaining issue specifically concerns external writeEpisodeState calls, which the new comment explicitly discusses.

Deterministic repro intercepts appendRecord immediately before forwarding to the real method, introduces a matching live t2 row with writeEpisodeState, then lets the real append proceed. confirmStopped returns confirmation=true; reconcile parks on the live hint.

Fix options: establish a shared state/journal ownership boundary for all supported writers, or explicitly require all ownership-identity writes to go through the serialized runner and document final revalidation as best-effort detection of unsupported edits, not external-writer atomicity. A second read alone cannot eliminate the interval. Add a boundary test appropriate to the chosen contract.

## Verification

- npm run build: PASS.
- node --test dist/test/attempt-runner.test.js: 82 pass, 0 fail.
- git diff --check: PASS.
- node .tre/tmp/r6-audit-repro.mjs: all three reproducer assertions PASS (demonstrating the gaps).
- Injected liveness is deterministic test evidence, not a claim that pid 777777 is a real process.
- Full repository suite not rerun during this audit.

The R5 public refresh queue and changed-snapshot refusal work in the checked paths. The new R5-1 test queues refresh AFTER confirmation (despite its title saying before); it does not test the audit's original refresh-first ordering. The queue implementation appears to cover both, but a refresh-first regression should verify confirmation sees the refreshed evidence rather than relying solely on the reversed schedule.
