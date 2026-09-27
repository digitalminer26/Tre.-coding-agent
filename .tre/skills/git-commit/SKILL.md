---
name: git-commit
description: Commit the current codebase safely. Runs the quality gate on exactly what will be committed, stages everything, commits, and verifies the commit landed — refusing guardrail-zone commits and clean-tree no-ops. Use when the user says "commit", "git commit", "commit the codebase", "commit the current work", or after an increment is done and needs to land.
---
# git-commit skill

One action: **commit the current codebase** — gated, staged, verified.

The mechanical core is `scripts/git-commit.sh`. Do not hand-roll `git add`/
`git commit` for this; invoke the script so the gate + verification always run.

## Invoke

```sh
sh scripts/git-commit.sh "<message>"
```

The message must be ONE sentence — what and why (the self-improve rule: a
commit you cannot explain in one sentence is too big).

## What the script does (in order)

1. **Clean-tree check** — if `git status --porcelain` is empty it prints the
   HEAD and exits **10** (nothing to commit). This is a normal outcome, not an
   error: a clean tree means the codebase is already committed.
2. **The gate** — runs `GATE` (default `npm test` = quality gate + tsc + full
   test suite) from the repo root, *before* staging, so it verifies exactly
   what will be committed. Gate failure → exit **11**, nothing staged or
   committed.
3. **Stage** — `git add -A` (the whole current codebase), prints the count.
4. **Commit** — `git commit -m "<message>"`. The pre-commit **guardrail hook**
   runs here and rejects any staged set touching the guardrail zone.
5. **Verify** — confirms the new HEAD's subject equals the message.

## Exit codes

| code | meaning |
|------|---------|
| 0 | commit created and verified |
| 1 | commit failed (incl. guardrail-zone rejection) |
| 2 | usage error (no message / not a git repo) |
| 10 | nothing to commit (tree already clean) |
| 11 | quality gate failed (nothing staged, nothing committed) |

## Guardrail zone — the agent NEVER bypasses

If the commit is rejected because it touches the guardrail zone
(`src/tools/sandbox.ts`, `src/tools/safety.ts`, `src/tools/bash.ts`,
`scripts/guardrail-check.sh`, `scripts/git-hooks/*`, `scripts/check-deps.mjs`,
`.tre/skills/self-improve/SKILL.md`), STOP and tell the user. A human commits
such a change themselves with `GUARDRAIL_BYPASS=1 git commit ...`. The agent
must never set that variable.

## Rules

- The gate is the real `npm test` by default. Do not weaken it to make a
  commit pass.
- One behavior per commit. If the staged set is large, that is a signal the
  increment was too big — say so.
- Report the script's stdout (HEAD, file count, subject) back to the user.
