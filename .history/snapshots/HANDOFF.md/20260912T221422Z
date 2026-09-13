# HANDOFF — resume point (2026-09-12, WS8 done)

## Where we are
WS0–WS8 (MVP + safety + eval harness) are complete and green. The MVP is
functionally done: wire layer, loop, tools, prompt/skills, sessions, CLI,
safety, and the eval harness all exist and are tested.

The last remaining piece — the WS8 eval *runner* — landed today:

- **`npm run eval`** (`test/eval-run.ts`) plugs the real wire StreamFn
  (`openAiStream`) into `runEval` and runs the PLAN WS8 3-task suite
  (create file / fix typo / run command + report exit code) against a live
  model from models.json. Prints a pass/fail table per task; exits
  0 = all pass, 1 = any fail, 2 = setup error (bad args / missing models
  file / unknown model). A `--timeout <ms>` (default 180s) aborts the
  stream — an aborted task scores as a failed task (I3: no hangs).
- **Scorer extension (D9)**: `EvalTask.expected.argsContains` — substring
  match for open-ended string args. Added because the 27B answered
  "run pwd and report its exit code" with `pwd; echo "Exit code: $?"` —
  an eval that fails a task because the model did *more* than the minimum
  is mismeasurement. `argsSubset` (deep-equal) is unchanged.
- Verified live: **3/3 PASS** against TKG `Qwen3.8-27B-UD-Q4_K_M`
  (baseline 2026-09-12). The 27B is run-to-run variable — an earlier run
  had it `read` before `edit` on fix-typo (single-turn FAIL). Treat the
  eval as a regression baseline, not a gate; a FAIL is a measurement.

## Remaining
- **Phase 3 (deferred)**: WS9 context compaction, WS10 Ink TUI.

## WS8 (eval) key facts
- `test/eval.ts`: `runEval({streamFn, model, tasks, systemPrompt?, signal?})`
  → `EvalResult[]` (`{task, pass, reason, calls}`). Scoring is single-turn:
  one LLM call per task, inspect the first assistant message, score the
  FIRST emitted tool call against `expected.toolName` + `argsSubset`
  (deep-equal) + `argsContains` (substring). `stopReason: "error"` →
  failed task with the stream error in `reason`; no tool call → "no tool
  call emitted". `formatEvalReport(results)` → the printable table.
- `test/eval-run.ts`: `EVAL_TASKS` (the 3 PLAN tasks, real `DEFAULT_TOOLS`
  schemas), `parseArgs` (`--models <path>` default `./models.json`,
  `--model <id>`, `--timeout <ms>`, `--help`), `main(argv) → exit code`
  with the realpath entry guard (importable without side effects).
  Status line goes to stderr; the report to stdout.
- Test coverage: `test/eval.test.ts` (5 tests: pass/wrong-tool/wrong-args,
  argsContains hit/miss/non-string, no-call, stream error, report format)
  — all via fake-stream, no network. Full fast suite: 176 tests.
- Live prompts must stay short and direct (WS6 lesson, restated in
  eval-run.ts comments).

## Conventions
- **I3**: failures are data (isError results, exit codes), never uncaught
  throws. **D7**: blocked/denied = isError ToolResult the model reads.
  **D8**: destructive bash confirms even under --yes.
  **D9**: eval scoring — single turn, first tool call, argsSubset +
  argsContains.
- Tests: `node --test` (no framework), tsc strict, ESM `.js` suffixes on
  relative imports. Live tests gated `RUN_LIVE=1` (models.json → TKG
  vks-llama, --parallel 1, so live tests are slow: ~45s full suite).
- File history: every agent-made change is snapshotted in `.history/`
  (see CHANGELOG.md). Git: commit per workstream with `WS<n>: ...` subject
  + a docs commit for HANDOFF/PLAN updates.
- The model is a 27B Q4 — live prompts must be short and direct, or it
  ignores instructions (lesson from WS6).

## How to resume
1. `npm test` (fast, 176 tests) and `RUN_LIVE=1 npm test` (final gate).
2. `npm run eval` — live 3-task eval vs the default models.json model.
3. Phase 3 when the MVP feels stable: WS9 compaction, WS10 TUI.
