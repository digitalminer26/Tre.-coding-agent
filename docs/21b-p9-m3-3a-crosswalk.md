# 21b — 3A final-review artifact (evidence-first crosswalk)

Format RATIFIED by the owner (fourth tranche, "part 3 - proposed
format"; docs/21 FOOT record): (1) run the reference suite and pin
results; (2) disposition crosswalk — each 3A sentence → the code
lines + test ids that hold it → drift classified CODE/TEST/DOC vs
SPEC; (3) ONE owner ratification reading against this artifact;
extra cycles only if drift is found. This file is that artifact.
3A verdict: UNCONFIRMED until the owner's reading lands — nothing
here pre-empts it.

## Step 1 — suite run, pinned

- Evidence tree (post D4A round close, commit 8721f5b):
  `reference/p9m3/ledger.py` sha1-prefix
  `3a9307a7b1fc6fea628c03c19c855c9facc655ab`, sha256-prefix
  `4e997d59ed99433e25141177145f99eb512b239d38661d893a7b2664819d47fb`;
  `reference/p9m3/test_ledger.py` sha1-prefix
  `656e77d3599f31a9be2f97f800ee32be6faac395`, sha256-prefix
  `ca66c1a47209a763040c25f908097b49a8b9f600096149a90130a99559694772`.
  [HASH-LABEL CORRECTION 2026-11-17: these values were first recorded
  as `sha256-prefix` at da7f7f0 but were transcribed from `shasum`
  (SHA-1) output — the true SHA-256 prefixes are the ones added here
  (read from the tree, per the D4A pin rule; verified identical at
  8721f5b and the HEAD **of that time** (commit 37070e1, the v46
  fold) **for ledger.py only** — later AUD45 folds have changed
  ledger.py again; see the updates below and the current-tree
  mapping (AUD45-c7-2);
  finding AUD45-c1-1).]
- EVIDENCE-TREE UPDATE (AUD45-pre fold, 2026-11-17): the five-finding
  hygiene fold STRENGTHENED `test_ledger.py` (test_F25v33_* gained
  write-side arms: `partial_write` {0,1,4} produce the crash prefixes
  and arm (c) drives the settlement route; mutation-verified in a
  scratch copy — any-tail-unsettled kills the (b2) arm,
  no-settlement-byte kills the (c) arm). TESTS ONLY — `ledger.py`
  UNCHANGED (sha1 `3a9307a7b1fc…`, sha256 `4e997d59ed99…` — the
  behavior this crosswalk reads is untouched; every Step-2 line
  citation and test-id still resolves). New tree: `test_ledger.py`
  sha1-prefix `7780857914ad4147e51d9732ca668fd99ff5359b`,
  sha256-prefix
  `7a2159df7f46b6d1393e1894981bd9b2057db76c2d5d13f1ed1d3cbdd079ec51`;
  suite re-run post-fold: **Ran 92 tests — OK** (2026-11-17). The
  owner's ratification reading may be taken against EITHER tree;
  they differ in test rigor only.
- EVIDENCE-TREE UPDATE 2 (AUD45 cycle-2 fold, 2026-11-17): finding
  AUD45-c2-1 (minor DOC) — the `_check_access_controls` docstring in
  `ledger.py` still described the SUPERSEDED v38 cycle-1 permissive
  policy ("pre-existing read-only group bits … operator policy");
  the code below it (and the 1A premise at docs/21 ~2548) enforce
  STRICT 0600-owner-only (an externally created 0644 protocol file
  REFUSES — experimentally confirmed in an audit copy). The
  docstring was restated to match the enforced policy; **ZERO
  behavior change, tests untouched** — `ledger.py` sha1-prefix
  `86d9ddc5d059e9d28ffc621b32465f0fe671fcb0`, sha256-prefix
  `26e44e0414cae8ed059d4f202bf135079a2c4911f4b5c594921157e2bf89d954`
  (supercedes the `3a9307a7b1fc…`/`4e997d59ed99…` pin above — that
  pin remains true of the pre-fold tree, per the hash-history rule);
  `test_ledger.py` UNCHANGED (`7780857914ad…`/`7a2159df7f46…`).
  The Step-2 table's LINE citations are pinned to the tree pinned
  above them at writing (per the D4A pin rule); the docstring-only
  edit shifts `ledger.py` lines below ~163 by +6 (e.g. the S1
  866–899 route → 872–905; S2 1456–1459 → 1462–1465; S3 1810 →
  1816), so citations resolve against the SUPERSEDED pin, not the
  new one — the content at each cited site is byte-identical
  (spot-verified at the S1/S2/S3 anchors).
  Suite re-run post-fold: **Ran 92 tests — OK**.
- EVIDENCE-TREE UPDATE 3 (AUD45 cycle-3 fold, 2026-11-17): finding
  AUD45-c3-1 (major CODE) — the NO-PENDING resolve path exempted
  itself from the attempt bound: a persistent resolve-IO fault there
  returned `durability-pending` forever, never consuming the counter,
  so the spec's "Resolution attempts are BOUNDED per episode … No
  schedule drives an unbounded loop" never arrived (docs/21 ~2820).
  FIX: the cap refusal now PRECEDES the resolve IO on this path
  (persist-first, same discipline as the recovery round), the
  counter is consumed ONLY on IO failure, a successful ordinary
  resolve stays counter-free (v38 fix 1 preserved) and clears any
  charged attempts, exhaustion is sticky and operator-reset-only —
  the pre-existing overlays (status/promote) needed no change.
  New pin test_F60_no_pending_resolve_io_fault_is_bounded (repeated
  failure → exhaustion sequence, status+binding view, cross-process
  stickiness, operator reset + healthy resolve, success-stays-free;
  mutation-verified BOTH ways in scratch copies — reverting the
  branch to pre-fix behavior kills it, removing only the charge
  kills it). Suite: **Ran 93 tests — OK** (every "92" above is
  historical, pinned to its own tree). New tree: `ledger.py`
  sha1-prefix `2524fb71ff178ef144f7ace38450fbe45ce1bd60`,
  sha256-prefix `6e6f5277b6590e0fdc7c75c7…`; `test_ledger.py`
  sha1-prefix `80eb7014ee1fcfb2396f194ebf6fd05221571cda`,
  sha256-prefix `bed061d92495a884825c3bf0…`. Cumulative line shift
  below ~163 is now +28 from the tree pinned at Step 2 (S2
  1456–1459 → 1484–1487, S3 1810 → 1838; the S1 classify region is
  ABOVE the changed resolve branch and unshifted); cited content
  remains byte-identical (anchors re-verified). No 3A SENTENCE
  changed behavior: S1–S6 drift stays NONE — the fix serves docs/21's
  own resolve-bound prose.
- EVIDENCE-TREE UPDATE 4 (AUD45 round close, 2026-11-17; finding
  AUD45-c7-1; **NOW HISTORICAL per AUD46-a3 — this block pins the
  tree at commit 317ca83 (the AUD45 round-close commit); the AUD46
  fold (A1/A2 pre-IO charge + status overlay) and later cycles
  re-shift the anchors — see the AUD46 round-close Update 5**):
  the update-3 "+28 cumulative" mapping went stale the
  moment cycles 4-5 edited ledger.py docstrings again. CURRENT-TREE
  MAPPING (measured, both algorithms pinned below): S1 classify
  DEAD/valid route — pinned 866–899 (8721f5b) -> now 875–908
  (dead.append anchor 894 -> 903, +9); S2 revive_dead_repair —
  1456–1459 -> 1491–1494 (+35); S3 status dead_repairs line — 1810
  -> 1845 (+35). Cited content byte-identical at all three anchors
  (re-verified). Current tree: `ledger.py` sha1
  `cf0f6962fb87c7cd196e73697420d6136c76baba` sha256
  `dadb9e043500a1413cf4adea394260107b87bba388898c5961a1d493ae539088`
  (cycles 4-5 docstring folds after update 3; behavior of cycles
  4-5/6 folds: docstrings/prose only); `test_ledger.py` sha1
  `80eb7014ee1fcfb2396f194ebf6fd05221571cda` sha256
  `bed061d92495a884825c3bf0095156c2823cc15a52f4dbea9a2c7886e6a0ef6d`
  (unchanged since the cycle-3 pin — F60). THE Step-2 TABLE'S LINE
  CITATIONS ARE HISTORICAL (pinned to 8721f5b per the D4A pin rule);
  this block is the verified mapping to the current tree. Suite at
  this tree: **Ran 93 tests — OK**.
- Command: `cd reference && python3 -W error::ResourceWarning
  -m unittest p9m3.test_ledger`
- Result: **Ran 92 tests — OK** (2026-11-16). The three pins added
  by the D4A cycle-5 fold (test_F23v33_late_genuine_AUTH_activates_
  dead_repair, test_F23v33_late_AUTH_occurrence_mismatch_stays_dead,
  test_F25v33_crash_prefix_enumeration_three_arms) are mutation-
  checked: each reverts-to-RED when the rule it pins is removed
  (record: docs/21a, D4A-c5-1/c5-2 entries).

## Step 2 — sentence-by-sentence crosswalk

3A text audited: the DEAD-REPAIR DISPOSITION block at docs/21 ~2629
(+ its QUALIFICATION bracket) and the V37 OWNER DECISION RECORD
shorthand (~6749: "3A DEAD REPAIR = inert + reported, removal is
compaction debt, revival only via fresh AUTH + fresh REPAIR").
Code lines are reference/p9m3/ledger.py as pinned above.

| # | 3A sentence (normalized) | Code holding it | Tests holding it | Drift vs SPEC |
|---|---|---|---|---|
| S1 | a DEAD REPAIR contributes NOTHING to authority, masks nothing, is never evaluated or trusted | classify() routes a reasoned REPAIR ONLY to `dead` and never into `repairs` (866–899); authority algebra (stage 6, 918–945) and mask coverage (stage 5, 955–965) consume `repairs`/WATERMARK lines only — a dead record is structurally unreachable from both | test_F21_dead_repair_inert_promotion_refused_fresh_pair; test_F13_dead_repair_masking_valid_watermark; test_F16_authorize_refuses_schema_valid_line_dead_repair_ok | NONE |
| S2 | NOT latent authority; NO operator command may make one contribute; the only legal removal is the future compaction contract | revive_dead_repair() exists ONLY to raise `no-such-operator-command` (1456–1459); no other public API writes or mutates a DEAD record (dead is recomputed per read, never persisted); NO compaction API exists — removal is genuinely future-work | test_F21 (`assertRaises` on revive_dead_repair) | NONE — "future compaction contract" is unimplemented BY DESIGN (spec's own word: "future"); boundary noted, not drift |
| S3 | status REPORTS each DEAD REPAIR: offset, hash, reason ∈ {unknown-authId, mask-mismatch} (closed 2-reason set) | dead entries carry exactly {offset, hash, reason} (897–899); reasons assigned at 869 (unknown-authId) / 871, 878, 880, 892 (mask-mismatch incl. watermark-ahead and generation-header-moved under the closed-set reading, per v39 R2-B2 comment 882–890); status() surfaces cls["dead_repairs"] verbatim (1810) | test_F12_fully_masked_status_render; test_F13; test_F21 (asserts reason == "unknown-authId"); test_F24gen (reason on generation death) | NONE |
| S4 | an operator who believes one should be live must go through a NEW AUTH + fresh REPAIR against the CURRENT occurrence list | authorize() refuses a used authId (`auth-id-already-used`, 1366) and refuses already-masked occurrences (F26 rule); repair() refuses a spent AUTH (`authorization-spent`, 1488/1511) and a stale list (`authorization-stale` — checked against the CURRENT stage-2 occurrence set) | test_F21 (fresh pair succeeds; old AUTH now `authorization-stale`); test_F26_authorize_refuses_masked_occurrence | NONE |
| S5 | QUALIFICATION (v39 AUDV1-M1, surfaced by D4A-c3-1): "no revival" means NO OPERATOR COMMAND — validity is CURRENT-READ; the same record reclassifies VALID automatically when its precondition arrives later as a genuine authorization (AUTH appears with exact mask match, or the confirmation log grows past ALL.watermark while the current generation header still equals the REPAIR's own all.confirmGen) | classify() is pure current-read (no dead-state persistence anywhere); late AUTH hits by_auth at 866–871 on the next read; mask equality 871–880; watermark growth vs confirmation_length 880–881; generation binding compared on EVERY read (882–892, v39 R2-B2: the binding is the REPAIR's OWN all.confirmGen) | test_F23v33_late_genuine_AUTH_activates_dead_repair (dead→valid activation + second REPAIR refused SPENT); test_F23v33_late_AUTH_occurrence_mismatch_stays_dead (occurrences≠M ⇒ stays DEAD); test_F24gen (growth arm + generation-header arm) | NONE (the qualification itself was the D4A-c3-1 DOC fix, already folded into both the disposition block and the V37 record) |
| S6 | V37 shorthand "revival only via fresh AUTH + fresh REPAIR" | same as S4+S5 — the shorthand is carried WITH the S5 qualification bracket at both locations | same as S4+S5 | DOC — RESOLVED: read WITHOUT the qualification the shorthand overstates (an automatic reclassification is not a "revival" in S2's operator-command sense); the qualification is folded in place at both sites (D4A-c3-1), this artifact's reading is the ratification point |

Round-audit provenance: every row was walked in the D4A scope-A
round (cycles 1–5; docs/21a round record): D4A-c3-1 (S5/S6 DOC
qualification), D4A-c5-1/c5-2 (S5 pins added + mutation-checked),
D4A-c5-3 (coverage-mapping headers). No CODE drift found in any
3A sentence; the suite's 92 pins include the only behaviors 3A
claims.

## Step 3 — owner ratification reading (the ONLY remaining step)

Read the six rows above. Ratify by replying, e.g.:
- "3A ratified" — the disposition INCLUDING the S5 qualification and
  this crosswalk becomes the ratified reading; docs/21 status lines
  flip 3A UNCONFIRMED → CONFIRMED; or
- corrections — folded as cycles (the format allows more cycles
  only if the reading finds drift, which by construction means
  disagreement with a row above).

Nothing in this artifact changes 3A's status by itself.
