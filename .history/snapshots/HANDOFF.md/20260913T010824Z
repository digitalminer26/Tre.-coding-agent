# HANDOFF — resume point (2026-09-12, WS9 done)

## Where we are
WS0–WS9 complete and green. The MVP is done end to end: wire, loop, tools,
prompt/skills, sessions, CLI, safety, eval, and context compaction. Only
**WS10 (Ink TUI)** remains in the plan.

Landed today (WS9 — context compaction, D10):

- **Auto-compaction between LLM turns.** The loop's existing
  `prepareNextTurn` hook is wired in `runTurn` (CLI): when the last
  assistant usage (`totalTokens + maxTokens + 1024 slack`) would exceed
  `contextWindow`, the older messages are folded into ONE silent LLM call
  (no tools) and the context becomes `[summary-user-message, …kept]`.
- **Keep policy (D10):** the recent tail up to ~8192 *estimated* tokens
  (chars/4, `--compact-keep <n>`), snapped to unit boundaries — an
  assistant toolCall is never split from its ToolResultMessages — and the
  most recent user message always survives (nothing safe to fold → skip).
- **Iterative summaries:** if the context already starts with a summary,
  the summarizer prompt folds it in ("produce an UPDATED summary").
  Verified live: two consecutive compactions in one run.
- **Session persistence:** the WS5 `compaction` entry is now written for
  real (`firstKeptEntryId` = first kept message's entry id), so a resumed
  run replays to exactly `[summary, …kept]`. This forced **incremental
  persistence** — `runTurn` now appends each message on
  `done`/`tool_execution_end` (was: batch after `agent_end`) and tracks
  message→entry-id (`entryIds` map, seeded from the replay on `--resume`).
  Side benefit: a kill mid-run keeps the whole run, not just the prompt.
- **New contract citizen (D10):** `context_compacted` AgentEvent
  (CLI-emitted, not loop) — the CLI prints a `✂` line on stderr.
  `replaySession` now also returns `contextEntryIds` (parallel to
  `context`).
- **I3:** a failed/empty summary call skips compaction for that turn —
  the run continues uncompacted, never crashes.
- **Pure core:** `src/context/compact.ts` (estimateTokens, shouldCompact,
  planCompaction, renderTranscript, summarizePrompt, makeSummaryMessage,
  compactContext) — no I/O, injectable StreamFn.
- **CLI flags:** `--no-compact` (off), `--compact-keep <n>` (default 8192).
  Compaction is on by default whenever a session exists (no session →
  nothing to persist a boundary → no compaction).

## WS9 verification
- `test/compact.test.ts` (14 tests): trigger, plan invariants (unit
  boundaries, last-user survives, no overlap/loss), transcript rendering +
  truncation, summarizer prompt (incl. iterative), compactContext happy /
  not-needed / failed / empty (no tools on the silent call, captured
  request assertions).
- `test/cli.test.ts` (+4 e2e, fake stream): parseArgs; over-budget mid-run
  → silent call + compacted context + compaction entry replays;
  `--no-compact` → full history, no entry; failed summary → run continues
  uncompacted.
- `test/cli-live.test.ts` (live slice 5, RUN_LIVE=1): small-window model
  copy trips the trigger mid-run against the real 27B; asserts the `✂`
  line, ≥1 compaction entry, replayed context starts with the summary,
  and the summary captured a seeded fact verbatim (passphrase). PASS.
- Full fast suite: **194 tests, 0 fail** (6 live skipped).
- Manual live run: two back-to-back compactions (~2.5k → 809-char summary;
  then 2.7k → 1056-char updated summary), task still completed correctly.

## Remaining
- **WS10 — Ink TUI** (the only workstream left): streaming render,
  tool-call display, diff view, keybindings. Consumes the same
  `AgentEvent` stream the CLI already prints (now incl.
  `context_compacted`).

## Conventions
- **I3**: failures are data (isError results, exit codes), never uncaught
  throws. **D7**: blocked/denied = isError ToolResult the model reads.
  **D8**: destructive bash confirms even under --yes. **D9**: eval scoring
  (single turn, first tool call, argsSubset + argsContains). **D10**:
  compaction semantics (above; full text in PLAN §9).
- Tests: `node --test` (no framework), tsc strict, ESM `.js` suffixes on
  relative imports. Live tests gated `RUN_LIVE=1` (models.json → TKG
  vks-llama, --parallel 1, so live tests are slow: ~105s full live file).
- File history: every agent-made change is snapshotted in `.history/`
  (see CHANGELOG.md). Git: commit per workstream with `WS<n>: ...` subject
  + a docs commit for HANDOFF/PLAN updates.
- The model is a 27B Q4 — live prompts must be short and direct, or it
  ignores instructions (lesson from WS6).

## How to resume
1. `npm test` (fast, 194 tests); `RUN_LIVE=1 npm test` (final gate);
   `npm run eval` (live 3-task eval).
2. WS10: an Ink app consuming `AgentEvent` (see `printEvent` in
   src/cli/main.ts for the current plain-text rendering to replace).
   Note the TUI will want `context_compacted` styled distinctly.
