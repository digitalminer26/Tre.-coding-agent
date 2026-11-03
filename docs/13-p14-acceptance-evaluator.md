# P14 — Acceptance Evaluator (contract & as-built surface)

> Status: CONTRACT + audit amendments (drafted 2026-11-03, implemented
> 2026-11-03, amended 2026-11-03 after an independent review found F1–F7 —
> see §8; re-amended 2026-11-03 after a second review round found C2-F1–F5
> — see §9, which is NORMATIVE over §4/§8 where they differ).
> Module: `src/acceptance/evaluator.ts`. Consumed by P10 (planner) and P9/M1
> composition; produces the S5 `kind:"acceptance"` record (§14.3).
> Parent plan: docs/11 §11.1 P14 row, §9.1 "Acceptance" paragraph,
> §13.3 rows "normal run ends before required check" / "work changes
> after a passing check".

## 0. Purpose & boundary

P14 answers exactly one question: **given approved acceptance criteria and
the evidence actually observed, what is the task's acceptance verdict —
`complete | incomplete | blocked | uncertain` — with evidence refs and
remaining work?** It is the acceptance half of the recovery loop; the
decision of *what to do* about a verdict belongs to P10, the acting to
P11, the gating to P8.

Normative source sentences (docs/11):

- "Prefer deterministic checks; validated model assessment handles
  semantic criteria without replacing required gates."
- "Return evidence refs and remaining work, and invalidate stale
  assessments after relevant artifact changes."
- "Normal stop or model self-report alone never proves completion."
- "Acceptance criteria and safety guards may not be weakened to make a
  task pass. Model output is untrusted advice at this boundary." (§9.1)
- "Model judgment may assess semantic requirements but cannot waive
deterministic gates or promote stale checks after relevant artifacts
change." (§9.1)

Boundary rules (what P14 is NOT):

1. **No side effects, no model calls, no subprocesses.** evaluate() is a
   PURE function of its inputs (§2). Gate *execution* is a supervisor
   act; the evaluator judges gate *results* presented as evidence.
2. **No budget authority.** P8 facts enter as plain input facts
   (§11.2 "accounting below judgment" — P10 re-checks with P8; a P14
   verdict is not a permission).
3. **No graph mutation.** The supervisor is the only graph writer (§4);
   P14 returns a verdict; the supervisor persists it as an S5
   `acceptance` record via the P4 journal.
4. **Self-contained compartment** (the P6/P7/P8 fleet pattern):
   `src/acceptance/` imports only `node:` builtins (type-only imports
   from sibling modules are permitted — runtime import is the violation
   the guard test enforces). Input types are structural, so P14 compiles
   against the §14 shapes without owning them.

## 1. Artifact identity (the staleness anchor)

Acceptance evidence binds to *artifacts*, not to a moment in time.

```ts
interface ArtifactIdentity {
  sha: string;          // git commit sha the evidence was observed at
  dirty?: boolean;      // true = uncommitted changes existed at observation
  dirtyDigest?: string; // caller-supplied digest of the dirty delta
}
```

- `sameArtifact(a, b)`: equal iff same `sha` AND (both dirty with equal
  `dirtyDigest`, or neither dirty). A dirty working tree is a *different*
  artifact from the clean commit; two dirty trees are the same artifact
  only if their deltas digest identically.
- Evidence whose `at` identity differs from the current artifact is
  **stale** — never counted as a pass, never counted as a *failure of
  the current artifact* either: it contributes "no evidence at current"
  and is reported in the criterion's `staleEvidenceRefs`.
- An empty `sha` is not an identity: deterministic criteria require one;
  evidence without an identity is unbound evidence (see §3, EV rules).

## 2. Inputs

```ts
interface TaskAcceptanceSpec {     // S3 task.acceptance, closed at P0
  criteria: { id: string; kind: "deterministic" | "semantic";
              required: boolean; note?: string }[];
  requiredChecks: string[];        // gate ids; every one needs a current PASS
  artifacts: string[];             // expected artifact paths (S3 acceptance.artifacts)
}

interface GateResult {             // observed gate run (supervisor ran it)
  gateId: string;
  pass: boolean;
  at: ArtifactIdentity;
  evidenceRef: string;             // non-empty; surfaced on the record
  runId?: string;
}

interface ArtifactEvidence {       // S3 acceptance.artifacts expectations
  path: string;
  exists?: boolean;                // observed by the caller
  at?: ArtifactIdentity;
  digest?: string;                 // content digest (exists-true proof)
  evidenceRef: string;
}

interface ClaimEvidence {          // worker / model statements — ADVISE ONLY
  source: "worker-self-report" | "model-judgment";
  judge?: string;
  claim: string;
  verdict?: "complete" | "incomplete" | "blocked"; // self-reported
  confidence?: number;
  criteriaIds?: string[];          // semantic criteria this judgment names (EV6)
  evidenceRefs?: string[];         // refs the claim points at (unverified)
  at?: ArtifactIdentity;           // F3: identity the judgment was MADE at —
                                   // a claim may fund/flip a criterion ONLY at
                                   // its own identity; claims without `at` are
                                   // unbound and fund nothing (F3 amendment).
}

interface BlockerEvidence {        // positive evidence of an external blocker
  blocker: "authority-denied" | "environment" | "approval-required"
         | "dependency-external" | "budget-exhausted" | "other";
  at: ArtifactIdentity;
  evidenceRef: string;
}

interface EvaluateInput {
  taskId: string;
  taskRevision: number;            // §14.4 — assessments are per-revision
  current: ArtifactIdentity;       // artifact under judgment
  spec: TaskAcceptanceSpec;
  gates: GateResult[];
  artifacts: ArtifactEvidence[];
  claims: ClaimEvidence[];
  blockers: BlockerEvidence[];
  now: number;                     // injected clock (no Date() inside)
  semanticMinConfidence?: number;  // [0.7] EV6 funding threshold
}
```

There is deliberately **no `prior` input**: nothing in the verdict
function consumes prior assessments (fresh evaluation at the current
identity is the discipline); stored-assessment liveness is a separate
pure function (§5.1). Inputs are the *complete* evidence set for the
judgment.

Malformed input fails **closed** as `uncertain` with reason
`bad-input:<what>` — an evaluator that cannot parse its evidence never
invents a verdict. Non-negative finite `now`, unique gate ids *among
current-identity results*, non-empty ids/refs — all validated before
judgment. **F2 amendment:** ALL four evidence arrays (`gates`,
`artifacts`, `claims`, `blockers`) must be arrays — a non-array value is
`bad-input`, never silently treated as empty (a broken blocker list must
not become proof that no blockers exist). **F5 amendment:** every claim
field the OUTPUT carries (`judge`, `evidenceRefs[]`) is validated as
part of claim shape — a claim whose output fields are malformed is
dropped like any other malformed advice (it can never carry a verdict,
so it never fails the whole input).

## 3. Evidence (EV) rules — the pinned judgment mechanics

| id | rule |
|----|------|
| EV1 | **A gate result binds to exactly one artifact identity.** Only results whose `at` equals `current` count toward the verdict. Results at other identities are reported as `staleGates` and never pass or fail the current judgment. |
| EV2 | **Required check coverage is per gate id.** A required check passes iff a *current* PASS result exists for it. Two PASSes are not stronger than one; a current PASS plus a current FAIL is CONTRADICTORY → `bad-input` (the caller must reconcile its own gate runs). |
| EV3 | **A failed current gate makes the task `incomplete`, never `blocked`.** A gate failure is work-to-do evidence; `blocked` requires positive blocker evidence (§4). |
| EV4 | **Artifact criteria:** an expected artifact is satisfied iff observed `exists:true` with a non-empty `digest` observed AT `current`. `exists:true` without a digest is an unsupported observation → `bad-input` (it is exactly the shape of an unverified claim). **F1 amendment:** `exists` ABSENT (or a non-boolean value) is an UNKNOWN observation, never a satisfied one — unknown → `uncertain` (EV9); a malformed `digest` type is `bad-input`. Only the exact shape `(exists === true, non-empty string digest)` satisfies. |
| EV5 | **Claims are advice.** `worker-self-report` and `model-judgment` NEVER set or flip a verdict. They attach to `modelAdvisory` (latest per source) and may attach *to semantic criteria outcomes* only (EV6). A claim of "complete" with missing deterministic evidence yields at most `uncertain`. **F4 amendment (the AC1 floor):** a spec with NO required checks and NO expected artifacts yields at most `uncertain` from claims alone — `complete` requires at least one piece of current non-model evidence (a current gate result or a satisfied artifact observation). A spec whose only requirements are semantic is malformed *by construction* → the caller must provide deterministic evidence or the verdict is capped at `uncertain`. **C2-F2 scope correction:** a required DETERMINISTIC criterion is itself an evidence requirement (EV7 binds criterion ids to gate ids — repeating them in `requiredChecks` is redundant), so "claims-only" means no required check, no expected artifact AND no required deterministic criterion; such specs take the normal evidence rules (a current PASS funds, a current FAIL is `incomplete`). **C3-F2 exception:** the cap bounds what claims may PROVE (`complete`), not what they may FIND — a judge-declared `incomplete` on a REQUIRED criterion is a concrete negative finding and yields `incomplete` even in a claims-only spec (§10). **C3-F3 bar:** that finding power is held to the SAME epistemic bar as the positive side — judge-declared `incomplete` sets the finding rung only at confidence ≥ `semanticMinConfidence` (absent confidence counts as 0); below the bar the criterion stays unfunded (never passes) and no verdict is set from the claim. |
| EV6 | **Semantic criteria** pass only by a current model-judgment claim (source `model-judgment`, `verdict:"complete"`, confidence ≥ the caller-supplied `semanticMinConfidence` [default 0.7]) naming the criterion — carried as ADVISORY: `pass:true`, `advisory:true`, evidence = the claim ref. Semantic FAILS from a claim are respected (a judge saying "incomplete" counts as remaining work, never waived upward). **F3 amendment:** "current" binds the CLAIM too — a claim may fund or fail a criterion only if `claim.at` equals the current artifact identity (`sameArtifact`); claims without `at`, or at a stale identity, are UNBOUND advice: reported in `staleEvidenceRefs` (when they carry refs), surfaced in `modelAdvisory` only if the advisory quote itself is harmless (advisory is never load-bearing), and they fund/flip NOTHING. |
| EV7 | **Deterministic criteria** pass only by a current PASS gate result (the criterion `id` IS the gate id). No model output can produce a deterministic pass. Expected artifacts are judged separately (EV4), never as criteria. |
| EV8 | **Blockers require positive, current evidence.** A `blocked` verdict additionally requires the required-evidence path be *unresolvable by more work evidence* — blockers never rescue a failed current gate (EV3 wins; the failed gate is reported, the stale blocker is listed and ignored for verdict). |
| EV9 | **Unknown is the floor, not a weapon.** Absence of evidence at the current identity is `uncertain` — NEVER inferred failure ("no evidence" ≠ "failed"), and never success. This mirrors §13.4's `unknown`-never-`crashed` discipline: silence is not evidence. |
| EV10 | **Revision scoping lives in §5.1, not the verdict inputs:** stored assessments are keyed to `taskRevision`; a rung-4 rewrite (revision bump) makes every prior assessment stale automatically. |
| EV11 | **Determinism (A7 shape):** evaluate() is a pure function of its input — no wall clock, no fs, no env reads. Same input ⇒ structurally identical output. `now` is injected and only copied into the record fields. |
| EV12 | **Complete is conjunctive.** `complete` iff: spec valid, every required gate has a current PASS (EV2), every required criterion passes (EV6/EV7), every expected artifact satisfied (EV4), no unresolved blocker, and NO current FAIL anywhere. Self-report is absent from this conjunction entirely. |

## 4. Verdict function (normative)

```text
bad input                                  → uncertain (bad-input:… recorded)
judge-declared incomplete (required criterion,   → incomplete (F6; C3-F2:
  confidence ≥ semanticMinConfidence — C3-F3      also ABOVE the claims-only
  gates negatives at the bar like positives)      cap — a concrete finding
                                                  outranks absence of
                                                  required evidence)
current FAIL gate/criterion                → incomplete  ┐ CONCRETE negative
expected artifact observed exists:false    → incomplete  ┘ findings PRECEDE
    at current  (C2-F1: proven absence is a finding, not an absence   EVERYTHING
    of evidence — the floor never masks it)                            below
claims-only spec (F4, C2-F2 scoped: no required check, no expected
    artifact AND no required deterministic criterion)
                                           → uncertain cap (F4/EV5 — at most
                                               uncertain; a required
                                               deterministic criterion IS an
                                               evidence requirement, EV7)
no current non-model evidence (F4)         → uncertain (COMPLETION-eligibility
                                           floor only — see §9 C2-F1)
required gate missing/unbound at current   → uncertain   (EV9)
expected artifact unobserved at current    → uncertain   (EV9)
required semantic criterion unfunded       → uncertain
positive current blocker(s), nothing failed/missing → blocked
all green (EV12, incl. floor)              → complete
default (evidence exhausted without green) → uncertain
```

Precedence is total and evaluated in this order; no rule rewrites an
earlier one. Missing-evidence rules (gates, artifact observations,
semantic funding) outrank `blocked`: a blocker explains *why work may be
stuck* but never substitutes for the evidence a verdict requires, and
`blocked` never outranks a concrete finding (a failed gate or a proven
missing artifact).
`remainingWork` lists every unmet required item (gate ids, criterion ids,
artifact paths) — the exact continuation work a safe resume (§9.1
"premature normal stops resume with specific remaining acceptance work")
needs.

**R1-audit amendment (2026-11-03):** the conjunction check (every
required criterion passes) was implemented *before* the blocker rule —
an unmet required criterion with a current blocker is `uncertain`
(missing evidence outranks blocked, EV9), not `blocked`. A blocker is a
statement about why the *required-evidence path is stuck*, so it only
applies once the required-evidence shape is otherwise satisfied.
(`verdict:criterion-unfunded` therefore outranks `verdict:blocked`; a
judge-declared incomplete stays `incomplete` — a concrete finding.)

## 5. Output

```ts
interface AcceptanceAssessment {  // mirrors S5 kind:"acceptance" payload
  taskId: string;
  taskRevision: number;
  verdict: "complete" | "incomplete" | "blocked" | "uncertain";
  criteria: { id: string; pass: boolean; advisory?: boolean;
              evidenceRef?: string; checkedAtSha?: string }[];
  remainingWork: string[];
  staleEvidenceRefs: string[];    // evidence seen but not at `current`
  artifact: ArtifactIdentity;     // identity the verdict binds to
  modelAdvisory: { judge: string; quote: string; confidence: number } | null;
  reasons: string[];              // machine-checkable reason codes (§4 names)
}
```

`criteria[].checkedAtSha` is ALWAYS the artifact identity sha (or absent
for non-artifact evidence) — the field the P4 schema carries.

### 5.1 Staleness of STORED assessments

`isStale(stored, current)` implements §9.1 "invalidate stale assessments
after relevant artifact changes": a stored assessment is live iff same
`taskRevision` and `sameArtifact(stored.artifact, current)`. Any other
pair is stale — staleness NEVER converts a complete to a failure; it
removes the assessment from evidence (§13.3: "work changes after a
passing check → stale acceptance invalidated; required checks rerun").
The supervisor records invalidation with the S5 `invalidatedBy` field;
P14 does not write journals.

## 6. Invariants (each pinned by named tests)

| id | invariant |
|----|-----------|
| AC1 | A normal stop (`runEnd`), a steer receipt, or any `ClaimEvidence` alone can never produce `complete` — verdict without current deterministic evidence is `uncertain` at best. **F4 amendment:** this holds UNCONDITIONALLY — a spec lacking any required check or expected artifact is capped at `uncertain` (complete requires ≥1 current non-model evidence: gate result or satisfied artifact). |
| AC2 | A model judgment cannot waive a failed or missing deterministic gate/check (EV6 vs EV7). |
| AC3 | Stale gate results never count at the current identity — in either direction (EV1); stored assessments go stale exactly on artifact-identity or revision change (§5.1). |
| AC4 | Determinism: same input → identical output (pure fold, injected `now`, no I/O). |
| AC5 | Fail-closed: malformed input of any kind yields `uncertain` + `bad-input` reason, never a throw, never an optimistic verdict. **F2 amendment:** a non-array evidence field (`gates`/`artifacts`/`claims`/`blockers`) is malformed input — it never collapses to "empty" (silence would manufacture proof of no blockers / no evidence). |
| AC6 | A gate FAIL is never `blocked` (EV3); a blocker never rescues it (EV8). |
| AC7 | `complete` requires the full conjunction (EV12) — every member independently defeatable by removing exactly that evidence (mutation-style test per conjunct) — INCLUDING the ≥1-current-non-model-evidence floor (F4) and per-claim identity binding (F3: an unbound/stale claim funds nothing). |
| AC8 | `modelAdvisory` is advisory in the record: it never appears as the evidence of a deterministic criterion (EV5/EV7). |
| AC9 | Compartment: no runtime import outside `src/acceptance/` in either direction (guard test, same extractor as P8's). |

## 7. Deviations & deferrals (as-built notes)

1. Gate *execution* (running `policy.gate.cmd`) is deliberately NOT in
   P14 — it is a supervisor/P11 act; P14 judges results only. A future
   adapter may run gates and construct `GateResult`s, but that adapter
   lives outside this compartment.
2. `dirtyDigest` for dirty trees is caller-supplied; P14 has no opinion
   on how the delta is computed, only that identity requires it.
3. Semantic judging is *intake of an already-produced judgment* (the
   caller runs the model through P8/P11 and hands the claim in). P14
   itself never talks to a model.
4. `AcceptanceAssessment` → S5 record conversion is a field-copy helper
   (`toAcceptanceRecord`) provided for the supervisor's convenience —
   it validates the COMPLETE record against the §14.3 + P14-amendment
   shape and THROWS `TypeError` on any malformed field (a corrupted
   assessment object cannot become a durable record); it does NOT
   append (the P4 journal owns writing). **F5 amendment:** the P4
   journal schema (§14.3) knows the amended optional fields
   (`criteria[].advisory`, `staleEvidenceRefs`, `artifact`) and
   validates their shapes; pre-amendment records stay valid (additive
   fields only). The evaluator validates every claim field it copies
   into the OUTPUT (`judge`, `evidenceRefs[]`) — malformed there means
   the claim is dropped as advice, never emitted.


## 8. Audit amendments (2026-11-03 — independent review F1–F7)

The independent review (`.tre/audit-p14-review.md`) found seven defects in
the first implementation; all are closed in code + tests, and this section
is the contract record of what changed:

| id | amendment |
|----|-----------|
| F1 | EV4 strictness: only `(exists === true, non-empty digest)` at current satisfies; `exists` absent/non-boolean is UNKNOWN → `uncertain`; malformed digest type → `bad-input`. |
| F2 | All four evidence arrays must be arrays; non-array → `bad-input` (never silently empty). |
| F3 | Claims bind to `claim.at`: a claim funds/fails a criterion ONLY at its own artifact identity; unbound claims (no `at`) fund nothing. Unbound claims are reported as stale advice (refs listed in `staleEvidenceRefs`). |
| F4 | The AC1 floor is unconditional: a claims-only spec (no required check, no expected artifact — *scoped by C2-F2: a required deterministic criterion counts as evidence shape too*) caps at `uncertain`; `complete` requires ≥1 current non-model evidence. |
| F5 | Full output validation: claim fields consumed by the output are validated (dropped-claim on malformation); `toAcceptanceRecord` validates the COMPLETE record shape (throws `TypeError`); the P4 schema validates the amended fields; P4 TS types declare them. |
| F6 | Judge-declared incomplete on a required criterion is a CONCRETE finding at the same rung as a current FAIL: it outranks missing-evidence rules (which are about ABSENCE of evidence, not presence of a negative finding) — and, per C3-F2, the claims-only cap too. `incomplete` wins.  Held to the C3-F3 confidence bar. |
| F7 | `isStale`/`sameArtifact` treat a malformed stored artifact (empty sha) as never-live; identity validation precedes the liveness decision. |

Precedence after F6 was superseded by the cycle-2 restructure (§9/C2-F1 —
concrete negative findings moved ABOVE the evidence floor) and by the
follow-up C3-F2 (§10 — findings moved above the claims-only cap too); the
live total order is the ladder in §4 as amended by §9–§10.

## 9. Cycle-2 audit amendments (2026-11-03 — second review round C2-F1–C2-F5)

The cycle-1 closure was reviewed again (`.tre/audit-p14-cycle2.md`, against
`efd1866` — same-session read-only lens, NOT a cross-model audit; see C2-F5).
Five findings; all closed in code + tests. This section is normative over
§4/§8 where they differ.

| id | amendment |
|----|-----------|
| C2-F1 | The F4 evidence floor is a rule about COMPLETION ELIGIBILITY only — it never suppresses a concrete negative finding. An OBSERVED `exists:false` artifact at current (and a current FAIL) now precede the floor in the ladder: proven absence is non-model evidence of a finding, not an absence of evidence. `incomplete`/`verdict:artifact-missing` restored for the audit repro. |
| C2-F2 | Claims-only classification corrected: a spec with a required DETERMINISTIC criterion is not claims-only (EV7 binds criterion ids to gate ids — repeating them in `requiredChecks` is redundant). Such a spec takes the normal evidence rules: current PASS funds, current FAIL → `incomplete` (EV3 no longer masked). Optional-only deterministic criteria demand nothing, so a spec of semantic + optional-deterministic criteria keeps the F4 cap. |
| C2-F3 | Schema parity with P4 enforced at every emission point: claim intake requires non-empty `judge` (empty → malformed advice, dropped with a reason, funds nothing — the audit's complete-then-rejected repro now drops and lands on the evidence-only verdict); identity helpers require non-empty `dirtyDigest` when present; `toAcceptanceRecord` refuses empty `judge`/`dirtyDigest` and out-of-range/non-finite `confidence` (∈ [0,1]) — the converter is deliberately STRICTER than the journal `num` shape (no maximum; NaN passes `type:"number"`), strict-in-the-safe-direction: garbage the journal would tolerate is refused before emission. The P4 journal's acceptance `artifact` shape dropped `nullable` — `artifact:null` is now rejected (absent is the "no identity" case); the TS type (`artifact?: {…}`) and the journal agree. Parity is pinned by a matrix test: converter-accepted ⇒ `validateSupervisorRecord`-accepted for a valid envelope, plus the documented converter-strict cases. |
| C2-F4 | `isStale` validates BOTH revisions (positive integers, matching `task.revision` §14.4) before equality: a malformed `taskRevision` on stored OR current ⇒ stale (never live). The F7 identity fix left this hole; `0`, `-1`, `1.5`, `undefined` all repro'd live and now repro stale. |
| C2-F5 | Records corrected (this doc header, HANDOFF, `.tre/audit-p14-fixes.md` addendum): the F1–F7 review was a SAME-SESSION read-only review, not an "independent" (fresh model family) audit — the audit report said so and the HANDOFF headline contradicted it; the claimed "75 acceptance tests" was wrong (68 at rebuild — 10 new ones here bring the true count to 78). Durable-journal gap closed: a new regression performs a REAL `DecisionJournal.open` → `append` → `read` identity round-trip of an amended acceptance record and proves `artifact:null` fails closed on reopen (the earlier round-trips were field-validation only, not persistence). Audit acceptance remains OPEN pending a cross-model review round. |

Cycle-2 regressions: `test/acceptance.test.ts` §"cycle-2 audit regressions"
(C2-F1 ×2, C2-F2 ×3, C2-F3 ×3 incl. the durable round-trip, C2-F4 ×1,
ladder-order ×1). All four audit repros re-run against rebuilt dist land on
the corrected verdicts.

## 10. Cycle-3 follow-ups (2026-11-03 — third review round)

| id | amendment |
|----|-----------|
| C3-F1 | Cycle-2's C2-F4 regression was one-sided: it proved a malformed CURRENT revision with a valid stored one (which `!==` already caught), not the audit's repro of MATCHING malformed revisions on both sides. The test now covers both sides (`0`, `-1`, `1.5`, `undefined` each, stored=current), and fails against the pre-fix source. |
| C3-F2 | Concrete negative findings now outrank the claims-only CAP, not just the evidence floor (the cycle-2 restructure left the cap as the only absence-of-evidence rule still above the F6 rung). A claims-only spec whose judge explicitly calls a REQUIRED criterion incomplete is `incomplete`/`verdict:criterion-incomplete` — F6's principle is that presence of a finding outranks absence of evidence, and the cap is absence of REQUIRED evidence. Boundaries pinned by tests: POSITIVE claims (verdict `complete`) still cap at `uncertain` (the cap bounds what claims may prove); judged-incomplete on an OPTIONAL criterion keeps the cap (only required criteria are the finding rung). |
| C3-F3 | (audit of `9bbb54a`, user-approved) Negatives are now gated at `semanticMinConfidence` like positives: pre-existing code applied ANY judge `incomplete` (confidence 0/absent included) to set the finding rung, while `complete` required confidence ≥ msc — asymmetric bars for symmetric judgments. Harmless while the claims-only cap absorbed negatives; C3-F2 made negatives verdict-setting, exposing the hole (confidence-0 flipped `uncertain`→`incomplete` on a claims-only spec — EV5 violation). Now absent confidence counts as 0 and the finding rung requires ≥ msc. Conservative direction preserved: a below-bar incomplete still NEVER passes the criterion (`row.pass=false`) and is still named in `remainingWork` — it simply is not a finding, falling back to the normal evidence rules. 5 tests incl. custom-bar gating; mutation-checked (ungating fails exactly the gating tests). |

Cycle-3 regressions: `test/acceptance.test.ts` (C3-F2 ×4, C3-F3 ×5; C3-F1 is
the strengthened C2-F4 test). Suite: 87 acceptance tests; full suite
**1878 / 1864 pass / 0 fail / 14 skipped**, `npm test` exit 0.
