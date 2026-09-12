# HANDOFF — resume point (2026-09-12)

Build of a minimal coding-agent harness (TypeScript, zero runtime deps, Node 26).
Plan: `PLAN.md`. Contracts: `docs/02-contracts.md`. Walkthrough: `docs/01-walkthrough-harness-llm.md`.

## Status

| WS | What | State |
|----|------|-------|
| WS0 | `src/types.ts` contracts + scaffold + 3 contract tests | ✅ done |
| WS8 | test/eval harness: `test/mock-sse.ts`, `test/fake-stream.ts`, `test/eval.ts` + tests | ✅ done, commit `ec952b3` |
| WS1 | wire layer: `src/wire/{http,abort,openai-completions}.ts`, `src/config/models.ts` + tests | ✅ done, commit `4732991` |
| WS2 | core loop: `src/loop/agent-loop.ts` + `test/agent-loop.test.ts` (13 tests) | ✅ done, commit `39c33c8` |
| WS3 | tool system: registry, truncate, read/write/edit/bash | not started |
| WS4 | system prompt + skills | not started |
| WS5 | session JSONL persistence | not started |
| WS6 | integration / vertical slice against live endpoint | deferred — propose after the six |

## Resume WS3 — exact next steps

1. `src/tools/` framework first, then the four tools. Specs + exit criteria: PLAN.md WS3 (authoritative):
   - registry: add/list byName.
   - execute pipeline: validate args vs `parameters` JsonSchema → `beforeToolCall` hook (WS7's approval gate seam — leave the hook point, don't build the UI) → `tool.execute(signal, onUpdate)` → `afterToolCall` → `ToolResult`; failures become `isError` results, NEVER throw (I3).
   - truncate: 2000-line / 50KB cap — head-keep for `read`, tail-keep for `bash`, never split a line; on overflow write full output to a temp file and report `details: { truncated: true, fullOutputPath }`.
   - tools: `read`, `write`, `edit` (exact match against the ORIGINAL file — unique `oldText`, no overlap; test the failure paths), `bash` (spawn, timeout, honor `signal.aborted`, tail-truncate).
2. Wire WS2's seam: WS3's pipeline is what gets injected as `executeToolCall` (loop defaults to raw `tool.execute`; keep that default for the loop's own tests).
3. Tests: each tool unit-tested against a temp dir; `edit` exact-match semantics incl. failures; a too-long `bash` output truncates to ≤ limits and reports the full-output path; unknown tool → error result, not a throw.
4. `npm test` green (baseline now 50 total: 48 pass + 2 live skipped) → commit `WS3: tool system — registry, validation pipeline, truncate (head/tail + temp file), read/write/edit/bash`.
5. Then WS4 (prompt/skills), WS5 (session JSONL) in that order — each: implement → `npm test` green → commit. Specs in PLAN.md per-WS sections (exit criteria there are authoritative).

## Key facts (already verified — do not re-probe)

- **Tests**: `npm test` = `tsc && node --test dist/test/*.test.js`. Strict tsconfig: `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (type-only imports!), target ES2022, NodeNext.
- **Live endpoint**: `http://172.30.70.11:8080/v1` (vks-llama, llama.cpp), model id `Qwen3.8-27B-UD-Q4_K_M` (short id accepted). It is a **thinking model** (`reasoning_content` field, spends token budget thinking) → live tests need `max_tokens >= 4096`. Live tests gated behind `RUN_LIVE=1` (test/wire-live.test.ts — both pass).
- **Contract invariants** (docs/02-contracts.md): I1 everything is a message/tool; I2 every stream event carries full in-progress message (loop pushes on `start`, replaces SAME slot on every event); I3 no exceptions cross boundaries — streams ALWAYS emit `start`…`done` even on error/abort (both fakeStream and openAiStream already do this; the loop relies on it).
- **WS2 seam**: loop takes `executeToolCall?: ExecuteToolCall` option (defaults to `tool.execute`); WS3's validation/hook pipeline gets injected there. `prepareNextTurn` hook is where WS5 compaction lands.
- **WS8 fixtures** (pinned by tests, reuse them): mock-sse 5 scenarios (`text`, `multi-tool`, `length`, `http-error`, `stream-error`); fakeStream turns as above; `runEval` scores first tool call of one LLM call.
- **fakeStream quirk (verified, WS2)**: deltas are pre-built before the first yield, so a mid-turn abort's `done` message carries the FULL text, not a truncated partial. Don't "fix" without updating WS8 self-tests; WS2 tests pin loop behavior (stopReason + slot consistency), not fake truncation fidelity.
- **Loop type notes (verified, WS2)**: `prepareNextTurn` may return `undefined` (keep context) or a Promise — type is `AgentMessage[] | undefined | Promise<AgentMessage[] | undefined>`. `LlmContext.messages` handed to the StreamFn is the loop's LIVE context array (cloned only for `initialMessages`) — capture by value if you assert on it later.

## Working method for this repo

- **Sequential only** — no parallel subagent fan-out (user's explicit request; worker subagent also terminates early on large tasks).
- **File-history discipline**: before creating/modifying any project file, log it: `~/.pi/agent/skills/file-history/scripts/hist add <path> "created"` (or snapshot for existing files). Append-only `.history/CHANGELOG.md`.
- Commit per workstream with a descriptive message; verify exit criteria from PLAN.md before committing.
