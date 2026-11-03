# P14 audit cycle 2 — efd1866

Verdict: FINDINGS. Same-session read-only review, NOT a cross-model audit.
No implementation edits or commits performed.

Verification: npx tsc --pretty false clean; acceptance 68/68 pass;
npm test 1859 total / 1845 pass / 0 fail / 14 skipped. Adversarial Node
probes against rebuilt dist reproduced the findings below.

## C2-F1 — Major: evidence floor suppresses a proven missing artifact

Location: src/acceptance/evaluator.ts:586–588, 609–615.
Repro: spec {criteria:[],requiredChecks:[],artifacts:['out']}; gates:[];
artifacts:[{path:'out',exists:false,at:current,evidenceRef:'missing'}].
Actual: uncertain, verdict:no-current-non-model-evidence.
Expected EV4: incomplete, verdict:artifact-missing. An observed negative
artifact result is concrete non-model evidence, not absence of evidence.
The new floor counts only SATISFIED artifact observations and runs before
the proven-missing branch. Fix: apply the floor only to eligibility for
complete, after all concrete-negative branches; preserve incomplete for
observed missing artifacts. Add an artifact-only negative regression.

## C2-F2 — Major: deterministic criteria incorrectly classified claims-only

Location: src/acceptance/evaluator.ts:585, 594–598.
Repro: criteria:[{id:'g',kind:'deterministic',required:true}],
requiredChecks:[], artifacts:[], current gate g PASS.
Actual: uncertain, verdict:claims-only-spec. With g FAIL it STILL returns
uncertain, masking EV3's concrete failure.
This spec is not claims-only: EV7 expressly lets deterministic criteria
bind their IDs to gates; no rule requires repeating them in requiredChecks.
The original F4 issue was CLAIMS ALONE proving complete, not lack of
redundant check declarations. Fix: recognize required deterministic criteria
as evidence requirements; enforce a non-model floor at the completion branch,
not by rejecting valid acceptance shapes. Keep current FAIL incomplete
regardless of spec membership. Test PASS and FAIL criterion-only specs.

## C2-F3 — Major: F5 output-validation closure remains incomplete

Locations: src/acceptance/evaluator.ts:413, 464, 767–768;
src/episode/journal.ts:443–445.
Repro A: otherwise-green funding claim with judge:'' and at:current.
evaluate returns complete; toAcceptanceRecord succeeds; P4 rejects
$.modelAdvisory.judge as empty. This is an evaluator-produced output, not
merely an artificially corrupted assessment.
Repro B: accepted clean identities with dirtyDigest:'' yield complete;
converter succeeds; P4 rejects $.artifact.dirtyDigest as empty.
Repro C: converter accepts modelAdvisory.confidence:-1; P4 rejects it
(minimum 0). assertAssessment checks only finite number, not bounds.
Fix: align claim intake, identity rules and converter validation with P4's
actual field constraints; test converter success implies P4 validation
success for a valid supervisor envelope. Reject/drop empty judge or default
it consistently; validate optional digest shape consistently. Also remove
nullable from the new P4 artifact shape unless explicitly documented:
artifact:null currently passes journal validation despite the TS/contract
field being optional object, not nullable object.

## C2-F4 — Minor: stored assessments with invalid revisions remain live

Location: src/acceptance/evaluator.ts:695–698.
Repro: same valid artifact and matching taskRevision values of 0, -1,
1.5, or undefined on stored/current -> isStale false in every case.
F7 fixed empty identities but liveness still treats malformed revisions as
live, despite positive-integer revision requirements. Fix: validate both
revisions before equality and return stale on malformed values.

## C2-F5 — Minor: audit/verification records overstate what ran

Locations: HANDOFF.md:3,11; docs/13 header and section 8;
.tre/audit-p14-fixes.md suite paragraph; docs/11 ledger row.
Claimed: 75 acceptance tests. Actual rebuilt acceptance suite: 68.
Claimed: independent review; the underlying audit report explicitly says
same-session review, NOT independent/fresh model family. HANDOFF later
acknowledges this while still calling the review independent at the top.
The round-trip tests call validateSupervisorRecord, not durable
DecisionJournal append/reopen; no durable round-trip regression was added.
Fix: correct counts and provenance consistently; distinguish field-validation
round trips from persisted journal round trips. Do not mark audit acceptance
closed on these records.

## Previous finding closure assessment

F1: false-complete for omitted exists fixed, but negative-artifact regression
introduced (C2-F1).
F2: raw-array shape checks fixed.
F3: artifact binding implemented; stale/unbound claims no longer fund criteria.
F4: claims-only complete leak fixed, but criterion-only regression introduced
(C2-F2).
F5: types and schema extended, malformed original repros rejected, but schema
parity remains incomplete (C2-F3).
F6: judge-negative now outranks missing evidence for declared check/artifact
specs; claims-only cap still precedes it by the revised contract.
F7: empty-sha identities fixed; malformed revisions remain live (C2-F4).
Positive compartment fixtures added and pass.

Recommendation: fix C2-F1–F3 before acceptance; correct C2-F4–F5 and run a
fresh review. Existing green suite does not cover these counterexamples.
