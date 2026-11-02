# Independent review of H3 working-tree changes

Scope: current diff in src/runner/attempt.ts and test/attempt-runner.test.ts,
plus the untracked .tre/audit/p7-audit-verify.ts harness and resolution notes.
No implementation or existing tests modified during this review.

## Findings

### R1 — Major: numeric PID equality across generations clears historical unknown-group ownership
Location: src/runner/attempt.ts:461-475.

survivorTupleClaim collects proven/unproven identities in Set<number> across
an entire stable attemptId. A resume is a different spawn and PID reuse is
possible. A later generation with the same numeric PID and detached:true or
pgid removes an older generation's unknown-mode claim. That does not prove
anything about descendants of the older process in its unknown group.
Both analyze and confirmStopped share this unsafe release.

Reproduced with two ok records for t1-a1: gen1 pid=999991, no mode/group;
gen2 pid=999991, pgid=999991, detached=true. With negative current probes,
reconcile returns spawn (no ownership flag) and confirmStopped succeeds.

Fix: match proof to spawn identity (generation, or a causally delimited
legacy intent/resolve segment), not just PID; retain safe same-spawn
intent-to-ok enrichment. Test same PID in distinct generations and legacy
resume segments, and same-spawn enrichment as a positive control.

### R2 — Major, retained safety hole: identifier-less ok tuples are released by ordering
Location: src/runner/attempt.ts:1220-1240.

The rejection of H3-1 relies on the comment's claim that ok without pid
cannot exist. The journal schema permits it (AttemptRecord.pid is optional),
and the runner intentionally consumes legacy journals/state hints. The
existing test fixtures also use this shape. markSuperseded does not check
spawnOutcome before allowing the no-probe ordering escape.

Reproduced by appending t1-a1 ok gen1 with neither pid nor pgid: reconcile
parks. Append t1-a2 ok gen2 with proven, dead identities: reconcile returns
spawn and lists a1 as superseded, without new evidence about a1. This is
retained behavior rather than a newly introduced regression, but the new
comment and resolution document incorrectly dismiss the safety finding.

Fix: distinguish an identifier-less observed-ok claim from any explicitly
allowed unresolved-intent ordering escape. Keep the former fenced or reject
such legacy input explicitly. Add a reopen test showing a later anchor alone
does not erase the observed-ok claim.

### R3 — Medium: block B's late-stamp assertion never appends a stamp
Location: .tre/audit/p7-audit-verify.ts:134-140.

After initial refusal, the harness invokes confirmStopped again with a new
evidence string. No seed/append occurs between calls. The passing assertion
therefore tests repeated refusal, not late detached evidence. Its permanence
claim also contradicts survivorTupleClaim's deliberate same-PID enrichment.

Fix: append the proposed late record, distinguish same-spawn enrichment from
a different spawn/generation, and assert the intended behavior for each.
Update the resolution notes to match that scoped policy rather than claiming
all unknown-mode taint is permanent.

### R4 — Medium: generation-ordering test cannot distinguish generation from append order
Location: test/attempt-runner.test.ts:1243-1252.

The test appends gen1 then gen2. Replacing the generation comparison with
append-position ordering would still pass every assertion, so it does not
pin the generation-specific branch it claims to cover. run() also opens on
deterministically dead tuples whether or not they are superseded; the
superseded-list assertions are the meaningful part of this test.

Fix: append the higher-generation successful anchor before the lower-
generation record (and optionally invert timestamps/IDs too). Assert the
lower generation is superseded despite the contradictory append order.

### R5 — Minor: obsolete subclass predicate and unreachable fence branch remain
Locations: src/runner/attempt.ts:1053-1069, 1253-1273; AttemptView.unprovableGroup.

Every true survivorTupleClaim necessarily has at least one record matching
the unprovableTuples predicate. Thus ownership=true implies unprovableGroup=
true, making the detached-survivor message branch at line 1069 unreachable.
Detached:true alone is explicitly not survivor-class. The subclass comments
and resolution summary still claim otherwise, while confirmStopped's new
comment correctly rejects this subclass hypothesis. unprovableGroup can also
be true for a same-PID-enriched tuple with ownership unset.

Fix: remove the obsolete subclass/flag/branch or model real claim reasons
once from a shared classifier. Derive diagnostic wording from the offending
historical record rather than a.record (which is only the latest record).

## Verification

- git diff --check: clean.
- npm run build: passes.
- node --test dist/test/attempt-runner.test.js: 62 pass, 0 fail.
- npx tsx .tre/audit/p7-audit-verify.ts: ALL PASS (does not invalidate R3).
- node .tre/tmp/h3-review-repro.mjs: confirms R1 and R2:
  no-id ok BEFORE anchor: park
  no-id ok AFTER anchor: spawn superseded: [ 't1-a1' ]
  same numeric PID across generations: spawn ownership: [ undefined ]
  confirmation: true

The repo-wide suite was not rerun in this review; the prior run's results
are not represented as new verification. Recommendation: address R1/R2 and
strengthen R3/R4 before signing off the audit-cycle resolutions.
