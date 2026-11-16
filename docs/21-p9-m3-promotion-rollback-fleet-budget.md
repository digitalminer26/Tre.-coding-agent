# P9/M3 — Promotion/rollback & fleet budget layer (contract draft)

Status: **DRAFT v46 — contract-first scoping. NOT YET APPROVED, NOT
IMPLEMENTED; no module in `src/` is touched by this doc.** (v46 is the
five-finding hygiene fold from the post-D4A final audit, 2026-11-17:
(1) the V37 OWNER DECISION RECORD's 3A shorthand is now QUALIFIED at
its source (no operator revival COMMAND vs automatic current-read
reclassification, v39 AUDV1-M1 / test_F24gen — the same qualification
the D4A-c3-1 fold placed at ~2647); (2) test_F25v33_* gained
write-side arms (partial_write {0,1,4} produce the exact crash
prefixes; arm (c) drives the full settlement route) —
mutation-verified, suite still 92 OK; (3) the D4A round-count claims
are corrected 8 -> 9 findings (fold tables 2+1+1+2+3; cycle-5 lists
three rows under an intro saying two — note in docs/21a); (4) every
recorded hash is now algorithm-LABELED: the da7f7f0 21b "sha256"
prefixes were SHA-1 transcriptions (true SHA-256 added), and the 21a
post-fold "docs/21 4847b3205b63…" pin matches no committed state
under either algorithm (transcription failure; commit ids
supersede); (5) the F23/F25 rows' [PINNED: annotations are closed
with `]`. v45 folds the CLOSE of the Decision-4 prose round
(scope A; 5 cycles, 9 findings — full record in docs/21a; corrected
from "8" — the round's own totals miscounted cycle 5, see the
COUNT CORRECTION note in docs/21a) and its
cycle-5 pin fold: +3 mutation-checked tests (test_F23v33_* /
test_F25v33_*, suite 92 OK), fixture-coverage mapping corrected in
both module headers, rows F23/F25 annotated with pin lineage; ONE
owner decision POOLED from the round (D4A-c4-1, rotation
workstream — flagged, non-blocking). v44 folds
the owner's FOURTH-TRANCHE replies (2026-11-16, record at foot): D1,
D3, D7, D8 SIGNED AS DRAFTED; D2 and D4 SIGNED via option 0 of the
depth-review tables (= as drafted); D9 replied "refuse" —
CLOSED-PENDING-CONFIRMATION as confirming the drafted refuse
behavior (interpretation flagged in §4 D9, correction invited);
DC-2 acknowledged-gap block RATIFIED AS WRITTEN (status folded in
docs/21a; Q-J2-h deferral now owner's own recorded position); 3A
final review format ACCEPTED (evidence-first crosswalk, one owner
reading, cycles only on drift) — 3A itself still UNCONFIRMED until
that reading lands — ARTIFACT BUILT 2026-11-16 as docs/21b (suite
pinned 92 OK + 6-sentence crosswalk, 0 CODE drift; the owner's
ratification reading is the only step left); Decision 4 prose round scoped to A (reference-
impl behavior prose only) with owner-approved sequencing — round
itself RUN AND CLOSED 2026-11-16 at its 5-cycle cap — 9 findings (corrected 2026-11-17 from "8": the cycle-5 fold table lists 3 findings — D4A-c5-1/2/3 — while its intro line and the round totals said 2/4; per-cycle 2+1+1+2+3=9; full classification and note in docs/21a), record in docs/21a (D4A-c1-1 … D4A-c5-3); its cycle-5 fold added 3 mutation-checked pins (test_F23v33_* / test_F25v33_*, suite now 92 OK) and corrected the fixture-coverage mapping in both module headers; ONE owner decision remains POOLED from the round (D4A-c4-1: does S-J2-R rotation get its own implementation workstream; is the reference impl's journal-full refusal the ratified interim behavior?) — flagged, non-blocking; Part-5 backlog items unchanged ("review later").
With this tranche, §4 reads: D1–D8 CLOSED, D9 CLOSED-PENDING-
CONFIRMATION, D5/D6 CLOSED (v43). v43 folds
the owner's D5/D6 sign-offs (2026-11-16, THIRD TRANCHE record at
foot): D5 = strict fail-closed DEFAULT + a scope-bound operator-
acknowledgment waiver drafted into §2.2 (shape ratified, details NOT
yet audited); D6 = SOFT cap SIGNED AS DRAFTED (§2.4) with a human-side
provider-account hard-limit ACTION ITEM outside this repo; §4 entries
and two §5.2 rows updated. v42 folds
the INLINE-AUDIT of the R4 changes themselves (targeted pass, 3
findings): F19's pistol race proved nothing about serialization and
used the wrong geometry — REWRITTEN around a new under-lock
`_test_hook_after_reserve` seam that FORCES both serial orders
(role-swapped, offset-tagged frames show WHO wrote WHERE) with the
row's cap−24 crossing geometry and poll-guarded child pipes (no hang,
exit codes asserted); the R4-c3 disposition's "zero new findings / no
normative gap" over-claim is corrected to "none FILED; absence NOT
established". R5 is a fresh 5-cycle gpt-6.1-terra round over these
changes with mandatory CODE-vs-SPEC classification; SPEC findings pool
for one owner batch fix after the code changes land. R5-c1 then filed
5 findings (3 TEST major / 2 DOC minor, 0 CODE, 0 SPEC), all fixed:
the forced-order fixture now proves CONTENTION via the new
`_test_hook_lock_miss` seam (the rival's own "I was refused the lock"
signal — a non-exclusive lock trips the guard instead of passing), a
PER-FRAME-LENGTH BOUNDARY geometry (cap−24-seed geometry where the
frame allows, deeper seeds for the deep-F pairs where lead >= 8
demands it — AUD45-c6-2; 56
lead/trail pairs over a frame-length set CLOSED under both roles —
for EVERY framed length F the fixture appends (as lead or trail,
including case (a)'s 32-B and case (b)'s 12-B frames), one pair
with remaining space R == F EXACTLY that must FIT and one with
R == F−1 that must REFUSE, in both lead roles; lead lengths
max(24−F+d, 8) all lie in the set, so the claim is closed per
R5-c5 f1 — any constant delta or size shift in the predicate
mis-verdicts some pair; extended per R5-c2 f1 + R5-c3 f1 + R5-c4
f1 + R5-c5 f1) plus DIRECT
instrumentation — every refusal reports the
predicate's OWN (size, framed) from the rejection detail, so a
guessed/stale size fails even when the verdict matches; the
raised detail reuses the comparison's own locals, so
reported-vs-compared divergence is impossible by construction
(R5-c4 f1). Bounded evidence for these sizes/roles/orders: the
loser's reserve check is SHOWN to observe the winner's bytes AT
THOSE BOUNDARIES — not proven against every conceivable
implementation (R5-c4 f1) — and every cap refusal leaves the
pending sidecar's STATE unchanged with no durability window
(content and position; a byte-identical re-write of the same
settled marker would not be distinguished — observed outcomes,
not event history, per R5-c4 f2); this
header's earlier stronger phrasings referred to those newly-added
proofs.) (v41 folds
the INLINE-AUDIT round R4 (3 cycles, gpt-6.1-terra) over the v40
state — R4-c1 rewrote the two mis-firing race fixtures F3 (in-window
seam `_test_hook_after_lc_read`) and F19 (real two-process
start-pistol contention). v40 folded
the ROUND-3 adversarial audit of the v39 state (combined contract+code
round, 3 cycles) PLUS a post-round INLINE AUDIT of the R3 changes
themselves (gpt-6.1-terra reviewer mode) whose findings R3-c4-1..4
shut the residual mint-path freshness gap (under-lock collision check,
fail-closed refusal; conforming ULID — pins F55/F56): R3-c1 pins the
F7 generation-clause vacuity fix and the F24gen generation-binding
test; cycle-2 findings R3-2-1 (δ2
"permanently" over-claim vs generation binding), R3-2-2 (settlement
write return unchecked — CODE, fixed + pinned F18z/F18z2), R3-2-3
(framing "crash mid-loop ⇒ unsettled-tail" unconditional claim —
corrected to the F25 three-case enumeration); cycle-3 findings
R3-c3-1 (authId freshness not writer-enforced — authorize now mints
fresh ULIDs, caller-chosen ids test-only + collision-refused, pinned
F53) and R3-c3-2 (unreadable consumption log escaped as raw OSError —
classify fails CLOSED to `unknown`, pinned F54); dispositions in the
ROUND 3 footer table. Prior: v39 label correction, cycle-2 audit
R2-m1: the footer records this as the V39 prose fold; the header
lagged at v37.) v2 revises
v1 against a full-severity self-audit (2 blockers + 5 majors + 1
minor — the v1 gate-target inversion, the unsafe `git revert` worktree
claim, and the fleet-accounting/file-state/admission races; full
dispositions at the foot). v3 folds the ROUND-2 adversarial review of
v2 (2 blockers + 4 majors + 1 minor, each verified against `src/` and
reproduced against the lab git before acceptance — dispositions at the
foot): v2's `agent/**` promotion source describes a branch NO producer
can create; the literal CAS command follows a symbolic `main` and
advances the OTHER branch (reproduced on git 2.54); the per-episode
refusal + "disclosed lower bound" admitted other episodes against
unknown spend; both overshoot formulas withdrawn; discovery moves to an
operator-declared root registry; checked-out `main` becomes a refusal.
v4 folds the confirming-round audit (1 blocker + 4 majors + 1 minor,
dispositions at the foot): the CURRENT episode's root must itself be
registered (`fleet-root-unregistered` otherwise — closing the
unregistered-custom-root hole round-2 left open); discovery enumerates
episode DIRECTORIES with a new-vs-missing ledger distinction
(marker-absent = zero term, marker-present-but-unreadable =
`fleet-indeterminate`; the marker heuristic is SUPERSEDED in v5 —
finding B1); `projectFleet`/`fleetSummary` take
discriminated per-episode inputs (no more raw record arrays that
conflate unreadable with empty); `M == E` is an `already-merged` no-op
(`commit-tree` drops duplicate parents — reproduced on git 2.54);
idempotent reservation redelivery is coverage with zero second estimate
(P8's C2-F10 posture, mirrored). v5 folds the SECOND confirming-round
audit (2 blockers + 4 majors + 1 minor, each verified against `src/`
before acceptance — dispositions at the foot): the v4 layout-marker
heuristic misclassified every legitimate first admission (the host
creates the layout BEFORE any ledger exists — `supervise.ts:2781`) and
fleet discovery MUTATED other episodes' ledgers (`BudgetLedger.open`
runs `repairTail`, which truncates+fsyncs — `ledger.ts:1581,1674`); v5
replaces both with an explicit durable ledger-initialization protocol
and a genuinely read-only discovery API (`BudgetLedger.inspect` — no
write path, torn-tail tolerance as a pure predicate equal to `open()`'s
result set); per-root DISCOVERY RESULTS join the projection inputs
(`RootDiscovery[]` — a failed enumeration can no longer masquerade as
an empty one); redelivery coverage requires the FULL P8 identity match
(action+amounts+receiptDigest, `ledger.ts:2198-2203`) and is
observation-only; the journal dedup/recovery precedence is pinned
BEFORE the `M == E` shortcut (an open tail intent outranks the
equal-tips no-op — P12's cycle-4 F1 rule, which v4 copied while its
status table contradicted it: sticky `already-executed` vs
`already-merged` for the same replay). v6 folds CYCLE 1 of the
confirming-round audit of v5 (4 blockers + 7 majors + 4 minors —
dispositions at the foot): the v5 in-file header init broke the
UNCHANGED owner reader (a header is not a `LedgerRecord` —
`validateLedgerRecord`, `ledger.ts:354-365` — so every initialized
ledger failed its own `open()`), and could not distinguish
never-initialized from deleted-with-spend; v6 moves the evidence to
an atomically-published SIDECAR marker (`events/budget-init.json`,
write-fsync-rename-fsync) with a full crash/recovery table and an
explicit operator adoption path for legacy episodes — the ledger
format stays byte-unchanged. The v5 `worktree list --porcelain -z`
grammar was wrong (real git emits `branch <value>\0` — attribute and
value SPACE-separated, records ended by an empty field; reproduced on
git 2.54 with byte dumps) — v6 pins the true grammar and parse. The
inspect↔open equivalence claim is scoped to pure byte-classification
(read-vs-open repair I/O has no read-only counterpart) and an
observed cut/ambiguous EOF tail is now Σ-INDETERMINATE for the
consult (an omitted tail may be a live append — smaller-Σ certainty
requires a settled tail). Recovery paths read main + journal only
(a moved episode branch must not strand its own open intent);
`recovered` outcomes are terminal `merged` records for rollback
provenance; rollback verifies the promotion is an ANCESTOR of current
main; the root/episode
correspondence is closed-form set equality with exactly one
documented exception (the current episode). v7 folds CYCLE 2 of the
confirming-round audit of v6 (2 blockers + 6 majors + 3 minors —
dispositions at the foot): coverage gained the missing DIRECTION
(every episode in a complete root's enumeration must appear as
exactly one input) and the exception became representable
(`CurrentEpisode` in both signatures); the marker/ledger crash window
closed by DURABLE ORDERING (complete-ledger fsynced before the marker
is linked — no self-heal fiction survives, and no permanent freeze:
zero-byte ledger = proof of zero spend); repeat rollback is lifecycle
(journal-keyed, `refused(already-executed)`) not tree algebra — after
a reintroduce the spent actionId can never roll back
independently-gated new work; the recovery-path rule named the
execution paths (fresh / no-effect replay — the TWO fresh-execution
paths; sticky-terminal is a non-executing answer, not a third path —
v9, cycle-4 minor 1: v8's header still enumerated "three" here while
§1.1 correctly said two, corrected to match §1.1);
whitespace-EOF is UNSETTLED (never `blank-suffix`) and ANY
population `unterminated-cut`/`ambiguous` makes the WHOLE consult
indeterminate (determinacy beats freshness). v8 folds CYCLE 3 of the
confirming-round audit of v7 (3 blockers + 5 majors + 3 minors —
dispositions at the foot): the ledger's DIRECTORY ENTRY is fsynced
before any marker link (a file fsync persists content, not an entry —
the deletion-detection proof needed hardening); adoption evidence
gains a PREFIX DIGEST (`adoptedSha256`) verified on every consult
(first-record + length cannot stop a same-first-record rewrite that
omits later spend); coverage rule (vi) REQUIRES exactly one input
matching `current` (complete-empty enumeration + `[]` is a refusal,
never a zero-Σ admit); `initEpisode` classification is marker-FIRST
(a valid marker over an absent ledger refuses — init never mints a
zero ledger over a deletion) while publication stays ledger-first;
action identity separates logical (`actionId`, pins/seq excluded)
from execution (`actionId#r<n>`, durably allocated); rollback gains
an explicit precedence table (own-record recovery → promotion
lifecycle → provenance/ancestor → no-op) so a crash window or a
rewind can neither re-land a landed inverse nor mask the sticky
`already-executed`; the §3 release bar is reconciled line-for-line
with the v7 body rules; and `O_EXCL`/fsync/link failure paths get a
convergent state machine. v9 folds CYCLE 4 of the confirming-round
audit of v8 (3 blockers + 7 majors + 4 minors — dispositions at the
foot): EVERY marker publisher (EEXIST loser, valid-marker retry,
adoption) now establishes the FULL fsync chain itself — durability is
per-publisher, never inherited; a rewind's recovery proves landing by
TIP IDENTITY (`main == M`) instead of the revert descendant test
(which is vacuously true pre-CAS and would ack a rollback that never
ran), and open rollback intents are indexed by PROMOTION actionId so
a second identity can never race the first; `executionSeq` is demoted
to an optional expectation — the `r` suffix is journal-allocated with
the intent append as the atomic claim; the §3 provenance pin is split
per-mode (the v8 BOTH-modes ancestor pin contradicted §1.2); the
discovery summary's marker-absent/ledger-present row now splits by
ledger bytes like the crash table; the failure machine distinguishes
the marker link's EXPECTED `EEXIST` from fatal errors and no longer
promises an impossible "no classification change"; adoption inherits
the whole durability ordering, not just the link. v10 folds CYCLE 5
of the confirming-round audit of v9 (3 blockers + 5 majors + 4 minors
— dispositions at the foot): the INITIAL-STAT path for an existing
zero-byte ledger gets the full per-publisher fsync chain + pin (v9
spelled the chain only for the creator and the EEXIST loser); the
promotion-scoped claim is an ATOMIC TRANSACTION inside the serialized
writer — 0a/0a′/0b are re-evaluated at intent-append time, closing
the scan-then-append TOCTOU; identity fields are ENUMERATED
explicitly (`{episodeId, promotionActionId, mode}`) with `now`,
per-invocation metadata, and pins excluded — a retry with a fresh
timestamp resolves to the same actionId; the `r` CLAIM is appended
BEFORE candidate construction so the trailer-bearing commit can only
carry the claimed suffix (crash after claim before intent ⇒ burned
`r`, step-0 dedup ignores claims); EVERY publisher/retry/adoption
fsyncs the episode dir regardless of who created `events/`; the
trailer's promotion-reference seq is separated from the act's own
execution seq (initial rule: first execution is `r1`, never
default-0); the rewind ABA residue is disclosed at FULL strength
(recovery can record a false-attribution terminal that permanently
spends the rollback lifecycle) with a pinned operator remedy
(`--revoke-rollback-recovery <rollbackActionId>#<r>` — target refined
in v11, cycle-6 major 3, to the ROLLBACK execution's `actionId#r`,
module-never-
automatic) and a byte-for-byte §3 scenario pin; the §3 dropped-
promotion fixture is qualified (no prior rollback/open intent — 0a/
0b answer first) and the provenance matrix is STRUCTURAL-only (the
lifecycle condition answers `already-executed`, not a matrix cell);
plus minor reconciliations (classification ORDER: presence
classification precedes `inspect()`; zero-byte stream determinates
vacuously; `adopt-all` misses classify by the §2.3 table, not
blanket `ledger-without-init`; the stale "executionSeq bumped"
wording is gone).
v11 folds CYCLE 6 of the confirming-round audit of v10 (2 blockers +
5 majors + 7 minors — dispositions at the foot): unconverted claims
are liveness-guarded by an `ownerEpoch` fence generation (a LIVE
paused competitor refuses; a CRASHED owner's claim is stale-by-
epoch and never strands the lifecycle — no death inference from
intent-absence); the claim transaction is an explicit journal
primitive `withClaimLock(scanAndAppend)` — the fence excludes
another OWNER, not concurrent async calls inside one owner, so the
plain read-then-append path is ILLEGAL for claims; the two new
record kinds (`promotion-claim`, `recovered-revoked`) get full
schemas against the shipped CLOSED journal union (a docs/11 Change
Ledger row gates implementation); the revoke act is fully specified
(target = the ROLLBACK execution's own `actionId#r`, a journal
PROJECTION under which a valid revocation supersedes its recovered
terminal in 0a AND 0b/0a′, FIVE distinct refusal codes for invalid
targets (v12 adds revoke-target-not-rollback; v13 cycle-8 minor 5
splits non-outcome into its own `revoke-target-not-outcome`),
idempotence-by-refusal); the §1.2 provenance checklist now
compares the candidate trailer's `seq` against the terminal
promotion execution's `r` (and the "not a security boundary" note
is scoped to forgeability, not comparison); the claim point is
precise — AFTER the `M == E` refs-only no-op (which stays journal-
write-free), CONFLICT and empty-difference no-ops BURN their claim
(the "before any journal write" wording corrected accordingly); plus
minor reconciliations (the header's cycle-5 major count corrected
to 5; two residual "if `events/` is new" fsync conditionals removed
per the v10 uniform rule; discovery's marker-valid/ledger-ABSENT
decided by PRESENCE, never `inspect()`; the link-crash fixture
states the post-link dir-fsync edge; §3 gains the pins C5 claimed
but never pinned — omitted/mismatched expectation, unequal suffixes
— plus the epoch, withClaimLock, conflict-burns-claim, and revoke
refusal pins).
v12 folds CYCLE 7 of the confirming-round audit of v11 (4 blockers +
6 majors + 4 minors — dispositions at the foot): the claim EPOCH has
a specified SUPPLIER — stamped from the P7 writer-lease file at
acquisition, monotone from the journal max, re-validated on every
fenced append, quiesce-before-release, with the forced-steal window
disclosed in §5.2; a same-actionId unconverted claim BLOCKS within
its own epoch (a duplicate live call is `refused(intent-open)`, a
crash-reissue only under a NEW epoch — v11's always-ignore rule
explicitly licensed two concurrent same-mode requests); every
pre-intent return path appends a THIRD record kind
(`promotion-claim-abandoned`) converting its claim (abandon-window
stranding disclosed); the ambiguous-append non-reuse promise is
reconciled with torn-truncation (the reopen scan is authoritative;
re-allocating a truncated torn `r` is proven-safe recovery, the
non-reuse covers SURVIVING records; reopen is wrapper-owned, never
act-local); the revoke target must resolve to an intent of ROLLBACK
shape (a recovered plain PROMOTION is `refused(revoke-target-not-
rollback)`, fifth refusal class, §3 negative fixture); record-ID
DISCIPLINE replaces the v11 conflation — `@claim`/`@abandon`/`#i<n>`/
`#o<n>`/`revoke-<ulid>`, execution identity is a construct, the M3
writer fails closed on duplicate ids at append and a duplicate-
id journal makes every claim-bearing act refuse
(`journal-unreadable:duplicate-ids` — per-act scope; fleet
admission unaffected, ledger ≠ journal); `withClaimLock` gets a TYPED
ClaimOutcome union over a bound inline writer (no requeue deadlock)
and the wrapper owns the queue and the poison-reopen barrier;
conversion is by EXACT `(actionId, r)`; the §1.2 provenance
checklist gains a named PRE-GATE PASS ON R (construction bug ⇒
`failed(post-construction-checklist)`, no gate, no CAS); steps 0–3
are ONE ordered algorithm (snapshot → no-op → claim → construct →
intent; refs never re-read after the claim — CAS proves the
snapshot) and §5.2 consolidates every disclosed residual into an
honesty LEDGER. v13 folds CYCLE 8 of the confirming-round audit of
v12 (2 blockers + 5 majors + 6 minors — dispositions at the foot):
the forced-lease-steal residual is stated at its TRUE strength —
v12's claim that journal-level append atomicity survives a
mid-append steal is RETRACTED (multi-syscall appends, per-instance
serialization, `journal.ts:631-636`), replaced by an integrity
QUARANTINE (validate-only open after takeover; mid-file
malformation ⇒ `journal-corrupted`, every claim-bearing act
refuses, remedy is restore/manual repair with the journal kept as
evidence); release's quiesce barrier no longer waits on the writer
QUEUE (queued appends only — construction and gate run outside the
callback) but on an ACT-LIFETIME REGISTRY (register at admission,
decrement at terminal; close → await → token-conditional remove);
the lease is a NEW file `events/writer-lease.json` with an explicit
schema and `O_EXCL`-link publish (the shipped lease body carries no
epoch and its release has no write fence), epoch reuse is narrowed
to what is provable (atomic publish ⇒ no two live owners share an
epoch; a repeat implies zero journalled records ⇒ proven harmless),
and EVERY named writer (claim/abandon/intent/outcome/recovery/
revoke) validates token+epoch before its inline append with a
`fence-lost` terminal (no retry, no further append, no CAS); the
originating-operation recovery is pinned — the caller's OWN
complete claim line found by its reopen scan is ADOPTED at the
same `n` (v12's "retry allocates n+1" collided with the
same-epoch blocker, leaving two live claims of one act); the
abandon append gains its own failure contract (resolve-by-exact-id
`@abandon`, one idempotent retry on torn truncation,
`failed(abandon-ambiguous)` on fence loss — never a silent return
of the original result while the abandon is unestablished); the
pre-gate checklist pass on R is pinned as a PRE-INTENT return
(claim abandoned `pre-intent-error`; the abandon record is the
ONLY journal write — no intent, no outcome, no terminal);
conversion's complete set is intent-OR-abandon (exact identity,
mutually exclusive — v12's intent-only "iff" contradicted its own
abandonment transition); the non-outcome revoke target gets its
own code `revoke-target-not-outcome` (five conditions, five
distinct codes — one code shared by two conditions cannot pin
separately); journal defects are per-ACT refusals, never fleet
admission denial (ledger ≠ journal); §5.2's cap row no longer
states a numeric overshoot it disclaims; and the trailer-field
census is split honestly (four trailer fields + the separate
commit-parent structural check + exec-actionId mismatch = six
sub-pins).
v14 folds CYCLE 9 of the confirming-round audit of v13 (3 blockers +
5 majors + 7 minors — dispositions at the foot): the epoch is
re-validated AFTER publication — a successful no-replace link
publishes an ALREADY-COMPUTED body, so a delayed publisher could
inherit a journal-visible epoch (A claims at 8, releases, B's
delayed link lands owning 8); the acquirer now RE-SCANS the floor
after a successful link and re-stages via an owner-only rename when
the floor has moved (bounded second check, `epoch-contention`),
restoring "no journal-visible epoch is ever inherited"; takeover
quiescence no longer rests on the shipped settle-time (that hold is
`leaseSwapHoldMs`, default 0, and the shipped comment says it is not
scheduler-independent) — the contract requires a PROVEN quiescence
condition (old-pid ESRCH or operator confirmation) before any tail
repair or normal-mode admission, with `journal-quiescing` refusals
until then; validate-only is NEW work — shipped `open()` ALWAYS
repairs its tail — so `DecisionJournal.inspect()` is specified as a
non-mutating API (patterned on P8's `BudgetLedger.inspect`) that
PRESERVES a torn tail as evidence; the writer-lease is no longer an
independent orphan file with no crash story but a DERIVATIVE of the
shipped host lease (host-lease-first acquisition, token equality so
per-append validation transitively proves host ownership, `EEXIST`
resolved by the proven sole holder via rename, full crash/boundary
table); the act registry gets implementable semantics (one object in
the journal wrapper, synchronous check-and-register atomic on the
event loop, admission validates the lease token BEFORE registering,
deregistration exactly once in a finally-equivalent covering
returned/refused/failed/thrown alike); fence-loss precedence on the
abandon path is resolved (pre-attempt fence loss ⇒ `failed(fence-
lost)`; uncertainty discovered after an abandon attempt is OUTSTANDING
⇒ `failed(abandon-ambiguous)` — the operator-material fact is the
unestablished abandon); the non-outcome revoke fixture is made
REACHABLE by a second CLI target form (full record id, e.g. `A#i1`,
refused `revoke-target-not-outcome` — the forms are labeled T1/T2
because F1/F2/F3 already names the step-0 fresh-execution paths
— v15 cycle-10 major 4 REVISED that binding: the request names no
second execution, so T2's execution context IS the named record's
own `(actionId, r)`, `revoke-<ulid>` ids are excluded as usage
errors, and the multi-condition CHECK ORDER is pinned); conversion mutual exclusion is
checked in BOTH directions (the intent append now also refuses when
an `@abandon` exists for the execution); a closed code census lists
EVERY `refused`/`failed` reason incl. the new `lease-unavailable`,
`journal-quiescing` with their CLI rendering; and §5.2 gains the
registry-blocked-release and stale-pid rows. v15 folds the CYCLE-10
adversarial audit of v14 (3 blockers + 5 majors + 4 minors — all
verified against `src/host/supervise.ts` and `src/episode/journal.ts`
before acceptance; dispositions at the foot): the takeover carries a
PERSISTED UNQUIESCED-PREDECESSOR LEDGER (`events/quarantine.json`,
inherited across crash-rejoining successors, entries cleared only on
proven quiescence) so a successor's crash cannot erase a still-live
ancestor from the quiescence proof; the "proven sole holder" language
is REVISED to the shipped lease's actual guarantee — a deployment-
chosen TIME BOUND with a documented check→act TOCTOU
(`supervise.ts:2259-2272, 2335-2342`) — with the degradation posted
as an §5.2 residual row rather than an assumed exclusion; the act
registry keys INVOCATION entries (not logical action identity) so a
refused same-action loser cannot empty the live-set under a live
winner; the takeover's lock-lifetime claim is corrected (the shipped
reclaim releases its lock before returning — M3 takeover is a new
orchestrating act re-verifying its lease at every mutation, never
holding a reclaim lock across an operator wait); the epoch floor is
derived ONLY from a FRESH post-quiescence post-`open()` read (the
step-3 inspect is never reused; late-record and late-malformed
routing pinned); step 2 publishes a `phase: "pending"` body
(`epoch: 0` reserved) with per-failure token-conditional cleanup and
the bump crash table pinned; the phase→code map is made EXACT; the
revoke T2 grammar contradiction is resolved (mutually exclusive
`--exec`/`--target-id`, `revoke-<ulid>` a usage error, the record's
own `(actionId, r)` as execution context, multi-condition CHECK
ORDER pinned: existence → kind → shape → state → marker); and the
closed census is RECONCILED with every live emit path (adding
`lifecycle-blocked`, `not-replayable`, revoke-class `fence-lost`,
`journal-unreadable:duplicate-ids` as refused result, exit codes
per result STATUS). v16 folds the CYCLE-11 adversarial audit of v15
(2 blockers + 8 majors + 6 minors — all verified against
`src/host/supervise.ts` and `src/episode/journal.ts` before
acceptance; dispositions at the foot): the ledger's IDENTITY CAPTURE
becomes an operational UNION rule (old ledger ∪ observed host-lease
body — pre-read, since the shipped reclaim exposes no post-removal
observation (corrected in v17) — ∪
observed writer-lease body) so a pre-ledger crash cannot erase a
still-live ancestor; ledger publication becomes crash-atomic
(tmp→fsync→rename→dir-fsync, in-place rewrite forbidden) and
READ-MERGE-PUBLISH with a fail-closed malformed-file posture and the
merge-loss residual disclosed in §5.2; the exclusivity paragraph is
CORRECTED from "worst case torn-tail" to the full restore-class
lattice (mid-file interleaved corruption included) and the
NO-TWO-LIVE-OWNERS / epoch-inheritance assertions are qualified to
conforming operation; re-verification now precedes EVERY publication
including step 2's renames (with the check→rename residual stated
honestly); the clearing state machine is ASSIGNED (per-acquisition
ESRCH pass, atomic empty-set publication that does not wedge
admission, confirmation by recorded hostToken); BOTH late-malformed
rejection points (step-5 `open()` and step-6 `read()`) route to the
evidence-preserving refusal; takeover gets a CLOSED result union and
ONE cleanup contract; the claim schema requires `ownerEpoch >= 1`
(sentinel 0 unambiguous, rejection-not-migration); the exact
phase→code map is scoped to the owning wrapper with an honest
external precedence (steps 3/4b collapse conservatively); plus minor
reconciliations (three stale "under the shipped lock" sites,
exact-id resolve defined as a lease-free read, the usage-vs-refused
payload discriminator at exit 2, `chainFrom` defined with ulid
validation, one revoke grammar (positional = `--exec` sugar), the
"bounded by PID space" claim withdrawn); §3 gains pins P7–P12.
v17 folds the CYCLE-12 adversarial audit of v16 (1 blocker + 6
majors + 5 minors — all verified against `src/host/supervise.ts`
and `src/episode/journal.ts` before acceptance; dispositions at
the foot): `chainFrom` becomes a FRESHLY MINTED CHAIN-EVENT ULID
(the shipped owner token `${pid}.${random}.${time}` is NOT a ulid
— v16's definition failed its own validator on the first real
takeover), with mint/copy/retain-on-empty rules; the displaced-
host re-confirmation loses its UNOBSERVABLE SUPPLIER (the shipped
reclaim returns only its own handle) — capture is pre-read-only,
the post-reclaim lease read detects third-party swaps via the NEW
`lease-swapped-post-reclaim` reason, publishing-before-abort is
itself guarded; the P8 merge pin is CORRECTED to the SNAPSHOT
BOUND the read-merge-publish protocol actually delivers (v16's
`{A,B,C}` claim is false — survivor is `{A,B}` or `{A,C}`; the
LOST-B fixture asserts recovery via the next takeover's union
capture, and the §5.2 residual is restated); CLEARING
PUBLICATIONS are guarded like every other mutation and compose
removal over their own read (P8b pin; the stale-rename
resurrection of a just-confirmed-away entry is disclosed as the
same snapshot-loss class); the ABSENT-LEDGER POSTURE IS STATED
ONCE (absent = empty set; malformed = fail-closed quiescing;
operator deletion ≡ fresh absence = the disclosed
chain-severance residual — the v16 text contradicted itself
between the precedence list and §5.2); the external precedence
NEVER answers "admitted" — it is a conservative DISK OBSERVATION
with absence classified (`free` / `lease-unavailable`) and no
status field is ever act authority; the closed `TakeoverResult`
union absorbs the swap reason with dual-union census closure,
unknown predecessors get an in-schema representation
(`{pid:0, hostToken:"unknown-<ulid>"}` — confirmation-cleared,
never ESRCH-clearable), and takeover-scope duplicate ids route to
their OWN union reason (v16 misrouted them to an act result);
minors: empty-set `chainFrom` retention defined, the stale
"inspect under the shipped lock" site corrected (inspect runs
under the HOST LEASE, after the handle returns), shipped `open()`
does NOT create the journal (the first append does — citation
corrected), the exact-id resolve is a lease-free re-READ (no
`status` argument is defined for it), and P12's "exit-code-2
pair" wording fixed (`failed` exits 1; the PAYLOAD discriminates).
v18 folds the CYCLE-13 adversarial audit of v17 (0 blockers + 6
majors + 4 minors — all verified against `src/host/supervise.ts`
and `src/episode/journal.ts` before acceptance; dispositions at
the foot; the audit AGAIN self-declared incomplete, so C13 also
does NOT count as a confirming round): the LOST-B RECOVERY is
no longer unconditional — it holds only while the predecessor's
writer body survives, and the racing-joint-erasure case (ledger
AND writer body overwritten by publishers that never saw the
predecessor, inside the check→rename windows) is stated as the
FULL ERASURE CLASS the double-reclaim residual permits, with
real exclusion protocol named as the only closure (P8 fixture
made barrier-controlled; §5.2 row rewritten); the malformed-
WRITER body gets its own precedence clause (`journal-corrupted`
before any token comparison) closing the last unclassified
status triple — P10 now walks the full 40-triple matrix
asserting exactly-one governing clause per triple; the swap
abort's DETECTION POINT is pinned (immediately post-reclaim,
before any step-2 publication) with REASON PRECEDENCE (an
observed swap outranks a later guard failure — exactly one
reason per abort) and OWNERSHIP-CONDITIONAL cleanup (the swap
reason releases nothing — shipped `releaseOursClaim` returns
`absent` on non-ownership, `supervise.ts:1955-1990`); P8b's
survival guarantee is scoped to first-read→second-read
additions, the second-read→rename loss/resurrection window is
DISCLOSED, and the resurrection fixture now INJECTS the
material ordering with barriers (asserting the window occurs,
not passing vacuously) plus a competing-confirmations fixture;
the OPERATOR RECOVERY SURFACE becomes executable spec
(`--operator-status` prints every entry incl. unknown tokens;
`--confirm-quiesced --entry-token` APPENDS a durable
confirmation RECORD to `events/quiesce-confirmations.json` —
NEVER a direct ledger edit — which the lease-guarded clearing
pass consumes as proven-gone evidence in its next guarded
publish, so confirmation works WHILE the 4b holder is live
(the only case it exists for) with no second ledger publisher;
`--repair-quiescence-ledger --from` validates, copies a
parseable `chainFrom` verbatim or writes literal `null` —
never invents an ulid; authorization = file permissions,
"they sign" replaced; new pin P13 drives the full
unknown-entry loop); the census's "both planes" claim is
corrected to ONLY `journal-corrupted` dual-plane (`journal-
quiescing` is act/status-only — failed quiescence is never
terminal — closure fixture asserts its ABSENCE from the
takeover union); minors: the snapshot bound quantified over
each publisher's own snapshot ∪ own-additions, the false
"never resurrect" lead-in WITHDRAWN, the `null` repair state
pinned, and the pin-P12 vs P12-module naming collision given an
explicit disambiguation note. v19 folds the CYCLE-14 adversarial
audit of v18 (0 blockers + 6 majors + 6 minors — C14 REACHED EOF
(4,570 lines read) but SELF-DECLARED INCOMPLETE again: no
section-by-section supporting-doc sweep, no independent 40-row
enumeration, so C14 does NOT count as a confirming round; all
findings verified before acceptance; dispositions at the foot):
the v19 folds are — (M1) the header, the C13-M5 disposition, and
P8b RECONCILED to the durable separate-file confirmation design
(the superseded direct-removal text corrected; the resurrection
fixture now drives TWO REAL GUARDED CLEARING PUBLICATIONS with
barriers and a re-confirmation convergence step, plus a separate
confirmation-FILE race fixture asserting the lost-append is
fail-safe); (M2+M3) the external-status prose precedence is
replaced by ONE ORDERED DECISION TABLE R1–R10 with the absence
cases INSIDE the order and an ENUMERATED 40-CELL MATRIX that
the P10 fixture asserts cell-by-cell (not "exactly one
governing clause"), the malformed-writer rule restated as
applying only after the ledger rules have not matched, and the
uncomparable-token (host absent) case classified explicitly;
(M4) the REPAIR-VS-LIVE-PUBLISHER RACER is bounded: a pass that
reads malformed fails closed and publishes nothing, a staged
rename of a valid pre-repair snapshot is the EXISTING
second-read→rename window (not a new hazard), every publish
re-merges over its second read, a mandatory post-repair
status/repair loop is pinned with a fixture asserting both race
outcomes are sound and entries never leave the ledger except by
ESRCH-proof or token-confirmation; (M5) swap-abort cleanup is
executed against the OWNERSHIP OBSERVED AT CLEANUP (regained
ownership releases, non-ownership no-ops, reason frozen,
`cleanup: released|absent|failed:<detail>` reported separately,
check→unlink non-atomicity named as the shipped residual);
(M6) the erasure disclosure and the cycle-11 DAMAGE LATTICE are
RECONCILED: identity-proof failure and journal damage are
separate — a demoted-but-erased B's late appends remain bounded
by the fence-lost/torn/restore-class lattice, which IS the
damage bound, stated once in §1.1 and cross-linked in §5.2;
minors: the N-PUBLISHER snapshot bound restated as the full
writer's bound (final publication = own snapshot ∪ own
additions; earlier additions absent from the final snapshot can
be lost; pairwise intersection demoted to corollary), the
"they sign"/"operator-signed minimal ledger" phrasing fully
WITHDRAWN (file-permission-gated; §5.2 row too), the dangling
"see the writer-lease lifecycle below" splice replaced by the
actual serialization statement, the pin-counter note fixed to
P1…P13, the OPERATOR RESULT PLANE given its own payload
(`{plane:"operator", op, ok, ...}` — operator `refused` never
joins the three act families), and `--operator-status` given
its malformed/unreadable-input behavior (raw bytes + parse
error, exit 0). v20 folds the CYCLE-15 adversarial audit of v19
(1 blocker + 3 majors + 3 minors — C15 again SELF-DECLARED
INCOMPLETE (tool-output truncation on the wide disposition pages
and parts of the doc-11/doc-12/HANDOFF sweep; G3 matrix
enumeration and G6 code-citation checks complete; verdict
CHANGES REQUESTED — does NOT count as a confirming round; all
findings verified before acceptance; dispositions at the foot):
(B1) CONFIRMATION CONSUMPTION IS DURABLE — consumed records are
marked `consumedAt` IN THE CONFIRMATION FILE BEFORE the guarded
ledger rename (identity = `(hostToken, confirmedAt)`; merges
never drop/rewrite except the mark; mark-then-rename crashes are
conservative; a consumed record NEVER re-clears, including after
a resurrection or restart — P8b's re-confirmation now requires a
NEW confirmation identity); (M1) the repair-stomp bound is
restated honestly: a stale clearing rename DESTROYS unobserved
repair content wholesale (the snapshot-loss class, not
"resurrect-or-re-add"); convergence is the DUAL loop — operator
`--force` re-apply (executable, terminating, pinned by fixture)
OR the next takeover's union re-capture of the live owner; no
state hides a live holder from BOTH status and takeover; (M2)
the matrix prints the present-host FOREIGN row (v19 footnoted it
while P10 asserted it) and the cell arithmetic is corrected to
40 NOMINAL / 36 OBSERVATIONAL with the absent-host match/foreign
collapse stated as asserted equality; (M3) the unreadable
swap-cleanup fragment is rewritten as THREE separate artifacts
(ledger publication / writer body / racing residue) with the
regained-branch publish the only source of our content; minors:
the exit-code rule's "P12 convention" attribution corrected to
an M3-defined convention at all three sites (docs/16 defines no
CLI exit rule — full sweep), the erasure→R4-`free` connective
made explicit (`free` is a disk observation, never quiescence
proof), and the clearing pass's EVIDENCE SNAPSHOT pinned to the
SECOND read (confirmations evaluated at rename-time re-read;
post-second-read arrivals missed by that publish, converged by
the poll loop, same disclosed window). v21 folds the CYCLE-16
adversarial audit of v20 (2 blockers + 1 major + 1 minor — C16
SELF-DECLARED INCOMPLETE again (G1–G6 gate not satisfied: the
EOF chunked page read, the per-document sweep, the independent
40-case enumeration, the full interleaving set and the full
splice sweep were not completed; the findings produced are
concrete and were verified before acceptance; verdict CHANGES
REQUESTED — does NOT count as a confirming round; dispositions
at the foot): (B1+B2) CONFIRMATION CONSUMPTION RECONCILED TO A
TWO-FILE ACTIVE/CONSUMED MODEL — the operator-written
confirmation file NEVER carries marks (v20's in-file
`consumedAt` is SUPERSEDED: unserialized operator merges staged
over pre-mark snapshots can restore a consumed record to
active — the exact C16 blocker-1 resurrection), the
lease-holding pass alone writes the append-only
`events/quiesce-consumptions.json` (single writer under lease
⇒ marks are never lost), a record is ACTIVE iff its
`(hostToken, confirmedAt)` identity is absent from the
consumed set, and a removal via confirmation consumes ALL
records naming the token (v21 cycle-16 blocker 2 — a second
pre-existing record must never survive to re-clear a
resurrection; new P8b two-confirmations fixture); (M1) the
repair re-apply termination is restated as CONDITIONAL on
epoch finiteness — no termination claim under a continuing
takeover loop, escalation = operator stops the churn then
re-applies; minors: `--operator-status` now prints BOTH
confirmation files annotated active/consumed (diagnosing WHY
an entry will not clear). v22 folds the CYCLE-17 adversarial
audit of v21 (2 blockers + 2 majors + 1 minor — C17 again
SELF-DECLARED INCOMPLETE (its own NOTES: G0/G1 failed on a
nonconforming reread protocol + uncertified chunk inspection,
G3 independent enumeration not completed, G4/G5/G6 partial;
verdict CHANGES REQUESTED — does NOT count as a confirming
round; all findings verified before acceptance; dispositions
at the foot): (B1+B2) CONFIRMATION + CONSUMPTION REBUILT AS
TWO APPEND-ONLY O_APPEND LOGS WITH BYTE-OFFSET WATERMARKS —
v21's replaced-file consumed set died to an epoch-displaced
stale writer's rename (C17-B2) and its snapshot-exclusion left
post-snapshot pre-removal records ACTIVE against the claimed
re-confirmation property (C17-B1); an O_APPEND log can only
ADD facts (no rename ⇒ marks unlosable across the disclosed
double-reclaim window), and the watermark (read AFTER the
final guard, appended BEFORE the ledger rename — v22 phrasing;
v24 REORDERS to: L re-read → watermark append → epoch-check
guard as the LAST operation → rename, cycle-19 blocker 1) consumes EVERY
record naming the token below it, leaving only the disclosed
shipped guard→rename window (`supervise.ts:1976-1988` parity)
where a surviving record is a true disappearance assertion for
an exact dead token (wrong-token inertness ⇒ it can never
match a new process); (M1) `--repair-confirmations` /
`--repair-consumptions` DEFINED (v21 invoked a repair doctrine
with NO verb) — each repair RAISES watermarks monotonically,
so re-activating consumed evidence by deleting marks is
structurally impossible; (M2) confirmation identity is the
CLI-generated `confirmId` (fresh ULID) — NEVER the timestamp
(clock repeat/regress made confirmations indistinguishable);
minor: status gains the third `unknown` annotation when the
consumption log is uncomputable. v23 folds the CYCLE-18
adversarial audit of v22 (2 blockers + 3 majors + 1 minor —
C18 also SELF-DECLARED NON-CONFIRMING (G1 non-EOF page read,
G2/G3 incomplete, G4–G6 partial; dispositions at the foot):
(B2) CONSUMPTION-LOG TAIL ASYMMETRY — a torn trailing line of
the CONFIRMATION log is ignored (losing a confirmation is
fail-safe), but an unsettled trailing line of the CONSUMPTION
log renders the consumption authority UNCOMPUTABLE (a partial
live watermark append is indistinguishable from a torn tail;
ignoring it silently un-consumes a just-consumed
confirmation — a re-clear path); (M1) GENERATIONS — the
confirmation log carries a `confirmGen` header (new at
creation AND every repair) and watermark lines carry the
generation their L was read from; ACTIVE compares only
same-generation offsets, so a repair cannot strand a fresh
post-repair confirmation behind an old-generation byte
watermark; (B1) consumption-log repair runs UNDER LEASE
ACQUISITION — the lease-swap revokes prior epochs, a pass's
guard is its last epoch check before its ledger rename, so
removal and watermark are same-epoch facts and no repair
rename can discard an append whose removal landed (THE FENCE
CLAIM IN THIS PARAGRAPH WAS FALSIFIED BY CYCLE-19 BLOCKER 1 —
SUPERSEDED by the v24 total order below); (M2) the
second-read/watermark rules are disambiguated (second read =
what the pass may USE; L = what it CONSUMES; only a record
after L stays active); (M3) the P8b two-confirmations fixture
barrier is pinned to arrival BEFORE the L read; minor: P13's
"loses its append" means write FAILURE only. v24 folds the
CYCLE-19 adversarial audit of v23 (2 blockers + 2 majors + 1
minor — C19 SELF-DECLARED NON-CONFIRMING (G0/G1: a batched
supporting-document call exceeded the 220-line chunk mandate;
G2/G5 not certified complete; dispositions at the foot):
(B1) THE PAST-GUARD FENCE WAS FALSE — epoch revocation cannot
fail a pass that already performed its guard, so the watermark
ordering is PINNED as a total order: re-read L+gen header →
append the watermark via a FRESH open(O_APPEND)+write+fsync
(no fd held across any pause — a stale-inode append class is
eliminated by construction) → the EPOCH-CHECK GUARD AS THE
LAST OPERATION → the ledger rename → POST-RENAME
SELF-VERIFICATION re-appending the watermark onto the CURRENT
log if a repair replaced it inside the disclosed window
(v26 note: self-verification DEMOTED to backstop in v26 —
see the cycle-21 M1 disposition below; the composition is the
handler)
(max-semantics ⇒ idempotent; the repair owner composes every
readable old line into its replacement); (B2) CONFIRMATION-REPAIR
PUBLICATION ORDERING — the ALL watermark (staged length N, new
generation G2) is made DURABLE in the consumption log BEFORE
the tmp→rename that publishes G2, so no reader ever sees a G2
record without its covering watermark; crash between the two
is harmless and retry-idempotent; (M1) WAITING-HOLDER
SELF-REPAIR — an unsettled consumption tail during 4b is
truncated IN PLACE by the 4b holder under its OWN epoch (the
lease requirement fences writers; a holder already fences),
no deadlock against the lease the loop itself holds
[V39 SUPERSEDED (R2-M2): the in-place truncation is REVOKED —
unsettled tails are SETTLED by one `\n` append per (b-O)(1)+
SETTLEMENT; see the (δ) case correction. Retained as the
record of the v24 deadlock fix's shape.]; (M2)
CROSS-GENERATION HANDOFF pinned for all three pass-vs-
confirmation-repair interleavings (only offsets ≥ N in G2 are
live, decided by the single ALL line durable before G2 is
visible); minor: P10's malformed-ledger attribution corrected
to R1. New fixtures for both inode orderings, crash-consistent
repair, waiting-holder recovery, and the A2 cross-gen handoff.
v25 folds the CYCLE-20 adversarial audit of v24 (1 blocker + 1
major, NO minors — C20 SELF-DECLARED NON-CONFIRMING: G3
enumeration incomplete, G4/G5/G6 partial; dispositions at the
foot): (B1) CRASH AFTER THE LEDGER RENAME COULD LEAVE THE OLD
CONFIRMATION ACTIVE — a repair whose composition snapshot
missed the pass's watermark append, plus a pass killed before
post-rename self-verification, published a CURRENT
consumption log with NO watermark while its removal had
landed (the v24 "self-healing" claim relied on the very
self-verification step that crashed). v25 CLOSES IT BY
ORDERING + MANDATORY COMPOSITION: the repair owner's
replacement line set is built from a re-read of the CURRENT
consumption log STRICTLY AFTER lease acquisition (staging
from a pre-acquisition snapshot is ILLEGAL), the replacement
publish is crash-durable (premise (R): tmp fsync, rename,
file+parent-dir fsync before success), and the pass's
watermark append is fully durable BEFORE its epoch-check
guard — yielding the WATERMARK-LOSS IMPOSSIBILITY THEOREM
(§1.1 (c)): at every repair acquisition the watermark line
is already in the then-current log, so induction over
consecutive repairs makes "removal landed, watermark
NOWHERE readable" UNREACHABLE even if self-verification
never runs; post-rename self-verification is DEMOTED to
redundant defense against implementation drift; a
crash-point invariant table pins every step boundary and new
fixture (i-b) drives the exact C20-B1 schedule through
restart, resurrection, and convergence. (M1) SECOND-READ AND
P8b STILL SAID "POST-GUARD L" — both live references
reconciled to the normative v24 PRE-GUARD total order
(second read = evidence; pre-guard L = consumption), the
race probe RENAMED post-guard-race → guard→rename-race at
all sites (the window is watermark read → ledger rename
with the guard inside), and the historical disposition rows
(C17-B1/C18-M2/C18-M3) carry supersession notes instead of
silently contradicting the operative text.
v26 folds the CYCLE-21 adversarial audit of v25 (1 blocker + 2
majors + 1 minor — C21 again SELF-DECLARED NON-CONFIRMING:
G4/G5/G6 partial though G1/G2/G3 completed cleanly; the THIRD
consecutive non-confirming round; dispositions at the foot):
(B1) THE CONSUMPTION LOG HAD NO CREATION PROTOCOL — the
mandatory watermark step-(2) open lacked `O_CREAT` while
status legitimately prints BOTH logs absent, so a fresh
episode's FIRST confirmation-based removal failed `ENOENT`
and the recovery path had no specified successful execution;
v26 makes `O_CREAT` MANDATORY with (R)-DURABLE CREATION
(v27, cycle-22 finding 4: SUPERSEDED — every append now
fsyncs its parent directory unconditionally; see step (2)) at BOTH appends
(pass step (2) and the confirmation-repair ALL append).
(M1) A2 AND THE REPAIR PARAGRAPH STILL MADE SELF-VERIFICATION
THE LOAD-BEARER (watermark "orphaned on the old inode",
self-verification as "the handler") directly contradicting
the v25 demotion — reconciled: the repair's MANDATORY
POST-ACQUISITION COMPOSITION is the handler in A2 (the
append was durable in the log current at the repair's
acquisition ⇒ its composition SEES and carries it, whether
or not the pass survives to step (5)); self-verification is
the redundant backstop ONLY, and the A2 fixture now asserts
the line is present IN THE CURRENT LOG WITH THE PASS KILLED
BEFORE STEP (5). (M2) THE COMPOSITION PREDICATE WAS UNDEFINED
AT THE SAFETY BOUNDARY — v26 defines the SINGLE NORMATIVE
READABLE PREDICATE (physical `\n`-terminated line + one
shared schema parser + 512 B cap; unsettled trailing bytes
are never READABLE), pins it as ONE definition used
IDENTICALLY by authority computation, self-verification, and
repair composition, PINS THE FUSION HAZARD (an O_APPEND after
an unterminated fragment is durable but NOT READABLE), and
adds the theorem's VERIFICATION PREMISE STEP 2V: after
write+fsync+close the writer FRESH-READS the last 1024 bytes
and tail-scans for its own READABLE line; not-found ⇒ append
FAILED ⇒ removal cycle ABORTED pre-guard (fail-safe wedge),
which is exactly what makes "landed removal ⇒ READABLE
watermark" an established premise rather than an assumption;
new fixture (e) drives the fuse-abort-repair-recover path.
(m1) "the residual window shrinks to the guard→rename step
itself" UNDERSTATED the window — corrected at both live sites
to L-READ→RENAME (a record landing between the pre-guard L
read and the guard is offset ≥ L and ACTIVE), P8b's wider
statement confirmed correct.
(v27, cycle-22 AUDIT FOLD — the post-C22 fused-line correction
above was itself audited and found defective; four findings
folded; NO new audit round was run; the loop remains
UNCONFIRMED): (F1) composition no longer DROPS malformed lines —
no automatic path drops one; only an operator `--repair-
consumptions --force` with a printed diff does, and automatic
paths fail closed; (F2) the authority rule is single: a
malformed terminated line makes the authority `unknown` (the
existing rule), so fixture (e)'s recovery is the operator repair,
NOT a next-pass self-heal; (F3) the crash table is split before
and after 2V and covers the fused and not-yet-dir-fsynced
sub-cases fail-safe; (F4) directory durability is UNCONDITIONAL
on every consumption-log append (file fsync + parent-dir fsync),
so no opener relies on observing a name as durable and `O_CREAT`
need not detect creation.
(v28 AUDIT FOLD — the v27 self-audit findings AUD27-B1, AUD27-M2,
AUD27-M3, AUD27-m4; NOT yet audited by a fresh round): (B1) the
forced repair is now INERT-BY-CONSTRUCTION — any repair dropping
a malformed line appends an ALL line naming the CURRENT
confirmation length, so every confirmation at offset < that length stays inert
regardless of what the dropped line held; the floor check is a
diagnostic only; (M2) the lease deadlock is removed by a lease-free,
digest-bound operator AUTHORIZATION, applied by the waiting holder
or by an acquiring repair; (M3) the crash table distinguishes the
vanished (no wedge — pre-pass state), surviving-readable, and
surviving-fused outcomes for a crash during step (2); (m4) the
v26 footer's revoked recovery clause is marked superseded.
(v29 AUDIT FOLD — cycle-1 audit of v28 by gpt-6.1-terra returned
CHANGES REQUESTED; findings AUD28-B1, AUD28-B2, AUD28-M1..M4, AUD28-m1
folded; NOT yet re-audited): concurrent operator confirmations after
the L_C read are FRESH active assertions, and the inertness invariant
is stated only for offsets < L_C (B1); the forced replacement is
fresh-read verified before publish (B2); the authorization binds the
malformed set, is single-use, has defined framing and torn-tail
rules, and has a stated residual window (M1, M2); the crash table
adds the partial-tail outcome and makes the readable survivor require
ONE new confirmation (M3); the floor check is diagnostic only (M4);
the superseded footer is marked revoked (m1).
(v30 AUDIT FOLD — cycle-2 audit of v29 by gpt-6.1-terra returned CHANGES
REQUESTED; AUD29-B1, AUD29-M1..M4, AUD29-m1..m3 folded; NOT yet
re-audited): the forced repair's composition is the LAST read before
the rename, with an unterminated-tail refusal and displaced-writer
losses argued as never-landed (B1); spending is COMMITTED by the same
rename via an embedded APPLIED line, so no separate record can tear
(M1); the partial-tail outcome restores the original confirmation with
no new confirmation (M4) [V39 SUPERSEDED (R2-B1): the δ outcome is a
NEW confirmation — see the (δ) OUTCOME-CORRECTED paragraph];
the floor check PRINTS a diagnostic and never
refuses (M3); the inertness wording is restated for offsets < L_C and
the superseded v28 summaries are marked (m1-m3).
(v31 AUDIT FOLD — cycle-3 audit of v30 by gpt-6.1-terra returned CHANGES
REQUESTED; AUD30-B1, AUD30-M1, AUD30-M2, AUD30-m1, AUD30-m2 folded; NOT
re-audited (cycle 3 was the last requested cycle)): APPLIED lines are
carried forward by every composition and checked as a superset, so no
repair can erase a spend (B1); the late-append boundary is disclosed as
a residual window, not closed (M1); the authorization file's tail is
settled before any append (M2); the floor-check sentence is repaired
(m1); the historical "same as previous" wording is removed (m2).
(v32 OWNER DECISION — structural change, replacing the read-modify-write
repair with OVERLAY REPAIR after 30 audit rounds failed to converge on
check-then-act semantics; owner picked option D with two riders (deferred
compaction disclosed; overlay rendering conspicuous). AUD30-M1 and the
recurring B1 class ("a later composition erases / omits state") are
CLOSED BY ELIMINATION: no repair path rewrites the consumption log; the
log only grows and effective state is a pure function of its bytes.
NOT audited — requires one focused confirming pass on (b-O)/(c-O) and
the effective-read algorithm before sign-off.)
(v33 RESOLUTION of the focused-audit blockers (AUD32-B1/B2/B3, M1-M4), per the
recommended mutation-model resolution. NOT audited when written.)
(v34 — cycle-1 terra audit of v33 (CHANGES REQUESTED): AUD33-B1 unmasked-malformed repair unreachable; AUD33-B2 unterminated tail silently dropped; AUD33-B3 (not raised) — see V34 DISPOSITIONS; AUD33-M1/M2/M3, m1, m2 folded. NOT re-audited when written.)
(v35 — cycle-2 terra audit of v34 (CHANGES REQUESTED): AUD34-B1 durability, M1 settlement, M2 SPENT predicate, M3 precedence/staging, M4 live rewrite text superseded in place, M5 one AUTH format, m1 fixtures F5/F9, m2 ALL claim. NOT re-audited when written.)
(v37 — owner-decision revision after the owner-approved FOCUSED audit of the v36 delta (CHANGES REQUESTED: AUD36-B1 resolve-on-use not isolated from concurrent appends; AUD36-B2 cap check races a concurrent writer; AUD36-M1 crash mid-recovery indeterminate; AUD36-m1 F13 wording vs the DEAD-REPAIR rule). Owner decisions: 0A local-only storage + startup probe is CONFIRMED; 1A exclusive flock sidecar, 2A bounded resolve rounds, 3A dead-REPAIR disposition are DRAFTED per the agent's recommendation and AWAIT the owner's explicit confirmation (v39 R2-m1: corrected from "applied" — see the V37 OWNER DECISION RECORD; until ratified treat them as proposed). Dispositions in the AUD36 footer table. NOT re-audited when written. [STATUS 2026-11-16: 1A/2A since CONFIRMED, 3A still UNCONFIRMED — see the V37 OWNER DECISION RECORD and the tranche records at the foot.])
D1–D9 go to sign-off only
after two more confirming rounds find no blocker/major
[STATUS 2026-11-16: sign-offs have since been received — §4 and the
OWNER DECISION RECORD tranches at the foot: D1–D8 CLOSED, D9
CLOSED-PENDING-CONFIRMATION ("refuse" interpreted as confirming the
drafted refuse behavior; correction invited).]
(docs/16 precedent: contracts are attacked, not asserted). Parent
schemas: docs/11 (§5 S5 merge-action contract, §10 Q5, §11.4 M3 row,
§14.7 policy), docs/12 (P8 ledger/gate), docs/16 (P12 module), docs/18
§10 and docs/20 §14 (the deferral rows naming this scope "M3").

## 0. Scope

docs/18 §10 and docs/20 §14 defer to M3: **"staging/rollback + fleet
budget layer."** This contract scopes exactly those two slices, which
are independent of each other (A touches the git/ref surface, B the
budget surface; neither imports the other):

- **Slice A — promotion & rollback.** The episode branch is already the
  staging ref (P12 merges tested task candidates onto
  `refs/heads/<episodeBranch>`; "staging" needs no new machinery). What
  M3 adds is the two missing acts: **promotion** (episode branch →
  `main`, Q5-gated) and **rollback** (undo a landed promotion).
- **Slice B — fleet budget layer.** P8 caps are per-episode; the host
  scheduler admits work against ONE episode's `GatePolicy`/snapshot
  (`src/host/sched-gate.ts` filters records by `episodeId`). M3 adds a
  machine-level cap spanning concurrent episodes.

**Explicitly NOT in docs/21 scope** (each with the reason):

| item (docs/11 M3 row) | why not here |
|---|---|
| approved model swaps | **shipped + audited** (docs/18 §4 allowlist, ledger `model-not-approved`; 2026-11-12) |
| worktree release at accepted `done` | **shipped + audited** (P6 leaf gate, audit rounds 5–9 converged) |
| P12 tested integration | **shipped + wired** as the host merge port (`--episode-branch`, `src/host/activate.ts`) |
| richer P13 views | view-plane; the dashboard-class rides M4 |
| fresh-session handoff | needs operating evidence (§11.4 exit evidence: "improvements supported by operating evidence") — no M2 evidence of a handoff class worth automating yet; reopen when episodenomics shows stale-session continuation losses |
| broader decomposition (graph rewrite) | docs/20 §13 scoped graph rewriting OUT of M2 admission; rewrite invalidates pending steer scopes (docs/11 §14.2) — needs its own contract round after A/B |
| optional P3b in-flight steering | L2 ships the `--steer-file` seam; live-file steering stays gated (§11.4: "required before enabling live file steering" — enabling is not scheduled) |

## 1. Slice A — promotion & rollback

### 1.0 Threat model (stated so the audit aims correctly)

The module trusts what P12 trusts and nothing more: the CALLER is the
trusted host process (spawned by the machine's operator), the gate
adapter is trusted, the git object store is trusted. `grantedBy` is
attestation recorded FOR the human-visible record, not a cryptographic
credential — an actor who can already exec the CLI or write the repo
is outside the threat model (same boundary as P12's trusted-gate
port). Verifiability inside the model comes from DURABLE BINDING
(journal record ⇄ commit trailer ⇄ parentage ⇄ gate run), not from
`grantedBy` alone. No claim in this doc depends on `grantedBy` being
honest.

### 1.1 Promotion: `promoteTestedEpisode(req, ports)`

A NEW leaf module (`src/integration/promote.ts`, sibling of `merge.ts`).
Not a generalization of `integrateTestedCandidate`: P12's identity is
"advances episode branches only; the literal `main` is refused" (Q5,
audit C2-F1 case-fold guard) — a module that does both halves dilutes
the strongest-tested guard in the compartment. Shared doctrine is by
copy-with-citation, as P12 did with P11's fence.

**Request (hostile input, fence + frozen snapshot):**

```ts
{ repoRoot: string;            // abs path; validated via `rev-parse --git-dir`
  episodeId: string;           // SAFE_ID
  episodeBranch: string;       // refs/heads/<name>: check-ref-format,
                               // SINGLE path element, OUT of `agent/**`,
                               // not `main` — the promotion SOURCE
                               // guard, v3-corrected to the branches
                               // P12 actually advances (see §1.5, D8)
  expectedEpisodeTip?: string; // optional 40/64-hex pin vs the branch tip
  expectedMainTip?: string;    // optional 40/64-hex pin vs refs/heads/main
  now: number;                 // finite, >= 0 — injected clock
                               // (NON-identity: EXCLUDED from the
                               // actionId hash, v10 cycle-5 blocker 3)
  executionSeq?: number;       // OPTIONAL EXPECTATION, NO DEFAULT
                               // (v10, cycle-5 major 3 — v9's
                               // "default 0; ONLY re-issuance
                               // disambiguator" contradicted
                               // allocation-by-max: omitted ⇒ no
                               // expectation; present ⇒ must EQUAL
                               // the allocated r; it disambiguates
                               // nothing — detects stale re-issues)
  grantedBy: string;           // non-empty attestation (§1.0);
                               // per-invocation, NON-identity
                               // (v10, cycle-5 blocker 3)
}
```

**There is NO target-ref field.** The ref the module can write is the
literal `refs/heads/main`, a compile-time constant; unknown request
fields (`target`, `targetRef`, `branch`, `mode`, …) are fence refusals,
pinned by a fuzz test. (v1's "case-folded target compare" wording was
confusion with P12's C2-F1 guard, which lives here as §1.5's SOURCE
guard instead.)

**Act sequence — candidate-first (v2, fixes the v1 gate inversion):**
v1 gated the EPISODE TIP and then merged — wrong: a clean merge can
combine episode and main changes into a candidate that was never
tested. The promotion advances `main` to a MERGE COMMIT, so the gate
must bind to exactly that commit:

**SINGLE ORDERED PROCEDURE (v12, cycle-7 major 6 — steps 0–3
reference each other in both directions and v11 never stated the
total order a conflict-free implementation must follow; this IS
the algorithm, the numbered steps below are its sections, and an
implementation follows THIS order exactly):**
```
0. Scan journal ONCE under withClaimLock's read half: compute the
   projected lifecycle (dedup/recovery/sticky/revocations/claims
   incl. epoch-blocker + abandonment conversions). ANY answer that
   does not execute (sticky terminal, recovery verdict, refused)
   returns from here — no refs read beyond what the scan needs.
1. SNAPSHOT READS (refs only, one `git` invocation set under the
   same writer lease): M = rev-parse refs/heads/main, E = episode
   tip, symref/worktree guards. Pins checked against THIS
   snapshot only.
1a. M == E ⇒ durable `already-merged` (pre-claim, no journal
   claim write — step-0 answer class), return. (Checked AFTER
   the snapshot because it IS a snapshot fact; "before any claim"
   means no CLAIM record was appended, not no refs read.)
2. CLAIM via withClaimLock(scanAndAppend): allocator re-scan
   inside the lock → r, ownerEpoch stamped from the lease file;
   refused/failed/fence-lost per the ClaimOutcome union (v14,
   cycle-9 minor 1 — v13's two-member enumeration omitted the
   live `fence-lost` member declared below). Held claim now
   excludes same-epoch competitors (both acts).
3. CONSTRUCT (revert/merge-tree per mode) against the SNAPSHOT
   values only — refs are NEVER re-read after the claim: moved
   refs are proven at step 5 by CAS on the recorded old value,
   and re-reading would admit a post-claim move INTO the built
   content (the exact race §1.2's checklist exists to refuse).
   END OF POSITION 3 (rollback): the PRE-GATE CHECKLIST PASS ON
   R (§1.2) runs HERE — a mismatch is a PRE-INTENT return: the
   claim is abandoned with reason `pre-intent-error` (v13,
   cycle-8 major 4 — NO intent, NO outcome, NO journal terminal;
   the abandon record is the ONLY journal write OF THE FAILURE
   PATH beyond the already-landed claim — v14 cycle-9 minor 2
   wording: the act's journal footprint is claim + abandon and
   NOTHING else), no gate, no
   CAS.
4. INTENT append `actionId#i<n>` (converts the claim by exact
   (actionId, r)), gate run on the candidate, then CAS + OUTCOME
   (`actionId#o<n>`) under the §1.1 provability table.
```
Rollback (§1.2) is the SAME skeleton with its mode-specific steps
2c/0a–0d folded into positions 0–3 (0a–0d are step-0 scan
extensions, 0c ancestor-check is a snapshot read in position 1,
construction+pre-gate-checklist is position 3, intent/gate/CAS is
position 4). The numbered steps below retain their detailed
wording; where a step's prose and this ordering disagree, THIS
ordering wins (v12 pins it so audit rounds stop re-deriving it).

0. **Journal dedup & recovery FIRST (v5, audit major 5/6 — the
   docs/16 §2 order ported, BEFORE any ref read or construction):**
   scan the journal for this actionId (the hash over the EXPLICITLY
   ENUMERATED identity fields — v10, cycle-5 blocker 3: NOT "all
   frozen fields except", the identity field list is below, and
   per-invocation metadata (`now`, `grantedBy`) is EXCLUDED with the
   seq/pins; the full identity discipline, immediately below), with
   P12's precedence INCLUDING the cycle-4 F1 tail rule:
   **Identity discipline (v8, cycle-3 major 2; REFINED v9, cycle-4
   majors 5+6; RE-WRITTEN v10, cycle-5 blockers 2+3 + majors 1+3 —
   the v9 text hashed "frozen fields EXCLUDING executionSeq and the
   pins", which silently INCLUDED the injected clock `now` (every
   retry at a different time became a NEW logical action, missing
   its own sticky outcome and open intents — the lifecycle doctrine
   defeated by a clock tick) and made the INTENT APPEND the
   allocation claim, which cannot work: the trailer-bearing
   candidate (step 2) is BUILT BEFORE the intent append (step 3),
   so two acts could build candidates against the same provisional
   suffix; and its scan-then-append pair is not atomic against a
   second identity racing the same promotion):** the LOGICAL action
   identity `actionId` = sha256 over the ENUMERATED identity fields
   — promotion: `{episodeId, episodeBranch}` plus the act-
   discriminator (which act, which promotion for rollback:
   `{episodeId, promotionActionId, mode}`); EXCLUDED as
   non-identity, per-invocation metadata: `now` (injected clock),
   `grantedBy` (attestation of THIS invocation — two operators
   re-issuing the same act hit the SAME logical identity, exactly
   what the sticky lifecycle requires), `executionSeq`, and the
   optional pins. NO other request fields exist (§1.1's fence —
   hostile fields are refused), so the enumeration is complete by
   construction. `executionSeq` is an OPTIONAL EXPECTATION with NO
   DEFAULT (v10, cycle-5 major 3 — the v9/request text still said
   "default 0; ONLY legitimate re-issuance disambiguator", which
   contradicts allocation-by-max: an omitted seq is NOT expectation
   0, it is NO expectation; present ⇒ must EQUAL the allocated `r`,
   else `refused(execution-seq-mismatch)`; it disambiguates nothing
   — it only detects stale re-issues). Allocation is by the CLAIM
   RECORD, not the intent (v10, cycle-5 major 1): before building
   the trailer-bearing candidate the act appends, INSIDE the
   journal's serialized writer, a CLAIM record
   `actionId#r<n>@claim` where `n` = max(suffixes over CLAIMS ∪
   INTENTS) + 1 (empty journal ⇒ max over the empty set = 0 ⇒ first
   execution is `r1` — the rule v9 never stated). **PRECISE CLAIM
   POINT (v11, cycle-6 major 5 — "claim before construction" must
   not silently turn the no-journal-write paths into journal
   writers): the claim is appended AFTER step-0 dedup/recovery and
   AFTER the `M == E` graph-no-op check (a refs-only read —
   `already-merged` remains a NO-JOURNAL-WRITE answer: it never
   reaches the claim), and BEFORE any trailer-bearing construction
   (the C5-M1 invariant). A CONFLICT surfaces only inside
   construction — it therefore BURNS its claim: the §1.1 "abort
   before any journal write" wording is corrected to "before any
   COMMIT, before the gate, before the INTENT/OUTCOME write" (v11
   — the durable claim exists by then and is spent, gap
   disclosed like every crash-burned `r`); rollback's
   pre-construction no-ops (0d empty-difference) and conflict
   paths get the same treatment in §1.2.**
   **CLAIM ABANDONMENT TRANSITION (v12, cycle-7 blocker 3 — a
   burned claim that stays UNCONVERTED with the CURRENT epoch
   blocks every OTHER rollback identity for the whole life of the
   lease: revert claims P, conflicts, returns normally; operator
   asks rewind — different actionId, epoch rule ⇒
   `refused(intent-open)` forever, though no intent ever existed.
   The epoch alone cannot distinguish "paused mid-construction"
   from "returned-done-no-intent", so the act CONVERTS the claim
   explicitly before any pre-intent RETURN: on conflict, on 0d
   empty-difference, on construction failure — i.e. every path
   that returns WITHOUT journaling an intent (gate-failure and
   CAS no-effect are POST-intent paths: there the claim is
   already converted by its intent, no abandon record applies —
   v12 corrects its own first draft here) — the act appends
   (under withClaimLock) a
   `promotion-claim-abandoned` record naming the execution
   `actionId#r<n>` (third new kind — schema in the NEW RECORD
   KINDS block below, §1.1); the
   abandonment CONVERTS the claim for eligibility purposes (an
   abandoned claim is neither unresolved nor blocking — same
   allocator-internal status as a crash-burned one), and a
   same-actionId redelivery sees "claim abandoned, no outcome" ⇒
   fresh act at the next allocation, NOT refused. DISCLOSED
   RESIDUAL (pinned honest): the window between deciding to
   return and the abandon append is a real window — a crash
   inside it leaves an unconverted current-epoch claim, which
   blocks alternative identities until the next fenced
   acquisition makes it epoch-stale; the alternative (never
   blocking unconverted claims) is strictly worse — it would
   permit the live-competitor double-construct v11 fixed, so the
   window is accepted, bounded by lease turnover, and named in
   §5.2's honesty ledger. ABANDON-APPEND FAILURE CONTRACT (v13,
   cycle-8 major 5 — the abandon append itself can fail
   ambiguously like any append): the act's abandon is identified
   by its exact record id `actionId#r<n>@abandon`; on poison the
   wrapper reopen runs, then the scan checks for THAT id —
   survived ⇒ the abandonment is ESTABLISHED, the act returns
   its original result (conflict/empty-difference/etc.) as
   planned; absent AND the fence validates PRE-RETRY
   (token+epoch checked BEFORE the retry is issued) ⇒ retry the
   abandon append EXACTLY ONCE (idempotent by id: the
   duplicate check-before-append means a double-success is
   impossible — second success after a "failed" first is the
   survived case) AND the retry's SUCCESS RETURNS THE ACT'S
   PLANNED ORIGINAL RESULT (v14, cycle-9 minor 3 makes explicit
   what v13 left unstated); absent AND the pre-retry fence check
   FAILS, OR the retry itself fails AMBIGUOUSLY ⇒ the act
   returns `failed(abandon-ambiguous)` —
   PRECEDENCE OVER THE GENERAL `failed(fence-lost)` RULE (v14,
   cycle-9 major 3: the named-writer rule says an abandon writer
   failing lease validation returns `failed(fence-lost)`; that
   general rule governs the FIRST abandon attempt's pre-append
   validation — a fence already lost when the abandon is first
   attempted ⇒ `failed(fence-lost)` with no append issued; but
   once an abandon attempt is OUTSTANDING (its outcome
   uncertain), fence loss discovered during resolution is
   reported as `failed(abandon-ambiguous)` — the operator-
   material fact is the UNESTABLISHED ABANDON, not the fence;
   §3 pins both: pre-attempt fence loss ⇒ `failed(fence-lost)`,
   zero abandon records attempted; post-attempt discovery ⇒
   `failed(abandon-ambiguous)`) —
   an explicit terminal telling the operator the abandonment is
   UNESTABLISHED — NOT necessarily absent (v15, cycle-10 minor
   2: an ambiguous RETRY may itself have LANDED without the act
   learning it; the operator answer is "conversion could not be
   established", and the remedy is the next epoch's exact-id
   resolve — DEFINED OPERATIONALLY (v16, cycle-11 minor 2: the
   RESOLVE OPERATION IS A READ — after the next acquisition (or
   by any reader — resolve needs no lease), re-scan for the
   exact id `actionId#r<n>@abandon` under the §1.2 duplicate
   rules; found ⇒ abandonment ESTABLISHED (claim converted; any
   later act or `status` query reports it so); absent ⇒
   UNESTABLISHED, and per the ledger/clearing rules the claim
   burns its `r` with no second abandon append for that
   execution — a fresh execution allocates a new `r`; NO new
   act kind or CLI verb is minted: resolve is the documented
   scan every act already performs at eligibility, executed
   operator-style as a LEASE-FREE RE-READ of the journal under
   the duplicate rules (v17, cycle-12 minor 4 — this contract
   does NOT define a `status` argument that reports abandon
   resolution; the read-only `status` classification defined in
   §1.1 covers the quiescence state only, and any read-capable
   operator tool may perform the scan), which reports established if
   the late abandon
   survived; v14's "remains unconverted" asserted absence the
   contract cannot know)
   (its stranding behavior is the disclosed residual
   above; no silent success: the act NEVER returns its original
   result while the abandon is unestablished, because that would
   re-open exactly the stranding C7-B3 closed). §3 pins: abandon
   complete-then-failed-resolve ⇒ scan finds the id ⇒ normal
   return, ZERO second abandon records; abandon torn-truncated ⇒
   single retry lands ONE record; fence dropped mid-abandon ⇒
   `failed(abandon-ambiguous)`, zero further appends. Ordering
   vs the C7-B2 same-identity
   rule: an ABANDONED claim no longer triggers `refused(intent-
   open)` for a same-actionId call either (abandonment is the
   act completing; only UN-adopted current-epoch claims block).
   The claim's EXACT conversion set (v13, cycle-8 minor 1 —
   v12 said "converted iff an intent exists" at the eligibility
   paragraph while abandonment also converts; the complete
   definition): a claim `A#r<n>@claim` is CONVERTED iff an
   intent `A#i<n>` exists OR an abandon `A#r<n>@abandon` exists
   (either one, exact execution identity; the two are mutually
   exclusive BY TWO-SIDED VALIDATION — v14, cycle-9 major 5: the
   abandon append checks NO intent `A#i<n>` exists (v13), AND THE
   INTENT APPEND CHECKS NO abandon `A#r<n>@abandon` EXISTS (v14
   — the missing direction: abandon-then-intent for one execution
   after a recovery re-entry would otherwise slip past a
   one-sided check; both checks run inside the serialized writer
   domain, a violated check is the append's `failed(ambiguous)`-
   class refusal of the attempting act — a duplicate-class
   collision at append, §3 pins BOTH orderings:
   intent-then-abandon ⇒ abandon append refused; abandon-then-
   intent ⇒ intent append refused);
   §3 pins: conflict then different-mode request WITHOUT owner
   restart ⇒ proceeds (abandon adopted); crash inside the abandon
   window then same-epoch different-mode request ⇒
   `refused(intent-open)`; after new acquisition ⇒ proceeds
   (stale).** The claim
   APPEND RE-EVALUATES eligibility FIRST (see the claim discipline
   at rollback 0a′ — the same discipline fronts promotion step 0):
   claim-eligible ⇒ append durably (fsync-before-resolve, the P7
   journal's property, `src/episode/journal.ts:602-606`) and THAT
   append is the atomic reservation of `r`; the claim record
   carries an `ownerEpoch` (v11, cycle-6 blocker 1; SUPPLIER AND
   HANDOFF FULLY DEFINED v12, cycle-7 blocker 1 — v11 cited
   `journal.ts:480-486` spawnGen, but spawnGen is a per-SESSION
   spawn generation, NOT an episode-writer lease generation, and
   the shipped journal merely ASSUMES a caller-owned fence
   (`journal.ts:632-636`); an implementer could not derive the
   stale/live distinction from what v11 named). THE EPOCH IS
   SUPPLIED BY THE P7 WRITE LEASE ITSELF, made generation-stamped:
   the host's per-episode writer-lease acquisition (supervise.ts's
   lease act) allocates `ownerEpoch = 1 + max(ownerEpoch over ALL
   records in this episode's journal)` AT ACQUISITION (the
   JOURNAL FLOOR is the monotone quantity — monotone across host
   restarts with lease-state loss; the ACQUIRED epoch is NOT
   claimed monotone: sequential repetition is legal per C8-M2
   below; the v11 shorthand "monotone across restarts" is read
   throughout v14 under this qualifier; the
   acquisition is already an exclusive no-replace link), and
   PASSES the value into every `withClaimLock` call
   that act runs (the epoch is fixed per ACQUISITION, read once —
   it cannot change mid-scan; an act NEVER re-reads it between
   scan and append). **LEASE SCHEMA & PUBLISH (v13, cycle-8 major
   1 — v12 said "lease file" but the SHIPPED lease body is
   `{pid, token, episodeId, claimedAt}` (`supervise.ts:2005`),
   carries NO epoch, and its release interface supplies no write
   fence (`:2739`): the M3 writer-lease is therefore a NEW file,
   `events/writer-lease.json`, schema `{pid, token, episodeId,
   epoch, journalFloor, claimedAt}`, published by the SAME
   no-replace `O_EXCL` link protocol as the budget-init marker
   (write-tmp → fsync → link → dir fsync; `journalFloor =
   max(ownerEpoch over all journal records) `computed at
   acquisition); `epoch = journalFloor + 1` STAGED in the tmp
   body. (v14 CROSS-REFERENCE: the new file exists but is NOT an
   independent lease — its acquisition, `EEXIST`/stale-replace,
   token relationship to the shipped `host.lease`, release order,
   and forced-takeover cascade are governed by the WRITER-LEASE
   LIFECYCLE block below; a crash holding this file is a
   specified state, not an undefined one.) THE
   POST-PUBLICATION RE-SCAN BUMP (v14, cycle-9 blocker
   1 — the link publishes the ALREADY-COMPUTED body and does not
   atomically COMPUTE the floor: A and B both stage epoch 8 over
   floor 7; A links, claims at 8, releases; B's delayed link then
   SUCCEEDS on the removed file and B owns a journal-VISIBLE
   epoch 8 — A's claim is misclassified current and blocks B for
   its whole lease life): immediately after a SUCCESSFUL link the
   acquirer RE-READS the journal floor; if it is `>=` the staged
   epoch, the acquirer REWRITES its own lease body at
   `epoch = 1 + newFloor` via write-tmp → fsync → RENAME over
   own path (RENAME — not link — is the owner-only replace: the
   token is UNCHANGED, only epoch+journalFloor move; NOTE v15,
   cycle-10 blocker 2: the link+reclaim machinery is the SHIPPED
   one, whose exclusion is a deployment-chosen time bound, NOT a
   scheduler-independent proof — see the exclusivity-posture
   paragraph below; the bump inherits exactly that bounded
   residual and no stronger), then re-checks the floor once
   more; a second lag ⇒ acquisition fails `epoch-contention`
   (bounded, defensive). EVERY PUBLICATION, REPLACEMENT, AND
   BUMP RENAME IS FOLLOWED BY A DIRECTORY FSYNC BEFORE THE NEXT
   STEP, AND THE BUMP'S CRASH POINTS ARE SPECIFIED (v15, cycle-10
   major 3): crash after tmp fsync but before rename ⇒ the
   PUBLISHED body is the OLD one (old epoch) and the orphan tmp
   is removed by the next acquirer's stale-tmp sweep; crash after
   rename but before dir fsync ⇒ on recovery EITHER the old body
   or the new body may be visible (no ordering is assumed —
   either is conforming, because both carry the SAME token and
   the floor-derived epoch of the new body is `>=` every journal
   record visible at bump time); admission does not proceed until
   the dir fsync returns. THE INVARIANT the
   bump restores: NO EPOCH VALUE APPEARING IN THE JOURNAL is ever
   inherited by a later owner — every visible epoch belongs to the
   current owner or lies strictly below it — QUALIFIED to the
   shipped bounded exclusivity (v16, cycle-11 major 1): under
   the disclosed double-reclaim residual two processes can both
   hold lease files claiming the same staged epoch during the
   race window, and if the displaced one lands bytes mid-append
   before learning it was displaced, a record at that epoch can
   briefly exist while a same-epoch holder is live — the
   defense-in-depth is per-append token validation plus the
   restore-class posture for corrupted interleavings; under
   CONFORMING (non-racing) operation the invariant is absolute.
   The C8-M2 sequential
   REPEAT survives intact and is re-pinned: A stages 8, journals
   NOTHING, releases; B stages 8, links, re-scan floor is still 7
   ⇒ keeps 8 — legal precisely BECAUSE no record carries 8
   ("monotone across restarts" remains the WRONG shorthand — the
   monotone quantity is the journal floor; acquisition is
   floor-validated); REUSE NARROWED HONESTLY (v13,
   cycle-8 major 2 — "monotone across restarts" as v12 stated it
   is FALSE for an acquirer that writes no claim: epoch 8 taken,
   no claim written, released, next acquisition computes the same
   journal max and also receives 8. The narrowed true promise:
   each lease file's publish is atomic so NO TWO LIVE OWNERS ever
   hold the same epoch simultaneously — QUALIFIED (v16, cycle-11
   major 1): "live owners" means owners under the shipped
   bounded exclusivity; a delayed double-reclaim (the disclosed
   residual) can put TWO processes in possession of the SAME
   staged epoch (both scanned floor 7 before either's record
   landed, and re-scan ordering cannot save the second if its
   re-scan precedes the first's claim append) — the defense is
   then per-append token validation (ONE of the two wins the
   lease file; the loser fails `fence-lost` before appending —
   the residual lattice including its restore-class member is
   pinned above, not re-litigated here), and
   an epoch REPEAT is
   PROVEN HARMLESS — a repeated epoch can only occur when the
   prior owner journalled nothing, so NO record in the journal
   carries the repeated value, so no eligibility decision can
   compare against it and no claim can be misclassified stale/
   live BY THE REPEAT ITSELF; the §3 pin is restated to this
   exact statement: acquire-no-claim-release-reacquire ⇒ same
   epoch legal AND no journal-visible effect). WRITER-LEASE
   LIFECYCLE & THE SHIPPED HOST LEASE (v14, cycle-9 blocker 3 —
   v13 invented `events/writer-lease.json` with no crash story:
   the SHIPPED episode lease is `host.lease` (`supervise.ts:
   1811-1823, 1866-1867`) with its OWN dead-owner reclaim via a
   separate takeover lock + re-verification (`:1833-1850`) that
   does not touch a new file; a crash holding the writer-lease
   leaves `EEXIST` forever ⇒ admission frozen, or every host
   invents its own unlink). RESOLUTION — the writer-lease is NOT
   an independent lease: it is a STAGED VIEW of the shipped host
   lease, acquired DERIVATIVELY: (i) acquisition order is
   host-lease-FIRST (the shipped act, with its shipped reclaim
   machinery unchanged), then the writer-lease tmp+link within
   the same host-lease hold; (ii) `EEXIST` on the writer-lease
   link means the CURRENT host-lease holder did not clean up —
   the acquirer REPLACES the stale writer-lease file by rename
   (the same owner-only replace protocol as the epoch bump:
   only the current host-lease holder may replace it; a link
   racing a non-holder is impossible because host-lease
   exclusivity precedes it — QUALIFIED in v15, cycle-10 blocker
   2: see EXCLUSIVITY POSTURE immediately below, which v14
   overstated as "already proven sole host-lease holder");
   EXCLUSIVITY POSTURE — STATED AT THE SHIPPED STRENGTH (v15,
   cycle-10 blocker 2): the shipped host-lease exclusion is a
   DEPLOYMENT-CHOSEN TIME BOUND, not a scheduler-independent
   proof: `supervise.ts:2338-2346` documents the takeover lock's
   stamp-read→rmdir TOCTOU as "an unavoidable check→act TOCTOU
   without an atomic-compare-delete primitive" and states
   `leaseSwapHoldMs` "is NOT a scheduler-independent bound"
   (`:2259-2272` — a delayed reclaim can pass every read-based
   check, and the shipped comment adds "a read-only fence CANNOT
   exist"). EVERY v14/v15 claim of the form "proven sole holder"
   therefore means: sole holder as far as the shipped bounded
   mechanism can establish — the derivative writer-lease
   inherits the host lease's residual EXACTLY (no stronger, no
   weaker): under a delayed-reclaim double-admission (the
   shipped disclosed residual), two hosts can both believe
   themselves sole holder, and their writer-lease replaces can
   overwrite one another between floor scan and rename. THE
   CONTRACT'S POSTURE on that window (v15): it is the SAME
   residual already disclosed for the forced-steal append race
   (§5.2 row 1) — one shared fence, so the writer-lease adds NO
   new failure mode beyond the host lease's own, and the §3
   delayed-competitor fixture (below) tests BEHAVIOR UNDER the
   race (both claimants stamp; per-append validation lets at
   most the CURRENT lease-file token append — the displaced one
   fails `fence-lost` at its next validation — THE FULL LATTICE
   OF OUTCOMES (v16, cycle-11 major 1 — v15's "worst case is
   the disclosed torn-tail class ... never a silent mid-file
   corruption BY THE FENCE ITSELF" UNDERSTATED the residual and
   is corrected): a displaced holder that was MID multi-syscall
   APPEND when the replacement published can leave INTERLEAVED
   MID-FILE bytes — NOT repairable at open — the RESTORE-CLASS
   outcome (`journal-corrupted`, validate-only, manual
   repair/restore with the journal as evidence), identical in
   kind to the forced-steal row; the torn-EOF class is only the
   MILD member of the lattice; what remains true is that the
   writer-lease adds NO failure mode BEYOND the host lease's
   own disclosed set — the set itself includes restore-class
   corruption, and no-restore-class safety REQUIRES the
   stronger fencing protocol (O_EXCL-chained compare-and-write,
   e.g. link-based epochs under a kernel-atomic create) listed
   as M3-ADJACENT hardening; if the lab requires that class
   eliminated, THAT work — not this doc's language — is where
   it happens); the contract
   does NOT claim the race is closed, only that the fence degrades
   to the disclosed bound. Strengthening the shipped host-lease
   (e.g. O_EXCL-chained fencing) is listed as M3-ADJACENT
   hardening work in HANDOFF, NOT silently assumed by this doc. (iii) TOKEN RELATIONSHIP: the
   writer-lease `token` EQUALS the host-lease token, so the
   per-append validation transitively validates host-lease
   ownership — one fence, two files; (iv) graceful release is
   the act-registry barrier THEN unlink writer-lease THEN the
   shipped host-lease release — crash between the two unlinks is
   cleaned by rule (ii) on next acquisition; (v) FORCED TAKEOVER
   of the host lease (shipped operator act) cascades: the
   successor runs the takeover's quarantine state machine
   (below) BEFORE EPOCH DERIVATION (its step 6), so a corrupted
   journal is never written under a fresh epoch; every M3 act
   refuses `refused(lease-unavailable)` (a NEW code, in §1.4's
   CLI contract) between host-lease acquisition and
   writer-lease derivation — acts never assume the file exists;
   §3 pins: crash-holding-writer-lease ⇒ successor acquires
   host lease ⇒ stale writer-lease replaced by rename ⇒
   quarantine-inspect ⇒ epoch derived from post-bump floor ⇒
   admission proceeds, with competing-successor serialization
   on the shipped takeover lock FOR THE SWAP ONLY (v16, cycle-11
   minor 1 — the lock does NOT cover steps 2-6; see LOCK
   LIFETIME below) and a boundary-crash table
   (crash points: after host link / after writer link / between
   unlinks). QUARANTINE STATE MACHINE ORDERING (v14, cycle-9
   major 2; REWORKED in v15 against cycle-10 blocker 1, majors 1
   and 3, and minor 1): takeover ⇒ (1) shipped host-lease reclaim
   (old owner removed from the shipped lock) ⇒ (2) writer-lease
   replace per rule (ii) in the PENDING PHASE (below) ⇒ (3)
   `inspect()` validate-only ⇒
   (4a) mid-file malformation ⇒ `journal-corrupted`, the episode
   stays refused, the writer-lease file is REMOVED (quarantine
   holds via `journal-corrupted` per-act refusals, not via a
   file) ⇒ (4b) tail-torn-only or clean ⇒ await the QUIESCENCE
   CONDITION (old-pid ESRCH or operator confirmation — the
   settle-time is NOT sufficient) ⇒ (5) normal `open()` (tail
   repair runs here, after quiescence) ⇒ (6) epoch derivation
   FROM A FRESH POST-OPEN READ (below) with the re-scan bump ⇒
   (7) admission opens. PHASE→CODE MAP, EXACT (v15, cycle-10
   minor 1): acts arriving during steps 1-3 refuse
   `refused(lease-unavailable)` (the writer-lease is not yet
   validated for use); during step 4b (awaiting quiescence) they
   refuse `refused(journal-quiescing)`; during steps 5-6 they
   refuse `refused(lease-unavailable)` again (the writer-lease
   exists but carries NO usable epoch until step 6 completes —
   see the PENDING PHASE); step 7 opens admission. The transition at
   each boundary is atomic on the event loop (a phase field in
   the wrapper; no act observes two phases) — SCOPED: the map is
   the promise for calls through the OWNING WRAPPER (v16,
   cycle-11 major 8); the on-disk cross-process precedence for a
   second process (which cannot see the field) is pinned in the
   PENDING PHASE block below. UNQUIESCED-
   PREDECESSOR LEDGER (v15, cycle-10 blocker 1; REWORKED in v16
   against cycle-11 blockers 1-2 and majors 3-4 — replacing the
   lease-body pid is NOT the end of the story: A superseded
   paused inside an append, B replaces the writer body at step 2
   carrying B's pid, B CRASHES before quiescence, C reclaims B
   and checks only B's pid — A can still resume and lands into
   C's repaired journal): the takeover carries an
   UNQUIESCED-PREDECESSOR SET, PERSISTED at
   `events/quarantine.json` (`{predecessors: [{pid, hostToken,
   seenAt}], chainFrom}` — `chainFrom` is a FRESHLY MINTED
   CHAIN-EVENT ULID (v17, cycle-12 blocker 1 — NOT the first
   displaced owner's identity: the shipped owner token is
   `${pid}.${random}.${time}` (`supervise.ts:1866-1868`), NOT a
   ulid, and the contract's own id doctrine MINTS ids rather
   than borrowing foreign formats — same minting pattern as
   `revoke-<ulid>`): created at the takeover that first makes a
   NON-EMPTY set, copied verbatim by every takeover or clearing
   pass that UPDATES a non-empty set, and when the set empties
   the file is published with `predecessors: []` and the OLD
   `chainFrom` RETAINED (forensic record of the chain that
   ended); the next takeover that makes the set NON-EMPTY MINTS
   a NEW chainFrom (a new chain begins). Validation: the field
   is EITHER a parseable ulid OR the literal `null` (the
   never-had-a-chain state of a file created empty by a
   malformed-repair path — see the malformed-ledger block);
   anything else ⇒ the file is malformed (fail-closed, below).
   Its role is operator forensics: a non-empty set with an old
   `chainFrom` tells the operator the chain has been wedged
   since then.)
   IDENTITY CAPTURE — WHAT TO ADD IS DEFINED OPERATIONALLY (v16,
   cycle-11 blockers 1, major 3 — the shipped reclaim handle is
   `{token, path, held, release}` and does NOT report the
   displaced owner (`supervise.ts:2713-2727, 2738-2739`), and a
   crash BETWEEN host reclaim and ledger publication loses even
   the "owner it displaced" if that phrase is read narrowly):
   the takeover's ledger is the UNION, never a replacement:
   `newSet = oldLedger ∪ {observedHostOwner} ∪ {observedWriter}`
   where `observedHostOwner` is the identity read from
   `host.lease` (its `{pid, token}` body) IMMEDIATELY BEFORE the
   reclaim call, with NO post-reclaim re-confirmation CLAIMED AS
   PROVABLE (v17, cycle-12 major 1 — the shipped reclaim checks
   the stale body internally under its lock, moves the lease
   aside, deletes the moved copy on successful admission, and
   returns only `{token, path, held, release}`
   (`supervise.ts:2713-2727, 2738-2739, 2070-2330`): a caller
   CANNOT observe WHICH intermediate body was removed; v16's
   "re-confirmed against what the reclaim actually removed"
   named an unobservable supplier and is WITHDRAWN). The
   HONEST capture is pre-read-only: `observedHostOwner` is the
   pre-read body, believed unless contradicted — and the
   contradiction channel that DOES exist is the writer body
   (below) plus the post-reclaim lease-body read (after the
   reclaim returns, the file contains OUR body or a successor's
   — a token that is neither ours nor the pre-read is an
   observed swap by a third party, which aborts per the cleanup
   contract AFTER publishing the pre-read variant into the
   ledger; the reason is a NEW union member
   `lease-swapped-post-reclaim`, added to the closed
   `TakeoverResult` reasons in v17. DETECTION POINT AND REASON
   PRECEDENCE ARE NOW PINNED (v18, cycle-13 major 3): the swap
   read happens IMMEDIATELY AFTER THE RECLAIM RETURNS AND
   BEFORE ANY STEP-2 PUBLICATION (neither the ledger rename nor
   the writer-lease replace has begun at the detection point);
   a swap detected there ⇒ the ledger publish is ATTEMPTED
   (guarded) and IF ITS OWN token check fails, THE REASON
   STAYS `lease-swapped-post-reclaim` — the swap reason
   OUTRANKS `lease-stolen-precheck` whenever a swap was already
   observed (stolen-precheck is reserved for guard failures
   with NO prior observed swap), so one abort produces exactly
   ONE reason; CLEANUP IS OWNERSHIP-CONDITIONAL (v18): at the
   swap point the lease file names the OTHER token — we do NOT
   hold the lease — so cleanup is EXECUTED AGAINST THE
   OWNERSHIP OBSERVED AT CLEANUP TIME, not at swap-observation
   time (v19, cycle-14 major 5 — ownership can be REGAINED
   between the two: the body can name our token again when
   cleanup runs, e.g. a swap back or a successor's re-publish
   racing): the cleanup step RE-READS the host body immediately
   before each action — names OUR token at cleanup ⇒ we DO hold
   it: run the guarded ledger publish if still pending, remove
   OUR writer body if published, CALL `releaseOursClaim` (it
   sees our token and unlinks — CORRECT: we release what we
   hold; a failed release reports cleanup-failure alongside the
   PRESERVED swap abort reason — the reason never changes;
   release-then-unlink is NOT atomic, the check→unlink window
   is the disclosed double-reclaim residual — a stale release
   can unlink a successor's body the instant ownership flips,
   the same non-atomicity shipped at `supervise.ts:1976-1988`,
   NOT newly closable here); names ANOTHER token or absent at
   cleanup ⇒ release NOTHING (`releaseOursClaim` returns
   `"absent"` on non-ownership — safe no-op-by-design,
   `supervise.ts:1955-1990`); NEVER touch the writer file when
   it is not ours (ours was never published in the swap case
   unless a racing success); dir
   fsync if we published, return the reason; the abort REASON
   is frozen at swap observation and never rewritten by later
   cleanup outcomes — cleanup failure is a SEPARATE reported
   field (`cleanup: released | absent | failed:<detail>`); the v17 sentence
   listing the swap reason among "RETAINED-then-QUARANTINED
   while it holds the lease" members is CORRECTED — retention
   applies only to reasons raised WHILE HOLDING our lease.
   PUBLISHED-VARIANT CASE STATED SEPARATELY (v20, cycle-15
   major 3 — v19's fragment was unreadable): THREE distinct
   artifacts, three separate outcomes. (1) LEDGER PUBLICATION:
   the swap abort is observed at the post-reclaim guard, which
   runs BEFORE any clearing publish of ours exists — the abort
   path performs its (optional) guarded publish only when the
   cleanup re-read STILL finds our token (the regained branch
   above); if the guard observed a swap, no publish from the
   aborted path was attempted before this cleanup, so the only
   way a ledger mutation carrying OUR staged content exists is
   the regained branch performing it. (2) WRITER BODY (v39, AUDV1-m1 —
   step number CORRECTED: our writer body is published at STEP 2 per the
   state machine (the old "step 4" was wrong — there is no step-4 body
   publication), and the pinned detection point runs BEFORE ANY STEP-2
   PUBLICATION, so "published before the swap was observed" was FALSE
   for OUR body — no body of ours exists at the detection point): at
   the swap point the lease file names the OTHER token and our staged
   body was NEVER published by this invocation — at cleanup the body is
   foreign or absent (that IS the swap) and we remove NOTHING (touching
   a foreign body is forbidden); if the re-read shows the body OURS,
   that is the regained branch AFTER our own guarded step-2 replace
   completed (ownership raced back), and we remove our own published
   body there, which is correct, not forensic. SEQUENCING PINNED
   (v39, R2-M7): an abort DOES NOT continue into step-2 body
   publication on its own — reaching publication requires the
   regained branch, which re-runs the FULL step-2 sequence (fresh
   lease re-validation under the exclusion lock, then the guarded
   replace) exactly as a non-aborted pass would; there is no
   abort-local publish shortcut. OWNERSHIP EVIDENCE is
   INVOCATION-SPECIFIC, not token alone: this invocation may remove
   a body ONLY if ITS OWN step-2 replace returned success this run
   (a process-local fact recorded at publish time); a body merely
   NAMING our token but never published by this invocation (a
   pre-existing or forensic remnant) is foreign-by-rule and is
   never touched. Fixtures: swap-back into a regained publish, and
   a pre-existing same-token body at cleanup (must survive). (3) ANY LEDGER CONTENT
   carrying our staged removal that a swap-back publish
   nevertheless left behind (only reachable through the
   regained branch's publish racing a LATER swap away): that
   content was published by OUR guarded publish while we
   believed we held the lease, its entries left the ledger
   only via ESRCH-proof, and a later holder's union read
   re-incorporates everything it raced — it is harmless to
   soundness, and status/dashboards may show its traces; that
   residue is the disclosed double-reclaim residual acting,
   not a new failure mode; `observedWriter` is the `{pid,
   token}` read from the EXISTING `writer-lease.json` (if any)
   before replacing it — so a takeover that crashed before
   publishing the ledger (B reclaimed A's HOST lease, died
   before writing the file; C now reclaims) still captures A:
   A's identity is recoverable from the writer-lease file B
   never got to touch, or from the still-listed host-lease
   body, and "each takeover ADDS the owner it displaced" is
   READ AS this union rule. PUBLICATION IS CRASH-ATOMIC AND
   MERGE-BASED (v16, cycle-11 blocker 2): the ledger is written
   tmp → fsync(tmp) → RENAME over the target → dir fsync — an
   in-place rewrite is FORBIDDEN (truncate-mid-write losing the
   old set is the failure); the rename is a READ-MERGE-PUBLISH:
   the writer RE-READS the current file immediately before its
   own rename and writes `read ∪ own additions` — the honest
   guarantee is SNAPSHOT-WIDE (v17, cycle-12 major 2 wording
   fix): every entry in the publishing writer's OWN READ
   SNAPSHOT — together with the additions THAT PUBLISHER ITSELF
   is making, which are by construction in its own publish and
   so survive its own rename (v18, cycle-13 minor 1: the bound
   quantifies over each publisher's full write, snapshot ∪
   own-additions, of its OWN publication) — survives its
   publish; THE FULL WRITER'S BOUND, N-PUBLISHER HONEST (v19,
   cycle-14 minor 1 — v18's "NEITHER of two competing
   snapshots" phrasing bounds only PAIRS): the FINAL
   publication contains its own snapshot ∪ its own additions;
   an earlier publisher's addition ABSENT FROM THE FINAL
   PUBLISHER'S SNAPSHOT CAN BE LOST; for every publisher P,
   entries in (the intersection of all snapshots taken AFTER
   P's publish completed, ∪ P's own additions) survive — the
   two-snapshot intersection is the weaker pairwise corollary,
   not the full bound, and the P8 pin's intersection phrasing
   reads as the corollary (v19 says which is which); an
   addition made by a competitor that a given publisher never
   observed CAN be lost by
   the last rename (v16's "cannot stomp an entry unless it also
   observed it" inverted the losing publisher's observation and
   is corrected — see the P8 pin); THE
   ORDERING OF THE STEP-2 PUBLICATIONS IS PINNED AND LOAD-BEARING
   (v16, pre-empting cycle 12): the LEDGER rename + dir fsync
   COMPLETE BEFORE the writer-lease replace rename begins —
   crash in between and the on-disk triple is (host body =
   ours-or-dead-ours, writer body = PREDECESSOR's, ledger names
   the predecessor), which the union capture re-derives exactly
   (the reverse order would put the predecessor's writer identity
   nowhere while a half-completed takeover runs — FORBIDDEN);
   a MALFORMED or unreadable predecessor writer body is captured
   fail-closed as ONE MORE unknown predecessor; a MALFORMED
   or non-ULID-`chainFrom` ledger file is FAIL-CLOSED: treated
   as naming one MORE unknown predecessor (represented per the
   v17 unknown-entry schema `{pid: 0, hostToken:
   "unknown-<ulid>", seenAt}` once ANY publish is possible;
   while the file is unreadable, refusal needs no publish —
   admission and
   takeover both refuse `journal-quiescing` and the operator
   must either restore the file or REPLACE it via the
   OPERATOR SURFACE's `--repair-quiescence-ledger` (file-
   permission-gated; v19 per cycle-14 minor 2 — the phrase
   "a minimal ledger they sign" is WITHDRAWN, no signature
   scheme exists); deleting the file entirely = the disclosed
   chain-severance residual, never an automatic act). CLEARING IS AN ASSIGNED,
   CRASH-SAFE OPERATION (v16, cycle-11 major 4 — v15 said
   "entries are removed on proven quiescence" but named no
   actor; a literal reading wedged admission forever): EVERY
   acquisition path (normal AND takeover) runs a CLEARING PASS
   before it admits: for each entry, `kill(pid,0)` ESRCH ⇒ the
   entry is proven gone; the pass then atomically publishes the
   REMAINING set (same tmp→fsync→rename→dir-fsync protocol, and
   — v17, cycle-12 major 3 — EACH clearing publication is
   GUARDED by the same immediate-before-rename host-token
   re-verification as every other publication: a clearing pass
   whose host token no longer matches aborts the publish,
   touching nothing; and its merge is REMOVAL-COMPOSED, not
   addition-only (v17, cycle-12 major 3 — semantics stated
   exactly): the publish is a SECOND read-merge — re-read the
   current file at rename time and write
   `currentRead − {entries in currentRead this pass proved gone}`
   (ESRCH-proven or confirmation-named); EVIDENCE SNAPSHOT IS
   THE SECOND READ (v20, cycle-15 minor 3): an entry's
   proven-gone evidence — the `kill(pid,0)` result AND the
   confirmation records ACTIVE per the consumption log (v22:
   offset ≥ token watermark, both logs re-read) — is evaluated
   at the rename-time second read, not at the pass's first
   observation (the confirmation file is re-read as part of the
   second-read step); a confirmation that lands between the
   first observation and the second read therefore COUNTS in
   this publish, and one that lands after the second read is in
   no read at all and can be missed by this publish — the same
   disclosed snapshot window, with the waiting 4b loop's re-read
   each poll converging at the next pass. PRECISION (v23,
   cycle-18 major 2 — the two rules must not disagree;
   ORDERING CORRECTED v25 per cycle-20 major 1 — the v23/v24
   phrase "post-guard watermark read L" contradicted the
   normative v24 total order, which reads L and appends the
   watermark BEFORE the final guard): the second read
   determines what this pass may USE as evidence (removal
   justification); the PRE-GUARD watermark read L (v24 total
   order, step 1) determines what this pass CONSUMES (v22
   consumption rule unchanged). The operative sequence at the
   rename site is: second read (evidence) → re-read L +
   generation header → watermark append (fresh open with
   `O_CREAT` + (R)-durable creation, v26 per cycle-21 blocker
   1) + write + fsync + close → 2V tail-verify (v26 per
   cycle-21 major 2; not-found aborts the cycle) →
   epoch-check guard as
   the LAST operation → ledger rename → post-rename
   self-verification (§1.1 (c) LOG). A record landing between
   the second read and the L read is therefore never evidence
   for THIS removal yet is consumed by L and can never justify
   ANY future removal; only a record landing AFTER the L read
   stays ACTIVE (the disclosed L-read→rename non-atomicity
   residue — v26 per cycle-21 minor: the window begins at the
   L read, not at the guard — `supervise.ts:1976-1988`
   parity, §1.1).
   entries a concurrent
   publisher ADDED between the pass's FIRST read and its
   rename-time SECOND read are in `currentRead` and are NOT
   proven-gone, so they survive the clearing rename by
   construction; additions landing AFTER the second read but
   BEFORE the clearing rename are IN `currentRead` at no point
   and CAN BE LOST by the clearing rename — the same bounded
   snapshot window as every other unguarded read→rename pair,
   DISCLOSED as such (v18, cycle-13 major 4; the v17 claim
   "a concurrent stale snapshot can therefore never resurrect a
   confirmed-away entry" is WITHDRAWN as a false lead-in —
   minor 2: the resurrection window is exactly this pair: the
   confirmation's removal-publish lands between the clearing
   pass's second read and its rename ⇒ the stale rename
   republishes the confirmed-away entry; same class, disclosed,
   re-derived by the next clearing pass only if the pid is
   again ESRCH-proven or the operator re-confirms; the contract
   does not pretend removal composes losslessly under the
   double-reclaim residual);
   if the remaining set is EMPTY the file is published EMPTY
   (`predecessors: []`) — an empty-set file DOES NOT REFUSE
   admission (refusal is driven by SET CONTENT via the clearing
   pass, never by mere file presence — v15's "leftover file
   refuses until the set clears" means exactly this and v16
   pins it: presence-of-empty-set = proceed, and the file is
   kept as the forensic record, never auto-deleted); entries
   that ESRCH cannot clear (pid alive again — reuse) are
   cleared ONLY by operator confirmation DESIGNATING THE
   ENTRY BY ITS RECORDED `hostToken` (not by pid — the token
   is what the confirmation names, so PID reuse cannot
   confirm the wrong entry away); step 4b runs the clearing
   pass on each poll and awaits the SET being empty. GROWTH IS
   BOUNDED: each takeover adds at most two entries (host+writer
   observations) and the clearing pass drains ESRCH-proven
   entries at every acquisition, so a wedge is always a
   live-process or explicit-confirmation situation, never
   arithmetic accumulation. §3 pins A→B-replaces→B-crashes
   →C with A paused inside an append: C's step 4b sees A's entry,
   refuses admission, until A's pid is proven gone; AND (v16)
   A→B-reclaims-host-CRASHES-pre-ledger→C: C's union capture
   recovers A from the writer/host-lease bodies and refuses
   until A is gone; AND the concurrent-reclaim merge fixture
   (v17, cycle-12 major 2 — corrected, v16 overclaimed): two
   reclaimers read `{A}`, add B and C respectively; with
   LAST-RENAME-WINS the honest survivor is `{A,C}` OR `{A,B}`
   depending on rename order — the FIRST rename's addition CAN
   BE LOST by a publisher that never observed it (the merge rule
   preserves every entry in BOTH read snapshots; it does NOT
   guarantee the union of additions). The pin asserts exactly
   that: the survivor contains every entry in the INTERSECTION
   of the two read snapshots (here: A — the survivor is the last
   write, which unions its own snapshot, and any entry in both
   snapshots was necessarily in the last writer's),
   NEVER an entry neither publisher saw, plus an explicit
   LOST-B FIXTURE showing `{A,C}` surviving and the contract
   treating lost-B as the disclosed merge-loss residual —
   RECOVERY CLAIM QUALIFIED HONESTLY (v18, cycle-13 major 1):
   the NEXT takeover's union rule re-captures B FROM B's WRITER
   BODY, and that recovery HOLDS ONLY WHILE B's body survives
   on disk; a racing takeover that replaces the writer body
   without ever capturing B (possible inside the disclosed
   double-reclaim residual — the check→rename windows, not an
   atomic fence) can erase B's identity from ALL artifacts
   while B is still live, which re-opens exactly the C10-B1
   class — SO: the residual is stated as the FULL ERASURE
   CLASS, not a bounded merge loss: "under the double-reclaim
   residual, a live unquiesced predecessor's identity CAN be
   lost from ledger AND writer body jointly (host body, writer
   body, ledger all overwritten by publishers that never saw
   it); no invariant of this contract survives that triple
   erasure, and none is claimed — strengthening the shipped
   time fence into a real exclusion protocol is M3-ADJACENT
   hardening and is the ONLY thing that closes it (see the
   TIME-BOUND row)"; the fixture asserts recovery IN THE
   ABSENCE OF RACING BODY REPLACEMENT (barrier-controlled),
   not unconditionally. RECONCILIATION WITH THE DAMAGE LATTICE
   (v19, cycle-14 major 6 — identity-proof failure and journal
   damage are SEPARATE failures; the triple erasure destroys
   only the first): after a joint erasure of B's identity, B's
   ACTS remain governed by the SAME per-append epoch-validation
   lattice as any other delayed publisher — the fence-loss /
   torn-EOF / mid-file-interleaved (restore-class) outcomes of
   the TIME-BOUND row apply UNCHANGED to B's late appends
   (per-append validation admits only the CURRENT lease-file
   token, so a demoted B is refused or restore-class exactly as
   there; the erasure adds NO new journal-damage mode); what
   the erasure DOES destroy is the quiescence PROOF: admission
   can proceed while B is still live and may still finish an
   append, and the only listed consequence boundary is
   therefore the lattice's worst case (restore-class on the
   shared journal) — NOT unbounded loss: the lattice IS the
   damage bound, stated once here so the two residuals cannot
   be read as claiming different worst cases. THE ERASURE
   LANDS ON A MATRIX ROW (v20, cycle-15 minor 2): after the
   joint erasure the disk triple is host-absent + writer-absent
   + ledger-absent, which the §1.1 R-table answers R4 `free` —
   the connective is now explicit: `free` is a DISK OBSERVATION,
   NOT PROOF OF QUIESCENCE; the erased-but-live B remains
   exactly the disclosed admission-while-live hazard this
   passage describes, and no status answer, including `free`,
   may ever be treated as quiescence evidence (per the table's
   own no-act-authority rule). A TRUE
   union guarantee would need writer serialization on the
   ledger file (an exclusive lock across read-merge-publish);
   under the double-reclaim residual two writers can exist, so
   this contract claims the snapshot bound, not the union, and
   says so in §5.2. PENDING
   PHASE (v15, cycle-10 major 3): the step-2 writer-lease body
   is written with `epoch: 0` (RESERVED — no journal record ever
   carries epoch 0, so 0 is unambiguous) plus `phase:
   "pending"`; the per-append validation refuses ANY act stamped
   against a pending lease (epoch 0 never matches a stamped
   record) — acts never validate against a pending body because
   the phase gate already refuses them; a pending file at
   acquisition by a DIFFERENT host-lease holder (crash mid-
   takeover) is stale by rule (ii) and replaced. CROSS-PROCESS
   PHASE PRECEDENCE FOR EXTERNAL CALLERS (v16, cycle-11 major 8
   — a second process cannot read the wrapper's phase field, and
   the on-disk state during step 3 is IDENTICAL to step 4b
   (pending writer body + non-empty ledger), so no on-disk
   derivation can distinguish them — HONEST ANSWER: for external
   observation the three-window map COLLAPSES step 3 into 4b;
   the exact per-step map holds only through the owning wrapper):
   an external act process that cannot acquire the host lease
   refuses `lease-unavailable` from the acquisition itself
   (shipped path — conservative, correct at every phase); a
   READ-ONLY status query derives from disk by ONE ORDERED
   DECISION TABLE (v19, cycle-14 majors 2+3 — the v18 prose
   clauses left the absence cases OUTSIDE the ordered list, so
   a list-order reader and an exception-first reader could
   disagree; the table IS the precedence: FIRST MATCHING RULE
   GOVERNS, no exceptions apply out of order; this also corrects
   v18's "independent of every ledger state" wording for the
   malformed-writer rule — it is independent of host presence
   but applies only AFTER the ledger rules have not matched):
   R1 ledger EXISTS AND IS MALFORMED ⇒ `journal-quiescing`
   (fail-closed, operator intervention per the ledger block) —
   regardless of host/writer; R2 ledger parseable and NON-EMPTY
   ⇒ `journal-quiescing` — regardless of host/writer (covers
   takeover steps 3 AND 4b — deliberately collapsed, the more
   conservative of the two codes; a malformed writer + non-empty
   ledger answers HERE, quiescing, the more conservative answer);
   R3 writer body EXISTS BUT IS MALFORMED/UNREADABLE ⇒
   `journal-corrupted` (v18 cycle-13 major 2; reached only when
   R1/R2 did not match, i.e. ledger absent-or-empty — mirrors
   the takeover capture rule treating a malformed writer as one
   more unknown predecessor; status says corrupted, the machine
   refuses, operator path = the OPERATOR RECOVERY SURFACE below
   `--operator-status` / `--confirm-quiesced` /
   `--repair-quiescence-ledger`); R4 host-lease ABSENT + writer
   ABSENT ⇒ `free` (nothing held — normal acquisition
   succeeding, not proof any past takeover completed); R5 host
   ABSENT + writer `phase:"pending"` ⇒ `lease-unavailable`
   (crash-mid-takeover orphan; stale by rule (ii), replaced at
   acquisition); R6 host ABSENT + writer carries any token
   (matching-or-foreign — NO host body exists, so the token is
   UNCOMPARABLE; v19 closes the cycle-14 gap: an uncomparable
   token is never "matching") ⇒ `lease-unavailable` (orphaned
   derivative); R7 host PRESENT + writer ABSENT ⇒
   `lease-unavailable` (live holder between acquisition and its
   writer publish, or a crashed one — shipped lease liveness
   says which); R8 host PRESENT + writer `pending` ⇒
   `lease-unavailable` (steps 5-6 window, takeover-crash
   included); R9 host PRESENT + writer token ≠ host-lease body
   token ⇒ `lease-unavailable` (derivative lease, step 1);
   R10 all pass (host PRESENT + writer token == host token +
   ledger absent-or-empty) ⇒ `no-quiescence-warrant` — NOT
   "admitted" (v17, cycle-12 major 5 — the disk triple cannot
   distinguish "step 7 complete" from "step-6 bump done, step 7
   pending"; and a pass-all answer is NEVER act authority).
   ENUMERATED MATRIX (v19, arithmetic corrected v20 per
   cycle-15 major 2: NOMINALLY 40 cases = host {absent,present}
   × writer {absent,pending,match,foreign,malformed} × ledger
   {absent,empty,nonempty,malformed}, but with host ABSENT the
   writer token is UNCOMPARABLE — "match" and "foreign" are the
   SAME observable state — so the matrix has 36 DISTINCT
   OBSERVATIONAL CELLS; the table prints ALL 9 observational
   rows × 4 ledger columns; the P10 fixture walks the 40 NOMINAL
   cases and asserts each equals the first-matching-rule answer
   of its row, absent-host match/foreign asserting the SAME
   uncomparable answers — asserted equality is between
   observationally-identical cases, not a hidden collapse of
   distinct states; L = ledger, W = writer, H = host; every
   cell is the FIRST matching rule's answer):
   | H | W | L=absent | L=empty | L=nonempty | L=malformed |
   |---|-----|----------|---------|------------|-------------|
   | absent | absent | free | free | quiescing | quiescing |
   | absent | pending | unavail | unavail | quiescing | quiescing |
   | absent | match/orphan | unavail | unavail | quiescing | quiescing |
   | absent | malformed | corrupted | corrupted | quiescing | quiescing |
   | present | absent | unavail | unavail | quiescing | quiescing |
   | present | pending | unavail | unavail | quiescing | quiescing |
   | present | match | warrant | warrant | quiescing | quiescing |
   | present | foreign | unavail | unavail | quiescing | quiescing |
   | present | malformed | corrupted | corrupted | quiescing | quiescing |
   (`warrant` = `no-quiescence-warrant`, `unavail` =
   `lease-unavailable`, `quiescing` = `journal-quiescing`; the
   writer "foreign-token" column of v18 is SPLIT into
   match/≠host where a host body exists to compare against —
   present-host foreign ⇒ `lease-unavailable` via R9, its row
   PRINTED (v20; v19 kept it in a footnote, so the printed
   table did not cover what P10 asserts); absent-host foreign
   is the `match/orphan` row by uncomparability.) NO
   status field of this query is ever ACT AUTHORITY — it is a
   conservative DISK OBSERVATION for dashboards and operators;
   an act's answer still comes from attempting acquisition
   (shipped path). The ABSENT-LEDGER POSTURE (v17, cycle-12
   major 4) is stated ONCE: an ABSENT `quarantine.json` is the
   EMPTY SET at both normal acquisition and takeover — a fresh
   episode never created the file and must not be refused; a
   MALFORMED file is the fail-closed `journal-quiescing` case
   (R1) remedied ONLY by the OPERATOR SURFACE's
   `--repair-quiescence-ledger` (the v17/v18 phrase
   "operator-signed minimal-ledger procedure" is WITHDRAWN —
   the procedure is file-permission-gated, not signature-gated;
   C14-m2); an operator DELETING an existing ledger is
   OBSERVATIONALLY IDENTICAL to fresh absence and is the
   disclosed chain-severance residual (§5.2); nothing may
   AUTO-RECREATE a ledger with invented content. NO field
   beyond `{host-lease body, writer-lease body,
   quarantine.json}` is needed; no phase transition requires an
   additional on-disk marker. ONE CLEANUP
   CONTRACT FOR EVERY PRE-ADMISSION EXIT (v16, cycle-11 major 6
   — v15 listed three failure triggers but left the result
   shapes and the rest of the exits open; this union is CLOSED
   and covers BOTH machines — normal acquisition AND takeover —
   every member names its cleanup, and the finally is the SAME
   for all: remove any writer-lease file THIS invocation
   published (token-conditionally: only while the on-disk host
   token still equals ours — never stomp a successor's file),
   RELEASE the host lease via the shipped release (normal path)
   or leave it quarantined (takeover path, below), dir fsync,
   RETURN the result — no silent retry; `quarantine.json` is
   NEVER deleted by a failure path (it is inherited):
   (1) normal-acquisition `epoch-contention` ⇒ writer file
   removed (token-conditional), host lease RELEASED, error
   surfaces to the caller (exit as an acquisition failure, not
   an act result — census note unchanged); (2) takeover-class
   failures have NO ACT to refuse them, so the orchestrating
   act has its OWN result union `TakeoverResult =
   {status:"quarantined-admitted"} | {status:"aborted", reason}`
   with `reason ∈ {lease-stolen-precheck (one of the
   immediate-before-publication re-verifications failed),
   lease-swapped-post-reclaim (v17, cycle-12 major 1 — the
   post-reclaim lease-body read shows a token that is neither
   ours nor the pre-read: an observed third-party swap),
   ledger-malformed (fail-closed per the ledger block),
   journal-corrupted (either rejection point of the floor
   block), duplicate-ids-at-takeover (the TAKEOVER-scope
   analogue of the refused act result — no act admitted; the
   census note records it under the takeover union, not the act
   census), epoch-contention-step6, io-failure (any unclassified
   EACCES/EIO from the machine's own syscalls)}`;
   UNKNOWN-PREDECESSOR ENTRIES ARE REPRESENTED IN THE LEDGER
   SCHEMA (v17, cycle-12 major 6): a predecessor whose identity
   cannot be read (writer body malformed/unreadable) is stored
   as `{pid: 0, hostToken: "unknown-<minted-ulid>", seenAt}` —
   `pid: 0` means "identity unknown, never ESRCH-clearable"
   (pid 0 is never a real process id); clearing is by operator
   confirmation naming that EXACT `unknown-<ulid>` token (the
   takeover result and status query both print it), so the
   closed confirmation machinery covers unknown entries with no
   special case; the CLI
   renders `TakeoverResult` in the SAME structured payload with
   `status:"aborted"`, the reason as `code`, exit 2 (refused-
   class — nothing landed); the host lease is RELEASED on
   `lease-stolen-precheck` (we no longer hold it — nothing to
   release beyond confirming) and RETAINED-then-QUARANTINED for
   every other reason: the takeover that aborts still holds the
   host lease while it removes its writer file, then RELEASES
   it, leaving the episode guarded by `quarantine.json` + the
   per-act `journal-corrupted`/`journal-quiescing` refusals —
   the corruption guard PERSISTS WITHOUT ANY EXTRA STATE (v17,
   cycle-12 major 6): the per-act `journal-corrupted` refusal
   is derived by each acquiring wrapper from `inspect()` on the
   JOURNAL BYTES THEMSELVES (step 3 is in the normal acquisition
   path too), not from a wrapper field or the predecessor-set
   schema — the corrupted bytes ARE the durable guard, so
   releasing the host lease after the abort loses nothing
   (the SAME disposition v15 described for 4a, now stated once
   as the general contract; "failed quiescence check" is NOT a
   terminal reason — step 4b WAITS (operator-confirmed entries
   or ESRCH clear it); an operator ending the wait re-runs the
   takeover act, which inherits the ledger. Composed edge (v15):
   `epoch-contention` DURING step 6 of a takeover ⇒ the takeover
   aborts per the cleanup just stated (quarantine file stays,
   operator re-runs); the bump never loops inside the machine.
   LOCK LIFETIME — THE "UNCHANGED" CLAIM IS REVISED (v15,
   cycle-10 major 1): the shipped reclaim releases its takeover
   lock in a `finally` BEFORE `acquireEpisodeLease` returns
   (`supervise.ts:2713-2727, 2738-2739` — the returned handle is
   `{token, path, held, release}`; NO lock handle escapes), so
   steps (2)-(6) CANNOT run "under the shipped lock" as v14
   worded it. v15: M3 takeover is a NEW ORCHESTRATING ACT
   (`takeOverQuarantined(episodeId)`) that (a) calls the shipped
   reclaim, (b) writes `quarantine.json`, (c) runs steps 2-6, and
   (d) RE-VERIFIES its host lease immediately before EVERY
   publication it performs — the ledger rename, the writer-lease
   replace, the step-5 `open()`, and the step-6 bump rename
   (v16, cycle-11 major 2 — v15 listed steps 3/5/6 and missed
   the step-2 publications; see RE-VERIFICATION COVERS EVERY
   PUBLICATION below for the honest check→rename residual)
   (token equality against the lease file —
   the same per-append validation), ABORTING with the cleanup
   above if the lease was stolen; competing acquirers serialize
   on the SHIPPED takeover lock only for the swap itself — the
   quarantine window that follows is protected by the host lease
   PLUS the quiescence ledger, NOT by holding a reclaim lock
   across an operator wait (which the shipped code rightly never
   did). FLOOR SOURCE, FRESH READ ONLY (v15, cycle-10 major 2;
   routing COMPLETED in v16 against cycle-11 major 5 — v15
   pinned only the step-6 fresh-read throw, but a late
   malformed line can make step 5's `open()` itself REJECT
   before any instance exists, and `open()` returns the
   INSTANCE, not records (`journal.ts:616-622`)): the fresh
   read is an explicit SECOND `read()` call on the opened
   instance, and BOTH rejection points route identically —
   step 5 `open()` REJECTS (mid-file malformed bytes landed
   between inspect and open) OR step 6's `read()` REJECTS
   (bytes landed between open and read) ⇒ EITHER case routes
   to the 4a evidence-preserving refusal: `journal-corrupted`,
   quarantine holds, NO repair beyond what `open()` already
   did, writer-lease removed token-conditionally, HOST LEASE
   released per the single cleanup contract below, operator
   notified. The step-3 `inspect()` result is NOT the floor
   source and is NOT reused after quiescence — between inspect
   and quiescence a dying owner's late append can land COMPLETE
   (its last appends may finish after the inspect snapshot).
   Step 6 derives `epoch = 1 + max(epoch over ALL records in a
   FRESH READ of the POST-QUIESCENCE, POST-`open()`-REPAIR
   journal)` (either rejection point above pre-empts
   derivation); a
   duplicate-id result from the fresh read ⇒ the takeover
   aborts `duplicate-ids-at-takeover` (v17, cycle-12 major 6 —
   v16 routed this to the refused-ACT result, but no act is
   admitted in a takeover: the takeover-union reason IS the
   result; the act-scope `journal-unreadable:duplicate-ids`
   refusal remains for normal-path reads) (this pin EXISTED for
   normal reads only; now pinned for the takeover path too). An
   ABSENT journal file at inspect (episode dir exists, journal
   never created) ⇒ classified CLEAN with floor 0 (epoch 1),
   consistent with shipped behavior — `open()` does NOT create
   the journal; it returns an instance after `read()`/repair
   both tolerate ENOENT, and the FIRST APPEND creates the file
   (`journal.ts:616-622, 663-675, 718-724`; v17 cycle-12 minor
   3 — v16 said "creating on first use", which is false of
   `open()` and true of the append);
   EMPTY and ABSENT are the same class. §3 pins: (i) a complete
   late claim landing between steps 3 and 5 is INCLUDED in step
   6's fresh floor (its epoch is subsumed, never re-derived);
   (ii) a late MALFORMED line between 3 and 5 ⇒ EITHER
   rejection point (step-5 `open()` OR step-6 `read()`) routes
   to `journal-corrupted` with the bytes preserved — both
   distinct paths are separately pinned (v16, cycle-11 major 5).
   RE-VERIFICATION COVERS EVERY PUBLICATION (v16, cycle-11
   major 2 — v15 verified at steps 3/5/6 but step 2 publishes
   files, and the header claimed "re-verifying at every
   mutation"): the takeover re-verifies its host-lease token
   IMMEDIATELY BEFORE each of its FOUR mutations — (i) the
   ledger rename, (ii) the writer-lease replace rename, (iii)
   the step-5 `open()`, (iv) the step-6 bump rename — aborting
   with the single cleanup contract (below) on theft. The
   residual is stated honestly: a token READ followed by a
   RENAME is still a check→act window (the shipped comment says
   a read-only fence CANNOT exist) — a reclaimer that steals
   AFTER B's check but BEFORE B's rename can be clobbered by
   B's pending rename; what the added checks bound is the
   WINDOW (check and rename are adjacent statements, no await
   between), and a CLOBBERED live successor's next validation
   fails it `fence-lost` — its acts STOP (fail-closed) rather
   than append under a stolen fence, while B's own step 3/5/6
   re-checks (and the ledger, which lists the successor as a
   predecessor-to-prove) refuse B's admission. THE RESIDUAL
   LATTICE (delayed double-reclaim, worst cases): (a) spurious
   fence-lost for the interrupted live holder (availability,
   recoverable — its work journalled nothing further);
   (b) TORN-EOF tail (repair at next open cleans it);
   (c) MID-FILE INTERLEAVED CORRUPTION if the clobbered host
   was MID-APPEND when its replacement published — NOT
   repairable at open; this is the RESTORE-CLASS outcome
   (validate-only open ⇒ `journal-corrupted` ⇒ manual repair /
   restore with the journal kept as evidence) — IDENTICAL in
   kind to the forced-steal row's outcome, and v16 CORRECTS
   v15's "worst case is the disclosed torn-tail class" in the
   exclusivity paragraph, which UNDERSTATED it (cycle-11
   major 1 — see that paragraph and the §5.2 row, both
   restated to the lattice).
   PER-APPEND
   VALIDATION, NAMED WRITERS (v13, cycle-8 major 1): EVERY M3
   journal writer — claim (`withClaimLock`), abandon, intent,
   outcome, recovery-update, and revoke — validates BEFORE its
   inline append that the lease file's `token` EQUALS its owner's
   token and its own stamped epoch EQUALS the lease file's
   `epoch` (the read-before-write check is cheap and closes the
   ORDINARY takeover path; it CANNOT close the in-flight-append
   overlap — see the residual below); a failed validation is a
   `fence-lost` TERMINAL: `ClaimOutcome` gains
   `{status: "fence-lost"}` (not a refused — the act holds
   nothing and may not retry on the old lease), the abandon/
   intent/outcome/revoke writers return the act's top-level
   `failed(fence-lost)` (revoke result contract likewise gains
   `refused(fence-lost)`), and a fence-lost act performs NO
   retry, NO further append, NO CAS — it surfaces to the caller
   as an execution that journalled nothing further. ACT-LIFETIME
   QUIESCE BARRIER (v13, cycle-8 blocker 2 — v12's "waits on the
   writer instance's pending chain" waits on the WRONG work: the
   shipped pending chain (`journal.ts:602-606, 638-660`) covers
   QUEUED APPENDS only; the contract itself puts construction
   and gate work OUTSIDE the claim callback, so the queue drains
   while acts are still live): the lease holder maintains an
   ACT-LIFETIME REGISTRY — every claim-bearing act registers
   (increments a counter) at ADMISSION (before its step-0 scan),
   decrements at its TERMINAL result (returned/failed/journalled
   outcome); release = (i) CLOSE the registry (new admissions on
   this lease are refused `lease-closing`), (ii) AWAIT all
   registered acts reaching terminal results, (iii) remove the
   lease file (token-conditional, shipped release discipline),
   (iv) dir fsync. REGISTRY SEMANTICS MADE IMPLEMENTABLE (v14,
   cycle-9 major 1 — v13 said "the lease holder maintains a
   registry" without naming the object or its exception story):
   the registry is ONE OBJECT inside the journal WRAPPER (the
   same per-process instance that owns the writer chain), in the
   lease's owning process — it is NOT per-call and NOT
   cross-process (a second process with no matching lease is
   refused at admission, see below); register/close are
   synchronous transitions of one field (`open` → `closing`)
   plus a live-set — single-threaded event loop makes
   check-and-register ATOMIC by construction (no await points
   between test and insert). ADMISSION = the wrapper's entry
   point for EVERY M3 act (promotion, rollback, revoke, and
   recovery-participating reads that write): step (a) validate
   the lease token against the lease file (so a non-holder
   process is refused `lease-unavailable`/`fence-lost` BEFORE
   incrementing — nothing registers against a lease it does not
   own); step (b) registry state must be `open` (else
   `lease-closing`); step (c) insert a UNIQUE INVOCATION TOKEN
   (a per-admission ULID the wrapper allocates — NOT the act's
   logical action identity: two concurrent admissions of the
   SAME actionId are legal per the same-action pin below and
   must occupy TWO live-set entries, else the loser's terminal
   decrement would empty the set while the winner is still live
   and release would drop the fence under a live act — v15,
   cycle-10 blocker 3) into the live-set; steps (d)+ run the
   act. DEREGISTRATION is EXACTLY
   ONCE IN A `finally`-EQUIVALENT — the wrapper awaits the act's
   promise and removes ITS OWN invocation entry on FULFILLMENT OR
   REJECTION ALIKE (returned, refused, failed, AND thrown-by-bug
   all decrement; a leaked counter blocking release forever is
   the failure mode this closes; the never-throws result-union
   contract stays — the finally is defense-in-depth for bugs,
   not a new throw surface). The registry catches step-0
   non-executing answers too: sticky-terminal replays register
   at admission and decrement at their (immediate) return — they
   hold the lease for microseconds, not zero, so release never
   overtakes one mid-projection. §3 pins: (a) an act THROWN by
   injected bug still decrements (release proceeds afterwards),
   (b) a step-0 replay returns AND decrements (no phantom
   registration), (c) release concurrent with admission ⇒ the
   admitted act either registered BEFORE close (awaits terminal)
   or refuses `lease-closing` (no interleaved in-between), (d)
   second-process act with no lease refuses at step (a) with the
   live-set UNCHANGED, (e) revoke and recovery reads register
   and decrement like claim-bearing acts, (f) TWO concurrent
   admissions of the SAME actionId occupy TWO invocation entries
   — the refused LOSER decrements its own while the winner stays
   paused mid-construction ⇒ the live-set stays non-empty ⇒
   graceful release remains blocked until the winner terminates
   (v15, cycle-10 blocker 3). A stuck act (bug, hung
   gate) BLOCKS graceful release until it terminates or the
   operator forces takeover —
   disclosed, bounded by the same forced-takeover path below, no
   new mechanism. §3 pin MOVED and strengthened: pause an act
   AFTER its `withClaimLock` callback has RETURNED (claim
   durable, construction live outside the queue) ⇒ release
   MUST NOT complete; only after the act's terminal result does
   the lease drop.** FORCED-TAKEOVER RESIDUAL — DISCLOSED AT ITS
   TRUE STRENGTH (v13, cycle-8 blocker 1 — v12's §5.2 row 1 and
   §1.1 claimed the steal window preserves "journal-level append
   atomicity" and bounded the damage to wasted construction; that
   claim is RETRACTED: `FileHandle.appendFile` may issue MULTIPLE
   syscalls and serialization is PER INSTANCE
   (`journal.ts:631-636`), so a superseded owner paused INSIDE an
   append can have its bytes interleave with the new owner's —
   producing MID-FILE corruption that `open()`'s tail repair
   cannot fix (`read()` rejects malformed mid-file records,
   `:663-705`) and a subsequent takeover-repair can truncate
   COMPLETE records written by the new owner. The honest posture:
   forced takeover of a LEASE whose holder may be mid-append is
   an OPERATOR RECOVERY ACTION whose possible outcomes include a
   CORRUPTED journal; the contract therefore adds an integrity
   QUARANTINE: after ANY forced takeover the new owner MUST run
   the journal inspection in VALIDATE-ONLY mode — A NEW
   NON-MUTATING API, `DecisionJournal.inspect()` (v14, cycle-9
   major 2: shipped `open()` ALWAYS repairs its tail —
   `journal.ts:616-622` `#repairTail()` truncates or appends a
   newline at `:730-748` — so validate-only is M3-new work,
   patterned on the P8 `BudgetLedger.inspect` precedent: pure
   byte classification, repair NOTHING; the torn TAIL is
   reported (`tail-torn: <offset>`) and PRESERVED untouched —
   repair happens only in normal mode after the quiescence
   condition below is met) — if parsing yields ANY mid-file
   malformation (not just tail), the episode is `journal-
   corrupted`: EVERY claim-bearing act refuses
   (`refused(journal-corrupted)`, extending the same per-act
   scope as duplicate-ids — fleet admission unaffected, ledger ≠
   journal), the operator's documented remedy is
   restore-from-backup or manual repair with the journal
   retained as forensic evidence. THE SETTLE-TIME IS NOT A
   QUIESCENCE PROOF (v14, cycle-9 blocker 1/2 correction — v13
   said the operator "waits out the takeover settle-time
   inherited from the shipped time fence, `supervise.ts:
   2259-2272`": that hold is `leaseSwapHoldMs`, DEFAULT 0, taken
   AFTER the swap to mitigate a delayed lock-reclaim, and the
   shipped comment at `:2335-2342` states it is NOT a scheduler-
   independent bound — a finite sleep can NEVER prove a paused
   old-owner append has stopped landing). THE QUIESCENCE
   CONDITION (what the contract now REQUIRES before normal-mode
   admission or repair): the new owner may transition from
   validate-only to normal mode only when the old owner is
   PROVABLY GONE — `kill(oldPid, 0)` reports ESRCH (the lease
   body's pid; PID-reuse is bounded honestly: a recycled pid
   belongs to a process that never held this journal's fd,
   because opening the journal required the shipped lease —
   stale-pid false-positive disclosed to §5.2), or the operator
   has terminated the old host and CONFIRMS it (the takeover act
   prints the old pid and demands confirmation; LEDGER-SCOPE
   NOTE, v16 cycle-11 major 4: when the unquiesced-predecessor
   ledger is non-empty, the same confirmation procedure applies
   PER ENTRY and DESIGNATES THE ENTRY BY ITS RECORDED `hostToken`
   — confirmation of "the old pid" clears only the entry whose
   token matches, never the whole set). Until quiescent
   the episode stays `journal-quiescing`: claim-bearing acts
   refuse (`refused(journal-quiescing)` — a distinct code from
   `journal-corrupted`); the shipped takeover lock covers THE
   SWAP ITSELF ONLY — inspect runs AFTER the reclaim handle
   returns, i.e. under the HOST LEASE with re-verification,
   never under the reclaim lock (v17, cycle-12 minor 2 — v16's
   "takeOver then inspect run under the shipped takeover lock"
   was still wrong: the lock is released before the handle
   returns; steps (2)-(6) run under the HOST LEASE with
   re-verification, see LOCK LIFETIME below), so a competing
   acquirer that steals the swap out from under us serializes
   with us only through the swap reason's immediate post-reclaim
   detection (v19, cycle-14 minor 3 — v18's "(see the
   writer-lease lifecycle below)" was a DANGLING pointer: the
   lifecycle passage is ABOVE and serializes nothing; the only
   serialization this path offers is the guard-abort itself).
   THE CONFIRMATION
   PROCEDURE IS AN EXECUTABLE OPERATOR SURFACE (v18, cycle-13
   major 5 — "operator confirmation" appeared as prose
   throughout; an interface is now defined — it is a CLI
   OPERATOR MODE, not an episode act: no journal record, no
   dedup identity, it runs BEFORE/outside admission and is
   therefore OUTSIDE the act census with its own result shape):
   (a) READ: `--operator-status <episodeId>` prints the full
   quiescence picture — the precedence answer PLUS every ledger
   entry verbatim `{pid, hostToken, seenAt}` INCLUDING unknown
   `unknown-<ulid>` tokens (this is the DISCOVERY path the
   confirmation argument needs; exit 0 always; pure read, no
   lock, no lease — on an UNREADABLE or MALFORMED ledger or
   confirmation file it prints the RAW BYTES (truncated at
   64 KiB with the byte count) plus the parse error, still
   exit 0: atomic rename prevents torn PUBLICATIONS, not I/O
   failure or pre-existing malformed files, and the operator
   surface must degrade to forensics, not to an error the
   operator needs the machine for — v19 closing cycle-14
   minor 6) PLUS every record in BOTH logs (confirmation and
   consumption) verbatim, each confirmation annotated `active`
   or `consumed` by the watermark computation (v21, cycle-16
   minor 1 — without this the operator cannot diagnose WHY a
   wedged entry refuses to clear: a lost append, a consumed
   record, or a missing one; absent files print as empty
   sets), with the third value `unknown` when the consumption
   log is unreadable/malformed so the classification is
   uncomputable (v22, cycle-17 minor 1 — alongside the raw
   bytes + parse error, so the operator never sees a fabricated
   active/consumed verdict), and `TakeoverResult` aborts print
   the same entry list inline; (b) CONFIRM: `--confirm-quiesced
   <episodeId> --entry-token <token>` — the token argument is
   matched EXACTLY against one entry's `hostToken` field
   (string equality; no pid involved; the argument is taken
   from --operator-status output). THE CONFIRMATION IS A
   DURABLE RECORD, NOT A LEDGER EDIT (v18, cycle-13 major 5,
   self-corrected same cycle): the operator process holds NO
   host lease, so it NEVER publishes to `quarantine.json`
   directly (a removal-publish from a non-holder would race or
   stomp the lease-holding clearing pass — and refusing while
   ANY holder is live, the naive guard, makes confirmation
   IMPOSSIBLE during a 4b wait, which is its ONLY use case —
   the takeover wrapper IS the live holder then). Instead the
   operator APPENDS to `events/quiesce-confirmations.json` —
   an APPEND-ONLY JSONL LOG (v22, cycle-17 blockers 1+2 —
   replacing v21's read-merge-append file and in-file/identity
   mark schemes: every merge-over-snapshot+rename design loses
   facts to stale renames, so NEITHER confirmation file is
   EVER rewritten): one record per line
   `{confirmId, hostToken, confirmedAt}` appended via
   `open(O_WRONLY|O_CREAT|O_APPEND)` + ONE `write` of the
   complete line (line cap 512 B — a longer line is invalid
   input and refused BEFORE any write) + `fsync` (no tmp, no
   rename, no merge: concurrent appenders never overwrite each
   other — O_APPEND positions atomically; records below a
   page-size cap never interleave); a torn trailing line of the
   CONFIRMATION log is IGNORED per the ledger's tail-scan rule
   (the asymmetry, v23 per cycle-18 blocker 2: losing a
   confirmation record is FAIL-SAFE — a wedge that persists
   until re-confirmation, never an unsound clearing);
   `events/quiesce-consumptions.json` has the OPPOSITE failure
   algebra — a partial/unreadable trailing WATERMARK line must
   NEVER be ignored: bytes after the last complete line of the
   consumption log render the consumption authority
   UNCOMPUTABLE (a partial live append is observationally
   indistinguishable from a torn tail, and ignoring it would
   silently un-consume a just-consumed confirmation —
   exactly the re-clear C17-C18 hunt) — confirmation evidence
   is then REFUSED for every clearing decision (ESRCH still
   clears; entries stay), status prints the `unknown`
   annotation naming the unsettled tail's byte offset, and
   [V35 SUPERSEDED: tail truncation, tmp→rename and composition in this
   passage are REVOKED by v33/v34 (append-only). Settlement is the v34
   `\n`-append path. Read the sentence below as historical.]
   recovery is SETTLEMENT (v39, AUDV1-M2: the sentence below still read
   as live despite the bracket above — REWRITTEN: recovery is the v34
   `\n`-append SETTLEMENT executed by the 4b holder; the truncation
   doctrine named below is HISTORICAL and eliminated per (b)). WAITING-HOLDER
   SELF-REPAIR EXIT (v24, cycle-19 major 1 — the v23 text sends
   the 4b loop to a repair verb that requires the lease the 4b
   loop itself holds, a deadlock): the repair doctrine's lease
   requirement FENCES CONCURRENT WRITERS, so it is satisfied by
   a holder ALREADY HOLDING the lease — `--repair-consumptions`
   runs under the EXISTING lease (same epoch, no swap, no
   second acquirer) when invoked by the holder, and the 4b poll
   loop AUTOMATES it: a poll that observes the unsettled-tail
   annotation executes the v34 settlement in place under its own
   epoch (v35: `\n`-append settlement only; no tmp→rename; the
   ALL-line rule unchanged), then continues waiting with
   recomputed authority on the next poll — NO operator
   intervention, NO lease handoff, and a non-holder invoking
   the repair still takes the standard acquisition path (a
   held lease is honored: `lease-unavailable` per the normal
   rules); identity is
   the
   CLI-generated `confirmId` (a fresh ULID per invocation —
   v22, cycle-17 major 2: `confirmedAt` timestamps are NOT
   identity — clock repeat/regress makes two confirmations
   indistinguishable; the fixture confirms same-token
   same-`confirmedAt` records are DISTINCT, consumed
   independently); a whole-file-garbage confirmation log is
   FAIL-CLOSED for confirmation evidence (ESRCH-only clearing;
   status prints raw bytes per (a); recovery =
   `--repair-confirmations`, the same repair doctrine as (c):
   validate-line-scan, replacement published tmp→rename,
   REFUSED `file-not-malformed` otherwise; BECAUSE WATERMARKS
   ARE BYTE OFFSETS, a confirmation-log repair ALSO appends
   `{hostToken:"ALL", watermark: <byte length of the repaired
   file>, confirmGen: <the NEW generation of the repaired
   file, v23>}` to the consumption log (an operator append to the
   watermark log is monotone-safe: watermarks only ever RAISE
   the inert threshold, so no operator append can re-activate
   evidence). PUBLICATION ORDERING (v24, cycle-19 blocker 2 —
   the v23 text left the two-file protocol's crash boundary
   open: a repair could rename G2 in, then die before its ALL
   line, and "a generation with no watermark lines is fully
   live" would activate COPIED, already-consumed records): the
   repair's staged replacement (tmp file) has a KNOWN length N
   BEFORE publication, so the ordering is pinned — (1) build
   the tmp replacement, compute N and the new generation
   `confirmGen G2`; (2) APPEND the ALL line
   `{hostToken:"ALL", watermark: N, confirmGen: G2}` to the
   CURRENT consumption log (fresh `open(O_WRONLY|O_CREAT|O_APPEND)`
   — `O_CREAT` + (R)-durable creation as in the pass's
   step-(2) append, v26 per cycle-21 blocker 1 —
   +
   one logical append via the checked write loop of (b-O) FRAMING
   + fsync + close — same no-held-fd rule as the
   clearing pass) and it is then DURABLE; (3) ONLY THEN the
   tmp→rename publishing G2. Crash after (2), before (3): the
   ALL line names a generation with no published file —
   harmless, no record can bear G2; a repair retry recomputes
   N and re-appends (max-semantics, idempotent). Crash after
   (3): the covering watermark is durable before the records
   it covers are visible — NO reader ever sees a G2 record
   without its G2 ALL watermark, so copied records are inert
   the instant they appear; only records appended AFTER the
   repair (offset ≥ N) are active, and every pre-repair record
   is inert. THE CONSUMPTION
   LOG: when a guarded publish removes entry X via confirmation
   evidence, the pass — ordering (v24, cycle-19 blocker 1 —
   the v23 claim "the guard revocation fails the pass's rename"
   was FALSE for a pass already PAST its guard: the epoch check
   must be the LAST operation before the ledger rename, and a
   dropped watermark must be re-establishable): (1) re-read the
   confirmation file's CURRENT BYTE LENGTH L AND generation
   header; (2) append the watermark
   line `{hostToken: X, watermark: L, confirmGen, consumedAt}`
   to `events/quiesce-consumptions.json` via a FRESH
   `open(O_WRONLY|O_CREAT|O_APPEND)` (v26 cycle-21 blocker 1,
   retained: `O_CREAT` is MANDATORY — a fresh episode may have NO
   consumption log; status prints absent files as empty sets).
   (v27, cycle-22 finding 4 — DIRECTORY DURABILITY IS
   UNCONDITIONAL: `O_CREAT` cannot tell the opener whether IT
   created the name, and an opener can observe a name that a
   concurrent creator has not yet dir-fsynced, so creation is
   never detected and never assumed durable. EVERY consumption-log
   append (step (2) and the confirmation-repair ALL append) is
   followed by fsync of the file AND fsync of its PARENT
   DIRECTORY before the step counts as durable; a directory fsync
   persists every entry created in that directory, including a
   concurrent creator's, so it covers the observed name whoever
   created it. Creating `events/` itself follows the same rule
   (mkdir, then fsync of the parent). Cost: one extra directory
   fsync per removal, accepted.)
   + one logical append via the checked write loop of (b-O) FRAMING
   + fsync + close (then the parent-directory fsync
   above) — NO
   file descriptor held across any pause, so the line lands in
   whatever file is CURRENT at open time (a stale-inode append
   class is eliminated by construction); (2V, v26 per cycle-21
   major 2 — the theorem's VERIFICATION PREMISE, defined fully
   below at the READABLE predicate) FRESH-READ the log's last
   1024 bytes and tail-scan for a READABLE line matching
   (confirmGen, X, L): NOT FOUND ⇒ the append is treated as
   FAILED, the pass ABORTS this removal cycle (no guard, no
   rename; entry remains; wedge persists — fail-safe);
   (3) THE EPOCH-CHECK
   GUARD AS THE LAST OPERATION before (4) the ledger rename —
   a repair that acquired the lease after step (2) revokes the
   epoch and step (3) FAILS the rename (no removal; a watermark
   for a removal that never landed is monotone-safe); (5)
   POST-RENAME SELF-VERIFICATION: re-scan the
   [V35 SUPERSEDED: step (5) composition and rename are REVOKED by v33/v34.]
   CURRENT consumption log for a complete watermark line
   matching (confirmGen, X, L); if absent (a repair replaced
   the file inside the disclosed check→rename microsecond
   window), RE-APPEND it once — watermark lines are max-
   semantic so duplicates are idempotent; AND THE REPAIR
   OWNER'S COMPOSITION IS MANDATORY POST-ACQUISITION (v25,
   cycle-20 blocker 1): the replacement's line set is built by
   a re-read of the CURRENT consumption log taken STRICTLY
   AFTER the repair's lease acquisition — staging a
   replacement from a pre-acquisition snapshot is ILLEGAL —
   and every READABLE line of the old log (the v26 normative
   predicate, defined immediately below) is
   composed into the replacement (removal-composed parity)
   before its tmp→rename. THE WATERMARK-LOSS IMPOSSIBILITY
   THEOREM (v25; premises + predicate PINNED v26 per cycle-21
   major 2): for any pass whose removal LANDED (step-4
   rename committed), its step-2 watermark append was fsync'd,
   closed, AND TAIL-VERIFIED (step 2V below) BEFORE its
   step-3 guard. THE SINGLE NORMATIVE READABLE PREDICATE
   (v26 — ONE definition used IDENTICALLY by the authority
   computation, the step-(5) self-verification scan, and
   repair composition; there is no second predicate): a line
   is READABLE iff it is a PHYSICAL LINE (terminated by `\n`;
   an unterminated final byte run is NOT a physical line)
   that parses, under ONE shared parser, as a schema-valid
   watermark record (all required fields, cap 512 B); this
   is the SAME notion as the tail-scan above (the consumption
   authority is UNCOMPUTABLE when bytes after the last
   complete line exist — unsettled bytes are never READABLE).
   THE FUSION HAZARD THE PREDICATE PINS (v26): an O_APPEND
   write landing after a tail fragment WITHOUT a trailing
   newline FUSES onto that fragment — the record is then
   durable but NOT a physical line, hence NOT READABLE — so
   "durable" NEVER alone implies readable. MALFORMED-LINE CLASS
   (v28; supersedes the v27 (c) floor-only repair and the v26
   self-heal rule): a fused watermark is a NEWLINE-TERMINATED
   MALFORMED LINE (complete physical line, schema-INVALID), not
   an unsettled tail. It is NEVER READABLE and NEVER interpreted.
   (a) AUTOMATIC PATHS FAIL CLOSED: any malformed terminated line
   NOT masked by a committed REPAIR record (b-O) makes the consumption
   authority `unknown`; confirmation evidence is REFUSED for every
   clearing decision; status annotates `malformed-line` with its byte
   offset and raw bytes. A fully masked log renders, RIDER 2:
   `repaired (overlay active: N lines masked by REPAIR{authId})` —
   never silently as healthy, so no human or external consumer is
   fooled by malformed bytes still physically present.
   (b) NO PATH REWRITES THE CONSUMPTION LOG (v33; AUD32-B3). The
   consumption log is APPEND-ONLY and is never truncated, replaced, or
   composed in the live protocol. ELIMINATED: forced composition, the 4b
   self-repair rewrite, `--repair-consumptions` rewrite, the non-forced
   truncation path, and the oversized-mask truncation fallback. Rider 1
   compaction is NOT part of this contract and is forbidden until its
   own contract exists.
EXCLUSION LOCK (v37, AUD36-B1/B2; NEW normative primitive, owner decision
1A). The ledger directory contains a sidecar lock file `<ledger>.lock`
(mode 0600, created if missing with O_CREAT, NEVER renamed, truncated, or
deleted — it is a rendezvous point, not data; its absence is not corruption
and its presence grants nothing). EVERY operation that mutates the ledger,
or computes a decision from it, holds an exclusive advisory lock
(flock(2), LOCK_LEASE-class kernel lock) on this sidecar for its ENTIRE
duration:
  (i) every append of (b-O) — reserve-on-append CHECK AND EVERY syscall of
      the checked write loop happen under the same acquisition, so no second conforming writer can
      insert bytes between cap check and append (closes AUD36-B2; fixtures
      F19);
  (ii) the resolve sequence + the classification it yields + the decision
      (consume / repair / settlement) made from it, up to and including any
      append the decision performs — one acquisition, no release between
      read and record (closes AUD36-B1: settlement can no longer be
      computed on a snapshot a concurrent appender has already extended);
  (iii) settlement's `\n` append and any APPLIED/WATERMARK append.
Acquisition is NON-BLOCKING with bounded retry (20 attempts, 50 ms → 2 s
backoff cap). An appender that cannot acquire fails with the TRANSIENT
reject `ledger-lock-held` (fresh retry is an ordinary idempotent attempt);
a reconciler whose binding-read acquisition times out REFUSES to decide
and reports `ledger-lock-timeout` (fail closed — never decides on a
possibly-stale snapshot). The lock is released by the kernel on process
exit, so a crashed holder leaves NO lock state to repair and crash
recovery needs no lock liveness protocol. Conformance is by construction:
the ledger directory is `0700` and the ledger files `0600`, owned by the
protocol user — a writer outside the lock is already outside the trust
model of the whole contract (same premise as append-only-ness itself).
FS PROFILE (v37, owner decision 0A; local-only storage). The consumption
ledger, AUTH file, and all sidecars MUST live on LOCAL filesystems;
network mounts (NFS/CIFS/FUSE-family) are OUT OF CONTRACT — flock
arbitration, fsync visibility, and rename semantics differ there in ways
that fail OPEN unprovably, so no network-mounted deployment may rely on
ANY guarantee in this document. Startup probe (runs once before the first
decision touching that storage; any leg failing ⇒ startup REFUSES with
`fs-probe-failed` and directs migration — no degraded mode):
  leg 1: the mount is a local fs type per statfs;
  leg 2: an flock acquire/release round-trip on a probe file, AND a
         competing independently opened descriptor fails a nonblocking
         exclusive acquisition while the first lock is held (v38 cycle-6
         SPEC SHARPENING, audit C1-5: a round-trip alone is satisfied by
         an flock that never excludes). Disclosed limit: a finite startup
         probe proves exclusion ONCE at startup; it cannot prove future
         lock behavior, crash durability, or a later network remount;
  leg 3: append + fsync(file) + fresh open shows exactly the appended
         bytes;
  leg 4: a probe rename-overwrite leaves no second visible name (catches
         silly-rename layers).
A FUSE mount that *reports* local is judged by behavior (legs 2–4), not
by the fs-type string. Cross-host deployments exist ONLY through the
lease-only confirmation path, where this ledger is never read remotely.
(b-O) EFFECTIVE READ (v34; replaces v33 (b-O); AUD33-B1/B2, M1, M3). The
ONLY function any reader, guard, status, or repair consults.
FRAMING (unchanged from v33; ONE-SYSCALL READING REVOKED v39, AUDV1-M3):
every append is ONE LOGICAL APPEND of `\n` + record + `\n` — one
reserved contiguous region, appended once, under ONE exclusion-lock
acquisition — EXECUTED as a checked write loop: attempt the write; while
bytes remain, re-issue for the remainder; a write returning 0 (no
progress) or an error raises, the loop is bounded only by errors (each
error terminates it). A short first write is COMPLETED by the loop; the
reservation, the cap check, and every loop syscall live inside the SAME
lock acquisition, so partial-loop state is invisible to any conforming
reader. A crash mid-loop may leave NO bytes, only a blank/whitespace
prefix (the framing newline and nothing else), or a nonblank
unterminated tail. The first two classify as ABSENT under framing
((b-O)(1) strips the blank tail) — [V40 LOCAL CORRECTION (R3-c2 DOC,
R3-2-3): the prior unconditional "a crash mid-loop leaves an
unterminated tail ⇒ unsettled-tail" over-claimed; the newline-prefix
case classifies absent, as F25 (V38 R2-M4) already enumerates]; only
the third classifies `unsettled-tail` (b-O)(1) + SETTLEMENT — the SAME
route every other crash-mid-append takes. Nothing in this contract asserts one-SYSCALL
atomicity anywhere; where prior text said "a single write" or "ONE
write" it has been conformed to "one logical append (checked loop)" at
every live site (cycle-6 audit finding S-C6-3, v39: the reference
implementation's `_sidecar_write` docstring still claimed
"single write"; corrected in code to the loop semantics). Blank physical lines are ignored; an unterminated tail
is terminated by the NEXT append's leading `\n` and becomes a terminated
MALFORMED occurrence. The log is never rewritten; every physical line
keeps a stable byte offset for life. Caps: WATERMARK 512 B, APPLIED 128
B, REPAIR 4096 B; over-cap records are refused before append.
RESERVE-ON-APPEND (v36, AUD35-M3): EVERY appender (WATERMARK, APPLIED,
REPAIR, settlement `\n`) must compute its framed byte count (record + the
two framing bytes) and REFUSE `log-cap-exceeded`, writing ZERO bytes, when
current file size + framed count would exceed 64 MiB. Because every live
append reserves its full framed size under the lock before its first
byte, the live protocol can never grow the log past 64 MiB (a crash
mid-loop leaves the reserved region unwritten or torn — the cap
invariant is about accepted appends, and torn bytes never extend the
accepted prefix past the reservation); the read cap in (b-O) is then DEFENSIVE ONLY (externally
corrupted or pre-v36 logs). Near-cap is a terminal operational state: the
log stops accepting appends and `log-cap-exceeded` names the future
compaction contract as the exit.
The reserve CHECK and the reserved append's write LOOP (every loop
syscall, v39 R2-M3 — "reserved single write" REVOKED) execute under ONE
exclusion-lock acquisition (EXCLUSION LOCK above; AUD36-B2): the two are
atomic with respect to every conforming writer, so the predicate can never
be invalidated between check and bytes-on-disk.
ALGORITHM over a FULL read (log > 64 MiB ⇒ `unknown`):
(1) an UNTERMINATED NONBLANK trailing run ⇒ authority `unsettled-tail`
    (FAIL CLOSED: it is NOT silently ignored; AUD33-B2). Trailing
    whitespace-only bytes are treated as blank and ignored;
(2) terminated line that parses as a valid known-kind record ⇒ VALID;
    any other terminated nonblank line ⇒ MALFORMED OCCURRENCE with
    (offset, sha256 of its exact bytes);
(3) a REPAIR is VALID iff its authId names exactly one VALID AUTH (d),
    its `masks` list equals that AUTH's occurrence list EXACTLY (each
    entry: offset AND hash, in order), each entry identifies a MALFORMED
    occurrence of this read (AUD33-M1: a mask entry naming a valid
    watermark or a nonexistent offset makes the REPAIR INVALID), its
    ALL.watermark <= current confirmation-log length, AND the
    confirmation log's CURRENT generation header equals its
    `all.confirmGen` — the generation the REPAIR bound at (c-O) step
    (i). GENERATION BINDING IS CARRIED BY THE REPAIR RECORD ITSELF,
    not by the AUTH: no AUTH generation field exists and none is
    needed (v39, R2-B2 — the prior text's "the generation the AUTH
    bound" had no referent). A confirmation-log repair publishes a
    NEW generation header, after which every REPAIR bound to the old
    generation fails this clause and stays DEAD (F24). A REPAIR failing
    this rule is a DEAD REPAIR (v36, AUD35-B1): it masks nothing, is NOT
    itself an occurrence (it is a schema-valid terminated line), requires
    no mask, and participates in no conflict. REPAIR validity references
    ONLY valid AUTHs, the stage-2 syntactic occurrence set, and the
    confirmation log — NEVER the validity of another REPAIR — so a single
    pass is deterministic and non-circular. Status annotates the count of
    DEAD REPAIRs; removing them is compaction debt, not live protocol.
    DEAD-REPAIR DISPOSITION (v37, owner decision 3A, pinned): a DEAD
    REPAIR contributes NOTHING to authority, masks nothing, and is never
    evaluated or trusted. It is NOT a latent authority awaiting operator
    action, and NO operator command may make one contribute — the only
    legal removal is the future compaction contract. Status REPORTS each
    DEAD REPAIR (offset, hash, reason: unknown-authId / mask-mismatch);
    an operator who believes one should be live must go through a NEW
    AUTH + fresh REPAIR against the CURRENT occurrence list.
    [QUALIFIED by the LATE-VALIDATION rule immediately below (v39
    AUDV1-M1; surfaced by D4A-c3-1): "no revival" means NO OPERATOR
    REVIVAL COMMAND exists — it does NOT mean a DEAD classification
    persists: validity is current-read, and the same stored record
    reclassifies VALID automatically when its missing precondition
    arrives later as a genuine authorization (AUTH appears / log
    grows past its watermark within its own `all.confirmGen`) —
    pinned by test_F24gen + fixture F24. The formerly unqualified
    "revival only via fresh AUTH + fresh REPAIR" shorthand in the
    V37 OWNER DECISION RECORD carries the same qualification (in
    place since the v46 fold, 2026-11-17); the
    owner's still-pending 3A reading is the ratification point for
    this whole disposition INCLUDING the qualification.]
    LATE VALIDATION IS EXPLICIT MEANING (v39, AUDV1-M1): validity is a
    CURRENT-READ classification — no "was DEAD" fact persists (none can:
    the log is append-only and nothing tombstones a record). A REPAIR
    DEAD in read N may classify VALID in read N+1 IF AND ONLY IF the
    missing precondition itself arrived LATER AS A GENUINE AUTHORIZATION:
    an AUTH with that exact authId appears AND its occurrence list still
    matches the mask list exactly, or the confirmation-log length grows
    past the REPAIR's ALL.watermark WHILE the confirmation log's current
    generation header still equals the REPAIR's `all.confirmGen`
    (v39, R2-B2: "the generation the AUTH bound" REVOKED — the binding
    is the REPAIR's own `all.confirmGen`, compared against the current
    generation header on every read). In either case the record's contribution is EXACTLY what a
    fresh REPAIR under that AUTH would contribute — same masks, same
    ALL — so the soundness content of the old "stays dead" promise is
    preserved: the only way a DEAD REPAIR ever contributes is behind a
    valid AUTH, and the SPENT predicate then forbids any second
    REPAIR/APPLIED under that authId (c-O step (ii)); "NO operator
    command may make one contribute" REMAINS TRUE (no command edits
    classification; contribution requires a new AUTH that happens to
    match). PRECISION (v39, R2-M1): a conforming producer can NEVER
    append a REPAIR whose authId has no AUTH (it REFUSES at (c-O)
    step (ii)/(iii)), and every `--authorize-consumption-repair` mints
    a FRESH ULID — so the only way a late-arriving AUTH can ever match
    a pre-existing DEAD REPAIR is if that REPAIR was injected or the
    producer was non-conforming. F23 is therefore an INJECTED/
    CORRUPTION-ONLY fixture: the rule defines what a matching genuine
    AUTH does IF one appears, not a supported workflow for creating
    one (creating one would require reusing a known authId, which the
    freshness rule forbids). [V40: the freshness rule is now WRITER-
    ENFORCED ON BOTH PATHS — a MINTED id is checked (under the same
    lock) against the AUTH inventory AND every id named by a
    terminated log record, with bounded retries and a FAIL-CLOSED
    refusal on persistent collision (R3-c4-1, pinned test_F55), and
    the minted value is a CONFORMING ULID — 48-bit epoch-ms ‖ 80-bit
    random (R3-c4-2, pinned test_F56); a caller-chosen authId is
    refused outright in production, and the test-only seam
    additionally refuses ids colliding with the AUTH file or named by
    any terminated schema-valid log record (R3-c3-1, pinned
    test_F53).] This closes the v36 "validity was decided, disposition was
    not" gap by DECLINING to grant the record any disposition beyond
    inertness + visibility (fixtures F13, F21; late-arrival fixtures
    F23, F24);
(4) every MALFORMED occurrence must be masked at its exact (offset,hash)
    by a VALID REPAIR; unmasked ⇒ `unmasked-malformed` (fail closed);
(5) VALID REPAIRs sharing an authId must have equal masks and equal
    ALL.confirmGen; effective ALL watermark is the MAX; otherwise
    `repair-conflict` ⇒ authority `unknown`;
(6) effective authority = VALID WATERMARK lines PLUS each VALID REPAIR's
    ALL as a watermark with hostToken "ALL"; the existing max-per-
    generation algebra and ALL inertness (offset < L_C in G_C) apply;
(7) SPENT := authIds of VALID REPAIR and APPLIED lines.
Occurrence binding is by (offset, hash); later identical bytes at a new
offset are a new occurrence and are NOT masked (AUD32-B2).
CLASSIFICATION (v35; AUD34-M3) is STAGED, total, and first-match:
  stage 1 (framing): log > 64 MiB or unreadable ⇒ `unknown`; an
     unterminated NONBLANK tail ⇒ `unsettled-tail`.
  stage 2 (syntax): every terminated nonblank line is either a schema-
     valid known-kind record or a MALFORMED OCCURRENCE (no third class).
  stage 3 (semantics): a REPAIR is VALID per rule (3) above, or DEAD.
     (v36, AUD35-B1) The v35 sentence "INVALID REPAIRs are treated as
     malformed occurrences" is REVOKED — it made stage 3 depend on stage 3.
     A DEAD REPAIR is inert: not an occurrence, masks nothing, needs no
     mask. A mask entry naming a schema-valid line's bytes NEVER names a
     malformed occurrence, so a malformed occurrence is always a syntactically
     invalid terminated line and the occurrence set is fixed before any
     REPAIR is evaluated.
  stage 4 (conflict): VALID REPAIRs sharing an authId with unequal masks ⇒
     `repair-conflict`. (v40 R3-c1 sharpening: the original trigger list
     also said "or unequal confirmGen" — under the v39 R2-B2 generation
     clause that branch is VACUOUS: every VALID REPAIR's confirmGen
     equals the single current generation header on the same read, so
     two VALID REPAIRs can never have unequal confirmGen. The branch
     is retained DEFENSIVELY against a reader that ignores the
     generation clause; no conforming read can reach it.)
  stage 5 (coverage): a malformed occurrence not masked by a VALID REPAIR ⇒
     `unmasked-malformed`.
  otherwise ⇒ `ok`.
Precedence: stage 1 > stage 4 > stage 5 (a conflict is reported even when
unmasked malformed bytes also exist). Exactly one state per read.
OBSERVER GATE (v36, AUD35-M2): a classification is a DECISION BASIS only
for a reader that has satisfied DURABILITY (below). An un-DURABLE-RESOLVED
reader's decision state is `durability-pending` (fail-closed: consume and
repair both REFUSE), regardless of the classification it computed.
   (c-O) THE FORCED REPAIR IS AN APPEND (v35; replaces v34 (c-O); AUD34-B1,
M2, M4). Runs under the held lease AND under the exclusion lock
(the lease authorizes the epoch; the lock serializes the file — (b-O)
EXCLUSION LOCK (ii); AUD36-B1):
(i) read the CONFIRMATION log's length L_C and generation G_C;
(ii) FULL-read the consumption log (b-O); the state MUST be `ok` or
     `unmasked-malformed` — in particular the SPENT predicate (below) must
     be FALSE for this authId; `unsettled-tail` ⇒ SETTLEMENT first;
     `repair-conflict`/`unknown` ⇒ REFUSE;
(iii) REFUSE `authorization-stale` unless the current occurrence list of
     `unmasked-malformed` equals the AUTH's occurrence list exactly;
(iv) build REPAIR = {t:"REPAIR", authId, masks:[{offset,hash}...] (the
     AUTH's list), all:{hostToken:"ALL", watermark:L_C, confirmGen:G_C}};
     REFUSE `repair-too-large` if it exceeds 4096 B; REFUSE
     `log-cap-exceeded` (v36 reserve-on-append) if current file size +
     framed REPAIR bytes (REPAIR + 2) would exceed 64 MiB;
(v) write `\n`+REPAIR+`\n` (O_WRONLY|O_CREAT|O_APPEND), loop on short
     writes; fsync the FILE; fsync the PARENT DIRECTORY (C22-F4). SUCCESS
     requires BOTH fsyncs to return success (AUD34-B1: a visible re-read
     is not durability);
(vi) any write/fsync failure or indeterminate result makes the outcome
     `outcome-unknown` AND puts the observer into `durability-pending`
     (DURABILITY below; v36, AUD35-M1 supersedes the v35 resolution text).
     RESOLUTION, exactly once, under the held lease: perform the resolve
     sequence (fsync file + fsync parent dir + FULL read). If the SPENT
     predicate holds after a DURABLE-RESOLVED read (VALID REPAIR or
     APPLIED naming this authId): SUCCESS. If the read is clean (no
     pending tail, size unchanged through the failed write — a clean
     error with nothing new on disk): FAILED, AUTH unspent, and ONE fresh
     (c-O) attempt with the same AUTH is permitted. In every other case
     remain `outcome-unknown`: NO second REPAIR append for this authId
     while any tail or durability is unresolved (AUD34-M1: a read showing
     "no VALID REPAIR" is NOT by itself a retry license), and status shows
     the pending state.
SPENT PREDICATE (single definition, used by (c-O)(ii), authorization
admission, and outcome-unknown recovery; AUD34-M2): an authId is SPENT iff
the (b-O) read contains a VALID REPAIR OR a VALID APPLIED line with that
authId. A spent authId is never repaired again.
DURABILITY (v36; AUD35-M2; single rule for settlement, REPAIR, WATERMARK
and APPLIED appends): an append's bytes are durable only once fsync(file)
AND fsync(parent directory) have returned success covering them.
RESOLVE-ON-USE: any process making an AUTHORITY or SPEND decision must
first perform the RESOLVE SEQUENCE — fsync(file), fsync(parent directory),
FULL read (b-O). Until both fsyncs succeed (state `durability-pending`):
REFUSE consumption, REFUSE repair — `durability-pending` is treated as
`unknown` (fail closed). Because a successful fsync flushes every pending
page-cache byte, once the resolve sequence succeeds, everything visible in
the following read IS durable; the pending state clears and its
classification is the decision basis. Read-only `status` need not resolve,
but must print `durability-pending` when the most recent append on this
host left it unresolved. This ONE rule replaces the per-path durability
prose of v34/v35 (AUD34-B1 remains closed by it).
RESOLVE BOUND & CRASH DETERMINISM (v37, AUD36-M1; owner decision 2A): the
resolve sequence and the (b-O) read it justifies run under ONE exclusion-
lock acquisition (EXCLUSION LOCK (ii)). If a process CRASHES between
entering `durability-pending` and recording its resolution, there is no
hidden state to reconstruct — and NO SUCCESSOR INFERS the crashed
process's fsync history from the visible bytes (a past fsync RETURN is a
process-local event, not a disk fact; v39, R2-M6). The pending rule is
instead CONSERVATIVE-CONSTRUCTIVE: every process that has performed (or
observes bytes consistent with) an append whose resolve has not been
confirmed BY ITS OWN successful resolve sequence treats the log as
`durability-pending` until ITS OWN resolve sequence succeeds under the
lock. This is not reconstruction of history; it is a default-deny that
resolves deterministically: the resolve fsyncs + read either confirm
durability (pending clears, classification stands) or fail (pending
persists). Resolution is IDEMPOTENT (fsync+fsync+full read recomputes the
same classification from the same bytes). Resolution attempts are BOUNDED per episode by
`repair-attempt-cap` (same bound, same exhaustion behavior as the tail-
repair loop): exhaustion ⇒ the ledger stops serving decisions
(`durability-pending` persists, fail closed), operator channel reports
`resolve-exhausted`, and exit is the operator path — NOT an automatic
retry, and NOT a silent pass. No schedule drives an unbounded loop or an
indeterminate acceptance.
SETTLEMENT (v35; AUD34-M1): when the read is `unsettled-tail` the holder
appends exactly one `\n` (one logical append via the checked write loop of (b-O) FRAMING, fsync file, fsync dir). It does
NOT classify or edit the torn bytes: the settled line is then re-read by
the ORDINARY (b-O) algorithm. If the settled line is a VALID record it is
VALID (for a REPAIR it may spend the AUTH and make its ALL effective — the
durability rules of (v) apply to the settlement append as well); if it is
malformed it is a malformed occurrence requiring a NEW AUTH. Settlement
write/fsync failure or indeterminacy (v36, AUD35-M2: the `\n` may ALREADY
have terminated the tail even when the fsync failed, so the framing state
can no longer be assumed `unsettled-tail`): the observer enters
`durability-pending` and may not use ANY classification until the resolve
sequence succeeds; after resolve, whatever the ordinary classification
yields — including a VALID record — is durable and stands.
CRASH TABLE (v35): (α) crash before (v) ⇒ no REPAIR; AUTH unspent. (β)
torn REPAIR ⇒ `unsettled-tail` ⇒ settlement ⇒ ordinary classification
(malformed ⇒ NEW AUTH; complete valid ⇒ valid). (γ) REPAIR complete but
an fsync did not return ⇒ `outcome-unknown` until re-open + fsync; the
on-disk truth is VALID or absent. (δ) VALID REPAIR durable AND both fsyncs
returned ⇒ spent and effective atomically. (ε) settlement `\n` written,
fsync failed or unconfirmed, process exits ⇒ next user of the log takes
`durability-pending` (fail-closed) until its resolve sequence succeeds;
the resolve fsync either flushes the pending bytes (then the post-settle
classification is durable truth) or the bytes were already durable.
AUD32-B1 (retained): ALL authority only through (b-O)(6). Offsets >= L_C
in THIS repair are not made inert by THIS ALL; they are inert only if an
applicable ALL/watermark from a later repair or confirmation covers them,
and otherwise remain ACTIVE (concurrent confirmation barrier). No rename,
tmp file, composition, or truncation appears on this path; the
confirmation-log ALL repair is OPEN AUDIT DEBT.
(d) AUTHORIZATION, HOLDER-MEDIATED (v28 AUD27-M2; v29 AUD28-M1/M2;
v30 AUD29-M1/M2). events/consumption-repair-authorizations.json is
append-only JSONL, one object per line, schema tag `consumptionRepairAuth`. [V35 SUPERSEDED: the 512 B cap and the single malformedSet digest are REVOKED; the operative format is the v34 occurrence-list AUTH below, cap 64 KiB.] ONE record kind: AUTH {authId (fresh ULID),
malformedSet (sha256 over the ordered (byte offset, exact bytes) of
every malformed TERMINATED line of the consumption log), createdAt}.
The operator runs `--authorize-consumption-repair <episodeId>`, which
prints the diff and appends one AUTH (O_CREAT, file fsync, parent-dir
fsync). AUTH-FILE FRAMING AND REPRESENTATION (v34; AUD33-M1, M2, M3). The
authorization file uses the (F1) framing and is NEVER truncated. Each
AUTH is one terminated line: {t:"AUTH", authId (ULID), occurrences:
[{offset, hash}, ...] (the exact unmasked-malformed occurrence list the
operator reviewed), createdAt}. The AUTH cap is 64 KiB; an operator
authorization whose list would exceed it is REFUSED (`auth-too-large`;
the set is not authorizable and the state stays `unmasked-malformed`
terminally until the future compaction contract). An entry list must
contain ONLY malformed occurrences at the time of authorization — i.e.
stage-2 SYNTACTIC occurrences (terminated lines failing the schema);
`--authorize-consumption-repair` REFUSES (`auth-entry-not-malformed`) any
entry whose bytes are a schema-valid terminated line, including a DEAD
REPAIR's bytes (v36, AUD35-B1).
VALIDITY: a valid AUTH is a terminated schema-valid line; an
unterminated NONBLANK or nonblank-malformed authorization line FAILS
CLOSED (a whitespace-only unterminated tail is stripped, consistent
with the (b-O) blank-tail rule; AUD45-c5-1)
(`authorization-file-malformed` for every authorization) until an
operator repair procedure, which is out of scope and named as open debt.
`--authorize-consumption-repair` REFUSES when a valid unspent AUTH with
the same occurrence list exists.
SPENT STATE (v34): an AUTH is SPENT iff a VALID REPAIR or APPLIED line names
its authId (b-O)(7). Spend is committed by the single append in (c-O)(v).
[V36 SUPERSEDED: the v34 sentence "a outcome-unknown repair is retried
only after a full read shows no VALID REPAIR" is REVOKED (AUD35-M1: it
permitted re-appending onto a torn tail). Recovery is EXCLUSIVELY
(c-O)(vi) + DURABILITY resolve-on-use; this paragraph adds no retry rule.] BINDING: REPAIR applies only when (c-O)(iii) holds; a newly
appended malformed occurrence changes the list ⇒ `authorization-stale`.
A displaced WATERMARK at a fresh offset is a VALID watermark, unmasked,
and participates in the effective read. The waiting 4b holder applies
(c-O) under its own epoch; idle episodes use the standard acquisition
path under the same rules.
BOUNDARY CLOSED BY ELIMINATION (v32 AUD30-M1, owner decision D):
the v31 disclosed late-append window existed only because (c)
REBUILT the file from one read. Under (c-O) the repair performs no
read-modify-write on the consumption log at all; a late append
between (c-O)(ii) and (v) is simply a later entry, governed by the
same effective-read rules as every other byte. The residual-window
disclosure is WITHDRAWN — not narrowed, eliminated: the operation it
described no longer exists. (Displaced-writer appends remain
non-authoritative per v30 epoch-revocation reasoning, unchanged.)
(e0) HISTORICAL (v32): text below referring to a "replacement",
"composition" of the consumption log, the (R) replacement-durability
premise, or induction over consecutive replacements describes the
SUPERSEDED v31 read-modify-write design, retained as the record of why
option D was chosen. The live path is (b-O)/(c-O): log grows only.
(e) Operative sequence: abort -> `malformed-line` status -> confirmations
refused -> operator authorizes -> holder or acquiring repair applies (c-O) (append REPAIR; no rewrite)
-> the pre-repair confirmation is inert and ONE NEW confirmation (or
ESRCH) is required -> next pass removes normally.
   The theorem
   therefore carries an explicit VERIFICATION PREMISE: STEP
   2V (v26, part of step (2), before the guard): after
   write+fsync+close the writer FRESH-READS the consumption
   log's last 1024 bytes and tail-scans for a READABLE line
   matching its own (confirmGen, hostToken, watermark); NOT
   FOUND ⇒ the append is treated as FAILED: the pass ABORTS
   the removal cycle (no guard, no rename; entry remains;
   wedge persists — fail-safe; re-attempt after
   `--repair-consumptions` settles the tail); soundness
   corollary: by 2V + abort, every unreadable/fused watermark
   region in a log belongs to a removal that NEVER LANDED
   (a landed removal's line was READABLE at guard time, and
   repair composition carries every READABLE line forward),
   so repair truncation of unsettled regions loses nothing
   load-bearing (v39 AUDV1-M2 note: no truncation exists to perform —
   under (b)/(c-O) unsettled regions are SETTLED by `\n` and then
   repaired by overlay; the sentence survives only as the historical
   soundness argument for why the v30 truncation design was safe, and
   its load-bearing content is carried by the 2V + abort corollary
   above it); the confirmation-repair ALL append performs
   the same 2V before its tmp→rename. Any repair that
   acquires the lease BEFORE that guard revokes the epoch and
   FAILS the rename (no removal — nothing to lose); any repair
   acquiring AFTER the guard takes its mandatory post-
   acquisition composition read strictly after the append was
   durable in the then-current log, so it SEES the line and
   composes it. THE REPAIR PUBLISH IS CRASH-DURABLE (v25,
   premise (R) of the theorem — the C3-B1 discipline applied
   to the replacement): the staged tmp is fsync'd, renamed
   into place, and BOTH the replacement FILE and the log's
   PARENT DIRECTORY are fsync'd BEFORE the repair reports
   success; a repair crash before the dir fsync may lose the
   rename, but then the OLD log (still current, carrying the
   watermark in its tail) serves, and a retry recomposes.
   By induction over consecutive repairs (each
   replacement carries every line its predecessor carried and
   the induction step is crash-durable by (R)),
   in EVERY schedule — including CRASH AFTER THE LEDGER RENAME
   with self-verification never executed — either the removal
   never landed or a complete (confirmGen, X, L) line exists
   READABLE (v26 predicate) in the CURRENT consumption log to
   every future repair; the state "removal landed, watermark
   exists NOWHERE READABLE" is UNREACHABLE (the induction
   step: 2V gave READABLE-at-guard-time; composition preserves
   READABLE lines byte-for-byte — physical lines re-emitted as
   physical lines under the same parser; (R) makes each
   preservation survive crash). POST-RENAME
   SELF-VERIFICATION IS THEREFORE REDUNDANT DEFENSE against
   implementation drift (a missed composition), not the
   load-bearing close; the load-bearing close is the ordering
   (append fully durable before the guard) PLUS the mandatory
   post-acquisition composition; the crash-point invariant
   table (v25) pins it: crash DURING or after step (2), before the guard — the guard is
never reached, so NO rename can have landed. PRECONDITION: the
consumption log was COMPUTABLE (READABLE or absent) when the pass
began; a pass whose status is `unknown` never appends. Outcomes: (α)
NOTHING survived (power loss before the directory fsync may drop the
append): no (confirmGen,X,L) line; the original confirmation stays
ACTIVE; no removal landed; the next pass re-derives and proceeds, with NO
recovery action. (β) a COMPLETE READABLE watermark survived: the original
confirmation is INERT for X's removal watermark, the entry stays, and the
ONLY recovery is ONE NEW confirmation (or ESRCH); the next pass's own 2V
does NOT reactivate the old confirmation. (γ) a COMPLETE newline-terminated
FUSED malformed line survived: status `malformed-line`, confirmations
REFUSED, fail-closed until the (c)/(d) repair. (δ) a PARTIAL unterminated
tail survived (torn write): status `unsettled-tail`, authority `unknown`,
confirmations REFUSED; recovery is SETTLEMENT (v39, AUDV1-M2: v30-v37
prescribed non-forced `--repair-consumptions` TRUNCATION here — REVOKED,
it contradicted (b) append-only: the truncation path is ELIMINATED, and
this case now reads exactly as the live rule (b-O)(1) + SETTLEMENT do:
the next holder's 4b loop appends one `\n` under its lease, the fragment
becomes a TERMINATED malformed occurrence, and the state is
`unmasked-malformed` until an operator AUTH + REPAIR masks it). (δ)
OUTCOME, CORRECTED (v39, R2-B1 — supersedes the v38 AUD38-B1 carve-out):
the claim "after the repair
completes the ORIGINAL confirmation is ACTIVE again" is WRONG and is
REVISED as follows. REPAIR step (i) reads L_C AFTER settlement, so the
original confirmation — which precedes the settled fragment — lies BELOW
L_C, and the REPAIR's mandatory `all:{watermark:L_C}` (c-O step (iv))
consumes every confirmation record below L_C, the original included.
Therefore, after settlement + AUTH + REPAIR the ORIGINAL confirmation is
INERT (consumed by the ALL watermark), NOT ACTIVE again, and the removal
requires ONE NEW confirmation (or ESRCH) — the recovery OUTCOME
coincides with (β); what differs is only that the fragment is masked
rather than the confirmation being independently readable. The AUD29-M4
"outcome preserved by the new path" statement is hereby re-graded: the
path preserved the OUTCOME only in the sense that no removal ever landed
without a fresh confirmation; the earlier "no new confirmation" wording
contradicted (b-O)(6) watermark semantics and is superseded by this
paragraph.
(δ2) NOTE on (β)-vs-(δ) journal state: after a δ recovery the REPAIR
record for that authId IS the surviving consumption journal — WHILE THE
CONFIRMATION GENERATION REMAINS G_C and the other validity conditions
hold, the ALL watermark (b-O)(6) keeps every confirmation record below
L_C inert (offset < L_C in G_C ⇒ inert) and the SPENT predicate
(b-O)(7) forbids a second REPAIR/APPLIED under that authId.
[V40 LOCAL CORRECTION (R3-c2 DOC, R3-2-1): "permanently" was
over-claimed. Generation binding (R2-B2) bounds this: a
confirmation-log repair that publishes a NEW generation makes this
REPAIR DEAD — its masks and its authId spend contribution CEASE on
subsequent reads, the formerly-masked records below L_C reappear,
their malformed occurrences re-enter unmasked classification, and a
fresh REPAIR under the same authId becomes valid in the new
generation (pinned: test_F24gen). The δ recovery OUTCOME at its
moment (one NEW confirmation or ESRCH) is unchanged; what generation
binding removes is the inference of PERMANENT consumption.]
Historical: the v30 wording "recovery is the non-forced
`--repair-consumptions` truncation to the last complete line" survives
only in superseded rows, marked so at each site.
A crash after the guard and before the rename is case (β):
the watermark is READABLE (2V verified), the original confirmation is
inert, and ONE NEW confirmation (or ESRCH) is the recovery. crash after (3) before (4) ⇒
   (the crash-after-(3) case is fully specified in the (β)/(δ) block
   above; no removal landed); crash after (4) before (5) ⇒
   removal landed, line in the current log by the theorem —
   a stale ledger rename finds it INERT, and restart re-derives
   from the two logs with NO recovery action required; crash
   after (5) ⇒ complete; every
   confirmation record naming X at a byte offset
   < L is PERMANENTLY INERT (consumed by the watermark without
   enumerating records); a record is ACTIVE for token X iff its
   offset ≥ max of X's watermarks IN THE SAME CONFIRMATION-LOG
   GENERATION (an `ALL` token line applies to every token).
   GENERATIONS (v23, cycle-18 major 1 — byte offsets are
   meaningless across a replaced file): the confirmation log's
   FIRST line is a generation header `{confirmGen: <fresh
   ULID>}` (written at creation AND at every repair — a repair
   publishes a NEW generation); every watermark line carries
   the `confirmGen` its L was read from, and the ACTIVE
   predicate compares records and watermarks with MATCHING
   `confirmGen` ONLY: a generation with no watermark lines is
   fully live, and a repaired confirmation file's pre-existing
   copies are inert via the repair's `ALL` line written IN THE
   NEW GENERATION (offset < new-file length) — old-generation
   watermarks can never strand a fresh post-repair record.
   CROSS-GENERATION HANDOFF (v24, cycle-19 major 2 — pinning
   pass-vs-confirmation-repair serialization to all three
   interleavings): the pass and a confirmation repair are
   ordered by the LEASE (the repair holds or takes it; the
   pass guards its epoch last before its rename), so exactly
   one of: (A1) the repair acquires first — the epoch swap
   fails any not-yet-guarded pass's rename (its evidence,
   watermark, and removal all lose together); (A2) the pass
   guards first (its lease then expires inside the disclosed
   window), the repair lands, and the pass's rename still
   lands — the repair's MANDATORY POST-ACQUISITION COMPOSITION
   (v26, cycle-21 major 1 — THE LOAD-BEARING CARRIER here,
   not self-verification: the append was durable in the log
   current at the repair's acquisition, so the repair's
   composition read SEES the (G1, X, L) line and carries it
   into the G2 replacement) puts the watermark in the CURRENT
   log REGARDLESS of the pass surviving to step (5); the
   pass's post-rename self-verification, if it runs, FINDS
   the line present and is a no-op (or re-appends an
   idempotent max-semantics duplicate if implementation drift
   missed the composition — the redundant defense only);
   G2's ALL line (watermark N) keeps every COPIED pre-repair
   record consumed: the removal and its watermark are both
   present in the current state and NO copied confirmation
   can re-clear anything; (A3) the pass
   completes rename + self-verification before the repair — the
   repair owner's readable-line composition carries the G1
   watermark into the replacement and G2's ALL line covers the
   copies. In NO interleaving can implementations disagree
   about which G2 records are consumed: ONLY offsets ≥ N in G2
   are live, decided by the single ALL line durable BEFORE G2's
   records are visible. Fixture (v24, restated v26): a barrier
   forces the confirmation repair between the pass's guard and
   its rename (A2), asserting the (G1, X, L) line is present
   in the CURRENT log WITH THE PASS KILLED BEFORE STEP (5)
   (the composition carried it — killing self-verification
   must NOT remove it) AND that the repair's copy of the
   same-token confirmation does NOT clear a resurrection of X.
   Why watermarks, not marks or identity sets
   (v22): (i) v20's in-file marks died to operator merges
   (C16-B1); (ii) v21's replaced-JSON consumed set died to
   stale RENEW-FREE renames across overlapping epochs —
   P1 paused after its guard renames a pre-B snapshot over
   P2's marks (C17-B1/B2) — whereas an O_APPEND log can ONLY
   ADD facts: an epoch-displaced stale writer's append lands
   as one more line and destroys nothing, so marks are
   unlosable including across the disclosed double-reclaim
   window; (iii) the watermark's L is re-read AFTER the evidence
   snapshot (v24 ordering step 1 — the v23 "taken AFTER the
   guard" phrasing inverted the steps; the soundness argument
   is unchanged), so
   the C17-B1 interleaving (confirmation appended after the
   pass's evidence snapshot but BEFORE the removal) is CAPTURED
   inert by the watermark — the residual window shrinks to the
   L-READ→RENAME steps (v26, cycle-21 minor — the v22/25 "the
   guard→rename step itself" understated the window: a record
   landing BETWEEN the pre-guard L read and the guard also
   stays ACTIVE, offset ≥ L; P8b states the wider window
   correctly) — the SAME disclosed shipped
   non-atomicity as `supervise.ts:1976-1988` (a record landing
   inside it stays active and may clear a later resurrection —
   sound: it is a human disappearance assertion for that exact
   hostToken made outside the removal's evidence window, and
   per wrong-token inertness it can NEVER match a NEW process,
   whose entry carries a different token — a stale ghost is
   removed by a true assertion, never a live host by a stale
   one); (iv) crash AFTER the watermark append, BEFORE the
   ledger rename = entry present, all its records inert =
   conservative wedge, recovery = ONE new confirmation (new
   record, offset past L, ACTIVE) — never a retry on inert
   evidence; (v) a resurrection is cleared by ESRCH or an
   ACTIVE record only — NO record consumed by the removal's
   watermark EVER re-clears, including after restart (active =
   offset ≥ watermark IN THE RECORD'S GENERATION, re-derived
   from the two logs). Restart
   re-derives everything: no third state. A repaired log
   CANNOT re-activate history: `--repair-consumptions` (the
   malformed-consumption-log repair, v22 closing cycle-17
   major 1 — v21 invoked "the repair doctrine" for a file with
   NO defined verb) validates every line of `--from` against
   [V39 SUPERSEDED FRAME (R2-M2): from here through the end of
   this paragraph, the described replacement/composition/
   tmp→rename machinery for the CONSUMPTION log is the
   superseded v22–v26 design — ELIMINATED by (b) v33 ("NO
   PATH REWRITES THE CONSUMPTION LOG") and (c-O) v35 (the
   forced repair is an APPEND). What remains LIVE: the verb's
   existence, its lease/epoch discipline, and the monotonicity
   principle (repaired logs cannot re-activate consumed
   history); everything about composing an old consumption log
   into a replacement is HISTORICAL. The confirmation-log
   repair's replacement machinery (§ the PUBLICATION ORDERING
   block) remains LIVE — the ban applies to the consumption
   log only.]
   the watermark-line schema, requires printed-diff +
   `--force` for a VALID-or-absent current file (chain-
   severance parity), runs UNDER HOST-LEASE ACQUISITION (v23,
   cycle-18 blocker 1, restated v24 per cycle-19 blocker 1 —
   the v23 fence claim was OVERSTATED: epoch revocation only
   fails a pass that has NOT yet performed its final guard, so
   fencing is pinned as a total order, not implied): acquiring
   the repair lease revokes every prior epoch through the
   standard lease-swap; the ONLY writer of a consumption line
   is a pass whose EPOCH-CHECK GUARD IS ITS LAST OPERATION
   before its ledger rename (watermark-append ordering, (c)
   above), so a repair whose acquisition revokes the epoch of a
   pass that has NOT yet guarded FAILS that pass's rename (the
   watermark it appended is monotone-safe — a line for a
   removal that never landed), and a pass that already GUARDED
   (the only window where a repair rename could strand its
   watermark on the old inode) is handled FIRST by the repair
   owner's own rule — at post-acquisition re-read it COMPOSES
   every readable line (see READABLE below) of the old file
   into its replacement (removal-composed parity), so no
   readable watermark is ever destroyed and the pass's
   step-(5) self-verification merely CONFIRMS the line is
   present (v26, cycle-21 major 1: composition is the
   handler; self-verification is the redundant backstop for
   implementation drift, never the load-bearer — the two
   roles must not be swapped) — plus (v22, pre-v26 text) a
   residual append
   landing after the rename re-positions onto the replacement
   via O_APPEND (fresh open) and only ADDS a line, scoped by
   confirmGen and monotone-safe), and — per the PUBLICATION
   ORDERING above, appending the ALL line (staged replacement
   length N, new generation G2) BEFORE the confirmation file's
   tmp→rename — records that existed
   before the repair can only become active again by an
   explicit operator re-confirmation AFTER the repair —
   re-activating consumed evidence by deleting marks is
   structurally impossible (v22 self-check: a MALFORMED log's
   watermarks may be partially readable, so the tool additionally
   PRINTS, as a DIAGNOSTIC ONLY and NEVER as a refusal (v30 AUD29-M3;
v29 AUD28-M4), whether the replacement's per-token max watermark is
LOWER than the max over the old file's READABLE lines; the SAFETY
argument for malformed lines is the forced-repair ALL construction in
step (2)(c), not this comparison —
   watermarks only ever RISE across any repair; an unparseable
   old line is NOT an argument for inertness — inertness of the
   dropped line's confirmations comes ONLY from the forced-repair
   ALL construction in step (2)(c)); the
   lost-append failure mode
   remains FAIL-SAFE (a failed/lost append ⇒ wedge persists,
   status shows it, operator re-confirms). The waiting 4b loop
   re-reads BOTH logs each poll (watermarks included), so a
   confirmation un-wedges the wait with NO re-run and NO second
   publisher; wrong-token confirmations match no entry and are
   inert (fixture: wrong-token confirmation leaves the entry AND
   admission still refuses);
   every operator-mode result is the §1.4 OPERATOR PLANE payload
   (`{plane:"operator", op, ok, ...}` — never an act payload;
   exit 0 success, 2 refusal, `status` exit 0 always per (a)); (c) LEDGER REPAIR: `--repair-quiescence-ledger
   <episodeId> --from <file>` replaces a MALFORMED ledger with
   the operator-supplied file (must itself parse as the ledger
   schema; the tool VALIDATES before publishing; `chainFrom`
   in the replacement is the literal `null` if absent from the
   file — the NEVER-HAD-A-CHAIN state pinned, v18 closing
   cycle-13 minor 3: repairs MUST NOT invent a chain ulid, and
   an explicit `chainFrom` in the operator file is COPIED
   VERBATIM when it parses) via tmp→fsync→rename→dir-fsync;
   REFUSED with `ledger-not-malformed` UNLESS the current file
   is MALFORMED (tool's own schema parse — the decidable
   predicate; v18 cycle-13 major 5 self-correction: "absent-
   with-proof-of-tampering" was an UNDECIDABLE predicate and is
   WITHDRAWN); for an absent or VALID current file the only
   permitted path is printing the full current content as a
   diff and requiring `--force` (an explicit operator override
   = the manual chain-severance act, disclosed residual
   territory, recorded in the tool's stdout forensics line) —
   no tool deletes a ledger as a side effect. REPAIR-VS-LIVE-
   PUBLISHER RACER (v19, cycle-14 major 4 — repair NEVER takes
   the host lease and NEVER coordinates with holders; instead
   the racers are shown to be the EXISTING disclosed class,
   bounded as follows): (i) a clearing pass whose read sees a
   MALFORMED ledger FAILS CLOSED (the R1 posture) and publishes
   NOTHING — malformed-during-pass converts the pass to refusal
   and the operator is signaled, so a pass can never "clear"
   its way through a malformed state; (ii) the live racers are
   passes that read a VALID snapshot and hold a staged rename:
   their guard re-checks only lease OWNERSHIP (shipped), so a
   stale clearing rename CAN overwrite a just-published repair
   — this is the SAME snapshot-loss/double-reclaim residual,
   NOT a new hazard, and repair claims no stronger durability:
   after ANY repair the operator MUST re-run `--operator-status`
   and, if the replacement content is gone, re-apply (every
   publish composes removal over its rename-time second read,
   so a publisher whose second read lands AFTER the repair
   incorporates the repaired set — only reads BEFORE the repair
   can stomp it); the residual is the second-read→rename window
   of §1.1's clearing rules, disclosed there; (iii) the same
   bound covers a takeover whose UNION READ landed before the
   repair: its publish is a read-merge-publish, so its own
   second read re-incorporates the repair, and the pre-repair
   variant is again the disclosed window; (iv) a fixture drives
   repair racing a staged clearing publish and asserts BOTH
   outcomes CONVERGE — v20, cycle-15 major 1 corrects v19's
   overclaim that a stomp can "resurrect or re-add, never
   unsoundly delete": the rename replaces the WHOLE file, so a
   stale clearing rename CAN DESTROY a just-published repair
   wholesale, including a LIVE unconfirmed entry the stale
   publisher never observed. The precise bound (restated to
   match the snapshot rules): entries the publisher OBSERVED
   leave the ledger only via ESRCH-proof or token-named
   confirmation in its payload (its own design, intact);
   entries it NEVER OBSERVED — which includes everything a
   repair added after its snapshot — are lost as the §1.1
   snapshot-merge loss class (additions a publisher never saw
   CAN be lost; the repair claims no stronger durability, as
   (ii) already says). Such a lost LIVE entry is NOT permanently
   unsound because the ledger is takeover-local: the next
   takeover's UNION READ re-captures the CURRENT host owner
   (an in-flight clearing rename cannot block it — it lands
   before the next guard), so convergence is DUAL: (A) the
   operator's mandatory post-repair `--operator-status` +
   re-apply loop, where a stomp leaves a VALID ledger that does
   NOT match the operator's file — re-applying a repair over a
   VALID file is the documented `--force` override path (the
   manual chain-severance act, disclosed residual territory,
   recorded in the stdout forensics line), so the loop is
   EXECUTABLE, and repeated re-apply TERMINATES UNDER A STATED
   STABILITY CONDITION (v21, cycle-16 major 1 — the v20 bound
   was per-publisher only, which does NOT bound a continuing
   stream of new epochs): IF takeover epochs are FINITE (each
   stale publisher that staged a publish before the repair
   renames AT MOST ONCE after its snapshot and NO FURTHER
   takeover takes a new lease staging a clearing publish),
   re-apply converges in at most (epochs already in flight) +
   1 rounds — a CONDITIONAL guarantee, pinned as such; under a
   CONTINUING takeover/crash loop NO TERMINATION IS CLAIMED:
   the wedge persists, every re-apply prints the divergence
   (never silent), and the operator ESCALATES by stopping the
   takeover churn (killing the wrapping supervisor processes —
   the same file-permission trust boundary) before the final
   re-apply; (B) absent operator
   action, the next takeover re-captures the live owner and
   status shows it again. The fixture asserts: after the stomp
   outcome, `--operator-status` followed by the prescribed
   `--force` re-apply (no wedge, no manual file edit) restores
   the repaired set, and no state exists where a LIVE holder is
   invisible to BOTH status and the next takeover; Authorization is
   FILE PERMISSIONS (operator = the account owning the episode
   dir, same trust boundary as the shipped supervisor; no new
   signing scheme — v17's "they sign" wording is replaced by
   "file-permission-gated operator mode"). What the CAS still
   guarantees when the journal SURVIVES takeover intact: two
   executions of DIFFERENT actionIds may both construct, the CAS
   admits at most one, the loser is a provable `no-effect:`.
   What it does NOT guarantee across a mid-append steal: journal
   integrity — and NO time-based wait claims otherwise.
   The claim is exclusionary ONLY while its owner epoch is live:
   an act evaluating eligibility treats an unconverted claim
   (CONVERSION IS BY EXACT EXECUTION IDENTITY `(actionId, r)` —
   the claim `A#r<n>@claim` is converted iff an intent record with
   id `A#i<n>` exists OR an abandon `A#r<n>@abandon` exists
   (v13, cycle-8 minor 1: the COMPLETE conversion set is
   intent-or-abandon, exact identity, mutually exclusive by the
   abandon's validation; v12's intent-only "iff" contradicted the
   abandonment transition); v12, cycle-7 major 4: a LATER intent
   for suffix m does NOT convert claim n, and an earlier intent
   does not prove anything about n) from a DIFFERENT actionId as an
   unresolved-intent-class blocker
   ⇒ `refused(intent-open)` IF `claim.ownerEpoch == currentEpoch`
   (the owner is a LIVE act of this same fenced writer — the
   paused-competitor case); if `claim.ownerEpoch != currentEpoch`
   the claim is STALE by construction — an epoch changes only
   when the exclusive fence passes to a new owner AND the old
   owner quiesced (act-lifetime registry barrier above; the
   forced-steal case is the quarantined residual disclosed
   there) — and it
   burns its `r` with NO lifecycle effect (the crash case: no
   stranding, gap disclosed; NO death inference is made from
   "absence of intent" alone, the epoch is the liveness proof).
   An unconverted claim with the SAME actionId is NOT ignored
   inside its own epoch (v12, cycle-7 blocker 2 — v11 said same-
   actionId claims are always ignored, which explicitly licensed
   two CONCURRENT same-mode requests (identical identity fields ⇒
   identical actionId) to each claim and construct, CAS proving
   only one lands while BOTH journals exist): same-epoch ⇒
   `refused(intent-open)` exactly like the cross-identity rule
   (the first act is LIVE — a second invocation of the same
   identity while the first is in flight is a duplicate call, not
   a re-issue); the ignore-and-re-issue reading applies ONLY when
   the unconverted claim's epoch is NOT current (crash reissue
   after a fenced acquisition — the re-issue allocates the next
   `r`, prior claim burned; F2-style fresh act). §3 pins: two
   same-mode requests paused after the FIRST's claim ⇒ second
   refuses; claim then owner CRASH + new acquisition ⇒ reissue
   proceeds at next `r`.
   The candidate is then built with `seq = n` in its trailer and
   the intent record `actionId#i<n>` (v12, cycle-7 major 2 id
   scheme) records the SAME `n` — no two
   conforming acts can ever build against the same suffix. A
   crash AFTER a claim but BEFORE the intent leaves a burned `r`
   with no lifecycle effect (under the epoch rule above): claims
   are ALLOCATOR-INTERNAL for lifecycle — the step-0
   dedup/recovery table IGNORES claim records (only intents and
   outcomes answer lifecycle questions), r-gaps are legal and
   meaningless (the execution identity is the pair `(actionId,
   r)`; gaps are disclosed in
   §5's honesty ledger). Cross-process atomicity is the P12
   premise, not a new promise (v10, cycle-5 blocker 2, evidence
   read): the journal serializes appends PER INSTANCE under the
   caller's exclusive-writer ownership; separate instances/processes
   require the supervisor ownership fence (P7) — `src/episode/
   journal.ts:602-606` — and the P12 port exposes `read` and
   `append` as separate ops (`src/integration/merge.ts:264-267`).
   **THE CLAIM TRANSACTION IS AN EXPLICIT JOURNAL OPERATION
   (v11, cycle-6 major 1 — the named interface does NOT provide
   it: `append` is queued per instance but `read` is a separate
   op (`journal.ts:602-630, 638+`), so two async acts INSIDE one
   legitimately-fenced owner can each read eligibility before
   either's queued append lands — the fence excludes another
   OWNER, not concurrent calls within the owner; serializing the
   appends never serialized the preceding reads). The contract
   requires a new journal primitive, `withClaimLock(scanAndAppend)`
   — TYPED CONTRACT (v12, cycle-7 major 3: the callback does NOT
   call the queued public `append()` (that would queue behind the
   callback awaiting it — deadlock); it receives a bound
   NON-REENTRANT inline writer (`appendInline`, the same code the
   pending chain runs but invoked FROM INSIDE the chain), and the
   callback's result is a closed union
   `ClaimOutcome = { status: "claimed"; r: number; ownerEpoch:
   number } | { status: "refused"; reason: "intent-open" |
   "already-executed" | "lifecycle-blocked" | "execution-seq-
   mismatch" } | { status: "failed"; ambiguous: boolean; reopened:
   boolean } | { status: "fence-lost" }` (v13, cycle-8 major 1:
   the fourth member — lease token/epoch validation failed; NOT a
   refused: the act holds nothing, may never retry on the old
   lease, and journals nothing further) — the act acts on the
   union; it never inspects journal state outside the lock to
   decide)
   :
   it queues the ENTIRE callback — eligibility re-scan (claims +
   intents for this actionId AND unresolved intents naming the
   promotion) plus the claim append — on the same per-instance
   pending-promise chain that serializes `append`, so within a
   host process exactly one scan-and-append runs at a time, and
   across processes the P7 writer fence + `ownerEpoch` cover the
   multi-owner case. Host wiring is IN SCOPE for the module: every
   claim-bearing act (promotion + rollback) obtains its journal
   through the episode's single fenced writer instance and claims
   ONLY via `withClaimLock`; the plain separate `read`-then-
   `append` path is ILLEGAL for claims (it is exactly the TOCTOU
   cycle 6 reproduced). Failed/ambiguous append: the instance
   poisons on I/O failure (`journal.ts:604, 651-656` — "reopen
   before appending"); the claim transaction therefore REOPENS
   and re-reads before ANY retry (v12, cycle-7 blocker 4 + major
   3, reconciled — v11 said "retry claims at a FRESH allocation,
   never reuses an ambiguous `r`" while the allocator IS max over
   surviving claims+intents: if the torn fragment is truncated by
   `open()`'s repair (`journal.ts:718-720`), the scan returns the
   SAME `n` — v11's non-reuse promise was unimplementable as
   stated. Resolution: the reopen scan is the AUTHORITATIVE state,
   and RE-USING `n` after a truncated torn claim is PROVEN SAFE,
   because the durable-before-resolve property means an
   unresolved append leaves NO claim record surviving in ANY
   state a successor can read: either the line never landed (scan
   correctly returns `n`; allocating `n` again races nothing) or
   it landed COMPLETE but its resolve was lost — then the scan
   SEES the complete claim: if it is the ORIGINATING operation's
   OWN claim the act ADOPTS it and continues at `n` (v13,
   cycle-8 major 3, recovery rule below — v12 said "allocates
   `n+1`" here, which collided with the same-epoch blocker by
   leaving two live claims of one act); a claim of a DIFFERENT
   identity makes the scan allocate above it, never colliding.
   The only case where a surviving record could disagree is a
   line landed complete with a DIFFERENT identity — impossible:
   the allocator's own re-scan inside the same transaction
   observes it. So the contract narrows to what is provable:
   "retry NEVER REUSES A SURVIVING (DURABLY LANDED) CLAIM'S `r`"
   — enforced by the scan — and torn-truncation-then-`n`-again is
   CORRECT RECOVERY, not reuse; the §3 pin is restated to test
   exactly this (torn fragment truncated ⇒ next claim may equal
   the torn `n` and MUST NOT equal any surviving record's `n`).
   Reopen is serialized INSIDE the wrapper (v12, cycle-7 major 3:
   `open()` repairs the tail per call (`journal.ts:616-622`), and
   two acts independently reopening would create TWO journals
   with independent pending chains — splitting the serialization
   domain. The wrapper therefore owns the instance: poison is
   visible to all queued waiters, exactly ONE reopen runs (the
   head of the chain after poison), its repaired instance
   replaces the shared reference under the same chain, and every
   waiting act resumes against it. ORIGINATING-OPERATION
   RECOVERY (v13, cycle-8 major 3 — v12's "retry allocates n+1"
   and the same-epoch blocker COLLIDE on one case: the caller's
   OWN append wrote a COMPLETE claim line then failed before
   resolve (`journal.ts:645-657` — failure after write, at
   sync/close); the reopen scan sees a surviving unconverted
   claim at the CURRENT epoch belonging to this exact actionId —
   auto-allocating `n+1` would leave TWO current-epoch un-
   converted claims of one live act (the blocker C7-B2 exists to
   stop), and `refused(intent-open)` would strand the ORIGINATOR
   at its own claim. Resolution — recovery identity is the
   exact record `actionId#r<n>@claim`: when the ambiguous
   operation's reopen scan finds its OWN complete claim (same
   actionId, same r, same ownerEpoch as the failed operation —
   the stamping makes ownership decidable), the act ADOPTS that
   claim as held (it IS the act's claim, journalled durably —
   adoption adds nothing to write) and proceeds to intent at the
   ADOPTED `n`, exactly once; it does NOT allocate `n+1` and is
   NOT refused by its own record (the self-claim exemption is
   by construction: recovery identity matches the failed
   operation's own tuple, which a DIFFERENT live act's claim
   never does — the same-epoch blocker keeps refusing other
   actionIds and same-actionId OTHER callers; the exemption is
   scoped to the recovering operation and cannot be claimed
   twice — a second ambiguous operation for the same tuple finds
   either an intent (converted) or re-adopts the same claim
   idempotently, never a second claim line: the check-before-
   append duplicate rule refuses it, and adopt-then-append is
   not attempted). Distinguish in §3: complete-line-failed-
   resolve ⇒ adopt same `n`; torn-tail-truncated ⇒ fresh
   allocation may equal the torn `n`; concurrent DIFFERENT live
   act ⇒ still `refused(intent-open)`);
   the ALLOCATED (or ADOPTED) `r` is what the
   intent, the
   outcome, and the trailers record. Literal-`#` injection is
   closed: actionId is lowercase hex, the `#r<n>` suffix (with its
   `@claim` marker suffix-position) is the only non-hex content
   permitted and the journal lookup parses positionally.**
   **NEW RECORD KINDS — SCHEMA (v11, cycle-6 major 2: the shipped
   journal enforces a CLOSED record union — `src/episode/journal.ts`
   defines the record kinds and `validateSupervisorRecord` rejects
   unknown kinds at append AND on read, so a claim or revocation
   invented as a raw new kind would fail the journal OPEN, not just
   the append; extending it is a docs/11 Change Ledger row, the
   same route §14.3 used for every prior kind). This contract
   requires exactly THREE new kinds (v12, cycle-7 blocker 3 adds
   the abandonment record), all extending the union with a
   Change Ledger row BEFORE implementation may compile against
   them:**
   - `PromotionClaimRecord extends RecordEnvelope { kind:
     "promotion-claim"; actionId: string; r: number; promotion?:
     string; ownerEpoch: number }` — `promotion` REQUIRED on
     rollback claims (names the promotion whose lifecycle the claim
     blocks in 0a′/0b re-scans), ABSENT on plain promotions;
     `ownerEpoch` REQUIRED (the fence generation, above); id
     discipline: the record's id is `actionId#r<n>@claim` (its
     EXECUTION identity is `actionId#r<n>` — construct, not id)
     (positional parse, `@claim` suffix-position — the only
     non-hex content permitted); validation: `r >= 1`, actionId
     lowercase hex, epoch integer — AND `ownerEpoch >= 1`
     (v16, cycle-11 major 7: the PENDING-PHASE sentinel
     reserves 0 for the writer-lease body (`epoch: 0` = "no
     usable epoch"), so NO journal record may carry 0 — v15's
     text asserted "no journal record ever carries epoch 0"
     while its validator accepted 0, letting one conforming
     implementation mint a record the sentinel argument
     depends can never exist; a zero/absent/negative
     `ownerEpoch` on an incoming record is a SCHEMA REJECTION
     — closed-schema fuzz territory, the record never lands —
     and since the floor derivation is `1 + max(...)` over
     surviving records, admitted journals start at 1 by
     construction; no migration is needed because no compliant
     journal ever contains 0).
   - `PromotionClaimAbandonedRecord extends RecordEnvelope { kind:
     "promotion-claim-abandoned"; actionId: string; r: number;
     reason: "conflict" | "empty-difference" |
     "pre-intent-error" }` (v12, cycle-7
     blocker 3) — id `actionId#r<n>@abandon`; converts its claim
     for eligibility (abandonment paragraph above); validation:
     the named execution MUST have a claim record and MUST NOT
     have an intent `actionId#i<n>` (converting an act that
     intended is a contract violation, fail closed).
   - `RecoveredRevokedRecord extends RecordEnvelope { kind:
     "recovered-revoked"; targetOutcomeId: string; operator:
     string }` — `targetOutcomeId` is the `id` of the revoked
     `merged(recovered)` OUTCOME record; `operator` from the
     TTY-confirmed CLI invocation context (v12, cycle-7 minor:
     §1.0/§1.4 define the human gate as TRUSTED-CALLER + TTY
     confirmation, NOT an authentication mechanism — "authenticated
     context" was an orphan promise); emitted ONLY by the
     `--revoke-rollback-recovery` act
     (§1.2), never by an act.
   - **RECORD-ID DISCIPLINE (v12, cycle-7 major 2 — v11 conflated
     the EXECUTION identity with the record `id`: it said the
     intent uses `actionId#r<n>` AND the revoke argument is "the
     exact outcome record's id", but intent and outcome of one
     execution cannot share one record id (the envelope requires
     unique ids — and the shipped reader only REPORTS duplicates,
     `journal.ts:663-668, 706-715`, never rejects them). Pinned
     id scheme per execution `(actionId, r)` — following the
     shipped outcome-suffix precedent `${actionId}#o${n}`
     (`merge.ts:702-705`): claim id `actionId#r<n>@claim`,
     abandon id `actionId#r<n>@abandon`, INTENT id
     `actionId#i<n>`, OUTCOME id `actionId#o<n>`, revoke id
     `revoke-<ulid>`; execution identity `actionId#r<n>` is a
     CONSTRUCT resolved to records, never a record id itself. The
     revoke CLI takes the execution identity `<actionId>#<r>` and
     resolves it deterministically to the `actionId#o<r>` outcome
     record; the M3 WRITER fails closed on duplicate record ids
     AT APPEND (`withClaimLock` and the intent/outcome/abandon/
     revoke writers check-before-append; the shipped read-time
     report is kept as a fuzz-detector, but append-side uniqueness
     is what makes target-selection total — v12 pins that a
     journal presenting a duplicate id at OPEN makes the M3
     projections treat the episode `unreadable(duplicate-ids)`:
     every claim-bearing ACT refuses
     (`refused(journal-unreadable:duplicate-ids)`) — never an
     arbitrary pick. NOTE (v12): the fleet budget's
     `fleet-indeterminate` (an §2.2 admission state driven by
     LEDGER reads) is NOT entered by a journal defect — journal
     and ledger are distinct files; the act-level refusal is the
     correct scope); §3 pins
     nonexistent target, duplicate target, non-outcome target.**
   - Reader/validator changes (pinned scope): all THREE kinds join
     the
     union + `validateSupervisorRecord`; the lifecycle projections
     (§1.1 step 0, §1.2 0a/0a′/0b) treat claims as allocator-
     artifacts-except-epoch-blocker and revocations as supersede
     markers (projection above); `DecisionJournal.read()` returns
     them mixed with the old kinds — every EXISTING reader is
     kind-filtered, so old consumers ignore new kinds and old
     journals (no new kinds present) read byte-identically: the
     backward-compat direction (new reader, old journal) is total,
     the forward direction (old reader, new journal) is a docs/11
     version-bump disclosure (a pre-extension reader meeting a new
     kind fails closed at open — disclosed, since only the M3-aware
     writer ever appends them and M3 hosts run the M3-aware reader).
   The ALLOCATED `r` sentence above names what the intent, the
   outcome, and the trailer record; the claim record's own fields
   are as pinned here.**
   **Redelivery comparison (v9, cycle-4 major 6 — stated, not
   assumed): step-0 lookup is BY `actionId` ALONE; the optional pins
   NEVER participate in identity, and the answer a redelivery gets
   depends only on the journal state (acked ⇒ sticky; open ⇒
   recovery; un-acked no-effect ⇒ fresh replay with the NEW request's
   pins).** This is deliberate: pins are preconditions on an
   EXECUTION, not on the ANSWER — an action that already LANDED
   stays landed no matter what tips a later request pins to, and
   pins take effect only on the two fresh-execution paths, each of
   which journals its own freshly allocated intent (so two requests
   differing only in pins can NEVER share an execution identity —
   each gets a distinct `r`, and each `r`'s recorded `M`/`E`/`C`
   come from the act that wrote that intent). Consequences pinned
   (v9): (i) all request fields that DISCRIMINATE the act (mode,
   params, amounts) ARE frozen identity fields — same `actionId`
   ⇒ identical frozen fields, so "incompatible same-identity
   redelivery" can only ever mean differing PINS; (ii) a differing-
   pin request against an ACKED `r` receives the sticky recorded
   outcome and is never newly authorized against that ack — a
   caller wanting a new act under moved pins chooses a different
   LOGICAL identity (different mode/params ⇒ different hash), not a
   pin edit; (iii) what each execution attested is exactly its own
   intent record's pins, and that record is what replay reports.
   - **acked outcome** → `refused(already-executed)` (sticky terminal,
     replay only) — UNLESS the journal TAIL is an OPEN intent for this
     actionId, in which case recovery runs first (§1.1 step 5b).
   - **outcome, un-acked, `no-effect:` marker** → replay permitted
     (fresh intent, distinct journal ids).
   - **outcome, un-acked, no marker** → `refused(not-replayable)` —
     same open-tail exemption as the acked case.
   - **open intent** → its recorded `M`/`E`/`C` are carried into
     recovery (step 5b) BEFORE any equality shortcut or construction —
     an open intent is closed ONLY by observed reality, never by a
     no-op answer.
   - **no record** → proceed.
   **Recovery-path input rule (v6, cycle-1 major 4; REFINED v7,
   cycle-2 major 1 — v6's "steps 1–6 run ONLY on the no-record
   fresh-act path" made the step-0-permitted no-effect replay have
   no executable path):** the rule scopes to the paths that answer
   WITHOUT executing — sticky terminals and recovery: when step 0
   routes to recovery (open tail) or to a sticky terminal, the act
   reads ONLY `refs/heads/main` plus the journal-recorded evidence —
   the CURRENT episode branch is NOT read and the caller's
   `expectedEpisodeTip`/`expectedMainTip` pins are NOT checked on
   that path (a moved/deleted branch after the crash must not strand
   the open intent behind a step-1 refusal; recovery compares
   recorded `C` against observed main, which is all recovery needs).
   **The TWO FRESH-EXECUTION paths run steps 1–6 in full (v8,
   cycle-3 minor 2 — v7 called this list "three" while F3 explicitly
   refuses to execute):** (F1)
   no record for the actionId (the plain fresh act); (F2) outcome,
   un-acked, `no-effect:` marker — replay permitted (v6 step 0), and
   the replay executes steps 1–6 against CURRENT reality with its
   own fresh pins (the marker attests the prior attempt changed
   nothing, so there is no recorded intent to protect; pins come
   from the REPLAYED request, and the replay journals a NEW intent
   id `actionId#i<n>` (v13, cycle-8 minor 4: `#i<n>` per the id
   scheme — v12's `#r<n>` here was a leftover) at the freshly
   ALLOCATED suffix (the claim
   protocol above — the same discipline as the operator re-issue
   below). NOT an execution path: (F3) open
   intent NOT descended after recovery (`refused(intent-open)`) is
   terminal — it executes nothing. Test pin (§3): un-acked `no-effect:` outcome on
   the actionId ⇒ replay builds a fresh candidate, gates, CASes, and
   journals execution `…#r2` (intent `…#i2`, outcome `…#o2` —
   v12 id scheme) — and a SECOND such marker replays as `…#r3`.
1. **Read pre-images:** observed main sha `M` (`rev-parse
   refs/heads/main`; unborn main is D9) and episode tip `E`
   (pins checked against caller expectations; mismatch ⇒ `refused`).
   Before any write the module also asserts `main` is NOT a symbolic ref
   (§1.1 step 5's guard) and NOT checked out in any worktree (v5,
   audit blocker 2 — the probe is pinned to ONE machine-readable form:
   `git worktree list --porcelain -z`; `-z` means paths are NEVER
   shell- or C-quoted — plain `--porcelain` quotes paths with spaces/
   unicode and a naive split would mis-parse a worktree path out of
   existence). **Grammar pinned against git 2.54 with byte dumps
   (v6, cycle-1 blocker 2 — v5 wrote the field separators wrong):**
   EVERY field is `attribute[ SP value] NUL` (attribute and value are
   SPACE-separated — `branch refs/heads/main\0`, `worktree <path>\0`,
   `HEAD <sha>\0`); RECORDS end with an extra bare `NUL` (an empty
   field between records); valueless attributes are `detached\0`,
   `bare\0`, `prunable\0`. Reproduced on the lab git: main checkout
   emits `branch refs/heads/main\0\0`; a detached worktree emits
   `HEAD <sha>\0 detached\0\0` (no branch field at all). Parse: split
   output on `NUL`; accumulate fields until an EMPTY field = record
   boundary; per field, the attribute is the token before the FIRST
   space and the value is everything after it (paths may contain
   spaces — split exactly once). A malformed stream (missing leading
   `worktree` field at record head, unknown attribute, unterminated
   final record) ⇒ parse anomaly ⇒ fail closed as probe failure, same
   as below. A worktree CHECKS OUT main iff its record carries field
   `branch refs/heads/main`; comparison is byte-exact on the
   fully-qualified branch VALUE (NOT a path/sha heuristic, NOT
   `git-linked`-style relative path resolution — `--path-format
   =absolute` output and `worktree list` paths disagree on symlinks
   and the check must never depend on which the installed git
   returns). A DETACHED worktree at main's sha is NOT a checkout of
   the ref (it tracks no ref; moving `main` cannot rewrite its
   working tree) — decision pinned HERE, not "at implementation":
   detached entries never refuse, but the act's result DISCLOSES any
   detached entry whose HEAD equals the old/new sha (operator
   information, not a gate). Any parse anomaly or `worktree list`
   failure on a repo with a readable main ⇒ `main-checked-out`-class
   refusal with code `worktree-probe-failed` (fail closed: the module
   could not prove no checkout).
   `update-ref` moves the ref only — a checked-out `main` would show its
   working tree as wholesale reverted/advanced against a reality it
   never saw, and a later operator commit there could launder that
   state. Syncing a foreign worktree is outside this module's authority
   (P12's cycle-2 F3 note, ported verbatim), so the act REFUSES
   (`main-checked-out`) and the operator moves that checkout first.
   TOCTOU honesty: a checkout armed AFTER the probe is inside the same
   accepted-race class as the journal⇄ref race below — a single act
   resolves refs once and writes once; it never loops.
2. **Build the candidate IN THE OBJECT STORE ONLY** (no index, no
   worktree touched — probe-verified clean: `merge-tree` under
   `--write-tree` mutates neither): `git merge-tree --write-tree <M>
   <E>` runs the real merge algorithm against the two commits. **A
   conflict is detected BOTH ways — never one alone** (probes on the
   lab git: clean merge → exit 0, exactly one line, the merged tree
   sha; conflicting merge → exit 1, 10/10 runs, printing the
   conflicted tree followed by stage-entry/conflict-info lines):
   non-zero exit OR line count > 1 ⇒ abort (`conflict`) before any
   `commit-tree`, before the gate, before the INTENT/OUTCOME write
   (v11, cycle-6 major 5 — NOT "before any journal write": the
   claim record was appended before construction and is DURABLE
   here; a conflict BURNS its claim, r-gap disclosed — the v10
   wording contradicted the claim-before-construction invariant).
   Both
   signals, not one: an early probe of the SAME conflict printed
   exit 0 while ten consecutive reruns on the same git all returned
   exit 1 (cause never pinned — exactly the kind of unreproducible
   single-signal observation a two-signal check survives); the
   implementer pins exact framing against the installed git in test
   before relying on the parse at all; never
   auto-resolved, `--rerere` never
   consulted. (The conflicted TREE git writes to the object store on
   that path is harmless garbage — no commit object, no ref, never fed
   forward.) On `M == E` AND no open tail intent for this actionId
   (v12, cycle-7 major 6 note: the PRIMARY `M == E` check is
   position 1a of the SINGLE ORDERED PROCEDURE — refs-only,
   pre-claim, journal-write-free; this step-2 occurrence is only
   the defensive re-check of the snapshot value and is UNREACHABLE
   for a fresh act that followed the procedure, since 1a already
   returned; an open tail intent goes through step 5b recovery
   FIRST — cycle-1 minor: landing makes main equal `C`, a TWO-parent
   commit, NEVER equal `E`, so the graph-no-op can never stand in for
   a landed intent; recovery of an open intent is by candidate
   descent, step 5b, not by tip equality) the module stops HERE
   with `already-merged`
   (v4, audit major 4): `commit-tree` with two identical `-p` flags
   ignores the duplicate and mints a ONE-parent commit (reproduced on
   git 2.54 — "duplicate parent ignored") — a commit §1.2's
   two-parent provenance rule would refuse at rollback, so the gate
   must never run on it and the CAS must never advance to it. An
   already-current main is not a promotion. Then `git commit-tree
   <mergedTree> -p <M> -p <E>` with the
   promotion trailer (§1.3) → candidate commit `C` (parentage + trailer
   probe-verified; the later revert construction is tree-exact vs the
   recorded pre-image).
3. **Journal the INTENT** (docs/16 §2 pattern) — v10, cycle-5
   major 1 places this AFTER the CLAIM: the act's claim record
   `actionId#r<n>@claim` was already appended at the claim step
   (position 2 of the SINGLE ORDERED PROCEDURE above — after the
   `M == E` no-op check, before construction; allocating `r`
   before any trailer-bearing
   construction — see the step-0 identity discipline); this intent
   record (id `actionId#i<n>`, v12 scheme)
   records the SAME allocated `n`. actionId = sha256 over the
   ENUMERATED identity fields (NOT "all frozen fields except") per
   the step-0 discipline above (v9, cycle-4 minor 4; v10, cycle-5
   blocker 3 — the enumeration replaces the exclusion-list
   wording);
   intent record carries `M`, `E`,
   `C`.
4. **Gate** runs against `candidateSha: C` with the per-call deadline
   floor (hung runner ⇒ `gate-timeout` is a documented negative).
   Gate result must bind to C's exact sha.
5. **CAS advance** `refs/heads/main`: `update-ref --no-deref
   refs/heads/main C M` (literal old-value). **`--no-deref` is
   load-bearing, not styling** (v3 / round-2 blocker R2-B2): plain
   `update-ref` follows a symbolic ref — reproduced on the lab git 2.54,
   a symref `main → other` makes `update-ref refs/heads/main C M`
   advance `other` while `main` keeps pointing elsewhere (and the
   rename-free CAS never ran). The resolve stage therefore refuses `main`
   as a symbolic ref (P12's `resolve:episodeBranch-symbolic-ref` probe,
   ported); a symref installed after the probe yields a numeric CAS
   rejection (a `"ref: …"` line can never equal the sha old-value — exit
   1, provable no-effect; the same belt P12 ships at its CAS).
   Provability is the docs/15 §4 step-7 table:
   clean numeric CAS rejection with the observable head = the only
   provable `no-effect:`; landed-then-moved, unreadable head, and ANY
   unreported CAS exit (kill/timeout, `close:aba` included) are
   `act-unknown:`.
6. **Journal the OUTCOME** (+ acceptance record on `merged`, as P12).

**5b. Recovery of an open tail intent (v5, audit major 5 — P12
docs/16 §2 step 2 ported):** when step 0 found an OPEN intent, its
recorded `candidateSha`/`M`/`E` are compared against observed reality
BEFORE the `M == E` shortcut may fire: `merge-base --is-ancestor C M`
(the intent's recorded candidate vs the CURRENT main) — descended ⇒
close the intent with an acked OUTCOME **of kind `merged` with
`recovered: true` + the provenance note** and return status
`recovered`; not
descended ⇒ `refused(intent-open)` with zero side effects (NEVER
re-run the act on someone else's intent). A `recovered` outcome is
FULLY EQUIVALENT to a landed one downstream (v6, cycle-1 major 5):
it is the TERMINAL `merged` record §1.2's provenance checklist
resolves, and the acceptance record P12 writes on `merged` (step 6)
is written for it too — recovery is the module OBSERVING its own
landed work, so a promotion that crashed between CAS and outcome
must stay revertible through the prescribed module, not become
unrevertible by the accident of when the process died. Test pin (§3):
crash after CAS before outcome ⇒ recovery ⇒ `rollbackPromotion`
(default mode) succeeds against the recovered record. The equal-tips `M == E`
no-op answers only requests with NO open intent (v7, cycle-2 minor 1 —
fixing the v6 residual at THIS occurrence, which C1-m1's disposition
claimed but did not reach): landing makes `main == C` (the two-parent
merge), NEVER `main == E` — so if an open intent finds `M == E`,
main arrived by an entirely different route and the graph equality is
NOT that intent's landing; a shortcut ahead of recovery would answer
`already-merged` while the intent's own candidate was never landed,
stranding it — exactly the class P12's cycle-4 F1 pins
(`merge.ts:693-698` runs recovery ahead of its own `already-merged`
shortcut; v4's unconditional no-op reintroduced the stranding).

**If `main` moved between steps 1 and 5:** CAS rejects (or the exit is
unreported ⇒ `act-unknown:` — reconcile by probe, NEVER blind-retry);
the module does NOT auto-rebuild. A `no-effect:` rejection is answered
by an OPERATOR re-issue (v10, cycle-5 minor 4 — reworded: a re-issue
is a fresh act at the journal-ALLOCATED next `r`; a caller MAY carry
the expected suffix in `executionSeq` to detect staleness, but
bumping it is neither possible nor meaningful as disambiguation —
allocation is by max+1; fresh candidate,
fresh gate — stale gate evidence for a stale `M` is never reused).
`already-executed` sticky terminals and the tail-intent closure rule
(docs/16 §2, cycle-4 F1) copy verbatim — and v5 pins their PRECEDENCE
explicitly (step 0/5b): sticky terminals stop replays but never strand
a tail intent; recovery outranks every equality/terminal shortcut.

Statuses (closed union, P12-shaped): `merged | already-merged |
recovered | conflict | gate-failed | refused | failed` — final table
frozen at contract sign-off; `stage` names the last step reached.
One replay contract, pinned (v5, audit major 6 — v4 made these collide):
an **idempotent re-issue whose journal holds a terminal `merged`** for
this actionId is `refused(already-executed)` EXACTLY as in P12 (a
sticky terminal, `stage: "dedup"`, `outcomeDurable: true`) — the
replayed request is a refusal with the recorded outcome attached, NOT
a fresh `already-merged`. `already-merged` names ONE fact: the
graph-level no-op `M == E` (v4, with the v5 recovery precedence of
step 5b — main already at the episode tip; no candidate is built, no
gate runs, no journal write; the outcome is re-derivable from the
refs, durable without reconciliation — P12's `already-merged` has no
journal write either, `merge.ts:687-690`).
NEVER throws (§5-fence, docs/15 E5 pattern); `outcomeDurable: false`
⇒ reconcile, never re-run. (Promotion adds `execution-seq-mismatch`
(v9, cycle-4 major 5 — a supplied expectation ≠ the journal-allocated
`r`; named in the union here so every code used in §1.1 is defined);
Rollback adds `revert-conflict`, `rewind-blocked`, and
`already-rolled-back` (v6, cycle-1 M3 — the tree-equality no-op class);
both modules share `unverified-provenance`,
`routing-poisoned`, `no-main`, `main-checked-out`.)

**CLOSED CODE CENSUS (v14, cycle-9 minor 6 — every code emitted by
ANY §1.1 path, in one list; implementer greps this census, not the
prose; v15, cycle-10 major 5 RECONCILED against every live emit
site — v14's list omitted `lifecycle-blocked` (ClaimOutcome),
`not-replayable` (§1.1 step 0 / §1.2), the revoke-class
`refused(fence-lost)` (line "revoke result contract likewise gains
`refused(fence-lost)`"), and MISCLASSIFIED
`journal-unreadable:duplicate-ids` as non-result while §3 pins
claim-bearing acts EMITTING `refused(journal-unreadable:duplicate-
ids)` as their act result):** `failed(...)` reasons: `ambiguous`
(claim/append, with the `ambiguous: true` flag),
`abandon-ambiguous`, `fence-lost` (claim-bearing act classes),
`post-construction-checklist`; `refused(...)` reasons:
`intent-open`, `already-executed`, `lifecycle-blocked`,
`not-replayable`, `execution-seq-mismatch`,
`revert-conflict`, `rewind-blocked`, `already-rolled-back`,
`unverified-provenance`, `routing-poisoned`, `no-main`,
`main-checked-out`, `worktree-probe-failed`, `revoke-target-not-found`,
`revoke-target-not-outcome`, `revoke-target-not-recovered`,
`already-revoked`, `revoke-target-not-rollback`, `fence-lost`
(REVOKE-class only — a fence-lost revoke REFUSES, it never claims
to have failed a write; the same reason string appears under BOTH
unions by act class — the census is closed, the CLI exit code is
per-result-STATUS: exit 1 iff the act result is `failed(...)`,
exit 2 iff `refused(...)`), `journal-unreadable:duplicate-ids`
(NOW a refused ACT RESULT per the §3 duplicate-ids pin — every
claim-bearing act on a duplicate-id journal returns
`refused(journal-unreadable:duplicate-ids)`; the NON-RESULT note
applies only to the raw journal-READ error, which the wrapper
converts to this refused result), `journal-corrupted`,
`journal-quiescing`, `lease-unavailable`, `lease-closing`.
Non-result codes (NOT act results — surface elsewhere):
`epoch-contention` (lease ACQUISITION failure, §1.1 epoch supplier —
no act was admitted); the `TakeoverResult` aborted-reason union
(`lease-stolen-precheck`, `lease-swapped-post-reclaim` (v17,
cycle-12 major 1), `ledger-malformed`, `journal-corrupted`,
`duplicate-ids-at-takeover`, `epoch-contention-step6`,
`io-failure`) is a SEPARATE CLOSED UNION (v17, cycle-12 major 6 —
the closure fixture covers BOTH unions: every TakeoverResult
reason constructible, none outside the list; ONLY
`journal-corrupted` appears in both planes (the takeover-union
member AND the act-scope refused code — same string, different
union, discriminated by the payload `status` field (`aborted`
vs `refused`)) — `journal-quiescing` is an ACT and STATUS
result ONLY and is NOT a TakeoverResult member: failed
quiescence is never terminal (step 4b waits; v15), so no
takeover aborts with it, and the closure fixture asserts its
ABSENCE from the takeover union (v18, cycle-13 major 6 — v17's
"both appear in both planes" sentence overclaimed). CLI rendering (§1.4): each
`refused(reason)`/`failed(reason)` renders its machine code verbatim
in the exit payload (`{ok:false, status, code, stage}`) with exit
code 1 for `failed` and 2 for `refused` (AN M3-DENERATED
CONVENTION DEFINED HERE — v20, cycle-15 minor 1: v19 called this
"P12's convention", but the full sweep of docs/16 shows the P12
module defines IntegrationResult STATUSES and git-command exit
handling, NOT a CLI exit-code convention; the rule below is
M3's own);
`journal-corrupted`/`journal-quiescing` additionally print the
operator remedy line; no code is collapsed, aliased, or dropped at
the CLI boundary. §3 pins: the census is CLOSED — a fixture asserts
every listed code is constructible and every constructed code is in
the list (greppable table test).

### 1.2 Rollback: `rollbackPromotion(req, ports)`

Same module. v1 proposed `git revert -m 1` "on a fresh index" —
REJECTED in v2: `git revert` is porcelain that runs IN THE WORKTREE —
probe on git 2.54: a successful revert rewrites the working-tree file
(and the index), the merge backend writes state into the git dir
(`.git/AUTO_MERGE` observed), a conflicted one leaves conflict
markers + conflict state for an operator to clean, and there is no
way to run it object-store-only; v1 also
never proved the supplied sha IS an authorized promotion. v2 replaces
both.

**Provenance BEFORE anything else.** The request supplies
`promotionActionId`; the module resolves the promotion exclusively
from its own journal and verifies, ALL must hold or `refused` with
code `unverified-provenance`:

- the journal holds a TERMINAL `merged` promotion record for that
  actionId in THIS episode's journal (journal read is the P12 port);
- `git cat-file -e <candidateSha>` — the recorded candidate exists;
- the candidate is a MERGE COMMIT (exactly 2 parents);
- its first parent equals the journal-recorded pre-promotion main sha
  `M`, and its second parent equals the recorded episode tip `E`;
- the commit carries the promotion trailer with the matching
  `episodeId` and `actionId` (§1.3) — parentage alone is NOT taken as
  promotion evidence (any contributor can author an accidental
  first-parent merge); **AND its `seq` EQUALS the `r` of the
  resolved terminal promotion EXECUTION being rolled back (v11,
  cycle-6 major 4: one logical promotion can have multiple
  execution records after no-effect replays; §1.3 added `seq`
  precisely to identify an execution, so the checklist that claims
  "full binding" must compare it — a trailer bearing a DIFFERENT
  execution's seq is `unverified-provenance`, whatever the §1.3
  note below reads; likewise the rollback candidate's own trailer
  binds `promotion=<actionId>@<r>` to the SELECTED terminal
  promotion execution and `exec=` to its own claim-allocated
  `r` — the two suffixes generally differ and BOTH are checked at
  their own sites)**
  — the §1.3 note "a trailer is not a security boundary" is about
  forgeability, NOT about which fields are compared: every field
  §1.3 defines is compared (v11);
- **the candidate is an ANCESTOR of the CURRENT main tip**
  (`merge-base --is-ancestor <candidateSha> refs/heads/main`) — v6,
  cycle-1 major 3: without this, a promotion later REWOUND or dropped
  by an operator history-change still passes every journal-side check
  while its "inverse delta" applies the candidate's base to an
  unrelated current tree — a clean merge would gate and land a commit
  changing content no current-main promotion introduced. A promotion
  not in current history ⇒ `refused(unverified-provenance)` naming
  `promotion-not-ancestor-of-main`. (Rewind's own pin, below, is the
  narrow CURRENT case. **v8 scoping, cycle-3 major 3: the ancestor
  bullet applies to `revert` mode at step 0c; `rewind` mode's
  currency proof is its `expectedMainTip == candidateSha` pin, and
  the sticky 0b lifecycle check runs BEFORE this bullet in BOTH
  modes, so a post-rewind repeat never reaches a misleading
  `unverified-provenance` — the journal answers first.)**
- **the promotion has NO completed rollback of its own** — durable
  lifecycle, NOT tree algebra (v7, cycle-2 major 3): the rollback act
  journals its acked outcome keyed by the promotion's actionId, and
  that record IS the lifecycle fact. A second `rollbackPromotion` of
  the SAME promotion actionId ⇒ `refused(already-executed)` pointing
  at the prior rollback outcome (sticky, exactly like promotion
  dedup). v6 tried to detect repeats by tree equality (the revert
  constructing an empty delta against current main) — REJECTED:
  ancestry survives reverts, and after the change is REINTRODUCED
  (a revert-of-the-revert, or a fresh promotion of the same content)
  the same actionId's inverse delta is NONEMPTY again — tree
  equality would then roll back the NEW landing, silently
  undoing independently-gated work, and an unrelated edit can just
  as easily turn the pinned no-op into a conflict. Tree equality is
  retained ONLY as what it can actually prove: an EMPTY-DIFFERENCE
  pre-construction no-op (`already-rolled-back`, `already-merged`
  class, no gate, no CAS) — an honest optimization for the settled
  case, never the lifecycle decision. Lifecycle questions are
  answered by the journal, content questions by the merge. A
  REINTRODUCTION of a rolled-back change is a NEW promotion act on a
  NEW episode branch with a NEW actionId (and a new gate); the
  old actionId is permanently spent. Rollbacks of rollbacks are not
  a thing: `R` is not a promotion record, so `rollbackPromotion`
  against it fails `unverified-provenance` (no promotion trailer,
  no promotion journal entry). Pins (§3): repeat rollback of the
  same actionId after a reintroduce lands as `refused(already-executed)`,
  NEVER a gated delta; empty-difference case ⇒ `already-rolled-back`;
  fresh promotion of reverted content ⇒ proceeds normally.
- **Journal precedence for the rollback act itself (v8, cycle-3
  major 3 — the v7 text made only an ACLED rollback outcome the
  lifecycle fact and left crash windows undefined: an implementer
  could re-land an already-landed inverse, strand its open intent,
  or refuse a provably-no-effect retry; and a rewind makes the
  promotion non-ancestor, so naive ordering masks the sticky
  already-executed behind `unverified-provenance`). The rollback act
  carries its OWN request `actionId` (logical identity per the §1.1
  step-0 identity discipline — the enumerated identity fields
  `{episodeId, promotionActionId, mode}`; `now`/`grantedBy`/
  `executionSeq`/pins EXCLUDED, v10 cycle-5 blocker 3)
  and journals intent/outcome for execution `actionId#r<n>` —
  record ids `actionId#i<n>`/`actionId#o<n>` per the v12 id scheme
  (§1.1 schema block) — with the SAME
  dedup/recovery doctrine as §1.1 — ordered explicitly:**
  0a. **Own-record dedup/recovery FIRST** (keyed by the rollback's
  own logical actionId — under the revocation projection above: a
  REVOKED terminal does not count as acked, v11 cycle-6 blocker 2):
  acked outcome ⇒ `refused(already-executed)`
  sticky; open intent ⇒ recovery by observed reality (candidate `R`
  descended ⇒ terminal `merged(recovered)`; not descended ⇒
  `refused(intent-open)`); un-acked `no-effect:` ⇒ F2-style replay
  against current reality with a new `#r<n>`; un-acked unmarked ⇒
  `refused(not-replayable)` — the §1.1 precedence verbatim, EXCEPT
  for `rewind` mode's landing proof (v9, cycle-4 blocker 3 — a
  rewind's CAS target is the promotion's `M`, and `M` is an ANCESTOR
  of `C` before the CAS ever runs, so "target descended into main"
  is vacuously true pre-landing and would ack a rollback that never
  happened): a rewind intent records target `M` and candidate `C`;
  recovery proves landing by TIP IDENTITY — `main == M` exactly ⇒
  terminal `merged(recovered)`; `main != M` (still `C`, or moved
  elsewhere) ⇒ `refused(intent-open)`, NEVER an ack. The
  `main == M` proof carries a disclosed ABA residue, and the
  disclosure is now stated at full strength (v10, cycle-5 major 3
  — the v9 sentence "strictly worse than a stale `already-executed`
  on a state content-identical to the rollback's own effect"
  UNDERSTATED the consequence): the ack is a DURABLE LIFECYCLE
  ASSERTION, not just a tree observation — if an operator
  independently moved main `C → M` after the intent but before
  recovery, recovery records terminal `merged(recovered)` for a
  rollback that NEVER RAN, permanently spending P's rollback
  lifecycle; if main is later restored to `C` by an independent
  history movement, a NEEDED rollback of P is sticky-refused
  `already-executed` forever. Accepted trade (the conservative
  alternative — never ack on `main == M`, force operator action —
  was weighed against this false-attribution path and rejected as
  strictly worse in the COMMON case: an honest post-CAS crash also
  shows `main == M`, and refusing it would strand every ordinary
  rewind recovery behind operator surgery). Operator remedy
  (pinned, FULLY DEFINED v11, cycle-6 blockers/majors 1-3 — the v10
  one-liner was not implementable):
  - **Act:** `--revoke-rollback-recovery <rollbackActionId>#<r>` —
    ONE COMPLETE GRAMMAR (v16, cycle-11 minor 5): this positional
    spelling is EXACTLY the T1 target form of §1.4 — writing
    `--revoke-rollback-recovery A#r` is sugar for
    `--revoke-rollback-recovery --exec A#r`; the full accepted
    invocation is `--revoke-rollback-recovery (--exec
    <actionId>#<r> | --target-id <fullRecordId>)` with EXACTLY
    ONE of the two target args (positional = `--exec`, mutually
    exclusive with `--target-id`; both or neither ⇒ the same
    usage error exit 2, no act — §1.4, cycle-10 major 4). The
    target is the ROLLBACK EXECUTION's identity (the false
    terminal `merged(recovered)` belongs to the ROLLBACK act and
    carries the ROLLBACK's own allocated `r`; v10 wrote
    `<promotionActionId>#<r>`, ambiguous between the promotion's
    execution and the rollback's — resolved: the reference is the
    exact `actionId#r` of the recovered OUTCOME record, the same
    identity the sticky dedup keys on, so there is exactly one
    selectable target).
  - **Record:** appends `recovered-revoked` (a new journal RECORD
    KIND, see the schema block in §1.1) referencing the target
    outcome's record id; it NEVER rewrites or deletes the revoked
    outcome (audit history preserved — append-only, I4).
  - **Journal projection (the operative semantics — v11, cycle-6
    blocker 2: a valid revocation SUPERSEDES its target terminal in
    EVERY lifecycle reading, both 0a and 0b/0a′):** the projection
    walks the journal once; a `merged(recovered)` outcome whose
    record id is referenced by a later `recovered-revoked` record
    is treated as NEVER WRITTEN for lifecycle purposes — 0a own-
    record dedup: the revoked identity no longer maps to a sticky
    `already-executed`, the same-mode retry re-enters as a fresh
    act (its CLOSED intent stays closed — the revoked execution is
    not revived, a NEW `#r` allocates); 0b promotion lifecycle:
    the revoked terminal is not a "TERMINAL ACLED rollback
    outcome," so P's rollback lifecycle reopens for any identity;
    0a′ open-intent scan: unchanged (a revoked execution's intent
    was resolved by the recovery, not left open). An ACLED
    `merged` (non-recovered) outcome is NEVER revocable —
    `recovered-revoked` targets ONLY outcomes with
    `recovered: true` (a real landed rollback stays spent).
    **ROLLBACK-SHAPE REQUIREMENT (v12, cycle-7 major 1 — the v11
    validation stopped at "recovered outcome", but a plain
    PROMOTION that crashed after its CAS recovers as a
    `merged(recovered)` outcome too (step 5b); the stated
    validation would accept it and the projection would reopen
    the PROMOTION's own sticky merged lifecycle — outside the
    act's declared rollback-only scope. The target's execution
    `(actionId, r)` must resolve to an INTENT record `actionId#i<r>`
    carrying the ROLLBACK shape (a promotion reference +
    `mode ∈ {revert, rewind}` — §1.2's intent records are that
    shape; promotion intents record `M`/`E`/`C` and carry no
    promotion reference): a recovered outcome whose execution's
    intent lacks the rollback shape ⇒
    `refused(revoke-target-not-rollback)` — fifth refusal class,
    §3 pins the promotion-recovered-target negative fixture
    byte-for-byte.**
  - **Eligibility/validation & repeat behavior (v11, cycle-6 major
    3):** target must exist, be an outcome record, and be a
    RECOVERED terminal — otherwise the act is a no-op refusal
    naming the reason (`revoke-target-not-found` — no record with
    that id; v13, cycle-8 minor 5 gives the non-outcome case its
    OWN code, v14 cycle-9 major 5 MAKES IT REACHABLE (the two
    target forms are named T1/T2 to avoid colliding with the
    fresh-execution F1/F2/F3 path labels of step 0; v15,
    cycle-10 major 4 GRAMMAR FIXED — v14's binding text required
    a T2 record's execution prefix to match "the request's named
    execution," but a revoke request NAMES no execution besides
    its target, and the T2 list included `revoke-<ulid>`, which
    has no execution prefix at all — self-contradictory): the
    revoke CLI takes EXACTLY ONE of two mutually exclusive target
    arguments — `--exec <actionId>#<r>` (T1: an EXECUTION
    identity, resolved deterministically to `A#o<r>`; on a
    CONFORMING journal that id is either an outcome or absent —
    the duplicate-id rule forbids it naming anything else) OR
    `--target-id <fullRecordId>` (T2: a FULL, EXECUTION-SCOPED
    RECORD ID matching the grammar `actionId#...`, i.e.
    `A#i<r>`, `A#r<n>@claim`, or `A#r<n>@abandon`, naming one
    record DIRECTLY; a `revoke-<ulid>` marker id is NOT a legal
    `--target-id` value — it matches no record-kind grammar, so
    the CLI rejects it as a USAGE error (exit 2, usage text)
    BEFORE any act runs — no census code minted, a revoke marker
    is never a revocation target); a T2 record carries its OWN
    `(actionId, r)` in its id, and THAT is the request's
    execution context (provenance and confirmation display
    derive from the named record itself — there is no second
    execution to bind against, which is why v14's binding
    sentence is withdrawn rather than repaired); a T2 id
    resolving to a surviving non-outcome
    record ⇒ `revoke-target-not-outcome` — the §3 fixture uses
    T2 (`revoke --target-id A#i1`, no other target argument) on
    an intent of a completed execution: a real,
    conforming, reachable target that is not an outcome; T2 does
    NOT weaken fail-closed — malformed/duplicate ids are still
    journal-level refusals, T2 only names VALID records of the
    wrong kind. CHECK ORDER, PINNED (v15, cycle-10 major 4 —
    multi-condition targets previously had no first-match rule;
    two conforming implementations disagreed): existence →
    record-kind (`not-outcome`) → rollback-shape (`not-rollback`)
    → recovered-terminal (`not-recovered`) → revocation-marker
    (`already-revoked`); a NON-RECOVERED plain-promotion outcome
    therefore answers `not-rollback` (shape beats state), and §3
    pins that exact multi-condition input;
    `revoke-target-not-recovered` — an outcome but not a RECOVERED
    terminal, incl. an ACLED `merged`); a SECOND revoke of an already-
    revoked target ⇒ `refused(already-revoked)` (idempotence is
    refusal, not a second marker — two markers would make the
    projection's supersede ambiguous); an ordinary non-recovered
    terminal ⇒ `revoke-target-not-recovered`; a RECOVERED but non-
    rollback-shape outcome ⇒ `revoke-target-not-rollback` (above).
    FIVE distinct refusal CODES (v13, cycle-8 minor 5: not-found /
    not-outcome / not-recovered / already-revoked / not-rollback —
    five conditions, five codes, the §3 fixture pins each
    separately; v11-v12 counted "four classes" while giving two
    conditions one code, which cannot pin separately); The revoke act runs
    through the SAME `withClaimLock` domain as claims (append under
    the writer chain; it claims no `r`), ordering against
    concurrent claims is the writer order, and its result contract
    is `{revoked: <outcomeId>} | refused(<reason>)`. §3 pins crash
    BEFORE and
  AFTER the rewind CAS separately AND the operator-move-before-
  recovery → later-restoration → sticky-refusal → revoke sequence,
  BOTH-mode retries after revoke, and the FIVE invalid-target
  refusals (v11's four + v12's `revoke-target-not-rollback`).
  0a′. **Open-intent guard across identities (v9, cycle-4 major 4):
  BEFORE executing any NEW rollback identity against promotion `P`,
  scan the journal for an UNRESOLVED intent from ANY rollback act
  naming `P` (a different logical actionId — e.g. the first attempt
  chose `revert`, the retry asks `rewind`; CLAIM records never
  count as unresolved intents — allocation artifacts answer no
  lifecycle question, v10): found ⇒ that intent is
  resolved FIRST by ITS OWN recorded mode's recovery rule (0a, with
  the rewind proof above); still unresolved ⇒ `refused(intent-open)`
  — two concurrent rollbacks of one promotion can never both reach
  construction, whatever identities they carry. **ATOMICITY
  (v10, cycle-5 blocker 2 — a scan OUTSIDE the writer is TOCTOU:
  two calls with different identities can both scan, both see
  nothing, and both append — per-instance append serialization
  never makes the promotion-scoped check atomic, evidence:
  `src/episode/journal.ts:602-606` serializes per instance under
  the exclusive-writer fence (P7); `src/integration/merge.ts:264-
  267` exposes read and append as separate ops). The 0a/0a′/0b
  eligibility RE-EVALUATION and the CLAIM APPEND form ONE
  writer-serialized transaction inside the episode journal's
  fenced domain (the same premise docs/16 pins for P12 — a host
  running two acts against one journal unfenced violates P7 and
  is out of contract): claim-eligible re-scan (this actionId's
  records + unresolved intents naming P, claims+intents) then
  append, atomically as seen by any other claim transaction — via
  the `withClaimLock` primitive (§1.1), NOT a read-then-append
  sequence, which is illegal for claims even INSIDE one fenced
  owner: the fence excludes another OWNER, not two concurrent
  async calls of the same owner (v11, cycle-6 major 1); the
  second racing act's transaction re-scans INSIDE the writer,
  SEES the first act's claim record (a claim names its promotion —
  `@claim` records carry `{actionId, r, promotion, ownerEpoch}`,
  v11), and refuses per 0a′/0b — UNLESS the claim is epoch-stale,
  which the eligibility rule treats as ignorable with its `r`
  burned (v11, cycle-6 blocker 1: a LIVE paused owner refuses the
  second act; a CRASHED owner's unconverted claim never strands
  the lifecycle — the ownerEpoch decides, never intent-absence). Pin (§3): two calls paused AFTER both initial
  scans, released together ⇒ exactly one claims; the other
  re-evaluates and refuses — never constructs a second inverse.**
  0b. **Promotion lifecycle SECOND** — checked BEFORE the ancestor
  test, so the sticky lifecycle answer survives a later rewind: the
  promotion's journal shows a TERMINAL ACLED rollback outcome ⇒
  `refused(already-executed)` (both modes, rewind included — "this
  promotion's rollback already ran" is the answer even when main no
  longer descends from the candidate; a REVOKED recovered outcome
  does not count here — the revocation projection governs 0a AND
  0b/0a′ alike, v11 cycle-6 blocker 2).
  0c. **Structural provenance + ancestor check THIRD** (the v6 list;
  rewind-mode 0c checks the promotion's shape + recorded `M`,
  because after a rewind the ancestor fact is by-definition gone —
  the rewind request's `expectedMainTip == candidateSha` pin is its
  currency proof, and the v6 ancestor bullet stays scoped to `revert`
  mode, stated so in its text).
  0d. **Empty-difference no-op FOURTH** (content optimization only,
  after 0a–0c pass; it runs AFTER the claim transaction because it
  requires building the inverse TREE — a construction-side check —
  so an empty-difference no-op BURNS its claim, v11 cycle-6 major
  5, same disclosed-gap treatment as `conflict`). Pins (§3): crash between rollback CAS and acked
  outcome ⇒ own-record recovery lands terminal `merged(recovered)`
  AND writes the lifecycle marker — a THIRD request gets
  `already-executed`, never a re-land; rewind-then-repeat-rollback ⇒
  `already-executed` from 0b, NOT `unverified-provenance`; CAS-
  rejected `no-effect:` rollback replayed ⇒ proceeds (F2), its
  journal execution id `…#r2` (records `…#i2`/`…#o2`, v12 scheme).

**Construction (object-store only, no index, no worktree, no
sequencer state):**

- **`revert` (default, works even with later main commits):** the
  inverse-apply merge expressed with explicit base —
  `git merge-tree --write-tree --merge-base=<candidateSha> <currentMainTip> <firstParentSha>`
  (git ≥ 2.38 `--merge-base`, trees only). Any conflict (same both-ways
  detection as §1.1 step 2)
  aborts clean (`revert-conflict`; operator resolves manually — never
  auto). On
  success `git commit-tree` with parent `currentMainTip` and the
  `Tre-Rollback:` trailer (§1.3) → rollback commit `R`.
  **PRE-GATE CHECKLIST PASS ON R (v12, cycle-7 major 5 — the
  provenance checklist v10–v11 describes lives entirely on the
  CANDIDATE side; the gate sits between construction and CAS, and
  the contract never said the constructed artifact `R` is
  re-verified, so a construction bug (wrong trailer fields, wrong
  parent) would be gated and CASed. The contract names the site:
  IMMEDIATELY after commit-tree and BEFORE any gate invocation,
  the act re-runs the FULL §1.2 checklist against R itself —
  trailer parses, `episodeId`/`actionId` match the request,
  `promotion=<actionId>@<r>` binds the SELECTED terminal promotion
  execution, `exec=` equals THIS act's claim-allocated `r`
  (§1.3's field set), parent equals the snapshot `currentMainTip`
  the inverse was built against. Any mismatch ⇒
  `failed(post-construction-checklist)` — a PRE-INTENT return
  (v13, cycle-8 major 4: the checklist sits at the END of
  procedure position 3, BEFORE position 4's intent append, so
  the abandonment transition governs: the claim is ABANDONED
  with reason `pre-intent-error` and the act RETURNS the failure
  as its result — NO intent, NO outcome record, NO journal
  terminal; v12's "a terminal outcome journaled under the
  normal intent/outcome discipline" contradicted the ordering
  and is corrected); NO gate
  run, NO CAS; §3 pins a doctored-trailer construction (test
  seam) refuses with zero ref movement AND zero gate invocations
  AND — v13 — journals ONLY the `@abandon` record (intent/outcome
  records both ABSENT, pinned).**
  **R is then gated**
  exactly like a promotion candidate (its content is new when main
  moved — the merged result was never tested as-is), then CAS:
  `update-ref --no-deref refs/heads/main R <currentMainTip>`, same
  provability table, same intent/outcome journaling, and the SAME
  symref / checked-out-`main` guards as §1.1 (v3 — both acts mutate
  main's ref; a rollback that "lands" in a worktree still showing the
  promoted content is the same illusion R2-M5 refuses to create).
- **`rewind` (narrow, history-erasing):** CAS
  `update-ref --no-deref refs/heads/main <M> <promotionSha>` (same
  v3 no-deref rule) — permitted only
  while the promotion is current (request `expectedMainTip` pin must
  equal the candidate sha; head moved ⇒ `rewind-blocked`). No gate run
  needed: the restored content is by construction the pre-promotion
  state. Rewind is the escape for "promoted wrong minutes ago, nothing
  since", NOT the default.

Both modes: `mode` is a closed union inside the request (NOT caller-
chosen target); same never-throws fence; same evidence doctrine.

### 1.3 Commit trailers (v2 addition — durable, verifiable binding)

Promotion commits carry, in the message body:

```
Tre-Promotion: episode=<episodeId> action=<actionId> seq=<allocatedR>
```

`seq` is the ALLOCATED `r` of THIS execution (never the request's
optional expectation, v10, cycle-5 major 3). Rollback commits carry
`Tre-Rollback:` with TWO distinct identities (v10, cycle-5 major 3 —
one `seq` cannot name both: a rollback execution's allocated suffix
generally differs from the promotion's):

```
Tre-Rollback: episode=<episodeId> promotion=<promotionActionId>@<promotionR> exec=<rollbackActionId>#<rollbackR>
```

the first pair naming the promotion undone (reference), the second
naming THIS rollback execution. Trailers are the git-side half of
the binding journal ⇄ commit ⇄ parentage; §1.2 refuses on mismatch.
(A trailer is
not a security boundary — inside the threat model §1.0 it makes
mis-aimed rollback and post-hoc audit mechanically checkable without
the journal being the only copy.)

### 1.4 Host path & the Q5 human gate (D2)

The module enforces nothing about WHO signed (§1.0); the human gate is
structural: **v1 ships exactly one caller** — an explicit operator CLI
act (`tre. activate --promote-episode <id> --episode-branch <name>`,
plus `--rollback-promotion <actionId> [--mode revert|rewind]`, plus
the audit/lifecycle-correction act `--revoke-rollback-recovery
<rollbackActionId>#<r>` (v10, cycle-5 major 4; target refined v11,
cycle-6 major 3 — the argument is the ROLLBACK execution's own
`actionId#r`, the exact identity the sticky dedup keys on, so the
false terminal is uniquely selectable — see §1.2's revoke contract)
— the ONLY path
around a false-attribution `merged(recovered)` ack; appends a
`recovered-revoked` journal marker reopening the promotion's
rollback lifecycle; module-NEVER-automatic, TTY-confirmed like the
rest)), which
refuses to run without a TTY-confirmed operator prompt (Q5's human
gate lives in the host, not the leaf). `autoMergeTested` (docs/11
§14.7) stays admission-side (episode integration), and `promoteToMain:
"auto"` is honored by NO host path in v1 — declarative only, until
§11.4 operating evidence exists. When auto later ships the module
contract is unchanged; only the caller list grows.
**CLI RESULT RENDERING & TARGET FORMS (v14, cycle-9 minor 6 /
major 5):** every act prints its machine result code verbatim in a
structured exit payload `{ok, status, code, stage, ...}` — exit 0
success statuses, exit 1 `failed(...)` (reason as `code`), exit 2
`refused(...)` (the M3 convention defined at the §1.1 census's CLI
rendering — NOT a P12-module rule; cycle-15 minor 1); USAGE
ERRORS ALSO EXIT 2, so
THE PAYLOAD `status` FIELD IS THE MACHINE DISCRIMINATOR (v16,
cycle-11 minor 3): a usage error prints
`{ok:false, status:"usage", code:"usage-error", stage:"cli-parse",
message}` BEFORE any act exists (never a census member — the
census covers act results only; `status:"usage"` is outside the
act-result union, not inside it), a refused act prints
`{ok:false, status:"refused", code:<census code>, stage:...}`;
consumers branch on `status` FIRST, then `code` — exit code alone
NEVER disambiguates (pinned); §3 fixture asserts the three
families are pairwise distinguishable on the payload, not on the
exit code; THE OPERATOR SURFACE IS ITS OWN PLANE (v19, cycle-14
minor 5 — §1.1's OPERATOR RECOVERY SURFACE is not an act and its
result payload NEVER joins these three families: operator-mode
stdout is `{plane:"operator", op:"status"|"confirm"|"repair-*"
(v22: `repair-ledger` | `repair-confirmations` |
`repair-consumptions`),
ok:true|false, ...}` — an operator `refused`/`ok:false` carries
`op` beside its code, so a consumer can always tell an operator
refusal (e.g. `ledger-not-malformed`) from an act `refused` even
though the word is reused; the pairwise-distinguishability
fixture's scope stays the THREE ACT FAMILIES — the operator
plane is excluded by construction, and its `refused` reuse is
inside-plane only);
`journal-corrupted` and
`journal-quiescing` additionally print their operator remedy line
(restore/manual-repair evidence path; quiescence confirmation
procedure); NO code is aliased, collapsed, or dropped at the CLI
boundary — the §1.1 census is the CLI's census. The revoke act
accepts EXACTLY ONE of two mutually exclusive target arguments
(§1.2, v15 cycle-10 major 4 — the two flags together, or neither,
is a USAGE error, exit 2 usage text, no act runs): `--exec
<actionId>#<r>` (form T1, resolved to `#o<r>`) or `--target-id
<fullRecordId>` (form T2, naming one execution-scoped record
directly by the `actionId#...` grammar — e.g. an intent id, for
the `revoke-target-not-outcome` path; `revoke-<ulid>` ids match
no T2 grammar and are rejected as usage errors BEFORE any act —
the record-kind set is exactly `#i<r>` / `#r<n>@claim` /
`#r<n>@abandon`); T2's execution context is the named record's
OWN `(actionId, r)` (v14's "MUST equal the request's named
execution" binding is WITHDRAWN — the request names no second
execution; see §1.2 for the pinned CHECK ORDER); T2 requires
the same TTY confirmation.

### 1.5 Namespace & routing guards

- SOURCE guard (v3, round-2 blocker R2-B1 — v2 said "live under
  `refs/heads/agent/**`", which NO producer can satisfy: `agent/**` is
  the P6 **task** namespace (`agent/<episodeId>/<taskId>`,
  `src/worktree/provision.ts:433`); P12 **categorically keeps episode
  branches OUT of it** (`merge.ts:25–27`, `:441–451`) and the host's
  `--episode-branch` grammar is a single element with no `/`
  (`src/host/activate.ts:143`) — v2's guard admitted nothing the host
  can produce). The guard is the EXACT P12 episode-branch rule, ported:
  `check-ref-format refs/heads/<name>`; single path element (SAFE_ID —
  no `/`, no `..`); must NOT be `agent` or enter `agent/**` (the
  namespace P12 owns for tasks); must NOT case-fold to `main`
  (`MAIN`/`Main` refused — P12's C2-F1 table, which was always a
  SOURCE-side table; the module's own target constant is exact, so no
  folding ever happens at the target). This is the "episode branches
  only" identity P12 tests; a promotion source is an integration branch
  the operator wired with `--episode-branch`.
- TARGET guards (v3, round-2 R2-B2 + R2-M5, restated where the audit
  aims): `refs/heads/main` must be a NON-symbolic ref (symref refusal +
  `--no-deref` on every CAS, both acts — plain `update-ref` following
  `main → other` is REPRODUCED, not theorized) and must not be checked
  out in any worktree (`main-checked-out`; the ONE pinned probe form of
  §1.1 step 1 — `worktree list --porcelain -z`, byte-exact
  `branch refs/heads/main` FIELD match under the v6-pinned
  `attr[ SP value]NUL`-record grammar, probe/parse failure
  refuses fail-closed; detached-at-main never refuses, only discloses;
  refuse, never sync a foreign checkout).
- Routing (m3fix5): before any ref read/write,
  `assertHonestRouting()` on `repoRoot` — `rev-parse --show-toplevel`
  / `--git-dir` realpath+case-fold-compared against the registered
  root; ANY resolution failure ⇒ `routing-poisoned`, fail-closed
  (promotion acts on the MAIN repo, the highest-blast-radius surface
  in the compartment).
- Env/config (m3fix4/3/2, restated so the audit has one place to aim):
  per-call `gitEnv()` strips the WHOLE `GIT_*` namespace (no deny
  list); `GIT_CONFIG_SYSTEM=/dev/null`; `-c core.fsmonitor=false` on
  every index-reading call (rollback's construction reads no index —
  belt stays anyway); filter/attribute drivers pinned to identity on
  anything that materializes trees; `--rerere` never consulted.
- Compartment: `src/integration/` internals only; imports `node:`
  builtins + fixed-argv git plumbing; nothing outside imports
  promote.ts until host wiring (mirror-pin then).

## 2. Slice B — fleet budget layer

### 2.1 Fleet policy file `tre-fleet-budget/1`

Machine-level, sibling of the capacity file (`~/.tre/episodes/`):

```
{ "schema": "tre-fleet-budget/1",
  "caps": { "usd": number },           // required-if-present, > 0, finite
  "episodeRoots"?: string[],          // v3: absolute accounting roots
                                      // (default ["~/.tre/episodes"])
  "updatedAt": number }
```

Closed schema, all-or-nothing validation (capacity-file doctrine —
never a partial parse). Three states, DISCRIMINATED (v2 — v1's
"invalid ⇒ unapplied" silently disabled a fleet cap the operator had
configured; episode caps do not bound fleet-wide spend and are often
absent):

| state | meaning | admission behavior |
|---|---|---|
| ABSENT (file never created) | fleet cap not configured | cap not applied; per-episode caps alone govern; state disclosed |
| VALID | operator configured | cap enforced (§2.3) |
| PRESENT-BUT-BROKEN (malformed / non-finite / stale) | operator intended a cap; it cannot be honored | **FAIL CLOSED on new admission**: `fleet-policy-invalid`, refuse run/resume fleet-wide, disclose per-scheduler-record, until the file is fixed or DELETED (deletion = back to ABSENT, an explicit operator act). Fail-closed matches the capacity-file rule — spending money is consumption-shaped like spawning, not defense-in-depth-shaped as v1 claimed. |

Staleness: `updatedAt` older than `staleAfterMs` (default like
capacity's) is PRESENT-BUT-BROKEN (`fleet-policy-stale`) — a cap file
nobody maintains silently throttles or unthrottles the machine;
re-deriving it is a one-line operator write.

### 2.2 Fleet projection: `projectFleet(episodeInputs, roots, fleetPolicy, current, now)`

Pure function, new `src/budget/fleet.ts` (sibling of `ledger.ts`,
imports `node:` builtins only; NOTHING in `src/` imports it until a
host wires it — P8 compartment doctrine). Inputs are DISCRIMINATED
per-episode results the host builds at consult time (v4, audit major
3 — raw record arrays alone CANNOT express "unreadable" vs "empty",
and v3's signatures left the promised failure states unrepresentable):

```ts
// What inspect() RETURNS (five-state diagnostic of the EOF run, §2.3):
type TailClass = "clean" | "blank-suffix" | "unterminated-kept"
               | "unterminated-cut" | "ambiguous";

type EpisodeInput =
  | { episodeId: string; root: string; status: "read";
      records: LedgerRecord[];
      tail?: "clean" | "blank-suffix" }
                                    // v7 (cycle-2 blocker 3 + major
                                    // 6): ONLY a newline-terminated
                                    // stream arrives as `read`.
                                    // Single-write framing doctrine
                                    // (§2.3): determinacy ⇔ the
                                    // stream ends with '\n'; every
                                    // unterminated state (kept/cut/
                                    // ambiguous) AND every
                                    // whitespace-suffix WITHOUT a
                                    // final '\n' is UNSETTLED — a
                                    // live append's byte-prefix
                                    // (whitespace, or valid JSON
                                    // awaiting its newline, is a
                                    // prefix the writer may still
                                    // extend) — mapped by the host
                                    // to `unreadable(torn-unterminated)`
                                    // with the raw TailClass carried
                                    // in `tailDiag` (§2.3 v7).
                                    // v6's "unterminated-kept
                                    // contributes its record" is
                                    // RETIRED: counting an
                                    // unterminated record as final
                                    // asserts a settlement the
                                    // bytes alone cannot establish.
  | { episodeId: string; root: string; status: "new-episode";
      reason: "never-initialized" | "init-pending" }
                                    // v7: legitimate zero terms —
                                    // ABSENT marker + ABSENT ledger
                                    // ("never-initialized"), and
                                    // marker-absent + provably
                                    // ZERO-BYTE ledger
                                    // ("init-pending", §2.3 v7
                                    // init ordering — zero bytes is
                                    // proof of zero spend; nothing
                                    // can hide in an empty file
                                    // O_EXCL just created);
                                    // "init-durable-unwritten" stays
                                    // retired
  | { episodeId: string; root: string; status: "unreadable";
      reason: "missing-ledger" | "ledger-without-init" | "init-conflict"
              | "adoption-binding-broken" | "corrupt" | "denied" | "eio"
              | "torn-unterminated" | "unknown";
      tailDiag?: TailClass };       // v7 diagnostic for the consult
                                    // record when reason is
                                    // torn-unterminated
  // One input per discovered directory, no "absent" variant: §2.3's
  // discovery + init protocol decides WHICH variant before this call.

type FleetPolicyInput =
  | { state: "valid"; cap: number; roots: string[] }
  | { state: "absent" }
  | { state: "broken"; reason: string };   // malformed/stale — fail closed

type RootDiscovery =
  | { root: string; state: "complete"; episodes: string[] }
                                    // enumeration finished; episodes =
                                    // episode dir names enumerated
  | { root: string; state: "failed";
      reason: "missing" | "unreadable" | "short-read" | "unknown" };

type CurrentEpisode = { root: string; episodeId: string };
                                    // v7 (cycle-2 major 2): WHO is
                                    // consulting — required by BOTH
                                    // functions; §2.2 rule (v) is
                                    // meaningless without it

projectFleet(inputs: EpisodeInput[], roots: RootDiscovery[],
             policy: FleetPolicyInput, current: CurrentEpisode,
             now: number)
```

v5 (audit major 3, completed): `RootDiscovery[]` is a REQUIRED
parameter with one entry per declared root — v4's
`EpisodeInput[]`-only signature still let a declared root whose
enumeration FAILED produce the same input array as an empty readable
root (the R2-M3 partial-Σ failure through the signature itself, and
§2.5's "per-root discovery results" had no parameter to carry them).
`projectFleet` refuses Σ determinacy (`fleet-indeterminate`) whenever
any root is not `complete`; `fleetSummary` discloses each root's
state. **Correspondence rules, closed form (v6, cycle-1 major 6):**
let `CR` = the set of canonicalized declared roots in a `valid`
policy, `DR` = the set of roots named in `RootDiscovery[]`. The
projection asserts, and refuses `fleet-indeterminate` (with the named
mismatch) on any violation: (i) `DR == CR` as SETS — a declared root
with NO discovery entry is a failed enumeration wearing a gap, an
enumerated root nobody declared is untrusted input; (ii) no duplicate
`root` entries; (iii) `EpisodeInput`s are UNIQUE by `(root,
episodeId)` — duplicate pairs would double-charge Σ — and every
episodeId appears under exactly one root; (iv) every input's `(root,
episodeId)` appears in the enumeration of the COMPLETE root it names
(no input from an unenumerated or failed root); **(v, v7 cycle-2
blocker 1 — the other DIRECTION, previously only in prose):** for
EVERY COMPLETE root, every episodeId in its enumeration appears as
EXACTLY ONE input — a discovered episode silently missing from the
inputs is a dropped Σ term (fail-open with omitted spend), so the
projection refuses, it never sums what it was handed. The ONLY
permitted asymmetry is ONE input for the CURRENT episode not yet
listed by its root's enumeration (§2.3 current-episode registration),
identified by the `current` parameter below; the current episode's
root must still be a COMPLETE declared root — the exception never
admits an input from a FAILED or UNDECLARED root, which stays
`fleet-root-unregistered`/`fleet-indeterminate`. v4's
`EpisodeInput[]`-only signature still let a declared root whose
enumeration FAILED produce the same input array as an empty readable
root (the R2-M3 partial-Σ failure through the signature itself, and
§2.5's "per-root discovery results" had no parameter to carry them).
**(v7 cycle-2 major 2 — the exception must be REPRESENTABLE):** the
exception references the current episode, so both functions take it
as a parameter — `(root, episodeId)` of the acting episode, supplied
by the host at consult time; WITHOUT it the pure function cannot
distinguish the legitimate unlisted input from an unauthorized extra
(one input array, two verdicts). **(vi, v8 cycle-3 blocker 3 — the
identity must OCCUR in the inputs:** a consult with `inputs = []`
over a root whose enumeration is empty (the current episode's own
directory created after traversal) passes (i)–(v) while dropping the
current episode's EXISTING spend — §2.3 says the current episode is
by definition included, so the projection now REQUIRES exactly one
input with `(root, episodeId) == current` (its enumeration-membership
is the sole permitted asymmetry); `current` naming a FAILED or
UNDECLARED root ⇒ `fleet-root-unregistered`/`fleet-indeterminate`,
`current` absent from inputs ⇒ refusal `current-input-missing` — the
projection refuses, it never sums around its own episode). Test pin
(§3): identical
`inputs`/`roots` arrays with two DIFFERENT `current` identities —
the unlisted episode legal only when it IS `current`, PLUS empty
enumeration + `inputs = []` + a valid `current` ⇒ refusal, not a
zero-Σ admit.)

The function never touches the filesystem (same purity split as
`projectLedger`/`check`); the host does all I/O (§2.3 discovery API —
`BudgetLedger.inspect`, NEVER `open()` on a foreign episode, v5) and
maps each outcome to exactly one `EpisodeInput` — an unreadable episode is
NEVER passed as `records: []` (that conflation is what let an
invisible episode masquerade as a zero term; `BudgetLedger.read()`'s
ENOENT-returns-empty convenience, `ledger.ts:1599`, is for P8's own single-episode admission, not for
fleet discovery — the host distinguishes the cases via the LEDGER
INIT PROTOCOL and the read-only inspect API BEFORE calling, never via
a layout-marker heuristic (v4's marker inference is REJECTED in v5 —
finding B1, §2.3)).

Per-episode usage reuses `projectLedger` semantics UNCHANGED — no
record-format change, no cross-episode ledger, no new durable state.

**Unreadable episode (v3 — v2's "lower bound" REJECTED, round-2
R2-M1):** v2 refused only the unreadable episode and admitted the
OTHERS against "Σ = last known lower bound". Two defects, both
accepted: (a) no such store exists — an unreadable ledger yields no
"last known" number (0 is the only bound derivable from it, so the
admitted Σ silently excludes the unknown episode's spend, and
disclosure on a refusal line doesn't turn a lower bound into a cap
check); (b) "Σ = lower bound" is exactly the condition under which the
inequality admits spend the cap cannot cover. v3 takes the consistent
branch of the A6 doctrine (unknown is never headroom, not even
someone else's): **an indeterminate episode makes Σ itself
indeterminate — new USD admissions are DENIED FLEET-WIDE
(`fleet-indeterminate`) while any episode in the §2.3 accounting
population has an unreadable/poisoned ledger or nonzero
unknown-priced spend.** Harsh, honest, and repairable: the operator
fixes the ledger, or moves the episode out of the accounting
population (declared roots, §2.3); non-USD admissions (turns,
wallclock) are unaffected; ALREADY-RUNNING attempts are untouched
(admission-only, no kill — unchanged). v2's "never fleet-wide freeze"
framing is withdrawn: a fleet that keeps admitting spend it cannot see
is the failure the cap exists to prevent, and the BROKEN-FILE state
already fails closed for a weaker cause.

**Operator-acknowledgment waiver (v43 — owner sign-off 2026-11-16, D5
answered "option 3 for robustness"):** the v3 fleet-wide denial remains
the DEFAULT and the only automatic behavior; a narrow, non-automatic
exception is added: the operator may acknowledge a SPECIFIC
indeterminate source so the fleet is not held hostage to one episode's
broken ledger. Binding rules (skeleton — full normative text is
post-approval drafting; NOTHING here is implemented in `src/`):
- **Scope-bound:** one ack names exactly one `(root, episodeId)` AND
  the named indeterminate state (`unreadable(...)` / unknown-priced
  spend) AND the fleet-policy generation it was made under; a policy
  regeneration ORROWS the ack (Σ-computability is re-established
  without it or a fresh ack is required). An ack NEVER covers the
  policy file itself — T1 (broken/stale policy) remains unconditional
  fleet denial; an ack NEVER covers root-enumeration failure (you
  cannot ack what you cannot name).
- **Effect:** the acknowledged episode is REMOVED from the §2.3
  accounting population (it is NOT substituted with any number — no
  0, no lower bound, no estimate; the R2-M1 rejection stands: the ack
  excludes, it does not value). Σ becomes computable over the rest,
  and admission resumes under the §2.3 inequality.
- **Disclosure is mandatory and loud:** every fleet summary and every
  admission verdict computed under any ack carries the ack list
  (episode, state, ackedAt label, acking operator) on its disclosure
  line; a verdict under ack is distinguishable from a clean verdict
  by construction, and its `Σ` is explicitly "Σ excluding N
  acknowledged episodes".
- **Durable state (honesty):** the ack store IS new durable
  fleet-level state; v3's "no new durable state" (§2.2) applied to
  PER-EPISODE state. Owner waiver 2026-11-16 SUPERSEDES that
  sentence's scope; the supersession is noted here so no reader
  takes §2.2's sentence as currently true of the slice as extended.
- **Trust domain:** the ack store is an operator-owned file beside
  the policy (same trust domain as `tre-fleet-budget/1` itself —
  file-permission-gated like `--repair-quiescence-ledger`, NOT
  signature-gated; the "operator-signed" phrasing is avoided per the
  C14-m2 correction). It is durable fleet-level operator config —
  v3's "no new durable state" promise concerned per-EPISODE state.
- **What the waiver buys and pays:** liveness (fleet keeps admitting
  against a computable Σ) at the price of knowingly UNDERCOUNTING
  reality — the acknowledged episode's actual spend is and remains
  invisible to the cap. That trade is the owner's explicit choice
  ("for robustness"); it is recorded as a §5.2 residual, not a
  closed hole. Tests (post-wiring round, contract-first): ack named
  wrongly ⇒ no effect; ack orphaned by regeneration ⇒ denial
  resumes; verdicts under ack disclose; policy-broken + valid ack ⇒
  STILL fleet-denied.

### 2.3 Admission rule (v4 — the formula, stated as an inequality; discovery fixed)

The fleet gate is a SECOND check consulted by the host at admission
time (scheduler headroom path in `src/host/sched-gate.ts` and the
single-worker supervise path) with closed codes appended to the
scheduler refusal list (alongside `budget-headroom`):

```
admit  iff  ΣE consumed(E) + ΣE holds(E) + candidateEstimate ≤ fleetCap
            AND the Σ is DETERMINATE (§2.2, v3)
            AND the current episode's root is REGISTERED (§2.3, v4)
            AND every declared root's discovery is COMPLETE (§2.2, v5)
            AND (redelivery-covered admissions mint no second estimate — full P8 identity match required, §2.3 v5)
```

- **Current-episode registration (v4, audit blocker 1):** the host
  passes its OWN resolved episodes root (`opts.episodesRoot`, default
  `~/.tre/episodes`) and episode id into the ℵ-fleet consult. The
  consult canonicalizes BOTH sides the same way — `realpath(3)` after
  `~`/env expansion, trailing-slash stripped, then a byte-exact
  string compare against the canonicalized `episodeRoots` entries —
  and REFUSES with `fleet-root-unregistered` unless the current
  episode's root is an ENTRY in the registry. Rationale: without this,
  the operator could set a valid policy, configure the default root,
  then admit an episode from `--episodes-root /elsewhere` whose spend
  is invisible to Σ — exactly the R2-M3 failure with the roles
  reversed. Canonicalization failures (unresolvable path, non-absolute
  after expansion) also refuse `fleet-root-unregistered`, never admit.
  The current episode is BY DEFINITION in the population: its records
  (freshly read, same as every other episode's — NEVER the caller's
  assertion) are included in Σ even if discovery has not yet listed
  the directory. Test pin: admit from an unregistered custom root ⇒
  `fleet-root-unregistered` with zero ledger reads outside declared
  roots.
- **Accounting population (v3, round-2 R2-M3; v4 hardened):** discovery is an
  OPERATOR-DECLARED root registry — the fleet file's optional
  `episodeRoots: string[]` (§2.1), absolute paths, default
  `["~/.tre/episodes"]`. v2 enumerated only `~/.tre/episodes`, so any
  episode run with `--episodes-root` (`src/host/activate.ts:71`,
  `supervise.ts:2771`) spent OUTSIDE the cap with zero disclosure.
  Episodes are discovered per root — directories under a declared root
  (v4: NOT conditioned on a ledger being present; see the
  new-vs-missing distinction below — not the caller's imagination;
  host reads fresh at consult time). A
  declared root that is missing/unreadable at consult ⇒ discovery is
  incomplete ⇒ `fleet-indeterminate` (fail-closed, §2.2), never a
  silent partial Σ. **Lifetime boundary (declared, not bug-laundering):**
  the cap governs the CURRENT population — deleting or moving an
  episode directory out of a declared root removes its spend from Σ
  (an operator act; provider-side billing limits are the lifetime
  mechanism, out of this slice).
- **Ledger initialization protocol — sidecar marker, atomically
  published, crash-tabled (v6, cycle-1 audit blockers 1+3 + majors
  1+2, replaces v5's in-file header):** v5 put the "initialized"
  evidence in a **header line inside `budget.jsonl`** — three defects,
  all accepted: (i) the header is NOT a `LedgerRecord` — the
  UNCHANGED owner reader validates every line (`validateLedgerRecord`
  requires `schema`+`id`+`ts`+`kind`, `ledger.ts:354-365`) and
  mid-file corruption THROWS (`read()`, `ledger.ts:1592-1598`), so
  every initialized ledger would fail the owner's own `open()` —
  first admission freezes, not succeeds; (ii) file-absent classification
  cannot distinguish never-initialized from DELETED-LEDGER-WITH-SPEND
  (the v5 claim "the header only ever disappears through whole-directory
  deletion" is an assertion the protocol never enforced — deleting
  just `budget.jsonl` left marker…file absent + directory + graph
  present, the exact "new episode" zero-term class, silently dropping
  the episode's spend from Σ); (iii) `open("ax")` + append is not an
  atomic publication — a crash mid-write leaves an empty/partial file
  whose re-validation classifies as conflict with NO defined recovery
  transition, and no fsync ordering was specified. v6's protocol:
  1. **Evidence is a SIDECAR marker file, the ledger format is
     UNCHANGED.** `BudgetLedger.initEpisode(episodePath)` (new,
     `ledger.ts`) acts in a PINISHED ORDER (v7, cycle-2 blocker 2 —
     the LEDGER IS CREATED FIRST, the marker published SECOND, so no
     durable state exists that discovery cannot classify without
     freezing):
     (a) **Classify FIRST, then ledger:** read the marker state
     BEFORE creating anything (v8, cycle-3 major 1 — publication
     order stays ledger-first, but CLASSIFICATION is marker-first:
     valid marker + absent ledger ⇒ REFUSE `missing-ledger` without
     creating a byte — the operator-only state of the table below
     must never be "healed" by init minting a zero ledger over a
     deletion; corrupt marker ⇒ refuse `init-conflict`). Only
     marker-ABSENT proceeds. **The durability rule of this branch
     is uniform over EVERY way a zero-byte ledger can be observed
     (v10, cycle-5 blocker 1 — v9 spelled the fsync chain only for
     the fresh `O_EXCL` create and the `EEXIST` loser; a zero-byte
     file found on the FIRST stat — a crash remnant whose creator
     died before its own fsyncs — silently skipped the chain and
     could publish a marker over a possibly-not-durable ledger
     entry): whoever proceeds to publish, having OBSERVED (never
     created-and-fsynced in this act) the zero-byte ledger, MUST
     open and fsync THAT FILE, then fsync `events/` (and the
     episode dir per the parent rule below), before any marker
     link.** Concretely: if `events/budget.jsonl` does not
     exist, create it ZERO-BYTE via `open(O_WRONLY|O_CREAT|O_EXCL)`
     + fsync the file, then **fsync the `events/` DIRECTORY** (v8,
     cycle-3 blocker 1: a file fsync does NOT persist the new
     DIRECTORY ENTRY — without this dir fsync, a crash can lose the
     ledger's directory entry while the later marker link survives
     its own dir fsync, yielding durable marker + absent ledger =
     the operator-only freeze; the ordering below forbids that
     interleaving). If `events/` was newly created, fsync its
     parent (the episode dir) FIRST — the same entry-durability
     argument one level up, and (v10, cycle-5 major 2) fsync the
     episode dir is required of EVERY publisher/retry whose chain
     relies on `events/` entries, NOT only the invocation that
     created it — a publisher that OBSERVES an existing
     `events/` cannot assume its entry in the episode dir is
     durable (the creator may have died before that fsync; see the
     remnant fixture in §3). (An empty file is the owner's own
     empty-read state — `read()` over `""` yields zero records,
     `ledger.ts:1599` — nothing to parse, nothing to hide.) If it
     EXISTS (first stat) and is ZERO BYTES ⇒ apply the uniform
     observed-zero-byte rule above (open + fsync the file, fsync
     `events/`, episode dir per the rule) and proceed to (b) —
     this is the crash-remnant path: the table's `init-pending`
     row HEALS by marker publication, and healing inherits the
     FULL chain, never less. If the `O_EXCL` create fails `EEXIST`
     (concurrent initializer — v8, cycle-3 major 5; HARDENED v9,
     cycle-4 blocker 1: the loser inherits NONE of the winner's
     durability obligations): re-stat;
     ZERO bytes ⇒ the winner created it, but the loser may NOT link
     a marker on the winner's unverified durability — the loser
     OPENS the existing zero-byte file and fsyncs IT, then fsyncs
     `events/` (and the episode dir — v10 uniform rule: the episode
     dir fsync is NOT conditional on this publisher creating
     `events/`), establishing
     the SAME chain as the winner, before proceeding to (b); the
     durability chain is per-PUBLISHER, not per-creation (a winner
     that crashed before its own dir-fsync must not be trusted by
     the loser — the loser's fsyncs close that hole regardless);
     NON-EMPTY ⇒ refuse
     `adoption-required` (same rule as below; never assume). If it
     EXISTS and is NON-EMPTY ⇒ `initEpisode` REFUSES
     `adoption-required` (v7, cycle-2 major 4:
     plain init may never mint an ownership marker over records of
     unknown provenance — that is the operator adoption act (3),
     and this refusal makes the init/adoption race structurally
     impossible rather than adjudicated after the fact).
     (b) **Marker second:** publish `events/budget-init.json` —
     content `{"schema":"tre-budget-init/1","episodeId":…,"created":ts}`
     — by **ATOMIC NO-REPLACE publication** (v7, cycle-2 major 4):
     write `events/.budget-init.json.tmp-<pid>-<nonce>`
     (O_WRONLY|O_CREAT|O_EXCL), fsync the file, then `link(2)` tmp →
     `budget-init.json` — link FAILS `EEXIST` if any marker already
     exists, which is how concurrent publishers converge: the winner
     proceeds, every loser revalidates the WINNER's marker
     (episodeId mismatch ⇒ `init-conflict` refuse) and deletes its
     own tmp. (v6's rename-based publication could clobber: rename
     silently replaces, so a concurrent adoption's evidence could be
     overwritten by a plain init — cycle-2 major 4; also two "equal"
     inits with different `created` ts — the v6 claim "contents
     equivalent" was false. With link, exactly ONE marker exists and
     ITS contents stand.) fsync the `events/` DIR (the link's
     durability edge), then unlink the tmp. Already-valid marker ⇒
     **revalidate AND re-establish durability before success (v9,
     cycle-4 blocker 2 — a plain no-op is not enough: the prior act's
     marker-link dir-fsync may have FAILED, leaving a linked-but-
     not-durably-recorded marker; if the owner reserved on that
     no-op, a later crash could lose the marker entry while the
     non-empty ledger survives — `ledger-without-init`, the freeze
     the protocol exists to prevent): the valid-marker path fsyncs
     the ledger file (if present), the `events/` DIR, AND the
     episode dir (v10, cycle-5 major 2 — the retry's chain relies
     on entries in `events/` AND on `events/`'s own entry in the
     episode dir; who created either is irrelevant to a durability
     claim this return is making), before
     returning success, so ANY successful return — fresh or retry —
     means the full chain is durable, not merely intended.**
     **Failure-state machine for the
     durability ops themselves (v8, cycle-3 major 5; REFINED v9,
     cycle-4 major 3): ANY failed fsync, and any link failure OTHER
     THAN the marker link's EXPECTED `EEXIST` (the convergence path
     above — not an error, the designed loser branch), ABORTS
     `initEpisode` with an error: the owner proceeds to NO reserve
     and writes nothing further (fail the ACT — see the honest
     scope below). "Fail the ACT, never the classification" means
     the failure adds NO special classification of its own: the disk
     state left behind is classified by the crash table as-is — an
     aborted act CAN legitimately leave a classifiable intermediate
     (a zero-byte ledger ⇒ `init-pending`; a linked-then-
     dir-fsync-failed marker ⇒ visible, and the NEXT consult reads
     `read` or the table's row, which is allowed — what is forbidden
     is the ACT proceeding to reserve, and any classification the
     table does not cover); retry re-runs the whole act
     from (a) — idempotent by construction: EEXIST paths reclassify
     as above; a linked-but-dir-fsync-LOST marker is recovered on
     retry by (a)'s valid-marker path (revalidate + dir-fsync above).
     tmp cleanup is best-effort: a leaked
     tmp file is inert (prefix-dotted, never parsed); cleanup NEVER
     removes published evidence.** **No line format of
     `budget.jsonl` changes** — the owner's
     `open()`/`read()`/`repairTail()` and every shipped P8 reader
     stay byte-compatible (this is the migration story: nothing to
     migrate INSIDE the ledger).
  2. **Crash/recovery table (discovery is READ-ONLY; the admission
     path re-runs `initEpisode` and heals by construction):**
     | marker | ledger file | classification |
     |---|---|---|
     | valid | present, inspects OK | `read` (normal Σ term; zero-byte ledger under a valid marker is an initialized zero term) |
     | valid | ABSENT | `unreadable(missing-ledger)` ⇒ `fleet-indeterminate` — **deletion-with-spend is DETECTED, never reclassified new** (cycle-1 blocker 1). Under v7/v8 ordering this state arises ONLY from deletion (or a partial backup restore): the ledger's directory entry is fsynced BEFORE the marker is linked (v8, cycle-3 blocker 1), so a durable marker PROVES the ledger entry was durable before it — the crash window is provably closed, not asserted. `initEpisode` REFUSES in this state — create-anything happens only under a marker-ABSENT classification (v8, cycle-3 major 1) |
     | absent | absent | `new-episode(never-initialized)` — the legitimate zero term; owner's next admission runs `initEpisode` (creates ledger, then marker), then the normal fresh path. Discovery classifies this DIRECTLY — read-only, no init involved (v7, cycle-2 minor 3 — v6's "(and init succeeds)" wrongly made a consult depend on a write) |
     | absent | present, ZERO BYTES | `new-episode(init-pending)` — v7 (cycle-2 blocker 2): the crash between (a) and (b). Zero bytes is PROOF of zero spend (no record can exist in an empty file O_EXCL just created), so this is a zero term, NOT the legacy state, and there is NO permanent freeze: no "queued first record" fiction — the restarted owner simply re-runs `initEpisode` (sees the empty ledger, publishes the marker) BEFORE its own reserve, and the fleet consult never blocks on it |
     | absent | present, NON-EMPTY | `unreadable(ledger-without-init)` ⇒ `fleet-indeterminate` — an ownership-evidence-less ledger with CONTENT is never trusted as new nor with its own numbers (pre-v6 legacy state; zero provenance, nonzero risk; see 3) |
     | corrupt | any | `unreadable(init-conflict)` ⇒ `fleet-indeterminate` |
     Durable-ordering honesty (v8, cycle-3 blocker 1): a file fsync
     persists CONTENT, not a directory ENTRY — so the act fsyncs the
     ledger's file AND the `events/` directory before attempting any
     marker link, and fsyncs the episode dir UNCONDITIONALLY (v11,
     cycle-6 minor — v10 still said "when `events/` itself is new",
     contradicting §2.3's uniform per-publisher rule: the entry
     naming `events/` may be undurable no matter who created the
     directory). With that ordering: if the (a) ledger-create's
     dir-fsync is LOST, the act ABORTS before any marker exists
     (cycle-3 major 5) — the ledger vanishes with the marker never
     written, absent/absent, zero term, healed by retry (the crash
     reorders toward LESS state, never stranding more). If the (b)
     marker link or its dir-fsync is lost: zero-byte (or content-
     bearing, pre-first-consult) ledger with absent marker —
     `init-pending`/`ledger-without-init` classification, healed by
     retry or adoption. Every reachable
     crash state classifies without a permanent freeze and without
     trusting unowned content.
     Crash ordering under v7 (replaces v6's self-heal claim — the
     v6 text asserted the marker-before-ledger window "self-heals as
     soon as the owner's queued first record appends", but a CRASHED
     process has no queued operation and the restarted owner must
     pass the fleet gate before it reserves: the window could freeze
     the fleet permanently, cycle-2 blocker 2. The ordering fix
     deletes the window; what remains is bounded honestly): a valid
     marker with an ABSENT ledger arises only from deletion or a
     partial restore and stays fail-closed (`missing-ledger`) until
     an operator acts — conservative by design: it errs toward
     freezing, never toward dropping recorded spend. Every
     init-created intermediate (zero-byte ledger, marker pending) is
     a classified zero term healed by retry; `initEpisode` is
     idempotent so the owner's retry costs nothing.
  3. **Legacy migration is an explicit operator act (cycle-1 major
     2):** episodes created BEFORE this protocol have a ledger and NO
     marker ⇒ the absent/present row ⇒ `fleet-indeterminate` until
     adopted. `initEpisode(episodePath, { adopt: true })` (operator
     CLI, per episode; a one-pass `adopt-all` walks declared roots)
     requires `read()` to return CLEAN (no corrupt class; torn tail is
     repaired by the owner first). **Binding (v7 major 5, v8 cycle-3
     blocker 2 — first-record identity + length are INSUFFICIENT: a
     replacement ledger keeping the same first record and equal
     length but omitting later spend would pass them):**
     the marker records `adopted:true`, `firstRecordId`/`firstRecordTs`,
     `adoptedLen` = the ledger's byte length at validation, AND
     `adoptedSha256` = SHA-256 over the ledger's bytes `[0,
     adoptedLen)` at validation;
     publication uses the SAME link-based no-replace act as (b)
     **INCLUDING its full durability chain (v9, cycle-4 major 7 —
     "the same act" means the whole ordering, not just the link):
     BEFORE the marker link, fsync the legacy ledger file (already-
     durable content is a no-op; a not-yet-durable entry cannot be
     assumed), fsync the `events/` DIRECTORY, AND fsync the episode
     dir UNCONDITIONALLY (v10, cycle-5 major 2 — the adoption act
     never CREATES `events/` (a legacy ledger implies it exists) but
     may OBSERVE it with a non-durable entry in the episode dir; the
     v9 "if newly created by the act" condition does not exempt
     adoption — same uniform rule as (a)) — so the
     deletion-only explanation of the valid/absent crash-table row
     covers ADOPTED markers identically, not just fresh-init ones;
     after the link, fsync the `events/` DIR again (the link's
     durability edge); a failed pre-link or post-link fsync follows
     the same abort-and-retry machine as (b) — an adopted marker's
     SUCCESS return means the full chain is durable.**
     Publish-then-recheck: AFTER the link succeeds, re-read the file
     and verify bytes `[0, adoptedLen)` still hash to `adoptedSha256`
     AND the first record still matches `firstRecordId` — a
     mismatch (file replaced/truncated/rewritten-prefix under the
     act) ⇒ the act
     reports `adoption-binding-broken`, marker left in place as
     EVIDENCE (never silently unlinked), consult stays
     `fleet-indeterminate` via the discovery-side check below until an
     operator investigates. **`firstRecordTs` is DIAGNOSTIC ONLY
     (v9, cycle-4 minor 2): the binding checks (publish-recheck and
     every discovery consult) verify `firstRecordId` and the prefix
     digest — never the timestamp (a clock-skewed or re-serialized
     record must not break an otherwise byte-identical binding; the
     digest already covers the record's bytes, so the ts adds
     evidence for operator forensics, nothing more).** Appends after adoption are LEGITIMATE
     (append-only extends past `adoptedLen` — prefix monotone); only
     a shortened or rewritten prefix breaks the binding — the digest
     is what makes "same first record, same length, different later
     bytes inside the validated prefix" impossible to pass (v8). **Discovery
     verifies the binding on every consult** (v7, digest-extended
     v8): an `adopted:true`
     marker must have the ledger's first record == `firstRecordId`,
     length ≥ `adoptedLen`, AND SHA-256 of bytes `[0, adoptedLen)`
     == `adoptedSha256`, else
     `unreadable(adoption-binding-broken)` — a marker never
     legitimates a ledger other than the one it validated. Stated
     boundary (v8): the binding freezes OWNERSHIP of the validated
     prefix; it is not a general integrity seal — post-adoption
     record DELETION preserving the prefix is ledger tampering, the
     same residual the in-episode append-only writer discipline
     already carries (§2.4 point-in-time posture; a hash chain across
     records is out of scope here).
     Adoption NEVER writes the ledger. `adopt-all` is explicitly
     NON-ATOMIC (v7; CLASSES CORRECTED v10, cycle-5 minor 3 —
     episodes missed by the walk are NOT categorically
     `ledger-without-init`; they classify by the §2.3 table:
     absent/absent ⇒ `new-episode` zero term, absent/zero-byte ⇒
     `init-pending` zero term, and ONLY absent/NON-EMPTY ⇒
     `ledger-without-init`): per-episode results are reported;
     episodes created mid-walk are simply not adopted (their ledger-
     free or zero-byte state is a classified ZERO TERM healed by the
     owner's own `initEpisode` — fail closed ONLY for a non-empty
     ledger with no marker — disclosed,
     re-runnable); the pass makes no coverage promise beyond the
     snapshot it enumerated. Upgrade note (stated loudly in the
     release): until the adoption pass completes, the fleet USD
     denial of §2.2 applies to those episodes — consistent with the
     fail-closed doctrine, one-time, operator-bounded.
- **Fleet discovery is READ-ONLY — never `open()` a foreign ledger
  (v5, audit blocker 2; equivalence claim REFINED in v6, cycle-1
  blockers 4 + major 7):** v4 mandated `BudgetLedger.open` per
  discovered episode, but `open()` calls `repairTail()`
  (`ledger.ts:1581`), which TRUNCATES and FSYNCS (`ledger.ts:1674`),
  while a foreign episode's writer is appending — the fleet consult
  could mutate (and mid-append, destroy records of) a live episode's
  ledger with no cross-episode lock. v5 adds a genuinely read-only
  API, `BudgetLedger.inspect(path)` (new static, same file): reads
  bytes, applies the SAME tolerant line classification `read()` uses
  for the torn EOF run (`ledger.ts:1620-1651` — `isTornTail` is
  already a pure predicate over (lines, endsNL)), returns
  `{ records, tail: "clean" | "blank-suffix" | "unterminated-kept" |
  "unterminated-cut" | "ambiguous" }`, and has **no write path at
  all** (no `repairTail`, no handle, no truncate). v6 replaces v5's
  `tornTail: boolean` with this five-state classification of the EOF
  run (the boolean conflated a whitespace-suffix repair — nothing was
  dropped — with a kept-but-unterminated record, and with a cut —
  data the owner WILL resurrect differently):
  - `clean` — ends with newline, every line valid; Σ contribution
    complete and determinate.
  - `blank-suffix` — trailing whitespace-only run **terminated by a
    final newline** after the last complete record
    (`ledger.ts:1613-1627`); no record content is affected;
    determinate; disclosed. **v7 (cycle-2 blocker 3): a
    whitespace-only EOF suffix WITHOUT a final newline is NOT this
    class — it is UNSETTLED** (the bytes may be the beginning of a
    live append sequence; append-only means the already-written
    bytes never change, but the unseen remainder of the same write
    may complete into a valid record Σ never saw — exactly the
    cycle-1 blocker-4 ambiguity, and v6 wrongly declared it
    determinate).
  - `unterminated-kept` — final line parses+validates but lacks its
    newline (`repairTail` will terminate & keep it, `ledger.ts:1815-
    1824`). **v7 (cycle-2 major 6) RETIRES v6's "counted, disclosed"
    mapping: an unterminated record is NOT a settled Σ term.** A
    syntactically valid prefix is precisely what a mid-write large
    record looks like once its visible bytes happen to parse (no
    atomicity guarantee covers a multi-chunk append; byte-level
    observation cannot establish the writer's write has completed),
    and the owner's post-repair fold may keep, extend, or
    reinterpret what the bytes show. `read` inputs carry ONLY
    newline-terminated streams; `unterminated-kept` maps to
    `unreadable(torn-unterminated)` with `tailDiag` like every other
    unterminated state. (Static-byte facts are retained in NOTES and
    fixtures: `inspect()`'s accepted-record SET equals `read()`'s —
    that equivalence is about parsing, never about settlement.)
  - `unterminated-cut` / `ambiguous` — final line is unparseable,
    schema-invalid, or duplicate-key-ambiguous (`ledger.ts:1636-1651,
    1800-1813`): repair WILL cut it — **but an observer cannot tell
    an abandoned torn append from a LIVE append still in flight**
    (cycle-1 blocker 4): the next poll may see it complete into a
    valid record the Σ omitted. **v6 rule (unchanged): any
    `unterminated-cut` or `ambiguous` tail in ANY population episode
    makes the consult's Σ INDETERMINATE for that consult**
    (`unreadable(torn-unterminated)` → `fleet-indeterminate`, USD
    admissions only — turns/wallclock unaffected, §2.2 posture) and
    a re-consult after the owner's next append/repair resolves it.
  **The v7 determinacy rule in one line: Σ is determinate for an
  episode iff its observed stream ENDS WITH NEWLINE and every line
  validates (with the ONE byte-level exception the crash table
  grants, v10, cycle-5 minor 2: a ZERO-BYTE stream ENDS WITH
  NEWLINE VACUOUSLY — zero bytes contain no partial record, the
  explicit proof case — so it determinates as the zero term, not as
  an unsettled EOF) — the final newline is the only byte-level
  evidence that
  no partial record exists at EOF.** Determinacy beats freshness: a
  smaller Σ you cannot prove is FINAL is not a smaller Σ, it is an
  unknown. (Point-in-time honesty per §2.4 is unaffected: a
  newline-terminated stream may gain a record the instant after the
  read — that is the accepted concurrent-admission window §2.4
  declares, not an unsettled byte.)
  **Equivalence claim, scoped honestly (v6):** `inspect()` and
  `read()` agree on the COMPLETE-RECORD SET exactly — same records
  accepted, same mid-file corruption throws the same class; the
  claim is a pure byte-classification equivalence over (lines,
  endsNL). It does NOT extend to `open()`: `open()` = read + a
  MUTATING repair that can itself fail on I/O (`ledger.ts:1671-1679`)
  — outcomes in that class have no inspect counterpart (there is
  nothing to repair read-only), and the contract does not claim
  otherwise. The §3 pin is fixtures over every EOF class asserting
  (records-equal, tail-state-equals-repair's-actual-outcome) against
  the owner's post-`open()` fold, plus the paused-partial-append test
  below. The owning episode's own admission path keeps
  `open()`+repair (its own file, its own serialization domain — the
  ledger queue). Fleet consult and fleetSummary discovery use
  `inspect()` exclusively.
- **Per-root discovery results are data (v5, audit major 3):** one
  `RootDiscovery` per declared root (§2.2) built from ONE traversal;
  a root that is missing/unreadable/mid-listing is `{state:"failed"}`
  — the projection refuses Σ determinacy over it, and empty-reads-
  complete is distinguishable from failed-enumeration at the
  signature level (v4's `EpisodeInput[]`-only inputs made them the
  same argument; §2.2).
- **New vs missing ledgers (v4, superseded by the two bullets above;
  the failure it fixed stays fixed):** discovery enumerates episode
  DIRECTORIES (v3's "directories holding a ledger" let an
  existing-but-unreadable episode vanish from Σ). Classification is
  now (v6 sidecar rule, ORDER restated v10, cycle-5 minor 1:
  MARKER/LEDGER PRESENCE CLASSIFICATION PRECEDES INSPECTION — a
  marker-absent ZERO-BYTE ledger inspects "OK" (zero records) yet
  is `init-pending`, never `read`; `inspect()` runs only on the
  marker-valid + ledger-present leg — and marker-valid + ledger-
  ABSENT is decided BY PRESENCE at the classification step, never
  reaching `inspect()` (v11, cycle-6 minor: the v10 text contradicted
  itself by keeping it in the `inspect()`-throws parenthetical):
  `inspect()` OK ⇒ `read`; `inspect()` throws ⇒
  `unreadable`; marker-valid + ledger-absent ⇒
  `unreadable(missing-ledger)` from PRESENCE alone; marker AND ledger both absent ⇒
  `new-episode` (discovery classifies DIRECTLY — read-only, no init
  involved, v8 cycle-3 minor 1 — v7's "(and init succeeds)" parenthetical
  survived here after its table-cell fix); marker-absent +
  ledger-present splits BY LEDGER BYTES (v9, cycle-4 major 6 — v8's
  summary here said blanket "marker-absent/ledger-present ⇒
  `unreadable(ledger-without-init)`", contradicting the v8 table,
  which splits it): ledger ZERO BYTES ⇒ `new-episode(init-pending)`
  — a classified ZERO TERM, NOT indeterminate (§2.3 table row 4:
  proof-of-zero-spend, healed by the owner's `initEpisode` retry);
  ledger NON-EMPTY ⇒ legacy `unreadable(ledger-without-init)`
  pending adoption. NEVER a
  marker-based guess of the LEDGER's content. Test pins (§3): an
  episode with a VALID marker but DELETED ledger ⇒
  `fleet-indeterminate` (the deletion-detection pin);
  brand-new (un-initialized) episode
  directory ⇒ zero-term admission; **first admission of a brand-new
  episode under a valid fleet cap SUCCEEDS (the B1 regression)**;
  concurrent append/discovery against one live ledger ⇒ append intact,
  discovery non-mutating (the B2 regression).
- `candidateEstimate` is the SAME number the per-episode `check()`
  mints (docs/12 D2 floor/raise — the ledger's `estimateRaised`,
  `ledger.ts:395` — NOT this doc's §4 D2) — the fleet check never sees a cheaper
  candidate than the episode gate charged.
- **Idempotent redelivery is coverage, not a second hold — with the
  FULL P8 identity match (v5, audit major 4, tightens v4):** v4 said
  "a receipt or actionId the ledger already records" suffices — too
  weak: actionId alone says nothing about WHICH reservation, and P8's
  actual redelivery branch admits only when the prior record matches
  the request on **action, reservedUsd, reservedTurns, AND
  receiptDigest** (`ledger.ts:2196-2203`), then re-runs `check()` in
  coverage mode against the full snapshot, and documents that a
  successful redelivery "proves a past intent, it authorizes nothing"
  (`ledger.ts:2214`). The fleet gate mirrors it exactly: coverage-zero
  requires (i) the consult's freshly-read per-episode records contain
  a reservation for this actionId whose action/amounts/receiptDigest
  EQUAL the current consult's candidate identity (same canonical
  action-spec digest the per-episode `check()` verifies), and (ii) the
  per-episode coverage check for this redelivery is currently
  ALLOWED. Same identity, changed amounts/digest ⇒ NOT coverage — the
  consult takes the normal path with the full estimate (and the
  episode layer itself refuses the mismatched actionId with
  `action-used`, `ledger.ts:2252`). Coverage is OBSERVATION-ONLY: a
  fleet admit on a covered redelivery adds no new spend authority,
  grants no fresh permission — it re-affirms the standing intent
  under the CURRENT fleet policy + Σ. A redelivery whose standing
  intent the current fleet policy no longer covers still refuses
  (`fleet-policy-revoked`, the fleet-side twin of P8's
  `policy-revoked`, `ledger.ts:2244-2248`); a redelivery presenting no
  recorded reservation takes the normal path with the full estimate.
  Test pins: record a reservation, redeliver the IDENTICAL actionId at
  a fleet cap of exactly Σ ⇒ admit with zero added; redeliver the same
  actionId with a DIFFERENT candidate estimate at cap Σ ⇒ NOT
  zero-rated (full estimate ⇒ `fleet-budget-exhausted`); new actionId
  with any positive estimate at exactly Σ ⇒ `fleet-budget-exhausted`;
  covered actionId under a tightened fleet cap below Σ ⇒
  `fleet-policy-revoked`.
- `priced:"unknown"` spend (A6, v3): a nonzero `unknownSpend` ANYWHERE
  in the population makes Σ indeterminate ⇒ fleet-wide `USD`
  `fleet-indeterminate` denial (§2.2) — the same posture P8 takes
  per-episode (`unknownSpend` ≠ USD headroom), applied consistently at
  the fleet Σ instead of only shielding the unknown episode itself.
- **Exhaustion:** inequality fails ⇒ `fleet-budget-exhausted`, deny
  NEW run/resume reservations fleet-wide (and `fleet-indeterminate`
  denies while Σ is unresolvable). **Already-running attempts
  are never interrupted** — admission-only, no kill path (docs/12 A2:
  expiry never removes a hold; consumption is fact, not threat).
- `check()` itself stays per-episode and signature-frozen; fleet codes
  live in the scheduler/host refusal surface, closed-set grown at
  wiring time with mirror pins.

### 2.4 The cap is SOFT, stated honestly (v3 — BOTH prior formulas withdrawn)

v1 claimed "overshoot ≤ one reservation per concurrent admission" —
withdrawn in v2. v2 then claimed overshoot "equals (concurrent
admitted estimates) + (estimation error on running attempts)" —
withdrawn here (round-2 R2-M2): that sum is not an upper bound either.
Σ is read, then each episode's own reserve+consume happens on
independent paths with no cross-episode transaction, and the inputs
themselves can be wrong: estimates under-price running work, the read
is stale the moment it returns, and (pre-v3 framing) episodes outside
discovery spent invisibly. **No numerical overshoot bound is claimed.**
The property actually held to:

> **The fleet cap is an admission-only, best-effort consumption
> governor, not a hard limit.** It stops NEW USD admission once
> observed Σ crosses the cap (or Σ is indeterminate, §2.2). Overshoot
> beyond the cap is possible; its magnitude is unbounded by this
> contract. Closing that fully needs a cross-episode reservation
> transaction — REJECTED for v1 (it re-introduces the shared-write
> machinery this compartment has avoided since P4; recorded as D6's
> rejected alternative).

"Per-episode caps summed under the target" is NOT a hard cap either
(v3 correction): per-episode P8 ceilings are themselves
consumed+reserved+estimate checks (`ledger.ts:1296–1305`) — actual
spend can exceed an estimate there too — and the sum only holds over
episodes that HAVE caps and live in the declared roots. It narrows
drift; it does not bound the total. A provably hard machine-wide limit
would need provider-side (API-account) budget controls — outside this
repo's surface; if Hong needs that, it is its own contract round.

**Owner sign-off (v43, 2026-11-16 — D6 answered as drafted):** the
SOFT, admission-only, best-effort cap is SIGNED as written. The
contract's position — physics, not timidity: a numerical overshoot
bound is NOT DERIVABLE across independent processes without a
cross-episode reservation transaction (rejected for v1), so every
alternative that promised a number was rejected on the merits, twice —
signing "soft" is the only honest option, and demanding a hard cap of
THIS layer buys nothing an estimate cannot fake. Two recorded
consequences of the sign-off, both owner-directed (not new spec
mechanisms): **(1) provider-account hard limits are the real hard
stop and are a SEPARATE ACTION ITEM (owner/human action, OUTSIDE the
repo — set account-level budget caps at each provider; this contract
round neither implements nor can implement them, and the sign-off
explicitly leans on them).** **(2) If a HARD in-repo cap is ever
required, the owner RE-OPENS the reservation-transaction question
with full knowledge of what it costs (shared-write machinery this
compartment has avoided since P4) — signing soft today is not a
precedent that the transaction was never considered.**

### 2.5 Fleet read surface

`fleetSummary(inputs, roots, fleetPolicy, current, now)` — same
`EpisodeInput[]` + `RootDiscovery[]` + `CurrentEpisode` as
`projectFleet` (v5: the readout
and the consult are computed from the SAME arrays the host built from
ONE traversal — per-episode usage + per-episode indeterminate reasons
+ aggregate + cap headroom + policy-file state + per-root discovery
results, a missing/failed declared root disclosed, never silently
skipped) — consumed in v1 by the admission consult and an operator CLI
readout; it is the input M4's dashboard lane will render (docs/20 §14;
no M4 work implied). v4 invariant (audit major 3), v5-completed:
`projectFleet` and `fleetSummary` take IDENTICAL input types — the
consult and the readout can never disagree about which episodes were
seen OR which roots enumerated, because both consume the same
`EpisodeInput[]`/`RootDiscovery[]` pair and share the projection's
correspondence assertion (v7: including `current` — the readout
judges the same coverage rules the consult applies).

## 3. Tests & guards (release bar, per slice)

Slice A (full P12 matrix ported — real-git repos, PATH shims at kill
sites, mutation-check every new regression against `git archive HEAD`
pre-fix builds per the m3fix doctrine): candidate-first ordering pin
(the gate NEVER sees a sha other than the CAS target — source-bind +
journal record asserts C == CAS-newvalue); conflict-before-commit-
object; commit-tree parentage + trailer content; CAS matrix incl.
`close:aba` and moved-`M` operator re-issue (fresh act at the
journal-allocated next `r`; an optional carried `executionSeq`
expectation must match it — v10, cycle-5 minor 4,
stale gate evidence never reused); sticky terminals + tail-intent;
hostile-request fuzz incl. unknown-field refusal (`target`, `targetRef`,
`branch`, `mode`); SOURCE guard (`MAIN`, `Main`, two-element
`integrate/ep1`, `agent` and `agent/**` sources, literal
`refs/heads/main` as source — all refused; a real P12-advanced
single-element integration branch ACCEPTED end-to-end — v3 pin against
R2-B1: the guard as v2 wrote it admitted nothing the host can produce);
unborn main (D9); **`M == E` no-op (v4, audit major 4): episode tip
already == main tip ⇒ `already-merged`, NO commit-tree, NO gate, NO
journal write, NO ref mutation — pinned end-to-end against the
duplicate-parent probe**; **worktree-probe grammar fixtures (v6,
cycle-1 blocker 2): captured byte dumps of `git worktree list
--porcelain -z` for attached, detached, bare, path-with-space, and
prunable worktrees parsed by the pinned attr[SP value]NUL grammar —
a main checkout DETECTED in each shape, a detached-at-main entry
NEVER refusing but disclosing, malformed stream ⇒
`worktree-probe-failed`**; **recovery-path input pin (v6, cycle-1
major 4): open intent + episode branch MOVED/DELETED after the crash
⇒ replay still routes to 5b recovery (main-only reads; moved branch
does not strand the intent behind a step-1 refusal); crash injected
after each of intent/gate/CAS/outcome with replay from each point;
**fresh-execution path pins (v7, cycle-2 major 1): un-acked
`no-effect:` outcome on the actionId ⇒ replay runs steps 1–6 against
CURRENT reality (moved episode tip ⇒ NEW candidate from current
tips), journals execution `actionId#r2` — intent `actionId#i2`
(freshly ALLOCATED suffix — v9, cycle-4 major 5: the module
allocates `r`, it is not "bumped" by the replay; v12 cycle-7 major
2 id scheme); a
SECOND such marker ⇒ `actionId#r3` (id-discipline pin); a `no-effect:`
marker followed by main having MOVED PAST the recorded pre-image ⇒
replay builds fresh against new main, never refuses on the stale
marker's recorded pins**);
**identity/claim pins (v10, cycle-5 blockers 2+3, major 1): retry
with a DIFFERENT injected `now` (and/or different `grantedBy`)
RESOLVES TO THE SAME actionId and hits its sticky/open record
(never a new logical action); CLAIM-before-candidate — two acts
released together after both initial step-0 scans ⇒ exactly one
claim record appended for the promotion, the other refuses per
0a′/0b, and the winner's candidate trailer `seq` == its claimed
`r` (a built-against-WRONG-suffix candidate is impossible by
construction); crash after CLAIM before INTENT ⇒ burned `r`,
step-0 dedup IGNORES the claim (re-issue proceeds at the next `r`,
gap disclosed); empty journal ⇒ first execution `r1`; **v11
cycle-6 additions — CLAIM EPOCH BLOCKER: an unconverted claim from
a DIFFERENT actionId with `ownerEpoch == currentEpoch` ⇒
`refused(intent-open)` (live paused owner), the SAME claim under a
non-current epoch ⇒ stale, ignored for eligibility, its `r` burned
(no death inference from intent-absence — the epoch is the liveness
proof; pinned BOTH ways); SAME-actionId unconverted claim:
v12, cycle-7 blocker 2 — SAME epoch ⇒ `refused(intent-open)` (two
concurrent same-mode requests paused after the FIRST's claim: the
second refuses; crash reissue under a NEW fenced acquisition ⇒
ignored, fresh act at next allocation); CLAIM ABANDONMENT (v12,
cycle-7 blocker 3): conflict then different-mode request WITHOUT
owner restart ⇒ proceeds (abandon record adopted, claim converted);
crash inside the abandon window then same-epoch different-mode
request ⇒ `refused(intent-open)`; after new acquisition ⇒ proceeds
(stale); CONVERSION BY EXACT EXECUTION (v12, cycle-7 major 4):
claim `A#r1` unconverted + a later intent `A#i2` exists ⇒ `A#r1` is
STILL unconverted (unequal-suffix interleave pin); withClaimLock
serialization: two async acts in ONE fenced process through
`withClaimLock` ⇒ exactly one claim appended (the in-process TOCTOU
of cycle-6 major 1 — the plain read-then-append path is illegal
for claims and a fixture attempts it to prove the refusal class);
ambiguous claim append (poison-then-reopen, v12, cycle-7 blocker 4
narrowed; v13 cycle-8 major 3 completes it): reopen's scan is
AUTHORITATIVE — retry NEVER reuses a SURVIVING record's `r`; a
torn fragment truncated by `open()` repair MAY re-allocate the
same `n` (proven-safe recovery); the ORIGINATOR's OWN complete
claim surviving (same actionId+r+ownerEpoch tuple) ⇒ ADOPT and
continue intent at the SAME `n` (not refused by self, no second
claim line — duplicate check-before-append stands); pinned THREE
ways: torn-truncated ⇒ equal `n` legal; own-complete ⇒ adopt same
`n` ONCE (idempotent re-recovery pinned); foreign surviving ⇒
strictly greater; CONFLICT-BURNS-CLAIM: a conflicting merge after the claim
leaves the claim durable + ABANDONED (abandon record appended,
v12), intent/outcome absent, next act at `r+1`
(v11 cycle-6 major 5 — contradicts no-longer-true v10 wording);
OMITTED `executionSeq` expectation ⇒ proceeds at the allocation
(no expectation-0 refusal); SUPPLIED mismatched expectation ⇒
`refused(execution-seq-mismatch)`; TRAILER SEQ BINDING: a rollback
whose promotion candidate's trailer `seq` ≠ the terminal promotion
execution's `r` ⇒ `unverified-provenance`, and promotion seq ≠
rollback exec suffixes is LEGAL and pinned distinct (v11 cycle-6
major 4)**);
**rollback provenance extensions (v6 majors 3+5, v7 major 3;
SPLIT v9, cycle-4 major 1 — v8 pinned one ancestor rule for BOTH
modes while §1.2 scopes the ancestor bullet to `revert` step 0c and
runs the sticky lifecycle check first in both modes; the v8 pin was
unsatisfiable together with §1.2 — after an ACKED rewind §1.2
demands `already-executed` but this pin demanded
`unverified-provenance`):**
- **`revert` mode, promotion dropped from main's history**
  (rewound/operator-rewritten) ⇒ step 0c ⇒
  `refused(unverified-provenance:promotion-not-ancestor-of-main)` —
  fixture QUALIFIED (v10, cycle-5 major 5): the dropped-promotion
  test case carries NO completed rollback outcome and NO open
  intent for the promotion (either present and 0a/0b answers first
  with the lifecycle result — an unqualified fixture contradicts
  the precedence table above);
- **`rewind` mode currency** is its step-1 pin `expectedMainTip ==
  candidateSha` — no ancestry test; main moved off the candidate ⇒
  `rewind-blocked` (the existing §1.2 code — v9 reuses it, no new
  refusal name), never an ancestry refusal;
- **post-rollback lifecycle (BOTH modes, checked at 0a/0b BEFORE
  any provenance test):** acked rollback outcome for the
  promotion ⇒ `refused(already-executed)` — incl. rewind-then-
  repeat (the promotion is non-ancestor after a landed rewind; the
  journal answers first, `unverified-provenance` must NOT mask the
  sticky fact) and SECOND `rollbackPromotion` of the SAME promotion
  actionId after a REINTRODUCE of the change (revert-of-revert or
  fresh promotion of same content) ⇒ `refused(already-executed)`
  citing the prior rollback outcome — NEVER a gated delta rolling
  back the new landing (the v6 tree-equality-detector would have
  done exactly this; v9, cycle-4 major 4 pin: a new rollback IDENTITY
  with a DIFFERENT mode while an intent from another identity is
  open ⇒ that intent resolves by its own mode first, unresolved ⇒
  `refused(intent-open)` — tested cross-identity, not just same-
  identity redelivery);
crash after CAS before outcome ⇒ `recovered` ⇒ default
rollback succeeds against the recovered record; **rewind crash
pins (v9, cycle-4 blocker 3): crash BEFORE the rewind CAS ⇒ main is
still `C` ≠ target `M` ⇒ `refused(intent-open)`, NEVER
`merged(recovered)` even though `M` is an ancestor of `C`; crash
AFTER the rewind CAS ⇒ main == `M` exactly ⇒ terminal
`merged(recovered)`**; **ABA/lifecycle pin (v10, cycle-5 major 4):
rewind intent written, no CAS; an operator independently moves main
`C → M`; recovery observes `main == M` ⇒ records the (false)
terminal `merged(recovered)`, P's rollback lifecycle is spent;
main later restored to `C`; a new rollback request ⇒ sticky
`refused(already-executed)`; the operator act
`--revoke-rollback-recovery <rollbackActionId>#<r>` (the FALSE
TERMINAL's own execution identity, v11 cycle-6 major 3) appends
`recovered-revoked` and the NEXT request proceeds — the same-MODE
retry re-enters as a fresh act AND a different-mode request passes
0b (the projection governs both, v11 cycle-6 blocker 2), plus the
FIVE invalid-target refusals, five DISTINCT codes (v13, cycle-8
minor 5: `revoke-target-not-found` / `revoke-target-not-outcome` /
`revoke-target-not-recovered` / `already-revoked` /
`revoke-target-not-rollback`; v11 cycle-6 major 3 + v12 cycle-7
major 1 + v13 code split) — the full
sequence pinned byte-for-byte (§1.2 0a's disclosed residue)**;
empty-difference pre-construction ⇒ `already-rolled-back` no-op,
never a gated empty commit; rollback of a ROLLBACK (`R`'s sha as
promotion sha) ⇒ `unverified-provenance`**);
**symref-main probes (v3, R2-B2): `main` a symbolic
ref ⇒ refusal at resolve; symref installed after the probe ⇒ numeric
CAS rejection with the OTHER branch's tip byte-unchanged (the
reproduced mis-aim, pinned as a regression); every shipped CAS call
source-bound through the `--no-deref` argv builder**; **checked-out
`main` probes (v3, R2-M5): main in a linked worktree ⇒
`main-checked-out` refusal, worktree files byte-untouched; detached-HEAD
worktree AT main's sha — pinned decision per §1.1: NEVER refuses,
discloses the matching-HEAD entry**;
routing-poison probes against main repoRoot; provenance matrix (the
STRUCTURAL §1.2 checks individually broken ⇒ `unverified-
provenance` — v10, cycle-5 major 5: the matrix enumerates the
structural checks (journal record, object exists, two-parent shape,
first/second-parent match, trailer match) ONLY; the completed-
rollback lifecycle condition is NOT in it — its answer is
`already-executed` per 0b — and the revert-only ancestor check runs
under the mode/lifecycle preconditions of the qualified fixture
above, not as a blanket matrix cell);
`--merge-base` revert construction: clean matrix, conflict abort with
NO journal outcome + no ref mutation, later-main-commits case gated on
R; rewind-blocked on head-move; rewind exactness (restored content ==
recorded M byte-proven).
**v12 cycle-7 pins:** PRE-GATE CHECKLIST ON R (cycle-7 major 5):
doctored-trailer construction (test seam) ⇒
`failed(post-construction-checklist)` with ZERO ref movement AND
ZERO gate invocations AND — v14 cycle-9 minor 7 closes the gap
between this pin and the C8-M4 disposition — a FULL JOURNAL
CENSUS: the episode journal contains EXACTLY the claim record and
its abandon record (reason `pre-intent-error`) and NOTHING else
(no `#i` intent line, no `#o` outcome line, no terminal), asserted
by parsing the journal file itself, not by mocking the writer; EACH checked field broken independently —
v13 cycle-8 minor 6 splits the census: FOUR trailer fields
(episode, action, promotion-ref, exec-`r`) + the SEPARATE commit
structural check (parent == snapshot tip — parent is a COMMIT
field, not a trailer field) + exec actionId-vs-request mismatch as
its own sixth sub-pin (v13) — six sub-pins total; REVOKE SHAPE (cycle-7 major 1): recovered plain-
PROMOTION outcome as revoke target ⇒ `refused(revoke-target-not-
rollback)` negative fixture byte-for-byte; DUPLICATE IDS
(cycle-7 major 2): journal forged with two records sharing one id
⇒ M3 projections `unreadable(duplicate-ids)` ⇒ every
claim-bearing act `refused(journal-unreadable:duplicate-ids)`,
never an arbitrary pick (fleet admission unaffected — ledger ≠
journal, §1.1 note); revoke resolution from
execution identity `A#r` to record `A#o<r>` is deterministic (the
`A#i<r>` intent is NOT a legal target UNDER FORM T1 (execution
identity resolves only to `#o<r>`; v14 cycle-9 major 5: under T2
a full record id, `A#i<r>` IS a reachable target — refused
`revoke-target-not-outcome`, which is how that code's fixture
lands), `A#r` is never itself a
record id); POISON-REOPEN BARRIER (cycle-7 major 3): two acts
queued during poison ⇒ exactly ONE reopen runs, both resume on the
replaced instance (a split-domain fixture — two independently
reopened instances appending — must be IMPOSSIBLE by construction,
the barrier test asserts one writer chain survives poison);
ORIGINATOR ADOPTION (v13, cycle-8 major 3): claim append writes a
COMPLETE line then fails at sync/close; wrapper reopen; scan finds
the operation's OWN complete claim (actionId+r+ownerEpoch tuple)
⇒ act ADOPTS and proceeds intent at the SAME `n` — pinned with
ZERO second claim records, and a re-run of the same recovery is
IDEMPOTENT (adopt twice = same single claim); concurrent different
live act at the same tuple boundary ⇒ still refused(intent-open),
the exemption NEVER extends to other operations; ABANDON-FAILURE
CONTRACT (v13, cycle-8 major 5): abandon-append complete-then-
failed-resolve ⇒ scan finds `@abandon` id ⇒ act returns its
original result, ZERO second abandon records; abandon torn-
truncated ⇒ exactly ONE retry lands one record; fence dropped
mid-abandon ⇒ `failed(abandon-ambiguous)`, zero further appends,
abandonment UNESTABLISHED — not asserted absent (v16, cycle-11
minor 2: a prior retry may have landed; the remedy is
the exact-id resolve defined in §1.1), never a silent
original-result return;
EPOCH SUPPLIER (cycle-7 blocker 1, v13 restated by cycle-8
majors 1+2): the writer-lease file publishes `{pid, token,
episodeId, epoch, journalFloor, claimedAt}` atomically via
O_EXCL link; acquire→no-claim→release→re-acquire ⇒ SAME epoch is
LEGAL and journal-invisible (the narrowed monotone promise — no
record carries a repeated epoch ⇒ no decision can depend on it);
every named writer (claim/abandon/intent/outcome/recovery/
revoke) validates token+epoch against the lease file before its
inline append, mismatch ⇒ `fence-lost` terminal with NO retry
and NO further writes (`ClaimOutcome` fence-lost member; act
result `failed(fence-lost)`; revoke `refused(fence-lost)`);
release is the ACT-LIFETIME registry barrier (close registry ⇒
new admissions `lease-closing`; await ALL registered acts
terminal; then token-conditional unlink): pause an act AFTER
its withClaimLock callback has RETURNED (claim durable, gate
pending) ⇒ release MUST NOT complete (v13 cycle-8 blocker 2 —
the queue-empty state proves nothing); FORCED-TAKEOVER
QUARANTINE (v13 cycle-8 blocker 1): takeover of a possibly
mid-append owner followed by validate-only open ⇒ mid-file
malformation ⇒ `journal-corrupted`, every claim-bearing act
refuses, zero appends, zero CAS, journal preserved; the
interleaved-append fixture asserts quarantine fires, NOT that
repair succeeds;
**v14 cycle-9 pins:** EPOCH POST-PUBLICATION RE-SCAN (cycle-9
blocker 1): acquirer stages `epoch = floor+1`, link SUCCEEDS,
re-scan finds the floor has MOVED (a prior owner journalled
between the acquirer's scan and its link) ⇒ lease body re-staged
at `1 + newFloor` via owner-only rename, token unchanged; the
delayed-publisher schedule is pinned — A floor-7-staged-8 claims
at 8 and releases, B (also staged 8 pre-A) links late, re-scan
sees floor 8 ⇒ B re-stages to 9 BEFORE any act; a fixture asserts
NO journal-visible epoch value is ever owned by two hosts across
the schedule (the old acquire-no-claim-release-reacquire same-
epoch pin survives ALONGSIDE it — repetition without journalled
records stays legal; v15, cycle-10 minor 4 FIXTURE POSTURE —
under host-lease-first acquisition two CONFORMING hosts can
NEVER stage overlapping (the shipped exclusive host lease
serializes acquisition), so the schedule above is a FAULT-
INJECTED one: the §3 harness pauses B's link syscall across A's
entire hold, reproducing ONLY the shipped delayed-reclaim race
class (`supervise.ts:2338-2346`); the fixture is therefore
labeled a DEFENSIVE-PROTOCOL test — it asserts that IF the
bounded race fires, the re-scan bump still restores the
invariant — NOT a claim that conforming scheduling produces the
race); QUIESCENCE-ORDERED QUARANTINE (cycle-9
blockers 2 + major 2): takeover ⇒ host-lease reclaim ⇒ writer-
lease replace ⇒ `inspect()` validate-only (zero writes — the
fixture asserts the journal file's bytes and mtime are
unchanged) ⇒ tail-torn evidence PRESERVED (still torn after
inspect) ⇒ old owner NOT YET quiescent (fixture pauses a
simulated old-owner append across the inspect point; ESRCH not
yet true) ⇒ acts refuse `journal-quiescing`; after ESRCH (or
operator confirmation) normal `open()` repairs the tail exactly
ONCE and admission proceeds; mid-file fixture ⇒
`journal-corrupted` refusals, writer-lease file removed, no
repair ever runs; WRITER-LEASE LIFECYCLE (cycle-9 blocker 3):
crash holding the writer-lease ⇒ successor completes the shipped
host-lease reclaim ⇒ `EEXIST` writer-lease replaced by rename
under the shipped bounded exclusivity (v15 cycle-10 blocker 2:
"proven sole holder" means sole-as-far-as-the-shipped-time-bound
establishes — see the exclusivity-posture paragraph) ⇒ quarantine
⇒ epoch from
post-bump floor ⇒ admission proceeds; competing-successor fixture
under the shipped takeover lock (one winner — the fixture tests
swap serialization only; the post-swap quarantine window is
guarded by the host lease + the predecessor ledger, v16 cycle-11
minor 1); boundary-crash
table (after host link / after writer link / between release
unlinks) each classified; act arriving between host-lease
acquisition and writer-lease derivation refuses
`lease-unavailable`; REGISTRY SEMANTICS (cycle-9 major 1): act
THROWN by injected bug still decrements (release proceeds after);
step-0 replay registers AND decrements (no phantom, no bypass);
release concurrent with admission ⇒ registered-before-close OR
`lease-closing` refusal (no in-between, event-loop-atomic
check-and-register fixture); second process with no lease
refused at admission token-check with the live-set UNCHANGED;
revoke and recovery-participating reads register and decrement;
FENCE-LOSS PRECEDENCE (cycle-9 major 3): pre-attempt fence loss on
abandon ⇒ `failed(fence-lost)`, ZERO abandon records attempted;
post-attempt discovery (abandon outstanding, fence gone at
resolution) ⇒ `failed(abandon-ambiguous)` — distinct fixtures,
distinct journal states; TWO-SIDED CONVERSION (cycle-9 major 5):
intent-then-abandon ⇒ abandon append refused; abandon-then-intent
⇒ intent append refused; both fixtures under the serialized
writer domain; REVOKE T2 (cycle-9 major 5): `revoke --target-id
A#i1` on a conforming journal (completed execution) ⇒
`refused(revoke-target-not-outcome)` — reachable, byte-pinned;
CENSUS TEST (cycle-9 minor 6): every code in the §1.1 closed
census constructible, every emitted code in the list (table
test; v15 cycle-10 major 5 extends the fixture list: the
reconciled census adds `lifecycle-blocked`, `not-replayable`,
revoke-class `refused(fence-lost)`, and
`refused(journal-unreadable:duplicate-ids)` — each gets its own
constructible sub-fixture, and the exit-code assertion follows
the result STATUS, `fence-lost` rendering exit 2 for revoke and
exit 1 for claim-bearing acts); **v15 CYCLE-10 PINS: (P1)
UNQUIESCED-CHAIN CARRY — A paused inside an append, B completes
host reclaim + step-2 writer replace (quarantine.json names A),
B CRASHES, C reclaims: C's step 4b sees A's entry and refuses
`journal-quiescing` until A's pid is proven gone — a fresh
journal append by A after C's inspect proves zero admission
proceeded while A was unproven; (P2) FRESH-READ FLOOR — a late
COMPLETE claim from the dying owner lands between steps 3 and 5
⇒ step 6's fresh post-open read includes it (derived epoch
strictly above it); a late MALFORMED line in the same window ⇒
step 6 routes to `journal-corrupted` evidence-preserved, no
repair past `open()`'s own; (P3) PENDING PHASE — step-2 body
carries `epoch: 0`/`phase: pending`; any act stamped against it
is refused by the phase gate (zero appends); a crash mid-
takeover leaves the pending file, next acquirer replaces per
rule (ii); (P4) REGISTRY DOUBLE-ADMISSION — two concurrent acts,
same actionId, both admitted (two invocation entries); the
refused loser returns, decrements ONLY its entry; while the
winner is paused mid-construction a graceful release attempt
BLOCKS (live-set non-empty) — the C10-B3 regression pin; (P5)
REVOKE GRAMMAR — `revoke --exec A#1 --target-id A#i1` together
⇒ CLI usage error exit 2, NO journal growth; NEITHER flag ⇒ same
usage error; `--target-id revoke-01ABC...` (marker id) ⇒ usage
error, zero acts; multi-condition target (non-recovered plain-
promotion outcome) ⇒ `refused(revoke-target-not-rollback)` per
the pinned check order (shape beats state); (P6) BUMP CRASH
TABLE — crash after tmp fsync-before-rename ⇒ published body is
the old epoch, orphan tmp swept by next acquirer; crash after
rename-before-dir-fsync ⇒ recovery accepts EITHER body (same
token; both conforming); admission never proceeds before the
dir fsync returns.** **v16 CYCLE-11 PINS: (P7) PRE-LEDGER CRASH
CAPTURE — A paused inside an append, B completes host reclaim
and CRASHES BEFORE publishing `quarantine.json`; C reclaims B:
C's union capture (host-lease body ∪ writer-lease body ∪
existing ledger) recovers A, admission refuses
`journal-quiescing` until A's pid is proven gone — the exact
boundary the audit named; a SECOND crash (C dies pre-ledger
too, D reclaims) is the same fixture iterated: every takeover
re-runs the union capture, no chain depth assumption; (P8)
MERGE UNDER DOUBLE-RECLAIM (v17, cycle-12 major 2 — CORRECTED;
v16 asserted `{A,B,C}` under either order, which read-merge-
publish does NOT deliver: the survivor is `{A,C}` or `{A,B}`):
two reclaimers read ledger `{A}`, one adds B, the other C, both
publish read-merge-rename — the assertion is the SNAPSHOT
BOUND: the surviving file contains A and every entry in BOTH
publishers' read snapshots (here just A), never an entry
neither publisher saw; PLUS the explicit LOST-B FIXTURE: P2's
rename lands last ⇒ `{A,C}` survives, B's ledger addition is
lost, B's writer body remains on disk and is RE-CAPTURED by the
next takeover's union rule (the disclosed merge-loss residual —
asserting the recovery, not a union that cannot be guaranteed;
v18, cycle-13 major 1: the fixture is BARRIER-CONTROLLED —
NO racing writer-body replacement — because recovery depends
on B's body surviving to the next acquisition, and the
ERASED-B JOINT-ERASURE CASE (racing takeover replaces the
writer body without capturing B, inside the residual's
check→rename windows) IS the disclosed full erasure class with
NO claimed recovery — the fixture asserts recovery in the
barrier case and the residual row states the joint-erasure
class; an anti-fixture for the erased case is NOT assertable as
safe, only as disclosed);
asserts tmp→fsync→rename→dir-fsync ordering via injected crash between
fsync(tmp) and rename (old file intact, orphan swept); (P8b)
CLEARING PUBLICATIONS ARE GUARDED AND REMOVAL-COMPOSED (v17,
cycle-12 major 3; windows and fixtures corrected v18, cycle-13
major 4) — a 4b clearing poll's host token is stolen
immediately before its rename ⇒ the publish ABORTS touching
nothing (guard fixture); a clearing publish composes removal
over its rename-time SECOND read (`currentRead − proved-gone`)
— the SURVIVAL GUARANTEE COVERS additions landing between the
pass's FIRST read and its SECOND read ONLY; an addition (or a
confirmation removal) landing between the SECOND READ and the
RENAME is outside `currentRead` and CAN BE LOST/RESURRECTED —
the disclosed window (v17's unqualified "after the read
survive" named no read and is corrected); THE RESURRECTION
FIXTURE NOW INJECTS THE MATERIAL ORDERING WITH BARRIERS USING
TWO REAL GUARDED CLEARING PUBLICATIONS (double-reclaim, v19
per cycle-14 major 1 — an operator can NEVER publish to the
ledger, so no fixture may show one): (1) clearing pass P1
(lease W1) second-reads {A,X}, ESRCH-proves A gone, stages
payload {X}, passes its immediate-before-rename guard, then
BARRIES before the rename; (2) W1 expires; acquirer T2 takes
lease W2; a confirmation for X exists; T2's clearing pass
second-reads {A,X}, proves A gone (ESRCH) and X gone
(confirmation), renames payload {} ⇒ file {}; (3) P1 wakes,
its stale rename lands ⇒ X RESURRECTED to {X} — the fixture
asserts the resurrected state OCCURS (proving the check→rename
window is real and exercised, not passed vacuously); (4)
convergence: the consumption log (v22: the pass appends
`{hostToken, watermark: L, confirmGen (v23), consumedAt}` to
`events/quiesce-consumptions.json` — every confirmation
record naming X below L is PERMANENTLY INERT while its record
is RETAINED FORENSICALLY, O_APPEND-only so no epoch-displaced
stale writer can lose the mark, v22 per cycle-17 blocker 2)
makes the confirmation INERT, so the resurrected X must be
RE-CONFIRMED (or
ESRCH-proven) by the next clearing pass — the fixture drives
that re-confirmation (the new record's offset is past every
watermark ⇒ ACTIVE) and asserts final state {} (resurrection
is disclosed and converges, never silently accepted); THE
TWO-CONFIRMATIONS FIXTURE (v21 per cycle-16 blocker 2,
restated v22 per cycle-17 blocker 1): TWO distinct confirmation
records for X — one BEFORE the pass's evidence snapshot, one
AFTER the snapshot but BEFORE the pass's PRE-GUARD watermark
read L (v25, cycle-20 major 1: L is read at total-order step 1,
before the final guard — the v23/v24 "post-guard" phrasing is
corrected here; the precise C17-B1 barrier, restated v23 per
cycle-18 major 3: "before the removal" is NOT the boundary —
arrival between L and the rename is the ACTIVE guard→rename
race below) —
both sit below the pass's watermark L, so the
fixture asserts BOTH are inert after the removal and NEITHER
re-clears X across a stale-rename resurrection; only ESRCH or a
NEW record appended after the resurrection clears; and a
GUARD→RENAME-RACE probe (v22, renamed v25 per cycle-20 major 1
— the window is watermark read → ledger rename with the guard
inside it, never "post-guard"): a record landing between the
watermark read and the ledger rename stays active (the
disclosed shipped window, `supervise.ts:1976-1988` parity) —
the fixture asserts it may clear a later resurrection, SOUND
because it is a true disappearance assertion for that exact
token (wrong-token inertness ⇒ it can never match a NEW
process's entry); a
SEPARATE CONCURRENT-APPEND fixture (v19, restated v22): operators
append to `events/quiesce-confirmations.json` via O_APPEND +
single-write + fsync; two concurrent appends ⇒ BOTH records
survive complete (no merge, no rename ⇒ no lost-append class —
v21's "one confirmation MAY be LOST, fail-safe" case is
STRUCTURALLY IMPOSSIBLE in the JSONL design, so the fixture
asserts both-land instead);
CLEARING PASS — normal acquisition with leftover ledger of
all-dead pids: clearing pass ESRCH-proves each, publishes
`predecessors: []` atomically, admission PROCEEDS (presence of
an EMPTY-set file must not refuse — file presence is not the
gate, set content is); a live reused pid is cleared only by
confirmation naming its recorded `hostToken` — a confirmation
naming a DIFFERENT token clears nothing (fixture asserts the
wrong-token confirmation leaves the entry); (P10) EXTERNAL
PHASE PRECEDENCE — second process, read-only status during
step 3 AND during step 4b (same disk state: pending writer
body + non-empty ledger) ⇒ BOTH answer `journal-quiescing`
(the collapsed conservative code — the wrapper-internal
step-3 `lease-unavailable` is asserted ONLY through the owning
wrapper); malformed ledger ⇒ `journal-quiescing`; empty ledger
+ pending body ⇒ `lease-unavailable`; ABSENCE CLASSIFIED (v17,
cycle-12 majors 4+5) — both lease bodies absent ⇒ `free`; host
present + writer absent ⇒ `lease-unavailable`; the pass-all case
answers `no-quiescence-warrant` and a fixture asserts NO status
answer is ever `admitted` (the query is a disk observation,
never act authority — an act's answer comes from attempting
acquisition); MALFORMED WRITER CLASSIFIED (v18, cycle-13 major
2; restated v19 per cycle-14 majors 2+3; arithmetic per cycle-15
major 2 folded v20) — the fixture walks the §1.1 ENUMERATED
MATRIX table's 40 NOMINAL cases (H×W×L; 36 distinct OBSERVATIONAL
cells — absent-host match/foreign are the same uncomparable state
and assert equal answers; the present-host foreign row is PRINTED
in the table, v19's footnote placement fixed) and
asserts EVERY cell equals the FIRST-matching-rule answer in
the table — no unclassified cell, no double-answer, and NOT
merely "exactly one governing clause" (v18's under-specified
assertion); malformed writer + non-empty/malformed ledger ⇒
`journal-quiescing` (a MALFORMED ledger matches R1 first —
non-empty matches R2 — the table's first-match order governs,
the more conservative answer; R3 `journal-corrupted` applies only when
R1/R2 have not matched); (P13) OPERATOR
RECOVERY SURFACE (v18, cycle-13 major 5, durable-record design;
v22 append-only watermark logs)
— `--operator-status` prints every entry INCLUDING unknown
tokens AND every record in BOTH logs annotated
`active`/`consumed`/`unknown` (v21, cycle-16 minor 1; the
`unknown` value per cycle-17 minor 1 when the consumption log
is uncomputable); `--confirm-quiesced --entry-token` APPENDS one
line (fresh `confirmId` ULID) to
`events/quiesce-confirmations.json` via O_APPEND+write+fsync
(never touches the ledger
— no lease held, no racing publisher; operators NEVER write the
consumption log except the monotone-safe ALL-watermark after a
confirmation-log repair); the lease-guarded
clearing pass treats an ACTIVE naming confirmation as proven-gone and
consumes by WATERMARK (append `{hostToken, watermark: L,
confirmGen}` (v23) — v24 ordering: L re-read, watermark
appended via a FRESH open, then the epoch-check guard as the
LAST operation before the ledger rename, then post-rename
self-verification, cycle-19 blocker 1 — every record naming
the token below L permanently inert, v22 per cycle-17 blockers
1+2) in its guarded publish; fixture drives:
4b waiting on reused-pid entry → operator appends confirmation
→ waiting loop clears on NEXT poll → admission proves
quiescence → admit (NO takeover re-run needed); a confirmation
racing a clearing publish loses ONLY its own append (an
O_APPEND WRITE FAILURE — v23 per cycle-18 minor: a race can
NEVER lose a confirmation append; the concurrent-append fixture
above proves both-land, and a failed write is the only loss mode
— fail-safe:
wedge persists, re-confirm — never unsound); wrong-token
confirmation is inert (entry stays, admission keeps refusing);
`--repair-quiescence-ledger` refuses with `ledger-not-malformed`
unless the tool's own parse says malformed; valid-or-absent
file requires printed-diff + `--force` (the manual
chain-severance act, never a side effect); copies a parseable
chainFrom VERBATIM, writes literal `null` when absent (never
invents an ulid — closes cycle-13 minor 3); `--repair-confirmations`/
`--repair-consumptions` (v22, closing cycle-17 major 1) repair
the two logs with the SAME doctrine as the ledger repair
(validate-before-publish; refused `file-not-malformed`;
valid-or-absent requires printed diff + `--force`), and EACH
append raises inert thresholds monotonically: a
confirmation-log repair appends the ALL-watermark so no
pre-repair record re-activates unless the operator confirms
anew (v22, cycle-17 major 2's clock-collision class is closed
by the ULID `confirmId` — identity never derives from
`confirmedAt`); NEW v24 FIXTURES (cycle-19): (i) BOTH INODE
ORDERINGS for the past-guard repair race — barrier-forced
repair rename BEFORE and AFTER the pass's watermark append,
asserting in both orders either the removal never lands OR a
complete (confirmGen, X, L) watermark line is present in the
CURRENT consumption log after the pass finishes (v25,
cycle-20 blocker 1: closure in BOTH orders is delivered by
the MANDATORY POST-ACQUISITION COMPOSITION plus the
append-before-guard ordering — the crash-durable theorem of
§1.1 (c) — with post-rename self-verification demoted to
redundant defense); (i-b) CRASH AFTER LEDGER RENAME,
SELF-VERIFICATION NEVER RUNS — barrier immediately after the
removal rename commits, `kill -9` before step (5) executes;
restart a fresh process and drive: (a) the two-log re-derivation
finds the (confirmGen, X, L) line IN THE CURRENT consumption
log (the repair owner's mandatory post-acquisition
composition, §1.1 (c) v25, put it there before its own
publish — this is the fixture that KILLS the C20-B1 schedule:
repair acquires with a stale pre-acquisition composition
snapshot, pass appends + guards + renames + dies); (b) a
resurrection via stale ledger rename does NOT clear X on the
original pre-L confirmation (INERT — offset < L in the same
generation); (c) only ESRCH or a NEW post-resurrection record
clears, and the run converges to {}; (d) assert the repair's
published replacement contains EVERY READABLE line
(the v26 normative predicate) of the log it replaced
[V39 SUPERSEDED (R2-M2): under (b)/(c-O) the repair publishes
NO replacement of the consumption log — the live assertion is
that the append-only log still contains EVERY pre-repair
byte, unchanged in place; the replacement-carries-every-line
assertion is the historical v26 schedule test, retained for
the record]; (e) 2V
ABORT + MALFORMED-LINE FAIL-CLOSED (v28; supersedes v27 (e)):
[V33: the v32 mapping is superseded by the V33 FIXTURE TABLE in the footer.]
with a pre-existing unterminated fragment the pass's watermark
append FUSES into a NEWLINE-TERMINATED MALFORMED LINE; 2V finds
no READABLE match ⇒ the cycle ABORTS (no guard, no rename, entry
remains). ASSERT: status `malformed-line` at its offset with raw
bytes; confirmations REFUSED; a NEXT pass ALSO aborts without
repair; automatic composition and 4b self-repair REFUSE to publish
over the file; an authorization with the digest ALONE repairs
nothing; after authorization the 4b holder (or an acquiring
repair) applies (c): the replacement carries the ALL line naming
the current confirmation length; a PRE-REPAIR confirmation is then
INERT and must be re-issued; the following pass removes normally.
[V39 note (R2-B1/M2): "replacement" here means the appended REPAIR
record's ALL watermark (c-O); no file replacement exists.]
(e-2) LANDED-WATERMARK CORRUPTION (AUD27-B1): a log holding a
LANDED (G1,X,L) watermark; corrupt THAT line into a malformed
terminated line; authorize and force-repair; ASSERT the ALL line
names the pre-repair confirmation length and a stale ledger rename
resurrecting X does NOT clear on the ORIGINAL pre-L confirmation
(inert via the ALL line); only a NEW post-repair confirmation
clears. (e-3) AUTHORIZATION BINDING: a displaced READABLE watermark
appended after authorization is COMPOSED (malformed set unchanged,
repair proceeds); a displaced malformed fragment changes the set ⇒
`authorization-stale`, no publish. (e-4) WAITING-HOLDER REPAIR: the
same flow with a live 4b holder — the holder applies (c) under its
own epoch; a non-holder receives `lease-unavailable` throughout.
(e-5) CONCURRENT CONFIRMATION BARRIER (AUD28-B1): a barrier forces a
confirmation between the L_C read and the ALL publish; ASSERT that
confirmation (offset >= L_C) remains ACTIVE and clears its entry, and
that every confirmation at offset < L_C stays inert. (e-6) REPLAY:
a second repair attempt with the SAME authId ⇒ refused (APPLIED
present); a fresh authorization over the already-repaired file ⇒
malformed set empty ⇒ refused `no-malformed-lines`. (e-7) TORN AUTH
TAIL (V34 SUPERSESSION — v30 text REVOKED by D4A-c2-1 fold): an
unterminated authorization tail is NOT ignored — a nonblank
unterminated tail fails CLOSED exactly like a terminated
nonblank-malformed line (`authorization-file-malformed` for EVERY
authorization, including one backed by a prior complete AUTH), until
the operator repair procedure (operative VALIDITY rule above; rows
F9/F14, which already carried the corrected expectation — this
fixture row had simply never been updated; pinned by
test_F9_F14_torn_auth_tail_fails_closed). A terminated malformed authorization
line refuses every authorization. (e-8) PARTIAL TAIL (δ): a torn
unterminated append ⇒ `unsettled-tail`; recovery is SETTLEMENT then
operator AUTH+REPAIR over the resulting malformed occurrence (v38,
AUD38-M2: the v30 "non-forced `--repair-consumptions` truncates it"
instruction is REVOKED here too — see the (δ) case correction).
OUTCOME CORRECTED (v39, AUD38-B1/R2-B1): the earlier "the ORIGINAL
confirmation is then ACTIVE (no watermark ever survived) and the removal
proceeds with NO new confirmation" is WRONG — the REPAIR's mandatory
ALL watermark (L_C read AFTER settlement) consumes the original
confirmation (offset < L_C), so it is INERT and the removal requires
ONE NEW confirmation (or ESRCH), exactly like (e-9). (e-9) READABLE SURVIVOR (β): the original
confirmation stays inert; the pass's 2V does not clear it; only a
NEW confirmation or ESRCH clears. (ii) CRASH-CONSISTENT
confirmation repair — kill between the ALL-line append and the
G2 tmp→rename, assert no G2 record was ever visible during the
crash window and a retry converges; after a completed repair a
COPY of a previously-consumed confirmation does NOT clear a
resurrection; (iii) waiting-holder recovery — an unsettled
consumption tail during 4b is truncated IN PLACE by the 4b
holder under its own epoch (no second acquirer, `lease-
unavailable` for every non-holder) and the wait clears on the
next poll after a fresh confirmation
[V39 SUPERSEDED (R2-M2): "truncated IN PLACE" is REVOKED —
the holder appends one `\n` (SETTLEMENT) under its own epoch,
the fragment becomes a terminated malformed occurrence, and
the wait clears only after AUTH+REPAIR masks it and a fresh
confirmation; the lease-holder-executes-the-recovery shape
is retained, the truncation is not.]; (P11) OWNER-EPOCH
FLOOR — an incoming claim record with `ownerEpoch: 0` (or
negative) is a closed-schema REJECTION (never lands, fuzz
case); every admitted journal starts at ≥1 (floor `1+max` over
surviving records); (P12) USAGE-VS-REFUSED PAYLOAD — **NAMING
DISAMBIGUATION (v18, cycle-13 minor 4): "P<n>" in this pin list
is THIS DOC's fixture counter (P1…P13, P8b) and is UNRELATED to
the P8/P12 MODULE names from docs/12/docs/16 (v20, cycle-15
minor 1: the P12 module defines NO CLI exit-code convention —
every live "P12 convention" attribution was corrected to "the
M3 convention" at its two sites; the module's actual content is
IntegrationResult statuses, so do NOT seek the exit rule in
docs/16); where both appear nearby the words pin/convention
decide — no
renumber, the C11 disposition rows cite these labels
historically.** — usage
error and refused act share exit 2 while failed acts exit 1
(v17, cycle-12 minor 5 — v16 called all three an
"exit-code-2 pair", false for `failed`); the discriminator is
the PAYLOAD, asserted from the rendered payload, not the exit
code: `status` fields are pairwise distinct (`usage` /
`refused` / `failed`).** JOURNAL-CENSUS ON THE CHECKLIST PIN (cycle-9 minor 7):
doctored-trailer fixture asserts the journal contains claim +
abandon records and NOTHING else, parsed from the file.
ORDERED PROCEDURE (cycle-7 major 6): refs moved BETWEEN the step-1
snapshot and the claim ⇒ claim still proceeds with SNAPSHOT values
(refs NOT re-read), and the CAS then proves-or-refuses — pinned
interleave; refs moved after intent before CAS ⇒ `no-effect:`
provability table unchanged.

Slice B: closed-schema fuzz (incl. malformed `episodeRoots`); the
THREE file states discriminated
(absent ≠ broken ≠ valid) with per-state admission behavior pinned;
broken-file fail-closed incl. stale; **indeterminacy fail-closed (v3,
R2-M1): an unreadable/poisoned episode ledger or nonzero
`unknownSpend` DENIES new USD admissions for every episode
(`fleet-indeterminate`), turns/wallclock admissions unaffected, and
clearing the cause restores admission**; **root-registry discovery
(v3, R2-M3): an episode under a declared NON-default root is counted
in Σ; a missing declared root ⇒ `fleet-indeterminate`, never a partial
Σ**; **coverage set-equality pins (v6, cycle-1 major 6): a declared
root with NO `RootDiscovery` entry ⇒ `fleet-indeterminate`; a
discovery entry for an undeclared root ⇒ refused; duplicate
`(root, episodeId)` inputs ⇒ refused (never double-charge); a `read`
input for an episode not in its root's complete enumeration ⇒
refused UNLESS it is the current episode (the single documented
exception, §2.2(iv)); **BOTH coverage directions pinned (v8,
cycle-3 majors):** an enumerated episode MISSING from inputs ⇒
refusal with the omitted episode named (the C2-B1 pin), AND the
extra-input direction; **rule (vi) (v8, cycle-3 blocker 3): complete
root with EMPTY enumeration + `inputs = []` + valid `current` ⇒
refusal `current-input-missing` — never a zero-Σ admit; `current`
under a failed/undeclared root ⇒ `fleet-root-unregistered`/
`fleet-indeterminate`**; **current-episode registration (v4, audit blocker 1): admit
from an unregistered custom root ⇒ `fleet-root-unregistered`, zero
ledger reads outside declared roots**; **new-vs-missing ledgers (v4,
audit major 2; v6 marker protocol): existing episode with deleted/
inaccessible ledger ⇒ `fleet-indeterminate`; brand-new directory ⇒
zero-term admission**; **init crash table, row by row (v6 blockers
1+3 + majors 1+2, v7 durable-ordering rewrite, v8 reconciliation —
pins match the §2.3 table as written, cycle-3 major 4): crash injected after
EACH durability step of `initEpisode` (ledger-file-fsync,
ledger-DIR-fsync, marker-file-fsync, marker-link, marker-DIR-fsync)
with re-consult classification pinned per the §2.3 table — ledger
dir-entry fsynced before any marker link (cycle-3 blocker 1), so NO
crash window yields a durable marker whose ledger entry was never
durable; crash after ledger-create (zero bytes) before link ⇒
`new-episode(init-pending)` ZERO TERM, healed by the owner's
`initEpisode` retry — NOT `ledger-without-init` (v8 fix of this
pin); crash after link ⇒ complete — where "complete" means the
POST-LINK directory fsync also completed: a crash strictly BETWEEN
the link and the post-link dir fsync leaves the marker entry itself
possibly-undurable, and the fixture asserts the outcome is EITHER
classification the table already defines (durable-marker ⇒ `read`;
lost-marker ⇒ back to (a)/(b) healing), never a third state (v11,
cycle-6 minor — the v10 fixture called the marker "durable after a
crash after link" without stating the post-link dir fsync had run);
ANY fsync/link FAILURE (other
than the marker link's expected `EEXIST` convergence branch) aborts
the act with no further writes — no special classification of its
own is added, the leftover bytes classify per the table as-is and
the ACT simply never reaches reserve (v9, cycle-3 major 5 refined
by cycle-4 major 3 pin: inject a marker-link dir-fsync failure ⇒
act errors, no reserve; on retry the valid-marker path revalidates
AND re-establishes the dir fsync before returning success —
cycle-4 blocker 2 pin: success from ANY path implies the full
durability chain, tested by a fail-first-fsync-then-succeed-
second-pass fixture); concurrent `initEpisode` ×2 ⇒ one marker (link EEXIST),
loser re-verifies the winner's marker, no error; CONCURRENT ledger
`O_EXCL` race: loser re-stats — zero bytes proceeds ONLY after the
loser itself fsyncs the existing file + `events/` DIR + the episode
dir UNCONDITIONALLY (v11, cycle-6 minor — the v10 "if new" residue
here contradicted §2.3's uniform rule) — per-publisher durability, the loser inherits none of
the winner's fsync obligations (v9, cycle-4 blocker 1 pin — the
fixture kills the winner between its file-fsync and dir-fsync, then
verifies the completed loser's chain survives a second crash), and
the REMNANT variant pins (v10, cycle-5 blocker 1) a creator killed
BEFORE EITHER fsync whose zero-byte file is found on a LATER
invocation's FIRST stat (no EEXIST involved): the later publisher
must open+fsync the file + fsync `events/` + the episode dir before
linking (fixture: second crash after that publisher's link — the
marker is durable AND the ledger entry is durable — never
`missing-ledger`), plus (v10, cycle-5 major 2) a publisher that
OBSERVES an already-existing `events/` (creator died before the
episode-dir fsync) still fsyncs the episode dir before relying on
it — marker durability claims never depend on who created the
directory, tested with a crash-remnant `events/` directory,
non-empty
refuses `adoption-required` (v8, cycle-3 major 5 pin);
marker-valid + ledger-absent ⇒ `unreadable(missing-ledger)` —
post-publish deletion only (the case exists ONLY if someone deleted
the file after init completed) **AND `initEpisode` called in that
state REFUSES without creating the ledger (v8, cycle-3 major 1 pin:
test the ACT, not just discovery)**; marker-absent + ledger-present
(zero bytes) ⇒ `init-pending`; (non-empty) ⇒
`unreadable(ledger-without-init)`; `adopt:true` on a clean legacy
ledger ⇒ readable, marker records `adopted:true` + `firstRecordId` +
`firstRecordTs` + `adoptedLen` + `adoptedSha256`, publish-then-recheck
verifies prefix digest + first record; adopt racing a live writer
that APPENDS PAST `adoptedLen` ⇒ recheck PASSES (append-only is
legitimate, v8 pin — prefix monotone); racing rewrite/TRUNCATION of
the validated prefix ⇒ recheck fails ⇒ `adoption-binding-broken`
(v8 naming fix — the body name; `adopt-race` never existed in the
§2.2 reason union), marker kept as evidence, consult indeterminate;
**replacement ledger with SAME first record + SAME length but
different bytes inside `[0, adoptedLen)` ⇒ discovery digest check
fails ⇒ `unreadable(adoption-binding-broken)` (v8, cycle-3 blocker 2
pin)**; `adopt:true` on a corrupt legacy
ledger ⇒ refuses without writing; owner `open()` on a
marker-initialized ledger reads byte-identically to pre-protocol
(format unchanged — cycle-1 blocker 3)**;
**inspect/read equivalence fixtures (v6 major 7, v7 §2.3
reclassification — v8 fixed the internal contradiction this pin had
with the body, cycle-3 major 4): one fixture per EOF class (`clean`,
`blank-suffix`
— records-only content with a genuinely blank final line TERMINATED
by newline; whitespace-EOF WITHOUT final newline ⇒ UNSETTLED, NOT
`blank-suffix` (v7: whitespace ≠ blank), unterminated-KEPT —
NOT counted, NOT determinate: maps to `unreadable(torn-unterminated)`
with `tailDiag:"unterminated-kept"` exactly like every other
unterminated state (v7 retired "counted, disclosed" — this pin now
matches §2.3), unterminated-CUT, duplicate-key-ambiguous,
mid-file-corrupt) asserting inspect's record set == `read()`'s ==
the owner's post-`open()` fold (the static parsing equivalence —
settling is NOT asserted from bytes), AND inspect's
tail classification == what `repairTail` actually does to that byte
sequence; population-pin: one `unterminated-cut` episode among ten
healthy ⇒ WHOLE consult `fleet-indeterminate`, Σ/usage not reported,
the nine healthy episodes' readouts unaffected (§2.3 v7 — determinacy
beats freshness)**;
**live-append determinacy pin (v6, cycle-1 blocker 4): writer pauses
mid-append (partial unterminated line visible) ⇒ `inspect()` reports
`ambiguous`/`unterminated-cut` ⇒ consult `fleet-indeterminate` for
USD, turns/wallclock unaffected; append completes ⇒ next consult
counts the record — a Σ that omits an unfinished append is never
determinate**;
**redelivery coverage (v4, audit major 5): recorded reservation
redelivered at exactly Σ ⇒ admit with no second estimate; new actionId
with any positive estimate at the same cap ⇒
`fleet-budget-exhausted`**; inequality boundary (`= cap` admits,
`> cap` denies); no-continuation-kill invariant (running attempts
untouched at exhaustion); purity (no fs in projection).

## 4. Open decisions (proposed resolutions — Hong signs off per item)

- **D1 — module shape (A):** new leaf `src/integration/promote.ts`
  rather than generalizing `integrateTestedCandidate`. **Proposed:
  yes** — preserves the tested "never main" identity of P12; audit
  history attaches per-module. **SIGNED 2026-11-16 (owner) AS
  DRAFTED** (fourth tranche; duplication of merge mechanics accepted
  as the price of confining the main-writing capability to one
  leaf — see the OWNER DECISION RECORD at the foot).
- **D2 — human-gate point (A):** host-side: promotion/rollback only
  via the explicit operator CLI act with a TTY-confirmed prompt
  (§1.4); `promoteToMain:"auto"` honored by nothing in v1.
  **Proposed: yes.** **SIGNED 2026-11-16 (owner) — option 0 (sign as
  drafted): a promotion gate that depends on config honesty is not
  a gate; a future full-loop automation (e.g. an audit loop that
  closes find→fix→test-green WITHOUT moving main) composes with
  this decision — auto-promotion would be its own later contract
  round (fourth tranche).**
- **D3 — rollback default (A):** object-store `revert` construction
  (gated candidate `R`), `rewind` as the narrow escape (head ==
  promotion sha, no gate — content is by-construction pre-promotion).
  **Proposed: yes.** **SIGNED 2026-11-16 (owner) AS DRAFTED**
  (fourth tranche; the rewind escape's blast radius equals a human
  `git reset` to the pre-promotion sha, with the journal retaining
  the erased promotion as evidence; the C5-M4 ABA remedy —
  `--revoke-rollback-recovery` TTY marker + byte-for-byte pin —
  travels with it).
- **D4 — fleet cap axes (B):** USD only in v1. **Proposed: yes** —
  dollars are the machine's scarce resource; turns/wallclock are
  endpoint/attempt shapes that don't compose across a fleet.
  **SIGNED 2026-11-16 (owner) — option 0 (sign as drafted): each
  extra axis multiplies the indeterminate population (§2.2) and would
  convert the only number the mechanism can
  approximately stand behind into apparent strictness; `caps` stays
  an extensible object so a future axis is an additive change
  (fourth tranche).**
- **D5 — fleet file state semantics (B, v3-revised):** ABSENT = not
  configured (no cap); BROKEN/STALE = **fail closed on new admission**
  (v1's fail-open-with-disclosure rejected by audit — it silently
  disabled a configured cap); unreadable/poisoned episode ledger or
  unknown-priced spend (anywhere in the population) = Σ indeterminate
  ⇒ **fleet-wide USD denial** (`fleet-indeterminate`, v3 — v2's
  per-episode refuse + "lower-bound Σ" admitted other episodes against
  spend nobody could see, and no such bound is derivable from an
  unreadable ledger). **Proposed: yes.** **SIGNED 2026-11-16 (owner)
  WITH ONE AMENDMENT — "option 3 for robustness": a scope-bound,
  non-automatic operator-acknowledgment waiver over per-episode
  indeterminacy (T2/T3 only; policy-broken T1 stays unconditional;
  acks exclude-not-value; mandatory loud disclosure; regeneration
  orphans them; new operator-owned ack store) — full binding rules
  in §2.2 (v43). The strict v3 denial remains the default behavior
  absent a valid ack.**
- **D6 — cap hardness (B, v3-revised):** accept a SOFT, admission-only,
  best-effort cap (§2.4) — **no numerical overshoot bound is claimed**
  (v2's overshoot formula withdrawn as unsupportable); reject the
  cross-episode reservation transaction for v1. **Proposed: yes** —
  if Hong needs a HARD machine-wide cap, per-episode sums do NOT
  provide one (v3 correction, §2.4); the honest mechanism is
  provider-side account budget — a separate contract round, not this
  slice's claim. **SIGNED 2026-11-16 (owner) AS DRAFTED — soft
  accepted; provider-account hard limits recorded as a separate
  human-side ACTION ITEM (owner to set them at each provider
  account); hard-cap demand would re-open the reservation-transaction
  question (see §2.4 sign-off note).**
- **D7 — build order:** Slice A first (Q5 pinned; doctrine ports per
  §1.5; the highest-blast-radius act gets the battle-tested leaf
  pattern first), B second; each slice audits (code) to convergence
  per the m3fix/M2-acceptance precedent; host wiring a SEPARATE
  increment; docs/11 ledger flips only after the wiring round closes.
  **Proposed: yes.** **SIGNED 2026-11-16 (owner) AS DRAFTED**
  (fourth tranche). Agent note recorded WITH the sign-off: D7 orders
  the TypeScript implementation slices only; the reference
  implementation (docs/21a "both, code first") built the
  confirmation-log ledger core BEFORE Slice A/B exists — this is NOT
  a D7 violation and a future reader must not read one into it.
- **D8 — promotion source namespace (A, v3-rewritten):** v2 said
  "restricted to `refs/heads/agent/**`" — REJECTED (round-2 R2-B1:
  that is P6's TASK namespace; P12 keeps episode branches out of it,
  so the guard admitted nothing producible). v3: a promotion source is
  the operator's **integration branch** — a single-element branch name
  exactly as `--episode-branch` admits and P12 advances: passes
  `check-ref-format`, NOT `agent`/inside `agent/**`, does not
  case-fold to `main`. Arbitrary human branches that violate this
  grammar are not this module's business. **Proposed: yes.**
  **SIGNED 2026-11-16 (owner) AS DRAFTED** (fourth tranche; the
  case-fold guard is filesystem-grounded on this machine — APFS is
  case-insensitive by default, so a branch literally named `Main`
  collides with `main` at the file layer while being a distinct ref
  string; the guard is the cheap correct check per P12's C2-F1
  source-side table).
- **D9 — unborn main (A):** `refs/heads/main` missing at promotion:
  v1 REFUSES (`refused:no-main`) — operator creates the branch first;
  a CAS-with-no-old-value on the machine's most important ref is not
  worth its own provability sub-table. **Proposed: yes.**
  **OWNER REPLIED 2026-11-16: "refuse" — the agent's interpretation
  (recorded as interpretation, per this doc's decision-record rule)
  is that this CONFIRMS the drafted option-A behavior (v1 refuses;
  first promotion requires a deliberate human `git branch main
  <sha>`). If the owner instead meant refusal OF the sign-off, D9
  REMAINS OPEN and this fold must be corrected — flagged to the
  owner in the fold reply (fourth tranche).**

## 5. Delivery shape (each slice, when approved)

Contract revision round HERE (attack this doc — see Status) → D1–D9
sign-off → implementer subtask per slice (leaf module + tests) →
adversarial CODE audit rounds to convergence (Sol rounds,
task-delegation review mode) → host wiring (activate.ts flags, mirror
pins, scheduler code additions) as a SEPARATE increment from the leaf
→ full-suite gate + tsc clean per round → docs/11 ledger row flips
only after the wiring round closes.

### 5.2 Honesty ledger (v12, cycle-7 minor 1 — every residual the
contract DISCLOSES rather than promises away, in one place so an
implementer cannot cherry-pick the optimistic reading; each entry
names its section):

| Residual | Where | What is honestly bounded, not eliminated |
|---|---|---|
| Forced lease-steal window | §1.1 epoch supplier | An operator-forced steal while a live owner is mid-append can INTERLEAVE multi-syscall appends (`journal.ts:631-636`) and CORRUPT THE JOURNAL mid-file — tail repair cannot fix it. v13 RETRACTS v12's claim that append atomicity holds in this window; the posture is quarantine: validate-only open after takeover, `journal-corrupted` ⇒ every claim-bearing act refuses, remedy is restore/manual repair with the journal kept as evidence. When the journal survives intact, CAS still admits at most one landing |
| Crash-burned `r` gaps | §1.1 claim/abandon | Claim allocated, crash before intent ⇒ `r` spent, lifecycle-ignored; gaps legal and meaningless |
| Abandon-window stranding | §1.1 abandonment | Crash between deciding to return and the abandon append leaves a current-epoch unconverted claim blocking alternative identities until lease turnover |
| Registry-blocked graceful release | §1.1 act-lifetime registry | A stuck act (bug or hung human gate) BLOCKS graceful lease release until it terminates or the operator forces takeover — disclosed, bounded by the same forced-takeover path (with its quarantine), no new mechanism (v14 cycle-9 minor 4: §1.1 disclosed it; this row lists it so the ledger is complete) |
| Stale-pid false-positive in quiescence | §1.1 quarantine | `kill(oldPid,0)` ESRCH proves the old process gone; a RECYCLED pid (reuse) yields a false "still alive" keeping the episode `journal-quiescing` until operator confirmation — fail-closed direction; NO elapsed-time bound is claimed (PID reuse supplies none — v16 cycle-11 minor 6 withdraws "bounded by PID space": the wait is bounded only by operator action, and the confirmation designates entries by recorded hostToken so a reused pid cannot confirm the wrong entry away) |
| Host-lease exclusion is a TIME BOUND, not a proof | §1.1 exclusivity posture | The shipped takeover lock carries a documented check→act TOCTOU and `leaseSwapHoldMs` is "NOT a scheduler-independent bound" (`supervise.ts:2338-2346`, `:2259-2272`); a delayed double-reclaim can put two hosts in writer-lease-replace races — the derivative writer fence degrades to EXACTLY this disclosed bound (adds no new failure mode; per-append validation still admits only the current lease-file token); THE FULL OUTCOME LATTICE UNDER THE RESIDUAL (v16, cycle-11 major 1 — v15's "worst case is the torn-tail class" understated it and is corrected here and in §1.1): spurious `fence-lost` (mild) → torn-EOF tail (repaired at open) → MID-FILE INTERLEAVED CORRUPTION when the displaced holder was mid-append (RESTORE-CLASS: `journal-corrupted`, manual repair/restore with the journal as evidence — same class as the forced-steal row); NO-RESTORE-CLASS safety requires the stronger fencing protocol (O_EXCL-chained compare-and-write) scoped as M3-ADJACENT hardening work, not assumed here (v15, cycle-10 blocker 2; v16 lattice restatement) |
| Quiescence ledger is takeover-local | §1.1 quarantine | `events/quarantine.json` proves predecessors dead across takeover chains ONLY on this host family's episode dir; an operator who deletes the file severs the chain (manual act, restore-evidence remedy; NEVER automatic — ABSENCE IS THE EMPTY SET by the v17 single posture: a fresh episode never created the file and is not refused, and a deleted ledger is OBSERVATIONALLY IDENTICAL to fresh absence — that is exactly what makes severance undetectable and therefore a residual, v17 cycle-12 major 4; a MALFORMED file is the fail-closed `journal-quiescing` case remedied by the OPERATOR SURFACE's `--repair-quiescence-ledger` (the phrase "operator-signed minimal-ledger procedure" is WITHDRAWN — the procedure is file-permission-gated, not signature-gated, C14-m2); ESRCH on a recorded pid clears it (dead-is-dead); unknown predecessors are entries `{pid: 0, hostToken: "unknown-<ulid>", seenAt}` cleared only by confirmation naming that token (v17 cycle-12 major 6); operator clearing of a pid-reuse entry designates the entry by its recorded `hostToken`, never by pid (v16, cycle-11 major 4); MERGE-LOSS RESIDUAL (v16; restated v17, cycle-12 majors 2+3): under the double-reclaim race two reclaimers last-rename-win with read-merge-publish — the guarantee is the SNAPSHOT BOUND (every entry in a publisher's own read survives; the survivor ⊇ entries both snapshots observed), and an addition a publisher never observed CAN be LOST, including a just-confirmed-away entry resurrected by a stale clearing rename; loss/reurrection is bounded, DETECTABLE at the next clearing pass; re-capture by the next takeover's union rule holds ONLY WHILE the predecessor's writer body survives on disk — under the residual's check→rename windows a racing takeover CAN erase the identity from ledger AND writer body jointly while its process is live, and NO QUIESCENCE-BOOKKEEPING invariant survives that triple erasure — the journal-side epoch-validation lattice (fence-lost/torn/restore-class) is INDEPENDENT of the ledger and STILL BOUNDS B's late-append damage (v19, cycle-14 major 6 reconciliation: identity-proof failure vs journal damage are separate; the lattice is the damage bound) (v18, cycle-13 major 1 — the FULL class is stated; a real exclusion protocol, M3-ADJACENT, is the only closure) — disclosed, not closed |
| Torn-fragment `r` reuse | §1.1 B4 reconciliation | `open()` repair truncates an ambiguous claim line; re-allocating the same `n` is proven-safe recovery, not reuse — the non-reuse promise covers SURVIVING records only |
| Cap is soft, no numerical bound | §2.4 | The cap is SOFT and §2.4 claims NO numerical overshoot bound (v13 cycle-8 minor 3 corrects v12's §5.2 wording "by one candidate estimate" — an unsupportable numeric); concurrent admissions may overshoot by an unquantified margin; determinacy of the NEXT consult is what is claimed. **SIGNED SOFT by owner 2026-11-16 (D6): the real hard stop is provider-account budget limits — a human-side action OUTSIDE this repo (action item open until Hong sets them); this contract never promises more than a governor** |
| `fleet-indeterminate` fail-closed | §2.2 | An unreadable ledger denies ALL new USD admissions fleet-wide until repaired (ledger-scope only; a journal defect — duplicate ids, mid-file corruption — is per-ACT refusal, never fleet denial: ledger ≠ journal, v13 cycle-8 minor 2) |
| Operator-ack waiver UNDERCOUNTS by design | §2.2 (v43, owner D5 option 3, 2026-11-16) | An acknowledged indeterminate episode is REMOVED from the accounting population, so Σ admits against a KNOWN-INCOMPLETE total: acknowledged spend is invisible to the cap, permanently and by construction. Bounded not by math but by procedure: one-episode-one-ack scope, policy-generation expiry, mandatory disclosure on every affected verdict, T1 (policy broken) and root-enumeration failure NEVER waivable. The waiver trades cap completeness for fleet liveness — the owner's explicit robustness choice; the fleet-indeterminate row above remains the default posture for unacknowledged indeterminacy |
| Forward reader compat | §1.1 schema block | A pre-extension reader meeting a new record kind fails closed at open; only M3-aware stacks may host M3 journals |
| `grantedBy` is not authorization | §1.0 | The field is recorded evidence, never trusted; the human gate is structural (TTY-confirm), not an authentication mechanism |
| `revoke-<ulid>` needs no clock trust | §1.1 id scheme | ULIDs are sortable labels, not timestamps of truth; journal ORDER is file order, not claimed wall-clock |
| Rewind erases history | §1.2 | Narrow escape by design; promoted content after the pin ⇒ `rewind-blocked`, manual operator path only |

---

## Disposition of the v1 self-audit (2026-11-13; findings against v1 — historical round record; two v2 dispositions below were themselves superseded by the v3 round, marked †)

| Sev | v1 finding | v2 disposition |
|---|---|---|
| blocker | gate bound to EPISODE TIP while CAS advances an untested merge commit (§v1 A.1) | candidate-first sequence: merge-tree → commit-tree `C` → gate on `C` → CAS to `C`; moved-`M` = no auto-rebuild, operator re-issue bumps `executionSeq`, stale gate evidence never reused (§1.1) |
| blocker | `git revert` is worktree-running porcelain (probe: rewrites worktree+index, writes `.git/AUTO_MERGE` state); no isolation; no provenance that the sha IS an authorized promotion (§v1 A.2) | object-store `--merge-base` inverse merge + commit-tree (no index/worktree — probe-verified tree-exact vs the recorded pre-image); full provenance checklist against journal + parentage + trailer before any ref touches (§1.2, §1.3) |
| major | "last durable projection" promised a store/freshness that doesn't exist (§v1 B.2) | † no invented store; v2's replacement (per-episode refuse + lower-bound Σ) REJECTED by round 2 — v3: fleet-wide `fleet-indeterminate` denial (§2.2, R2-M1 below) |
| major | admission formula omitted the candidate; claimed race bound unsupportable (§v1 B.3) | explicit inequality incl. `candidateEstimate`; A6 unknown-spend posture; bound WITHDRAWN — cap declared soft; † v2's replacement overshoot formula and hard-cap alternative REJECTED by round 2 — v3 claims NO numerical bound (§2.4, R2-M2 below) |
| major | invalid/stale file silently disabled a CONFIGURED fleet cap (§v1 B.1) | three-state discrimination; broken/stale fails CLOSED on new admission; deletion is the explicit un-configure act (§2.1) |
| major | CLI-only + non-empty `grantedBy` conflates text with authorization; first-parent alone not promotion evidence (§v1 A.1) | explicit threat model; durable binding = journal ⇄ trailer ⇄ parentage; human gate structural at host (TTY-confirm); no claim rests on `grantedBy` honesty (§1.0, §1.3, §1.4) |
| major | no target field, yet tests "refuse MAIN as target"; case-fold at the target was wrong (§v1 A.1/§3) | target is a compile-time constant; unknown-field fuzz refusal pinned; C2-F1 table relocated to the SOURCE guard (§1.1, §1.5, §3) |
| minor | records dated/claimed too strong ("zero drift", "verbatim", one-round sign-off) | HANDOFF + docs/11 rows downgraded to unreviewed-proposal wording; adversarial doc round gates sign-off (Status, §5) |

## Disposition of the round-2 review of v2 (2026-11-13; every finding verified against `src/` and/or reproduced on the lab git BEFORE acceptance — all resolved in v3)

| ID | Sev | v2 finding (verification) | v3 disposition |
|---|---|---|---|
| R2-B1 | blocker | §1.5/D8 restrict promotion sources to `refs/heads/agent/**` "exactly what P6 provisions and P12 advances" — FALSE: `agent/<ep>/<task>` is the TASK namespace (`provision.ts:433`); P12 refuses episode branches inside it (`merge.ts:25–27,441–451`); the host grammar forbids `/` (`activate.ts:143`) — the guard as written admits NO promotable branch | D8 rewritten to the real P12 episode-branch rule (single element, out of `agent/**`, not `main`-folding); §3 pins an end-to-end test promoting a REAL P12-advanced branch (§1.5, D8) |
| R2-B2 | blocker | prescribed `update-ref refs/heads/main C M` follows a symbolic ref — REPRODUCED on git 2.54: symref `main→other`, the CAS advanced `other`, `main` untouched (the module believes it promoted; it renamed someone else's branch) | `--no-deref` on EVERY CAS (promotion, revert, rewind); symref refusal at resolve (P12's probe ported); post-probe symref race ⇒ numeric rejection with the other tip byte-verified unchanged (§1.1/§1.2/§1.5, §3) |
| R2-M1 | major | §2.2 admits OTHER episodes against a "lower-bound Σ" when one ledger is unreadable: $100 cap, A unknown, B $20 ⇒ admission on B alone; "last known bound" has no store when the ledger is unreadable; disclosure ≠ a cap check | indeterminate Σ (unreadable ledger or unknownSpend anywhere) ⇒ fleet-wide USD denial `fleet-indeterminate`; repair or re-root to restore; non-USD admissions unaffected (§2.2/§2.3, D5) |
| R2-M2 | major | §2.4's overshoot "= concurrent estimates + estimation error" is not an upper bound (estimates under-price, reads go stale); "episode caps summed under target" is no hard cap (P8 ceilings are themselves estimate-checked, `ledger.ts:1296–1305`, and cover only capped+discovered episodes) | both formulas WITHDRAWN; the contract claims no numerical overshoot bound; hard cap = provider-side account budget, explicitly out of surface (§2.4, D6) |
| R2-M3 | major | discovery enumerates `~/.tre/episodes` only — episodes run under `--episodes-root` (`activate.ts:71`, `supervise.ts:2771`) spend outside the cap silently; no population definition for archived/moved episodes | operator-declared `episodeRoots` registry in the fleet file (default as before); missing declared root ⇒ `fleet-indeterminate`, never a partial Σ; lifetime boundary (dir removed from population ⇒ out of Σ) declared; registry + missing-root regressions in §3 (§2.1/§2.3) |
| R2-M5 | major | promotion/rollback CASes `main` while `main` may be CHECKED OUT — the checkout silently shows reverted/advanced content vs reality; P12 documents this exact hazard for its branch (`merge.ts:443–449`) but v2 inherited no guard | refuse `main-checked-out` (worktree-list probe, both acts; P12's doctrine: never sync a foreign checkout); post-probe race disclosed as the accepted single-act class (§1.1/§1.5, §3) |
| R2-m1 | minor | `.tre/remaining-items-review.md` still asserted "No audit has an open finding" + "one Telegram round closes sign-off" WHILE hosting the pending-round entry — self-contradicting status | both lines qualified: closed rounds vs the OPEN docs/21 contract round; the one-round claim removed wherever it survived (that file, this round) |

## Disposition of the confirming-round audit of v3 (2026-11-13 — all resolved in v4)

| ID | Sev | v3 finding (verification) | v4 disposition |
|---|---|---|---|
| A-B1 | blocker | §2.3 registered the population but not the CURRENT episode: valid policy + default root configured, then admit from `--episodes-root /elsewhere` — the consult reads only declared roots, so that episode's spend is invisible to Σ (R2-M3 with the roles reversed) | consult takes the host's own resolved episodes root + episode id; canonicalize (`realpath`, `~` expansion, trailing-slash strip) and byte-compare against canonicalized registry entries; unregistered current root ⇒ `fleet-root-unregistered` refusal, zero reads outside declared roots; the current episode's freshly-read records are always in Σ (§2.3) |
| A-M2 | major | §2.3 discovered "directories holding a ledger" — a missing/inaccessible `events/budget.jsonl` for an EXISTING episode drops it from the population, so the §2.2 unreadable-ledger rule never fires; `BudgetLedger.read()` ENOENT-returns-empty (`ledger.ts:1593`) makes the conflation easy | † discovery enumerates episode DIRECTORIES; per-directory outcome classified via the host-created layout marker (`createEpisodeLayout`, `supervise.ts:2777`): marker-present-but-unreadable ⇒ `fleet-indeterminate`, marker-absent ⇒ genuine-new zero term; any read throw (corrupt/EACCES/EIO) ⇒ indeterminate, never skipped (§2.3) — **marker heuristic SUPERSEDED by v5 (finding B1: layout precedes the ledger; the rule rejected every first admission); directory-enumeration + fail-closed-read survive in the v5 init protocol (§2.3)** |
| A-M3 | major | `projectFleet(recordsByEpisode, …)` / `fleetSummary(recordsByEpisode, …)` cannot express the promised states: raw arrays conflate unreadable with empty; per-root discovery results and policy-file state have no parameter | discriminated inputs: `EpisodeInput` (`read { records }` vs `unreadable { reason }`, one per discovered directory — no absent variant) + `FleetPolicyInput` (valid/absent/broken); I/O stays in the host, projection stays pure; consult and readout share IDENTICAL input types so they cannot disagree (§2.2, §2.5) |
| A-M4 | major | §1.1 step 2 always runs `commit-tree -p M -p E`: on `M == E` git ignores the duplicate parent (reproduced on git 2.54 — "duplicate parent ignored") and mints a ONE-parent commit the gate would test and the CAS would land, while §1.2 demands exactly two parents for rollback provenance | `M == E` stops BEFORE commit construction with durable `already-merged` (no candidate, no gate, no journal write, no ref mutation); status semantics + end-to-end duplicate-parent pin in §3 (§1.1, §1.2-statuses) |
| A-M5 | major | §2.3 always adds `candidateEstimate` to holds — but P8 redelivery of an already-recorded reservation is COVERAGE, adding no second hold (`ledger.ts:2204-2210`): at exactly Σ == cap a valid redelivery is fleet-refused though it grants no new spend authority | redelivery presenting a receipt/actionId the freshly-read records already contain takes the coverage path: `candidateEstimate = 0` for this consult, current policy + Σ still checked; changed-policy-no-longer-covering still refuses (P8 C2-F10 posture); no-record redelivery takes the normal path (§2.3) |
| A-m6 | minor | `HANDOFF.md:22` gave the pre-R2-B2 command `update-ref refs/heads/main C M` without `--no-deref` — the exact unsafe form v3 rejects | handoff command corrected to `update-ref --no-deref`; historical unsafe forms in dispositions stay explicitly labeled as rejected |

## Disposition of the first confirming-round audit of v4 (2026-11-13 — all resolved in v5)

| ID | Sev | v4 finding (verification) | v5 disposition |
|---|---|---|---|
| B1 | blocker | §2.3's layout-marker rule rejects legitimate NEW episodes: the host creates the layout INCLUDING `graph.json` before any ledger op (`supervise.ts:2781`, `journal.ts:48`), `BudgetLedger.open()` never creates the file, `read()` ENOENT→empty (`ledger.ts:1574,1599`) — marker-present/no-ledger is the NORMAL first-admission state and froze fleet admission | v5 durable explicit init protocol (§2.3) — **[partially superseded by v6 cycle-1 B1/B3: the header form broke the owner reader and mis-distinguished deletion; the SIDECAR-MARKER protocol replaces it; "never infer admission from the layout marker" survives]** |
| B2 | blocker | §2.3 mandated `BudgetLedger.open()` per discovered episode — `open()` runs `repairTail()`, truncating+fsyncing (`ledger.ts:1581,1674`) another LIVE episode's ledger mid-append with no cross-episode serialization | read-only `BudgetLedger.inspect()` with no write path (§2.3) — equivalence claim scoped further in v6 (major 7 below) |
| M3 | major | per-root discovery failures unrepresentable: `EpisodeInput[]`+`FleetPolicyInput` carry no per-root result; empty-readable-root and failed-enumeration produced identical inputs | required `RootDiscovery[]` parameter (§2.2) — completed to closed-form set equality in v6 (cycle-1 M6) |
| M4 | major | redelivery coverage on insufficient identity: "receipt or actionId" — P8 checks action+reservedUsd+reservedTurns+receiptDigest (`ledger.ts:2196-2203`) and redelivery is observation, not permission (`ledger.ts:2214`) | full four-field P8 identity match + coverage-mode re-check; observation-only stated (§2.3) |
| M5 | major | `M == E` shortcut conflicts with open-intent recovery: unconditional `already-merged` without journal write strands P12's tail-intent closure (docs/16; `merge.ts:687` suppresses its own shortcut when an intent is open) | §5b recovery BEFORE the equality shortcut; `refused(intent-open)` when not descended (§1.1) — input-path ordering fixed in v6 (cycle-1 M4); rationale corrected in v6 (cycle-1 m1: landing makes M==C, never M==E) |
| M6 | major | contradictory replay contract: sticky `already-executed` copied from P12 while a terminal `merged` replay returned `already-merged` (`docs/16 §3`) | one pinned contract: terminal replay ⇒ `refused(already-executed)` sticky (`stage:"dedup"`); `already-merged` reserved for the graph no-op (§1.1 statuses) |
| m7 | minor | HANDOFF described `M == E` AFTER commit-tree+gate; the check must precede construction | HANDOFF sequence rewritten: dedup/recovery → `M == E` stop → merge-tree → commit-tree → gate → CAS |

## Disposition of the confirming-round audit of v5 — CYCLE 1 (2026-11-13; every finding verified against `src/` and reproduced on the lab git (git 2.54) BEFORE acceptance — all resolved in v6)

| ID | Sev | v5 finding (verification) | v6 disposition |
|---|---|---|---|
| C1-B1 | blocker | init classification cannot separate new from DELETED-WITH-SPEND: marker…file-absent + dir + graph present is exactly the "never-initialized" zero-term state after an operator deletes just `budget.jsonl` — the episode's spend silently leaves Σ, contradicting the §2.3 delete test the protocol claimed to satisfy | SIDECAR marker (§2.3 v6): valid marker + absent ledger ⇒ `unreadable(missing-ledger)` ⇒ `fleet-indeterminate` — deletion is DETECTED, never reclassified; crash table row-by-row with fail-closed directions |
| C1-B2 | blocker | prescribed worktree grammar does not exist: real `git worktree list --porcelain -z` emits `branch refs/heads/main\0\0` — attribute+value SPACE-separated, records end with an empty field; a literal parser of v5's `branch\0refs/heads/main\0` fails on every normal repo ⇒ `worktree-probe-failed` freeze (byte-dumped on git 2.54, attached/detached/bare) | grammar re-pinned to the reproduced form (§1.1 step 1, §1.5) + captured-dump fixtures (§3) for attached/detached/bare/space-path/prunable |
| C1-B3 | blocker | the v5 header line is NOT a `LedgerRecord`: unchanged owner `read()` validates every line (`ledger.ts:354-365,1592-1598`) and THROWS on mid-file non-records — every initialized ledger fails its own `open()`; first admission freezes | evidence moves OUT of the ledger to `events/budget-init.json`; `budget.jsonl` format stays byte-UNCHANGED — owner reader untouched (§2.3 v6-1; pin: owner `open()` byte-identical post-init) |
| C1-B4 | blocker | tolerant read of an in-progress final append omits a LIVE hold from Σ: an unterminated fragment may be a torn tail OR a live append still in flight — the observer cannot tell (`ledger.ts:1592-1598,1628-1651`), yet v5 declared the result determinate + disclosure | `unterminated-cut`/`ambiguous` EOF tails make the CONSULT indeterminate (`unreadable(torn-unterminated)`, USD-only); `unterminated-kept` counts+discloses; paused-partial-append pin (§2.3 v6, §3) |
| C1-M1 | major | init not atomically published: `open("ax")`+append leaves empty/partial states with no defined recovery, `EEXIST` revalidation-freeze unrecoverable, no fsync/dir-fsync ordering | atomic tmp+fsync+rename+dir-fsync; full crash/recovery table incl. concurrent init ×2 (§2.3 v6-1/2; §3 crash-injection pin per step) |
| C1-M2 | major | no migration path for existing headerless ledgers: legacy episodes hit `EEXIST` with a first line that isn't the header — freeze or unspecified exception (two incompatible implementations) | legacy = marker-absent/ledger-present ⇒ `unreadable(ledger-without-init)` (fail closed) + explicit operator `adopt:true` CLI act (clean-read required, marker records adoption) (§2.3 v6-3; §3 pin) |
| C1-M3 | major | rollback can revert a promotion NOT in current main's history (post-rewind/history-rewrite): journal passes, inverse-merge applies the candidate's base to an unrelated tree, gate lands content no promotion introduced | provenance adds `merge-base --is-ancestor C currentMain` ⇒ `refused(…:promotion-not-ancestor-of-main)`; second-rollback ⇒ tree-equality ⇒ `already-rolled-back` no-op (§1.2; §3 pins) |
| C1-M4 | major | recovery stranded behind step 1: open-intent replay still routed through episode-branch read + tip pins, which a post-crash moved/deleted branch fails before step 5b ever runs | recovery-path input rule (§1.1 step 0, v6): recovery reads main + journal evidence ONLY; pins/fresh reads run only on the no-record path; §3 pin replay after branch move/delete |
| C1-M5 | major | recovered landings unrevertible: `recovered` outcome not declared a TERMINAL `merged` record for §1.2 provenance; acceptance record undefined on recovery | recovery writes a terminal `merged` (kind) with `recovered:true` + acceptance record — fully equivalent downstream (§1.1 5b; §3 crash-after-CAS ⇒ recover ⇒ rollback pin) |
| C1-M6 | major | coverage claim not enforceable: a declared root with NO discovery entry, duplicate `(root,episode)` inputs (double-charge), and the current-episode exception vs "exactly corresponds" all underspecified | closed-form rules (i)-(iv) (§2.2 v6): `DR == CR` set equality, no duplicates, inputs ⊆ complete enumerations with the SINGLE current-episode exception (§2.3 registration stays intact); §3 pins |
| C1-M7 | major | equivalence pin conflates parsing with repair I/O: `open()` = read + MUTATING repair (can fail where inspect cannot); `tornTail:true` conflates whitespace-suffix/kept/cut; §3 promised the pin but contained none | claim scoped to byte-classification over (lines, endsNL); five-state `tail` enum replaces the boolean; §3 gains per-class fixtures + explicit out-of-scope note for repair-I/O failure |
| C1-m1 | minor | repeated claim "landing makes `M == E` true" — landing makes main == `C` (two parents), never `E` | rationale corrected (§1.1 step 2 + 5b): graph-no-op can never stand in for a landed intent; recovery is by candidate descent |
| C1-m2 | minor | §3 said the detached-at-main decision is "pinned at implementation" while §1.1 already pinned it | §3 reworded to the pinned decision (never refuses, discloses matching-HEAD entries) |
| C1-m3 | minor | estimate floor/raise attributed to "D2" — §4's D2 is the human-gate decision | attributed to docs/12 D2 / ledger `estimateRaised` (`ledger.ts:395`), §4 D2 disambiguated |
| C1-m4 | minor | header claimed v5 dispositions at the foot — the table was absent | v5-round table added above; v6 table (this one) appended; header claims now match the document |

## Disposition of the cycle-2 audit of v6 (2026-11-13; 2 blockers + 6 majors + 3 minors — findings against v6, each verified against `src/` before acceptance)

| ID | Sev | v6 finding (verification) | v7 disposition |
|---|---|---|---|
| C2-B1 | blocker | coverage rules enforce only input→enumeration: a declared root enumerating {A,B} with inputs {A} alone passes all four rules while B's spend vanishes from Σ — admit against a violated cap | rule (v) added (§2.2): for EVERY complete root, every enumerated episodeId appears as EXACTLY ONE input — refusal, never partial sum; missing-input pin (§3) |
| C2-B2 | blocker | crash between durable marker publish and first ledger record permanently freezes the fleet: the table yields `missing-ledger` forever, and the "queued first record appends" self-heal is a fiction (a restarted owner passes the fleet gate before any reservation; `open()`/`repairTail()` do not create a missing ledger — `ledger.ts:1574-1582,1674-1682`) | durable ORDERING replaces the fiction (§2.3): ledger created COMPLETE (empty, `open(O_WRONLY\|O_CREAT\|O_EXCL)`+fsync) BEFORE the marker is `link()`-published — no crash window yields marker-with-partial-ledger; zero-byte ledger + no marker = proof of zero spend ⇒ `init-pending` zero term, no freeze; marker+absent-ledger stays permanently `missing-ledger` (operator-only — deletion-with-spend stays fail-closed) |
| C2-M1 | major | permitted no-effect replay has no executable path: step 0 replays it, but the v6 recovery-path rule confines steps 1–6 to the "no-record fresh-act path" — a record exists on the replay, so a literal implementation cannot build/gate/CAS | recovery-path rule re-scoped (§1.1): scopes to paths that answer WITHOUT executing (sticky + step-0 recovery); THREE fresh-execution paths named (F1 fresh / F2 un-acked `no-effect:` replay with steps 1–6 against current reality, intent `actionId#r<n>`, `executionSeq` bumped / F3 refused(intent-open) terminal); §3 pins `…#r2`/`…#r3` id discipline |
| C2-M2 | major | the current-episode exception is not representable: `projectFleet(inputs, roots, policy, now)` cannot distinguish the legitimate unlisted input from an unauthorized extra one — identical arguments, opposite verdicts | `CurrentEpisode = {root, episodeId}` parameter added to BOTH `projectFleet` and `fleetSummary` (§2.2, §2.5); the exception is keyed by it; the current root must be a COMPLETE declared root (the exception never overrides a failed/undeclared root) |
| C2-M3 | major | ancestry + tree equality do NOT establish rollback lifecycle: after promote→revert→REINTRODUCE, `C` is still an ancestor and the old actionId's inverse delta is non-empty again — a repeat rollback removes independently-gated new work; unrelated edits turn the pinned no-op into a conflict | lifecycle is journal-keyed (§1.2 v7): the rollback act journals by the promotion's actionId; a second rollback of the SAME actionId ⇒ `refused(already-executed)` — tree equality retained ONLY as the empty-difference no-op; reintroduction is a NEW promotion act with a NEW actionId; §3 revert-of-revert pin |
| C2-M4 | major | marker publication is replace-unsafe: concurrent init and adoption each write a tmp and rename — adoption evidence silently lost; "two equal inits" untrue (differing `created:ts`) | ATOMIC NO-REPLACE publication (§2.3): `link()` (EEXIST = loser re-verifies the winner); loser's tmp discarded; content divergence resolved by ownership, not merge |
| C2-M5 | major | adoption does not bind its validation to the ledger it marks: a live writer can replace/extend the ledger between validation and publish; the table checks marker validity, not the first-record binding | adoption binds (§2.3 v7): marker records `adopted:true` + `firstRecordId`/`firstRecordTs`/`adoptedLen`; publish-then-recheck verifies the first record byte-identically; race ⇒ `unreadable(adopt-race)`, consult indeterminate; §3 racing-append pin |
| C2-M6 | major | `unterminated-kept` claims settled finality from bytes alone (writer may still append legal trailing bytes — `ledger.ts:1628-1653` vs `repairTail` `:1815-1824`); whitespace-only EOF classified `blank-suffix` ⇒ a live whitespace-prefix append drops its hold from a DETERMINATE Σ | determinacy beats freshness (§2.3 v7): ANY population `unterminated-cut`/`ambiguous` ⇒ WHOLE consult `fleet-indeterminate` (USD-only fallback, readouts unaffected); whitespace-EOF without final newline is UNSETTLED — never `blank-suffix`; `blank-suffix` requires a genuinely terminated blank line; §3 population pin + whitespace-prefix case |
| C2-m1 | minor | §1.1 (at the equal-tips paragraph) still says landing makes `M == E` true — contradicts step 2 and the C1-m1 disposition | rationale rewritten at THAT occurrence (§1.1): landing makes `main == C` (two parents), never `main == E`; equality under an open intent means main arrived by another route |
| C2-m2 | minor | the `read` variant admits `unterminated-cut`/`ambiguous` while prose says they never arrive as projection inputs | union narrowed (§2.2): `status:"read"` requires a newline-terminated stream (`tail?: "clean" \| "blank-suffix"`); the unsettled classes are discovery findings routed to `fleet-indeterminate`, not inputs |
| C2-m3 | minor | the absent/absent table cell required "(and init succeeds)" — making a read-only consult depend on a write | cell reworded (§2.3): discovery classifies DIRECTLY; the owner's next admission runs `initEpisode` before its own reserve — discovery never initiates |

## Disposition of the cycle-3 audit of v7 (2026-11-13; 3 blockers + 5 majors + 3 minors — findings against v7, each verified against `src/` and the live git durability semantics before acceptance)

| ID | Sev | v7 finding (verification) | v8 disposition |
|---|---|---|---|
| C3-B1 | blocker | ledger-first does not durably order the ledger DIRECTORY ENTRY before the marker: file fsync persists content, not the entry; crash after marker link + lost dir fsync ⇒ durable marker + absent ledger = the operator-only freeze, contradicting the "provably closed" claim | §2.3 ordering hardened: after ledger-create fsync the **`events/` DIRECTORY** (episode dir too, if `events/` is new) BEFORE any marker link; the crash table's valid/absent cell now states the deletion-only proof; per-boundary crash tests pinned (§3) |
| C3-B2 | blocker | adoption binding insufficient: marker records first-record id/ts + length but NO prefix digest — a replacement ledger with the same first record, equal/greater length, and later spend OMITTED passes both the act's recheck and discovery's check, understating Σ | marker records `adoptedSha256` = SHA-256 over `[0, adoptedLen)` (§2.3); publish-recheck and EVERY consult verify first record + length ≥ + prefix digest; legitimate append-only extension distinguished from prefix mutation; §3 same-first-/-length-different-bytes pin |
| C3-B3 | blocker | coverage still omits the CURRENT episode: complete-but-empty enumeration + `inputs = []` passes rules (i)–(v) while the current episode's existing spend vanishes — `CurrentEpisode` makes the exception representable but never requires the identity to occur in inputs | rule (vi) added (§2.2): exactly one input with `(root, episodeId) == current` is REQUIRED; empty enumeration + empty inputs ⇒ refusal `current-input-missing`, never zero-Σ admit; the (iv) exception applies ONLY to that required input; §3 pins both this and mismatched identity |
| C3-M1 | major | init algorithm conflicts with the permanent missing-ledger state: step (a) "no ledger ⇒ create it" under a valid marker converts deletion-with-spend into a zero ledger; marker-first-checking implementations instead refuse | §2.3: **classification is marker-FIRST, publication stays ledger-first** — valid marker + absent ledger ⇒ `initEpisode` REFUSES `missing-ledger` without creating a byte; corrupt marker ⇒ refuse; only marker-ABSENT creates; §3 tests the ACT (initEpisode in that state), not just discovery |
| C3-M2 | major | replay identity undefined: `actionId` = request-snapshot hash but F2 bumps `executionSeq` — if the bump feeds the snapshot the replay finds no prior outcome, if not the hash rule is incomplete; `r<n>` suffix allocation undefined | identity discipline (§1.1 step 0, v8): `actionId` hashes the frozen request fields EXCLUDING `executionSeq`/pins; execution identity = `(actionId, executionSeq)`; `r` suffix allocated durably as `max(existing suffixes)+1` scanned from the journal — collision-free under concurrent replay; §3 pins changed-pins replay + repeated replay `#r2`→`#r3` |
| C3-M3 | major | rollback lifecycle lacks recovery/retry precedence: only an ACLED rollback outcome is the lifecycle fact; crash between rollback CAS and ack, un-acked `no-effect:`, open intent, and rewind-mode masking (promotion no longer ancestor ⇒ `unverified-provenance` hides the sticky answer) all undefined | §1.2 precedence table added: **0a** the rollback's OWN record dedup/recovery (keyed by its own logical actionId, `#r<n>` doctrine); **0b** promotion lifecycle SECOND — terminal ACLED rollback ⇒ `refused(already-executed)` in BOTH modes BEFORE the ancestor test; **0c** structural provenance + ancestor (revert-scoped) THIRD; **0d** empty-difference no-op FOURTH; §3 pins crash-between-CAS-and-ack ⇒ third request `already-executed`, rewind-then-repeat ⇒ `already-executed` not `unverified-provenance` (v9 note, cycle-4 minor 3: these pins were claimed here but ABSENT from the §3 release-bar text in v8 — v9 added them, split by mode: see the "rollback provenance extensions" pin block, incl. rewind crash-before/after-CAS pins) |
| C3-M4 | major | §3 release-bar pins contradict the v7 body: crash-after-empty-create pinned `ledger-without-init` (body: `init-pending`); append-during-adoption pinned FAIL (body: append-only legitimate); `unterminated-kept` pinned counted/determinate (body: `torn-unterminated`, not counted); the C2-B1 "missing-input pin" was actually the extra-input case | §3 rewritten to match the body rule for rule (v8): `init-pending` pin, append-PASSes vs prefix-replacement-FAILS split, `unterminated-kept` → `unreadable(torn-unterminated)` with `tailDiag`, BOTH coverage directions + rule (vi) pins added |
| C3-M5 | major | `O_EXCL`/fsync/link FAILURE paths unspecified: ledger-create EEXIST loser behavior missing; owner may proceed after a failed fsync/link; linked-but-dir-fsync-lost marker undefined — §3 demands both initializers converge without error | §2.3 failure-state machine (v8): ledger `O_EXCL` EEXIST ⇒ re-stat (zero ⇒ proceed on winner's file; non-empty ⇒ `adoption-required` refuse); ANY fsync/link failure ABORTS the act, no reserve, no classification change, retry idempotent from (a); leaked tmp is inert, cleanup never removes published evidence; §3 pins |
| C3-m1 | minor | the "marker AND ledger both absent **(and init succeeds)**" text survived at §2.3's discovery bullet after its table-cell fix | bullet reworded (§2.3): discovery classifies DIRECTLY, read-only, no init involved |
| C3-m2 | minor | §1.1 calls F3 one of "three fresh-execution paths" while F3 is an explicit terminal refusal | reworded (§1.1): TWO fresh-execution paths (F1, F2); F3 listed as "NOT an execution path" |
| C3-m3 | minor | §3 and the C2-M5 disposition name `unreadable(adopt-race)` — a reason that never existed in the §2.2 union; the live name is `adoption-binding-broken` | §3 renamed to `adoption-binding-broken` (body name); disposition row left as the historical record, this row is the correction |

## Disposition of the cycle-4 audit of v8 (2026-11-13; 3 blockers + 7 majors + 4 minors — findings against v8, each verified against `src/`, the §1/§2 body text, and git durability semantics before acceptance — all resolved in v9)

| # | sev | finding | disposition (v9) |
|---|-----|---------|------------------|
| C4-B1 | blocker | concurrent init: the `O_EXCL` loser that re-stats zero bytes proceeds to marker publication WITHOUT establishing the fsync chain for the winner's file — B can link+dir-fsync on a ledger whose entry A never fsynced; the "durable marker proves durable ledger entry" proof fails for the permitted race, and A's file-fsync failure doesn't stop B | §2.3(a) EEXIST branch: the loser OPENS the existing zero-byte file and fsyncs IT, then fsyncs `events/` (episode dir if new) before linking — durability is PER-PUBLISHER, none of the winner's obligations inherited; §3 pin: kill winner between its file-fsync and dir-fsync, completed loser's chain survives a second crash |
| C4-B2 | blocker | valid-marker retry is "no-op" — if the prior act's marker-link dir-fsync FAILED, the retry returns success and the owner reserves on a not-durably-recorded marker; a later crash loses the marker entry, non-empty ledger ⇒ `ledger-without-init` freeze the protocol exists to prevent | §2.3(b): the valid-marker path REVALIDATES AND re-establishes durability (fsync ledger file if present + `events/` DIR) before returning success — success from ANY path (fresh or retry) means the full chain is durable; §3 pin: fail-first-fsync, succeed-second-pass fixture |
| C4-B3 | blocker | rewind recovery reuses the revert descendant test: the rewind's CAS target `M` is an ANCESTOR of `C` before the CAS ever runs, so "R descended into main" (as written) reports `merged(recovered)` while main still contains the promotion — acking a rollback that never happened, then sticky-refusing the real one | §1.2 0a EXCEPT-clause: rewind intents record target `M` and candidate `C`; landing proven by TIP IDENTITY `main == M` exactly (disclosed ABA residue, conservative alternative weighed+rejected); `main != M` ⇒ `refused(intent-open)`, never an ack; §3 pins crash BEFORE rewind CAS ⇒ intent-open, AFTER ⇒ merged(recovered) |
| C4-M1 | major | §3 pinned `promotion-not-ancestor-of-main` for BOTH modes whenever the promotion is dropped, while §1.2 scopes the ancestry bullet to revert 0c and answers sticky lifecycle first in both modes — after an acked rewind §1.2 demands `already-executed`, the pin demanded `unverified-provenance`; unsatisfiable together | §3 provenance pins SPLIT per mode: revert ⇒ ancestry refusal at 0c; rewind ⇒ currency is `expectedMainTip == candidateSha` (moved ⇒ `rewind-blocked`); post-rollback lifecycle (both modes) ⇒ sticky `already-executed` before any provenance test |
| C4-M2 | major | the discovery summary bullet said marker-absent/ledger-present ⇒ blanket `unreadable(ledger-without-init)` while the crash table row 4 classifies marker-absent/ZERO-byte as `new-episode(init-pending)` zero term — two consult results for the same crash state | §2.3 discovery bullet splits BY LEDGER BYTES like the table: zero bytes ⇒ `init-pending` zero term (healed by retry), non-empty ⇒ legacy `ledger-without-init` pending adoption |
| C4-M3 | major | `link` EEXIST is BOTH the designed loser convergence path and, literally, "any failed link aborts"; §3's "any fsync/link FAILURE … NO classification change" is impossible — a linked-then-dir-fsync-failed marker is visible and legitimately changes discovery | §2.3 failure machine: aborts cover ANY fsync failure and link failures OTHER THAN the marker link's expected `EEXIST`; "fail the ACT" redefined honestly — no special classification is ADDED, leftovers classify per the table as-is, what is forbidden is proceeding to reserve; §3 pin replaced with the permitted classifications (inject link dir-fsync failure ⇒ act errors, no reserve; retry re-establishes) |
| C4-M4 | major | 0a protects only redelivery of the SAME rollback identity: a first attempt (mode A) CASes, crashes pre-ack; a second request with a DIFFERENT logical actionId (mode B) finds no own record, no acked lifecycle, and can construct a second act against the same promotion while the first intent is open | §1.2 gains 0a′: BEFORE executing any new rollback identity against promotion `P`, scan for an UNRESOLVED intent from ANY rollback act naming `P`; found ⇒ resolve by ITS OWN recorded mode's rule first, still unresolved ⇒ `refused(intent-open)`; §3 cross-identity pin (revert-intent-open + rewind-request) |
| C4-M5 | major | request supplies `executionSeq` AND the module allocates `r` = journal-max+1 with no reconciliation rule — stale/skipped/concurrently-identical sequences unspecified; re-scan-on-collision names no atomic reservation; F2 text said "executionSeq bumped" | §1.1 identity discipline REFINED: `executionSeq` is an OPTIONAL EXPECTATION (docs/15 §4 re-issue path), never identity; the `r` suffix is journal-allocated, the INTENT APPEND IS THE ATOMIC CLAIM (single-writer journal); supplied ≠ allocated ⇒ `refused(execution-seq-mismatch)`; the allocated `r` is what intent/outcome/trailer record; F2 replay text reworded to "freshly ALLOCATED suffix" |
| C4-M6 | major | two requests differing only in excluded pins hash to the same actionId; step 0 answers by ID alone — never stated whether a changed-pin request against an existing `r` is the same redelivery, a hostile collision, or a reissue | §1.1 redelivery comparison stated: pins NEVER participate in identity; pins are preconditions on an EXECUTION, not on the ANSWER — acked ⇒ sticky recorded outcome regardless of new pins; fresh paths (no-effect replay, recovery-permitting replay) run the NEW request's pins and journal a distinct allocated `r`; all discriminating fields ARE frozen identity fields, so same-actionId ⇒ same frozen fields; a new act under moved pins requires a different logical identity, and each `r` attests exactly its own intent record |
| C4-M7 | major | adoption says "the same link-based no-replace act as (b)" but only the link: no fsync of the legacy ledger or its directories pre-link — a visible-but-not-durable legacy ledger can vanish while the adopted marker survives, breaking the deletion-only explanation of valid/absent for adopted markers | §2.3(3): adoption inherits the FULL durability ordering (fsync legacy ledger file + `events/` DIR + episode dir if new, pre-link; post-link dir fsync; same abort-and-retry machine) — an adopted marker's SUCCESS return means the full chain is durable |
| C4-m1 | minor | status header still enumerated "three" recovery-path members (fresh / no-effect replay / sticky-terminal) while §1.1 correctly names TWO fresh-execution paths | header reworded: TWO fresh-execution paths; sticky-terminal is a non-executing answer, not a third path |
| C4-m2 | minor | adoption marker records `firstRecordTs` but only `firstRecordId` is rechecked — ts validation required or diagnostic? | §2.3 pinned: `firstRecordTs` is DIAGNOSTIC ONLY (digest already covers the record's bytes; a clock-skewed re-serialization must not break a byte-identical binding) |
| C4-m3 | minor | §3 and the C3-M3 disposition claim rollback crash/rewind pins that do not appear in the §3 release-bar text | the pins were genuinely absent — v9 adds them (split-by-mode block above: rewind crash before/after CAS, cross-identity intent pin) and annotates the C3-M3 row as corrected-here |
| C4-m4 | minor | §1.1 step 3 says actionId = hash over "the canonical request snapshot" bare — could be read as including the fields step 0 excludes | step 3 restates the exclusions (`executionSeq` + optional pins) and cross-references the step-0 discipline |

## Disposition of the cycle-5 audit of v9 (2026-11-13; 3 blockers + 5 majors + 4 minors — findings against v9, each verified against `src/` (`journal.ts`, `merge.ts`, `ledger.ts`), the §1/§2 body text, and git durability semantics before acceptance — all resolved in v10)

| # | sev | finding | disposition (v10) |
|---|-----|---------|-------------------|
| C5-B1 | blocker | the initially-existing zero-byte ledger path establishes no per-publisher durability: v9's fsync chain is spelled only for the creator and the `O_EXCL` EEXIST loser — an initializer that finds a crash-remnant zero-byte file on the first stat can publish+sync a marker and return success without ever fsyncing the ledger file or `events/`, so a later crash leaves a durable marker over a non-durable ledger entry (`missing-ledger`, frozen admission) | §2.3(1)(a): the initial-stat zero-byte branch is the SAME per-publisher chain as the EEXIST loser — open + fsync the existing ledger, fsync `events/` (episode dir if new), then the marker link chain; "every successful publisher establishes the full chain" now covers creator/loser/initial-stat/retry/adoption uniformly; §3 pin: creator killed before EITHER fsync, later publisher completes, second crash, discovery still classifies the marker's chain as durable |
| C5-B2 | blocker | the cross-identity guard (0a′) is a check, not an atomic claim: two rollback identities can both pass 0a/0a′/0b after their scans and both append+execute — per-instance append serialization does not serialize scan→append transactions across callers/processes (evidence: `journal.ts:602-606` per-instance serialization; `merge.ts:264-267` separate read/append port) | §1.2: the promotion-scoped claim is an ATOMIC TRANSACTION inside the exclusive serialization domain — 0a/0a′/0b are RE-EVALUATED at intent-append time under the writer's lock and the intent appends atomically with the claim (the append IS the claim; a failed claim re-runs 0a/0a′/0b for the loser, which answers per its re-evaluated state, never executing); ownership = the journal's single-writer ownership fence; §3 pin: two calls paused after both initial scans, released together ⇒ exactly one claim record, the other refuses per 0a′/0b **(v11 superseding note, cycle-6 minors 3-4: the CLAIM is a distinct `promotion-claim` RECORD appended BEFORE construction — not the intent append itself — serialized by `withClaimLock` and liveness-guarded by `ownerEpoch`; the "intent is the claim" phrasing of this round predates v10's claim-before-construction reorder and v11's epoch protocol, and the "§3 pins omitted expectation, mismatch, unequal suffixes" claim of C5-M3 was fulfilled only in v11's §3 additions)** |
| C5-B3 | blocker | the identity hash covers "all frozen fields except seq/pins" — `now` is a required frozen request field, so a retry at a later injected clock hashes to a DIFFERENT actionId, missing its own open intent/sticky outcome (promotion recovery strands its CAS-window intent; rollback's own-record protection is bypassed) | §1.1 identity fields ENUMERATED explicitly: `{episodeId, promotionActionId, mode}` — `now`, per-invocation metadata (`grantedBy`), `executionSeq`, and pins EXCLUDED; "all frozen except" phrasing removed everywhere; §3 pin: retry with a different injected `now` (and/or `grantedBy`) resolves to the same actionId and hits its sticky/open record, both rollback modes incl. completed/redelivery |
| C5-M1 | major | the trailer-bearing candidate is built BEFORE the contract allocates `r`: step 2 constructs the commit (trailer carries the allocated suffix), step 3's intent append is the allocation claim — two callers can build against the same provisional suffix and the loser cannot reuse its candidate with a re-allocated suffix (wrong trailer + sha) | §1.1 execution order REORDERED: the CLAIM record (journal-allocated `r`, promotion-scoped, inside the same atomic transaction as C5-B2) is appended BEFORE candidate construction — commit construction happens only under a held claim, so the trailer's `seq` == the claimed `r` by construction; crash after CLAIM before INTENT ⇒ burned `r` (gap disclosed), step-0 dedup IGNORES claim records, re-issue proceeds at the next allocation; §3 pins concurrent construction + claim-crash |
| C5-M2 | major | the per-publisher directory chain is incomplete when `events/` pre-exists from another act: "if `events/` is new" exempts the retry/second publisher from fsyncing the EPISODE DIRECTORY, so the entry naming `events/` itself may never be durable (adoption path likewise) | §2.3 uniform rule: EVERY publisher/retry/adoption fsyncs the episode directory UNCONDITIONALLY before relying on child entries — the "if new" conditional removed; §3 fixture: creator crashes between `events/` creation and episode-dir fsync, second publisher's success survives a later crash (directory-remnant fixture) |
| C5-M3 | major | `executionSeq` keeps mutually incompatible meanings: the request text still says "default 0" + sole disambiguator (a reader can treat omission as expectation-0 and refuse a first allocation), and §1.3's single `seq=<executionSeq>` cannot name both the promotion's execution (rollback trailer references the PROMOTION) and the current execution | §1.1: default-0/disambiguator wording DROPPED — omitted ⇒ no expectation, supplied ⇒ must match the allocation or `refused(execution-seq-mismatch)` (the name was already defined, §1.1 line 474 — no orphan); initial rule pinned: empty journal ⇒ first execution is `r1`; §1.3 trailers carry TWO distinct identities: the promotion-REFERENCE (`<promotionActionId>#<r'>`, the promotion's OWN allocated execution) vs the acting execution's own `seq` — never one seq for both; §3 pins omitted expectation, mismatch, replay, unequal promotion/rollback suffixes **(fulfilled in v11's §3 additions — cycle-6 minor; and the notation is disambiguated there: journal execution ids use `<actionId>#<r>`, the git trailer's promotion-reference field uses `<actionId>@<promotionR>` — two syntaxes for two media, v11 cycle-6 minor)** |
| C5-M4 | major | the ABA disclosure understates rewind recovery's lifecycle consequence: operator moves main `C→M` before recovery ⇒ recovery records a FALSE-ATTRIBUTION terminal `merged(recovered)` that PERMANENTLY SPENDS P's rollback lifecycle (main later restored to `C` ⇒ the needed rollback is sticky-refused); v9's "strictly worse than a stale already-executed on a state" rationale omits the future consequence | §1.2 0a disclosure restated at FULL STRENGTH (false durable lifecycle assertion; permanent spend; conservative alternative weighed+rejected again); an explicit operator remedy defined: `--revoke-rollback-recovery <promotionActionId>#<r>` appends a `recovered-revoked` journal marker reopening the rollback lifecycle (audit/lifecycle-correction act, module-NEVER-automatic, TTY-confirmed); §3 pins the full sequence byte-for-byte (operator-move-before-recovery ⇒ false terminal; later restoration; sticky refusal; revoke; next request proceeds) |
| C5-M5 | major | §3 still contradicts the mode-scoped precedence: the dropped-promotion revert pin demands the ancestry refusal without qualifying that no rollback lifecycle completed (the very next pin demands sticky `already-executed` first), and the blanket "each §1.2 check individually broken ⇒ `unverified-provenance`" matrix includes the lifecycle condition (answer: `already-executed`) and the revert-only ancestor check in rewind mode | §3 dropped-promotion fixture QUALIFIED (no completed rollback outcome, no open intent — either present ⇒ 0a/0b answers first); provenance matrix restricted to the STRUCTURAL checks (record/object/two-parent/parent-match/trailer-match) ONLY, mode/lifecycle preconditions stated separately per the qualified fixture |
| C5-m1 | minor | the discovery summary begins with unqualified `inspect() OK ⇒ read` — a marker-absent zero-byte ledger inspects "OK" (zero records) yet must classify `init-pending` | §2.3 summary ORDER restated: marker/ledger PRESENCE classification precedes inspection; `inspect()` runs only on the marker-valid + ledger-present leg |
| C5-m2 | minor | "Σ determinate iff the stream ENDS WITH NEWLINE" excludes the crash table's valid zero-byte ledger (zero bytes contain no newline) | §2.3: the one byte-level exception named — a ZERO-BYTE stream ends-with-newline VACUOUSLY (zero bytes contain no partial record) and determinates as the zero term |
| C5-m3 | minor | `adopt-all` text makes episodes missed by the walk categorically `ledger-without-init` — but absent/absent and absent/zero-byte are zero-term states | §2.3: missed episodes classify by the §2.3 table (absent/absent ⇒ `new-episode`, absent/zero-byte ⇒ `init-pending`, ONLY absent/NON-EMPTY ⇒ `ledger-without-init`); fail-closed phrasing scoped to the non-empty case |
| C5-m4 | minor | "operator re-issue with `executionSeq` bumped" survives in two live §3/§1.1 texts despite v9's optional-expectation model (bumping a supplied expectation is not how re-issue works) | reworded at both sites: a re-issue is a fresh act at the journal-ALLOCATED next `r`; a carried `executionSeq` expectation must match the allocation — never "bumped" as the mechanism |

---

## Cycle-6 dispositions (audit of v10 → v11; 2 blockers + 5 majors + 7 minors)

| ID | severity | finding | disposition |
|---|---|---|---|
| C6-B1 | blocker | a claim cannot both exclude a live competitor and be ignored after a crash: post-claim/pre-intent state is identical for a paused owner and a crashed one; no liveness test, release, or fencing generation exists — treat claim as burned ⇒ both may execute inverses; treat as held ⇒ a crash strands the lifecycle | §1.1/§1.2: claims carry `ownerEpoch` (the P7 fence's monotonic generation, spawnGen precedent `journal.ts:480-486`); unconverted claim from a DIFFERENT actionId blocks (`refused(intent-open)`) IFF `ownerEpoch == currentEpoch` (live paused owner); epoch mismatch ⇒ stale BY CONSTRUCTION (an epoch changes only when the exclusive fence moves, which per P7 happens only after the old owner died/released) ⇒ ignored, its `r` burned, no stranding; SAME-actionId unconverted claim ⇒ ignored, fresh act at next allocation; NO death inference from intent-absence — the epoch IS the liveness proof; §3 pins live-owner-refusal and stale-takeover separately |
| C6-B2 | blocker | the revoke remedy does not override rollback's OWN sticky dedup: 0a maps the false `merged(recovered)` ack to `refused(already-executed)` BEFORE the lifecycle check, so the promised post-revoke retry can never proceed | §1.2: full journal PROJECTION defined — a `merged(recovered)` outcome referenced by a later `recovered-revoked` is treated as NEVER WRITTEN for every lifecycle reading (0a own-record dedup: same-mode retry re-enters fresh, closed intent NOT revived, new `#r` allocates; 0b: P's rollback lifecycle reopens; 0a′ unchanged); ACLED non-recovered terminals are NEVER revocable; §3 pins both-mode retries after revoke |
| C6-M1 | major | the "atomic transaction inside the writer" is not provided by the named interface: `append` is queued per instance, `read` is separate (`journal.ts:602-630, 638+`; `merge.ts:264-267`) — the P7 fence excludes another OWNER, not two concurrent async calls inside one legitimately fenced owner | §1.1: new journal primitive `withClaimLock(scanAndAppend)` queues the ENTIRE scan+evaluate+append callback on the same per-instance pending chain that serializes `append`; host wiring in scope (single fenced writer instance per episode journal; the plain read-then-append path is ILLEGAL for claims); poisoned-instance rule pinned: reopen-and-rescan before any retry, decide landed-vs-torn from the reopen (`open()`'s §13.1 repair truncates a torn tail), retry allocates FRESH — never reuses an ambiguous `r`; §3 fixture: two async acts through `withClaimLock` in ONE process ⇒ one claim; the illegal path attempts and refuses |
| C6-M2 | major | `promotion-claim` and `recovered-revoked` have no implementable journal schema: the shipped reader enforces a CLOSED record union and rejects unknown kinds AT OPEN — an invented kind fails journal recovery, not just the append | §1.1 schema block: exactly TWO new kinds extending the union via a docs/11 Change Ledger row (the §14.3 route): `PromotionClaimRecord {kind, actionId, r>=1, promotion? (required on rollback claims), ownerEpoch>=0}`, id `actionId#r<n>@claim` positional; `RecoveredRevokedRecord {kind, targetOutcomeId (unique record id), operator}`; validation rules pinned; reader changes pinned scope (union + validateSupervisorRecord + the two projections); backward compat: old journals read byte-identically under the new reader; a pre-extension reader meeting a new kind fails closed at open — disclosed (only M3-aware writers append them) |
| C6-M3 | major | revoke target and repeat behavior ambiguous: `<promotionActionId>#<r>` cannot name the false terminal (the rollback act owns its own `r`; the promotion has an execution `r` too); no behavior for nonexistent/non-recovered/double targets | §1.2/§1.4: target = the ROLLBACK execution's own `actionId#r` (the identity the sticky dedup keys on — uniquely selectable); eligibility: target must exist, be an OUTCOME, be RECOVERED (`revoke-target-not-found` covers nonexistent AND non-outcome records; `revoke-target-not-recovered` covers ACLED terminals); double revoke ⇒ `refused(already-revoked)` (idempotence by refusal — two markers would make the projection ambiguous); runs under the `withClaimLock` writer chain, claims no `r`; result contract `{revoked} \| refused(reason)`; §3 pins all four refusal classes |
| C6-M4 | major | the trailer provenance checklist doesn't require the promotion execution seq to match: one promotion can have multiple execution records after no-effect replays; §1.2 enumerates only episodeId+actionId while §1.3 added `seq` precisely to identify an execution; the "not a security boundary" note reads as license to compare less | §1.2 checklist bullet extended: candidate trailer `seq` must EQUAL the resolved terminal promotion execution's `r` (mismatch ⇒ `unverified-provenance`); the rollback trailer's `promotion=<actionId>@<r>` binds to the SELECTED terminal execution, `exec=` to its own claim-allocated `r` — both checked at their own sites; note re-scoped: forgeability ≠ comparison-scope, every §1.3-defined field is compared; §3 pins deliberately mismatched seq and unequal promotion/rollback suffixes (legal, distinct) |
| C6-M5 | major | claim-before-construction contradicts the no-journal-write release wording: `already-merged` and conflict paths still promise "no journal write"/"abort before any journal write", impossible after a durable claim | §1.1 PRECISE CLAIM POINT: claim is appended AFTER step-0 dedup/recovery AND AFTER the refs-only `M == E` check (`already-merged` stays NO-JOURNAL-WRITE — never reaches a claim); conflict surfaces post-claim ⇒ BURNS it (wording corrected to "before any COMMIT, before the gate, before the INTENT/OUTCOME write"), r-gap disclosed like every crash-burned `r`; rollback 0d empty-difference (construction-side tree check, post-claim) same treatment; §3 pin: conflict leaves claim durable, intent/outcome absent, next act at `r+1` |
| C6-m1 | minor | status header says cycle 5 had "3 blockers + 7 majors + 4 minors" while its own disposition table records 5 majors | header corrected to "3 blockers + 5 majors + 4 minors" |
| C6-m2 | minor | §2.3 crash-ordering explanation and the §3 EEXIST-loser pin still say episode-dir fsync "when/if `events/` is new", contradicting v10's unconditional rule | both residuals rewritten to UNCONDITIONAL (v11 note at each site); grep-clean: no live "if new" fsync conditional remains (historical disposition rows are history) |
| C6-m3 | minor | C5-B2's historical disposition ("re-evaluation at intent-append; the append IS the claim") misstates v10/v11's live order (distinct CLAIM record, pre-construction, `withClaimLock`+epoch) | C5-B2 row annotated with a superseding note pointing at v10's claim-before-construction reorder and v11's epoch protocol |
| C6-m4 | minor | C5-M3's disposition claims §3 pins omitted expectation, mismatch, and unequal suffixes — the live §3 never pinned them | the three pins ADDED to §3's identity/claim block (v11), and the disposition row annotated that fulfillment landed in v11 |
| C6-m5 | minor | discovery summary says `inspect()` runs only on the marker-valid+ledger-present leg but keeps marker-present/ledger-ABSENT in the `inspect()`-throws parenthetical — self-contradiction | §2.3 summary restated: marker-valid + ledger-absent is decided BY PRESENCE at classification (`unreadable(missing-ledger)`), never reaching `inspect()` |
| C6-m6 | minor | notation collision: §1.3 trailer uses `<actionId>@<promotionR>` while dispositions describe the reference as `<actionId>#<r'>` | disambiguated (C5-M3 row annotated + §1.3 unchanged): journal execution ids use `#`, the git trailer's promotion-reference field uses `@` — two syntaxes for two media; the revoke CLI argument is a JOURNAL id (`#`) |
| C6-m7 | minor | §3 crash fixture calls the marker durable "after link" without stating the post-link directory fsync completed — a crash strictly between link and post-link dir fsync leaves the marker entry itself possibly undurable | fixture text extended: "complete" = post-link dir fsync also completed; the link-then-crash-strictly-before window asserts the outcome is EITHER already-defined classification (durable-marker ⇒ read; lost-marker ⇒ healing retry), never a third state |

## Disposition of cycle 7 of the confirming-round audit of v11 (2026-11-13; 4 blockers + 6 majors + 4 minors, each verified against `src/` before acceptance — all resolved in v12)

| ID | Sev | v11 finding (verification) | v12 disposition |
|---|---|---|---|
| C7-B1 | blocker | the epoch fence has no supplied generation or handoff barrier: no storage, no durable monotonic allocation, no defined value passed into the locked scan; cited `spawnGen` is per-session-spawn (`journal.ts:480-487`), the shipped journal only ASSUMES a caller fence (`:632-636`), the host lease explicitly disclaims mathematical exclusion (`supervise.ts:2259-2272, 2335-2342`); no quiesce requirement — A claims, releases with construction live, B ignores A's claim, both proceed | §1.1 EPOCH SUPPLIER: `ownerEpoch` stamped from the P7 writer-LEASE FILE at acquisition, allocated `1 + max(ownerEpoch over ALL journal claim records)` (journal is the durable floor — monotone across restart even if the lease file loses state), re-validated on EVERY fenced append (superseded instance fails closed), release is a BARRIER (quiesce all in-flight acts before the lease drops); forced-steal residual disclosed in §5.2 (operator-forced takeover during a live owner's append window is bounded, named, not promised away); §3 pins monotonicity across restart, superseded-append failure, and release-quiesces-first |
| C7-B2 | blocker | a LIVE same-actionId competitor is explicitly treated as a crashed reissue: v11 ignores same-actionId unconverted claims ALWAYS, so two concurrent same-mode requests (identical identity fields ⇒ identical actionId) each claim and construct; CAS proves one lands, both journals exist | §1.1: same-actionId unconverted claim with `ownerEpoch == currentEpoch` ⇒ `refused(intent-open)` (a duplicate live call is a duplicate call, not a reissue); ignore-and-reissue ONLY under a non-current epoch (crash reissue after a fenced acquisition, next `r`, prior burned); §3 pins two same-mode requests paused after the FIRST's claim ⇒ second refuses; crash + new acquisition ⇒ reissue proceeds |
| C7-B3 | blocker | a normal conflict strands another rollback identity for the whole owner epoch: revert claims P, conflicts, returns no-intent; the claim stays unconverted-current-epoch, so the operator's rewind (different actionId) is `refused(intent-open)` forever — nothing completes or marks the claim | §1.1 CLAIM ABANDONMENT: EVERY pre-intent return path (conflict, 0d empty-difference, construction failure) appends third new kind `promotion-claim-abandoned` (reason union; validation: named execution has a claim, NO intent) converting the claim for eligibility (neither unresolved nor blocking — same allocator status as crash-burned); abandon-window crash residual disclosed §5.2 (blocks alternative identities until lease turnover — the alternative re-opens the live-double-construct C7-B2 just closed, so the window is accepted, bounded, named); §3 pins conflict-then-different-mode-without-restart ⇒ proceeds, crash-in-window same-epoch ⇒ refuses, post-acquisition ⇒ proceeds |
| C7-B4 | blocker | a poisoned claim append can reuse precisely the suffix v11 says must never be reused: `r1` append fails leaving a torn fragment, `open()` truncates (`journal.ts:718-720`), the scan finds nothing, returns `r1` again — v11's pin demanded BOTH truncation and non-reuse with no high-water evidence making both possible | §1.1 reconciliation: the reopen scan is AUTHORITATIVE and re-allocating a truncated torn `n` is PROVEN-SAFE recovery (durable-before-resolve ⇒ an unresolved append leaves NO surviving record in any readable state; a COMPLETE landed claim is SEEN and allocates `n+1`); the non-reuse promise NARROWS to "never reuse a SURVIVING record's `r`" (enforced by the scan); §3 pin restated both ways (torn-truncated ⇒ equal `n` legal; surviving ⇒ strictly greater); wrapper-OWNED reopen (cycle-7 major 3): exactly one reopen per poison, replaced instance shared under the chain |
| C7-M1 | major | revoke eligibility never restricts the target to a rollback: a promotion crashed after CAS recovers as `merged(recovered)`, passes v11's validation, and the projection would reopen the PROMOTION's own sticky lifecycle — outside the act's rollback-only scope | §1.2/§1.4: the target's execution `(actionId, r)` must resolve to an INTENT `actionId#i<r>` of ROLLBACK shape (promotion reference + `mode ∈ {revert, rewind}`); recovered-promotion target ⇒ `refused(revoke-target-not-rollback)` — fifth refusal class (header/§3 counts updated four→FIVE); §3 negative fixture byte-for-byte |
| C7-M2 | major | execution identity and outcome record id are conflated and uniqueness assumed: intent `actionId#r<n>` vs revoke arg "the outcome record's id `actionId#r`" — either they collide (envelope `id` exists, `journal.ts:385-392`) or the CLI identity is not the outcome id as stated; `read()` REPORTS duplicates, never rejects (`:663-668, 706-715`) | §1.1 RECORD-ID DISCIPLINE: per execution `(actionId, r)` — claim `#r<n>@claim`, abandon `#r<n>@abandon`, intent `#i<n>`, outcome `#o<n>` (shipped `merge.ts:702-705` precedent), revoke `revoke-<ulid>`; execution identity is a CONSTRUCT resolved to records; revoke CLI takes `<actionId>#<r>` → deterministically `actionId#o<r>`; M3 writer fails closed on duplicate ids AT APPEND; a duplicate-id journal at OPEN ⇒ projections `unreadable(duplicate-ids)` ⇒ every claim-bearing act refuses (never an arbitrary pick; fleet admission unaffected — ledger ≠ journal, scoped in-text); §3 pins nonexistent/duplicate/non-outcome targets |
| C7-M3 | major | the locked callback's append/reopen semantics can deadlock or split the serialization domain: the queued callback calling the queued public `append()` queues behind itself; post-poison acts reopening independently get separate instances with independent pending chains (`journal.ts:602-606, 616-622, 638-660`) | §1.1 typed contract: `ClaimOutcome` closed union (`claimed`/`refused(reason)`/`failed{ambiguous,reopened}`) returned by `withClaimLock`; the callback receives a bound NON-REENTRANT `appendInline` (runs FROM INSIDE the chain — no requeue); the WRAPPER owns the instance and the poison-reopen barrier (one reopen, head-of-chain, repaired instance replaces the shared reference); §3 split-domain impossibility fixture |
| C7-M4 | major | conversion is keyed by actionId, not execution: claim `A#r1` unconverted + a later intent suffix 2 makes r1 look converted though its own intent never existed; an intent for another suffix proves nothing about r1 | §1.1: conversion by EXACT execution identity — claim `A#r<n>@claim` is converted iff intent `A#i<n>` exists; unequal-suffix interleave pin added to §3 |
| C7-M5 | major | the rollback-trailer comparison is asserted with no checking site: the checklist covers the promotion candidate; "checked at their own sites" for `promotion=`/`exec=` names no code point, no mismatch result — a builder emitting the wrong refs has no specified refusal | §1.2 PRE-GATE CHECKLIST PASS ON R: immediately after commit-tree, BEFORE any gate invocation, the full §1.2 checklist re-runs against R (trailer fields, promotion-ref binding, exec-`r` == this act's claimed `r`, parent == snapshot tip); mismatch ⇒ `failed(post-construction-checklist)`, journaled, NO gate, NO CAS; §3 five per-field doctored-trailer sub-pins with zero ref movement AND zero gate invocations |
| C7-M6 | major | the merged claim-point sequence stays contradictory: the precise rule puts `M == E` before the claim, step 2 runs the equality stop AFTER `merge-tree`, step 3 says the claim was appended "at the start of the fresh-execution path"; lock re-evaluation never says whether refs are re-read | §1.1 SINGLE ORDERED PROCEDURE: 0 scan/project (non-executing answers return) → 1 snapshot refs reads + guards → 1a `M == E` no-op (pre-claim) → 2 claim under `withClaimLock` → 3 construct against SNAPSHOT ONLY, refs NEVER re-read (CAS proves the snapshot; re-reading would admit post-claim moves into built content) → 4 intent/gate/CAS/outcome; §1.2 mapped onto the same skeleton; "where a step's prose and this ordering disagree, this ordering wins"; §3 pins refs-moved-between-snapshot-and-claim (claim proceeds on snapshot, CAS proves) |
| C7-m1 | minor | §1.1 twice promises disclosure in §5's "honesty ledger" but §5 contains only the delivery sequence | §5.2 added: consolidated honesty LEDGER — every disclosed residual (forced-steal window, crash-burned `r` gaps, abandon-window stranding, torn-fragment reuse, soft cap, fleet-indeterminate denial, forward reader compat, `grantedBy` non-authorization, ULID ordering, rewind erasure) with its section, one place, no cherry-picking |
| C7-m2 | minor | the revoke `operator` comes from an "authenticated context" while §1.0/§1.4 specify trusted-caller + TTY confirmation, not an authentication mechanism | schema wording fixed: `operator` from the TTY-confirmed CLI invocation context, with an explicit note that the human gate is structural, not authentication |
| C7-m3 | minor | §1.2 points to the schema block "below"; it is above, in §1.1 | pointer corrected to "the schema block in §1.1" |
| C7-m4 | minor | comma followed by "Both" after the conflict clause — grammatical drift | comma replaced with a period before "Both signals, not one" (§1.1 step 2) |

## Disposition of cycle 8 of the confirming-round audit of v12 (2026-12-31; findings against v12, each verified against `src/` before acceptance — all resolved in v13)

| ID | Sev | v12 finding (verification) | v13 disposition |
|---|---|---|---|
| C8-B1 | blocker | the forced-steal residual is overstated: v12 (§5.2 row 1, §1.1) claims the steal window preserves "journal-level append atomicity" and bounds damage to wasted construction — FALSE: `FileHandle.appendFile` may issue multiple syscalls and serialization is per-instance (`journal.ts:631-636`), so a superseded owner paused mid-append interleaves with the new owner's bytes, producing MID-FILE corruption `open()` tail repair cannot fix (`read()` rejects malformed mid-file records, `:663-705`) and takeover-repair can truncate the new owner's complete records | §1.1 RETRACTS the atomicity claim; forced takeover of a possibly-mid-append holder is an operator recovery action whose possible outcomes include a CORRUPTED journal; adds integrity QUARANTINE: after any forced takeover the new owner runs `DecisionJournal.open()` validate-only (parse all, repair nothing); any mid-file malformation ⇒ `journal-corrupted` — every claim-bearing act refuses (per-act scope as duplicate-ids; fleet admission unaffected), remedy restore/manual repair, journal kept as evidence; no auto repair while a prior-owner append could land (wait out the shipped takeover settle-time, `supervise.ts:2259-2272`); §5.2 row corrected; what CAS guarantees WHEN THE JOURNAL SURVIVES is stated separately (§3 pins quarantine refusal + intact-survival CAS exclusivity) |
| C8-B2 | blocker | v12's quiesce-before-release waits on the WRONG work: the shipped pending chain (`journal.ts:602-606, 638-660`) covers QUEUED APPENDS only, and v12's own contract puts construction and gate work OUTSIDE the claim callback — release "awaiting the chain" completes while acts are live (C7-B1's A-claims-releases-with-construction-live scenario survives v12's own fix) | §1.1 ACT-LIFETIME QUIESCE BARRIER: the lease holder maintains a registry — every claim-bearing act registers at admission (before its step-0 scan), decrements at its terminal result; release = close registry (new admissions refused `lease-closing`) → await all terminals → token-conditional file remove → dir fsync; a stuck act blocks graceful release until terminal or forced takeover (disclosed, bounded, no new mechanism); §3 pin MOVED+STRENGTHENED: pause an act AFTER its `withClaimLock` callback returned (claim durable, construction live outside the queue) ⇒ release MUST NOT complete |
| C8-M1 | major | "stamped from the writer-lease file" has no referent: the shipped lease body is `{pid, token, episodeId, claimedAt}` (`supervise.ts:2005`) — NO epoch field, and the release interface supplies no write fence (`:2739`); "every fenced append re-validates" names neither the writers nor what failed validation returns | §1.1 LEASE SCHEMA & PUBLISH: NEW file `events/writer-lease.json` `{pid, token, episodeId, epoch, journalFloor, claimedAt}`, published by the budget-init marker's `O_EXCL` link protocol (link = acquisition = epoch assignment, one atomic step); PER-APPEND VALIDATION with NAMED WRITERS: claim/abandon/intent/outcome/recovery-update/revoke each check lease token == own token AND stamped epoch == lease epoch before its inline append; failure ⇒ `fence-lost` TERMINAL (`ClaimOutcome` gains the status; acts return `failed(fence-lost)`; revoke gains `refused(fence-lost)`) — no retry, no further append, no CAS; §3 pins a stale-token append refusing with zero journal growth |
| C8-M2 | major | "epoch monotone across restarts" is FALSE as stated: epoch 8 acquired, NO claim written, released; next acquisition computes the same journal max and also gets 8 — v12's own allocation rule permits the repeat it forbids in prose | §1.1 REUSE NARROWED HONESTLY: the true promise is (i) atomic publish ⇒ no two LIVE owners ever hold the same epoch, and (ii) an epoch REPEAT is PROVEN HARMLESS — a repeat implies the prior owner journalled nothing, so no record carries the repeated value; no eligibility decision can compare against it, no claim is misclassified by the repeat itself; §3 pin restated to exactly: acquire-no-claim-release-reacquire ⇒ same epoch legal AND zero journal-visible effects (the v12 "strictly greater after restart" pin withdrawn — the journal max floor is what is monotone, not the acquired value) |
| C8-M3 | major | v12 collides with itself on the ambiguous claim append: "retry allocates n+1" AND the same-epoch blocker — when the caller's OWN append wrote a COMPLETE claim line then failed before resolve (`journal.ts:645-657`), the scan sees a current-epoch unconverted claim of this exact actionId: n+1 leaves TWO live claims of one act (what C7-B2 exists to prevent); `refused(intent-open)` strands the originator at its own claim | §1.1 ORIGINATING-OPERATION RECOVERY: recovery identity is the exact tuple `(actionId, r, ownerEpoch)` — the reopen scan finding its OWN complete claim ⇒ the act ADOPTS it and proceeds to intent at the ADOPTED `n`, exactly once (adoption writes nothing new); never `n+1` here; the self-claim exemption cannot be claimed twice (a second ambiguous operation for the tuple finds a converted intent or re-adopts idempotently; check-before-append makes a second line impossible); other actionIds and same-actionId other callers are still refused; §3 three-way pin: complete-line-failed-resolve ⇒ adopt same `n`, zero second claim records, recovery idempotent under re-run; torn-truncated ⇒ fresh allocation may equal the torn `n`; foreign surviving claim ⇒ strictly greater |
| C8-M4 | major | v12's step-3 listing ends the pre-gate checklist mismatch with "abandons the claim (reason `pre-intent-error`), no gate, no CAS" but §1.2's body still routes post-construction failures through the intent-first crash table row — read as an intent-bearing failure: two journals for one bug, and the sticky-recovery precedence then finds an intent the contract says was never gated | §1.2 body AND step-3 listing pinned to ONE reading: the checklist pass on R is a PRE-INTENT return — claim abandoned `pre-intent-error`, the abandon record is the ONLY journal write of the act (NO intent, NO outcome, NO terminal; the crash table row is for post-INTENT construction/gate/CAS failures only, re-titled); eligibility sees claim+abandon ⇒ converted, nothing blocks; §3 pins doctored-trailer fixture ⇒ journal contains claim+abandon records and NOTHING else (no `#i`/`#o` line) |
| C8-M5 | major | the abandon append is itself an append — v12 specifies no failure contract for it: an ambiguous abandon (torn or complete-then-failed) leaves the claim unconverted with the act already returned its original result; a naive retry double-appends; a silent swallow re-opens the stranding C7-B3 closed | §1.1 ABANDON-APPEND FAILURE CONTRACT: resolve by the exact id `actionId#r<n>@abandon` (survived ⇒ abandonment ESTABLISHED, act returns its planned original result); absent + fence valid ⇒ retry EXACTLY ONCE (idempotent by id, check-before-append makes double-success impossible); absent + fence-lost or retry also ambiguous ⇒ `failed(abandon-ambiguous)` — explicit terminal, claim remains unconverted (residual stranding as disclosed), the act NEVER returns its original result while the abandon is unestablished; §3 pins complete-then-failed-resolve ⇒ zero second abandon records; torn ⇒ one retry lands one; fence dropped ⇒ `failed(abandon-ambiguous)` with zero further appends |
| C8-m1 | minor | v12's eligibility paragraph asserts "converted iff an intent `A#i<n>` exists" while the abandonment transition ALSO converts — the contract contradicts its own new record kind | §1.1: complete conversion set — claim converted iff intent `A#i<n>` OR abandon `A#r<n>@abandon` exists (exact identity; mutually exclusive by the abandon's validation), cross-referenced at both the eligibility paragraph and the abandon block |
| C8-m2 | minor | the header's duplicate-id rule inherits v12's `fleet-indeterminate` phrasing — a duplicate-id JOURNAL would read as denying ALL ADMISSIONS fleet-wide while §1.1's per-act refusal is the intended scope (ledger ≠ journal) | header + §5.2 row scoped: fleet denial is LEDGER-scope only; journal defects (duplicate ids, mid-file corruption) are per-ACT refusals, admission unaffected |
| C8-m3 | minor | §5.2's cap row says overshoot happens "by one candidate estimate" while §2.4 explicitly disclaims any numerical bound — the ledger re-mints the withdrawn number | §5.2 row corrected: SOFT, no numerical bound claimed (v12's "by one candidate estimate" struck); determinacy of the NEXT consult is the claim |
| C8-m4 | minor | the F2 no-effect-replay prose journals "a NEW intent id `actionId#r<n>`" — a v11 leftover colliding with v12's `#i<n>` scheme two pages away | step listing corrected to `actionId#i<n>` (v13); claim-block schema wording split: the record's ID is `actionId#r<n>@claim`, its EXECUTION identity `actionId#r<n>` is a construct |
| C8-m5 | minor | the revoke eligibility says five refusal CLASSES but gives "no record" and "non-outcome record" one code — two conditions, one code cannot pin separately as §3 demands | `revoke-target-not-outcome` split out as its own code: five conditions, FIVE distinct codes (not-found / not-outcome / not-recovered / already-revoked / not-rollback), §1.2 and §3 counts restated |
| C8-m6 | minor | the trailer sub-pin census "five trailer fields (episode, action, promotion-ref, exec-r, parent)" counts `parent` — a COMMIT structural field, not a trailer field — and omits the exec-actionId-vs-request mismatch the same paragraph requires | §1.2/§3 census split: four trailer fields + separate commit-parent check + exec-actionId mismatch ⇒ SIX sub-pins, each doctored independently with zero ref movement AND zero gate invocations |

## Disposition of the cycle-9 review of v13 (2026-11-14; terra adversarial audit of v12+v13 seams — every finding checked against `src/` before acceptance; all resolved in v14)

| ID | Sev | v13 finding (verification) | v14 disposition |
|---|---|---|---|
| C9-B1 | blocker | epoch is computed BEFORE ownership is established: `link()` publishes the ALREADY-STAGED body and does not atomically compute the journal floor (`supervise.ts:2020-2035` writes+fsyncs the body before link). A/B both stage epoch 8 over floor 7; A links, claims at 8, releases; B's delayed link then SUCCEEDS on the removed file — B owns a journal-VISIBLE epoch 8, A's epoch-8 claim is misclassified current and blocks admission for B's whole lease life; this also disproves "a repeated epoch implies the prior owner journalled nothing" | §1.1 POST-PUBLICATION RE-SCAN BUMP: after a successful link the acquirer RE-READS the journal floor; if `>=` the staged epoch it re-stages its OWN body (`epoch = 1 + newFloor`) via write-tmp → fsync → owner-only RENAME over its own path (token unchanged — the successful link proved sole ownership), re-checks once, second lag ⇒ acquisition fails `epoch-contention` (bounded, defensive). Restored invariant: NO EPOCH VALUE APPEARING IN THE JOURNAL is ever inherited by a later owner; C8-M2's sequential repeat survives re-pinned (a repeat with zero journalled records stays legal — the re-scan cannot see a record that was never written); §3 pins the delayed-publisher schedule byte-for-byte |
| C9-B2 | blocker | the takeover "settle-time" proves nothing: the cited hold is `leaseSwapHoldMs`, DEFAULT 0, taken AFTER the swap (`supervise.ts:2259-2274`), and the shipped comment at `:2335-2342` states it is NOT a scheduler-independent bound — an old owner paused inside a multi-syscall append can resume AFTER the new owner's validation and corrupt or get truncated after the one-time quarantine check, contradicting "NO auto repair runs while any prior-owner append could still land" | §1.1 quarantine rewritten: THE SETTLE-TIME IS NOT A QUIESCENCE PROOF; a QUIESCENCE CONDITION gates the transition from validate-only to normal mode — `kill(oldPid,0)` ESRCH on the lease body's pid (PID-reuse false-positive bounded and disclosed to §5.2) or operator termination + explicit confirmation (the takeover act prints the old pid and demands confirmation); until quiescent the episode is `journal-quiescing` and claim-bearing acts refuse; §3 pins an old append resuming AFTER the validation point refuses `journal-quiescing`, repair runs only after quiescence |
| C9-B3 | blocker | the new writer-lease has no crash-recovery lifecycle: the SHIPPED episode lease is `host.lease` (`supervise.ts:1811-1823, 1866-1867`) with its OWN dead-owner reclaim (separate takeover lock + re-verification, `:1833-1850`) that does not touch `events/writer-lease.json`; a crash holding the writer-lease leaves `EEXIST` forever ⇒ admission frozen under a literal no-replace rule, or every host invents its own unsafe unlink | §1.1 WRITER-LEASE LIFECYCLE: the writer-lease is DERIVATIVE of the host lease, not independent — acquisition order host-lease-FIRST (shipped reclaim untouched) then writer tmp+link inside the same hold; `EEXIST` ⇒ the proven sole host-lease holder REPLACES the stale file by owner-only rename; writer token EQUALS host token so per-append validation transitively validates host ownership (one fence, two files); graceful release order registry-barrier → unlink writer → shipped host-lease release, crash between unlinks cleaned by the replace rule; forced takeover cascades through the 7-step quarantine state machine — the writer-lease file is replaced at step 2 (no epoch use), `inspect()` validates at step 3, and NO epoch is stamped until step 6 AFTER the quiescence condition holds, so a corrupted journal is never written under a fresh epoch; acts arriving between acquisition and derivation refuse `lease-unavailable`; §3 pins crash-holding-writer-lease recovery, competing-successor serialization under the shipped takeover lock, and the boundary-crash table |
| C9-M1 | major | registry admission/deregistration not implementable: "the lease holder maintains a registry" names no object, no atomic check-vs-close, no throw path (decrement only on listed result paths leaks the counter and blocks release after a bug-throwing act; early decrement passes live work); token validation is specified before APPEND not at registration (a non-holder process could register); step-0 replays, revoke, and recovery participation unstated | §1.1 REGISTRY SEMANTICS: ONE object in the journal wrapper (per-lease, per-process); admission step (a) validates the lease token FIRST (non-holder refused `lease-unavailable`, live-set unchanged), (b) state must be `open` (else `lease-closing`), (c) synchronous insert — check-and-register event-loop-atomic, no await points; DEREGISTRATION exactly once in a finally-equivalent on fulfillment OR rejection (returned/refused/failed/thrown all decrement; defense-in-depth, the never-throws union unchanged); step-0 replays register and decrement; revoke and recovery-participating reads participate; §3 pins thrown-act decrement, step-0 phantom-free, concurrent close/admission, second-process refusal |
| C9-M2 | major | quarantine's publication/failure/tail-repair transitions unspecified: floor "at acquisition" vs quarantine-after-takeover unordered; no lease-release story on post-publication corruption; no admission answer for acts during takeover; "validate-only" is NEW behavior — shipped `open()` ALWAYS repairs (`journal.ts:616-622 #repairTail()` truncates or appends newline at `:730-748`) and no defined path preserves a tolerated torn tail | §1.1 names `DecisionJournal.inspect()` as an M3-new non-mutating API (patterned on P8 `BudgetLedger.inspect`: pure byte classification, repair NOTHING; torn tail reported `tail-torn: <offset>` and PRESERVED) + a 7-STEP ORDERED TAKEOVER STATE MACHINE (host reclaim → writer-lease replace WITHOUT epoch use → inspect → corrupt ⇒ `journal-corrupted` refusals + writer file removed / torn-or-clean ⇒ await QUIESCENCE → normal `open()` repairs tail → epoch derivation with re-scan bump → admission); arriving acts answer `lease-unavailable`/`journal-quiescing` per phase; §3 pins inspect's zero-write property (bytes+mtime unchanged) and per-phase refusals |
| C9-M3 | major | fence-loss results conflict on the abandon path: §1.1 abandon block demands `failed(abandon-ambiguous)` on a failed fence check while the general named-writer rule says a failed validation ⇒ `failed(fence-lost)` — same observable sequence, no precedence, §3 pins repeat both | §1.1 precedence pinned: the named-writer rule governs the FIRST abandon attempt's PRE-APPEND validation (fence already lost ⇒ `failed(fence-lost)`, zero abandon records); once an abandon attempt is OUTSTANDING, fence loss discovered during resolution ⇒ `failed(abandon-ambiguous)` (the operator-material fact is the unestablished abandon); §3 fixtures separate both journal states |
| C9-M4 | major | the `revoke-target-not-outcome` fixture is UNREACHABLE: the CLI resolves an execution identity deterministically to `A#o<r>`; the duplicate-id rule forbids that id naming anything else on a conforming journal — the non-outcome case as specified cannot exist without journal corruption, which conflicts with fail-closed | §1.2/§3: TWO target forms — T1 execution identity (resolves to `#o<r>`, the common path) and T2 full record id (`A#i<r>`, `A#r<n>@claim`, `A#r<n>@abandon`, `revoke-<ulid>`) naming a record directly; a T2 id resolving to a surviving non-outcome record ⇒ `revoke-target-not-outcome`; fixture uses T2 on `A#i1` (intent of a completed execution); T2 names only VALID records — malformed/duplicate ids remain journal-level refusals, fail-closed intact; T2 additionally BOUND to the request's named execution (foreign-execution ids ⇒ `revoke-target-not-found`, cycle-9 minor 5 hardening) |
| C9-M5 | major | conversion mutual exclusion is checked ONE WAY: the abandon append refuses when an intent exists, but the INTENT append never checks for an `@abandon` — abandon-then-intent for one execution (recovery re-entry) would slip past, the projection sees both, contradicting the asserted invariant | §1.1 TWO-SIDED VALIDATION: the intent append checks NO `A#r<n>@abandon` exists for the execution inside the serialized writer domain (violated check ⇒ the attempting act's append-time refusal, duplicate-class collision); §3 pins BOTH orderings (intent-then-abandon ⇒ abandon refused; abandon-then-intent ⇒ intent refused) |
| C9-m1 | minor | step-2 of the ordered procedure enumerates claim handling as "refused/failed", omitting the live `fence-lost` member declared later in the same section | step 2 reads refused/failed/fence-lost (v14) |
| C9-m2 | minor | "the abandon record is the ONLY journal write" is false as literally written — the claim was already appended (the C8-M4 disposition itself says claim PLUS abandon) | wording qualified at both sites: the act's journal footprint is claim + abandon and NOTHING else |
| C9-m3 | minor | the abandon retry's SUCCESS result is never stated | §1.1 makes it explicit: a successful retry returns the act's planned ORIGINAL result (same as the survived case) |
| C9-m4 | minor | §1.1 discloses registry-blocked graceful release but §5.2 (the honesty ledger that claims to collect every disclosed residual) has no row | §5.2 gains the registry-blocked-release row (plus the stale-pid quiescence row surfaced by C9-B2's fix) |
| C9-m5 | minor | §1.1 retains the unqualified "monotone across restarts" assertion and "two acquirers cannot stamp the same epoch" while the same section permits sequential epoch repetition | epoch-supplier paragraph qualified: the JOURNAL FLOOR is the monotone quantity; the ACQUIRED epoch is not claimed monotone (repetition legal per C8-M2, floor-validated acquisition) |
| C9-m6 | minor | `abandon-ambiguous`, `fence-lost`, `lease-closing`, `journal-corrupted`, `post-construction-checklist` have no closed census and no §1.4 CLI rendering | §1.1 CLOSED CODE CENSUS: every refused/failed reason in one list (incl. the new `lease-unavailable`, `journal-quiescing`, `epoch-contention` as a non-result acquisition code) + §1.4 rendering: machine code verbatim in the exit payload, exit 1 failed / exit 2 refused (P12 convention), no aliasing/dropping; §3 table test asserts census closure |
| C9-m7 | minor | the C8-M4 disposition claims a claim-plus-abandon-and-nothing-else journal fixture but the visible §3 checklist pin asserts only field checks + zero gate/ref movement — no full journal census | §3 checklist pin extended (v14 cycle-9 minor 7): full journal census parsed from the journal FILE — exactly claim + abandon records, no `#i`/`#o` line |

---

## Disposition of the cycle-10 review of v14 (2026-11-13; terra adversarial audit of v14 seams — every finding checked against `src/host/supervise.ts` and `src/episode/journal.ts` before acceptance; all resolved in v15)

| Sev | v14 finding | v15 disposition |
|---|---|---|
| C10-B1 | blocker | the quarantine state machine can erase the identity of a STILL-LIVE predecessor: A superseded paused inside an append; B replaces the writer lease at step 2 (B's pid in the body) BEFORE quiescence; B crashes before step 4b; C reclaims B and checks only B's pid — once B is proven dead, C repairs and admits while A can still resume its append, reopening the interleaving/truncation class quarantine exists to prevent (`journal.ts:632-650` permits multi-syscall appends under an external fence) | §1.1 UNQUIESCED-PREDECESSOR LEDGER: takeover carries a predecessor SET persisted durably at `events/quarantine.json` (`{predecessors:[{pid,hostToken,seenAt}],chainFrom}`), written+fsynced at step 2 BEFORE the writer replace; each takeover ADDS the owner it displaced; an entry is removed ONLY on its own proven quiescence (ESRCH or operator confirmation naming that token); step 4b awaits the WHOLE SET; a crash-rejoining successor INHERITS the file and may not clear entries it did not observe dying (ESRCH clears per entry regardless); a leftover file at NORMAL acquisition refuses `journal-quiescing` until the set clears — never silently deleted; §5.2 gains the takeover-locality residual; §3 pin P1: A→B-replaces→B-crashes→C with A paused inside an append, C's step 4b refuses until A's pid is proven gone |
| C10-B2 | blocker | the derivative writer fence assumes an exclusivity guarantee the UNCHANGED host lease expressly disclaims: `supervise.ts:2259-2272` calls the takeover protection a deployment-chosen time bound (default zero); `:2335-2342` documents the stamp-read/remove TOCTOU and disclaims a scheduler-independent bound — "successful link proved sole ownership" / "already proven sole host-lease holder" are STRONGER than the cited mechanism; a delayed double-reclaim puts two hosts in writer-replace races and independent append queues | Language REVISED everywhere: "proven sole holder" means sole-as-far-as-the-shipped-time-bound-establishes (§1.1 exclusivity-posture paragraph + writer-lifecycle paragraph + §3); the honest degradation is POSTED, not assumed away — §5.2 new residual row "Host-lease exclusion is a TIME BOUND, not a proof": a delayed double-reclaim races writer replacement, per-append validation still admits only the current lease-file token, worst case is the disclosed torn-tail class; strengthening the shipped fence is scoped as M3-ADJACENT hardening (a real fencing protocol for writer publication/replacement/bump under the reclaim race), NOT assumed by this contract; §3 keeps the delayed-publisher fixture as a DEFENSIVE-PROTOCOL test (see C10-m4) |
| C10-B3 | blocker | the registry live-set keys the logical ACTION identity: two same-actionId admissions (legal per the same-action pin) collapse to one entry; the refused loser's finally-decrement empties the set while the winner is live at the gate ⇒ graceful release drops the fence under a live act | Registry holds unique INVOCATION tokens per admission (not action identity): step (c) inserts the invocation entry; deregistration removes ITS OWN entry exactly once in the finally-equivalent (fulfillment OR rejection alike); §3 pin P4: two concurrent admissions of the same actionId occupy TWO invocation entries, the refused loser decrements its own while the winner stays paused mid-construction ⇒ live-set stays non-empty ⇒ graceful release remains blocked until the winner terminates |
| C10-M1 | major | the takeover machine cannot run inspection under the shipped takeover lock as specified: the shipped reclaim releases the lock in a `finally` BEFORE `acquireEpisodeLease` returns (`supervise.ts:2713-2727, 2738-2739` — handle `{token,path,held,release}`, no lock handle escapes), so "steps 2-6 under the shipped lock" is a different protocol than "acquisition unchanged" | §1.1 LOCK LIFETIME REVISED: M3 takeover is a NEW ORCHESTRATING ACT `takeOverQuarantined(episodeId)` that (a) calls the shipped reclaim (unchanged), (b) writes `quarantine.json`, (c) runs steps 2-6, (d) RE-VERIFIES its host lease at steps 3, 5, 6 immediately before each mutation (token equality vs the lease file — same per-append validation), aborting with the token-conditional cleanup on theft; competing acquirers serialize on the shipped lock ONLY for the swap; the quarantine window is protected by the host lease PLUS the quiescence ledger — a reclaim lock is NEVER held across an operator wait |
| C10-M2 | major | quarantine classification is a pre-quiescence snapshot but the floor source after quiescence is unspecified: a dying owner's late COMPLETE claim (or newly-malformed line) can land between step-3 inspect and step-5 `open()` (`journal.ts:616-622` — `open()` returns the instance, not the records read; `:663-706` rejects mid-file malformed data); reusing the snapshot can derive a now journal-visible epoch | §1.1 FLOOR SOURCE, FRESH READ ONLY: the step-3 inspect is NOT the floor source and is never reused; step 6 derives `epoch = 1 + max(epoch over ALL records in a FRESH READ of the post-quiescence, post-`open()`-repair journal)`; a THROWN fresh read (late malformed line) routes to `journal-corrupted` evidence-preserved with NO repair past `open()`'s own; §3 pin P2 both branches (late complete claim ⇒ derived epoch strictly above it; late malformed line ⇒ corrupted refusal) |
| C10-M3 | major | bump and takeover acquisition have no composed failure/cleanup contract: rename/fsync/second-scan failures "fail acquisition" without saying whether the linked writer file and host lease are retained or released, how retry proceeds, or what step-2's epoch-less body is (schema requires an epoch); no dir-fsync requirement, no pending representation | §1.1 PENDING PHASE + CLEANUP: step-2 body carries `epoch: 0` (RESERVED — no journal record ever carries 0) + `phase:"pending"`; the phase gate refuses acts stamped against a pending lease; a pending file found by a different host-lease holder is stale-by-rule replaced; EVERY failure of the step-2 rename / dir fsync / step-6 bump ⇒ acquisition fails, the writer file is removed TOKEN-CONDITIONALLY (only the current host token may unlink), the HOST LEASE is released in the same finally, takeover returns the failure to the operator (no silent retry; re-run inherits `quarantine.json`); composed edge pinned: `epoch-contention` during step 6 aborts per the same cleanup; DIRECTORY FSYNC after rename required BEFORE admission; §3 pin P6 crash table: crash after tmp fsync-before-rename ⇒ published body is the OLD epoch, orphan tmp swept by next acquirer; crash after rename-before-dir-fsync ⇒ recovery accepts EITHER body (same token, both conforming — no assumed winner) |
| C10-M4 | major | T2 binding contradicts the reachable-target list and has no resolution order: §1.2 allowed `revoke-<ulid>` in T2 while requiring the record's `(actionId,r)` to match "the request's named execution" — a revoke request names no execution besides its target and a marker id has no execution prefix; the pinned `revoke --target-id A#i1` example supplies no execution to bind, so implementations disagree whether it errors or returns the pinned `revoke-target-not-outcome` | §1.2/§1.4 GRAMMAR RESOLVED: the revoke CLI takes EXACTLY ONE of two MUTUALLY EXCLUSIVE target args (`--exec <actionId>#<r>` = T1, resolved deterministically to `A#o<r>`; `--target-id <fullRecordId>` = T2, grammar `actionId#...` exactly — `#i<r>` / `#r<n>@claim` / `#r<n>@abandon`); `revoke-<ulid>` matches NO record-kind grammar ⇒ USAGE error exit 2 BEFORE any act (no census code minted — a revoke marker is never a revocation target); both flags together, or neither ⇒ same usage error, no act runs; the v14 binding sentence is WITHDRAWN: a T2 record carries its own `(actionId,r)` in its id and THAT is the request's execution context (provenance/confirmation derive from the named record); CHECK ORDER PINNED: existence → record-kind (`not-outcome`) → rollback-shape (`not-rollback`) → recovered-terminal (`not-recovered`) → revocation-marker (`already-revoked`) — a non-recovered plain-promotion outcome answers `not-rollback` (shape beats state); §3 pin P5: both-flags and neither-flag usage errors leave the journal EMPTY; marker id ⇒ usage error; multi-condition target answer pinned per check order |
| C10-M5 | major | the "closed" census contradicts live emit paths: `not-replayable`, `lifecycle-blocked`, `refused(fence-lost)`, `journal-unreadable:duplicate-ids` appear as act-level answers in the body but are absent from (or expressly non-result in) the census; the same revoke fence loss appears as BOTH `failed` and `refused` — the closure fixture and CLI rendering cannot both match | §1.1 census RECONCILED against every live emit path: adds `lifecycle-blocked`, `not-replayable`; `fence-lost` appears under BOTH unions BY ACT CLASS (claim-bearing ⇒ `failed(fence-lost)`; revoke-class ⇒ `refused(fence-lost)` — a fence-lost revoke never claims to have failed a write); `journal-unreadable:duplicate-ids` RECLASSIFIED as a refused ACT RESULT (every claim-bearing act on a duplicate-id journal returns it; the non-result note covers only the raw journal-READ error the wrapper converts); CLI exit code is per result STATUS (exit 1 iff `failed`, exit 2 iff `refused` — fence-lost renders 2 for revoke, 1 for claim); §3 census fixture extended to construct each added code and assert the table test against the REAL result-producing paths |
| C10-m1 | minor | takeover phases do not map each window to exactly one of `lease-unavailable` / `journal-quiescing` | §1.1 PHASE→CODE MAP, EXACT: steps 1-3 ⇒ `lease-unavailable` (writer-lease not yet validated); step 4b ⇒ `journal-quiescing`; steps 5-6 ⇒ `lease-unavailable` again (writer file exists, no usable epoch until step 6 — pending phase); step 7 opens admission; boundaries atomic on the event loop via a phase field in the wrapper |
| C10-m2 | minor | `abandon-ambiguous` tells the operator the claim "remains unconverted" — but an ambiguous retry may have LANDED without the act learning it | Abandon-failure contract reworded: abandonment is UNESTABLISHED, NOT necessarily absent; the remedy sentence points to next-epoch exact-id resolve (which re-reads and settles either way) rather than assuming absence |
| C10-m3 | minor | §1.2 never names the `--target-id` flag that §1.4 uses | Both sections now spell the flag identically (`--target-id <fullRecordId>`, §1.2 grammar ↔ §1.4 census/calling text, cross-referenced) |
| C10-m4 | minor | the §3 delayed-publisher schedule is not producible by two CONFORMING hosts (host-lease-first acquisition forbids staging inside overlapping exclusive holds) — the fixture mislabels what it tests | §3 fixture posture LABELED: under conforming scheduling the shipped exclusive host lease serializes acquisition so conforming hosts can NEVER stage overlapping; the schedule is a FAULT-INJECTED reproduction of the shipped delayed-reclaim race class (`supervise.ts:2338-2346`) — the harness pauses B's link syscall across A's hold — and is marked a DEFENSIVE-PROTOCOL test (asserts the re-scan bump restores the invariant IF the bounded race fires), not a claim that conforming scheduling produces the race |

---

## Disposition of the cycle-11 review of v15 (2026-11-14; terra adversarial audit of the v15 quarantine/ledger seams — every finding checked against `src/host/supervise.ts` and `src/episode/journal.ts` before acceptance; all resolved in v16)

| Sev | v15 finding | v16 disposition |
|---|---|---|
| C11-B1 | blocker | a crash between host reclaim and ledger publication erases a live predecessor: B reclaims A's host lease then crashes BEFORE writing `quarantine.json`; C reclaims B and records only B ("the owner it displaced" read narrowly); A (paused inside an append, identity recoverable only from the writer/host-lease bodies) is omitted, C proves B dead and admits while A resumes (`supervise.ts:2713-2727` — reclaim returns its OWN handle, not the displaced identity; `journal.ts:632-650` multi-syscall appends) | §1.1 LEDGER REWRITTEN — IDENTITY CAPTURE IS AN OPERATIONAL UNION RULE: `newSet = oldLedger ∪ {observedHostOwner} ∪ {observedWriter}` — `observedHostOwner` from the host-lease body read BEFORE reclaim AND re-confirmed against what the reclaim removed (mismatch ⇒ abort fail-closed ADDING every observed variant); `observedWriter` from the existing `writer-lease.json` before replacing it — A's identity survives any pre-ledger crash through at least one on-disk body; P1 extended: A→B-reclaims-host-CRASHES-pre-ledger→C refuses until A proven gone (§3 pin P7, iterated for repeated crashes) |
| C11-B2 | blocker | the ledger update has no crash-atomic or lost-update contract: an in-place rewrite can truncate the old set mid-write; content fsync alone does not establish the directory entry; under the disclosed double-reclaim race two successors reading `{A}` replace each other's ledger, losing an unquiesced predecessor — defeating the whole-set proof | §1.1 PUBLICATION IS CRASH-ATOMIC AND MERGE-BASED: tmp→fsync(tmp)→RENAME→dir-fsync, in-place rewrite FORBIDDEN; every publish is READ-MERGE-PUBLISH (re-read immediately before rename, write `read ∪ own additions`); malformed ledger is FAIL-CLOSED (treated as one more unknown predecessor; operator-signed minimal replacement only — deletion = disclosed chain-severance); §5.2 locality row extended with the honest MERGE-LOSS RESIDUAL (a never-observed addition can still be lost — bounded, not closed); §3 pin P8 merge-under-double-reclaim + injected fsync/rename crash |
| C11-M1 | major | the time-bound residual understates corruption: v15 says "worst case is the torn-tail class, never silent mid-file corruption BY THE FENCE ITSELF" while the forced-steal row acknowledges mid-file corruption/restore; a displaced holder paused mid-multi-syscall-append leaves INTERLEAVED mid-file bytes (`journal.ts:632-650, 663-748`); "NO TWO LIVE OWNERS" and the epoch-inheritance invariant are unqualified under the same residual | EXCLUSIVITY PARAGRAPH CORRECTED TO THE FULL LATTICE (v16): spurious `fence-lost` → torn-EOF → MID-FILE INTERLEAVED CORRUPTION = RESTORE-CLASS (same kind as the forced-steal row); "NO TWO LIVE OWNERS" qualified to owners under the bounded exclusivity (delayed double-reclaim can stage the same epoch twice; per-append validation is the defense, restore-class posture the residual); the epoch-inheritance invariant restated as absolute only under CONFORMING (non-racing) operation; §5.2 TIME-BOUND row restated with the lattice; stronger fencing named explicitly as the requirement for no-restore-class safety (M3-adjacent, not assumed) |
| C11-M2 | major | step 2 publishes files with none of the promised re-verification: checks were pinned at steps 3/5/6 only, so B's ledger/writer renames can clobber a live successor C's files during B's publishing window; the header's "re-verifying at every mutation" claim oversold the algorithm | RE-VERIFICATION COVERS EVERY PUBLICATION: token check immediately before each of the FOUR mutations (ledger rename, writer-lease replace, step-5 `open()`, step-6 bump rename), aborting with the single cleanup contract on theft; the honest CHECK→RENAME residual stated (check and rename are adjacent statements; a clobbered successor fails `fence-lost` fail-closed and is listed as predecessor-to-prove — the window is bounded, not eliminated) |
| C11-M3 | major | the displaced-owner identity the ledger needs is not supplied by the unchanged reclaim API: the handle is `{token,path,held,release}` (`supervise.ts:2713-2739`) — the contract never says how the OLD `{pid,hostToken}` is obtained and bound to the actual displaced lease; implementers must guess from a stale observation or change the "unchanged" reclaim | MERGED INTO THE UNION RULE (C11-B1 disposition): capture is defined as reading the on-disk lease BODIES (`host.lease` before+after reclaim, `writer-lease.json` before replace) — no new reclaim API, the "unchanged" claim survives because the identity comes from files the takeover already reads; pre-read-vs-removed mismatch aborts fail-closed |
| C11-M4 | major | ledger clearing is not a complete state machine: entries clear "on proven quiescence" but NO ACTOR rechecks, durably removes, publishes the empty set, or disposes of the empty file; a literal normal acquisition can refuse forever after every recorded pid died; confirmation is specified for "the old pid", not per entry | CLEARING IS AN ASSIGNED CRASH-SAFE OPERATION: EVERY acquisition path runs a CLEARING PASS (per-entry `kill(pid,0)`; ESRCH ⇒ removed; publish remaining set atomically; EMPTY set published as `predecessors: []` — presence-of-empty-set does NOT refuse admission, gate is set CONTENT; file kept as forensic record, never auto-deleted); operator clearing designates entries by RECORDED `hostToken` (pid reuse cannot confirm the wrong entry); step 4b polls the pass; growth bounded (≤2 entries/takeover, drained at every acquisition); §3 pin P9 |
| C11-M5 | major | the late-malformation route names a step the shipped API never reaches: mid-file bytes landing before step 5 make `open()` itself REJECT — there is no instance for step 6's fresh read (`journal.ts:616-622` returns the instance, `read()` is separate) — and the fresh read was never named as a second `read()` call | BOTH REJECTION POINTS ROUTED IDENTICALLY: step-5 `open()` rejection OR step-6 `read()` rejection ⇒ 4a evidence-preserving refusal (`journal-corrupted`, writer file removed token-conditionally, host lease released per the cleanup contract); the fresh read pinned as an explicit SECOND `read()` call on the opened instance; §3 pin P2 now asserts both distinct paths |
| C11-M6 | major | takeover failure results/cleanup remain open: no closed result union for ledger/inspect/`open()`/duplicate-ids/quiescence exits; `journal-unreadable:duplicate-ids` is an ACT refusal but takeover has admitted no act; normal `epoch-contention` cleanup (writer file? host lease?) ambiguous | CLOSED UNIONS + ONE CLEANUP CONTRACT: `TakeoverResult = {status:"quarantined-admitted"} \| {status:"aborted", reason∈{lease-stolen-precheck, ledger-malformed, journal-corrupted, duplicate-ids-at-takeover, epoch-contention-step6, io-failure}}`; one finally for every pre-admission exit of BOTH machines (writer file removed token-conditionally; host lease released on normal path, quarantined-and-released per disposition on takeover path; dir fsync; no silent retry; `quarantine.json` NEVER deleted by a failure path); failed quiescence is NOT terminal (step 4b waits); CLI renders aborted as exit 2 refused-class |
| C11-M7 | major | epoch 0 is reserved in the pending-phase passage but valid in the claim schema (`ownerEpoch` integer `>= 0`) — a conforming validator can mint the record the sentinel argument forbids | SCHEMA FIXED: `ownerEpoch >= 1` REQUIRED on every journal record (0 reserved for the writer-lease body sentinel only); zero/absent/negative incoming `ownerEpoch` = closed-schema REJECTION (never lands); no migration needed — admitted journals start at 1 (`1+max` floor); §3 pin P11 (fuzz case) |
| C11-M8 | major | the exact phase→code promise is process-local: the phase is a wrapper field; a second process sees the SAME disk state (pending body + non-empty ledger) in steps 3 and 4b and cannot distinguish `lease-unavailable` from `journal-quiescing` | HONEST SCOPING + DURABLE PRECEDENCE: the exact per-step map is the promise through the OWNING WRAPPER only; external READ-ONLY status derives from disk precedence: malformed ledger ⇒ `journal-quiescing`; non-empty set ⇒ `journal-quiescing` (steps 3 AND 4b DELIBERATELY COLLAPSED to the conservative code); empty + pending body ⇒ `lease-unavailable`; token mismatch ⇒ `lease-unavailable`; else admitted — no new on-disk marker needed; §3 pin P10 asserts the collapse |
| C11-m1 | minor | three sites still say inspection/serialization "under the shipped takeover lock", contradicting the corrected lock-lifetime paragraph | All three sites qualified: the lock covers the SWAP/INSPECT WINDOW ONLY; the post-swap quarantine window is guarded by host lease + predecessor ledger (§1.1 lifecycle paragraph, §3 writer-lease fixtures, quiescence paragraph) |
| C11-m2 | minor | "the next epoch's exact-id resolve" names no operation or result; §3 still says a fence-dropped ambiguous abandon "stays unconverted" — contradicting the corrected UNESTABLISHED-not-absent wording | Resolve DEFINED OPERATIONALLY as a lease-free READ (re-scan for `actionId#r<n>@abandon` under the duplicate rules: found ⇒ established; absent ⇒ unestablished, `r` burned, no second append for that execution; no new act/verb — it is the eligibility scan invoked via `status`); §3 wording corrected to UNESTABLISHED + remedy pointer |
| C11-m3 | minor | exit 2 covers BOTH usage errors and refused results with no machine-readable discriminator | PAYLOAD `status` FIELD IS THE DISCRIMINATOR: `{status:"usage", code:"usage-error", stage:"cli-parse"}` (pre-act, outside the census) vs `{status:"refused", code:<census code>}`; consumers branch on `status` first; exit code alone never disambiguates; §3 pin P12 pairwise-distinguishability |
| C11-m4 | minor | `chainFrom` is named without definition (value, validation, recovery role) | DEFINED: ulid of the FIRST displaced owner in an unbroken chain — set on CREATE, copied verbatim on UPDATE, reset only when the set clears empty; validation: must parse as ulid else the ledger is malformed (fail-closed); role: operator forensics for chain wedage age |
| C11-m5 | minor | §1.2 presents `--revoke-rollback-recovery <actionId>#<r>` positionally while §1.4 requires exactly one of `--exec`/`--target-id` — two grammars for one act | ONE GRAMMAR: the positional spelling is declared sugar for `--exec`; full invocation `--revoke-rollback-recovery (--exec <actionId>#<r> \| --target-id <fullRecordId>)`, exactly one target arg, both/neither ⇒ the same usage error exit 2, no act |
| C11-m6 | minor | the stale-pid §5.2 row claims the reuse wait is "bounded by PID space" — PID reuse supplies no elapsed-time bound | Phrase WITHDRAWN: the wait is bounded only by operator action (fail-closed direction restated); confirmation designates entries by recorded `hostToken`, so a reused pid cannot confirm the wrong entry away |

## Cycle-12 disposition table (adversarial audit of v16, gpt-6.1-terra — 1 blocker + 6 majors + 5 minors; every finding verified against `src/host/supervise.ts` and `src/episode/journal.ts` before acceptance)

| ID | severity | finding | disposition (v17) |
|---|---|---|---|
| C12-B1 | blocker | required `chainFrom` cannot be derived: it must be the ulid of the first displaced owner, but the shipped owner identity is `${pid}.${random}.${time}` (`supervise.ts:1866-1868`) — not a ulid; first takeover with a real shipped token fails its own validator forever | `chainFrom` REDEFINED as a FRESHLY MINTED CHAIN-EVENT ULID (same mint pattern as `revoke-<ulid>` — ids are minted, foreign formats never borrowed): created at the takeover that first makes the set non-empty, copied verbatim by every update, RETAINED on the empty-set publish (forensic record of the chain that ended), NEW ulid minted when the next non-empty chain begins; validation = parseable ulid OR literal `null` (never-had-a-chain); fixture: first takeover with a real shipped-form host token, reload, second takeover |
| C12-M1 | major | the displaced-body "re-confirmation" has no observable supplier: the shipped reclaim checks internally, moves the lease aside, deletes the moved copy, and returns only `{token,path,held,release}` (`:2713-2727, 2738-2739, 2070-2330`) — the caller cannot prove which intermediate body was removed; mismatch had no named result in the closed union; publish-before-abort unresolved under lost ownership | "RE-CONFIRMED" WITHDRAWN — capture is PRE-READ-ONLY; the post-reclaim lease read (ours / pre-read / other) detects third-party swaps: `other` ⇒ publish the pre-read variant (guarded by the immediate-before-rename token re-verification — if we no longer hold the lease the rename is SKIPPED, the variant surviving in the takeover result forensics = the disclosed double-reclaim residual) then abort with the NEW closed-union reason `lease-swapped-post-reclaim`; fixture: changed intermediate body + crash during the abort path |
| C12-M2 | major | P8 overclaims: two publishers reading `{A}`, staging `{A,B}`/`{A,C}`, last-rename-wins yields `{A,C}` or `{A,B}` — NOT `{A,B,C}`; and "cannot stomp an entry unless it also observed it" inverts the losing publisher's observation (P2 erases B precisely because P2 never saw B) | P8 REWRITTEN TO THE SNAPSHOT BOUND: survivor ⊇ entries in BOTH read snapshots, never an entry neither saw; explicit LOST-B FIXTURE (`{A,C}` survives; B's writer body on disk RE-CAPTURED by the next takeover's union rule — recovery asserted, not an impossible union); §1.1 merge wording corrected; §5.2 residual restated (a true union needs ledger-file writer serialization — out of scope under the residual, said so) |
| C12-M3 | major | clearing publications compose with neither the fence nor the merge rule: every-4b-poll renames aren't enumerated as guarded mutations; `read ∪ own additions` has no removal semantics — a stale clearing rename can resurrect a just-confirmed-away entry or clobber a newly added predecessor; the resurrection class is absent from §5.2 | clearing publishes are GUARDED (immediate-before-rename token check — theft aborts the publish touching nothing) and REMOVAL-COMPOSED (`read − entries_this_pass_proved_gone`; entries added after the read are never dropped); the just-confirmed resurrection by a stale rename is DISCLOSED as the same snapshot-loss class — detectable at the next clearing pass, never silently accepted; new pin P8b (guard + removal composition + resurrection-detection fixtures) |
| C12-M4 | major | absent-ledger posture self-contradicts: the external precedence treats absent like empty and first takeover "creates the file", while §5.2 says missing ⇒ one more unknown predecessor until operator-signed replacement — fresh-absence and deleted-absence are observationally identical, so one implementation admits fresh episodes and another refuses them | POSTURE STATED ONCE: ABSENT = EMPTY SET everywhere (fresh episodes are never refused); MALFORMED = fail-closed `journal-quiescing` remedied by the operator-signed minimal ledger; operator DELETION ≡ fresh absence — exactly what makes severance undetectable, kept as the disclosed chain-severance residual (§5.2 rewritten; no durable initialization evidence is claimed — none exists); no auto-recreate with invented content |
| C12-M5 | major | the external precedence's final `otherwise` claims "admitted (step 7 complete)" but cannot distinguish step-6-bump-done-step-7-pending; post-cleanup both lease bodies can be ABSENT — undefined by the list | `otherwise` REPORTS `no-quiescence-warrant`, never "admitted" — the query is a conservative DISK OBSERVATION, never act authority (an act's answer = attempting acquisition, shipped path); absence classified: both bodies absent ⇒ `free`; host present + writer absent ⇒ `lease-unavailable`; P10 fixture extended: NO status answer is ever `admitted` |
| C12-M6 | major | abort paths do not compose with the closed union: unknown predecessors have no representation in `{pid,hostToken,seenAt}` nor a `TakeoverResult` mapping; malformed ledger is both `journal-quiescing` and `aborted(ledger-malformed)` with the normal-acquisition result unstated; duplicate-ids-at-takeover routes to an ACT refusal although no act is admitted; post-release `journal-corrupted` persistence is not encoded by any surviving state | unknown predecessors get an in-schema entry `{pid: 0, hostToken: "unknown-<minted-ulid>", seenAt}` — pid 0 never real, never ESRCH-clearable, cleared by confirmation naming that exact token (printed by result and status); malformed-ledger refusal needs no publish while unreadable (refusal precedence already defined); takeover-scope duplicate ids ⇒ the union's OWN reason (act-scope `journal-unreadable:duplicate-ids` unchanged for normal reads); corruption persistence: the guard is the JOURNAL BYTES re-inspected by every acquiring wrapper — no wrapper field or ledger state required; census closure fixture extended to BOTH unions (`journal-corrupted` in both planes, discriminated by payload `status`) |
| C12-m1 | minor | `chainFrom` must always parse as a ulid yet is "reset" when the set empties — empty-file representation and next-chain initialization unspecified | subsumed by the B1 fix: empty-set publish RETAINS the old ulid; next non-empty chain MINTS a new one; `null` legal only in the never-had-a-chain repair state |
| C12-m2 | minor | "takeOver then inspect run under the shipped takeover lock FOR THE SWAP/INSPECT WINDOW ONLY" still conflicts with the lock released before the handle returns — inspect necessarily runs after | site corrected: the lock covers THE SWAP ITSELF ONLY; inspect runs after the handle returns, under the HOST LEASE with re-verification |
| C12-m3 | minor | shipped `open()` does NOT create an absent journal — it returns an instance after `read()`/repair tolerate ENOENT; the FIRST APPEND creates the file (`journal.ts:616-622, 663-675, 718-724`) | citation and claim corrected: absent journal is CLEAN with floor 0; creation attributed to the first append, not `open()` |
| C12-m4 | minor | the exact-id resolve points at operator-style `status`, but no status output/argument reporting abandon resolution is defined | resolve = a LEASE-FREE RE-READ of the journal under the duplicate rules by any read-capable operator tool; the text now says explicitly this contract defines NO status argument for it (`status` classification covers quiescence state only) |
| C12-m5 | minor | P12 calls usage/refused/failed a "SAME exit-code-2 pair" while `failed` exits 1 | wording fixed: usage+refused share exit 2, failed exits 1; the PAYLOAD `status` fields (`usage`/`refused`/`failed`) are the pairwise discriminator, asserted from the rendered payload |
| C12-N1 | note | the audit is incomplete (page-wise read; supporting-document review and every interleaving probe not finished) — findings are not a certification of the remaining contract | accepted as a scope note: C12 does NOT count as one of the two confirming rounds; the next round must re-attack v17's seams (identity capture, snapshot bound, clearing composition, absence posture, dual-union census) AND complete the supporting-document sweep |

## Cycle-13 disposition table (adversarial audit of v17, gpt-6.1-terra — 0 blockers + 6 majors + 4 minors; every finding verified against `src/host/supervise.ts` and `src/episode/journal.ts` before acceptance)

| ID | severity | finding | disposition (v18) |
|---|---|---|---|
| C13-M1 | major | the lost-B recovery assumes B's writer body survives to the next acquisition, but competing takeovers can replace the writer body without capturing B (guard-to-rename windows are check→act, `supervise.ts:2259-2272, 2335-2342`) — a live unproven predecessor's identity CAN be absent from ALL three artifacts; P8 asserted unconditional recovery | RECOVERY QUALIFIED: §1.1 + P8 state recovery holds ONLY while the body survives, with the fixture BARRIER-CONTROLLED (no racing body replacement); the racing JOINT-ERASURE case is restated in §5.2 as the full erasure class the double-reclaim residual permits — no invariant survives triple erasure by publishers that never observed the predecessor, none is claimed, and a real exclusion protocol (M3-ADJACENT) is the only closure; the erased case is disclosed, never asserted safe |
| C13-M2 | major | malformed writer bodies have no external-status classification: with host present + ledger empty/absent + malformed writer, clauses (i)-(iii) don't answer and (iv) needs a token parsing never supplied — implementations diverge | NEW precedence clause inserted BEFORE the token-comparison clause (v) (list order governs multi-match — folded self-correction: the draft's own primed-clause ordinal broke the chain, fixed same cycle): malformed/unreadable writer body ⇒ `journal-corrupted`, independent of host presence and every ledger state (mirrors the capture rule's unknown-predecessor treatment); P10 fixture extended to the FULL 40-triple matrix (host {absent,present} × writer {absent,pending,current,foreign,MALFORMED} × ledger {absent,empty,nonempty,malformed}) asserting exactly-one governing clause per triple — no unclassified triple remains |
| C13-M3 | major | the swap path double-assigns the abort reason: post-reclaim read sees `other` (⇒ `lease-swapped-post-reclaim`) but its guarded publish's own token failure produces `lease-stolen-precheck` — text names no winner; the swap reason was listed among "lease retained" cleanups although observing `other` proves non-ownership; detection point relative to the writer replace unpinned | DETECTION PINNED immediately after reclaim returns, BEFORE any step-2 publication; REASON PRECEDENCE: observed swap OUTRANKS a later guard failure (one abort ⇒ one reason; `lease-stolen-precheck` reserved for guard failures with no prior swap); CLEANUP OWNERSHIP-CONDITIONAL: swap ⇒ never touch the writer file (not ours), release only via the shipped token-verified `releaseOursClaim` which returns `absent` on non-ownership (`supervise.ts:1955-1990` — cited and verified), retention applies only to reasons raised while holding OUR lease |
| C13-M4 | major | P8b pins a property its fixture cannot exercise: "additions after the read survive" never says WHICH read — additions after the rename-time SECOND read are absent from `currentRead` and CAN be overwritten; the resurrection fixture injects no barriers so it passes without constructing the disclosed window | P8b REWRITTEN: survival scoped to first-read→second-read additions; the second-read→rename window (loss AND confirmation-resurrection) DISCLOSED explicitly; the fixture NOW INJECTS the material ordering with barriers (pass reads {A,X} → confirmation removes X → stale rename resurrects {A,X}) and asserts the RESURRECTION OCCURS (window real, non-vacuous) then converges via next pass + re-confirmation; NEW competing-confirmations fixture (two operators, overlapping stale reads, last-rename-wins per entry, convergence asserted, no lost-update claim) |
| C13-M5 | major | the operator recovery procedure is prose: no confirmation verb, argument, authorization representation, or delivery path to a waiting clearing pass; the malformed-ledger "operator-signed minimal ledger" names no operation — implementations cannot interoperate on the only recovery path | EXECUTABLE OPERATOR SURFACE defined (§1.1, file-permission-gated operator mode — no journal record, outside the act census): `--operator-status <episodeId>` prints the precedence answer + every entry verbatim INCLUDING `unknown-<ulid>` tokens (the discovery path; `TakeoverResult` aborts print the same list; on unreadable/malformed ledger or confirmation file it prints the RAW BYTES + the parse error, still exit 0 — C14-m6); `--confirm-quiesced <episodeId> --entry-token <token>` exact-string match APPENDS a durable record to `events/quiesce-confirmations.json` (tmp→fsync→rename→dir-fsync; NEVER a ledger edit — the operator holds no lease, and refusal-while-holder-live would have made confirmation impossible in its only use case, the 4b wait; superseded same-cycle draft of a direct guarded removal publish, C14-M1) which the LEASE-GUARDED clearing pass consumes as proven-gone evidence alongside ESRCH in its next guarded removal publish (the waiting loop re-reads each poll — un-wedges with no re-run); wrong-token records inert; `--repair-quiescence-ledger <episodeId> --from <file>` validates the replacement against the ledger schema, COPIES a parseable `chainFrom` VERBATIM else writes literal `null`, tmp→fsync→rename→dir-fsync, refused `ledger-not-malformed` unless the tool's own schema parse says malformed (the "proof of tampering" predicate was undecidable — withdrawn same cycle); valid-or-absent requires printed diff + `--force` (manual chain-severance act); REPAIR-vs-LIVE-PUBLISHER EXCLUSION per C14-M4 (below); auth = episode-dir file ownership (same boundary as the shipped supervisor — "they sign" replaced); new pin P13 drives the full loop abort→status→confirm→admit |
| C13-M6 | major | the census claims `journal-corrupted` AND `journal-quiescing` appear in both unions, but the closed TakeoverResult list contains only `journal-corrupted` — following the census adds a reason the union forbids | CENSUS CORRECTED: ONLY `journal-corrupted` is dual-plane (payload `status` discriminates `aborted`/`refused`); `journal-quiescing` is ACT-and-STATUS-ONLY, never a takeover reason (failed quiescence is never terminal — step 4b waits, v15); the closure fixture asserts its ABSENCE from the takeover union |
| C13-m1 | minor | "never an entry neither publisher saw" must count each publisher's OWN ADDITIONS, not just its ledger read snapshot | snapshot bound quantified over each publisher's own write (snapshot ∪ own-additions) — its own additions are by construction in its own publish |
| C13-m2 | minor | "a concurrent stale snapshot can therefore never resurrect" is immediately contradicted by its own parenthetical | false lead-in WITHDRAWN; the resurrection window stated directly as the second-read→rename pair, same disclosed class |
| C13-m3 | minor | the `null` repair state is named but the minimal-repair procedure doesn't pin whether it must use `null` or may use a ulid | pinned in the repair tool: repairs MUST NOT invent a chain ulid — explicit parseable `chainFrom` in the operator file is copied verbatim, absent ⇒ literal `null` |
| C13-m4 | minor | local pin "P12" collides with the P12 module (docs/16) and its "P12 convention" in the same area | explicit NAMING DISAMBIGUATION note in the pin list: "P<n>" = this doc's fixture counter, module names carry "module/convention"; no renumber (C11 disposition rows cite the labels historically) |
| C13-N1 | note | audit incomplete AGAIN: not paged to EOF, supporting-doc sweep not done, no full triple/interstice enumeration — not a confirming-round certification; the shipped-code spot-checks that WERE run confirm all five v17 code claims (token-not-ulid, no displaced-owner in handle, lock released pre-return, open() non-creating) | accepted as a scope note: C13 does NOT count as one of the two confirming rounds; C14 must page the doc to EOF, complete the supporting-document sweep (docs/11/12/16/18/20 + HANDOFF), walk the full 40-triple matrix and the N-publisher generalization, and re-attack v18's seams (erasure-class wording honesty, operator-surface race with the clearing pass, swap-reason precedence under re-races, matrix double-answers) |

## Cycle-14 dispositions (adversarial audit of v18 — 0 blockers + 6 majors + 6 minors; EOF reached at 4,570 lines but sweep/enumeration incomplete ⇒ NOT a confirming round)

| # | sev | finding | disposition |
|---|-----|---------|-------------|
| C14-M1 | major | the confirmation protocol body and its fixtures/dispositions specify INCOMPATIBLE machines: §1.1's live separate-file durable-record design vs P8b's fixture requiring an operator LEDGER publish (forbidden by §1.1) vs header/C13-M5 text describing the superseded direct guarded removal with holder-live refusal | FULL RECONCILIATION to the separate-file design: header and C13-M5 disposition rewritten to the durable-record wording; P8b's resurrection fixture rebuilt around TWO REAL GUARDED CLEARING PUBLICATIONS (double-reclaim: pass P1 stages {X} and barrages before rename; lease expires; T2's pass consumes the confirmation and renames {}; P1's stale rename resurrects {X} — asserted to OCCUR; convergence via RE-CONFIRMATION since consumed confirmations are retained-inert); NEW separate confirmation-file race fixture (two operator appends, last rename wins, lost confirmation FAIL-SAFE — wedge persists, removal never possible without ESRCH or token-named confirmation) |
| C14-M2 | major | the malformed-writer rule claims independence of EVERY ledger state while list-order precedence hands non-empty/malformed ledgers to the quiescing clauses — both outcome promises cannot be true at once | RULE RESTATED: malformed-writer ⇒ `journal-corrupted` applies ONLY after the ledger rules have not matched (reached only when ledger absent-or-empty); the R2-wins example is stated in the table's own text; P10 asserts the ENUMERATED cells, where every cell has one answer by construction |
| C14-M3 | major | the ordered list still lacks a total treatment: both-bodies-absent (`free`) and host-present+writer-absent (`lease-unavailable`) are specified AFTER the catch-all, so list-order and exception-first readers diverge; "foreign token" is undefined when no host body exists to compare against | ONE ORDERED DECISION TABLE R1–R10 (absence rules R4–R7 INSIDE the order; uncomparable token classified explicitly at R6 — host absent ⇒ never "matching"); the catch-all is last by construction; ENUMERATED 40-CELL MATRIX printed in §1.1 and asserted cell-by-cell by P10 (v18's "exactly one governing clause" assertion replaced); disposition text for the matrix claim updated at the P10 pin |
| C14-M4 | major | repair can race a live staged publisher with no defined safety transition: a clearing pass that read a VALID snapshot pre-repair can rename its stale payload over the repair (guard checks ownership only, shipped `supervise.ts:1976-1988`); reverse order likewise; no coordination or recheck rule specified | RACER BOUNDED IN §1.1: (i) a pass whose read sees a MALFORMED ledger fails closed and publishes NOTHING (R1 posture — malformed-during-pass converts to refusal, never "clears through"); (ii) stale-rename-over-repair is shown as the EXISTING second-read→rename disclosure window (every publish re-merges over its rename-time second read — reads after the repair incorporate it; only reads before can stomp); mandatory post-repair `--operator-status` + re-apply loop pinned; fixture drives repair racing a staged clearing publish and asserts BOTH outcomes sound — entries only LEAVE the ledger via ESRCH-proof or token-named confirmation, so a stomp resurrects/re-adds, never unsoundly deletes. [V39 LOCAL SUPERSESSION (R2-m2): the "never unsoundly deletes" claim is qualified — unobserved repair content IS lost wholesale by a stale full-file rename (see C15-M1 in this table and the live snapshot-loss analysis, v16/v17); the observed-entry rule (ESRCH/confirmation-only) is what survives. Row retained as the historical record.] |
| C14-M5 | major | swap-abort cleanup undefined when ownership is REGAINED between swap-observation and cleanup: `releaseOursClaim` then sees OUR token and unlinks (not the documented no-op); shipped release is check→unlink, not atomic compare-delete; retention/release outcome and effect on the abort result unspecified | CLEANUP AGAINST OWNERSHIP OBSERVED AT CLEANUP (re-read immediately before each action): ours ⇒ release it (correct — we hold it), foreign/absent ⇒ `absent` no-op; writer body touched only when ours; abort REASON frozen at swap observation, cleanup outcome reported separately as `cleanup: released \| absent \| failed:<detail>`; the check→unlink window named as the shipped disclosed residual (same non-atomicity as `supervise.ts:1976-1988`), not newly closable |
| C14-M6 | major | the triple-erasure disclosure ("no invariant survives") and the cycle-11 damage lattice are unreconciled: a reader cannot tell whether erasure damage is bounded by the fence-lost/torn/restore-class lattice or is unbounded; B's post-erasure late appends still have governance status unstated | RECONCILED IN §1.1 + §5.2: identity-PROOF failure and journal DAMAGE are separate — after joint erasure B's acts remain governed by the SAME per-append epoch-validation lattice (per-append validation admits only the current lease-file token; demoted-B appends refused or restore-class exactly as before; the erasure adds NO new journal-damage mode); what erasure destroys is the quiescence PROOF (admission while B live); §5.2 row now says the lattice STILL BOUNDS late-append damage and is the damage bound, stated once |
| C14-m1 | minor | the two-snapshot wording bounds only pairs; for N publishers the survivor bound is the final publisher's (snapshot ∪ own additions); "intersection of all snapshots" is the weaker corollary | FULL WRITER'S BOUND stated in §1.1: final publication = own snapshot ∪ own additions; earlier additions absent from the final snapshot CAN be lost; per-publisher survival = intersection of snapshots taken after its publish ∪ own additions; the pairwise-intersection phrasing explicitly DEMOTED to a corollary and P8's phrasing declared which-is-which |
| C14-m2 | minor | "they sign" / "operator-signed minimal-ledger procedure" survives at §5.2 and the capture passage despite the file-permission authorization correction | BOTH SITES WITHDRAWN: capture passage now routes through `--repair-quiescence-ledger` (file-permission-gated); §5.2 row updated; the header fold-note records the withdrawal |
| C14-m3 | minor | "so a competing acquirer serializes (see the writer-lease lifecycle below)" is a dangling splice — the lifecycle passage is ABOVE and serializes nothing | SPLICE REPLACED with the true statement: serialization on this path is the swap reason's immediate post-reclaim guard-abort itself; cross-reference removed |
| C14-m4 | minor | the pin-counter disambiguation note says "P1…P12" although P13 exists | note corrected to "P1…P13, P8b" |
| C14-m5 | minor | the three-way act payload distinction is scoped to usage/refused/failed; the operator mode reuses `refused` across planes with no discriminator | OPERATOR RESULT PLANE defined in §1.4: operator stdout `{plane:"operator", op:"status"\|"confirm"\|"repair", ok:true\|false, ...}` NEVER joins the three act families; pairwise-distinguishability fixture's scope explicitly stays the act families (operator plane excluded by construction); operator-mode result lines in §1.1 reference the plane payload |
| C14-m6 | minor | `--operator-status` promises exit 0 + full picture but defines nothing for unreadable/malformed ledger or confirmation files — rename-atomicity prevents torn publications, not I/O failure or pre-existing malformed files | BEHAVIOR DEFINED: on unreadable/malformed ledger-or-confirmation file it prints RAW BYTES (64-KiB truncation + byte count) plus the parse error, still exit 0 — the operator surface degrades to forensics, never to an error requiring the machine it diagnoses |
| C14-N1 | note | NOT a complete confirming round (EOF reached at 4,570; supporting-doc sweep and independent 40-triple enumeration and several interleavings not finished; docs/16 exit-code convention spot-check inconclusive) | accepted as a scope note: C14 does NOT count toward the two confirming rounds; C15 MUST (gate): page to EOF AND state the final line count, sweep docs/11 §5/§10/§11.4/§14.7 + docs/12 + docs/16 (including the exit-code-convention claim P12 cites — verify or flag) + docs/18 §10 + docs/20 §14 + HANDOFF with a per-document completion statement, independently enumerate all 40 matrix cells against R1–R10, and drive the named interleavings — or the round does not count |

## Cycle-15 dispositions (adversarial audit of v19 — 1 blocker + 3 majors + 3 minors; EOF verified at 4,779 and R-table/matrix independently enumerated + code citations verified, but tool-output truncation left parts of the page-read and the docs/11/12/HANDOFF sweep incomplete ⇒ self-declared NOT a confirming round)

| # | sev | finding | disposition |
|---|-----|---------|-------------|
| C15-B1 | blocker | consumed confirmations are indistinguishable from active ones after a resurrection: the record is `{hostToken, confirmedAt}` retained-inert with NO consumption marker, so after P8b's stale-rename resurrection the OLD record either re-clears X (violating P8b) or inertness has no specified predicate, including after restart | CONSUMPTION MADE DURABLE (§1.1): record gains `consumedAt?`; identity `(hostToken, confirmedAt)` immutable; the lease-holding clearing pass marks the record consumed IN THE CONFIRMATION FILE BEFORE the guarded ledger rename (mark-then-rename; crash between = entry present + confirmation consumed = conservative, re-confirm); a consumed record NEVER satisfies "proven gone" again — resurrection requires a NEW confirmation identity appended after resurrection; the confirmation-file merge rule pinned (never drop a record, never rewrite except adding `consumedAt`; lost operator append fail-safe); P8b's step-4 re-confirmation now consumes a NEW record and the fixture asserts the old consumed record does not re-clear |
| C15-M1 | major | the repair-racer bound overclaims: "a stomp can resurrect or re-add, never unsoundly delete" is false for entries the stale publisher NEVER OBSERVED — the rename replaces the whole file, so a just-published repair containing a live unconfirmed entry is destroyed wholesale, and the prescribed recovery refuses re-apply over a valid file without `--force` | BOUND RESTATED HONESTLY (§1.1 (iv)): observed-entry rule intact (publisher-observed entries leave only via ESRCH/confirmation); unobserved repair content is lost AS THE EXISTING SNAPSHOT-LOSS CLASS (repairs claim no stronger durability — as (ii) already states); such a lost LIVE entry converges DUALY: (A) the mandatory post-repair status loop, with re-apply over a valid-but-wrong file EXECUTABLE via the documented `--force` override (forensics line, disclosed territory) and TERMINATING (each stale publisher renames at most once post-snapshot — bounded by epochs in flight); (B) absent operator action, the next takeover's union read re-captures the live owner (a pending clearing rename cannot block it); fixture asserts status+`--force` re-apply restores the set and NO state hides a live holder from BOTH status and the next takeover |
| C15-M2 | major | the printed matrix is 8 rows × 4 = 32 cells while P10 asserts "these 40 cells"; the present-host FOREIGN row lives only in a footnote; independent enumeration shows 36 distinct OBSERVATIONAL cells (absent-host match/foreign collapse to the uncomparable state) | MATRIX FIXED (§1.1): the present-host foreign row is PRINTED (9 rows × 4 = the 36 observational cells); the claim restated as 40 NOMINAL cases / 36 OBSERVATIONAL with the collapse explicit — absent-host match and foreign are the SAME observable state and P10 asserts their equality to the same first-match answers (an asserted equality, not a hidden collapse); P10's fixture text updated to the same arithmetic |
| C15-M3 | major | the swap-cleanup splice ("the published variant … surviving alongside — the swap read raced … is forensic and harmless") is not a readable operative sentence inside the cleanup contract, where ledger publication and writer-body publication have different consequences | FRAGMENT REWRITTEN as three separately-stated artifacts: (1) LEDGER PUBLICATION — the abort path publishes only via the regained branch (guard precedes any publish); (2) WRITER BODY — published at step 4, foreign/absent at cleanup ⇒ removed nothing; ours again ⇒ regained branch removes its own (correct, not forensic); (3) RESIDUE — our staged content left by a regained-branch publish racing a LATER swap-away was published under our guarded publish with ESRCH-only removals, is re-incorporated by later union reads, is harmless to soundness, and is the disclosed double-reclaim residual, not a new failure. [V39 LOCAL SUPERSESSION (R2-m2): this row's "(2) WRITER BODY — published at step 4" is WRONG — v39 corrected the step number: the writer body is published at STEP 2, and the pinned swap-detection point runs BEFORE any step-2 publication; see the PUBLISHED-VARIANT CASE block. Row otherwise retained.] |
| C15-m1 | minor | "exit 1 failed / exit 2 refused (P12 convention)" attributes the rule to the P12 module, but the full docs/16 sweep found IntegrationResult statuses and git-command exit handling and NO CLI exit-code convention | ATTRIBUTION CORRECTED at all three live sites (census rendering, CLI rendering, naming note): the rule is an M3-DENERATED CONVENTION DEFINED IN THIS DOC, with a note that docs/16 must not be searched for it; the naming-disambiguation note updated to match |
| C15-m2 | minor | the erasure disclosure never connects the erased disk triple to the R-table: host+writer+ledger absent is exactly R4 `free`, and nothing says the `free` answer is not quiescence proof | CONNECTIVE MADE EXPLICIT (§1.1 erasure passage): the joint erasure LANDS ON R4 `free`; `free` is a DISK OBSERVATION, never quiescence evidence (per the table's no-act-authority rule); the erased-but-live B remains exactly this passage's disclosed admission-while-live hazard |
| C15-m3 | minor | the clearing pass pins the ledger's second read and the poll loop's confirmation re-read, but not whether confirmations arriving between the pass's first observation and its second read count in that publish | EVIDENCE SNAPSHOT PINNED TO THE SECOND READ (§1.1 clearing rules): the `kill(pid,0)` results AND the confirmation file's unconsumed-record set are evaluated at the rename-time second-read step (confirmation file re-read as part of it); post-first-observation arrivals COUNT; post-second-read arrivals are missed by that publish — same disclosed snapshot window — the unconsumed record survives and converges at the next pass/poll |
| C15-N1 | note | C15 self-declared PARTIAL on G1 (wide disposition pages truncated in tool output), G2 (docs/11 broader cross-check, docs/12 full read, HANDOFF exhaustive enumeration — partial), G4 (interleavings (ii)-(iv) not fully driven), G5 (full splice sweep partial); G3 (independent R1–R10 enumeration) and G6 (code-citation spot-checks: release primitive, journal appends, time fences — all match) complete; R1–R10 first-match agrees with every printed cell; status-vs-confirm exit codes distinguished by verb; P8b staged payload survives lease expiry within the disclosed window | accepted as a scope note: C15 does NOT count toward the confirming rounds; C16 MUST (gate, revised for tool-output limits): page to EOF IN CHUNKS that avoid truncation (explicitly `cut -c1-200` long lines and report per-chunk line ranges; state first-and-last line seen) AND state the line count; complete the docs/11 §5/§10/§11.4/§14.7 + docs/12 + docs/16 + docs/18 §10 + docs/20 §14 + HANDOFF sweep with per-document completion statements; drive interleavings (i)–(iv) naming each step's governing rule; sweep EVERY v19/v20 splice end-to-end for surviving fragments; or the round does not count |

## Cycle-16 dispositions (adversarial audit of v20 — 2 blockers + 1 major + 1 minor; verdict CHANGES REQUESTED but the completeness gate (G1–G6) self-declared NOT satisfied ⇒ NOT a confirming round; all findings verified before acceptance)

| # | sev | finding | disposition |
|---|-----|---------|-------------|
| C16-B1 | blocker | a concurrent confirmation append erases the consumption mark: the operator reads a pre-mark snapshot while the pass marks X consumed and removes X; the operator's rename publishes the pre-mark file + its record, RESTORING X's record unconsumed — a stale ledger rename resurrects X and a later pass clears it WITHOUT re-confirmation (v20's merge rule serializes neither the renames nor prevents pre-mark restoration) | CONSUMPTION MARKS MOVED OUT OF THE OPERATOR-WRITTEN FILE ENTIRELY (§1.1, v21): confirmations file = operator-appended records only, NEVER marked; the lease-holding pass alone appends consumed identities to `events/quiesce-consumptions.json` (append-only; SINGLE WRITER UNDER THE HOST LEASE ⇒ marks cannot be lost by construction; restart re-derives active = confirmations − consumed); crash between consumption append and ledger rename = entry present + evidence consumed = conservative (re-confirm, never unguarded removal); barrier fixture: operator append racing pass consumption + stale-ledger-rename resurrection + subsequent clearing pass — the restored RECORD is not ACTIVE, re-confirmation required |
| C16-B2 | blocker | a SECOND pre-existing confirmation for X survives the removal and re-clears a resurrected X without any post-resurrection confirmation — "an unconsumed confirmation naming X proves it gone" conflicts with the fresh-identity requirement | CONSUME ALL RECORDS FOR THE TOKEN: removing X via confirmation evidence appends EVERY record naming X's token to the consumed set, so after any removal NO pre-removal record is ACTIVE — a resurrected entry clears ONLY via ESRCH or a NEW record appended after resurrection; NEW P8b two-confirmations fixture (two records before removal → pass removes X consuming both → stale rename resurrects → NEITHER re-clears; post-resurrection confirmation does) |
| C16-M1 | major | the re-apply termination argument lacks a stability condition: per-publisher rename bounds do not bound a continuing stream of new takeover epochs staging publishes between re-apply and status | TERMINATION STATED AS CONDITIONAL (§1.1): converges in (epochs in flight) + 1 rounds IF epochs are finite (no further lease taken staging a clearing publish) — a pinned conditional guarantee; under a CONTINUING takeover/crash loop NO termination is claimed: wedge persists, every re-apply prints the divergence (never silent), escalation = operator stops the churn (kills the wrapping supervisor processes — same file-permission boundary) then final re-apply |
| C16-m1 | minor | `--operator-status` requires ledger entries but never requires displaying the confirmation records or their consumed state — the operator cannot diagnose WHY a wedged entry refuses to clear (lost append vs consumed record vs none) | STATUS PRINTS BOTH CONFIRMATION FILES (§1.1 (a)): every record verbatim annotated `active`/`consumed` by the consumed-set computation; absent files print as empty sets; P13 asserts the annotation |
| C16-N1 | note | the binding completeness gate was again NOT satisfied (G1: EOF chunked page read not completed; G2: per-document sweeps — P12 exit-code claim, HANDOFF chronological claims — unverified; G3: 40-case independent enumeration not completed; G4: only the confirmation-mark and duplicate-confirmation interleavings driven; G5: splice sweep partial; G6: shipped-code citations not verified — though no finding relied on one) | accepted as a scope note: C16 does NOT count toward the confirming rounds; C17 MUST satisfy the FULL gate: chunked EOF page read with per-chunk line ranges + first/last line seen + final line count; per-document sweep with completion statements (docs/11 §5/§10/§11.4/§14.7, docs/12, docs/16, docs/18 §10, docs/20 §14, HANDOFF); independent enumeration of all 40 nominal matrix cells against R1–R10; interleavings (i)–(iv) with each step's governing rule named; end-to-end splice sweep for surviving fragments — or the round does not count |

## Cycle-17 dispositions (adversarial audit of v21 — 2 blockers + 2 majors + 1 minor; verdict CHANGES REQUESTED; gate self-declared NOT satisfied (G0/G1 fold-reread + certification, G3 enumeration, G4/G5/G6 partial) ⇒ NOT a confirming round; all findings verified before acceptance)

| # | sev | finding | disposition |
|---|-----|---------|-------------|
| C17-B1 | blocker | a confirmation appended AFTER the pass's evidence snapshot but BEFORE the removal stays active (v21 explicitly excluded post-snapshot records from consumption) and re-clears a resurrection — contradicting the claimed "no pre-removal record survives active / resurrection needs a post-resurrection confirmation" property; P8b's fixture only tests two records from BEFORE the snapshot | WATERMARK TAKEN AFTER THE FINAL GUARD (§1.1, v22: ORDERING SUPERSEDED v24/v25 — L is read and appended PRE-GUARD per the total order; the row is kept as the historical fold): the pass re-reads the confirmation file's CURRENT BYTE LENGTH L immediately after its last ownership check and appends `{hostToken, watermark: L}` before the ledger rename — every record naming the token below L is permanently inert, capturing the C17-B1 window; the residual shrinks to the guard→rename step (disclosed shipped non-atomicity, `supervise.ts:1976-1988`), whose surviving record is a true disappearance assertion for the exact dead token (never matches a new process's different token); P8b's two-confirmations fixture REWRITTEN to the exact interleaving (one record pre-snapshot, one post-snapshot/pre-removal — both inert) plus a guard→rename-race probe (v25 label: "post-guard-race" — v22 name, window is watermark read → rename with the guard inside) asserting the disclosed-window record may legitimately clear a later resurrection |
| C17-B2 | blocker | the consumed set loses marks across overlapping epochs: P1 (displaced after passing its guard) renames a pre-B snapshot of the consumptions file over P2's mark B; B's entry resurrects and B's retained confirmation re-clears — v21's "single writer under the lease" premise does not cover the expressly disclosed double-reclaim residual, and read-merge-append's "only ADDS" is not monotone across stale RENAMES | CONSUMPTION LOG IS APPEND-ONLY VIA O_APPEND (§1.1, v22): both files are JSONL logs written `O_WRONLY|O_CREAT|O_APPEND` + ONE bounded write + fsync (line cap 512 B; torn tail ignored per the ledger's tail-scan rule) — NO tmp/rename/merge exists anywhere, so a stale epoch-displaced writer can only ADD a line and destroy nothing; marks are unlosable BY CONSTRUCTION including across double-reclaim; P8b's lost-append race fixture replaced by a both-appends-land assertion (the v21 loss class is structurally impossible); the "single writer" claim narrowed honestly: single writer under lease for LOG ORDER, but soundness needs no ordering — append-only is commutative for the watermark-max computation |
| C17-M1 | major | malformed-consumptions recovery names no operation: `--repair-quiescence-ledger` targets only the ledger; a reused-PID entry wedged behind an unreadable consumption log has no reachable repair (and a new confirmation would be useless if the log were uncomputable forever) | TWO NEW VERBS DEFINED (§1.1 + P13): `--repair-confirmations --from` / `--repair-consumptions --from` with the ledger-repair doctrine (validate-before-publish per-line schema; refused `file-not-malformed`; valid-or-absent requires printed diff + `--force`); a confirmation-log repair MUST also append `{hostToken:"ALL", watermark: <repaired byte length>}` to the consumption log so no pre-repair record re-activates (operator appends to the watermark log are monotone-safe: thresholds only rise); status's `unknown` annotation makes the wedge diagnosable |
| C17-M2 | major | confirmation identity `(hostToken, confirmedAt)` has no uniqueness guarantee: a repeated or regressed clock makes a NEW confirmation indistinguishable from a consumed one — it is instantly classified consumed and the prescribed re-confirmation never clears the entry | IDENTITY IS `confirmId` (v22): the CLI generates a fresh ULID per `--confirm-quiesced` invocation; `confirmedAt` is forensic metadata, NEVER identity; consumption is by watermark offset so identity collision cannot cause double-consumption either; fixture: same token, same `confirmedAt`, two records ⇒ distinct lines, independently positionable relative to a watermark |
| C17-m1 | minor | status promises active/consumed annotations even when the consumption log is unreadable — the classification is uncomputable, yet the spec has no third value | `unknown` ANNOTATION (v22 §1.1 (a)): when the consumed log cannot be computed, every confirmation prints with `unknown` alongside the raw bytes + parse error — never a fabricated active/consumed verdict; P13 asserts the annotation |
| C17-N1 | note | gate self-declared incomplete: G1 chunk read "cannot be certified" + one nonconforming `fold` reread; G2 sweep uncertified for wide lines; G3 enumeration NOT done; G4 interleavings (iii)/(v) not fully driven; G5 splice sweep partial; G6 citations read but line-mapping incomplete; findings produced before gate completion | accepted as a scope note: C17 does NOT count toward the confirming rounds; C18 MUST (gate, with TURN ECONOMY — complete the gate EARLY): sequential ≤220-line `cut -c1-190` chunks to EOF with ranges + first/last line recorded as you go (no `fold`, no parallel batched page reads); per-document completion statements ×7; independent 40-case enumeration against R1–R10; interleavings (i)–(v) with governing rules named; splice sweep of the v22-touched regions; citation checks — the gate FIRST, findings after, or the round does not count |

## CYCLE-18 dispositions (v22 → v23) — verdict CHANGES REQUESTED (2 blockers + 3 majors + 1 minor)

C18 (gpt-6.1-terra) completed under the TURN-ECONOMY protocol (6-call batched turns) but again SELF-DECLARED NON-CONFIRMING (G1 non-EOF targeted reads; G2/G3 incomplete; G4–G6 partial) — it does NOT count as a confirming round. Every finding was independently verified against the text before acceptance:

| # | sev | finding | disposition |
|---|-----|---------|-------------|
| C18-B1 | blocker | `--repair-consumptions` rename can discard a LIVE concurrent watermark append (append lands on the renamed-away inode after the repair's old-file max check), and a stale ledger rename can then resurrect the entry with its confirmation active again | ACCEPTED — repair now runs UNDER HOST-LEASE ACQUISITION: acquiring the repair lease revokes prior epochs through the standard lease-swap; the clearing pass's final guard is its LAST epoch check immediately before its ledger rename, so a repair that could discard the pass's append has necessarily revoked its epoch and the pass's guarded rename then FAILS — removal and watermark are same-epoch facts, no reachable state has the removal landed without its watermark; a residual late append re-positions onto the replacement via O_APPEND and only ADDS a monotone-safe line |
| C18-B2 | blocker | "torn trailing line ignored" applied to the CONSUMPTION log is not fail-closed: a partial live watermark append is observationally indistinguishable from a torn tail; ignoring it silently un-consumes the confirmation it carried — a re-clear path | ACCEPTED — failure algebra asymmetry PINNED: confirmation-log torn tails ignored (losing a confirmation wedges, fail-safe); an unsettled (bytes-after-last-complete-line) consumption-log tail renders the consumption authority UNCOMPUTABLE — confirmation evidence REFUSED for all clearing decisions (ESRCH still clears), status prints `unknown` naming the unsettled tail's offset, recovery is `--repair-consumptions` tail truncation under the repair doctrine |
| C18-M1 | major | byte-offset watermarks compared across a REPLACED confirmation-log file strand fresh post-repair records (old watermark 10,000 > 100-byte replacement ⇒ every fresh confirmation "consumed" until the file regrows 10 KB) — contradicts the repair promise | ACCEPTED — GENERATIONS: confirmation log's first line is `{confirmGen: fresh ULID}` (written at creation AND every repair); watermark lines carry the `confirmGen` their L was read from; ACTIVE compares offsets ONLY within matching generations; a generation with no watermarks is fully live; pre-repair copies inert via the repair's ALL-line written IN THE NEW GENERATION |
| C18-M2 | major | the second-read evidence rule ("a confirmation after the second read stays ACTIVE and satisfies its next evaluation") contradicts the watermark rule (consumed if it lands before the later L read) — same record, two classifications | ACCEPTED — roles disambiguated: the second read determines what the pass may USE as removal evidence; L determines what it CONSUMES; a record between the second read and L is never evidence for THIS removal yet permanently consumed; only a record after L stays ACTIVE (guard→rename race residue — v25, cycle-20 major 1: L is read PRE-GUARD per the v24 total order; supervise.ts:1976-1988 parity) |
| C18-M3 | major | P8b two-confirmations fixture says both records inert for arrivals "after the snapshot but before the removal" — but the algorithm only makes records below L inert; an arrival between L and the rename is the ACTIVE guard→rename race (v25: the v23 'post-guard' label corrected) | ACCEPTED — fixture barrier pinned to arrival BEFORE the L read; the separate guard→rename-race probe retained and cross-referenced (v25 label correction) |
| C18-m1 | minor | P13 says "a confirmation racing a clearing publish loses ONLY its own append" — contradicts the O_APPEND both-land fixture | ACCEPTED — loss means WRITE FAILURE only; a race can never lose a confirmation append |

C18-SCOPE: C19 must complete the gate EARLY and prove EOF: sequential ≤220-line `cut -c1-190` chunks to the LAST line with per-chunk ranges + first/last line text; G2 ×7 completion statements; G3 independent 40-case enumeration; G4 drive (i) the C18-B1/B2 fixed paths re-driven, (ii) generation arithmetic (post-repair fresh confirmation ACTIVE — walk offsets across generations; a watermark naming a foreign confirmGen is IGNORED — verify no predicate can mix generations), (iii) unsettled-tail recovery walk (repair truncation vs a new concurrent append — who can append while no lease? operator confirmations can — do they ever affect the consumption-log tail? they append to the CONFIRMATION log only — confirm), (iv) R4 mid-acquisition `free` (still undriven from C17), (v) status precedence with ALL of: ledger malformed + consumption tail unsettled + confirmations valid; G5 splice sweep of ALL v23-touched regions (~540-615, ~1355-1375, ~1972-2005, ~2015-2035, ~2063-2100, ~4515-4530, ~4590-4605, foot table); G6 citations. Gate first, findings after; COUNTS only if G0–G6 all complete.

## CYCLE-19 dispositions (v23 → v24) — verdict CHANGES REQUESTED (2 blockers + 2 majors + 1 minor)

C19 (gpt-6.1-terra) completed under the TURN-ECONOMY protocol but SELF-DECLARED NON-CONFIRMING (G0/G1: one batched supporting-document call exceeded the 220-line chunk mandate so EOF is proven but G1 not certified; G2 seven-document sweep not certified; G4/G5 partial) — it does NOT count as a confirming round. Every finding was independently verified against the text before acceptance:

| # | sev | finding | disposition |
|---|-----|---------|-------------|
| C19-B1 | blocker | lease acquisition does NOT fence a pass already PAST its final guard: P guards, pauses; repair acquires, stages, renames over the consumption-log inode; P resumes and renames the ledger — removal landed, watermark on the renamed-away inode, and the stale rename + active confirmation re-clear class reopens; the v23 "same-epoch facts" claim is contrary to the contract's own guard→rename stale-rename fixture (v25 label correction), and the shipped precedent is non-atomic | ACCEPTED — the fence is REPLACED by a pinned total order (§1.1 (c) LOG): (1) re-read L + gen header; (2) append the watermark via a FRESH `open(O_WRONLY|O_APPEND)` + one write + fsync + close — no fd held across any pause, so the line lands in whatever file is current at open time (the stale-inode append class is eliminated by construction); (3) the EPOCH-CHECK GUARD AS THE LAST OPERATION before (4) the ledger rename — a repair acquiring after step (2) revokes the epoch and FAILS the rename (no removal; the watermark is monotone-safe); (5) POST-RENAME SELF-VERIFICATION: re-scan the CURRENT log for (confirmGen, X, L); absent (repair replaced the file in the disclosed check→rename window) ⇒ re-append once (max-semantics, idempotent); plus the repair owner's composition rule — at post-acquisition re-read it composes every tail-scan-readable old line into its replacement. "Removal landed, watermark absent from the current log" is self-healing, converging in at most one extra confirmation cycle; fixtures drive BOTH inode orderings |
| C19-B2 | blocker | confirmation-log repair can expose copied confirmations before its new-generation ALL watermark is durable: publish G2, crash before the ALL line; "a generation with no watermarks is fully live" activates COPIED consumed records; old-generation watermarks are (correctly) ignored so cannot protect | ACCEPTED — PUBLICATION ORDERING PINNED (§1.1, confirmation-repair block): the staged replacement's length N and new generation G2 are known BEFORE publication; (1) build tmp; (2) append the ALL line `{ALL, watermark: N, confirmGen: G2}` to the current consumption log (fresh O_APPEND, write, fsync, close) — DURABLE; (3) ONLY THEN the tmp→rename publishing G2. Crash between (2) and (3): the ALL line names an unpublished generation — harmless; retry recomputes and re-appends (idempotent). No reader ever sees a G2 record without its covering ALL watermark; copied records are inert the instant they appear. Crash-window + consumed-copy-do-not-clear fixtures pinned |
| C19-M1 | major | the prescribed consumption repair is unavailable to the live 4b holder it must unblock: the unsettled tail refuses confirmation evidence while 4b holds the host lease, and `--repair-consumptions` requires acquiring that same lease — deadlock, no specified exit | ACCEPTED — WAITING-HOLDER SELF-REPAIR EXIT (§1.1 (b) + P13): the repair doctrine's lease requirement FENCES CONCURRENT WRITERS, so a holder already satisfies it — the repair runs under the EXISTING lease (same epoch, no swap) when invoked by the holder, and the 4b poll loop automates it: a poll observing the unsettled-tail annotation truncates in place under its own epoch (validate-line-scan, tmp→rename, ALL-line rule unchanged) and continues waiting with recomputed authority; non-holders keep the standard acquisition path (held lease ⇒ `lease-unavailable`); waiting-holder recovery fixture pinned |
| C19-M2 | major | confirmation repair concurrent with an already-started pass lacks a sound handoff: a pass may hold G1 evidence and G1's L when a repair publishes G2; which G2 records are consumed and whether the in-flight removal is protected is implementation-divergent | ACCEPTED — CROSS-GENERATION HANDOFF pinned (§1.1, after the GENERATIONS block): pass-vs-repair is lease-serialized, so exactly three interleavings — (A1) repair acquires first ⇒ the epoch swap fails the not-yet-guarded pass outright; (A2) the pass guards first, repair lands before its rename ⇒ post-rename self-verification re-appends (G1, X, L) onto the current G2 file and G2's ALL line keeps every copied pre-repair record consumed — the G1 watermark is a monotone-safe line for a removal that never survived; (A3) the pass completes first ⇒ the repair's readable-line composition carries the G1 watermark into the replacement. In NO interleaving can implementations disagree: only offsets ≥ N in G2 are live, decided by the single ALL line durable before G2 is visible; A2 barrier fixture pinned |
| C19-m1 | minor | §3 P10 attributes malformed-ledger + malformed-writer to R2, but the ordered table matches malformed ledger at R1 (same answer, wrong rule) | ACCEPTED — P10's attribution corrected to the table's first-match order (malformed ledger matches R1 first; non-empty matches R2) |

C19-SCOPE: C20 must complete the gate EARLY and prove EOF: sequential ≤220-line `cut -c1-190` chunks to the LAST line with per-chunk ranges + first/last line text (NO batched supporting-document call exceeding one chunk — the C19 G0 violation); G2 ×7 completion statements; G3 independent 40-case enumeration; G4 drive (i) the C19-B1 total order under BOTH inode orderings (repair rename before vs after the watermark append — assert the self-verification closes the second), (ii) the C19-B2 crash window (ALL durable, G2 unpublished — assert no G2 record ever visible; retry converges; a copied consumed record does NOT clear), (iii) the 4b self-repair walk (holder truncates under its own epoch; a NON-holder gets `lease-unavailable`), (iv) the A2 cross-gen handoff, (v) R4 mid-acquisition `free` (still undriven since C17); G5 splice sweep of ALL v24-touched regions (~605-645 header, ~2015-2110 LOG ordering, ~2040-2075 publication ordering, ~2135-2170 repair restatement + handoff, ~1395-1420 tail, ~4690-4770 P13 + new fixtures, foot tables); G6 citations (`supervise.ts:1976-1988` re-verified as non-atomic — the contract now CLAIMS no atomic fence, only self-healing). Gate first, findings after; COUNTS only if G0–G6 all complete.

## CYCLE-20 dispositions (v24 → v25) — verdict CHANGES REQUESTED (1 blocker + 1 major + 0 minors; SELF-DECLARED NON-CONFIRMING)

C20 (gpt-6.1-terra) completed the gate's G0/G1 (sequential ≤220-line `cut -c1-190` chunks over all 5,417 lines, first/last lines reported, footer C19-SCOPE) but SELF-DECLARED the round NON-CONFIRMING: G3 (40-case enumeration) INCOMPLETE, G4/G5/G6 PARTIAL — findings concrete, no closure certification. Per the counting rule the round does NOT count as confirming; its findings are folded at full severity.

| # | sev | finding | disposition |
|---|-----|---------|-------------|
| C20-B1 | blocker | crash after the ledger rename can leave the OLD confirmation active indefinitely: pass appends (G1,X,L), passes its guard; a consumption-log repair acquires the lease, composes its replacement from a snapshot that misses the append, publishes; the pass's already-guarded rename removes X and the process CRASHES before post-rename self-verification — the CURRENT consumption log lacks the watermark, a stale ledger rename resurrects X, the pre-L G1 record is ACTIVE and re-clears; the restart two-log scan cannot infer the lost line and the repair doctrine cannot recover what it never observed (post-rename work in the crashed process alone cannot close it) | ACCEPTED — CLOSED BY ORDERING + MANDATORY COMPOSITION (§1.1 (c), v25): the repair owner's replacement line set is built by a re-read of the CURRENT consumption log STRICTLY AFTER lease acquisition (a pre-acquisition snapshot is ILLEGAL) and every tail-scan-readable old line is composed before its tmp→rename; the replacement publish is crash-durable (premise (R): tmp fsync → rename → file+parent-dir fsync before success; a pre-dir-fsync crash leaves the old watermark-bearing log current and a retry recomposes); the pass's watermark append is fully durable (fresh open(O_APPEND)+write+fsync+close; v26 note: step (2) gained MANDATORY O_CREAT + (R)-durable creation and step 2V per cycle-21) BEFORE its epoch-check guard. WATERMARK-LOSS IMPOSSIBILITY THEOREM: a repair acquiring before the guard revokes the epoch and FAILS the rename (nothing to lose); a repair acquiring after the guard's composition read is strictly after the append was durable in the then-current log ⇒ SEES and composes the line; induction over consecutive repairs (crash-durable at each step by (R)) makes "removal landed, watermark exists NOWHERE readable" UNREACHABLE in every schedule including kill-before-step-(5). Post-rename self-verification is DEMOTED to redundant defense against implementation drift. Crash-point invariant table added at §1.1 (c) (crash after 2/3/4/5, each with its recovery); NEW FIXTURE (i-b) drives the EXACT C20-B1 schedule (repair with stale snapshot → pass append+guard+rename → `kill -9` before step (5)) through restart: the two-log re-derivation finds the line in the CURRENT log, a stale-rename resurrection is NOT cleared by the pre-L confirmation (INERT), only ESRCH or a NEW post-resurrection record clears, final state {} |
| C20-M1 | major | the LIVE second-read passage (~:1426) and P8b (~:4676) still placed L AFTER the final guard ("post-guard watermark read L"), contradicting the normative v24 total order (L re-read + watermark appended BEFORE the guard) — incompatible operative sequences, not historical description; P13's "post-guard-race" probe label inherited the error | ACCEPTED — both live sites reconciled to the PRE-GUARD total order (second read = what the pass may USE as evidence; pre-guard L = what it CONSUMES; roles unchanged per C18-M2); the probe RENAMED post-guard-race → GUARD→RENAME-RACE at every site (the window is watermark read → ledger rename with the epoch-check guard inside it; `supervise.ts:1976-1988` parity); historical disposition rows C17-B1, C18-M2, C18-M3 carry explicit supersession/label-correction notes so no live text contradicts the operative order |
| C20-G | gate | C20 self-declared NON-CONFIRMING (G3 independent 40-case enumeration not completed; G4 drove only the counterexample, not the full schedule set; G5/G6 partial) | NOTED — the round does NOT count toward the two-confirming-rounds rule (§0); the C21 mandate below re-pins the full gate with the v25 additions and demands NO self-declared partial passes |

C21-SCOPE: C21 audits v25 and must complete the gate EARLY and prove EOF: sequential ≤220-line `cut -c1-190` chunks to the LAST line with per-chunk ranges + first/last line text (NO batched supporting-document call exceeding one chunk — the class of shortfall that has now cost C19 and C20 their confirming status: budget the chunk calls FIRST, findings second); G2 completion statements for docs/11 §5/Q5/M3/§14.7, docs/12, docs/16, docs/18 §10, docs/20 §14, HANDOFF M3 sweep; G3 INDEPENDENT 40-case enumeration of the P10/P13 matrix vs the first-matching-rule table (not inspection — enumerate and compare); G4 drive to closure, each listed separately: (i) the v25 watermark-loss impossibility argument — construct the repair-acquisition schedule set around a pass appending BEFORE and AFTER the guard's epoch check and show every branch ends either no-removal or watermark-in-current-log (attack the theorem: two consecutive repairs with the second's acquisition between the first's rename and the pass's crash; a repair whose (R) dir-fsync is the crash point); (ii) fixture (i-b)'s schedule as written — verify the kill-before-step-(5) restart finds the line and the resurrection converges; (iii) BOTH inode orderings of the v24 past-guard repair race under the v25 composition rule; (iv) the C19-B2 crash window; (v) the 4b self-repair walk; (vi) the A2 cross-gen handoff; (vii) R4 mid-acquisition `free`; G5 splice sweep of ALL v25-touched regions (~643-690 header fold, ~2135-2200 §1.1 (c) theorem + (R) premise + crash table, ~2250-2320 crash-point paragraphs, ~1420-1460 second-read, ~4730-4760 P8b probe rename, ~4850-4890 fixture (i)/(i-b), foot tables) asserting no orphaned sentence fragments and NO surviving operative "post-guard" claim (historical rows with supersession notes excepted); G6 re-verify `supervise.ts:1976-1988` and `:2259-2272` and grep the WHOLE doc for any remaining atomic-fence or post-guard-ordering claim. Gate first, findings after; COUNTS only if G0–G6 are ALL complete and self-certified complete — any self-declared partial pass repeats the C19/C20 non-confirming outcome.

## CYCLE-21 dispositions (v25 → v26) — verdict CHANGES REQUESTED (1 blocker + 2 majors + 1 minor; SELF-DECLARED NON-CONFIRMING — third consecutive)

C21 (gpt-6.1-terra) completed G1 (sequential chunks, wc 5,539, first/last lines reported), G2 (all 7 docs), and — first time since C18 — a COMPLETED G3 (independent 40-case enumeration: all 40 answers match the printed rows; absent-host match/foreign collapse → 36 cells; malformed-ledger R1). G4/G5/G6 self-declared partial ⇒ the round does NOT count as confirming; findings folded at full severity.

| # | sev | finding | disposition |
|---|-----|---------|-------------|
| C21-B1 | blocker | the consumption log has NO CREATION PROTOCOL: the mandatory watermark append opens `quiesce-consumptions.json` `O_WRONLY|O_APPEND` WITHOUT `O_CREAT`, while `--operator-status` legitimately prints both logs absent and no other creator is specified — a fresh episode's first confirmation-based removal fails `ENOENT` at step (2), so the P13 recovery path has NO specified successful execution on exactly the fresh-episode reused-PID scenario it exists for | ACCEPTED — `O_CREAT` is MANDATORY at the pass's step-(2) append AND the confirmation-repair ALL append (§1.1 (c), v26), with (R)-DURABLE CREATION: on creation the file is fsync'd and the PARENT DIRECTORY is fsync'd before step (2) completes, so a step-(2)-durable watermark in a just-created log survives power loss like a repair publish; a plain append to an EXISTING name needs no dir fsync (the name is already durable) |
| C21-M1 | major | the v25 proof and the LIVE cross-generation handoff prescribe incompatible roles for self-verification: the theorem says it is redundant; A2 says the watermark is "orphaned on the old inode" and self-verification re-appends it; the repair passage calls it "the handler" for past-guard passes — a conforming implementation cannot treat a required recovery action as redundant, especially kill-before-step-(5) | ACCEPTED — ROLES RECONCILED TO THE PROVED INVARIANT (v26): in A2 the repair's MANDATORY POST-ACQUISITION COMPOSITION is the load-bearing carrier (the pass's append was durable in the log current at the repair's acquisition, so the composition read SEES the (G1,X,L) line and carries it into the G2 replacement regardless of the pass's survival); self-verification if it runs FINDS the line present and is a no-op (idempotent-duplicate only on implementation drift) — the redundant backstop ONLY; A2's "orphaned on the old inode" narrative DELETED; the A2 fixture REWRITTEN to assert the line is in the CURRENT log WITH THE PASS KILLED BEFORE STEP (5) and the copied confirmation still does not clear; the repair paragraph now names composition FIRST as the handler with self-verification as backstop and forbids swapping the roles |
| C21-M2 | major | the composition predicate "tail-scan-readable" is UNDEFINED at the safety boundary — not pinned for the consumption log, not established to agree with the authority scan and the self-verification scan, and the torn-prefix case (a COMPLETE watermark appended after an abandoned unterminated fragment) is unresolved (O_APPEND FUSES onto an unterminated tail: durable but not a physical line ⇒ one implementation keeps it, another omits it — the theorem ASSUMED preservation rather than proving it for those bytes) | ACCEPTED — SINGLE NORMATIVE READABLE PREDICATE DEFINED (§1.1 (c), v26): READABLE iff a PHYSICAL `\n`-terminated line that parses under ONE shared parser as a schema-valid watermark record (required fields, 512 B cap); ONE definition used IDENTICALLY by authority computation, step-(5) self-verification, and repair composition (all former "tail-scan-readable" sites now name it); THE FUSION HAZARD PINS the torn-prefix case (fused records are durable but NOT READABLE); the theorem gains the VERIFICATION PREMISE STEP 2V: after write+fsync+close the writer FRESH-READS the last 1024 bytes and tail-scans for its own READABLE (confirmGen,hostToken,watermark) line — NOT FOUND ⇒ append treated FAILED ⇒ removal cycle ABORTS pre-guard (no rename; wedge persists, fail-safe; re-attempt after `--repair-consumptions` settles the tail); by 2V+abort every unreadable/fused region belongs to a removal that NEVER LANDED, and composition preserves READABLE lines byte-for-byte with (R) surviving crash — so the induction premise "landed ⇒ READABLE watermark" is ESTABLISHED, not assumed; the ALL append performs the same 2V; NEW FIXTURE (e) drives fuse→abort→repair→recover |
| C21-m1 | minor | §1.1 says the residual window shrinks to "the guard→rename step itself" although the operative window begins at the PRE-GUARD L read (a record landing between the L read and the guard has offset ≥ L and stays ACTIVE); P8b states the wider window correctly | ACCEPTED — both live sites corrected to the L-READ→RENAME window (v26), cross-referenced to P8b |

C22-SCOPE: C22 audits v26 and must complete the gate EARLY and prove EOF: sequential ≤220-line `cut -c1-190` chunks to the LAST line with per-chunk ranges + first/last line text (NO batched supporting-document call exceeding one chunk); G2 ×7 completion statements; G3 independent 40-case enumeration (C21 PROVED THIS ACHIEVABLE — replicate it); G4 drive SEPARATELY and to closure: (i) THE v26 THEOREM WITH 2V — construct the full repair-acquisition schedule set (repair fully completing between append-durable and guard; two consecutive repairs; the (R) crash point; a repair whose composition read catches a 2V-verified line), and ATTACK 2V: the last-1024-byte window vs the 512 B line cap plus newline (is 1024 provably enough to see one's own line even when another appender's line interleaves ahead — O_APPEND single writes below a page never interleave, cite it); a fresh-read racing concurrent appends (verify own line ANYWHERE in the tail scan window, not necessarily last — is that stated? if the text says "last line" that is a finding — two concurrent 2V-verified appends both pass by scanning for presence not position); (ii) FIXTURE (e) as written (fuse→abort→repair→next pass succeeds); (iii) fixture (i-b) kill-before-step-(5) + A2's v26 rewrite (line present with pass killed); (iv) BOTH inode orderings of the past-guard repair race; (v) the C19-B2 crash window; (vi) the 4b self-repair walk; (vii) R4 mid-acquisition `free`; G5 splice sweep of ALL v26-touched regions (~643-730 header fold, ~2160-2185 step (2) O_CREAT block, ~2196-2210 step 2V insertion, ~2225-2275 READABLE predicate + theorem rewrite, ~2320-2345 A2 rewrite, ~2370-2390 repair-paragraph roles, ~1468-1490 second-read operative sequence, ~2310 residual-window, ~4985-5000 fixture (e), foot tables incl. the C21 table + C22-SCOPE) — "reads clean" or quote the fragment; assert NO surviving narrative anywhere claims self-verification is load-bearing or that the watermark can be "orphaned" pending re-append, and NO operative "guard→rename step itself" window claim remains (historical rows with supersession notes excepted); G6 citations `supervise.ts:1955-1990/:1976-1988/:2259-2274/:2335-2346`, `journal.ts:616-622/:663-675/:718-748` + whole-doc grep for atomic-fence claims. BUDGET: turns 1–6 gate G1 ONLY; G2–G3 by turn ~10; findings only after the gate is closed. COUNTS only if G0–G6 are ALL complete and self-certified — three consecutive non-confirming rounds end the audit loop with the contract UNCONFIRMED and escalate to the owner.

LOOP-END DISPOSITION (v26, cycle-22; PARTLY SUPERSEDED — the
malformed-line recovery clause below is REVOKED by v27/v28;
the loop-end statement stands): C22 self-declared the
gate PARTIAL (fourth consecutive non-confirming round — C19,
C20, C21, C22): PER THE STANDING RULE THE AUDIT LOOP ENDS
HERE WITH THE CONTRACT **UNCONFIRMED** AND ESCALATED TO THE
OWNER; v26 remains DRAFT, NOT APPROVED, NOT IMPLEMENTED.
C22 nonetheless surfaced ONE surviving finding (folded the
same turn, owner-reviewable): the fuse fixture's recovery
clause assumed an unsettled-tail truncation, but a fused
watermark (the appended record ends `\n`) is a
NEWLINE-TERMINATED MALFORMED LINE — a complete physical line,
schema-INVALID — which the last-`\n` truncation rule does not
touch. FIX FOLDED: MALFORMED-ARTIFACT CLASSIFICATION added
to the READABLE-predicate paragraph (fail-closed parse
rejection; `malformed-line` status annotation distinct from
`unsettled-tail`; [REVOKED by v27/v28: composition-drop and next-pass self-heal; malformed lines are fail-closed and dropped only by the authorized forced repair], and fixture (e) now
asserts the corrected classification, the abort, AND both
recovery paths. All other C22 attacks (2V window arithmetic
and appender census, predicate schema scope, role-reconciliation
survivals, residual-window sites) were NOT reached before the
partial declaration and remain UNVERIFIED — open audit debt
for the owner; the exact unexercised schedule set is in the
C22 prompt file `~/.tre/audits/m3v26c22-terra-prompt.txt`.

V27 DISPOSITIONS (cycle-22 audit of the v26 post-C22 fold; NO new audit round run; loop remains UNCONFIRMED):
| ID | Severity | Finding | Disposition |
|---|---|---|---|
| C22-F1 | blocker | composition dropping a malformed line can erase a landed watermark | ACCEPTED: no automatic path drops a malformed line; only operator `--repair-consumptions --force` with printed diff (step (2) MALFORMED-LINE CLASS) |
| C22-F2 | major | malformed-log authority (`unknown`) conflicts with next-pass self-heal | ACCEPTED: single rule, malformed terminated line ⇒ `unknown`; fixture (e) recovery is operator repair; (e-2) added for external corruption |
| C22-F3 | major | crash invariant false between step (2) and 2V | ACCEPTED: crash table split before/after 2V; fused and un-dir-fsynced sub-cases fail-safe |
| C22-F4 | major | creation durability not established under concurrent creators | ACCEPTED: parent-dir fsync UNCONDITIONAL after every consumption-log append and on events/ mkdir; `O_CREAT` need not detect creation |
Open: the C22 unexercised schedules remain open audit debt; v27 changes require a fresh adversarial round before any approval.

V28 DISPOSITIONS (v27 self-audit findings; partly superseded by V29/V30 where noted):
| ID | Severity | Finding | Disposition |
|---|---|---|---|
| AUD27-B1 | blocker | forced malformed-line drop can reactivate a consumed confirmation (floor check blind to a corrupted landed watermark) | ACCEPTED: forced repair appends ALL{L_C, G_C} into the replacement, so every pre-repair confirmation is inert by construction; fixtures (e-2) |
| AUD27-M2 | major | external `--force` repair gets lease-unavailable while a 4b holder waits | ACCEPTED: digest-bound operator authorization, applied by the holder or an acquiring repair; fixtures (e-3), (e-4) |
| AUD27-M3 | major | crash during step (2): pre-dir-fsync vanish mislabeled as a wedge | ACCEPTED: three outcomes (α vanished = no wedge, β readable = inert, γ fused = fail-closed) |
| AUD27-m4 | minor | superseded C22 disposition read as a completed fix | ACCEPTED: marked PARTLY SUPERSEDED in place |

V29 DISPOSITIONS (cycle-1 audit of v28 by gpt-6.1-terra; NOT yet re-audited):
| ID | Severity | Finding | Disposition |
|---|---|---|---|
| AUD28-B1 | blocker | operator confirmation between L_C read and publish escapes the ALL watermark | ACCEPTED as designed: such a record is a fresh assertion (ACTIVE); invariant restated for offsets < L_C only; barrier fixture (e-5) |
| AUD28-B2 | blocker | forced ALL/replacement bytes not verified before publish | ACCEPTED: tmp fresh-read + ALL READABLE check before rename; refuse on failure (step (2)(c)(iii)) |
| AUD28-M1 | major | whole-file digest check races displaced appends (TOCTOU) | ACCEPTED: binding moved to the malformed set; composition carries READABLE displaced appends; residual window stated monotone-safe |
| AUD28-M2 | major | authorization file framing, validity, replay unspecified | ACCEPTED: AUTH/APPLIED records, torn-tail ignored, malformed-file refuses all, single use (e-6, e-7) |
| AUD28-M3 | major | crash table omits partial tail; readable survivor recovery overclaimed | ACCEPTED: outcome (δ) added; (β) requires ONE new confirmation (e-8, e-9) |
| AUD28-M4 | major | live floor-check prose contradicts the forced-ALL safety argument | ACCEPTED: rewritten as diagnostic only |
| AUD28-m1 | minor | superseded footer text still reads as operative | ACCEPTED: marked REVOKED in place |

V30 DISPOSITIONS (cycle-2 audit of v29 by gpt-6.1-terra; NOT yet re-audited):
| ID | Severity | Finding | Disposition |
|---|---|---|---|
| AUD29-B1 | blocker | replacement staged before the final read loses a displaced READABLE append | ACCEPTED: composition read is the last read before rename; displaced post-acquisition appends are never-landed; unterminated tail refused (c)(iii) |
| AUD29-M1 | major | APPLIED record torn/unverified; authorization reusable after crash | ACCEPTED: spend = APPLIED line embedded in the replacement, committed by the same rename (d) |
| AUD29-M2 | major | unterminated tail not bound by the authorization | ACCEPTED: (c)(iii) refuses any unterminated tail; the forced drop covers terminated malformed lines only |
| AUD29-M3 | major | floor check both diagnostic and refusing | ACCEPTED: diagnostic only, never a refusal |
| AUD29-M4 | major | partial-tail fixture demands a new confirmation the table does not require | ACCEPTED: (δ) restores the original active confirmation; e-8 aligned |
| AUD29-m1 | minor | v28 "no pre-repair confirmation" summary overstated | ACCEPTED: restated for offsets < L_C |
| AUD29-m2 | minor | APPLIED{appliedId} vs APPLIED{authId} schema mismatch | ACCEPTED: single APPLIED{authId} line kind |
| AUD29-m3 | minor | crash after guard/before rename said "same as previous" | ACCEPTED: stated as case (β) with ONE new confirmation |


(v32 RIDER 1) COMPACTION IS OUT OF SCOPE, NAMED, AND HONEST
(`--compact-consumptions`): the overlay leaves malformed bytes
physically present and the log grows unboundedly (REPAIR lines are
<= 4096 B and rare; growth rate is disclosed in status). Compaction
MATERIALIZES the effective read: write a new log containing the
effective authority lines (masked lines GONE), each active
confirmation's latest state, and one APPLIED{authId} line per SPENT
authId (MANDATORY — spend must survive compaction as standalone
lines; REPAIR lines may be dropped once materialized). Compaction is
a read-modify-write: THE DEFECT CLASS RE-ENTERS THERE. It therefore
runs ONLY under lease with PROVEN WRITER QUIESCENCE before its binding
read AND flock serialization on the `quiesce-consumptions.lock` lock
file held read→fsync→rename→dir-fsync (option B mechanics, scoped to
this one operator-triggered path), and its AUD30-M1-class window is
DISCLOSED at that boundary exactly as v31 disclosed (c)'s. This is
the same disclosure M1 carried, moved off the abort path where it
cannot block a repair decision. Compaction correctness is NOT covered
by this contract's remaining scope; it is a named future contract.

V31 DISPOSITIONS (cycle-3 audit of v30 by gpt-6.1-terra; last requested cycle; NOT re-audited):
| ID | Severity | Finding | Disposition |
|---|---|---|---|
| AUD30-B1 | blocker | later repair erases embedded APPLIED marker, re-enabling replay | ACCEPTED: all compositions carry APPLIED forward; (c)(vi) superset check |
| AUD30-M1 | major | late displaced append between composition read and rename not covered | ACCEPTED AS DISCLOSED RESIDUAL WINDOW (not closed); full closure needs writer quiescence (OPEN) |
| AUD30-M2 | major | ignored unterminated authorization tail fuses with next append | ACCEPTED: tail settled under lock before any append |
| AUD30-m1 | minor | spliced floor sentence | ACCEPTED: repaired |
| AUD30-m2 | minor | residual "same as previous" wording | ACCEPTED: removed |

OPEN (owner decision): AUD30-M1 closes only with writer quiescence before the binding read (fence or drain displaced appenders). The contract currently discloses the window rather than closing it.

V32 OWNER DECISION RECORD (supersedes the V31 OPEN line):
Owner decision 2026-07-15: option D (overlay repair) adopted with both riders (deferred compaction; conspicuous overlay rendering). Consequences:
- AUD30-M1 late-append window: CLOSED BY ELIMINATION (operation removed; no read-modify-write on the repair path).
- AUD28-B1 / AUD29-B1 / AUD30-B1 recurrence class (composition erases/omits state): CLOSED BY ELIMINATION (nothing composes; SPENT/mask monotone by construction).
- v31 (c)(vi) APPLIED superset forward-carry: SUPERSEDED (see v32 spend paragraph).
- v25 (R) replacement-durability premise for the repair path: SUPERSEDED (no rename on repair path).
- New open items requiring the focused confirming pass before sign-off: (1) (b-O) effective-read totality + the shared parser handling three line kinds; (2) content-hash masking soundness incl. duplicate malformed lines; (3) REPAIR crash table incl. torn REPAIR + unsettled-tail interaction; (4) 2V extended to REPAIR appends; (5) status/malformed rendering per rider 2; (6) the dedicated v32 fixture set (mask hashing, torn-REPAIR, duplicate-REPAIR idempotence, masked+resurrected bytes, rider-2 rendering) replacing the v31-shaped (e-1)–(e-5) consumption fixtures. Compaction is EXCLUDED from this contract (named, rider 1).

V33 DISPOSITIONS (focused audit of v32, run by the reviewer; the three terra cycles are recorded in the V33 record):
| ID | Severity | Finding | Disposition |
|---|---|---|---|
| AUD32-B1 | blocker | ALL watermark not in effective authority | ACCEPTED: (b-O)(6) applies each VALID REPAIR's ALL to the authority set |
| AUD32-B2 | blocker | content-hash masks hide later identical malformed bytes | ACCEPTED: masks bind (offset, hash); (b-O)(4) requires exact-offset masking |
| AUD32-B3 | blocker | the log is still truncated/rewritten on some paths | ACCEPTED: all rewrites ELIMINATED from the live protocol; authorization file framed, not truncated |
| AUD32-M1 | major | a failed self-verification is not proof AUTH unspent | ACCEPTED: full re-read decides; read failure ⇒ outcome-unknown, not retried |
| AUD32-M2 | major | creation/durability/framing/caps unspecified | ACCEPTED: (F1)-(F3), unconditional dir fsync, short-write loop, per-kind caps |
| AUD32-M3 | major | REPAIR validation and conflicts unspecified | ACCEPTED: (b-O)(3)(5) define validity and same-authId conflicts |
| AUD32-M4 | major | fixtures are categories, not executable tests | ACCEPTED: V33 FIXTURE TABLE below |

OPEN AUDIT DEBT (not resolved here): (1) the CONFIRMATION log's ALL-append repair still uses a tmp→rename path (v25-era text), which is a rewrite and has not been re-audited under this model; (2) the 64 MiB and 4096 B caps are terminal states with no fallback; (3) rider 1 compaction is out of scope.

V33 FIXTURE TABLE (each fixture is a byte-level test; expected results are normative):
| # | Setup | Expected |
|---|---|---|
| F1 | AUTH set = {offset 100, hash H}; identical malformed bytes appended at offset 900 | set changed ⇒ authorization-stale; no REPAIR; offset 900 never masked |
| F2 | landed (G1, X, L=50) at offset 100 corrupted; old confirmation (G1, X) at offset 40; REPAIR ALL{L_C=200, G1} | effective ALL makes offset 40 inert; X does not clear on it; a new confirmation at offset 260 clears |
| F3 | operator confirmation (10 B) lands at offset 200 between L_C read (200) and REPAIR append — the confirmation log grows 200->210 (AUD45-c6-1: the former "lands at offset 210" phrasing named the GROWN LENGTH, not the start offset) | offsets 200 AND 210 stay ACTIVE and clear (start + last line; R4-c2-2 pins the start) |
| F4 | REPAIR killed after 30 bytes (torn) | authority `unsettled-tail`; settlement appends \n ⇒ one malformed occurrence ⇒ NEW AUTH2 + REPAIR succeeds; AUTH1 stays unspent and stale |
| F5 | REPAIR write returns 10 of 300 bytes then EIO; re-open + full read shows no VALID REPAIR and the file is unchanged beyond the torn tail | the tail is `unsettled-tail` (NOT FAILED); settlement, then a NEW AUTH; AUTH1 stays unspent and stale |
| F6 | REPAIR durable; post-write full re-read fails | outcome-unknown; no second REPAIR; next successful full read shows VALID ⇒ spent |
| F7 | two VALID REPAIRs for one authId: same mask and G1, ALL L=200 and L=220 (confirmation-log header PARSES as G1 — v40 R3-c1: the R2-B2 generation check compares against the current header on every read) | effective ALL = 220. [V40 LOCAL SUPERSESSION (R3-c1): "with G2 instead of G1 ⇒ repair-conflict" is VACUOUS under R2-B2 — a REPAIR carrying G2 while the header is G1 is DEAD, not a conflict party; see the stage-4 sharpening; the defensive branch is pinned unreachable in test_F7b] |
| F8 | 60 malformed occurrences, each entry {offset,hash}≈70 B | REPAIR would exceed 4096 B ⇒ repair-too-large; authority stays unmasked-malformed; no truncation attempted |
| F9 | torn AUTH tail | authorization-file-malformed (fail closed) until the operator procedure; NOT ignored (v34 AUTH rule) |
| F10 | static check | no truncate, rename, or O_TRUNC call targets the consumption log or the AUTH file in the live protocol (grep over src/) |
| F11 | consumption log of 64 MiB + 1 byte | authority unknown (defensive only: reserve-on-append makes the live protocol unable to create this; externally corrupted or pre-v36 logs) |
| F13 | REPAIR whose masks entry names a valid watermark's offset (v37 wording fix, AUD36-m1: v36 said "INVALID", the operative class is DEAD); the log ALSO holds one terminated malformed line M that the REPAIR's mask list does NOT name | the REPAIR is a DEAD REPAIR (masks nothing, is not itself an occurrence); M is an unmasked malformed occurrence ⇒ `unmasked-malformed`; status annotates 1 DEAD REPAIR. (v39 R2-M5: the v37 row's "every occurrence it would have masked stays UNMASKED" was wrong — the mask names a VALID watermark, which is no occurrence at all, so with no other malformed line the read was `ok`; the malformed line M is now part of the setup) |
| F14 | torn AUTH line (unterminated) | authorization-file-malformed for every authorization until the operator procedure |
| F15 | REPAIR durable, full re-read fails | outcome-unknown; no second REPAIR; next full read decides |
| F12 | fully masked log | status renders `repaired (overlay active: N lines masked by REPAIR{authId})` |
| F16 | R2 = schema-valid REPAIR naming an unknown authId; operator tries AUTH{occurrences:[R2's (offset,hash)]} | `--authorize-consumption-repair` REFUSES `auth-entry-not-malformed` (R2's line is schema-valid, never an occurrence); R2 is a DEAD REPAIR; state `ok` + status annotates 1 DEAD REPAIR (AUD35-B1, deterministic single pass) |
| F17 | consumption log at 64 MiB − 100 B; REPAIR framed size 200 B | REFUSED `log-cap-exceeded` before any write; ZERO bytes appended; AUTH unspent; state unchanged |
| F18 | settlement `\n` write succeeds, file fsync returns EIO, process exits; next holder full-reads and sees a settled VALID record | decision state is `durability-pending` (REFUSE) until resolve sequence (fsync file + dir + read) succeeds; after success the VALID record is durable and the classification stands (AUD35-M2) |
| F19 | ledger at cap − 24 B; two processes concurrently attempt appends whose framed size crosses the cap (v37, AUD36-B2) | exactly one serial order exists under the exclusion lock; each order ⇒ reserve check fails ⇒ `log-cap-exceeded`, ZERO bytes; no interleaved partial write is constructible; non-crossing variant: the loser's check observes the winner's bytes (same lock) — the two admissible outcomes are the two serial ones |
| F20 | process enters `durability-pending`, is `kill -9`'d before recording resolution; successor full-reads (v37, AUD36-M1) | successor enters `durability-pending` by the CONSERVATIVE default of v39 R2-M6 (it does NOT infer the crashed process's fsync returns from bytes — pending is default-deny until the successor's OWN resolve fsyncs+read succeed under one lock acquisition), then resolves idempotently; adversary keeps failing fsync ⇒ attempts bounded by `repair-attempt-cap`, exhaustion ⇒ `resolve-exhausted`, service stays refused — no unbounded loop, no silent pass |
| F21 | REPAIR with unknown authId + valid AUTH covering different occurrences; operator asks status, then tries to promote (v37, owner 3A) | the REPAIR is DEAD (F16 rule), contributes nothing; unmasked occurrences ⇒ `unmasked-malformed` ⇒ promotion REFUSED; no command revives the DEAD REPAIR; a fresh AUTH+REPAIR over the current list succeeds; status lists 1 DEAD REPAIR (offset, hash, reason unknown-authId) |
| F22 | deployment points the ledger at an NFS mount; variant: FUSE mount reporting "local"; variant: lease-only cross-host (v37, owner 0A) | leg 1 (statfs) rejects NFS ⇒ `fs-probe-failed`, service never starts, zero bytes written; the FUSE impostor is judged by legs 2–4 behavior and rejected on any failing leg; the lease-only deployment has no local ledger and is out of ledger scope by design |
| F23 | REPAIR R (authId A*, masks=M) appended; no AUTH A\* exists (DEAD, reason unknown-authId); later a genuine AUTH A\* with occurrences=M is appended; full re-read. SETUP IS INJECTED/CORRUPTION-ONLY (v39, R2-M1): a conforming producer refuses a REPAIR with no matching AUTH and every authorization mints a fresh ULID, so this state is unreachable on the live path — the fixture pins the classification rule, not a supported workflow | the v39 late-validation rule: R classifies VALID on the re-read (the AUTH arrived as a genuine authorization; the operator who authored A\* authorized exactly M); a second REPAIR under A\* ⇒ refused SPENT; if instead the AUTH carries occurrences≠M, R stays DEAD forever (F21 rule) [PINNED: test_F23v33_late_genuine_AUTH_activates_dead_repair + test_F23v33_late_AUTH_occurrence_mismatch_stays_dead, added by the D4-scopeA cycle-5 fold after finding D4A-c5-1; the v38 test_F23 pins a different fixture reusing the number] |
| F24 | REPAIR R with ALL.watermark W > confirmation-log length L (DEAD, reported reason mask-mismatch per the closed 2-reason set); confirmation log later grows past W while its generation header still equals R's `all.confirmGen` (v39 R2-B2: "the generation R's AUTH bound" REVOKED — the binding is the REPAIR record's own `all.confirmGen`; no AUTH generation field exists) | R classifies VALID on the re-read per the v39 rule (growth is monotone and in-generation; validity is a current-read classification, which the reference classify already implements); a confirmation-log repair publishing a NEW generation header leaves R DEAD permanently (clause (3) generation check) |
| F25 | injected short first write on a WATERMARK append under the exclusion lock: the frame is `\n`+record+`\n` (record 36 B, frame 38 B); syscall 1 writes exactly the FIRST 3 BYTES (`\n` + the first 2 record bytes — deliberately NONBLANK), remainder completes in 2 more loop syscalls | log contains exactly one frame, byte-exact; the cap reservation was consumed once. CRASH-PREFIX ENUMERATION (v39, R2-M4) — a crash between loop syscalls has THREE distinct disk prefixes: (a) ZERO bytes written ⇒ no trace, the append simply never happened (no unsettled tail; equivalent to no append); (b) ONLY the leading `\n` (or any whitespace-only prefix) ⇒ trailing whitespace is ignored ⇒ the read is indistinguishable from (a) — NOT unsettled-tail; the append never completed and is treated as absent; (c) a NONBLANK unterminated prefix ⇒ `unsettled-tail` ⇒ settlement route. The crash-injection variant (bytes 1–3 nonblank) is case (c): unsettled-tail + settlement, never a silently dropped remainder. Fixtures drive (a), (b), and (c) separately [PINNED: test_F25v33_crash_prefix_enumeration_three_arms, added by the D4-scopeA cycle-5 fold after finding D4A-c5-2; the v38 test_F25 pins post-write verify staleness, a different fixture reusing the number; the AUD45-pre fold STRENGTHENED the pin: the write side is now DRIVEN — `partial_write` {0, 1, 4} must produce exactly the (a)/(b1)/(c) prefixes and arm (c) walks the full settlement route (unsettled ⇒ settle ⇒ one malformed occurrence ⇒ `unmasked-malformed`); mutation-verified: any-tail-unsettled kills the (b2) read arm, no-settlement-byte kills the (c) write arm] |
V33 OWNER-LEVEL NOTE: AUD30-M1 and the B1 class remain closed by elimination under v33 for the consumption log only; the confirmation-log debt in the OPEN AUDIT DEBT list is NOT closed.

V34 DISPOSITIONS (cycle-1 terra audit of v33):
| ID | Severity | Finding | Disposition |
|---|---|---|---|
| AUD33-B1 | blocker | prescribed repair refuses `unknown` yet unmasked malformed ⇒ `unknown`, so the REPAIR can't be appended | ACCEPTED: explicit authority states; REPAIR allowed from `unmasked-malformed` |
| AUD33-B2 | blocker | an unterminated nonblank tail is silently ignored, dropping authority | ACCEPTED: `unsettled-tail` fails closed; settlement appends `\n` to make it a malformed occurrence |
| AUD33-M1 | major | occurrence binding unenforceable; AUTH represented as one digest | ACCEPTED: AUTH carries an explicit {offset,hash} list; REPAIR masks must each name a malformed occurrence |
| AUD33-M2 | major | torn REPAIR vs absent indistinguishable | ACCEPTED: `unsettled-tail` classification; retry fenced until settlement |
| AUD33-M3 | major | 4096 B refusal unreachable under 512 B AUTH | ACCEPTED: AUTH cap 64 KiB; repair-too-large / auth-too-large are terminal and disclosed |
| AUD33-m1 | minor | preamble still mandates rename/composition | ACCEPTED: preamble marked superseded (see footer) |
| AUD33-m2 | minor | torn AUTH tail wedges authorization | ACCEPTED: terminal fail-closed; operator procedure named as open debt |

OPEN AUDIT DEBT (carried): confirmation-log ALL-append repair (tmp→rename, v25-era); operator procedure for malformed AUTH files; 64 MiB and 4096/64 KiB terminal states; rider 1 compaction (out of scope).

V34 FIXTURE ADDITIONS: F13 (mask names a valid watermark), F14 (torn AUTH), F15 (durable REPAIR + failed re-read). Fixtures F4, F8 revised.

V35 DISPOSITIONS (cycle-2 terra audit of v34):
| ID | Severity | Finding | Disposition |
|---|---|---|---|
| AUD34-B1 | blocker | visible-but-not-durable REPAIR reported SUCCESS | ACCEPTED: SUCCESS requires both fsyncs; ambiguous ⇒ outcome-unknown with re-open/fsync resolution |
| AUD34-M1 | major | settlement can publish a complete valid record | ACCEPTED: settlement appends `\n` only; ordinary classification decides |
| AUD34-M2 | major | SPENT omits APPLIED | ACCEPTED: one SPENT predicate (VALID REPAIR or VALID APPLIED) used everywhere |
| AUD34-M3 | major | authority precedence and semantic REPAIR classification not total | ACCEPTED: staged five-stage classification with precedence |
| AUD34-M4 | major | live rewrite instructions outside the historical section | ACCEPTED: marked V35 SUPERSEDED in place (waiting-holder truncation, step (5) composition) |
| AUD34-M5 | major | AUTH 512 B schema vs 64 KiB occurrence list | ACCEPTED: 512 B schema marked REVOKED; one format, 64 KiB cap |
| AUD34-m1 | minor | F5/F9 contradict failure handling | ACCEPTED: F5 ⇒ unsettled-tail; F9 ⇒ fail closed |
| AUD34-m2 | minor | ALL overstates concurrent-append inertness | ACCEPTED: this ALL does not make offsets >= its L_C inert by itself |

OPEN AUDIT DEBT (carried): confirmation-log ALL repair (tmp→rename, v25-era); operator procedure for a malformed AUTH file; terminal caps (64 MiB, 4096 B repair, 64 KiB AUTH); rider 1 compaction (out of scope).

V36 DISPOSITIONS (cycle-3 terra audit of v35; option-1 simplification, owner-approved):
| ID | Severity | Finding | Disposition |
|---|---|---|---|
| AUD35-B1 | blocker | REPAIR validity circular (stage 3 re-classified lines feed other REPAIRs' mask checks) | ACCEPTED: DEAD-REPAIR rule — validity references only AUTHs + stage-2 syntactic occurrences + confirmation log; never another REPAIR; single deterministic pass; AUTH entries restricted to syntactic occurrences |
| AUD35-M1 | major | stale v34 retry license after read showing no VALID REPAIR | ACCEPTED: sentence REVOKED; recovery exclusively (c-O)(vi) + resolve-on-use; no re-append while any tail/durability unresolved |
| AUD35-M2 | major | settlement fsync failure leaves visibility ≠ durability | ACCEPTED: unified DURABILITY rule + `durability-pending` observer gate (fail-closed) for ALL appenders; resolve-on-use before any authority/spend decision; crash case (ε) added |
| AUD35-M3 | major | durable append can cross 64 MiB read cap, contradicting crash table | ACCEPTED: RESERVE-ON-APPEND for every appender (`log-cap-exceeded`, zero bytes written); read cap now defensive-only |
| — | minor | F11 restated (defensive-only); F16/F17/F18 added | ACCEPTED |

OPEN AUDIT DEBT (carried, updated v36): confirmation-log ALL repair (tmp→rename, v25-era); operator procedure for a malformed AUTH file; near-cap terminal state and DEAD-REPAIR accumulation both exit only via the future compaction contract (now named from `log-cap-exceeded`).
NOTE (corrected by the v37 footer): the three-cycle budget ended with the cycle-3 audit of v35; a further FOCUSED audit of the v36 delta was run under explicit owner approval (scope: DEAD REPAIR, durability gate, cap reservation only). Findings and dispositions below.
NOTE: Option 2 (executable reference implementation + fault-injection tests, with F1–F22 as the test spec) remains the agreed next step to settle the remaining classes empirically.

AUD36 DISPOSITIONS (focused audit of v36, owner-approved scope; findings against v36, each verified against the v36 text before acceptance — all resolved in v37):
| ID | Severity | Finding | Disposition |
|---|---|---|---|
| AUD36-B1 | blocker | resolve-on-use visibility not guaranteed: a binding read could settle a decision on a snapshot a concurrent appender had already extended (no mutual exclusion between reader-settler and appenders) | ACCEPTED: EXCLUSION LOCK — one flock acquisition spans reserve+write for every appender, and resolve+classification+decision+recording for the reconciler (v37, owner decision 1A); bounded non-blocking acquisition, fail-closed `ledger-lock-timeout`, kernel-released on crash |
| AUD36-B2 | blocker | cap check races a concurrent writer between predicate and append | ACCEPTED: reserve CHECK and reserved single write share one lock acquisition (v37); F19 proves only the two serial orderings exist |
| AUD36-M1 | major | crash between entering durability-pending and recording resolution left an indeterminate state with no bounded re-entry path | ACCEPTED: pending is re-derived from disk (idempotent resolve), rounds bounded by `repair-attempt-cap`, exhaustion ⇒ `resolve-exhausted` fail-closed to the operator path (v37, owner decision 2A); F20 |
| AUD36-m1 | minor | F13 said "REPAIR INVALID" while the operative v36 class for a failing REPAIR is DEAD | ACCEPTED: F13 reworded to the DEAD-REPAIR vocabulary; F21 added covering dead-REPAIR disposition end-to-end (v37, owner decision 3A: inert + reported, revived only by fresh AUTH+REPAIR) |

V37 OWNER DECISION RECORD: 0A CONFIRMED by owner 2026-07-17 ("the recommendation where the deployment is local only"). 1A/2A/3A below are DRAFTED per the agent's recommendation and await the owner's explicit confirmation or correction — until then treat them as proposed, not ratified. [STATUS NOTE 2026-11-14: still unconfirmed; see the OWNER DECISION RECORD at the foot. SUPERSEDED IN PART by the second tranche (same date): 1A/2A CONFIRMED ("confirm 1a" / "confirm 2a"); 3A explicitly DEFERRED by owner to last ("review 3a after everything") — 3A remains UNCONFIRMED; the fourth tranche (2026-11-16) accepted the evidence-first crosswalk format for that final reading.] 0A local-only storage + 4-leg startup probe (`fs-probe-failed`, no degraded mode, lease-only remains the only cross-host mode); 1A exclusive flock sidecar `<ledger>.lock` (never renamed/deleted; LOCK_NB + bounded retry; transient `ledger-lock-held` for appenders, fail-closed `ledger-lock-timeout` for the reconciler; conformance = 0700 dir + 0600 files + same trust premise as append-only-ness); 2A bounded resolve rounds reusing `repair-attempt-cap` with `resolve-exhausted` operator exit; 3A DEAD REPAIR = inert + reported, removal is compaction debt, revival only via fresh AUTH + fresh REPAIR [QUALIFIED 2026-11-17, surfacing the D4A-c3-1 rule at its source: "revival only via fresh AUTH + fresh REPAIR" states there is NO OPERATOR REVIVAL COMMAND — it does NOT mean the DEAD classification persists: validity is a CURRENT-READ classification (v39 AUDV1-M1, owner-approved at v39), so the same stored record reclassifies VALID automatically when its missing precondition arrives later as a genuine authorization (AUTH appears / log grows past its watermark within its own `all.confirmGen`) — pinned by test_F24gen + fixture F24; the late-validation text at ~2647 carries the same qualification and the owner's pending 3A reading ratifies both readings together]. Decision 4 (audit v37 prose vs build the reference implementation first vs both) REMAINED OPEN AS OF THIS V37 RECORD — owner has since answered "c"; see the OWNER DECISION RECORD at the foot.

V38 CYCLE-3 DRAFT AMENDMENTS (reference-implementation audit of the v37
build; findings AUD C3-1..C3-7; drafted 2026-11-14, PENDING owner
ratification — same draft discipline as the v37 record above):

SIDECAR GRAMMAR (v38 draft; closes AUD C3-3). The `resolve-attempts`
sidecar is a fixed-width 16-byte record with ONE strict grammar:
`<count><single space><flag>` left-justified and NUL-padded to 16 bytes,
where `<count>` is 0–10 ASCII decimal digits (no sign, no leading `+`,
no empty field) and `<flag>` is exactly `-` or `X`. MISSING file =
(0, not exhausted). An EXISTING file whose bytes fail the strict grammar
for ANY reason — empty (torn creation), truncated, unparsable count,
negative count, unknown flag, wrong padding — is EXHAUSTED, fail closed:
a corrupt bound NEVER re-arms automatic resolve/repair rounds, and only
`operator_resolve_reset()` rewrites the record. ONE parser serves every
reader (status, the resolve loop, admission): two readers computing
exhaustion from the same bytes can never disagree. Fixtures F34/F35.

AUTH READER BOUNDS (v38 draft; closes AUD C3-4). The 64 KiB per-line AUTH
cap is a READ bound and MUST be enforced while streaming: the reader
consumes the AUTH file in bounded chunks and counts the CURRENT physical
line incrementally, refusing the whole file malformed the moment the
line length would exceed the cap — BEFORE parsing, retaining, or
buffering the remainder, so no legal or hostile AUTH file can make the
reader allocate unbounded memory. TOTAL INVENTORY BOUND (drafted owner
decision): at most `AUTH_INVENTORY_CAP = 1024` schema-valid AUTH lines
may exist in the file; the 1025th valid line makes the file malformed
(fail closed: ALL authorizations refused, operator action required —
AUTHs are single-use and short-lived, so a healthy fleet stays far below
the bound; a file that reaches it is evidence of an unspent-AUTH leak,
not legitimate load). Both bounds are resource guarantees of the same
class as the 64 MiB log cap. Fixtures F36/F37.

PROBE CONFORMANCE, PRE-WRITE (v38 draft; closes AUD C3-5, extends v37
owner decision 1A conformance + 0A probe). The probe's directory is
ESTABLISHED AND VALIDATED before any scratch write (leg 0): the path
must resolve (O_NOFOLLOW — never a symlink) to a real directory OWNED
by the protocol user with mode 0700; a newly created directory is
created 0700 AND explicitly chmodded to defeat the caller's umask. An
existing directory that fails ownership or mode REFUSES the probe
(`fs-probe-failed:dir-*`) leaving ZERO trace. Startup access-control
check is STRICT: every protocol file (ledger, AUTH, lock, both sidecars,
repair journal) must exist 0600 owned by the protocol user — ANY mode
bit outside 0600 (group/other READ included) is refused; the earlier
"operator read-bit policy" allowance is WITHDRAWN for consumption
evidence: the v37 conformance premise (0700 dir, 0600 files, protocol
user) admits no looser file policy. Fixture F38.

PROBE EXACT OUTCOMES (v38 draft; closes AUD C3-7, pins leg text as
written). Leg 3's "fresh open shows exactly the appended bytes" is
BYTE EQUALITY (a suffix match is not the spec: surplus visible bytes
mean the fs lied about the append). Leg 4 additionally verifies the
destination contains exactly the SOURCE's bytes after the rename-over
(a rename that preserves stale destination content fails the leg) and
the source name is gone. Adversarial seams pin both. Fixture F39.

DECISION-APPEND GATE (v38 draft; closes AUD C3-1 + C3-6; NO spec text
change needed \u2014 the code violated the already-normative RESOLVE-ON-USE
and EXCLUSION LOCK (ii) rules): every entry point of a DECISION APPEND
(APPLIED) resolves and gates on the IN-LOCK classification; the in-lock
helper performs its own resolve and REFUSES `lock-required-not-held`
when its instance holds no verifiable acquisition. Fixtures F40.
FAILED-CLEAN DURALITY (v38 draft; closes AUD C3-2; clarifies CRASH
TABLE (vi)): a clean-looking write error licenses the FAILED verdict
ONLY after the resolve sequence completes over the failed call (fsync
file + fsync dir + FULL read under the held lock); until then the
outcome is `outcome-unknown`, never a reported failure. The ONE fresh
(c-O) attempt is enforced PERSISTENTLY (crash-durable evidence, not
in-process memory): a second failed-clean episode on the same AUTH is
refused `repair-retry-exhausted` BEFORE any write. Fixture F41.

V38 CYCLE-4 DISPOSITIONS (owner-confirmed fixes + spec sharpening; closes
AUD C4 findings F1-F8; fixtures F42-F48). Where a finding showed the code
violating already-normative text it says so; where the draft was silent
the SHARPENED NORMATIVE TEXT is given here and is drafted (not ratified)
with the same status as the v38 drafts above.

  C4-F1 (BLOCKER, code): a caller's LOCK DECLARATION is never an
  acquisition. Sharpening of EXCLUSION LOCK (ii): the verifiable
  acquisition is per-instance and un-delegatable — no parameter, flag,
  or foreign-fd claim licenses an append; an instance that did not
  perform the flock acquisition itself refuses `lock-required-not-held`
  before any intent or ledger byte, even while the lock is genuinely
  held on another process's fd. Fixture F42 (positive case stays F40).

  C4-F3 (code): COUNTER GRAMMAR is FIXED WIDTH 16 bytes — a SHORT
  existing file (torn creation or truncated rewrite), including exact
  prefixes of valid records, is corruption (EXHAUSTED, fail closed),
  never a fresh counter. MISSING file remains (0, not exhausted).
  Fixture F43.

  C4-F2 (spec-gap, sharpened): FAILED-CLEAN DURALITY's crash-durable
  journal now has NORMATIVE FRAMING AND DURABILITY: one JSON object per
  line terminated by \n; appends use a checked write (short-write loop)
  + file fsync, + parent-dir fsync when the journal file is created;
  O_NOFOLLOW; reading is BOUNDED (size cap — an over-cap or unreadable
  journal fails CLOSED `journal-unreadable`). CONSERVATIVE RECOVERY
  (normative): records PAIR per authId (INTENT..OUTCOME); a torn line
  naming the AUTH counts as a consumed attempt (no keyword required)
  [SUPERSEDED by V38 CYCLE-5 D1-A/D2-A below: torn or damaged journal
  content now fails closed as `journal-unreadable` for every reader;
  there is no per-record pairing or quarantine];
  an UNTERMINATED trailing record naming the AUTH counts as consumed
  (intent-with-landed-no-outcome IS the crash-between-resolve-and-record
  window); a durable `repaired` outcome resets ONLY its own AUTH's
  count; records of other AUTHs never affect this AUTH's count. The
  current attempt's own INTENT is not a "prior" attempt (pair it out).
  Fixtures F45/F48.

  C4-F4 (spec-gap, sharpened): NO-FOLLOW POLICY (extends ACCESS
  CONTROLS): the protocol NEVER resolves a protocol path through a
  symlink — every open of a protocol file carries O_NOFOLLOW and the
  startup access-control check uses lstat and refuses a symlinked
  protocol path (`unsafe-path-permissions`) leaving the impostor
  untouched. FULL dirfd-anchoring of ledger operations is documented
  RESIDUAL RISK of the reference implementation (the window it closes
  requires attacker control of the 0700 dir, which the trust premise
  already admits). Fixture F47.

  C4-F5 (code-completion): the AUTH inventory bound is a BOUND ON BOTH
  SIDES — `authorize` refuses `auth-inventory-full` BEFORE any write
  when the file already holds AUTH_INVENTORY_CAP valid AUTHs (the
  writer must never itself create the terminal 1025th-line state).
  Sharpening of AUTH READER BOUNDS: the bound constrains producer and
  consumer. Fixture F44.

  C4-F6 (code, half-sentence sharpened): the RESOLVE BOUND principle —
  exhaustion stops the ledger from serving decisions — applies to the
  informational view too: `status` OVERLAYS `exhausted` on the decision
  field whenever the counter is exhausted, REGARDLESS of the pending
  marker (the binding path refuses on exhaustion unconditionally; no
  reader may show a decision state the binding path contradicts).
  Fixture F46.

  C4-F7 (code + residual-risk note): `_append_bytes` asserts the
  lock-acquisition ALWAYS (no mode, seam, or parameter skips it; a
  contention seam hands out a closed/never-locked fd, not an unheld-
  but-open one). NOTE (normative ceiling, do not re-file): POSIX flock
  offers no hold-verification API — re-locking after silent loss also
  succeeds — so fd-aliveness (fstat) plus same-instance acquisition is
  the strongest honestly-claimable check; continued-hold is protected
  only by the single-threaded same-process discipline.

  C4-F8 (code, probe): after validation the probe operates RELATIVE TO
  the validated directory fd (opens with dir_fd, renameat, fd-anchored
  census) — validated pathnames are never re-resolved for the leg
  writes. Residual-risk note (do not re-file): a pathname re-resolve
  between validation and leg write required attacker control of the
  parent directory; the anchor closes it at zero cost.

  Fixture adequacy: cycle-4 pins F42-F48 were written AFTER the fixes
  and each reverts-to-red on a one-fix mutant of its own fix (same
  method as the cycle-3 assessment).

V38 CYCLE-5 DISPOSITIONS (owner decisions D1-A/D2-A/D3-B/D4-B/D5-A;
closes the cycle-4 audit findings against the cycle-4 build; fixtures
F45(rewritten)/F49/F50/F51/F52. Same drafted status as the records above.)

  D1-A (owner decision, code+norm): FAILED-CLEAN ATTEMPT CAP is a
  TOTAL-ATTEMPT CAP — every crash-durable `REPAIR-INTENT` for an AUTH
  is ONE CONSUMED ATTEMPT, period: orphan intents (crash before the
  outcome landed) and paired intents each consume once. The COUNTED
  UNIT is the `REPAIR-INTENT` record; `REPAIR-OUTCOME` records are not
  counted independently (v38 cycle-6 audit: the earlier "outcome
  records all consume" wording was wrong).
  A resolved `outcome-unknown` grants NO free slot and an orphan is
  NOT reabsolved by ledger evidence (the old reader counted only
  outcome records, so a crash between INTENT and OUTCOME silently
  returned the slot). The ONLY reset is a VALID, DURABLE `repaired`
  outcome (`"durable": true`, exact grammar) for that AUTH — a
  `durable:false` "repaired" is grammatically valid and resets
  NOTHING (audit finding 2: the old code reset on ANY repaired
  outcome, re-arming the bound on a non-durable success).
  Fixture F45 (rewritten for the total cap).

  D2-A (owner decision, code+norm): JOURNAL GRAMMAR IS STRICT AND
  GLOBAL. Every terminated line of the repair journal must parse as a
  JSON OBJECT of a known kind (`REPAIR-INTENT` / `REPAIR-OUTCOME`)
  with an EXACT key set and valid field types. ANY damage — non-object
  JSON (bare `null`/string/array; the old reader CRASHED with
  AttributeError on `null`), schema violation, unknown kind or
  outcome, unterminated tail, over-cap, un-openable file (a DANGLING
  SYMLINK counts as damage, never as "absent"), open failure other
  than ENOENT — fails CLOSED as `journal-unreadable` for EVERY reader
  of the ledger, not just the counting reader: a ledger with a damaged
  journal serves NO decisions. ENOENT ALONE means the empty journal.
  Keyword heuristics ("does the torn line mention the auth?") are
  WITHDRAWN — total-cap semantics make them unnecessary and a
  heuristic reader is a forgiveness vector. Opens are O_NOFOLLOW.
  Fixture F49.

  D3-B (owner decision, code): the probe's fd-anchored census is
  `os.scandir(dir_fd)` — NO process-wide CWD side effect. The
  cycle-4 census swapped the process CWD (fchdir) and restored it,
  which is unsafe in a multi-threaded host (another thread's relative
  I/O races the window; restore-by-name fails after a rename-out).
  Sharpening of the C4-F8 residual-risk discipline: the anchor must
  not itself introduce process-global state. The F52 pin verifies
  getcwd byte-equality AND statically pins the SOURCE (no chdir of
  any form; census is `os.scandir(dir_fd)`) — a serial test cannot
  observe an fchdir+restore round-trip, so the mutation-caught
  requirement is met at source level (see evidence table).

  D4-B (owner decision, code; v38 CYCLE-6 AUDIT CORRECTION): LOCK
  IDENTITY, not lock ownership. The check below detects a stored fd
  that now refers to a DIFFERENT inode. It does NOT prove the fd still
  holds the flock: a same-inode reopen can reuse the fd number without
  holding a lock, and a replaced lock PATHNAME is not detected while
  the original fd stays open. The earlier claim that the check "rules
  out fd-close-and-reuse" was too broad. Whether stronger ownership
  detection is required is OPEN (spec question S-L1 below).
  Acquisition records the lock file's (st_dev, st_ino) via fstat;
  `_lock_held()` re-verifies the CURRENT fstat of the held fd against
  that identity. A held fd whose file was replaced (unlink + recreate
  reusing the fd number after close, or an impostor file under the
  same name) fails `_lock_held()` — silent loss of the acquisition
  now downgrades to "not held", refusing appends
  (`lock-required-not-held`) instead of writing under a stale claim.
  This narrows (does not abolish) the C4-F7 note: POSIX still offers
  no hold-verification API; identity re-verification catches
  REPLACE-style loss, not kernel-side lock revocation.
  Fixture F51 (same fd number, different file ⇒ not held).

  D5-A (always-fix, code): `settle_in_lock()` REQUIRES THIS
  INSTANCE'S VERIFIABLE ACQUISITION (C4-F1 discipline applied to the
  one entry point that lacked it): a fresh instance pointing at a
  genuinely locked directory refuses `lock-required-not-held` with
  ZERO journal bytes written; settlement runs only under the lock
  this instance acquired. Fixture F50.

  Evidence (mutation adequacy — each pin reverts-to-red on a
  one-fix mutant of its own fix; all mutants restored, suite green
  after each):
    M1 settle-precondition removed          -> F50 RED (LedgerError not raised)
    M2 reset on non-durable repaired        -> F49 RED (AssertionError: 1 != 2)
    M3 unknown journal kind skipped         -> F49 RED (journal-unreadable expected)
    M4 non-object record skipped            -> F49 RED
    M5 probe census back to fchdir+restore  -> F52 RED via STATIC source pin
         (behavioral getcwd check alone MISSES the round-trip — the
         static pin is required; documented so it is never "simplified" away)
    M6 lock identity check removed          -> F51 RED (True is not false)
    M7 REPAIR-INTENT no longer consumes     -> F45 RED
  Suite: 52/52 OK under `python3 -W error::ResourceWarning` (twice);
  ResourceWarnings in the test module eliminated (all raw open()
  reads wrapped).

V38 CYCLE-6 SPEC SHARPENINGS (code-audit GPT Terra cycles 1-4; each is
drafted, not ratified — the owner decides, as with cycle 5). Code-only
findings are NOT listed here; they are fixed in code with pins.

  S-L1 (C6, lock trust boundary; from the cycle-6 review). The D4-B
       identity check proves only "not a different inode". Owner
       decision required: accept the narrowed claim (fd reuse on the
       same inode and lock-pathname replacement are residual risk under
       the 0700 single-writer premise), or require a stronger ownership
       design. Until ruled, the code claims only the narrowed scope.

  S-J2 (C6, journal capacity). The writer now refuses (`journal-full`,
       zero bytes) any append that would exceed JOURNAL_CAP, and an
       intent reserves room for its worst-case outcome (12-digit
       timestamp, enforced range 0 <= at < 10**12). OPEN: what operator
       recovery is authorized when the journal fills (archive/rotate
       under the lock, or a new ledger epoch)? Until ruled, a full
       journal blocks further repairs and decisions fail closed.

  S-A1 (C6, partial AUTH line). A short AUTH write now raises instead
       of returning an id (code fix, pinned). The protocol forbids
       truncation (F10), so the partial line may remain and the AUTH
       file is then classified malformed. OPEN: the operator recovery
       path for a partial AUTH line (rewrite via the operator-reset
       channel, or a fresh AUTH file with the old one quarantined).

  S-J1 (C6, duplicate member names; RATIFIED-IN-CODE pending owner
       ack). D2-A now states: a duplicate member name in any journal
       object is damage (`journal-unreadable`); the decoder rejects it
       rather than applying last-value-wins. Pinned by C6_20.

  S-P1 (C6, probe scope). Leg 2 now requires a competing descriptor to
       fail a nonblocking exclusive acquire, accepting ONLY EAGAIN/
       EWOULDBLOCK as contention. The startup probe proves exclusion
       once at startup; it does not prove future lock behavior or crash
       durability (stated limit, unchanged).

V39 CONTRACT-PROSE AUDIT — ROUND 1 (full-severity document-level
adversarial audit of the v37+ build, gpt-6.1-terra, read-only; drafted
PENDING owner ratification — same discipline as the v37/v38 records;
the auditor disclosed its tooling could not execute shell/git checks,
so every finding below was re-verified by the editor against the
cited text before acceptance):
| ID | Severity | Finding | Disposition |
|---|---|---|---|
| AUDV1-M1 | major | a DEAD REPAIR could classify VALID on a later read (late AUTH arrival / confirmation-log growth) while the text promised it "stays dead" — validity is recomputed per read and no tombstone can exist on an append-only log | ACCEPTED: LATE VALIDATION IS EXPLICIT MEANING (rule (3)): contribution requires the precondition to arrive as a genuine AUTHORIZATION; SPENT then forbids any second spend; no operator command edits classification (true as before); fixtures F23/F24 pin both activation paths and the ≠-occurrences non-activation |
| AUDV1-M2 | major | torn-tail recovery had two live, incompatible prescriptions: (b) append-only + settlement vs the (δ) crash case and fixture (e-8) ordering non-forced `--repair-consumptions` TRUNCATION | ACCEPTED: every truncation instruction REVOKED in place — (δ) case, fixture (e-8), the 4b-passage sentence, and the theorem's "repair truncation" residue — recovery is settlement + AUTH/REPAIR; historical rows stay marked. OUTCOME CLAIM CORRECTED (v39, R2-B1): this row's original "the AUD29-M4 outcome (original confirmation ACTIVE, no new confirmation) preserved" was WRONG — the mandatory ALL watermark consumes the pre-repair confirmation, so δ ends exactly like β: INERT, ONE NEW confirmation (or ESRCH) required; see the (δ) OUTCOME-CORRECTED paragraph and (e-8). Residual survivor instructions (header M1 summary, P13 (iii)/(d)) marked superseded per R2-M2 |
| AUDV1-M3 | major | "every append is ONE write / a single reserved write" contradicted the REQUIRED short-write loop at (c-O)(v): crash-between-syscalls semantics and reservation accounting were undefined | ACCEPTED: FRAMING rewritten to ONE LOGICAL APPEND executed as a checked write loop under one lock acquisition; cap-invariant restated on reservations not syscalls; the lock clause, reserve-on-append, settlement, and the two operative step-(2)/ALL-append sites conformed (v39 R2-M3: the reserve clause and the confirmation-repair/pass watermark sites still read "one write" — now rewritten to "one logical append via the checked write loop"; remaining hits are historical rows or refer to single-WRITER, not single-syscall); fixture F25 pins short-write + crash-mid-loop with the R2-M4 prefix enumeration |
| AUDV1-m1 | minor | the published-variant case said our writer body "was published at step 4 (before the swap was observed)" while the state machine publishes at step 2 and the pinned detection point precedes any step-2 publication | ACCEPTED: case (2) rewritten — step number corrected, no body of ours exists at the detection point, foreign-body removal forbidden, regained branch re-scoped to a completed guarded step-2 replace |

NOTE: this round audited the DOCUMENT (prose consistency, internal
contradiction, residue) — not the reference build (the reference suite
remains 79 passing; F23/F24/F25 are NEW release-bar fixtures to be
implemented with the next code cycle, F10's grep now also covering the
revoked truncation instructions).

V39 CONTRACT-PROSE AUDIT — ROUND 2 (cycle-2 full-document adversarial
audit of the v39 fold, read-only; all findings re-verified by the
editor against the cited text before acceptance; drafted PENDING
owner ratification):
| ID | Severity | Finding | Disposition |
|---|---|---|---|
| R2-B1 | blocker | δ partial-tail recovery and fixture e-8 required mutually exclusive outcomes: the REPAIR's mandatory ALL watermark (L_C read AFTER settlement) consumes the ORIGINAL pre-repair confirmation (offset < L_C), yet both texts said it ends ACTIVE with no new confirmation | ACCEPTED: (δ) OUTCOME-CORRECTED paragraph rewritten — after settlement + AUTH + REPAIR the original confirmation is INERT and ONE NEW confirmation (or ESRCH) is required (same end-state as β; only the recovery means differ); (e-8) rewritten to match; the AUDV1-M2 disposition's "outcome preserved" claim corrected in place; (δ2) note pins the surviving-journal semantics |
| R2-B2 | blocker | F24 and the late-validation rule referenced "the SAME GENERATION the AUTH bound" but the AUTH schema carries no generation field and no comparison was defined | ACCEPTED: rule (3) gains an explicit generation clause — the binding is the REPAIR record's own `all.confirmGen` (written at (c-O) step (i)), compared on every read against the confirmation log's CURRENT generation header; a confirmation-repair publishing a new generation leaves old-generation REPAIRs permanently DEAD; late-validation text and F24 rewritten to the same binding; no AUTH field added (none needed) |
| R2-M1 | major | late-AUTH activation implied a workflow to create/reserve a future authId, contradicting fresh-ULID authorization and the "no operator command may make one contribute" claim | ACCEPTED: PRECISION paragraph added to rule (3) — a conforming producer can never leave a REPAIR without its AUTH, so a matching late AUTH is only reachable via injection/non-conformance; F23 relabeled INJECTED/CORRUPTION-ONLY (pins the classification rule, not a workflow) |
| R2-M2 | major | revoked truncation/replacement instructions survived in the release bar (header M1 summary, P13 (iii), fixture (d)/(e) replacement wording) while AUDV1-M2 claimed every live site revoked | ACCEPTED: local [V39 SUPERSEDED] markers inserted at each surviving site (header M1, P13 (iii), (d), the operative repair-paragraph frame) restating the live settlement+overlay behavior; AUDV1-M2 disposition corrected from "every live truncation instruction REVOKED" to enumerate the residual sites now marked |
| R2-M3 | major | an operative "single write" rule survived (reserve-on-append clause; the two step-(2)/ALL-append "one write + fsync + close" sites) after the one-logical-append reframing | ACCEPTED: all three operative sites rewritten to "one logical append via the checked write loop of (b-O) FRAMING"; AUDV1-M3 disposition amended; remaining grep hits verified historical rows or single-WRITER (not single-syscall) usages |
| R2-M4 | major | F25 asserted crash-mid-loop ⇒ unsettled-tail unconditionally, but a first short write of only the leading `\n` (whitespace-only prefix) is ignored and leaves no tail | ACCEPTED: F25 rewritten with the three-case CRASH-PREFIX ENUMERATION ((a) zero bytes = absent append; (b) whitespace-only prefix = ignored, treated absent; (c) nonblank unterminated prefix = unsettled-tail + settlement) and the 3-byte injection made explicitly nonblank; all three boundaries pinned as separate fixture drives |
| R2-M5 | major | F13 expected `unmasked-malformed` from a REPAIR whose only mask entry names a valid watermark — no occurrence exists in that setup, so the read is `ok` | ACCEPTED: F13 setup extended with one terminated malformed line M the mask list does not name; expected state now follows; the v37 "every occurrence it would have masked stays UNMASKED" phrasing corrected in the row |
| R2-M6 | major | resolve-bound text and F20 claimed a successor "re-derives `durability-pending` from disk", but a past fsync RETURN is a process-local event no byte pattern can encode | ACCEPTED: rule rewritten as CONSERVATIVE-DEFAULT-DENY — pending persists until the successor's OWN resolve sequence succeeds under the lock (no history reconstruction claimed); F20 reworded to match |
| R2-M7 | major | the swap-abort cleanup's regained-branch sentence left undefined whether an abort continues into step-2 body publication, and identified "OURS" by token alone | ACCEPTED: SEQUENCING PINNED paragraph — an abort never publishes on its own; publication requires the regained branch re-running the full step-2 sequence; body removal is gated on THIS invocation's own step-2 replace success (invocation-specific evidence), pre-existing same-token bodies are foreign-by-rule; swap-back and pre-existing-body fixtures added |
| R2-m1 | minor | header said "DRAFT v37" while the footer records v39; the intro said owner decisions 1A/2A/3A were "applied" while the owner record says they await confirmation | ACCEPTED: header relabeled DRAFT v39 (with correction note); the v37 revision note rewritten to distinguish 0A CONFIRMED from 1A/2A/3A DRAFTED-awaiting-confirmation, matching the V37 OWNER DECISION RECORD |
| R2-m2 | minor | historical rows C14-M4 ("never unsoundly deletes") and C15-M3 ("published at step 4") carried contradicted claims without local supersession markers | ACCEPTED: [V39 LOCAL SUPERSESSION] annotations added inside both rows citing the live snapshot-loss analysis (C15-M1 / v16-merge section) and the v39 step-2 correction respectively |

Fixture coverage (R2): F13, F20, F23, F24, F25 amended above; F10's
revocation grep now also covers the header M1 summary and P13 (iii).
ROUND 2 audited the DOCUMENT only — the reference build (79 passing)
is unchanged; F23/F24/F25 remain release-bar fixtures for the next
code cycle. Decision 4 (prose audit vs reference implementation vs
both) remains OPEN with the owner.

---

## ROUND 3 (R3) ADVERSARIAL AUDIT — combined contract+code round, dispositions (v40)

Findings are labeled R3-c<k>-<n> (audit cycle k of this round). Every
finding was independently re-verified against the cited line before
acceptance; dispositions below.

| ID | Sev | Finding (verified) | Disposition |
|---|---|---|---|
| R3-c1-1 | major | Fixture F7's contrast arm ("with G2 instead of G1 ⇒ repair-conflict") became VACUOUS once R2-B2 bound REPAIR validity to the CURRENT confirmation generation: a REPAIR carrying G2 while the header is G1 is DEAD, never a conflict party | ACCEPTED: F7 row annotated [V40 LOCAL SUPERSESSION (R3-c1)] marking the arm vacuous-by-rule; the defensive conflict branch's unreachability pinned in test_F7b (equal-generation conflicts only) |
| R3-c1-2 | major | CODE: the R2-B2 generation clause had no pin in the reference build (F24 text landed in the doc; nothing in test_ledger exercised generation death of a valid REPAIR) | ACCEPTED: test_F24gen added — generation-match keeps the REPAIR live (spent, mask active); a new confirmation-log header generation makes it DEAD (mask-mismatch, nothing spent, promotion refused) |
| R3-c2-1 | major | δ2 note claimed the ALL watermark consumed records below L_C "permanently" and the SPENT predicate forbids reuse — but under generation binding, publishing a NEW confirmation generation makes the REPAIR DEAD: masks and spend contribution CEASE, formerly-masked records reappear, a fresh REPAIR under the same authId becomes valid in the new generation | ACCEPTED: δ2 rewritten with the generation-conditional scope [V40 LOCAL CORRECTION (R3-c2)]: inert + SPENT while the generation remains G_C and validity holds; generation republish ⇒ DEAD, spend ceases, new-generation REPAIR valid (pinned test_F24gen); the δ recovery OUTCOME at its moment is unchanged |
| R3-c2-2 | major | CODE: both settlement paths (`settle()`, `settle_in_lock()`) issued the framing-newline `os.write` unchecked — a zero return proceeded through fsync and was reported as a durable settlement, contrary to the checked-write rule that every other append path enforces | ACCEPTED: both sites now require a 1-byte return; zero progress raises (EIO) and leaves the intent window durability-pending with ZERO bytes landed; new fault seam `settle_write_zero`; pins test_F18z (public settle: no false durable settlement, tail still unsettled, promotion refused, recovery by re-settle) and test_F18z2 (in-lock settle writes nothing); mutation-verified (guard removed ⇒ both pins fail) |
| R3-c2-3 | major | The framing clause still asserted unconditionally "a crash mid-loop leaves an unterminated tail ⇒ unsettled-tail" after R2-M4 established (F25) that a blank/whitespace-only prefix classifies ABSENT | ACCEPTED: clause rewritten to the F25 three-case enumeration — no bytes / blank-only prefix ⇒ absent under framing; nonblank unterminated tail ⇒ unsettled-tail + SETTLEMENT [V40 LOCAL CORRECTION (R3-c2)] |


| R3-c3-1 | major | CODE: `authorize()` accepted a caller-supplied `auth_id` and wrote it unchecked — the freshness rule the doc leans on (F23: only injection could match a DEAD REPAIR's authId) was NOT enforced; a caller could authorize to a DEAD REPAIR's id and activate it, or duplicate AUTH ids (ledger.py:1254/1308 at audit) | ACCEPTED (v40): production path MINTS a fresh ULID and refuses a caller-chosen id (`auth-id-caller-chosen-forbidden`); caller-chosen ids exist only behind an explicit `test_only=True` seam, refused on collision with the AUTH file (`auth-id-exists`) or with ANY terminated schema-valid log record naming the id (`auth-id-already-used`, closing DEAD-REPAIR activation and APPLIED-id duplication); zero bytes on every refusal; pin test_F53 (mutation-verified) |
| R3-c3-2 | major | CODE: contract stage 1 says an UNREADABLE consumption log classifies `unknown`, but `_read_bytes()` handled only ENOENT — other open/read errors escaped `classify()`/`status()`/`promote()` as raw OSError instead of the fail-closed classification | ACCEPTED (v40): classify converts open/read OSError to `unknown` (ENOENT-as-empty preserved); fault seams `open_raises`/`read_raises` pin classify ⇒ unknown, status ⇒ unknown, `promote()` refuses WITHOUT executing its callback, `promotion_allowed()` False, recovery on healthy reads — pin test_F54 (mutation-verified) |
| R3-c4-1 | major | INLINE AUDIT F-A1, CODE: the R3-c3-1 fix checked id collisions only on the CALLER-supplied (test-only) path; the production MINT path wrote `_mint_ulid()` unchecked — forcing the generator to repeat an id produced TWO AUTH lines with the same id (reproduced empirically), and a forced collision with a DEAD REPAIR's log-named id could activate it — freshness still not enforced where production actually writes | ACCEPTED (v40): under the same lock, the minted candidate is checked against the AUTH inventory AND every log-named id; bounded 64 retries; persistent collision refuses `auth-id-mint-collision` FAIL-CLOSED with zero bytes; pins test_F55 (forced AUTH-collision, forced log-named collision, transient-collision retry succeeds; mutation-verified) |
| R3-c4-2 | major | INLINE AUDIT F-A2, CODE+SPEC-ADJACENT: `_mint_ulid()` emitted 26 RANDOM Crockford chars — not a ULID (no 48-bit timestamp prefix; values could exceed 2^128). The doc's "mints a FRESH ULID" was therefore false as written. Whether the contract REQUIRES strict ULID conformance (vs "fresh random 128-bit id") is a spec question; the code now conforms, so the doc statement is true under either reading — no owner decision needed unless the owner prefers the weaker contract | ACCEPTED (v40): `_mint_ulid` builds the conforming 48-bit-epoch-ms ‖ 80-bit-random value encoded per the ULID spec (`secrets` CSPRNG); pin test_F56 (alphabet, length, <2^128, timestamp-prefix range, uniqueness, lexicographic==temporal; mutation-verified against the old generator) |
| R3-c4-3 | minor | INLINE AUDIT F-A3, TEST: test_F53 case (2) proved only truthiness of the production-minted id — it did not establish the freshness claim it cites (the F-A1 gap survived it) | ACCEPTED: freshness-on-mint now pinned independently by test_F55; F53 remains the seam/collision-code pin |
| R3-c4-4 | minor | INLINE AUDIT F-A4, DOC: coverage claims overstated the record — the cycle-3 auditor's verdict was **INCOMPLETE** (truncated reads; open items re-encountered but NOT independently verified), the footer implied verified confirmation; and "84 passing entering R3-c3" conflated entering (82) with post-fold (84) | ACCEPTED: coverage note rewritten (this paragraph is part of the fix); 21a ROUND R3 status corrected to the same wording |
| R4-c1-1 | major | TEST: fixture F19's cap-crossing checks ran SEQUENTIALLY and its "contention" loser only timed out against a passive flock holder — neither exercised the contract row's two-process concurrent crossing (re-verified against the old test text before accepting) | ACCEPTED (v41): F19 rewritten — two forked processes, "ready" acks after each startup probe (construction sequenced), simultaneous start-pistol release; (a) crossing pair at the cap ⇒ both `log-cap-exceeded`, zero bytes; (b) non-crossing pair ⇒ admitted offsets exactly {cap−24, cap−20} — serialization evidence the loser's reserve check saw the winner's bytes; (c) bounded-attempts child refuses `ledger-lock-held` (holder on the correct `consumptions.jsonl.lock`). Ran 8×: deterministic |
| R4-c1-2 | major | TEST: fixture F3 appended the confirmation AFTER `repair()` returned — never inside the L_C-read→append window the contract's F3 row prescribes (re-verified: old test body had no window insertion) | ACCEPTED (v41): in-repair test seam `_test_hook_after_lc_read` (fires after the L_C read, before any ledger byte; production passes none) lands the confirmation mid-window; REPAIR now asserted to carry the L_C **read** (200), not the grown length — the race is tested, and a watermark-staleness regression would fail the pin |
| R4-c2-1 | major | CODE: `repair()` journaled the REPAIR-INTENT before the log-cap reservation check inside `_append_bytes`, so a pre-write `log-cap-exceeded` refusal landed an intent — under D1-A (attempt = landed intent) two zero-byte refusals exhausted the AUTH's allowance with no ledger byte ever attempted on disk | ACCEPTED (v41): capacity preflight (honoring the fault `size_override`) runs UNDER THE LOCK before `_log_repair_intent`; refusal writes NOTHING anywhere and consumes no attempt; pin test_F57 (3 refusals ⇒ no intent in the journal, zero ledger bytes, same AUTH repairs after capacity restores; mutation-verified by removing the preflight) |
| R4-c2-2 | minor | TEST: F3's `confirmation_clears(210)` alone would pass a threshold wrongly shifted to the confirmation's interior (e.g. a REPAIR watermarking 210 and suppressing inside its own generation) | ACCEPTED (v41): F3 additionally asserts the confirmation's START offset 200 is ACTIVE (and 199 stays inert under gen0's ALL) — a threshold inside the landed region fails the pin (mutation-verified alongside the watermark-staleness mutation) |
| R4-c3 | — | (HISTORICAL, as of R4) CYCLE 3 VERDICT: **INCOMPLETE.** The auditor reported truncated contract/code reads and its sandbox refused the /tmp copy (the maintainer verified the suite in its WORKING TREE — the files are untracked — `cd reference && python3 -W error::ResourceWarning -m unittest p9m3.test_ledger` → 87 OK). No findings were FILED, but the auditor stated its finding counts are UNDETERMINED, not zero: the cycle did not establish the absence of findings. The open owner items it listed (Decision 4, R-1, D-1) match 21a verbatim. Per its own instruction this is NOT a clean audit: c1/c2 found no SPEC gap, but whether R4 as a round has none is NOT established — the full contract prose sweep and independent re-verification of the mutation claims remain OPEN and are disclosed rather than laundered |

ROUND 3 coverage note: the auditor ran read-only (sandbox refused
/tmp; no suite run in its session). The maintainer ran the full suite
before and after each fix: **80 passing** entering R3 (79 through the
v38 round + F24gen + F7b); **82** after the cycle-2 fold (+F18z,
+F18z2); **84** after the cycle-3 fold (+F53, +F54) [v40 correction:
this note previously stated "84 entering R3-c3", conflating the
entering count (82) with the post-fold count (84)].
A SUBSEQUENT INLINE AUDIT of the R3 changes (model: gpt-6.1-terra,
reviewer mode) then found R3-c3 cycle 3 itself had reported **verdict
INCOMPLETE** (truncated contract/owner-ledger reads; open-item
dispositions NOT independently verified) — this footer's earlier
claim that the auditor "confirmed none were settled" overstated the
record and is corrected here: the SPEC items below were merely
re-encountered, not re-verified. The inline audit's findings and
their fixes (mint-path collision check, conforming ULID — pins
test_F55/test_F56) are folded below as R3-c4 (suite: 86 passing), and the
INLINE-AUDIT ROUND R4 (3 cycles, gpt-6.1-terra) folds R4-c1-1/2 (F19/F3
fixture rewrites) and R4-c2-1/2 (cap-preflight before intent, F3
start-offset assertion; pin F57) — suite: **87 passing**.
Re-encountered open SPEC items from the owner ledger (21a): S-L1,
S-J2, S-A1, S-P1, S-J3, R-1 — unchanged, still awaiting owner
decisions. Decision 4 (prose vs reference vs both) remains OPEN; R3
treated the combined state as in scope.

---

## INLINE-AUDIT ROUND R5 (5 cycles, gpt-6.1-terra) — dispositions (v42)

Target: the v42 state — the R4 fixture rewrites (F19 forced-order,
F3 in-window seam, cap preflight) and the folded header claims.
Every finding carried a mandatory CODE|TEST|DOC|SPEC class; every
one landed CODE/TEST/DOC — the SPEC pool for this round is EMPTY,
so no owner batch fix is required. Findings are R5-c<k>-<n>.

| ID | Class·Sev | Finding (verified against the cited line) | Disposition |
|---|---|---|---|
| R5-c1-1 | TEST major | F19's forced-order case trusted a 0.15 s sleep that the rival had reached the lock — never proven | ACCEPTED: new test-only seam `_test_hook_lock_miss` (ledger.py `_acquire`, fires on every flock MISS incl. the last attempt, after the missed fd is closed — no fd leak, no lock held; inert in production); the fixture's second child signals its OWN first miss and the parent FAILS if no miss is ever observed. Mutation-verified RED: `LOCK_EX`→`LOCK_SH` trips the guard (c2/c3/c5 independently re-ran it RED) |
| R5-c1-2 | TEST major | (b2) geometry (three refuse pairs) could not kill a `max(0, size - 1)` predicate | ACCEPTED: exact-one-byte-overflow pairs added; later subsumed by the closed per-frame-length boundary geometry (R5-c4-1) |
| R5-c1-3 | TEST major | cap refusals never pinned the pending sidecar | ACCEPTED: every refusal case now asserts `_read_pending()` unchanged + `durability_pending()` False; fresh dirs assert NO sidecar. Claim stated as observed state, not event history (R5-c4-2) |
| R5-c1-4 | DOC minor | header claimed forcing/proving more than the fixture established | ACCEPTED: header rewritten each round; final phrasing = bounded evidence (see R5-c4-2) |
| R5-c1-5 | DOC minor | module scope lines stale (F1–F27 / F1–F33) | ACCEPTED: both headers read F1–F57 with the per-generation inventory |
| R5-c2-1 | TEST major | a `max(0, size - 1)` predicate still passed (stale-by-one overrun) | ACCEPTED: R==F-1 exact pairs; RED-mutation confirmed by c2's own copy AFTER the fix (the auditor ran it green-before/RED-after in its sandbox copy) |
| R5-c2-2 | DOC minor | header's "proves observed" unqualified | ACCEPTED: qualified, then superseded by c4-2's bounded-evidence phrasing |
| R5-c3-1 | TEST major | reported (size, framed) could be a guess — verdict-matching mutants with wrong operands stayed green | ACCEPTED: four-tuple refusal results carry the predicate's OWN detail; ledger.py raised the detail from the SAME locals the comparison consumed (comment pins it — divergence impossible by construction); RED-mutation: compare-guess-report-real now FAILS |
| R5-c3-2 | DOC minor | header proof claim too broad given c3-1 | ACCEPTED: qualified as above |
| R5-c4-1 | TEST major | selected geometries could not exclude a predicate comparing stale/guessed sizes while reporting the true ones | ACCEPTED: (b2) rebuilt as a CLOSED per-frame-length boundary geometry — 56 pairs; trail lengths {4,8,9,10,11,12,13,14,15,16,17,20,21,32} × {R==F fit, R==F-1 refuse} × both lead roles; lead lengths max(24−F+d, 8) all lie IN the set; case (a)'s 32 B and case (b)'s 12 B frames are members. RED mutations re-run: ±1 constant deltas and the guessed-operand mutant all FAIL |
| R5-c4-2 | DOC minor | "prove observed" + "UNTOUCHED" exceed what matching final state shows (a byte-identical re-write is indistinguishable) | ACCEPTED: header and fixture docstrings now state BOUNDED evidence for the listed sizes/roles/orders and observed STATE, not event history |
| R5-c5-1 | DOC minor | the "EVERY framed length" claim was open — F19 also appended 4- and 12-byte frames never tested as boundary trails | ACCEPTED: FRAMES closed to the 14-length set above (4 and 12 included; leads ⊆ set — closure verified programmatically), pair count corrected 16→56 in the header, test docstring cites the closure |

Round totals: 12 findings — CODE 0, SPEC 0, TEST 8, DOC 4 (minor
docs corrections counted with TEST per the round's tally style:
CODE 0 / SPEC 0 / DOC+TEST 12 across five cycles: 5+2+2+2+1).
No contract invariant, bound, or error semantic was changed by any
R5 fix: all changes are test fixtures, test-only seams, comments,
and doc prose. Suite after the final fold: **87 passing**
(`cd reference && python3 -W error::ResourceWarning -m unittest
p9m3.test_ledger`), determinism re-checked by repeating F19.

R5 coverage & honesty note: c1–c5 auditors ran read-only against
the working tree; c2–c5 each ran the copied suite in their
permitted `~/.tre/audits/x2` sandbox (87 OK) and re-ran the named
mutations there; c1's sandbox refused the copy (its suite claims
were maintainer-verified only). No cycle reported verdict
INCOMPLETE; c5 reported the smallest finding set (1 DOC minor).
Whether R5 as a round established the ABSENCE of SPEC gaps: the
round found none, but a bounded adversarial round cannot prove
none exist — the standing open owner items (S-L1, S-J2, S-A1,
S-J1, S-P1, S-J3, R-1, D-1, Decision 4) are unaffected and remain
OPEN in 21a.

---

## OWNER DECISION RECORD — replies received (dates UNVERIFIED)

The owner replied in shorthand. The agent's earlier version of this
record invented a date (2026-07-30) and expanded the replies beyond
what the owner said. This record keeps ONLY the owner's words and
marks the agent's interpretations explicitly.

Owner replies (verbatim shorthand):
- S-L1: "a with b as a debt item works"
  → interpreted: A (accept narrowed claim); B recorded as debt.
- S-J2: "a works"
  → interpreted: A (rotate under exclusion lock). PROCEDURE NOT
    SPECIFIED: the counter/attempt-cap preservation across rotation
    is an OPEN sub-spec (see Open items).
- S-A1: "b"
  → interpreted: B (fresh AUTH file, old renamed). Note: the 1A
    sidecar rename-never-delete rule is NOT the same rule; S-A1 has
    no separate ratified precedent.
- S-J1: "ack"   → S-J1 acknowledged.
- S-P1: "ack"   → S-P1 acknowledged.
- S-J3: "accept the rec c" (an earlier "b" reply is UNVERIFIED and
  not in the supplied record). Owner SELECTED option C, which the
  ledger defined as a MONOTONIC COUNTER. The agent implemented a CLAMPED
  wall-clock label instead (provisional). Owner to confirm: clamp, or
  implement the counter. Agent's earlier recommendation of B was WRONG
  (it did not guarantee the reserve); see Open items.
- R-1: "a"     → interpreted: A (retain until operator archive).
- D-1: "ok"    → closed via S-J1 ack.
- Decision 4: "c" → interpreted: C (prose audit + reference impl,
  code first). The prose audit has NOT been run.

Open items — NOT decided, NOT closed:
[STATUS 2026-11-16: partially SUPERSEDED by the second/fourth
tranches below — 1A/2A CONFIRMED (second tranche); 3A still open
(deferred to last; crosswalk format accepted, fourth tranche);
S-J2 rotation CLOSED (second tranche, S-J2 FINAL in docs/21a);
S-J3 CLOSED (clamp, second tranche). Still open per this list:
Decision 4 prose round (scoped A, fourth tranche; not yet run);
3A final reading.]
- 1A / 2A / 3A (drafted in the v37 record, line ~6587) still await
  explicit owner confirmation. They were drafted "per the agent's
  recommendation and await the owner's explicit confirmation".
- S-J2 rotation sub-spec: how the attempt counter (`_clean_failure_count`
  derives from journal history) is preserved across rotation. A fresh
  file with no carry-over would silently rearm repair attempts.
- Decision 4 prose round: not yet run.
- Owner's date of the replies: unknown/unverified.
- S-J3 option C: clamp (implemented) vs monotonic counter (as written).


OWNER DECISION RECORD — SECOND TRANCHE (replies received 2026-11-14,
same session; verbatim owner words, expansions marked as interpretation):

- S-J3 (clamp vs monotonic counter): "ok. clamp for s-j3".
  → FINAL: the clamp [0, AT_MAX] is the accepted implementation of
    option C. Closing terms (agent draft, ratified by the owner's
    "ok"): (1) `at` is a DIAGNOSTIC LABEL ONLY — no ordering,
    counting, or inertness decision may consume it; the sequence
    authority is journal APPEND ORDER under the exclusion lock,
    observable as byte offsets. (2) Lossy saturation of out-of-domain
    clocks is accepted behavior (pins F58/F59/C6_19/C6_21 stand).
    (3) Option C is satisfied IN SUBSTANCE — ordering does not depend
    on wall-clock — via file order rather than a counter field; a
    counter label scheme remains a future option as its own audited
    workstream only if a real consumer with real requirements appears.
- S-J2 (rotation sub-spec): "sidecar s-j2" → approve the drafted
  rotation design: per-authId carry-over folded into the journal as
  ROTATE-SNAPSHOT records (the journal stays the single enforcement
  record — see the S-J2 FINAL sub-spec), plus an in-flight marker
  sidecar with strict grammar (missing = none, corrupt = refuse).
  Archive mode 0400 accepted. Rotation algorithm, marker grammar,
  crash matrix: see the S-J2 FINAL entry in docs/21a.
- S-A1 (atomicity sub-spec): "fail-closed retryable s-a1" → approve
  the drafted invariant: NO step of torn-AUTH recovery is required
  to be atomic; EVERY interruption point must land in an observable,
  fail-closed, retryable state. Three-state contract (torn-present /
  quarantined-only / quarantined+fresh) + in-flight marker: see the
  S-A1 FINAL entry in docs/21a.
- Decision 4 (prose round): "decision 4 go with the recs" → the
  sequence: (a) fold ratified answers + the S-J3-C round record into
  docs/21 + docs/21a; (b) commit; (c) bounded prose audit round
  (5 cycles max; the reference implementation is the authority for
  behavior, prose is the authority for intent; findings classified
  CODE/TEST/DOC vs SPEC as before).
- 1A: "confirm 1a" → flock sidecar DRAFTED TERMS CONFIRMED.
- 2A: "confirm 2a" → bounded resolve rounds DRAFTED TERMS CONFIRMED.
- 3A: "review 3a after everything" → EXPLICITLY DEFERRED by the
  owner to last, after all of the above lands. NOT confirmed, not
  corrected — a final owner review item with a fresh brief.

OWNER DECISION RECORD — THIRD TRANCHE (replies received 2026-11-16,
same session; verbatim owner words, expansions marked as
interpretation):

- D5 (fleet file-state semantics): "option 3 for robustness"
  → interpreted: sign the v3 strict fail-closed posture AS THE
    DEFAULT, amended by drafted Option 3 — a scope-bound,
    non-automatic operator-acknowledgment waiver over PER-EPISODE
    indeterminacy only. Binding skeleton folded to §2.2 (v43);
    T1 (policy broken/stale) and root-enumeration failure stay
    unconditional; acks exclude-not-value; regeneration orphans
    them; mandatory disclosure on affected verdicts; new
    operator-owned ack store (scope note added against §2.2's
    "no new durable state"). FULL normative text (file schema,
    ack grammar, expiry semantics) is post-approval drafting —
    the shape is ratified, the details are NOT yet audited.
    Recorded as a §5.2 residual (waiver undercounts by design).
- D6 (cap hardness): "option 0"
  → interpreted: SIGN THE SOFT CAP AS DRAFTED (§2.4, no numerical
    overshoot bound; reservation transaction stays rejected).
    Folded to §2.4 sign-off note + §4 D6 + §5.2 row. ACTION ITEM
    (human-side, outside this repo, OPEN): set provider-account
    budget hard limits at each provider — the sign-off leans on
    them as the real hard stop. Hard-cap demand would re-open the
    reservation-transaction question.
- D1–D4, D7–D9: NOT YET ANSWERED (D2 no-auto-gate and D4
  USD-only flagged by the agent as the two most contract-
  shaping of the remainder; low-regret shape/ordering items
  otherwise).
- Remaining open owner items after this tranche: 3A final review
  (deferred to last, by owner); Decision 4 prose audit round
  (authorized in the second tranche, not yet run); S-J3 clamp
  CLOSED (second tranche); §14.10 G1 draft (docs/11) — separate
  workstream, round-1 folded, NOT implemented.

OWNER DECISION RECORD — FOURTH TRANCHE (replies received 2026-11-16,
same session as the third; verbatim owner words, expansions marked
as interpretation):

- D2: "d2 - 0" → option 0 = sign AS DRAFTED (no auto-promotion path
  in v1). [The "0" picks from the agent's depth-review option table,
  where option 0 was "sign as drafted".]
- D4: "d4 - 0" → option 0 = USD-only cap axes, sign AS DRAFTED.
- D1: "d1 - as drafted" → SIGNED as drafted (leaf promote.ts).
- D3: "d3 - as drafted" → SIGNED as drafted (inverse-merge default,
  narrow rewind escape).
- D7: "d7 - as drafted" → SIGNED as drafted, WITH the agent's
  reference-impl-ordering note folded into the §4 entry (see D7).
- D8: "d8 - as drafted" → SIGNED as drafted (integration-branch
  grammar incl. the case-fold guard).
- D9: "d9 - refuse" → AMBIGUOUS, interpreted (flagged, not silently
  resolved): confirms the REFUSE behavior as drafted (refused:no-main;
  human `git branch main <sha>` before first promotion). The
  alternative reading (refuse the sign-off; D9 stays OPEN) is
  recorded in the §4 entry and was surfaced to the owner for a
  one-word correction. D1–D8 are CLOSED; D9 is CLOSED-PENDING-
  CONFIRMATION of this interpretation.
- Part 2 (DC-2 acknowledged-gap block): "part 2 - ratify" → the
  DC-2 BLOCK (docs/21a, ACKNOWLEDGED GAP: T4-GAP COMPLETION
  MECHANISM DEFERRED) is RATIFIED AS WRITTEN; Q-J2-h deferral is
  now the OWNER'S OWN recorded position (fourth affirmation — the
  block's "third affirmation" count described the pre-ratification
  deferral events and is superseded by this ratification). The
  T4-gap is a PERMANENT accepted gap in v1; the only route out is
  whole-dir restore (R-1). STATUS FOLDED IN docs/21a.
- Part 3 (3A final review): "part 3 - proposed format" → the agent's
  proposed evidence-first format is ACCEPTED: (1) run the reference
  suite and pin results; (2) disposition crosswalk — each 3A
  sentence → code lines + test ids holding it → drift classified
  CODE/TEST/DOC vs SPEC; (3) one owner ratification reading against
  that artifact, cycles only if drift is found. 3A remains
  UNCONFIRMED until that reading lands.
- Part 4 (Decision 4 prose round): "part 4 - a" → scope A: the
  prose audit covers ONLY prose describing reference-implementation
  behavior (confirmation log, AUTH/REPAIR, resolve, cap/lock,
  freshness — the F-series fixture territory); Slice A/B prose
  (unimplemented) is OUT of this round. 5 cycles max; findings
  CODE/TEST/DOC vs SPEC as before.
- Part 5 (standing backlog: purge-exception draft Q-1A-b/N7,
  Q-J2-h completion-mechanism design, provider-account hard limits,
  D5 waiver full normative text): "review later" → NOT now; items
  remain parked with their recorded reasons; this tranche changes
  none of their statuses. (The DC-2 ratification above DISCHARGES
  the documentation duty on the T4 gap; designing a completion
  mechanism remains NOT commissioned.)
- Sequencing: "okay with the sequencing as suggested" → (1) fold
  this tranche [done: v44]; (2) Decision 4 prose round scope A —
  its crosswalk artifact feeds (3); (3) 3A final review against
  that artifact (truly last, per the second tranche); (4) provider
  hard limits — human-side, non-blocking.
