# WS0 — The Three Contracts

> **Status note:** This document began as the WS0 parallel-work contract and
> now also records later contract increments. The original descriptions below
> are historical where labeled (for example, MVP-era producers or behavior);
> current types and runtime behavior in `src/types.ts` and `src/` take
> precedence. For project status, see `README.md`; dated changes are in
> `HANDOFF.md`.

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
  permission-signature failures PER TOOL (per executor instance — the CLI
  builds one per run), WINDOWED (docs/08 H1, 2026-09-30): the count is
  "how many permission failures of this tool within its last
  `STALL_WINDOW` (8) calls" — NOT "how many in a row". The count is keyed
  on the tool NAME, not the arguments: a model that rephrases the command
  each retry (`git push` → `git push origin main` → …) defeats the loop's
  3-identical-batch guard, and rephrasing is exactly the stall pattern —
  so it must NOT reset the count. A model PROBEING the boundary
  interleaves successful calls with the denied ones — so a success or a
  non-permission failure must NOT reset the count either (it occupies a
  slot in the window); the window sliding past a failure drops it (a
  stale denial 8+ calls ago must not stall a fresh retry). Each tool has
  its own window and count — a different tool neither inherits nor resets
  it. The `STALL_THRESHOLD` (3)th permission failure of a tool within its
  window is replaced in-band with `stallText(tool)` + `details.stall`
  (I3: every call gets a result); the call WAS executed (a denial is a
  harmless no-op), so a legitimate call that SUCCEEDS never trips it. The
  loop maps `details.stall` onto `stopReason: "stall"` and stops —
  resumable like `loop` (exit 3). Non-permission failures (transient
  errors are normal retries) never count toward the threshold. The two
  guards are complementary: byte-identical retries are caught by the loop
  guard (stopReason `loop`); rephrased or interleaved retries are caught
  here (stopReason `stall`).
- **C35 — extra roots: an explicitly assigned, non-sensitive directory under
  home becomes an additional read/write region (one boundary, two layers).**
  The boundary is a *set* of roots, not a single value: the workspace
  (`--cwd`) plus each `--extra-root <dir>` (repeatable). The two layers that
  enforce it MUST move together — the bash kernel policy
  (`generateBashSandboxPolicy(root, extraRoots)`) re-allows each extra root's
  subpath (real path, read **and** write, with its ancestor-metadata chain),
  emitted BEFORE the workspace rule so the workspace stays the last matching
  rule; and the write/edit path sandbox (`checkPathWithinRoots(roots, p)`)
  allows a path under ANY root. `read` stays unrestricted. An extra root
  re-allows **its own subpath only** — never its parent or siblings — so a
  path outside every root is still denied by the kernel and refused by the
  hook. **The sensitive-root guard (what makes it a contract):** at startup
  each extra root is validated and the run REFUSES to start (exit 2, like
  `--cwd` on a missing dir) if its real path is sensitive (`~/.ssh`, `~/.aws`,
  `*.pem`, `.env`-family, …) or outside the user's home dir (v1 rule: a
  non-sensitive dir under `~`). The (ws)/(sys) sensitive split keeps using
  the PRIMARY root only — an extra root widens the *boundary* but never
  downgrades a path from (sys)-sensitive to (ws), so a `.env` under an extra
  root is still blocked in every mode. **Inherited-sandbox limitation:** when
  `TRE_SANDBOX === "1"`, the bash child spawns unwrapped (it inherits the
  caller's confinement and the per-call policy is not re-applied), so extra
  roots are inert there — same as the workspace re-allow today. Full spec:
  `docs/05-extra-roots-spec.md`.
- **C36 — durable extra roots: `tre.json` persists the C35 boundary.** C35's
  extra roots were flag-only (`--extra-root`, re-passed every launch). C36 adds
  a config file `tre.json` with a single field, `extraRoots` (an array of
  directory strings). **Lookup** mirrors D19's models.json convention: walk UP
  from the launch directory for a `tre.json` (the same convention as a `.git`
  dir or a `models.json`), then fall back to `~/.tre/tre.json`. **Precedence:**
  the CLI flag APPENDS to the config — `tre.json` is the durable baseline and
  `--extra-root` is the per-launch addition (both are validated). **Tilde
  (2026-09-30):** an entry (config OR flag) may start with `~` or `~/` — it is
  expanded against the home dir at startup (`expandTilde` in
  `src/config/tre-config.ts`), shell-style, BEFORE the C35 validation, so
  `~/kubeconfigs` is portable across machines/users; `~` alone means the home
  dir; a bare `~name` is NOT expanded (no user-lookup — it resolves to the
  literal `~name` path and fails the exists check, fail-closed). **Guard
  (fail-closed):** every `tre.json` entry is validated at startup EXACTLY like a
  `--extra-root` value (`validateExtraRoot` — exists, non-sensitive, under
  home); a malformed file (bad JSON, non-array `extraRoots`, non-string/empty
  entry) or a refused entry REFUSES the startup (exit 2, like a bad flag) —
  never a silent ignore. A missing `tre.json` is the flag-only C35 behavior
  (no durable roots). `tre.json` is the first durable config surface; `extraRoots`
  is its first field (future fields are additive).

- **C37 — background Telegram driver for the plain CLI (one-shot + REPL),
  with loop prevention.** The TUI already polls the bot (`src/tui/run.tsx`);
  the plain CLI did not (the user's messages were only seen after the
  workstream finished). C37 adds a background driver
  (`src/telegram/driver.ts` + `src/telegram/bridge.ts`) that LONG-POLLS the
  bot (one `getUpdates` per cycle, blocking up to 15s via the helper's new
  `poll --timeout N`) and routes each message: a turn in flight → **steer** it
  into the running loop (the existing `SteeringQueue`); idle → run a turn and
  reply via the bot (REPL only — one-shot is a single turn). **Loop
  prevention is the contract's core** — a naive `while (true) { poll(); }`
  hot-spins (hundreds of process spawns/sec) when a poll fails FAST (network
  down, bad token). Three independent mechanisms make that impossible:
  (1) **long-poll self-pacing** — each poll blocks up to 15s, so a no-message
  cycle takes ~15s; (2) **min-interval guard** — a hard cap keeps ≥15s between
  poll STARTS even if a poll returns instantly (a helper that ignores
  `--timeout`, or a fast failure); (3) **capped exponential backoff on
  failure** — a fast-failing poll backs off `min(base·2ⁿ, cap)` (default
  1s→60s), so a persistent failure settles to one poll per 60s, never a spin;
  a success (even "no message") resets the counter. The driver is also
  **interruptible** (`stop()` kills the in-flight poll child and wakes any
  sleep) and **single-flight** (a turn mutex serializes user + telegram turns
  so two turns never run concurrently on the shared context). The driver is
  **inert** when the bridge is not enabled (no `.tre/telegram.json` + helper)
  — the no-telegram path is byte-for-byte the old behavior. The LLM endpoint
  is NOT involved in polling (a poll is one HTTPS GET); the LLM is only spent
  when a real message arrives and a turn runs.

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
