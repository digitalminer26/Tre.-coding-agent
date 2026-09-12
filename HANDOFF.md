# HANDOFF — resume point (2026-09-12, WS7 done)

## Where we are
WS0–WS8 (MVP + safety) are complete and green. WS7 (safety & permissions)
landed today: the agent now has real permission boundaries.

- **Path sandbox** — read/write/edit are confined to the project root
  (`--cwd`, default process cwd). The safety hook resolves each `path` arg
  against the root and REWRITES `args.path` to the canonical absolute result
  (so `--cwd` actually means something — tools no longer depend on process
  cwd). Lexical check (kills `../` + absolute escapes) + realpath check on
  the deepest existing ancestor (kills symlink escapes).
- **Approval gate** — bash/write/edit are gated. Mode `ask` (default): every
  gated call prompts the human, anything but `y` denies. `--yes`:
  auto-approve except destructive bash. `--no-approve`: never prompt, block
  gated calls outright (fail-closed for non-interactive). A denial is a
  BLOCK → `isError` tool result the model reads and adapts to (I3/D7).
- **Destructive confirmation (D8, new decision in PLAN §9)** — even under
  `--yes`, bash commands matching destructive patterns (recursive rm,
  `git push -f/--force/--force-with-lease`, dd/redirection to raw devices,
  mkfs, fork bomb, shutdown/reboot/halt/poweroff) still confirm. Patterns
  are deliberately over-triggering.
- **bash runs in the project root** — `createBashTool(cwd)` factory
  (bashTool = no-cwd default).
- Prompts are serialized (one question on screen at a time; `makeAskQueue`)
  and fail closed: non-TTY stdin without an injected approver denies; a
  throwing ask() denies.

## Remaining
- **WS8 residual (small)**: an eval *runner* that plugs the real wire
  StreamFn into `runEval` (test/eval.ts already scores; nothing drives it
  end-to-end against a live model yet).
- **Phase 3 (deferred)**: WS9 context compaction, WS10 Ink TUI.

## WS7 key facts
- `src/tools/safety.ts`: `makeSafetyHooks({root, mode, ask})` → the
  `BeforeToolCall` hook (undefined = allow, `{args}` = rewrite,
  `{blocked}` = refuse). `checkPathWithinRoot(root, p)` (exported, tested),
  `destructiveBashPatterns(cmd) → string[]` (labels; [] = safe),
  `makeAskQueue(inner)`, `AskApproval`/`ApprovalMode` types.
- Hook order per call: (1) path sandbox for read/write/edit (missing/non-
  string `path` → blocked — defense in depth), (2) approval gate for
  write/edit/bash (read is never gated), (3) bash destructive
  classification feeds the gate. A sandboxed path tool ALWAYS returns
  `{args}` (the rewrite) even when allowed.
- CLI (`src/cli/main.ts`): `MainDeps.askApproval?` injection; one-shot uses
  a throwaway readline per question (TTY only; non-TTY → deny); the REPL
  shares its readline with the approver via a `consumer` slot — either the
  `you> ` prompt or an approval prompt is pending, each `line` resolves the
  pending consumer (piped stdin can answer: `printf 'msg\nn\n' | coding-agent`).
  `wiredTools` swaps bash for `createBashTool(root)`; the executor =
  `makeToolExecutor({ beforeToolCall: makeSafetyHooks(...) })` flows through
  `runTurn`'s `executeToolCall?` dep.
- Pipeline block message: `Tool "<name>" was blocked: <reason>` (isError).
  The CLI prints it truncated at 200 chars — the FULL reason lives in the
  session's toolResult (tests should assert on the session, not the print).
- Tests: `test/safety.test.ts` (31 tests: sandbox incl. symlink escape +
  fail-closed root, D8 pattern table, all 3 modes, FIFO queue, pipeline
  integration). `test/cli.test.ts` gained WS7 section (injected
  askApproval deny/approve, --yes, --no-approve, absolute + `../` escapes
  via --session assertions, bash `pwd` in root, bad --cwd → exit 2).
  `test/cli-live.test.ts` slice 4 = live denied approval (real model reads
  the isError result); slices 2/3 now use `--yes --cwd <dir>` (chdir hack
  gone).
- Verified live (RUN_LIVE=1): all 175 tests pass incl. 4 CLI slices.
  Verified by hand: non-TTY one-shot denies without hanging; TTY (via
  `script -q /dev/null`) prompts and answers; REPL piped deny/approve both
  work, EOF exits cleanly.

## Conventions
- **I3**: failures are data (isError results, exit codes), never uncaught
  throws. **D7**: blocked/denied = isError ToolResult the model reads.
  **D8**: destructive bash confirms even under --yes.
- Tests: `node --test` (no framework), tsc strict, ESM `.js` suffixes on
  relative imports. Live tests gated `RUN_LIVE=1` (models.json → TKG
  vks-llama, --parallel 1, so live tests are slow: ~45s full suite).
- File history: every agent-made change is snapshotted in `.history/`
  (see CHANGELOG.md). Git: commit per workstream with `WS<n>: ...` subject
  + a docs commit for HANDOFF/PLAN updates.
- The model is a 27B Q4 — live prompts must be short and direct, or it
  ignores instructions (lesson from WS6).

## How to resume
1. `npm test` (fast, 175 tests) and `RUN_LIVE=1 npm test` (final gate).
2. WS8 residual: wire a tiny runner (`node test/eval.ts` or `npm run eval`)
   that loads models.json, builds the real openai-completions StreamFn,
   runs a 3-task suite (create file / fix typo / run command + report exit
   code) and prints pass/fail per task.
3. Phase 3 when the MVP feels stable: WS9 compaction, WS10 TUI.
