# Plan B — Canonical Rule Register for §14.10 (restructure to kill the fold-residue plateau)

Status: DRAFT plan (owner direction 2026-11-22: "kick c and draft b").
Target after approval: spec `docs/11-orchestrator-schema.md` §14.10 + named
overlap zones (§14.9 row, §14.12.2, §14.12.6), producing draft **v22**.
Baseline: **v21** (cycle-15's 2 MAJORs folded 2026-11-22: R5-C15-1 drift
recovery verdict forced to `refused`+code per replay binding clause (1) +
normative drift replay vector; R5-C15-2 applied-candidate byte authority =
the immutable `findingRef` artifact, two-way digest bound, damage routes
through the group-fault path). Both are class-B (new-fold-text) — cycle 15
found ZERO class-A residue, supporting the register thesis.

## 1. Diagnosis this plan attacks

Round-4 data (14 cycles, auditor gpt-6.1-terra, all `DECISIONS-REQUIRED: 0`):
findings 8→9→6→6→7→6→6→6→4→4→5→4 — plateau at 4–5 MAJOR/cycle since c9, in
two classes:

- **A — fold residue:** a rule was correctly changed at its primary site but
  survives in contradictory form at duplicate statement sites (e.g. C14-F1:
  class-B row still "terminal-by-refusal via restored R1" after the §14.10.3
  precedence rule said terminal-by-damage; C14-F2: terminal-outcome summary
  still bound every R2 to P(W) after the two-class exception).
- **B — new-fold-text gaps:** the replacement prose itself is non-total or
  collides with a neighboring rule (e.g. C14-F3: recovery duty not total over
  4 candidate kinds; C14-F4: `fresh-spool` label rule vs MIXED digest rule).

Root cause: every rule of §14.10 is RESTATED at 4–6 sites — precedence prose +
disposition result table + replay vectors (i)–(viii) + §14.12.2 class-B/O rows
+ summary paragraphs — and the table cells have grown past 1,000 words with
nested EXCEPT/ALSO-EXCLUDING clauses. A fold that sweeps semantically cannot
be verified by grep anchors, so the loop's floor is ~4 residue findings and
CLEAN is structurally unreachable. The fix is structural, not another cycle.

## 2. The restructure

### 2.1 Canonical Non-derogable Rules register (NDRs)
Create **§14.10.0 "Rule Register (NDR-1 … NDR-n)"**: a numbered, closed list;
each rule stated ONCE, in normative prose, with fields:
`id | statement | applies-to (record kinds / states) | failure route | cited-by (site list)`.
Every other location in §14.10 + overlap zones becomes **reference-only**: a
table cell or summary may state a PREDICATE plus `per NDR-k`, never a restated
rule body. A restatement error becomes impossible to introduce silently
because there is exactly one body to edit.

Seed register (rule families that generated round-4 findings — extraction will
flesh these out to exact statements from v20):

| seed | family | found as |
|---|---|---|
| NDR-a | Entry modes: origin × producer × emission authority, proof-field nullability | C8-arc, C11 |
| NDR-b | Accepted-fix rule space: producers × severities × repro kinds × dispositionBy → exactly one verdict; minor-exception is the only null-ref route | C4, C9 |
| NDR-c | Claim equality: NFC-normalized decoded JSON string values, not raw bytes | verified c14 |
| NDR-d | Refusal binding: general immediate-predecessor rule + EXHAUSTIVE two-class exception (pinned ⇒ P(W); gate ⇒ predecessor); class replay-checkable from the `pinnedVerdict` pair, never asserted | C10-2, C11-2, C13-5, C14-2 |
| NDR-e | Byte provenance: closed enum `content-addressed│fresh-spool│none`; `observedSha256` nullability; MIXED act-digest re-check CONSTITUTIVE (mismatch ⇒ malformed, integrity route) | C12-2, C13-3, C14-4 |
| NDR-f | MIXED class: joint re-derivation over bound prefix + digest-verified `adjudicatedDraftBytes` | C10-3 |
| NDR-g | `intake-refusal` fault predicate: closed ONLY-list incl. draft/mixed corruption | C10-5 |
| NDR-h | Filing-integrity faults: kinds × dispositions × inexpressibility; excluded-from-B on record EXISTENCE, open OR disposed; per-disposition result table (terminal-by-damage/refusal/disposition, claim retirement) | C8, C11-3, C12-1, C13-1/2, C14-1 |
| NDR-i | Withdrawal determinism: append order W → effect → outcome; one outcome per withdrawal; P(W) rebound to pre-disposition prefix (no self-digest) | C10-1, C10-6 |
| NDR-j | Append-legality gate: MIXED-class checks on append-time prefix; CLOSED diagnostic mapping + precedence; collision refusal under general binding | C11-2, C12-3 |
| NDR-k | Crash recovery duty, TOTAL by candidate kind: (a) applied finding, (b) pinned refusal, (c) gate refusal, (d) byte-free drift refusal (over the record's own `spoolObserved`); per-kind fail-closed route to the group-fault path; replay-only, never re-adjudicating | C12-2, C13-4, C14-3 |
| NDR-l | Terminal taxonomy: terminal-by-refusal / -by-damage / -by-disposition / claim-retired — class-B and class-O membership per state | C13-1/2, C14-1 |
| NDR-m | Finalization B/O predicates: OPEN-fault-CONDITION predicates, disposition records as clearing evidence, never re-minted by re-observation | C8-6, C12-1 |
| NDR-n | Correction lineage totalness (live tip / no tip / duplicate-of-duplicate / severity non-decreasing) → r4 chain table | verified c14 |
| NDR-o | Drift-resolution op: binds R2 by record id; R1 history excluded | C9-3 |
| NDR-p | Two reopening edges jointly exhaustive (minor-exception, closed-residual); every other transition over closed states invalid | C9-1/C10-4 |
| NDR-q | needs-owner clearing: named closing act/transition for every uncleanness condition; no orphan holds | C-arc general |

### 2.2 Table-cell budget
§14.12.2 B/O rows and the r4 chain-closure table: cells may contain predicates,
enums of record ids, and `per NDR-k` citations; any rule BODY appearing in a
cell is a defect (auditable mechanically: a cell exceeding ~150 words or
containing a normative "must/never/ONLY" without an NDR citation fails the
gate). Explanatory prose moves under the table.

### 2.3 Extraction procedure (mechanical, auditable)
1. Triage every normative claim in §14.10.1–.3, .5, §14.9 row, §14.12.2,
   §14.12.6 (markers: `must`, `NEVER`, `ONLY`, `EXCEPT`, `⇒`, nullability
   clauses, enum lists) into candidate rules with all statement sites.
2. Collapse duplicates: where sites disagree, the canonical statement is the
   most-recent fold's narrowed text (git blame orders folds); every demotion
   (site → citation) is logged.
3. Produce `docs/audits/g1-ndr-conflict-log.md`: each round-4 finding
   R5-Cx-y → the NDR id that now carries it → sites converted to citations.
   This preserves auditability: the auditor can re-verify each historical
   fold against the register instead of against prose scatter.
4. Rewrite tables/summaries as reference-only (cell budget above).
5. Bump §14.10 to **v21** with a Change-Ledger row citing this plan.

### 2.4 Fold-hygiene v2 (process gate, lands with v21)
Extend the existing fold-hygiene rule: a future fold MAY edit (i) the canonical
NDR body, (ii) mechanical citation text, and nothing else; the Change-Ledger
row lists the NDR ids touched and asserts `sites-edited = canonical only`.
A fold that needs to change a non-canonical location first converts it to a
citation (separate hygiene commit).

## 3. Verification & exit
1. **Self-check (implementable as a script):** every `per NDR-k` citation
   resolves; every normative marker in §14.10/§14.12.2 lives inside a
   register entry or a citation; no NDR id appears twice in the register;
   the conflict log covers all 14 cycles' findings.
2. **Invariant walks (existing doctrine):** every act state × disposition ×
   candidate-kind enumeration re-walked against the register (totality
   checker for NDR-h/k/l).
3. `npm test` (docs-only change; regression guard).
4. **One confirming audit (cycle 16) with a restructured prompt:** primary
   surface becomes register completeness + citation integrity — "every
   normative rule reachable in v20 maps to exactly one NDR; no two NDRs
   contradict; every former restatement site is now a citation; hunt
   counterexamples against the register" — expected to collapse class A to 0.
5. **Exit criterion (proposed):** v21 + cycle-16 folded with 0 class-A
   findings ⇒ declare §14.10 audit-converged; further review moves to
   implementation-time (the record schema feeding §14.12 consumption), not
   more prose cycles.

## 4. Sequencing & cost
1. Fold cycle-15 findings into v20 → v20.1 (waiting on the detached audit;
   it validates whether class-A residue was fully cured by the C14 folds).
2. Extraction + register (steps 2.3.1–2), conflict log.
3. Reference-only conversion of tables/summaries (2.2), v21 + ledger row.
4. Scripted self-check + npm test + commit.
5. Cycle 16 confirming audit; fold; apply exit criterion.

Effort: step 2 is the bulk (≈ one focused session; §14.10 is ~2,400 lines,
the re-adjudication zone ~800). Risk: nuance lost in a move — mitigated by
the conflict log (every demoted sentence preserved verbatim with its site)
and git history.

## 5. Explicit non-goals
- No design changes: the register RESTATES decisions ratified through round 4
  (R1–R8, R2-x, F1–F5, C1-1…C14-4); any extraction ambiguity that would
  CHANGE behavior is escalated as DECISIONS-REQUIRED, not resolved silently.
- No implementation, no module touched (standing round-4 constraint).
- §14.11/.13/.14/.15 untouched except where a §14.10-cited record/field is
  mis-specified in §14.10's own text.
