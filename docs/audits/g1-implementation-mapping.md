# G1 implementation mapping — NDR register → code sites → test vectors

**Status: DRAFT for owner review (pre-implementation).** Contract ground
truth: `docs/11-orchestrator-schema.md` §14.10 (G1 finding-record schema,
draft v33, D-signed-off round closed CLEAN ×2; the §14.10 internal G1
draft numbering is separate and continued to v33 through the g1r4 +
follow-up rounds). This doc is the step-1 sanity check the owner
approved (2026-11-22, "go with your recommendation"): every canonical
rule gets a named code site and a named test vector BEFORE code lands,
because the v36 audits repeatedly found text-vs-intent divergence.

## Ground rules

- Module home: **`src/findings/`** (new), with the S5 log adapter in
  `src/findings/s5log.ts` (the supervisor file-log seam §14.10 rides on
  the existing supervisor session log; `src/supervisor/` stays the
  caller). Test home: `test/findings-*.test.ts` (node --test, same
  discipline as convergence-tier.test.ts — reference-model vectors).
- **Replay-derived everything:** no stored state flags. The fold
  (`fold.ts`) recomputes act state from the durable prefix; every
  predicate in the register is a pure function over (prefix, candidate).
- The register governs: where this doc's paraphrase and §14.10.0
  disagree, **the register entry wins** (doctrine 2). Each site below
  carries a `// NDR-x` comment; `scripts/g1-ndr-selfcheck.mjs` style
  grep-coverage extends to `src/findings/` (check 10 candidate: every
  NDR id appears in ≥1 code site and ≥1 test vector name).
- G5 hooks stubbed, not built: `scopeRefs` is carried/validated as an
  opaque `string[]` at intake (§14.10.1 wire field exists); the §14.14.3
  scope function is NOT called from G1. G2 is an intake gate per the
  round-0 M9 close: `route:"code-fix"` + failed norm-check → refusal at
  intake (`surface:"spec"` × `route:"code-fix"` invalid — NDR-t(2)).

## Proposed module layout

| file | contents | NDR coverage |
|---|---|---|
| `records.ts` | wire types + envelope + closed vocabularies (finding, update, filing, outcome, fault, disposition, drift-resolution, cure/settlement/cancel, cure-gate, repro-run) | NDR-t(1), NDR-a nullability shapes, NDR-h record shape |
| `intake.ts` | finding intake: entry-mode validation, id mint, claimDigest/findingRef artifact, scopeRefs carry, G2-gate refusal path | NDR-a, NDR-t, NDR-c (claim equality impl) |
| `disposition.ts` | update-intake: transition legality incl. the two reopening edges, minor exception, refutation validation | NDR-b, NDR-p, NDR-s, NDR-t(3) |
| `fold.ts` | effect fold + correction/duplicate lineage fold (total 4-step), terminal taxonomy, B/O finalization predicates | NDR-l, NDR-m, NDR-n, NDR-r, NDR-v (caller sweep = fold's consumers) |
| `adjudicate.ts` | serialized withdrawal→effect→outcome unit, append-legality gate, refusal binding, check classes, byte provenance | NDR-d, NDR-e, NDR-f, NDR-i, NDR-j |
| `recovery.ts` | restart crash-recovery duty (candidate kinds a–d), establishment/ordering per the v31–v33 restart-step audit folds | NDR-k (total duty), NDR-i, NDR-j |
| `faults.ts` | integrity-fault mint/identity/disposition, drift-resolution op, intake-refusal ONLY-list | NDR-g, NDR-h, NDR-o, NDR-l disposition outcomes |
| `cure.ts` | residual-cure two-phase protocol: confirm/unique/settle/cancel, ordering witness (b1/b2/b3), reproDigest(F) | NDR-u, NDR-v, NDR-q inventory rows |
| `inventory.ts` | NDR-q closing-inventory as a data table + totality check (unlisted reachable hold = contract defect) | NDR-q |
| `s5log.ts` | append/flock/fsync (durability-establishment per file, one fsync per pass), redelivery idempotence | NDR-r(1), NDR-i critical section, v33 per-file establishment |

## Per-rule mapping (NDR-a … NDR-v)

| NDR | canonical rule (1-line) | primary code site | test vector(s) |
|---|---|---|---|
| a | 3 entry modes, nullability by MODE, derived = supervisor privilege | `intake.ts#validateEntryMode` | `ndr-a-entry-modes`: all 3 legal; every other (origin,proof) combo refused; auditor never originates owner line |
| b | accepted-fix needs green reproRunRef; sole minor owner exception; chain-member discharge predicate | `disposition.ts#acceptedFixOk` + `fold.ts#chainMemberDischarge` | `ndr-b-minor-exception` (4 cases: non-null ref still validated green); `ndr-b-discharge-machine-check` (member link not reproDigest-equal ⇒ UNCLEAN) |
| c | claim equality = NFC-normalized decoded JSON value equality | `intake.ts#claimEqual` | `ndr-c-nfc-equality`: byte-different/NFC-equal pair accepted; v9 byte reading dead (regression pin) |
| d | refusal binds immediate predecessor; EXHAUSTIVE 2-class exception; class replay-derived, never labeled | `adjudicate.ts#bindingClass` | `ndr-binding-class`: eligibility⇒predecessor, R2⇒P(W); label-vs-derived mismatch ⇒ malformed candidate |
| e | bytesSource required, durable-only deterministic; enum closed (no embedded-R1); fresh-spool reserved | `adjudicate.ts#bytesSource` | `ndr-e-provenance`: re-digest⇒content-addressed; drift⇒none; validator never fabricates fresh-spool |
| f | MIXED class = exactly 4 correction codes, JOINT re-derivation prefix+bytes | `adjudicate.ts#mixedCheck` | `ndr-f-joint-rewrite`: prefix-only and bytes-only each insufficient (split-vector asserts both halves needed) |
| g | intake-refusal fault ONLY-list (closed) | `faults.ts#intakeRefusalOnly` | `ndr-g-only-list`: each listed cause mints; each near-miss does NOT |
| h | fault shape; damage identity (actId,failingCheck) forever vs eventful intake-refusal; B-existence vs O-open-only exclusion | `faults.ts#faultIdentity` + `fold.ts#classExclusions` | `ndr-h-identity`: post-disposition re-observation re-mints nothing; disposed intake-refusal doesn't suppress later forged attempt |
| i | withdrawal W binds P(W) never self-digest; W→effect→outcome one flock section; 1:1 outcome | `adjudicate.ts#serializedUnit` | `ndr-i-selfdigest-dead`: self-referential digest refused; `ndr-i-second-outcome` malformed |
| j | append-legality gate in same section; CLOSED failure→diagnostic mapping (no new code); R2 predecessor-bound | `adjudicate.ts#legalityGate` | `ndr-j-gate`: eligible⇒append; collision⇒R2 w/ mapped diagnostic, outcome refused/eligible/null |
| k | recovery duty TOTAL by candidate kind (a–d); exactly-one-valid⇒validation-only replay; ≥2 or fail⇒group fault; withdrawn only, refiled inexpressible | `recovery.ts#dutyTotal` | `ndr-k-kinds-abcd` one vector per kind incl. (d) byte-free drift over recorded spoolObserved (filesystem NEVER substitutes); `ndr-k-two-candidates` group fault, no winner picked |
| l | 5 terminal states + readjudication-owed + claim-retired; membership + clearing per state | `fold.ts#terminalState` | `ndr-l-taxonomy`: state-by-state table vector; cancellation reachable only via cancel op |
| m | finalization O predicate = UNDISPOSITIONED condition only; disposed never re-dirties; no retroactive re-clean | `fold.ts#finalizeBO` | `ndr-m-disposed-clean`: boundary after disposition CLEAN; closed unclean boundary never re-cleaned |
| n | total 4-step lineage fold; effective live tip walk (visit-once, cycle⇒needs-owner); no-live-tip via tip-most T | `fold.ts#lineageFold` | `ndr-n-cycle-prefix` (A→B→A admitted, routed, not assumed away); `ndr-n-effective-tip` (terminalized tip delegates to survivor); vectors (b)(c)(d) ported from schema |
| o | drift-resolution binds refusalRecordId (live, unique); refiled needs equal-claim APPLIED later filing | `faults.ts#driftResolution` | `ndr-o-liveness`: R1 resolution never binds R2; cleared/superseded refusal refused as target |
| p | exactly 2 reopening edges (minor exception over dup OR superseded; strand cure 2 strands), forward-only; all else invalid | `disposition.ts#reopenEdges` | `ndr-p-edges`: edge (1) covers superseded; edge (2)(a)/(b) strand proofs fail closed; third transition refused |
| q | no orphan holds; supplied closing inventory (totality); unlisted reachable hold = contract defect | `inventory.ts` data table + `test/findings-inventory.test.ts` | `ndr-q-totality`: enumerate unclean conditions from fold.ts, assert every one maps to an inventory row (the locked-pair row = regression pin for the c19 F5 class) |
| r | 3 filing-identity cases never collapsed; redelivery idempotent; new act = new attempt (never duplicate-intent refusal); divergent bytes refused | `s5log.ts#redelivery` + `intake.ts#refileAttempt` | `ndr-r-three-cases`: identical-bytes refiling succeeds as separate finding (then rejected-duplicate is the normal path); same-act divergent ⇒ replay-integrity refusal |
| s | green/red/not-reproduced closed semantics; refuted needs not-reproduced on PRE-FIX baseline (executedArtifactDigest == baseline); incomplete run = no record; owner-grade; no cross-lineage discharge | `disposition.ts#refutationOk` | `ndr-s-refutation-invalid` (run on fixed tree refused); `ndr-s-no-cross-lineage` |
| t | closed vocab (refuse+surface, never silent drop); route×surface validity; findingRef append-only, edit⇒new+superseded only while OPEN (correctionOf is refuted-targets-only) | `intake.ts#vocabValidate` + `disposition.ts#supersedeRoute` | `ndr-t-spec-codefix` refused; `ndr-t-artifact-drift`; supersede-onto-closed refused except the named route |
| u | cure protocol canonical: {digest,preimage} commitment immutable; uniqueness per pair; settlement id `cure-settlement-<actId>`; single evidence check; witness b1(git walk once, fail-closed)+b2(log position)+b3(cureGateId binding); reproDigest(F) one operation all sites; cancel ⇒ vacated settlement id; unsettled ⇒ no CLEAN, boundary still APPENDS unclean | `cure.ts` whole-file | `ndr-u-commitment-shape`; `ndr-u-witness-three` (ancestry alone insufficient; log-position alone insufficient); `ndr-u-cancel-drain` (stranded-queue exit vector, v28 R5-C20P-3); `ndr-u-replays-never-reswalk-git`; `ndr-u-reprodigest-equality` (scoped: only cited runs owe the cure digest) |
| v | effect-binding exception CLOSED set (2 members) + caller sweep; owed cure-gate shares parent class, never a B/quiescence/stall item | `fold.ts#effectException` (+ exclusion clauses at every consumer site) | `ndr-v-one-prefix-one-class`: every fold consumer re-derives same class for an unsettled cure; crash-window owed-gate vector (boundary never evaluated against unrestored gate — recovery pass runs first) |

## Implementation order inside G1 (each step = own commit + tests green)

1. `records.ts` + `s5log.ts` (types, envelope, append/fsync, redelivery) — NDR-t(1), NDR-r(1), durability establishment (v33 per-file fsync vector V-g13 ported)
2. `intake.ts` — NDR-a/c/t; G2-gate stub refusal path
3. `fold.ts` — NDR-l/m/n/r/v; lineage fold is the heart — port the schema's worked vectors first
4. `disposition.ts` — NDR-b/p/s
5. `faults.ts` — NDR-g/h/o
6. `adjudicate.ts` — NDR-d/e/f/i/j
7. `recovery.ts` — NDR-k (+restart ordering V-g8…V-g13 ports)
8. `cure.ts` — NDR-u/v cure half (last: depends on fold + faults + s5log)
9. `inventory.ts` + totality test — NDR-q closes the set

Then: G1's own fresh-audit cycle(s) (detached terra, prompt built from
this mapping + the register) to CLEAN, Change Ledger row, per §14.15.

## Open questions for the owner (answer before step 1)

- **Q1 language surface:** pure TS module inside this repo (`src/
  findings/`, imported by the future supervisor wiring) — assumed yes;
  no separate package.
- **Q2 S5 log:** real append against the existing supervisor JSONL
  session-log code, or a G1-local append-only file first with the S5
  adapter as a thin wrapper (recommended: thin wrapper — decouples G1's
  audit from P1 session-log internals)?
- **Q3 vectors:** the schema worked examples (V-g1…V-g13, r4 chain
  vectors, cure vectors) get ported verbatim as fixture vectors —
  recommended yes, they are the contract's own tests.
- **Q4 selfcheck extension:** add quality-check.sh check 10 (every NDR
  id present in `src/findings/` AND in a test name) — recommended yes.
