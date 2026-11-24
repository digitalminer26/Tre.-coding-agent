# G1 implementation mapping — NDR register → code sites → test vectors

**Status: DRAFT for owner review (pre-implementation); folded through
mapping-audit cycle 1 (gpt-6.1-terra, detached, 2026-11-22: CHANGES
REQUESTED — 0 blockers / 7 MAJOR / 5 MINOR, all adopted as noted at the
foot of this doc).** This doc is NON-NORMATIVE mapping/audit material:
it is not a canonical expansion site of any NDR entry, and it mints no
P13 exchange; where it and §14.10.0 disagree the register governs.
Contract ground truth: `docs/11-orchestrator-schema.md` §14.10 (G1
finding-record schema, draft v33, D-signed-off round closed CLEAN ×2;
the §14.10 internal G1 draft numbering is separate and continued to v33
through the g1r4 + follow-up rounds). This doc is the step-1 sanity
check the owner approved (2026-11-22, "go with your recommendation"):
every canonical rule gets a named code site and a named test vector
BEFORE code lands, because the v36 audits repeatedly found
text-vs-intent divergence.

## Ground rules

- Module home: **`src/findings/`** (new), with the S5 log adapter in
  `src/findings/s5log.ts` (the supervisor file-log seam §14.10 rides on
  the existing supervisor session log; `src/supervisor/` stays the
  caller). Test home: `test/findings-*.test.ts` (node --test, same
  discipline as convergence-tier.test.ts — reference-model vectors).
- **Replay-derived state, observed inputs:** no stored state flags — the
  fold (`fold.ts`) recomputes act state from the durable prefix. NOT
  "every predicate is a pure function over (prefix, candidate)" as a
  blanket claim (audit c1 fresh finding): two contract inputs are
  legitimately non-prefix — the settlement's ONE-TIME git-ancestry
  witness walk (NDR-u b1, recorded once into `ancestryWitness`, replay
  never re-walks) and spool admission's read of durable spool bytes
  (§14.10.3 confirmed-bytes snapshot). Sites with external observation
  must record their witness durably at append and replay consumes the
  record.
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
| `intake.ts` | finding intake: entry-mode validation, id mint, claimDigest/findingRef artifact, scopeRefs carry (opaque; G5 path validation DEFERRED to G5 — G1 validates `string[]` shape only, no §14.14.3 semantics claimed); **spool admission producer/consumer: CLI writes confirmed bytes to `drafts/sha256-<draftSha256>` + fsync BEFORE the act append (16 KiB cap, over-cap refused at input); intake NEVER reads the live draft path — reads the spool, re-hashes it; mismatch/missing ⇒ `owner-filing-draft-drift` (terminal for the act)**; named spool vectors (c2 m2, split per c3 M1): `spool-a-write-fsync-order` (bytes durable before act append), `spool-a-rerehash-mismatch-drift` (intake reads spool only, live path NEVER), `spool-a-overcap-refused` (16 KiB at input), `spool-a-act-present-spool-missing` (terminal drift + resolution path per §14.10.3 — the act exists, its re-hash fails, empty-by-refusal), `spool-a-preact-crash-no-act` (crash between (i) fsync and (ii) act append: NO act was appended, so NOTHING exists to refuse, resolve, or owe — the orphan spool object is inert storage, the owner re-confirms normally); G2-gate stub refusal path (see note below the table) | NDR-a, NDR-t, NDR-c, spool §14.10.3 (MAJOR-6 fold) |
| `disposition.ts` | update-intake: transition legality incl. the two reopening edges, minor exception, refutation validation | NDR-b, NDR-p, NDR-s, NDR-t(3) |
| `fold.ts` | effect fold + correction/duplicate lineage fold (total 4-step), terminal taxonomy, B/O finalization predicates. **Consumes fault identity/disposition outcomes via an interface (`faultsIfc`) defined in step 1's `records.ts` — the fold/faults dependency seam (MINOR-1): fold tests run green against the interface with fakes; `faults.ts` lands step 5 with the real impl behind the same interface.** | NDR-l, NDR-m, NDR-n, NDR-r, NDR-v |
| `queue.ts` | queue P3 predicate, drain named deferred-effect excuse, quiesce-stall rule + the drain-excuse/stall exclusions — the NDR-v **caller-sweep consumer homes named individually (MAJOR-5)**: `fold.ts#effectException` is the shared predicate; `queue.ts` P3 / drain-excuse / stall each carry their own exclusion clause citing NDR-v and are each tested against the SAME prefix as the fold (one prefix, one classification) | NDR-v caller sites |
| `adjudicate.ts` | serialized withdrawal→effect→outcome unit, append-legality gate, refusal binding, check classes, byte provenance | NDR-d, NDR-e, NDR-f, NDR-i, NDR-j |
| `recovery.ts` | restart crash-recovery duty (candidate kinds a–d) + the **restart-step ORDERING decomposed (MINOR-5, per v32/v33 audit folds): (c0) ownership → validation WITHOUT mutation; (§13.1 repair; torn gate lines repaired-then-appended under exclusive ownership); (c1a) semantic checks (O1/O2/O3, one-per-act, terminal-combination) BEFORE any establishing sync; (c1b) terminal-first classification (unestablished terminal records established by the restart's own fsync here); (c1c) sync ONLY for an otherwise-live act's gate — failed sync leaves the act under the barrier; no appends of any kind after a gate-append failure (fail-stop)** | NDR-k (total duty), NDR-i, NDR-j, restart ordering V-g8…V-g13 |
| `faults.ts` | integrity-fault mint/identity/disposition, drift-resolution op, intake-refusal ONLY-list | NDR-g, NDR-h, NDR-o, NDR-l disposition outcomes |
| `cure.ts` | residual-cure protocol: confirm/unique/settle/cancel + the **cure-gate clause-level sites (MAJOR-4 fold): `confirmCure` appends the gate record as a SEPARATE append immediately after the confirmation record (NOT an atomic multi-record pair — append-then-act, D1=A); nonce mint (fresh ULID `id` + 32 random bytes hex, durable ONLY in the gate record); DISPATCH GATING — repro dispatched only after the gate append is DURABLE (append-then-dispatch; dispatch-while-not-durable is a contract violation, every run it produces unverifiable forever, TA-5); `repro-run.cureGateId` append-decidable nullability split; one-gate-per-cure-act; owed-completion D1=A complete-the-pair recovery (crash tearing the pair); cancelled/settled gate EXTINGUISHMENT + failed-append outcomes** — plus ordering witness (b1/b2/b3), reproDigest(F) | NDR-u, NDR-v, NDR-q inventory rows |
| `inventory.ts` | NDR-q closing-inventory as a data table + totality check (unlisted reachable hold = contract defect). **Envelope/record-kind scope note (MINOR-3): G1's OWN wire kinds only** (finding, update, filing, outcome, fault, disposition, drift-resolution, cure/settlement/cancel, cure-gate, repro-run). The §14.12.4b `cure-gate` inventory row is carried in `records.ts`'s kind table with a pointer; `finding-hold` / `finding-hold-lift` (§14.12.4, NDR-q row) are **G1 WIRE DEPENDENCIES carried as types + intake vocab, their lifecycle semantics land with G3** — stated, not implied | NDR-q |
| `s5log.ts` | append/lock/fsync (durability-establishment per file, one fsync per pass), redelivery idempotence. **Wrapper contract (audit c1 Q5c): "thin" is a decoupling claim, not a capability claim — the wrapper MUST provide exclusive ownership (held across the serialized unit — directory-registry claims per the storage audit arc c4 B1/c7 B1, not flock; acquisition is SOLE-CLAIM ADMISSION: O_EXCL entry + sweep dead residue + admit only when the registry holds exactly one live entry, ours — no clock, no ordering key, per cycle-7 B1 after audit c6 falsified the name-encoded-time ordering proof), ordered durability (fsync-before-ack of decision records), and full lock lifetime per NDR-i; conformance vectors V-g1/V-g4/V-g13 ported as acceptance tests of the wrapper itself** | NDR-r(1), NDR-i critical section, v33 per-file establishment |

**G2-gate stub contract (MAJOR-7 fold):** the stub is an injected
interface `normGate(record) => pass | fail(code)`; G1 owns its observable
outcomes per NDR-t(2), so the stub ships WITH them: a `code-fix` record
failing the gate is refused at intake, the `refusal-code` is JOURNALED
as an S5 decision-log record naming the refused line's content hash,
the line NEVER becomes an `audit-finding`, and a corrected resubmission
is a NEW record next cycle. Fail-closed: a gate that errors is a
refusal with the error journaled. Test vectors `ndr-t2-gate-journal` +
`ndr-t2-gate-never-finding`. No G2 implementation is scheduled (§14.15
order honored).

## Per-rule mapping (NDR-a … NDR-v)

| NDR | canonical rule (1-line) | primary code site | test vector(s) |
|---|---|---|---|
| a | 3 entry modes, nullability by MODE, derived = supervisor privilege | `intake.ts#validateEntryMode` | `ndr-a-entry-modes`: all 3 legal; every other (origin,proof) combo refused; auditor never originates owner line |
| b | accepted-fix needs green reproRunRef; sole minor owner exception; chain-member discharge = member is **minor** AND the member's OWN effective link (NDR-n step 2) is machine-checkable — BOTH operands | `disposition.ts#acceptedFixOk` + `fold.ts#chainMemberDischarge` | `ndr-b-minor-exception` (4 cases: non-null ref still validated green); `ndr-b-discharge-machine-check` (member link not reproDigest-equal ⇒ UNCLEAN); `ndr-b-discharge-nonminor` (non-minor member never discharges via the exception) |
| c | claim equality = NFC-normalized decoded JSON value equality | `intake.ts#claimEqual` | `ndr-c-nfc-equality`: byte-different/NFC-equal pair accepted; v9 byte reading dead (regression pin) |
| d | refusal binds immediate predecessor; EXHAUSTIVE 2-class exception: PINNED re-adjudication refusal (P(W)-bound by identity) vs GATE refusal (predecessor-bound) — class REPLAY-DERIVED from the record + outcome pinnedVerdict pair, never from an asserted label | `adjudicate.ts#bindingClass` | `ndr-d-binding-class`: pinned-R2⇒P(W), gate-refusal⇒predecessor; derived-class-vs-record mismatch ⇒ malformed candidate (the vector derives the class itself — no asserted-label operand exists) |
| e | bytesSource required, durable-only deterministic; enum closed (no embedded-R1); fresh-spool reserved | `adjudicate.ts#bytesSource` | `ndr-e-provenance`: re-digest⇒content-addressed; drift⇒none; validator never fabricates fresh-spool |
| f | MIXED class = closed FIVE (v34 D1(a): the 4 correction codes + `cure-unknown-act`), JOINT re-derivation prefix+bytes | `adjudicate.ts#mixedCheck` | `ndr-f-joint-rewrite`: prefix-only and bytes-only each insufficient (split-vector asserts both halves needed) |
| g | intake-refusal fault ONLY-list (closed — NECESSARY not sufficient: listed cause + eligibility/identity/replay context still govern) | `faults.ts#intakeRefusalOnly` | `ndr-g-only-list`: each listed cause mints WHEN the surrounding fault context holds; each near-miss does NOT; a listed cause in isolation (identity already disposed / no live act) mints nothing (ONLY-list is not an unconditional-mint rule) |
| h | fault shape; damage identity (actId,failingCheck) forever vs EVENTFUL intake-refusal (actId,failingCheck,refusalRecordId); B exclusion: DAMAGE kinds exclude on record EXISTENCE (open or disposed), intake-refusal excludes ONLY while UNDISPOSITIONED; disposition results per NDR-l | `faults.ts#faultIdentity` + `fold.ts#classExclusions` | `ndr-h-identity`: post-disposition re-observation re-mints nothing; disposed intake-refusal doesn't suppress later forged attempt |
| i | withdrawal W binds P(W) never self-digest; W→effect→outcome one flock section; 1:1 outcome | `adjudicate.ts#serializedUnit` | `ndr-i-selfdigest-dead`: self-referential digest refused; `ndr-i-second-outcome` malformed |
| j | append-legality gate in same section; CLOSED failure→diagnostic mapping (no new code); R2 predecessor-bound | `adjudicate.ts#legalityGate` | `ndr-j-gate`: eligible⇒append; collision⇒R2 w/ mapped diagnostic, outcome refused/eligible/null |
| k | recovery duty TOTAL by candidate kind (a–d); exactly-one-valid⇒validation-only replay; failure route SPLIT per kind: TRANSIENT re-derivation failure ⇒ RETRY (never terminalizes), DETERMINISTIC failure ⇒ group-fault path; candidate/check mismatch or ≥2 candidates ⇒ group fault; withdrawn only, refiled inexpressible | `recovery.ts#dutyTotal` | `ndr-k-kinds-abcd` one vector per kind incl. (d) byte-free drift over recorded spoolObserved (filesystem NEVER substitutes); `ndr-k-two-candidates` group fault, no winner picked; `ndr-k-transient-retry` (temporarily unreadable artifact ⇒ retry, NOT a group fault; deterministic digest mismatch ⇒ group fault) |
| l | 5 terminal states + readjudication-owed + claim-retired; membership + clearing per state | `fold.ts#terminalState` | `ndr-l-taxonomy`: state-by-state table vector; cancellation reachable only via cancel op |
| m | finalization O predicate = UNDISPOSITIONED condition only; disposed never RE-DIRTIES (it does not itself CLEAN a boundary — other unclean conditions still govern); no retroactive re-clean | `fold.ts#finalizeBO` | `ndr-m-disposed-no-redirty`: all OTHER predicates held clear, boundary after disposition is clean; variant with an independent open condition stays unclean; closed unclean boundary never re-cleaned |
| n | total 4-step lineage fold; effective live tip walk (visit-once, cycle⇒needs-owner); no-live-tip via tip-most T | `fold.ts#lineageFold` | `ndr-n-cycle-prefix` (A→B→A admitted, routed, not assumed away); `ndr-n-effective-tip` (terminalized tip delegates to survivor); vectors (b)(c)(d) ported from schema |
| o | drift-resolution binds refusalRecordId (live, unique); refiled needs equal-claim APPLIED later filing | `faults.ts#driftResolution` | `ndr-o-liveness`: R1 resolution never binds R2; cleared/superseded refusal refused as target |
| p | exactly 2 reopening edges (minor exception over dup OR superseded; strand cure 2 strands), forward-only; all else invalid | `disposition.ts#reopenEdges` | `ndr-p-edges`: edge (1) covers superseded; edge (2)(a)/(b) strand proofs fail closed; third transition refused |
| q | no orphan holds; supplied closing inventory (totality); unlisted reachable hold = contract defect | `inventory.ts` data table + `test/findings-inventory.test.ts` | `ndr-q-totality`: the condition set is enumerated from a SINGLE SHARED SOURCE — **`records.ts` exports the canonical condition list + registration interface** (step 1, before its consumers; c6 MAJOR fix: the row and the step list now agree — `inventory.ts` IMPORTS the list and owns the step-9 data table) (all §14.10/§14.12.2 unclean/needs-owner conditions INCLUDING quiesce-stall and finding-hold), and fold.ts/queue.ts register their emitted conditions AGAINST that source (a condition emitted by any consumer with no inventory row, or an inventory row with no emitter, fails the test) — enumerating from `fold.ts` alone would miss the queue.ts/stall/hold conditions (c4 MAJOR-1 fix). **Hold-row emitter seam (c5 MAJOR fix): the G1 EMITTER is real — `fold.ts` handles a conforming `finding-hold` record (G1 wire kind, `records.ts`) by registering the hold condition; only the sign-off-counting semantics and the `finding-hold-lift` CLOSER transition land with G3 (the closer is referenced by name in the row, marked `closer: G3` in the row data, and the lift wire type ships in step 1 so the ref resolves); the totality test exercises the closer with a FIXTURE lift record proving the row's exit is expressible over G1's vocabulary — the both-direction check is NOT weakened (emitter required, closer ref required to resolve). The SHARED LIST + registration interface land in step 1 (m1 fix: before its consumers, same seam pattern as faultsIfc); the data table + totality test remain step 9**; the locked-pair row = regression pin for the c19 F5 class |
| r | 3 filing-identity cases never collapsed; redelivery idempotent; new act = new attempt (never duplicate-intent refusal); divergent bytes refused | `s5log.ts#redelivery` + `intake.ts#refileAttempt` | `ndr-r-three-cases`: identical-bytes refiling succeeds as separate finding (then rejected-duplicate is the normal path); same-act divergent ⇒ replay-integrity refusal |
| s | green/red/not-reproduced closed semantics; refuted needs not-reproduced on PRE-FIX baseline (executedArtifactDigest == baseline); incomplete run = no record; owner-grade; refuted-run evidence never discharges a DUPLICATE OF A CORRECTED CLAIM (the register's narrow no-cross-lineage clause, v27 R5-C19-3 — NOT a blanket ban on all cross-lineage discharge; c7 MAJOR fix) | `disposition.ts#refutationOk` | `ndr-s-refutation-invalid` (run on fixed tree refused); `ndr-s-no-cross-lineage-dup-of-corrected` (refuted-run evidence against a duplicate of a corrected claim refused; a cross-lineage discharge the register does NOT name is asserted NOT refused — pin against over-implementation) |
| t | closed vocab (refuse+surface, never silent drop); route×surface validity; findingRef append-only, edit⇒new+superseded only while OPEN (correctionOf is refuted-targets-only) | `intake.ts#vocabValidate` + `disposition.ts#supersedeRoute` | `ndr-t-spec-codefix` refused; `ndr-t-artifact-drift`; supersede-onto-closed refused except the named route |
| u | cure protocol canonical: {digest,preimage} commitment immutable; uniqueness per pair; settlement id `cure-settlement-<actId>`; single evidence check; witness b1(git walk once, fail-closed)+b2(log position)+b3(cureGateId binding — the cure-gate clause-level protocol lives in the `cure.ts` row above); reproDigest(F) one operation all sites; cancel ⇒ vacated settlement id; unsettled ⇒ no CLEAN, boundary still APPENDS unclean | `cure.ts` whole-file (incl. gate sites) | `ndr-u-commitment-shape`; `ndr-u-witness-three` (ancestry alone insufficient; log-position alone insufficient); `ndr-u-gate-append-then-dispatch` (dispatch before durable gate append ⇒ run unverifiable, refused at settlement); `ndr-u-gate-torn-pair` (D1=A complete-the-pair recovery; cancelled/settled extinguishment; failed append); `ndr-u-cancel-drain` (stranded-queue exit vector, v28 R5-C20P-3); `ndr-u-replays-never-redigest-git` (stored ancestryWitness consumed); `ndr-u-reprodigest-equality` (scoped: only cited runs owe the cure digest) |
| v | effect-binding exception CLOSED set (2 members) + caller sweep — **consumer homes named individually (MAJOR-5): `fold.ts#effectException` (shared predicate), `queue.ts` P3 predicate, `queue.ts` drain deferred-effect excuse, `queue.ts` quiesce-stall paragraph** — each carries its own exclusion clause citing NDR-v; owed cure-gate shares parent class, never a B/quiescence/stall item | the four sites listed | `ndr-v-one-prefix-one-class`: P3, drain-excuse and stall each re-derive the SAME classification as the fold against one prefix (a caller differing from the fold is a defect); crash-window owed-gate vector (boundary never evaluated against unrestored gate — recovery pass runs first) |

## Implementation order inside G1 (each step = own commit + tests green)

1. `records.ts` + `s5log.ts` (types incl. the **`faultsIfc` interface seam** (MINOR-1), the **shared canonical condition list + registration interface** (c5 m1: lands before its consumers fold.ts/queue.ts, same seam pattern as faultsIfc; `inventory.ts` imports it, fold/queue register against it) and envelope, append/fsync, redelivery; wrapper conformance vectors land here) — NDR-t(1), NDR-r(1), durability establishment (v33 per-file fsync vector V-g13 ported)
2. `intake.ts` — NDR-a/c/t; spool admission + drift route; G2-gate stub refusal path with journal
3. `fold.ts` — NDR-l/m/n/r/v (against `faultsIfc` fakes — the step-5 seam); lineage fold is the heart — port the schema's worked vectors first; **same commit family: the `queue.ts` caller-site exclusion clauses (NDR-v sweep lands with its predicate, not "later")**
4. `disposition.ts` — NDR-b/p/s
5. `faults.ts` — NDR-g/h/o (real impl behind `faultsIfc`; fold's fake-vs-real differential test lands here)
6. `adjudicate.ts` — NDR-d/e/f/i/j
7. `recovery.ts` — NDR-k + the decomposed restart ordering (c0/c1a/c1b/c1c) and cure-gate owed-completion D1=A; V-g8…V-g13 ports. **Seam (c3 m2, same pattern as the faults seam): the `cure-gate`/settlement/cancel RECORD TYPES + the gate-protocol interface land in step 1's `records.ts` (the kind table already lists them); step 7 tests D1=A complete-the-pair against the interface with fakes, and step 8's `cure.ts` lands the real protocol behind it — the step-7/8 differential test (fake-vs-real gate completion) lands in step 8.**
8. `cure.ts` — NDR-u/v cure half incl. the cure-gate clause-level protocol (last: depends on fold + faults + s5log)
9. `inventory.ts` + totality test — NDR-q closes the set

**Trust-basis traceability (MINOR-2; § corrected per c4 m1 — the
TA block lives in §14.10.0, after the statement-site manifest):**
TA-1…TA-5 (declared
assumptions — enforcement sites must cite them; no runtime module) —
each TA gets a `// TA-n` marker comment at its enforcement site
(TA-1 ledger-ref resolution ⇒ `s5log.ts`/`fold.ts` cite checks; TA-2
runner trust — nonce MINTED by supervisor never runner, runner's
obligation is the honest echo ⇒ the gate-echo check in `cure.ts`; TA-3
git-object honesty ⇒ the b1 witness walk in `cure.ts`; TA-4 preimage
availability ⇒ the commitment re-check in `cure.ts`; TA-5
log-atomicity scope ⇒ dispatch gating + D1=A complete-the-pair in
`cure.ts`/`recovery.ts`) and a traceability table in
`test/findings-ta.test.ts` asserting every TA-n is cited by ≥1 site
(documentation-grade check, same shape as the check-10 candidate).

Then: G1's own fresh-audit cycle(s) (detached terra, prompt built from
this mapping + the register) to CLEAN, Change Ledger row, per §14.15.

## Open questions for the owner (answer before step 1) — ANSWERED 2026-11-23

Owner confirmed all four as recommended (2026-11-23: "confirm all four
as recommended and open the implementation step 1"):

- **Q1 language surface:** pure TS module inside this repo (`src/
  findings/`, imported by the future supervisor wiring) — assumed yes;
  no separate package. **CONFIRMED.**
- **Q2 S5 log:** real append against the existing supervisor JSONL
  session-log code, or a G1-local append-only file first with the S5
  adapter as a thin wrapper (recommended: thin wrapper — decouples G1's
  audit from P1 session-log internals)? **CONFIRMED: thin wrapper.**
  `s5log.ts` owns the append primitive writing its own append-only
  JSONL; `src/session/session.ts`'s selective-fsync policy (§13.1,
  steer-receipt-only fsync) is explicitly NOT the S5 backing store;
  cross-log joins ride by id/content-hash.
- **Q3 vectors:** the schema worked examples (V-g1…V-g13, r4 chain
  vectors, cure vectors) get ported verbatim as fixture vectors —
  recommended yes, they are the contract's own tests. **CONFIRMED
  verbatim**, with the bookkeeping rule: each port carries its schema
  anchor; a vector testing behavior deferred to G2/G3/G5 is marked
  DEFERRED, never adapted.
- **Q4 selfcheck extension:** add quality-check.sh check 10 (every NDR
  id present in `src/findings/` AND in a test name) — recommended yes.
  **CONFIRMED**, with one build-out refinement: check 10 is
  HARD-ENFORCED once `src/findings/inventory.ts` exists (step 9 closes
  the id set — the mechanical analogue of NDR-q totality); before step
  9 it runs informational (a mid-build hard check would fail by
  design, which would pressure skipping tests). Steps 1–8 carry the
  grep as a per-step self-discipline gate.

## Audit disposition — mapping-audit cycle 1 (2026-11-22)

Auditor gpt-6.1-terra (detached one-shot
`~/.tre/audits/v36/g1map-c1-*`, against commit 4840465): CHANGES
REQUESTED — 0 blockers / 7 MAJOR / 5 MINOR. All 12 adopted; folded
in-place (this file is the fold): M1 minor-member operand + counterexample
vector (NDR-b row); M2 ONLY-list necessity-not-sufficiency (NDR-g row);
M3 disposed-fault vector qualified (NDR-m row); M4 cure-gate clause-level
sites + vectors (cure.ts row, NDR-u row); M5 caller-sweep consumer homes
named individually — new `queue.ts` (layout + NDR-v row + step-3 sweep
landing); M6 spool admission producer/consumer (intake.ts row); M7
G2-stub observable contract (note below the layout table). m1 fold/faults
`faultsIfc` seam + differential test (layout + steps 1/3/5); m2 TA-1…5
traceability (post-steps); m3 inventory scope note + hold-record
deferral (inventory.ts row); m4 scope-validation deferral stated
(intake.ts row); m5 restart ordering decomposed c0/c1a/c1b/c1c
(recovery.ts row). Fresh-finding (Q6): the blanket "pure function over
(prefix, candidate)" rewritten — external-observation inputs declare
their durable witness (ground rules). Gates re-run after fold:
contract-check 40/40 PASS, g1-ndr-selfcheck PASS. The auditor confirmed:
no src/findings/ exists; 22/22 entries carry ≥1 site + ≥1 vector;
doctrine compliance fixed-ok with the non-normative status line now
explicit at the head.

## Audit disposition — mapping-audit cycle 2 (confirming, 2026-11-22)

Auditor gpt-6.1-terra (detached one-shot `~/.tre/audits/v36/g1map-c2-*`,
against commit 3e13ce8): CHANGES REQUESTED — 0 blockers / 3 MAJOR / 2
MINOR. M1–M5 + m1–m5 + Q6 from cycle 1 CONFIRMED fixed (auditor checked
each disposition claim against the text). New findings, all adopted:
M1 NDR-k row — failure route SPLIT restored (transient ⇒ retry, NEVER
terminalizes; deterministic ⇒ group fault) + `ndr-k-transient-retry`
vector; M2 NDR-d row — pinned vs gate classes spelled out, vector
renamed `ndr-d-binding-class`, no asserted-label operand; M3 (check-10
satisfiability) resolved by that rename — all vector names now carry
the NDR id under the proposed literal check (OVERSTATED as written —
corrected by cycle 3 m1: the spool vectors are protocol-named
`spool-a-*`; the accurate claim is every per-rule ROW carries ≥1
`ndr-<id>`-named vector, which is what check-10 consumes); m1 NDR-h row — damage
vs eventful exclusion qualified per kind; m2 named spool vectors added
(`spool-a-*` ×4). A transcription slip during this fold ("re-hashes,
path.") was caught and repaired in the same commit. Gates re-run after
fold: contract-check 40/40, g1-ndr-selfcheck PASS. Cycle 3 (second
confirming) dispatched against the folded text.

## Audit disposition — mapping-audit cycle 3 (confirming on c2 fold, 2026-11-22)

Auditor gpt-6.1-terra (detached one-shot `~/.tre/audits/v36/g1map-c3-*`,
against commit 7fe5b91): CHANGES REQUESTED — 0 blockers / 1 MAJOR / 2
MINOR. Cycle 2's fold confirmed (NDR-k/d/h rows, spool vectors,
transcription repair all supported; Q2/Q3/Q4/Q5 fixed-ok modulo the
three new findings). New findings, all adopted: **M1** —
`spool-a-crash-between-write-and-act` prescribed a drift resolution
where NO ACT EXISTS (crash between (i) spool fsync and (ii) act append
leaves nothing to refuse or resolve; the contract's drift path governs
an appended immutable act) — split into `spool-a-act-present-spool-
missing` (terminal drift + resolution) and `spool-a-preact-crash-no-act`
(orphan spool object inert, owner re-confirms, nothing owed); **m1** —
cycle 2's "all vector names carry the NDR id" overstated (spool vectors
are protocol-named) — corrected in place in the cycle-2 section; **m2** —
step 7→8 cure-gate seam made explicit (gate types + protocol interface
in step 1's records.ts, D1=A fakes at step 7, real protocol step 8,
differential test at step 8 — same pattern as the faults seam).
Gates re-run after fold: contract-check 40/40, g1-ndr-selfcheck PASS
(22 entries). Closure bar for this doc: CLEAN ×2 on identical text —
next cycle is the first confirming attempt on the folded text.

## Audit disposition — mapping-audit cycle 4 (2026-11-22)

Auditor gpt-6.1-terra (detached one-shot `~/.tre/audits/v36/g1map-c4-*`,
against commit 8838899): CHANGES REQUESTED — 0 blockers / 1 MAJOR / 1
MINOR. Cycle 3's fold confirmed. All 22 rule rows classified neutral or
acceptable-paraphrase. Findings adopted: **M1** — `ndr-q-totality`
enumerated conditions from `fold.ts` alone, which cannot see the
queue.ts (P3/drain/stall) conditions or the finding-hold dependency
boundary — rewritten: `inventory.ts` is the SINGLE SHARED SOURCE of
canonical conditions, consumers (fold.ts, queue.ts) register emitted
conditions against it, both directions (emitted-without-row /
row-without-emitter) fail the test; **m1** — trust-basis section
citation corrected (§14.10.3 ⇒ §14.10.0, after the statement-site
manifest — verified against docs/11 line 2435). *(Historical note, c7
m1: the shared-source ownership above was later superseded — c6 moved
the exporter to `records.ts` (step 1) with `inventory.ts` as importer +
data-table owner; this paragraph is preserved as the cycle-4
disposition as issued.)* Gates re-run:
contract-check 40/40, g1-ndr-selfcheck PASS. CLEAN×2 closure bar: this
fold resets the clock; next cycle is the first confirming attempt on
the folded text.

## Audit disposition — mapping-audit cycle 5 (2026-11-22)

Auditor gpt-6.1-terra (detached one-shot `~/.tre/audits/v36/g1map-c5-*`,
against commit e709251): CHANGES REQUESTED — 0 blockers / 1 MAJOR / 1
MINOR. Cycle 4's fold confirmed (shared-source totality design judged
faithful; TA citation confirmed; all 22 rows neutral). Findings
adopted: **M1** — the finding-hold inventory row had no G1 emitter
under both-direction totality (lifecycle deferred to G3): seam
specified — fold.ts's handling of a conforming `finding-hold` record
IS the G1 emitter (wire kind ships step 1); only sign-off-counting
semantics + the `finding-hold-lift` closer transition land G3 (closer
ref'd by name, `closer: G3` in row data, wire type step 1 so the ref
resolves); totality test exercises the closer with a fixture lift
record — check NOT weakened; **m1** — the shared condition list +
registration interface now land in step 1, before their consumers
(same seam pattern as faultsIfc). Gates re-run: contract-check 40/40,
g1-ndr-selfcheck PASS. CLEAN×2 clock reset by this fold; next cycle is
the first confirming attempt on the folded text.

## Audit disposition — mapping-audit cycle 6 (2026-11-22)

Auditor gpt-6.1-terra (detached one-shot `~/.tre/audits/v36/g1map-c6-*`,
against commit e936d98): CHANGES REQUESTED — 0 blockers / 1 MAJOR / 0
MINOR. Cycle 5's fold confirmed EXCEPT: the NDR-q row still credited
`inventory.ts` with exporting the shared list (step 9) while step 1
placed it in `records.ts` — a literal implementer following the row
could not complete the step-3 consumers. **Fix:** the row now names
`records.ts` as the exporter (step 1, before consumers) and
`inventory.ts` as importer + owner of the step-9 data table — row and
step list agree throughout; verified no residual "inventory.ts
exports" claim *(corrected in c7: this was too broad — the historical
cycle-4 paragraph still carried the old ownership statement and is now
marked superseded there)*. All 22 rows neutral (rule paraphrase of q itself
judged faithful). Gates re-run: contract-check 40/40, g1-ndr-selfcheck
PASS. CLEAN×2 clock reset; next cycle is the first confirming attempt
on this text.

## Audit disposition — mapping-audit cycle 7 (2026-11-22)

Auditor gpt-6.1-terra (detached one-shot `~/.tre/audits/v36/g1map-c7-*`,
against commit 6769ebb): CHANGES REQUESTED — 0 blockers / 1 MAJOR / 1
MINOR. Cycle 6's fold confirmed (records.ts-exporter agrees with step
list). Findings adopted: **M1** — NDR-s row said unqualified "no
cross-lineage discharge"; the register's clause (v27 R5-C19-3,
docs/11:2204-2208) is narrower: a REFUTED RUN's evidence never
discharges a DUPLICATE OF A CORRECTED CLAIM — row qualified and vector
renamed `ndr-s-no-cross-lineage-dup-of-corrected` with an
assert-not-refused pin against over-implementation; **m1** — the
historical cycle-4 disposition still described `inventory.ts` as the
shared-source owner: marked superseded in place (history preserved),
and the cycle-6 "agree throughout / no residual" claim corrected in
place as too broad. Gates re-run: contract-check 40/40,
g1-ndr-selfcheck PASS. CLEAN×2 clock reset; next cycle is the first
confirming attempt on this text.

## Audit disposition — mapping-audit cycles 8–9 (2026-11-22) — CLOSED

Cycle 8 (detached `~/.tre/audits/v36/g1map-c8-*`, HEAD 47a0530):
**CLEAN** — 0/0/0; all 22 rows neutral; coverage/inverse coverage,
build-order seams, doctrine, and scope boundaries all fixed-ok;
cycle-7 fold confirmed. Cycle 9 (detached `g1map-c9-*`, same HEAD,
independent full re-review per the doctrine): **CLEAN** — 0/0/0.
**CLEAN ×2 on identical text at 47a0530 — the G1-mapping audit is
CLOSED** (9 cycles: 7 CHANGES REQUESTED folded, 2 confirming CLEAN).
Mode B complete: the NDR→implementation mapping is audit-clean and
ready for owner Q1–Q4 sign-off before code.
