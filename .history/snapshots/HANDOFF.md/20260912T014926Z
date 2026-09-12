# HANDOFF — resume point (2026-09-11)

Build of a minimal coding-agent harness (TypeScript, zero runtime deps, Node 26).
Plan: `PLAN.md`. Contracts: `docs/02-contracts.md`. Walkthrough: `docs/01-walkthrough-harness-llm.md`.

## Status

| WS | What | State |
|----|------|-------|
| WS0 | `src/types.ts` contracts + scaffold + 3 contract tests | ✅ done |
| WS8 | test/eval harness: `test/mock-sse.ts`, `test/fake-stream.ts`, `test/eval.ts` + tests | ✅ done, commit `ec952b3` |
| WS1 | wire layer: `src/wire/{http,abort,openai-completions}.ts`, `src/config/models.ts` + tests | ✅ done, commit `4732991` |
| WS2 | core loop: `src/loop/agent-loop.ts` | ⚠️ **IN PROGRESS** — loop written + `tsc` clean, **loop tests NOT written, not committed** |
| WS3 | tool system: registry, truncate, read/write/edit/bash | not started |
| WS4 | system prompt + skills | not started |
| WS5 | session JSONL persistence | not started |
| WS6 | integration / vertical slice against live endpoint | deferred — propose after the six |

## Resume WS2 — exact next steps

1. Write `test/agent-loop.test.ts` using `fakeStream` from `test/fake-stream.ts` (scripted turns: `text | thinking | toolcall | error | aborted | length`). Planned tests:
   - full multi-turn: user → assistant(toolcall) → toolresult → assistant(text) → stop; assert exact `AgentMessage[]` in `agent_end.messages` (normalize timestamps + strip `undefined` keys — fake messages carry an own `usage: undefined` key)
   - clean stop on `error` (errorMessage kept, no throw) and on `aborted` (partial kept in context)
   - real `AbortSignal` fired mid-turn → `agent_end.stopReason === "aborted"`
   - `length` guard: tool calls FAILED (isError, "truncated" text), never executed (`tool.calls.length === 0`), run continues to next turn
   - batch `terminate: true` on every result → loop stops (script a 3rd turn that must NOT be consumed — fakeStream throws if exhausted)
   - parallel batch: 2 calls, slow resolves after fast → results + `tool_execution_end` events still in CALL order
   - `executionMode: "sequential"` on any call → whole batch serialized (assert start/end log order)
   - unknown tool → error result "not found", no throw
   - tool that throws (I3 violation) → error result, run survives
   - `maxTurns` cap; `prepareNextTurn` hook can rewrite context (assert next turn's `LlmContext` sees it)
   - Helper: `drain(gen)` collects events; `makeTool(name, over?)` records `{id, args}` calls in a closure
2. `npm test` (tsc + `node --test dist/test/*.test.js`; baseline 22+35… expect ~35 pass + 2 live skipped).
3. Commit: `git add -A && git commit -m "WS2: core agent loop — I2 context slot, length guard, batch dispatch (parallel/sequential), terminate, error-as-data"`.
4. Then WS3 (tools), WS4 (prompt/skills), WS5 (session JSONL) in that order — each: implement → `npm test` green → commit. Specs in PLAN.md per-WS sections (exit criteria there are authoritative).

## Key facts (already verified — do not re-probe)

- **Tests**: `npm test` = `tsc && node --test dist/test/*.test.js`. Strict tsconfig: `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (type-only imports!), target ES2022, NodeNext.
- **Live endpoint**: `http://172.30.70.11:8080/v1` (vks-llama, llama.cpp), model id `Qwen3.8-27B-UD-Q4_K_M` (short id accepted). It is a **thinking model** (`reasoning_content` field, spends token budget thinking) → live tests need `max_tokens >= 4096`. Live tests gated behind `RUN_LIVE=1` (test/wire-live.test.ts — both pass).
- **Contract invariants** (docs/02-contracts.md): I1 everything is a message/tool; I2 every stream event carries full in-progress message (loop pushes on `start`, replaces SAME slot on every event); I3 no exceptions cross boundaries — streams ALWAYS emit `start`…`done` even on error/abort (both fakeStream and openAiStream already do this; the loop relies on it).
- **WS2 seam**: loop takes `executeToolCall?: ExecuteToolCall` option (defaults to `tool.execute`); WS3's validation/hook pipeline gets injected there. `prepareNextTurn` hook is where WS5 compaction lands.
- **WS8 fixtures** (pinned by tests, reuse them): mock-sse 5 scenarios (`text`, `multi-tool`, `length`, `http-error`, `stream-error`); fakeStream turns as above; `runEval` scores first tool call of one LLM call.

## Working method for this repo

- **Sequential only** — no parallel subagent fan-out (user's explicit request; worker subagent also terminates early on large tasks).
- **File-history discipline**: before creating/modifying any project file, log it: `~/.pi/agent/skills/file-history/scripts/hist add <path> "created"` (or snapshot for existing files). Append-only `.history/CHANGELOG.md`.
- Commit per workstream with a descriptive message; verify exit criteria from PLAN.md before committing.
