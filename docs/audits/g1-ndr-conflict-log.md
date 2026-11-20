# G1 NDR register — conflict log (Plan B, v22)

Companion to `docs/audits/g1-plan-b-canonicalization.md` and §14.10.0 of
`docs/11-orchestrator-schema.md`. Two jobs:

1. **Demotion log** — every sentence REMOVED from a statement site in the
   v21→v22 citation conversion, preserved verbatim with its site, so each
   historical fold remains re-verifiable against the register.
2. **Round-4 finding → NDR mapping** — where each cycle-5…15 finding's
   fix now lives canonically.

Rules: nothing was ever deleted from the document without appearing here;
the register entry governs over any text in this file.

## 1. Demotions (v21 → v22)

### §14.12.2 finalization table — class-O row

Demoted (replaced by `per NDR-l` / `per NDR-h` / `per NDR-m` citations):

> **result after each valid disposition: damage-kind `refiled` ⇒ act terminal-by-damage, fresh finding live evidence, no O/B item remains; damage-kind `withdrawn` ⇒ act terminal-by-damage, claim retired, no O/B item remains (needs-owner was cleared BY the disposition — the disposition record is itself the clearing evidence replay checks); the group kind (`readjudication-group`, whose only admissible disposition is `withdrawn`) behaves EXACTLY like damage-kind `withdrawn` (v19 R5-C13-1/2 — act terminal-by-damage, claim retired, invalid R1 permanently fault-superseded and never a resolution target — v18's "terminal-by-refusal via restored R1" was FALSE for a fault-adjudicated-invalid R1), no O/B item remains; `intake-refusal` `refiled` ⇒ terminal-by-disposition, none; `intake-refusal` `withdrawn` ⇒ class B until the re-adjudication outcome lands, then applied or terminal-by-refusal per the ordinary rules**

> the faulted act is excluded from class B on the fault record's EXISTENCE for damage kinds (`effect-record`, `findingRef-artifact`, `act-payload`, `readjudication-group` — the fourth kind folded into this row v18 R5-C12-1) — open OR disposed (v19 R5-C13-1/2: the group kind's exclusion is UNCONDITIONAL — open OR disposed — like every damage kind; v18's "EXCEPT the group kind … restores terminal-by-refusal standing via the superseded R1" was FALSE, see the result table below) — and after disposition is TERMINAL-BY-DAMAGE, never re-classified as outstanding; an `intake-refusal` fault's EXCLUDED-FROM-B effect is disposition-dependent (v14 R5-C8-1: `refiled` ⇒ terminal-by-disposition, no item; `withdrawn` ⇒ `readjudication-owed` = CLASS B drain-progressing until its outcome record lands — NOT an O item; a disposed `intake-refusal` fault contributes NOTHING to O); one fault record per identity (`(actId, failingCheck)`, plus `refusalRecordId` for `intake-refusal`) for all time, never re-minted by post-disposition re-observation;

Governing register entries: NDR-h (fault shape/identity/exclusion),
NDR-l (terminal taxonomy + per-disposition results), NDR-m (finalization
predicate). No semantic change — the O row's predicate ("UNDISPOSITIONED
fault CONDITION only", v14 R5-C8-6) STAYS in the cell verbatim.

### §14.12.2 finalization table — class-B row

Demoted:

> **and NOT for an act under an open/undisposed `readjudication-group` fault (v18 R5-C12-1: the group fault's EXISTENCE excludes the act from B like the other damage kinds; `readjudication-owed` is suspended while the group fault is open — the fault is the act's item, not an owed outcome; group `withdrawn` ⇒ the act is TERMINAL-BY-DAMAGE with its claim RETIRED (v20 R5-C14-1 — v19 left this sentence saying "terminal-by-refusal via the superseded R1 standing restored", contradicting this row's own O-row result table and the §14.10.3 precedence rule; invalid R1 is never restored and never a resolution target) — NOT this class, no outcome owed, no O item either (the disposition record is the clearing evidence)**

> **EXCEPT (v14 R5-C8-1) an act whose only fault is `intake-refusal` with disposition `withdrawn` and NO re-adjudication outcome record yet: that act is `readjudication-owed` — ordinary intake work the supervisor owes and can complete — so it sits in THIS class (drain-progressing, NOT O, NOT terminal) until its outcome lands (applied ⇒ applied; new bound refusal ⇒ terminal-by-refusal)**

> EXCLUDING a filing-class act that is **terminal-by-refusal** under §14.10.3 (v9 R4-C3-2: its never-created finding is NOT an owed record; the unresolved filing-refusal condition (drift, mapping, or any exhaustive-rule intake refusal, v10 R5-C4-2 / v11 R5-C5-5) in the O row IS its class-O item, so no act is ever simultaneously terminal (intake-refused) and owed (class B))

Governing register entries: NDR-h, NDR-i (append order for outcome
landing), NDR-k (kind-wise recovery), NDR-l, NDR-m. No semantic change.

## 2. Demotions (v22, second conversion pass — §14.10.3 outcome paragraphs)

### §14.10.3 — terminal-outcome summary (R2 terminality clause)

Demoted (replaced by `per NDR-d` citation):

> the PINNED prefix **per the two-class exception (v16 R5-C10-2, swept v20 R5-C14-2): a PINNED refusal (verdict consumed P(W)) binds the prefix P(W) named by W's binding pair, NOT its own log predecessor (which under crash recovery may be an unrelated append); an APPEND-LEGALITY-GATE refusal binds its OWN IMMEDIATE PREDECESSOR under the general rule (v17 R5-C11-2 — its checks evaluated the append-time prefix, not P(W)); the class is replay-checkable from the record + outcome `pinnedVerdict` pair (v19 R5-C13-5), never from an asserted label**

### §14.10.3 — outcome-dependent nullability (same-act binding clause)

Demoted (replaced by `per NDR-d` citation):

> bound to P(W) per the R5-C10-2 exception **OR — when the refusal is the named append-legality-gate collision refusal (v17 R5-C11-2) — bound under the general predecessor rule to its own append-time prefix; the binding mode is determined by the refusal's own derivation and is replay-checkable either way**

Governing register entry: NDR-d (the binding paragraph in §14.10.3 remains
the registered expansion; these two summary sites restated it and were the
exact sites cycle-14's R5-C14-2 had to sweep — with the citation in place
a future fold touches the register entry once). No semantic change.

## 3. Round-4 finding → NDR mapping

| finding | fix now canonical at |
|---|---|
| R5-C5-5 exhaustive terminal-by-refusal | NDR-l |
| R5-C6-4 minor-exception null-ref predicate | NDR-b |
| R5-C7-3 refusal prefix binding + intake-refusal fault | NDR-d, NDR-g |
| R5-C8-1 kind-bounded exclusion / readjudication-owed | NDR-l (taxonomy), NDR-h (exclusion) |
| R5-C8-2 class-separated verification / eventful identity | NDR-d (class checkability), NDR-h (identity) |
| R5-C8-5 act-payload kind + withdrawn-only | NDR-h |
| R5-C8-6 undisposed-condition predicate | NDR-m |
| R5-C9-1 second reopening edge | NDR-p |
| R5-C9-2 draft-derivative class | NDR-f |
| R5-C9-3 refusalRecordId on resolution | NDR-o |
| R5-C9-4 fault refusalRecordId field | NDR-h |
| R5-C9-5 serialized adjudication protocol | NDR-i |
| R5-C10-1 P(W) rebound, consumed-by-identity | NDR-i |
| R5-C10-2 pinned-refusal binding exception | NDR-d |
| R5-C10-3 MIXED class | NDR-f |
| R5-C10-4 two named edges jointly exhaustive | NDR-p |
| R5-C10-5 fault ONLY-list extension | NDR-g |
| R5-C10-6 outcome-dependent nullability + append order | NDR-i (nullability binding), NDR-d (class check) |
| R5-C11-1 kind-dependent refiled binding | NDR-h, NDR-o (claim equality per NDR-c) |
| R5-C11-2 append-legality gate | NDR-j |
| R5-C11-3 readjudication-group fault + retirement | NDR-k (group), NDR-h (kind), NDR-l (result) |
| R5-C11-4 outcome byte-provenance fields | NDR-e |
| R5-C12-1 group exclusion unconditional | NDR-h |
| R5-C12-4 pinnedVerdict recording | NDR-i, NDR-d |
| R5-C13-1/2 group withdrawn ⇒ terminal-by-damage + retired | NDR-l |
| R5-C13-3 canonical byte labels (embedded-R1 deleted) | NDR-e |
| R5-C13-4 replay-only pinned re-derivation duty | NDR-k |
| R5-C13-5 two-class exception sweep | NDR-d |
| R5-C14-1 B-row sweep (terminal-by-damage in B row) | NDR-l (now single site) |
| R5-C14-2 terminality summary qualified by class | NDR-d (now single site) |
| R5-C14-3 kind-wise recovery totality | NDR-k |
| R5-C14-4 MIXED digest re-check constitutive | NDR-e, NDR-f |
| R5-C15-1 byte-free drift kind (d) ⇒ refused+code | NDR-k (kind d) |
| R5-C15-2 findingRef artifact as byte authority | NDR-k (kind a) |

Coverage-limit follow-ups (cycle-15 self-report) and where the register
makes them checkable: correction-lineage → NDR-n (total four-step fold);
accepted-fix cross-product → NDR-b (single rule, exception is its only
null route); filing-replay idempotence → NDR-c + NDR-i (one outcome per
withdrawal, deterministic); needs-owner closing paths → NDR-q (no orphan
holds).

## 2b. Cycle-16 demotions and mappings (v22 → v23)

### §14.12.2 rule-4 accepted-fix paragraph (opinion rule)

Demoted (v23 R5-C16-7, replaced by a `per NDR-b` citation carrying the
predicate summary; governing entries: NDR-b + its registered expansions
§14.10.1 acceptance contract / §14.10.2 minor-exception text):

> the ONE rule across this section is — every `accepted-fix` carries a conforming `reproRunRef` UNLESS it satisfies the minor exception (minor + dispositionBy: owner + riding a finding-disposition act + non-empty matching reason + **`reproRunRef == null` — v11 R5-C5-6: the exception is ONLY for a NULL reference; any NON-null reference must satisfy the ordinary green-run validation regardless of the owner reason, so an invalid/mismatched/red run attached to an "exception" accepted-fix is refused like any other, and the exception never excuses a bad run — it excuses the ABSENCE of one**)

No semantic change — the predicate is byte-identical to NDR-b's.

### Cycle-16 finding → action mapping (R5-C16-*)

| finding | action | register effect |
|---|---|---|
| R5-C16-1 (MAJOR, EXPANSION-CONTRADICTION: NDR-a said supervisor-derived = owner-origin only; expansion table admits `"auditor" OR "owner"`) | NDR-a rewritten: mode defined by PROOF not origin; observer≠appender pinned | NDR-a (canonical corrected to ratified table) |
| R5-C16-2 (MAJOR: NDR-p said edge (1) covers `rejected-duplicate` only; expansion + ratified v10/v11 behavior include `superseded`) | NDR-p canonical text now says `rejected-duplicate` **OR `superseded`** — restates ratified rule, adds none | NDR-p |
| R5-C16-3 (MAJOR: register LIVE TIP defined as not-closed-by-duplicate/superseded vs expansion's not-closed-by-`rejected-refuted`) | NDR-n corrected to the expansion definition (not closed by `rejected-refuted`); terminalized members (duplicate/superseded) are a DISTINCT role — never live tips; they delegate via step-2 link effectivization to the effective survivor | NDR-n |
| R5-C16-4 (MAJOR: filing replay / new-act refiling unregistered) | NEW **NDR-r** — filing identity, replay, re-filing over identical bytes; expansion = §14.10.3 "Identical bytes ≠ identical filing" paragraph | NDR-r (new) |
| R5-C16-5 (MAJOR: refutation evidence, field validity, artifact immutability unregistered) | NEW **NDR-s** (refutation evidence — expansion §14.10.2 "What counts as a refuting run") and NEW **NDR-t** (closed vocabularies, route×surface validity, append-only artifact + claimDigest binding — expansion §14.10.1 field-rules block) | NDR-s, NDR-t (new) |
| R5-C16-6 (MAJOR: "ONE named expansion site" vs multi-site declarations, NDR-q none) | Doctrine 1 REVISED: declared expansion = bounded FINITE set (one OR more); multi-site legal only if DECLARED; self-contained entries declare `(none — self-contained)`; NDR-q re-declared self-contained | doctrine 1, NDR-q |
| R5-C16-7 (MAJOR: rule bodies remain at non-expansion sites — §14.12.2 rule-4 paragraph) | rule-4 paragraph demoted to predicate + `per NDR-b` citation (full predicate preserved above verbatim); conformance vector stays (it is application text, not a body) | NDR-b |
| R5-C16-8 (MAJOR: NDR-q asserts totality without supplying it) | NDR-q gains the PER-CONDITION CLOSING INVENTORY table (six reachable conditions × closing act × operands × clearing evidence × forward effect) + historical-vs-hold distinction + unlisted-hold ⇒ contract defect | NDR-q |

Register extension: v22 closed set a…q → v23 closed set a…**t**
(heading updated). Self-check script entry-count expectation is derived
from the heading, not hardcoded (it was never hardcoded — PASS reports
the derived count).

## 2c. Cycle-17 demotions and mappings (v23 → v24)

### §14.12.2 minor-severity exception paragraph (demoted v24 R5-C17-4)

Demoted (v24 R5-C17-4, replaced by a `per NDR-b` citation + retained
application-local consequence; governing entry: NDR-b + registered
expansions). Verbatim v23 text:

> THE rule, both sections: `accepted-fix` with `reproRunRef == null` is valid ONLY where (i) the finding's `severity` is minor, AND (ii) `dispositionBy: "owner"` riding a `finding-disposition` owner-act (whose `reproRunRef` is likewise null — the act is the authority and the record is its transcription, v8 c6-M7 alignment), AND (iii) the update's `reason` is non-empty AND non-null (the reason is the binding evidence — the act's canonical payload carries the same reason string; validation checks agreement). Orchestrator-originated `accepted-fix` NEVER takes the exception (no owner act exists for it; v5 R2-3's "required for BOTH dispositionBy values" holds exactly for the exception's non-minor case and for minors against the orchestrator). A minor `accepted-fix` with null ref failing ANY condition is the pre-existing refusal (missing/mismatched/ worker-authored ⇒ refused).

No semantic change — byte-identical to NDR-b's predicate.

### §14.12.2 repro-run result-semantics paragraph (demoted v24 R5-C17-5)

Demoted (v24 R5-C17-5, replaced by a `per NDR-s` citation; governing
entry: NDR-s + registered expansion §14.10.2 "What counts as a
refuting run"). Verbatim v23 text:

> **result semantics closed (v6 F5):** `green` = `postFixExpected` observed (supports `accepted-fix`); `red` = `postFixExpected` NOT observed (supports NOTHING — evidence of a failed fix, recorded for the trail); `not-reproduced` = the repro command ran to COMPLETION against the finding's pre-fix baseline (§14.10.2 v6 F5 definition) and the claimed `preFixObserved` behavior did NOT occur (supports `rejected-refuted` ONLY). A `not-reproduced` record whose `executedArtifactDigest` ≠ the pre-fix baseline is refutation-invalid; `accepted-fix` NEVER accepts `not-reproduced`/`red`, `rejected-refuted` NEVER accepts `green`/`red`. Runs that did not complete are never written as repro-run records at all (no result value may encode "aborted" — absence of a record is the honest encoding, §14.10.2 v6 F5).

### §14.12.2 r4 chain-closure table — minor-exception cell (demoted v24 R5-C17-8)

Rule bodies converted to `per NDR-b`/`per NDR-p` citations. Verbatim
v23 cell parentheticals:

> (v9 R4-C3-7 — the only null-run accepted-fix that exists; act-bound evidence, so "VALID repro-run" can never be satisfied here and the fallback row must NOT swallow it: the exception is a row of its own)

> (v10 R5-C4-7) the v9 alternative "OR its own disposition is the same owner act" is WITHDRAWN: the single-consumption rule (§14.10.3) lets one owner-act authorize exactly ONE privileged record (or one NAMED atomic group), no group exists for two finding dispositions, so the alternative was inexpressible AND contradicted this row's own next clause. Cure for an already-closed member a run cannot reach (e.g. non-falsifiable `rejected-duplicate`): its own `finding-disposition` owner-act under this exception, appended as the update §14.10.2 permits over a `rejected-duplicate` **or `superseded`** closure (v11 R5-C5-4 — superseded members reach the same held state via a failed link revalidation, so the reopening exception names both closures), FORWARD-ONLY — it re-evaluates LATER boundaries only (verdicts stay frozen, the general survivor-change rule above); until it lands the member is UNCLEAN with needs-owner naming it.

### §14.12.2 r4 chain-closure table — refuted cell (demoted v24 R5-C17-5/8)

Verbatim v23 cell definitional parentheticals:

> (VALID = the v6 F5 closed definition: `not-reproduced` on the pre-fix baseline, supervisor/gate-authored, digest-bound)

> (v11 R5-C5-2) "every duplicate link" = each member's OWN effective link after §14.10.2's transshipment — NOT every raw edge on the path: a raw intermediate link's failure does NOT propagate (a member whose own effective link is machine-check-equal to the refuted survivor's repro discharges even when an intermediate member's link is not); the intermediate member whose own link fails is itself UNCLEAN — this is the same per-member rule as §14.10.2 step 2, and the two texts may never disagree.

### Cycle-17 finding → action mapping (R5-C17-*)

| finding | action | register effect |
|---|---|---|
| R5-C17-1 (MAJOR, EXPANSION-CONTRADICTION: v23 live-tip definition makes a duplicate-closed correction member the live tip while NDR-n says terminalized members are never live tips) | NDR-n adds the EFFECTIVE LIVE TIP concept: a terminalized live tip resolves FORWARD along its own edge (transitively) to its effective survivor; EVERY consumer binds the effective tip; §14.10.2 lineage clause states the same rule | NDR-n, §14.10.2 |
| R5-C17-2 (MAJOR, CITATION-DIVERGENCE: NDR-r's divergent-bytes refusal cited "NDR-i's stage rules" — NDR-i governs withdrawal only) | NDR-r now owns the rule: confirmed-act bytes are pinned by `draftSha256`, re-digest-checked on redelivery; NDR-i explicitly disclaimed as authority | NDR-r |
| R5-C17-3 (MAJOR, INVENTORY-GAP: inventory row prescribed non-minor `closed-residual` that NDR-p refused — edge (2) was withdrawal-strand-only) | NDR-p edge (2) strand condition generalized to a CLOSED LIST: (a) owner-retired-by-withdrawal (v15), (b) survivor validly-refuted + member's own link owner-authorized (the vector-(d) cure; minor keeps edge (1)); evidence operands pinned per strand; §14.10.2 second-edge paragraph updated | NDR-p, §14.10.2, inventory row |
| R5-C17-4 (MAJOR, EXPANSION-CONTRADICTION: demoted rule-4 paragraph still restated the full predicate; minor-exception paragraph still "THE rule, both sections") | rule-4 parenthetical demoted to citation+pointer; minor-exception paragraph demoted to `per NDR-b` with application-local consequence retained (verbatim texts logged above) | NDR-b |
| R5-C17-5 (MAJOR, EXPANSION-CONTRADICTION: repro-run result semantics + r4 refuted cell restated NDR-s rules independently; r4 cell had no citation) | §14.12.2 result-semantics paragraph demoted to `per NDR-s`; refuted cell VALID definition now cites NDR-s, effective-link clause cites NDR-n step 2; cure cites NDR-p edge (2) strand (b) | NDR-s, NDR-n, NDR-p |
| R5-C17-6 (MAJOR, EXPANSION-CONTRADICTION: manifest declared the recovery-reconstructibility clause an NDR-e expansion while NDR-e declares only the byte-provenance-fields paragraph and lists recovery under Cited at) | clause now carries `per NDR-e`/`per NDR-k` citations IN TEXT; manifest reclassified to citation (it is an application site) | manifest, §14.10.3 clause |
| R5-C17-7 (MAJOR, INVENTORY-GAP: `residual-inherited` member (any severity) makes the round unclean until settlement — absent from NDR-q's inventory) | NEW inventory row: residual-inherited member → append-only `residual-re-resolution` record (§14.12.2 v9 c7-M7 route/operands/settlement/clearing evidence/forward effect) | NDR-q inventory |
| R5-C17-8 (MAJOR, EXPANSION-CONTRADICTION: r4 table cells carried long rule bodies, several uncited — doctrine 3 violation) | minor-exception and refuted cells demoted to predicates + `per NDR-b/s/n/p` citations (verbatim preserved above); withdrawal cell cites NDR-p edge (2) strand (a); refiled cell cites NDR-n/NDR-c; manifest row updated | r4 table, manifest |
| R5-C17-9 (MAJOR, FRESH: NDR-t said "the closed-record route is `correctionOf` per NDR-n" — but correctionOf admits ONLY `rejected-refuted` targets; a closed accepted-fix/closed-residual record has no such route) | NDR-t qualified: correctionOf is the wrong-REFUTATION route subject to its target predicate; other closed records untouchable except via NDR-p's two named edges | NDR-t |

No register-extension this cycle (closed set stays a…t, 20 entries).
