# Owner ratification session — O-G2/G3/G4/G5 decisions (contract v36, post-D-sign-off)

Reading material: `docs/audits/o-decisions-review-v34.md` (companion to
§14.11.5 / §14.12.5 / §14.13.7 / §14.14.6). Session run one item at a
time with the owner on 2026-11-22, after the v36 terra round closed
(CLEAN ×2, c45/c46, commit cb0a3cd).

This log records the owner's ANSWERS as they land. Per the contract the
formal ratification surface remains the P13 typed `norm-ratification`
exchange (§14.11.4) — this file is the owner's recorded intent that the
exchanges are minted from.

| Id | Owner decision | Date |
|---|---|---|
| O-G2-1 | RATIFIED default: digest mandatory at `ratified` only (drafts carry no content hash; unratified text binds nothing) | 2026-11-22 |
| O-G2-2 | RATIFIED default: `from` field (expected prior revision) on norm transitions — CAS checkable after the fact; shape difference vs audit-finding-update audit-cleared as intentional | 2026-11-22 |
| O-G2-3 | RATIFIED default: changed norm = new id, never in-place edit (in-place edit is the C1-F4 impersonation class; id proliferation accepted) | 2026-11-22 |
| O-G2-4 | RATIFIED default: identity in `norm-created` append-only records; `norms.json` is a rebuildable projection (rebuild mismatch = corruption signal, round-0 B4; no hand edits — P13 is the only human surface) | 2026-11-22 |
| O-G2-5 | RATIFIED default: supervisor stamps `normId`+digest (worker self-stamping = self-certification; round-0 B5 null-digest dodge class) | 2026-11-22 |
| O-G2-6 | RATIFIED default: intake resolves against the dispatch PIN set ONLY (records-vs-records replay; freshness enforced at dispatch via `stale-norm`; missing pin = `norm-unpinned`, v4 vocabulary) | 2026-11-22 |
| O-G2-7 | RATIFIED default: content-addressed snapshots — missing/mismatch ⇒ NOT ratified + needs-owner (fail closed, c1-C1-F6; operator mistakes stop a norm rather than being silently repaired — intended) | 2026-11-22 |
| O-G3-1 | RATIFIED default `owner-only`: opinion-basis blockers are closable ONLY by the owner (unfalsifiable by construction; orchestrator closing them re-opens the "auditor says clean" hole; c25 precedent — owner is the repro oracle; toil measured 0 at verdict level c43–c46) | 2026-11-22 |
| O-G3-2 | RATIFIED split (recommendation 1): `cleanRoundsRequired` = 2 as the FLOOR, **3 for prose-contract audits** (pairs demonstrably miss — c26/c27→c28, c29/c30→c32, c42→c43; the holding streaks were k=3; prose has the widest sampling surface), 2 kept for code-defect rounds (mechanical repro); per-episode bumps ride the policy line (lower values need an owner-recorded change) | 2026-11-22 |
| O-G4-1 | RATIFIED default: budget enforced at CYCLE BOUNDARY only, no mid-flight kill (torn partial application is the poisoned state for an append-only/replay ledger; overshoot bounded by admission + frozen by O-G4-4). STANDING RE-OPEN TRIGGER logged — see below | 2026-11-22 |
| O-G4-2 | RATIFIED default: estimate overshoot DISCLOSED (ledger-appended), not reserved/hard-bounded — no pre-dispatch reservation machinery for the single-wave loop; learned topology: single lab, one episode at a time. STANDING RE-OPEN TRIGGER logged — see below | 2026-11-22 |
| O-G4-3 | **CORRECTED 2026-11-22 (same day; see audit disposition below) — REAFFIRMED the v35 decision, which stands: DECIDED AGAINST the drafted default — recovery spend is RING-FENCED under §14.7 and EXCLUDED from the cycle projection (v35 Change Ledger row; the sole against-default decision of the v35 batch; §14.13.3 amendment + `maxUsd` policy line). The re-ratification session confirms the v35 outcome; the anti-relabel guard stays. NOTE: an earlier version of this row transcribed the review sheet's RECOMMENDATION (count toward cap, ring-fence not taken) instead of the owner's decision and stood unreconciled for hours — corrected before push.** Standing re-open posture unchanged: v35's reversal is itself the pod-flakiness rationale; revisit only if the ring-fence's anti-relabel guard shows leakage | 2026-11-22 |
| O-G4-4 | RATIFIED default: unreconciled (unknown) spend consumes ALL remaining headroom until reconciled — fail closed, no next cycle on an estimate (v1's count-at-estimate withdrawn for this exact double-authorize failure); freeze-and-ask beats double-spend. Machinery as D-signed-off §14.13.2/§14.13.3 (held exposure is a FLOOR on spent, disjoint arms, admission denied — not "the hold equals the whole headroom") | 2026-11-22 |
| O-G5-1 | RATIFIED default (strict): unscoped findings (`scopeRefs:[]`) collapse to ONE serial group; NOT treated as overlapping only with same-`surface` findings. Considered and rejected: a "declare scopeRefs first" mandate as a separate design cycle — findings with paths are ALREADY scoped per-wave by the §14.14.3 scope function (declaration exists; the cycle would bind only genuinely whole-repo findings, where a mandate either drops real defects or pressures false-precise scopes — the git-invisible-escape class the v35 O-G5-3 fold proved expensive — or carves an "honestly unscoped" escape that lands back on this default). Two policy notes attached (intake-side, NOT contract changes): (1) intake SHOULD push findings to declare `scopeRefs` where paths exist — scoping is free and buys parallelism; unscoped remains legal and honest, and is serialized. (2) STANDING RE-OPEN TRIGGER (below) for solo-wave scheduling cost. | 2026-11-22 |
| O-G5-2 | RATIFIED default: file-granular overlap — directory-prefix overlap serializes; two anchors in the SAME file never run in parallel (v1's anchor rule removed: the platform (git + worktrees) cannot grant below-file isolation, round-0 M6 / c1-F5). Disjoint-region same-file pairs serialize — accepted cost; below-file parallelism requires a proven merge-layer mechanism, never a schema promise (v1's error). STANDING RE-OPEN TRIGGER logged — see below | 2026-11-22 |
| O-G5-3 | RATIFIED as drafted: scope-escape audit is MANDATORY (§14.14.4: base-to-task-tip delta ⊆ authorized scope ∩ episode authority, rename/delete/mode/gitlink-aware, base-equality verified not assumed, gated identity bound into the P12 CAS request); consequence = per-candidate refusal `scope-escape` + `needs-owner`, episode-global until a validated `scope-escape-resolution` or owner waiver, own cycle unclean. Wave-void question CLOSED **NO**: candidates are individually CAS-integrated with own gates and individually revertable (§14.5) — a batch void punishes verified candidates for a bad neighbor and makes replay's "which integration survived?" unanswerable at the ledger level; the unclean cycle is the pressure signal. The reviewer's optional same-norm re-verify condition stays DECLINED (as in the v35 owner call — shared-interface dependency-impact review covers that shape) | 2026-11-22 |

## Standing re-open triggers

- **O-G4-1 → soft-stop (option B):** re-open when wave length × worker
  cost exceeds roughly one cycle estimate (tasks-in-flight overrun
  becomes meaningful). If taken, `budget-truncated` enters as its own
  §14.12.3 verdict row with a FRESH audit round — not an amendment on
  the D-signed-off §14.12.1 text.
- **O-G4-2 → hard reservation (option D):** re-open when concurrency
  > 1 wave becomes real (multi-episode or fleet spend). Worst case
  until then: N concurrent groups × per-cycle estimate, disclosed in
  the ledger.
- **O-G5-1 → loose variant (surface-overlap):** re-open when a single
  unscoped finding's serialized wave measurably dominates cycle cost
  (solo-wave scheduling pain), with measured throughput evidence in
  hand — the strict default stays until then.
- **O-G5-2 → below-file parallelism:** re-open only when a concrete
  merge-layer mechanism exists (content-level merge + conflict
  detection proven); never as a schema promise without the mechanism
  (v1's error).

