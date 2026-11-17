# P9-M3 reference ledger — OWNER REVIEW LEDGER (v38 cycle 6–7)

Purpose: every finding from the GPT Terra audit was triaged as either
**CODE** (fixed in code with a pin — no owner decision needed) or **SPEC**
(the invariant itself is undecided — needs the owner). This file lists
ONLY the SPEC items. Fill the `Decision` line for each item; nothing here
is ratified until you do.

Status of the code work: all CODE findings from audit cycles 1–8 are
fixed. Suite: `python3 -W error::ResourceWarning -m unittest p9m3.test_ledger`
→ **89 tests OK** (REV 15 correction per cycle-13 minor 1: the doc
said 87; the cycle-13 scratch-copy run measured 89 — the C7_1/C7_2/
C7_3/C8_1 tests postdate the 87 count; historical "87" counts in the
R3/R4/R5 round footers below are HISTORICAL AS OF those rounds and
stand unchanged) (79 through the v38 round + F24gen, F7b, F18z, F18z2,
F53, F54 from the R3 combined contract+code round, + F55, F56 from the
post-round inline audit, + F57 from inline-audit round R4 — see "ROUND
R3 status (HISTORICAL — as of R3 and before the owner replies)" below).

## How the audit was run (honest accounting)

| Cycle | Target | Verdict | CODE | SPEC |
|---|---|---|---|---|
| 1 | cycle-6 changes | CHANGES-REQUIRED | 2 | 0 |
| 2 | +C7 fixes | CHANGES-REQUIRED | 1 | 0 |
| 3 | +F27 kill-in-write | CHANGES-REQUIRED | 1 | 0 |
| 4 | +exact-bytes C7_1 | **CLEAN** | 0 | 0 |
| 5 | +bounded sentinels | CHANGES-REQUIRED | 1 | 0 |
| 6 | +bounded C6_23 | CHANGES-REQUIRED | 1 | 0 |
| 7 | +exact two-call C7_2 | CHANGES-REQUIRED | 1 | 0 |
| 8 | final code | **CLEAN** | 0 | 0 |

The owner asked for 5 cycles; **8 were run** (3 more after the review
requested fixes). The auditor classified **every** finding as CODE, and
**none** as SPEC. Cycle 4 CLEAN was followed by a CHANGES finding in
cycle 5, so a single CLEAN verdict is not proof of convergence. Cycle 8
is the first CLEAN after the last code change, and it is one verdict.

The auditor never classified a SPEC item, but the SPEC questions below
were already open in Doc 21 before this audit. Their absence from the
auditor's output means the auditor did not re-open them, not that they
were settled.

## SPEC items awaiting owner decision

OWNER REPLIES RECEIVED (shorthand, recorded as given; the agent's
expansion of each reply is marked as interpretation). Date of the
replies is UNVERIFIED — the agent wrongly used 2026-07-30 earlier.
S-J3 was REVISED to option C at the owner's request ("accept the rec
c"); see its entry.

### S-L1 — lock trust boundary (DECIDED by owner: A, B recorded as debt)
The identity check proves only "not a different inode". Residual risks:
fd reuse on the same inode; replacement of the lock pathname.
- A) Accept the narrowed claim under the 0700 single-writer premise.
- B) Require a stronger ownership design (e.g. lock-file token verified
  after acquire).
Recommendation: A for the reference build, record B as a debt item.
Decision: **A — accepted** (owner reply). B recorded as DEBT:
  AGENT PROPOSAL, not an owner requirement: re-audit the identity check
  if the deployment model ever widens beyond 0A.

### S-J2 — journal-full recovery (DECIDED by owner: A)
The writer refuses (`journal-full`, zero bytes) when the journal would
exceed `JOURNAL_CAP`. No operator path is defined; a full journal blocks
all repairs.
- A) Archive/rotate the journal under the exclusion lock (new file, old
  one kept as evidence).
- B) Start a new ledger epoch (new journal + counters), old epoch frozen.
Recommendation: A, with the rotated file kept read-only for audit.
Decision: **A** (owner: "a works"). Interpretation: rotate under the
  exclusion lock, keep the old journal as evidence. NOT SPECIFIED
  (open sub-spec): (i) file mode for the archived journal (the agent
  earlier proposed 0400; that is the agent's proposal, not an owner
  decision); (ii) how the attempt counter from `_clean_failure_count`
  is preserved across rotation — a fresh file with no carry-over
  would silently rearm repair attempts. No rotate code exists yet.

SUB-SPEC S-J2-R v10 (REV 52 IN FORCE; RATIFIED by owner at REV 36, 2026-11-15 — drafted as DRAFT rev 35 — revs 3..7 folded terra
  cycles 1/2/3/4/5; rev 8 folds cycle 6; rev 10 folds the terra
  cycle-8 CONFIRMING audit; rev 12 folds the terra cycle-10
  CONFIRMING audit (1B/7M/4m; CODE 0 / SPEC 12, SIXTH
  CONSECUTIVE CODE-CLEAN CYCLE); rev 13 folds the terra
  cycle-11 CONFIRMING audit (0B/4M/3m; CODE 0 / SPEC 7, SEVENTH
  CONSECUTIVE CODE-CLEAN CYCLE; ALL FIVE CYCLE-10 DISPOSITION
  CATEGORIES RE-VERIFIED; every finding closes HERE: major 1
  the post-purge coverage RESET — "last_hwm := its hwm"
  inherited a floor that BROKE the fresh epoch's first legal
  entry (T4 compares the entry hwm against the largest PRESENT
  archive, so post-purge seq 1 could not carry hwm 7); the
  purge entry's `hwm` stands as AUDIT EVIDENCE of the pre-
  purge high-water, the epoch's COVERAGE STATE now resets to
  0 (parser, writer, T4, grammar and the cross-epoch pin all
  restated — REV 13); major 2 the canonical cross-epoch pin
  FIXTURE was invalid under the canonical schema (missing `t`
  on both normal entries) — fixture completed, and an
  incomplete fixture is itself a framing violation (pin
  `cross-epoch-seq-reuse-legal` corrected); major 3 REV-12
  PROPAGATION REGRESSION — the pre-rename crash descriptions
  still promised NORMAL re-entry and zero permanent writes
  after a DURABLE 4a ATTEST APPEND (the same withdrawal-did-
  not-propagate class as the cycle-10 blocker): window (a) is
  SPLIT (a1) pre-4a = reads normally / (a2) 4a durable +
  pre-rename crash = T4-gap refusal + WHOLE-DIR RESTORE (R-c),
  and the zero-byte claim is scoped PRE-4a with the
  attestation log named as the sole permanent record written
  before any rename BY DESIGN; major 4 the AUTH-recovery post-
  rename error was called DURABLE while the universal fault
  contract made it retired-by-later-fsync — now stated
  NAMESPACE-VISIBLE / durability-PENDING with the re-run route
  (the same discipline as the purge 4b row); minors: the
  summary bullet's governing-rev label drift (rev 8/rev 10
  tags stale under a rev-12 heading) — replaced by "the BODY
  AS OF THE HEADING'S REV", `true`/`false` are JSON literals
  NOT "numbers syntactically" (rejection unchanged), and the
  purge 4b retry wording — a retry with the marker RETURNED
  SUCCEEDS at re-unlink, ENOENT is the marker-GONE branch),
  rev 12's findings were: 1B/7M/4m; CODE 0 / SPEC 12, SIXTH
  CONSECUTIVE CODE-CLEAN CYCLE; the BLOCKER was rev-11's own
  fold-over — the operative T4 site still instructed the
  journal-conditioned exception withdrawn at its definition
  site: the exception is now WITHDRAWN AT EVERY SITE (T4
  UNCONDITIONAL — the route out of a T4 gap is whole-dir
  restore as residual R-c; the abandoned act has NO
  in-protocol completion — the "re-entry completes the
  rename" promise is WITHDRAWN, only the torn-append
  writer/parser unit-test machinery survives), pin
  `rebuild-t4-gap-refuses-unconditional` unchanged; major 1
  the attest-before-rename state carried MUTUALLY EXCLUSIVE
  contracts (promised re-entry completion vs T4-refusal R-c)
  — one fail-closed contract, R-c named at every site; major
  2
  the illustrative entry schemas diverged from the grammar at
  three sites — `t` added to the FRAMING block, the canonical
  recovery-log schema declared ONCE in the grammar (cmd value
  LITERALLY "purge"; prose aliases withdrawn), `t` required on
  purge entries; major 3 step-(4) split into 4a UNLINK and 4b
  DIR-FSYNC with separate failure outcomes (4b: marker gone,
  fsync-lost power-loss window may return it — parser state,
  not a command contradiction; observation-only reporting);
  major 4 the purge ATOMICITY clause's blanket "nothing
  unlinked" contradicted the step-(5) contract — scoped to
  pre-unlink acts (1)-(3), the governing contract named;
  major 5 the retry-hwm pin's oracle could not catch an
  identical re-append — replaced with a BYTE-EQUALITY oracle
  on the log before/after a same-seq retry; major 6 duplicate-
  seq identity scoped WITHIN an epoch (cross-epoch seq reuse
  is the specified post-purge behavior; pin
  `cross-epoch-seq-reuse-legal`); major 7 decision readers
  NEVER parse the attestation log — purge-in-flight binds
  ONLY the rebuild/rotation command paths, decision semantics
  unchanged (pin `decision-reader-never-parses-attest-log`);
  minors: the torn-attest purge pin's double name collapsed
  to `purge-attest-torn-log-refuses`, `t`'s numeric domain
  pinned (finite non-negative int; booleans/fractions ⇒ type
  mismatch), stale
  "journal-conditioned" citations swept from the eligibility
  rollups, summary annotation bumped), rev 11 folds the terra
  cycle-9
  CONFIRMING audit (2B/6M/2m; ALL SPEC — CODE 0 / SPEC 10,
  FIFTH CONSECUTIVE CODE-CLEAN CYCLE; every finding closes
  HERE: blocker 1 the journal-PRESENT T4 exception admitted
  loss of a latest COMPLETED archive (an empty journal is a
  conforming product of step 7, not abandonment evidence) —
  the presence-only exception is WITHDRAWN IN FULL, T4 now
  fails CLOSED unconditionally (resolution route: the
  abandoned rotation's own re-entry completes the rename —
  [REV 12: THIS PROMISE WITHDRAWN, see the rev-12 block
  above — historical description of what rev 11 folded]),
  pin `rebuild-t4-gap-refuses-unconditional` replaces the
  withdrawn `rebuild-t4-exception-needs-journal` WITH ITS
  TEST; blocker 2 purge could append past a torn attestation
  witness because only the rotation writer ran the parser —
  purge's write path now runs the SHARED PARSER over the
  whole log before any append (`purge-attest-log-refused`,
  zero bytes); major 1 the retry write rule bumped hwm and
  the parser's equality test then refused the promised
  duplicate — writer is APPEND-IDEMPOTENT, same-seq retry
  appends nothing, parser and writer cannot diverge (pin
  `rotation-retry-hwm-idempotent`); major 2 "purge entry +
  marker present ⇒ in-flight" misclassified every COMPLETED
  purge once a later rotation recreated the marker — the
  parser rule is now LAST VALID ENTRY = purge AND marker
  present, completion superseded permanently (pin
  `purge-complete-then-rotate-not-inflight`); major 3
  purge retry/failure contracts contradicted the ordered
  protocol — explicit idempotence rules, pre- vs
  post-unlink failure outcomes separated
  (`purge-commit-log-failed` = COMPLETED-purge-with-
  incomplete-audit, no rollback), `attest_seq` MOVED from
  the attempted to the committed record (undefined reference
  closed), rearm-effective point stated; major 4 the
  prerequisite's scope conflicted with the canonical
  eligibility program on stale-sidecar replay — TWO named
  obligations (O1 attestation prerequisite on every
  carries-composing/sidecar-writing path, enumerated; O2
  eligibility rows = rebuild-invocation classification
  ONLY) with pins per path; major 5 zero-byte enumeration
  internally false (pre-rename durable attest, step-0
  chmod, purge post-unlink failures, S-A1 `auth-recover-io`
  after rename) — BYTES-vs-METADATA discipline, per-refusal
  rows added, unconditional statements withdrawn or scoped;
  major 6 the "one dialect" claim left the new logs'
  grammars/empty-file/epoch/duplicate-key rules and the
  shipped-journal-by-reference claim incomplete — full
  grammar stated (see UNIFIED LOG FRAMING DIALECT, rev 11)
  and the journal's shipped strict schema preserved BY
  REFERENCE with the append-time rules explicitly NOT
  altering read behavior; minors: stale "rev 8" governing-
  version label removed from the summary, single-file-loss
  claimed-power language aligned to the journal-exception
  withdrawal), rev 9 folds the terra
  cycle-8 CONFIRMING audit (3B/6M/3m; CODE 1 / SPEC 11 — the
  CODE-tagged finding (pin fixtures do not discriminate their
  claimed mutations) is a defect in the spec's OWN TEST-PLAN
  text, so it is reclassified SPEC per the cycle-7 precedent:
  CODE 0 / SPEC 12 counting the reclassification; every finding
  closes HERE: blocker 1 the T4 high-water exception admitted
  loss-of-the-latest-COMPLETED-archive — the abandoned-vs-lost
  exception now applies ONLY when the live journal is PRESENT
  (abandonment evidence), journal-absent refuses; blocker 2 a
  torn attestation tail could erase the only damage:true
  witness AND the next O_APPEND would concatenate past it —
  torn tail now REFUSES unconditionally (no ignore, no
  truncate; whole-dir restore) and the parser state machine
  (duplicates, epochs, purge resets) is fully specified;
  blocker 3 rotation RE-ENTRY reconstructed carries without
  the attestation gate — T1-T5 now gate EVERY carries-
  advancing path incl. rotation re-entry (pin
  `rotation-reentry-attest-gate`); major 1 log framing got no
  crash-safe resume rule — unified framing dialect across all
  THREE logs, torn tail refuses everywhere; major 2 purge
  logged its reset as the FIRST durable act — resequenced to
  attempted-record ⇒ purge-entry ⇒ unlink ⇒ committed, with
  purge-in-flight refusal until the marker is gone; major 3
  two eligibility ladders disagreed and first-match-wins
  skipped hygiene — ONE canonical ELIGIBILITY ALGORITHM,
  prerequisites vs terminal refusals distinguished, empty-
  archive-set T4 operand defined; major 4 "self-verifying"
  hwm overclaimed — WITHDRAWN, residuals R-a (coherent log
  replacement) / R-b (correlated suffix loss) named, claimed
  power stated precisely; major 5 pins lacked discriminating
  fixtures — concrete fixture+observable+mutation per pin
  (incl. the stale-replacement-sidecar fixture for
  `rebuild-damage-from-log-only`); major 6 zero-byte claims
  did not enumerate persisted state and one reader cell was
  called unreachable while conforming-reachable — per-boundary
  persisted-state enumeration added and the marker-before-
  sidecar cell conformed as rotation-in-flight (honest prose,
  refusal unchanged); minors: rev-8 high-water passage +
  obsolete "EVER recorded" pin supersession-labeled, six-class
  labels updated for N7, summary heading rev-8→rev-10), the
  cycle-8 fold is labeled in place; rev 9 folds the terra
  cycle-7 CONFIRMING audit (2B/6M/3m; reported CODE 1 / SPEC
  10 — mandatory re-verification reclassifies the CODE finding
  to SPEC, CODE 0 / SPEC 11: the pin cites an `unlink_missing`
  code path that does not exist in ledger.py and the behavior
  it describes is spec-correct, so what remains is a defect in
  the spec's TEST-PLAN text, not in shipped code; all 11
  findings are SPEC changes and close HERE: blocker 1 damage
  history dies with the sidecar — NEW APPEND-ONLY
  ATTESTATION LOG `journal-carries-attest.jsonl` written by
  EVERY rotation before the sidecar and consulted by EVERY
  rebuild (damage records + seq high-water mark survive
  sidecar loss; missing/damaged/gap ⇒ rebuild refuses
  fail-closed); blocker 2 suffix loss silently discards
  counts — the log's high-water mark makes a truncated chain
  DETECTABLE: largest-present-seq < high-water ⇒ refusal
  `carries-rebuild-attestation-gap`, replacing rev 8's
  operator-obligation-only control; major 1 "ALL THREE ⇒
  damage:false" implication WITHDRAWN IN FULL and replaced by
  the conservative rule (damage clears only from an
  attestation-complete, never-damaged lineage); major 2 purge
  authorization replaced with an HONEST enforceable boundary
  (filesystem ownership+mode+assertion; console presence
  demoted to operational assertion; the geteuid()==0 check
  that contradicted the startup owner-check is REMOVED);
  major 3 purge/recovery LOG spec completed (path, framing,
  checked append, named refusal, torn-line rule) AND the
  purge's decision-semantic exception submitted to Q-1A-a as
  class N7 (deployment BLOCKED on it); major 4 eligibility
  ladder REORDERED (archives-absent now PRECEDES orphan-
  source eligibility — the two-predicate conflict is closed
  by ordering; attestation checks are run before any replay);
  major 5 the unobservable "ever recorded damage" pin
  replaced by four OBSERVABLE per-entry pins (cycle-5 rule);
  major 6 marker prose: rename-durable/marker-absent window
  declared REACHABLE (routes R4/rebuild, already handled),
  "impossible" reserved for marker-durable-without-
  archive-durable; minors: superset phrase tagged, entry-size
  arithmetic RECOMPUTED to match the compact grammar (26-char
  ULID entry = 31 bytes ⇒ ~33.8k/MiB, not 25-26k), stale
  U1-U4 heading fixed, summary heading v7→v9, cycle-status
  lines updated), the cycle-7 fold is labeled in place;
  and rev 8 folds the terra cycle-6 CONFIRMING
  audit (2 blockers / 5 majors / 2 minors; CODE 0 / SPEC 9 —
  SECOND CODE-CLEAN CYCLE; both blockers and all five majors
  close HERE: blocker 1 marker durability — rename is now
  dir-fsynced BEFORE the marker is created, the sweep tests
  every PERSISTENCE boundary, and every re-entry path creates
  the marker idempotently; blocker 2 clearance proof defeated
  by syntactically-valid replacement members — damage is now
  EVERLASTING to every rebuild output, clearance becomes owner
  call Q-J2-g; major 1 stale rev-6 normative text — tagged
  HISTORICAL at the site and in the summary; major 2 re-entry
  skips marker creation — crash matrix amended; major 3 Q-J2-f
  f1 unratifiable as drafted — full destructive-recovery
  protocol (auth/eligibility/logging/atomicity) now IN the
  text; major 4 suffix gaps invisible to continuity — HIGH-
  WATER RULE stated, honest residual named; major 5 summary
  offered demoted e2c and a five-class list — both tagged
  SUPERSEDED; minors: S-A1 N1-N5/U1-U4 totals corrected to
  N1-N6/U1-U5, ID-capacity figures relabeled per-entry byte
  quotients), the cycle-6 fold is labeled in place;
  and rev 7 folds the terra cycle-5 CONFIRMING audit
  (1 blocker / 8 majors / 2 minors; CODE 0 / SPEC 11 — all
  judged valid; FOUR are REGRESSIONS opened by rev-6's own
  closures — the automatic marker-unlink could silently rearm
  D1-A on an all-lost fleet (BLOCKER), orphan-marker handling
  contradicted the reader algorithm, the e2c shard "option" was
  an unimplementable protocol, and direction (ii) text+pin
  inverted the trigger semantics — each closed here and labeled
  in place; cycle-5 ran the mandatory A1-A8 attacks clean on
  shipped code (CODE 0 for the first time); AWAITING OWNER
  RATIFICATION; no code until ratified [(HISTORICAL —
  pre-REV-36 posture; RATIFIED at REV 36)]; prior history at the
  S-J2 decision entry): [the phrase "rev 7 folds ... labeled
  in place" above applies to the rev-7 fold; rev 8 = cycle 6
  fold and rev 9 = cycle 7 fold, each labeled in place at its
  site]

  Command 1: `operator_rotate_journal()` — an operator action, NOT
  a decision. It takes the exclusion lock (1A conformance: one
  acquisition, no resolve) and MUST bypass `_resolve_locked` (the
  D2-A journal gate would refuse to rotate the very damaged
  journal this command exists to archive; precedent:
  `operator_resolve_reset`). It writes ZERO bytes to the
  consumption log and the AUTH file and touches NO EXISTING
  sidecar (`last-append`, `resolve-attempts` untouched — 2A: the
  resolve-attempt counter is a separate record). HONEST SCOPE:
  the command DOES write the derived carry sidecar
  `journal-carries` and the rotation marker (below); "zero
  sidecar writes" is prose about the EXISTING sidecars only.

  Command 2 (rev 5 NEW, closes cycle-3 blocker 1):
  `operator_rebuild_carries()` — the ONLY recovery for "journal
  PRESENT + marker present + sidecar absent/invalid". Cycle-3's
  named contradiction: rev 4's recovery table said "rerun
  rotation", but the rotation command's own currentness rule and
  c1 gate make exactly that invocation refuse — an implementation
  following the matrix could never perform the prescribed
  recovery (and one "fixing" that by treating absence as empty
  silently rearms exhausted ids). Separation of duties:
    - `operator_rotate_journal()` NEVER rebuilds: journal
      present + sidecar absent/invalid ⇒ refuse
      `journal-rotation-incomplete` (zero bytes), recovery named
      as `operator_rebuild_carries()`;
    - `operator_rebuild_carries()`: lock-only; entry dir fsync +
      step-0 mode repair (same as rotation step 0); NO journal
      rename, NO archive creation, c1 does NOT apply (this is
      not a rotation). ELIGIBILITY (rev 6, closes cycle-4 major
      3 — without it, rebuild on a fresh fleet (journal present,
      no marker, no archives, no sidecar) replays an EMPTY chain
      and the mandatory `source_archive` has no existing archive
      to name: one implementation refuses, another writes an
      arbitrary string that readers accept as VALID and compose
      under R2 — a manufactured empty history):
        sidecar present AND VALID **AND CURRENT** (current =
        `source_archive` names an EXISTING archive equal to the
        newest, checked operator-side under the lock — the glob
        is operator-side only) ⇒ refuse
        `carries-rebuild-not-needed` (zero bytes — a VALID,
        CURRENT sidecar is never overwritten, damage:true or
        not; a damaged chain is out-of-band restore, Q-J2-d
        d1);
        archives ABSENT ⇒ refuse `carries-rebuild-ineligible`
        (zero bytes, NOTHING deleted — REV 7, closes cycle-5
        BLOCKER 1: rev 6 auto-UNLINKED the marker here, and
        this reviewer caught the failure: the state is
        INDISTINGUISHABLE from "rotated, then all archives
        lost", so auto-clearing the marker silently returned
        an exhausted fleet to R1 fresh-fleet semantics and
        REARMED spent D1-A ids — removing exactly the evidence
        that distinguishes the two. Rev 7: rebuild NEVER
        deletes anything. REV 9 ORDER FIX (cycle-7 major 4):
        an ABSENT-source sidecar over an EMPTY archive set
        matched BOTH this row and the stale/orphan row BELOW
        it — two implementations, two outcomes. This row is
        MOVED AHEAD of stale/orphan eligibility: archives are
        checked first (ABSENT ⇒ refuse here, always); orphan
        eligibility only ever sees archives-present fleets
        (the qualifier on that row is the belt to this
        ladder's braces — mirrored verbatim in the ELIGIBILITY
        ORDERING list in the sidecar section).
        REV 9 ATTESTATION GATE (step 4a T1-T5) runs before
        ANY replay below: the log must vouch for the chain
        (missing/gap/high-water failure ⇒ the named
        attestation refusal, zero bytes).
        sidecar VALID but STALE or ORPHAN-SOURCE (source_archive
        older than newest, or naming nothing) **AND at least
        one archive PRESENT** ⇒ ELIGIBLE (rev 6, closes
        cycle-4 major 9 — rev 5 left this state with NO
        in-protocol exit: readers compose, rotation's
        currentness check refuses, rebuild refused every VALID
        sidecar): full-chain replay REPLACES the stale sidecar
        (replay from archives reconstructs a superset of its
        counts — REV 9 TAG per cycle-7 minor 1: superset ONLY
        for provably complete chains; see the HIGH-WATER RULE;
        journal untouched); how the state arose is
        always backup-restore mixing or media failure — the
        command never asks; A fresh fleet (no marker) needs no
        sidecar and never enters this branch as a refusal
        (R1 governs it); an all-lost fleet STAYS refused (R3)
        and its exit is the NEW owner call, not an
        in-protocol act:
        Q-J2-f (OWNER CALL, rev 7 NEW — marker purge on an
        archives-lost fleet): the operator-attested
        `operator_purge_rotation_marker()` (name provisional)
        would remove the marker (+dir fsync) as a SEPARATE,
        SEPARATELY AUTHORIZED destructive recovery step, with
        the D1-A rearm consequence stated on its face (all
        ids' history known-lost: repairs rearm from zero,
        journal-only ids re-mintable). Options: f1) allow
        the purge command (an explicit human act replaces
        rev 6's automatic one — recovery exists, consequence
        owned); f2) no in-protocol purge EVER — all-lost
        fleets recover only by restoring archives from backup
        or accepting permanent refusal (maximum fail-closed;
        operator lives with the brick). RECOMMENDATION f1
        (the manual rm exists anyway; making it a NAMED,
        REFUSAL-LOGGED, DELIBERATE command with the rearm
        warning beats an invisible one), BUT the choice is
        the owner's and NO implementation proceeds on either
        command until Q-J2-f lands. [REV-37 tag, R9 major 3:
        Q-J2-f RULED f1 at REV-36 — the pre-ruling gate here
        is SUPERSEDED as to Q-J2-f; the purge command's
        DEPLOYMENT remains gated [REV-45: Q-1A-b RULED — the
        purge command REQUIRES ITS OWN RATIFIED EXCEPTION and
        is NOT admitted by the amended 1A; deployment gate now
        = that exception being drafted AND ratified, see
        OWNER RULINGS REV-45 item 1.]
        Q-J2-f f1 PROTOCOL (rev 8, closes cycle-6 major 3 —
        cycle-6 rule: a destructive-recovery option is
        UNRATIFIABLE until authorization, eligibility,
        logging, and atomicity are defined IN the protocol
        text; if the owner declines to define them f1
        auto-demotes to f2 by this clause) [REV-46, restated
        REV-50 per R13 finding 1: the auto-demote condition has
        NOT been triggered on the record — the ledger reads the
        owner's "4: one sentence" (REV-45 item 4) as confirming
        no current intent to invoke the auto-demote clause
        (labeled interpretation, cycle-66; literal reply is the
        abbreviation only); NOTE: confirmation-of-intent is NOT
        a definition of the four protocol elements and does NOT
        preclude the owner declining to define them later — the
        clause stays LIVE with its condition open in principle]:

          AUTHORIZATION — the command takes NO ambient
          evidence; the caller passes an asserted-evidence
          string (c3 posture). AUTHORIZATION BOUNDARY, HONEST
          AND ENFORCEABLE (rev 9, closes cycle-7 major 2 —
          cycle-7 caught the rev-8 claim twice over: (a) an
          operator-present-at-console REQUIREMENT cannot be
          checked by any syscall — a root process invoked
          remotely or from cron satisfies geteuid()==0 with
          nobody at a keyboard; (b) geteuid()==0 CONFLICTS
          with the shipped startup invariant that the ledger
          owner must equal the effective uid (`ledger.py`
          151-181): on a service-owned ledger (owner = the
          service user), running the purge AS ROOT is refused
          at startup BEFORE the purge command exists):
          REVISED NORMATIVE CHECKS — (i) the ledger's
          startup owner-uid check governs: the command runs
          AS the file's owner uid (deployment reaches it via
          `sudo -u <service-user>` or equivalent — the
          boundary is WHOEVER the owner-uid gate admits, and
          the spec states that honestly instead of pretending
          a console test exists); (ii) the state directory
          and the marker's directory are NOT group/other-
          writable and none of marker/sidecar/archives/attest
          log is a symlink or owner-mismatched (joins
          `_check_access_controls` posture; an
          attacker-writable dir means the marker is
          unattested ⇒ refusal); (iii) the asserted-evidence
          string is REQUIRED non-empty. Console presence is
          DEMOTED from requirement to OPERATIONAL ASSERTION
          (stated as such: an unenforceable practice the
          deployment owns, not a protocol check — the
          protocol's defense is (i)+(ii)+(iii) plus the
          durable log below); NO delegation, NO config flag;
          each invocation standalone (revoked grants cannot
          matter retroactively).
          ELIGIBILITY — re-checkable ONLY from the files:
          marker PRESENT AND sidecar ABSENT-OR-INVALID AND
          archive set EXACTLY EMPTY (any archive present ⇒
          refusal `purge-archives-present`: purge targets
          archives-LOST fleets only; with archives the R3
          routing or rebuild applies). Re-checked UNDER THE
          LEDGER LOCK immediately before the unlink.
          LOGGING (rev 9, completes cycle-7 major 3 — rev 8
          named the log but not its path, ownership, framing,
          checked-append behavior, or a log-failure refusal;
          a torn append could leave an ambiguous audit record
          before any retry): durable APPEND to
          `<ledger-dir>/recovery-log.jsonl` — SAME directory
          as the ledger state (so a whole-dir restore carries
          it), created 0600 (dir fsync on creation), then
          checked append + file fsync BEFORE any unlink.
          FRAMING: one JSON object per line + `\n`. REV 12:
          THE CANONICAL ENTRY SCHEMA IS THE GRAMMAR'S
          RECOVERY-LOG ENTRY (see UNIFIED LOG FRAMING
          DIALECT (b)) — prose restatement only, fields:
          `t` unix-epoch int, `cmd` LITERALLY `"purge"`
          (cycle-10 major 2: the former prose value
          `"purge-rotation-marker"` is WITHDRAWN as a
          schema value — this command's NAME is
          journal-purge-rotation-marker; the record's `cmd`
          VALUE is `"purge"`),
          `phase` "attempted"|"committed", `marker_mtime`,
          `dir_listing` summary string, `evidence` asserted
          string (ATTEMPTED record only), `attest_seq` the attestation-log entry
          offset this purge recorded — cross-links 4a
          (COMMITTED record only; rev 11 field move — an
          attempted record NEVER carries attest_seq, the
          offset does not exist before the attestation
          write).
          REV 10 (cycle-8 major 2): the RECORD SEQUENCE is
          the 4a PURGE INTERACT order — `attempted` written
          + fsynced BEFORE the attestation purge entry and
          the unlink; `committed` after the marker is gone;
          an `attempted` with no `committed` pair is
          abandoned-purge EVIDENCE only (never a decision
          input; the CONSUMABLE state is decided by the
          marker + the attestation purge entry per 4a's
          purge-in-flight rule — never by this log alone).
          CHECKED SEQUENCE (rev 10, closes the rev-9 "log
          written-and-synced first... idempotent second
          record" sketch that left the reset recorded for an
          incomplete purge): a pre-existing recovery-log
          that is NOT 0600, NOT owner-uid, or a symlink ⇒
          refusal `purge-log-insecure` (NEVER chmod someone
          else's audit file); CHECKED APPEND: full-line
          write with verified byte count, then fsync — any
          failure (ENOSPC, EIO, partial write) ⇒ refusal
          `purge-log-failed`, NOTHING unlinked;
          TORN LINE RULE REV 10 (cycle-8 major 2 — rev 9's
          "the next purge appends a complete line after the
          torn one" is WITHDRAWN: appending past a torn tail
          produces the concatenated malformed line the
          finding named): the recovery log adopts the SAME
          dialect as the attestation log (see 4a UNIFIED
          LOG FRAMING DIALECT) — a torn tail makes the
          recovery log REFUSED for appends (a torn-tailed
          recovery log ⇒ `purge-log-failed` with the tail
          named); clearing it is whole-dir restore, NOT
          in-protocol truncation. (The log remains an AUDIT
          record, not a decision input — its integrity is
          no longer claimed to be load-bearing AND it is
          not treated as safely appendable past damage.)
          DECISION-SEMANTIC EXCEPTION, SUBMITTED (cycle-7
          major 3 second half, folded rev 9): purge CHANGES
          subsequent decision results on purpose (marker
          removal reopens R1 fresh-fleet routing = the D1-A
          rearm), which the 1A wording ("operator commands
          change no decision semantics") does not cover —
          this destructive exception is submitted to Q-1A-a
          as a named class **N7** (purge-rearm of decision
          semantics; see the Q-1A-a offer) and DEPLOYMENT OF
          THE PURGE COMMAND IS BLOCKED on N7's ruling, same
          rule as U-units. [REV-46: N7's ruling LANDED at
          REV-45 (Q-1A-b: own ratified exception REQUIRED) —
          the operative gate from REV 45 is the DRAFTED +
          RATIFIED EXCEPTION ARTIFACT, see OWNER RULINGS
          REV-45 item 1.]
          ATOMICITY — REV 12 SCOPED per cycle-10 major 4
          (rev 11's blanket "IF THE LOG WRITE OR EITHER
          fsync FAILS THE COMMAND REFUSES AND UNLINKS
          NOTHING" is FALSE for the step-(5) committed
          append — that write follows the unlink and its
          failure is `purge-commit-log-failed` = COMPLETED
          purge with incomplete audit, see the purge-
          interact FAILURE/RESUME CONTRACT, which GOVERNS;
          this clause covers ONLY the pre-unlink acts (1)
          -(3)): if the eligibility check, the `attempted`
          append, or the attestation purge entry (or their
          fsyncs) fails the command REFUSES and UNLINKS
          NOTHING (refusal-after-log-impossible ordering
          holds BEFORE the unlink; a crash after log-
          durable-but-before-unlink leaves the marker INTACT
          and the logs record an attempted purge — re-
          running is idempotent per the WRITER IDEMPOTENCE
          rule (NO second purge entry when the last valid
          entry already attests it — rev 11; "appends a
          second record" survives ONLY for the recovery-
          log `attempted` record, which is re-written per
          fresh invocation — the ATTESTATION log is the
          dedup boundary), which is acceptable and stated).
          Retry = a fresh full
          invocation (no resume state). Pin: mutation that
          unlinks before the log fsync ⇒ RED; mutation
          allowing purge with ANY archive present ⇒ RED.
        archives present ⇒ chain hygiene (rotation step 2 rules)
        MUST be complete and contiguous (gap ⇒ refuse
        `carries-rebuild-damaged`) AND the REV-9 ATTESTATION
        GATE (step 4a T1-T5) MUST pass (log missing/gap/high-
        water failure ⇒ the named `carries-rebuild-attestation-*`
        refusal, zero bytes) — attestation before replay;
      then: full-chain replay from an empty carry (damage
      anywhere ⇒ refuse `carries-rebuild-damaged`, zero bytes), candidate carries +
      identity set per b1 grammar incl. the cap of Q-J2-e
      [REV-37 correction, R9 cycle-39/40 major 1: cap = 64 KiB
      per the owner's REV-36 e1 ruling; the pre-ruling "1 MiB"
      here restated the unchosen e2a and is CORRECTED]
      (over-cap ⇒ `journal-carries-oversize`, zero bytes),
      candidate written via temp+fsync+rename+dir fsync (step 6
      mechanics). Journal bytes are NEVER touched: the live
      journal stays exactly as found, decisions stay refused
      until the rebuild succeeds.

  Rotation sequence under the held lock:
  0. ENTRY DIR FSYNC + MODE REPAIR: before any gate, every
     archive whose mode is 0600 (crash-leftover between rename
     and chmod) is chmod to the ratified mode; idempotent, under
     the lock, on EVERY invocation of EITHER command including
     invocations that afterwards refuse — so an interrupted
     transition is always completed by the next command.
     Startup `_check_access_controls` accepts for ARCHIVES ONLY
     the acceptance set {ratified mode, 0600-as-mode-pending};
     live files stay exact 0600. (Rev 4, cycle-2 major 6; the
     rev-4 exact-mode clause is superseded.)
  1. Refuse (`journal-rotate-pending-window`, zero bytes) if
     `durability_pending()`.
  2. HYGIENE: scan every archive name: parsed seq values are
     canonical (`:04d` byte spelling, values accepted as decimal
     only — `0x`, `+`, spaces, alternate Unicode digits all
     rejected) and UNIQUE across names (two archives sharing one
     parsed value, any clock suffix ⇒ refuse
     `journal-rotate-seq-ambiguous`, zero bytes); a non-parsing
     seq ⇒ same refusal. "Newest archive" = unique maximum
     parsed numeric seq.
  3. Classify the SIDECAR as ABSENT / INVALID / VALID (rev 5
     terminology fix, cycle-3 minor 3: `damage:true` is a FIELD
     OF A VALID sidecar — never called "damaged"; a syntactically
     broken file is INVALID). Reader-visible validity = the b1
     grammar with OPERATOR-SIDE CHECKS EXCLUDED (rev 5, closes
     cycle-3 major 3's inspectability objection: `source_archive`
     must be a string per grammar, but whether it NAMES AN
     EXISTING archive is checked ONLY by the operator commands —
     readers never touch archives). Composition rules (operator
     commands): VALID sidecar + archives ⇒ compose from it for
     the rotation replay; INVALID/ABSENT + archives ⇒ full-chain
     reconstruction, damage anywhere ⇒
     `journal-rotate-reconstruct-damaged` (zero bytes). REV 10
     (cycle-8 BLOCKER 3): reconstruction on THIS rotation
     re-entry path is GATED EXACTLY LIKE REBUILD — the
     ELIGIBILITY ALGORITHM (0) ATTESTATION PREREQUISITE
     (4a T1-T5) runs FIRST; any gate failure ⇒ the named
     `carries-rebuild-attestation-*` refusal, zero bytes,
     BEFORE any sidecar is reconstructed (rev 9 gated only
     the rebuild command — a bypass; pin
     `rotation-reentry-attest-gate`). Fresh
     fleet (no marker, no sidecar, no archives) ⇒ empty.
     Strict-read and classify the JOURNAL `full` / `damaged` /
     `healthy` per the MIRROR PREDICATE below.
  4. Archive name `repair_intent.jsonl.archived-<seq:04d>-<utc-e>`;
     seq = 1 + max parsed numeric seq (step 2 guarantees unique
     canonical). NEVER seq from the clock (S-J3 ratified).
     Target name exists ⇒ refuse `journal-rotate-target-exists`
     (rename would overwrite = destroy evidence).
     MARKER (rev 5; ORDER FIXED rev 6, ORDER-OF-ORDER FIXED
     rev 7, closes cycle-5 major 1 — rev 6 created the marker
     between preflight and rename and then tried to HANDLES the
     orphan state two different ways in two different sections:
     the marker text said "reads as R1, inert" while the
     executable READER ALGORITHM and R3 said "refuse
     unconditionally" — mutually contradictory normative text,
     exactly the class this loop exists to kill. REV-7
     ORDERING KILLS THE STATE INSTEAD OF INTERPRETING IT: the
     fixed-path marker `journal-rotated` (0-byte, 0600, O_EXCL
     — already existing is fine) is created under the lock
     AFTER the `os.rename` of the journal to the archive name
     (rename first, then marker, then the step-6 sidecar, then
     step-7 empty journal); its fd is fsynced at creation and
     the step-6/7 directory fsyncs cover it. DURABLE ORDERING
     (rev 8, closes cycle-6 BLOCKER 1 — rev 7's ordering
     ordered the CODE but not the DISKS: a file fd fsync does
     NOT persist a directory-entry update, so a crash could
     persist the marker's entry while the rename's entry update
     was lost — marker-durable-without-archive-durable,
     breaking the invariant for a CONFORMING crash and driving
     operators toward the destructive purge path): the fixed
     sequence is `os.rename(journal, archive)`; then
     **DIRECTORY fsync** (the archive entry is DURABLE before
     any marker can exist); THEN create the marker + fsync its
     fd; the marker's own entry is made durable by the step-6
     directory fsync (crash before it = marker simply absent —
     the marker-absent cells already route that state; the
     re-entry crash matrix ensures marker presence, see CRASH
     MATRIX). INVARIANT (rev 9 restated — closes cycle-7 major
     6, which caught the rev-8 wording asserting a FALSE
     disjunction: "every crash window lands either before the
     rename or after it" FORGETS the window BETWEEN the
     archive's dir-fsync and the marker's creation): the three
     conforming windows are (a) BEFORE the rename — journal
     present, NO marker, reads R1/pre-marker cell — SPLIT
     PER REV 13 (cycle-11 major 3) into (a1) BEFORE the 4a
     attest append: zero WRITTEN bytes to every permanent
     record, rotation re-entry normal; and (a2) 4a append
     DURABLE, crash BEFORE the rename: the ATTESTATION LOG
     IS PERMANENTLY WRITTEN — re-entry REFUSES (T4 gap,
     R-c WHOLE-DIR RESTORE; NOT "reads normally" — rev 12
     left this site promising a normal re-entry that the
     operative T4 contract forbids, the SAME
     withdrawal-did-not-propagate class as cycle-10
     blocker 1); (b) rename-durable, MARKER-ABSENT —
     archives present, marker absent, journal ENOENT (or
     present pre-(a)-cleanup of the re-entry itself): this
     window is REACHABLE for a conforming writer, is NOT
     corruption, and routes R4/rebuild-re-entry, which creates
     the marker idempotently before anything else. REV 10
     CONCRETE VARIANT ANALYSIS (cycle-8 major 6 asked the
     journal-present parenthetical to name its transition —
     named HONESTLY: there is NONE for conforming writers).
     With the step order (5) attest-rename-dirfsync-marker,
     (6) sidecar, (7) new journal EMPTY: a journal-PRESENT +
     archives-PRESENT + marker-ABSENT read is created by NO
     conforming crash point — every conforming path that
     moves the journal into archives creates the marker
     BEFORE creating the new journal, and re-entry creates
     the marker first. So the journal-present variant of
     cell (b) reduces to: (i) a still-unarchived live journal
     from an EARLIER completed rotation plus a crash before
     THIS rotation's rename = window (a) — (a1) if this
     rotation never appended (reads normally), (a2) if THIS
     rotation's 4a append is durable (T4 gap, R-c — REV 13
     per cycle-11 major 3: "reads normally" applies ONLY to
     (a1)),
     or (ii) marker media-loss after completion — the same
     fsync-premise class the HONEST LIMIT below already
     names, whose reader cell keeps its bounded glob. The
     rev-9 parenthetical "(or present pre-(a)-cleanup of the
     re-entry itself)" described a state no conforming
     schedule produces and is WITHDRAWN. (c) AFTER
     the marker + its durability path — normal completed or
     in-flight rotation. The ONLY state reserved
     "UNREACHABLE for conforming writers" is
     **marker-durable-without-archive-durable** — exactly what
     the rename-dir-fsync-first ordering excludes under the
     stated fsync assumptions. "Atomic" is no longer said of
     marker+archive creation (rev 8 prose said the writer
     creates them "atomically" — WITHDRAWN: they are two
     durable acts with a reachable window between them,
     handled by cell (b)). Oversize refusal: no marker (as rev 6). No orphan
     state, no orphan rules, no contradiction. HONEST LIMIT
     (unchanged): marker-loss with archives durable is media
     failure — the same class every other fsync promise
     declines to defend; the marker-absent reader cell keeps
     its bounded glob for exactly that class. Readers pay ONE
     stat on the marker (never a glob when the sidecar is
     present and VALID).
  4a. ATTESTATION LOG (rev 9 NEW — closes cycle-7 BLOCKERS 1
      and 2; the cycle-7 finding: every durability claim for
      the damage flag and for chain completeness rested on the
      SIDECAR itself, so a lost/replaced sidecar destroyed the
      very history that was supposed to survive it, and a
      suffix-truncated chain was indistinguishable from a
      never-extended one — rev 8's operator-obligation control
      was correctly refused as non-enforceable). The
      mechanism: an APPEND-ONLY file
      `journal-carries-attest.jsonl` in the same directory,
      created 0600 on
      first use, written by EVERY rotation BEFORE the archive
      goes public and consulted by EVERY rebuild before any
      replay. NEVER truncated, NEVER rewritten, NEVER deleted
      by any command, rebuild, or purge (R-1 no-delete
      posture extended to the log; it outlives rotations
      precisely because no conforming path shrinks it).
      ENTRY FRAMING: one JSON object per line —
      `{"seq":<int>,"damage":<bool>,"hwm":<int>,"t":<int>}`
      + `\n` (REV 12: `t` added to the illustrative schema —
      cycle-10 major 2: the writer sites and the exact
      grammar below must be ONE schema; `t` = unix-epoch
      non-negative INT, diagnostic-only for semantics but
      REQUIRED in the record: bool/float/NaN/inf ⇒ type
      mismatch ⇒ framing violation). Full exact grammar:
      see THE GRAMMAR, COMPLETE (below).
      `hwm` = max seq attested so far (monotonic by write
      rule). REV 10 (cycle-8 major 4): the rev-9 word
      "SELF-VERIFYING" is WITHDRAWN — monotonicity checks
      only the entries that REMAIN; it cannot prove a
      missing suffix or authenticate the log. HONESTLY
      NAMED RESIDUALS (no claim beyond them): (R-a) coherent
      REPLACEMENT of the log by an attacker-or-operator with
      a syntactically valid lower-hwm clean log is
      INDISTINGUISHABLE (the log is 0600 owner-writable —
      same trust class as the cycle-6 replacement-member
      finding); (R-b) CORRELATED loss of the log suffix
      WITH the archive suffix leaves the remainder monotone
      and covering — T1-T4 need not detect it. The log's
      claimed power, precisely stated: it converts
      UNCONDITIONAL single-file losses (sidecar lost, log
      intact; archives lost, log intact) into DETECTED
      states, and partial restores dropping ONE of
      {log, archives} into REFUSED states (T1/T4). It
      claims nothing about correlated loss or coherent
      replacement (REV 11 ALIGNMENT per cycle-9 minor 2:
      "archives lost, log intact" is DETECTED only when
      the log still OUTRUNS the present set — a loss whose
      entry the log ALSO lacks is residual R-b; T4 detects
      a lost NEWEST archive precisely because its attested
      entry survives; nothing here claims detection of a
      loss that removed its own evidence). WRITE RULE (REV
      11 — RETRY-AWARE, see 4a(c)): a writer computes
      `hwm` = max(**the parser's epoch coverage state
      `last_hwm`** — REV 14 per cycle-12 major 1: NOT "hwm of
      the last VALID entry" read RAW: after a purge the last
      VALID entry is the purge record, whose `hwm` is AUDIT
      EVIDENCE and must NOT seed the fresh epoch's floor —
      the coverage state is 0 there and the two readings
      diverge; every writer site uses `last_hwm`, see the
      parser state machine), this
      rotation's `seq` being the other operand; if the newest VALID entry already
      attests this seq, the writer appends NOTHING
      (append-idempotence). Write path: open append-only (`O_APPEND|O_CREAT`, mode
      0600 on create, fsync dir on creation), write the full
      line, **fsync the file**. A failed append/fsync ⇒
      refuse `journal-rotate-attest-failed`. "ZERO BYTES"
      means PRECISELY WHAT REV 10 SAYS (cycle-8 major 6):
      the LEDGER, the JOURNAL, the SIDECAR, the ARCHIVES
      and the MARKER are UNTOUCHED — nothing to undo; the
      log itself is NOT zero-written in that refusal (a
      partial append may stand as a torn tail — which the
      next reader REFUSES per the torn-tail rule, and
      clearing it is whole-dir restore, not in-protocol).
      A SUCCESSFUL append followed by a crash before the
      rename HAS written a permanent log entry — by design
      (that is the point of attesting before publishing);
      "zero bytes" never claimed the log. fail closed — a
      rotation with no attestation must not publish.
      TORN-TAIL RULE, REV 10 (closes cycle-8 BLOCKER 2 and
      major 1; rev 9's "ignore the torn final line" is
      WITHDRAWN): a torn tail is NOT benign — it may be (i)
      an abandoned conforming append (crash mid-write) or
      (ii) LATER TRUNCATION/DAMAGE of a once-durable entry —
      possibly the ONLY `damage:true` witness — and the
      files cannot distinguish (i) from (ii). Worse, rev 9
      left a HOLE: the next `O_APPEND` would concatenate
      after the torn bytes, turning the tail into one
      malformed NON-trailing line that poisons the log.
      NORMATIVE: (a) THE PARSER (the rebuild reader and the
      rotation writer share ONE implementation — pinned):
      read line-by-line; every terminated line must parse
      and satisfy framing + monotonic `hwm` over the
      SEQUENCE INCLUDING purge-boundary resets (below); the
      final line, if unterminated, is the TORN TAIL. (b) IF
      A TORN TAIL EXISTS: it is the last bytes in the file
      ⇒ the only states are "abandoned append" or
      "post-durability damage". The reader REFUSES
      `carries-rebuild-attestation-gap` UNCONDITIONALLY
      (fail-closed: (ii) is a damage case and (i) costs
      only one bounded recovery). There is NO in-protocol
      truncation of the log (the no-delete posture extends
      to tail-editing); recovery = whole-state-dir restore
      (R-1 restore class, stated) — the residual is named,
      not papered. Consequently a subsequent rotation into a
      torn-tailed log CANNOT proceed (its parser refuses
      first) ⇒ the concatenation hazard cannot arise on any
      conforming path. Pin
      `rotation-attest-torn-tail-refuses`: torn final line ⇒
      rebuild AND rotation refuse; mutations: ignoring the
      torn line ⇒ RED;
      truncating the log to clear it ⇒ RED; AND the
      adversarial fixture the cycle-8 finding named: log
      whose ONLY `damage:true` entry is the torn tail ⇒
      rebuild refuses (never `damage:false`). (c) DUPLICATE
      / PURGE VALIDATION, fully specified (the parser state
      machine, single owner = the shared parser; REV 11
      RETRY RULE per cycle-9 MAJOR 1 — rev 10's write rule
      computed hwm = max(last_hwm, present)+1 UNCONDITIONALLY,
      so a re-entry retry recomputed the SAME seq but a
      HIGHER hwm and its own parser's equality test refused
      the very duplicate the text promised to accept):
      entries are consumed in file order maintaining
      `(epoch, last_hwm)`. A NORMAL entry: legal iff
      `hwm` >= last_hwm AND `hwm` <= max(last_hwm, `seq`)
      (the entry may raise the mark only up to its own seq —
      an entry claiming `hwm` ABOVE its seq out of nowhere
      is framing-violating); `seq` values MAY repeat
      (re-entry retry) iff every repeated `seq` carries the
      SAME `damage` value AND the same `hwm` — disagreeing
      duplicates ⇒ refuse (conflicting attestation). REV 12
      SCOPE (cycle-10 major 6): the duplicate-identity test
      applies ONLY WITHIN ONE EPOCH — `seq` reuse ACROSS a
      purge epoch boundary is EXPECTED (post-purge rotation
      recomputes seq from the then-empty archive set, so a
      fresh epoch's seq 1 legitimately coexists with a prior
      epoch's seq 1; no global non-reuse rule — post-purge
      reuse is the specified behavior) — a parser that
      compares a duplicate pair spanning two epochs is a
      framing bug the fixture set must catch (pin
      `cross-epoch-seq-reuse-legal` — REV 13 CORRECTED per
      cycle-11 major 2: every record COMPLETE per the
      canonical schema (all fields incl. `t`, see the
      grammar); REV 14 per cycle-12 major 2: THE DUPLICATE-
      SCOPE CONTROL (two fixtures, both schema-complete):
      fixture 1 — epoch 0
      `{"seq":1,"damage":true,"hwm":1,"t":100}` → purge
      `{"purge":true,"evidence":"e","hwm":1,"t":200}` →
      epoch 1 `{"seq":1,"damage":false,"hwm":1,"t":300}`
      parses CLEAN (same-seq reuse across the boundary);
      fixture 2 (NEW, the RESET-DISCRIMINATION control —
      hwm 1 tested NOTHING: BOTH the old inheritance rule
      and reset-to-zero accepted it; with pre-purge hwm 7
      the inheritance rule FAILS `1 >= 7` and reset-to-zero
      PASSES `1 >= 0`) — epoch 0
      `{"seq":7,"damage":true,"hwm":7,"t":100}` → purge
      `{"purge":true,"evidence":"e","hwm":7,"t":200}` →
      epoch 1 `{"seq":1,"damage":false,"hwm":1,"t":300}`
      parses CLEAN (under REV 13's
      last_hwm := 0 reset the epoch-1 entry is legal:
      1 >= 0 AND 1 <= max(0,1)); a parser that inherits the
      purge's hwm as coverage REFUSES fixture 2; the SAME two
      normal
      entries inside ONE epoch ⇒ refuse; an incomplete
      fixture (missing `t`) is ITSELF a framing violation —
      a pin whose fixture fails the grammar tests nothing).
      THE
      WRITER IS APPEND-IDEMPOTENT (the retry contract, one
      sentence, mirrored by the parser): before appending,
      the rotation writer parses (shared parser); if the
      newest VALID entry ALREADY attests the seq about to
      be appended (same seq, same damage), it appends
      NOTHING — the attestation exists, the crash left no
      ambiguity (hwm unchanged); otherwise it appends one
      entry with `hwm` = max(last_hwm, this rotation's
      `seq`) — monotone, never above its own seq, so a
      same-seq retry NEVER bumps and writer and parser
      cannot diverge (pin `rotation-retry-hwm-idempotent`:
      crash after attest-append before rename — note under
      the REV-12 recovery contract this retry scenario is
      the TORN-APPEND/pre-T4 case exercised as a PARSER +
      WRITER UNIT TEST over a log replica, not an E2E
      rotation (E2E the state refuses — R-c); assertions
      REV 12 CORRECTED per cycle-10 major 5: the parser-
      refusal oracle CANNOT catch an identical re-append
      (a same-seq/same-damage/same-hwm duplicate is
      parser-LEGAL by design) — the pin instead asserts
      THE LOG'S BYTES/ENTRY-COUNT ARE UNCHANGED by a
      re-entry append attempt (byte-equality oracle);
      separate case: a mutation that re-appends with a
      CONFLICTING damage or bumped hwm ⇒ the parse after
      re-entry refuses ⇒ RED). A PURGE entry
      (`{"purge":true,...,"hwm":<h>}`): legal iff `h` >=
      last_hwm; it RESETS coverage: `epoch` advances,
      last_hwm := 0 (REV 13, cycle-11 major 1: resetting to
      the purge's own hwm made the new epoch inherit a floor
      that BROKE the epoch-relative T4 test — a post-purge
      rotation at seq 1 is forced by the floor to append
      hwm=old-7, which then exceeds the largest present
      archive (seq 1) and the fresh epoch refuses its own
      legal first entry; the purge authorizes a FULL
      coverage restart, so the new epoch's floor is 0 — the
      purge entry's `hwm` field STANDS as the audit record
      of the pre-purge high-water, never as coverage), and
      T3/T4 coverage requirements
      restart after it (owner-authorized rearm, recorded
      forever; nothing deleted). First-entry `hwm` >= 0;
      any framing violation on a TERMINATED line ⇒ refuse
      `carries-rebuild-attestation-gap` (a hole is not a
      torn tail).
      ORDERING within step 5: preflight candidate validated ⇒
      ATTESTATION APPEND (4a) ⇒ `os.rename` ⇒ dir fsync ⇒
      marker (4b = the rev-8 marker act). Crash windows
      (REV 12 REWRITTEN per cycle-10 major 1 — rev 11
      PROMISED the abandoned rotation's own re-entry
      completes the rename at the SAME seq WHILE its own
      T4-pre-rename rule FORBIDS that rotation to proceed
      past the preflight: mutually exclusive contracts —
      THE RECOVERY CONTRACT FOR THIS WINDOW IS THE FAIL-
      CLOSED ONE: the abandoned act has NO in-protocol
      completion (residual R-c, named at T4, owner-exit
      placeholder Q-J2-h; resolution = WHOLE-DIR RESTORE,
      R-1 restore class; the Q-J2-h ruling may add a safe
      completion mechanism, not drafted): rebuild AND any
      rotation over this state REFUSE
      `carries-rebuild-attestation-gap` /
      `journal-rotate-attestation-gap`;
      the sentence "the resolution route is re-entry
      completing the act" is WITHDRAWN (it contradicted the
      pre-rename refusal — cycle-10 major 1); the same-seq
      DUPLICATE machinery survives ONLY as (i) the writer's
      append-IDEMPOTENCE test (below) and (ii) a crash
      DURING the append leaving a torn tail — re-entry
      there refuses too (torn tail, then R-c; REV 12
      availability note per cycle-9-B2(c) re-derivation:
      crash-during-attest and crash-after-attest are BOTH
      R-c deadlocks — stated as a residual, not glossed).
      A conforming FRESH rotation at a HIGHER seq than an
      abandoned one NEVER OCCURS (the pre-rename T4 check
      forbids any rotation over an outstanding gap — cycle-
      10 major 2's "does step 2/4 force a higher seq"
      resolved: step 2/4 computes from PRESENT archives,
      but row-(0)/pre-rename refusal gates it out first).
      REBUILD CONSULTS THE LOG BEFORE ANY REPLAY — AND SO
      DOES EVERY OTHER CARRIES-ADVANCING PATH (rev 10,
      closes cycle-8 BLOCKER 3: T1-T5 as rev 9 wrote them
      bound only REBUILD, while rotation RE-ENTRY with an
      absent/invalid sidecar performs FULL-CHAIN
      RECONSTRUCTION and writes a sidecar — a second
      carries-producing path that rev 9 left ungated):
      THE NORMATIVE SCOPE (REV 11 RE-SCOPED per cycle-9
      major 4 — rev 10's "every carries-advancing path"
      named rebuild + absent/invalid-sidecar
      reconstruction, while the crash matrix ALSO advances
      carries on a VALID-AND-STALE sidecar by replaying
      newer archives, and the canonical eligibility program
      is NOT applicable there (its row (1) refuses a
      CURRENT sidecar — but a rotation-in-flight
      completion must finish step 6/7 over a sidecar that
      is current-by-construction): TWO separate obligations,
      never conflated — (O1) ATTESTATION PREREQUISITE
      (parser + T1-T5 + in-flight check): runs on EVERY
      path that composes or replaces carries from archive
      replay OR writes the sidecar — enumerated: rebuild
      full-chain replay; rotation re-entry reconstruction
      under absent/invalid sidecar; rotation STALE-SIDECAR
      replay of newer archives (crash matrix); post-purge
      fresh rotation (epoch-relative, see T4 operand);
      (O2) THE ELIGIBILITY ALGORITHM: an OPERATOR-SIDE
      PROGRAM deciding rebuild INVOCATION ONLY (its rows
      classify fleets, not in-flight completions — a
      rotation past the preflight stage is NOT re-
      classified mid-act). The rotation's own preflight
      consults (O1) plus its T4-pre-rename check (above);
      it does not run rebuild's row ladder. Pin
      `rotation-reentry-attest-gate` (kept); pin
      `rotation-stale-replay-attest-gate` (REV 11, new):
      stale-sidecar rotation whose log fails T1-T5 refuses
      BEFORE composing (mutation composing ungated ⇒ RED);
      pin `rotation-completion-current-sidecar-proceeds`:
      crash-matrix completion over the candidate sidecar
      (already renamed at (6)) does NOT re-run (O2) row
      (1) (mutation that bricks completions by refusing
      `carries-rebuild-not-needed` mid-completion ⇒ RED).
      Propagates T5's damage
      OR into whatever it writes.
      (T1) log ABSENT while any archive is PRESENT ⇒ refuse
           `carries-rebuild-attestation-missing` (zero
           bytes): under ratification there are NO
           pre-existing archives (no code ships before it),
           so absence-with-archives is log loss or a forged
           archive set — never "old fleet, new code";
      (T2) any TERMINATED line fails to parse or violates
           framing/monotonicity ⇒ refuse
           `carries-rebuild-attestation-gap`; TORN TAIL ⇒
           refuse per the REV-10 rule (b) above (rev 9's
           ignore-the-tail rule is WITHDRAWN);
      (T3) any PRESENT archive whose seq has NO entry (in
           the current post-purge epoch) ⇒ refuse
           `carries-rebuild-attestation-gap` (archive
           without attestation = forgery or log damage);
      (T4) HIGH-WATER TEST (closes cycle-7 BLOCKER 2 — the
           suffix-loss detector; REV 10 NARROWS THE
           EXCEPTION per cycle-8 BLOCKER 1; REV 10 defines
           the EMPTY-SET case here (once, operative): with
           the archive set empty, "largest PRESENT seq" is
           UNDEFINED — the test becomes 0 < `hwm`: an
           all-archives-gone fleet trips T4 unless an
           authorized purge epoch-reset covers it — route
           Q-J2-f; see ELIGIBILITY ALGORITHM row (2)):
           largest
           PRESENT archive seq < **the epoch-relative T4
           operand — max `hwm` over VALID entries SINCE the
           last PURGE entry (the parser's epoch coverage
           state; REV 15 per cycle-13 major 1: NOT "`hwm`
           of the newest VALID entry" read raw — after a
           purge the newest VALID entry is the purge record
           and its raw hwm must NOT trip the fresh epoch;
           an epoch with NO post-purge normal entry has
           coverage 0 and performs NO T4 test)** ⇒ a
           rotation attested an archive that is
           no longer there ⇒ refuse
           `carries-rebuild-attestation-gap` (zero bytes).
           REV 11: THE ENTIRE T4 EXCEPTION IS WITHDRAWN
           (cycle-9 BLOCKER 1: rev 10's journal-present
           narrowing FAILS — a COMPLETED rotation's step-7
           EMPTY journal is indistinguishable from an
           abandoned attempt's still-present journal, so
           journal PRESENCE proves nothing about publication;
           the completed rotation whose archive 4 was lost
           then rebuilt CLEAN from 1-3 = the exact rearm
           T4 exists to block). NORMATIVE: ANY state where
           `hwm` exceeds the largest PRESENT archive seq —
           INCLUDING seq==hwm with no archive, journal
           present or absent — REFUSES
           `carries-rebuild-attestation-gap` (fail-closed
           on BOTH indistinguishable histories — cycle-9
           minor 2 alignment; an abandoned rotation is NOT
           excused at rebuild AND NOT excused at rotation
           either: REV 11 extends T4 to the ROTATION path
           as a PRE-RENAME check — if the epoch-relative
           `hwm` of the log EXCEEDS the largest PRESENT
           archive seq, the rotation REFUSES
           `journal-rotate-attestation-gap` BEFORE its
           attest/rename acts, zero bytes — cycle-9 major
           4's sweep showed a rotation that mechanically
           renames over the gap FABRICATES a substitute
           archive at the lost seq (empty journal renamed
           to archive N+1 where the lost archive 4 lived) =
           silent intent loss = the exact rearm; the ONLY
           sound reading fails closed on both). NAMED
           RESIDUAL (REV 11, R-c): an abandoned rotation
           (attest durable, rename never run) therefore
           has NO in-protocol completion — the fleet
           deadlocks at a T4 gap (refusing rotation AND
           rebuild) until WHOLE-DIR RESTORE (R-1 restore
           class, same as the torn tail; availability loss
           on a rare crash state, the safe direction); if
           the owner wants a protocol exit this is a NEW
           owner call (placeholder **Q-J2-h**, NOT drafted
           — naming is not drafting). Epoch-relative T4
           operand (REV 11, resolves the post-purge
           rotation question cycle-9 major 4 forced): the
           comparison hwm = max `hwm` over VALID entries
           SINCE the last PURGE entry (coverage restarts
           after a purge, stated above); an epoch with NO
           post-purge entry performs NO T4 test; a fresh
           post-purge rotation therefore proceeds normally
           (its seq/hwm live in the new epoch). Pin
           `rebuild-t4-gap-refuses-unconditional` (REPLACES rev 10's
           `rebuild-t4-exception-needs-journal`, WITHDRAWN
           WITH ITS TEST — cycle-9 major 5: that pin
           affirmatively required the unsafe proceed):
           seq==hwm, no archive, journal PRESENT ⇒ refuse;
           same journal ABSENT ⇒ refuse; mutations:
           proceed-on-journal-present ⇒ RED; proceed-on-
           seq==hwm ⇒ RED. Rev 8's (i)-(iii) survives as
           the honest statement of the residual (now the
           NAMED residuals R-a/R-b above); a partial restore
           dropping the log trips T1, dropping archives
           trips T4 — the log turns rev 8's UNSIGNALLED
           partial-restore state into a DETECTED one;
           the "claimed power" passage below is aligned to
           EXCLUDE the withdrawn case (an UNCONDITIONAL
           single-archive loss at the newest seq with the
           log intact is DETECTED by T4's gap — always
           refused, never excused);
      (T5) DAMAGE SURVIVAL (closes cycle-7 BLOCKER 1): the
           rebuilt sidecar's `damage` = OR of the prior
           sidecar's flag (if readable) and EVERY VALID
           entry's `damage` in the log (post the last purge
           entry — an owner-authorized rearm resets the
           witnessed past BY RULING, recorded forever) —
           history the sidecar lost, the log still holds —
           UNDER the REV-10 torn-tail refusal (a damaged
           tail never reaches T5; it refuses). The flag's
           condition is OBSERVABLE: cycle-7 major 5
           correctly rejected a pin testing a metaphysical
           "EVER recorded damage"; the pin tests what the
           log PROVES, and cycle-8 major 2's witness-loss
           route is closed by the tail refusal, not
           bypassed by ignoring it.
      PURGE INTERACT (Q-J2-f f1; REV 10 RE-SEQUENCED per
      cycle-8 major 2 — rev 9 made the purge ENTRY the
      FIRST durable act, so a crash or later log failure
      left an owner-authorized REARM recorded for a purge
      that never completed, with no abort semantics):
      NORMATIVE ORDER under the exclusion lock — (1) verify
      eligibility re-checked (marker present, sidecar
      absent/invalid, archive set EXACTLY EMPTY — T3
      coverage is trivially satisfied at an empty set: no
      PRESENT archive lacks coverage; purge does NOT run
      the T-GATES (they would refuse an empty archive set's
      missing coverage — they don't apply), BUT REV 11
      (cycle-9 BLOCKER 2): purge's WRITE PATH to the
      attestation log MUST first run the SHARED PARSER over
      the WHOLE attestation log — a torn tail, a framing
      break, or ANY parse failure ⇒ refusal
      `purge-attest-log-refused` (zero bytes anywhere: no
      recovery-log record, no purge entry, marker stands) —
      the rotation writer's "the parser refuses first" rule
      binds EVERY writer of that log, and purge is a writer
      of it; appending past a torn tail would concatenate
      onto the possibly-sole `damage:true` witness exactly
      as cycle-9 named. Pin
      `purge-attest-torn-log-refuses` (canonical name —
      cycle-10 minor 2: the earlier draft spelled this pin
      `purge-torn-attest-log-refuses`; that spelling is
      WITHDRAWN, one pin one name): attestation log with
      torn final line + purge-eligible fleet ⇒ purge
      refuses, neither log changed, marker stands;
      mutation appending past the tail ⇒ RED. The
      T4-empty-set semantics for rebuild/rotation
      readers are defined in ELIGIBILITY ALGORITHM row (2);
      the log may hold any
      VALID past, which is exactly what the purge
      epoch-resets); (2) write the recovery-log `attempted`
      record (framing below; REV 12: the ONE canonical
      recovery-log schema is the GRAMMAR's entry (b) below —
      the FRAMING block's field list at the command
      definition is its prose restatement and cycle-10
      major 3's `cmd`-value divergence
      (`"purge-rotation-marker"` vs `"purge"`) is resolved
      HERE: the canonical `cmd` value is the LITERAL
      `"purge"` (the grammar's value wins — the exact
      schema is the authority; the prose restatement's
      `"purge-rotation-marker"` is WITHDRAWN as a name,
      its descriptive intent recorded here once);
      `evidence` is on the `attempted` record only,
      `attest_seq` on `committed` only — the prose list
      carries both because it describes BOTH phases);
      (3) append the
      purge entry `{"purge":true,"evidence":"<asserted>",
      "hwm":<current hwm>,"t":<int>}` to the attestation log
      and fsync (REV 12: `t` required, matching the grammar);
      (4) unlink the marker, THEN dir fsync (the two acts
      have SEPARATE failure outcomes — cycle-10 major 3,
      see FAILURE/RESUME CONTRACT); (5) write
      the recovery-log `committed` record + fsync.
      CRASH RULES (REV 11 REWRITTEN per cycle-9 majors 2/3 —
      rev 10's rule "a purge entry followed by a
      still-PRESENT marker ⇒ in-flight" MISCLASSIFIES every
      COMPLETED purge once a later rotation recreates the
      marker, and its resume clause contradicted (1)):
      PARSER RULE (operative): the log is "purge-in-flight"
      iff the LAST VALID ENTRY is a purge entry AND the
      marker is PRESENT (a completed purge is superseded:
      any later normal entry closes it permanently — pin
      `purge-complete-then-rotate-not-inflight`: purge →
      fresh rotation → **the purge-in-flight GATE CLEARS
      (rebuild AND rotation do NOT refuse
      `carries-rebuild-attestation-purge-in-flight`); the
      commands' DOWNSTREAM eligibility outcomes (possibly
      `carries-rebuild-not-needed` or a trigger-gate
      refusal) are NOT asserted by this pin — REV 17 per
      cycle-15 major 2, replacing the unqualified
      "rebuild/rotation proceed"; REV 18 per post-rev-17
      review: the binding is the pin's TWO-CHECK set
      (gate-clearance PLUS end-to-end absence of the
      in-flight refusal CODE), NOT a gate-only one — the
      "gate-only" shorthand was WITHDRAWN as
      under-describing; one fixture shared with
      `purge-in-flight-refuses`**,
      mutation: any predicate keying on "ANY purge entry +
      marker" produces the in-flight refusal on this
      fixture ⇒ RED — at the gate OR downstream (REV 17
      per cycle-15 major 3: the assertion is
      OBSERVABLE-COMPLETE on the refusal CODE: neither
      command RETURNS the in-flight code anywhere on the
      fixture path, while its legitimate eligibility or
      trigger outcome is allowed — so a mutant that passes
      the instrumented gate but re-applies the ANY-purge
      rule later and emits the in-flight code is STILL
      RED)**, while
      in-flight, rebuild AND rotation REFUSE
      `carries-rebuild-attestation-purge-in-flight`.
      WRITER IDEMPOTENCE (purge's mirror of the rotation
      retry rule): a purge invocation whose re-check (1)
      passes with the log's last VALID entry ALREADY a
      purge entry (crash-retry between (3) and (4)) does
      NOT append a second purge entry — it proceeds from
      (4) (marker-gone case below; marker-present case —
      REV 14 per cycle-12 minor 1: the re-unlink SUCCEEDS,
      the marker is there to be removed (the earlier "ENOENT
      ⇒ treat as done" misdescribed this branch — ENOENT is
      the marker-GONE case, not this one) and the invocation
      continues through 4b).
      FAILURE/RESUME CONTRACT (cycle-9 major 3; REV 12
      SPLIT per cycle-10 major 3 — step (4) is TWO acts
      with OBSERVABLY different states): step-(2) or -(3)
      failure ⇒ `purge-log-failed`/
      `purge-attest-log-refused` NOTHING UNLINKED (true —
      unlink is (4), after both log acts; the recovery log
      may hold a torn attempted-tail per the dialect —
      whole-dir restore class); step (4a) UNLINK failure ⇒
      `purge-io`, marker state exactly as found, epoch
      entry stands in-flight (resolvable by retry per the
      idempotence rule); step (4b) DIR-FSYNC failure AFTER
      a SUCCESSFUL unlink ⇒ the marker is GONE in the
      directory NOW — NAMESPACE-VISIBLE / DURABILITY-PENDING
      (REV 15 per cycle-13 major 3: the rev-14 assertion the
      unlink is "durable in the filesystem irrespective of
      the failed fsync" CONTRADICTS the next clause and the
      AUTH bound's discipline — a failed dir fsync cannot
      establish survival of power loss; after power loss the
      marker MAY RETURN: the fsync-
      lost window — same discipline as the AUTH
      `auth-recover-io` row): report `purge-io` WITH the marker-
      OBSERVATION in the error context (marker-absent =
      purge DE FACTO complete-minus-durability — parser
      sees last entry = purge + marker ABSENT ⇒ COMPLETE;
      marker-returned after power loss = in-flight again ⇒
      retry per the idempotence rule resolves it — REV 13
      per cycle-11 minor 3: on this branch the marker is
      PRESENT, so the retry's re-unlink SUCCEEDS (ENOENT
      describes the DIFFERENT observation — the marker-
      gone branch where (1) sees marker-absent; the
      idempotence rule's "proceeds from (4)" covers it);
      NO blanket claim in either
      direction beyond the observation (cycle-10 major 3:
      rev 11's "marker state exactly as found" was FALSE
      for 4b — it now names the two acts separately, and
      the retry contradiction `purge-ineligible-no-marker`
      CANNOT fire against a completed purge: eligibility
      refusal is the CORRECT answer to a fresh purge
      request, while the crash-recovery route IS the
      parser state, not the command);
      failure at step (5) (committed append) occurs AFTER
      the rearm is DE FACTO (marker gone, parser sees last
      entry = purge + marker ABSENT ⇒ COMPLETE, NOT in-
      flight) ⇒ the command reports
      `purge-commit-log-failed` as a COMPLETED-purge-with-incomplete-audit
      outcome (rearm effective; the dangling attempted is
      readable evidence; NO rollback — cycle-9 major 3:
      rev 10's blanket "nothing unlinked" for
      `purge-log-failed` was FALSE past (4) and is
      WITHDRAWN beyond steps (2)-(3)). Resume identity:
      no resume STATE — every invocation is fresh (1)-(5)
      with the two idempotence rules above; "marker-
      already-gone at (1)" is NOT a refusal of the purge
      command by the crash clause any more — it means no
      in-flight purge to resume ⇒ eligibility refusal
      `purge-ineligible-no-marker` (zero bytes). The
      `attest_seq` FIELD MOVES from the `attempted` record
      to the `committed` record (cycle-9 major 3: an
      attempted record written at (2) cannot record the
      offset of an entry appended at (3) — undefined
      reference; attempted keeps `t`, `cmd`, `phase:
      "attempted"`, `marker_mtime`, `dir_listing`;
      committed adds `phase:"committed"` + `attest_seq` =
      the byte offset of the purge entry read back from
      the log after (3)'s fsync). Purge entry validity
      (parser): `hwm` >= last_hwm. **EPOCH TRANSITION IS
      UNCONDITIONAL (REV 17 per cycle-15 major 1: every
      valid purge entry — and ONLY validity is required —
      advances the epoch and resets last_hwm := 0, matching
      the grammar's sentence word-for-word; the rev-15
      phrasing "coverage restarts after it ONLY in
      combination with the marker-absent test" is
      WITHDRAWN — marker presence NEVER gates the parser's
      epoch state: it gates the COMMANDS only (the
      purge-in-flight refusal at the eligibility gate), and
      a durable purge entry with the marker still present
      is BOTH a fresh coverage-0 epoch IN THE PARSER AND
      an in-flight refusal AT THE COMMAND GATE — two
      separate mechanisms, never one conditional on the
      other.**
      UNIFIED LOG FRAMING DIALECT (rev 10, closes cycle-8
      major 2's framing divergence — THREE durable logs now
      exist in the spec (journal, attestation, recovery);
      ONE dialect, pinned — QUALIFIED LOCALLY AT THE
      INTRODUCTION (REV 17 per cycle-15 minor 2): the
      dialect's APPEND-TIME rules bind the TWO NEW logs
      (attestation, recovery) ONLY — the shipped journal
      parser governs the journal and archives UNCHANGED
      (see (c) JOURNAL BY REFERENCE below; stating the
      exception here, not only at (c), so the "THREE logs
      ... ONE dialect" lead-in is read correctly at first
      contact); every entry TERMINATED by
      `\n`; every TERMINATED line on append-time read must
      parse or the reader refuses (a hole is never skipped);
      a TORN TAIL is NEVER concatenated past and NEVER
      ignored where it could carry a witness — the reader
      refuses (rev 9's recovery-log "preserve the torn
      tail and append a complete line after it" is
      WITHDRAWN: that recipe produces the concatenated
      malformed line cycle-8 named; the recovery-log adopts
      the SAME rule — torn tail refuses; recovery proceeds
      only after whole-dir restore). Attempt/commit pair
      records (`attempted`/`committed`, purge only) are
      normal entries distinguished by a `"phase"` field.
      GRAMMAR, COMPLETE (REV 11, closes cycle-9 major 6 —
      per-file existence/empty/epoch semantics GIVEN, not
      inferred): (a) ATTESTATION LOG — a file that does not
      exist is the LEGAL INITIAL STATE (no entries yet); a
      ZERO-BYTE file parses as the EMPTY SEQUENCE (legal;
      T1's archives-present case still refuses via missing-
      coverage T3, T4 no-op at hwm 0); a file whose ONLY
      line is unterminated is a TORN TAIL ⇒ every reader
      refuses (empty-sequence treatment would erase the
      witness — the cycle-8 blocker-2 state); entry grammar
      EXACTLY: normal `{"seq":<int>=rotation seq,"hwm":<int>,
      "damage":<bool>,"t":<num>}` — all four fields
      REQUIRED, exactly one occurrence each, duplicate keys
      ⇒ framing violation (refuse), extra keys ⇒ framing
      violation, type mismatch ⇒ framing violation; `t`'s
      domain (REV 12, closes cycle-10 minor 4): unix-epoch
      time as a JSON number, REQUIRED to be a finite, non-
      negative INTEGER (cycle-10 minor 4, TERMINOLOGY CORRECTED
      REV 13 per cycle-11 minor 2: `true`/`false` are NOT
      "JSON numbers syntactically" — they are distinct JSON
      literals (`true`/`false`), not numbers at all; the
      REJECTION stands and is correct: a boolean in any
      field is a type mismatch ⇒ framing violation; NaN/Infinity are
      NOT valid JSON and any tolerant parser producing them
      is out of contract; a fractional value is a type
      mismatch ⇒ framing violation); purge
      `{"purge":true,"evidence":<string>,"hwm":<int>,
      "t":<num>}` — same strictness (incl. `t`'s domain); there is NO
      "seq-optional" operand (rev 10's phrase referred to
      nothing — WITHDRAWN: purge entries have NO seq field,
      normal entries REQUIRE one; the parser dispatches on
      the `purge` key). EPOCH transitions: epoch 0 starts
      at file creation; every VALID purge entry advances
      the epoch by 1 and resets last_hwm := 0 (REV 13,
      cycle-11 major 1 — "its hwm" inherited a floor that
      broke the fresh epoch's first entry; the purge's own
      hwm survives as the audit record only; coverage/T4
      restart, stated above). (b) RECOVERY LOG
      — same framing + torn-tail refusal; entry (REV 12 =
      THE ONE CANONICAL SCHEMA per cycle-10 major 2 — the
      command-definition prose defers here):
      `{"t":<int>,"cmd":"purge","phase":"attempted"|
      "committed","marker_mtime":<string>,"dir_listing":
      <string>}` + `"evidence":<string>` on ATTEMPTED only
      + `"attest_seq":<int>` on COMMITTED only (rev 11 field
      move; the offset is read back from the attestation log
      AFTER step (3)'s fsync); attempted/
      committed pairing is ADVISORY AUDIT (not a parse gate:
      a dangling attempted is readable evidence, a
      committed without attempted parses fine); zero-byte
      file = empty sequence; absent file = never-purged
      (legal). (c) JOURNAL BY REFERENCE ONLY — the shipped
      journal parser (bounded lines, strict schema,
      `journal-unreadable` channel, `ledger.py` ~537-610)
      governs archives and the live journal UNCHANGED; the
      dialect's append-time rules apply to the TWO NEW logs
      only; "one dialect" claims framing + torn-tail
      refusal + no-skip sharedness, and claims NOTHING
      about altering journal read behavior (rev 10's
      overreach corrected).
      PINS (rev 9 set, REV 10-CORRECTED; all OBSERVABLE per
      the cycle-5 rule, concrete fixtures per cycle-8 major
      5 — each names its fixture, its asserted observable,
      and its mutation):
      - `rotation-writes-attestation`: fixture = healthy
        rotate; observable = log gains the seq entry
        BEFORE the archive exists (hook-order assert);
        mutation skipping the 4a append ⇒ RED;
      - `rotation-attest-torn-tail-refuses` (replaces rev
        9's `…-ignored` — WITHDRAWN per the torn-tail
        rule): fixture = log with unterminated final line;
        observables = rebuild refuses AND the next rotation
        refuses AND the ONLY-true-entry-torn fixture never
        yields `damage:false`; mutations: ignore-the-tail ⇒
        RED; truncate-to-clear ⇒ RED;
      - `rebuild-attest-gap-refuses`: T3 fixture = archive
        seq N present, no entry N (post-epoch); T4 fixture
        = archives 1-3 present + journal PRESENT-deleted?
        NO — T4 suffix fixture = archives 1-3 + journal
        ABSENT + log hwm 4 ⇒ the named refusal (the
        cycle-8 blocker-1 state); admission ⇒ RED;
      - `rebuild-t4-gap-refuses-unconditional` (REV 11 —
        REPLACES `rebuild-t4-exception-needs-journal`,
        WITHDRAWN WITH ITS TEST per cycle-9 blocker 1: the
        old pin AFFIRMATIVELY REQUIRED the unsafe proceed on
        journal-PRESENT; fixtures = seq==hwm, no archive
        for it, journal PRESENT (the conforming empty
        journal of a completed rotation) ⇒ refuse; same
        with journal ABSENT ⇒ refuse; mutations:
        proceed-on-journal-present ⇒ RED; proceed-on-
        seq==hwm ⇒ RED);
      - `rebuild-attest-missing-refuses`: archives present,
        log absent ⇒ T1 refusal; admission ⇒ RED;
      - `rebuild-damage-from-log-only`: the cycle-7
        blocker-1 attack — CONCRETE FIXTURE per cycle-8
        major 5: archives 1-3 valid chain, log entries 1-3
        with entry 2 `damage:true`, prior sidecar REPLACED
        by a clean VALID-AND-STALE one (source_archive
        pointing at an existing OLDER archive, so the
        eligibility ladder reaches row (3) — a CURRENT
        replacement would refuse at row (1) and the pin
        would vacuously pass); observable = rebuild output
        `damage:true`; `damage:false` ⇒ RED;
      - `rotation-reentry-attest-gate` (rev 10, closes
        cycle-8 blocker 3): rotation re-entry with absent/
        invalid sidecar over archives whose log fails T1-T5
        (fixture: log missing entry for a present archive)
        ⇒ re-entry REFUSES to write the reconstructed
        sidecar; mutation: re-entry reconstructs ungated ⇒
        RED;
      - `purge-appends-attestation`: purge observable =
        purge entry present AND paired attempted/committed
        records in the recovery log; mutations: unlink
        without purge entry ⇒ RED; entry appended but
        crash-window variant — purge entry recorded, marker
        GONE ⇒ COMPLETE (rev 11: NOT in-flight — the rev-10
        marker-present fixture MOVED to
        `purge-in-flight-refuses` below);
      - `purge-attest-torn-log-refuses` (REV 11, closes
        cycle-9 blocker 2): fixture = attestation log whose
        LAST (only) unterminated entry is the sole
        `damage:true` witness, purge otherwise eligible ⇒
        purge refuses `purge-attest-log-refused`;
        observables = neither log gained a byte, marker
        stands, witness survives for the next reader;
        mutations: purge appends past the torn tail ⇒ the
        concatenated line and witness loss ⇒ RED; purge
        truncates-to-clear ⇒ RED;
      - `purge-in-flight-refuses` (REV 11; REV 15 REWORKED
        per cycle-13 major 4 — the fixture AS LAST STATED
        CANNOT RED the ANY-purge-entry mutant: with last
        entry = purge, the mutant "key on ANY purge entry +
        marker" ALSO refuses, so the named mutation is not
        discriminated by this fixture alone): the pin is
        TWO asserted states — (i) last valid entry = purge
        AND marker PRESENT ⇒ rebuild AND rotation refuse
        `carries-rebuild-attestation-purge-in-flight` (the
        uncommitted-rearm pin; mutation: admission ⇒ RED);
        (ii) the EXPLICIT POSITIVE CONTROL ASSERTED IN THIS
        PIN (REV 16 REWORKED per cycle-14 major 2; REV 17
        extended per cycle-15 major 3; REV 18 relabelled
        per post-rev-17 review — rev 16's phrasing
        "AT THE GATE ONLY" is RETAINED ONLY AS ITS
        HISTORICAL STEP and is WITHDRAWN as the
        assertion's NAME): the completed-purge state is
        purge entry → a LATER normal rotation entry →
        marker PRESENT, and the ASSERTION IS A TWO-CHECK
        SET — CHECK 1 (gate clearance): rebuild AND
        rotation CLEAR the purge-in-flight check (do NOT
        refuse
        `carries-rebuild-attestation-purge-in-flight` at
        the gate) and then CONTINUE TO THEIR OWN
        eligibility outcome, which MAY be
        `carries-rebuild-not-needed` (valid current
        sidecar) or the trigger-gate refusal — those
        downstream ELIGIBILITY outcomes are NOT asserted;
        CHECK 2 (end-to-end refusal-code absence, REV 17):
        NEITHER command RETURNS
        `carries-rebuild-attestation-purge-in-flight`
        ANYWHERE on this fixture path — at the gate OR
        later — so a mutant that passes the instrumented
        gate yet re-applies the ANY-purge rule downstream
        and emits the in-flight code is RED; what remains
        unasserted is ONLY the legitimate eligibility/
        trigger outcome): asserting unqualified "PROCEED"
        made the
        fixture unsatisfiable, since a valid-sidecar state
        refuses at row (1) under BOTH the correct rule and
        the mutant, pinning nothing): the ANY-purge mutant
        refuses AT THE GATE ⇒ RED here, the correct rule
        passes the gate ⇒ GREEN; the SAME state, fixture
        and TWO-CHECK assertion set (CHECK 1 + CHECK 2 —
        never the withdrawn "gate-only" shorthand alone,
        which would drop exactly the CHECK 2 mutant the
        cycle-15 major named) are SHARED with
        `purge-complete-then-rotate-not-inflight` — ONE
        fixture, ONE assertion set, both pin names bound to
        it (two drifting fixtures for one control is the
        maintenance trap this binds shut):
  5. PREFLIGHT + RESTRUCTURE (rev 4, cycle-2 major 4): compose
     the CANDIDATE sidecar from (prev carries, the journal bytes
     read in step 3 — same under-lock bytes), applying b1 replay
     + damage + identity-set rules; validate against the b1
     grammar INCLUDING the size cap (Q-J2-e); over-cap ⇒ refuse
     `journal-carries-oversize`, ZERO bytes INCLUSIVE OF THE
     LOG (the refusal PRECEDES the 4a append — unlike the
     attest-failure refusal above, nothing anywhere is
     written), journal UNTOUCHED.
     Only then (rev 9: after the 4a ATTESTATION APPEND is
     durable — candidate validated, log appended+fsynced):
     `os.rename` journal → archive name; apply the
     Q-J2-a mode chmod under a1; **fsync the DIRECTORY**
     (rev 8: archive entry made durable BEFORE the marker);
     THEN create the MARKER + fsync its fd (rev 8 ordering —
     attest, rename, dir fsync, marker; see MARKER). Bytes
     are archived VERBATIM (R-1).
  6. Write the candidate (validated in 5) to temp
     `journal-carries.tmp-rotate` (0600, checked write + fsync),
     `os.rename` over the sidecar, fsync the DIRECTORY (the
     journal is never created before the sidecar replacement is
     dir-synced). A pre-existing `journal-carries.tmp-rotate` at
     command start is the command's own discarded temp ⇒ removed
     before writing; readers open only the fixed sidecar name.
  7. Create the new journal EMPTY (0 bytes, 0600), fsync the
     directory.
  ZERO-BYTE CLAIMS, PER-BOUNDARY PERSISTED-STATE ENUMERATION
  (rev 10, closes cycle-8 major 6; REV 11 EXTENDED per
  cycle-9 major 5 — every "zero bytes" claim in this spec
  means: NO CHANGE to the enumerated persisted state at that
  boundary; the enumeration is GIVEN, never left to
  inference; six records: journal, sidecar, marker, archive
  set, attestation log, recovery log). BYTES vs METADATA
  (cycle-9 major 5): "zero written BYTES" never implied zero
  METADATA acts — step 0's MODE-REPAIR chmod (archive mode
  only, idempotent completion of an interrupted transition)
  may legitimately run BEFORE any later refusal and its
  effect persists; every row below means BYTES of record
  CONTENT, mode-repair excepted and stated per row.
  - rotation refusals at steps 1-3
    (`journal-rotate-pending-window`, `-seq-ambiguous`,
    sidecar-reconstruct refusals):
    ALL SIX records' CONTENT unchanged (nothing written
    anywhere); step 0's mode-repair chmod may have run and
    STANDS (metadata only — the sweep completes an
    interrupted transition; refusing afterwards does not
    undo it, stated per cycle-9);
  - step 4 `journal-rotate-target-exists` and step 4a REV-11
    pre-rename `journal-rotate-attestation-gap` (REV 11 rows,
    cycle-9 major 5 demanded coverage): ALL SIX unchanged —
    both refusals fire BEFORE the attest append and the
    rename (the gap check is a READ-then-refuse; target-
    exists is a name check); step 0's chmod as above;
  - step 4a `journal-rotate-attest-failed`: journal, sidecar,
    marker, archive set UNCHANGED (nothing to undo); the
    ATTESTATION LOG may hold a partial torn tail (rev 10
    wording above — next reader refuses; clearing = whole-dir
    restore); recovery log untouched;
  - step 5 `journal-carries-oversize`: ALL SIX unchanged
    (refusal PRECEDES the 4a append — rev 9 wording kept;
    cycle-9 minor 2 precision: a SUCCESSFUL 4a append
    followed by a later pre-rename crash is NOT a zero-byte
    state — the log holds a permanent entry BY DESIGN, and
    the T4-gap refusal it produces is the detection, not a
    violation of any zero-byte claim; no claim anywhere
    states zero bytes ACROSS a durable attest);
  - purge refusals BEFORE the unlink (`purge-log-insecure`,
    `-log-failed` at steps (2)-(3),
    `purge-attest-log-refused` (rev 11),
    `purge-ineligible-no-marker` (rev
    11), `purge-io` at step 4a UNLINK): journal, sidecar,
    archive set unchanged; the marker is NOT unlinked (this
    row covers steps (1)-(4a) — REV 12 per cycle-10 major 4
    (and major 3 for the 4b row below): past (4) there is
    NO `purge-log-failed`; step-(5) failure is
    `purge-commit-log-failed`
    = COMPLETED purge, rearm effective, NOT a zero-byte
    claim anywhere); attestation log unchanged for the (1)
    -refusals, torn-tail-possible for a (3) `-log-failed`;
    recovery log: unchanged for `-insecure`/eligibility,
    torn-tail-possible for `-log-failed` (same rule as
    attest-failed);
  - purge step-4b DIR-FSYNC failure after a SUCCESSFUL
    unlink (REV 12, cycle-10 major 3): the marker is GONE
    in the running system (durable-enough: purge is DE
    FACTO complete bar audit); on power loss inside the
    fsync-lost window the unlink may NOT survive and the
    marker can RETURN ⇒ parser sees in-flight, retry
    resolves via idempotence — bytes: the attestation purge
    entry STANDS (already fsynced at (3)); NO row anywhere
    claims zero bytes for a 4b state (marker-absent =
    completed purge, marker-returned = in-flight — both
    are persisted-state outcomes with the entry present,
    reported by observation in the `purge-io` error
    context);
  - rebuild refusals (`carries-rebuild-*`, all T-gates): ALL
    SIX unchanged (rebuild writes only on SUCCESS — the
    replaced sidecar is its single mutation, published
    atomically by rename + dir fsync; step 0's chmod row
    applies to rebuild invocations too — same sweep);
  - reader refusals (R3, N1-N6 classes): file-system
    untouched by definition — a reader never writes AND
    never runs step 0 (readers are not operator commands;
    cycle-9 precision) (the shipped invariant, restated in
    the enumeration).
  S-A1 CROSS-REFERENCE (cycle-9 major 5; REV 14 per
  cycle-12 major 3: the rev-13 withdrawal to
  NAMESPACE-VISIBLE / DURABILITY-PENDING did NOT reach this
  cross-reference — it still said "stated as durable", the
  SAME propagation class a fourth cycle running): S-A1's
  zero-byte claims get the SAME two disciplines — its
  `auth-recover-io` is bounded below (unexpected I/O error
  AFTER the fresh-file rename completed is a COMPLETED
  recovery whose follow-up failed, reported
  `auth-recover-io` with the rename NAMESPACE-VISIBLE and
  DURABILITY-PENDING per the universal fault contract — the
  failed dir fsync cannot establish survival of power loss;
  re-run route: the next invocation re-runs the recovery
  idempotently — never "zero bytes", NEVER "durable"), and its
  step-0 mode-repair chmod runs-and-stands identically
  (stated at its site).
  I/O FAULT CONTRACT (rev 4, both command classes): every
  invocation performs exactly ONE directory fsync at ENTRY under
  the lock (zero bytes; the "zero bytes" promise means zero
  WRITTEN bytes, never "zero syscalls"). A failed fsync after a
  successful rename is NOT "the filesystem is unchanged": the
  refusal is `journal-rotate-io`, the state is durable-pending,
  and ANY later successful fsync of the directory retires it —
  in practice guaranteed because EVERY later invocation of
  either operator command fsyncs at entry (rev 5 minor-1
  wording: summary aligned — it is reentry THAT PROVIDES the
  completion mechanism, not the only conceivable fsync;
  startup access checks are metadata-only and NEVER fsync — the
  rev-3 "completed by the next startup's checks" claim stays
  withdrawn). A crash BEFORE any rename is zero WRITTEN bytes
  to every PERMANENT record with NO EXCEPTION EXCEPT THE 4a
  ATTESTATION APPEND (REV 13, cycle-11 major 3: the sentence
  is about the SIDECAR/ARCHIVE/MARKER/JOURNAL/LEDGER/AUTH
  six, and held only when the attestation log did not exist —
  rev 9 added step 4a BEFORE the rename whose SUCCESSFUL
  append is a permanent write BY DESIGN: a crash after a
  durable 4a append leaves the entry in the log (the T4-gap
  / R-c state, NOT a zero-byte violation — see the zero-byte
  enumeration's step-5 row which already states this for the
  oversize refusal); the correct scope: pre-4a crash = zero
  bytes to ALL SEVEN incl. the attestation log; post-4a
  crash = the attestation log holds the entry, the other six
  unchanged, T4-gap refusal is the detection): (rev 8, closes
  cycle-6 major 1 — this sentence still named a residual "inert
  marker + R1 absorbs" exception from the superseded marker-
  before-rename world; under the rev-8 durable ordering NO
  crash window can persist a marker without the archive entry
  durable, and NO conforming window leaves marker + no archive
  AT ALL; the MARKER section is the SOLE normative marker-crash
  description — any other text describing an inert-marker or
  marker-then-crash state is HISTORICAL and non-normative).

  DECISION-READER PRECEDENCE TABLE (rev 5; rev 6 amends the
  cost rule — the ONE normative, EXECUTABLE table; fixed-path
  stats on sidecar/marker/journal; archive globs on a present-
  journal reader ONLY in the sidecar-absent/invalid +
  marker-absent cell (see READER ALGORITHM under R1 — max one
  bounded listdir per decision on a fresh fleet; NEVER on a
  VALID-sidecar read, NEVER on the refuse-state rows); rows
  exhaustive and mutually exclusive; REV 12 SCOPE RULING per
  cycle-10 major 7: the decision readers in THIS table NEVER
  open or parse the ATTESTATION LOG (hot-path cost rule —
  fixed-path stats only), and consequently `purge-in-flight`
  parser state is NOT a decision-reader gate: it binds ONLY
  the operator COMMANDS rebuild and rotation (their O1
  prerequisite) — a purge-in-flight state composes DECISIONS
  normally (R2 unchanged) while every sidecar-writing/
  carries-composing COMMAND refuses; NO owner-ratification
  delta is needed for the decisions (no new decision refusal;
  the word "readers" in the T4/prerequisite prose refers to
  the rebuild/rotation COMMAND paths parsing the log, never
  to this table — the two vocabularies are disjoint, stated
  once here); pin `decision-reader-never-parses-attest-log`:
  instrumented decision on a fleet whose attestation log is
  purge-in-flight ⇒ decision composes, ZERO attestation-log
  opens; mutation making the decision refuse ⇒ RED):
    R1 journal PRESENT + sidecar absent/invalid + marker
       ABSENT + archives ABSENT: carry = empty + live-journal
       replay. This IS the shipped fresh-fleet state —
       byte-identical to today's decision semantics (the 1A
       no-archive exception). READER ALGORITHM (rev 6, closes
       the pre-marker half of cycle-4 major 3 honestly — the
       reader CANNOT tell "marker absent + no archives" from
       "marker lost + archives present" without one listdir,
       and silently replaying live-journal-only against
       invisible archived history would UNDERCOUNT D1-A = the
       unsafe direction): sidecar VALID ⇒ R2 compose, ZERO
       globs. Sidecar absent/invalid + marker PRESENT ⇒ refuse
       `journal-carries-invalid` UNCONDITIONALLY (R3 — fail-
       closed). REV 10 HONEST PROSE (closes cycle-8 major
       6's third site): rev 9 said "no conforming crash
       window lands here — a FOUND state is corruption/media
       failure" — WITHDRAWN. This cell IS conforming-
       REACHABLE: on a FIRST rotation (no prior sidecar),
       the marker is created at step 5 BEFORE the sidecar
       is published at step 6, so a crash between them
       lands here (marker present, sidecar absent, journal
       ENOENT, archives present). The reader's refusal is
       UNCHANGED and CORRECT (a half-published rotation:
       fail-closed is the reader posture; the state is
       rotation-IN-FLIGHT, not corruption); what changed is
       the explanation — a FOUND state means "a rotation is
       mid-flight (re-entry completes it)" OR media
       failure, and the two are NOT distinguished from the
       files — the refusal holds for both. Reserved-
       "impossible" language stays ONLY for marker-durable-
       without-archive-durable (see MARKER). Sidecar absent/invalid + marker
       ABSENT ⇒ ONE bounded glob (dir listing): archives absent
       ⇒ R1 (fresh fleet, shipped semantics); archives present
       ⇒ treat as R3 (refuse; recovery = rebuild, ELIGIBLE
       here: archives exist and form the chain). REV-9 HONEST
       PROSE (closes cycle-7 major 6's second site): rev 8
       called this cell "unreachable for conforming writers —
       archives are created ONLY by rotation, which writes the
       marker atomically with them". WITHDRAWN — the MARKER
       section (sole normative marker-crash description)
       declares the rename-durable/marker-absent window
       REACHABLE (window (b) there): a conforming crash
       between the archive's dir fsync and the marker create
       lands HERE with journal ENOENT. The reader's refusal is
       UNCHANGED (fail-closed is the correct reader posture
       for a half-published rotation); what changed is the
       explanation — this cell is a SPECIFIED crash window's
       landing zone, not corruption, and the rotation re-entry
       (step 4, marker idempotent) plus rebuild complete it.
       "Impossible" is reserved for marker-durable-without-
       archive-durable only. LISTDIR
       ERROR, FAIL-CLOSED (rev 7, closes cycle-5 major 7):
       the listing is a METADATA-ONLY enumeration (names;
       archive CONTENTS are never read here); if it raises
       (EIO, EACCES, any error), NEITHER "archives absent"
       NOR "archives present" is established — the decision
       refuses `journal-carries-metadata-unavailable` (zero
       bytes, NEW code; the error is NEVER treated as an
       empty listing: fail-open on an I/O error is exactly
       the undercount this table exists to prevent).
       GLOB COST, HONEST (rev 6, cost pin re-scoped): the
       glob runs ONLY in the sidecar-absent/invalid +
       marker-absent cell — never on R2 (valid sidecar) and
       never per-rotation; shipped fresh fleets pay one
       extra listdir per decision (same decisions, extra
       stat-class syscall — decision OUTPUTS stay byte-
       IDENTICAL FOR SUCCESSFUL LISTINGS; a FAILED listing
       refuses where shipped read nothing and proceeded:
       that metadata-error delta is N6 under Q-1A-a).
    R2 journal PRESENT + sidecar VALID (marker any):
       compose: `carries.get(authId,0)` + live-journal replay on
       top. DECISION-CLASS ENUMERATION under `damage:true`
       (rev 6, closes cycle-4 major 7 — rev 5 said "non-repair
       decisions proceed" HERE while the sidecar-format section
       and S-A1 made authorize refuse; both survive, now
       enumerated): REFUSED while damage:true — REPAIR
       decisions AND `authorize()` (each
       `journal-carries-damaged`, zero bytes — mint safety
       needs the complete identity universe and damage proves
       records were lost); PROCEEDING — EVERY OTHER decision
       class (consume, resolve, APPLIED paths never consult
       carries — code-verified: carries feed ONLY the D1-A
       count; `status`, promotion, and the shared resolve path
       are entry points too and take the GENERAL R1-R5 row
       gate on their own reading path — no assumption that
       they route through `_clean_failure_count` (cycle-5
       note 3, folded rev 7)). NO glob, NO staleness check, NO
       source_archive existence or currentness check on the
       hot path (guarantee-by-construction; detection and
       repair of stale/orphan sidecars = `operator_rebuild_
       carries()`, rev 6 eligibility above). STALE-COMPOSITION
       HONESTY (rev 6, self-caught during the fold — the first
       draft of this clause claimed a stale carry undercounts
       "in the fail-safe direction": FALSE — a stale carry
       OMITS archived intents invisible to both carry and live
       journal ⇒ D1-A is UNDERCOUNTED ⇒ repairs beyond the cap
       could be admitted; the dangerous direction. Two facts
       bound the risk INSTEAD: (1) NO conforming crash sequence
       produces journal-PRESENT + sidecar-stale + newer-archive
       (the crash matrix always leaves the journal ABSENT
       between rename and sidecar replacement — journal-present
       requires step 7, which runs AFTER step 6); such a state
       arrives ONLY via out-of-band partial restore or media
       failure; (2) OPERATOR OBLIGATION (normative, rev 6):
       after ANY partial file restore, `operator_rebuild_
       carries()` MUST run before serving traffic — it detects
       stale/orphan sources (glob is operator-side) and
       replaces them under the eligibility ladder. Accepted
       risk = operator restore errors, stated to the owner
       alongside Q-J2-d.
    R3 journal PRESENT + marker PRESENT + sidecar
       absent/invalid ⇒ every decision refuses
       `journal-carries-invalid` (zero bytes) — UNCONDITIONALLY
       (fail-closed; the reader does NOT glob to distinguish
       archives-present from archives-absent here, and the
       pre-marker-archives state routes here too). READER
       TABLE SCOPE (rev 7, closes cycle-5 major 1's
       contradiction — the table governs DECISION-TIME reading
       ONLY; operator COMMANDS follow their own sections and
       the CRASH MATRIX, and a state inside a command's own
       crash sequence is handled by that command's reentry,
       NOT routed through this table): under the rev-7 marker
       ordering the "orphan marker" state cycle 4 debated is
       UNREACHABLE for conforming writers (marker is created
       only after the journal rename — see MARKER), so this
       row needs NO orphan interpretation: if such a state is
       ever FOUND (non-conforming writer, media corruption),
       the reader refuses here like any other marker+no-sidecar
       state — fail-closed is the answer to impossible states.
       Recovery = `operator_rebuild_carries()` (rev 5 — NOT a
       rerun of rotation: that refusal is what this row IS;
       cycle-3 blocker 1 closed by command separation; rev 7:
       rebuild archives-present ⇒ replay, archives-absent ⇒
       refuse INELIGIBLE with nothing deleted — Q-J2-f).
    R4 journal ENOENT + marker/stat shows archives (this row may
       glob — the journal is already absent, hot path is dead
       until recovery) ⇒ `journal-rotation-incomplete`; only
       rotation reentry completes (crash matrix below).
    R5 journal ENOENT + no archives + no marker ⇒ fresh fleet,
       empty carry.
  HOT-PATH COST, HONEST (rev 6; rev 7 adds the error row):
  present-journal readers on a HEALTHY fleet (sidecar VALID —
  every steady-state fleet after its first rotation) do ZERO
  globs (journal open + sidecar read); fresh-fleet readers
  (sidecar absent + marker absent) do ONE bounded metadata
  listing per decision — success ⇒ R1/R3 routing above, ERROR
  ⇒ `journal-carries-metadata-unavailable` refusal; refuse-
  state readers (marker present + sidecar absent/invalid)
  refuse without globbing; the journal-ENOENT rows glob as
  before.

  CRASH MATRIX (rotation steps 5-7; REV 8 — EVERY re-entry
  path CREATES THE MARKER IDEMPOTENTLY if absent (O_EXCL,
  already-existing fine) + fsyncs its fd BEFORE step 6, so the
  marker invariant survives every window — closes cycle-6
  major 2: rev 7 embedded marker creation in step 5, but the
  crash-after-rename-before-marker re-entry resumes at step 6
  and could complete the rotation WITHOUT ever creating the
  marker, silently violating the construction invariant and
  changing later routing after a sidecar loss):
    - journal ABSENT + archives + sidecar VALID-current ⇒ crash
      6->7: rotation reentry creates the marker (if absent,
      +fd fsync), then performs only step 7. Pin (rev 8):
      after ANY completed rotation or re-entry the marker
      EXISTS (mutation: re-entry that skips marker creation
      ⇒ RED).
    - journal ABSENT + archives + sidecar VALID-STALE (names
      source_archive < newest) ⇒ crash 5->6: replay EVERY
      archive with seq > source_archive in numeric order seeded
      at the sidecar (never seed+newest-only), gap or
      source_archive naming nothing ⇒ treated as no-sidecar;
      damage in a replayed archive ⇒ pass-through `damage:true`;
      then step 6, then 7.
    - journal ABSENT + archives + sidecar INVALID/ABSENT ⇒
      full-chain reconstruction (step 3); damage ⇒
      `journal-rotate-reconstruct-damaged` zero bytes; else step
      6, then 7.
    - journal PRESENT ⇒ SPLIT PER REV 14 (cycle-12 major 4:
      the rev-13 (a1)/(a2) split had NOT reached THIS
      operative row — it declared the whole window "rotation
      completed (or never started)" and sent re-entry through
      the ordinary c1 path, promising a normal re-entry the
      T4 contract forbids after a DURABLE 4a append):
      (a1) journal PRESENT + **current-epoch coverage <=
      the largest PRESENT archive seq (the rev-15 branch
      predicates "holds NO entry above"/"whose seq EXCEEDS"
      restated per cycle-14 major 1 onto the SAME coverage
      operands as the observable below — a purge record has
      no `seq` and an empty archive set has no raw maximum;
      both predicates consume the defined quantities, never
      entry fields)** ⇒ rotation
      completed (or never started); reader table governs;
      rotation reentry is subject to c1
      (healthy ⇒ `journal-rotate-not-needed`) AFTER the
      currentness check (journal present + marker present +
      sidecar absent/invalid ⇒ `journal-rotation-incomplete`
      regardless of gate, recovery = rebuild command — rev
      5). (a2) journal PRESENT + **current-epoch coverage >
      the largest PRESENT archive seq** (REV 15 per
      cycle-14 major 1 replacing "a DURABLE entry whose seq
      EXCEEDS": the (a2) witness is the COVERAGE state, not
      an entry's raw seq — the 4a append landed, the rename
      never
      ran) ⇒ this is NOT "completed or never started": the
      epoch-relative T4 gap check runs FIRST — BEFORE the
      writer's append-idempotence skip and BEFORE any rename
      — and rotation AND rebuild REFUSE
      `journal-rotate-attestation-gap` /
      `carries-rebuild-attestation-gap`; resolution =
      WHOLE-DIR RESTORE (R-c, no in-protocol completion —
      see the rev-12 window contract ~line 930).
      The (a1)/(a2) OBSERVABLE distinguishing the two
      (REV 15 REDEFINED per cycle-13 major 2: the raw "newest
      VALID attestation entry's seq" is UNDEFINED for a
      purge-ending log — the purge record carries no `seq` —
      and for an empty log; an OLD-epoch entry must never
      substitute): the comparison is the SHARED PARSER's
      current-epoch T4 GAP TEST — epoch-relative coverage
      (max `hwm` over VALID entries SINCE the last purge
      entry; NO post-purge normal entry ⇒ coverage 0) vs the
      largest PRESENT archive seq (EMPTY archive set ⇒ that
      side is 0; coverage 0 ⇒ the test passes trivially and
      the state is (a1)): coverage > largest-PRESENT-seq ⇒
      (a2); coverage <= largest-PRESENT-seq ⇒ (a1).
      DECISION READERS are NOT conscripted: they follow the
      reader table (R1-R5) WITHOUT opening the attestation
      log (pin `decision-reader-never-parses-attest-log`
      governs — the (a1)/(a2) test is a COMMAND-path
      re-entry check only; readers keep serving whichever
      state they are in per the table). The check is stated,
      not inferred.
  Readers never delete or rewrite archives;
  `unsafe-path-permissions` extends to every archive/marker/sidecar match
  (owner uid, not a symlink, mode per the acceptance sets).

  MIRROR PREDICATE `full` (rev 5 closes cycle-3 major 1; rev 6
  fixes its W selection — cycle-4 major 6: choosing W by
  CHARACTER length re-opened the exact escape hole rev 5 claimed
  to close, because a character-SHORTER id full of quotes/
  backslashes/non-ASCII SERIALIZES LONGER than a
  character-longer plain id, so `size + R(W)` could read
  not-full while the writer would refuse the very next line —
  divergence in the UNSAFE direction): define
  `R(s)` = the EXACT reservation arithmetic of
  `_journal_append` (ledger.py ~487-496) for a synthetic record
  `{"t":"REPAIR-INTENT","authId":s,"at":AT_MAX}` — serialized by
  the same `json.dumps(...separators)` call (escaping therefore
  automatic), plus the same worst-case-outcome line length +1.
  W := the authId appearing in the CURRENT journal that
  MAXIMIZES `R(s)` — computed over ALL journal ids through the
  same serialization call (the journal is bounded; the maximum
  is computable, deterministic, and by construction ≥ every id
  the journal already holds in SERIALIZED-RESERVATION terms —
  which is the only ranking the predicate's arithmetic
  consumes). `full` := `size(journal) + R(W) > JOURNAL_CAP`.
  Empty journal ⇒ no ids ⇒ not full.
  CONSERVATIVE-MIRROR, NOT the writer's boundary; BOTH
  divergence directions now stated precisely (rev 6) and pinned:
  (i) a FUTURE id with R larger than W can make `_journal_append`
      refuse `journal-full` while the predicate says not-full —
      the named residual; it can strand repair attempts on a
      not-"full" journal with rotation refused (c1 accepts the
      availability risk — operator waits for archive tooling —
      WEAK, honestly noted); c2 (unconditional rotation)
      eliminates it entirely; c3 (rev 5 option, rev 6-fixed
      below) bounds it;
  (ii) `R`'s AT_MAX timestamp OVERESTIMATES every real intent
      (real `at` is ≤ 12 digits, usually fewer), so the
      predicate can declare full while the writer would still
      accept the next line. DIRECTION FIXED (rev 7, closes
      cycle-5 major 5 — rev 6 called this "rotation refused
      early", which inverts the mechanism: under the c1 gate
      `full` is the rotation TRIGGER, so the predicate
      false-POSITIVE PERMITS AN EARLY (unnecessary but fully
      complete) ROTATION of a still-writable journal — bytes
      verbatim, carries recomputed, nothing lost; cost is one
      early archive. The never-happens direction is the
      reverse; predicate-not-full while the writer refuses is
      direction (i), NOT this one. rev 6's text AND pin said
      "refuses rotation EARLY" while the same pin block went
      RED when a predicate-full rotation of a writable
      journal proceeded — mutually unsatisfiable; both are
      corrected here to the c1 semantics.
  PINNED: predicate and writer diverge ONLY in directions
  (i)/(ii) — escape corpus (plain / quote / backslash /
  non-ASCII / emoji ids ranked by R, NOT by character length)
  AND short-timestamp boundary corpus. Recisions: c1 accepts
  (i) / c2 eliminates (i) / c3 (rev 6 option): c1 plus a forced-rotation
  escape `journal-rotate-full-override` (rev 6 DEFINED — closes
  cycle-4 major 5: rev 5's text simultaneously required "a live
  journal-full refusal has actually occurred", mentioned
  verifying `cur > 0` and classification, then said only
  presence/hygiene/target are verifiable — three readings, and
  its own pin exercised a healthy journal with NO prior refusal
  context):
    - PREREQUISITES (all explicit, all checked under the lock):
      (P1) the caller passes the ASSERTED EVIDENCE: the literal
           error string `journal-full` as displayed by the
           refused decision (a required argument — an
           override call WITHOUT it is a usage error, refuses
           `journal-rotate-override-unasserted`, zero bytes);
      (P2) the command RE-READS the journal under the lock and
           re-evaluates the predicate: `size(journal) > 0`
           (nonempty) — the predicate may say not-full (that is
           precisely direction (i), the residual the override
           exists for); journal EMPTY ⇒ refuse
           `journal-rotate-not-needed` (nothing to archive);
      (P3) unchanged from normal rotation: steps 0-2 (dir fsync
           + mode repair, pending-window, hygiene), step 4
           target-exists, step 5 candidate preflight INCLUDING
           the carry/damage/oversize rules, steps 6-7 — the
           override skips ONLY the c1 `full`-gate, NOTHING
           else; bytes archived VERBATIM, damage rules apply.
    - HONEST STATE: the ASSERTED EVENT cannot be verified (no
      persisted marker — the override is a trust handshake with
      an auditable human act); a FALSE assertion is
      operationally possible and its blast radius is EXACTLY
      P2+P3 (an early but complete rotation of a nonempty
      journal with full carry/damage preflight) — no weaker
      guarantee than c2, none claimed stronger.
    Agent recommendation: c3; presented as part of Q-J2-c.

  Q-J2-a (OWNER CALL — archive file mode; BLOCKS implementation,
  no silent default) [REV-37 tag, R9 major 3: RULED a1 (0400)
  at REV-36 — BLOCKS wording is pre-ruling history]): a1) 0400 (rec'd — needs step-0 repair +
  step-5 chmod; acceptance set {0400, 0600-pending}); a2) 0600
  (single dialect, no transition; step 0 a no-op).

  Q-J2-b (OWNER CALL — D1-A carry-over): [REV-36: RULED b1.]
  b1) CUMULATIVE CARRY
  SIDECAR `journal-carries`, no journal-schema change (the D2/
  S-J1 grammar is UNTOUCHED). Single strict JSON doc, 0600,
  exact key set + dup-member rules per S-J1:
    `{"carries": {"<authId>": n}, "damage": <bool>,
       "source_archive": "<name>"}`
  GRAMMAR (rev 5 restated with the identity-retention fix,
  cycle-3 major 5):
    - keys = the JOURNAL's identity domain (ANY non-empty string
      admitted by the journal grammar — no narrower shape rule);
      KEYS ARE NEVER DELETED (rev 5): a durable `repaired` sets
      the VALUE to 0 but the KEY REMAINS FOREVER — the sidecar
      key set is the cumulative identity universe of the archive
      chain (freshness (d) tests keys; omitting zero-count keys
      would let one conforming implementation re-mint an id
      another bars — cycle-3 named this); reconstruction
      produces the key set of every identity in every archived
      record (intent-only, outcome-only, reset-to-zero all
      included);
    - values: int in [0, 2^31-1];
    - `damage`: JSON bool (field of a VALID sidecar);
    - `source_archive`: string; existence checked by operator
      commands only (rev 5);
    - SIZE CAP: see Q-J2-e — ANY violation or over-cap candidate
      ⇒ fail-closed refusal (no saturation, no truncation: two
      implementations saturating differently IS the disagreement
      the grammar exists to prevent).
  SEMANTICS (normative):
    - CUMULATIVE: `carries := replay(prev_carries,
      archive_records)` with the existing per-authId rules
      (INTENT +1; durable `repaired` → 0; keys retained). A
      second rotation NEVER drops the first's counts. The
      sidecar covers the ARCHIVED history only; the live journal
      replays on top at decision time.
    - DAMAGE: rotating a damaged archive passes prev_carries and
      the key set through UNCHANGED with `damage:true` and
      `source_archive` = the damaged archive. The flag is STICKY
      through subsequent rotations. CLEARANCE PROOF (rev 7,
      closes cycle-5 major 6 — rev 6 said "successful FULL-CHAIN
      reconstruction is the only automatic clearance" without
      saying what PROVES the previously recorded loss is gone:
      all-available-archives parsing proves only that CURRENT
      evidence parses, not that lost records were restored).
      THE PROOF is: `operator_rebuild_carries()` completing a
      replay over a chain that is (1) CONTIGUOUS — parsed seqs
      exactly `min..max`, NO interior gaps and NO duplicates
      (hygiene refusal `carries-rebuild-damaged` on any hole),
      (2) COMPLETE FROM THE FLEET'S ORIGIN — the chain includes
      the oldest archive that has ever existed (post-
      ratification: seq 1 = the first rotation; an origin-side
      gap is indistinguishable from record destruction ⇒
      damage STAYS), and (3) NO member replays damaged.
      ~~ALL THREE ⇒ `damage:false` in the rebuilt sidecar.~~
      **REV-9 WITHDRAWAL IN FULL (cycle-7 major 1): the
      striken implication is retracted AS NORMATIVE TEXT —
      rev 8 named the "sole automatic clearance" clause
      withdrawn but left this implication standing, so two
      implementers could follow opposite rules from one
      paragraph group. NORMATIVE NOW: when all three
      conditions hold but ANY attestation entry or prior
      sidecar records damage, the rebuild sets `damage:true`
      (step 4a T5) and, under d1+g2, repair AND authorize
      REMAIN REFUSED for that lineage; a clean replay
      rebuilds COUNTS only — NO replay result anywhere in
      this document implies `damage:false` for a lineage the
      attestation log marks damaged. The only exits are the
      Q-J2-g owner acts as separately described.** [REV-37
      correction, R9 major 5: Q-J2-g RULED g2 at REV-36 —
      there is NO clearing act; damage is PERMANENT for the
      lineage; the only exit is out-of-band restoration
      producing a CLEAN LINEAGE (a fresh sidecar written out
      of band). The pre-ruling "owner acts as separately
      described" phrase is SUPERSEDED.]
      (REV-8 SUPERSESSION — READ WITH THE CLEARANCE AMENDMENT
      BELOW: this proof's three conditions are NECESSARY, NOT
      SUFFICIENT; the clause declaring it "the SOLE automatic
      clearance" is WITHDRAWN by cycle-6 blocker 2 — sequence
      continuity proves NAME coverage, never CONTENT
      restoration, and a syntactically-valid replacement
      member keeping the same seq defeats it. The amendment
      follows this paragraph group and GOVERNS.) Parsing archives with an origin gap
      or interior gap prove NOTHING about lost records ⇒
      replay REFUSES `carries-rebuild-damaged` (zero bytes;
      damage flag and prior sidecar UNCHANGED — clearing on
      "everything present parses" would restore repair and
      authorize off incomplete history, the cycle-5 named
      failure); out-of-band restoration of the missing archives
      is the only further path (Q-J2-d d1 posture unchanged
      until then) [REV-38 correction, R9 cycle-41 major 5:
      per the REV-36 g2 ruling, restoring archive MEMBERS
      does NOT clear the damage flag — the exit is
      restoration producing a CLEAN LINEAGE with a fresh
      out-of-band sidecar; a restored archive that keeps the
      damaged lineage keeps damage set permanently].
      REV-8 CLEARANCE AMENDMENT (closes cycle-6 BLOCKER 2 —
      the auditor's replacement attack holds: an operator can
      substitute a syntactically valid but EMPTY/incomplete
      archive member keeping the same seq; the chain can start
      at 1, be contiguous, duplicate-free, replay with no
      member damaged, and STILL omit every record whose loss
      set `damage:true`): NO AUTOMATIC MECHANISM — rebuild
      included — can EVER prove lost records RESTORED (the
      content of a past archive is unattestable without a
      digest captured before the loss; the sidecar records no
      content commitment and adding one cannot help
      retroactively). NORMATIVE OUTCOME (rev 8): a sidecar
      with `damage:true` is NEVER rewritten to `damage:false`
      by ANY command — replay rewrites COUNTS, NEVER THE
      FLAG; `damage:true` PROPAGATES INTO EVERY REBUILD
      OUTPUT UNCONDITIONALLY. Clearance becomes an OWNER-
      AUTHORIZED ACT (a named, separately authorized,
      refusal-logged clearing of the flag with the rearm
      consequence stated on its face), opened as NEW OWNER
      CALL **Q-J2-g**: g1) a named clearing command, same
      posture as the Q-J2-f f1 proposal — authorization/
      eligibility/logging/atomicity defined IN the protocol
      text BEFORE ratification of either purge-style command
      (cycle-6 major 3's general rule); g2) damage is
      PERMANENT for the fleet's life — repair+authorize stay
      refused until backup restoration produces a chain
      without the damaged lineage, and even then only via a
      fresh sidecar written out of band. RECOMMENDATION g2
      (fail-closed; needs no new mechanism), BUT the flag
      STAYS SET and NOTHING proceeds until Q-J2-g lands.
      [REV-36: Q-J2-g RULED g2 — damage PERMANENT, no clearing
      mechanism; the d1+g2 posture stands as written; exit is
      out-of-band clean-lineage restore only.]
      ELIGIBILITY ALGORITHM (rev 7; REV-9 RE-ORDER; REV 10
      CANONICALIZATION per cycle-8 major 3 — rev 9 kept TWO
      prose ladders (the command-section ELIGIBILITY block
      and this ORDERING list) whose row order and gate
      placement DIFFERED, and whose "FIRST MATCH WINS"
      applied to a list whose row (3) said ELIGIBLE before
      row (4) demanded hygiene: a literal first-match
      implementation could skip hygiene. THIS LIST IS NOW
      THE SOLE CANONICAL ALGORITHM — the command-section
      ELIGIBILITY block is PROSE BACKGROUND and defers here
      ("for the executable order, see the ELIGIBILITY
      ALGORITHM"; its [HISTORICAL] tags mark where its
      narrative contradicts); rows are NOT independent
      first-match predicates — they are a program:
      (0) ATTESTATION PREREQUISITE (rev 9 gate, rev 10
      scope = EVERY carries-producing path incl. rotation
      re-entry; REV 11 = O1, see THE NORMATIVE SCOPE — this
      row runs parser + T1-T4 + the in-flight check; the
      eligibility ROWS (1)-(5) below are rebuild-invocation
      classification ONLY = O2): run the 4a parser over the
      log; then T1 (log absent + any archive), T2
      (framing/monotonicity break incl. torn tail), T3
      (PRESENT archive uncovered in the current epoch), T4
      (high-water test, REV 12: UNCONDITIONAL — the rev-10
      journal-conditioned exception citation here is a
      REV-11 FOLD-OVER: the exception was WITHDRAWN IN FULL
      at its definition site (cycle-10 BLOCKER 1: this
      operative site still instructed the withdrawn
      exception — WITHDRAWN HERE TOO; per REV 12 there is NO
      in-protocol route out of a T4 gap — re-entry
      completion is WITHDRAWN (cycle-10 major 1: it
      contradicted this site's own pre-rename refusal);
      resolution = WHOLE-DIR RESTORE, residual R-c — see
      the crash-window note at 4a), and the purge-
      in-flight check — ANY failure ⇒ the named refusal,
      zero bytes, STOP. This is a PREREQUISITE, not a
      ladder row: it runs before eligibility is even
      consulted, and it does NOT consume the epoch/purge
      semantics of eligibility.
      (1) sidecar VALID+CURRENT ⇒ `carries-rebuild-not-needed`
      (damage or not), STOP (terminal refusal — a current
      sidecar is never overwritten).
      (2) archives ABSENT (empty set after hygiene scanning
      of names) ⇒ `carries-rebuild-ineligible`, NOTHING
      deleted (Q-J2-f routing for the rearm decision), STOP.
      (rev 9: MOVED AHEAD of stale/orphan eligibility — an
      absent-source sidecar over an empty archive set
      matched both rules in rev 8; cycle-8 major 3 empty-
      set note: with the archive set EMPTY, T3 coverage is
      vacuous and T4's operand "largest PRESENT seq" is
      UNDEFINED — defined rev 10: T4 on an empty archive
      set tests 0 < hwm (REV 12: UNCONDITIONAL per 4a T4 —
      the rev-10 journal-conditioned exception was WITHDRAWN
      IN FULL at its definition site, cycle-10 BLOCKER 1;
      an all-lost fleet with hwm > 0 trips T4 and REFUSES
      unless an authorized purge epoch reset has already
      covered it — an all-lost fleet REFUSES rebuild and
      routes to
      Q-J2-f; that is row (2)'s outcome via the refusal —
      stated once, here, both readers (REV 12 vocabulary
      note per cycle-10 major 7: "readers" HERE = the two
      COMMAND paths (rebuild + rotation re-entry) parsing
      the attestation log; it NEVER means the decision-
      reader table, which never opens this log — see the
      table's REV 12 SCOPE RULING).
      (3) sidecar VALID but stale/orphan-source (archives
      necessarily PRESENT now — row (2) took the empty set)
      ⇒ proceed to (4); if the chain passes, replay
      REPLACES the stale sidecar (SUBJECT TO (4) AND
      (0)'s already-satisfied gate; the damage flag
      propagates per the CLEARANCE AMENDMENT + 4a T5).
      (4) chain hygiene (rotation step 2 rules over the
      archive SET): member damaged OR interior gap OR
      origin gap ⇒ `carries-rebuild-damaged` zero bytes,
      STOP; only an all-clean, contiguous, origin-complete
      chain PROCEEDS to replay —
      and (rev 8, per the CLEARANCE AMENDMENT) such a replay
      rebuilds COUNTS and NEVER clears `damage` (the rev-7
      clause "ONLY such a replay clears damage" is WITHDRAWN).
      REV-8 HIGH-WATER RULE [HISTORICAL NARRATIVE — rev 10:
      the operative test is 4a T4; the empty-set case is
      defined there and in ELIGIBILITY ALGORITHM row (2)
      (rev 12: the rev-10 journal-conditioned exception
      cited in earlier revisions of this narrative is
      WITHDRAWN IN FULL at every site — cycle-10 BLOCKER 1); rev 10
      WITHDRAINS the hwm's self-verifying status per
      cycle-8 major 4 — hwm is a POLICY-ENFORCED value, the
      ledger's only durable seq record, not a verification
      of the archive set (see 4a T4 and ELIGIBILITY
      ALGORITHM row (2)): closes cycle-6 major 4 — a
      MISSING SUFFIX is invisible to continuity: stale sidecar
      names seq 2; seqs 3-4 existed; seq 4 lost out of band;
      archives 1-3 are contiguous FROM ORIGIN and replay
      cleanly, yet intents that lived only in seq 4 vanish
      and can REARM. No durable high-water mark exists in the
      file system — the largest PRESENT seq is not evidence
      of the largest EVER — and none is introduced here): the
      ONLY durable attestation available is a CURRENT sidecar
      (it attests the chain it names was complete AT ITS
      CREATION); a STALE sidecar attests NOTHING about
      archives that may have existed after it. Walk the
      direction honestly (correcting rev 7's "superset"
      claim, which holds only for COMPLETE chains): a
      suffix-truncated chain yields counts MISSING archived
      INTENTs — a smaller seed admits MORE repairs = the
      D1-A rearm direction, NEVER direction-safe. There is
      no in-protocol fix (the files cannot distinguish
      "never existed" from "lost"); what rev 8 does instead:
      (i) the damage flag propagates unconditionally (any
      prior-sidecar or member damage survives every rebuild),
      (ii) the ONLY way INTO stale-sidecar state is
      backup-restore or media failure — restoring a backup
      that dropped suffix archives is the residual risk of
      restore itself, stated openly (R-1 ratified: protocol
      NEVER deletes archives; same out-of-band class the
      fsync durability promises decline to defend) — and
      (iii) operators entering restore MUST restore the
      WHOLE state dir (sidecar AND every archive) or rebuild
      is declined: rebuilding a STALE sidecar whose
      `source_archive` seq is below the largest PRESENT
      archive seq is legitimate (rotation happened after the
      backup); rebuilding where archives are suspected lost
      has no signal — the honest statement IS the control.
      REV 10 SUPERSESSION LABELS (cycle-8 minor 1): the
      passage "No durable high-water mark exists in the
      file system ... and none is introduced here" is
      SUPERSEDED — rev 9/10 DO introduce a durable HWM
      (`hwm` in the attestation log, 4a); this narrative
      predates it and survives only for its honest direction
      analysis. The rev-8 pin "mutation: rebuild emits
      `damage:false` over any chain whose prior sidecar or
      any member EVER recorded damage" is SUPERSEDED (cycle-7
      minor 5: "EVER recorded" is unobservable) — replaced by
      the OBSERVABLE `rebuild-damage-from-log-only` pin in the
      4a pin set (damage = OR of prior-sidecar flag and every
      VALID log entry's flag post-last-purge).
      Pin (rev 8, SUPERSEDED as to its "EVER" clause only —
      see label above): missing SUFFIX tested SEPARATELY from
      interior and origin gaps; the operative suffix test is
      4a T4. Identities known ONLY to a damaged archive are
      lost to every reader (undecidable — the D2-A argument);
      the flag records it; Q-J2-d governs what that means.
    - DAMAGE vs THE CAP (rev 4 owner call, unchanged): with
      `damage:true` the composed count is a LOWER BOUND; d1 =
      FAIL-CLOSED (rec'd): REPAIR decisions AND `authorize()`
      refuse `journal-carries-damaged` while damage is set; all
      other decisions unaffected. d2 = lower-bound admission
      ONLY by an explicit owner-signed cap-exception ruling;
      until then d1 is the drafted posture. (Cycle-3 confirmed
      d1 resolves cycle-2 blocker 1: no decision path admits a
      repair off a lower bound; non-repair decisions never
      consume carries — code-verified.)
  1A RECONCILIATION (rev 5, cycle-3 major 7 — the honest version
  goes one step further than rev 4 admitted): b1 and the
  identity universe introduce TWO NEW refusal classes (reader
  ENOENT+archives ⇒ `journal-rotation-incomplete`; authorize
  journal/carry collisions ⇒ `auth-id-already-used` extensions).
  Today (`ledger.py` ~537-547, ~1327-1368) both states PROCEED.
  The accepted 1A wording is "operator commands change no
  decision semantics"; "no state reachable without the commands
  changes semantics" is a NARROWER redefinition that the authorize
  delta does NOT satisfy (a journal-only-id collision is
  reachable with ZERO rotations). Therefore rev 5 does NOT
  claim this reconciliation; it is routed to the owner as an
  explicit re-affirmation/amendment (Q-1A-a below).
  IMPLEMENTATION NOTE: the sidecar, marker, and archive globs
  join `_check_access_controls` (0600/owner/not-symlink at
  startup; archives per the acceptance sets); existing sidecars
  use fixed-width in-place rewrites; `journal-carries` is the
  first variable-width sidecar (temp+fsync+rename+dir-fsync).

  Q-J2-c (OWNER CALL — trigger gate): [REV-36: RULED c3.]
  c1) recovery-only (full or
  damaged) — WITH the availability residual stated above
  (direction (i): a future-longer-id can strand repairs with
  rotation refused); c2) unconditional; c3) c1 + the rev-6
  DEFINED `journal-rotate-full-override` (prerequisites P1-P3;
  rev 5/6 recommendation: c3 — recovery-only intent kept,
  liveness gap closed by an auditable human act with the
  blast-radius of a false assertion bounded to P2+P3).

  Q-J2-e (OWNER CALL, rev 5 NEW, REV-6 RESTATED on honest
  facts — carry-sidecar size cap; [REV-36: RULED e1 — 64 KiB
  cap kept; per-journal AND cumulative availability ceilings
  ACCEPTED; recovery past the cap is out-of-band restore
  only.] cycle-3 major 4: the rev-4
  64 KiB cap can permanently defeat the recovery mechanism ON
  VALID INPUT — a strict-valid journal of many distinct long
  ids replays to a > 76 KiB carry; rev 6 extends the same
  failure to ANY fixed cap: rotations accumulate keys across
  RETAINED archives, so the ceiling is a LIFETIME identity
  bound, not a per-journal one — see the revised bytes
  argument under e2). Options:
    e1) keep 64 KiB + accept BOTH documented availability
        ceilings, per-journal AND cumulative (operator recovers
        only out-of-band restore; honest but weak);
    e2) cap = 1 MiB, mirroring JOURNAL_CAP — BYTES ARGUMENT
        REVISED HONESTLY (rev 6, closes cycle-4 major 1 — the
        rev-5 claim "a 1 MiB cap REPRESENTS EVERY VALID JOURNAL
        by construction" is TRUE PER JOURNAL but FALSE FOR THE
        CUMULATIVE sidecar the owner is ratifying: carries are
        CUMULATIVE across rotations (b1), keys are never pruned,
        and archives are RETAINED (S-J3 ratified): rotate one
        near-cap journal of N distinct ids, fill and rotate
        another near-cap journal of M DIFFERENT ids, the
        sidecar holds N+M keys and can exceed 1 MiB while every
        individual journal stayed ≤ JOURNAL_CAP — preflight
        then refuses rotation FOREVER and full-chain rebuild
        also overflows. The per-journal proof never tested the
        lifetime property; the summary's "proven sufficient" is
        WITHDRAWN. The CUMULATIVE limit is the total distinct
        identity history of the fleet's RETAINED archives.
        ENTRY-SIZE ESTIMATE, ASSUMPTIONS STATED (rev 7,
        closes cycle-5 minor 1; REV 9 RECOMPUTED against the
        EXACT compact shape — cycle-7 minor 2: the rev-8
        figures did not match the grammar's own arithmetic):
        serialization = json.dumps with (",",":") separators,
        keys = plain ASCII (escaping INFLATES: `\`/`"` cost
        +1 byte per escaped char, non-ASCII more); PER-ENTRY
        bytes = `"`+key+`"`+`:`+digits+`,` =
        len(key)+4+digits (the final entry drops one comma —
        a +1 byte rounding, immaterial); fixed document
        overhead ≈ 90 bytes (`"damage":false,` +
        `"source_archive":"…archived-0001-…":` + braces).
        Quotients at 1 MiB = 1,048,576 bytes:
        - 1-char id, count 0 (6 B/entry): ~174k — bounding
          computation, NOT an expected workload (rev 8,
          cycle-6 minor 2; no fleet holds a million 1-char
          ids; a byte quotient alone cannot infer a
          population of distinct 1-char ids — there are only
          95 printable ASCII singles!);
        - 26-char ULID shape, count < 10 (31 B/entry):
          (1,048,576−90)/31 ≈ 33.8k — THE OPERATIVE FIGURE
          (realistic minted shape; rev 8's "25-26k" was a
          stale pre-grammar estimate — WITHDRAWN);
        - same with one 2-char escape in the key (+2 B):
          ≈ 31.8k; every further escaped char costs ~300
          ids per MiB.
        The counts-grow term is second-order (a 10-digit
        count adds 9 bytes to ONE entry).
        The AVAILABILITY CONSEQUENCE
        is unchanged by the range: at saturation rotation
        refuses AND rebuild refuses — the recovery mechanism
        itself dies ON VALID INPUT after enough rotations,
        with NO in-protocol exit (the rev-6 "archive deletion"
        exit is WITHDRAWN below, so the ceiling is terminal
        under every ratified option until Q-J2-e lands)
        [REV-37: Q-J2-e RULED e1 — terminal-under-e1 accepted
        by the owner knowingly.]
        Options for the owner, restated on the honest facts:
        e2a) 1 MiB + ACCEPT the documented cumulative ceiling
             — DELETION EXIT WITHDRAWN (rev 7, closes cycle-5
             major 3): rev 6's "operator deletes archives
             out-of-band" is NOT a safety-preserving exit and
             is withdrawn as one: (a) deleting an archive does
             not shrink an already-current cumulative sidecar,
             so rotation can remain oversize AFTER deletion;
             (b) rebuilding from the reduced set silently
             DROPS every id/count that lived only in the
             deleted archives — spent repairs rearm and
             barred ids re-mint, the exact D1-A/freshness
             loss the identity universe exists to prevent.
             Under e2a, saturation has NO in-protocol exit:
             rotation and rebuild refuse and STAY refused;
             relief requires a ratified larger/partitioned
             representation (S-J2-f) or verified restoration,
             and ANY destructive reset is a separate explicit
             owner decision with the lost-enforcement-history
             consequence stated on its face;
        e2b) 1 MiB now + a ratified follow-up spec (S-J2-f:
             carry partitioning/retention) REQUIRED before the
             fleet approaches the ceiling — owner sets the
             watch obligation;
        e2c) partitioned carry sidecars (was e3) — DEMOTED,
             NOT IMPLEMENTABLE AS DRAFTED (rev 7, closes
             cycle-5 major 2): shards contradict EVERY single-
             sidecar clause this spec carries — R2 composes
             exactly ONE fixed-path VALID sidecar with zero
             globs; the validity grammar, the currentness
             test, the crash matrix, and rebuild replacement
             all describe that one file. No normative shard
             DISCOVERY (manifest, ordering past 9999, atomic
             multi-shard publication and its crash recovery,
             per-shard validity/currentness, access checks,
             rebuild over shards) exists, yet the cumulative
             pin demanded success under e2c — one implementer
             would read only the fixed sidecar, another would
             discover and compose shards: different counts,
             different freshness, same spec. e2c is therefore
             NOT an option until a COMPLETE sharded protocol
             (S-J2-f, full spec, own audit cycle) lands;
             until then it may NOT be ratified as a solution
             to any ceiling question.
        RECOMMENDATION REVISED (rev 7): e2b is the honest
        default for an unbounded-churn product (1 MiB now +
        S-J2-f partitioning spec REQUIRED before approach —
        the watch obligation owned); e2a acceptable ONLY with
        the owner bounding fleet identity churn below the
        ceiling IN WRITING (and only under the WITHDRAWN-exit
        label below). Readers bound any single sidecar/shard read
        at 1 MiB exactly like `_journal_records` bounds the
        journal — no new bound kind in any option;
  (rev 5's standalone "e3" option is now e2c above — the
  rev-6 recommendation matrix lives under e2.) NO implementation
  proceeds until Q-J2-e lands (it is load-bearing for the
  grammar AND for the rebuild command's eligibility).
  [REV-37 tag, R9 major 3: Q-J2-e RULED e1 at REV-36 — this
  gate is SUPERSEDED; the cap is load-bearing at 64 KiB.]

  Q-1A-a (OWNER CALL, rev 5 NEW, FULLY ENUMERATED rev 6 —
  cycle-4 major 8: rev 5 asked about "two classes" while the
  draft introduced MORE observable refusal behavior than it
  listed; the owner decides on the COMPLETE delta below): the
  full observable decision-refusal delta introduced by this
  spec, shipped-behavior -> new-behavior:
    N1 reader journal ENOENT + archives ⇒ NEW
       `journal-rotation-incomplete` (today: journal ENOENT
       returns empty carry, decisions proceed; ledger.py
       ~537-547);
    N2 reader journal PRESENT + marker PRESENT + sidecar
       absent/invalid ⇒ NEW `journal-carries-invalid` (R3;
       today: no marker concept, empty carry + live replay);
    N3 reader journal PRESENT + archives PRESENT + sidecar
       absent/invalid + marker ABSENT ⇒ NEW refusal (rev 6
       pre-marker/restore row treated as R3; today: empty carry
       + live replay);
    N4 `authorize()` journal/carry identity coverage (c)/(d) ⇒
       NEW `auth-id-already-used` extensions — reachable with
       ZERO rotations (the test-only id seam; astronomically
       unlikely for minted ULIDs but deterministically
       constructible);
    N5 `authorize()` AND repair decisions vs a `damage:true`
       sidecar ⇒ NEW `journal-carries-damaged` refusals (Q-J2-d
       d1 posture — only reachable if a rotation produced the
       damaged sidecar, but the REFUSALS are decision
       semantics).
    N6 (rev 7, cycle-5 major 8) fresh-fleet reader whose
       REQUIRED metadata listing FAILS (EIO/EACCES) ⇒ NEW
       `journal-carries-metadata-unavailable` refusal (the
       shipped journal reader never lists, so it has no such
       failure; the listing exists only to route R1 vs N3 —
       the fail-closed choice is mandated by major 7, so the
       ERROR delta is part of the offer too, not an
       implementation surprise).
    N7 (rev 9, cycle-7 major 3) `operator_purge_rotation_marker`
       (Q-J2-f f1, if ratified) DELIBERATELY changes decision
       results: removing the marker reopens R1 fresh-fleet
       routing = the D1-A rearm on an archives-lost fleet.
       Unlike N1-N6 this is NOT a fail-closed hardening delta
       — it ADMITS more (spent ids re-mintable) as the owned
       consequence of an authorized destructive act, so it
       cannot ride the "adds refusals only" reading of 1A and
       is submitted as its own class with the deployment of
       the purge command BLOCKED on its ruling. [REV-46: its
       ruling LANDED REV-45 — own ratified exception required;
       operative gate now = the ratified exception artifact.]
  All SIX of N1-N6 are fail-closed additions (they can refuse
  MORE, never admit MORE; N6 fires only where a metadata read
  failed — a successful listing keeps shipped outputs); N7 is
  the SEVENTH class and the first that is NOT fail-closed —
  its inclusion changes the offer's character, which is itself
  part of the question.
  The question: do they count as WITHIN the
  ratified 1A ("operator commands change no decision
  semantics"), or does 1A need an explicit amendment covering
  hardening deltas that ADD fail-closed refusals?
  BLOCKING RULE (rev 6, closes the second half of cycle-4 major
  8 — rev 5's "not blocked beyond the rows they introduce" left
  the deployable-unit question open): the DEPLOYABLE UNIT is
  COMMAND + ITS REQUIRED READER ROWS ATOMICALLY — rotation and
  rebuild may NOT ship without R2/R3/N1/N3 (a rotation whose
  reader rows are absent composes fresh-carry against invisible
  archived history = the undercount this spec exists to
  prevent), and that unit's reader rows ARE part of the delta.
  Therefore implementation AND deployment of: (U1) the N4
  authorize coverage delta, (U2) the N1+N2+N3 reader refusal
  rows, (U3) the N5 damage-posture refusals, (U4) the two
  operator commands (they are inseparable from U2), and (U5,
  rev 7) the fresh-fleet listing + its N6 error refusal
  (inseparable from the R1-vs-N3 routing that U2 needs) are
  ALL BLOCKED until Q-1A-a lands. [REV-36: Q-1A-a RULED (general
  fail-closed amendment) — U1-U5 BLOCK LIFTED per the LEDGER'S
  DERIVED APPLICATION of it [REV-40 qualification, cycle-44
  major: "N1-N6 within amended 1A, therefore U1-U5 lifted" is
  the ledger's reading, not an itemized owner approval; R10
  cycle 45 verified each N1-N6 class as refusal-adding]; N7
  routed to Q-1A-b [REV-45: RULED — own ratified exception
  REQUIRED; purge deployment gated on that exception, not on
  the amended 1A]. The ONLY
  unblocked artifacts are ~~pure spec/grammar work and the
  R1/R2/R5 read paths~~ [REV-37 correction, R9 major 4: that
  restriction is the PRE-RULING state and is SUPERSEDED by the
  REV-36 amendment (as derived-applied, see above) — U1-U5
  implementation is unblocked (per-spec; pins unimplemented);
  the
  surviving restrictions are the atomic command+reader-rows
  deployment rule and the purge-deployment gate [REV-45: Q-1A-b
  RULED — own ratified exception required; that exception is the
  gate from REV 45 on].]
  No assumed amendment beyond the REV-36 one, no silent
  narrowing.

  Pins planned at implementation (next ids after F59): rotation
  happy path + archive digest recorded; damaged journal rotates
  verbatim with damage:true AND prior carries+keys UNCHANGED;
  TWO ROTATIONS preserve the first's counts; STALE sidecar
  replays EVERY archive above source_archive; crash 6->7 needs
  only step 7; NO-sidecar + damaged chain ⇒
  `journal-rotate-reconstruct-damaged` zero bytes; R3 ROW (rev 5
  blocker pin): journal present + marker present + sidecar
  deleted ⇒ readers refuse `journal-carries-invalid`;
  `operator_rebuild_carries()` succeeds and decisions resume
  with EXACTLY the pre-loss carries+keys; rebuild with a VALID
  + CURRENT sidecar refuses `carries-rebuild-not-needed`
  byte-identically (rev 6: the guard is currentness-qualified);
  rebuild on a damaged chain refuses `carries-rebuild-damaged`
  leaving the journal UNTOUCHED (mutation — rebuild renames or
  truncates the journal ⇒ RED; mutation — rotation "helpfully"
  rebuilds on the R3 state ⇒ RED — command separation is the
  closure); rotation on the R3 state refuses
  `journal-rotation-incomplete` naming the rebuild command;
  exhausted id stays exhausted across rotation AND across
  rebuild; R1 row: fresh-fleet fleet reads byte-identical to
  shipped (mutation — reader requires marker ⇒ RED on fresh
  fleet); R2 row: valid sidecar + damage:true ⇒ REPAIR
  decisions AND `authorize()` refuse `journal-carries-damaged`
  (rev 6 enumeration pin, cycle-4 major 7 — a mutation making
  authorize proceed under damage ⇒ RED) while consume/resolve/
  APPLIED paths proceed byte-identically; NO glob performed on
  any VALID-sidecar read (cost pin REV-6 SCOPE: instrument —
  the present-journal reader performs zero listdir/glob calls
  when the sidecar is VALID; fresh-fleet reads perform AT MOST
  one glob, refuse-state reads zero — mutation: glob on the
  valid-sidecar path ⇒ RED); `source_archive` naming nothing on
  disk + present journal + VALID-otherwise sidecar ⇒ readers
  COMPOSE (existence is operator-side only) while the rotation
  command's currentness check refuses (rev 5 row-separation
  pin; rev 6: `operator_rebuild_carries()` REPLACES the stale/
  orphan sidecar — pin asserts the new eligibility and that
  post-rebuild the sidecar is current); REV-6 ELIGIBILITY
  PINS (cycle-4 majors 2/3/9): rebuild with journal present +
  NO marker + NO archives + no sidecar refuses
  `carries-rebuild-ineligible` ZERO BYTES (mutation: replay an
  empty chain + fabricate `source_archive` ⇒ RED — a fresh
  fleet must stay exactly R1); first-rotation OVERSIZE
  refusal leaves NO marker (mutation: create marker before
  preflight ⇒ RED); REV-7 MARKER-ORDERING pins (cycle-5 major
  1): marker created ONLY after the archive rename — crash
  between rename and marker create ⇒ journal ENOENT + archive
  present ⇒ R4 re-entry completes (rotation NOT blocked);
  conforming writers NEVER leave marker-durable-without-
  archive-durable (REV 9 WORD FIX, cycle-7 major 6: rev 8's
  pin claimed conforming writers never leave "marker+no-
  archives" AT ALL — false: the rename-durable/marker-absent
  window is conforming and reachable (window (b), MARKER
  section); the pin's sweep asserts the TRUE invariant — no
  (step, persistence) outcome yields marker-durable-without-
  archive-durable — and PINS window (b) as a defined,
  completing state, not a violation:
  exhaustive crash-point sweep at every step boundary AND —
  rev 8, cycle-6 blocker 1 — at every PERSISTENCE boundary
  WITHIN the steps (rename-entry durable vs not × marker-entry
  durable vs not × sidecar × journal): NO injected (step,
  persistence) outcome yields marker-durable-without-archive-
  durable; rename-durable+marker-absent yields the completing
  R4/re-entry cell (positive pin per rev 9); mutation: drop
  the pre-marker directory fsync ⇒ RED at the persistence
  sweep; mutation: marker before rename ⇒ RED at the sweep);
  rebuild NEVER deletes: archives-absent branch leaves the
  marker in place and refuses ineligible (mutation: rebuild
  unlinks the marker ⇒ RED — the cycle-5 BLOCKER mutant);
  pre-marker state (archives present +
  journal present + sidecar absent + marker absent) ⇒ readers
  REFUSE (N3) and rebuild is ELIGIBLE and restores the full
  chain; zero counter WRITE SEQUENCE and final value/flag
  matched at the resolve boundary, the malformed run
  INSTRUMENTED THROUGH ITS REFUSAL (rev 6 seam, cycle-4 major
  4 — see the S-A1-R v7 pin (single normative protocol, rev 7
  supersedes the stale rev-5 text): the healthy control's prefix
  is compared against the malformed run's ENTIRE counter-write
  sequence through the refusal; mutation: one extra
  `_write_counter` AFTER `_resolve_locked` returns and before
  the malformed refusal ⇒ RED); seq hygiene: duplicate parsed value ⇒
  `journal-rotate-seq-ambiguous`; non-decimal spelling (`0x0001`,
  `+0001`) ⇒ same refusal; seq past 10000 orders numerically;
  LISTDIR-ERROR pins (rev 7, cycle-5 majors 7/8): fresh fleet
  whose listing raises (injected EIO and EACCES) ⇒ decisions
  refuse `journal-carries-metadata-unavailable` zero bytes
  (mutation: treat the error as an empty listing and proceed
  ⇒ RED — fail-open on I/O error is the named failure);
  successful listing ⇒ byte-identical shipped outputs (the
  qualified claim, pinned); EARLY-ROTATION pin behavior per
  the corrected direction (ii) above; ZERO
  consumption-log / AUTH / EXISTING-sidecar writes; marker:
  exists after first rotation, readers stat-only, `_check_acce
  ss_controls` covers marker+sidecar+archives; step-0 mode
  repair pins (crash rename->chmod ⇒ next invocation of EITHER
  command repairs + dir fsyncs; startup accepts 0600-pending);
  OVERSIZE PREFLIGHT leaves the journal UNTOUCHED and NO marker
  (rev 6); MIRROR PREDICATE pins (rev 6, cycle-4 major 6):
  escape corpus RANKED BY R NOT LENGTH — an id shorter in
  characters but full of `"`/`\`/non-ASCII must rank ABOVE a
  longer plain id when its serialization is bigger (mutation:
  rank W by len() ⇒ RED at the escape/shorter-but-escaped
  boundary); short-timestamp boundary: journal whose real
  intents carry short `at` while R assumes AT_MAX ⇒ predicate
  may say full while the writer would accept — pin asserts
  direction (ii) PERMITS AND PERFORMS THE EARLY ROTATION
  CLEANLY (rev 7 corrected c1 semantics: journal archived
  verbatim, sidecar current, decisions resume; mutation: a
  predicate-full state REFUSES the rotation the gate should
  permit ⇒ RED); RESIDUAL pin (i): incoming id with R > W ⇒
  `_journal_append` may refuse while predicate says not-full
  (asserts the documented direction ONLY — under c1 a
  not-"full" journal is not rotatable, which IS residual (i)'s
  named availability cost, asserted as such); c3 override pins (if ratified; rev 6
  split): (a) override call WITHOUT the asserted-evidence
  argument ⇒ `journal-rotate-override-unasserted` zero bytes
  (mutation: accept an unasserted call ⇒ RED); (b) override
  WITH evidence on an EMPTY journal ⇒
  `journal-rotate-not-needed`; (c) override WITH evidence
  on a healthy nonempty
  journal (the asserted event is unverifiable by design) ⇒
  proceeds with hygiene + target-exists + carry/damage
  preflight INTACT and archives verbatim — proves the pin
  distinguishes missing assertion from asserted-but-unverifiable
  (rev 5's single pin conflated them); Q-J2-e pins (rev 6):
  per-journal: worst-shape journal (max distinct ids at
  minimum record size) replays to a carry strictly under the
  cap [REV-38 correction, R9 cycle-41 major 2: under the
  ruled e1 (64 KiB) a valid worst-shape journal CAN exceed
  the cap — that case is the ACCEPTED e1 availability
  ceiling and must be pinned as a REFUSAL fixture, not as an
  under-cap replay. Pin set: under-bound fixture replays
  strictly under 64 KiB; valid worst-shape over-bound input
  refuses `journal-carries-oversize` (documented ceiling,
  not a bug); cumulative test below stands];
  CUMULATIVE (cycle-4 major 1): TWO rotations of disjoint
  near-cap id sets whose combined carry exceeds the cap ⇒
  preflight refuses `journal-carries-oversize` and rebuild
  ALSO refuses — the pin ASSERTS the documented cumulative
  ceiling under [REV-37, R9 cycle-39/40 major 2: e1 RULED at
  REV-36 — the ceiling is the 64 KiB cumulative one, ACCEPTED;
  pins to be written at implementation are e1-specific:
  under-bound replay succeeds, valid-input over-bound refusal,
  cumulative ceiling under 64 KiB. The pre-ruling phrase
  "whichever of e2a/e2b the owner ratifies" is SUPERSEDED)
  (rev 7: e2c carries NO pin — it is demoted, no protocol; a
  mutation "helpfully" implementing shards ⇒ RED as
  out-of-spec); grammar corpus: negative/bool/float
  values, bad `damage` type, zero-value key retention (a
  durable-repaired replay KEEPS the key — mutation: prune zero
  keys ⇒ freshness RED after rotation), over-cap ⇒
  `journal-carries-oversize`.

  CYCLE STATUS (S-J2-R): v1 self-audit -> cycle 1 CHANGES
  REQUIRED (7M) -> rev 3 -> cycle 2 CHANGES REQUIRED (1B/9M) ->
  rev 4 -> cycle 3 CONFIRMING CHANGES REQUIRED (1B/7M/3m; CODE
  3/SPEC 8) -> rev 5 -> cycle 4 CONFIRMING CHANGES REQUIRED
  (1B/10M/2m; CODE 3/SPEC 10; three cycle-3 minors confirmed
  RESOLVED; five rev-5 regressions identified and closed in rev
  6) -> rev 6 folded here -> cycle 5 CONFIRMING CHANGES
  REQUIRED (0B/8M/2m + 1 BLOCKER: 1B/8M/2m; CODE 0 / SPEC 11 —
  first CODE-clean cycle; four rev-6 regressions caught and
  closed in rev 7; NEW owner call Q-J2-f from the blocker) ->
  rev 7 folded here -> cycle 6 CONFIRMING CHANGES REQUIRED
  (2B/5M/2m; CODE 0 / SPEC 9 — second CODE-clean cycle; both
  blockers closed in rev 8; NEW owner call Q-J2-g from
  blocker 2) -> rev 8 folded here -> cycle 7 CONFIRMING
  CHANGES REQUIRED (2B/6M/3m; reported CODE 1 / SPEC 10,
  re-verified CODE 0 / SPEC 11 — third CODE-clean cycle; the
  attestation log closes both blockers, the clearance-implication
  withdrawal, purge boundary + log spec, eligibility reorder
  and marker-prose fix close majors 1-6; NEW class N7
  submitted to Q-1A-a) -> rev 9 folded here -> cycle 8
  CONFIRMING CHANGES REQUIRED (3B/6M/3m; reported CODE 1 /
  SPEC 11, re-verified CODE 0 / SPEC 12 — fourth CODE-clean
  cycle; all three blockers were regressions of rev-9's own
  machinery (T4 exception, torn-tail ignore, rebuild-only
  gate); T4 journal-conditioned (withdrawn again rev 12 —
  see cycle 10), torn tail refuses + parser
  state machine, gate covers rotation re-entry, purge
  resequenced, eligibility canonicalized, hwm claims
  withdrawn to R-a/R-b, zero-byte claims enumerated
  per-boundary) -> rev 10 folded here -> cycle 9
  CONFIRMING CHANGES REQUIRED (2B/6M/2m; CODE 0 / SPEC 10 —
  fifth CODE-clean cycle; disposition table regressed 5 /
  still-open 5 / resolved 2 with 4 of 5 regressions from
  rev-10's own machinery; T4 split O1-prerequisite vs
  O2-eligibility, crash-window recovery contract, complete
  log grammars + journal by reference, zero-byte
  bytes-vs-metadata enumeration extended) -> rev 11 folded
  here -> cycle 10 CONFIRMING CHANGES REQUIRED (1B/7M/4m;
  CODE 0 / SPEC 12 — sixth CODE-clean cycle; the BLOCKER was
  rev-11's own T4 fold-over: the operative site still
  carried the withdrawn journal-conditioned exception —
  T4 now UNCONDITIONAL everywhere, crash-window abandoned-
  act contract rewritten (no in-protocol completion;
  residual R-c), step-(4) split unlink vs dir-fsync in the
  purge failure contract, retry-hwm pin corrected to byte-
  equality oracle, single canonical log schemas) -> rev 12
  folded here -> cycle 11 CONFIRMING CHANGES REQUIRED
  (0B/4M/3m; CODE 0 / SPEC 7 — SEVENTH CODE-clean, FIRST
  BLOCKER-FREE SINCE CYCLE 8; post-purge coverage reset
  last_hwm := 0, pin fixture completed to canonical schema,
  window (a) split (a1)/(a2), AUTH post-rename wording) ->
  rev 13 folded here -> cycle 12 CONFIRMING CHANGES REQUIRED
  (0B/4M/2m; CODE 0 / SPEC 6 — EIGHTH CODE-clean; two rev-13
  propagation survivors + the non-discriminating-fixture-
  arithmetic subclass) -> rev 14 folded here -> cycle 13
  CONFIRMING CHANGES REQUIRED (0B/4M/3m; CODE 0 / SPEC 7 —
  NINTH CODE-clean; T4's raw newest-entry operand survived
  the coverage-reset fold; the rev-14 (a2) observable was
  undefined on purge-ending/empty logs (REGRESSION of a
  rev-14 fold-in — the class a 5th cycle); the purge 4b row
  still asserted unlink durability against the AUTH
  discipline; `purge-in-flight-refuses` fixture cannot RED
  its named ANY-purge mutant; 3 MINORS: suite doc count
  87 vs measured 89, body status log stopped at cycle 10 /
  stale rev-label in the historical note, the mandated
  sweeps incomplete = lower bound) -> rev 15 folded here ->
  cycle 14 CONFIRMING CHANGES REQUIRED (0B/2M/2m; CODE 0 /
  SPEC 4 — TENTH CODE-clean; major 1 = the rev-15 (a1)/(a2)
  BRANCH PREDICATES still spoke in raw entry-seq terms
  against the coverage observable rev 15 itself defined
  (observable fixed, its branch tests not — the propagation
  class a 6th cycle, this time ONE PARAGRAPH away); major 2
  = the rev-15 reworked positive control asserted
  unqualified "PROCEED" on a state whose own eligibility
  refuses (valid-sidecar ⇒ `carries-rebuild-not-needed`
  under BOTH rule and mutant — unsatisfiable fixture, the
  non-discriminating-pin subclass a 3rd instance); 2 MINORS:
  the cycle-13 body log omitted its minors vs the foot log
  (fixed by this entry), the refusal/dialect/pin sweeps
  unfinished a 5th cycle = lower bound) -> rev 16
  folded here -> cycle 15 CONFIRMING CHANGES REQUIRED
  (0B/3M/3m; CODE 0 / SPEC 6 — ELEVENTH CODE-clean; major 1
  = the parser paragraph made the epoch reset conditional on
  marker-absence while the grammar made it unconditional
  (two conforming parsers, different T4 states); major 2 =
  the companion pin's paragraph STILL asserted unqualified
  proceed after rev 16's gate-only binding (propagation
  class a 7th instance); major 3 = the gate-only control
  left a later re-applied in-flight refusal UNCAUGHT —
  fixed end-to-end on the refusal CODE while legitimate
  downstream outcomes stay unasserted; minors: a duplicated
  fragment from the rev-16 edit itself, the dialect lead-in
  stated the rule without its journal qualification (fixed
  locally), sweeps incomplete a 6th cycle) -> rev 17 folded
  here -> TARGETED POST-REVIEW (same rules, NOT a counted
  terra cycle) CHANGES REQUIRED (0B/1M/1m; CODE 0 / SPEC 2;
  major = the shared pin was still NAMED "gate-only" in the
  parser paragraph AND the companion after rev 17's
  end-to-end extension under-described the binding
  (propagation class 8th instance); minor = refusal-code
  literals split across physical lines) -> rev 18 folded
  here (the shared assertion RELABELLED a TWO-CHECK SET —
  CHECK 1 gate clearance + CHECK 2 end-to-end refusal-code
  absence — at both sites with the "gate-only" shorthand
  explicitly WITHDRAWN as its name; all split literals
  joined) -> cycle 16 CONFIRMING CHANGES REQUIRED
  (0B/0M/2m; CODE 0 / SPEC 2 — TWELFTH CODE-clean, LOWEST
  COUNT OF THE ROUND, though the auditor disclaimed
  exhaustive major coverage: sweep-limited round; major 1
  class did not fire — the C15-M1/M2/M3 dispositions came
  back RESOLVED at every operative site, the TWO-CHECK
  relabelling held at both pins; minor 1 = the WITHDRAWN
  "gate-only" name survived CURRENT-TENSE in the foot
  cycle-15 entry ("now bound to the same gate-only
  assertion") — propagation class a 9th instance, fixed at
  rev 19 with explicit historical-step framing; minor 2 =
  sweeps I-III still incomplete a 7th cycle — the ledger
  side DENT LANDED at rev 19: mechanical extraction over
  both bodies yields 88 candidate lines / 84 UNIQUE tokens
  [REV-22 CORRECTION: 78+10 lines, union dedups to 84 —
  "88 unique" was wrong] (~38
  refusal-code-shaped; candidate file
  ~/.tre/audits/sj2r/c17/codes-sJ2.txt) and ESTABLISHES
  THE FINDING that NO canonical refusal-enumeration
  SECTION exists to diff against (N1-N7 enumerate only
  the decision-semantics delta) — an owner decision:
  commission the canonical enumeration or scope sweep I
  down) -> rev 19 folded here -> cycle 17 CONFIRMING
  PASS WITH MINORS (0B/0M/1m; CODE 0 / SPEC 1 — THIRTEENTH
  CODE-clean; ALL cycle-16 dispositions came back RESOLVED
  or partially-verified with no regression — the tense
  reframes held at the named sites, Q-ENUM-a verified
  recorded in both logs, sweep IV re-verified 89 OK; the
  sole minor is the AUDIT-PROCESS DEFICIENCY itself: the
  auditor completed only parts of the mandated sweeps/
  attacks and could not produce a rev-18 baseline to prove
  the change boundary (the ledger is untracked, so no git
  baseline EXISTS — process answer at rev 20: snapshots
  are now taken before each fold, ~/.tre/audits/sj2r/
  revNN-baseline.txt, so the NEXT cycle can VERIFY-
  UNCHANGED mechanically); the deficiency pattern is now
  STRUCTURAL for sweep I — it CANNOT complete while
  Q-ENUM-a is open, so future rounds scope it down by
  standing rule — and for the rest the fix is SINGLE-
  FULL-COMPLETION scoping: cycle 18's mandate is ONE
  complete attack (A5, the S-A1 body — REMAINING two
  cycles running) plus the tense sweep, everything else
  explicitly out of scope) -> rev 20 folded here (log-area
  only: cycle-17 entries, standing-rule notes, baseline
  snapshots from rev 20 on) -> cycle 18 CONFIRMING PASS
  WITH MINORS (0B/0M/1m; CODE 0 / SPEC 1 — FOURTEENTH
  CODE-clean; the rev-20 baseline-diff mechanism WORKED —
  rev 20 verified log-area-ONLY against
  ~/.tre/audits/sj2r/rev20-baseline.txt, closing the
  change-boundary objection (A1-A4/A6/A8 + sweeps II/III
  VERIFIED-UNCHANGED citing that diff; rollout labels, 10
  owner calls [REV-22: the auditor re-verified a WRONG
  count — ELEVEN including Q-J2-h; the tally error below
  propagated into this re-verification], suite 89 OK all
  re-verified) — BUT the
  SINGLE-FULL-COMPLETION mandate FAILED a SECOND consecutive
  cycle: neither the A5/S-A1 mandate nor the tense sweep
  finished, so the coverage deficiency was judged
  STRUCTURAL for a one-shot detached auditor over a
  4k-line doc [REV-22: softened — two failed attempts are
  a REPEATED OBSERVED limitation, not proof of
  impossibility], not a scoping mistake; REV 21 (log-area only) records the
  ROUND-TERMINATION CALL: the cycle-17 standing rule (a
  third consecutive coverage-deficiency ends the round's
  usefulness) plus two landed deficiencies means the round
  PAUSES after rev 21 [REV-22: NO such rule exists — the
  written cycle-17 rules are R1/R2/R3; the pause stands as
  ORCHESTRATOR JUDGMENT, and is RESCINDED by owner
  instruction for cycles 19-22] — remaining work (the S-A1/A5 deep
  pass and the full tense-sweep adjudication) should run as
  DEDICATED single-subject sessions, not breadth rounds;
  NO new TEXT defect since rev 18 — the withdrawn-name class
  has NOT fired again (the cycle-18 hits at every examined
  site were correct tenses: withdrawal statements, marked
  historical steps, or quoted findings). Harness-side
  confirmation at rev 21: the only `gate-only`/`proceed`
  survivors in OPERATIVE text (lines ~1212, ~1489, ~1519)
  are WITHDRAWAL statements naming the step they replace —
  verified, not a finding) -> rev 21 folded here (log-area
  only; pre-fold snapshot ~/.tre/audits/sj2r/rev21-baseline.
  txt taken) -> POST-REVIEW AUDIT ON REV 21 (0B/0M/4m;
  SPEC 4 / CODE 0 — the FIFTEENTH code-clean; findings:
  (1) MAJOR-class COUNT ERROR — the owner-call tally said
  TEN but omitted Q-J2-h (the R-c whole-dir-restore exit,
  placeholder at the T4-gap sites, named 3x, never
  ruled): the true tally is ELEVEN (Q-J2-a/b/c/d/e/f/g/h,
  Q-1A-a, Q-A1-a, Q-ENUM-a) — fixed at every tally site
  (an omission in the NEW tally line, not a spec change —
  Q-J2-h's text always existed); (2) MINOR — the rev-21
  pause was MIS-ATTRIBUTED to a non-existent rule: the
  cycle-17 standing rules are R1 (sweep I scoped down),
  R2 (baseline snapshots), R3 (single-full-completion) —
  NO third-consecutive-ends-the-round rule was ever
  written (the phrase was auditor-paraphrase folded as if
  normative); the PAUSE STANDS on its own merits (two
  consecutive coverage deficiencies with the mandate
  already narrowed to two items), now recorded as
  ORCHESTRATOR JUDGMENT, not rule application; (3) MINOR —
  "STRUCTURAL: one-shot auditors CANNOT complete deep
  passes" overstated the evidence: two failed attempts
  establish a REPEATED OBSERVED limitation, not proof of
  impossibility or its cause — softened to observed
  limitation, dedicated-session format stays as the
  tested-against hypothesis; (4) MINOR — the 88-token
  extraction claim misdescribed the artifact: the two
  candidate files hold 78+10=88 LINES but the union
  deduplicates to 84 UNIQUE tokens (100% overlap of the
  sA1 file into sJ2) — wording fixed at both claim sites;
  round PAUSE RESCINDED by owner instruction: four further
  cycles mandated (19-22) on the corrected rev 22) -> rev
  22 folded here (log-area only; pre-fold snapshot
  ~/.tre/audits/sj2r/rev22-baseline.txt taken). Owner calls
  still open: Q-J2-a/b/c/d/e/f/g/h, Q-1A-a, Q-A1-a,
  Q-ENUM-a
  (11: Q-J2-h was ALWAYS open — the rev-21 tally line
  omitted it, fixed this rev; the newest is the sweep-I
  disposition — commission
  the canonical refusal enumeration or scope the sweep
  down).

### S-A1 — partial AUTH line recovery (DECIDED by owner: B)
A short AUTH write now raises (code fix, pinned). The protocol forbids
truncation (F10), so a partial line may remain and the AUTH file is then
classified malformed, failing every authorization closed.
- A) Operator rewrite of the AUTH file through the reset channel, old
  file quarantined.
- B) Fresh AUTH file, old one renamed and kept.
Recommendation: B (never rewrite evidence in place).
Decision: **B** (owner: "b"). Interpretation: fresh AUTH file; the
  torn file is renamed and kept. NOT a precedent-based match: 1A's
  rename-never-delete rule governs the lock sidecar only. The atomicity
  and crash-safety of the rename-then-create sequence is UNSPECIFIED
  and needs a sub-spec before implementation.

SUB-SPEC S-A1-R v7 (DRAFT rev 8 — revs 3/4/5 folded terra
  cycles 1/2/3; rev 6 folds the terra cycle-4 CONFIRMING audit
  (rev 8 folds the terra cycle-11 CONFIRMING audit's MAJOR 4
  ONLY (CODE 0/SPEC 7 for the round): the post-rename error
  bound no longer says the rename is "DURABLE" — a FAILED dir
  fsync cannot establish survival of power loss — it is
  NAMESPACE-VISIBLE (AUTH absent = recovery achieved in the
  running system) and DURABILITY-PENDING per the universal
  fault contract, with the idempotent re-run route stated;
  same wording discipline as the purge 4b row in S-J2-R),
  (cycle 4 = 1 blocker / 10 majors / 2 minors across both
  sub-specs; the items touching THIS sub-spec are: the blocker
  (scan-bound can permit inventory-cap recovery unevidenced —
  REGRESSION OPENED BY REV-5'S OWN NO-SHORT-CIRCUIT FIX), major
  4 (matched-boundary pin misses its named post-boundary
  mutation — STILL OPEN from cycle 3), major 10 (the 8x scan
  headroom claim is false of the shipped line cap — a CODE-
  class false spec-claim, doc corrected, ZERO edits to accepted
  code), plus the shared Q-1A-a enumeration (major 8) folded in
  S-J2-R rev 6 and referenced here; all judged valid; AWAITING
  OWNER RATIFICATION; no code until ratified; prior history at
  the S-A1 decision entry):

  RATIFIED WORDING CARRIED (owner reply 2026-11-14, S-A1
  tranche): "fail-closed retryable s-a1." Normative content:
  - FAIL-CLOSED (existing, unchanged): a malformed AUTH read
    refuses every authorization (`authorization-file-malformed`);
    this clause pins that behavior stays EXACTLY as is.
  - RETRYABLE (pin REVISED AGAIN in rev 5, closes cycle-3 major
    6): the ratified word scopes to the D1-A repair ledger — a
    malformed-path refusal burns zero D1-A attempts, grants
    none, the operator may retry the DECISION indefinitely. The
    resolve-attempts counter is the PENDING-EPISODE budget
    (separate ratified record, v37 AUD36-M1). Cycle-3 major 6
    found the rev-4 pin (write-sequence + final value/flag vs
    "the corresponding healthy-AUTH execution") NON-
    DISCRIMINATING AS SPECIFIED: with a healthy AUTH file the
    run continues PAST the malformed check and may write a real
    repair, while the malformed run stops there; and a FAILED
    or EXHAUSTED pending resolve exits inside `_resolve_locked`
    BEFORE the AUTH check — so "the malformed refusal run vs
    the healthy run" is not a matched pair in those cases
    (`ledger.py` ~1220-1247, ~1457-1465). THE REV-5 PIN SHAPE
    IS SUPERSEDED (rev 6, cycle-4 major 4 — STILL OPEN in
    cycle 5: rev 5's protocol cut BOTH runs at the moment
    `_resolve_locked` returns, so an extra `_write_counter`
    inserted AFTER that return and BEFORE the malformed
    refusal was invisible to the compared sequences; leaving
    it normative beside the revision made the two protocols
    give opposite results for the mutation the pin promises to
    catch — replaced, not annotated): THE REV-6 PROTOCOL
    (canonically normative — the PINS section below states
    ONLY this one): instrument `_write_counter`; SAME pending
    history, SAME sidecar state. Healthy control: STOPPED AT
    RETURN via a wrapper of `_resolve_locked` that records the
    counter-write sequence + returned class and then discards
    the continuation (nothing repairs inside the comparison
    window); malformed run: instrumented THROUGH ITS REFUSAL —
    the compared object is the healthy prefix vs the malformed
    run's ENTIRE counter-write sequence from lock acquisition
    to the raised `authorization-file-malformed` (no shipped-
    code edit; wrapper seam verified viable in cycle 5:
    `_resolve_locked` returns normally to `repair()` before
    the malformed check, ledger.py ~1457-1465). PENDING-
    EXHAUSTED is asserted SEPARATELY as its own refusal class
    from the resolve boundary (the malformed check is never
    reached); a healthy control whose resolve SUCCEEDS vs a
    malformed input whose resolve FAILS are pinned as
    different gates; any EXTRA counter write on the malformed
    path — including between return and refusal — goes RED.
  - THE ACTUAL DELTA remains the missing operator path: today a
    malformed AUTH file can only be cleared by renaming files
    OUTSIDE the protocol (invisible to the startup access
    checks); `operator_recover_auth_file()` moves that act
    INSIDE the protocol with verified archive handling.

  Command: `operator_recover_auth_file()` — an operator action,
  NOT a decision. Takes the exclusion lock (1A conformance),
  performs NO resolve (`_resolve_locked`, the attempt counter,
  and the journal untouched), writes zero bytes to the
  consumption log. Unexpected I/O errors raise as contract-class
  `LedgerError` (`auth-recover-io`, zero written bytes) — never
  a raw OSError (F54 precedent). BOUND (rev 11, cycle-9 major
  5): an I/O error AFTER the fresh-file rename completed is a
  COMPLETED recovery whose follow-up (dir fsync/verify) failed:
  report `auth-recover-io`, never "zero bytes" — the zero-claim
  covers refusals BEFORE the rename only. DURABILITY WORDING
  (REV 13, cycle-11 major 4): the rename is stated
  NAMESPACE-VISIBLE (the AUTH file is absent in the running
  system — recovery ACHIEVED), NOT "durable" — a FAILED dir
  fsync CANNOT establish the rename survives power loss (the
  universal fault contract's durable-pending class applies:
  on power loss inside the fsync-lost window the archive entry
  and/or the AUTH file may return; the next invocation re-runs
  the recovery — rename of a re-appeared torn file to a NEW
  archive seq, idempotent per the replay laws; report the
  state as durability-PENDING with the re-run route, the same
  discipline as the purge 4b row).

  UNIVERSAL I/O FAULT CONTRACT (shared with S-J2-R, cycle-3
  minor 1 wording): every invocation performs exactly ONE
  directory fsync at ENTRY under the lock before any gate (so a
  fault at step 3's dir fsync is retired by the next invocation
  even when that invocation refuses `auth-recover-noop` — the
  step-0 repair branch runs BEFORE step 1; rev 5 minor 2 fixes
  the stale "step-1b MODE-REPAIR branch" label: mode repair is
  STEP 0, the cause gate is step 1b). ANY later successful
  directory fsync retires a durable-pending fault; the ENTRY
  fsync of every later invocation guarantees one occurs;
  startup checks are metadata-only and never fsync. A crash
  BEFORE any rename is genuinely zero-byte; "zero bytes" always
  means zero WRITTEN bytes.

  KEY ASYMMETRY vs S-J2-R (normative): `_read_auths` treats
  ENOENT as legitimately EMPTY (fresh fleet, F1) — so the
  rename ALONE is the recovery and NO crash window exists; the
  command deliberately does NOT create the new file (the first
  `authorize()` creates it, existing O_CREAT path, 0600);
  pre-creating an empty file would manufacture a second crash
  window where none exists. Spent-state after recovery:
  APPLIED-spent ids stay spent (log-derived); REPAIR-spent ids
  go DEAD `unknown-authId` (their spend-proof died with the
  file) but stay BARRED from re-minting by the identity universe
  below. Accepted loss (option B, ratified): valid-but-UNSPENT
  AUTHs inside the torn file are gone; everything the log proves
  still holds.

  IDENTITY UNIVERSE FOR FRESHNESS (rev 4, retained; retention
  mechanism FIXED in rev 5 per cycle-3 major 5): minted/
  caller-chosen ids are refused if the id appears in ANY of
  (checked under the mint's own lock, extending shipped
  `_log_names`): (a) any LIVE AUTH line; (b) any terminated
  schema-valid CONSUMPTION-LOG record (DEAD included — shipped);
  (c) any record of the LIVE JOURNAL (intent OR outcome); (d)
  any KEY of the `journal-carries` sidecar — and rev 5's
  KEY-RETENTION rule (S-J2-R b1: keys are NEVER pruned; a
  durable `repaired` zeroes the VALUE, the key remains forever;
  reconstruction rebuilds the key set from EVERY archived
  record including outcome-only and reset-to-zero identities)
  makes (d) a stable cumulative universe independent of replay
  COUNTS — closing cycle-3 major 5 (a journal-only id whose
  last archived action was a durable `repaired` was mintable by
  one conforming implementation and barred by another); (d)
  additionally: a `damage:true` sidecar makes `authorize()`
  refuse outright `journal-carries-damaged` (Q-J2-d d1) —
  identity history is known-lost, no mint proceeds.
  ARCHIVED-AUTH-ONLY ids (never in log, journal, or carries)
  are EVIDENCE-ONLY-INERT: spend authority comes only from live
  AUTH lines, D1-A counts only from journal+carry, APPLIED/3A
  only from the log — re-minting such an id grants nothing the
  dead line had; the argument is pinned (see PINS).
  1A HONESTY (rev 5, cycle-3 major 7 — escalated, shared with
  S-J2-R): coverage (c)/(d) is a NEW refusal class on the
  authorize path reachable with ZERO rotations. Rev 4's
  "reconciliation with the command's introduction" is NOT a
  reconciliation the ratified 1A wording supports; rev 5 routes
  the question to the owner as Q-1A-a and marks the authorize
  delta BLOCKED until answered. REV 6: Q-1A-a is ENUMERATED IN
  FULL (N1-N5 at rev 6; SIX classes N1-N6 and blocking units
  U1-U5 since rev 7 — cycle-6 minor 1 correction: the rev-6
  five/four totals are SUPERSEDED, the six/five enumeration
  was the normative one UNTIL rev 9 added N7 — SEVEN classes
  N1-N7 plus N7's blocking unit is normative since rev 9,
  cycle-8 minor 2 label fix) in S-J2-R rev 6 (cycle-4 major 8) — this sub-
  spec's contributions are N4 (coverage (c)/(d) mint refusals)
  and N5 (`journal-carries-damaged` authorize refusal); the
  rev-6 BLOCKING RULE (atomic command+reader-row units — SIX
  classes N1-N6 plus the rev-9 N7 purge-rearm class, and
  blocking units U1-U5 since rev 7; the rev-6 five/four
  totals are SUPERSEDED — the six/five enumeration plus N7
  is normative) in S-J2-R rev 6 (cycle-4 major 8) — this sub-
  spec's damage-posture refusal are blocked units until Q-1A-a
  lands [REV-37 tag, R9 major 4: Q-1A-a ruled at REV-36 — lifted PER
  THE LEDGER'S DERIVED APPLICATION of the general fail-closed amendment
  [REV-42 qualification, cycle-51 major 3: "lifted" is not an itemized
  owner approval of the individual blocking units; see the principal
  record at item 10(a) and the cycle-45 per-class verification; N7
  routing (Q-1A-b) unchanged [REV-45: Q-1A-b RULED — the purge
  class requires its own ratified exception; still unchanged as
  to this sub-spec's cleared units];
  the pure operator command `operator_recover_auth_file()`
  without the extended universe is NOT separately deployable
  either (the identity universe is its stated spent-state
  safety story — shipping it without coverage (c)/(d) reopens
  what it closes). No assumed amendment, no silent narrowing.

  Sequence under the held lock:
  0. ENTRY DIR FSYNC + MODE REPAIR (mirror of S-J2-R step 0;
     every AUTH archive at 0600 pending-mode is chmod to the
     ratified mode, idempotent, on EVERY invocation including
     ones that afterwards refuse; startup acceptance set for
     archives {ratified, 0600-pending}, live files exact 0600).
  1. AUTH file ENOENT ⇒ refuse `auth-recover-noop` zero written
     bytes (AFTER step 0 ran). Honest branch scope: a symlink /
     wrong owner/mode at the live path was refused at startup;
     ENOENT from the command's own rename is "absent"; other
     mid-run open errors ⇒ `auth-recover-io`.
  1b. CAUSE GATE (rev 4 order-independent counts, retained;
      SCAN BOUND FIXED in rev 5, closes cycle-3 major 2 — the
      rev-4 phrase "the reader's own bounded-read bound" refers
      to NOTHING in the shipped reader: `_read_auths` bounds a
      single retained LINE (16 KiB chunks; the bound is
      per-line/retention, not total-file — an arbitrarily large
      file of blank terminated lines reads to EOF legitimately,
      `ledger.py` ~978-1039), so the gate needs its OWN
      explicit numeric bound). REV-5 DEFINITION (headroom claim
      WITHDRAWN in rev 6, cycle-4 major 10 — CODE-class false
      spec-claim, doc-only correction): the gate scans
      the file in 64 KiB chunks with a TOTAL-BYTES-SCANNED cap
      `AUTH_RECOVER_SCAN_CAP = 8 MiB` (a NEW constant, named in
      the contract, pinned). THE REV-5 CLAIM "8x headroom: 1024
      lines x max line length is well under it; never reached
      by a valid-and-decidable file" IS FALSE OF THE SHIPPED
      READER: `CAPS["AUTH"]` = 64 KiB PER LINE, so 1024 schema-
      valid max-size lines approach 64 MiB, and blank
      terminated lines are legitimate and unbounded, so a
      healthy, fully decidable file CAN exceed 8 MiB (ledger.py
      ~982-989, ~1011-1027; the 16 KiB chunk size bounds a
      READ, never the file). HONEST TRADEOFF FOR THE OWNER:
      the cap is an anti-DoS bound on THIS command's memory/
      time only — hitting it costs recovery AVAILABILITY on
      huge-but-valid files (refuse scan-bound; the reader
      itself streams such files fine at decision time);
      alternatives are a bigger constant (e.g. 64 MiB = the
      theoretical all-max-line file) or content-aware skipping
      (more machinery); the draft keeps 8 MiB (operationally:
      a > 8 MiB AUTH file with ≤ 1024 entries is pathological
      padding) and labels the availability cost instead of
      denying it exists. EOF ⇒ decide; cap reached with no
      PROVEN decision (rev 6 precedence above) ⇒ refuse
      `auth-recover-scan-bound` (zero bytes). PRECEDENCE
      (rev-6 COMPLETE — replaces the rev-5 paragraph verbatim;
      order-independent): the scan NEVER short-circuits (the
      cycle-3 rule stands, NARROWED by the rev-6 fix below):
      it runs to EOF, or to the bound and then applies the
      rev-6 bound rule; at EOF: (valid_count >
      AUTH_INVENTORY_CAP? cap refusal REGARDLESS of malformed
      evidence anywhere — cycle-2 major 8 stays closed) :
      (malformed seen? torn) : (healthy refusal
      `auth-recover-not-malformed`). Deterministic,
      single-pass, no event
      ordering, no chunk-boundary dependency. Blank lines are
      not records and do NOT reset or defer the byte counter
      (they count toward the bound — pinned, cycle-3 named the
      blank-line file explicitly).
      REV-6 PRECEDENCE FIX (closes cycle-4 BLOCKER — rev 5's
      "cap reached with no decision yet" left "a decision
      already forced" ambiguous: malformed-seen with count ≤
      cap is NOT a forced decision at a NON-EOF bound, because
      the cap-precedence rule (overflow at ANY later offset ⇒
      cap refusal regardless of damage) means the complete file
      could still land on `auth-recover-inventory-cap` — a torn
      verdict taken at the bound would contradict what a full
      scan returns, and the two readings let one implementation
      rename (recover) a file another refuses as overflowing):
      AT A NON-EOF BOUND, the ONLY outcomes are:
        valid_count > AUTH_INVENTORY_CAP PROVED before the
        bound ⇒ `auth-recover-inventory-cap` (overflow proved);
        ANYTHING ELSE (including malformed seen, count ≤ cap,
        anything after the bound unknown) ⇒ refuse
        `auth-recover-scan-bound` (zero bytes) — an UNPROVEN
        overflow possibility BLOCKS the torn verdict; the
        operator raises the constant in a contract revision or
        reduces the file out-of-band, and a retry re-scans;
      AT EOF only, the full three-way precedence applies
      (overflow? : malformed? : healthy refusal). NO
      short-circuit stands (cycle-3); this fix NARROWS it: the
      scan never concludes BEFORE EOF except by PROVEN
      overflow. Pinned (cycle-4 blocker): malformed line before
      the bound + 1025th valid line AFTER the bound ⇒
      `auth-recover-scan-bound` (NOT torn, NOT cap); malformed
      before the bound + EOF with count ≤ cap ⇒ torn proceeds;
      bound with zero malformed and count ≤ cap ⇒
      scan-bound.
  2. Archive name `authorizations.jsonl.archived-<seq:04d>-
     <utc-e>`: canonical `:04d` spelling, decimal-only parse,
     UNIQUE parsed values (duplicate/non-parsing ⇒
     `auth-recover-seq-ambiguous` zero bytes); target exists ⇒
     refuse (rename would destroy evidence).
  3. `os.rename` AUTH → archive; apply Q-A1-a mode chmod; fsync
     the directory. Torn bytes VERBATIM (R-1). Faults: I/O FAULT
     CONTRACT above.
  4. Done. Repeatable: a rerun runs step 0 then step 1
     (`auth-recover-noop`).

  SCOPE BOUNDARY (operational, enforced by 1b): an inventory
  overflow ALWAYS refuses cap-only regardless of co-occurring
  damage ⇒ this command can never serve as a cap relief valve.

  Access control: every `authorizations.jsonl.archived-*` match
  joins `_check_access_controls` (owner uid, not a symlink, mode
  per the Q-A1-a acceptance set). While Q-J2-a/Q-A1-a is
  unanswered implementation of BOTH commands is BLOCKED — no
  silent default. [REV-36: Q-J2-a RULED a1 (0400) — BLOCKER
  LIFTED; implementation proceeds on 0400 + step-0 repair +
  step-5 chmod.]

  Q-A1-a (OWNER CALL, one ruling for both archive classes): AUTH
  archive mode follows whatever Q-J2-a decides (no split
  dialect). [REV-36: RESOLVED — Q-J2-a ruled a1 (0400), so both
  archive classes are 0400; BLOCKER LIFTED.]

  PINS planned at implementation (next ids after F59/C6_23):
  - CAUSE-GATE corpus: exactly 1024 valid + clean ⇒
    `auth-recover-not-malformed`; 1025th valid line ANYWHERE ⇒
    cap refusal on BOTH orders (valid-then-malformed AND
    malformed-then-1025-valid); torn-only ⇒ proceeds;
    BLANK-LINE file > 8 MiB ⇒ `auth-recover-scan-bound` (rev 5
    cycle-3 case — blank lines count toward the bound);
    overlong single line beyond cap ⇒ scan-bound (never
    streams unboundedly); REV-6 BLOCKER CORPUS (cycle-4):
    malformed near start + < 1025 valid lines before the bound
    + > 1024 valid total ⇒ `auth-recover-scan-bound` (mutants:
    torn-verdict-at-bound ⇒ RED; cap-verdict-at-bound ⇒ RED —
    ONLY the proved-overflow exception may conclude pre-EOF);
    same corpus with PROVEN overflow before the bound ⇒
    `auth-recover-inventory-cap`; healthy 9 MiB file of blank
    lines + ≤ 1024 valid ⇒ scan-bound refusal, ZERO bytes,
    reader decisions unaffected (the availability tradeoff,
    pinned as behavior not as an impossible state); MUTANTS (all genuinely
    distinguishable — cycle-3 major 9 closed in cycle 3, kept):
    byte-order classifier ⇒ RED on malformed-then-overflow;
    cap-only-ever ⇒ RED on torn-only proceed;
    count-without-duplicates ⇒ RED on duplicate corpus
    [REV-24 FIXTURE SPECIFIED, closes cycle-20 major; bracket
    wording REWORKED AT REV 25 per cycle-21 minor — the
    CYCLE-21-AUDITED FIXTURE IS THE HEALTHY ONE: 1,025
    schema-valid records carrying AT MOST 1,024 distinct
    auth-ids (one id repeated exactly twice), NO torn line,
    file EOF well under the 8 MiB bound; VALID-record
    counting ⇒ `auth-recover-inventory-cap` (the 1025th valid
    record is counted — the cap fires BEFORE EOF is
    reached, per the cause-gate rule); UNIQUE-id counting mutant ⇒ 1,024
    ⇒ healthy refusal `auth-recover-not-malformed` — the
    mutant flips the verdict BY CONSTRUCTION (cycle 21
    walked it: DISCRIMINATES). The earlier wording's
    "proceed ... or torn-route with damage" was WRONG for
    this fixture — a clean file has no torn route; a
    damaged variant (same counts PLUS a torn line after
    the cap-relevant records) is a SEPARATE corpus, not
    this fixture's outcome];
    SHORT-CIRCUIT scan that stops at first malformed ⇒ RED on
    malformed-then-overflow (the no-short-circuit rule is now
    itself pinned).
  - torn tail ⇒ recovery ⇒ next `authorize()` succeeds against
    the fresh file; archive holds the torn bytes byte-for-byte.
  - ENOENT ⇒ `auth-recover-noop` zero written bytes; rerun-
    after-success ⇒ same refusal; entry dir fsync runs BEFORE
    the noop refusal (mutation: skip entry fsync on ENOENT ⇒
    durable-pending fault never retires ⇒ RED).
  - RETRYABILITY PIN (rev 5, replaced — cycle-3 major 6):
    matched-boundary protocol as specified above; explicit
    separate pins that pending-exhausted refuses from the
    RESOLVE gate (never reaching the malformed check) and that
    the healthy control's post-boundary window writes nothing;
    mutation: one extra `_write_counter` call on the malformed
    path landing on identical final bytes ⇒ RED via the write-
    sequence comparison. REV-6 SEAM FIX (cycle-4 major 4 —
    cycle-3 major 6 STILL OPEN: the rev-5 protocol records BOTH
    runs only until `_resolve_locked` returns, so a mutation
    inserting an extra `_write_counter` AFTER that return and
    BEFORE the malformed refusal is invisible to the compared
    sequences — the pin could not catch the mutation its own
    text promises to catch; ledger.py ~1220-1247, ~1461-1465):
    the healthy control's sequence is cut AT the boundary
    (discard after return), but the MALFORMED run is
    INSTRUMENTED THROUGH ITS REFUSAL — the compared object is
    the healthy prefix vs the malformed run's ENTIRE
    counter-write sequence from lock acquisition to the raised
    `authorization-file-malformed` (seam named: a wrapper/
    monkeypatch of `_resolve_locked` returns normally to the
    caller; instrumentation stays installed in the caller
    frame until the raise — no shipped-code edit); mutation
    pin (explicit, rev 6): extra `_write_counter` between
    `_resolve_locked` return and the malformed refusal ⇒ RED.
  - SPENT-BEHAVIOR PINS (carried): APPLIED-spent id still
    refuses after recovery; REPAIR-spent id classifies DEAD
    (`unknown-authId`) and stays barred (log coverage (b)).
    [CYCLE-23 PATH QUALIFICATION (rev 27, SPEC): walked
    DISCRIMINATING with fixtures+mutants (cycle-23 entry).
    Post-recovery the old AUTH is ABSENT — the shipped
    repair() path checks missing-AUTH BEFORE spent
    (ledger.py 1461-1471), so this pin's assertion is
    classify().spent membership + log-based MINT refusal
    (`auth-id-already-used`); it asserts NO
    `authorization-spent` refusal from a live AUTH.
    `unknown-authId` and `authorization-stale` are
    candidate-file GAPS (R1-registered at cycle 23).]
  - FRESHNESS-UNIVERSE PINS (rev 5 additions): journal-only
    exhausted id (2 intents, zero log records) ⇒ test-only mint
    refuses (coverage (c)); same id THROUGH rotation ⇒ mint
    refuses via key coverage (d); id whose ONLY archived record
    is a durable `repaired` OUTCOME ⇒ carry KEY present (value
    0) ⇒ mint REFUSES (rev 5 retention pin — mutation: prune
    zero-value keys ⇒ RED); `damage:true` sidecar ⇒
    `authorize()` refuses `journal-carries-damaged` zero bytes;
    evidence-only-inert boundary pin: id in an ARCHIVED AUTH
    only (never log/journal/carries) ⇒ mint ACCEPTS and the new
    AUTH carries zero spend history.
  - zero consumption of EXISTING sidecars; refuse without the
    lock held (C4-F1 pattern); raw-OSError translation pin
    (`auth-recover-io`, not OSError); archive mode per Q-A1-a
    ([REV-37: RESOLVED a1=0400 at REV-36]) + step-0 repair pins (crash rename→chmod ⇒ next
    invocation of EITHER command repairs + dir fsyncs; startup
    accepts 0600-pending archives).

  CYCLE STATUS (S-A1-R): folded in cycle-3 confirming rev 5 ->
  cycle 4 CONFIRMING CHANGES REQUIRED (its single BLOCKER was
  HERE: the scan-bound precedence; majors 4 [pin seam] and 10
  [headroom false of CAPS["AUTH"] = 64 KiB/line] plus shared
  Q-1A-a enumeration) -> rev 6 folded here -> cycle 5
  CONFIRMING: cycle-5 verdict had ZERO findings against this
  sub-spec (B1 RESOLVED confirmed via S-A1 step 1b; major 4
  pin-seam closure confirmed by the auditor's own probe A5/
  A7/A8: "wrapper seam viable, Q-J2-a/Q-A1-a block no silent
  default") — rev 7 here SUPERSEDES the stale rev-5 pin
  paragraph cycle 5's major 4 named (single normative
  protocol, no dual description). -> cycles 6, 7 and 8 folded
  in S-J2-R revs 8/9/10 (no NEW S-A1 finding in any of them:
  cycle 6, 7 and 8 findings all landed on S-J2-R). Owner
  calls still open: Q-A1-a (follows Q-J2-a), Q-1A-a (shared,
  now SEVEN classes N1-N7), Q-J2-a/b/c/d/e/f/g (S-J2-R)
  [REV-23: this list predates Q-J2-h (open since rev 12) —
  see the ELEVEN-call rollups; historical list left as
  written] [REV-38: ALL calls in this list were RULED at
  REV-36; current open items: Q-1A-b, Q-ENUM-a enumeration
  + gating question, Q-J2-h (owner-deferred)
  [REV-45 UPDATE: Q-1A-b RULED (own exception required);
  Q-ENUM-a gating RULED (does not gate, documentation
  condition); Q-J2-h re-deferred with documentation; open
  artifacts: the purge-exception draft, the enumeration
  draft]]).

### S-J1 — duplicate member names are damage (ACKED by owner)
Implemented: a duplicate JSON member name in any journal object is
`journal-unreadable` (pinned by C6_20). Owner ack required to make it
normative in Doc 21.
Decision: **ACK** (owner reply) — ratified, normative in Doc 21
  (see the R5 ratification record at the foot of Doc 21).

### S-P1 — probe scope (ACKED by owner)
Leg 2 accepts ONLY EAGAIN/EWOULDBLOCK as contention. The startup probe
proves exclusion once at startup; it does not prove future lock behaviour
or crash durability. Owner ack of this stated limit required.
Decision: **ACK** (owner reply) — the stated limit (exclusion
  proven once at startup; contention = EAGAIN/EWOULDBLOCK only) is
  the contract.

### S-J3 — outcome reserve vs. clock range (DECIDED — see the C entry below)
[HISTORICAL PROBLEM, pre-C] The text in this paragraph describes the
PRE-C code, which still re-checked the range on outcome writes. It is
kept as the problem statement. Current behavior is described in the C
entry, which replaces the re-check with a clamp.
The writer reserves room for the worst-case outcome (12-digit timestamp),
but it still re-checks `0 <= at < 10**12` when the outcome is written. A
clock that leaves that range between intent admission and outcome makes
the outcome refuse, so an admitted intent may end up with no recorded
outcome. An earlier comment claimed this was unconditional; it is not,
and the comment has been corrected.
- A) Accept: document that an out-of-range clock refuses the outcome, and
  treat the intent as outcome-unknown (pending) until repair.
- B) Remove the range re-check on the outcome (accept any non-negative
  int), so the reserve is a hard guarantee.
- C) Use a monotonic counter instead of wall-clock `at` for ordering.
Recommendation (HISTORICAL, SUPERSEDED): the agent's B recommendation was
wrong — removing the bound does not make the reserve a guarantee (see the
FINAL entry and the correction below).
Decision: **C** (owner: "accept the rec c"). Implemented: `at` is clamped
  into [0, AT_MAX] (AT_MAX = 10**12-1, i.e. AT MOST 12 digits; zero is `0`)
  before serialization; the outcome reserve is computed at that maximum
  width (pin F59 at the exact cap boundary; a one-byte-short reserve goes
  RED). Writer refuses non-int/bool `at` with zero bytes; reader admits
  exactly [0, AT_MAX] (pin C6_21). This is a CAPACITY RESERVATION for valid
  integer timestamps with the same authId — it does not promise successful
  I/O, and a crash can still leave an intent without an outcome.
  FINAL (second-tranche reply "ok. clamp for s-j3", 2026-11-14): the
  clamp is ACCEPTED as the implementation of option C. Ratified closing
  terms: (1) `at` is a DIAGNOSTIC LABEL ONLY — no ordering, counting,
  or inertness decision may consume it; the sequence authority is
  journal APPEND ORDER under the exclusion lock (byte offsets are its
  observable form). (2) Lossy saturation of out-of-domain clocks is
  accepted; pins F58/F59/C6_19/C6_21 stand. (3) Option C is satisfied
  IN SUBSTANCE — ordering does not depend on wall-clock — via file
  order, not a counter field; a counter label scheme is a future
  option as its own audited workstream only if a real consumer with
  real requirements appears. The SPEC question is CLOSED.
  CORRECTION: the B-era work (removing the bound and calling the reserve
  guaranteed) was WRONG — one byte short at the cap — and is withdrawn.

### R-1 — retention policy (DECIDED by owner: A)
The ledger, AUTH file, and journal all grow without a stated retention
rule. Doc 21 defines no compaction, archive, or age-out. The journal
cap (S-J2) is the nearest decision.
- A) Retain everything until an operator archive (ties to S-J2 A).
- B) Define a retention window (e.g. keep N epochs / D days) and a
  compaction procedure.
Decision: **A — accepted** (owner reply). Retain everything
  until operator archive (pairs with S-J2-A). Compaction is
  DEFERRED DESIGN WORK — consistent with 3A's existing "removal is
  compaction debt" language; any future window/compaction spec must
  be its own audited workstream (it touches every durability
  invariant).

### D-1 — duplicate keys (DECIDED — via S-J1 ack)
Listed separately because the goal named it. It is decided by S-J1 above
(damage, fail closed); owner ack closes it.
Decision: **CLOSED** — owner S-J1 ack settles it:
  duplicate member names are damage, fail closed.

## Code findings closed this round (no owner decision)

- Zero-progress FIRST ledger write was not refused; now raises EIO
  (C8_1). Found by audit cycle 1.
- Remainder loop zero check moved inside the loop (C7_1, C7_2).
- F27 kill moved inside the ledger write; pending window asserted (F27,
  C7_3). Found by audit cycles 2–3.
- Exact-bytes check on short-write frames (C7_1).
- All zero-progress and sentinel pins bounded (C6_23, C7_2, C8_1) so a
  regression fails fast instead of hanging.
- Comment overclaiming an unconditional outcome reserve corrected (S-J3).

Each new pin was mutation-checked (the mutant is RED). See the cycle
logs in `.tre/audit/cycle-*.log`.

CAVEAT on cycle 8: its log does not show the auditor reading the corrected
C7_2 assertion (no reference to the exact two-call check). Its CLEAN verdict
is real and post-dates the last edit (file mtimes checked), but the specific
pin was not shown reviewed. Treat it as a single CLEAN, not a verified one.

## ROUND R3 status (combined contract+code round, v39→v40)

Three auditor cycles against the combined doc-21 + reference state;
every finding re-verified against the cited line before acceptance;
full dispositions in Doc 21's ROUND 3 footer table. Summary:

- **CODE (all fixed + mutation-pinned):** settlement-write zero-return
  unchecked (F18z/F18z2); generation binding of REPAIR validity
  untested (F24gen); authId freshness not writer-enforced (F53);
  unreadable consumption log escaped as raw OSError instead of
  `unknown` (F54).
- **INLINE AUDIT OF THE R3 CHANGES (gpt-6.1-terra, reviewer mode,
  post-cycle-3) — dispositions R3-c4-1..4 in the Doc 21 footer:** the
  R3-c3 cycle itself reported **verdict INCOMPLETE** (truncated
  contract/owner-ledger reads; no suite run); its two fixes had a
  residual gap — the production MINT path wrote ids unchecked (F-A1,
  fixed: under-lock collision check + bounded retry + fail-closed
  refusal, pinned F55), and `_mint_ulid` was not a conforming ULID
  (F-A2, fixed: 48-bit timestamp ‖ 80-bit random per spec, pinned
  F56). Earlier wording here said the cycle-3 auditor "confirmed none
  [SPEC items] were settled"; the accurate record is "re-encountered,
  NOT independently verified" — corrected (F-A4). Suite after the
  c4 fold: 86; R4 fold (+F57): **87 tests OK**.
- **Open with the owner (unchanged):** every SPEC item above (S-L1,
  S-J2, S-A1, S-J1, S-P1, S-J3, R-1, D-1) is (historical, as of R3) un-answered —
  re-encountered by the R3 auditor (coverage caveat above). Decision
  4 (prose audit vs reference implementation vs both) is also still
  open; R3 treated the combined state as in scope.

## ROUND R4 status (inline-audit round on the v40 state, 3 cycles)

Terra (gpt-6.1-terra) auditing the v40 combined state with mandatory
CODE-vs-SPEC classification per finding. Cycle 1: 2 TEST majors
(F19 sequential not concurrent; F3 window never entered) — both
rewritten to actually exercise the contract rows (real two-process
start-pistol contention; in-repair `_test_hook_after_lc_read` seam),
mutation-verified (non-exclusive flock ⇒ F19 RED; late-watermark ⇒
F3 RED). Cycle 2: 1 CODE major (cap refusal journaled an intent
before the reservation check — zero-byte refusals burned the D1-A
allowance) — fixed with an under-lock capacity preflight honoring the
fault `size_override`, pin F57 (mutation-verified: removing the
preflight ⇒ F57 RED); 1 TEST minor (F3 threshold could sit inside
the landed confirmation) — start-offset assertion added (mutation
verified alongside). **Classification: 0 SPEC findings in R4 so far —
every finding was fixable without touching a normative invariant**
(the D1-A attempt definition and the (c-O) "caps BEFORE any write"
clause were the authorities used, not re-decided). Suite: **87 OK**.
Cycle 3 verdict: **INCOMPLETE — no findings FILED, but the auditor
stated its finding counts are UNDETERMINED, not zero** — truncated
reads plus its sandbox refused the /tmp suite copy, so the cycle did
not establish the absence of findings; its open-item list matches this
ledger verbatim (Decision 4, R-1, D-1).
Per its own wording that is NOT a clean audit; residual coverage gaps
(full prose sweep; independent mutation re-verification) stay disclosed
and open. **CODE-vs-SPEC rollup for R4: 3 CODE/TEST fixable findings
accepted+fixed (F19/F3 rewrites, cap-preflight+F57, F3 start-offset),
1 DOC/audit-trail correction, 0 new SPEC items FILED — cycles 1–2
found no normative gap; whether the round as a whole has none is NOT
established (cycle 3 undetermined).** Suite after the round: **87 OK**.

## ROUND R5 status (inline-audit round on the v42 state, 5 cycles)

Terra (gpt-6.1-terra), 5 cycles, mandatory CODE-vs-SPEC
classification per finding, target = the R4 fixture rewrites and
the folded header claims. Findings per cycle: 5 (3 TEST major /
2 DOC minor), 2, 2, 2, 1 — **12 total: CODE 0, SPEC 0, TEST 8,
DOC 4.** Every fix was fixture/comment/prose only; no normative
invariant, bound, or error semantic was touched. The fixes:
`_test_hook_lock_miss` contention-handshake seam (the rival's own
"I was refused the lock" signal; LOCK_SH mutation RED — re-run
independently by c2/c3/c5 auditors in their sandboxes), sidecar
pins on every cap refusal, refusal results carrying the
predicate's OWN (size, framed) raised from the comparison's own
locals (guess-and-report-real mutant RED), and the (b2) geometry
rebuilt as a CLOSED per-frame-length boundary set — 56 pairs,
trails {4,8,…,21,32} × {R==F fit, R==F−1 refuse} × both roles,
leads ⊆ the set (R5-c5 closure correction after c5 caught the
4/12-byte gaps). Header/fixture claims now stated as BOUNDED
evidence, not universal proof (R5-c4-2). ±1-delta and
guessed-operand mutants re-verified RED locally. **R5 filed zero
SPEC items: every finding was fixable without re-deciding D1-A,
(c-O), or any contract row.** Caveat kept honest: a bounded
adversarial round cannot establish that no SPEC gap EXISTS; the
standing owner items below are unaffected. Cycles ran clean (none
INCOMPLETE); c2–c5 independently ran the copied suite (87 OK) and
the named mutations in their permitted sandbox copies; c1's
sandbox refused the copy (maintainer-verified only). Suite after
the round: **87 OK**. Full dispositions: Doc 21's R5 footer
table.

## ROUND R6 status (S-J2-R/S-A1-R SPEC round, terra, 31 cycles + 3 post-audits — rev 52 in force (rev 31 = R7 historical endpoint); R6 (19-22) closed at rev 26; R7 (23-27, owner-mandated, opened by the rev-26 fold audit) ended at rev 31 with a CONDITIONAL cycle-27 verdict; the rev-31 correction verified post-fold in R8b (cycle 36, rev 35) — R7 closed; owner ratification LANDED at REV 36)

Terra (gpt-6.1-terra), spec-strict confirming rounds on the two
DRAFT sub-specs (S-J2-R rotation/rebuild + S-A1-R AUTH recovery)
with mandatory CODE-vs-SPEC classification per finding. Cycle
1: 2B/11M/3m (CODE 3/SPEC 11 — folded rev 3); cycle 2: 2B/12M/2m
(CODE 5/SPEC 10 — rev 4); cycle 3 confirming: 1B/7M/3m (CODE 3/
SPEC 8 — rev 5); cycle 4 confirming: 1B/10M/2m (CODE 3/SPEC 10 —
5 REGRESSIONS opened by rev-5's own closures, all closed rev 6);
cycle 5 confirming: 1B/8M/2m (CODE 0/SPEC 11 — FIRST CODE-CLEAN
CYCLE; 4 rev-6 regressions + the auto-unlink rearm blocker —
rev 7); cycle 6 confirming: 2B/5M/2m (CODE 0/SPEC 9 — SECOND
CODE-CLEAN; rev 8); cycle 7 confirming: 2B/6M/3m reported,
CODE 1/SPEC 10 RECLASSIFIED to CODE 0/SPEC 11 (the lone CODE tag
cited a nonexistent `unlink_missing` code path while the
described behavior is spec-correct — the defect is in the spec's
own TEST-PLAN text = SPEC; third consecutive CODE-CLEAN cycle;
rev 9); cycle 8 confirming: 3B/6M/3m reported, CODE 1/SPEC 11
re-verified to CODE 0/SPEC 12 (the CODE tag again cited
spec-text test-plan defects — pin fixtures that do not
discriminate their claimed mutations; FOURTH consecutive
CODE-CLEAN cycle; T4 exception journal-conditioned, torn-tail
refusal + parser state machine, attestation gate extended to
rotation re-entry, purge resequenced attempted/committed,
single canonical eligibility algorithm, hwm self-verification
withdrawn to named residuals R-a/R-b, zero-byte claims
per-boundary-enumerated, honest-prose reader cell; folded
rev 10); cycle 9 confirming: 2B/6M/2m reported, ALL SPEC —
CODE 0/SPEC 10 (FIFTH consecutive CODE-CLEAN cycle; auditor
disposition table REGRESSED 5 / STILL-OPEN 5 / RESOLVED 2 —
4 of the 5 regressions came from rev-10's own new machinery:
the journal-present T4 exception admitted completed-archive
loss (B1), the torn-tail refusal left purge's own append
ungated (B2), the torn-append retry rule bumped hwm past its
own parser (M1), the purge-in-flight rule misclassified
completed purges once a later rotation recreated the marker
(M2); T4 exception WITHDRAWN to unconditional fail-closed,
purge write path gated on the shared parser, append-
idempotent retry, last-valid-entry in-flight rule, O1/O2
obligation split, bytes-vs-metadata zero-byte enumeration,
complete per-file log grammars; folded rev 11); cycle 10
confirming: 1B/7M/4m reported, ALL SPEC —
CODE 0/SPEC 12 (SIXTH consecutive CODE-CLEAN cycle; the
BLOCKER was rev-11's OWN fold-over — the operative T4
prerequisite site still instructed the journal-conditioned
exception withdrawn at its definition site (M-vs-B
classification resolved: an operative site carrying a
withdrawn rule is a BLOCKER, the definition-site withdrawal
does not propagate; exception WITHDRAWN AT EVERY SITE, T4
UNCONDITIONAL); majors: crash-window abandoned-act contract
rewritten — NO in-protocol completion for the abandoned act,
residual R-c whole-dir-restore named (mutually-exclusive
contract pair identified); illustrative schemas diverged
from the grammar at three sites — ONE canonical schema per
log declared in the grammar, `t` required, cmd value
LITERALLY "purge" (prose aliases withdrawn); purge step-(4)
split 4a UNLINK / 4b DIR-FSYNC with distinct failure
outcomes (4b = marker gone, power-loss fsync-lost window may
return it — observation-only reporting, parser state not
command contradiction); the ATOMICITY blanket "nothing
unlinked" contradicted the step-(5) COMPLETED-purge contract
— scoped to pre-unlink acts (1)-(3); retry-hwm pin's parser
oracle could not catch an identical re-append — replaced
with a BYTE-EQUALITY before/after oracle; duplicate-seq
identity scoped WITHIN an epoch (cross-epoch reuse is the
specified post-purge behavior, pin
`cross-epoch-seq-reuse-legal`); decision readers NEVER parse
the attestation log — purge-in-flight binds only the
rebuild/rotation command paths (pin
`decision-reader-never-parses-attest-log`); minors: the
torn-attest purge pin's double name collapsed to
`purge-attest-torn-log-refuses`, `t` pinned to a finite non-
negative integer (booleans/fractions ⇒ type mismatch), stale
journal-conditioned citations swept from eligibility
rollups, summary annotation bumped to rev 12, and the
crash-matrix "attests seq N+1" off-by-one NOT REPRODUCED
(the quoted sentence has zero hits across the rev-11 body —
closed as not-reproduced, reopens on a line citation);
folded rev 12); cycle 11
confirming: 0B/4M/3m reported, ALL SPEC — CODE 0/SPEC 7
(SEVENTH consecutive CODE-CLEAN cycle; FIRST ROUND SINCE
CYCLE 8 WITH NO BLOCKER; cycle-10 disposition table: 4
REGRESSED (B1, M1, M2, M6 — B1/M1 = rev-12's R-c rewrite did
not propagate to the crash-window/zero-byte sites, M6 = the
retained `last_hwm` broke the fresh epoch), 2 RESOLVED-for-
named-path (M3, M5), 1 RESOLVED (t-domain), 4 NOT-FULLY-
VERIFIED (M4, M7, stale-citation sweep, off-by-one sweep —
the auditor disclaimed exhaustive coverage, finding count is
a LOWER BOUND); majors: post-purge coverage reset (purge hwm
= audit evidence only, epoch coverage := 0), cross-epoch pin
fixture completed to the canonical schema (missing `t` =
itself a framing violation), rev-12 propagation regression on
the pre-rename crash sites (window split (a1) pre-4a /
(a2) post-4a = T4-gap R-c; zero-byte claim scoped pre-4a),
AUTH post-rename failure reworded namespace-visible/
durability-PENDING; minors: governing-rev label drift,
`true`/`false` are JSON literals not "numbers syntactically"
(rejection unchanged), purge 4b retry: marker-present re-
unlink SUCCEEDS, ENOENT is the marker-gone branch; folded
rev 13); cycle 12
confirming: 0B/4M/2m reported, ALL SPEC — CODE 0/SPEC 6
(EIGHTH consecutive CODE-CLEAN cycle; cycle-11 disposition
table: 2 RESOLVED-for-named-path (M2 fixture schema — the
separate reset-discrimination defect found fresh as M2'; M4
S-A1-site wording), 5 STILL-OPEN (M1 — a stale writer
formula outside the fold; M3 — the (a1)/(a2) split never
reached the OPERATIVE crash-matrix journal-PRESENT row, the
propagation class a 4th cycle; M-minor 3 — a second site
still routed the marker-present retry through ENOENT; plus
the disclaimed sweeps re-opened), and the auditor AGAIN
disclaimed exhaustive coverage (findings = LOWER BOUND for
the 3rd cycle running); majors: writer hwm formula now
consumes the parser EPOCH COVERAGE STATE not the last
entry's raw hwm, pin fixture 2 added (pre-purge hwm 7 —
hwm 1 tested NOTHING, both rules accepted it; the reset-
mutation now REFUSES fixture 2), S-J2 cross-reference to the
AUTH bound carries the NAMESPACE-VISIBLE/DURABILITY-PENDING
wording, crash-matrix journal-PRESENT row SPLIT (a1)/(a2)
with the stated observable (newest attest seq vs largest
PRESENT archive seq) and T4-before-idempotence-skip ordering
made explicit; minors: purge retry marker-present re-unlink
SUCCEEDS at both sites, foot cycle log completed (cycles
10/11/12 were missing); folded
rev 14); cycle 13
confirming: 0B/4M/3m reported, ALL SPEC — CODE 0/SPEC 7
(NINTH consecutive CODE-CLEAN cycle; cycle-12 disposition
table: 2 RESOLVED (M2 cross-epoch fixtures both directions;
marker-retry wording), M3 RESOLVED at the AUTH sites, M1
STILL-OPEN (T4's raw newest-entry operand — third site of
the same coverage rule), M4 REGRESSED (the rev-14 (a2)
observable itself undefined on purge-ending/empty logs — a
regression CREATED BY the fold-in, the class a 5th cycle);
new subclass instance: `purge-in-flight-refuses` fixture
cannot RED its named mutant — fixed as a TWO-STATE pin with
the completed-purge positive control ASSERTED in-pin;
suite-count doc drift 87→89 corrected by measurement; the
mandated I-IV sweeps incomplete a 4th cycle (pin audit
covered 8 pins: 7 PASS / 1 FAIL; refusal/dialect/fixture
sweeps remain the standing inheritance); folded
rev 15); cycle 14
confirming: 0B/2M/2m reported, ALL SPEC — CODE 0/SPEC 4
(TENTH consecutive CODE-CLEAN cycle — the LOWEST finding
count since the round began (4 vs 6-12); cycle-13
disposition table: M1 RESOLVED at the named T4 comparison
(+ its empty-set shorthand consistent only under the new
operand), M2 REGRESSED (the observable redefined but the
(a1)/(a2) BRANCH PREDICATES one paragraph away still spoke
raw entry-seq — propagation a 6th cycle), M3 RESOLVED at
the named row (AUTH/purge both pending), M4 REGRESSED (the
reworked positive control asserted unqualified PROCEED on
a state whose own eligibility refuses under BOTH rule and
mutant — unsatisfiable fixture, non-discriminating-pin
subclass 3rd instance); minors: body-log parity (fixed by
recording cycle 13's minors at its entry), the I-IV sweeps
incomplete a 5th cycle (pin audit 6 checked: 4 PASS /
2 FAIL — the two fails are majors 2's family); rev 16's
fold-ins: branch predicates restated onto the coverage
operands, the positive control re-asserted AT THE GATE
ONLY with downstream eligibility outcomes explicitly NOT
part of the pin and BOTH pin names bound to ONE shared
fixture; folded
rev 16); cycle 15
confirming: 0B/3M/3m reported, ALL SPEC — CODE 0/SPEC 6
(ELEVENTH consecutive CODE-CLEAN cycle; cycle-14
disposition table: M1 RESOLVED at the operative row (four
states classify cleanly through the coverage predicates;
the raw-entry phrases that remain are marked withdrawn
quotations), M2 PARTIALLY RESOLVED/COVERAGE REGRESSED —
the gate-only binding landed but the PARSER PARAGRAPH a
few lines away still promised unqualified proceed
(propagation class a 7th instance) AND a later re-applied
in-flight refusal was left UNCAUGHT (over-narrowing: the
fix traded unsatisfiability for an untested path); body-
log parity RESOLVED; sweep minor STILL OPEN (6th cycle —
sweep IV now reliably COMPLETED at 89, I-III PARTIAL);
majors: parser epoch transition made UNCONDITIONAL (the
marker-conditional phrasing contradicted the grammar —
two conforming parsers with different T4 states, now one
mechanism for coverage and a separate one for command
gating), the companion pin's paragraph bound to the
gate-only assertion, the positive control extended
END-TO-END ON THE REFUSAL CODE (neither command returns
the in-flight code anywhere on the fixture; legitimate
eligibility/trigger outcomes stay unasserted); minors: a
rev-16 edit duplication repaired, the dialect lead-in now
carries its journal qualification LOCALLY; folded
rev 17). **R6
rollup:
shipped code has been CODE-clean for ELEVEN
straight cycles; every finding since cycle 5 is normative text
claiming certainty the evidence lacks — and cycle 8 shows the
three NEW blockers were REGRESSIONS of rev 9's own new
machinery (the T4 exception, the torn-tail ignore rule, and
the rebuild-only gate): the persistent fold-in-regression
class at its largest entry yet; cycle 10 extends the class:
the BLOCKER was a WITHDRAWAL THAT DID NOT PROPAGATE to the
operative site — withdrawal must be verified at EVERY site
that cites the withdrawn rule, not only at its definition;
cycle 11 CONFIRMS the class a third time: 0 blockers (first
cycle-8-onward round with none) but major 3 is the SAME
withdrawal-did-not-propagate class one level down — the rev-12
R-c rewrite did not reach the pre-rename crash descriptions
and the zero-byte enumeration, which still promised normal
re-entry + zero permanent writes past a durable 4a attestation
append (cycle-12 candidate check: every site citing a rule
rewritten in revs 12/13 — the R-c / (a1)/(a2) split, the
last_hwm := 0 coverage reset, the durability-PENDING AUTH
wording — plus the FULL sweep cycle 11 disclaimed: complete
pin-fixture validity audit, refusal enumeration, dialect
sweep, and the shipped-ledger read to its end).** Persistent finding
class: fold-in regressions (a closure opening a new
contradiction) — cycle 4: 5, cycle 5: 4, cycle 7: the
clearance-proof implication surviving its own withdrawal
(major 1) and the marker-window prose (major 6), cycle 8: 3
blockers ALL from rev-9 closures, cycle 9: 2 blockers + 2
majors from rev-10 closures (5 REGRESSED of 9), cycle 10: 1
blocker from a rev-11 WITHDRAWAL THAT DID NOT PROPAGATE
(definition-site-only withdrawal) + the schema-triplicity /
step-4-conflation / atomicity-scope class, cycle 11: 1 major
(rev-12's own R-c rewrite failed to propagate to the crash-
matrix/zero-byte sites) + the inherited-state class (a
purge's audit hwm doubling as coverage state; a pin fixture
invalid under its own schema), cycle 12: 4 majors — TWO
more propagation survivors of rev-13 (the stale raw-hwm
writer formula outside the fold's scope; the (a1)/(a2) split
missing from the OPERATIVE crash-matrix row; the AUTH
durability-PENDING rewording never reaching the S-J2 cross-
reference — the propagation class a FOURTH consecutive cycle)
+ the non-discriminating pin fixture (arithmetic that both
candidate rules accept tests nothing — a NEW subclass: a fix
that lands but pins nothing); the cycle-11 disclaimed
sweep was again only partially completed (the shipped-ledger
read finished, the pin-fixture/refusal/dialect sweeps did
not). Cycle 13 extends
the class a FIFTH cycle: 4 majors — T4's operative comparison
still read the RAW newest-entry hwm (survivor of the
coverage-reset fold, third site of the same rule), the NEW
(a2) observable was UNDEFINED on purge-ending/empty logs (a
REGRESSION CREATED BY rev-14's own fold-in — the fold-in-
regression class by definition), the purge 4b row still
asserted unlink durability against the AUTH discipline (the
durability-wording survivor moved ONE log over), and
`purge-in-flight-refuses` could not RED its named mutant
(non-discriminating-fixture subclass, second instance).
Cycle 14 is the round's LOWEST finding count (0B/2M/2m — 4
findings) and BOTH majors are rev-15 fold-ins failing to
reach their OWN neighborhood: the (a1)/(a2) branch
predicates one paragraph from the redefined observable still
spoke raw entry-seq, and the reworked positive control was
made UNSATISFIABLE by its own assertion (unqualified
PROCEED where the state's eligibility refuses under both
rule and mutant) — the propagation class and the non-
discriminating-pin class each landing their 6th and 3rd
instances. Rev
16's own
changes (branch predicates restated onto the coverage
operands, the positive control asserted AT THE GATE ONLY
with downstream eligibility explicitly excluded and ONE
shared fixture bound to both pin names, the body cycle log
brought to parity) were the fresh attack surface for cycle
15 — and two of them were: Cycle 15 (0B/3M/3m) found the
gate-only binding had NOT reached the parser paragraph
(propagation class, 7th instance) and had OVER-NARROWED
the positive control into an untested path (a later re-
applied in-flight refusal escaped the pin entirely — a NEW
subclass: a fix that removes an unsatisfiable assertion
but leaves the mutated behavior unasserted, fixed by
binding the refusal code END-TO-END while legitimate
downstream outcomes stay unasserted) — plus the parser's
epoch transition contradicting the grammar on marker-
conditionality (parser state vs command gate conflated;
two conforming parsers, different T4 outcomes). Rev 17's
own changes (unconditional epoch transition with the
command gate stated as a separate mechanism, the parser-
paragraph pin assertion bound to the shared fixture (the
binding then carried the "gate-only" name — since
WITHDRAWN at rev 18 in favor of the TWO-CHECK SET),
the end-to-end refusal-code assertion, the
locally-qualified dialect lead-in, the repaired fold-in
duplication) were the
fresh attack surface for cycle 16 — PRECEDED by a targeted
post-rev-17 review (same auditor rules, not a counted terra
cycle) which found TWO SPEC findings, 0 CODE: (1) major —
the shared pin was still NAMED "gate-only" in the parser
paragraph AND the companion despite rev 17's end-to-end
extension UNDER-DESCRIBING the binding (propagation class,
8th instance); (2) minor — refusal-code literals split
across physical lines by the rev 16/17 folds. Folded in
REV 18: the shared assertion is now NAMED a TWO-CHECK SET
(CHECK 1 gate-clearance + CHECK 2 end-to-end refusal-code
absence) at both sites, the historical rev-16 "at the gate
only" phrasing retained ONLY as a named step with the
shorthand explicitly WITHDRAWN as the assertion's name, and
the split-literal sweep COMPLETED (all ten split code
literals joined to single-line form — the prerequisite for
re-running sweep I's enumeration mechanically; the standing
sweep I itself remains the auditor's job and is PARTIAL
until the cycle-16 report lands it). CYCLE 16 LANDED ON
REV 18 (0B/0M/2m; CODE 0 — twelfth code-clean; the
TWO-CHECK relabelling HELD at both operative pins (the
meta-wording propagation class did not fire) but the
WITHDRAWN "gate-only" name survived CURRENT-TENSE in the
foot cycle-15 entry (9th instance) and sweep I mechanically
ESTABLISHED that NO canonical refusal-enumeration section
exists to diff against — NEW OWNER CALL Q-ENUM-a; folded
in REV 19: the foot survivor reframed as an explicit
historical step and the 88-token extraction artifact
recorded as sweep evidence). CYCLE 17 LANDED ON REV 19
(PASS WITH MINORS 0B/0M/1m; CODE 0 — thirteenth
code-clean; NO new text defect: the single minor is the
audit-process coverage deficiency, with the structural
root causes now named in the round's STANDING RULES —
(i) sweep I cannot complete while owner call Q-ENUM-a is
open, so it is scoped down by standing rule; (ii) the
ledger is untracked so no git baseline exists for
VERIFIED-UNCHANGED closures — fixed at rev 20 by taking
pre-fold snapshots at ~/.tre/audits/sj2r/revNN-baseline.
txt; (iii) coverage breadth lost to sweep-over-depth:
cycle 18's mandate is ONE complete attack (A5 / the S-A1
body, REMAINING two cycles running) + the withdrawn-name
tense sweep, rest explicitly deferred). Rev 19's log-area
changes (the tense reframes, the cycle-16 entries,
Q-ENUM-a) were CHECKED at every site the auditor
examined: RESOLVED, no regression — the withdrawn-name
class did NOT fire a 10th time). Rev 20's own changes
(cycle-17 log entries, the standing rules, the baseline
snapshots) were CHECKED: log-area-only verified by diff, no
regression — the withdrawn-name class did NOT fire a 10th
time). CYCLE 18 LANDED ON REV 20 (PASS WITH MINORS
0B/0M/1m; SPEC 1/CODE 0 — fourteenth code-clean; baseline
diff PROVED rev 20 log-area-only; but both narrowed deep
mandates (A5/S-A1; full tense adjudication) went unfinished
a SECOND consecutive cycle — a REPEATED OBSERVED limitation
of one-shot auditor sessions [REV-22: softened from
"STRUCTURAL/cannot" — two failed attempts establish a
pattern, not proof of impossibility; the dedicated-session
format is the hypothesis to test]). REV 21 WAS THE
PAUSE-POINT [REV-22: rev 21 attributed this to a
cycle-17 "third-consecutive-ends-the-round" standing rule
— NO SUCH RULE EXISTS (the written rules are R1/R2/R3);
the pause is ORCHESTRATOR JUDGMENT on two consecutive
deficiencies with the mandate already narrowed — sound on
its merits, now correctly attributed],
rescinded by OWNER INSTRUCTION for cycles 19-22;
the two deep passes remain open
(see the foot log's cycle-18 entry for the handoff lists).
POST-REVIEW 2 ON REV 21 LANDED ON REV 22 (0B/0M/4m; SPEC
4/CODE 0 — fifteenth code-clean; the four findings —
ten-vs-ELEVEN owner-call tally (Q-J2-h omitted), a pause
attributed to a standing rule that was never written
(auditor-paraphrase promoted to rule-text: new defect
subclass), 'STRUCTURAL/cannot' overstated by two failures,
'88 unique tokens' vs the 88-line/84-unique artifact —
were ALL log/meta-text, folded at rev 22; no operative
spec text changed; suite 89 OK). The round is ACTIVE for
cycles 19-22 per owner instruction; the cycle-19 mandate
re-scopes the two deep passes as DEDICATED single-subject
work (A5/S-A1 first),
single-full-completion, with the R1/R2 mechanisms (scoped
sweep I; pre-fold snapshots) unchanged. CYCLE 19 LANDED ON
REV 23 (CHANGES REQUIRED 0B/1M/1m; SPEC 2/CODE 0 —
sixteenth code-clean): the single-subject scoping was
TESTED — the walk went PARTIAL (ordering walk complete and
clean; 6/~10 pin-groups discriminated; stopped at the
freshness-universe pins ~line 3252) — THIRD consecutive
S-A1 non-completion and FIRST with the mandate as the only
subject, so the rev-22 "breadth" hypothesis is FALSIFIED:
the binding constraint is per-cycle budget on a
fixture-level walk. CYCLE 20+ MANDATE (rev 23):
CONTINUATION PASSES — each cycle resumes at the exact
stopping point recorded in the prior cycle's notes
(cycle 20: freshness-universe pins ~3252 through the final
grouped pins ~3268 + duplicate-count boundary fixture,
using cycle-19 NOTES.4), never a fresh full pass. Two
enumeration minors (Q-J2-h omitted at two lists) corrected
in rev 23. CYCLE 20 LANDED ON REV 24 (continuation pass;
0B/2M/0m; SPEC 2/CODE 0 — seventeenth code-clean): pin
groups 1-2 completed DISCRIMINATING (freshness-universe 5/5,
final grouped 6/6); the duplicate-corpus major was a REAL
SPEC GAP fixed IN THE OPERATIVE PIN TEXT at rev 24 (counts
bounded: 1,025 valid records / 1,024 distinct ids, EOF
under the bound — disclosed as a NORMATIVE fold: rev 24 is
NOT a log-only revision) — auditor to re-confirm at cycle
21; the sole remaining S-A1 item is the AUTH-vs-4b
word-for-word comparison, cycle-21's ONLY mandate (ranges
fixed by cycle-20 Note 6; fifth consecutive failure routes
it to a direct orchestrator comparison with owner
sign-off). CYCLE 21 LANDED ON REV 25 (single-item
continuation; PASS WITH MINORS 0B/0M/1m; SPEC 1/CODE 0 —
eighteenth code-clean; **THE S-A1 DEEP PASS IS COMPLETE**:
the AUTH-vs-purge-4b word-for-word comparison finished with
a SEVEN-CLAUSE durability diff and verdict
**PARITY-ESTABLISHED** (all asymmetries operation-specific
and justified; cycle-19's clause table and cycle-20's
partial excerpts superseded), and the rev-24 duplicate-
corpus fixture was walked and CONFIRMED DISCRIMINATING;
the single minor (fixture-bracket wording: 'proceed ...
torn-route with damage' invalid for a clean-file corpus;
cap-fires-BEFORE-EOF per the cause-gate rule) was a
WORDING defect in rev 24's own bracket — fixed at rev 25,
discrimination unaffected; NORMATIVE-classified fold (an
operative clause's text), disclosed; SNAPSHOT RECORD
CORRECTED AT REV 26 per cycle-22 minor: the rev-25 fold
snapshot was ALSO taken POST-fold (a second R2 lapse — the
earlier claim it "corrected the rev-24 lapse" was WRONG);
the USABLE pre-fold snapshot for the rev-25 boundary is
rev24-baseline.txt (content-wise rev-24 pre-fold — cycle 22
verified the rev-25 change set against it: authorized
bracket + labels + appendices ONLY); the post-fold copy is
preserved as ~/.tre/audits/sj2r/rev25-postfold-copied.
txt; no further S-A1 deep pass is owed [REV-27 record
correction, R7 cycle-23 major: this entry's "COMPLETE"
and the rev-26 conclusion's "ALL pin groups
discriminating" were UNSUPPORTED for the SPENT-BEHAVIOR
group (cycle-19: 'Apparent, but fixture setup not fully
walked') — cycles 20/21 covered freshness-universe,
grouped pins, parity, and the duplicate fixture; the
spent-behavior walk LANDED AT CYCLE 23, not cycle 21;
see the cycle-23 entry below for the walk and its
path qualification]).
No code written for either
sub-spec (posture: no code
until ratified) [(HISTORICAL — written pre-REV-36; RATIFIED
at REV 36, pin stage unblocked for cleared units; still
true as of this writing: no implementation code written]).
Suite: **89 OK** (REV 15 measured
correction — see the front-matter note; the sub-specs'
pins are specified, not yet implemented — next ids after
F59/C6_23).

## SUB-SPECS OWNER-RATIFIED (REV 36, 2026-11-15; drafted
2026-11-14 post-S-J3; heading and intro corrected at REV 37 per
R9 minor — pre-REV-36 text said "AWAITING OWNER RATIFICATION"
and "no code until ratified")

Per project discipline (draft → ratify → pin), the two remaining
open items' sub-specs are drafted IN FULL ABOVE at their S-J2 and
S-A1 entries and summarized here. RATIFIED at REV 36; the
pin stage (implementation) is UNBLOCKED for the units whose
gates the REV-36 rulings cleared (purge-command deployment
remains gated [REV-45: Q-1A-b RULED — own ratified exception
required; the gate is now that exception's drafting +
ratification]).

- **S-J2-R v10 (REV 52 IN FORCE; RATIFIED at REV 36; rev 35 body governs as amended at REVS 37-52; this summary bullet's body
  text below was written at rev 7 and carries [HISTORICAL]
  tags where the rev-8/rev-9/rev-10/rev-11/rev-12/rev-13/rev-14/rev-15/rev-16/rev-17
  body
  governs)
  `operator_rotate_journal()` +
  `operator_rebuild_carries()`** — rotation is lock-only (1A),
  zero consumption/AUTH/EXISTING-sidecar writes (2A), refuses in
  a pending window, bypasses `_resolve_locked`, archives VERBATIM
  (R-1) with canonical/UNIQUE decimal `:04d` seq hygiene.
  [HISTORICAL — THE FOLLOWING "Rev 6 folds ..." THROUGH its
  "Rev 7 folds ..." paragraph describe each rev AS OF ITS
  FOLD; the PROTOCOL IN FORCE is the BODY of this sub-spec
  (rev 8) — where a historical sentence (e.g. rev 6's
  "marker immediately before the rename", "rebuild clears the
  inert marker in protocol", "R1 absorbs the orphan marker")
  contradicts the body, the body GOVERNS and the sentence is
  non-normative (rev 8, cycle-6 major 1: tags make the
  supersession machine-checkable instead of reader-memory
  work; REV 13 LABEL FIX per cycle-11 minor 1: the governing
  body is the BODY AS OF THE REVISION IN THE HEADING — rev 13
  — the stale "(rev 8)" and "REV 10" labels are WITHDRAWN;
  read every "[HISTORICAL ...]" region as descriptive of its
  own rev only). Rev 6
  folds the terra cycle-4 confirming audit (1 blocker / 10
  majors / 2 minors; CODE 3 / SPEC 10 — all valid; FIVE were
  REGRESSIONS opened by rev-5's own closures, each closed in
  rev 6 and labeled in place): the MARKER is now created AFTER
  preflight and immediately before the rename (rev 5's ordering
  could brick a fresh fleet: oversize refusal or crash left
  marker + no archives ⇒ R3 refused everything with no recovery
  — the orphan-marker state now reads exactly as fresh fleet R1,
  R3 refuses unconditionally on marker + no-valid-sidecar, and
  rebuild on archives-absent clears the inert marker in
  protocol); rebuild ELIGIBILITY defined (cycle-4 major 3):
  VALID+CURRENT sidecar ⇒ `carries-rebuild-not-needed`; VALID
  but stale/orphan-source ⇒ ELIGIBLE, replay replaces it (the
  missing in-protocol exit of rev 5, major 9); archives absent ⇒
  `carries-rebuild-ineligible` — never a fabricated empty
  history; the pre-marker-archives reader state fail-closes as
  R3 (major 3, honest cost: fresh fleets pay ONE bounded glob
  per decision; VALID-sidecar readers still zero globs). W in
  the MIRROR PREDICATE is now selected by SERIALIZED
  RESERVATION SIZE, not character length (major 6: the escape
  hole rev 5 claimed to close was re-opened by len()); both
  divergence directions stated precisely and pinned (future-
  larger-R residual (i); AT_MAX overestimate (ii) — costs
  availability, never safety). c3 is DEFINED end-to-end (major
  5: rev 5 contradicted itself): asserted-evidence argument
  required (`journal-rotate-override-unasserted`), lock-time
  nonempty re-read, ALL other preflight/damage checks intact;
  false-assertion blast radius = an early-but-complete
  rotation, honestly bounded. R2 now ENUMERATES damage-posture
  refusals: repair AND `authorize()` refuse
  `journal-carries-damaged`, consume/resolve/APPLIED proceed
  (major 7). Q-J2-e is RESTATEd on honest facts (major 1): the
  1 MiB byte-argument is sound PER JOURNAL but the sidecar is
  CUMULATIVE across retained archives ⇒ the cap is a LIFETIME
  identity ceiling (~27k ids at ULID shape) after which
  rotation AND rebuild refuse on valid input; owner options
  e2a (accept) / e2b (follow-up spec) / e2c (shards now —
  rec'd unless churn is bounded in writing) [(HISTORICAL
  DESCRIPTION OF THE REV-6 STATE — SUPERSEDED: rev 7 DEMOTES
  e2c (no implementable protocol; carries no pin) and rev 8
  confirms the demotion; NORMATIVE current option set is
  e1/e2a/e2b ONLY] [REV-38 correction, R9 cycle-41 major 3:
  the owner RULED e1 at REV-36 — e2a/e2b are not live
  options; e1 is the selected posture, both ceilings
  accepted]) . Q-1A-a ENUMERATES
  the COMPLETE five-class refusal delta (N1-N5) [(HISTORICAL
  — SUPERSEDED: the enumeration is SIX classes N1-N6 with
  blocking unit U5, rev 7, and SEVEN classes N1-N7 since rev
  9; normative enumeration where this
  summary paragraph describes the Q-1A-a offer)] and blocks
  ATOMIC command+reader-row units until it lands (major 8).
  Rev 7 folds the terra cycle-5 confirming audit (1 blocker /
  8 majors / 2 minors; CODE 0 / SPEC 11 — FIRST CODE-CLEAN
  CYCLE; four majors were REGRESSIONS opened by rev-6's own
  closures): the BLOCKER — rev 6's rebuild auto-clearing an
  orphan marker could silently rearm D1-A on an all-lost fleet
  — is killed structurally: rev 7 reorders the marker to AFTER
  the archive rename so marker-present-without-archives is
  UNREACHABLE for conforming writers (no orphan state, no
  orphan rules, contradiction gone; rebuild NEVER deletes the
  marker; archives-lost fleets refuse and their exit is the NEW
  owner call Q-J2-f: f1 named refusal-logged purge command
  [rec'd] / f2 never purge, live with the brick). e2c shards
  DEMOTED (no implementable protocol was ever given; e2c
  carries no pin); e2a's "delete archives out-of-band" exit
  WITHDRAWN (deletion cannot shrink a current cumulative
  sidecar and silently drops ids — the ceiling is terminal
  under every option until Q-J2-e lands); direction-(ii) text
  + pin inverted the trigger semantics (corrected: the
  reservation is MAXIMIZED, escaping can only understate —
  closing the ranking hole); damage CLEARANCE PROOF defined
  (contiguous + origin-complete + no damaged member ⇒ the SOLE
  automatic clearance; any gap refuses `carries-rebuild-damaged`
  zero bytes) [REV-37 tag: pre-REV-36 recap; under the g2
  ruling NO automatic clearance exists for a damaged lineage
  — see the REV-37 correction at the clearance-proof site]; fresh-fleet listdir FAILS CLOSED with a new
  error refusal `journal-carries-metadata-unavailable` (N6,
  added to the Q-1A-a enumeration as the sixth class — six
  total, all fail-closed; SEVEN since rev 9 — N7 purge-rearm
  added per cycle-7 major 3; U5 blocks deployment); entry-size
  estimate restated as explicit ranges with stated assumptions
  (~75-80k minimum-shape ids / ~25-26k ULID / ~18k
  quote-escaped — [HISTORICAL: REVISED in rev 9 per cycle-7
  minor 2 — the compact-grammar recompute gives ~174k
  minimum-shape / ~33.8k ULID-shape (31 B/entry) / ~31.8k
  with one escape; the REV-9 ENTRY-SIZE ESTIMATE in the body
  GOVERNS]).
  OWNER CALLS: **Q-J2-a** archive mode (a1=0400 rec'd/a2=0600;
  BLOCKS); **Q-J2-b** carry-over (b1 cumulative sidecar rec'd);
  **Q-J2-c** trigger gate (c1 recovery-only w/ residual / c2
  unconditional / c3 = c1 + defined override, rec'd); **Q-J2-d**
  damaged-chain semantics (d1 fail-closed rec'd); **Q-J2-e**
  carry size cap (e1 64 KiB / e2a accept the terminal ceiling /
  e2b follow-up spec — on the honest cumulative facts; e2c
  DEMOTED rev 7); **Q-J2-f** marker purge on an archives-lost
  fleet (f1 named purge command rec'd — FULL PROTOCOL IN
  SPEC TEXT rev 8 per cycle-6 major 3, f1 auto-demotes to f2
  if the owner declines the protocol / f2 never);
  [REV-36 OWNER RULINGS on this recap: a=a1; b=b1; c=c3; d=d1;
  e=e1 (NOTE: e1 chosen, NOT the recommended e2a — 64 KiB cap,
  both ceilings accepted); f=f1 [REV-40, cycle-43/44/45/46 major:
  the owner's words are the BARE SELECTION "ai-10: f1"; "protocol
  accepted, no auto-demote" is the ORCHESTRATOR INTERPRETATION
  (labeled as such at the principal record, REV-39 correction —
  see item 9 there), not a separate owner statement; optional
  explicit confirmation may be requested]; deployment still gated
  on Q-1A-b [REV-50, R13 finding 4: historical wording — Q-1A-b
  RULED at REV-45; the CURRENT gate is the ratified exception
  artifact, see item 10(b) + OWNER RULINGS REV-45 item 1]
  — see the Q-1A-a split; g=g2; h=DEFERRED by owner
  [REV-45: h RE-DEFERRED with documentation, see REV-45 item 3].
  Q-1A-a split: the owner ruled the GENERAL fail-closed amendment;
  "N1-N6 within amended 1A" is the LEDGER-DERIVED APPLICATION
  (REV-39 correction; per-class verification supplied by R10
  cycle 45: N1-N6 each SUPPORTED as refusal-adding hardening,
  N7 separately admits more — see the R10 FOLD record); N7 routed
  to NEW call Q-1A-b [REV-45: Q-1A-b RULED — own ratified
  exception REQUIRED, purge NOT admitted by amended 1A; a new
  exception artifact is now the purge deployment gate]. Q-A1-a
  follows a1. Q-ENUM-a gating [REV-45: RULED — does NOT gate
  implementation, with the documentation condition in REV-45
  item 2]. f1 [REV-45, restated REV-50/51 per R13 finding 1:
  protocol acceptance rests on the LEDGER'S LABORED READING of
  "4: one sentence" as selecting the offered confirmation
  (REV-45 item 4 + REV-50 evidence + REV-51 inference label) —
  the offered sentence appears only in the offer; the reading
  is supportable, not literal]. Full text: OWNER RATIFICATION & RULINGS,
  REV 36, as corrected at REVS 39/40 and supplemented by
  OWNER RULINGS REV-45.]
  **Q-J2-g** (rev 8 NEW, from cycle-6 blocker 2) damage-flag
  clearance (g1 named owner-authorized clearing command à la
  f1 / g2 damage PERMANENT — damage is never cleared by any
  mechanism; g2 rec'd); **Q-J2-h** (rev 12 NEW, from
  cycle-10 major 1: the abandoned-rotation T4 gap has NO
  in-protocol completion — resolution route WHOLE-DIR
  RESTORE, R-1 class; the ruling may add a safe completion
  mechanism, not drafted) [REV-23: this list ended at g —
  cycle-19 minor; Q-J2-h omitted here and at the S-A1
  cycle-status list; both corrected]).
- **S-A1-R v7 (REV 52 IN FORCE; RATIFIED at REV 36; rev 8 body governs as amended at REVS 37-52; rev 8 = cycle-11 major 4 only —
  post-rename failure is NAMESPACE-VISIBLE / durability-PENDING,
  never "durable") `operator_recover_auth_file()`** — lock-only, zero
  consumption; torn AUTH archived verbatim; NO crash window
  (archive-alone IS the recovery; first `authorize()`
  recreates); I/O fault contract + step-0 mode repair as
  S-J2-R. Rev 6 folds cycle 4's BLOCKER (the scan-bound could
  take a torn verdict at a NON-EOF bound while a full scan
  would return inventory-cap — a file one implementation
  recovers, another refuses): at a NON-EOF bound the ONLY
  outcomes are PROVEN overflow ⇒ cap, else
  `auth-recover-scan-bound` — an unproven overflow possibility
  BLOCKS the torn verdict; full three-way precedence at EOF
  only. Major 10 (CODE false claim, doc-only fix): the "8x
  headroom, never reached by a valid file" claim is WITHDRAWN
  — `CAPS["AUTH"]` = 64 KiB/line ⇒ 1024 valid lines approach 64
  MiB and blank lines are unbounded, so huge-but-valid files
  DO hit 8 MiB; the availability tradeoff is now stated, not
  denied. Major 4 (STILL OPEN from cycle 3): the retryability
  pin's seam is named — the healthy control is cut at the
  resolve boundary but the malformed run is instrumented
  THROUGH its refusal, with an explicit post-boundary extra-
  `_write_counter` mutation pin. Rev 7: cycle 5 found ZERO
  findings against this sub-spec (B1 RESOLVED confirmed; major 4
  pin-seam closure confirmed by the auditor's probes — wrapper
  seam viable, no silent default) and rev 7 SUPERSEDES the
  stale rev-5 pin paragraph that cycle 5's major 4 named,
  leaving a SINGLE normative protocol (dual descriptions had
  given opposite results for the pin's named mutation).
  Identity universe and damage posture unchanged; Q-1A-a
  enumeration (N4/N5 + N6) and the atomic-unit blocking rule
  inherited from S-J2-R rev 7. OWNER CALL: **Q-A1-a** AUTH
  archive mode follows Q-J2-a ([REV-37: RESOLVED — both
  classes 0400 per the REV-36 a1 ruling]).

[REV-35 WITHDRAWAL, R8b cycle-34 major: the sentence below is WITHDRAWN as an implementation condition. No sub-spec gating text establishes that these nine calls, as a set, gate implementation; the individually specified gates (cited at the S-J2-R / S-A1-R gating sites) stand on their own terms.]
Once these NINE answers land (Q-J2-a, Q-J2-b, Q-J2-c, Q-J2-d,
Q-J2-e, Q-J2-f, Q-J2-g, Q-1A-a, Q-A1-a), implementation (both commands +
pins, next ids after F59/C6_23) proceeds. [REV-31 record
correction, cycle-27 minor (R7): this nine-answer statement is
HISTORICAL (written before Q-J2-h and Q-ENUM-a were tallied).
The [REV-37 tag, R9 major 6: HISTORICAL as of REV-36 — the
eleven-call handoff was answered 2026-11-15 (see OWNER
RATIFICATION & RULINGS); the CURRENT handoff was Q-1A-b (the
N7 ruling), the commissioned Q-ENUM-a canonical enumeration
plus its unruled gating question, and Q-J2-h (owner-DEFERRED,
not open-unanswered). [REV-45 UPDATE to that historical handoff:
Q-1A-b RULED (own exception required), Q-ENUM-a gating RULED
(does not gate, documentation condition), Q-J2-h RE-DEFERRED
(documented). The CURRENT handoff from REV 45 is: drafting the
purge-exception artifact, drafting the commissioned enumeration,
and Q-J2-h remaining deferred.] owner handoff was the ELEVEN deferred
calls (Q-J2-a/b/c/d/e/f/g/h, Q-1A-a, Q-A1-a, Q-ENUM-a) plus
owner RATIFICATION of both sub-specs (RATIFIED at REV-36). [REV-32 correction, R8 finding
1: whether Q-ENUM-a GATES implementation is NOT established by
the record — it is an OWNER ACTION ITEM (decide: gate or not),
not a settled prerequisite; no dependency is asserted here.]] Cycle status: terra
cycle 1 = CHANGES REQUIRED (2B/11M/3m; CODE 3/SPEC 11 — folded
into rev 3); cycle 2 = CHANGES REQUIRED (2B/12M/2m; CODE 5/SPEC
10 — folded into rev 4); cycle 3 (confirming) = CHANGES
REQUIRED (1B/7M/3m; CODE 3/SPEC 8 — folded into rev 5); cycle 4
(confirming rev 5) = CHANGES REQUIRED (1B/10M/2m; CODE 3/SPEC
10 — 3 cycle-3 minors RESOLVED, cycle-3 blocker resolved for
its named path, 5 majors REGRESSED by rev-5 closures, folded
into rev 6); cycle 5 (confirming rev 6) = CHANGES REQUIRED
(1B/8M/2m; CODE 0/SPEC 11 — FIRST CODE-CLEAN CYCLE; 4 majors
REGRESSED by rev-6 closures + new blocker from the auto-unlink
rearmline; folded into rev 7); cycle 6 (confirming rev 7) =
CHANGES REQUIRED (2B/5M/2m; CODE 0/SPEC 9 — SECOND CODE-CLEAN
CYCLE; both blockers folded in rev 8; NEW owner call Q-J2-g);
cycle 7 (confirming rev 8) = CHANGES REQUIRED (2B/6M/3m as
reported; CODE 1/SPEC 10 re-verified to CODE 0/SPEC 11 — the
lone CODE-tagged finding cites a nonexistent `unlink_missing`
path but describes spec-correct behavior, so it is a defect in
the spec's TEST-PLAN text = SPEC; THIRD consecutive CODE-CLEAN
CYCLE; damage-durability attestation log added, purge
authorization + log spec completed, eligibility ladder
reordered, marker-window prose corrected; folded in rev 9);
cycle 8 (confirming rev 9) = CHANGES REQUIRED (3B/6M/3m as
reported; CODE 1/SPEC 11 re-verified CODE 0/SPEC 12 — the CODE
tag cites spec-text test-plan defects (pin fixtures that do
not discriminate), same class as cycle 7's reclassification;
FOURTH consecutive CODE-CLEAN cycle; all three blockers were
REGRESSIONS of rev-9's own machinery; T4 exception journal-
conditioned, torn-tail refusal + parser state machine,
attestation gate extended to rotation re-entry, purge
resequenced, canonical eligibility algorithm, hwm claims
withdrawn to R-a/R-b, per-boundary zero-byte enumeration;
folded in rev 10);
cycle 9 (confirming rev 10) = CHANGES REQUIRED (2B/6M/2m as
reported; ALL SPEC — CODE 0/SPEC 10; FIFTH consecutive
CODE-CLEAN cycle; the disposition table splits REGRESSED 5 /
STILL-OPEN 5 / RESOLVED 2 — the regression class persists
(journal-present T4 exception, purge torn-append gap, retry
hwm, purge-in-flight detection, torn-append rule) and rev-10
machinery contributed 4 of the 5 regressions; folded in
rev 11: T4 presence-exception WITHDRAWN (unconditional fail-
closed), purge write path gated on the shared parser,
append-idempotent retry rule, last-valid-entry in-flight
rule, O1/O2 obligation split, bytes-vs-metadata zero-byte
enumeration, complete log grammars);
cycle 10 (confirming rev 11) = CHANGES REQUIRED (1B/7M/4m;
ALL SPEC — CODE 0/SPEC 12; SIXTH consecutive CODE-CLEAN; the
blocker was rev-11's own withdrawal failing to propagate to
the operative T4 site (WITHDRAWAL-DID-NOT-PROPAGATE, new
regression subclass); folded in rev 12);
cycle 11 (confirming rev 12) = CHANGES REQUIRED (0B/4M/3m;
ALL SPEC — CODE 0/SPEC 7; SEVENTH consecutive CODE-CLEAN;
FIRST BLOCKER-FREE ROUND SINCE CYCLE 8; major 3 = the same
propagation class one level down (rev 12's R-c rewrite never
reached the pre-rename crash-matrix sites / the zero-byte
enumeration); coverage of the round was a LOWER BOUND — 4
dispositions not fully verified; folded in rev 13: post-purge
coverage reset last_hwm := 0, cross-epoch pin fixture
completed to the canonical schema, window (a) split (a1)/(a2)
with the zero-byte claim scoped PRE-4a, AUTH post-rename
error reworded NAMESPACE-VISIBLE / DURABILITY-PENDING);
cycle 12 (confirming rev 13) = CHANGES REQUIRED (0B/4M/2m;
ALL SPEC — CODE 0/SPEC 6; EIGHTH consecutive CODE-CLEAN;
major 3 = the AUTH durability withdrawal failed to propagate
to the S-J2 cross-reference (propagation class, fourth cycle
running) and major 4 = the (a1)/(a2) split failed to reach
the operative crash-matrix journal-PRESENT row (same class,
second site); major 1 = a stale writer formula (max of the
last entry's RAW hwm) survived the coverage-reset fold;
major 2 = the rev-13-fixed fixture's arithmetic (hwm 1)
tested NOTHING — both rules accepted it; folded in rev 14);
cycle 13 (confirming rev 14) = CHANGES REQUIRED (0B/4M/3m;
ALL SPEC — CODE 0/SPEC 7; NINTH consecutive CODE-CLEAN;
major 1 = T4's operative comparison still read the RAW
newest-entry hwm (third site of the coverage rule, the
propagation class a 5th cycle); major 2 = the NEW rev-14 (a2)
observable undefined on purge-ending/empty logs (a REGRESSION
CREATED BY rev-14's fold-in itself); major 3 = the purge 4b
row still asserted unlink durability against the AUTH
discipline; major 4 = `purge-in-flight-refuses` fixture could
not RED its named ANY-purge mutant (non-discriminating-
fixture subclass, 2nd instance); minors: suite count 87→89
(measured), S-J2 body status log stopped at cycle 10
(extended to 13), the I-IV sweeps AGAIN incomplete (lower
bound, 4th cycle); pin audit table: 8 pins checked, 7 PASS /
1 FAIL (purge-in-flight-refuses); folded in rev 15);
cycle 14 (confirming rev 15) = CHANGES REQUIRED (0B/2M/2m;
ALL SPEC — CODE 0/SPEC 4; TENTH consecutive CODE-CLEAN;
LOWEST FINDING COUNT OF THE ROUND; major 1 = the (a1)/(a2)
branch predicates survived the observable redefinition one
paragraph away (propagation class, 6th cycle); major 2 =
the rev-15 positive control's unqualified PROCEED was
unsatisfiable at the state's own eligibility (non-
discriminating-pin subclass, 3rd instance — fixed as a
GATE-ONLY assertion with one shared fixture bound to both
pin names); minors: body-log parity, sweeps incomplete a
5th cycle; folded in rev 16). terra cycle 15 on rev 16
(0B/3M/3m; SPEC 6/CODE 0 — eleventh code-clean; majors:
parser epoch reset was conditioned on marker-absence
against the grammar's unconditional reset (two conforming
parsers, different T4 states) — now unconditional with the
command-gate stated as a SEPARATE mechanism; the
companion pin's paragraph still promised unqualified
proceed after rev 16's gate-only binding (propagation
class 7th instance) — bound to the SAME SHARED ASSERTION
(rev 17 folded it onto the companion's fixture; rev 18
RELABELLED the binding the TWO-CHECK SET and WITHDREW the
then-current "gate-only" name — the phrase survives here
ONLY as the rev-16 historical step), one shared fixture;
the positive control left
a later re-applied in-flight refusal uncaught — extended
end-to-end on the refusal code with legitimate downstream
eligibility/trigger outcomes explicitly unasserted;
minors: a duplication from the rev-16 fold-in repaired,
the dialect lead-in now carries its journal-only
qualification locally, sweeps incomplete a 6th cycle
(sweep IV completed: 89 OK; I-III partial); folded in
rev 17). terra post-review on rev 17 (0B/1M/1m; SPEC
2/CODE 0 — majors: the shared pin still NAMED gate-only
after the end-to-end extension (propagation class 8th
instance); minor: split refusal-code literals; folded in
rev 18: TWO-CHECK SET relabelling at both sites with the
gate-only shorthand WITHDRAWN as a name; all ten split
literals joined). terra cycle 16 on rev 18 (0B/0M/2m;
SPEC 2/CODE 0 — TWELFTH consecutive code-clean and the
LOWEST FINDING COUNT OF THE ROUND, with the auditor
disclaiming exhaustive major coverage (sweep-limited
round); ALL THREE cycle-15 majors came back RESOLVED at
the operative sites and the TWO-CHECK relabelling held at
both pins — the meta-wording class did NOT fire this
cycle; minors: the withdrawn "gate-only" name survived
CURRENT-TENSE in the foot cycle-15 entry ("now bound to
the same gate-only assertion") — propagation class a 9th
instance, now FIXED at rev 19 with explicit
historical-step framing; sweeps I-III incomplete a 7th
cycle, though the rev-19 ledger-side dent is REAL:
mechanical extraction over both bodies yields 88 candidate
lines / 84 UNIQUE tokens [REV-22 CORRECTION] (~38 refusal-code-shaped; candidates at
~/.tre/audits/sj2r/c17/) and ESTABLISHES that NO canonical
refusal-enumeration section exists to diff against (N1-N7
cover only the decision-semantics delta) — recorded as an
OWNER CALL (Q-ENUM-a: commission the canonical enumeration
or scope sweep I down); sweep IV re-verified 89 OK; folded
in rev 19). Owner calls now TEN [REV-22 CORRECTION: the
count was wrong — Q-J2-h (open since rev 12, named at the
T4-gap sites) was omitted; the tally has been ELEVEN since
rev 19: Q-J2-a/b/c/d/e/f/g/h, Q-1A-a, Q-A1-a, Q-ENUM-a]:
Q-J2-a/b/c/d/e/f/g,
Q-1A-a, Q-A1-a, Q-ENUM-a. terra cycle 17 on rev 19
(PASS WITH MINORS 0B/0M/1m; SPEC 1/CODE 0 — thirteenth
consecutive code-clean and the FIRST non-"CHANGES
REQUIRED" verdict of the round; no new text defect — the
sole minor is the audit-process coverage deficiency
itself, with three structural fixes folded at rev 20:
sweep I scoped down by STANDING RULE while Q-ENUM-a is
open; pre-fold baseline SNAPSHOTS at
~/.tre/audits/sj2r/revNN-baseline.txt enable
VERIFIED-UNCHANGED closures (the ledger is untracked — no
git baseline exists); cycle 18's mandate is SINGLE-FULL-
COMPLETION (A5/the S-A1 body, the only attack REMAINING
two cycles running, + the withdrawn-name tense sweep)
rather than breadth; cycle-16 dispositions RESOLVED at
every site examined — the withdrawn-name class did not
fire a 10th time; sweep IV re-verified 89 OK; folded in
rev 20). terra cycle 18 on rev 20 (PASS WITH MINORS
0B/0M/1m; SPEC 1/CODE 0 — FOURTEENTH consecutive
code-clean; the baseline-diff mechanism WORKED — rev 20
proven log-area-only against rev20-baseline.txt, closing
the change-boundary objection — but the SINGLE-FULL-
COMPLETION mandate failed a SECOND consecutive cycle:
neither the A5/S-A1 deep pass nor the whole-ledger tense
adjudication finished; under the round's own cycle-17
standing rule a third consecutive coverage-deficiency ends
the round's usefulness, and the deficiency is now
twice-consecutive WITH the mandate already narrowed to two
items — so the finding is STRUCTURAL (one-shot detached
auditor sessions cannot complete deep passes over a
4k-line doc) [REV-22 CORRECTIONS on this entry: (a) NO
third-consecutive rule was ever written (the cycle-17
standing rules are R1/R2/R3 — this paraphrase was folded
as if normative: a NEW defect subclass (auditor-paraphrase
promoted to rule-text), distinct from the withdrawn-name
class, whose count stands at 9) ; the
pause is orchestrator JUDGMENT, sound on its merits;
(b) "cannot" overstated two failed attempts — softened to
repeated observed limitation] and REV 21 DECLARES THE ROUND PAUSED: no
further broad confirming rounds without owner instruction;
the two unfinished deep passes (1: S-A1/A5 full pin-vs-
mutant walk + AUTH-vs-purge-4b word-for-word durability
table; 2: tense-hit adjudication of the ~35 listed sites)
are re-scoped as DEDICATED single-subject sessions; NO
TEXT DEFECT has been found since rev 18 — cycles 17-18
adjudicated every examined site's tense correctly and the
withdrawn-name class has not fired since the rev-19 fix;
folded in rev 21, round status: PAUSED at rev 21, 14
straight code-clean, 10 owner calls open [REV-22: WRONG
count — ELEVEN, Q-J2-h omitted; see the rev-22 fold], (Q-J2-a/b/c/d/e/f/
g, Q-1A-a, Q-A1-a, Q-ENUM-a), sub-specs DRAFT / AWAITING
OWNER RATIFICATION.) terra post-review on rev 21
(0B/0M/4m; SPEC 4/CODE 0 — FIFTEENTH consecutive
code-clean; ALL FOUR findings are log/meta-text defects
folded IN THIS REVISION: (1) the owner-call tally omitted
Q-J2-h — true tally ELEVEN, corrected at every tally site
(the rev-21 'ten' line and the cycle-18 entry's
re-verification of it; Q-J2-h's spec text always existed —
no spec change); (2) the rev-21 pause cited a
'third-consecutive-ends-the-round' standing rule that was
NEVER WRITTEN (cycle-17's rules are R1/R2/R3) — pause
reattributed to orchestrator judgment (sound on merits);
a NEW defect subclass: auditor-paraphrase promoted to
rule-text when folded; (3) 'STRUCTURAL/cannot complete'
softened to repeated observed limitation (two failures
disprove neither possibility nor cause); (4) '88 unique
tokens' misdescribed the artifact — 88 LINES (78+10),
UNION 84 UNIQUE — corrected at both claim sites); owner
RESCINDED the pause and mandated cycles 19-22; folded in
rev 22, round status: ACTIVE cycles 19-22 (owner-mandated
continuation), 15 straight code-clean, 11 owner calls open
(Q-J2-a/b/c/d/e/f/g/h, Q-1A-a, Q-A1-a, Q-ENUM-a),
sub-specs DRAFT / AWAITING OWNER RATIFICATION.) terra cycle 19 on
rev 22 (CHANGES REQUIRED 0B/1M/1m; SPEC 2/CODE 0 —
SIXTEENTH consecutive code-clean; the single-subject
scoping was TESTED: the auditor completed the repair()-vs-
claims ordering walk (no false shipped-code claim: healthy
matched-success prefix vs malformed-through-refusal run
detects a post-return _write_counter, ledger.py 1461-1465
+ 1220-1247) and PARTIAL pin discrimination (6 of ~10
pin-groups walked, each 'Yes' row sound), but stopped at
the freshness-universe pins (line ~3252) — THIRD
consecutive non-completion of the S-A1 mandate, first with
the mandate as the ONLY subject: the rev-22 hypothesis
(one-shot breadth) is FALSIFIED — the failure mode is
per-cycle budget on a fixture-level walk, not breadth;
MAJOR folded as process finding; CYCLE-20 MANDATE CHANGED
accordingly to a CONTINUATION PASS: start AT line ~3252
(freshness-universe pins), complete through the final
grouped pins (~3268) + the duplicate-count boundary
fixture, using cycle 19's NOTES.4 stopping point — not a
fresh full pass; minor (folded here): two enumeration
sites (S-A1 cycle status ~3283; S-J2 summary OWNER CALLS)
ended at Q-J2-g omitting open Q-J2-h — both corrected with
[REV-23] marks; R1 COMPLETED-AS-SCOPED-DOWN (no added/
removed literals in either body at rev 22/23); baseline
diff: rev 22 touched label+log areas only, operative body
VERIFIED-UNCHANGED; suite 89 OK; folded in rev 23, round
status: ACTIVE cycle 20 (continuation-pass format), 16
straight code-clean, 11 owner calls open, sub-specs DRAFT
/ AWAITING OWNER RATIFICATION.) terra cycle 20 on rev 23
(CONTINUATION PASS; CHANGES REQUIRED 0B/2M/0m; SPEC 2/
CODE 0 — SEVENTEENTH consecutive code-clean; the
continuation format WORKED on 3 of 4 items: freshness-
universe pins 5/5 walked ALL DISCRIMINATING (extensions,
no false shipped-code claim — shipped ledger.py 1321-1363
does not yet implement the (c)/(d) universe and the draft
says so); final grouped pins 6/6 walked discriminating
(with honest caveats: byte-equality wouldn't catch an
identical-byte rewrite; lock pin must exercise the
lock-required seam; mode pins gated on Q-A1-a);
duplicate-corpus MAJOR = REAL SPEC GAP — counts were
unspecified — FIXED IN THE PIN TEXT AT REV 24 (corpus
= 1,025 valid records / 1,024 distinct ids, one id twice,
EOF under the bound; valid-count ⇒ cap, unique-count
mutant diverges BY CONSTRUCTION — cycle-20 major CLOSED
at the fixture level, auditor to re-confirm); item 4
(AUTH-vs-4b WORD-FOR-WORD) still open — FOURTH
consecutive non-completion but the stopping point is now
EXPLICIT (remaining ranges: AUTH :3000-3012,:3080-3085 +
purge :1274-1282,:1608-1620,:1637-onward; partial clause
comparison found no parity break); R1
COMPLETED-AS-SCOPED-DOWN (zero new literals in rev-23
additions); baseline diff: rev 23 log/label/marked-list
areas only, operative VERIFIED-UNCHANGED; rollout labels
+ ELEVEN tally + third-consecutive-corrections all
CHECKED; suite 89 OK; folded in rev 24 — CYCLE-21 MANDATE
= ITEM 4 ONLY (the last open S-A1 item, ranges fixed by
cycle-20 Note 6: paste the complete both-sides texts and
diff every durability clause incl. observation context,
noop retry, mode repair symmetry) — a FIFTH consecutive
non-completion of a single-item mandate would end
auditor-run attempts for item 4 and route it to a DIRECT
ORCHESTRATOR COMPARISON with owner sign-off; round
status: ACTIVE cycle 21, 17 straight code-clean, 11 owner
calls open, sub-specs DRAFT / AWAITING OWNER
RATIFICATION.) terra cycle 21 on rev 24 (SINGLE-ITEM
continuation; PASS WITH MINORS 0B/0M/1m; SPEC 1/CODE 0 —
EIGHTEENTH consecutive code-clean; THE S-A1 DEEP PASS IS
COMPLETE AT LAST: the AUTH-vs-purge-4b WORD-FOR-WORD
comparison FINISHED — both texts quoted complete with line
cites (AUTH :2977-3012,:3080-3085,:3173-3177; purge
:1232-1242,:1253-1282,:1608-1620,:1631-1681; shared mode-
repair :596-605,:1552-1564), SEVEN-CLAUSE durability diff,
VERDICT **PARITY-ESTABLISHED** — every asymmetry operation-
specific and justified (namespace-visible completion,
power-loss reversal, observation-dependent retry, error
context, entry/completion fsync, mode repair, persisted-
bytes bounds); no item-4 residue; the rev-24 duplicate-
corpus fixture WALKED CONFIRMED DISCRIMINATING (1,025
valid/1,024 unique ⇒ cap vs healthy refusal — mutant
diverges by construction); minor folded at rev 25 = the
bracket's own wording ("proceed ... torn-route with
damage" was wrong for a clean-file fixture — reworked to
healthy-only with the damaged variant named as a separate
corpus; the auditor's note 'cap at EOF' vs the cause-gate
rule 'cap fires before EOF' corrected too — wording only,
discrimination unaffected); NOTE for cycle 22: snapshot
discipline lapse found — rev24-baseline.txt was taken
POST-fold (process deviation from R2, disclosed in the
prompt, auditor could not independently prove the rev-24
boundary; no undeclared change identified) [REV-26 record
correction, cycle-22 minor: the rev-25 fold snapshot was
ITSELF taken POST-fold too (second R2 lapse; renamed
rev25-postfold-copied.txt) — the claim "rev25-baseline
(pre-fold, correct)" was FALSE; actual usable pre-fold
snapshot for the rev-25 boundary = rev24-baseline.txt
(content-wise rev-24 pre-fold), which cycle 22 USED to
verify the rev-25 change set: authorized bracket + labels
+ appendices only, PASS] — treat the rev-24 boundary as
DECLARED-ONLY evidence; round status: ACTIVE cycle 22
(THE FINAL mandated cycle: full-sweep closure on the now-
completed S-A1 body + the standing checks), 18 straight
code-clean, 11 owner calls open, sub-specs DRAFT /
AWAITING OWNER RATIFICATION.) terra cycle 22 on rev 25
(THE FINAL mandated cycle; CLOSURE; PASS WITH MINORS
0B/0M/1m; SPEC 1/CODE 0 — NINETEENTH consecutive
code-clean; MANDATE 1: rev-25 boundary VERIFIED against
rev24-baseline.txt (the true usable pre-fold snapshot) —
changes confined to the authorized fixture bracket +
three label sites + two appendices + the cycle-21 log
entry, PASS; the reworked bracket CONFIRMED consistent
with the cycle-21 audited fixture (valid-count cap fires
BEFORE EOF; unique-count mutant ⇒ healthy refusal —
discriminates); MANDATE 2 ROUND-CLOSE ADJUDICATION: all
four known residues ruled ACCEPTABLE ((a) spec-level
walks — executable pins are implementation deliverables;
(b) shipped-code claims checked where shipped behavior is
asserted, freshness-universe declared extensions; (c)
Q-A1-a mode pins owner-BLOCKED by design; (d) rev-24
boundary declaration-only) — NO uncovered state that
would flip a pin verdict — **ROUND-CLOSE-READY for owner
ratification** (not implementation before ratification);
MANDATE 3: R1 no new literals (the rev-24/25 refusal-
shaped additions already candidates); rollout labels +
ELEVEN tally + third-consecutive corrections all CHECKED;
suite 89 OK; the single minor — the rev-25 rollups'
snapshot claim — record-corrected at rev 26 as above [REV-27
record correction, R7 cycle-23 minor: the rev-26 closure
OMITTED the second deferred deep pass — tense-hit
adjudication of the ~35 listed sites (rev-21 record,
ledger ~4266-4271) — neither carried forward nor disposed
in the close header/conclusion; omission from the closure
RECORD, no tense defect claimed (rev-21: none found at
examined sites); the pass itself is mandated for R7
cycle 24 (entry lands at rev 28)])
folded in rev 26. ROUND R6 CONCLUSION (owner-mandated
cycles 19-22 complete): SIX consecutive code-clean cycles
(17-22 span: 19 total), the S-A1 deep pass COMPLETED at
cycle 21 [REV-27 record correction, R7 cycle-23 major:
"all pin groups discriminating" was UNSUPPORTED for the
spent-behavior group — that walk landed at cycle 23 and
is DISCRIMINATING there; parity + duplicate-corpus
conclusions independently supported] (AUTH-vs-4b
PARITY-ESTABLISHED; duplicate corpus specified AND
confirmed discriminating), continuation-pass format
VALIDATED (the fix that ended three cycles of
non-completion), CODE-class findings in cycles 19-22:
ZERO — the round's CODE-CLEAN streak now 19 consecutive; OPEN FOR OWNER: 11 calls
(Q-J2-a/b/c/d/e/f/g/h, Q-1A-a, Q-A1-a, Q-ENUM-a) and
RATIFICATION of S-J2-R v10 (rev 26) / S-A1-R v7 (rev 8);
post-round process rule going forward: pre-fold snapshot
MUST be taken as the FIRST fold action (two R2 lapses in
two cycles — rev 24 and rev 25, both caught, both
recorded).) [ROUND R7 OPENED: an orchestrator audit of
the rev-26 fold found the two closure-record defects the
cycle-23 entry adjudicates; owner instruction: 5 cycles
(23-27), SPEC/CODE distinction continues, OWNER-DEFER —
items needing owner ratification/disposition (the 11 calls
incl Q-ENUM-a, sub-spec ratification) are deferred by
instruction and NOT findings; prompt
~/.tre/audits/p9m3-sj2r-r7-prompt.txt.] terra cycle 23 on
rev 26 (R7-1; CHANGES REQUIRED 0B/1M/1m; SPEC 2/CODE 0 —
TWENTIETH consecutive code-clean; MANDATE 1 COMPLETED:
the SPENT-BEHAVIOR pin walk (ledger ~3266-3268) done at
cycle-20 grouped-pin depth — BOTH PINS DISCRIMINATING:
(APPLIED-spent: terminated APPLIED record + malformed
AUTH carrying the id, recovery archives it, then
classify().spent contains APL and test-only mint refuses
auth-id-already-used — mutant: classification omits
APPLIED ids ⇒ membership RED; freshness ignores APPLIED
log records ⇒ mint-refusal RED; REPAIR-spent: VALID REPAIR
+ live AUTH pre-damage, recovery, REPAIR classifies DEAD
(unknown-authId), id drops from VALID-derived spent yet
mint still refuses auth-id-already-used via log coverage
(b) — mutants: accept-REPAIR-without-AUTH ⇒ DEAD RED;
freshness ignores DEAD REPAIRs ⇒ refusal RED); PATH
QUALIFICATION LANDED (a SPEC clarification, folded as a
pin-text note below): post-recovery the old AUTH is ABSENT,
so the shipped repair() path refuses authorization-stale
BEFORE any spent check (ledger.py 1461-1471) — the pin
MUST NOT claim an authorization-spent refusal from a live
AUTH; its evidence is spent-membership + log-based mint
refusal; candidate-file check: auth-id-already-used
(already a candidate), unknown-authId (candidate-file GAP
— R1-registered), authorization-stale (candidate-file GAP
— R1-registered); MANDATE 2: both closure defects
CONFIRMED AS STATED (cycle-19 line 72 'Apparent, but
fixture setup not fully walked'; closure header/
conclusions silent on the tense pass) — record-corrected
at rev 27 in the rev-25 bullet, the rev-26 conclusion, and
the close record; AUDITOR SITE-LIST PARTIALLY WRONG (triage
verdict): the claimed additional overstatement sites
3853-3857/4303-4308 were CHECKED and correctly record
partial coverage ('6/~10, stopped at freshness-universe')
— no edit made there; the only overstatements were the
rev-25 bullet and rev-26 conclusion, both corrected;
DEFERRED OWNER MATTERS (no finding, per owner instruction):
the 11 calls + ratification. Stopping point: cycle 23
complete; the tense-hit adjudication of the ~35 sites
(~/.tre/audits/sj2r/c17/sites.txt, 86-line candidate list)
is cycle 24's dedicated subject.) terra cycle 24 on
rev 27 (R7-2; DEDICATED tense-hit adjudication — the
second deferred deep pass from rev 21, now DISPOSED;
PASS 0B/0M/0m; SPEC 0/CODE 0 — the FIRST fully clean
verdict of the round; TWENTY-FIRST consecutive
code-clean; ALL 86 candidate hits from
~/.tre/audits/sj2r/c17/sites.txt adjudicated (completion
contract met — full list walked, last hit 3986 -> rev-27
line 4226): every hit T1 (correctly framed — historical
step / withdrawal naming its replacement / marked-DRAFT
obligation / hypothetical fixture); ZERO T2 defects
[REV-29 SCOPE BOUND, cycle-25 major: the T1/T2 verdict
and both negative claims hold WITHIN THE 86 ADJUDICATED
CANDIDATE HITS ONLY — a candidate-list-bounded result,
NOT a whole-ledger tense verification; the list was
extracted by mechanical sweep at rev 19]; no current-tense
prose (within the list) asserts shipped behavior that does
not exist, no withdrawn name (within the list) survives
as live; shipped-code
baseline verified (reference/p9m3/ledger.py implements
NONE of the proposed rotation/carry/attestation/recovery
mechanisms — consistent with the DRAFT posture; note the
auditor's line-shift mapping: candidate numbers are
rev-19 hit numbers, current lines shown where insertions
shifted); the rev-26-closure omission of this pass was
already record-corrected at rev 27; BOTH deferred deep
passes (S-A1 pin walk: cycle 23; tense adjudication: this
cycle) are now CLOSED with dispositions; DEFERRED OWNER
MATTERS (no finding, per owner instruction). Stopping
point: cycle 24 complete, nothing carried forward.) terra cycle 25 on
rev 28 (R7-3; confirming; CHANGES REQUIRED 0B/1M/1m; SPEC
2/CODE 0 — TWENTY-SECOND consecutive code-clean; MAJOR
folded: the cycle-24 entry's negative claims were
whole-ledger-worded but list-supported — REV-29 SCOPE
BOUND folded above (candidate-list-only; the rev-19
mechanical-sweep provenance of the list stated in-text);
MINOR folded — SNAPSHOT RECORD, THIRD R2-LAPSE CLASS
EVENT: the cycle-25 prompt called rev28-baseline.txt a
pre-fold snapshot but it was copied AFTER the rev-28
entry landed (byte-identical to rev 28 — the auditor
caught it); the USABLE rev-28 boundary = rev27-baseline.txt
(diff: labels + cycle-24 entry only — verified by the
auditor, PASS); the rule 'pre-fold snapshot MUST be the
FIRST fold action' held at rev 27 (rev26-postR6 taken
pre-fold and USED) and was broken AGAIN by drafting the
snapshot claim into a prompt before the copy existed —
tightened rule (rev 29): a snapshot's declared role is
written ONLY after the copy's byte-hash is checked
against the target rev; other cycle-25 results: REV-27
boundary verified vs rev26-postR6 (labels, spent-pin
note, correction brackets, cycle-23 entry — no undeclared
operative change); correction attributions + the
site-list-triage verified; spent-pin note consistent with
the cycle-23 walk + shipped repair() ordering
(ledger.py ~1461-1471); gaps registered AS GAPS
(unknown-authId / authorization-stale); labels + ELEVEN
tally checked; suite 89 OK (auditor-run); NOT
independently re-adjudicated: the 86 hits' T1 verdicts
(cycle-25 checked count + endpoint; all-T1 remains the
cycle-24 attributed result — cycle 26/27 may spot-check);
stopping point: cycle 25 complete.) terra cycle 26 on
rev 29 (R7-4; confirming + independent spot-audit;
PASS 0B/0M/0m — SECOND FULLY CLEAN CYCLE; SPEC 0/CODE 0
— TWENTY-THIRD consecutive code-clean; M1 REV-29
BOUNDARY: diff vs rev28-baseline (hash-stated roles per
the tightened rule) — confined to labels + the
[REV-29 SCOPE BOUND] bracket + the cycle-25 entry, no
undeclared operative change; M2 TENSE DISPOSITION
ADEQUATE as list-bounded: licenses 'no known tense
defect' + closure of the list-bounded pass; does NOT
license whole-ledger tense verification — AND the
auditor DECLINED to re-run the rev-19 extraction, so
LIST COMPLETENESS remains unverified (open residue: the
sweep's coverage claim is attributed, not reproduced;
ruled ACCEPTABLE residue for closure: an unverified
sweep-completeness over a class whose every examined
instance (86/86 cycle-24 + 20 cycle-26 spot) was clean);
M3 SPOT-CHECK (cycle-25 stopping-point item): 20 hits
stratified (pre-shift S-J2 body + shifted-table rows +
disposition rows), 20/20 T1, NO T2 disagreement with
cycle 24; M4 STANDING: labels rev 29/S-A1 rev 8,
ELEVEN tally, R1 clean (authorization-spent appears only
in explicit NEGATION — asserted refusal is
auth-id-already-used per the cycle-23 walk; gaps stand),
suite 89 OK auditor-run; no stopping-point residue.
Cycle 27 (FINAL, closure) next.) terra cycle 27 on
rev 30 (R7-5; FINAL CLOSURE CYCLE; PASS WITH MINORS
0B/0M/1m; SPEC 1/CODE 0 — TWENTY-FOURTH consecutive
code-clean; MANDATE 1 REV-30 BOUNDARY PASS (diff vs
rev29-baseline content-wise rev-29 — labels + cycle-26
entry only; completion snapshot hash-stated in the
prompt per the tightened rule — the rule's FOURTH cycle
applied clean); MANDATE 2 R7 FULL-ROUND ADJUDICATION:
opening findings CLOSED IN SUBSTANCE (the [REV-27] and
[REV-29] brackets verified not-half-applied); spent-behavior
disposition COHERENT across all four sites (rev-25
bullet, rev-26 conclusion, cycle-23 entry, pin-body
note — shipped repair() missing-AUTH-first ordering
re-verified ledger.py 1464-1471); tense disposition
COHERENT with the list-bounded limit preserved; SEVEN
RESIDUES RULED: six ACCEPTED (tense-list completeness —
attributed unreproduced sweep claim; spec-level pin
walks — implementation deliverables; shipped-vs-proposed
distinction; Q-A1-a mode pins — owner-blocked; rev-24
boundary — declaration-only; candidate-file gaps +
Q-ENUM-a — registered/deferred), ONE OPEN-BEFORE-CLOSE
corrected here: the S-J2-R summary's NINE-answer
implementation gate was STALE (pre-Q-J2-h/pre-Q-ENUM-a,
current-tense, unqualified) — [REV-31 record correction]
folded above marking it a historical step superseded by
the ELEVEN-call owner HANDOFF plus ratification (the eleven calls are the
owner handoff; whether Q-ENUM-a gates implementation is an OWNER ACTION
ITEM, undecided — [REV-33 record correction, R8 finding: the rev-31 text
said 'gate', which asserted a prerequisite the record does not establish]) (the stale-gate
class: a summary written before later owner calls
existed, surviving current-tense — withdrawn-name
cousin, 10th instance of the propagation family);
MANDATE 3 FINAL ROUND VERDICT: PASS WITH MINORS —
ROUND-CLOSE CONDITIONAL on the stale-gate correction. [REV-32
record correction, R8 finding 2: the rev-31 fold author
declared the condition SATISFIED and R7 CLOSED; that
declaration is the FOLD AUTHOR'S disposition, NOT a
post-fold Terra verification. The cycle-27 verdict remains
CONDITIONAL until a post-fold audit verifies the rev-31
correction (R8, below).] R7 ESTABLISHED: spent-behavior pins
DISCRIMINATING (cycle 23) with the authorization-stale/
-spent path qualification; tense pass CLOSED for its 86
candidate hits ONLY (not whole-ledger); both rev-26
closure defects record-corrected; CODE changes across
R7: ZERO — 24 straight CODE-CLEAN; HANDOFF TO OWNER
(NOT findings, per OWNER-DEFER): the 11 calls +
ratification of S-J2-R v10 (rev 31) / S-A1-R v7 (rev 8);
snapshot discipline: R2 lapses 3 (revs 24/25/28-prompt),
tightened rule (hash-check before declaring a snapshot
role) held at revs 29/30 — cycle 27 verified the roles
stated in its prompt from hashes.) [R8 — orchestrator implementation of the rev-31 audit findings, rev 32: (1) SPEC major — Q-ENUM-a implementation-gating status recorded as an OWNER ACTION ITEM, not asserted as a prerequisite; (2) SPEC minor — the R7 closure attributed to the fold author, cycle-27 verdict kept CONDITIONAL pending post-fold verification (cycles 28-32 below); (3) SPEC editorial — ROUND R6 status heading repaired. Pre-fold snapshot rev32-prefold.txt hash-matched rev31-baseline.txt before the fold. Suite 89 OK. Owner action items (NOT findings, per owner instruction): ratification of S-J2-R v10 / S-A1-R v7; decisions on the 11 calls; whether Q-ENUM-a gates implementation.]

R8 CYCLE RESULTS (terra, audit of rev 32 then rev 33; recorded at rev 34 per the R8 audit finding that the entry above pointed at cycles that were not written down):
- Cycle 28 (boundary + gate-wording check, rev 32): CHANGES REQUIRED 0B/1M/1m. Findings: the rev-31 Q-ENUM-a correction incomplete at the R7 closure line (fixed at rev 33); heading still 'rev 31 in force' (fixed at rev 33). Cycle 28 completed its mandate. Boundary verified: rev-32 diff against the true pre-fold snapshot (rev32-prefold.txt) confined to declared areas.
- Cycle 29 (action-item classification, rev 32): CHANGES REQUIRED 0B/1M/0m. Finding: the R7 closure line still described the eleven calls as a gate (fixed at rev 33). Inventory of owner-gating statements completed with gating text cited; those are classified as sub-spec gating text, not findings. Cycle 29 completed its mandate.
- Cycle 30 (shipped-code consistency, rev 32): PASS WITH MINORS 0B/0M/1m. Minor: heading (fixed at rev 33). Suite 89 OK; cited refusal literals verified at cited places; CODE findings 0. INCOMPLETE: the auditor did not finish all five R8 cycles and states its verdict covers only the checks it examined.
- Cycle 31 (propagation sweep, rev 32): CHANGES REQUIRED 0B/1M/0m. Finding: the same R7 'ELEVEN-call gate' wording (fixed at rev 33). Propagation sweep of NINE / TEN / Q-J2-a..g hits completed per hit: no other stale tally. Header check: S-J2-R rev 32 and S-A1-R rev 8 identified. INCOMPLETE as a five-cycle round: the sweep completed; cycles 28-32 as a set did not.
- Cycle 32 (closure, rev 32): CHANGES REQUIRED 0B/1M/1m. Findings: the same gate wording (fixed at rev 33) and the heading (fixed at rev 33). R7 CONDITIONAL verdict NOT yet satisfied: it requires a post-fold verification of rev 33, which has not been run. This closure is therefore NOT claimed.

R8 STATUS AT REV 34 (superseded by the R8b entry below, rev 35): all findings from cycles 28-32 folded (rev 33). Open: post-fold verification of rev 33 (the condition for the R7 CONDITIONAL verdict). Owner action items (NOT findings): ratification of S-J2-R v10 and S-A1-R v7; decisions on the eleven calls; decision on whether Q-ENUM-a gates implementation.

## Not done

- Nothing committed. `reference/` and this ledger are untracked.
- The audit prompt used `--tools read,bash`. `grep`/`glob` are not
  valid tool names in this build, so the read-only guarantee relies on
  the prompt, not the tool allowlist.


R8b CYCLE RESULTS (terra, cycles 33-36; recorded at rev 35; saved outputs ~/.tre/audits/r8b/out-c33..36.txt):
- Cycle 33 (boundary + fidelity): PASS 0B/0M/0m. Rev-34 boundary confined to declared areas against rev33-current-prefold34; ledger cycle 28-32 claims match the saved outputs. Mandate complete.
- Cycle 34 (gate-wording sweep): CHANGES REQUIRED 0B/1M/0m. Major: the historical nine-answer sentence lacked an explicit withdrawal of its implementation condition. FOLDED at rev 35 (explicit REV-35 WITHDRAWAL). Remaining gate-wording hits: each cited to sub-spec gating text (OK) or to a disclaimer.
- Cycle 35 (shipped-code + snapshot equality): PASS 0B/0M/0m for the checks performed. Suite 89 OK; authorization-stale at ledger.py ~1469 and auth-id-already-used at ledger.py ~1351 verified; reference/p9m3 equals saved copies c14/c15/c16/c17-run (equality with those copies, not an edit history). Mandate complete.
- Cycle 36 (closure): PASS 0B/0M/0m. Verdict: R7 CONDITIONAL verdict SATISFIED by the rev-33 correction and the post-fold checks in cycles 33-35. Cycle 36 did NOT carry cycle 34's major forward; rev 35 withdraws it explicitly anyway (cycle 36's reading accepted as sufficient but the explicit withdrawal was folded to remove ambiguity).

Incomplete-mandate disclosure: cycle 34 and cycle 36 stated stopping points; cycle 34's verdict covers the gate-wording sweep only; cycle 36 did not independently re-verify the whole ledger. No claim of whole-ledger verification.

R8 + R8b STATUS AT REV 35: findings folded; R7 CONDITIONAL verdict satisfied per cycle 36. Owner action items (NOT findings): ratification of S-J2-R v10 and S-A1-R v7; decisions on Q-J2-a..h, Q-1A-a, Q-A1-a, Q-ENUM-a; decision on whether Q-ENUM-a gates implementation.

[REV-36 SUPERSEDS THE ACTION-ITEM LINE ABOVE: owner rulings received 2026-11-15 — both sub-specs RATIFIED; see OWNER RATIFICATION & RULINGS (REV 36) below. Remaining open: Q-1A-b (new), Q-ENUM-a drafting (commissioned), the unruled Q-ENUM-a gating question, Q-J2-h (owner-deferred). [REV-45 UPDATE: Q-1A-b and the Q-ENUM-a gating question are now RULED (see OWNER RULINGS REV-45); Q-J2-h re-deferred with documentation; the surviving open WORK ITEMS are the two DRAFTS (purge exception; canonical enumeration), which need no owner input, and the deferred Q-J2-h.]]

## OWNER RATIFICATION & RULINGS (recorded at REV 36, 2026-11-15)

Owner replies received in session (orchestrator-recorded; owner text in
quotes). All eleven action items from the rev-35 list were put to the owner;
ten were ruled, one explicitly DEFERRED. One ruling splits a call.

RULINGS:
1. Ratification (AI-1): "ratify now" — S-J2-R v10 (rev 35 body) and
   S-A1-R v7 (rev 8 body) are RATIFIED as they stand, with the option
   resolutions below binding on implementation. The draft->ratify->pin
   discipline is now: pin (implementation) is UNBLOCKED for the units
   whose per-call gates are cleared below; post-ratification rulings that
   amend normative text will be amendments, not re-drafts.
2. Q-J2-a = a1 (0400 archive mode; step-0 mode repair + step-5 chmod;
   acceptance set {0400, 0600-pending}). [owner: "ai-2/3: 0400"]
3. Q-A1-a = follows Q-J2-a => 0400 for both archive classes. BLOCKER at
   the S-A1 site LIFTED at rev 36.
4. Q-J2-b = b1 (cumulative carry sidecar `journal-carries`; grammar as
   spec'd: keys never deleted; values [0, 2^31-1]; fail-closed on
   violation/over-cap). [owner: "ai-4: b1"]
5. Q-J2-e = e1 (keep 64 KiB cap; ACCEPT both documented availability
   ceilings, per-journal AND cumulative — recovery past the ceiling is
   out-of-band restore only). NOTE: e1 was NOT the auditor recommendation
   (e2a 1 MiB was); the owner chose the smaller cap knowingly.
   e2b/e2c not adopted. [owner: "ai-5: e1"]
6. Q-J2-c = c3 (recovery-only intent + the defined
   `journal-rotate-full-override` with prerequisites P1-P3). Matches the
   rev-5/6 recommendation. [owner: "ai-6: c3"]
7. Q-J2-d = d1 (fail-closed: repair decisions AND authorize() refuse
   `journal-carries-damaged` while damage is set). [owner: "ai-7: d1"]
8. Q-J2-g = g2 (damage is PERMANENT for the fleet's life; no clearing
   mechanism; exit is out-of-band restore of a clean lineage only).
   Combined posture with d1 recorded: the ONLY damage exit is restore.
   The "NOTHING proceeds until Q-J2-g lands" gate is answered; the
   flag-semantics text stands. [owner: "ai-8: g2"]
9. Q-J2-f = f1. Owner words: "ai-10: f1" — a bare selection of the
   f1 option (named `operator_purge_rotation_marker()`, deliberate +
   refusal-logged, rearm consequence on its face). [REV-39
   correction, cycle-42 major 1: the rev-36 record turned that
   selection into "the rev-8 FULL PROTOCOL text is accepted, f1 does
   NOT auto-demote". That is an ORCHESTRATOR INTERPRETATION (f1's
   text incorporates the protocol; the owner also ratified the
   sub-spec containing it), NOT a separate explicit owner statement
   — the owner's words do not mention the protocol or auto-demotion.
   IF the auto-demote condition matters in practice, the owner
   should confirm protocol acceptance explicitly; until then the
   interpretation stands as labeled. [REV-45, restated REV-50/51
   per R13 finding 1: the owner's reply "4: one sentence" to item
   4 of the archived review (whose option text WAS 'f1 protocol
   accepted, no auto-demote') is READ by the ledger as choosing
   the offered confirmation — LABORED, NOT LITERAL (cycle 66);
   evidence trail at OWNER RULINGS REV-45 item 4 REV-50/51 notes;
   this is as far as record evidence takes the question.] Deployment of
   the purge command REMAINS BLOCKED — [REV-45: Q-1A-b RULED —
   own ratified exception required; gate = that exception's
   drafting + ratification (see item 10 split + REV-45 item 1).]
10. Q-1A-a, SPLIT. Owner words: "amend 1a for fail close rule n7
    separately".
    (a) 1A is AMENDED for fail-closed hardening deltas (commands may
        add fail-closed refusals, never admit more). [REV-39
        correction, cycle-42 major 2: the owner ruled the GENERAL
        amendment; the application "N1-N6 are WITHIN the amended 1A"
        and the consequent "U1-U5 BLOCK LIFTED" are the LEDGER'S
        DERIVED APPLICATION — the ledger characterizes N1-N6 as
        fail-closed additions (their sites) and that classification
        has NOT been independently re-verified per class. It stands
        as the recorded reading; a per-class verification is R10
        work, not owner action. N7 is NOT decided by the amendment;
        its separate ruling (Q-1A-b) remains required.]
    (b) N7 (the purge-command decision-admitting delta) is routed to a
        NEW OWNER CALL **Q-1A-b**: does the ratified 1A (as amended)
        additionally admit N7's character, or does the purge command
        require its own ratified exception? Until Q-1A-b lands, the
        purge command is SPEC'd but NOT DEPLOYABLE (implementation may
        proceed behind its authorization seam only if Q-1A-b permits).
        [REV-45: Q-1A-b RULED — "require its own exception." N7 and the
        purge command are NOT admitted by the amended 1A. The purge
        command requires a NEW RATIFIED EXCEPTION ARTIFACT (owner
        ruling 2026-1615 session; wording recorded at OWNER RULINGS
        REV-45 item 1). NEW GATE CHAIN [REV-47, cycle-62 finding:
        NECESSARY NOT SUFFICIENT — ratification of the exception is
        the gate THIS ruling establishes; it does not by itself
        satisfy every other standing deployment condition (atomicity,
        pins, suite, per-unit gates)]: exception drafted (no owner
        input needed) -> owner ratifies the exception -> (with the
        usual standing deployment conditions also met) purge
        deployable. Until the exception is RATIFIED, purge remains
        SPEC'd but NOT DEPLOYABLE — this REPLACES the open-question
        framing above; the fail-closed amendment stays philosophically
        clean (the admit-more delta carries its own explicit owner
        signature).
11. Q-ENUM-a: "commission it" — the canonical refusal enumeration is
    COMMISSIONED as spec work (R9 deliverable: draft the canonical
    enumeration section from both sub-spec bodies, mechanical-extraction
    diff at ~/.tre/audits/sj2r/c17/ as the completeness check, terra
    audit of the enumeration itself). Until it lands, the standing
    scope-down rule remains in force. The SEPARATE owner question
    "does Q-ENUM-a gate implementation" was NOT ruled — the owner
    addressed commissioning only; it remains an open action item
    (current de facto: no, per the REV-35 withdrawal; nothing gates on
    it). [REV-45: NOW RULED EXPLICITLY — does NOT gate implementation,
    WITH a documentation condition (the enumeration must be documented
    as an explicit follow-up commitment, problem-solvable later; owner
    wording at OWNER RULINGS REV-45 item 2). The REV-35 de-facto
    position is now an EXPLICIT ruling; the drafting commission stands
    unchanged and remains PENDING.]
12. Q-J2-h: EXPLICITLY DEFERRED by the owner ("ai-9: let's defer") —
    the first deferred (not open, not answered) call. The T4-gap
    whole-dir-restore route stands as spec'd; no completion mechanism
    is being drafted. Implementation must NOT assume a future h-ruling
    adds one. [REV-45: RE-AFFIRMED DEFERRED with a documentation
    requirement (owner wording at OWNER RULINGS REV-45 item 3): the
    deferral and the T4-gap's consequence (no defined completion path;
    out-of-band manual intervention is the current answer) must be
    DOCUMENTED as an acknowledged, deliberate gap — not silently
    deferred. Deferral posture itself is UNCHANGED.]

TALLY AT REV 36: resolved Q-J2-a/b/c/d/e/f/g + Q-A1-a + Q-1A-a(a);
OPEN: Q-1A-b (new, from the split), Q-J2-h (DEFERRED by owner),
Q-ENUM-a (commissioned, drafting pending). Implementation gates cleared
for: both commands' core units, U1-U5, the rotation/rebuild reader rows,
the carry sidecar + 64 KiB cap posture, the c3 override mechanism
[REV-39 qualification, cycle-42 major 2: "cleared" = per the REV-36
rulings AND their derived application above; pins/fixtures for these
units are SPECIFIED but NOT yet implemented, executed, or proven —
readiness is per-spec, not proven-in-code; the Q-ENUM-a gating question
remains unruled and is NOT treated as a gate per the REV-35 withdrawal
[HISTORICAL AS OF REV 36 — the gating question was RULED does-not-gate
at REV-45 item 2; "remains unruled" was true when written at REV-36,
and is superseded]].
Still gated: purge-command deployment [REV-45: Q-1A-b RULED —
own ratified exception REQUIRED; gate = drafting + ratification of
that exception, see OWNER RULINGS REV-45]. Historical "BLOCKED until
Q-J2-x lands" sentences above are SUPERSEDED at the sites tagged
[REV-36]; untagged ones remain accurate as history.

R9 CYCLE RESULTS + FOLD (terra cycles 37-40 on rev 36; saved outputs
~/.tre/audits/r9/out-c37..40.txt; folded at rev 37):
- Cycle 37 (boundary + tag fidelity): CHANGES REQUIRED 0B/2M/0m. Both
  majors = incomplete gate propagation + the ONLY-unblocked survivor;
  folded. Flagged the rev-36 header/status edits (lines 79, 3950, 4085
  vs rev35-prefold36.txt) as UNDECLARED BOUNDARY CHANGES: "They appear
  consistent with ratification, but are undeclared boundary changes.
  Restore them or explicitly authorize that boundary expansion."
  [REV-44 correction, cycle-55 SPEC: this entry previously said
  "(accepted: they are in the declared ratification scope)" — that was
  the fold-AUTHOR's disposition, NOT cycle 37's ruling; cycle 37 asked
  for restoration or explicit authorization and cycle 40 expressly
  declined to decide the authorization question. Apparent consistency
  with the owner's ratification is NOT auditor acceptance of an
  expanded boundary. Disposition retained (edits kept as ratification-
  scope status text), now labeled as the author's call on an open
  auditor request, per the standing record rule.]
- Cycle 38 (tally + propagation): CHANGES REQUIRED 0B/3M/2m. Majors
  duplicate 37 plus the obsolete CURRENT-handoff line; minors = stale
  ratification status text and stale recap lists; folded at rev 37
  (heading/intro corrected, R6 heading updated, recap sites tagged).
- Cycle 39 (contradiction + consequence, self-declared incomplete):
  CHANGES REQUIRED 0B/4M/1m. NEW majors: operative rebuild site said
  1 MiB (CORRECTED to 64 KiB per e1) and cap pins framed around
  e2a/e2b (replaced with e1-specific pin directions). Suite 89 OK.
- Cycle 40 (closure): verdict **CHANGES REQUIRED 0B/6M/2m** against the
  PRE-FOLD ledger, consolidating cycles 37-39's findings.
  [REV-42 correction, cycle-50 major 1 (confirmed by 51, adopted by 52):
  this entry previously read "Round verdict per cycle 40: the R9 FINDINGS
  are closed by the rev-37 fold, VERIFIED..." — cycle 40 never verified
  the rev-37 FOLD; it consolidated and confirmed the FINDINGS list
  (against pre-fold text) and disclaimed whole-ledger verification. The
  rev-37 fold is the fold-author's disposition of that list; the
  independent site-specific verification OF the fold (three closed, five
  residuals) belongs to CYCLE 41, and closure requires the post-fold
  sequence, exactly as later rounds record it.]

[REV 37 IN FORCE: the REV-36 rulings were PROPAGATION-ATTEMPTED at the
cited gate, cap, damage-exit, handoff, and ratification-status sites.
[REV-43 correction, cycle-54 major: "propagated to every cited ...
site" was an overclaim of that fold's completeness — cycle 41's
independent check of rev 37 FOUND FIVE propagation residuals at
exactly those object classes (cap oracle, damage-exit, narratives,
recap lists), folded at rev 38; do not read this line as a clean-
propagation verdict by any auditor.] Open owner items unchanged from
REV 36: Q-1A-b; Q-ENUM-a enumeration + gating question; Q-J2-h
deferred.]

R9 POST-FOLD VERIFICATION (cycle 41 on rev 37; ~/.tre/audits/r9/out-c41.txt;
folded at rev 38): CHANGES REQUIRED 0B/3M/2m — of the eight consolidated R9
findings, three CLOSED confirmed (rebuild cap; Q-1A-a restrictions;
handoff); five residuals folded at rev 38: (M2) worst-shape under-cap
oracle pinned e1-correct (over-bound = accepted refusal fixture); (M3)
recap "NORMATIVE option set e1/e2a/e2b" corrected to e1-ruled; (M5)
restoration-of-archives passage now states g2: member restoration does
NOT clear damage; clean-lineage + fresh out-of-band sidecar only;
(m7) both pre-ruling "no code until ratified" narratives dated
HISTORICAL; (m8) stale open-calls list carries the REV-36 tally.
Boundary PASS **against `rev36-prefold37.txt` for the rev-37 FOLD** —
that is the ONLY boundary check cycle 41 performed. [REV-42 correction,
cycle-50 major 2 (confirmed by 51, adopted by 52): this entry previously
asserted "Boundary PASS (diff vs rev37-prefold38 confined to the
declared sites)" — NO auditor performed a boundary check of the rev-38
fold against rev37-prefold38.txt at fold time; rev37-prefold38.txt is
merely this fold's snapshot. The first evidenced comparison of
rev37-prefold38 vs the folded text is CYCLE 42's audit diff (its
verified-scope section reports it; verdict there was on content, not a
dedicated boundary ruling).]
Suite 89 OK (six consecutive runs; one earlier run reported a single
test error whose traceback was consumed by a tail pipeline before it
could be captured — subsequent runs including pre/post-fold of this
fold are clean; flagged, not silently dropped).

[REV 38 IN FORCE. REV-39 CORRECTION (cycle-42 major 3, owner
instruction 2026-11-15): the rev-38 claim "R9 CLOSED" is WITHDRAWN —
a fold is not independent confirmation. Correct status: R9 cycle-41
residuals FOLDED at rev 38; independent post-fold verification NOT yet
run; R9 NOT YET CERTIFIED CLOSED. Cycle 42 (independent audit of the
rev-38 latest changes) then raised the three majors folded here at rev
39; the R9/R10 closure line is: cycle-43+ post-fold verification of
rev 39. Owner items unchanged: Q-1A-b; Q-ENUM-a enumeration + gating
question; Q-J2-h (deferred).]

R10 FOLD (rev 39; audit basis: cycle 42 = independent adversarial audit of
the rev-38 latest changes, ~/.tre/audits/r9/out-c42.txt, verdict CHANGES
REQUIRED 0B/3M/0m, CODE 0 in scope):
- Major 1 (f1 record): folded above item 9 — bare owner selection vs the
  orchestrator's protocol-acceptance interpretation now separated; the
  interpretation stands as labeled; confirmation is an OWNER OPTION, not
  a finding.
- Major 2 (1A application): folded above item 10(a) + the TALLY
  qualification — general amendment = owner ruling; N1-N6/U1-U5
  application = ledger-derived, per-class verification = R10 work; N7
  untouched by the amendment.
- Major 3 (R9 closure): folded above — "R9 CLOSED" WITHDRAWN; correct
  status: residuals folded, independent post-fold verification pending,
  closure claimed only by the cycle 43+ sequence below.
Pre-fold snapshot: rev38-prefold39.txt (hash-matched before fold). Suite
89 OK. R10 CYCLE PLAN: cycles 43-46 = post-fold verification of rev 39
and the standing R9 obligations (the commissioned enumeration remains a
separate, still-pending deliverable, not closure evidence).

R10 RECORD (rev 40; cycles 43-46, ~/.tre/audits/r10/out-c43.txt .. out-c46.txt;
basis snapshot rev39-prefold40.txt = hash-matched pre-fold of the residual
fold):
- Cycle 43 (post-fold verify of rev 39): CHANGES REQUIRED 0B/2M — the
  three cycle-42 corrections verified at their principal sites; two
  PROPAGATION residuals (the f1 recap line; the categorical 1A/U1-U5
  sites). Boundary clean; 89 OK.
- Cycle 44 (propagation sweep): CHANGES REQUIRED 0B/2M — same two
  residuals independently confirmed. NOT a full sweep (labeled).
- Cycle 45 (per-class classification — the verification rev-39 item
  10(a) assigned to R10): N1 SUPPORTED / N2 SUPPORTED / N3 SUPPORTED /
  N4 SUPPORTED / N5 SUPPORTED / N6 SUPPORTED (each a refusal-adding
  hardening delta per ledger text + cited shipped code at
  ledger.py:537-547, 1308-1368, 659-683, 1473-1484); N7 separately
  admits more (Q-1A-b untouched); 1 MAJOR recap residual. Site-specific
  classification, not proof of the full design.
- Cycle 46 (closure): verdict **CHANGES REQUIRED (2 major SPEC)** — at
  cycle 46's time the two propagation residuals were **NOT YET FOLDED**
  (the ledger still matched the rev-39 baseline). Its substantive
  ruling stands: the missing R9 independent POST-FOLD VERIFICATION IS
  SUPPLIED by cycles 43-45, as verification-performed only, NOT as a
  clean-pass certification; NO whole-ledger certification claimed.
  [REV-41 correction, cycle-48 major: this entry previously said "R10's
  own verdict: residuals folded at rev 40" UNDER cycle 46 — a
  chronology/attribution error: the rev-40 fold (recap f1 label; U1-U5
  derived-application + cycle-45 note) happened AFTER cycle 46's
  changes-required verdict, as the correction to it; the residuals'
  independent verification and R10 closure belong to CYCLE 47. Full
  R10 chronology: 43/44 find residuals -> 45 classification + recap
  residual -> 46 changes-required + R9-verification ruling -> REV-40
  FOLD -> 47 post-fold PASS -> REV-41 record correction.]
STATE AT REV 40: R9 verification supplied with the two cycles-43/44
residuals folded at rev 40 — R9 closure statement: verification
performed by R10 cycles 43-45; residuals found and folded at rev 40; a
clean post-fold verify (cycles 47+) closes R10 in the established
manner. Owner items unchanged: Q-1A-b; Q-ENUM-a enumeration (commissioned,
NOT completed) + its unruled gating question; Q-J2-h (deferred);
OPTIONAL explicit f1-protocol confirmation (interpretation stands as
labeled until then). Implementation pins: unimplemented (all readiness
statements are per-spec).
- CYCLE 47 (post-fold verification of rev 40, run as cycle 47 of this
  round): **PASS 0B/0M/0m** — boundary diff confined to the two residual
  folds + record; f1 recap + U1-U5 sites verified carrying the
  interpretation/derived labels; overclaim search clean (remaining "R9
  CLOSED" matches are the withdrawals themselves); 89 OK. **R10 CLOSED
  within the verified scope** (~/.tre/audits/r10/out-c47.txt). Explicit
  non-claim kept: NO whole-ledger contradiction-and-consequence sweep
  and NO complete shipped-code audit has been performed in any round to
  date; a whole-ledger certification round would need to be commissioned
  separately. R9 closure statement stands as: verification performed by
  R10 43-45, residuals folded rev 40, verified PASS rev 40 cycle 47.

RECORD CORRECTION (rev 41; audit basis: cycle 48 = independent audit of
the rev-40 latest changes + the appended cycle-47 closure statement,
~/.tre/audits/r11/out-c48.txt, verdict CHANGES REQUIRED 0B/1M/0m, CODE 0
in scope): the sole finding — cycle-46 entry misattributed the rev-40
fold ("R10's own verdict: residuals folded at rev 40") as cycle 46's
view when cycle 46 actually said CHANGES REQUIRED with the residuals
UNFOLDED — folded above with the full R10 chronology. No operative
spec text changed (the f1/U1-U5 corrections themselves verified sound at
cycle 48). Pre-fold snapshot: rev40-prefold41.txt (hash 8d95d5be...).
Suite 89 OK. R11 CYCLE PLAN: cycles 49-52 = post-fold verification of
rev 41; cycle 50 audits RECORD/CHRONOLOGY INTEGRITY of every round
record (43-48) against the raw out-c*.txt files; cycle 51 = fresh
targeted contradiction pass over the rev-39..41 correction cluster;
cycle 52 = R11 closure with explicit non-claims.

R11 RECORD + FOLD (rev 42; cycles 49-52, ~/.tre/audits/r11/out-c49.txt ..
out-c52.txt; pre-fold snapshot rev40-prefold41.txt hash 8d95d5be...;
rev-42-fold pre-fold snapshot rev41-prefold42.txt — name means
"snapshot of rev 41 taken before the rev-42 fold"; the REV-41 fold's
snapshot is rev40-prefold41.txt above [REV-42 correction, cycle-53
minor: earlier text here called rev41-prefold42.txt the "rev-41-fold
pre-fold snapshot" — wrong fold label])
- Cycle 49 (post-fold verify of rev 41): PASS 0/0/0 within scope — the
  cycle-46 chronology correction verified against raw out-c46/47/48.
- Cycle 50 (RECORD/CHRONOLOGY INTEGRITY vs raw outputs, self-declared
  PARTIAL): CHANGES REQUIRED 2 SPEC — (1) cycle-40 entry credited cycle
  40 with verifying the rev-37 fold (raw: CHANGES REQUIRED 6M/2m
  against PRE-FOLD text; fold verification belongs to cycle 41);
  (2) cycle-41 entry asserted a rev-38 boundary PASS (raw: cycle 41's
  ONLY boundary check was rev36-prefold37 / the rev-37 fold).
- Cycle 51 (targeted contradiction pass on the rev-39..41 cluster):
  3 SPEC — confirmed both cycle-50 findings + NEW: the S-A1 site
  (:3130) stated the U1-U5 lift categorically (unlabeled derived
  application).
- Cycle 52 (closure): R11 OPEN as of rev 41; the three findings above
  folded at REV 42; closure requires independent post-fold verification
  of the rev-42 fold (cycle 53+), and cycle 52 expressly declined to
  certify beyond cycles 49-51's scope.
STATE AT REV 42: the record-integrity class (misattributed verdicts /
PASS-claims-for-folds-that-were-never-boundary-checked / unlabeled
derived applications) is now folded; NOTE for future record-writing:
an entry may attribute to a cycle ONLY what its raw output shows, and
a fold's disposition is the author's, never the finding-auditor's.
Owner items unchanged (Q-1A-b; Q-ENUM-a enumeration+gating; Q-J2-h
deferred; optional f1 confirmation). Pins unimplemented. Whole-ledger
sweep still NOT performed.

R11 CONTINUED (rev 43; cycles 53-54, out-c53/out-c54):
- Cycle 53 (post-fold verify of rev 42): CHANGES REQUIRED 1 minor — the
  three R11 folds verified faithful; new defect: rev41-prefold42.txt
  mislabeled as the "rev-41-fold" snapshot (it is the rev-42 fold's).
  Folded in-place at rev 42 (label-only edit; baseline rev42-baseline.txt).
- Cycle 54 (verify of that label fold + record-region integrity recheck):
  label fold verified clean (diff confined); NEW MAJOR: the "[REV 37 IN
  FORCE]" state block claimed propagation to EVERY cited site — an
  overclaim contradicting cycle 41's five residuals. Folded at REV 43
  ("propagation-attempted" + pointer to the residuals; snapshot
  rev42b-prefold43.txt).
- Standing rule re-affirmed for record-writing: a STATE block may only
  claim what an auditor verified; fold-author dispositions are labeled
  as attempts until independently checked.
- Cycle 55 (post-fold verify of rev 43 + FULL record-region integrity
  pass out-c37..c54): CHANGES REQUIRED 1 SPEC — the cycle-37 entry
  recorded the undeclared-boundary finding as "(accepted ...)"; raw
  cycle 37 demanded restore-or-authorize and cycle 40 declined to
  decide. Folded at REV 44 as the author's disposition on an open
  auditor request (snapshot rev43-prefold44.txt). Also: cycle 55's
  FIRST suite run failed once (F19 fs-probe-failed:leg4, cause not
  established — same intermittent class as the rev-38 note); five
  consecutive re-runs here 89 OK; flagged, not hidden. Record-integrity
  class otherwise clean across the full region check.
- Cycle 56 (post-fold verify of rev 44 + R11 closure assessment,
  out-c56.txt): **PASS 0/0/0 within scope** — cycle-37 correction
  verified against raw out-c37/40 (quote, counts, author-vs-auditor
  labels); record-region FINAL PASS: combining cycle 55's full-region
  comparison (through c54) with cycle 56's checks, NO surviving
  record-attribution / snapshot-label / state-overclaim defect
  identified (evidence-bounded, not proof-of-none); suite 89 OK
  first-run here.
  **R11 CLOSED within its verified scope** (terra's closure assessment
  adopted): the record-integrity class found its diminishing-return
  boundary; operative spec text untouched by these record defects.
  Non-claims preserved: no whole-ledger sweep; no complete code audit;
  enumeration still commissioned-not-completed; Q-1A-b / gating
  question / Q-J2-h / f1 confirmation owner items; pins unimplemented.

ROUND SEQUENCE FINAL (for the next reader): R9 verification = R10
cycles 43-45, residuals folded rev 40, verified cycle 47. R10 =
record-chronology class (cycle 48) -> R11 = record-integrity class
(cycles 49-56), closed at rev 44 by cycle 56. A NEW round must NOT
re-mine the record region by default: the standing open work is
(a) the Q-ENUM-a enumeration draft (owner-commissioned, still pending,
needs NO owner input to draft), and (b) whenever the owner rules on
Q-1A-b / the gating question / f1 confirmation, fold-and-verify as
usual. [REV-46, cycle-58 finding 3 + cycle-59 finding 1: ALL THREE
of those rulings LANDED at REV-45 (see OWNER RULINGS REV-45) and
were folded at REVS 45-46; the CURRENT standing open work is the
DRAFTS + docs: (i) the Q-ENUM-a enumeration draft, (ii) the
purge-exception artifact draft (then owner ratification, then the
standing deployment conditions), (iii) DC-1 and DC-2.] [SUPERSEDED for
item (i)/(iii) STATUS by the OWNER DECISION ROUND below (2026-07-27):
enumeration drafted, audited, and RATIFIED (DC-1 discharged); DC-2
written, owner review open; the purge-exception draft (ii) DEFERRED by
owner instruction — that item remains open-but-deferred, not pending
drafting work. A3-fold, cycle A3 finding 2: the REV-46 bracket is
history; that entry is the current work-state anchor.] Known intermittent: F19 fs-probe suite flake (twice in ~70
runs, cause unknown, tracked not hidden). [RESOLVED 2026-07-27
post-decision-round, owner "debug F19": ROOT CAUSE FOUND — the suite's
own F19 contention test forks racing Ledger constructors on ONE dir;
the startup probe is a once-per-directory contract and leg 4's census
check carries a BASELINE/CENSUS RACE against a concurrent sibling
probe: the baseline is taken before leg 4, and only names created
AFTER it (still visible at the post-rename census, neither ours nor
in baseline) trip the refusal — so overlap makes false refusal RACES
the common outcome, not every overlap fails unconditionally (A1-fold,
cycle A1 finding 2: wording precision; the probe contract itself is
unchanged). Observed runs: 8x400 concurrent probes on one dir =
3168/3200 leg4 fails; serial 3000 = 0 fails. Fix is TEST-SIDE (racer
children construct with probe=False; the append-flock contention
under test is unaffected; every spawned dir is still probed once by
the parent): F19 10/10, full Python suite 89/89 x3. "probe.py and
ledger.py UNTOUCHED" means UNCHANGED BY THIS F19 FIX relative to the
pre-fix working state (A1-fold, cycle A1 finding 1: commit-relative
scope claim corrected) — the commit itself ADDS the reference
implementation (ledger.py, probe.py, test_ledger.py are new files in
this commit; they carry the spec-bearing probe/flock contracts).
AUDIT SURFACE DISCLOSURE: the E/F rounds audited the ENUMERATION
artifact against this ledger, NOT this reference implementation line-
by-line (the v38 code rounds audited the earlier lineage of the same
code). THIS A round (7 cycles, commit 1425a69) is its scoped audit;
findings fold here. No spec change.]

FOUR-TIER ATTRIBUTION ANCHOR (REV-51, cycle-69 recommendation;
standing standard for EVERY attribution in this ledger):
  (a) DIRECT — the owner's own words rule on the substance (REV-45
      items 1-3: "require its own exception" / "doesn't gate
      (with proper documentation...)" / "defer (proper doc)").
  (b) ADOPTED-OFFER (LABORED) — an abbreviated owner reply read as
      selecting an offered act whose WORDING COMES FROM THE OFFER;
      the reading must carry its label (REV-45 item 4 / f1: "4: one
      sentence" read as choosing the offered one-liner — supportable,
      not literal; see item 4 REV-50/51 notes).
  (c) DERIVED APPLICATION — a general owner ruling applied by the
      ledger to specific deltas (N1-N6 within amended 1A).
  (d) INTERPRETATION — ledger reading of ambiguous phrasing (DC-1
      parallel-commitment timing).
  Future attributions MUST name their tier; escalation between
  tiers requires new owner words, never inference.

OWNER RULINGS (REV 45, 2026-11-15) — response to the open-action-item
pros/cons review; owner said "good to follow your order". Owner words
verbatim, in the order sent (matching the review's order): [REV-50,
R13 finding 2 fix: the mapping was ASSERTED before; it is now
EVIDENCED. The review sent to the owner had numbered sections 1 =
Q-1A-b, 2 = Q-ENUM-a, 3 = Q-J2-h, 4 = explicit f1 confirmation; the
full offer text is archived at ~/.tre/audits/r12/action-item-review-
offer.txt (sha256 1fffde74902e33e516b005e13d8de89bca5e2c9bde496fe0e76f4d0b6b15c432, extracted from the orchestrator session
transcript), so 1->Q-1A-b / 2->Q-ENUM-a / 3->Q-J2-h / 4->f1 is a
documented mapping, not an assumption.]
1. Q-1A-b (purge-command character): "require its own exception" — the
   amended 1A does NOT admit N7; the purge command requires a NEW
   RATIFIED EXCEPTION ARTIFACT. The fail-closed amendment stays clean
   (the one admit-more delta carries its own explicit owner signature).
   NEW PURGE GATE CHAIN (REV-46 correction, cycle-57 finding 1:
   NECESSARY, NOT SUFFICIENT): (i) exception artifact drafted (spec
   work, no owner input needed), (ii) owner RATIFIES the exception —
   THESE ARE THE NEW GATES the ruling establishes, but ratification
   alone does NOT assert every OTHER deployment condition (atomicity,
   pins, suite, per-unit gates) is satisfied; purge deployability
   still requires the full standing deployment conditions as usual.
2. Q-ENUM-a gating question: "doesn't gate (with proper documentation
   that we can problem solve later)" — RULED: the canonical refusal
   enumeration does NOT gate implementation. The documentation the
   owner attached is READ as a PARALLEL COMMITMENT (DC-1), NOT a
   precondition [REV-50, R13 finding 3: this parallel-vs-precondition
   reading is a LEDGER INTERPRETATION of "doesn't gate (with proper
   documentation...)"; the owner's words settle the ENUMERATION'S
   non-gating explicitly but do not expressly time-bind DC-1; the
   interpretation is the natural reading of a non-gate that carries
   a doc ask, and is labeled as such]: implementation proceeds
   whether or not DC-1 is written
   [REV-46, cycle-57 finding 2: earlier "CONDITIONAL on documenting"
   phrasing could be read to re-gate implementation, which the ruling
   does not establish]. The drafting commission (item 11)
   STANDS and remains pending. All other implementation gates stand as
   at REV 36 (+REV-45 item 1 for purge).
3. Q-J2-h: "defer (proper doc)" — DEFERRAL RE-AFFIRMED, with the
   documentation requirement: the deferral + T4-gap consequence (no
   defined completion path for the whole-dir-restore route; out-of-band
   manual intervention is the current answer) must be documented as an
   acknowledged deliberate gap. No design work commissioned; posture
   otherwise unchanged.
4. f1 protocol confirmation: "one sentence" — OWNER RESPONSE via
   ADOPTED-OFFER CONFIRMATION [REV-50, R13 finding 1 fix: the rev-45
   fold rendered this as a bare "EXPLICIT RULING"; the honest
   attribution chain is recorded here]. What the owner received
   (archived offer, item 4): the option "Confirm explicitly — One
   sentence ('f1 protocol accepted, no auto-demote') upgrades the
   interpretation to a ruling", recommended with "send the one-liner
   if you agree with the interpretation". The owner replied "4: one
   sentence" to that item. RULING OF RECORD [REV-51, cycle-66 fix:
   labeled inference, not literal report]: the ledger READS "4: one
   sentence" as the owner selecting the offered confirmation act, so
   f1 protocol accepted / no auto-demote is the working ruling of
   record. The owner's LITERAL REPLY was the five-word abbreviation;
   the offered sentence itself appears ONLY IN THE OFFER, never in
   the owner's message. Adoption is therefore an INTERPRETATION OF
   AN ABBREVIATED REPLY (supportable: the reply numbers the item and
   names its offered mode) — not a report that the owner sent or
   quoted the sentence. Evidence available: offer text + reply +
   transcript pointer; anything beyond "the owner chose confirmation
   via the offered mode" is NOT established. Should the attribution
   ever matter operationally, a fresh owner confirmation retakes it. NOTE: about the PROTOCOL's content
   only; does NOT override item 1 — purge deployment still waits for
   the ratified exception.

EFFECT AT REV 45: open OWNER decisions: NONE pending ratification
beyond the purge-exception artifact when it is drafted. Open WORK
(no owner input needed): (a) Q-ENUM-a canonical enumeration draft;
(b) purge-exception artifact draft (then owner ratification — the
ratification is a necessary gate, not a sufficient one, REV-46
correction of cycle-57 finding 1); (c) the
two documentation commitments from items 2/3. Q-J2-h: deferred; the
deferral is RECORDED here; the self-contained DC-2 DELIVERABLE is
still PENDING (REV-46 correction of cycle-59 finding 3: "documented"
without qualification overstated completion). Pins: all unimplemented; readiness remains per-spec.
Per the owner's standing instruction: spec changes that close
inconsistencies where applicable remain ACTION ITEMS, not findings.

DOCUMENTATION COMMITMENTS (REV 45 — the "proper documentation" the
owner attached to items 2 and 3; these are the artifacts the rulings
require, owed as spec work, each self-contained):
DC-1 (from REV-45 item 2, Q-ENUM-a): a clearly labeled
"FOLLOW-UP: CANONICAL REFUSAL ENUMERATION" commitment block stating:
the enumeration is commissioned-not-yet-drafted; implementation may
proceed without it (owner ruling REV-45); the residual risk it exists
to close (an operator-facing refusal table silently missing a refusal
path) is mitigated meanwhile by the standing scope-down rule (commands
may add fail-closed refusals only; cycle-45 per-class verification of
N1-N6); problem-solvable later BY DESIGN (owner ruling). [REV-46,
cycle-57 finding 2b + cycle-59 finding 2: an earlier draft of this
block said the enumeration "must land before operator-facing release
documentation is written" — that DEADLINE is NOT owner-authorized and
is REMOVED; if any timing constraint is wanted it must be a separate
labeled proposal for the owner, not attributed to the REV-45 ruling.]
DC-2 (from REV-45 item 3, Q-J2-h): an "ACKNOWLEDGED GAP: T4-GAP
COMPLETION MECHANISM DEFERRED" block stating: a T4-gap entry's
re-entry refuses (R-c) with WHOLE-DIR RESTORE as the only spec'd
route; there is NO defined COMPLETION MECHANISM turning a restored
dir into a clean lineage short of that out-of-band restore; the owner
has deferred defining one (REV 36 original; RE-AFFIRMED REV 45 with
this documentation requirement) so operators treat it as a deliberate
accepted gap — out-of-band manual intervention is the answer of
record — and implementation must not assume a future ruling adds an
in-protocol completion path.
STATUS [updated post-owner-decision-round, was "DC-1/DC-2 NOT YET
WRITTEN"]: DC-1 WRITTEN AND RATIFIED (docs/21a-refusal-enumeration.md,
owner ratification this session). DC-2 WRITTEN (block appended below;
owner review open). Purge-exception draft: DEFERRED by owner (not
drafted). These are WORK ITEMS, not findings.

R12 CYCLE RESULTS (57-61) + FOLD AT REV 46:
- Cycle 57 (boundary + ruling fidelity, rev 45): FINDINGS 0B/2M+
  (2 SPEC): gate chain overstated ratification as SUFFICIENT; the
  non-gating ruling rendered CONDITIONAL on documentation + DC-1
  carried an unattributed release-doc deadline. Boundary PASS. F19
  flake recurred (consistent with tracked class; cause still
  unknown). Both folded at rev 46 — [REV-47, cycle-62 finding: the
  sufficiency correction initially missed the item-10(b) site;
  completed at rev 47, see R12 closure entry.]
- Cycle 58 (propagation sweep, rev 45): CHANGES REQUIRED 3 SPEC:
  stale N7-ruling gate sites (:559, :2527); live auto-demote clause
  in the protocol body; ROUND SEQUENCE FINAL presenting landed
  rulings as future. All folded at rev 46.
- Cycle 59 (record integrity of the fold, rev 45): CHANGES REQUIRED
  3 SPEC: stale next-reader paragraph (overlap 58-3); DC-1 deadline
  enrichment (overlap 57-2b); effect summary "documented" overstating
  the pending DC-2 deliverable. Historical R9-R11 region verified
  NOT retro-edited. All folded at rev 46.
- Cycle 60 (spec-vs-code, rev 45): NO CODE FINDING — shipped
  reference/p9m3 has no purge surface, stub, or claim (absence
  CORRECT per the ruling); no code/docstring/test conditioned on the
  old open framings; suite 89 OK. Classification of 57-59 (SPEC,
  all ledger-text sites) supplied at cycle 61.
- Cycle 61 (closure assessment, rev 45 = unfolded findings):
  R12 CANNOT CLOSE pre-fold: 5 distinct finding clusters (with
  overlaps) listed with sites; fold + snapshot + post-fold
  independent verification required; diminishing-return closure
  premature at that point. Post-fold verification = cycle 62 below.
CLASSIFICATION: 8 raw findings (57x2, 58x3, 59x3), 5 distinct after
overlaps, ALL SPEC (ledger text at cited sites), 0 CODE — no shipped
defect. None closed by an owner spec change (rulings were correctly
recorded; the defects were fold-side propagation/rendering errors,
now corrected). Folded at rev 46 EXCEPT the item-10(b) sufficiency
site, which completed at rev 47 (cycle-62 residual); pre-fold
snapshot rev45-prefold46.txt.

R12 CLOSURE (REV 47): cycle 62 (post-fold independent verification of
the rev-46 fold) found ONE residual: the item-10(b) gate-chain site
still implied ratification-sufficiency (raw cycle 57 had cited both
sites; fold 46 corrected only the rulings-block site), and the R12
results block overstated that fold. Corrected at rev 47
(NECESSARY-NOT-SUFFICIENT tag at the item-10(b) site + fold-status
correction). Cycle 62 verified everything else PASS at its sites
(non-gating parallel commitment; DC-1 deadline removed; both N7 gate
sites tagged; auto-demote dead/provenance; next-reader updated;
deferral vs DC-2 deliverable distinguished; boundary clean; R9-R11
history untouched; suite 89 OK; no over-correction found).
CLOSURE LINE: with the rev-47 site correction, every finding site from
cycles 57-59 has its correction verified by an independent cycle
(62 verified all other sites; the rev-47 residual site is
mechanically the same tag text cycle 62 prescribed). Per the
established standard the residual class here is single-site wording
with the correction text supplied by the auditor itself; a further
full verification cycle on it repeats R11's diminishing-return
pattern. [REV-48, cycle-63 record correction (cycle-63 findings 2-3):
that reasoning was written BEFORE verification; cycle 63 IS a fresh
independent verification of the rev-47 item-10(b) site (PASS: no
unqualified sufficiency reading survives) and of the cycle-57
fold-status correction (PARTIAL PASS then fixed at rev 48 by this
entry), with boundary PASS and suite 89 OK. The former
"rev-47 site itself unverified" disclaimer is SUPERSEDED — but
cycle 63 is NOT self-certifying beyond its specified sites.]
[REV-50, R13 finding 2: "faithfully propagated" below meant
propagation FAITHFUL TO THE AUDIT INPUTS AS SUPPLIED — including
the orchestrator's reading of the owner's reply. A post-R12
independent review (R13) found the f1 item's attribution needed
the evidence chain spelled out and FOUR other raw findings (five
raw total — REV-51/cycle-67 count fix);
those were NOT visible to R12's cycles because the review offer
text had not been archived as evidence. R12's verified-scope
closure stands for FOLD MECHANICS; the attribution upgrades
arrive with R13/REV-50.] R12 is
CLOSED within its verified scope at rev 48:
all four owner rulings faithfully propagated (as qualified at
REV-50; see R13); action-item ledger
accurate (enumeration draft, purge-exception draft, DC-1, DC-2 —
ACTION ITEMS per the owner's instruction, not findings); 0 CODE
findings across R12 (cycles 60/63 scoped code checks); known limits
preserved (no whole-ledger sweep, no complete code audit, pins
unimplemented, F19 flake tracked).

R12 FINAL (REV 48): cycle 63 (fresh independent verification of the
rev-47 residual) PASSED the item-10(b) gate-chain correction and the
boundary + suite, and raised 2 record-fidelity SPEC minors: the
classification line still said "All folded at rev 46" (contradicting
its own rev-47 note) and the closure entry's "every site verified"
assertion contradicted its own "rev-47 unverified" disclaimer. Both
corrected at rev 48 (classification now distinguishes rev-46/rev-47;
closure rewritten to cite cycle 63 as the verification with its scope
limits). 0 CODE findings in cycle 63's scoped pass. No further
residuals identified. R12 CLOSED at rev 48 within verified scope.
Standing open work (ACTION ITEMS, no owner input needed): (i) the
Q-ENUM-a canonical enumeration draft; (ii) the purge-exception
artifact draft -> owner ratification -> standing deployment
conditions; (iii) DC-1 and DC-2 written. Q-J2-h: deferred, recorded;
DC-2 deliverable pending. Pins: unimplemented.
[SNAPSHOT (B7-fold, cycle B7 finding 1): the standing-work list above
is superseded by the OWNER DECISION ROUND entry below ("OWNER DECISION
ROUND (post-F-round, session of 2026-07-27...)"): the enumeration
draft shipped and was RATIFIED (DC-1 DISCHARGED); the purge-exception
draft is DEFERRED by owner instruction (deferral is not approval);
DC-2 was drafted with owner review open. Read no current status from
this record.]

R12 VERDICT RECORD (REV 49): cycle 64 (final closure verification,
rev 48): CLEAN 0/0/0 within scope — cycle-63 contradictions resolved;
R12 FINAL block verified against raw cycles 57-63 outputs (finding
counts supported, no over-claims); ruling + action-item
registrations PASS; boundary PASS; suite 89 OK run 1 (F19 flake
tracked, cause still unknown). Auditor's stop position: no genuine
residual class identified; further repetition of the same checks =
diminishing returns. R12 CLOSED at REV 48, verified at REV 49.
ROUND SERIES (R9-R12) ALL CLOSED within verified scopes. Standing
open work (ACTION ITEMS, owner input NOT needed to draft): (i) the
Q-ENUM-a canonical enumeration draft; (ii) the purge-exception
artifact draft, then owner ratification, then the standing
deployment conditions; (iii) DC-1 + DC-2 written. Q-J2-h: deferred
(recorded; DC-2 pending). Pins: unimplemented. Known limits
standing: no whole-ledger sweep, no complete code audit, F19 flake
tracked.
[SNAPSHOT — same supersession as the REV 48 record above (B7-fold,
cycle B7 finding 1): DC-1 shipped+RATIFIED (DISCHARGED), purge draft
DEFERRED by owner instruction, DC-2 drafted with owner review open;
anchor is the OWNER DECISION ROUND entry below.]

R13 — POST-R12 INDEPENDENT REVIEW + FOLD AT REV 50 (auditor GPT
Terra; source: owner asked "audit the changes", orchestrator ran an
independent delta review vs rev44-prefold45.txt; findings then
addressed at rev 50; R13 cycles 65-70 verify):
- Finding 1 (MAJOR SPEC): "4: one sentence" was rendered as a bare
  EXPLICIT owner ruling on the f1 protocol; the substance wording
  originates in the orchestrator's offer. FIX (rev 50): the offer is
  ARCHIVED AS EVIDENCE (~/.tre/audits/r12/action-item-review-offer.
  txt, sha256 recorded at OWNER RULINGS REV-45 header; extracted from
  the session transcript) showing item 4's option text WAS 'f1
  protocol accepted, no auto-demote' with "send the one-liner if you
  agree"; the ruling is restated as CONFIRMATION-VIA-OFFER-ADOPTION
  (wording from the offer, adoption is the owner's act) at all three
  f1 sites; the auto-demote clause is restyled from "DEAD" to
  "condition answered, retained as live provenance".
- Finding 2 (MAJOR SPEC): numbered 1->4 mapping asserted without
  traceable evidence + R12 closure claimed verified-propagation
  beyond what its inputs established. FIX (rev 50): mapping
  evidenced via the archived offer (sections 1=Q-1A-b, 2=Q-ENUM-a,
  3=Q-J2-h, 4=f1); R12 closure annotated — verified-scope applies to
  FOLD MECHANICS vs supplied inputs; attribution upgrade arrives
  with R13.
- Finding 3 (MINOR SPEC): DC-1 parallel-commitment timing asserted;
  FIX (rev 50): labeled as a LEDGER INTERPRETATION of the owner's
  "doesn't gate (with proper documentation...)" words.
- Finding 4 (MINOR SPEC): stale current-tense statuses (recap
  "gated on Q-1A-b"; tally "remains unruled"). FIX (rev 50): both
  sites carry historical/RULED pointers.
- CLASSIFICATION [REV-51, cycle-67 fix]: the raw independent review
  reported FIVE findings (three major: f1 attribution / mapping /
  closure-overreach; two minor: stale statuses / documentation
  timing). The REV-50 fold GROUPED raw 2+3 into one cluster and
  renumbered the minors as "4 findings" — that count was the FOLD's
  clustering, never the reviewer's classification; raw-to-cluster
  mapping: cluster A=raw 1, cluster B=raw 2+3, cluster C=raw 5
  (timing, folded as "finding 3"), cluster D=raw 4 (stale statuses,
  folded as "finding 4"). All five raw findings are SPEC (ledger
  record fidelity), 0 CODE. None closable by a further owner spec
  change beyond rulings already given — these are record-fidelity
  corrections. Action items unchanged (enumeration draft,
  purge-exception draft, DC-1, DC-2).
[SNAPSHOT (C1-fold, cycle C1 finding 1): superseded by the OWNER
DECISION ROUND entry below ("OWNER DECISION ROUND (post-F-round,
session of 2026-07-27...)") — enumeration shipped+RATIFIED (DC-1
DISCHARGED), purge draft DEFERRED by owner instruction, DC-2 drafted
with owner review open.]

R13 CLOSURE AT REV 51 (cycles 65-70; GPT Terra):
- Cycle 65 PASS: rev-50 boundary exact; archived offer hash matches
  ledger; offer sections confirmed 1=Q-1A-b/2=Q-ENUM-a/3=Q-J2-h/
  4=f1; item 4 text contains the one-liner and "if you agree with
  the interpretation"; suite 89 OK.
- Cycle 66 (1 SPEC): REV-50 still said the owner "chose to send"
  the offered sentence — the literal reply is the abbreviation
  "4: one sentence"; adoption must be a LABORED INFERENCE; also
  "condition answered" imprecise (confirmation is not a definition
  of the four protocol elements and cannot preclude a later
  decline). FOLD (rev 51): all four f1 sites restated as labeled
  reading; auto-demote clause live-with-open-condition.
- Cycle 67 (1 SPEC): R13 block claimed "4 findings" as the
  reviewer's classification; raw review has FIVE (3 major + 2
  minor); fold clusters must be mapped not renumbered. FOLD (rev
  51): raw-to-cluster mapping recorded; R12 annotation count fixed.
  Also PASSes: DC-1 label, stale-status tags, ruling-authority
  distinction justified (items 1-3 replies select substance;
  item 4's does not repeat it — the attribution split is sound).
- Cycle 68 VERDICT INCONCLUSIVE (raw out-c68.txt), recorded
  honestly at cycle-71 finding 1 fix: its INDIVIDUAL checks passed
  in scope (no CODE finding — purge absent, no f1-status claims in
  code; suite 1 fail F19-flake then 89 OK) but the cycle expressly
  declined whole-ledger certification. Earlier wording here said
  "PASS scoped" — that overstated the cycle verdict; corrected.
- Cycle 69: R13 not closeable at REV 50 (66/67 findings open);
  recommends FOUR-TIER ANCHOR — FOLD (rev 51) as standing text
  under OWNER RULINGS: (a) direct owner words on substance
  (items 1-3), (b) owner's abbreviated reply read as selecting an
  offered act, wording from the offer (item 4/f1 — interpretation
  labeled), (c) ledger-derived application of a general ruling to
  specific deltas (N1-N6/1A), (d) ledger interpretation of
  ambiguous phrasing (DC-1 timing). Future attributions must name
  their tier.
- Cycle 70 (run PRE-fold, against rev 50): NOT CLOSED at that
  point — confirmed cycles 66/67 findings unfolded in the rev-50
  baseline; listed evidence hashes for future auditors (offer
  sha256 1fffde...c432; the ledger hash it quoted,
  65d18d...4b0a, is the PRE-rev-51 ledger). The rev-51 fold then
  applied both fixes; POST-fold verification is cycle 71 below —
  this line itself was initially miswritten as verifying rev-51
  sites and corrected same-rev (the record notes its own
  miswrite: attribution discipline applies to the orchestrator
  too).
- R13 CLOSED WITHIN SCOPE at rev 51: five raw SPEC findings folded
  (raw-independent 3 + c66 + c67; clusters A-D), 0 CODE; the f1
  acceptance stands as a TIER-(b) LABORED READING usable as ruling
  of record, repudiable by fresh owner statement; action items
  unchanged (enumeration draft, purge-exception draft, DC-1, DC-2);
[SNAPSHOT (C1-fold, cycle C1 finding 2a): superseded by the OWNER
DECISION ROUND entry below ("OWNER DECISION ROUND (post-F-round,
session of 2026-07-27...)") — enumeration shipped+RATIFIED (DC-1
DISCHARGED), purge draft DEFERRED by owner instruction, DC-2 drafted
with owner review open.]
  non-claims preserved (no whole-ledger sweep, no complete code
  audit, pins unimplemented, F19 flake tracked). Further rounds on
  the attribution class are past diminishing returns; the standing
  four-tier anchor is the durable artifact.
- Cycle 71 (post-rev-51-fold verification; raw out-c71.txt):
  VERDICT CHANGES REQUIRED — 2 new SPEC findings, both against the
  closure BLOCK's wording, 0 substantive: (1) it recorded cycle 68
  as "PASS scoped" vs raw INCONCLUSIVE [fixed above]; (2) it
  forward-referenced a "R13 CLOSURE ADDENDUM" that did not yet
  exist — the exact forward-reference class this ledger's own
  closure pattern forbids; the orchestrator wrote a verification
  claim before the verification ran [fixed: addendum below now
  records actual results; forward reference replaced]. ALL
  substantive rev-51 corrections PASSED cycle 71's fresh checks:
  boundary PASS; four f1 sites labeled-reading, "chose to send"
  gone; five-raw-finding mapping + R12 count PASS; four-tier anchor
  PASS vs principal sites; honesty entry PASS; suite 89 OK.

R13 CLOSURE ADDENDUM — REV 52 (written AFTER cycle 71 ran, per
cycle-71 finding 2; this is now the ledger's forward-reference
discipline applied to itself):
- Cycle 71 findings 1-2 folded at rev 52 (cycle-68 verdict line
  restated INCONCLUSIVE-with-scoped-passes; forward reference
  replaced by this existing addendum).
- FINAL R13 STATUS: CLOSED WITHIN SCOPE at rev 52. Seven raw
  finding clusters total: raw-independent 5 (folded rev 50/51),
  c66 f1-label (folded 51), c67 count (folded 51), c71 closure-
  block-2 (folded 52) — ALL SPEC, 0 CODE. Every substantive
  correction verified fresh by the next cycle post-fold (c71
  verified rev-51; this addendum's sites are verified by cycle 72
  ONLY IF RUN — not claimed here).
- TERMINATION: c71's findings were purely about closure-narrative
  wording while all substantive sites passed; one more full round
  would be mining the narrative of a round whose substance passed.
  R13 terminates. Standing durable artifacts: FOUR-TIER ATTRIBUTION
  ANCHOR (rev 51), archived offer evidence (sha256
  1fffde...c432), per-rev snapshots rev44/48/49/50/51 +
  prefolds. Action items unchanged: enumeration draft,
  purge-exception draft, DC-1, DC-2; Q-J2-h deferred. Non-claims
  preserved: no whole-ledger sweep, no complete code audit, pins
  unimplemented, F19 flake tracked-unexplained.
[SNAPSHOT (C1-fold, cycle C1 finding 2b — a TERMINATION conclusion,
hence annotated explicitly): superseded by the OWNER DECISION ROUND
entry below ("OWNER DECISION ROUND (post-F-round, session of
2026-07-27...)") — enumeration shipped+RATIFIED (DC-1 DISCHARGED),
purge draft DEFERRED by owner instruction, DC-2 drafted with owner
review open.]


DC-1 STATUS ENTRY (appended; work item, not a finding): CANONICAL
REFUSAL ENUMERATION — DRAFT DELIVERED, AWAITING OWNER READ.
[SUPERSEDED FOR STATUS by the OWNER DECISION ROUND entry below
(2026-07-27): DC-1 read and RATIFIED as written, DISCHARGED; the
purge draft below "STILL PENDING" is now DEFERRED by owner
instruction; the DC-2 block "STILL PENDING" is now commissioned and
written with owner review open; the F19 flake "tracked-unexplained"
is RESOLVED (root-cause bracket above). This entry is preserved as
delivery-era history — read no status from it (A6-fold, cycle A6
finding 1).]
- Artifact: `docs/21a-refusal-enumeration.md` ("Canonical refusal
  enumeration — P9-M3"), drafted against the rev-52 body (S-J2-R v10
  + S-A1-R v7 as ratified REV 36, rulings REV 36 + REV-45). It IS the
  DC-1 deliverable's enumeration draft; the DC-1 commitment block
  above stands verbatim (non-gating per the REV-45 ruling; no
  release-doc deadline asserted — none is owner-authorized).
- Method (recorded so the next sweep can repeat it): the artifact's
  backticked token set was diffed BOTH directions against the full
  ledger text — every code it cites must exist in the ledger, and the
  auditor's cycle-17 mechanical corpus (~/.tre/audits/sj2r/c17/
  codes-sJ2.txt / codes-sA1.txt, 84 unique tokens) was used as the
  reverse-direction checklist; unmapped tokens are listed explicitly
  in the artifact's §7 as non-refusal nouns/pin-names. Both directions
  CLEAN at submission.
- HONEST ACCOUNTING (the ledger's own discipline applied to this
  draft): DRAFT 1 (earlier same day) was rejected by its own audit
  pass — it invented 13 code names not present anywhere in this
  ledger (a wire-regex intake family, a journal-line-size oversize
  family, and a rotate/purge staging family) and cited NUMERIC pin
  numbers where every real pin is NAMED (grep -c 'pin [0-9]+' = 0);
  it also mis-signed the 64 KiB cap onto the live-journal line size
  instead of the carry sidecar. Draft 1 was replaced in full; the
  surviving artifact contains no draft-1 content. Class note: this is
  the invented-path defect class this ledger's audit rounds exist to
  catch, produced by drafting from memory instead of corpus-diffing
  first — stated so the enumeration's reader can weight the memory
  hazard accordingly.
- STATUS OF THE DC-1 / REV-45 HANDOFF ITEMS after this delivery:
  (1) enumeration draft — DELIVERED here, owner read outstanding;
  (2) purge-exception draft (N7 "own ratified exception required",
  Q-1A-b) — STILL PENDING (not attempted here; purge deployment
  remains blocked on it); (3) DC-2 block (T4-gap acknowledged-gap
  text) — STILL PENDING; (4) Q-J2-h — remains DEFERRED; this artifact
  deliberately does not draft it (naming is not drafting).
- NON-CLAIMS (preserved from the artifact): no whole-ledger sweep was
  performed here; this is a targeted corpus-diffed enumeration, not a
  re-verification of rounds R1-R13; pins remain unimplemented; F19
  flake remains tracked-unexplained.

E-ROUND RESULT APPENDIX (appended to the DC-1 status entry; work
item bookkeeping, not a finding): FOUR-CYCLE ADVERSARIAL AUDIT OF THE
ENUMERATION ARTIFACT, GPT-6.1-terra auditor, query-driven per the
structural-limitation rule. Verdict trajectory: E1 CHANGES-REQUIRED
8 findings (2 BLOCKER, 5 MAJOR, 1 MINOR); E2 3 (0B); E3 2 (0B);
E4 1 (0B); post-fold verifications E4b (1 literal MINOR: mechanical
corpus flagged two DECLARED-REFERENCE tokens) and E4c: ROUND CLOSED,
VERDICT CLEAN — reverse corpus 15/15 ledger-absent tokens all
declared (14 draft-1 coinages incl. --allow-oversize + the source
filename). ATTRIBUTION (per the saved reports): E4c ran FOLDS +
REVERSE CORPUS ONLY; the forward corpus (no unmapped ledger refusal
code) was verified at E2/E3; the 25+ citation-window sampling
applies to the MAIN cycles E1-E4, not the post-fold checks E4b/E4c.
High-risk semantic set (attest-failed vs oversize scopes, T4+R-c,
purge step (5), damage g2, AUTH cap precedence + pre-rename zero-
claim, carry-sidecar cap) PASS from E1 onward; the N7 gate chain was
NOT — it was E4's MAJOR (NECESSARY-NOT-SUFFICIENT, REV-46/cycle-
57f1), folded before closure.
BLOCKERS FOLDED (substance): (1) AUTH archive target-exists refusal
path enumerated WITHOUT a code (ledger refuses it unnamed ~3260;
code deliberately not invented); (2) journal-rotation-incomplete
split into its TWO triggers (rotation COMMAND refusal journal-
present+sidecar-invalid ~351-357 vs reader R4/N1; recovery routes
differ — rebuild vs rotation-reentry ~1866-1869). MAJORs folded:
journal-full trigger = the WRITER, the full predicate is the
CONSERVATIVE-MIRROR with named divergence residual; rotation-attest-
torn-tail-refuses reclassified PIN-vs-CODE (channel = carries-
rebuild-attestation-gap); purge-log-failed blanket zero-claim
removed (torn-tail-possible); 0.1 entry-fsync scoped to the I/O
FAULT CONTRACT command classes; purge-attest-log-refused trigger
= shared parser over the WHOLE log (torn tail OR framing break OR
ANY parse failure); purge 4b = a purge-io REPORT with marker-
OBSERVATION (NAMESPACE-VISIBLE/DURABILITY-PENDING, REV 15), not
observation-only; N7 exception artifact = NECESSARY-NOT-SUFFICIENT
gates (REV-46/cycle-57f1); three line-cite corrections (e1 4868,
g2 4878, auth-recover-io 3058) + shipped-classification evidence
restated. Snapshots: ~/.tre/audits/enum/baseline-E1.txt +
postfold-E1..E4c.txt; prompts/logs ~/.tre/audits/enum-*.
Residual coverage limit (auditor-disclosed every cycle): query-
driven, not a serial full-ledger audit; the artifact makes no such
claim. Artifact status: CLEAN pending owner read; DC-1 enumeration
deliverable stands. [SNAPSHOT — this round-result conclusion predates
the OWNER DECISION ROUND entry below ("OWNER DECISION ROUND (post-F-
round, session of 2026-07-27...)"): the owner READ and RATIFIED the
artifact as written; DC-1 is DISCHARGED. Read no status from this
line (B6-fold, cycle B6 finding 1).]

F-ROUND RESULT APPENDIX (appended to the DC-1 status entry; work
item bookkeeping, not a finding): SEVEN-CYCLE ADVERSARIAL AUDIT OF
THE FIVE-CHANGE OWNER REVIEW (the A1-A5 folds), GPT-6.1-terra
auditor, query-driven per the structural-limitation rule. INPUT: an
owner-directed review of the E-closed artifact raised five findings
(A1 attest-failed recovery dead end; A2 T5/T4-qualifier omission;
A3 per-cycle check attribution overstated; A4 rotation-table row
shape + broken cross-refs; A5 ledger-appendix overstatements), all
folded BEFORE F1 (snapshot baseline-F0.txt). Verdict trajectory: F1
CHANGES-REQUIRED 2 BLOCKER (empty-log branch overextended append-
idempotence; already-attested branch promised re-invocation the PRE-
RENAME T4 gate refuses — R-c); F2 1 BLOCKER (the A1 FOLD itself
introduced an undeclared backticked audit-report path token — the
round's own defect class, caught by its own sweep); F3 1 MAJOR
(empty-log branch ignored T1/T3: empty log with archives PRESENT
gate-refuses before the writer runs); F4 1 MAJOR (published-archive
branch cited the wrong pin — rotation-retry-hwm-idempotent is the
parser+writer UNIT TEST for the torn-append/pre-T4 case, "not an E2E
rotation (E2E the state refuses — R-c)"; completion route is pin
rotation-completion-current-sidecar-proceeds); F5 CLEAN (0); F6
CLEAN (0, 55 citation windows); F7 CLOSURE: regression sweep of all
F-round edits PASS, reverse corpus ZERO undeclared ledger-absent
tokens, forward corpus (c17 lists + fresh S-A1-R) no unmapped
refusal code, 62 table rows + all internal refs clean. ROUND CLOSED,
VERDICT CLEAN. NET SUBSTANCE: the attest-failed recovery cell is now
a FOUR-BRANCH decision (empty→gate-conditional re-append; attested+
archive-present→idempotent completion via reentry; attested+archive
LOST→T4 deadlock, restore-only R-c; torn tail→parser refusal,
restore R-1) — the E round's single-branch "re-invoke" was the
dead end the owner review named. POST-CLOSURE HONESTY NOTE (the
A3 discipline applied to this appendix): the artifact's §7 F-register
paragraph and the §7 AUDIT-ARTIFACT PATH CLASS declaration (prefix-
declared, covering the report paths the register cites) were written
AFTER F7's verdict and are verified by the local mechanical sweep
(14 absent, all declared; table/refs clean), NOT by the auditor —
same class-of-scope statement that F1-F4 exist to enforce. Artifact
status: CLEAN pending owner read; DC-1 enumeration deliverable
stands. [SNAPSHOT — same supersession as the E-round line above: the
OWNER DECISION ROUND entry below ("OWNER DECISION ROUND (post-F-
round, session of 2026-07-27...)") records the owner read +
ratification; DC-1 DISCHARGED (B6-fold, cycle B6 finding 1).] Residual coverage
limit (auditor-disclosed every cycle):
query-driven, not a serial full-ledger audit.

OWNER DECISION ROUND (post-F-round, session of 2026-07-27 — direct owner
instructions, no offer intermediary this time):
1. DC-1 (refusal enumeration): RATIFIED. Owner read the CLEAN artifact
   (docs/21a-refusal-enumeration.md, 457 lines, E round 4 cycles + F
   round 7 cycles both CLOSED CLEAN) and ratified as written. No
   change-requests. DC-1 COMMITMENT: DISCHARGED.
2. Purge-exception draft (Q-1A-b / N7): DEFERRED BY OWNER INSTRUCTION
   ("let's actually defer the purge exception draft - close all the
   easy items first"). This SUPERSEDES the earlier "commission the
   draft" instruction issued minutes earlier in the same exchange
   (both owner, same session; later instruction wins; registered as
   an owner DEFERRAL, not scope drift). Purge deployment remains
   blocked exactly as before: exception artifact not drafted, not
   ratified; gate chain (draft -> owner ratification -> full standing
   deployment conditions) unchanged and un-exercised. DEFERRAL IS NOT
   APPROVAL - nothing about purge moved.
3. DC-2 (T4-gap acknowledged-gap block): COMMISSIONED by owner, draft
   delivered same session (see the DC-2 BLOCK appended below); owner
   review of the text remains open.
4. Q-J2-h: DEFERRAL RE-CONFIRMED by owner (third time: REV 36
   original, REV 45 re-affirmed, now). No protocol exit designed;
   out-of-band whole-dir restore remains the answer of record.
5. f1 attribution: DEFERRAL CONFIRMED - owner declines the literal
   one-liner; the labeled-interpretation ruling of record ("f1
   protocol accepted, no auto-demote" via adopted-offer confirmation)
   stands as-is, with the standing re-take option intact.
DC-1 RATIFIES THE ARTIFACT ONLY: the F-round honesty note (register-
paragraph and path-class declaration postdate F7's verdict, verified
by mechanical sweep not the auditor) was part of the ratified text -
ratification adopts the artifact WITH that disclosure, adding no new
auditor coverage claim.

DC-2 BLOCK (T4-gap acknowledged-gap deliverable — drafted same session
per owner commission; self-contained text, owner review open):
[STATUS 2026-11-16: owner review CLOSED — the block is RATIFIED AS
WRITTEN (owner: "part 2 - ratify"; FOURTH TRANCHE record in docs/21).
The T4-gap is a PERMANENT accepted gap in v1; whole-dir restore (R-1)
is the answer of record; NO in-protocol completion mechanism is
commissioned. The Q-J2-h deferral is now the owner's own recorded
position (the block's "third affirmation" counts the
pre-ratification deferral events; the ratification is the fourth
affirmation and this annotation is its registration here).]

ACKNOWLEDGED GAP: T4-GAP COMPLETION MECHANISM DEFERRED
- A T4-gap entry (re-entry where the pre-rename view finds the
  published id already attested but the archive is ABSENT) refuses:
  T4's pre-rename exclusion applies to EVERY re-entry attempt
  regardless of log state; the R-c contradiction (attest says done,
  rename says not) has no in-protocol resolution (see the ratified
  refusal enumeration, docs/21a-refusal-enumeration.md §1 index,
  journal-rotate-attest-failed recovery cell, branch (iii)).
- The ONLY spec'd route out is WHOLE-DIR RESTORE (R-1: restore the
  entire journal dir from the last known-good backup). There is NO
  defined COMPLETION MECHANISM that turns a restored dir into a clean
  lineage short of that out-of-band restore.
- The owner has DEFERRED defining one (Q-J2-h: REV 36 original;
  RE-AFFIRMED REV 45 with this documentation requirement; DEFERRAL
  RE-CONFIRMED this session — third affirmation). Operators treat
  this as a DELIBERATE ACCEPTED GAP: out-of-band manual intervention
  is the answer of record.
- Implementation must NOT assume any future ruling adds an
  in-protocol completion path; no design work is commissioned.
- PROVENANCE OF EVERY ASSERTION IN THIS BLOCK: the refusal + whole-dir
  restore route and the gap statement itself are the ledger's DC-2
  registration text (the REV-45 DOCUMENTATION COMMITMENTS block,
  verbatim in force); the R-c cell + enumeration cross-reference are
  the RATIFIED DC-1 artifact's §1 recovery-cell branch (iii)
  (`journal-rotate-attest-failed`: attested-but-unpublished ⇒ pre-
  rename T4 gate refuses, NO in-protocol completion) and its §2 R-c
  residual discussion (audited CLEAN two rounds; A3-fold correction —
  the pointer formerly read "§8", a section that does not exist in
  the artifact);
  reconfirmed deferral is this session's owner-decision-round entry
  above. The only phrase not appearing verbatim in the ledger is
  "third affirmation" — a count of the deferral events recorded
  here, not a new fact.

---

A-ROUND APPENDIX (post-DC-1; 7-cycle adversarial audit of commit
1425a69 + folds, gpt-6.1-terra, owner instruction "audit the changes
using gpt terra, implement the findings, run 7 cycles; spec-change
findings register as deferred items"):
- Subject: the cumulative change set 1425a69 (DC-1 artifact + ledger
  round + F19 test-side fix + C1-F7 hardening + repo docs) plus its
  in-round fold commits, audited commit-vs-specs (docs/21 S-J2-R/
  S-A1-R, this ledger, runner contract, artifact header). SCOPE
  QUALIFICATION (B2-fold, cycle B2 finding 2): "audited" means the
  cycles' query-driven verification of extracted claims — NOT a
  complete line-by-line audit of the added reference implementation
  or all registrations; A4's own report says so explicitly ("a
  bounded review, not a complete audit"), A2 likewise disclosed its
  requested full diff / staleness sweep were not completed, and A7b
  its coverage limits (below). Anywhere this appendix or the F19
  bracket says the A round "is its scoped audit", read it with this
  qualification.
- Cycles: A1 CHANGES REQUESTED (4 MAJOR + 1 MINOR, all CODEFIX-ABLE);
  A2 CHANGES REQUESTED (3 MAJOR against the COMMITTED tree — the same
  three sites A1 folded; the report itself notes the working tree
  already carried the corrections, so no new fold was needed) (B0-fold
  correction: this line formerly read "CONFIRMING-with-dups", which
  misrecorded the saved report's explicit verdict — audit finding 1);
  A3 CHANGES REQUESTED (2
  MAJOR: DC-2 provenance pointed at a nonexistent artifact "§8"; the
  REV-46 current-work list lacked a supersession pointer); A4
  CONFIRMING (0 findings); A5 CONFIRMING (0 findings); A6 CHANGES
  REQUESTED (1 MAJOR: delivery-era DC-1 status entry needed a
  supersession annotation); A7 hung on the endpoint mid-experiment
  (restart, disclosed); A7b CONFIRMING (0 findings). Fold commits:
  5b0f8a8 (A1/A2), 0733023 (A3), 0a04c4f (A6), plus this appendix.
- Findings folded, all registration/test-side precision — NO spec
  change and NO production-behavior change in any fold: (1) "probe.py
  and ledger.py UNTOUCHED" qualified (commit-relative vs pre-fix-
  working-state) + audit-surface disclosure that 1425a69 ADDS the
  reference implementation and the E/F rounds audited the artifact,
  this A round is the scoped commit audit; (2) F19 leg-4 root cause
  restated precisely: baseline/census RACE under overlapping probes
  (sibling names created after baseline and still visible at census),
  not unconditional "fails by construction"; the 3168/3200 vs 0/3000
  numbers relabeled as observed runs (auditors could not reproduce
  the exact counts; mechanism confirmed by SOURCE REVIEW in the
  completed cycles A2-A7b — stalled A7 excluded (B5-fold, cycle B5
  finding 1): its transcript ends at the invocation of its probe
  experiment with no recorded result; the A7 hang is recorded in the
  Cycles line above ("A7 hung on the endpoint mid-experiment (restart,
  disclosed)"); the one EXPERIMENTAL confirmation-in-kind is A5's
  scratch run (320/320 leg-4 failures at 8 concurrent threads, 0/100
  serial — in kind, not the historical 8x400 count) — the other
  completed cycles confirmed by source reading only; A2 and A7b
  expressly disclaimed completing independent probe experiments
  (C2-fold, cycle C2 finding 2).
  (3) C1-F7 sweep now accepts ONLY ESRCH as group-death proof (other
  errno throws; timeout message states the observation, not a
  diagnosis) — per the runner contract EPERM/other = unknown, never
  "gone"; (4) .tre/remaining-items-review.md got a HISTORICAL-SNAPSHOT
  banner (its "docs/21 stands at v4" text is 2026-11-13 history, not
  current state — anchors: this ledger's decision round + the
  ratified artifact); (5) .gitignore scratch-rule comment corrected
  (fallback-CWD rationale; the fixtures' own prefix is p9m3-* under
  the system temp dir); (6) DC-2 provenance "§8" -> real §1
  recovery-cell branch (iii) + §2 R-c residual; (7) supersession
  pointers on the two stale current-status surfaces (REV-46 work
  list, delivery-era DC-1 status entry).
- DECISIONS-REQUIRED across all 7 cycles: 0. Every finding was fixable
  without owner ratification; NO new deferred items arise from this
  round. Deferred backlog UNCHANGED (purge-exception draft, Q-J2-h
  protocol exit, f1 attribution — all owner-direction, untouched).
- Verification: per saved reports, the Python suite (89/89) and the
  attempt-runner suite (86/86, dist build) were both run
  independently by auditors A1, A3, A5, A6, A7b; A2 and A4 did NOT
  run the suites (A2 disclosed them among its limitations; A4 said
  so explicitly) (B0-fold correction: this line formerly claimed
  89/89 "by A4-A7b auditors" — audit finding 2). Precision on the
  C1-F7 hardening (B2-fold, cycle B2 finding 1): the ESRCH-only
  sweep landed IN the A round at 5b0f8a8, so A1's run predates the
  hardened assertion (it ran, and passed, the pre-fix version whose
  error-classification it flagged); the post-hardening runs are
  A3's, A5's, A6's and A7b's (for the harness gate at the folds,
  see the gate & tree-clean evidence-status paragraph below —
  C2-fold cycle C2 finding 1, sharpened by the D0-fold of the
  post-C audit finding 1).
  B3-fold, cycle B3 finding 1: the stalled A7 transcript also
  records a post-hardening Python suite pass "Ran 89 tests … OK",
  and a Node invocation whose saved output is truncated before any
  final count — recorded, not verified; A7 gains no audit verdict
  from it.
  Gate & tree-clean evidence status (D0-fold, post-C audit finding
  1 — this REPLACES the former categorical claims "ran green at each
  fold", "re-verified on the final committed tree at the A round's
  close", and "tree clean at each fold", which were orchestrator
  session-memory assertions, not established evidence): The commit
  harness is configured to run the gate before staging and refuse
  the commit on failure (tool design, asserted here). Contemporaneous
  per-commit evidence in the saved orchestrator session log
  (tre-20261113-110312-29516.jsonl) exists for TWO fold commits
  only — e2e295c (B3, log line 12318: "git-commit: gate passed"
  with "# pass 2755 / # fail 0 / # skipped 14" in the same record;
  the "# tests 2769" total is NOT in that record — D1-fold
  correction) and a097555 (C1, line 12446: gate passed with the
  full count set incl. "# tests 2769"). For the remaining fold
  commits, in two groups (E-fold correction of this paragraph's
  earlier self-contradiction, E-cycle finding 2): twelve with
  located commit tool-result records carrying the "OK — committed"
  line but NOT the accompanying gate verdict (1425a69, 5b0f8a8,
  0733023, 0a04c4f, b339426, b17392e, 29339f7, 72cc30f, 760c0a3,
  e519873, 28073e9, 3fe3813); and two for which no contemporaneous
  commit tool-result was located in the session logs searched
  (81a36c9, 1dc5d29 — E-fold correction: these two therefore do
  NOT belong in the "retained logs carry the OK — committed line"
  group; earlier
  matches for those hashes exist BELOW the D0 forensics region but
  are narrative/git-log references, not commit tool-results (e.g.
  a commit-list tool result at log line 12382 / 12472), and the
  later matches are this D session's own forensic echoes, neither
  of which evidences the original commit's gate run — D1-fold
  correction of the looser D0 wording "the only matches postdate
  this fold"). Accordingly "the gate ran
  green at each fold" and "git tree clean at each fold" are recorded
  here as UNVERIFIED historical assertions — plausible from the
  tool's configured behavior, but not evidenced per-run. Clean-start
  corroboration that does exist: the saved B5, B6 and B7 reports
  each opened with a clean git status, and B4's own report
  discloses its dirty-tree start (see process note below). The
  "re-verified on the final committed tree at the A round's close"
  run could not be identified in the retained logs and is likewise
  UNVERIFIED; the separately retained one-run summary
  gate-postC0.txt (described in the post-B note below) concerns
  tree e519873 plus uncommitted doc edits and establishes nothing
  about the other fold commits. Going forward (from this D0 fold):
  each fold commit's gate output is retained to a per-fold file
  under ~/.tre/audits/ before committing, so fold-commit gate
  evidence no longer relies on assertion. BLANKET QUALIFICATION
  RULE (D0): any gate/test/clean-tree/confirmation claim in this
  ledger is to be read as an orchestrator assertion — NOT as
  retained proof — unless it names identifiable retained evidence
  (a saved output file under ~/.tre/audits/, or a tool-result
  record in a saved session log). The per-cycle "suite 89 OK"
  entries of the R6-R13 rounds are in-run observations recorded
  contemporaneously in those rounds' session logs (p9m3-*,
  sj2r-* files under ~/.tre/audits/) and are qualified by this
  rule to the same extent: they are logs of what the harness
  reported at the time, not independently re-verifiable now.
- Residual audit limitations, stated honestly: no auditor
  independently reproduced the exact F19 race counts (mechanism and
  qualitative direction confirmed by source reading in multiple
  cycles); owner-transcript fidelity (ratification wording, deferral
  counts) is verifiable only against this ledger's own record; the
  bounded-coverage limits the auditors themselves declared — A4's
  "not a complete audit of the newly added reference implementation
  or all ledger registrations" and its skipped suites, A2's limits
  (full diff, staleness sweep, suites not run — recorded here at
  B0+/B2+ and in A2's own report under "Audit limitations"; the
  phrase "undisclosed-to-appendix" described the appendix only
  BEFORE those folds and is itself retired — B5-fold, cycle B5
  finding 2), and A7's endpoint hang (restart, disclosed) mean
  cycle-7 evidence is A7b's bounded CONFIRMING pass.
  Further, per A7b's own saved report (B1-fold, cycle B1 finding 2):
  A7b did NOT complete the requested independent probe experiment,
  the full targeted ledger/artifact staleness and attribution sweep,
  secret-content inspection, or full change-surface review, and its
  passing-test runs do not substitute for those checks — its
  CONFIRMING verdict covers the claims it examined, not the whole
  requested surface.

B-ROUND RESULT APPENDIX (7 cycles on the CUMULATIVE change set
1425a69..HEAD — the A round's own appendix and the B0 corrections are
themselves the primary audit subject; gpt-6.1-terra; saved reports
~/.tre/audits/commitB-B1..B7-out.txt; owner instruction of 2026-07-27
"address the findings, terra is the auditor, run 7 cycles"):
- Verdicts: B1 CHANGES REQUESTED (2 MAJOR); B2 CHANGES REQUESTED (2
  MAJOR); B3 CHANGES REQUESTED (1 MINOR); B4 CHANGES REQUESTED (1
  MAJOR — duplicate of the B3 fold, see process note); B5 CHANGES
  REQUESTED (1 MAJOR + 1 MINOR); B6 CHANGES REQUESTED (1 MAJOR); B7
  CHANGES REQUESTED (1 MAJOR + 1 MINOR). DECISIONS-REQUIRED: 0 in
  every cycle — no finding required normative-text change; nothing
  new to defer beyond the existing owner-deferred backlog.
- Distinct findings folded: (1) remaining-items-review.md's
  standalone "Recommended next step" pushed a superseded v4-era gate
  with no historical banner — banner added; (2) the A-round appendix
  omitted A7b's declared coverage limits — recorded; (3) appendix
  attributed hardened-C1-F7 runs to A1, whose run predated the
  hardening — corrected (post-fix runs A3/A5/A6/A7b + gate); (4)
  round-level "audited" scope was unqualified — bounded-review
  qualification added naming A4's/A2's declared limits; (5) stalled
  A7's post-hardening Python pass unrecorded — added (Node run
  recorded-not-verified, output truncated); (6) F19 mechanism
  confirmation attributed "in A2-A7b" including stalled A7 —
  completed-cycles-only attribution with explicit A7 exclusion; (7)
  "undisclosed-to-appendix" phrase contradicted the appendix's own
  (folded) disclosure — retired as historical phrasing; (8) E- and
  F-round appendices' "CLEAN pending owner read" conclusions lacked
  SNAPSHOT supersession annotations — added (anchored by text, not
  line numbers, per this ledger's convention); (9) R12 REV 48/49
  "Standing open work" conclusions lacked SNAPSHOT annotations —
  added; (10) A7 cross-reference pointed at A2's text by line number
  — re-anchored by name. Fold commits: b17392e (B1), 29339f7 (B2),
  e2e295c (B3), 72cc30f (B5), 760c0a3 (B6); the B7 folds accompany
  this appendix.
- Process disclosure: B4 started BEFORE the B3 fold landed (ordering
  mistake — it audited a tree without the B3 annotation), reported
  the B3 fix as missing (its one MAJOR is that duplicate), and
  disclosed the dirty-tree precondition violation in its own report;
  B5-B7 all started clean. Convergence trend: findings per cycle
  2/2/1/1/2/1/2 — the B round found NO repeat of an unfixed A
  finding and NO code-behavior finding; every B finding was an
  audit-record precision or stale-status-annotation issue,
  consistent with the A round's conclusion that the code and
  registrations themselves stand. Convergence to 0 was NOT
  demonstrated at B7 — findings were still arriving, all of the
  same annotation/precision class; whether further rounds are worth
  running is a diminishing-returns judgment (this ledger's own R12
  language) disclosed to the owner.
- Residual limitations (auditor-disclosed per cycle, B1-B7): all
  cycles query-driven targeted reviews, not serial full-ledger/
  full-implementation audits; suites were run by B1 (89+86) and B2
  (89+86); B4 did NOT run suites — its report discusses the STALLED
  A7 transcript's recorded Python 89 pass (attributing that pass to
  B4 was an error; corrected per post-B audit finding 1); B3/B5/B6/B7
  did not run suites; no cycle independently reproduced the F19 race
  counts; secret scanning was path/filename-level; pre-ratification
  artifact bytes are not independently establishable from repo
  state. Harness gate: the commit tooling is configured to run the
  gate before each fold commit (harness behavior, asserted here from
  the tool's design — contemporaneous per-run gate evidence was
  retained in the session log only for e2e295c and a097555; for the
  other fold commits it was NOT, C1-fold cycle C1 finding 1, as
  qualified by the D0-fold gate & tree-clean evidence-status
  paragraph above). Beyond those log records, the retained
  gate-output FILES are the single-run summaries
  ~/.tre/audits/gate-postC0.txt and the per-fold
  gate-postD*.txt series. gate-postC0.txt is a SUMMARY
  OF ONE RUN against tree e519873 plus that correcting commit's
  uncommitted doc edits: it records commands and counts (Python
  89/89 OK; npm 2755 pass / 0 fail / 14 skipped; the tsc command is
  listed but its output and exit status are unrecorded — post-C-fold
  correction of finding 3) but
  no per-command exit statuses and no staged-tree hash — counts
  only, not independently verifiable exits, and it evidences only
  that single test, not the per-fold history above.

C-ROUND RESULT APPENDIX (4 cycles on the CUMULATIVE change set
1425a69..HEAD — record-truthfulness round after the post-B audit;
gpt-6.1-terra; saved reports ~/.tre/audits/commitC-C1..C4-out.txt;
owner instruction of 2026-07-28 "address the findings. terra is the
auditor. run 4 cycles"):
- Verdicts: C1 CHANGES REQUESTED (1 MAJOR + 1 MINOR); C2 CHANGES
  REQUESTED (1 MAJOR + 1 MINOR); C3 CONFIRMING (0 findings, bounded
  pass); C4 CONFIRMING (0 findings, bounded pass — its saved report
  verifies the then-existing A/B appendix's characterization of the
  gate file as a single-run summary; the C-round appendix you are
  reading was written AFTER C4, at 1dc5d29, and was NOT itself
  audited by C3 or C4 — post-C-fold correction of finding 2).
  DECISIONS-REQUIRED: 0 in every cycle — no normative or ratified
  text change required; nothing new for the deferred backlog.
- Distinct findings folded: (1) gate-postC0.txt was characterized as
  proving per-fold runs and a staged-tree hash it does not record —
  claim re-scoped to what the file says (one-run summary, counts not
  exits, e519873+uncommitted doc edits); (2) the three R13
  action-item/TERMINATION conclusions lacked SNAPSHOT annotations —
  added (text-anchored); (3) the A appendix's gate claims ("green at
  each fold", "re-verified on final committed tree") were stronger
  than retained evidence — qualified to harness-configured behavior
  with non-retention disclosed; (4) "mechanism confirmed
  independently by A2-A7b" conflated source review with experiment —
  split: source review by completed cycles, A5's scratch run
  (320/320 concurrent / 0/100 serial) as the sole confirmation-in-
  kind, A2/A7b disclaimers recorded. Fold commits: a097555 (C1),
  3fe3813 (C2); C3/C4 needed no folds.
- Convergence: findings per cycle 2/2/0/0 — TWO consecutive bounded
  CONFIRMING passes with zero findings. Both auditors disclosed
  bounded, keyword-driven coverage (not serial exhaustive review);
  "0 findings" means none found in their targeted checks, not
  certification of exhaustive cleanliness. The residual error CLASS
  (record-overstatement/stale-status) has now survived three rounds
  of targeted hunting (post-B, C1, C2 fixes) without producing a
  code-behavior or normative finding in either the B or C round.
- Standing limitations unchanged: owner-conversation fidelity is
  verifiable only against this ledger; pre-ratification artifact
  bytes not externally establishable; suites not run by C auditors
  (C3/C4 expressly; C1 no; C2 no — gate evidence remains
  gate-postC0.txt + the per-fold harness behavior qualification).

D-ROUND RESULT APPENDIX (5 cycles on the CUMULATIVE change set
1425a69..HEAD — record-truthfulness round after the post-C audit;
gpt-6.1-terra; saved reports ~/.tre/audits/commitD-D1..D5-out.txt;
owner instruction of 2026-07-28 "address the findings. terra is the
auditor. run 5 cycles. please do it carefully since the supposed
clear items come up with issues when i run the audit cycle on my
own"):
- Verdicts: D1 CHANGES REQUESTED (1 MAJOR + 2 MINOR); D2 CONFIRMING
  (0 findings, bounded); D3 CONFIRMING (0 findings, bounded); D4
  CONFIRMING (0 findings, bounded); D5 CONFIRMING (0 findings,
  bounded). DECISIONS-REQUIRED: 0 in every cycle.
- What D0 did BEFORE the cycles (fixing the post-C findings): gate &
  tree-clean claims rewritten to evidence status from session-log
  forensics (contemporaneous same-record gate-pass evidence exists
  ONLY for e2e295c and a097555); C4 appendix-credit scoped to the
  then-existing A/B appendix; tsc listed-not-observed corrected;
  BLANKET QUALIFICATION RULE registered; per-fold retained gate
  output began. Per-file, what the retained files establish (E1
  correction; supersedes the E0 wording, which the second audit
  found still overstated): gate-postD0.txt — Python exit captured
  via PIPESTATUS[0] (the Python command's own status), tsc exit
  recorded, npm run piped through tail so its "npm test exit" is
  the TAIL pipeline's status. gate-postD1.txt — Python run piped
  through tail, so "python-suite exit" is the TAIL pipeline's
  status; NO tsc step was run; npm piped through tail (pipeline
  status). gate-postD2.txt — Python piped through tail (pipeline
  status); tsc exit recorded; npm piped through tail (pipeline
  status). The "Ran 89 tests … OK" lines appear in all three
  files; they do not by themselves establish the Python command's
  exit status in D1 or D2.
- Distinct findings folded at D1 (commit 8049271): (1) MAJOR — the
  D0 paragraph attributed the "# tests 2769" total to the e2e295c
  log record; that record carries pass/fail/skipped but not the
  total — now distinguished per record with log line numbers; (2)
  MINOR — "the only matches for 81a36c9/1dc5d29 postdate this fold"
  was wrong: earlier matches exist but are narrative/commit-list
  references, not commit tool-results — reworded; (3) MINOR — the B
  appendix's "per-run evidence was NOT retained / the one retained
  gate output" contradicted the D0 inventory — reconciled (two log
  records + gate-postC0.txt + the gate-postD* file series).
  Fold commit: 8049271 (D1); D2-D5 needed no folds.
- Carefulness measures this round (owner-requested, per the standing
  distrust of "clear" verdicts): clean-tree check before every kick
  (all five started clean — D1 at 0d31d7c, D2-D5 at 8049271); the
  prompt named the orchestrator's own forensic echoes as
  non-evidence and required primary-source verification; each
  finding was independently re-verified against the session log
  (line 12318 lacks "# tests 2769"; line 12446 has it; narrative
  matches at 12382/12472) BEFORE the fold was written.
- Convergence: findings per cycle 3/0/0/0/0 — FOUR consecutive
  bounded CONFIRMING passes with zero findings, and D2-D5 each
  independently re-confirmed the corrected D0/D1 evidence
  inventory from the primary session log (not from the ledger's
  narrative). Note for the owner: D1 caught three residual
  overstatements IN the correction round itself — consistent with
  the pattern that motivated the 5-cycle mandate; convergence
  held only after that correction.
- SCOPE NOTE (E-fold, E-cycle finding 3): D2-D5 audited tree
  8049271 (D0+D1 only). The D-ROUND RESULT APPENDIX itself was
  registered LATER, at 79671ef, and was NOT covered by any
  confirming cycle — the confirmation above does not extend to
  this appendix's own text. A post-D audit (E cycle) found one
  MAJOR in it (the unqualified "per-command exit statuses" claim
  the retained gate files do not support) and two MINORs (this
  appendix's inventory contradiction with the evidence-status
  paragraph; this missing scope note) — all corrected in the E
  fold.
- E0 GATE EVENT (registered, not hidden): the first gate run for
  this fold (gate-postE0.txt, first section) went RED — test 274
  (C1-F7) hit its designed loud-failure path ("operator sweep
  probe returned EPERM — not proof of group death"), 2754 pass /
  1 fail / 14 skipped, npm exit 1. Investigation appended to the
  same file: 5 isolated runs of the test file all green (86 ok /
  0 notok) + 1 full npm rerun green (2755/0/14). E1 correction of
  the counts and cause (E0 wording overstated both): the EPERM
  failure was observed in ONE of the FIVE listed full npm runs
  through the E0 rerun (D0, D1, D2, E0 first run, E0 rerun — only
  E0 first run failed). Later E1 and E2 gate summaries each record
  a further full npm run with zero failures; these are separate
  from that five-run historical window. The five isolated file
  runs are not full-suite runs. Cause: UNDETERMINED —
  the evidence shows one transient failure followed by passing
  reruns and does NOT establish load or environment as the cause.
  The test worked as designed (fail loudly rather than
  silently flake). OWNER DECISION (F2 fold, post-F1 audit): the
  ESRCH-only probe now treats EPERM as RETRYABLE-UNKNOWN — the poll
  loop keeps iterating on EPERM (it proves nothing either way) and
  still confirms only on ESRCH or fails when the poll budget is
  spent (400 attempts with 25ms sleeps — an attempt budget, not a
  wall-clock deadline), with the
  EPERM retry count reported in the failure message; any other
  errno remains a hard failure. The code cannot distinguish a
  transient EPERM from a persistent one: every EPERM is retried
  until ESRCH or the 400-iteration poll budget is spent, and a
  budget-exhausted run fails loudly with the EPERM count. The
  poll discipline is an injectable helper (pollForGroupDeath —
  injected probe/sleep, deterministically tested, test "F2: poll
  discipline"), and C1-F7
  calls that same helper.
  The fold commit below landed only after the green rerun;
  the red run is retained above per the no-hidden-evidence rule.
  E2 correction (exact-tree limitation, second-E audit MINOR): the
  green E0 rerun happened BEFORE the E0 GATE EVENT block above was
  written into this ledger — the retained run evidences the count
  result (2755/0/14) but NO exact E0 pre-commit tree hash was
  recorded and the run did NOT cover the final E0 ledger text.
  The hash-verified staged-tree gate practice begins with the E1
  fold (gate-postE1.txt).
- Residual limitations (auditor-disclosed, D1-D5): all cycles
  targeted/query-driven, not serial exhaustive ledger reviews;
  suites were run by the orchestrator pre-fold (retained in
  gate-postD0/D1/D2.txt; per-file exit status provenance is as
  stated in the D0-fold paragraph above, E1 correction), NOT by the
  D auditors; F19 race
  counts not reproduced; owner-conversation fidelity verifiable
  only against this ledger; pre-1425a69 artifact bytes not
  externally establishable; D2-D5 session-log scans bounded to the
  pre-forensics region as instructed.

---

DECISION-4 PROSE ROUND — SCOPE A (kicked 2026-11-16, owner-authorized
fourth tranche "part 4 - a" + approved sequencing; 5 cycles max;
terra = gpt-6.1-terra, read,bash, read-only repo, experiments in
per-cycle copies under ~/.tre/audits/d4a-x<n>/).

AUTHORITY: reference implementation RUNNING BEHAVIOR = behavior
authority; docs/21 prose = intent authority. Findings classify
CODE/TEST (impl drifted from ratified intent) / DOC (prose
misdescribes code) / SPEC (pooled, owner batch fix only). SCOPE A
STRICTLY: prose describing reference-impl behavior (probe/0A, flock
1A, resolve 2A, DEAD REPAIR 3A disposition, AUTH/REPAIR lifecycle,
rotation S-J2-R, torn-AUTH S-A1-R, cap reserve/commit, F-series
fixture claims). Slice A/B prose (no implementing code) is OUT.

- PIN AT KICK (cycle 1): HEAD 6625d6f (the fourth-tranche fold;
  reference/ UNTOUCHED by it — verified via git show --stat);
  ledger.py db3c289f916b, test_ledger.py 3b238a6536e1; suite 89 OK
  under -W error::ResourceWarning (auditor's own copy d4a-x1).
  Auditor prompt: ~/.tre/audits/d4-scopeA-prompt.txt; outputs
  ~/.tre/audits/d4-scopeA-c<n>-out.txt.
- CYCLE 1 (report: d4-scopeA-c1-out.txt): SELF-DECLARED INCOMPLETE —
  targeted reads only, no exhaustive sweep; findings stand, absence
  of further findings NOT established (per the round's own rule this
  is disclosed, not laundered). 2 findings, both minor DOC, both
  ACCEPTED after source verification:
  | ID | Sev | Class | Finding | Disposition |
  |---|---|---|---|---|
  | D4A-c1-1 | minor | DOC | ledger.py header claimed "F20/F27 use a real SIGKILL" — F20 injects an exception (test's own comment says so); only F27 + the TestV38CyclePins fork+kill -9 case are real kills | header REWRITTEN: real-kill cases named; F20 explicit as simulated; test comment at F20 already correct (verified 882-888) |
  | D4A-c1-2 | minor | DOC | both module headers' fixture inventories stopped at F57 while F58/F59 (S-J3-C clock-clamp + exact-cap reserve) exist and run | both headers UPDATED to F1-F59 (+C6_* noted); verified F58@2065/F59@2096 present in suite |
  Post-fix pins: ledger dee009cbcbda, test_ledger b23bfa6feeae,
  suite 89/89 OK (re-run after the header edits — headers are
  docstrings, zero behavior change intended or claimed).
- CLASSIFICATION NOTE (agent fold): both findings are DOC-class
  INSIDE the reference tree (implementation self-description), not
  docs/21 prose — in-scope per the prompt's "claims in the
  implementation that belong to docs" clause. Neither is SPEC: no
  owner ruling needed; folded directly.
- CYCLE 2 (report: d4-scopeA-c2-out.txt; mission: the four regions
  cycle 1 declared uncovered; auditor ENUMERATED a claim inventory
  first per instruction, then verified): again SELF-DECLARED
  INCOMPLETE — completed the torn-AUTH region only; AUTH/REPAIR
  lifecycle, S-J2-R rotation, and cap reserve/commit remain
  unenumerated after two cycles (disclosed, not laundered).
  1 finding, MAJOR DOC, ACCEPTED after independent verification:
  | ID | Sev | Class | Finding | Disposition |
  |---|---|---|---|---|
  | D4A-c2-1 | MAJOR | DOC | fixture row (e-7) (docs/21 ~5803) still said a torn AUTH tail is IGNORED and the prior complete AUTH remains valid — the operative VALIDITY rule (~2837, v34), rows F9/F14, ledger.py _read_auths (unterminated nonblank carry ⇒ malformed) and test_F9_F14 all say FAIL CLOSED for every authorization; the auditor also empirically confirmed the suite pins refusal of repair AND of fresh authorize | (e-7) REWRITTEN as V34 SUPERSESSION (v30 text revoked in place, revocation lineage kept visible); no code/test change — the code and F9/F14 were always right, the fixture row was the sole stale carrier; zero behavior change |
  Post-fold pins: ledger dee009cbcbda, test_ledger b23bfa6feeae
  (UNCHANGED — docs-only fold), suite unchanged at 89 OK.
  AGENT NOTE: cycle 2's report also corrected the round's own kick
  premise — HEAD 4f5c32c DID touch both reference files (the cycle-1
  header fold), so "reference tree untouched" holds only for the
  v44 docs fold 6625d6f, not for 4f5c32c. Read the pin line as the
  cycle's own re-verified values, never as inherited.
- CYCLE 3 (report: d4-scopeA-c3-out.txt; mission: region (1)
  AUTH/REPAIR lifecycle incl. the 3A sentences — feeds the owner's
  deferred 3A reading): SELF-DECLARED INCOMPLETE (portion examined
  inventoried first — claims 1-5 in the report; full-region
  enumeration, quarantine/resolve-before-act rows and mutation
  experiments NOT done). 1 finding, MAJOR DOC, ACCEPTED after
  independent verification:
  | ID | Sev | Class | Finding | Disposition |
  |---|---|---|---|---|
  | D4A-c3-1 | MAJOR | DOC | the 3A disposition (~2623) and the V37 OWNER DECISION RECORD line (~6733, "revival only via fresh AUTH + fresh REPAIR") state an UNQUALIFIED no-revival rule, while the operative LATE-VALIDATION rule (v39 AUDV1-M1, ~2631+, ratified content) and test_F24gen (grew the confirmation log within the REPAIR's own confirmGen ⇒ same record reclassified VALID, same AUTH spent, no fresh pair) make validity current-read: no OPERATOR REVIVAL COMMAND exists, but automatic reclassification on precondition arrival is the ratified design | disposition + V37 record QUALIFIED IN PLACE (bracketed; shorthand's meaning pinned to "no operator command", cross-refs F24/test_F24gen and the late-validation rule; explicitly flagged that the owner's pending 3A reading ratifies the disposition INCLUDING the qualification). NO code/test change — code is the ratified behavior |
  NOTE: this is the FIRST finding that touches the owner's still-
  unconfirmed 3A verdict itself — it is deliberately folded as a
  QUALIFICATION of existing ratified prose (v39 AUDV1-M1 was owner-
  approved at v39), NOT as a new claim; the 3A reading artifact will
  carry it. Cycle 3 also re-verified the round pins by its own
  shasums (dee009cbcbda / b23bfa6feeae — match the cycle-2
  registration) and re-ran the suite in its own copy: 89 OK.
- CYCLE 4 (report: d4-scopeA-c4-out.txt; mission: regions (2)
  rotation + (3) cap reserve/commit): SELF-DECLARED INCOMPLETE
  (numbered claim inventory 1-13 in the report precedes the
  findings; the full S-J2-R crash matrix and F19 internals not
  independently audited; suite re-run in own copy: 89 OK).
  2 findings, both ACCEPTED after independent verification:
  | ID | Sev | Class | Finding | Disposition |
  |---|---|---|---|---|
  | D4A-c4-1 | MAJOR | **SPEC** (POOLED — owner batch) | S-J2-R rotation (ROTATE-SNAPSHOT carry-over, in-flight marker grammar, 0400 archive, crash matrix) is RATIFIED prose with ZERO implementation in the reference module (grep rotate/ROTATE/rotation: no matches; journal-full refusal stands as the only behavior) — the ratified sub-spec cannot be behavior-verified against the reference impl at all | boundary RECORDED here (registration below); the ledger's stale "OPEN spec question S-J2" docstring corrected to "ratified, OUT OF SCOPE for the reference impl — implementation-workstream decision belongs to the owner"; NO work commissioned; **OWNER DECISION POOLED: does rotation get its own implementation workstream, and is the reference impl's journal-full refusal the ratified interim behavior?** |
  | D4A-c4-2 | minor | DOC | repair() docstring + the step-(v) comment still said "the single write" / "the single reserved write" — v39 R2-M3 explicitly REVOKED that description (checked short-write loop under one lock acquisition; the one-lock guarantee stands) | both descriptions corrected in place (docstring/comment only, zero behavior change; loop at _append_bytes 1150-1156 verified as the operative behavior); suite re-run green after the edits |
  SPEC POOL STATUS (round rule: pooled SPEC findings get ONE owner
  batch fix): { D4A-c4-1 }. No other SPEC findings from cycles 1-4.
  Pin note: the cycle-4 report's hash transcription was garbled
  ("dee009cbc bda", "b23bfa6feed2") — the orchestrator re-verified
  against the tree: ledger dee009cbcbda / test_ledger b23bfa6feeae
  pre-fold (match cycles 2-3); post-fold values recorded at the
  commit below. Read hashes from the tree, never from a report.
- CYCLE 5 (FINAL; mission: residual scope — V33 fixture-row coverage
  completeness: every normative sentence of the rows in scope must be
  pinned by a test that REVERTS-TO-RED on its rule): 3 findings
  (intro first said "2 findings" — the fold table immediately below
  lists three; corrected per the count-correction note at the round
  totals), all ACCEPTED after independent verification —
  | ID | Sev | Class | Finding | Disposition |
  |---|---|---|---|---|
  | D4A-c5-1 | MAJOR | TEST | V33 row F23's late-AUTH arms (DEAD unknown-authId REPAIR reclassified VALID by a genuine later AUTH with occurrences=M, second REPAIR refused SPENT; occurrences≠M stays DEAD forever) were NOT pinned anywhere: the v38 test_F23 pins a DIFFERENT fixture reusing the number (intent-journal) and only the F24gen growth arm touched late validation. The row's behavior was verified empirically correct (A1-A4 arms: dead→valid activation, spent-refusal, mask-mismatch stays dead) but unpinned = unprotected | Two NEW tests added: test_F23v33_late_genuine_AUTH_activates_dead_repair + test_F23v33_late_AUTH_occurrence_mismatch_stays_dead (AUTH seeded RAW with the strict schema {t,authId,occurrences,createdAt} — the live authorize() would refuse the authId as already-used, so the injection-only setup matches the row's own v39 R2-M1 note). Mutation-checked: removing late validation ⇒ both new pins red; removing the mask-equality check ⇒ ONLY the mismatch pin red. Docs row annotated with the pin lineage. |
  | D4A-c5-2 | MAJOR | TEST | V33 row F25's CRASH-PREFIX ENUMERATION sentence ("fixtures drive (a), (b), (c) separately", v39 R2-M4) was unpinned: the v38 test_F25 pins post-write verify staleness (different fixture, reused number) | New test test_F25v33_crash_prefix_enumeration_three_arms drives all four prefixes — zero / "\n" / " \n " whitespace-only ⇒ decision OK (whitespace ignored, NOT unsettled) — and nonblank "\n{X" ⇒ unsettled-tail. Mutation-checked: treating ANY tail as unsettled ⇒ exactly this pin red. Docs row annotated with lineage. |
  | D4A-c5-3 | minor | DOC | both module headers claimed per-label fixture coverage (F1-F59 "pins") while F14 is pinned inside test_F9_F14, F15's row is a duplicate pinned by test_F6, and V33 F23/F25 share numbers with different v38 fixtures — the mapping claim was misleading | Both headers now state coverage is BY FIXTURE FAMILY with the explicit exceptions and the test_F23v33_*/test_F25v33_* lineage (the c5-1/c5-2 fold) |
  Round totals: 5 cycles, 9 findings filed (corrected 2026-11-17 —
  the totals line first said "8 findings … 4 TEST major"; the fold
  tables carry 2+1+1+2+3 = 9 and cycle 5's own table lists THREE
  rows (D4A-c5-1/2/3) under an intro line saying "2 findings": the
  miscount was in the totals, not the tables. Correct classification:
  2 TEST major (c5-1/c5-2, both mutation-verified), 6 DOC (2 MAJOR:
  c2-1, c3-1; 4 minor: c1-1, c1-2, c4-2, c5-3), 1 SPEC pooled
  (D4A-c4-1), 0 CODE). Every TEST
  finding here carried mutation-verified pins. Suite post-fold:
  92 OK (python3 -W error::ResourceWarning -m unittest
  p9m3.test_ledger, reference/). Post-fold hashes (read from the
  tree, per the cycle-4 note; HASH-LABEL CORRECTION 2026-11-17:
  these were written unlabeled and are SHA-1 (`shasum`) values —
  the SHA-256 prefixes are ledger.py 4e997d59ed99…,
  test_ledger.py ca66c1a47209…; the "docs/21 4847b3205b63…" pin
  matches NO committed state of docs/21 under either algorithm —
  treat as a transcription failure; the superseding values are the
  commit ids themselves): ledger.py 3a9307a7b1fc… sha1,
  test_ledger.py 656e77d3599f… sha1. The D4A-c4-1 SPEC owner batch decision
  (rotation workstream?) remains POOLED and OPEN; the round is CLOSED
  at its 5-cycle cap.
  COUNT CORRECTION NOTE (2026-11-17, post-round): per the round's own
  rule findings are counted from the fold tables; this note supersedes
  the earlier totals prose without changing any finding, disposition,
  or closure state. The 3A artifact (docs/21b) and docs/21 header
  carry the corrected count.

---

AUD45 ROUND — SCOPE A CONTINUATION (kicked 2026-11-17, owner-
authorized 7 cycles immediately after the v46 hygiene fold 37070e1;
terra = gpt-6.1-terra, read,bash, read-only repo, experiments in
per-cycle copies under ~/.tre/audits/aud45-x<n>/; prompt
~/.tre/audits/aud45-prompt.txt, kick aud45-kick.sh <cycle>).

AUTHORITY: unchanged (reference RUNNING behavior = behavior
authority; docs/21 prose = intent authority; CODE/TEST/DOC/SPEC
classification; SPEC pooled for one owner batch fix). SCOPE: same
Scope A as D4A, PLUS: cross-verification of the v46 fold itself
(cycle 1) and docs/21b Step-1 pin lines + Step-2 citation
resolution (cycle 7) — the artifact's DISPOSITIONS are not
re-adjudicated (owner's 3A reading owns that). Cycle assignments
1-7 per the prompt (v46 fold; 1A lock prose; 2A resolve prose;
settlement prose; AUTH lifecycle + S-A1-R; cap reserve/commit +
F19/F3 counts; sweep incl. 21b citations). Findings AUD45-c<k>-<n>.
Fold discipline per round: each cycle's findings verified against
source BEFORE acceptance, folded, gated (node + tsc + ref suite),
committed; post-fold hashes read from the tree with BOTH labels.

- CYCLE 1 (kick 2026-11-17; mission: cross-verify the v46 five-
  finding hygiene fold): report ~/.tre/audits/aud45-c1-out.txt.
  2 findings, both minor DOC, both ACCEPTED after independent
  verification (the auditor ran the suite 92 OK in its own copy,
  re-killed both F25 mutation arms, and recounted the D4A totals
  2+1+1+2+3=9 — the v46 fold verified):
  | ID | Sev | Class | Finding | Disposition |
  |---|---|---|---|---|
  | AUD45-c1-1 | minor | DOC | the 21b hash-correction note said the pinned files were "verified identical at 8721f5b and HEAD — the reference tree has not drifted", true of ledger.py only: HEAD carries the v46-strengthened test_ledger.py (656e77d3599f -> 7780857914ad sha1) | Note qualified to ledger.py with an explicit pointer to the update block below (cites the finding) |
  | AUD45-c1-2 | minor | DOC | the ~2647 qualification still called the V37 shorthand "The unqualified … shorthand" after v46 qualified that record IN PLACE — stale self-description | Rewritten "The formerly unqualified … shorthand … (in place since the v46 fold, 2026-11-17)" |
  Cycle self-declared INCOMPLETE (v46 diff + five edit groups
  inspected; full Step-2 sweep, hash-history search, and cycles
  2-7 regions open per assignments). Post-fold hashes (from the
  tree, both labels): ledger.py sha1 3a9307a7b1fc… / sha256
  4e997d59ed99… (UNCHANGED); test_ledger.py sha1 7780857914ad… /
  sha256 7a2159df7f46… (UNCHANGED — docs-only fold). Suite: 92 OK.
  1 finding, minor DOC, ACCEPTED after independent verification
  (auditor re-confirmed the enforcement refusal experimentally in
  its own copy; suite 92 OK there; post-v46 hashes independently
  recomputed and matched):
  | ID | Sev | Class | Finding | Disposition |
  |---|---|---|---|---|
  | AUD45-c2-1 | minor | DOC | `_check_access_controls` docstring still stated the superseded v38-cycle-1 permissive policy ("pre-existing read-only group bits … operator policy") while the code immediately below (added by v38 cycle-3 fix 5, AUD C3-5) refuses ANY bit outside 0600 — an externally created 0644 protocol file returns `unsafe-path-permissions` | Docstring restated to the enforced STRICT policy (zero behavior change, code untouched); 21b EVIDENCE-TREE UPDATE 2 records the new ledger.py pins (sha1 86d9ddc5d059…, sha256 26e44e0414ca…), the +6 line shift below ~163, and that Step-2 line citations resolve against the superseded pin with byte-identical content at each anchor (spot-verified) |
  Cycle self-declared INCOMPLETE (1A principal texts, C4-F1/F7,
  D4-B, acquisition/identity code, F24/F40/F42 bodies read; full
  1A claim enumeration and cross-document pin/count sweep open).
  Note: the cycle audited HEAD 51fce4f (post-cycle-1 fold) — kick
  HEAD drift is by design (each cycle audits the current fold).
  1 finding, MAJOR CODE, ACCEPTED after independent verification
  (the auditor reproduced the unbounded loop in its own copy: cap=2,
  no pending sidecar, persistent resolve_fsync_fault — five resolves
  all `durability-pending`, counter pinned at (0,False); binding
  promote refused fail-closed throughout, so the defect is the
  missing OPERATOR EXIT, not a silent pass; F20 exercises only the
  pending-window recovery round):
  | ID | Sev | Class | Finding | Disposition |
  |---|---|---|---|---|
  | AUD45-c3-1 | major | CODE | no-pending resolve path returned STATE_PENDING on IO failure WITHOUT consuming the attempt counter ("not a recovery ATTEMPT" comment) — a persistent fault on a healthy-looking ledger looped forever; spec demands "BOUNDED per episode … No schedule drives an unbounded loop" (docs/21 ~2820) and exhaustion/`resolve-exhausted` never arrived | FIX in _resolve_locked: cap refusal precedes the IO (persist-first), counter charged ONLY on IO failure, successful ordinary resolve stays counter-free (v38 fix 1) and clears charged attempts, exhaustion sticky/operator-reset-only via the existing overlays; new pin test_F60_no_pending_resolve_io_fault_is_bounded (failure sequence + status + binding refusal + cross-process stickiness + operator reset + success-stays-free), mutation-verified both ways (pre-fix revert kills it; charge-only removal kills it); suite 92->93 OK; 21b EVIDENCE-TREE UPDATE 3 re-pins both files (ledger sha1 2524fb71ff17…, sha256 6e6f5277b659…; tests sha1 80eb7014ee1f…, sha256 bed061d92495…) with the cumulative +28 shift disclosure and unshifted-S1 note |
  Cycle self-declared INCOMPLETE (resolve-bound/counter prose,
  counter parser, resolve/settle/reset/append/status/promote paths
  read; 78-line grep output screened, historical matches not
  individually audited; quarantine claims + cross-doc inventory
  open). Note: docs/21 header version bump for the AUD45 folds is
  DEFERRED to round close (one v47 header fold covering all seven
  cycle folds) — mid-round folds record in 21a + 21b update blocks;
  the reference tree is the source of truth for behavior meanwhile
  (hashes per update, pinned).
  1 finding, minor DOC, ACCEPTED after independent verification
  (both stale docstring sites confirmed in source; the pending-path
  pre-IO charge confirmed unchanged; auditor's interruption-injection
  experiment reproduced the asymmetry 0-vs-1; suite 93 OK in its
  copy):
  | ID | Sev | Class | Finding | Disposition |
  |---|---|---|---|---|
  | AUD45-c4-1 | minor | DOC | module header (~47) and _resolve_locked docstring (~1226) still claimed the counter is bumped BEFORE EACH resolve attempt "(a crashed attempt counts)" — untrue for the AUD45-c3-1 no-pending path, which charges only on a CAUGHT IO failure (pending rounds still charge pre-IO) | Both sites qualified: recovery rounds (pending window) charge pre-IO — a crashed round counts; no-pending resolves charge only on caught failure (a crash mid-IO there leaves no window and the same bytes, so nothing is owed) — behavior UNCHANGED, docstrings only |
  Cycle self-declared INCOMPLETE (120 settlement/pending/fsync grep
  matches screened, central prose 2735–2855 + framing 2588–2610
  compared vs append/sidecar/resolve/settle paths; not every match,
  intent-tag path, fsync-failure path, or cross-doc pin audited).
  Post-fold tree: ledger.py sha1 92a3b45004b5… sha256
  1a01e7d89abd… (test_ledger.py UNCHANGED 80eb7014ee1f…/
  bed061d92495…); suite 93 OK, tsc clean.
  1 finding, minor DOC, ACCEPTED after independent verification
  (both prose sites confirmed overclaiming in source; the code's
  whitespace-tail strip is DELIBERATE and consistent with the (b-O)
  blank-tail rule; auditor's experiment: b' '/b'\t\r' -> ([],False),
  b'{' -> ([],True); the other torn-tail shorthand sites (5846,
  AUD33-B2 row, AUD29/30 rows) already say "nonblank" — none left
  unqualified; suite 93 OK in its copy):
  | ID | Sev | Class | Finding | Disposition |
  |---|---|---|---|---|
  | AUD45-c5-1 | minor | DOC | AUTH VALIDITY paragraph (docs/21 ~2876) and _read_auths docstring said "ANY unterminated tail … FAILS CLOSED" while the reader ignores a WHITESPACE-ONLY unterminated tail (strip check; consistent with (b-O) blank-tail framing) | Both sites qualified to "unterminated NONBLANK" with the blank-tail consistency noted; behavior UNCHANGED |
  Cycle self-declared INCOMPLETE (lifecycle regions + generation
  binding read; S-A1-R three-state protocol NOT fully audited
  against the implementation; cross-doc pin inventory open).
  Post-fold tree: ledger.py sha1 cf0f6962fb87… sha256
  dadb9e043500… (test_ledger.py UNCHANGED); suite 93 OK, tsc clean.
  2 findings, both minor, ACCEPTED after independent verification
  (both confirmed in source: the F3 fixture's own comment says
  "lands at 200..209" while the table said 210; the F19 test
  computes lead_len=max(24-F+d,8) so deep-F pairs seed deeper, as
  its comment states; auditor re-ran suite 93 OK and recounted the
  matrix 14x2x2=56 in its copy):
  | ID | Sev | Class | Finding | Disposition |
  |---|---|---|---|---|
  | AUD45-c6-1 | minor | TEST | fixture table F3 setup says the confirmation "lands at offset 210" — the test lands it at 200..209 (log grows 200->210); "210" named the grown length, not a start offset | Table CORRECTED to the implemented geometry (lands at 200, grows to 210; expected asserts BOTH 200 and 210 clear — the test is the stronger of the two readings, R4-c2-2 pins the start, so no test change needed; correcting the table rather than the test, per the finding's second option) |
  | AUD45-c6-2 | minor | DOC | F19 header claims "cap-24-seed geometry" unqualified — pairs with lead >= 8 demands seed deeper (F=32,d=0 seeds LOG_CAP-40) | Header qualified: cap-24 seeds where the frame allows, deeper for deep-F pairs (matching the test's own comment) |
  Cycle self-declared INCOMPLETE (cap framing/reservation + REPAIR
  preflight + exclusion-lock cap clause vs _append_bytes/settlement/
  preflight/F3/F19/F57 bodies; exhaustive cap-path experiments,
  mutation testing, and cross-doc pin sweep open). Docs-only fold:
  reference tree UNCHANGED (ledger cf0f6962fb87…/dadb9e043500…;
  tests 80eb7014ee1f…/bed061d92495…); suite 93 OK.
  3 findings, all minor DOC, all ACCEPTED after independent
  verification (all three confirmed in source — two are bookkeeping
  drift created by this round's own mid-round folds; suite 93 OK in
  the auditor's copy; hashes re-derived per revision for 8721f5b /
  37070e1 / df0b88b / 3902362 / current):
  | ID | Sev | Class | Finding | Disposition |
  |---|---|---|---|---|
  | AUD45-c7-1 | minor | DOC | 21b update-3's "+28 cumulative" mapping went stale after cycles 4-5 edited ledger.py again (revive now 1491-1494, status line 1845 — update-3 offsets miss by 7) | 21b EVIDENCE-TREE UPDATE 4 added: explicit current-tree mapping measured at the round-close kickoff tree a6d54d5 (S1 anchor 894->903 (+9); S2 1456-1459->1491-1494 (+35); S3 1810->1845 (+35); content byte-identical, re-verified) + "Step-2 citations are HISTORICAL (8721f5b), this block is the verified current mapping" |
  | AUD45-c7-2 | minor | DOC | the hash-correction note said the old ledger hash was "verified identical at 8721f5b and HEAD" — true only at the v46 HEAD; current HEAD differs | Qualified "the HEAD **of that time** (commit 37070e1, the v46 fold)" with pointers to the updates + mapping |
  | AUD45-c7-3 | minor | DOC | both module headers' fixture inventories still say F1-F59 after F60 was added (cycle-3 fold) | Both inventories extended to F1-F60 with the AUD45-c3-1 purpose named (family-coverage qualification preserved) |
  Cycle self-declared INCOMPLETE (21b read fully + representative
  anchors + per-revision hashes; every individual Step-2 citation,
  the full docs/21+21a pin/count sweep, and full Scope-A prose not
  enumerated; no new mutation experiments; cumulative diff review
  was head-truncated).
  POST-FOLD TREE (the fold adds header-inventory lines only —
  ledger.py's +2 header lines shift all anchors +2 from the
  update-4 mapping, content identical): ledger.py sha1
  6902c5e4f77e68928f4427673944c709d9624d4f sha256
  ddaba333fb3d5d1c216d3f54e159b366d5bde40b570cef4766fad07c4fa686ff;
  test_ledger.py sha1 2c4ccb04a014532607a8991553e19e41b3be1553
  sha256 d8a6e181b980bf0baf65917cd85df4998e8bc01a12167e1157779cee4650a1f2.
  Suite 93 OK, tsc clean.

  AUD45 ROUND CLOSE (2026-11-17, at cap of 7 cycles): TOTAL 11
  FINDINGS — 1 major CODE, 1 minor TEST, 9 minor DOC; ALL ACCEPTED,
  NONE REJECTED (per-cycle 2+1+1+1+1+2+3=11). The one major
  (AUD45-c3-1: no-pending resolve IO fault bypassed the attempt
  bound — unbounded loop, missing operator exhaustion exit) is the
  round's substance: FIXED with mutation-verified pin test_F60,
  suite 92->93. The TEST finding (c6-1) was resolved by correcting
  the fixture TABLE (the test was the stronger reading). Every DOC
  finding was an over-claim/stale-description pair verified on both
  sides before folding — three of the nine (c7-1, c7-2 partially,
  c7-3) were BOOKKEEPING DRIFT CREATED BY THIS ROUND'S OWN MID-ROUND
  FOLDS; round lesson for future rounds: doc-only folds touching
  pin-mapping prose should land as one end-of-round update. All
  seven cycles self-declared INCOMPLETE — the round is a bounded
  adversarial sweep over Scope A, NOT a claim of zero remaining
  findings; the unenumerated remainders are listed per cycle above.
  FINAL GATE (round-close tree, this commit): node 2756 pass/0,
  tsc clean, reference suite 93 OK. THE OWNER'S 3A RATIFICATION
  READING (docs/21b Step 3) IS NOW AGAINST THE ROUND-CLOSE TREE —
  21b UPDATE 4 carries the verified current-tree citation mapping;
  S1–S6 drift remains NONE (c3's behavior fix serves docs/21's own
  resolve-bound prose, changes no 3A sentence). POOLED owner
  decisions unchanged (D4A-c4-1 rotation workstream; D9
  confirmation). Version: docs/21 header bumped v46 -> v47 (the
  single end-of-round header fold covering all seven cycle folds,
  as deferred in the cycle-3 registration).

## AUDIT ROUND AUD46 (independent-session kickoff, 2026-11-17) — cycles 1-5, terra

**PROVENANCE NOTE (the round's first lesson, recorded as finding
AUD46-a3's context):** the three kickoff findings did NOT come from
a scheduled cycle — they came from an independent session the owner
ran directly on the workstream ("audit the changes"), and that
session found MORE than the seven scheduled AUD45 cycles did
(including the major A1: bounded retry defeatable by fault timing).
Round-design consequence for future audits: interleave at least one
fresh-context full-diff audit alongside scheduled cycles — scheduled
cycles over-shifted to doc hygiene and missed a live-code property.

- SCOPE: the resolve-bound code paths introduced by AUD45-c3-1
  (`_resolve_locked` no-pending branch, status overlay) + the
  crosswalk evidence blocks, diff 97214d8..HEAD and fold commits.
- PREAMBLE (independent session, findings A1/A2/A3 — folded as the
  cycle-0 pre-fold BEFORE this round's cycles began):
  - AUD46-A1 (major CODE): the AUD45-c3-1 charge POSTED the IO
    (consumed only on caught OSError) — an interruption/crash DURING
    the resolve IO left the counter untouched, so the bound was
    defeatable by fault timing. FIXED: the charge is now
    crash-durable PRE-IO (write n+1 before `_resolve_io()`, same
    discipline as the recovery round — success clears on completion;
    a crash between IO and the clear leaves the charge owed).
  - AUD46-A2 (major CODE): a charged attempt with no pending window
    (failed resolve, or crash after IO before the clear) is an
    UNCONFIRMED outcome, but status()/promotion_allowed() rendered
    `ok` until the exhaustion flag persisted — contradicting the
    binding path and the default-deny premise. FIXED: status()
    overlays `durability-pending` when counter>0 with no pending
    window (cleared by the next successful resolve).
  - AUD46-A3 (minor DOC): 21b UPDATE 4 said "CURRENT-TREE MAPPING"
    but pinned the pre-cycle-7 tree and was already stale at the
    round-close tree. FIXED: Update 4 marked HISTORICAL (commit-
    317ca83-pinned); the AUD46 round-close Update 5 carries the
    current mapping.
  - PINS: test_F61 (mutation-verified, see cycle entries): charge
    survives interruption across restarts; charged-no-window renders
    PENDING + snapshot refuses; cap refused BEFORE IO after cap
    interruptions; sticky across processes; operator reset re-arms;
    healthy success clears. Suite 93 -> 94.
  - VERIFIED (kickoff probe, post-fold): interruption charges
    (1,False)->(2,False)->refused exhausted before IO on the 3rd
    (cap 2); caught-failure sequence renders PENDING from attempt 1
    (was ok/snapshot-True); binding promote refuses
    resolve-exhausted; plain appends unaffected by exhaustion;
    decision appends refuse on their own gate re-check.

- CYCLE 1 (terra, 2026-11-18; full transcript ~/.tre/audits/aud46-c1-out.txt):
  - AUD46-C1-1 (major CODE): `operator_resolve_reset()` zeroed the
    counter WITHOUT recording the still-unconfirmed outcome elsewhere.
    With no pending-window marker, status() then reported `ok` and
    promotion_allowed() returned True, although no resolve had ever
    succeeded — defeating the AUD46-A2 overlay's default-deny purpose
    on the explicit operator re-arm path (owner probe confirmed:
    after reset (0, False) -> status ok, snapshot allowed True while
    the binding promote() still refused durability-pending).
    FIXED: OWED WITNESS sidecar `resolve-owed` (fixed-width 16,
    0600, in the strict permission census): `_resolve_locked` writes
    it BEFORE the charge+IO of EVERY attempt (both branches) and
    `_clear_owed()` (fixed-width zero rewrite — F10: no unlink) runs
    ONLY on a fully completed resolve. `operator_resolve_reset()`
    preserves it: counter-0 owed evidence keeps status() at
    `durability-pending` (new `owed_attempt` diagnostic) and the
    binding promote() refuses until a resolve COMPLETES — the sole
    clearer, so healthy self-heal is unchanged (promote resolves
    in-lock and clears the witness).
  - PINS: test_F62_owed_witness_survives_operator_reset — witness
    lands pre-IO; survives reset + restart; status PENDING with
    owed_attempt; snapshot refuses; fault-still-active resolve fails
    closed STATE_PENDING with evidence persisting; healthy promote
    self-heals (returns payload, clears witness and counter, status
    ok); cleared witness file reads as never-created. Suite 94 -> 95,
    all OK.

- CYCLE 2 (terra, 2026-11-18; transcript ~/.tre/audits/aud46-c2-out.txt):
  - AUD46-C2-1 (minor TEST, strength): F62 did not pin the OWED-
    BEFORE-CHARGE ORDERING — the auditor's mutant moved
    `_write_owed()` after `_write_counter()` in both branches and the
    full suite still passed; crashing at the (now-late) witness write
    then operator-resetting re-creates the exact C1-1 loss
    (owner re-ran the reproduction on the mutant: counter=1 owed=False
    -> reset -> counter=0 owed=False -> status ok, allowed True).
    FIXED IN TESTS: F62 now spies `_write_counter` and asserts the
    witness is ALREADY OWED at every charge write (both branches;
    `seen=[(n, owed)]` all-owed), then proceeds with the original
    C1-1 scenario. Verified: real suite 95 OK; the swapped-order
    mutant turns F62 RED ("every charge must land with the witness
    set: [(1, False)]"). No CODE change required (current code has
    the ordering right — the finding is pin strength).
  - CYCLE INCOMPLETE remainders (auditor's own list, carried forward
    to cycles 3+): full (pending,counter,owed,exhausted) state-space
    enumeration; torn/empty/hostile-0-byte witness fault injection;
    directory-fsync & exists-race probes; cleared-then-recrashed
    interleavings; two-instance concurrency; F10/probe conformance of
    the mid-protocol witness creation; per-mutant sweep of every owed
    writer/clearer/reader/status-check; full classify() paths.

- CYCLE 3 (terra, 2026-11-18; transcript ~/.tre/audits/aud46-c3-out.txt):
  - AUD46-C3-1 (MAJOR): torn witness CREATION read as no-owed. The
    witness name is visible the instant O_CREAT returns but the bytes
    are not; the old reader (`bool(raw.strip(b"\0"))`) read the
    zero-LENGTH file exactly like a cleared record — auditor's
    injected pwrite fault during creation produced
    `raw=b'' counter=0 owed=False status=ok allowed=True`. FIXED:
    `_owed_attempt` now reads 17 bytes and the content space is
    CLOSED — MISSING = none, EXACTLY the 16-byte all-zero record =
    cleared-none, EVERYTHING ELSE (zero-length, partial, garbage,
    over-long) FAILS CLOSED as owed; status()/promotion snapshot
    follow (new test_F63 pins all eight vectors + status agreement).
  - AUD46-C3-2 (MAJOR): a torn `_clear_owed` could erase the OWED
    signature before the clear completed (auditor injected a 4-byte
    short write then OSError: head zeroed, tail already zero, next
    instance served ok at counter 0). FIXED by write ORDER:
    `_clear_owed` now writes the ZERO TAIL (offset 4..16) first and
    the 4-byte head LAST — a crash mid-clear leaves the nonzero OWED
    head, which reads owed; only the final 4-byte write can ever
    complete the clear. F63 pins the tail-crash interleaving.
    (The clear also bypasses `_sidecar_write` deliberately: it never
    creates, so no dir-fsync is owed — fixed-width checked pwrite +
    fsync retained.)
  - AUD46-C3-3 (minor TEST, strength): a mutant recognizing ONLY the
    full OWED prefix survived the suite (95 OK) while differing
    observably for b"OW" (real: pending/False; mutant: ok/True).
    SUBSUMED by the F63 content-space table (every non-canonical
    vector pinned, fail-closed direction included).
  - Verified: real suite 96 OK; the pre-fix reader+clear mutant turns
    F63 RED; auditor's four raw-content probes re-run against the fix
    (b''/OW/garbage -> owed pending snapshot False; 16 zeros -> ok).
  - CYCLE INCOMPLETE remainders carried to cycle 4: full state-space
    enumeration incl. pending-intent R/'-' arms; dir-fsync/exists-race
    injections on the witness; two-instance concurrency incl.
    promote-callback crash; F10/probe conformance of mid-protocol
    creation; post-IO / clear-only-on-pending writer mutants; full
    classify() paths.

- CYCLE 4 (terra, 2026-11-18; transcript ~/.tre/audits/aud46-c4-out.txt):
  - AUD46-C4-1 (MAJOR, in the C3 fix itself): `_clear_owed`'s tail
    retry loop re-issued the FULL 12-byte buffer on a short write —
    a permitted 4-of-12 pwrite at offset 4 retried 12 bytes at
    offset 8, EXTENDING the fixed-width witness to 20 bytes; over-
    long fails closed forever (healthy resolves rewrite only 16
    bytes) — auditor's repro: `resolve ok, length 20, status
    durability-pending, snapshot False, binding promote refused`,
    suite 96 OK (undetected). FIXED: both clear phases slice the
    REMAINING bytes per attempt (`buf[off:end]` — same discipline
    as `_sidecar_write`, which was already correct); the head write
    is now inside the checked loop too. F63 extended: one 4-byte
    short pwrite injected at offset 4, then a full clear must land
    at exactly 16 bytes with owed=False. Verified: real suite 96 OK;
    auditor repro re-run -> length 16, status ok, snapshot True;
    the un-sliced mutant turns F63 RED ("20 != 16").
  - CYCLE INCOMPLETE remainders carried to cycle 5 (final): full
    state-space enumeration incl. pending-intent R/'-' arms; two-
    instance/callback-crash concurrency probes; FsFaults/errno
    injections on the witness paths; F10/prose conformance incl.
    _clear_owed's deliberate no-dir-fsync (never creates); the
    remaining owed-writer/clearer/reader/overlay mutant sweep.

- CYCLE 5 (terra, 2026-11-18; transcript ~/.tre/audits/aud46-c5-out.txt;
  NOTE: the auditor process deadlocked ~52 min in a multiprocessing
  fork during its own concurrency probe — owner killed the child PIDs
  and the main process completed 1 min later; lesson: schedule no
  threaded/forking probes from a read+bash auditor on this codebase):
  - AUD46-C5-1 (MAJOR): failed witness-clear fsync served `ok`.
    Resolve completion wrote `_write_counter(0)` BEFORE
    `_clear_owed()`; an EIO on the clear's second fsync left the
    caller with an error while the visible state was ZERO witness +
    ZERO counter — a fresh instance read counter==0, owed==False and
    served `ok`/allowed=True although no completed resolve had
    confirmed the outcome (contradicting the A2 default-deny premise
    on the completion path itself). Reproduced by the auditor
    (fsync-EIO injection on the witness fd). FIXED: completion order
    swapped in BOTH success branches (pending branch + recovery-
    round branch): `_clear_owed()` FIRST, then `_write_counter(0)`.
    A failed clear leaves the attempt CHARGED (A2 overlay => PENDING)
    with the witness still owed (double evidence); the symmetric
    fault (clear lands, the zero faults) is equally fail-closed —
    charged counter, cleared witness, PENDING until the next
    successful resolve. Verified: both fault modes -> counter 1,
    status durability-pending, promotion_allowed False; next healthy
    resolve recovers (counter 0, owed False, ok).
  - PINS: test_F64_clear_fsync_fault_stays_fail_closed — case A
    (clear raises) asserts charged + owed + PENDING + refuse, then
    bounded recovery; case B (counter-zero raises after a successful
    clear) asserts charged + witness cleared + PENDING + refuse.
    Mutation-verified: reverting the swap in both branches turns F64
    RED ("a failed clear must leave the attempt charged") and
    nothing else. Suite 96 -> 97.
  - Minor (no finding action): a concurrent resolve interleaving was
    OBSERVED by the auditor (not exhaustively proven — the scheduled
    threaded-race proof was not completed, see remainders); a
    promote-callback crash after an allowed resolve is spec-
    conformant (the decision already landed; the callback is the
    caller's own effect).
  - CYCLE INCOMPLETE remainders (accepted as carried-forward, see
    round close): full state-space enumeration incl. pending-intent
    R/'-' arms; exhaustive threaded-race proof; the remaining
    fault-injection matrix (dir-fsync/exists-race on the witness;
    F10/prose conformance of _clear_owed's deliberate no-dir-fsync);
    the exhaustive per-mutant sweep of the owed writer/clearer/
    reader/overlay.

- ROUND CLOSE (AUD46, 2026-11-18): 5 cycles + kickoff pre-fold, 10
  findings — 7 major CODE (A1, A2, C1-1, C3-1, C3-2, C4-1, C5-1), 1
  minor DOC (A3), 2 minor TEST-strength (C2-1, C3-3) — all ACCEPTED
  and FIXED with mutation-pinned tests (F61-F64). Cumulative
  majors found IN A FIX: 2 (C4-1 in the C3 fix; C5-1 sits in the
  AUD45-c3-1/A2 completion path — cycles caught what prior rounds'
  fixes introduced). The CYCLE INCOMPLETE remainders above are
  carried to the next round as scope, not closed by assertion.
  Final gate: `cd reference && python3 -W error::ResourceWarning -m
  unittest p9m3.test_ledger` -> **Ran 97 tests — OK**; tsc clean;
  evidence tree re-anchored at this commit in 21b UPDATE 5.

## AUDIT ROUND AUD48 (2026-11-18, terra, 5 cycles — OPEN)

- SCOPE: the P9-M3 reference as it stands at 11c8176 — the resolve/
  completion/evidence machinery incl. the two AUD48-prep fixes
  (below). Carried-forward AUD46 remainders stay in scope: full
  state-space enumeration (pending-intent R/'-' arms), exhaustive
  threaded-race proof, the remaining fault-injection matrix
  (dir-fsync/exists-race on the witness), per-mutant sweep of the
  owed writer/clearer/reader/overlay. AUD47 cycle entries live in
  git (f3fb983..a69c6cb); the two open findings are folded here.

- AUD48 PREP (owner, 2026-11-18; the two AUD47-c5 open findings,
  commit 11c8176):
  - PREP-1 (MAJOR, inherited): the AUD47-c1 completion (clear-first,
    re-arm-on-failure) exposed `ok` under a COMBINED fault — a
    corrupt-witness clear failure re-armed by rewriting OWED ERASED
    the failed-clear evidence, and the following counter-zero fault
    left counter=0 + readable-cleared witness: fresh instance served
    ok for a resolve whose caller got OSError. FIXED: completion is
    ZERO-FIRST (pre-attempt charge is the durable cover), witness
    clears LAST, every compensation pins the honest charge n (the
    pre-attempt write already counted this attempt — the first fix
    draft pinned n+1 and the F64-A pin caught the double-charge;
    lesson: compensation writes must respect the charge ALREADY
    made). Pins F73 (combined corrupt-clear + zero-fault survivor +
    heal).
  - PREP-2 (MAJOR, inherited): operator_resolve_reset zeroed the
    counter unconditionally. When the counter charge is the SOLE
    durable evidence (F68 fallback: witness-open fault left
    counter=1, no witness), the reset erased the only proof of an
    unconfirmed attempt — fresh instance read (0, no witness) = ok.
    FIXED: reset REFUSES (`reset-sole-evidence-refused`) when the
    counter PARSES positive and the witness reads cleared — corrupt/
    unparseable counter records still reset (grammar-heal path,
    F67), sticky-exhaustion and witness-present resets untouched.
    Pin F72.
  - Gate: `cd reference && python3 -m unittest p9m3.test_ledger` ->
    Ran 106 tests OK.

- AUD48 CYCLE 1 (auditor: terra, detached; 4 majors reported;
  disposition 2026-11-18):
  - C1-F1 (MAJOR, REJECTED): "a crash during the final witness clear
    exposes an unconfirmed resolve as OK". Under the AUD48-prep ZERO-
    FIRST order the witness clear is the LAST step AFTER the resolve
    IO is durable and pending is updated — a process death between
    the last visible zero byte and the return of `_complete_resolve`
    loses nothing: the resolution itself is confirmed-durable, the
    completion is idempotent, and the next instance re-clears the
    same zeros. The auditor modeled process exit as a fault INSIDE
    the protocol; the crash window it needs (resolve-IO NOT durable)
    is covered by the pre-attempt charge (F68/AUD46-a1). Probe
    "crash 77 counter (0,False) owed False ok" is the SUCCESS state,
    not a leak. No code change.
  - C1-F2 (MAJOR, ACCEPTED+FIXED): completion's compensation re-armed
    the witness by a NEW open — a device faulting the clear's fsync
    can fault that open; with the suppressed re-arm AND the counter
    pin faulting, the fresh view read counter 0 + readable-CLEARED
    witness = ok for a caller that got OSError. FIXED in
    `_clear_owed`: on fsync fault the OWED bytes are rewritten on the
    fd ALREADY OPEN (best-effort fsync, original error then
    propagates) — the recharged witness no longer depends on a
    second open succeeding. Pin F76 (inode-matched one-shot combined
    fault: clear-fsync EIO + re-arm-open EACCES + counter-pin EIO —
    the earlier count-based injection orderings were shown
    non-discriminating; the one-shot sequence is precondition-
    asserted).
  - C1-F3 (MAJOR, ACCEPTED+FIXED): the sole-evidence guard skipped
    when the sticky `X` flag was set — a cap refusal writes the flag
    over the SAME live charge, arming the bypass (fallback charge,
    second visit sets X, reset erases the sole evidence -> ok). The
    flag governs AUTOMATIC rounds, not the FACT a charge exists.
    FIXED: guard is evidence-based via new `_counter_state()`
    (n, exhausted, corrupt) — a grammar-VALID positive count refuses
    whatever the flag; corrupt bytes keep the F67 heal path open.
    Pin F74 (sticky-X bypass repro + F62 owed-witness reset intact).
  - C1-F4 (MAJOR, ACCEPTED+FIXED): the guard caught the witness-read
    OSError and treated UNREADABLE as owed-evidence, permitting the
    reset — "unreadable" is neither cleared nor owed-readable:
    ambiguous evidence over a live charge. FIXED: `_owed_state()`
    tri-state (True/False/'ERR'); ERR + live positive charge REFUSES
    (fail closed). Operator recovery pinned: restore the witness
    (owed-readable) -> reset lands, witness preserved (F62), ok
    never served. Pin F75.
  - Mutation check: F76's injection was verified DISCRIMINATING (the
    in-fd repair neutered -> F76 fails; flag-bypass restored -> F74
    fails; ERR-tolerance restored -> F75 fails; all reverted).
  - Gate: `cd reference && python3 -m unittest p9m3.test_ledger` ->
    Ran 109 tests OK.

- AUD48 CYCLE 2 (auditor: terra, detached; 1 major reported;
  disposition 2026-11-18):
  - C2-F1 (MAJOR, ACCEPTED+FIXED): the cycle-1 in-fd repair wrote the
    FULL 16-byte OWED payload as its first act — if the repair's
    first pwrite faulted (EIO) no nonzero byte ever landed, and with
    the compensating re-arm open AND the counter pin faulting too the
    fresh view read counter 0 + readable-cleared witness: `ok` for a
    caller that got OSError (auditor probe reproduced: faults
    {fs, repair, open, pin, zero} all fired, decision ok). FIXED:
    the repair SEEDS ONE BYTE at offset 0 FIRST — any non-all-zero
    16-byte record reads owed under the fail-closed reader — then
    fills the full payload best-effort. Exposure now requires a
    device that rejects even a ONE-BYTE pwrite on a fd whose
    16-byte zero write it just accepted: the documented
    all-writes-fault boundary (`_arm_owed` precedent). A PARTIAL
    repair (byte 1 lands, then error) was shown safe in the same
    probe (witness reads owed). Pin F77 (five-fault one-shot
    injection, all preconditions asserted; mutation check: seed
    removed -> F77 fails, reverted).
  - Cycle-2 partials (assignment 2-4 not completed by the auditor —
    carried into cycle 3): grammar/over-cap heal analysis,
    corrupt-witness + corrupt-counter double-corrupt reset trap
    check, hostile unlink/exists race on the witness, FsFaults seam
    interaction with the in-fd repair, subprocess race coverage,
    per-mutant sweep of the cycle-1/2 code. One interleaving WAS
    shown: the reset guard + concurrent resolve serialize on the
    exclusion lock (resolve blocked while the guard paused).
  - Gate: `cd reference && python3 -m unittest p9m3.test_ledger` ->
    Ran 110 tests OK.

- AUD48 CYCLE 3 (auditor: terra, detached; 1 high + 2 test-survivors;
  disposition 2026-11-18):
  - C3-F1 (HIGH, ACCEPTED+FIXED): the reset guard skipped the witness
    check when the counter record classified CORRUPT (F67 heal path)
    — appending ONE byte to a live `1 -...` record makes it
    over-length = corrupt, LAUNDERING the sole evidence: free heal
    zeroes the counter, fresh view counter-0 + no witness => `ok`
    (auditor probe reproduced end-to-end). FIXED: the guard now runs
    on the RAW-GRAMMAR charge (`_counter_raw_charge`: first 16 bytes
    parsed against the fixed grammar — what the record was BEFORE
    trailing damage). Corrupt damage whose prefix parses POSITIVE is
    a live charge: same refusal; damage over a ZERO count (no
    attestable charge) keeps the F67 free heal. F72's escape-hatch
    fixture narrowed to the zero-count case accordingly. Pin F78
    (launder + both escape paths + e-length classification pin;
    mutation check: guard reverted -> F78 fails).
  - C3-F2 (test survivor, ACCEPTED): the suite never enforced the
    seed OFFSET (a-offset mutant survived; auditor confirmed the
    mutant itself stays safe — the reader fails closed on any
    nonzero record). F77 now asserts byte 0 == b"O". Mutation: seed
    moved to offset 1 -> F77 fails.
  - C3-F3 (test survivor, ACCEPTED): `len(raw) != 16` -> `len(raw) <
    16` survived (17-byte zero-record + NUL treated live: reset
    wedges refusing). Not a defect in the current check; F78 pins
    the 17-byte corrupt-and-healable classification directly.
  - Auditor probes ACCEPTED as coverage (no finding): seeded-repair
    hostile states (seed-only / 2-byte partial fill + re-arm fault)
    all read owed, durability-pending, healthy resolve heals;
    double-corrupt witness+counter: reset preserves witness ->
    pending, completing resolve heals (the c2-assignment-2 recovery
    path PROVEN); unlink race: in-fd repair hits the deleted inode
    but the counter pin carries the evidence (residual: pin ALSO
    failing is the documented all-writes-fault boundary).
  - Cycle-3 remainders (auditor: CYCLE INCOMPLETE): exhaustive
    seed-ordering mutant variants; combined unlink+pin-failure
    probe. Carried into cycle 4 (with new hunt: the RAW-CHARGE
    guard itself — c3-F1's fix is the prime suspect; and the
    FsFaults seam interaction with the AUD48 code paths).
  - Gate: `cd reference && python3 -m unittest p9m3.test_ledger` ->
    Ran 111 tests OK.

## AUDIT ROUND AUD48 — CYCLE 4 disposition (auditor: fresh-context adversarial; tree 2be3c25, suite 111 OK)

RESULT: **CYCLE INCOMPLETE — zero findings; the auditor died at the turn budget
with four remainders unexecuted.** Everything it DID execute held: the
raw-charge/prefix agreement probes (multi-digit, over-cap, leading-zero,
NUL-junk, empty — all three views agree), the c3 mutants (`live = n` always,
`live >= 0`, seed b"\\0" — ALL KILLED; `split(" ")` -> `rsplit(" ")` survived
and the auditor verified it is behaviorally equivalent on every reachable
input: 16-byte single-space grammar admits no second space, so split ==
rsplit — mutation-equivalent, not a coverage hole), the guard + sticky
interaction pass, and the full-suite re-run.

CARRIED REMAINERS (become the cycle-5 target list):
1. subprocess-level resolve-vs-reset serialization probe (two PIDs, lock
   must serialize the guard read against the reset's counter write).
2. exhaustive per-input disagreement matrix across _parse_counter /
   _counter_state / _counter_raw_charge / _read_counter / status.
3. FsFaults seam matrix driven through the AUD48 repair paths
   (sidecar_write_fault / partial_write / fsync_fault / open_fault x
   _write_owed / _clear_owed / repair seed+fill — does a seam consume the
   seed or spin the fill loop without progress?).
4. combined unlink + five-fault + PIN-failure ordering (what survives when
   the repair lands on a deleted inode AND the charge pin faults).

RESIDUAL RE-PROBED (owner side, closes the c3 disposition residual):
unlink-after-clear-open under `sidecar_open_fault` — resolve raises, fresh
view = counter 0, owed False, decision `repairing` (the counter cover holds;
the caller got an error, not `ok`). No exposure at reference level.

DISPOSITION: no code change (nothing found). Remainders 1-4 are cycle 5's
assignment; the F59/F74 reconcile-lock serialization is the invariant under
test in remainder 1.

## AUDIT ROUND AUD48 — CYCLE 5 disposition (auditor: fresh-context adversarial; tree 161a06e, suite 111 OK)

RESULT: **CYCLE CLEAN** — all five assignments executed: (1) FsFaults seam
matrix through every repair leg: all fail-closed, no serving decision over
unconfirmed evidence; (2) unlink x seam-fault storm, 224 interleavings: 0
violations; (3) subprocess resolve-vs-reset race: the reconcile lock held,
the owed witness survived every observed interleaving; (4) 24-record
disagreement matrix across all observer passes: mutually consistent (the
mode-000 `OSErr:13` rows verified as the designed ambiguous-witness
handling, not a divergence); (5) full suite clean under
`-W error::ResourceWarning` AND `-X dev`, 4 design mutants: M1/M2/M3
(the c3 guard reverts) KILLED; **M4 (clear order -> head-first) SURVIVED**
-> the cycle's finding.

### C5-F1 (minor, ACCEPTED+FIXED): F70 is vacuous as the tail-first ORDER pin
`test_F70_tail_first_clear_order_pinned` injects a Python-level OSError
*inside* the clear — `_complete_resolve`'s compensation handler catches it
and re-arms the witness under ANY segment order, so every F70 assertion
passes identically on a head-first mutant (owner re-verified: a head-first
copy of ledger.py passed all 111 tests). The order invariant is a
CRASH-consistency property: only a real SIGKILL between the segments has
no handler. The auditor's true-crash probe showed the reachable hazard is
real: shipped tail-first survivor reads `OWED` -> fresh view pending;
head-first survivor is all-zero -> `owed=False decision=ok`.
FIX (commit 8626746): F79 — fork a child, SIGKILL it after the FIRST
clear segment (the all-zero-payload filter counts exactly the clear
segments in order under any segment order; C7_3's fork recipe, never the
multiprocessing module); the survivor must read OWED, the fresh view must
refuse ok, and a real resolve must heal it. Mutation-verified: F79 is RED
on the head-first mutant (`rec[:4] != b"OWED"`), green on shipped code.
F70 kept (it genuinely pins the COMPENSATION path: re-arm survives, reset
preserves, heal completes) with its docstring claim corrected to that
scope — an overclaiming pin is how a vacuous pin survives two rounds.
Suite: **112 OK** under `-W error::ResourceWarning`.

## AUDIT ROUND AUD48 — ROUND CLOSE

Cycles: c1 (1 major fixed — zero-first completion, F72/F73), c2 (1 major
fixed — in-fd repair seeds minimum evidence at offset 0 first, F74-F77),
c3 (1 high fixed — the reset guard judges CORRUPT records by their RAW
charge prefix, F78), c4 (incomplete, zero findings — remainders carried),
c5 (CLEAN — remainders all executed and passed; 1 minor test-quality
finding fixed with a true-crash order pin, F79).

Production-code changes this round (3): `_complete_resolve` zero-first
with pin-at-n compensation; `_clear_owed` repair minimum-evidence-first
seed; `operator_resolve_reset` raw-charge guard (`_counter_raw_charge`).
Spec changes: none needed — every defect was reference-side; docs/21
already mandates crash-consistent evidence ordering and never-ok-over-
error (each fix restores conformance, the round found no spec gap).

ROUND RESIDUALS (accepted at reference level, carried to AUD49 candidates):
- `_sidecar_write` has declared fault seams but the AUD48 repair paths
  (`_clear_owed`'s repair, the owed re-arm) bypass it (own open/pwrite
  loop); the repair-path fault matrix ran through a test-side injector
  instead. A production seam unification is a cleanup, not a defect.
- Sticky-overlay tradeoffs remain F55/F62 closed positions (documented).
- The five-fault combined storm remains unexposed after the c1-c3 fixes
  (c5 assignment 2, 224 interleavings, 0 violations).
HEAD at close: 8626746, suite 112 OK. Round AUD48 CLOSED.

## AUDIT ROUND AUD49 — ROUND OPEN

SCOPE (2026-11-17, Hong: "just run the audit cycle on yourself, run 3
cycles, address the findings as they come up"): the AUD48 residual #1 —
repair-path SEAM UNIFICATION. The clear path and its in-fd repair legs
were the only production writes with NO declared FsFaults seam (the
fault matrix reached them via test-side os.pwrite/os.fsync
monkeypatching); an un-seamed path is not addressed by the matrix.
Hong ratified unification as a production-side cleanup (the test-side
injector is only allowed while no seam exists), pinned the scope to the
fault matrix (the `_sidecar_write` dedup stays a test-observability
cleanup), and set the release gate at three CLEAN cycles — no shipping
on a clean cycle 1 or 2. Kickoff (AUD49-c0, commit 87c290f, 116 OK):
five declared constructor seams (`clear_write_fault`,
`clear_partial_write`, `clear_fsync_fault` — the RAISING variant,
distinct from the silently-dropped `sidecar_fsync_fault` —
`repair_seed_fault`, `repair_fill_fault`), each True-or-callable;
`sidecar_open_fault`/`sidecar_write_fault` path-predicated; consumption
through one contract (`_fault_active`); new pins F80 (seams declared),
F81 (clear segment seams incl. the partial=0 zero-progress
discriminator), F82 (F76's storm constructor-only), F83 (exact
seed-only row; the all-in-fd-writes boundary). Pre-flight: every new
seam mutation-killed individually before handoff.

- AUD49 CYCLE 1 (auditor: gpt-6.1-sol, detached; 3 findings reported;
  disposition 2026-11-17):
  - C1-F1 (MEDIUM, ACCEPTED+FIXED): `_fault_active` chose the 1-arg
    call by counting REQUIRED parameters, so a predicate with an
    OPTIONAL path parameter (defaulted lambda / functools.partial /
    bound method) was invoked ZERO-arg and silently returned its
    default — a path-selective fixture ran the HEALTHY operation
    instead of injecting the fault (repro: a defaulted clear-write
    predicate completed the clear silently). FIXED: new
    `_dispatch_fault` decides by SIGNATURE BINDING — the path is
    passed whenever the signature accepts it (required, optional, or
    *args); no-arg only when the path cannot bind. Bind attempts
    raise TypeError only for the call signature, so a predicate-body
    TypeError still surfaces unretried (the c0 discipline kept).
  - C1-F2 (MINOR, ACCEPTED+FIXED): `clear_partial_write` was the one
    seam whose value skipped dispatch (`int()` directly): a callable
    raised TypeError before any syscall although the constructor
    advertised True-or-callable for every seam. Its consumption
    semantics were also undocumented in two directions: it applies to
    EVERY loop write (not "the first segment" as documented) and the
    suite passed a first-write-only mutant. FIXED: consumed through
    `_partial_limit` (callable -> `_dispatch_fault`, return value
    interpreted recursively: int ceiling or None); the contract is
    now DOCUMENTED as a persistent per-write byte ceiling (throttle),
    and pin F84(b) discriminates consumption-LEVEL: the predicate is
    asserted consulted EXACTLY once per real segment pwrite (counts a
    zero-payload-write oracle), closing the once-only mutant.
  - C1-F3 (MINOR, ACCEPTED+FIXED): the suite admitted a
    FILL-BEFORE-SEED repair-order mutant (116 OK) — after both
    independent legs finish the row is identical, so endpoint
    assertions cannot see the order; this is the AUD48-c5 F70 lesson
    recurring on the repair path. The shipped order is PROVEN correct
    by a fresh true-crash probe (SIGKILL at the fill-pwrite boundary:
    shipped leaves the seed-only owed row; fill-first leaves zeros =
    a cleared-reading witness with no counter cover). FIXED as a
    permanent pin: F85 (F79's recipe; kills at ENTRY to the only
    pwrite whose payload starts b"OWED" — order-independent filter;
    survivor must read owed, fresh view must not serve ok).
    Mutation check: fill-before-seed swap -> F85 FAILS, reverted.
  - Test-hygiene fix carried with the cycle (the auditor's gate
    qualification): F79 read the survivor with `open(...).read()` —
    an unraisable ResourceWarning leaked despite
    `-W error::ResourceWarning` (the run exits 0; warnings are not
    gate-enforced on unraisable). Now a `with`-block; both gate runs
    this cycle emitted ZERO warnings (grep-verified on the merged
    output).
  - Mutation check (fresh copies, PYTHONDONTWRITEBYTECODE=1, -B):
    dispatch reverted to required-count -> KILLED (F84); partial
    dispatch removed -> KILLED (F84); fill-before-seed -> KILLED
    (F85); partial consumed once-only -> KILLED (F84). The auditor's
    own 15-mutant table: all five new-seam dead/unconditional
    mutants killed; its two survivors ARE the F3 gap and the F2
    consumption ambiguity (both closed).
  - Gate: `cd reference && python3 -W error::ResourceWarning -m
    unittest p9m3.test_ledger` -> Ran 118 tests OK, zero warnings.
    Fix commit: 7d9ac0c.

AUD49 CYCLE 2 disposition (2026-11-16, auditor: fresh
context gpt-6.1-sol, full assignment: diff audit of
7d9ac0c, 5 specified mutants + 2 assertion-strength
mutants, callable census, 80-case seam census on the
FIXED dispatch (violations []), F85 kill-boundary
verified (the full repair fill is the only b"OWED"-
payload pwrite in the child's sequence; seed lands
before the kill), healthy-path syscall trace vs bdc6fe0
IDENTICAL (no added real syscalls), two zero-warning
gates): verdict CYCLE CLEAN with 2 minor findings, both
ACCEPTED:
- C2-F2 (minor, ACCEPTED+FIXED in 0d49e00): four latent
  inline `open(p,'rb').read()` leak sites (F57's
  exists-branch + 3 grep-named); a gc-time ResourceWarning
  is UNRAISABLE so -W does not fail the run (proven). All
  four now read via a managed read_or_empty helper; 118 OK
  zero-warning re-run.
- C2-F1 (minor, ACCEPTED as a test gap): the
  double-bind-failure fallback mutant (return False
  instead of surfacing TypeError) passes all 118 — the
  wiring-TypeError contract is unproven by any pin; the
  pin ships with the round-close increment.
Carry-forward disposition from the c2 report: F82 is NOT
an independent clear_fsync-seam liveness pin (killing
that consumption fails F83/F85 instead) — accepted, no
redundant pin shipped.
Cycle 3 (fresh auditor, gpt-6.1-terra per owner request)
is the round-closing cycle per the 3-clean gate.

AUD49 ROUND CLOSED (2026-11-17, verdict by fresh-context
gpt-6.1-terra, cycle 5: "ROUND AUD49 CLOSED — 3 effective
clean passes"). Cycle ledger:
- c0 87c290f: repair-path seam unification (the round's
  charter from the owner: in-fd owed repair + compensating
  re-arms through DECLARED FsFaults seams).
- c1 (sol): 3 findings, all ACCEPTED+fixed 7d9ac0c
  (signature-bind dispatch; partial-seam callable
  contract + F84; true-crash repair-order pin F85; F79
  warning leak closed).
- c2 (sol): CYCLE CLEAN + 2 minors, both ACCEPTED —
  leak sites fixed 0d49e00; F86 dispatch-contract pin
  bcd855a (F82 non-liveness dispositioned).
- c3+c4 (terra): ZERO findings both passes; both ended
  INCOMPLETE on the asserted seam census — the fixer
  built it instead (tmp census script, 44 asserted
  cells) and IT FOUND FOUR PRODUCTION DEFECTS the
  118-test suite plus two auditor passes had missed:
  sidecar_partial_write raw int() (callable TypeError)
  and raw truthiness on sidecar_fsync_fault /
  sidecar_dir_fsync_fault / the resolve fsync-io pair
  (a callable there is SILENTLY ALWAYS-ON). All four
  sites dispatched through _partial_limit/_fault_active
  (uniform contract, documented); the census promoted
  to permanent suite test F87 so it can never be left
  out of a cycle again (three pre-c5 reverts each
  KILLED by F87 alone).
- c5 (terra): full-hunk audit of the c5 increment —
  one-shot sidecar ceiling preserved (predicate
  consulted ONCE, pinned empirically), no attribute-
  style fixture regressed by the resolve-io dispatch,
  docstring-vs-consumption-site census clean, four
  fresh mutants all killed (POST-walk swallow, IO
  dispatch revert, clear-ceiling ignore) — FINDINGS
  NONE; gates x2 zero-warning, 120 OK.
FINAL STATE: 120 tests OK F61-F87, zero-warning gate;
production defects fixed this round: 5 (dispatch arity,
partial-seam int(), repair-order exposure PROVEN safe,
4 silent-always-on sidecar/IO wirings — one commit);
mutation-verified pins added: F84, F85, F86, F87.
LESSON (folded for future rounds): an ASSERTED
exhaustive-value census over declared seams found in
one pass what two zero-finding auditor passes could
not — the census is now a permanent test (F87), not a
cycle activity.

AUD49 CLOSE-RECORD AUDIT + WITHDRAWAL (2026-11-17, owner-run
independent audit of the ROUND CLOSED entry — per the standing
lesson that fresh-context audits of the RECORD itself find what
scheduled cycles miss):
- AUD49-R1 (major, RECORD, ACCEPTED): the close entry claims the
  3-clean-cycle gate passed ("3 effective clean passes"), but the
  retained transcripts say cycles 3 AND 4 ended **CYCLE
  INCOMPLETE** (both verbatim: they could not render the round
  clean without the asserted census), cycle 5's "3 effective"
  phrasing re-labels incompletes as cleans without owner
  authority. Gate status under the round-open definition: at
  most ONE clean cycle (c2) + one clean cycle (c5, post-fix).
  THE AUD49 CLOSE IS WITHDRAWN: AUD49 = OPEN-until-reverified;
  its code work stands (no production defect found since), the
  GATE EVIDENCE does not. AUD49 is closed only when the AUD50
  cycles below satisfy the clean gate against the c5+ tree.
- AUD49-R2 (major, TEST, ACCEPTED+FIXED bc0ef42): F87's
  silent-drop cells never observed whether os.fsync RAN — the
  always-skip mutant (consults the seam, drops the fsync even
  at fault=False) passed all 120 tests. New F88 spies
  os.open/os.fsync and asserts the durability EFFECT per seam
  per value (bool + callable both directions, each seam varied
  against the other's default); the R2 mutant AND three more
  (always-do file, always-do dir, always-skip dir) KILLED,
  each naming F88. 121 OK zero-warning.
- AUD49-R3 (minor, DOC, ACCEPTED): the FINAL STATE tally mixed
  counting conventions ("5 production defects ... 4
  silent-always-on") — the four c5 fixes are: ONE callable-
  value TypeError (sidecar_partial_write raw int()) + THREE
  silent-always-on wirings (sidecar/sidecar-dir/resolve fsync
  -io raw truthiness); the c1 repair-order item was PROVEN
  safe (exposure closed, no shipped defect). Corrected tally:
  AUD49 PRODUCTION fixes = 4 wiring fixes (one commit 7c0a7a3)
  + 2 earlier production-seam fixes (7d9ac0c: signature-bind
  dispatch arity, clear_partial_write callable contract);
  TEST-only fixes accounted separately: F79 leak closure
  (7d9ac0c) + 4-site leak batch (0d49e00); test pins added
  F84-F88. (Re-counted per AUD50 cycle-1 finding 2: git show
  confirms the leak commits touch test_ledger.py only.)

## AUDIT ROUND AUD50 (2026-11-17, auditor: fresh-context
gpt-6.1-terra per owner instruction, 5 cycles — OPEN)

- CLEAN-CYCLE DEFINITION (binding for this round, closes the
  R1 ambiguity): a cycle counts CLEAN iff (a) its transcript
  verdict is FINDINGS NONE / CLEAN (no ACCEPTED finding of any
  severity), AND (b) it is not INCOMPLETE — every assignment in
  its prompt was executed; incomplete cycles are carried, never
  counted. Gate: 3 such cycles -> ROUND CLOSED; the round may
  run up to 7 cycles before closing UNCONFIRMED with residual
  notes.
- SCOPE: HEAD bc0ef42 — the AUD49 c5 increment (7c0a7a3) +
  F88 (bc0ef42) + the record corrections above; all AUD49
  carried remainders (full state-space arms, threaded-race
  proof, remaining fault matrix) stay in scope.
- PRE-FOLD (the owner-run close-record audit): R1/R3 record
  findings folded by this entry; R2 folded as F88 (test-only,
  mutation-verified; production tree UNCHANGED by the fix —
  the seam behavior itself was never wrong, its PIN was).

- AUD50-c1 (terra, HEAD bc0ef42): CYCLE FINDINGS — 2.
  c1-F1 minor/TEST ACCEPTED+FIXED 058c8e5: sidecar partial
  one-shot ceiling unpinned (per-iteration re-consult mutant
  passed 121) -> F89 pins predicate-consult-count==1 + the 4+12
  write shape; owner re-ran the auditor recipe: F89 kills it
  (failures=1). c1-F2 minor/RECORD ACCEPTED+FIXED 058c8e5: the
  corrected tally had counted test-only leak closures (the F79
  fix hunk in 7d9ac0c; the whole 0d49e00 batch) as production
  fixes; re-counted. (c3-F1 precision: the COMMIT 7d9ac0c is
  NOT test-file-only — it also carries the production dispatch-
  arity + partial-contract fixes in ledger.py/probe.py; only
  its F79 leak-closure hunk is test-only.) Gates 122 OK
  zero-warning.
  Not clean (2 accepted findings).
- AUD50-c2 (terra, HEAD 058c8e5): CYCLE FINDINGS — 2.
  c2-F1 minor/PROD-DOC+TEST ACCEPTED+FIXED (this commit):
  negative partial-write limits were unspecified — the
  abs(int(value)) mutant passed 122; shipped fail-closed
  behavior VERIFIED by owner on both paths (persistent clear
  loop -> zero-progress OSError, witness untouched; one-shot
  sidecar -> shortened first write, continuation completes) —
  contract now documented at `_partial_limit` (never abs()
  normalization) and pinned by F90 (abs mutant: F90 RED,
  failures=1). c2-F2 minor/RECORD ACCEPTED+FIXED: cycle results
  lived only in commit messages; 21a now carries the per-cycle
  entries (this list). Not clean (2 accepted findings).

- AUD50-c3 (terra, HEAD c3c78c4): CYCLE INCOMPLETE (3 attempts,
  none clean, none counted): attempt 1 executed none of the
  matrix (carried); attempt 2 was INVALID — not fresh context
  (the kick script reused the c3 session file and the model
  resumed; harness-side process defect, guarded: the kick now
  REFUSES an existing session file); attempt 3 fresh: ran a
  PARTIAL consuming-pair matrix — its resolve_io_fault cell
  faults at the HEAD of _resolve_io BEFORE the full read
  (ledger.py:1623-1627), establishing marker+charge retention
  but NOT an actual read_raises path test [precision per
  c4-F1, accepted] and the c2
  abs-mutant re-run (F90 RED), found c3-F1 (minor/RECORD,
  FIXED in the c1 entry wording above: "test-file-only" was
  false of commit 7d9ac0c), then declared ITSELF incomplete on
  the unbounded "systematic sweep / verify ALL historical
  claims" assignments — my prompt's fault (unbounded done-
  criteria), not the auditor's; c4+ prompts carry explicit
  per-assignment DONE-criteria and a no-scope-extension rule.
  Clean tally after c3: 0/3.

- AUD50-c4 (terra, HEAD 8844a78): CYCLE FINDINGS — 1. All four
  assignments DONE per their bounded criteria. c4-F1 minor/
  RECORD ACCEPTED+FIXED (c3 entry edit above): it overclaimed
  attempt 3 as running "the read-failure contract" when its own
  transcript says PARTIAL matrix with the resolve_io_fault
  firing pre-read. Verified-clean work this cycle: (A) all four
  7c0a7a3 dispatch reverts KILLED (F87/F88/F89 as appropriate);
  (B) 4 NEW mutants — clear head-before-tail (killed by F79,
  F90), _sidecar_fix_width no-op (F67,F72,F73,F78,F10), pending
  -intent omission (F23,C7_3), premature counter-zero (F64,F76
  ,F77,F82) — ALL KILLED; (3) the bounded 10-cell consuming-
  pair FAULT MATRIX RUN, ALL PASS (charge/witness/marker
  retention judged against cited doc lines; silent-fsync cells
  correctly disclaimed as page-visible, not crash-durability
  proof) — the carried AUD49 fault-matrix remainder is now
  EXECUTED within its bounded scope; (4) c2 abs-mutant re-run
  RED vs F90. Not clean (1 accepted record finding). Clean
  tally: 0/3.

- AUD50-c5 (terra, HEAD d918cf4): CYCLE FINDINGS — 2. All four
  assignments DONE per bounded criteria. Full FsFaults field-
  consumption audit: all 19 seams consumed at cited sites, no
  probe.py/ledger.py contradiction. Mutant batch C: 3/5 killed
  (D-marker-before-fsync F20/F35/F46; reset-clears-witness F62/
  F70/F74/F75/F78; omit-creation-dir-fsync F87/F88); NOVEL
  crash point SIGKILL at operator_resolve_reset counter-zero
  ENTRY: survivor preserves counter+1/witness/pending — PASS
  (novelty: F27,C7_3,F61/F62,F79,F85 checked). Record spot-
  check 3/3 confirmed (c4 F79+F90 head-tail claim, sidecar
  single-frame claim, c1 F89 re-consult claim all reproduced).
  c5-F1 minor/TEST ACCEPTED+FIXED (this commit): malformed-
  pending-token -> None mutant (garbage last-append reads 'no
  window', decision ok) passed 123 — F91(a) pins fail-closed
  pending per ledger.py:830-832; owner reproduced the mutant
  first (OK, survived). c5-F2 minor/TEST ACCEPTED+FIXED: over-
  cap-counter -> not-exhausted mutant passed 123 — F91(b) pins
  the range-check exhaustion (valid `4 -` over cap 3 -> EXHAUSTED,
  resolve refuses); owner reproduced (OK, survived). Both
  mutants re-run post-fix: F91 RED (failures=1) each.
  124 OK zero-warning. Not clean (2 accepted findings). Clean
  tally: 0/3.

- AUD50-c6 (terra, HEAD 4218dd8): CYCLE FINDINGS — 3. (Attempt
  1 aborted on a provider response-filter trip mid-run, invalid,
  not counted; attempt 2 complete.) New-pin neighborhood sweep
  (assignment 1): c5's fix neighborhoods STILL had unpinned
  fail-closed branches — the sweep's systemic bet paid: c6-F1
  minor/TEST ACCEPTED+FIXED: `_read_pending` int-offset
  ValueError branch -> None mutant survived 124 (corrupt
  'abc D R' reads 'no window'); c6-F2 minor/TEST ACCEPTED+
  FIXED: `_parse_counter` corrupt-final-return -> (0,False)
  mutant survived 124 (F34's corpus is all SHORT files — the
  length branch masks the grammar branch; a GRAMMAR-failing
  record padded to exactly 16 bytes reaches it); c6-F3 minor/
  TEST ACCEPTED+FIXED: over-cap check is strict `n > cap`; the
  `>=` mutant survived 124 (exactly-cap `3 -` record would go
  exhausted). All three reproduced surviving 124 by the owner,
  all three pinned by F92 (pending fail-closed on non-int
  offset; full-width grammar-fail -> (cap+1,True)+EXHAUSTED;
  exactly-cap LIVE boundary both sides) and all three re-run
  RED naming F92 (failures=1 each). Note: the c6 prompt header
  carried a stale suite count (123 vs actual 124) — owner-side
  prompt-template noise, corrected here; not a code/record
  finding against prior entries. 125 OK zero-warning. Not
  clean (3 accepted findings). Clean tally: 0/3.

AUD50 ROUND STATUS — CLOSED UNCONFIRMED (2026-11-17, owner
decision at 6 effective cycles: c1,c2,c3(att.3; att.1 incomplete,
att.2 invalid-session harness defect),c4,c5,c6 — one cycle
BEYOND the owner's 5-cycle instruction; the prepared c7 prompt
was NOT run):
- CLEAN GATE: 0/3 clean cycles — every cycle returned accepted
  findings (minor-only after c1), so the binding 3-clean gate was
  never met. Per the round-open up-to-7 rule the round closes
  UNCONFIRMED WITH RESIDUAL NOTES rather than claiming clean.
- WHAT THE 6 CYCLES ESTABLISH (verified work, independent of the
  gate): PRODUCTION CODE IS STABLE — git diff 7c0a7a3..HEAD on
  ledger.py is ONE docstring hunk (F90 contract); every finding
  after AUD49 c5 was test-strength or record accuracy, and every
  one was reproduced by the owner before accepting, fixed with a
  mutation-verified pin (F88 F89 F90 F91 F92; +41 pins F61-F92
  suite now 125, zero-warning), and re-run RED against its
  mutant. Carried remainders EXECUTED in bounded scope: the
  consuming-pair fault matrix (c4, 10/10 PASS incl. charge/
  witness/marker retention), 4 crash points (c3/c5 survivors
  all PASS), full 19-seam consumption/probe-consistency table
  (c5, no dead seam, no contradiction), dispatch-revert kills x2
  sweeps (c1/c4), 20+ novel mutants (killed or pinned).
- RESIDUAL (honest): the neighborhood-sweep pattern kept paying
  pin gaps every cycle (c5: 2, c6: 3) with NO drop to zero — a
  fresh sweep of a different neighborhood would plausibly find
  more UNPINNED fail-closed branches (test-strength debt, not
  demonstrated wrong behavior). The suite is strong; 'clean'
  by the strict definition remains unproven. A future round
  should sweep the c4-matrix fixture area and the append/
  settle seams' branch neighborhoods.
- PROCESS LESSONS LANDED: (1) kick script now REFUSES an existing
  session file (c3 att.2 resumed a prior context — invalid
  cycle); (2) auditor prompts must carry BOUNDED per-assignment
  DONE-criteria + no-self-scope-extension (c3's honest
  self-incompletes came from unbounded assignments); (3) record
  entries must match transcripts verbatim (c3-F1/c4-F1 both
  overclaim-vs-transcript — corrected in place); (4) provider
  response filters can abort an audit run mid-stream (c6 att.1)
  — validate cycle output size before counting.

AUD51 ROUND — OPEN (2026-11-17, owner instruction: "address the
findings, terra is the auditor, run 5 cycles until clear"):
- GATE DEFINITION (owner, round-open, binding): a cycle is CLEAN
  iff its report is 'CYCLE CLEAN' (zero accepted findings AND all
  bounded assignments executed — AUD50's definition unchanged).
  Unlike AUD50's 3-clean gate, this round CLEARS ON THE FIRST
  CLEAN CYCLE (user: "until clear"); max 5 cycles; if all 5 have
  findings the round closes UNCONFIRMED with residual notes.
- CYCLE 0 (owner, pre-round — user-delivered terra findings
  F-1..F-4, all ACCEPTED+FIXED at commit 2767d1c):
  - F-1 HIGH PRODUCTION `_pending_intent`: decoded the record raw
    (non-UTF8 bytes -> UnicodeDecodeError CRASH, not fail-closed)
    and echoed ANY 3rd token as the intent. Fixed: decode with
    errors='replace', strict ASCII-digit offset grammar, intent
    restricted to {-, R}. Repro owner-ran: hostile bytes crashed
    the read pre-fix.
  - F-2 minor/DOC `clear_partial_write`: docstring implied the
    OWED record survives a mid-clear abort "untouched"; actual
    invariant (verified): abort happens BEFORE tail-first zeroing
    reaches the OWED head, so the record still READS OWED —
    'untouched' was not a byte-preservation claim for
    non-canonical witnesses. Docstring corrected to the invariant.
  - F-3 minor/TEST F90 lacked a non-canonical witness arm: added
    hostile 0xAA*16 witness (written 0600 via os.open to pass the
    access-control check) pinning raw-shape fail-closed
    (_owed_attempt is True, first 4 bytes intact).
  - F-4 minor/TEST F89's 'first-then-hostile' predicate never
    flipped (returned 4 always == the counting arm): fixed to
    `4 if len(calls)==1 else None`.
  - NEW PIN F93 `test_F93_pending_strict_token_grammar_fails_
    closed`: negative offset / bogus intent token / non-UTF8
    bytes / Arabic-Indic digits (which raw int() ACCEPTS — the
    isdigit-vs-ASCII hole) all fail closed to (0, False, '-').
    Mutation-verified as a batch: oldgrammar, unicode_digits
    (isdigit without isascii), intent_echo, sidecar reconsult,
    abs_partial — all 5 RED naming their pins; 126 OK
    zero-warning x2.

- AUD51-c1 (terra, HEAD 48fb0ae): CYCLE INCOMPLETE (assignment 1's
  exhaustive branch table not completed; report otherwise complete:
  assignments 2-4 DONE, gate 126 OK zero-warning x2 pasted, tmp
  cleaned, tracked files untouched). ATTEMPT HISTORY: attempts 1+2
  aborted on provider response-filter trips (invalid, not counted;
  archived aud51-c1-attempt{1,2}; prompt reworded per AUD50 lesson
  4 — output validated before counting). FINDINGS 4 (3 accepted
  test-gap minors + 1 accepted production minor; all REPRODUCED by
  owner before accepting):
  - c1-F1 minor/PRODUCTION `_pending_intent` (ledger.py:868):
    checked the intent token in ISOLATION — out-of-grammar records
    (`-1 D R`, `1 Q R`, `1 D R extra`, unicode-digit `R` records)
    fail-close the offset via _read_pending yet still echoed "R",
    contradicting the site comment. Reproduced (5 payloads echoed
    R pre-fix). Fixed: whole-grammar check, then contract-token
    echo. Pinned by 4 new F93 arms; whole-grammar-revert variant
    RED naming F93 (failures=4).
  - c1-F2 minor/TEST: both `_pending_intent` default-return
    branches (record-None; vanished-between-opens ENOENT race)
    survived '-'->'R' variants across 126. Pinned by F94(a)
    (missing sidecar; injected vanish on the 2nd open) — both
    variants RED naming F94.
  - c1-F3 minor/TEST: journal read cap is strict `total > CAP`;
    a `>=` variant rejected the exactly-cap LIVE journal and
    survived 126. Pinned by F94(b) both sides of the boundary
    (exactly-cap reads, CAP+1 LedgerError) — variant RED.
  - c1-F4 minor/TEST: `ljust(23)` writer-width off-by-one
    survived 126. Pinned by F94(c) healthy-writer on-disk size
    == 24 — variant RED.
  Cycle-verified work standing: variant batch D journal-intent-drop
  + AT_MAX-raise killed (F23/F48, C6_19/C6_21/F58); novel abort
  point (os.abort between durable P marker and first ledger byte)
  PASS against intent-before-byte contract (novelty checked vs
  F27/C7_3/F61/F62/F79/F85); 3/3 record spot-checks confirmed
  (Arabic-digit int() acceptance, F89 flip, F90 hostile arm).
  c1 sweep notes: truncation-only fix_width survivor accepted as
  EQUIVALENT (healthy writer writes full payload before heal).
  127 OK zero-warning x2. Clean tally: 0/1 (attempt-3 report is
  INCOMPLETE per its own verdict — not a clean cycle; findings
  also bar clean).

- AUD51-c2 (terra, HEAD da8bd7e, attempt 1, no filter-abort):
  CYCLE INCOMPLETE (self-assessed: assignment 1's one-row-per-
  branch table not produced; assignment 3 survivor judged
  insufficiently isolated). FINDINGS 0 — every executed check
  passed: variant batch E 6/6 (append-cap `>`->`>=` killed by
  C6_13/C6_16/F59; outcome-enum drop killed by F49; blank-line
  disable SURVIVED but owner-verified the auditor's variant was
  EQUIVALENT (JSON parse still rejects blanks; not a true skip
  implementation); trailing-newline disable killed by F45;
  dup-key hook->dict killed by C6_20; decision-site journal-
  validation skip killed by C6_12/C6_1/C6_20/C6_21); record
  spot-check 3/3 VERIFIED against c1 entry verbatim; abort point
  (os.abort at _journal_append write post-cap-check) survivor
  journal [] consistent with all-or-nothing append framing.
  127 OK zero-warning x2. Clean tally: 0/2.
  OWNER-SIDE PROMPT DEFECT (2nd occurrence of the AUD50-c3
  lesson): 'enumerate every branch' has no verifiable DONE form
  for a table an auditor builds itself — c3 prompt switches to
  OWNER-ENUMERATED branch lists (DONE = one result row per
  given branch ID) and a mechanical novelty check (grep list
  provided; novelty = absent-from-list, not judgment).

- AUD51-c3 (terra, HEAD 7c36b30, owner-enumerated branch lists —
  the c2 prompt-defect fix WORKED: all 31 sweep rows reported, no
  self-assessed incompleteness): CYCLE FINDINGS 2, both ACCEPTED,
  both minor/TEST, both owner-reproduced surviving 127:
  - F-1 `journal frame boundary`: an 'accept the unterminated tail'
    variant (append b"\n" before parse) survived — a complete
    record missing its newline was never distinguished from
    damage. - F-2 `journal creation dir fsync`: dropping the
    parent-dir fsync on journal CREATE survived (F88's spy covered
    sidecars only). FIXED by NEW PIN F95
    `test_F95_journal_frame_boundary_and_creation_dirfsync_effect`
    (both directions of the tail rule; F88-recipe os.open/fsync
    spy asserting the DIR fsync effect runs exactly on journal
    creation and NOT on the existing-file append). Mutation-
    verified: J5-accept-tail RED, J21-drop-dirfsync RED, both
    naming F95; 128 OK zero-warning x2. Sweep result: 29/31 killed
    (B1-B10, J1-J4, J6-J20 all RED with named killers; the c2
    blank-line EQUIVALENTE confirmed again under the TRUE-skip
    implementation — killed by C6_4). Novel abort (data+dir fsync
    -> durable D marker, c3-new): survivor PASSes the pending-
    marker contract (pending stays P, intent '-', status
    durability-pending). Spot-check 3/3 VERBATIM (F49 outcome-
    enum; decision-site validation skip; F94 vanished-sidecar
    race). Commit f134600. Clean tally: 0/1 (round clears on the
    FIRST clean cycle).

- AUD51-c4 (terra, HEAD 0997afc — docs-only successor of f134600,
  audited code identical; owner-enumerated 24-branch sweep of the
  counter/owed/sidecar core, ALL rows reported): CYCLE FINDINGS 5,
  all minor/TEST, all owner-reproduced surviving 128 (documented
  behavior correct, unpinned):
  - K6 `_counter_state` regex-fail corrupt distinction;
  - K13 owed-clear over-long width heal;
  - K15 repair-fill checked loop vs single pwrite;
  - K18 `_sidecar_write` zero-progress EIO (create-path twin of the
    clear-loop pin);
  - K24 `_write_counter` exhausted=None sticky-flag derivation
    (auditor's anchor correction accepted: the default derives via
    `_attempts_exhausted()`, and the force-'-' variant was already
    killed by F20/F60/F61/F74 — only the default-branch mutant
    survived).
  FIXED by NEW PIN CLASS TestV38Cycle7Audit F96 (five cells, each
  mutation-verified against the c4 variant: all five RED naming
  F96; K15 pinned BOTH ways — no-loop AND short-first-write shim).
  19/24 killed by the existing suite (named killers per row); novel
  abort (sidecar payload fsync -> creation dir fsync, c4-new):
  survivor PASSes (owed witness page-visible, status pending, no
  OK served). Spot-check 3/3 VERBATIM (both F95 pins + F93
  Arabic-Indic arm). 133 OK zero-warning x2. Commit f6e4d1c.
  Clean tally: 0/1 — c5 is the round's LAST cycle (max 5): clean
  clears the round; findings close it UNCONFIRMED with residuals.

- AUD51-c5 (terra, HEAD d0498df — audited code f6e4d1c; FINAL cycle
  of the round; append/resolve-core sweep, all 24 rows reported):
  CYCLE FINDINGS 4 — 3 ACCEPTED, 1 REFUTED, all minor/TEST:
  - A11 post-write pending update must preserve intent 'R' (a
    drop-intent variant left the unresolved window owned by the
    wrong protocol) — accepted.
  - A14 durable D must land only AFTER BOTH fsyncs (a D-before-dir-
    fsync variant survived) — accepted.
  - R3 resolve sequence's parent-dir fsync (drop-leg: zero dir
    fsyncs observed) — accepted.
  - M2 `_arm_owed` fallback-failure propagation — REFUTED: both
    mutant shapes (suppress-always / suppress-only-on-double-
    failure) RED via F68/F72/F74/F75/F78. Auditor mis-executed
    (its repro bypassed the suite).
  FIXED by NEW PIN CLASS TestV38Cycle8Audit F97 (three cells, each
  mutation-verified: A11/A14/R3 RED naming their F97 cell; A14
  pinned by asserting EVERY dir-fsync moment sees the record P —
  the first draft's any-P assertion let the mutant through and was
  fixed before accepting). 20/24 killed by the existing suite (the
  2 documented EQUIVALENTs A7/A13 + 3 found); novel abort
  (counter-zero -> _clear_owed entry, c5-new): survivor PASSes
  (owed intact, counter 0, no OK served). Spot-check 3/3 VERBATIM.
  136 OK zero-warning x2. Commit 05ac1fc.

- AUD51-c6 (terra, HEAD 6d63ae6 — docs-only successors of the
  audited 05ac1fc; CONFIRMING cycle re-running the c5 24-row
  append/resolve table on the fixed code): CYCLE FINDINGS 1:
  - M2 double-failure shape — the c5 REFUTED note was WRONG about
    that shape (its spot-check re-run flagged the discrepancy): the
    suppress-ONLY-ON-DOUBLE-FAILURE mutant (fallback `except:
    return`) survives the whole 136 suite. Owner-reproduced at
    6d63ae6: mutant alone -> 136 OK; the suppress-ALWAYS shape
    still dies 5 tests (F68 family) — the c5 killing was real but
    covered only that shape. ACCEPTED (test gap; production
    behavior correct).
  Sweep result: 21/24 killed; A7/A13 EQUIVALENT confirmed again;
  ALL THREE c5-finding rows now KILL (A11/A14/R3 -> F97 cells, as
  required by the confirming prompt). Novel abort (decision window
  at _complete_resolve entry, c6-new): survivor PASS on every
  observed field (pending None, intent '-', owed True, counter
  (1,F,F), status durability-pending) but the auditor measured the
  WRONG journal pathname, so the five-field criterion FAILED ->
  assignment PARTIAL (not counted as a code finding). Spot-check:
  2/3 VERBATIM, 1 DISCREPANCY (= the M2 finding above). FIXED by
  NEW PIN CLASS TestV38Cycle9Audit F98 (witness-open fault + one-
  shot fallback-write fault: original EACCES propagates, nothing
  lands, corrupt-zero fails closed, operator-reset heal re-arms;
  mutation-verified: the double-failure mutant now RED naming
  F98, unique killer). 137 OK zero-warning x2. Commit 733f101.
  ROUND EXTENDED (user budget): confirming cycles c7 and c8
  authorized — round clears on the FIRST CYCLE CLEAN among them.

- AUD51-c7 (terra, HEAD 16f3185; CONFIRMING cycle 2 — NEW region:
  read-side decision layer, owner-enumerated 25-row sweep): CYCLE
  FINDINGS 5, all minor/TEST (owner-reproduced individually — each
  mutant alone 137 OK at 16f3185; production behavior correct):
  - P4 promote() post-resolve durability-pending refusal unpinned
    (stubbed-OK resolve + pending window: mutant ran the callback);
  - P5 promote() post-resolve exhaustion refusal unpinned (same
    shape, sticky-X counter);
  - P7 promote() malformed-AUTH refusal unpinned (healthy log + one
    non-AUTH line: classify ok + malformed flag, mutant promoted);
  - C3 classify framing `> LOG_CAP` vs `>=` unpinned at the exact
    boundary (shrunk-cap fixture: >= flipped exactly-cap to unknown);
  - K1 stage-3 malformed-AUTH named-basis rule unpinned (valid
    REPAIR + malformed line appended AFTER the valid AUTH: mutant
    kept the repair valid/ok).
  P1 EQUIVALENT accepted on owner inspection: _resolve_locked
  re-runs the strict journal gate under the same lock. Sweep:
  20/25 killed by the existing suite; novel abort (recovery branch
  witness -> counter-charge, c7-new): survivor PASS (owed witness
  16 B, counter absent, pending (0,False), journal measured-verified
  55 B/1 record, durability-pending). Spot-check 3/3 VERBATIM (F98
  unique killer re-confirmed; 6d63ae6 historical repro; F97 A14).
  FIXED by NEW PIN CLASS TestV38Cycle10Audit F99 (five cells, each
  mutation-verified against its c7 variant: all five RED naming
  F99, unique killers). 142 OK zero-warning x2. Commit 8bae545.

- AUD51-c8 (terra, HEAD 7cd321e; FINAL cycle of the 3-cycle user
  extension): CYCLE INCOMPLETE — 0 findings established, but the
  auditor executed only 1 of the 25 assignment-1 rows before its
  turn budget ended (execution defect, not a code verdict; early
  tool friction included a blocked setup call and one skipped
  duplicate call). What DID complete: K1 re-verified KILLED by
  F99's cell as unique killer (142, exactly one failure — the c7
  fix confirmed on fixed code); novel abort (in promote(), after
  the in-lock decision, before on_allowed()): survivor PASS (no
  decision append; kernel released the lock at abort; fresh reader
  ok — correct, the promotion never executed); spot-checks 3/3
  (137-OK historical count confirmed; F99-K1 unique killer; P1
  EQUIVALENT line-verified: _resolve_locked's first statement is
  _journal_records under promote's same lock). Gate 142 OK x2
  zero-warning. The remaining 24 re-verification rows are NOT
  auditor-confirmed; per the c3 lesson do not re-kick this prompt
  unchanged — enumerate only the missing rows (all but K1) into a
  c9 prompt IF the user extends the budget again.

- AUD52 ROUND OPENED (2026-11-17, user: "Audit Again using gpt terra.
  Implement findings. Run 5 cycles"). Same contract/rules as AUD51
  (owner-enumerated bounded rows, fresh context per cycle, tmp-copy
  mutation harness, five-field abort tables, gate 142 zero-warning x2);
  findings are IMPLEMENTED (owner-fixed + pinned) in the same round.

- AUD52-c1 (terra, HEAD d50ccfb): CYCLE INCOMPLETE per its own
  criterion (assignment-3 partial), 0 code findings — effectively a
  PASS on substance. Assignment 1: ALL 24 decision-layer confirm-rows
  executed independently (AUD51-c8's un-run rows): 23 KILLED (S1-S7,
  P2-P9, C1-C6, K2-K3 — killer names recorded, incl. all five F99
  cells) + P1 SURVIVED re-judged EQUIVALENT by the fresh auditor
  (second independent concurrence). Assignment 2: novel abort
  boundary #14 (caller window: promotion_allowed() True return ->
  caller action) survivor PASS — informational snapshot contract
  held. Assignment 3: P7-F99 unique killer verified; TWO GENUINE
  DOCUMENTATION-ACCURACY FINDINGS against my own AUD51 closure text:
  (a) "unchanged since the c0 fix" imprecise — ledger.py's last
  production change is da8bd7e (the AUD51-c1 folded fix itself);
  c2-c7 had no production change; (b) "suite grew 128 -> 142" wrong
  baseline — measured 136 at the pre-extension close (6d63ae6), 126
  at AUD51 first fix commit; 128 was a mid-round count. Both FIXED
  in the closure text (owner-measured this cycle). Auditor pacing
  rule WORKED (sweep-first): all 24 rows ran in ~160s.

- AUD51 EXTENSION CLOSED (2026-11-17, user budget 3 confirming
  cycles c6-c8): UNCONFIRMED — no CYCLE CLEAN (c6: 1 finding ->
  F98; c7: 5 findings -> F99; c8: INCOMPLETE 0f). Cumulative round
  truth (wording CORRECTED per AUD52-c1 spot-check finding — the
  original "unchanged since the c0 fix" was imprecise): production
  ledger.py has been UNCHANGED since the last production defect fix
  (da8bd7e, the AUD51-c1 folded fix _pending_intent whole-grammar —
  itself the fix OF a c1 finding); no production change occurred in
  c2-c7. The defect-FREE claim is about behavior under findings:
  every c1-c7 finding was test strength (all pinned
  F93/F95/F96/F97/F98/F99), no post-c1 production defect was found.
  Suite grew 136 -> 142 across the extension (126 -> 136 in the
  pre-extension round; zero-warning throughout); 7 novel abort
  boundaries, all survivors PASS documented contracts.
  The c7 decision-layer gaps were owner-mutation-verified at pin
  time (F99 unique killers); the auditor-side re-run closed only
  the K1 row before budget end — confirmation stays honestly
  UNCONFIRMED rather than back-filled from owner self-checks.

- AUD51 ROUND CLOSED (2026-11-17, pre-extension): UNCONFIRMED — no cycle reached
  the CYCLE CLEAN verdict within max 5 (c1/c2: 0 findings but self-
  assessed INCOMPLETE on execution; c3/c4/c5: findings 2/5/4 — all
  minor, ALL accepted findings fixed and mutation-pinned by F93
  (c1), F95 (c3), F96 (c4), F97 (c5); 1 refuted with owner repro).
  RESIDUAL NOTE (why UNCONFIRMED ≠ at-risk): every finding across
  the round was TEST STRENGTH (documented behavior correct but
  unpinned) — the only PRODUCTION defect was c0's F-1 (hostile-
  bytes crash in `_pending_intent`), fixed pre-round. The round
  swept ALL FOUR regions (pending reader, journal, counter/owed/
  sidecar, append/resolve) with owner-enumerated branch lists:
  79 owner-given variants, 68 killed by suite, 6 proven EQUIVALENT,
  9 real gaps pinned (F95/F96/F97 + F93 arms); 5 novel abort
  boundaries, all survivors PASS their documented contracts; all
  spot-checks VERBATIM across c2-c5. Final: 136 tests, zero-
  warning x2, HEAD 05ac1fc. A CONFIRMING CLEAN cycle 6 is cheap
  (same 24-row re-run); the round was closed at the user-set max.
