## 2026-11-03 — P14 cross-model audit: PASS with docs/tests remediation; acceptance CLOSED

The acceptance-blocking cross-model round (promised by C2-F5) ran: two
auditor workers on independent model families (adversarial probes vs dist +
contract-vs-code traceability), read-only vs HEAD `64d3db9`; artifacts
`.tre/delegation/p14-xmodel-audit/`. Auditor A: PASS — 8192-combo
independent-model differential on the §4 precedence ladder, 0 mismatches,
plus ~120 identity/claim/converter/P4-parity probes. Auditor B: 5 Major +
4 Minor findings — every one a doc/record/test gap, none in verdict logic:
docs/13 header+§8 wording (F-1), this file's 87 count (F-2, fixed above),
EV1 `staleGates` phantom field (F-3), §2 "unique gate ids" vs EV2 (F-4),
missing evaluator-side C2-F3 regression (F-5), advisory wording drift (F-6),
unstated claim-ordering rule (F-7), converter aliasing/extra-key pass-through
+ dead branch (F-8, the only CODE change), roadmap row (F-9). All nine
dispositioned; docs/13 §11 is the record. 6 new tests (F-4 dup-PASS +
contradiction pins, F-5 identity-digest regression, F-7 both claim orders,
F-8 key-drop/clone ×2). Suite: 96 acceptance, full **1887 / 1873 pass /
0 fail / 14 skipped**, `npm test` exit 0. **P14 acceptance CLOSED** —
docs/11 roadmap row P14 is done; next phase per docs/11 §11.1 is P9/M1
supervisor composition.

## 2026-11-03 — P14 cycle-3 follow-ups: C3-F1 test strengthened, C3-F2 findings outrank the claims-only cap

Third review round (same-session lens): the C2-F4 regression was one-sided — it never tested the audit's repro (MATCHING malformed taskRevisions on both sides); now covered, and it fails against the pre-fix source. Contract change (user-approved): **C3-F2** — concrete negative findings now outrank the claims-only CAP as well as the evidence floor: a claims-only spec whose judge explicitly calls a REQUIRED criterion incomplete lands `incomplete`/`verdict:criterion-incomplete` (docs/13 §10; §4 ladder re-drawn). Boundaries: positive claims still cap at uncertain; judged-incomplete on an OPTIONAL criterion keeps the cap. 4 new tests. **C3-F3** (audit of `9bbb54a`, user-approved): the C3-F2 change exposed an asymmetric confidence bar — ANY judge `incomplete` (confidence 0 included) set the finding rung while `complete` required ≥ `semanticMinConfidence`; now negatives are held to the same bar (absent = 0), below-bar negatives still never pass the criterion or leave remainingWork but set no verdict. EV5 carries both exceptions in contract text; 5 more tests (mutation-checked). Suite: 90 acceptance, **1881 / 1867 pass / 0 fail / 14 skipped** (count corrected post-hoc per cross-model audit F-2). Open: the cross-model independent audit round still has not happened — P14 roadmap acceptance stays open until it runs.

## 2026-11-03 — P14 cycle-2 fix round: audit findings C2-F1–F5 closed; suite 1869 / 0 / 14

A second read-only review round of `efd1866` (`.tre/audit-p14-cycle2.md` — same-session lens, not cross-model) found five defects in the F1–F7 closure. All five closed (record: docs/13 §9; docs/11 ledger row appended):
**C2-F1** the F4 evidence floor suppressed a PROVEN missing artifact (`exists:false` observed at current returned `uncertain`): the floor now gates only completion eligibility — concrete negative findings (current FAIL, proven-missing artifact) precede it; the repro lands `incomplete`/`verdict:artifact-missing` again.
**C2-F2** specs whose evidence requirement is a required DETERMINISTIC criterion (no `requiredChecks` repetition — EV7 binds criterion ids to gate ids) were misclassified claims-only and capped at `uncertain` (masking even a current FAIL); classification corrected — PASS funds, FAIL → `incomplete` (EV3).
**C2-F3** schema parity with P4 closed at every emission point: funding claims with `judge:""` no longer produce a journal-rejected `complete` (empty judge → malformed advice, dropped with reason, funds nothing); `dirtyDigest:""` identities refused by identity helpers AND the converter; converter refuses `confidence` outside [0,1]/non-finite (deliberately stricter than the journal's maximum-less `num`); journal acceptance `artifact` no longer nullable — `artifact:null` rejected (absent = no identity), TS type and shape agree. Parity matrix test pins converter-accepted ⇒ P4-accepted.
**C2-F4** `isStale` validates BOTH taskRevisions (positive integers per §14.4) — malformed (`0`, `-1`, `1.5`, `undefined`) is never live on either side.
**C2-F5** record corrections (the one below and docs/13 §8 corrected too): the F1–F7 review was SAME-SESSION (the audit report itself said so; the headline contradicted it) and its "75 acceptance tests" was wrong — 68 at rebuild. Durable-journal gap closed with a REAL `DecisionJournal.open`→`append`→`read` identity round-trip + `artifact:null` fails-closed-on-reopen regression (prior round-trips were field-validation only).
Cycle-2 regressions: 10 new tests (`test/acceptance.test.ts` §cycle-2); all four audit repros re-run against rebuilt dist land corrected. Final: **78 acceptance tests**, full suite **1869 / 1855 pass / 0 fail / 14 skipped**, `npm test` exit 0. Open: the cross-model independent audit round still has not happened — P14 roadmap acceptance stays open until it runs (both rounds so far were same-session reviewer lenses).

## 2026-11-03 — P14 fix cycle: same-session-review findings F1–F7 closed; suite 1859 / 0 / 14 (counts corrected below — see cycle-2)

A read-only review of `891466f` (`.tre/audit-p14-review.md`) found seven defects — the prior R1/R2 cycle was self-review. All seven closed (C2-F5 note: this round was a SAME-SESSION reviewer lens, not a fresh model family; "independent" in the original headline was wrong) (record: `.tre/audit-p14-fixes.md`; contract amendments docs/13 §8; docs/11 ledger row extended):
**F1** artifact evidence with `exists` ABSENT/non-boolean is UNKNOWN → `uncertain`, never satisfied; only `(exists===true, non-empty string digest)` at current satisfies (EV4 strict; malformed digest/exists → `bad-input`).
**F2** ALL four evidence arrays shape-checked on the RAW input — a non-array (`blockers: "yes"`) is `bad-input`, never silently empty (a broken blocker list can no longer become proof of no blockers).
**F3** claims bind to `claim.at` (new field): only claims made AT the current identity fund/fail criteria; unbound claims fund nothing; stale claims' refs surface in `staleEvidenceRefs`. The killer repro (new sha + refreshed gate + old claim) now lands `uncertain`.
**F4** the AC1 floor is unconditional: claims-only spec → `verdict:claims-only-spec` (uncertain); evidence shape present but zero current observations → `verdict:no-current-non-model-evidence`; `complete` requires ≥1 current non-model evidence.
**F5** two-fence output validation: claim output fields (`judge`, `evidenceRefs[]`, well-formed `at`) validated (malformed → dropped as advice); `toAcceptanceRecord` validates the COMPLETE assessment and throws `TypeError` (the `taskRevision:-5` corrupt repro now throws); P4 journal schema validates the amended fields (`advisory` literal-true, `staleEvidenceRefs` strings, `artifact` sha-required) — TS interfaces declare them, `JsonSchema.enum` widened for boolean literals, pre-amendment records stay valid; round-trip tests added.
**F6** judge-declared incomplete on a required criterion is a CONCRETE finding outranking ALL missing-evidence rules (incl. the F4 floor) → `incomplete`; ladder re-ordered and pinned (absence of evidence never outranks presence of a finding).
**F7** `sameArtifact`/`isStale` reject malformed/empty-sha identities — a stored `{sha:''}` assessment is never live.
Every fix has a named regression; all seven original repros re-run against rebuilt dist and land on corrected verdicts. Final: full suite **1859 / 1845 pass / 0 fail / 14 skipped**, `npm test` exit 0. (C2-F5 correction: the "75 acceptance tests" this paragraph claimed was wrong — the rebuilt acceptance suite was 68; cycle 2 grew it to the true 78.) Open: a cross-model independent audit round before the P14 roadmap row flips to accepted (this cycle was the same-session reviewer lens).

## 2026-11-03 — P14 acceptance evaluator: contract (docs/13) + `src/acceptance/` + audit R1–R2 closed; suite 1844 / 0 / 14

Contract-first per §11.2: `docs/13-p14-acceptance-evaluator.md` pins the acceptance-evaluator compartment — artifact-identity staleness anchor (`sameArtifact`: sha + dirty/dirtyDigest, fail-closed on unmeasured deltas), EV1–EV12 evidence rules (claims are advice: never set/flip a verdict; deterministic criteria pass only by a current PASS gate — EV7; artifact `exists:true` needs a digest — EV4; a current gate FAIL is `incomplete` never `blocked` — EV3; unknown is the floor — EV9; `complete` is the full conjunction — EV12), the total §4 precedence ladder, and `isStale()` for stored assessments (live iff same revision + same artifact). docs/11 §14.3 acceptance record amended additively (`criteria[].advisory`, `staleEvidenceRefs`, `artifact` identity) + Change Ledger row.
**Module** `src/acceptance/evaluator.ts` (~600 lines, ZERO imports — the guard test enforces the pure-function boundary; docs/13 §7 defers gate *execution* to the supervisor and *semantic judging* to the caller): `evaluate()` (total precedence, never throws — every malformed shape lands `uncertain` + `bad-input:…`; claims that are structurally broken are dropped per-item, reported, never fatal since advice is never load-bearing), `isStale()`, `sameArtifact()`, `toAcceptanceRecord()` (validates §14.3 shape, never writes journals). Advisory rows carry NO `checkedAtSha` (AC8: a model judgment is not an artifact check).
**Audit cycle `.tre/audit-p14-r1.md`:** R1 self-adversarial found F1 precedence leak (`blocked` was checked before the required-criterion conjunction — an unfunded required criterion + blocker yielded `blocked`; EV9 says missing evidence outranks blocked — fixed, docs/13 §4 R1-amendment) + fail-closed gaps (non-array claims threw; null elements poisoned judgment loops) + hygiene (dead drop-marking, always-true filter). R2 fresh probes vs built `dist/` found **F7** `evaluate(null)` threw (AC5) and **F8** a current FAIL of a gate NOT named in the spec leaked `complete` (EV12: "no current FAIL anywhere" — fixed by sweeping `currentGate` for any FAIL into `failedCurrent`); F9 pinned last-write-wins claim funding by test (matches the newest-last modelAdvisory contract); F10 accepted-by-design (frozen inputs clean — no caller mutation; duplicate opaque evidenceRefs allowed).
Tests `test/acceptance.test.ts` 53: AC1–AC9 named, EV12 mutation matrix (each conjunct independently removed), dirty-tree identity (clean evidence stale at dirty current; matching dirty digest counts), judge-incomplete outranks blocker, blocker-hole → `blocked`, stale blocker never blocks, EV6 threshold boundary (conf exactly at msc funds; missing conf = 0), EV4 no-digest → bad-input, contradictory current PASS+FAIL → bad-input (EV2), NUL-byte ids, fuzz-lite junk inputs never throw, purity (deep-equal input before/after + identical outputs), S5 record conversion, and the P8-C2-F13-pattern compartment guards (no ingress to `src/acceptance/` from the repo; module imports NOTHING at all — positive fixtures prove the guard fires).
Final: `tsc` clean; quality gate green; full suite **1844 / 1830 pass / 0 fail / 14 skipped**. P14 is a judgment function only — no permission, no journal writes, no model calls; P9/P11 wiring consumes it (supervisor runs gates, gathers artifact observations, hands in judgments).



## 2026-11-03 — P8 fix cycle 5: audit-c5 findings C5-F1–F3 closed + audit-c6 findings C6-F1–F3 closed; suite 1777 / 0 / 14
Cycle-5 audit (`audit-c5.md` vs the cycle-4 commit): C5-F1 (malformed-policy boundary) and C5-F3 (raw-byte repair) closed by this cycle's first pass, but the cycle-5 re-audit (`audit-c6.md`, FINDINGS) showed **C5-F2 NOT closed** — its fix sliced the journal strictly before the prior reservation, which dropped LATER standing contributions and replayed pre-intent closes. Cycle 5 (this commit) closes both audits' remaining majors:
**C6-F1 (major)** the historical-prefix recheck made a tightened AGGREGATE cap miss real revocation: A ($0.25) + B ($0.25) live under `caps.usd:10`, tighten to $0.40, redeliver A — the prefix is empty, so redelivery SUCCEEDED with $0.50 standing. **C6-F2 (major)** the same slice resurrected released holds (X=$0.75 released AFTER A's admission still charged: projected $1.00 against a $0.50 cap threw policy-revoked on $0.25 of real standing) and always restored the redelivered intent's ORIGINAL estimate whether it remained open, settled or released (settled $1 intent refused under a tightened $0.50 cap though its live hold is $0).
**The fix — coverage mode (the architecture C5-F2/C6 demanded):** `check(policy, request, snapshot, now, { coverage?: boolean })`. Coverage mode judges the FULL CURRENT snapshot (lifecycle-correct by construction: the fold refunds evidenced releases, keeps settled/expired/abandoned attempt slots A8, preserves strategy history and elapsed intervals) and adds **no hypothetical hold, attempt slot or strategy repeat** — the intent's own standing is already in the snapshot or zero if evidenced-closed. Authority checks are shared unchanged; the coverage verdict never mints a receipt (`CheckResult.receipt === undefined` — A4: only admission mints). The `reserve()` redelivery branch is now `check(pol, req, fullSnap, admissionAt, { coverage: true })` — the prefix slice, the wallclock-map patch-over and the reservedAttempts union hack are all DELETED. Consequences verified by public-API probes (re-running the audit's own repros, `scratch/c6/`): unchanged-policy redelivery at cap still succeeds (C3-F7), the tightened aggregate cap with essential later holds refuses (C6-F1), a release of an earlier hold refunds — redelivery covers the live total (C6-F2-r1), a settled intent's closed estimate contributes nothing live while its attempt slot stays charged (C6-F2-r2), a tightened wallclock cap still revokes (C4-F2), caps lowered below live standing still revoke (C2-F10/C5-F2).
**C6-F3 (minor)** docs/12 §7 item 7 rewritten to the coverage contract (including the explicit rejection of historical-prefix rechecks as a mechanism), and every surrounding comment describing the superseded refold/prefix algorithm (the C2-F10/C4-F2/C5-F2 block in `reserve()`, the C5-F2 test comments that ENCODED the workaround) corrected to the actual mechanism.
Tests: +5 C6 regressions (80 in `test/budget-ledger.test.ts`, 75→80): tightened aggregate cap where later holds are ESSENTIAL (audit's killer fixture), earlier-release-after-admission refund, settled-estimate-below-tightened-cap, coverage-never-mints (observation, not permission), coverage-adds-no-second-slot/no-second-strategy-repeat. docs/12 §7 item 7 + ledger.ts/test comments corrected (C6-F3).
**Cycle-7 addendum (audit-c7, C7-F1 — recommendation):** the earlier-release regression reserved X at the $0.25 default (no estimate), so the comment claimed $0.75 while a restored prefix mutant passed the test; fixed to the exact killer fixture (`reqX` estimate $0.75 + assertion on `recX.reservedUsd` — independently re-verified: the corrected test FAILS against the auditor's prefix mutant with policy-revoked and passes HEAD), and the two stale comments the audit named (C5-F2 test title/"below the reservation" wording — the $0.01 cap actually denies via the D2 class floor) corrected. Cycle-7 closure: C6-F1 closed, C6-F2 closed-in-code/test-gap-now-closed, C6-F3 closed; 3000-case admission differential vs parent: identical; 3 mutations killed.
Final suite state: `npm run build` (tsc) clean; `npm test` full suite **1777 pass / 0 fail / 14 skipped**; audit-c6 repros re-run against built `dist/` — all three probe outputs now refuse/succeed as specified (scratch/c6/probe-c6-fix.mjs). P8 acceptance rests on the cycle-7 re-audit of this commit.

## 2026-11-02 — P8 fix cycle 3: audit-c3 findings C3-F1–F8 closed; suite 1755 / 0 / 14

Cycle-3 audit (`FINDINGS`, gpt-6.1-sol vs `3fdc2fde`, `.tre/implement-audit/p8-audit/audit-c3.md`: 7 bugs + 1 recommendation). All eight closed:
**C3-F1** the C2-F1 snapshot covered the REQUEST only — a policy mutated from an injected clock's microtask still redirected the durable episode/root/paths while the ORIGINAL receipt digest passed. `reserve()` now deep-freezes a **synchronous snapshot of the presented `GatePolicy`** at call entry (resolver by reference); every judgment, digest comparison and durable field (episodeId, authority.root, paths, flags, amounts, TTL) is built from the snapshot, never the caller object. Mid-call mutation — episode swap, root swap, flag flip — changes nothing; revocation governs later calls only.
**C3-F2** the wallclock fold SUMMED overlapping closed/live and closed/closed intervals (run+resume on one attempt: 190s for a 100s span). Per-attempt time is now the **UNION of reservation intervals** (sorted merge, `[start,end)` half-open, zero-length live windows excluded; adjacent windows DO fuse at the shared boundary — `s <= runEnd` — which is duration-neutral). Explicit `recordWallclock` windows take **unconditional precedence**: an accepted explicit record for the attempt suppresses the reservation-derived proxy entirely (100s reservation + 1s explicit = 1s) — cycle-3's original entry wrongly claimed explicit wins only when strictly greater; corrected per audit-c4 F3, matching docs/12.
**C3-F3** a wallclock record discarded by first-wins dedup still marked its attempt explicitly-timed and suppressed ALL live elapsed (no entry instead of 100s). `explicitWindowKeys` is now derived ONLY from ACCEPTED (first-wins) records during the primary fold — a cross-kind duplicate is dropped entirely.
**C3-F4** a hand-written attest-less terminal `res-close` stayed schema-valid and erased the hold on rebuild. The SCHEMA now requires `attest` on every terminal close (settled/expired/released): bare terminals are schema-invalid → open refuses `corrupt` (fail-closed), and the fold independently ignores bare terminals for defense in depth. The API already persisted only a `close-request` for unattested closes (C2-F6, unchanged).
**C3-F5** `ActionReceipt.verify()` accepted a negative clock (`verify(spec,-1)` → ok) while check/reserve rejected it. verify now rejects non-finite/NEGATIVE now — the return shape is `{ ok: false, reason: "…clock is negative (…)" }` (cycle-3's original entry wrongly claimed an `invalid-now; expired:true` field shape; corrected per audit-c4 F3) — the verifier handed to future spawn consumers validates time consistently with mint/admission.
**C3-F6** multi-blank/whitespace EOF suffixes (`rec\n\n\n`, `rec\n\n \t\n`, whitespace-only `\n\t\n`) threw `corrupt` at open BEFORE the C2-F12 normalization could run. The reader now trims the ENTIRE EOF whitespace suffix pre-validation; durable normalization at open (rewrite+fsync, `tornTailRepaired=true`). The cycle-3 repair only cut the unterminated branch to the last newline (blank lines survived → corrupt on the next append+reopen) — **audit-c4 F1** extended the repair to full-suffix normalization. Blank-before-real-record stays fail-closed `corrupt`.
**C3-F7** idempotent redelivery under an UNCHANGED policy at its own cap falsely threw `policy-revoked` (the recheck added a hypothetical second hold/use on top of the standing one). The recheck is now **coverage**: the gate refolds the journal WITHOUT this action's own res-open, judging exactly one instance of the intent — unchanged-policy redelivery at cap succeeds; genuine revocation (usd/turns cap lowered below the standing hold, authority flags flipped, strategy limit tightened) still refuses `policy-revoked` (observation-only). The cycle-3 refold also dropped the record's ACCRUED WALLCLOCK interval (elapsed time is durable fact, not the record's intent), so a tightened `wallclockS` cap failed to revoke — **audit-c4 F2** fixed this by taking the wallclock maps from the FULL snapshot while refolding holds/slots/uses without the record.
**C3-F8 (rec)** "FINAL write stamp / monotonic ts" claims withdrawn everywhere (ledger.ts comment, HANDOFF line 10, docs/12 amendment §9): the stamp is a SAMPLED LOGICAL ADMISSION boundary — ts sampled before the write with expiry re-verified against it; NOT durable-completion time (delayed fsync can land past expiry), NOT act time (executor re-verifies with a live clock before spawn), NO monotonic-ts guarantee (backward clock sample recorded as-is; consumers must not order by ts).
Tests: +10 C3 regressions (58 in `test/budget-ledger.test.ts`, 48→58). docs/12 §7 amendment items 3/6/7 corrected in place and items 8 (policy snapshot) + 9 (stamp semantics) added. (Cycle-3's blanket claims — "every audit repro through PUBLIC APIs", "all seven probes re-run 7/7", "all eight fixed & cycle closed" — were **overstatements** per audit-c4 F3: some fold-level tests call `projectLedger` directly, no dedicated C3-F8 stamp regression was added, and the C3-F6 repair shipped partial (audit-c4 F1). Corrected here; the cycle-4 entry below closes the gaps.)
Final suite state at the cycle-3 commit: `npm run build` (tsc) clean; `npm test` full suite **1755 pass / 0 fail / 14 skipped**. P8 acceptance rested on the cycle-4 re-audit, which returned FINDINGS (see below).

## 2026-11-03 — P8 fix cycle 4: audit-c4 findings C4-F1–F3 closed; suite 1763 / 0 / 14

Cycle-4 audit (`audit-c4.md` vs the uncommitted C3 diff): 2 major + 1 minor, all closed:
**C4-F1 (major)** the unterminated repair branch cut only to `lastNL+1`, leaving blank lines that the next honest append planted mid-file (reopen threw `corrupt: blank line 2`). `repairTail()` now performs a **byte-wise backward trim of the ENTIRE EOF whitespace suffix** (multi-byte UTF-8 aware: lead-byte detection, continuation walk-back, one code point decoded at a time, invalid/partial sequences end the scan — never a full-buffer re-decode, which would shift cut offsets when a mid-file line holds invalid UTF-8). The cut keeps the last real record's OWN newline: when the record line carried trailing spaces before its newline, `buf[end]` is a space, not the newline — the terminator is found by scanning forward, so no survivor is left unterminated (the append-fusion class this repair exists to kill). Whitespace-only unterminated files cut to 0. Regressions: the audit's `\n\n \t` and `\n\n\n \t` repros, trailing-space-record-line variant, whitespace-only-unterminated variant — each open→repair→append→**reopen** (the audit's killer step).
**C4-F2 (major)** the C3-F7 coverage refold removed the action's res-open record — which also removed the **wallclock interval its hold accrued**. A run reserved at t=0, redelivered at t=100 s under `perAttempt.wallclockS: 50` passed, while `check()` on the live snapshot denied `attempt-wallclock-exceeded`. The refold now judges holds/slots/strategy-uses WITHOUT the record (one instance of the intent, C3-F7 preserved) but takes **both wallclock maps (`wallclockS`, `attemptWallclockS`) from the FULL snapshot** — elapsed time is durable fact, not the record's own intent. Regressions: tightened attempt cap revokes, tightened episode cap revokes, and the boundary (accrued 100 s < tightened 200 s cap still redelivers — no C3-F7 regression).
**C4-F3 (minor)** the cycle-3 entry above invented semantics: "explicit wallclock wins only if strictly greater" (code: unconditional precedence — an accepted explicit record suppresses the proxy entirely), "verify returns invalid-now; expired:true" (code: `{ok:false, reason}`), and the closure overstatements ("every repro through public APIs", "7/7 probes", "all closed"). All three corrected IN PLACE above; docs/12 always described the actual behavior.
Tests: +8 C4 regressions (66 in `test/budget-ledger.test.ts`, 58→66). Verified against built `dist/`: audit-c4 probes re-run — F1 and F2 repros now refuse/normalize as specified. P8 acceptance rests on the cycle-5 re-audit of this commit.

## 2026-11-02 — P8 fix cycle 2: audit-c2 findings C2-F1–F13 closed; suite 1745 / 0 / 14

Cycle-2 audit (`FINDINGS`, gpt-6.1-sol vs `c7a9663`): 13 bugs + 2 recommendations. All 13 bugs closed; both recommendations addressed:
**C2-F1** receipt binding was still bypassable after the pre-queue comparison: `reserve()` takes a **synchronously frozen snapshot** of the presented request (`Object.freeze`, deep on the checked fields) at call entry — every durable/queue decision uses the snapshot, never the caller-owned object; the snapshot's canonical digest is re-verified against the receipt INSIDE the queue immediately before the write (mutation across awaits changes nothing).
**C2-F2** `policy.authority.root` is now hashed into the receipt digest — swapping the root between check and reserve is `receipt-mismatch`.
**C2-F11** the receipt binds the RAW estimate and the mint-time raise decision: rewriting the estimate (even below-floor or absent→present) before reserve is `receipt-mismatch`; the durable `estimateRaised` is the mint decision, never a caller rewrite.
**C2-F9** `check()`, `ActionReceipt.verify()`, and reserve admission reject non-finite/negative `now`, and expiry arithmetic that overflows (`bad-input`) — NaN/Infinity/MAX_VALUE+TTL no longer mint, and NaN never passes a TTL comparison.
**C2-F4** projection is order-independent: a `res-close` recorded before its `res-open` still excludes the hold (closes apply wherever they sit — the contract pinned by the §2 reconcile rule).
**C2-F5** the fold dedups record ids FIRST-WINS before any contribution — a replayed res-open never double-charges an attempt slot or a strategy use (still reported in `duplicateIds`).
**C2-F7/F5** expiry + policy are re-verified at the FINAL write stamp (inside the queue, after the last disk read): a clock that jumps evil only at the stamp is `receipt-invalid` ("durable write") and writes nothing. Sampled logical admission only: not durable-completion/act time, and no monotonic-`ts` guarantee (C3-F8 corrected this claim — see the cycle-3 entry).
**C2-F8** wallclock interval semantics: a terminal close NEVER erases accrued time; explicit supervisor `recordWallclock` windows take precedence over the reservation-derived live interval (no completed/live double count); `ts=0` is a valid live anchor.
**C2-F6** terminal closes carry evidence: `res-close.attest {outcome, evidence, spawnStarted?}` (schema-validated); a bare `closeReservation(id,'released')` persists only a `close-request` marker — the hold STANDS; slot refunds require negative spawn evidence (`spawnStarted:false`), so evidence-free closes cannot reopen external headroom or attempt slots.
**C2-F3** authority gate takes an injected `resolveRealPath` (longest-existing-prefix realpath, nonexistent leaves appended, failure denies fail-closed): symlink escape is denied; without it the guarantee is lexical — pinned as docs/12 §7.5, no longer a silent delegation.
**C2-F10** `reserve()` validates the policy on EVERY call including the idempotent-redelivery branch (NaN caps → `bad-input`), and a policy that no longer covers the standing reservation rejects `policy-revoked` (observation-only — the record stays, per docs/12 §7.7).
**C2-F12** a terminated trailing blank line is normalized DURABLY at open (rewrite + fsync; `tornTailRepaired=true`) — the whitespace can no longer poison a later honest append.
**C2-F13** compartment guards rewritten: one specifier extractor for static/side-effect/dynamic/`export[] from`/`require()` including `.js` suffixes and aliases; POSITIVE violation fixtures prove a no-op guard cannot pass (both audit mutations now caught).
**R1** 17 targeted regressions for every C2 repro (F1–F13 + projection semantics); denial sweep unchanged where new codes are `BudgetLedgerError` codes (typed at API, not gate denials — `attest-required`, `policy-revoked`).
**R2** docs/12 gains §7 "Contract amendment — as-built surface": own `tre-budget/1` file format, whole-file read-only ingestion (cursor deferred), A7 = pure in (records, now) with interval semantics, A9 partial by declaration, lexical-unless-resolver boundary, evidenced closes, redelivery != permission. HANDOFF cycle-1 "all closed" overclaim is superseded by this entry; P8 acceptance rests on the cycle-3 re-audit of THIS commit.

## 2026-11-02 — P8 fix cycle 1: independent audit (gpt-6.1-sol) findings F1–F20 closed; suite 1728 / 0 / 14

Independent audit `FINDINGS` verdict against `2a5e1db` (.tre/implement-audit/p8-audit/audit-c1.md: 17 bugs + 2 recommendations) — all closed in this commit:
**F1** receipt binding was circular (digest recomputed from the live request): the receipt now carries the frozen canonical snapshot and `reserve()` compares the presented request field-by-field against it (`receipt-mismatch` on any drift).
**F2** open reservations evaporated at TTL: expiry NEVER removes a durable hold — an open (even expired) reservation keeps charging every compartment until an evidence-backed terminal close; expiry only blocks NEW admission (re-verified INSIDE the queue, F5). The A7/A2 tests now assert the hold survives expiry.
**F3** settled runs refunded their attempt slot (unlimited sequential attempts): a run reservation consumes the slot whether open/settled/closed-expired; ONLY a justified `released` close refunds (deferred post-pass so a close before its open still refunds once). actionId uniqueness + idempotent redelivery enforced inside the queue (`action-used`).
**F4** attempt reservations now charge the attempt compartment chain (episode+task+attempt).
**F5** receipt expiry moved inside the critical section; **F6/F7** the full EpisodeAuthority denial surface is enforced (paths via canonicalizePath+globs with default-closed absence, install/network/model/toolCalls maxes — `path-not-granted`, `install-not-allowed`, `network-not-allowed`, `model-not-approved`, `diagnostic-limit-exceeded`).
**F8** unknown pricing is the NONNUMERIC state (A6): `priced:"unknown"` records carry NO costUsd/rates, count in `unpricedCount`, and BLOCK USD admission in any compartment that carries them (never a silent $0); `FALLBACK_RATE` survives only as an explicit operator opt-in entry (provenance `override`). `SpendPriced` = table|override|unknown — `fallback` removed.
**F9** newline-terminated garbage fails closed (the read fold refuses it; repair only tolerates genuinely unterminated tails); **F10** duplicate-key detection decodes escapes (`"\u0073econds"` ≡ `seconds`); **F13** same for decoded keys in tail ambiguity; **F14** repair fsyncs through the handle before resolve.
**F15** reserve/close/append timestamps come from the injected clock at append (`ts: 0` never persists); **F16** manual-spend lineId guard runs INSIDE the queue (racing same-lineId calls → one durable record); **F17** open reservations anchored to an attempt accrue live wallclock from reservation.ts to `now` (supervisor downtime counts; A7 determinism preserved — fold is pure in (records, now)).
**F18** `validateGatePolicy` throws on non-finite/negative caps BEFORE any receipt mints (NaN no longer mints an allow).
**F19/F20** `RESERVE_DEFAULTS` exported as the module contract (run $0.25/1t, resume $0.05/1t): class default is the floor, callers RAISE only (raise-only, durable `estimateRaised`), and a policy cap BELOW the class default is the new denial `reserve-default-exceeds-cap` — never a silent redefinition.
**Rec** the compartment-guard regex now matches real import specifiers (`from "./x/budget/y.js"` caught); HANDOFF claims corrected: the wire schema id is `tre-budget/1` (this file said `tre.ledger.v1` — wrong), ingest provenance is `unpricedCount` (was `fallbackPricedCount`), and the D2 floor is the class default, not the per-attempt cap. Tests updated to the new contract + new coverage for F1/F2/F3/F5/F15–F18. P8 cycle 2: same-auditor re-audit of THIS commit decides acceptance.

## 2026-11-02 — P8 first increment: budget ledger & spend authority (`src/budget/`); suite 1728 / 0 / 14

`src/budget/ledger.ts` (~1,300 lines, 31 tests in `test/budget-ledger.test.ts`,
docs/12): one self-contained module (`node:` builtins only — the P4 journal
queue is re-implemented in-module rather than imported, per the fleet
pattern; compartment guard test proves nothing outside `src/budget/` imports
it and it imports nothing). Two halves: **BudgetLedger** — append-only JSONL
per episode (schema `tre.ledger.v1`, four kinds: `spend` / `res-open` /
`res-close` / `wallclock`) with the P4 durability discipline (fsync before
return, serialized appends, torn-tail repair, mid-file corruption fails
closed, dup record ids reported, dup-lineId spend refused `dup-line`);
**check()** — the pure gate over a `projectLedger` snapshot: ten budget denial
codes across episode/task/attempt compartments (consumed + live holds + the
new reservation floor), plus the authority half (`authority-missing`,
`external-not-allowed`, `estimate-invalid`). A pass mints an opaque
`ActionReceipt` (module-private WeakMap + SHA-256 digest over the canonical
action spec — check(X)-then-act(Y) fails loud); `reserve()` re-validates the
receipt AND re-runs check() inside the serialized append queue (refresh-first,
R6/R7 pre-empted). D1: in-module `DEFAULT_RATES` (exact > prefix > provider >
fallback, provenance derived by the resolver itself, never hand-claimed),
per-episode overrides, rate FROZEN onto each record at ingest — history never
reprices. D2: the reservation floor derives from the episode's own
per-attempt caps; callers raise, never lower; raises are recorded on the
intent. A6: an open run-reservation consumes an attempt slot (reservations
ARE attempts); resume into a never-reserved attempt denies. Ingest from
session JSONL goes through the P5 tailer's offset discipline (own cursor
file, never mutates the session; only assistant-entries with a usage block
ledger; unknown-priced entries flagged `fallbackPricedCount`, never silently
free per I3). Wallclock windows per task and per attempt. Bugs found and
fixed by the test suite: ingest dedup race (guard inside the queue),
`ts: 0` falsy bug, reserve/closeReservation queue deadlock, compartment
null-stop on the upward roll-up, A6 presence via the ever-reserved trail
(not the usage roll-up). Mutation sweep proves every denial code reachable
and `allowed` iff denials empty. P8 NOT yet accepted — independent
fresh-family audit decides (docs/12 §5 bar).

## 2026-10-31 — P7 remediation against the working-tree audit (all 9 findings + dead code); suite 1638 / 0 / 14

`src/runner/attempt.ts` (1,215 lines, 27 tests named per finding) now
addresses every finding of `docs/audits/audit-p7-working-tree.md` (whose
blocker was that the module did not compile): ESM-safe X_OK executable
check; `confirmStopped` ownership by SPAWN GENERATION (journal-stamped
`spawnGen` — a newer tuple's live claim survives confirmation of an older
one); session paths canonicalized at run/resume entry; group liveness via
`kill(-pgid,0)` (stop() returns groupStatus; leader death alone never
releases ownership — reconcile parks, run/confirmStopped refuse, incl.
EPERM = undeterminable = park per I3); resolved `failed` outcomes are
negative evidence; single-flight `AttemptRunner.open()`; `validateSpawnSpec`
refuses `--attempt-id` and `--resume`+`--session` (real CLI exits 2 on both
— verified), default `treWorkerSpawner` emits XOR argv with identity via
TRE_ATTEMPT_ID env; S6 hint advances to newer attempts, refuses rewinds;
dead code removed (newestPerSession stub, reservations tripwire).
AttemptRecord gains `pid`/`pgid`/`spawnGen` (journal = liveness authority,
state.json demoted to cache). The F5 test fixture was replaced after a
probe proved the old `trap '' TERM; sleep &` leader genuinely died to the
group TERM (flaky escalated). Evidence: `npx tsc` clean; 27/27 x8 stable
runner runs; full suite 1638/0/14; live probes confirmed group semantics
(alive with leader dead/child alive; ESRCH after group SIGKILL) and CLI
argv rejections. P7 stays NOT accepted — independent re-audit (gpt-6.1-sol
implement-audit loop) decides.

## 2026-10-31 — P6 REOPENED: independent audit found 3 real defects (suite 1611 / 0 / 14 (1597 + 14 skip))

**The cycle-4 ACCEPT was not independent.** Cycles 1–4 audited P6 with the
SAME model family that implemented it (deepseek-v4.1-flash-1017), so the
sign-off inherited the implementer's blind spots. A fresh audit of the
committed 603611d by two different families (claude-haiku-5.5 and
muse-spark-1.3) both returned REJECT on the same findings. Three were
confirmed by a live probe harness against the built module, not by reading:

- **C8 (data loss):** the `deleteBranch` gate `rev-list base..branch` is
  trivially empty when `baseCommit` is the branch's own tip — the gate
  "proved" loss-free deletion and then discarded a real unmerged commit.
  Reproduced end-to-end. The proof now requires base to be an INDEPENDENT
  pin (reachable from some ref other than the branch being deleted) AND an
  ancestor; the old test asserting "base == tip is provably loss-free" was
  itself wrong and is corrected.
- **C5 (false provenance):** `ensureTaskWorktree`'s preexisting path
  returned the requested `baseCommit` beside the registry `head` with no
  relation check, so a retry with a moved base returned success with a
  false §14.1 AttemptRecord and a wrong P12 merge anchor. Now the head must
  equal or descend from the base, else `branch-conflict`.
- **C1 (dead refusal):** `prune()` returned `{refusedForeign}` instead of
  throwing, so callers that ignore the result believed a blocked cleanup
  succeeded; `prune-refused` was declared but never thrown.

Also fixed: `locked` is parsed from `worktree list --porcelain` (a locked
worktree now refuses with a `locked` code instead of a late bare git
failure, and the stale-entry message names `worktree unlock`); the
placement probe no longer walks up on EACCES (fail-open in a fail-closed
gate); the post-creation HEAD check surfaces real stderr instead of
"HEAD null"; and the `pathsEqual` comment no longer claims a
canonicalization it does not do (renamed to a documented fail-closed
residual). Suite **1597 pass / 0 fail / 14 skip**, gate clean.

**Lesson (worth keeping):** an audit run by the implementing model is not
an audit. Cycles must use a different family, and cycle-4-style ACCEPTs
should say which model signed off.

## 2026-11-01 — P6 ds-audit series (cycles 1-5, suite 1611 / 0 / 14, 51 worktree tests)

The full post-commit audit series with deepseek-v4.1-flash-1017 landed on main (`673d4a1` -> final cycle-5 commit). Twelve real defects fixed across five cycles; the headline class: **git ref-resolution semantics** — a same-named TAG shadows a branch in `rev-parse`/`rev-list` (refs/tags/ precedes refs/heads/), which hollowed the deleteBranch proof after the C8 fix; every proof operand is now `refs/heads/`-qualified. Second class: **LOCKED worktrees** — git never marks locked entries prunable (locked+vanished dirs masqueraded live everywhere; liveness is now the `<path>/.git` gitfile), single `--force` cannot remove a locked worktree (`-f -f` required). Third: raw errnos and silent noops escaping the typed contract (wtRoot-as-file, plain-file/dangling-symlink at the task path -> `bad-wt-root` / `path-exists` / `not-registered`).

**Process lessons (both hurt, both kept):** (1) the same-family auditor rule still applies — this series ran auditor+implementer in one family, and the auditor was WRONG twice (claimed tag-shadowing on `worktree add`, whose commit-ish is branch-oriented; claimed recreated dirs escape `prunable`, which git decides via `<path>/.git`). Neither was "fixed" — both were disproven by experiment and PINED with regression tests, and the proposed fix for the first would have introduced a real detached-worktree defect. **Never implement an audit claim without reproducing it first.** (2) The docs P6 row is designated the full contract; three cycles of code fixes silently drifted it (it described the rejected `base..branch`-only proof). Error-union changes must land in the same commit as the code.

## 2026-10-31 — P6 worktree provisioning + 4-cycle audit (suite 1608 / 0 / 14)

**P6 implemented (docs/11 §11.1, §5, §14.1/§14.5).** `src/worktree/provision.ts`
ships `WorktreeProvisioner` — git worktree provisioning ONLY (integration is
P12): `open()` placement gates (wtRoot outside our repo AND any foreign repo,
bare included — authority = `rev-parse --path-format=absolute --git-common-dir`
on the nearest existing directory ancestor, checked BEFORE any mkdir, so a
refused open creates nothing); `ensureTaskWorktree` open-or-create idempotent
with branch `agent/<episodeId>/<taskId>` pinned at the resolved base sha +
post-creation HEAD verification, crash-recovery re-attach (branch at base,
registration gone), `branch-conflict` never-reset, `path-exists` never-adopt,
`stale-registration` until prune; `removeTaskWorktree` conservative teardown
(registered-only; dirty gate incl. untracked BEFORE mutation; deleteBranch
gated on `base..branch`-empty proof — never `branch -d` heuristics — plus a
branch-checked-out-elsewhere pre-gate; force = explicit discard); `prune()`
refuses when any stale entry lies outside wtRoot (git's prune is repo-global)
and reports exact removals by registry diff; `resolveCommit` option-safe
(`--` separator, `^{commit}` peel, never a HEAD fallback). All git via fixed
argv execFile; probe negatives classified honestly (exit 1 + the full
search-exhausted wording only — a broken-gitlink `not a git repository:
(null)` is a hard git-failed, never "outside any repo"). Provenance return
feeds the §14.1 AttemptRecord. Two enforced compartment guards (node:-only
imports; nothing outside src/worktree imports it). 34 tests on real git repos.

**Audit series (deepseek-v4.1-flash-1017 read-only;
`docs/audits/audit-p3b-p6c{1..4}.txt`).** Cycle 1: 2 CONFIRMED-WRONG (open()
mkdir'd before validating; foreign BARE repos undetected by `--show-toplevel`)
+ 3 RISK (dash-rev escaping, probe-exit collapse, partial delete via
`branch -D` on a double-checked-out branch) — all five fixed with
regressions. Cycle 2: 1 CONFIRMED-WRONG (a linked worktree RENAMED behind
git's back escaped registry-path containment) — fixed by replacing the
containment list with the stricter authority rule: anchor resolving to OUR
common git dir → refused unconditionally (git's own view is the authority).
Cycle 3: REJECT — 2 more (broken-gitlink stderr matched the loose
"not a git repository" marker → treated as outside; `nearestExisting` could
anchor on the `.git` GITFILE → ENOTDIR) — both fixed + regressions. Cycle 4:
**ACCEPT — no findings**; residual TOCTOU accepted for P6 under the §14.5
caller fence (git rejects concurrent duplicates; safe-state on failure).

**Next:** P7 (attempt runner & ownership recovery — the fence the
provisioner's idempotence assumes) or P8 (durable accounting), per the docs/11
dependency graph (P0+P4+P5+P6 → P12 is deferred; P7 precedes auto-scheduling).

## 2026-10-31 — P4 episode journal: audit follow-ups (suite 1509 / 0 / 14)

**Post-commit audits of the P4 journal primitives (docs/11 ledger).** The
d5447d8 audit added the duplicate-JSON-key boundary (`duplicateKeyIn`) on
every read boundary; its follow-up (612564a) moved the guard INSIDE
`#repairTail` (defense in depth — `open()`'s `read()` already rejects the
duplicate first) and pinned the fail-closed behavior that hand-pretty-printed
multi-line JSONL is rejected while the writer always emits one line
(JSON.stringify escapes newlines).

**Implement-audit cycle 1 on 612564a** (auditor claude-haiku-5.5; gpt-6.1-sol
and gpt-6-astra both 429'd — provider quota): previous finding confirmed
RESOLVED by independent probes; the two recommendations fixed here —
(1) the scanner evidence is pinned IN-REPO: a seeded-LCG fuzz (600 generated
valid docs + 600 constructed duplicates, adversarial values built through
`JSON.stringify` rather than hand-escaped literals; an early draft of the
generator double-escaped its own strings and produced mostly invalid docs —
caught by the parse-count assertion) plus a fixed adversarial case table, via
a new `@internal` export of `duplicateKeyIn`; (2) the tail guard's INPUT
CONTRACT (raw, complete-but-unterminated JSON tails) is now unit-pinned,
since the guard line itself stays reachable only through the write-side race
`open()` structurally closes. Suite **1509 pass / 0 fail / 14 skip**.

## 2026-10-30 — wire diagnostics + C43 intent nudge (suite 1453 / 0 / 14)

**describeError cause chain (`f029976`).** A transport-level
`BodyTimeoutError` wrapped as `TypeError: terminated` lost its cause — the
session reported an unactionable "terminated". `describeError` now walks the
finite, cycle-checked `cause` chain and assembles
`root (cause: A <- B <- ...)`; budget applies to the FINAL assembled string,
code-bearing nodes first. Plain errors keep their previous output
byte-for-byte. Suite 1447 pass / 0 fail / 14 skip. (Server half of the same
workstream: llama.cpp `3375f46`, SSE ping during silent prefill —
live-verified.)

**C43 — premature intent stop → one nudge (`f7daa18`).** Observed 6× in one
live session: the model announced the next step ("Now building …:") and the
turn ended `stop` with ZERO tool calls — the colon was treated as a handoff
the stop token ate. A text-only stop is legitimate, so the recovery keys on
the high-precision marker (SHORT reply ≤600 chars ending with ':'): in the
zero-calls branch, after the steering keep-alive check, one nudge per cycle
("make that tool call now instead of describing it…") and continue —
mirroring the C22 length nudge exactly (the nudge itself is not an LLM turn —
it adds nothing to `turn`, though the model's retry response counts as a
normal turn against the cycle budget; per-cycle reset,
a pending steer supersedes and resets). A second consecutive intent stop
ends the run normally. 6 new tests. Suite **1453 pass / 0 fail / 14 skip**
(current actual, re-verified 2026-10-30).

**Doc consistency sweep (this commit):** corrected the residual mislabelled
dates the 2026-10-29 hygiene pass missed — `2026-10-31` (8 sites) and
`2026-10-30` (1 site) in `src/types.ts`, `src/loop/agent-loop.ts`,
`test/agent-loop.test.ts`, `docs/02`, and `docs/08` → `2026-10-27` (the true
date of the loop-v2 audit chain `a2fd742`/`9d5b061`/`8d4f3ab`). The two
remaining `2027-*` strings are legitimate MCP protocol-version fixtures
(`docs/10` removal dates; the client's modern revision `2026-07-28` and a
deliberate newer-than-client probe). `docs/08`'s second "§10" heading
(Audit F-6) renumbered to §11 — it collided with the H3 §10 every cross-ref
means. Checked clean: all `docs/*.md` references from src//test//README/PLAN/HANDOFF
resolve; all D-numbers used in code lie within the PLAN.md log rows or the
archive-defined range (D15–D22 defined in `HANDOFF-archive.md`); all C-labels
used in code lie within the archive-defined C21–C42 range plus the C1–C3
compaction-criteria labels defined in `docs/06` and **C43** (the intent nudge
above — its prose definition lives in this entry, its code definition in
`agent-loop.ts` + tests). Scope caveat: these are
RANGE checks, not full cross-reference checks — the numbers are NOT a
collision-free namespace, so membership does not prove a reference points at
the definition its reader expects. Two known topic-collisions (kept, label
reuse predates this sweep): **C41** — `test/tui-pinned-layout.test.ts` ("item
layouts are cached") vs the archive's C41 (ChatGPT `client_version` fix,
`HANDOFF-archive.md`); **D15** — `src/wire/*` + `src/auth/*` (ChatGPT
Responses/OAuth workstream) vs the archive's D15 (`/display-bottom` + `you`
prefix). Resolve these by topic, not number. Fixed in this sweep: the
"docs/02 C6 contract" dangling label in HANDOFF (×2) and PLAN (×1) — the
batch-shape guard paragraph lives under Contract 4 (Tool) in docs/02 and the
references now say so. Note: C43 is recorded above (this entry is its prose
definition; the code definition lives in `agent-loop.ts` + tests).

---

## 2026-10-29 — Telegram round-4 (F1+F2) + batch-shape guards (audited; cycle 1 fixed)

**Audit cycle 1 (auditor gpt-6.1-sol, `audit-c2.md`): FINDINGS — 3 reproduced
bugs, all in the batch-shape guards (Telegram F1/F2 PASSED stress probes;
date-only edits verified behavior-neutral).** Fixed in this follow-up:
1. Synthetic skip records no longer pad the guard history — digest and
   failure flag are built from the EXECUTED subset only (padding with exact
   duplicates previously changed the stable digest and rescued loops; skip
   `failed=true` previously exempted real cycles). Skips still ride the
   transcript as in-band errors.
2. Results/end events are emitted in strict model CALL ORDER — one loop over
   the original `calls` array (executed results and skip notices interleaved
   correctly: `[a, dup-b, c]` → ends `a,b,c`, executed `a,c`).
3. `DUPLICATE_CALL_TEXT` is execution-neutral ("appears earlier in this
   response … consult that call's result") — it no longer claims the
   original "already ran" when that occurrence was itself trimmed
   (over-cap) or stall-skipped.
Mixed-batch terminate semantics unchanged (executed members only); an
all-skip batch never terminates. 4 regression tests (padding 0/1/3, cycle
exemption, interleaved order, notice neutrality incl. the over-cap planBatch
case); the docs/02 batch-shape guard paragraph (Contract 4 — Tool) updated
to match. Suite **1443 pass / 14 skip /
0 fail**. Cycle-2 audit (auditor-c3, gpt-6.1-sol): **CLEAN** — all three
cycle-1 repros independently re-run against the fixed build, no regressions
(loop stopped early on CLEAN, 2 of 3 budgeted cycles).

**Telegram round-4 (src/telegram/driver.ts, src/cli/main.ts, src/telegram/README.md, docs/02-contracts.md C37).** Fixes the two Medium findings from the round-3 audit (coordination dir: `.tre/implement-audit/telegram-round4/`, gitignored): **F1** — the idle-turn success path keeps `activeSteer` attached through `telegramBridge.send()` (typed guidance during the bot reply no longer falls into a detached queue) and detaches in `finally`, draining undrained steer into the driver's deferred buffer for the follow-up turn. **F2** — `withTurn<T>` returns `Promise<T | undefined>`: a reserved-but-unstarted body checks `stopped` after awaiting its predecessor, decrements pendingTurns, releases the mutex, and returns `undefined` without running (one-shot worker path treats it as cancelled, exit 130); `stop()` is now a lifecycle-level cancellation reserved bodies cannot bypass. Tests: explicit F2 barrier test + an end-to-end F1 gated typed-guidance integration test (replacing the former basic idle-reply test); mutation probes pinned both fixes (old code fails exactly at the new assertions). Orchestrator-implemented c0 deviation logged in plan.md (worker-c0 hit its wall-clock cap with a clean tree).

**Batch-shape guards (src/loop/agent-loop.ts, docs/02-contracts.md — the batch-shape guard paragraph under Contract 4 — Tool; cited at the time as "C6", a label docs/02 never carried).** From the Qwen runaway-tool-call audit (`qwen-duplicate-audit.md`, same coord dir): one response carried 163 tool calls (66 copies of one git command) and the loop executed every member concurrently with no ceiling. Added `MAX_BATCH_CALLS = 32` (cap on executed calls per response — extras get in-band error results with `details.notExecuted`, never run), `MAX_PARALLEL_CALLS = 8` (concurrency cap — oversized parallel groups run in ordered chunks), and `planBatch()` — a pure planner collapsing intra-batch EXACT duplicates (same tool + stable-JSON args; first occurrence runs, repeats get `DUPLICATE_CALL_TEXT`; trimming applies AFTER dedup). Every call ID still yields exactly one `tool_execution_end`; cross-turn loop/cycle guards sign the EXECUTED subset only. 4 new tests; 2 existing stall tests updated to distinct args. Suite: 1439 pass / 14 skip / 0 fail.

**Machine config (NOT in repo):** `~/.tre/tre/models.json` — moved `reasoning_effort`/`repeat_penalty` out of the nested `options` (llama.cpp reads them top-level) and set `parallel_tool_calls: false` for both Qwen entries; backup `~/.tre/tre/models.json.bak-qwen-params-20261029-155127`.

**Audit:** the round-4 implement-audit cycles were never completed against the implementation (c1 audited the baseline). An independent auditor cycle (gpt-6.1-sol) was planned against this committed diff with the verdict to be written to `.tre/implement-audit/telegram-round4/audit-c1.md` — it was never written there (no `audit-c1.md` exists; the gitignored coord dir holds `audit-c2.md`…`audit-c5.md`, and the post-implementation audit this paragraph promised actually landed as `audit-c2.md`, titled "cycle 1 (post-implementation)"). **SUPERSEDED:** the audit trail continued as the cycles below (cycle 3 `audit-c4.md` against `3ba24ab`; cycle 5 `audit-c5.md` — CLEAN, workstream closed).

**Audit cycle 3 (auditor gpt-6.1-sol, `audit-c4.md`, against `3ba24ab`): FINDINGS — recommendations only, no bug reproduced anywhere; both implemented in this commit.** **R1** — a batch-shape skip's `tool_execution_end` (a synthetic end whose ID never had a start) fell through the TUI's `withRunningTool` running-item fallback and transiently stamped the skip notice onto a still-running sibling (wrong ✗/✓ and resultText on a live tool line for one render). Fix: `withRunningTool` is now EXACT-MATCH ONLY; the `tool_execution_end` handler appends a finished ghost tool line for an ID it never saw start (notice stays visible, siblings untouched; a duplicate end for a finished ID still updates in place, appends nothing). docs/02's AgentEvent table gained the start/end-pairing contract paragraph (executed calls pair 1:1; the batch-shape skips emit ends without starts; consumers key on the ID and never guess). +2 tests (ghost-end-never-stamps-sibling reproducing the audit probe; duplicate-end-updates-in-place). **R2** — the one-shot F2 exit-130 path (`turnOut === undefined` → worker "failed"/"aborted" → exit 130) had only driver-level coverage; added a main()-level regression test via a new lifecycle seam `deps.telegramDriverHook` (called with the one-shot driver before `start()` and before its body reserves — no production caller, mirroring `sessionHook`): the test holds the turn mutex from the hook, fires a lifecycle stop() while main()'s body is reserved-but-unstarted, and asserts exit 130, zero stream calls, zero bot replies, and the aborted worker entry. Suite **1446 pass / 14 skip / 0 fail**.

**Audit cycle 5 (auditor Qwen3.8-Flash-Next-Q4 — same fresh-full-audit model as c4 — `audit-c5.md`, scoped to the `e6cedc4` diff + its interaction with the workstream): CLEAN** — both recommendations verified correctly implemented; every path probed (exact-match end handling incl. replay/duplicate/quiet-tool sites, the hook seam's call-exactly-once/one-shot-only placement, the R2 test's mutation-resistance reasoning, the docs/02 pairing paragraph vs agent-loop on all skip/abort/unknown-tool paths, gate re-run 1446/0/14, working tree unchanged at e6cedc4). Two informational non-findings (unreachable from real producers, strictly better than pre-fix: a hypothetical ghost end carrying `details.subtasks` would mirror the list without appending a line; an unknown-ID `tool_execution_update` is now a silent no-op). **Workstream CLOSED:** 6c26636 + 8c7b920 + e6cedc4 — cycles 1–5 all resolved, GitHub main = e6cedc4. (Cycle-5 run notes: the auditor's first two launches died with `provider error` mid-audit — a vks-llama server hiccup; the third run (same session, `--resume`) completed. Auditor protocol verified: HEAD unchanged, tree clean, only audit-c5.md created.)

**Date hygiene (this commit):** all mislabelled future dates ("2026-11-02/05/27/28/29" → true dates `10-27`/`10-28`/`10-29`) corrected across `src/`, `test/`, and `docs/` comments — see the note in the 2026-10-28 streak-guard entry.

---

**Same-error streak guard — final form + sequential stall-skip (2026-10-28,
third round).** *(Date-correction note, 2026-10-29: this entry and the
guard/audit comments across `src/` and `test/` were originally misdated
"2026-11-27 / 2026-11-05 / 2026-11-28" — the sessions drifted into future
dates. True dates derived from git: the loop-v2 audit chain (`a2fd742`/
`9d5b061`/`8d4f3ab`) 2026-10-27; the streak-guard rounds (`d35241e` →
`11a5d68`) 2026-10-28. `d35241e`'s commit MESSAGE still carries the bad
"2026-11-27" — history left unwritten; this note is the correction.)* The first `same-error-stall` cut (3 windowed hits, hard stop)
failed its own audit on four counts: the reset branch was unreachable dead
code inside the error-only `if` (successes never reset the streak); a
generic error across independent targets hard-stalled legitimate probing;
the CLI/TUI/prompt claimed "the repeat was not re-executed" when every
guard fires AFTER its triggering call executed; and parallel batches
dispatched everything before any guard spoke. Fixed in three parts,
superseding the 2026-10-28 entry it replaces: **(1)** `tools/pipeline.ts` —
the guard is now a CONSECUTIVE streak: one `{errorText, streak}` record per
tool, deleted by ANY other outcome (success, permission denial, different
error — no per-errorText map, no stale state), and a LADDER: warn in-band
at 3 in a row (real error returned VERBATIM + appended approach-changing
notice, run continues), hard stall at 5 (`guard: "same-error-stall"`,
`repeats` = the true streak, `consecutive: true`; exact byte-identical
repeats still belong to H2). **(2)** `loop/agent-loop.ts` — sequential
batches skip every call AFTER one returns `details.stall` (synthetic
`notExecuted` in-band result recorded with the SYNTHETIC_FILL_DIGEST so the
cycle guard treats skips as exempt fills); parallel batches still run all
(the honest limit: calls are in flight before results exist — documented in
the module header, pinned by a test). `agent_end.evidence.skipped` counts
prevented calls; CLI + TUI banners gained the honest skipped-note and lost
the false "not re-executed" claims (a guard never prevents a dispatched
call; only the sequential skip prevents queued ones). **(3)** the system
prompt's repeated-failure discipline now says the harness stops the run as
stalled — never promises refusal. Tests: 7 streak (warn@3/run-continues,
stall@5, success-reset, different-error-reset, independent-targets-defer,
H2-owns-exact-repeats, permission-resets) + 2 stall-skip (sequential skips
later calls + evidence.skipped; parallel runs all — pinned limit) + TUI
skip-note + prompt honesty; suite **1406 pass / 0 fail / 14 skip
(live-only)**. A follow-up audit found and fixed two bookkeeping defects in
that redesign: **(a)** the warn rung returned before H1's window push, so
warned calls never occupied window slots and stale permission denials
stayed counted (H1 then fired on a call whose real last-8 history held one
denial) — H1 bookkeeping now runs in a dedicated step BEFORE any verdict
return; **(b)** the pre-execution returns (validation failure, blocked
gate, broken hook) skipped the streak reset, so a malformed call between
two identical failures let the streak climb across unrelated work — all
three now break the streak through one `breakSameErrorStreak` helper. The
prompt's "third repeat earns a warning" claim was also scoped (exact
repeats still hard-stop via H2 at 3). Regression tests pin both sequences.
A second audit pass caught two more: **(c)** the `progressTarget` attach
sat at the very end of the executor, so the warn rung (whose result the
loop keeps) returned before it — a hook-rewritten edit path lost its
effective target and F1's unverified-edit scan split counts across the
effective and model paths; the attach moved to step 4b (after result
hooks, before any guard verdict). **(d)** the prompt still promised the
3-in-a-row warning to exact repeats; it now states the warning is for
VARYING-argument streaks and that an identical re-issue can stop with no
warning. Suite **1409 pass / 0 fail / 14 skip (live-only)**. Residuals: parallel
dispatch cannot be guarded pre-execution (inherent to Promise.all); F1
`progressMode` still defaults to `"watch"` — promotion to `nudge` is a
one-line flip backed by `/stats_progress`.

**Slot affinity (`bb19f48`): inert on current servers — annotated, do not
re-arm the flag expecting a pin (2026-10-29).** The commit claimed
llama-server pins a session to a slot by hash of the OpenAI `user` field.
Verified against the live lab box (fork @ upstream `34517d5`, 2026-10-28,
`--parallel 2`): `get_available_slot()` routes `id_slot` → LCP similarity
(`-sps`) → LRU and there is NO top-level `user` parsing anywhere in
tools/server, src, or include (hash-of-`user` routing existed only in old
llama.cpp and was replaced upstream). The wire/dispatcher/main plumbing is
sound (tsc clean, dist built, tests pin the injection) and harmless, but a
no-op on any server that doesn't parse `user`; the flag is intentionally
UNSET on both lab `models.json` entries. What actually keeps the lab cache
warm: server-side `-sps 0.8` + LCP routing (pod logs: `f_sim_best 0.94–0.99`
into one slot; ledgers 94–95% hit). Known residual miss (LCP math, not
eviction): a turn that nearly doubles the prompt scores < 0.80 and routes to
the other slot — a hash pin wouldn't prevent that either. **ACTION, only if
a real pin is ever wanted (multi-writer against one endpoint becomes
routine): fork-patch llama.cpp** — parse the request's top-level `user` in
`server_task`, hash to `id_slot` (the `selected slot by id` path already
works in this build, live-verified), rebuild via the llama-fork-build flow,
then set `slotAffinity: true` on the lab entries. Cost note: a pinned busy
slot DEFERS (head-of-line blocks) rather than evicting.

# Current project status (2026-10-25)

**D34 — D26 compaction CLOSED (2026-10-25).** The carried
open item below is resolved: the lossless fit policy is implemented
(`planCompaction` `{preserveLastUser, shrinkToFit}`; `compactContext`
`strictFit` bound/floor ladder with the real rule-notice measured before a
prompt fold, fold output capped at the headroom over its kept tail,
fold-after-demonstration, `priorityLastUser` transcripts, abort-terminal /
error-preserves-candidate; `compactNow` strict on the auto trigger, legacy
best-effort on manual `/compact`). Suite **1354 pass / 0 fail / 14 skip
(live-only)**; property sweep `scripts/audit-d26-repro.mjs` 168/168 against
the real `compactContext`. Contract + audit repros: docs/06 "D26"; decision
row: PLAN D34. Residual: fit is enforced on the calibrated chars/token
estimate (same tokenizer caveat as the trigger).

**M4 close-out (2026-10-21, `dfefd84`).** The post-remediation
review filed M4 and it is now FIXED: the write/edit branch of
`makeSafetyHooks` runs the same sensitive-path check `read` has (M1
helpers: case-folded patterns, realpath resolution, realpath-vs-realpath-root
ws/sys split) — sys-sensitive → blocked in every mode, ws-sensitive →
prompt in `ask`. A new `.tre`-anchored PATH pattern covers the machine
endpoint catalogs: `~/.tre/models.json` matches, a workspace
`models.json` never does. 8 regression tests (`test/safety-m4.test.ts`),
including the filed extra-root takeover repro and the symlink-into-extra-root
case (the sandbox passes it; only the sensitive check stops it). Bonus
finding pinned: the path sandbox refuses cross-root symlink writes (each
root is realpath-checked independently), so a workspace link INTO an extra
root never reaches the sensitive layer. Guardrail-zone file (safety.ts)
landed via the human `GUARDRAIL_BYPASS=1` path. Residual: same
TOCTOU/indirection caveats as M1 (inherent, documented in AUDIT.md).
Suite **1338 pass / 0 fail / 14 skip** (supersedes the 1330 count below).

**Audit remediation (2026-10-21): every M/L finding in AUDIT.md is FIXED.**
M2 `f59cd83` — both Telegram bridges enforce a chat allowlist at parse time
(shared `parseTelegramPollOutput`/`telegramAllowedChatIds` in
`src/telegram/paths.ts`; fail-closed). M1 `299ce1a` — the sensitive-path
gate closes all three verified bypasses: `read` classifies the
realpath-resolved target, pattern tests case-fold (macOS FS), bash tokens
are quote-stripped, and the ws/sys split compares realpath-vs-realpath (a
workspace under a symlinked path still PROMPTS — the macOS `/var` tmpdir
case). M3 `f398df9` — new `src/config/secret-mode.ts` hardens every known
secret file to 0600 at startup with a stderr warning (live machine: 3 files
tightened); price-cache write 0644→0600. L1–L4 — `read` stats before
materializing (64 MB cap + FIFO/socket/device refusal), listings cap at
2000 entries naming the total, truncation temp files 0600 + 7-day prune,
`env`/`printenv` out of `READONLY_VERBS` (`bash printenv` no longer passes
`no` mode). L5/L6 — pipeline `toolTimeoutMs` seam (default 30s for file
tools; bash/subtask/MCP exempt), pattern list gains `telegram.json`,
`tokenomics.json`, `.bashrc`/`.zshrc`/`.profile`. 29 new regression tests
pin the audit's own repros (suite 1330/0/14); the M1/L4 repros were
re-verified against built `dist/`. Guardrail-zone commits (safety.ts) used
the human-directed `GUARDRAIL_BYPASS=1` path. Residuals documented in
AUDIT.md per finding (TOCTOU swap, abandoned-write, agent can no longer
write its own bot-token config — intended).

**Open-items session (2026-10-21): model-prices v2 + docs-truth pass.**
`3dcf842` — the OpenRouter price cache goes **v2**: `ModelPrice` gains
optional `cacheRead`/`cacheWrite`/`cacheWrite1h` (6-decimal precision — real
cache-read rates go to $0.005/M; 2-decimal display rounding would destroy
them) and `overrides` long-context tiers (`minPromptTokens`, sorted
ascending; unsorted input handled, invalid optionals dropped with the base
price kept). `PriceCache` is `v: 1 | 2` — v1 files stay READABLE (no cache
rates), so a version bump never strands an offline host. The consumer loop
is closed end-to-end: tokenomics' `resolve_price`/`pick_tier`/
`cache_read_rate` already consume these fields. +8 tests; suite 1294/0/14.
Also this session: `90ef262` corrected stale H3/H4 status claims (docs/08
header + the HANDOFF docs/07 summary now record H3 as shipped with D33 and
H4 as formally not adopted); the PLAN D32 row's stale "Designed, NOT yet
implemented" tail and docs/08 §7's stale F1 entry were corrected to point
at the shipped state; the two stray `models.json*.bak` files were deleted;
the telegram-waiting delegation plan was stamped DONE (its fix shipped —
`src/telegram/paths.ts` resolves the helper across both skill roots).
Tokenomics L8 (container ran as root) was VERIFIED and FIXED: the image
now runs as uid 65534, the ledger volume was chowned, redeployed and
verified live (see `tokenomics/AUDIT.md`).

**F1 follow-up audit fixes.** Effective execution paths now travel from the
pipeline via `details.progressTarget` after safety-hook rewriting, fixing
relative/absolute alias counters when `--cwd` differs from process cwd. A3
checks the outstanding map each tool turn, so a simultaneous B detection
cannot lose a deferred A3 hit on a later read-only turn (an executed bash
still cancels it). Regression tests cover both, plus actual length-guard
and unknown-tool results replayed into the TUI: neither falsely recovers A3.
THIRD-PASS FIX: the real bash tool's spawn failures (the spawn `catch` and
a child `error` before the `spawn` event) now carry `details.notExecuted` —
a shell that never started is not a measurement, so it neither resets A3
nor recovers a fired episode. This is the reviewed guardrail-zone exception
(additive metadata only in bash.ts; sandbox behavior untouched), noted in
docs/08 §9. Regression tests: bash-kill.test.ts (spawn failure marked; a
running-but-failing command unmarked) and agent-loop.test.ts (loop + TUI
probes with the real bash tool). FOURTH-PASS FIX: the H1/H2 stall-result
replacements dropped `notExecuted` (the third identical bash spawn failure
arrived at the TUI as a plain stall notice and falsely recovered A3).
Both replacements now carry the marker through and their notices say
"WAS executed"/"was NOT executed" per the fact. Regression: agent-loop.test.ts
real-executor probe (3 spawn failures through makeToolExecutor + TUI
replay). FIFTH-PASS HYGIENE: stallText(tool, executed) is parameterized
(the notExecuted variant was a fragile string splice over its own prefix),
the H1 replacement got its regression test (marker preserved + honest
wording; the executed-denial test now also asserts NO marker), and docs/08
§9 "Scope & invariants" was amended to record the reviewed pipeline.ts and
bash.ts exceptions the audit passes actually shipped (it previously said
"nothing in pipeline.ts" / "no bash.ts" — self-contradictory vs the notes).
SIXTH-PASS FIX: an afterToolCall replacement that DROPS `details` could
still erase `notExecuted` (the documented redaction shape turned a real
bash spawn failure into apparent ground contact — false A3 reset / false
TUI recovery). The pipeline now captures the execution fact before the
hook and restores it after; the AfterToolCall type documents it as
authoritative. Regressions: tools.test.ts (hook dropping details) +
agent-loop.test.ts (real bash + redaction hook, loop AND TUI sides).
Verification: `npm test` (quality gate + tsc + full suite), 1305 total,
1291 passed, 0 failed, 14 skipped; `git diff --check` clean.

**F1 progress detection — IMPLEMENTED (2026-10-20, D32; docs/08 §9).**
The act–measure–act guards: variant **B** (`no-success` — 3 consecutive
turns whose whole batch failed; reset on any success or steer) and variant
**A3** (`no-verification` — 4 `write`/`edit`s of the same normalized path
with no EXECUTED `bash` between; a failing test IS the measurement; a
gate-blocked call never ran and neither counts nor resets — EVERY
never-executed path now tags `details.notExecuted`: the pipeline's
validation rejection + two gate paths, the loop's `failInband`, the
loop/length-guard fills, and not-found tools).
Turn-level state machine at the end of the batch body in `agent-loop.ts`
(every guard path continues/breaks first, so synthetic results never feed
it; an executed bash LATER in the same batch cancels a threshold crossed
earlier in it). One ladder per kind, one ANNOUNCEMENT per episode: the
`progress_nudge` event fires in EVERY mode (the observation channel);
`progressMode` (default **`"watch"`** — event only, nothing else) decides
the effect; `"nudge"` injects a context-only message; `"stop"` stops on
recurrence with the new resumable `stopReason: "progress"` (exit 3) +
`progress` on `agent_end`. `maxProgressNudges` default 1, 0 = hard stop
(the H5 convention). Telemetry: TUI per-kind fired/recovered — the
COUNTERS are per-RUN per kind (at most one fired + one recovered per run)
(`/stats_progress`, resets on restart like every tally — the data the
default flip needs); the plain CLI prints fires only in nudge/stop modes;
both render the progress stop as an explanatory line. Nothing persisted;
I3 untouched; no guardrail-zone files. docs/02: the StopReason value, the
event row, the `agent_end.progress` field, the F1 contract bullet.
AUDITED + FIXED (2026-10-20): four findings — stale same-batch A3
detection stopped runs despite a measurement; validation rejections and
loop/length-guard fills lacked `notExecuted` (false ground contact, incl.
a TUI false recovery); telemetry counted episodes instead of runs.
Regression tests pin all four: +5 tests (loop 4, TUI 1), 1 TUI test
rewritten (it had pinned the episode-counting behavior), 1 tools test
extended. Suite 1295 / 0 / 14. Next: run daily, flip
variant B's default to `nudge` when `/stats_progress` earns it (one-line
commit with the telemetry in the message).

**H3 loop visibility — IMPLEMENTED (2026-10-20, D33; docs/08 §10).**
Guard stops (`loop`/`stall`) now name their trigger instead of discarding
it. One `GuardEvidence` union (`identical-batch` → signature/repeats/
guardRetries spent; `permission-stall` & `repeat-failure` → tool/count/
window/errorExcerpt, excerpt one line capped at 2000) with three homes:
`agent_end.evidence?` (pipeline feeds the stall variants via additive
`details.stallEvidence`; `details.stall` untouched), a driver-written
session `guardStop` entry (replay-ignored like `modelChange`, never a
compaction anchor, `SESSION_FORMAT_VERSION` stays 1 — verified two-way
compatible), and the TUI/CLI stop lines appending a clamped one-line
`guardEvidenceNote` (static strings remain the no-evidence fallback; H2
repeat-failure stalls get their own wording, not the sandbox-wall text).
Rulings honored: persist, error text included, no H4 (commits stay at the
current threshold). docs/02 gained the `agent_end.evidence` row + the D33
section. +18 tests (loop 5, pipeline 3, session 3, TUI 3, CLI 4); suite
1253 / 0 / 14. Next: D32 (F1 progress detection, docs/08 §9) implements
the same way.

**H3 loop visibility — designed earlier today (2026-10-20, D33; docs commit
`4359bb0`, superseded by the implementation above — see docs/08 §10 for the
design and its rulings, incl. H4's non-adoption).**

**F1 progress detection — design record (designed 2026-10-20, D32;
implemented 2026-10-20 in `ecd893e`, watch default; this section restated
by the 2026-10-21 truth pass `4174829`).** The shipped state is docs/08 §9
+ the D32 rows in PLAN. The paragraph below is the DESIGN RECORD as written
at design time (2026-10-20) — kept verbatim; where it says "designed / NOT
yet implemented", read it as history. (The IMPLEMENTED status, the
follow-up audit fixes, and the suite counts are the section above — this
entry exists once, not twice.)
`docs/08-loop-hardening.md` gains §9: the design pass on the last logged
loop-hardening item. Unifying principle **act–measure–act** (thrashing that
never repeats byte-identically / never hits a permission wall / never produces
same-error churn is missed by C26/H1/H2 — only the budget catches it, late).
Rulings (user, 2026-10-20): **(1)** split — **variant B** (zero-success
turns: 3 consecutive turns whose whole batch is `isError`; reset on any success
or steer), then **variant A3** (same-target `write`/`edit` 4× with no executed
`bash` in between; verification = ANY bash call that ran — a failing `npm test`
counts as the measurement; the A2 pattern-list rejected as fragile). Landing
order + commit slicing are decided at implementation time — the spec binds the
posture, not the sequence. **(2)**
one ladder: context-only nudge, then recurrence → new `stopReason "progress"`
(distinct value; H5 auto-retry stays scoped to the identical-batch guard);
`maxProgressNudges` default 1. **(3)** rollout **measure-only**: `progressMode`
default `"watch"` (event fires, nothing else), promote to `nudge` then `stop`
via a one-line default flip backed by `/stats_progress` telemetry (fires /
recovered / rate per kind, the F2 pattern). Future-improvement log recorded in
§9 (autonomy is the direction: raise the nudge budget, name the real check
command, auto-run the verification, per-project thresholds via tre.json).
Scope: `agent-loop.ts` turn-level state, no guardrail-zone files, nothing
persisted, I3 untouched, no new CLI flags at landing. PLAN decision log gains
the D32 row; docs/02 will gain the contract rows WITH the implementation
(they describe shipped behavior, not the plan). Docs-only increment — no code
or test change; gate unchanged (1235 / 0 / 14).


---

**Archive.** Entries through 2026-10-19 (MCP tier-1/2 landing log, D28, releases,
the WS10-era history) live in `HANDOFF-archive.md` — closed history, appended
nothing since the 2026-10-23 split. This file keeps the current-status block;
older entries move there at split time.
