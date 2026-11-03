# P14 acceptance evaluator — audit log

## R1 (self-adversarial, 2026-11-03)

Reviewed `src/acceptance/evaluator.ts` against docs/13 §1–§7 line by line.

**F1 (fixed, severity: correctness).** §4 precedence implemented out of
order: `blocked` was checked BEFORE the EV12 conjunction's
required-criterion check. A required semantic criterion that was
unfunded (no funding judgment at all — MISSING evidence) plus a current
blocker yielded `blocked`; spec says missing evidence outranks blocked
(EV9: "Missing-evidence rules (gates, artifact observations, semantic
funding) outrank `blocked`"). Fix: conjunction check (`verdict:
criterion-unfunded` → uncertain) now runs before the blocker rule;
`verdict:criterion-incomplete` (judge explicitly called it incomplete —
a concrete FINDING, not missing evidence) still outranks blocked via the
earlier branch. Spec docs/13 §4 amended with the R1-audit note. The
`blocked:`-hole AC7 fixture expectation was corrected in the same pass
(blocker inserted on an otherwise-green task = `blocked`, correct).

**F2 (fixed, severity: robustness).** `evaluate()` destructured
`input.claims ?? []` before validateInput — a non-array claims value
(`"yes"`) threw `TypeError: .map is not a function`, violating AC5
(never throws). Fix: `arr<T>()` coercion of all four arrays in the
defensive copy + `bad-input:claims not an array` recorded from the RAW
input; null elements in gates/artifacts/blockers/spec arrays now skipped
everywhere (bad-input already recorded).

**F3 (fixed, severity: hygiene).** `validateInput` wrote `c.dropped`
onto local claim copies that evaluate() never saw (dead drop-marking),
and a stray `void r` loop. Removed; claim drop/shape-check lives solely
in evaluate() on its own copies (caller objects never mutated — AC4,
pinned by the purity test).

**F4 (fixed, severity: hygiene).** `return bad.filter(x => !x.startsWith("dropped-claim:") || true)` — always-true predicate left from the restructure. Simplified; dropped-claim reporting is now per-claim in reasons.

**F5 (noted, accepted-by-design).** Two contradictory current-identity
gates (PASS+FAIL) → `bad-input:contradictory gate` (EV2) rather than
picking one — validated in `validateInput` currentById pass; confirmed
the map built there doesn't shadow judgment (judgment rebuilds
currentGate independently; last-write-wins there is unreachable because
contradiction already forces uncertain).

**F6 (noted, accepted-by-design).** `modelAdvisory` picks the LAST
model-judgment claim in input order (documented newest-last contract);
no timestamps on claims (§2 has none). If a caller interleaves stale
advice last, the advisory is stale — but AC8 keeps advice non-load-
bearing, so this is cosmetic. R2 should probe whether spec should say
so.

**Mutation spot-check:** ran the EV12 hole matrix (AC7 test) — each
removed conjunct flips complete; blockers hole lands on `blocked` per
the corrected spec.

Status: F1–F4 fixed; 50/50 acceptance tests, full suite green after
fixes. R2 (fresh adversarial pass on the fixed module) next.

## R2 (fresh adversarial probes vs built dist, 2026-11-03)

Probed `dist/src/acceptance/evaluator.js` directly (not through the test
file) for throw paths and optimistic-verdict leaks.

**F7 (fixed, AC5 violation).** `evaluate(null/undefined)` threw
`Cannot read properties of null (reading 'gates')` — spread of a null
input before any validation. Fix: object-shape guard at the top of
evaluate() returning the uncertain minimal record with
`bad-input:input not an object`; pinned by test.

**F8 (fixed, EV12 leak).** A current FAIL of a gate **not named in the
spec** (requiredChecks or criteria) did not break `complete` — EV12 says
"NO current FAIL anywhere". Fix: sweep `currentGate` for any
`pass:false` into `failedCurrent` (listed in remainingWork as
`check:<gid>`); pinned by test.

**F9 (noted, contract pinned by test).** Funding claims are
last-write-wins: an earlier `complete` claim followed by an `incomplete`
claim yields incomplete (later claim flips the row and marks
judgedIncomplete); the reverse order yields complete. Matches the
documented newest-last modelAdvisory contract; test pins both the
supersede and the advisory quote.

**F10 (accepted-by-design).** Frozen-input call runs clean (no in-place
mutation of caller objects — purity test + probe agree). Duplicate
evidenceRefs across distinct artifacts are allowed (refs are opaque
pointers; uniqueness is not in the contract).

Probes after fixes: 11/11 + full acceptance suite 53/53.
