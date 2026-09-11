# Walkthrough: How a Coding-Agent Harness Talks to an LLM Endpoint

Grounded in the actual source of the pi coding agent (v0.85.1), which is split into four
layers. Every claim below is traceable to a file:

| Layer   | Package                                          | Job                                                                                        |
|---------|--------------------------------------------------|--------------------------------------------------------------------------------------------|
| Wire    | `@earendil-works/pi-ai`                          | HTTP/SSE to LLM endpoints, per-provider request building & response parsing, model catalog |
| Loop    | `@earendil-works/pi-agent-core`                  | The agent loop: stream response → dispatch tool calls → feed results back → repeat         |
| Harness | `@earendil-works/pi-coding-agent` (`dist/core/`) | System prompt, built-in tools, sessions, compaction, extensions                            |
| UI      | `@earendil-works/pi-tui`                         | Terminal rendering of the event stream                                                     |

Key architectural decision: **the loop works entirely in a provider-neutral message type
(`AgentMessage`). Conversion to the provider wire format happens exactly once, at the LLM
boundary** (`convertToLlm`). This is what makes "swap the endpoint" a config change.

```
user input ──► AgentMessage[] (context)
                 │
                 ▼
        ┌── runLoop (pi-agent-core) ──────────────────────┐
        │  turn:                                          │
        │    1. transformContext (compaction, pruning)    │
        │    2. convertToLlm  ──► Message[] (wire)        │
        │    3. streamFn(model, {systemPrompt, messages,  │
        │         tools}, {apiKey, signal})  ──► SSE      │
        │    4. accumulate assistant message (streaming)  │
        │    5. extract toolCalls ─► execute (parallel)   │
        │    6. append toolResult messages                │
        │    7. repeat while toolCalls exist or user      │
        │       steering/follow-up messages are queued    │
        └─────────────────────────────────────────────────┘
```

---

## 1. Session start: system prompt assembly

`dist/core/system-prompt.js` — `buildSystemPrompt()`. Built once per session (rebuilt when
tools change). Sections, in order:

1. **Base persona + tool list** — one-line description per enabled tool. Guidelines are
   *derived from which tools exist* (e.g. "Use bash for ls, rg, find" only appears when
   bash exists but grep/find don't).
2. **Appended system prompt** — project-level additions (subagent roster, file-history
   discipline, etc.).
3. **Project context files** — `AGENTS.md`-style files injected as
   `<project_context><project_instructions path="…">…</project_instructions></project_context>`.
4. **Skills listing** — name + one-line description per skill *only*. The SKILL.md body is
   never in context until the model reads it on demand. This is a deliberate token-economy
   pattern: index in prompt, body on demand.
5. **Current working directory** — last line.

> Takeaway: keep the system prompt small and deterministic; put everything bulky behind
> on-demand tools (file reads, history search).

## 2. The request (OpenAI-compatible `POST /v1/chat/completions`)

`pi-ai/dist/api/openai-completions.js` — `buildParams()`. Real shape (this is what your
llama.cpp / Ollama / vLLM endpoint receives):

```jsonc
{
  "model": "qwen3-32b",
  "messages": [
    { "role": "system", "content": "You are an expert coding assistant …\nCurrent working directory: /path" },
    { "role": "user", "content": "fix the bug in foo.ts" },
    { "role": "assistant",
      "content": "Let me look.",                      // string, not array — see §2.1
      "tool_calls": [
        { "id": "call_abc123", "type": "function",
          "function": { "name": "read",
                        "arguments": "{\"path\":\"foo.ts\"}" } }   // args are a JSON *string*
      ] },
    { "role": "tool",
      "tool_call_id": "call_abc123",                  // links back to the call
      "content": "1\timport { x } …" }                // truncated output text
  ],
  "tools": [
    { "type": "function",
      "function": {
        "name": "edit",
        "description": "Edit a single file using exact text replacement. …",
        "parameters": {                                // JSON Schema, generated from TypeBox
          "type": "object",
          "properties": {
            "path":  { "type": "string", "description": "Path to the file to edit (relative or absolute)" },
            "edits": { "type": "array", "items": {
              "type": "object",
              "properties": {
                "oldText": { "type": "string", "description": "Exact text … must be unique …" },
                "newText": { "type": "string", "description": "Replacement text …" }
              }, "required": ["oldText", "newText"] } },
            "description": "One or more targeted replacements. …" }
          },
          "required": ["path", "edits"]
        } } }
  ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_tokens": 8192,
  "temperature": 0.7
}
```

Wire-format rules that bite you if you get them wrong (§2.1):

- **Tool-call args are a JSON string**, not an object.
- **Assistant `content` is a plain string** (empty/`null` when the assistant only issued
  tool calls). Sending content as an array of `{type:"text",…}` is non-standard and some
  models literally mirror the structure in their output.
- **Tool results are separate `role:"tool"` messages**, one per call, linked by
  `tool_call_id`. Order is preserved from the batch.
- Empty assistant messages (no content, no tool calls — e.g. an aborted response) are
  *skipped entirely*; some providers reject them.
- Some providers require a synthetic assistant message between a tool result and the next
  user message (`requiresAssistantAfterToolResult` compat flag).
- Tool-call IDs are normalized (some providers use 400+ char IDs; OpenAI caps at 40).
- `role:"developer"` instead of `system` for certain reasoning models.

**Per-model compat flags** (`getCompat(model)`) absorb endpoint differences:
`max_tokens` vs `max_completion_tokens`, thinking/reasoning parameter formats
(deepseek `thinking:`, qwen `enable_thinking`, vLLM `chat_template_kwargs`, …), cache
control, `include_usage` support, tool-streaming quirks. **Model = (id, baseUrl, api,
compat, maxTokens, contextWindow, cost).** This is the single most valuable abstraction if
you want many endpoints: don't branch in the loop, branch in a per-model descriptor.

**Hooks around the request:** `onPayload(params, model)` lets extensions rewrite the
request in flight; `onResponse({status, headers})` observes it; `getApiKey(provider)`
re-resolves the key per request (expiring OAuth tokens). Retries via `retryProviderRequest`
with backoff; the fetch itself carries the `AbortSignal`.

## 3. The response: SSE stream → normalized events

The endpoint streams `data: {json}\n\n` chunks; the parser (`stream()` in
openai-completions.js) normalizes them into a small event vocabulary:

| SSE chunk field                                      | Internal event                                                                                                                                                            |
|------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| (first chunk)                                        | `start` — an empty assistant message skeleton is created                                                                                                                  |
| `choices[0].delta.content`                           | `text_delta` — appended to a `text` block                                                                                                                                 |
| `choices[0].delta.reasoning_content` (or similar)    | `thinking_delta`                                                                                                                                                          |
| `choices[0].delta.tool_calls[i]`                     | `toolcall_start` / `toolcall_delta` — name arrives first, `function.arguments` arrives as **string fragments** accumulated in `partialArgs`, matched by `index` then `id` |
| `chunk.usage` (final chunk, because `include_usage`) | usage recorded on the message                                                                                                                                             |
| `choices[0].finish_reason`                           | mapped: `stop`→`stop`, `tool_calls`→`toolUse`, `length`→`length`, `content_filter`→error, …                                                                               |
| stream end                                           | `done` (or `error`)                                                                                                                                                       |

Every event carries `partial` — the **full in-progress assistant message**. The loop
pushes that partial into the context on `start` and *replaces the same slot* as deltas
arrive, so session state and the UI always reflect live progress, and an abort at any
point leaves a consistent (truncated) message in history.

At block end, `parseStreamingJson(partialArgs)` parses the accumulated argument string —
with a **best-effort salvage parser** for truncated JSON (see §4.1 on why that matters).

Final assistant message shape (provider-neutral, persisted to session):

```jsonc
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Let me look." },
    { "type": "toolCall", "id": "call_abc123", "name": "read", "arguments": { "path": "foo.ts" } }
  ],
  "api": "openai-completions", "provider": "llama.cpp", "model": "qwen3-32b",
  "usage": { "input": 4210, "output": 87, "cacheRead": 0, "cacheWrite": 0,
             "totalTokens": 4297, "cost": { "total": 0, "…": 0 } },
  "stopReason": "toolUse",          // stop | length | toolUse | error | aborted
  "timestamp": 1757500000000
}
```

## 4. The loop (`pi-agent-core/dist/agent-loop.js` — `runLoop`)

```
emit agent_start, turn_start
outer: while true:
  inner: while hasToolCalls or pendingUserMessages:
    prepareNextTurn(lastTurn)?        # hook: compaction / model switch happens here
    inject any pending user messages  # "steering": user typed while agent was working
    message = streamAssistantResponse(context)      # §2 + §3
    if message.stopReason in {error, aborted}: finish
    toolCalls = message.content.filter(toolCall)
    if toolCalls:
      if message.stopReason == "length":
        results = failAll(toolCalls)                 # §4.1
      else:
        results = executeToolCalls(…parallel by default…)
      append each toolResult message to context
    emit turn_end
    if shouldStopAfterTurn(lastTurn): finish
  followUps = getFollowUpMessages()                   # queued *after* the agent would stop
  if followUps: continue outer
  break
emit agent_end
```

Notable behaviors worth copying:

- **Steering vs follow-up.** Messages that arrive *during* a run are injected before the
  next assistant response (steering); messages queued while the agent is about to *stop*
  extend the run (follow-up). One loop handles both.
- **`prepareNextTurn`** runs between turns and can return a new context+model — this is
  where auto-compaction hooks in without interrupting the run.
- **§4.1 The `length` guard.** If the response hit the output token limit, *every* tool
  call in that message is failed with an error tool result ("arguments may be truncated,
  re-issue the tool call") instead of executed. Truncated argument JSON can parse (salvage
  parser) and even validate, yet be silently incomplete — executing it would corrupt state.
  This is a cheap, high-value safety property.
- **Tool batch `terminate`.** A tool result can carry `terminate: true`; if *all* results
  in a batch do (e.g. a subagent-return tool), the loop stops.

## 5. Tool execution

A tool is: `{ name, description, parameters (JSON schema), executionMode?,
prepareArguments?, execute(toolCallId, args, signal, onUpdate) }` returning
`{ content: [{type:"text", text}], details?, usage?, terminate? }`.

Pipeline per call (`prepareToolCall` → `executePreparedToolCall` → `finalizeExecutedToolCall`):

1. **Look up** — unknown tool → error result `"Tool X not found"` (never throws).
2. **Validate** args against the JSON schema (`validateToolArguments`).
3. **`beforeToolCall` hook** — may rewrite args or **block** (with a reason that goes back
   to the LLM). This is the permission/approval seam.
4. **Execute** with an `AbortSignal` and a partial-update callback (long tools can stream
   progress: `tool_execution_update` events).
5. **`afterToolCall` hook** — may rewrite the result (redaction, annotation, …).
6. **Result → message:**

```jsonc
{ "role": "toolResult", "toolCallId": "call_abc123", "toolName": "read",
  "content": [ { "type": "text", "text": "1\timport …" } ],
  "details": { "truncated": true, "fullOutputPath": "/tmp/pi-bash-….log" },
  "isError": false, "timestamp": 1757500001000 }
```

**Errors never leave the loop as exceptions.** A failed tool produces an `isError` result
whose text the model reads and reacts to. The model is part of the error-handling system.

**Parallelism:** all tool calls in a message run concurrently (`Promise.all`), results are
appended in call order. A tool can declare `executionMode: "sequential"` (e.g. file
mutators with a shared queue); if *any* call in the batch is sequential, the whole batch
runs sequentially.

**Output truncation** (`dist/core/tools/truncate.js`) — the rules you see in your own tool
descriptions:

- Two independent limits, whichever hits first: **2000 lines or 50 KB**.
- `read` truncates from the **head** (you want the beginning); `bash` from the **tail**
  (you want errors/final lines). Never returns partial lines (one edge case excepted).
- Truncated output is saved to a temp file; the tool result tells the model the path so it
  can `read` it with offset/limit. Truncation is a *feature with a recovery path*, not a
  data loss.

## 6. Context management (compaction)

`docs/compaction.md` + `dist/core/compaction/`. When context grows, the harness summarizes
its own history *between turns*:

- **Trigger:** `contextTokens > contextWindow − reserveTokens` (reserve default 16384 —
  headroom for the model's own output). Checked after each tool batch and before each new
  prompt; compaction happens inside the running agent loop, transparently.
- **Cut point:** walk back from the newest message until `keepRecentTokens` (default ~20k)
  is covered. Cut at user/assistant/bashExecution/custom boundaries — **never between a
  tool call and its results** (they must travel together).
- **Summary:** a dedicated LLM call (fresh session ID, cache writes disabled) produces a
  *structured* summary — Goal / Constraints / Progress (Done, In Progress, Blocked) /
  Key Decisions / Next Steps / Critical Context — plus cumulative file-operation tracking.
  The next compaction receives the previous summary as iterative context.
- **Rebuild:** the LLM sees `[system, summary-as-user-message, kept recent messages…]`.
  The pre-compaction tail is never sent again.
- Complementary pattern: **history-as-a-tool** (`recall`) — instead of keeping everything
  in context, the model can search the session's past (omitted lines, file versions).
  Search beats retention for long sessions.

## 7. Session persistence

`docs/session-format.md`. Sessions are **JSONL** (append-only), one entry per line:

```
SessionHeader { version, id, … }
message { AgentMessage }        # user | assistant | toolResult | bashExecution | custom |
modelChange { model, … }        # compactionSummary | branchSummary
thinkingLevelChange { … }
compaction { summary, firstKeptEntryId, tokensBefore }
```

Extended message roles beyond the LLM's three: `bashExecution` (full command output, can be
`excludeFromContext` — e.g. `!!`-prefixed commands run for the user, not the model),
`custom` (extension-injected), `compactionSummary`, `branchSummary`.

**Resume = replay**: read the JSONL, rebuild context (honoring compaction boundaries),
continue. Because every entry is an immutable append, branching (`/tree`) is just "fork the
replay from an earlier entry."

## 8. Errors, aborts, retries

- One `AbortSignal` per agent run, threaded through stream + every tool execution.
  Abort mid-stream → the partial message stays in context with `stopReason:"aborted"`;
  abort mid-tool → remaining calls get `"Operation aborted"` results.
- Transient HTTP failures → `retryProviderRequest` (bounded retries, backoff, signal-aware).
- Provider-level failures → assistant message with `stopReason:"error"` + `errorMessage`;
  the loop ends the turn, the harness surfaces it (and can offer retry via
  `agentLoopContinue`, which re-enters the loop from current context without a new user
  message).

---

## 9. What to copy, what to simplify (for our own agent)

| Concern                   | pi's approach                                                         | Our MVP recommendation                                                                                      |
|---------------------------|-----------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| Message model             | Provider-neutral blocks, convert at boundary                          | **Copy.** It's the difference between "works" and "works with every endpoint"                               |
| Endpoint abstraction      | Per-model compat descriptor + per-API module                          | **Simplify:** one API module (openai-completions) + a model config file; add Anthropic later only if needed |
| Loop                      | Outer/inner loops, steering, follow-up, per-turn hooks                | **Copy the inner loop + hooks**; skip steering/follow-up until the UI needs them                            |
| Tool protocol             | JSON schema + `execute(id, args, signal, onUpdate)` + error-as-result | **Copy exactly.** Small, and it's what makes the model robust                                               |
| Parallel tool calls       | Default parallel, opt-out per tool                                    | **Copy** (one `Promise.all` + ordering)                                                                     |
| `length` → fail all calls | Salvage parser + safety guard                                         | **Copy** (cheap, prevents corrupt edits)                                                                    |
| Truncation                | 2000 lines / 50KB, head vs tail, temp file recovery                   | **Copy**                                                                                                    |
| System prompt             | Sections: tools, guidelines, context files, skills index, cwd         | **Copy the shape**; keep it < ~2k tokens                                                                    |
| Compaction                | Structured summary between turns, never split call/result             | **Defer to Phase 3** — MVP just warns near the limit; but design the context-rebuild seam now               |
| Sessions                  | JSONL append-only + replay                                            | **Copy** (it's trivially simple and gets resume + branching for free)                                       |
| Skills                    | Index in prompt, body on demand                                       | **Copy the pattern**; very high value, ~0 cost                                                              |
| UI                        | Ink TUI over an event stream                                          | **Defer.** MVP = plain CLI that prints events; the event vocabulary (§3/§4) is the UI's API                 |

The single most important invariant, restated: **everything the model sees is a message;
everything the model can do is a tool; everything the tool does is observed through the
same message channel.** No side channels, no exceptions crossing the boundary.
