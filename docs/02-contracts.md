# WS0 — The Three Contracts

The gate for parallel work. Every Wave B workstream codes against the types
in `src/types.ts` and nothing else. A contract change is a *broadcast*: all
active workstreams re-check against the new shape before continuing.

## Why these three

The agent is four modules (wire, loop, tools, CLI/session) that get built in
parallel. Parallel is only safe if the seams between modules are *narrow and
typed*. The seams are exactly three:

1. **`AgentMessage`** — the shared language. The wire layer converts to/from
   provider format exactly once at the boundary; the loop, session, and CLI
   only ever see `AgentMessage[]`.
2. **`StreamFn`** — the loop's only dependency on the wire layer.
3. **`Tool`** — the loop's only dependency on tools.

(`AgentEvent` is the fourth citizen: what the loop emits and the CLI/session
consume, built *from* the first three.)

## Contract 1 — `AgentMessage` (provider-neutral)

Discriminated union on `role`:

| role         | produced by        | key fields                                                                              |
|--------------|--------------------|-----------------------------------------------------------------------------------------|
| `user`       | the human          | `content: string` (MVP), `timestamp`                                                    |
| `assistant`  | the LLM (via wire) | `content: ContentBlock[]`, `model`, `provider`, `stopReason`, `usage?`, `errorMessage?` |
| `toolResult` | the tool pipeline  | `toolCallId`, `toolName`, `content: TextBlock[]`, `isError?`, `details?`                |

Content blocks: `text`, `thinking`, `toolCall {id, name, arguments}`.

Rules:
- **JSON-serializable, closed union.** This type *is* the session file format
  (one message per JSONL line) — no runtime-only fields.
- **`toolCall.arguments` is a parsed object** — the wire layer owns JSON
  parse + salvage; everything downstream gets an object or an error.
- **`stopReason` is the outcome channel**: `stop | length | toolUse |
  error | aborted | budget | loop | stall`. `length` is load-bearing: the
  loop must fail *all* tool calls in that message (truncated args may parse
  yet be incomplete). `budget`/`loop`/`stall` are set by the LOOP (never a
  wire finish_reason) and all three are resumable.
- **C26 — the turn budget is per-cycle, and the runaway guard is
  pattern-based.** `maxTurns` (derived or explicit) caps one *cycle*; at
  exhaustion the loop injects `BUDGET_CONTINUE_TEXT` (a user message) and
  resets the counter, emitting `turn_budget`, up to `maxContinuations`
  times (default 3 → 4 cycles). Only when every continuation is spent does
  the run stop with `budget`. Independently, the same tool-call batch
  (tool names + stable-JSON arguments, in order) issued 3 times in a row
  is a runaway-loop signature: the third repeat is failed in-band with
  `LOOP_GUARD_TEXT` (never executed) and the run stops with `loop`.
  Two identical batches remain allowed (legit retries exist).
- **Stall detection (tool pipeline) — the deterministic-failure guard.**
  The kernel sandbox makes permission denials DETERMINISTIC: the same
  operation fails identically forever ("Operation not permitted" /
  "permission denied"). The tool pipeline (`makeToolExecutor`) counts
  consecutive permission-signature failures PER TOOL (per executor
  instance — the CLI builds one per run). The count is keyed on the tool
  NAME, not the arguments: a model that rephrases the command each retry
  (`git push` → `git push origin main` → …) defeats the loop's
  3-identical-batch guard, and rephrasing is exactly the stall pattern —
  so it must NOT reset the count. The 3rd permission failure of the same
  tool is replaced in-band with `stallText(tool)` + `details.stall` (I3:
  every call gets a result); the call WAS executed (a denial is a harmless
  no-op), so a legitimate 3rd operation that SUCCEEDS never trips it. The
  loop maps `details.stall` onto `stopReason: "stall"` and stops —
  resumable like `loop` (exit 3). Non-permission failures (transient
  errors are normal retries) and a different tool or success reset the
  count. The two guards are complementary: byte-identical retries are
  caught by the loop guard (stopReason `loop`); rephrased retries are
  caught here (stopReason `stall`).

## Contract 2 — Events

### `AssistantStreamEvent` (emitted by `StreamFn`, one per assistant message)

| event            | when                                 | payload                                                    |
|------------------|--------------------------------------|------------------------------------------------------------|
| `start`          | first, always                        | `partial` — empty skeleton                                 |
| `text_delta`     | per content chunk                    | `delta` + cumulative `partial`                             |
| `thinking_delta` | per reasoning chunk                  | `delta` + cumulative `partial`                             |
| `toolcall_start` | per tool call (name/id arrive first) | `index` (position in response), `id?`, `name?`, `partial`  |
| `toolcall_delta` | per argument fragment                | `index`, `argsDelta` (raw JSON string fragment), `partial` |
| `done`           | last, always                         | `message` — final; `stopReason` carries the outcome        |

Invariants:
- **I2 — every event carries the full in-progress message.** The loop pushes
  `partial` into one context slot on `start` and replaces the same slot on
  every event; an abort at any point leaves a consistent truncated message.
- **`done` is always the final event, even on failure** — a network error
  yields `done` with `stopReason: "error"` + `errorMessage` (I3).

### `AgentEvent` (emitted by the loop — what the CLI prints, what the session persists)

`AgentEvent = AssistantStreamEvent` (passed through unchanged) plus:

| event                     | when                         | payload                                    |
|---------------------------|------------------------------|--------------------------------------------|
| `agent_start`             | run begins                   | —                                          |
| `turn_start` / `turn_end` | per LLM turn                 | `turn` (1-based)                           |
| `tool_execution_start`    | per tool call                | `toolCall`                                 |
| `tool_execution_update`   | optional progress            | `toolCallId`, `text`                       |
| `tool_execution_end`      | per tool call, in call order | `toolCallId`, `result` (ToolResultMessage) |
| `context_compacted`       | between LLM turns — CLI auto-compaction (D10, WS9) | `tokensBefore`, `messagesKept`, `summaryChars` |
| `turn_budget`             | C26: a cycle's budget was exhausted, the loop auto-continues (informational, NOT an error) | `turn`, `cycle`, `maxCycles`, `maxTurns` |
| `agent_end`               | run ends                     | `stopReason`, `messages` (final context); `maxTurns` + `maxCycles` when `stopReason === "budget"` |

## Contract 3 — `StreamFn`

```ts
type StreamFn = (
  model: ModelConfig,
  ctx: LlmContext,          // { systemPrompt, messages, tools }
  opts: { apiKey?: string; signal: AbortSignal },
) => AsyncIterable<AssistantStreamEvent>;
```

- **Owns:** HTTP fetch + bounded retry + abort, request building
  (`buildParams` / `convertMessages`), SSE parse, per-index tool-call
  argument accumulation + best-effort JSON salvage, usage capture.
- **Does not own:** context, tool dispatch, anything loop-shaped.
- **Must:** emit exactly one `start` … one `done` per call; honor `signal`;
  never throw for endpoint failures (I3).

## Contract 4 — `Tool`

```ts
interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;                 // sent to the LLM verbatim
  executionMode?: "parallel" | "sequential";
  execute(toolCallId, args, signal, onUpdate?): Promise<ToolResult>;
}
```

- **Errors never throw out** — a failed tool returns a result whose text the
  model reads (the loop marks the message `isError`). The model is part of the
  error-handling system.
- **`executionMode: "sequential"`** (e.g. file mutators) forces the whole
  batch to run in call order; the default is parallel.
- **`terminate: true`** on a result: if *every* result in a batch terminates,
  the loop stops after the batch.
- Must honor `signal` (abort mid-flight).

## `ModelConfig` (models.json)

`{ id, provider, baseUrl, api, contextWindow, maxTokens, temperature?, apiKey?, compat? }`
— one entry per model. `compat` (per-model flags: `maxTokensField`,
`supportsUsageInStreaming`, `requiresAssistantAfterToolResult`,
`extraParams`) is where endpoint quirks live, so the wire layer stays one code
path. Swapping endpoints = editing models.json.

## The invariants, restated

1. **Everything the model sees is a message; everything it can do is a tool;
   results flow back through the same message channel.**
2. **Every streaming event carries the full in-progress message.**
3. **No exceptions cross module boundaries — failures become data.**

## Change protocol

A contract change is a broadcast: author the change, re-run `tsc` across all
workstreams, and record it in `PLAN.md` §9 (decision log). Wave B workstreams
must not fork these types privately.
