# Audit cycle H3 (cycle 12) — resolutions

Status: ALL RESOLVED. Full suite green: 62/62 attempt-runner tests, 1673/1687
repo tests pass (14 skipped, 0 failed), `tsc` clean, and
`.tre/audit/p7-audit-verify.ts` prints ALL PASS (10 checks incl. new B/B2).

## Findings & dispositions

### H3-1 (markSuperseded releases probe-less views) — REJECTED as major, documented
Doctrine: a view with NO probe identity (no pid anywhere, no pgid) is
released by ORDERING, not by a deterministic negative. Deliberate:
such a tuple is structurally un-probeable (confirmStopped also refuses
it — nothing to probe), so "blocking forever" would deadlock the
session with zero evidence-based exits. An "ok" record without a pid
cannot exist (resolver requires pid > 0), so the class is exactly the
never-resolved intent, whose evidence-based release IS replacement by
a newer tuple. Survivor-class tuples never reach this path (the
unconditional ownership skip in markSuperseded covers them).
Documented in the markSuperseded comment block in src/runner/attempt.ts.

### H3-2 (unresolved intents with pid, no group identity escape survivor class) — FIXED
Added `survivorTupleClaim(records)` — the SINGLE shared predicate used
by the analyze scan AND the confirmStopped gate. Class = a
non-confirmation, non-failed record that either
- asserts `detached === false` (inherited FOREIGN group — contradiction
  clause, unprovable regardless of the rest of the tuple), or
- journalled a pid with no pgid and no `detached:true` whose pid has no
  proven-mode record elsewhere in the tuple (mode never recorded).
Includes unresolved intents (spawnOutcome null). `detached:true` alone
is NOT survivor-class: the hypothetical private group (pgid===pid) is
determinable and confirmStopped's B/G3 gate governs those.
Consequence pinned by the harness (block B): taint is PERMANENT — a
late detached stamp on a tainted tuple does not clear it
(release-by-re-seed would be release-by-ordering).

### H3-3 (harness block A seed masked the G2 supersede check) — FIXED
`.tre/audit/p7-audit-verify.ts` block A: the t1-a1 seed is now
proven-identity (`pgid + detached:true`), so the check exercises the
G2 rule (a confirmed never-ok intent cannot supersede a spawn-observed
ok tuple) instead of passing trivially via survivor-class parking.
Block B was also rewritten: the old "re-seed with detached:true then
confirm" step contradicted the H3-2 permanence doctrine (it threw with
the now-correct fence); replaced with an explicit
"late stamp does NOT clear the taint" check + a separate fresh-tuple
B2 case proving detached-from-start tuples still confirm via the
ESRCH-group gate.

### H3-4 (foreign-uid test seed was survivor-class) — FIXED
Test "confirmation refuses foreign-UID running pid evidence" now seeds
`detached:true, pgid:999991` so the tuple is NOT survivor-class; the
refusal is provably from the foreign-uid logic. The confirm gate itself
also gained the explicit foreign-uid branch message (H3-4 in-code note).

### H3-5 (blanket fence message misdescribes the claim) — FIXED
Two places branch on the ACTUAL claim now:
- run-fence ownership branch: mode-UNRECORDED / NON-detached tuples →
  "no evidence path … manual journal repair"; DETACHED survivor
  tuples → "death IS determinable … call confirmStopped" (with
  `view.unprovableGroup` computed in analyze to distinguish them).
  G1 regression caught this: message keeps "NON-detached" wording for
  detached:false records (message branch on a.record.detached).
- ok/failed blocking branch: "was observed spawned ok" only for ok
  latest; failed-latest admitted by H2-1 says "a HISTORICAL process
  recorded in the same tuple is not disproven".

### Sonnet follow-up F2 — folded into H3-5 + H3-2
The "detached survivor subclass" hypothesis was audited and REJECTED:
survivorTupleClaim is false for `detached:true`-without-pgid tuples
(proven mode), so confirmStopped's hypothetical-group gate governs
them; no unconditional confirm refusal exists for them. Documented in
the confirmStopped comment block.

## New tests
- H3-6: H2-1 variant with an INCONCLUSIVE (undefined) historical-pid
  probe under a failed latest — park, fence cites "inconclusive", and
  strict doctrine holds: a newer generated tuple does NOT supersede an
  inconclusive view (no deterministic negative ⇒ no ordering release).
- H3-7: PURE generation-ordering supersession with non-survivor seeds
  (both tuples detached:true + pgid, both dead) — pins the ordering
  release itself, which the existing G1 "generation" variant could not
  show (its survivor seed masked the mechanism).

## Verification
- `npm run build` — tsc clean.
- `npx tsx --test test/attempt-runner.test.ts` — 62 pass / 0 fail.
- `npm test` — 1673 pass / 0 fail / 14 skipped.
- `npx tsx .tre/audit/p7-audit-verify.ts` — ALL PASS (10 checks).
