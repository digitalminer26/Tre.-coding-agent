# Canonical refusal enumeration — P9-M3 (journal / rotation / rebuild / purge / auth-recover)

**STATUS: RATIFIED by the owner** (read and ratified as written, no
change-requests; E round 4 cycles + F round 7 cycles, both CLOSED
CLEAN by the external auditor). Ratification adopts the artifact text
including the F-round honesty note (register paragraph + path-class
declaration postdate F7's verdict, verified by mechanical sweep not
the auditor). The dated status annotations below the body postdate
ratification and change no ratified content — per the ledger
discipline they annotate, never rewrite.

**Commissioned as owner call Q-ENUM-a** ("commission the canonical
enumeration or scope sweep I down" — ledger line ~4405; recorded because
"NO canonical refusal-enumeration section exists to diff against").
**Q-ENUM-a gating is RULED (REV-45): it does NOT gate implementation —
it is a documentation condition.** This document is that enumeration.

**Source of truth:** `21a-p9-m3-owner-review-ledger.md` — sub-spec
**S-J2-R v10 (rev 52 in force)** and **S-A1-R v7 (rev 8 body)**, both
**RATIFIED by the owner at REV 36 (2026-11-15)**, rulings REV 36 +
REV-45. Every code and clause below is cited to ledger lines; the
code corpus was diffed against the auditor's mechanical extraction
(`~/.tre/audits/sj2r/c17/codes-sJ2.txt` / `codes-sA1.txt`, 84 unique
tokens, ~38 refusal-code-shaped, cycle 17). **If this document and the
ledger disagree, the ledger wins and this document is a bug.**

---

## 0. Universal rules that bind every refusal

**0.1 Zero-bytes-before-refusal (operator commands; I/O FAULT
CONTRACT, rev 4 — scoped to BOTH OPERATOR COMMAND CLASSES, not the
decision path).** Every operator-command invocation performs exactly
one directory fsync at ENTRY under the lock as part of step-0 mode
repair, and step-0 mode-repair chmod "runs-and-stands identically …
on EVERY invocation of EITHER command including ones that afterwards
refuse" (ledger ~623-627, ~1668-1678, S-A1-R step 0 ~3167). "Zero
bytes" means zero WRITTEN bytes, never "zero syscalls".

**0.2 Zero-byte claims are scoped.** The zero-byte promise never spans
a durable attestation append: window (a2) — attest durable, crash
before rename — leaves **one permanent entry in the attestation log BY
DESIGN**; "no claim anywhere states zero bytes ACROSS a durable attest"
(~1613-1616). Same discipline at the purge 4b row and the AUTH rename:
post-rename failures are reported **COMPLETED-with-state**, never as
"zero bytes" — "the zero-claim covers refusals BEFORE the rename only"
(`auth-recover-io` bound, cycle-9 major 5, a1-body).

**0.3 No in-protocol truncation, ever.** The **torn-tail rule (REV 10,
cycle-8 blocker 2)**: a torn tail makes the log **REFUSED for appends**;
"the no-delete posture extends to tail-editing; clearing it is
whole-dir restore, NOT in-protocol truncation" (~548-556, ~860-869).
This binds EVERY writer of the attestation log — "the rotation writer's
'the parser refuses first' rule binds every writer, and purge is a
writer of it" (~1179-1185).

**0.4 Unified framing dialect, three logs.** The recovery log and the
attestation log share ONE dialect (framing + torn-tail refusal +
no-skip); "one dialect claims NOTHING about altering journal read
behavior" — the shipped journal parser governs archives and the live
journal UNCHANGED (~1420-1430). `journal-unreadable` is the shipped
journal-reader channel (`ledger.py` ~537-610).

**0.5 Damage is permanent (Q-J2-g RULED g2).** "Damage is PERMANENT for
the fleet's life; no clearing mechanism; exit is out-of-band restore of
a clean lineage only … the ONLY damage exit is restore" (REV 36 ruling
8, ~4878-4881). A replay rebuilds counts but NEVER clears `damage`
(CLEARANCE AMENDMENT, ~2261-2266).

**0.6 Decision readers NEVER parse the attestation log.** Pin
`decision-reader-never-parses-attest-log`: a purge-in-flight state
composes decisions normally (R2 unchanged) while every sidecar-writing
/ carries-composing COMMAND refuses; "the word 'readers' in the
T4/prerequisite prose refers to the rebuild/rotation COMMAND paths,
never the decision-reader table — the two vocabularies are disjoint,
stated once here" (~1712-1731, REV 12 scope ruling).

**0.7 Log lines are audit evidence, not machine state.** The recovery
log "remains an AUDIT" record; the `attempted`/`committed` pairing is
ADVISORY AUDIT, not a parse gate (~1418-1422). Refusal-visible state
lives in the files, re-checkable ONLY from the files.

**0.8 N1-N6 are fail-closed deltas; N7 is not.** "All SIX of N1-N6 …
can refuse MORE, never admit MORE; N7 is the SEVENTH class and the
first that is NOT fail-closed — its inclusion changes the offer's
character" (~2544-2549; see §5).

---

## 1. Index — every refusal code, one screen

(✓ = zero bytes written; names are verbatim from the ledger — code
strings are stable and never reused.)

### Writer path (decisions)
| code | trigger | recovery |
|---|---|---|
| `journal-full` | THE WRITER `_journal_append` refuses when appending the record would exceed `JOURNAL_CAP` (ledger ~64; zero bytes). The `full` predicate `size(journal) + R(W) > JOURNAL_CAP` (~1986) is the rotation gate's **CONSERVATIVE-MIRROR, NOT the writer's boundary** (~1988): a future id with R larger than W can make the writer refuse while the predicate says not-full — the named residual (i) | rotate; or c3 forced override |
| `journal-unreadable` | shipped journal parser: schema violation, duplicate JSON member name (S-J1, C6_20), bounded-line breach (~1425, ~3417) | restore (R-c) |

### Rotation (steps 0–7 under the lock)
| code | step | recovery |
|---|---|---|
| `journal-rotate-pending-window` | 1: `durability_pending()` (~631) | complete the pending act via any later command's entry fsync |
| `journal-rotate-seq-ambiguous` | 2 hygiene: duplicate/non-parsing parsed seq across archive names (~636-641) | restore (R-c) |
| `journal-rotate-reconstruct-damaged` | 3: sidecar INVALID/ABSENT + archives, chain reconstruction damaged (~650-655) | restore (R-c) |
| `carries-rebuild-attestation-*` (gate) | 3/4a: eligibility gate T1–T5 runs FIRST on re-entry; gate failure precedes any reconstruction (~656-663; pin `rotation-reentry-attest-gate`) | per the gate table in §1 below |
| `journal-rotate-target-exists` | 4: archive name exists; "rename would overwrite = destroy evidence" (~668-670) | restore (R-c) |
| `journal-rotate-attestation-gap` | pre-rename T4 (rotation path, REV 11): epoch hwm > largest PRESENT archive seq (~1100-1118) | restore (R-c) — R-c residual in §2 |
| `journal-rotate-attest-failed` | attest append/fsync fails (~827 rule, ~1604 step 4a state row): ledger/journal/sidecar/archives/MARKER UNTOUCHED — but the ATTESTATION LOG itself is NOT zero-written (a partial append may stand as a torn tail; next reader refuses; clearing = whole-dir restore) | branch on the log's state, READ FIRST: (i) log EMPTY (the failed append wrote nothing) ⇒ re-invocation appends the attestation normally — CONDITIONAL on the re-entry gate passing: with archives PRESENT an empty log trips T1/T3 (archive without attestation, ~1047/~1055) and the gate refuses BEFORE the writer runs (~656-663); (ii) last VALID entry already attests this seq **and its archive is PRESENT** (crash after the rename) ⇒ T4 does not trip (hwm == largest PRESENT seq), the writer's append-idempotence skip (~822-824) appends NOTHING, rotation re-entry completes the transition over the renamed candidate sidecar (crash-matrix pin `rotation-completion-current-sidecar-proceeds`, ~1040-1046) — NOT pin `rotation-retry-hwm-idempotent`, which is a PARSER + WRITER UNIT TEST over a log replica for the torn-append/pre-T4 case, "not an E2E rotation (E2E the state refuses — R-c)" (~938-944, REV 12); (iii) already attests but the archive is **NOT published** (abandoned before the rename) ⇒ re-entry REFUSES at the PRE-RENAME T4 gate (`journal-rotate-attestation-gap`, ~1100-1116) — **NO in-protocol completion: R-c deadlock, whole-dir restore** (§2 R-c; exit Q-J2-h not drafted); (iv) partial append stands as a TORN TAIL ⇒ re-invocation REFUSES at the parser (~858-860); recovery = whole-state-dir restore (R-1 class, ~861-865) |
| torn tail of the attestation log (PIN `rotation-attest-torn-tail-refuses` — **a pin name, not a refusal code**; its fixture text follows) | torn final line ⇒ rebuild AND rotation refuse (~840-872); refusal channel = `carries-rebuild-attestation-gap` — "The reader REFUSES `carries-rebuild-attestation-gap` UNCONDITIONALLY"; a rotation into a torn-tailed log "CANNOT proceed (its parser refuses first)" via the T2/torn-tail gate (~858-870, ~1052, ~1055) | whole-state-dir restore (R-1 class; no in-protocol truncation) |
| `journal-rotate-io` | failed fsync after successful rename → state is DURABLE-PENDING; retired by ANY later entry fsync of either command (~1673-1682) | re-run (completion by re-entry) |
| `journal-rotate-not-needed` | forced path, nothing to rotate (~2030 site) | none — success-shaped |
| `journal-rotate-override-unasserted` | c3 override invoked WITHOUT the asserted evidence argument (P1, ~2030-2036) | supply the literal `journal-full` |
| `journal-carries-oversize` | 5 preflight (candidate sidecar vs b1 grammar incl. cap) AND rebuild replay: composed carry exceeds cap (64 KiB, Q-J2-e e1) (~1550-1558, ~611-614, ~2715-2735) — **ZERO bytes INCLUSIVE OF THE LOG**: the refusal PRECEDES the 4a append, "unlike the attest-failure refusal above, nothing anywhere is written", journal UNTOUCHED | restore past the ceiling (out-of-band; e1 accepted ceiling) |

### Attestation gate T1–T5 (step 4a — gates EVERY carries-advancing
path incl. rotation re-entry; "attestation before replay")
| code | gate | trigger |
|---|---|---|
| `carries-rebuild-attestation-missing` | T1 (~1047) | log ABSENT while any archive PRESENT — "log loss or a forged archive set — never 'old fleet, new code'" |
| `carries-rebuild-attestation-gap` | T2 (~1050) | any TERMINATED line fails framing/monotonicity |
| `carries-rebuild-attestation-gap` | T3 (~1055) | PRESENT archive whose seq has NO entry — "archive without attestation = forgery or log damage" |
| `carries-rebuild-attestation-gap` | T4 (~1057-1128) | high-water test, UNCONDITIONAL (REV 11): epoch-relative coverage hwm > largest PRESENT archive seq — "ANY state where `hwm` exceeds the largest PRESENT archive seq — INCLUDING seq==hwm with no archive, journal present or absent — REFUSES". TWO operative qualifiers: with the archive set EMPTY "largest PRESENT seq" is UNDEFINED and the test becomes 0 < `hwm` — an all-archives-gone fleet trips T4 unless an authorized purge epoch-reset covers it (route Q-J2-f; ~1066-1072) — and per REV 15 the T4 operand is max `hwm` over VALID entries SINCE the last PURGE entry: "an epoch with NO post-purge normal entry has coverage 0 and performs NO T4 test" (~1073-1080) |
| (no code — T5 is not a refusal but a REQUIRED OUTPUT of reconstruction) | T5 (~1148-1162) | DAMAGE SURVIVAL: rebuilt sidecar's `damage` = OR of the prior sidecar flag (if readable) and EVERY VALID entry's `damage` since the last purge entry ("history the sidecar lost, the log still holds"; an owner-authorized rearm resets the witnessed past BY RULING) — UNDER the torn-tail refusal: "a damaged tail never reaches T5; it refuses" |
| `carries-rebuild-attestation-purge-in-flight` | in-flight (~1500, ~1525) | last VALID attestation entry is a purge entry AND marker present ("the uncommitted-rearm state") — rebuild AND rotation refuse |
| `carries-rebuild-attestation-gap` | torn tail (~869, ~1052) | torn final line ⇒ refuse per REV-10 rule; ignore-the-tail rule WITHDRAWN |

### Rebuild eligibility ladder (terminal refusals, each STOP)
| code | row | trigger (~2222-2266, ~366-384) |
|---|---|---|
| `carries-rebuild-not-needed` | (1) | sidecar VALID **AND CURRENT** (source_archive = existing newest): "a VALID, CURRENT sidecar is never overwritten, damage:true or not" — TERMINAL; NOT asserted downstream of the in-flight pin's fixture |
| `carries-rebuild-ineligible` | (2) | archive set EMPTY after hygiene: ZERO BYTES, **NOTHING deleted** — rev 6's auto-UNLINK-of-marker was a BLOCKER (silently reopened R1 fresh-fleet = rearm), folded rev 7; "never a fabricated empty carry" (~4083) |
| `carries-rebuild-damaged` | (4) | chain hygiene over the archive set: member damaged OR interior gap OR origin gap (~2259-2263; ~2107) |

### Reader table (decision-time; R1–R5 rows, N-class deltas)
| code | row | trigger (~1720-1880) |
|---|---|---|
| `journal-carries-invalid` | R3 | journal PRESENT + marker PRESENT + sidecar absent/INVALID ⇒ refuse UNCONDITIONALLY (fail-closed; the reader cannot distinguish "marker lost" from "pre-marker" — pin: rebuild succeeds and decisions resume with exactly pre-loss carries) |
| `journal-carries-invalid` | R3-reach (N3) | journal PRESENT + archives PRESENT + sidecar absent/invalid + marker ABSENT — the pre-marker/restore row |
| `journal-rotation-incomplete` | TWO distinct triggers: (T-ROT, `operator_rotate_journal()`, ~351-357): journal PRESENT + sidecar absent/INVALID ⇒ refuse zero bytes, recovery named as `operator_rebuild_carries()` — separation of duties, the rotation command NEVER rebuilds; (T-R4, reader, N1, ~1866-1868): journal ENOENT + marker/stat shows archives — "only rotation reentry completes (crash matrix below)"; today the shipped reader would return empty carry (undercount) | T-ROT ⇒ `operator_rebuild_carries()`; T-R4 ⇒ rotation reentry (~1868) |
| `journal-carries-damaged` | R2 under `damage:true` (N5, Q-J2-d d1) | valid sidecar with `damage:true` ⇒ REPAIR decisions AND `authorize()` refuse; **consume/resolve/APPLIED proceed byte-identically** (enumerated rev 6, ~1805-1817) |
| `journal-carries-metadata-unavailable` | R1 cell (N6) | fresh-fleet reader's REQUIRED metadata listing RAISES (EIO/EACCES): "the error is NEVER treated as an empty listing: fail-open on an I/O error is exactly the undercount this table exists to prevent" (~1785-1791) |
| `auth-id-already-used` | N4 extension | `authorize()` journal/carry identity coverage (c)/(d) collisions — reachable with ZERO rotations (test-only id seam) |
| R5 | — | journal ENOENT + no archives + no marker ⇒ **fresh fleet, no refusal** (shipped semantics, byte-identical) |

### Purge (`operator_purge_rotation_marker`, Q-J2-f f1)
| code | trigger | state |
|---|---|---|
| `purge-archives-present` | eligibility: "purge targets archives-LOST fleets only; with archives the R3 routing or rebuild applies" (~494-499); re-checked UNDER THE LEDGER LOCK immediately before the unlink | 0 bytes ✓ |
| `purge-ineligible-no-marker` | eligibility: marker ABSENT (~1303, ~1323, ~1620); retry-with-marker-RETURNED succeeds at re-unlink, ENOENT is the marker-GONE branch (REV 13) | 0 bytes ✓ |
| `purge-log-insecure` | pre-existing recovery log NOT 0600 / NOT owner-uid / symlink — "NEVER chmod someone else's audit file" (~539-543) | 0 bytes ✓; NOTHING unlinked |
| `purge-log-failed` | checked-append failure (ENOSPC/EIO/partial) on the recovery log at steps (2)-(3), OR torn tail of the recovery log (dialect rule; tail NAMED) (~545-556). NO zero-bytes claim on the log itself: a failed checked append may leave a partial line — "torn-tail-possible for a (3) `-log-failed` (same rule as attest-failed)" (~1625-1632); NOTHING unlinked, marker stands | 0 unlinked; recovery log may hold a torn tail (next reader refuses) |
| `purge-attest-log-refused` | purge's write path runs the SHARED PARSER over the WHOLE attestation log first (REV 11, cycle-9 BLOCKER 2): a torn tail, a framing break, or ANY parse failure ⇒ refusal — appending past a torn tail "would concatenate onto the possibly-sole `damage:true` witness" (~1173-1195) | 0 bytes anywhere ✓: no recovery-log record, no purge entry, marker stands |
| `purge-io` | step 4a UNLINK failure (~1620); post-unlink failures reported WITH the marker state (cycle refs ~1288) | per-part: journal/sidecar/archives unchanged |
| `purge-commit-log-failed` | step (5) committed-append failure AFTER the unlink = **COMPLETED purge with incomplete audit** — rearm EFFECTIVE, "NOT a zero-byte claim anywhere" (~1626, ~576-581, ~1312) | rearm stands; audit line missing |
| — step 4b | dir-fsync failure after successful unlink ⇒ **reported as `purge-io` WITH the marker-OBSERVATION in the error context** (~1277-1292, REV 15 per cycle-13 major 3): marker GONE in the directory NOW — NAMESPACE-VISIBLE / DURABILITY-PENDING (a failed dir fsync cannot establish survival of power loss); after power loss the marker MAY return (fsync-lost window) ⇒ parser sees last entry = purge + marker present = in-flight, retry resolves via idempotence; attestation purge entry STANDS (REV 12, cycle-10 major 3) (~1632-1640). Same discipline as the AUTH `auth-recover-io` bound | marker-absent = purge DE FACTO complete-minus-durability; never "durable" |

### AUTH recovery (`operator_recover_auth_file()`, S-A1-R v7) and AUTH decisions
| code | trigger | state |
|---|---|---|
| `auth-recover-noop` | AUTH file ENOENT (after step 0 ran) (~3174, ~3265, ~3328) | 0 written ✓; rerunnable |
| `auth-recover-not-malformed` | EOF, no overflow, NO malformed seen ⇒ healthy refusal (~3226-3230) | 0 bytes ✓ |
| `auth-recover-inventory-cap` | `valid_count > AUTH_INVENTORY_CAP` **PROVED** (1025th valid line; or EOF with overflow, cap refusal REGARDLESS of malformed evidence — precedence rev 6) (~3239, ~3294, ~3312) | 0 bytes ✓; "this command can never serve as a cap relief valve" (~3270) |
| `auth-recover-scan-bound` | `AUTH_RECOVER_SCAN_CAP = 8 MiB` total-bytes-scanned cap reached at a NON-EOF bound with no PROVEN decision — "an UNPROVEN overflow possibility BLOCKS the torn verdict"; blank lines count toward the bound (~3190-3255) | 0 bytes ✓; operator raises the constant in a contract revision or reduces the file out-of-band; retry re-scans |
| `auth-recover-seq-ambiguous` | archive-name hygiene: duplicate/non-parsing parsed seq (canonical `:04d`, decimal-only) (~3257-3259) | 0 bytes ✓ |
| (no code — "target exists ⇒ refuse (rename would destroy evidence)") | AUTH archive target name already exists (~3260-3261). The ledger refuses this path WITHOUT assigning a refusal code — enumerated here as a real refusal path, code deliberately NOT invented | restore (R-c) |
| `auth-recover-io` | unexpected I/O error, contract-class `LedgerError` — never a raw OSError (F54); **pre-rename: zero written bytes; post-rename: report COMPLETED recovery, NAMESPACE-VISIBLE / durability-PENDING with the idempotent re-run route** — never "zero bytes", never "durable" (~3058-3075 a1-body BOUND rev 11 cycle-9 major 5 + REV 13 durability wording) | as stated |
| `authorization-file-malformed` | decision path (EXISTING, unchanged — "fail-closed retryable s-a1"): a malformed AUTH read refuses every authorization (~3008) | burns ZERO D1-A attempts, grants none, operator may retry the DECISION indefinitely (ratiated scope; pins instrument `_write_counter`; malformed run's ENTIRE counter-write sequence compared to the healthy prefix — rev 6 protocol) |
| `unknown-authId`, `authorization-stale` | SHIPPED decision-path classifications, explicitly carried unchanged: REPAIR-spent id classifies DEAD (`unknown-authId`) and stays barred via log coverage (b) (~3357-3359); the shipped repair() path checks missing-AUTH BEFORE spent, so it refuses `authorization-stale` first (ledger.py 1461-1471; verified at ledger.py ~1469 cycle-35, ~4839). NOT new codes; the candidate-file TEST fixtures for both are registered GAPS (R1, cycle 23 — ~3368-3369 says the tests are gaps, not that the channels are absent) | unchanged |

### Cross-cutting
- `unsafe-path-permissions` — startup access-control class, extended to
  EVERY archive/marker/sidecar match (owner uid, not a symlink, mode per
  the acceptance sets {ratified mode 0400, 0600-as-mode-pending}; live
  files stay exact 0600) (~1963-1965, ~625-630).
- `cross-epoch-seq-reuse-legal` — pin NAME (not a refusal): seq reuse
  across epochs is LEGAL and pinned (REV 13 corrected fixture: `t`
  required on entries; an incomplete fixture is itself a framing
  violation) (~96-100, ~901).
- `journal-rotated` — the durable marker filename (0-byte, 0600,
  O_EXCL; created AFTER the journal→archive rename, REV 7 ordering)
  — a name, not a refusal (~671-695).

---

## 2. The three crash windows around rotation, in refusal terms
(the a1/a2/b split, REV 13 cycle-11 major 3, folded from REV 12)

- **(a1) crash before the 4a attest append** — reads normally; zero
  permanent writes; maxseq ≥ hwm holds after rebuild.
- **(a2) attest append fsync-durable, crash BEFORE the rename** —
  permanent log entry BY DESIGN ⇒ re-entry hits the T4 high-water test
  ⇒ `carries-rebuild-attestation-gap` (rebuild) AND
  `journal-rotate-attestation-gap` refused pre-rename (rotation). **The
  entire T4 exception is WITHDRAWN (REV 11, cycle-9 blocker 1)** —
  "a COMPLETED rotation's step-7 EMPTY journal is indistinguishable
  from an abandoned attempt's still-present journal, so journal
  PRESENCE proves nothing about publication." The zero-byte claim is
  scoped PRE-4a; the attestation log is the sole permanent record
  written before any rename BY DESIGN.
- **(b) rename durable, crash before marker** — re-entry completes the
  transition (the marker is created after the rename; step 0 dir fsync
  on the next invocation orders the disks); a reader hitting
  ENOENT+archives first refuses `journal-rotation-incomplete` and
  **only rotation reentry completes** (~1866-1869 — "naming the rebuild
  command" is the R3-STATE rotation refusal ~2608, not this row).
- **RESIDUAL (R-c, named REV 11):** an abandoned rotation (attest
  durable, rename never run) "therefore has NO in-protocol completion
  — the fleet DEADLOCKS at a T4 gap (refusing rotation AND rebuild)
  until WHOLE-DIR RESTORE (R-1 restore class, same as the torn tail;
  availability loss on a rare crash state, the safe direction)"
  (~1113-1121). If the owner wants a protocol exit, that is placeholder
  **Q-J2-h — named, NOT drafted; "naming is not drafting"** (~1120-1121;
  RE-DEFERRED with documentation at REV-45).

## 3. Escape valves, as ruled

- **Q-J2-c = c3** (REV 36 ruling 6): `journal-rotate-full-override` —
  recovery-only intent + prerequisites P1–P3: **P1** the caller passes
  the asserted evidence (the literal `journal-full` string; missing ⇒
  `journal-rotate-override-unasserted`); **P2** under the lock the
  journal must be non-empty (empty ⇒ `journal-rotate-not-needed`);
  **P3** everything else runs unchanged (steps 0–2, target-exists,
  preflight INCLUDING carry/damage/oversize rules) — the override skips
  ONLY the `full` gate. The asserted event is unverifiable by design;
  a false assertion's blast radius is EXACTLY P2+P3 (~2016-2050).
- **The 64 KiB carry cap (Q-J2-e = e1)** — owner knowingly chose the
  SMALLER cap over the auditor's recommendation (e2a 1 MiB): "ACCEPT
  both documented availability ceilings, per-journal AND cumulative —
  recovery past the ceiling is out-of-band restore only" (~4868-4872).
  A valid worst-shape journal CAN exceed 64 KiB ⇒ that case is the
  ACCEPTED ceiling and must be pinned as a REFUSAL fixture
  (`journal-carries-oversize`), "documented ceiling, not a bug"
  (~2715-2722). Cumulative: two rotations of disjoint near-cap id sets
  ⇒ preflight refuses AND rebuild also refuses (~2723-2733).
- **No other escape exists.** Damage exit = restore (g2); T4 exit =
  restore (R-c); torn tail exit = restore (REV 10); cap exit = restore
  (e1). There are exactly two authorized destructive acts in the
  protocol: the c3 override (trust handshake, auditable) and the purge
  marker-removal (deliberate rearm; §5 N7).

## 4. Marker, mode, and path-posture refusals (acceptance sets)

Q-J2-a = a1 / Q-A1-a (REV 36 rulings 2-3): both archive classes 0400.
Startup acceptance set for archives = {ratified mode, 0600-as-mode-
pending}; **live files stay exact 0600**; step-0 mode repair chmods
pending archives on EVERY invocation. `unsafe-path-permissions` (wrong
owner / symlink / mode outside the set) covers "every archive/marker/
sidecar match." The 0-byte `journal-rotated` marker is 0600 O_EXCL;
the recovery log is 0600, dir fsync on creation, same directory as the
ledger state "so a whole-dir restore carries it" (~504-508).

## 5. Decision-semantics delta classes N1–N7 (the Q-ENUM-a sweep frame)

The enumeration exists so completeness sweeps can DIFF against it; the
N-classes are the decision-visible delta ("shipped behavior → new
behavior"), lines ~2500-2560:

- **N1** reader: journal ENOENT + archives ⇒ NEW `journal-rotation-incomplete`.
- **N2** reader: journal+marker+sidecar-absent/invalid ⇒ NEW `journal-carries-invalid`.
- **N3** reader: pre-marker/restore row ⇒ NEW refusal (treated as R3).
- **N4** `authorize()` identity coverage (c)/(d) ⇒ NEW `auth-id-already-used` extensions.
- **N5** repair decisions + `authorize()` vs `damage:true` ⇒ NEW `journal-carries-damaged` (d1).
- **N6** fresh-fleet listing failure ⇒ NEW `journal-carries-metadata-unavailable`.
- **N7** purge REARMS decision semantics on purpose — "NOT fail-closed
  … ADMITS more (spent ids re-mintable) as the owned consequence of an
  authorized destructive act." Q-1A-b RULED (REV-45): **own ratified
  exception REQUIRED; the purge command's deployment gate is the
  DRAFTED + RATIFIED EXCEPTION ARTIFACT** (~560-574, ~4255) —
  **NECESSARY, NOT SUFFICIENT** (REV-46, cycle-57 finding 1,
  ~5268-5275): drafting + owner ratification of the exception are
  the NEW gates the ruling establishes, but ratification alone does
  NOT assert every other deployment condition (atomicity, pins,
  suite, per-unit gates) — purge deployability still requires the
  full standing deployment conditions as usual. That exception
  artifact is the SECOND surviving draft work item (see §7).

Deployable-unit rule (rev 6): **command + its required reader rows
atomically** — rotation/rebuild may NOT ship without R2/R3/N1/N3
(~2553-2558).

## 6. Withdrawn names — do not revive (canonical-name discipline)

One pin, one name; these spellings are DEAD (audit trail):
- `purge-torn-attest-log-refuses` — WITHDRAWN; canonical
  `purge-attest-torn-log-refuses` (cycle-10 minor 2, ~1186-1190).
- `rebuild-t4-exception-needs-journal` — WITHDRAWN WITH ITS EXCEPTION
  (REV 11; replacement pin `rebuild-t4-gap-refuses-unconditional`)
  (~171, ~1131, ~1454).
- rev 9's `…-ignored` attest-torn pin — WITHDRAWN per the torn-tail
  rule (rev 10, ~1440-1442); rev 9's "ignore-the-tail" rule withdrawn
  (~1052).
- rev 9's "the next purge appends a complete line after the torn one"
  — WITHDRAWN (cycle-8 major 2, ~546-552).
- rev 6's auto-UNLINK marker at `carries-rebuild-ineligible` — WITHDRAWN
  (cycle-5 BLOCKER 1, ~376-384).
- rev 11's blanket purge atomicity ("if the log write or either fsync
  fails the command refuses and unlinks nothing") — FALSE for step (5);
  scoped to pre-unlink acts (1)-(3) (cycle-10 major 4, ~576-585).
- rev 7's "ONLY such a replay clears damage" — WITHDRAWN (CLEARANCE
  AMENDMENT, ~2265).
- rev 5's "8x headroom" scan claim — FALSE of the shipped reader;
  WITHDRAWN (cycle-4 major 10, CODE-class false spec-claim, ~3192-3205).
- The S-J2-R rev-12 T4 "journal-conditioned exception" — WITHDRAWN AT
  EVERY SITE (cycle-10 BLOCKER 1, ~4095-4102 vicinity).

## 7. Completeness accounting & open items

**Audit round E (4 cycles, GPT-6.1-terra adversarial auditor, query-
driven per the structural-limitation rule):** E1 verdict
CHANGES-REQUIRED, 8 findings (2 BLOCKER, 5 MAJOR, 1 MINOR) — ALL
FOLDED here: (B1) enumerated the AUTH target-exists refusal path
(~3260-3261) WITHOUT inventing a code — the ledger gives it none;
(B2) split `journal-rotation-incomplete` into its two triggers —
the rotation COMMAND refusal (journal present + sidecar invalid,
~351-357) vs the reader R4/N1 row; (M1) `journal-full` trigger is
the WRITER `_journal_append`, the `full` predicate demoted to
CONSERVATIVE-MIRROR with the named divergence residual (i); (M2)
`rotation-attest-torn-tail-refuses` reclassified as PIN NAME,
refusal channel = `carries-rebuild-attestation-gap` (~858-860);
(M3) `purge-log-failed` blanket zero-bytes claim removed — "torn-
tail-possible for a (3) -log-failed" (~1625-1632); (M4) §0.1
entry-fsync rule scoped to the operator-command I/O FAULT CONTRACT,
not decision refusals; (M5) `auth-recover-io` citation corrected
~2653-2665 → ~3058-3075; (m1) `unknown-authId`/`authorization-stale`
restated from the shipped-code evidence (~3357-3359, ledger.py
1461-1471/~1469) with the cycle-23 candidate-file GAP statement
narrowed to TEST fixtures. E1 also confirmed CLEAN: the 13-token
draft-1 declaration, the attest-failed/oversize scope split, T4-
unconditional + R-c, purge step (5), damage-permanent, carry-sidecar
cap, and the AUTH cap-over-torn precedence. E1 disclosed coverage:
query-driven, not a serial full-ledger read.
**E2 (post-E1-fold verification + fresh pass):** verdict
CHANGES-REQUIRED, 3 MAJOR / 0 BLOCKER — all folded: (M1) §2(b)
reader-route corrected: ENOENT+archives ⇒
`journal-rotation-incomplete` where "only rotation reentry completes"
(~1866-1869); the "naming the rebuild command" phrasing belongs to the R3-STATE
rotation refusal (~2608); (M2) g2 ruling citation corrected
~4892-4897 → ~4878-4881 (4892+ is the purge f1 interpretation);
(M3) e1 cap-ruling citation corrected ~4884-4887 → ~4868-4872.
E2 re-verified PASS: attest-failed/oversize scopes, T4+R-c, purge
step (5), damage permanence, N7 exception gate, AUTH cap precedence
+ pre-rename zero-claim, carry-sidecar cap, the 84-token c17
corpus, the declared draft-1 tokens (none undeclared), and the
disclaimed `authorization-spent` handling. Coverage disclosed:
query-driven sample, not exhaustive.
**E3 (post-E2-fold verification + fresh pass):** verdict
CHANGES-REQUIRED, 2 MAJOR / 0 BLOCKER — both folded: (M1)
`purge-attest-log-refused` trigger widened to the full REV-11
clause — shared parser over the WHOLE attestation log: "a torn
tail, a framing break, or ANY parse failure" (~1175-1179), not
torn-tail-only; (M2) purge step 4b re-labelled per ~1277-1292
(REV 15): it IS a `purge-io` report carrying the marker-OBSERVATION
(NAMESPACE-VISIBLE / DURABILITY-PENDING; marker-may-return window),
not "observation-only". E3 re-verified PASS: reverse corpus (13
declared, none undeclared), forward corpus (no unmapped ledger
refusal code), no citation displaced >20 lines in its sample, and
the same high-risk semantic set as E1/E2. Coverage disclosed:
query-driven, not serial.
**E4:** 1 MAJOR (N7 gate chain NECESSARY-NOT-SUFFICIENT, ~5268-5275)
— folded. **E4b (post-fold verification):** folds PASS; one literal
MINOR (mechanical corpus flagged the two declared-reference tokens)
— both explicitly declared here. **E4c (closure):** ROUND CLOSED,
**VERDICT: CLEAN** — but attribution matters: E4c's saved report
(verdict text in `~/.tre/audits/enum-e4c-out.txt`) verified ONLY the
two §7 folds and the reverse corpus (15/15 ledger-absent tokens
declared: 14 draft-1 coinages + the source filename). The FORWARD
corpus (no unmapped ledger refusal code) and the fold-regression PASS
claims belong to the earlier cycles (E2/E3 re-verified them), not to
E4c. Full round register appended to the ledger's DC-1 status entry.
Residual limit unchanged: query-driven, not a serial full-ledger audit.
**Post-E4c edits (the five-change "A round", owner-directed):** after
E closed CLEAN, an owner-directed review raised five findings (A1-A5:
attest-failed recovery dead end, T5/T4-qualifier omission in the
gate table, per-cycle attribution — this paragraph, rotation-table
row shape + broken cross-refs, ledger-appendix overstatement) — all
folded here; they are the INPUT to the F round below, and anything in
this document written after E4c is audited by the F round, not by E.
**F round (7 cycles, F1-F7, GPT-6.1-terra, same method):** audited the
A1-A5 folds + full method each cycle. Trajectory: F1 CHANGES-REQUIRED
2 BLOCKER ((i) empty-log branch overextended append-idempotence;
(ii) already-attested branch promised re-invocation the PRE-RENAME
T4 gate refuses — R-c) — folded into the 4-branch recovery cell;
F2 1 BLOCKER (fold-introduced undeclared backticked audit-report
PATH token) — folded by declaring the audit-artifact path class in
the §7 note; F3 1 MAJOR (empty-log branch ignored T1/T3: an empty
log with archives PRESENT gate-refuses before the writer runs) —
folded; F4 1 MAJOR (branch (ii) cited the wrong pin —
`rotation-retry-hwm-idempotent` is the parser+writer UNIT TEST for
the torn-append/pre-T4 case "not an E2E rotation (E2E the state
refuses — R-c)" ~938-944; the published-archive completion route is
pin `rotation-completion-current-sidecar-proceeds` ~1040-1046) —
folded. F5 CLEAN (0 findings); F6 CLEAN (0 findings, 55 citation
windows); F7 CLOSURE: regression sweep of everything the F round
touched PASS, reverse corpus 0 undeclared ledger-absent (15 absent
all accounted: 13 draft-1 coinages + source filename + declared
audit-path token; `--allow-oversize` present literally in the ledger
appendix), forward corpus (c17 lists + fresh S-A1-R) no unmapped
refusal code, 62 table rows + all § refs clean. **ROUND CLOSED,
VERDICT: CLEAN.** Snapshots: `~/.tre/audits/enum/baseline-F0.txt` +
`~/.tre/audits/enum/postfold-F1..F6.txt`; logs
`~/.tre/audits/enum-F1..F7-out.txt`. Residual
limit unchanged: query-driven, not a serial full-ledger audit.
(Post-verdict honesty note, A3 discipline: this register paragraph
and the §7 path-class declaration were written AFTER F7's verdict to
record it — verified by the mechanical sweep re-run locally, 14
absent all declared, not by the auditor.)

**Corpus diff (audit 1 of this artifact):** mechanical extraction over
(NOTE for future mechanical runs: token extraction may also flag the
SOURCE-FILENAME token `21a-p9-m3-owner-review-ledger.md` — declared
at the head of this document as the source of truth, a file name, not
a protocol token — the AUDIT-ARTIFACT PATH CLASS: every backticked
string beginning `~/.tre/audits/` (report/log/snapshot paths cited as
evidence — file paths, not protocol tokens; declared by PREFIX, not
enumerated) — and the declared draft-1 coinage list below.)
both sub-spec bodies yields 84 unique tokens (cycle 17,
`~/.tre/audits/sj2r/c17/`); every refusal-code-shaped token is mapped
above (§1). Tokens NOT mapped as refusals: artifact/state nouns
(`journal-carries`, `journal-rotated`, `journal-unreadable` channel
name, `hwm`, `hwm`-adjacent schema words `cmd`, `t`, `phase`, `epoch`,
`seq`, `status`, `attempted`, `committed`, `evidence`, `full`,
`healthy`, `damaged`, `damage`, `last-append`, `resolve-attempts`,
`purge`, `purge-in-flight` (state, not code), `0x`/`0x0001`
(non-decimal spellings in hygiene examples), `repaired`, pin NAMES
(`cross-epoch-seq-reuse-legal`, `rotation-writes-attestation`,
`purge-appends-attestation`, `rotation-retry-hwm-idempotent`,
`rotation-reentry-attest-gate`, `rotation-stale-replay-attest-gate`,
`rotation-completion-current-sidecar-proceeds`,
`rebuild-attest-missing-refuses`, `rebuild-attest-gap-refuses`,
`rebuild-damage-from-log-only`, `purge-attest-torn-log-refuses`,
`purge-complete-then-rotate-not-inflight`,
`decision-reader-never-parses-attest-log`,
`purge-in-flight-refuses`).

**Corrections folded from draft 1 (honest accounting — this ledger's
own discipline):** draft 1 invented `malformed-epoch`/`malformed-seq`/
`malformed-digest`/`seq-reuse-conflict`/`unverifiable-legacy`/
`ambiguous-digest`/`torn-tail-restore-required`/
`journal-verify-repair-required`/`journal-full-oversize-not-asserted`/
`scan-bound-exceeded`/`inventory-cap-exceeded`/
`journal-rotate-purge-in-flight`/`purge-ineligible-in-flight`/
`--allow-oversize` and cited
NUMERIC pin numbers — **none exist in the ledger** (pins are named;
`grep -c 'pin [0-9]+'` = 0; the wire-regex intake codes and the
`--allow-oversize` handshake (14 tokens total) came from a different
revision of the
project's memory, not this document). Draft 1 also mis-signed the
64 KiB cap onto the live journal line size; it is the **carry-sidecar
cap** (Q-J2-b b1 grammar, `journal-carries`), and the journal cap is
`JOURNAL_CAP` (mirrored by e2's 1 MiB option text). All corrected here;
the sweep that produced them is exactly why Q-ENUM-a was commissioned.

**Open items (mirror the ledger's REV-45 handoff, ~4252-4258):**
1. This enumeration — DELIVERED (draft 2); awaiting owner read + the
   next confirming sweep (sweep I can now diff against a canonical
   section).
2. The **purge-exception artifact** (N7's "own ratified exception
   required", Q-1A-b) — the surviving OTHER draft; purge deployment
   stays blocked until it is drafted AND ratified.
3. **Q-J2-h** (protocol exit for the T4-deadlock): RE-DEFERRED with
   documentation at REV-45; deliberately NOT drafted here.
4. Known coverage limitation, stated in the ledger: single-pass deep
   audits over the full ledger have failed twice ("STRUCTURAL … one-shot
   detached auditor sessions cannot complete deep passes over a 4k-line
   doc", round PAUSED at rev 21) — this artifact is a targeted,
   corpus-diffed enumeration, not a whole-ledger re-verification, and
   makes no such claim.

---

**POST-RATIFICATION STATUS ANNOTATION (owner decision round, same
session as ratification; annotates, changes no ratified content):**
1. Owner read: COMPLETE — RATIFIED as written, no change-requests.
2. Purge-exception artifact (Q-1A-b): **DEFERRED by owner instruction**
   ("close all the easy items first"); purge deployment remains
   blocked on draft + ratification + standing conditions, unchanged.
3. Q-J2-h: deferral re-confirmed (third affirmation; ledger entry of
   this session). DC-2 acknowledged-gap block: drafted per owner
   commission, appended to the ledger (owner review open).
