# Remaining items — orchestrator workstream review

Refreshed: 2026-11-13 at HEAD `865dbdd` (v0.4.9, tag `v0.4.9` on HEAD;
tree clean, `origin/main` up to date; `npx tsc --noEmit` clean).

This file supersedes the 2026-11-02 "post-R8 working-tree review"
version. All three of its "open decisions for the user" have since been
resolved (see *Housekeeping* below), and two further workstreams have
opened and closed since it was written:

| Workstream | Close | Verdict |
|---|---|---|
| P9/M2 shared supervision (scheduler, N workers, observer queue) | 2026-11-15 (docs/11 ledger close row; HANDOFF "P9/M2 ACCEPTANCE CLOSED") | Sol rounds c6→c9 clean PASS 0/0; "M2 acceptance: CLOSED — all m2c6/c7/c8 minors verified with counter-proofs" |
| M3 provisioner slice (worktree release gate) | 2026-11-14 (fix rounds 5–9, docs/11 ledger) | Round 9 clean PASS 0/0: "converged — no unprobed runtime defect class identified" |
| Kill-window audit (attempt lifecycle A1–A3) | 2026-11-13, shipped in v0.4.9 | Converged after 5 cycles; finding rate zero |

Suite at last recorded close: **2743 total / 2729 pass / 0 fail / 14
skipped** (pre-release), grown to 2769 total / 2755 pass at the
kill-window close; quality gate green.

## Findings status — code audits closed; the docs/21 CONTRACT round is OPEN

No CODE audit has an open finding: the R-series (attempt-runner R4–R8)
closed 2026-11-02; the M3 fix series closed at round 9; the M2
acceptance loop closed at c9; the kill-window series closed converged.
**The M3 contract round is different and OPEN:** docs/21 took two
rounds (v1 self-audit: 2 blockers + 5 majors + 1 minor; round-2 review
of v2: 2 blockers + 4 majors + 1 minor — every finding verified
against `src/` or reproduced on the lab git before acceptance;
dispositions in-file). It stands at **v4 (confirming-round audit of
v3 folded: 1 blocker — unregistered-current-root hole — + 4 majors +
1 minor; dispositions in-file), awaiting a FRESH confirming
adversarial round (docs/16 pattern) before D1–D9 go to sign-off.**

## Accepted-by-design limits (tracked, not open bugs)

1. **Runner external writers** (R6-3): state.json edits outside the
   runner's serialized paths are best-effort-detected, not excluded.
   Contract documented in `src/runner/attempt.ts`. Hard atomicity
   would need a cross-process lock — consciously declined.
2. **Final hint revalidation window**: the `currentHintState` check
   before the confirmation append cannot close its own read→append
   interval — acknowledged, bounded by the queue contract.
3. **Kill-window residuals** (STATUS.md close banner):
   - A group "alive" under a reaped leader is ownership-UNPROVABLE;
     `stop()` reports `unknown` and never sweeps a historical pgid (W4).
     Reclaim needs the operator path with positive evidence.
   - Non-detached (inherited-group) children can never yield
     `stopped:true`/`reaped` from `stop()`; their survivor fence stays
     closed until descendant ownership is independently disproven (G1).
   - A KILL denied by EPERM leaves the child running and tracked; the
     session stays fenced with an honest `unknown`.
4. **Observer queue serves 1 slot by design** (docs/20 §11.3): the D1
   clamp binds admission regardless of a requested larger size;
   multi-slot is explicitly post-M2. Necessity proof lives in the
   comparison test of `test/m2-acceptance-bench.test.ts` (fairness
   test's own `peakInside` is discipline, not a mutant proof).
5. **M3 provisioner residue**: a routing-poisoned worktree is never
   auto-removed — kept until an operator repairs config or removes
   manually; the terminal-task TOCTOU and the force-discard path are
   inside the accepted precondition set (round-9 convergence statement
   is explicitly bounded by these, not a claim of universal
   correctness).

## Housekeeping — resolved since the 2026-11-02 edition

1. ~~Commit the fix set~~ — committed and superseded; HEAD is `865dbdd`.
2. ~~`.tre/` audit-artifact policy~~ — resolved: `.tre/tmp/` and
   `.tre/audit/` are in `.gitignore` (lines 64/66); the r5–r8 review
   MDs are tracked (repo convention: consolidated reports committed,
   raw logs never).
3. ~~Release/version~~ — v0.4.7, v0.4.8, and v0.4.9 cut since; tag
   `v0.4.9` sits on HEAD, package version matches.

## Open decisions for the user (next workstream — Hong's pick)

Nothing is broken; everything below is **scope not yet started**, per
the docs/11 build plan and docs/20 §14 (explicitly deferred from M2):

1. **P9/M3 — promotion/rollback + fleet budget layer: CONTRACT
   DRAFT v4 — UNREVIEWED PROPOSAL** (2026-11-13,
   `docs/21-p9-m3-promotion-rollback-fleet-budget.md`). v1 failed a
   full-severity self-audit (2 blockers + 5 majors + 1 minor); v2 then
   FAILED a round-2 adversarial review (2 blockers — an admission
   source no producer can create, and a CAS that follows a symbolic
   `main` onto the wrong branch, reproduced on git 2.54 — + 4 majors +
   1 minor; dispositions tabled at docs/21 foot). v3 carried the fixes
   (promotion source = the real P12 episode-branch rule; `--no-deref`
   CAS + symref/checked-out-main refusals; indeterminate-Σ fleet
   denial — no "lower bound" admissions; NO numerical overshoot
   claim; operator-declared episode-root registry; object-store
   rollback with provenance checklist) — and then FAILED its own
   confirming-round audit (1 blocker — the current episode's own root
   was unregistered, so a custom-root episode spent invisibly — + 4
   majors + 1 minor; dispositions tabled at docs/21 foot). v4 carries
   the fixes (current-root registration gate with canonicalization;
   directory-based discovery with layout-marker new-vs-missing ledger
   distinction; discriminated projection inputs; `M == E`
   `already-merged` no-op; redelivery-as-coverage with zero second
   estimate).
   Two independent slices: **A** — episode→main promotion + rollback
   (new leaf `src/integration/promote.ts` on the P12 CAS/no-effect
   doctrine, Q5 human gate; rollback evidence = journal ⇄ trailer ⇄
   parentage) and **B** — fleet budget layer (pure
   `src/budget/fleet.ts` composing per-episode `projectLedger`
   semantics, machine-level USD cap file, admission-time-only denial —
   running attempts never interrupted). **Next gate: one CONFIRMING
   adversarial round on v4 itself** (docs/16 precedent —
   contracts are attacked, not asserted; round-2 lesson: findings must
   be reproduced/verified before acceptance); only then **D1–D9 sign-off**
   (docs/21 §4), each with a proposed resolution; D7 proposes slice A
   first. Fresh-session handoff, broader decomposition, and richer
   P13 views are explicitly NOT in docs/21 (reasons logged there §0).
2. **P9/M4** — dashboard/matrix lanes, multi-episode fleet scheduling,
   CLI attach. (docs/21 §2.5 `fleetSummary` is the read-plane input
   M4's dashboard lane will render — no M4 work implied.)
3. **P13 deferred slices** — matrix lanes, dashboard transport,
   episode replay UI, meta-telemetry (the escalation channel + park
   parity shipped; these did not).
4. **Cross-host workers** (docs/11 §8 Q4 transport), **per-task
   leases**, **dynamic capacity probing** — scoped out of M2, still
   open.

## Recommended next step

Run a FRESH CONFIRMING adversarial round on docs/21 v4 (docs/16 pattern —
findings must be verified against `src/`/reproduced before acceptance,
the round-2 discipline), then sign off (or amend) D1–D9 in docs/21 §4 —
scoping needs no code, but sign-off is Hong's per-item act and the
confirming round is its precondition — then implement slice
A per docs/21 §5
delivery shape (leaf module + tests → adversarial audit rounds to
convergence → host wiring as a separate increment).
