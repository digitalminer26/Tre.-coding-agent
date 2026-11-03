# P14 audit of 891466f

Verdict: FINDINGS — not acceptance-ready.

Scope: read-only review of implementation, contract, tests, P4 integration;
adversarial Node probes against rebuilt dist. No implementation changes.
The previous R1/R2 log was produced by the implementing agent itself, not
an independent reviewer/fresh model family; its closure must not be presented
as an independent audit. This review is also a same-session review.

Verification: `npx tsc --pretty false`; `node --test dist/test/acceptance.test.js`
53/53 pass; `npm test` 1844 tests / 1830 pass / 0 fail / 14 skipped.
Full output: `.tre/p14-review-test.log`.

## F1 — Major: unknown artifact existence satisfies EV4

Location: src/acceptance/evaluator.ts:498–501; validation :270–277.
Repro: otherwise-green input expects `out`; pass artifact evidence
`{path:'out', at:current, evidenceRef:'file'}` without exists or digest.
Result: complete, no reasons. `exists:'yes'` also completes.
Expected: missing existence observation -> uncertain; invalid exists type ->
bad-input. EV4 requires exactly exists:true + non-empty digest at current.
Fix: explicitly classify each expected artifact as satisfied only with
exists===true and valid digest; false is incomplete; unknown is uncertain.
Validate exists/digest optional-field types. Add regressions for omitted,
undefined and malformed existence values.

## F2 — Major: malformed evidence arrays disappear before validation

Location: src/acceptance/evaluator.ts:341–347, 373–374.
Repro: otherwise-green input with blockers null, {}, 'yes' or 1.
Result for each: complete, no bad-input. Only raw claims shape is checked.
A malformed artifacts array also completes when no artifacts are expected;
a malformed gates array with empty check/criterion lists also completes.
Expected: AC5 uncertain + bad-input on every malformed input array.
Fix: validate all four raw arrays before normalization, without throwing.
Do not allow a broken blocker list to become proof of no blockers.

## F3 — Major: semantic judgments have no artifact/revision binding

Location: src/acceptance/evaluator.ts:77–86, 449–465.
Repro: evaluate old SHA with a passing gate and semantic complete claim;
then change current SHA and refresh only the gate, retaining the old claim.
Result: complete at the new SHA. No stale semantic evidence is reported.
EV6 requires a CURRENT model judgment, but ClaimEvidence has neither at nor
revision, so the evaluator cannot enforce freshness. Stored-assessment
isStale does not prevent a stale claim from funding a fresh assessment.
Fix the contract first: bind semantic evidence to artifact identity (and
revision/criterion version as needed); filter stale claims before funding.
Add stale-positive and stale-negative judgment regressions.

## F4 — Major: model judgment alone proves completion

Location: src/acceptance/evaluator.ts:438–465, 545–557.
Repro: spec has one required semantic criterion, no required checks or
artifacts; gates/artifacts empty; a confidence-1 complete judgment names
that criterion. Result: complete.
Contradicts AC1's unconditional promise that any ClaimEvidence alone cannot
prove complete and no current deterministic evidence implies uncertain.
Fix: enforce an explicit current non-model-evidence floor, or resolve the
contradictory AC1/EV12 contracts explicitly before implementation. A
vacuously green conjunction is not the AC1 guarantee currently documented.

## F5 — Major: promised S5 output validation is absent

Location: src/acceptance/evaluator.ts:381–386, 457, 628–645;
src/episode/journal.ts:317–332, 427–432.
Repro A: complete model claim with judge:23, evidenceRefs:[{}] passes claim
validation, yields complete with object-valued criteria[].evidenceRef and
number-valued modelAdvisory.judge. It cannot satisfy the known P4 shape.
Repro B: toAcceptanceRecord({...assessment, taskRevision:-5,
criteria:[{id:17,pass:'yes'}]}) returns a record, rather than rejecting it;
P4 validation rejects this output. Converter checks only verdict.
Repro C: P4 validateSupervisorRecord accepts a valid envelope with
staleEvidenceRefs:[42] and criteria:[{id:'s',pass:true,advisory:'yes'}],
because new P14 fields remain unknown additive properties. P4 interfaces
also do not declare the new fields.
Fix: validate the entire converter output and all claim fields consumed as
output. Update P4 types and schemas for the amended optional fields. Add
converter-to-P4 validation and durable round-trip tests, including malformed
extensions. Preserve backwards compatibility for pre-amendment records.

## F6 — Major: missing evidence outranks a concrete semantic failure

Location: src/acceptance/evaluator.ts:529–540; docs/13 §4.
Repro: required deterministic gate missing; a model judgment explicitly
marks a required semantic criterion incomplete. Result: uncertain with
verdict:check-missing. The normative ladder places current FAIL
 gate/criterion -> incomplete before missing required evidence.
Fix: resolve semantic incomplete consistently with the promised current
criterion-failure precedence, then test negative semantic finding combined
with missing gates and missing artifact observations. Do not only test it
against a blocker.

## F7 — Minor: malformed stored identities can be live

Location: src/acceptance/evaluator.ts:602–605, 145–154.
Repro: stored.artifact={sha:''}, current.artifact={sha:''}, matching revision.
Result: isStale false. Empty SHA is expressly not an identity (§1).
Likewise sameArtifact ignores malformed non-true dirty values in this API.
Fix: validate stored/current artifact identities (including non-empty sha)
and revision before returning live; malformed stored assessments stay stale.

## Documentation / audit limits

- docs/13 header still says pre-implementation CONTRACT.
- HANDOFF says compartment positive fixtures exist in the new test file;
  the file copies the regex but has no corresponding positive fixtures.
- The prior R1/R2 records are self-review/probes, not independent audit.
- Passing existing tests does not cover the counterexamples above.

No fixes or commits performed by this review.
