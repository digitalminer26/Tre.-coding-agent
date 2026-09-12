# HANDOFF — resume point (2026-09-12, WS5 done)

Build of a minimal coding-agent harness (TypeScript, zero runtime deps, Node 26).
Plan: `PLAN.md`. Contracts: `docs/02-contracts.md`. Walkthrough: `docs/01-walkthrough-harness-llm.md`.

## Status

| WS | What | State |
|----|------|-------|
| WS0 | `src/types.ts` contracts + scaffold + 3 contract tests | ✅ done |
| WS8 | test/eval harness: `test/mock-sse.ts`, `test/fake-stream.ts`, `test/eval.ts` + tests | ✅ done, commit `ec952b3` |
| WS1 | wire layer: `src/wire/{http,abort,openai-completions}.ts`, `src/config/models.ts` + tests | ✅ done, commit `4732991` |
| WS2 | core loop: `src/loop/agent-loop.ts` + `test/agent-loop.test.ts` (13 tests) | ✅ done, commit `39c33c8` |
| WS3 | tool system: `src/tools/{registry,validate,truncate,pipeline,read,write,edit,bash,index}.ts` + 3 test files | ✅ done, commit `16d64c9` |
| WS4 | system prompt + skills: `src/prompt/{system-prompt,skills}.ts` + `test/prompt.test.ts` | ✅ done, commit `0856746` |
| WS5 | session JSONL persistence: `src/session/session.ts` + `test/session.test.ts` (10 tests) | ✅ done, commit `510a0ac` |
| WS6 | CLI / integration: `src/cli/main.ts` (PLAN.md §WS6) | ⬜ not started — **next up, see below** |
| WS7 | safety & permissions: approval gate + path sandbox (PLAN.md §WS7) | not started (deps: WS3 ✓) |
| WS9 | context management (auto-compaction) — Phase 3, deferred | seam defined in WS5 (see key facts) |

Note: WS8 was built before WS1 by deliberate dependency order (the harness is
the precondition for testing the wire layer). PLAN.md is the numbering
authority.

## Resume WS6 — exact next steps

Spec + exit criteria: PLAN.md §WS6 (authoritative). Deliverable:
`src/cli/main.ts` — the **integration seam**, first place all modules meet.

1. `main.ts`: load `models.json` (project root already exists — points at
   vks-llama, key stays out of git), pick model by id (short id accepted),
   build the system prompt (WS4 `buildSystemPrompt`, skills dir resolution
   order is decided HERE: project `.pi/skills` first, then
   `~/.pi/agent/skills`), register tools (WS3 `src/tools/index.ts`),
   construct the real `StreamFn` (WS1 `openAiStream`).
2. Run `runLoop` (WS2) with the replayed context when resuming:
   `--resume <file.jsonl>` → `replaySession(path)` → seed `initialMessages`
   + continue appending via `Session.open(path)`. Fresh run:
   `Session.create(path, { cwd, model })`. Persist every context-affecting
   message (user input, assistant turns, tool results) as it lands —
   `AgentEvent` stream is the source; append on `start`/message-finalization,
   not per delta.
3. Event printer: streaming assistant text (delta → stdout, newline on
   done), one line per tool call (`name` + id + args summary), tool result
   lines (truncate with WS3 `truncate.ts`), stopReason on `agent_end`
   (including `error` + `errorMessage` — I3: failures are data).
4. stdin: readline REPL; SIGINT mid-stream → `AbortController.abort()`
   (the loop's abort path is already tested in WS2 — mid-stream abort keeps
   the partial with `stopReason:"aborted"`, mid-tool abort yields
   "Operation aborted" results).
5. Exit criteria (PLAN.md §WS6): the §4 vertical-slice scenarios all pass
   against live llama.cpp (`RUN_LIVE=1`-gated pattern already exists —
   `test/wire-live.test.ts`). Live notes from the WS4-era HANDOFF still hold:
   Qwen is a **thinking model** → `max_tokens >= 4096`.
6. Server note (2026-09-12 infra): the local llama.cpp server now runs
   `--parallel 1` (single slot) — concurrent requests queue instead of
   sharing the KV pool. Keep CLI prompts lean; long generations may wait
   behind queued requests (seconds to ~1 min).

Then WS7 (safety & permissions) — PLAN.md §WS7; its hook is the WS3
`beforeToolCall` gate (`{ blocked: string }` shape is already tested).

## Key facts (already verified — do not re-probe)

- **WS5 session format (2026-09-12, 510a0ac)**: one `.jsonl` per session;
  entry kinds `header` (version=1, id, createdAt, cwd) / `message`
  (id + `AgentMessage`) / `modelChange` (model id + provider label — apiKeys
  NEVER in the file) / `compaction` (summary + firstKeptEntryId +
  tokensBefore). `Session.create` refuses existing files (EEXIST); resume =
  `Session.open`. Torn tail = unparseable LAST line without trailing `\n`
  (dropped, reported via `droppedTornTail`); any other bad line throws.
  **WS9's compaction writes `Session.appendCompaction(...)` between turns;
  the trigger point is the loop's `prepareNextTurn` hook**; replay rebuilds
  via pure `replayContext(entries)` = [summary-as-user-message] + entries
  from `firstKeptEntryId` on (chain-safe). Do not keep a shadow in-memory
  "logical context" — the log is the source of truth.
- **Tests**: `npm test` = `tsc && node --test dist/test/*.test.js`. Strict
  tsconfig: `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (type-only
  imports!), target ES2022, NodeNext. Current: 117 total — 115 pass + 2 live
  skipped (`RUN_LIVE=1`). Files: agent-loop 13 · wire 13 · tools 32 · prompt
  10 · truncate 8 · mock-sse 8 · validate 7 · fake-stream 7 · session 10 ·
  contracts 3 · eval 4 · wire-live 2.
- **Live endpoint**: `http://172.30.70.11:8080/v1` (vks-llama, llama.cpp),
  model id `Qwen3.8-27B-UD-Q4_K_M` (short id accepted). It is a **thinking
  model** (`reasoning_content` field, spends token budget thinking) → live
  tests need `max_tokens >= 4096`. Live tests gated behind `RUN_LIVE=1`.
- **Contract invariants** (docs/02-contracts.md): I1 everything is a
  message/tool; I2 every stream event carries full in-progress message (loop
  pushes on `start`, replaces SAME slot on every event); I3 no exceptions
  cross boundaries — streams ALWAYS emit `start`…`done` even on error/abort
  (both fakeStream and openAiStream already do this; the loop relies on it).
- **WS2 seam**: loop takes `executeToolCall?: ExecuteToolCall` option
  (defaults to `tool.execute`); WS3's validation/hook pipeline gets injected
  there. `prepareNextTurn` hook is where WS9 compaction lands.
- **WS8 fixtures** (pinned by tests, reuse them): mock-sse 5 scenarios
  (`text`, `multi-tool`, `length`, `http-error`, `stream-error`); fakeStream
  turns as above; `runEval` scores first tool call of one LLM call.
- **fakeStream quirk (verified, WS2)**: deltas are pre-built before the
  first yield, so a mid-turn abort's `done` message carries the FULL text,
  not a truncated partial. Don't "fix" without updating WS8 self-tests; WS2
  tests pin loop behavior (stopReason + slot consistency), not fake
  truncation fidelity.
- **Loop type notes (verified, WS2)**: `prepareNextTurn` may return
  `undefined` (keep context) or a Promise — type is `AgentMessage[] |
  undefined | Promise<AgentMessage[] | undefined>`. `LlmContext.messages`
  handed to the StreamFn is the loop's LIVE context array (cloned only for
  `initialMessages`) — capture by value if you assert on it later.
- **D7 (WS3, in decision log)**: `ToolResult` has `isError?: boolean`; the
  pipeline reports failures in-band and the loop marks
  `ToolResultMessage.isError` from it (a throw out of `executeToolCall` is
  still caught and marked isError — I3 safety net for broken tools).
- **`ExecuteToolCall` lives in `src/types.ts`** (contract home) so tools can
  implement it without importing the loop; `agent-loop.ts` re-exports it for
  WS2-era compatibility.
- **Truncation semantics (WS3, tested)**: kept text is the EXACT original
  slice through the last kept line — head-truncated text ends with `\n` (the
  separator existed in the original); tail-truncated ends with `\n` iff the
  original did. Byte cost model counts each line's own `\n` (so `keptBytes` =
  exact kept-text bytes, never over the budget).
- **Pipeline hook shapes (WS3)**: `beforeToolCall` returns `{ args? }`
  (rewrite) | `{ blocked: string }` (WS7 approval seam) | `undefined`;
  `afterToolCall` returns a replacement `ToolResult` | `undefined`. Both may
  be async; broken hooks are contained (I3).
- **node:test hooks (WS3)**: `beforeEach`/`afterEach` are top-level imports
  from `"node:test"` in @types/node 24 — `test.beforeEach` does NOT
  type-check.

## Working method for this repo

- **Sequential only** — no parallel subagent fan-out (user's explicit
  request; worker subagent also terminates early on large tasks).
- **File-history discipline**: before creating/modifying any project file,
  log it: `~/.pi/agent/skills/file-history/scripts/hist add <path> "created"`
  (or snapshot for existing files). Append-only `.history/CHANGELOG.md`.
- Commit per workstream with a descriptive message; verify exit criteria
  from PLAN.md before committing. Code commit first, docs (HANDOFF) commit
  second — the docs commit references the code commit's hash.
