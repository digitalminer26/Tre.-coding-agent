# P14 fix cycle — response to audit-p14-review (F1–F7)

All seven findings from `.tre/audit-p14-review.md` (against commit `891466f`)
closed. Contract amendments recorded in docs/13 §8; docs/11 ledger row
extended. Every fix carries a named regression; the review's original repros
were re-run against the rebuilt dist and all land on the corrected verdicts.

**F1 — artifact existence strictness (EV4).** `exists` absent or non-boolean
is an UNKNOWN observation → `uncertain` (`verdict:artifact-unobserved`);
a present-but-wrong-typed `exists` is additionally `bad-input`; a present
non-empty-string `digest` is required when `exists:true` (malformed digest →
`bad-input`). Satisfaction now requires the exact shape
`(exists === true, non-empty string digest)` at the current identity —
judged defensively in the artifact loop as well as validated upfront.

**F2 — raw-array validation.** All four evidence arrays (`gates`,
`artifacts`, `claims`, `blockers`) are shape-checked on the RAW input;
a non-array is `bad-input:<field> not an array` and the verdict is
`uncertain` — no array ever collapses to silently-empty (a broken blocker
list can no longer become proof of no blockers).

**F3 — claim identity binding.** `ClaimEvidence.at` added (docs/13 §2/§8).
Only claims with a well-formed `at` that `sameArtifact`s the current
identity may fund or fail a criterion (`currentClaims` filter). Unbound
claims (no `at`) fund nothing; stale claims fund nothing and their
`evidenceRefs` are listed in `staleEvidenceRefs`. `modelAdvisory` still
shows the latest judgment (advice is never load-bearing). The audit's
killer repro — new sha + refreshed gate + old claim — now lands `uncertain`.

**F4 — the unconditional AC1 floor.** A spec with NO required checks and NO
expected artifacts is malformed by construction → `verdict:claims-only-spec`
(uncertain). A spec with the evidence shape but zero current observations →
`verdict:no-current-non-model-evidence` (uncertain). `complete` requires
≥1 current non-model evidence. `remainingWork` names the missing shape.

**F5 — full output validation (two fences).** (a) Claim fields consumed by
the OUTPUT (`judge`, `evidenceRefs[]`, well-formed `at`) are part of claim
shape — malformed → the claim is dropped as advice, no garbage reaches the
record. (b) `toAcceptanceRecord` now validates the COMPLETE assessment
(`assertAssessment`: taskId/revision/criteria row shapes/AC8
advisory-without-sha/remainingWork/staleEvidenceRefs/artifact/modelAdvisory/
reasons) and throws `TypeError` on corruption — including the audit's
`taskRevision:-5, criteria:[{id:17,pass:'yes'}]` repro. (c) The P4 journal
schema (`src/episode/journal.ts`) now validates the amended fields:
`criteria[].advisory` (literal-true shape), `staleEvidenceRefs` (string
array), `artifact` (sha required, dirty/dirtyDigest typed); the TS
interfaces declare them; `JsonSchema.enum` widened to admit boolean
literals. Pre-amendment records stay valid (additive). Round-trip tests:
evaluate → toAcceptanceRecord → validateSupervisorRecord, both plain and
with amended fields.

**F6 — judge-declared incomplete is a concrete finding.** Re-scoped in the
precedence ladder: a required criterion the (current, bound) judge
explicitly calls incomplete outranks ALL missing-evidence rules — including
the new F4 evidence floor — and yields `incomplete` with
`verdict:criterion-incomplete`. Rationale: absence of evidence never
outranks presence of a finding. Ladder order (docs/13 §4 + §8): bad input >
claims-only cap > judge-incomplete > no-current-non-model-evidence floor >
current FAIL > artifact exists:false > unobserved artifact > missing gate >
criterion unfunded > blocked > complete > default uncertain.

**F7 — identity validation in liveness.** `sameArtifact` now returns false
for malformed or empty-sha identities (an empty sha is not an identity, §1);
`isStale` treats a malformed stored artifact, empty sha, or malformed
current identity as never-live. A stored `{sha:''}` assessment at a
`{sha:''}` current is stale, not live.

**Suite:** 75 acceptance tests (68 prior-shape adjusted + F1–F7 regressions
+ P4 round-trip + guard positive fixtures), full suite
**1859 / 1845 pass / 0 fail / 14 skipped**, `npm test` (gate + tsc + suite)
exit 0.

**Accepted-by-design (from the review, noted not fixed):** none — all seven
findings were fixed. Residual scope note: review was same-session (read-only
reviewer lens), not a fresh cross-model family; a follow-up cross-model
audit round remains open before the P14 roadmap row flips to accepted.

---

## Cycle-2 addendum (C2-F5, 2026-11-03)

`.tre/audit-p14-cycle2.md` found this record overstating verification:
(a) the "75 acceptance tests" count above was wrong — the rebuilt suite was
**68** (cycle 2 grew it to 78); (b) this cycle was a SAME-SESSION reviewer
lens (the review itself says so) and must not be described as an independent
audit; (c) the round-trip tests above exercised `validateSupervisorRecord`
field validation, not durable persistence — cycle 2 added a real
`DecisionJournal.open`→`append`→`read` round-trip plus an `artifact:null`
fails-closed-on-reopen regression. All corrected in HANDOFF.md, docs/13 §9,
and the docs/11 ledger. Cross-model audit round remains the open
acceptance gate.
