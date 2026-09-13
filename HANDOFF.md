# HANDOFF — MVP complete (2026-09-12, WS0–WS10 done)

## Where we are
**All ten workstreams are done and green.** The MVP is complete end to end:
wire (WS1), loop (WS2), tools (WS3), prompt/skills (WS4), sessions (WS5),
CLI glue (WS6), safety (WS7), eval (WS8), compaction (WS9), TUI (WS10).
There is no remaining plan work — further work is post-MVP (see PLAN §8:
Anthropic-native wire, images, subagents, themes, sandboxing, multi-model
routing, OAuth).

Landed today (WS10 — Ink TUI, D11):

- **`coding-agent tui` subcommand** — a full interactive UI on top of the
  SAME `AgentEvent` stream the plain CLI prints (the REPL is untouched,
  still the default).
- **Architecture (D11):** pure state machine (`src/tui/state.ts` —
  `applyEvent` folds events into a `TuiState`; input key handling is pure
  functions) + pure diff renderer (`src/tui/diff.ts` — LCS over lines,
  splitlines semantics, 500-line guard) + a presentational Ink app
  (`src/tui/app.tsx` — no agent logic; the keybinding table is the only
  place keys become intents) + a thin driver (`src/tui/run.tsx` — owns the
  Ink instance; one `runTurn` per submitted prompt, so sessions,
  compaction and safety hooks behave identically to the REPL; the TUI's
  sinks are no-ops).
- **Features:** streaming render with caret, turn counter, tool calls with
  args + ✓/✗ results, **edit diff view** (`-`/`+`/context lines under the
  edit call), prompt history (↑/↓), approval prompt (y/n/esc — D8 flow,
  input locked while pending), ctrl+c aborts the run (busy) or exits 130
  (idle), `/quit` exits 0.
- **Ink quirk handled:** Ink does NOT split `\r` inside multi-char chunks
  (paste semantics) — fast typing coalesces prompt+Enter into one string
  event; the App splits it (typed part → submit). Regression-tested.
- Deps added: `ink@7`, `react@19` (+`@types/react`), `ink-testing-library`
  (dev). tsconfig gained `"jsx": "react-jsx"`.

## WS10 verification
- `test/tui-diff.test.ts` (8): LCS correctness (insert/delete/replace,
  context, non-zip alignment), splitlines semantics, guards.
- `test/tui-state.test.ts` (19): event folding (streaming accumulation,
  multi-message turns, thinking hint, tool id-matching out of order,
  update previews, edit diff attachment, compaction item, agent_end
  error/aborted/length, busy/approval clearing), all input functions,
  approval promise resolution, immutability.
- `test/tui-app.test.tsx` (8): render (header/items/diff/compaction/error/
  hints/busy/caret), key routing (chars, backspace, enter, arrows, ctrl+c),
  coalesced-chunk typing + approval, approval y/n/esc/enter, state→app
  integration.
- **Live (27B, real pty via `script`):** run 1 — prompt → write call →
  approval `[y/N]` rendered → `y` (coalesced chunk) approved →
  `tui-smoke.txt` created with exact content, exit 0. Run 2 — edit call →
  diff view rendered `- x = 1` / `+ x = 2` → file modified correctly.
  (Run 2 initially hung because the 27B spontaneously followed the
  project's file-history convention — extra gated bash calls, each
  needing approval; `--yes` run confirmed the flow.)
- Full fast suite: **228 tests, 0 fail** (7 live skipped).

## Conventions
- **I3**: failures are data (isError results, exit codes), never uncaught
  throws. **D7**: blocked/denied = isError ToolResult the model reads.
  **D8**: destructive bash confirms even under --yes. **D9**: eval scoring
  (single turn, first tool call, argsSubset + argsContains). **D10**:
  compaction semantics (PLAN §9). **D11**: TUI architecture (PLAN §9).
- Tests: `node --test` (no framework), tsc strict, ESM `.jsx`/`.ts` for the
  Ink app, `.js` suffixes on relative imports. Live tests gated `RUN_LIVE=1`
  (models.json → TKG vks-llama, --parallel 1, slow: ~105s full live file).
- File history: every agent-made change is snapshotted in `.history/`
  (see CHANGELOG.md). Git: commit per workstream with `WS<n>: ...` subject
  + a docs commit for HANDOFF/PLAN updates.
- The model is a 27B Q4 — live prompts must be short and direct; it is
  run-to-run variable and occasionally does *more* than asked (e.g. extra
  bookkeeping tool calls), so live feeds need generous waits or `--yes`.

## How to resume (post-MVP)
1. `npm test` (fast, 228 tests); `RUN_LIVE=1 npm test` (final gate);
   `npm run eval` (live 3-task eval).
2. `coding-agent tui` for the interactive UI; `coding-agent` for the plain
   REPL; `coding-agent run "..."` for one-shots.
3. Pick a post-MVP item from PLAN §8. The seams that matter: wire
   (StreamFn), loop (AgentLoopOptions hooks), tools (ToolPipelineHooks),
   sessions (entry types), TUI (TuiState items — a new item kind renders
   by adding a case to `Item` in app.tsx).
