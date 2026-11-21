# Owner decision review — G2–G5 open decisions (contract v34)

Companion to §14.11.5 / §14.12.5 / §14.13.7 / §14.14.6. 16 decisions,
all drafted with a default, none ratified. Two were settled by audit
evidence (the alternative is known-unsafe); the rest are genuine
judgement calls. "AUDIT-CLOSED" below means terra c1–c35 (incl. the
v33 round, CLEAN ×3 on e28aa21) proved the alternative wrong or
unsafe — ratifying the default there is a formality.

Legend: [FORMALITY] = default is audit-closed, ratify to proceed.
[JUDGEMENT] = real tradeoff, your call.

## G2 — norm state (§14.11)

**O-G2-1 [FORMALITY] Digest mandatory at `ratified` only.**
- Pro (default): drafts may churn without a content hash per edit;
  once ratified, the digest is what pins dispatch (`stale-norm` gate)
  and what findings cite — mandatory exactly where identity matters.
- Con: a `drafted` norm has no integrity check at rest — someone can
  edit an unratified norm's text unnoticed. Accepted: unratified text
  binds nothing, so integrity would guard a non-asset.
- Alternative (digest on drafts too): hashes churn every edit;
  rejected by cost for zero authority gain.

**O-G2-2 [FORMALITY] `from` field on norm transitions.**
- Pro: the transition is a compare-and-set record; `from` (expected
  prior revision) is what makes the CAS checkable after the fact.
- Con: differs from audit-finding-update's shape — two similar records
  with one field difference (audit round c-audits verified the
  difference is intentional, not drift).

**O-G2-3 [FORMALITY] Changed norm = new id, never in-place edit.**
- Pro: findings/dispatch pins cite id+digest; an in-place edit would
  silently change what historical findings point at — the exact
  impersonation class terra c1-C1-F4 attacked.
- Con: id proliferation across revisions. Cost of correctness.

**O-G2-4 [FORMALITY] Identity in `norm-created`; `norms.json` rebuildable.**
- Pro: one append-only source of truth; a projection can be rebuilt
  and a rebuild mismatch is a corruption signal (round-0 B4).
- Con: you cannot hand-edit `norms.json` — by design (P13 channel is
  the only human surface).

**O-G2-5 [FORMALITY] Supervisor stamps `normId`+digest, not the worker.**
- Pro: workers report what they were dispatched against; a
  self-stamped digest is self-certification (round-0 B5: null-digest
  findings dodged staleness).
- Con: supervisor must hold the pin set at dispatch — it already does.

**O-G2-6 [FORMALITY] Intake resolves against the dispatch PIN set ONLY.**
- Pro: determinism/replay — intake compares records to records, never
  to a mutable "current state"; freshness is enforced at dispatch
  (`stale-norm`), missing pin is `norm-unpinned` (v4 closed the
  vocabulary clash).
- Con: a finding citing a just-superseded norm refuses instead of
  gracefully re-targeting — correct for an append-only ledger; the
  re-dispatch path handles it.

**O-G2-7 [FORMALITY] Content-addressed snapshots, missing/mismatch ⇒ NOT ratified + needs-owner.**
- Pro: fail-closed; a committed transition without its snapshot text
  means nobody can prove what was ratified (c1-C1-F6).
- Con: an operator mistake (deleted snapshot file) stops a norm rather
  than being silently repaired — the intended behavior.

## G3 — convergence (§14.12)

**O-G3-1 [JUDGEMENT] Opinion-basis blockers: `owner-only` closure (default) vs `hold-until-repro`.**
- Pro (default): an opinion blocker is unfalsifiable by construction;
  letting the orchestrator close it re-opens the "auditor says clean"
  hole this whole section exists to close (HANDOFF G3). You've lived
  the mirror image of this: the c25 verdict-refusal — self-declared
  incompleteness is not actionable either way, but ONLY you may wave
  a blocker through.
- Con: every opinion-class blocker needs your attention; with a
  chatty auditor that's toil (this round produced exactly 0 opinion
  blockers at verdict level, and c25 was the one hedging incident).
- `hold-until-repro`: orchestrator may park it but never close —
  slower convergence, blocker still eventually needs you; the
  difference is only whether the orchestrator can count it
  "resolved-enough" mid-round. Given the ledger keeps holds as
  sign-off holders (C1-F12), the two options converge on the same
  end state; default just makes ownership explicit sooner.
- **Recommend: `owner-only`.** You are the repro oracle for
  unfalsifiable claims.

**O-G3-2 [JUDGEMENT] `cleanRoundsRequired = 2`.**
- Pro: k=2 matches HANDOFF G3's implied consecutive rule; cheap.
- Con (live evidence, in both directions): this session showed k=2 is
  fragile as a *definition of clean* — c26/c27 were both CLEAN and
  c28 found a MINOR the pair missed; same for c29/c30→c32. The final
  streak (c33/c34/c35) was k=3. On the other hand the doc's verdict
  is about CONVERGENCE (stop-early signal), not proof-of-perfection,
  and raising k to 3 costs +1 auditor cycle per round (~13 min +
  spend) — the v33 round paid ~$? per cycle to show k=2 can be
  overturned by one fresh sample.
- The escape hatch exists either way: "lower values are not permitted
  without an owner-recorded policy change", and you can ratify 2 with
  a per-episode bump written in the policy line.
- **Recommend: ratify 2 as the floor, and set 3 for
  contract-text audits** (prose contracts have the widest sampling
  surface); keep 2 for code-defect rounds where repro is mechanical.

## G4 — cycle budget (§14.13)

**O-G4-1 [FORMALITY] Enforce at cycle boundary only (no mid-flight kill).**
- Pro: a kill at the cap yields partially-applied fixes — the worst
  state for an append-only, replay-based system.
- Con: a single huge cycle can overshoot the cap once (bounded by the
  cycle's own admission). Chosen knowingly; O-G4-2 discloses it.

**O-G4-2 [JUDGEMENT] Estimate-overshoot disclosed, not bounded.**
- Pro: hard reservation across concurrent cycles is distributed-systems
  machinery the single-episode loop doesn't need; disclosure keeps the
  ledger honest and the code simple.
- Con: N concurrent groups × per-cycle estimate is the true worst
  case, and you learn of overshoot in the ledger, not at the meter.
  If you ever move to multi-episode or fleet spend, revisit — this is
  the decision with the shortest shelf-life.
- **Recommend: ratify; re-open when concurrency > 1 wave becomes
  real.**

**O-G4-3 [JUDGEMENT] Recovery spend of cycle-dispatched tasks counts toward the cycle cap (default) vs ring-fence under §14.7.**
- Pro (default): one number answers "what did this cycle cost"; no
  escape where a "recovery" relabel dodges the cap (c1-F8/M8 class).
- Con: recovery is partly involuntary (torn tails, crash retries), so
  bad luck burns design budget — a machine hiccup can consume the
  next design cycle's room.
- Ring-fence alternative is legitimate but demands the `maxUsd` policy
  line explicitly state "audit+implement only" — ambiguity here was
  v1's actual bug. If your infra spend is volatile (spot GPU pods —
  the llama stack), ring-fencing is defensible; just write the scope
  into the policy line.
- **Recommend: default (count everything) unless pod-flakiness is a
  recurring cost driver.**

**O-G4-4 [FORMALITY] Unknown spend consumes ALL remaining headroom until reconciled.**
- Pro: the only fail-closed option — a crashed cycle that already paid
  can't be granted a second cycle on an estimate (v1's count-at-
  estimate was withdrawn for exactly this).
- Con: one crashed provider call can freeze the loop until you
  reconcile. That's the intended price: freeze-and-ask beats
  double-spend.

## G5 — partitioning (§14.14)

**O-G5-1 [FORMALITY] Unscoped findings collapse to ONE serial group (strict default).**
- Pro: a finding without `scopeRefs` could touch anything; parallel
  "anything" is guaranteed merge conflicts and unverifiable scope.
- Con: throughput — one unscoped finding serializes the wave. Looser
  variant (overlap only same-surface) trades safety for throughput
  without evidence; can be revisited when unscoped findings are
  measured common.

**O-G5-2 [FORMALITY] File-granular overlap: dir-prefix serializes; same-file never parallel.**
- Pro: the platform (git + worktrees) cannot grant below-file
  isolation; v1's anchor-parallelism was false and the audit removed
  it (round-0 M6, c1-F5).
- Con: two findings editing disjoint regions of one file serialize —
  accepted; below-file parallelism needs a merge-layer mechanism, and
  making that a schema promise was v1's error.

**O-G5-3 [JUDGEMENT] Scope-escape mandatory (closed); REMAINING QUESTION: does an escape VOID the wave's already-integrated candidates? Drafted: NO — per-candidate refusal, cycle goes unclean.**
- Pro (drafted no): candidates are individually CAS-integrated with
  their own gates; a batch-level void punishes verified candidates
  for one bad neighbor and complicates replay (which integration
  survived?). Unclean-cycle is the pressure signal.
- Con: the wave ships integration of K candidates plus a dangling
  needs-owner while the escapee is refused — an unclean episode state
  you must adjudicate next round anyway.
- The scary variant (terraform-style "no partial apply") doesn't fit
  here: P12 integration is per-candidate and individually revertable
  (ownership record §14.5), so per-candidate refusal loses nothing
  durable.
- **Recommend: drafted no; add one condition — an escape in a wave
  touching the same norm as an integrated candidate should force a
  re-verify of that candidate (§14.14's shared-interface dependency
  review covers the same shape; extend the wording if you want it
  explicit).**

## Summary table

| Id | Call | Recommendation |
|---|---|---|
| O-G2-1…7 | all FORMALITY | ratify defaults |
| O-G3-1 | judgement | `owner-only` |
| O-G3-2 | judgement | 2 floor; 3 for prose-contract audits |
| O-G4-1 | formality | ratify |
| O-G4-2 | judgement | ratify; revisit with fleet scale |
| O-G4-3 | judgement | count-all (default) unless pod-flakiness drives spend |
| O-G4-4 | formality | ratify |
| O-G5-1,2 | formality | ratify |
| O-G5-3 | judgement | no void; consider same-norm re-verify condition |

Ratification surface: each is a P13 typed `norm-ratification`
exchange (§14.11.4) per the contract — the sheet above is the reading
material, not the ratification itself.
