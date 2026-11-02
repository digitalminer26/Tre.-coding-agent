# Remaining items — post-R8 working-tree review

Date: working tree at 0bce050 + uncommitted R4–R7 fix set. Verdict: **no open findings**; remaining items are sign-off decisions and repo hygiene, listed with recommendations.

## Findings status — all closed

| Cycle | Findings | Status |
|---|---|---|
| R4 | F15–F19 | fixed, regression-tested |
| R5 | F16-parallel, refresh/queue races | fixed (queue serialization, snapshot revalidation) |
| R6 | R6-1 own-child bypass, R6-2 wrong-session confirm, R6-3 writer contract | fixed / documented-contract (accepted option) |
| R7 | R7-1 refresh-first coverage gap | fixed + mutation-verified (R8) |
| R8 | — | PASS, no actionable findings |

Repro suites all green against current dist/: r5-audit-repro.mjs, r6-audit-repro.mjs (corrected expectations), r7-audit-repro.mjs (6/6 adversarial). R7-1 passed 15 consecutive isolated runs and fails under the serialization-removal mutation.

## Accepted-by-design limits (not open findings)

1. **R6-3 external writers**: state.json edits outside the runner's serialized paths remain best-effort-detected, not excluded. Contract documented at src/runner/attempt.ts:1245–1255. Hard atomicity would need a cross-process lock — separate change if ever required.
2. **Final hint revalidation window**: the `currentHintState` check before the confirmation append cannot close its own read→append interval (R6-3 analysis, acknowledged).

## Housekeeping done in this pass

- Removed 9 leaked fixture dirs `.tre/tmp/r5-case-*` (aborted earlier repro runs; the repro's own cleanup now completes).
- Added STATUS banners to `.tre/audit-r5-review.md` and `.tre/audit-r6-review.md` — their REJECT verdicts were stale and could mislead a future reader.
- Fixed R7 report's new-test line reference (1634 → 1637).

## Open decisions for the user

1. **Commit the fix set.** `src/runner/attempt.ts` (+897) and `test/attempt-runner.test.ts` (+957) are uncommitted on `main` (HEAD 0bce050). Everything verified: build + quality gate pass, full suite 1711 tests / 1697 pass / 0 fail / 14 skipped, diff-check clean. Recommend committing with the "git-commit" flow when you say go.
2. **Untracked `.tre/` audit artifacts.** 9 entries (`audit-r5/r6/r7/r8-review.md`, older cycleH3 reports, `.tre/audit/`, `.tre/tmp/` at ~1.1MB) show as untracked; `.tre/tmp`, `.tre/audit*` are NOT in .gitignore (only `.tre/audits/`, `.tre/audit-cycle3/`, `.tre/implement-audit/`, `.tre/delegation/` are). Options: add `.tre/audit-r*-review.md` + `.tre/tmp/` + `.tre/audit/` to `.gitignore`, or `git add -f` the review reports if they should be durable project history. Repo convention (see docs/audits/) has been to commit consolidated human reports; raw logs scratch never. Recommendation: gitignore `.tre/tmp/` and `.tre/audit/`, commit the four r5–r8 review MDs alongside the fix commit. Not done unilaterally because it changes repo policy for `.tre/`.
3. **Release/version**: package still 0.4.7; no tag cut for this fix set. Only relevant if you want these fixes shipped — then tre-release applies.

## Recommended next step

Commit sequence: `.gitignore` additions (per decision 2) → commit source+tests+reports as one audit-cycle commit via the git-commit skill.
