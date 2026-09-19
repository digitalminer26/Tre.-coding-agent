---
name: self-improve
description: MANDATORY protocol for making ANY code change in this repository (the Tre Coding Agent itself) — bug fixes, features, refactors, TUI changes. Enforces the commit-first loop, the build+test gate, the guardrail zone, and TUI verification. Read this before editing.
---
# Self-improve protocol

You are improving THIS codebase. A human reviews your `git diff` after every
session and relaunches the next one from whatever you committed. The rules
below exist because a broken or careless commit breaks the NEXT launch.

## The loop (one increment at a time)

1. `git status --short` MUST be empty before you start. If not: stop and
   tell the user what is uncommitted.
2. Make ONE small change — one behavior, one file family.
3. `npm run build` (tsc). Fix until it passes.
4. `npm test` (tsc + node --test, network-free). Fix until ALL tests pass.
5. `git add -A && git commit -m "<what and why>"`.
6. If you touched `src/tui/*`: verify with a PTY capture (below) and check
   the stripped lines, not the raw ANSI.
7. Update `HANDOFF.md` — extend the current top section (or add a new one).
8. Repeat from step 1 for the next increment, or report done.

Never batch multiple behaviors into one commit. A commit you cannot explain
in one sentence is too big.

## On failure

- build or test still failing after 2 fix attempts → `git checkout .`
  (restores tracked sources), re-read the failure output, plan differently.
- NEVER leave the tree with a broken build: `dist/` is gitignored, so a
  broken state is not recoverable by `git checkout` of dist — the next
  `tre.` launch will fail until someone rebuilds from a good commit.
- The safe harbor is the `known-good-*` git tag. If you have lost the plot:
  `git checkout . && git clean -fd`, then `npm run build && npm test`, then
  tell the user exactly what you did and why.

## Guardrail zone — DO NOT MODIFY

```
src/tools/sandbox.ts   (your own kernel-sandbox policy generator)
src/tools/safety.ts    (your own approval/gating logic)
src/tools/bash.ts      (sandbox wiring in the bash tool)
scripts/guardrail-check.sh, scripts/git-hooks/*
.pi/skills/self-improve/SKILL.md
```

These are your own cage. A pre-commit hook REJECTS any commit touching them
and names the files. If a task genuinely requires changing one: STOP,
explain to the user exactly why and what would change, and wait. The user
commits such changes themselves with `GUARDRAIL_BYPASS=1`.

## TUI verification (touching src/tui/*)

Capture a real frame (ANSI stays in the file — strip it before asserting):

```bash
( ( sleep 1.5; printf '/display-bottom model\r'; sleep 2 ) \
  | script -q /dev/null tre. tui 2>&1 ) > /tmp/tui-check.out
python3 -c "import re,sys; raw=open('/tmp/tui-check.out','rb').read().decode('utf-8','replace'); \
clean=re.sub(r'\u001b(?:\[[0-9;?]*[a-zA-Z]|\][^\u0007]*\u0007|[@-Z\\\\-_])','',raw).replace('\r',''); \
open('/tmp/tui-check-clean.txt','w').write(clean)"
```

Then assert on the stripped lines: the pinned block is the LAST 8 lines —
hint / `─` / input row / `─` / 3 bottom-display lines. The input row is
always exactly 4 lines above the screen bottom.

## Sessions and turn budget

- The per-run turn cap is `--max-turns` (default 32). If a task will not fit,
  finish the current increment (committed + tested), then tell the user:
  what is done, what remains, and the exact relaunch command
  (`tre. tui --session <file>` to save / `--resume <file>` to continue).
- Sessions must live OUTSIDE the repository (D20 boundary): pass
  `--session ~/.tre/sessions/<task>-<utc-timestamp>.jsonl` or use `--session-auto`.
  The agent under test must never be able to read or edit its own session
  history — a session file inside the repo would be both readable and editable.
- Do not start a second increment after you have used ~80% of your turns.

## Definition of done

An increment is done ONLY when: tests pass, the commit is in, HANDOFF.md is
updated, and (for TUI work) a PTY capture confirms the frame. "It should
work" is not done.
