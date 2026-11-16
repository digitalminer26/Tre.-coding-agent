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
  8721f5b and HEAD — the reference tree has not drifted since the
  suite run this step pins).]
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
