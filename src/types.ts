/**
 * WS0 — the three contracts that decouple the workstreams.
 *
 *   1. AgentMessage (+ ContentBlock, Usage, StopReason) — the shared,
 *      provider-neutral message language of wire, loop, session, and UI.
 *   2. AgentEvent / AssistantStreamEvent — the event vocabulary.
 *   3. StreamFn + Tool — the loop's only two dependencies.
 *
 * L2: structure adapted from @earendil-works/pi-agent-core 0.85.1 (MIT,
 *      © Mario Zechner) — the provider-neutral message model (ContentBlock
 *      union, Usage, StopReason), the event vocabulary (AssistantStreamEvent
 *      with `partial` on every event; AgentEvent), and the Tool protocol
 *      (execute(toolCallId, args, signal, onUpdate), error-as-result) —
 *      docs/01 §3–5, §9 "Copy" / "Copy exactly".
 *      Simplified: no bashExecution/custom/branchSummary message kinds, no
 *      per-tool usage, no cost tracking, no prepareArguments.
 *      Added: StopReason "budget"/"loop"/"stall" (C26 + stall detection),
 *      `details` on tool results.
 *
 * Invariants (see docs/02-contracts.md):
 *   I1. Everything the model sees is a message; everything it can do is a
 *       tool; results flow back through the same message channel.
 *   I2. Every streaming event carries `partial` — the full in-progress
 *       assistant message — so one context slot is always consistent.
 *   I3. No exceptions cross module boundaries: failures become data
 *       (stopReason "error", isError tool results).
 */

// ──────────────────── 1. Messages (provider-neutral) ────────────────────

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  /** Provider-generated id; the wire layer normalizes length/charset. */
  id: string;
  name: string;
  /**
   * Parsed arguments. On in-flight (partial) messages this is best-effort
   * (may be {} mid-stream); only the parse on the `done` message is
   * authoritative. The wire layer owns JSON parse + salvage.
   */
  arguments: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface Usage {
  input: number;
  output: number;
  /** Prompt tokens served from cache, when the endpoint reports it. */
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens: number;
}

/**
 * Why an assistant message ended. Mirrors the wire's finish_reason:
 *   stop     — model finished normally
 *   length   — hit the output token cap (tool-call args may be truncated!)
 *   toolUse  — model wants to call tools
 *   error    — provider/transport failure; see errorMessage
 *   aborted  — AbortSignal fired; the partial is kept in context
 *   budget   — C26: EVERY cycle's turn budget was exhausted (the loop
 *              auto-continues per cycle; this is the final stop); set by
 *              the LOOP (never a wire finish_reason); the run is resumable
 *   loop     — C26: the model issued the same tool-call batch 3 times in
 *              a row (runaway-loop detection); the third repeat was not
 *              executed; set by the LOOP; the run is resumable
 *   stall    — the same tool failed 3 times with a permission denial
 *              (Operation not permitted / permission denied — the
 *              deterministic sandbox wall) within its last 8 calls (docs/08
 *              H1: windowed — interleaved successes do not reset); the
 *              failing call was not executed; set by the LOOP (from the
 *              tool pipeline's `stall` detail); the run is resumable
 */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "budget" | "loop" | "stall";

export interface UserMessage {
  role: "user";
  /** MVP: plain text. (Images etc. would extend this to ContentBlock[].) */
  content: string;
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  /** Ordered blocks, as the model emitted them (text and tool calls interleaved). */
  content: ContentBlock[];
  /** Model id as requested on the wire. */
  model: string;
  /** Provider label, e.g. "vks-llama". */
  provider: string;
  stopReason: StopReason;
  /** Set when stopReason === "error". */
  errorMessage?: string;
  usage?: Usage;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  /** Links to the ToolCallBlock.id this result answers. */
  toolCallId: string;
  toolName: string;
  /** MVP: text only. */
  content: TextBlock[];
  /** True when the tool failed. The text is what the model reads and reacts to. */
  isError?: boolean;
  /** Structured extras, e.g. { truncated: true, fullOutputPath: "…" }. */
  details?: Record<string, unknown>;
  timestamp: number;
}

/** The provider-neutral message type. The loop's context is AgentMessage[]. */
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

/**
 * D19 — file-access tools the UI stays silent about ON SUCCESS. A call is
 * shown only when it is DENIED (isError) — a whitelist denial is the only
 * directory-access news worth a line. Both consumers are the TUI
 * (state.ts: hidden item, unhidden or dropped on end) and the plain CLI
 * (printEvent: no start line, end line only on isError). bash is NOT here:
 * its command line is the approval surface.
 */
export const QUIET_ON_SUCCESS_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit"]);

// ───────────────────────────── 2. Events ─────────────────────────────

/**
 * Emitted by a StreamFn while one assistant message is generated.
 * `start` is always first, `done` always last; every event carries the
 * full in-progress assistant message (I2).
 */
export type AssistantStreamEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_delta"; delta: string; partial: AssistantMessage }
  | { type: "thinking_delta"; delta: string; partial: AssistantMessage }
  | {
      type: "toolcall_start";
      /** Position of this call within the response's tool_calls array. */
      index: number;
      id?: string;
      name?: string;
      partial: AssistantMessage;
    }
  | {
      type: "toolcall_delta";
      index: number;
      /** Raw JSON argument fragment (arguments arrive as string chunks). */
      argsDelta: string;
      partial: AssistantMessage;
    }
  | { type: "done"; message: AssistantMessage };

/**
 * The loop's event stream — what the CLI prints and the session persists.
 * Wire events pass through unchanged; the loop adds lifecycle + tool events.
 */
export type AgentEvent =
  | { type: "agent_start" }
  | {
      type: "agent_end";
      /** stopReason of the last assistant message. */
      stopReason: StopReason;
      /** Final context — what the session layer appends to the JSONL file. */
      messages: AgentMessage[];
      /**
       * Present when stopReason === "budget": the per-CYCLE cap that was
       * hit (so the UI can name it). A new prompt starts a new run with a
       * fresh count.
       */
      maxTurns?: number;
      /**
       * Present when stopReason === "budget": how many cycles the run got
       * (maxContinuations + 1) — the UI says "max N turns × M cycles
       * reached".
       */
      maxCycles?: number;
    }
  | {
      /**
       * C26 — a cycle's turn budget was exhausted and the loop auto-
       * continues (counter reset). Informational, not an error: the run
       * keeps going. Emitted by the loop between turns.
       */
      type: "turn_budget";
      /** Turn counter at the moment of exhaustion. */
      turn: number;
      /** Continuation number, 1-based (1 = the 2nd cycle begins). */
      cycle: number;
      /** Total cycles allowed (maxContinuations + 1). */
      maxCycles: number;
      /** The per-cycle cap that was exhausted. */
      maxTurns: number;
    }
  | { type: "turn_start"; turn: number }
  | { type: "turn_end"; turn: number }
  | {
      /**
       * Steering: guidance the user typed while a run was in flight. The
       * driver queued it; the loop delivered it as a user message into the
       * context just before this LLM call. Informational (the TUI already
       * echoed the line at submit time — it is a NO-OP in applyEvent).
       */
      type: "steer";
      turn: number;
      text: string;
    }
  | { type: "tool_execution_start"; toolCall: ToolCallBlock }
  | { type: "tool_execution_update"; toolCallId: string; text: string }
  | { type: "tool_execution_end"; toolCallId: string; result: ToolResultMessage }
  | {
      /** D10 (WS9): the CLI's compaction hook replaced the context between
       *  LLM turns. Emitted by the CLI (runTurn), not by the loop. */
      type: "context_compacted";
      tokensBefore: number;
      messagesKept: number;
      summaryChars: number;
      /** Estimated tokens of the NEW context ([summary, …kept]) — what the
       *  next prompt starts from (estimateTokens; chars/4). */
      contextTokens?: number;
      /** D (failure escalation): the summary call failed twice and the
       *  context was shrunk by the rule-based fallback (no LLM summary). */
      degraded?: boolean;
    }
  | AssistantStreamEvent;

/**
 * One-line explanation of a run that ended with stopReason "length".
 * The wording must be accurate for BOTH failure modes: the last assistant
 * message may hold a tool call whose arguments were truncated, or the model
 * may have spent the whole output budget on thinking/text and emitted NO
 * call at all (thinking models with a small maxTokens). The UI must not
 * claim one when the other is what happened.
 */
export function lengthEndNote(messages: AgentMessage[]): string {
  const lastAsst = [...messages].reverse().find((m) => m.role === "assistant");
  const hadCall =
    lastAsst !== undefined && lastAsst.content.some((b) => b.type === "toolCall");
  return hadCall
    ? "length: output limit hit — tool-call arguments may be truncated"
    : "length: output limit hit — response cut off before any tool call (thinking/text consumed the output budget)";
}

// ─────────────────── 3. The loop's two dependencies ───────────────────

/** What one LLM call needs. Built by the loop; consumed by the wire layer. */
export interface LlmContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: Tool[];
}

/**
 * The loop's only dependency on the wire layer.
 * Owns: HTTP + bounded retry + abort, request building, SSE parse,
 * tool-call argument accumulation + best-effort JSON salvage, usage capture.
 * Does not own: context management, tool dispatch, anything loop-shaped.
 * Must end with exactly one `done` event — even on failure (I3).
 */
export type StreamFn = (
  model: ModelConfig,
  ctx: LlmContext,
  opts: { apiKey?: string; signal: AbortSignal },
) => AsyncIterable<AssistantStreamEvent>;

export interface ToolResult {
  content: TextBlock[];
  /**
   * Set by the tool pipeline (WS3) when the call failed (invalid args,
   * blocked by a hook, tool error). The loop marks the ToolResultMessage
   * `isError` accordingly — I3: tool failures are data, not exceptions (D7).
   */
  isError?: boolean;
  /** Surfaced on the ToolResultMessage.details of the matching message. */
  details?: Record<string, unknown>;
  /** If true on every result of a batch, the loop stops after the batch. */
  terminate?: boolean;
}

/**
 * The loop's tool-execution seam (Contract 4). Defaults in the loop to
 * `tool.execute` directly; WS3's full pipeline (validate → beforeToolCall →
 * execute → afterToolCall) is injected here so the loop stays decoupled
 * from the tool system. Lives in types.ts (not the loop) so the tools
 * layer can implement it without depending on the loop layer.
 */
export type ExecuteToolCall = (
  tool: Tool,
  call: ToolCallBlock,
  signal: AbortSignal,
  onUpdate?: (text: string) => void,
) => Promise<ToolResult>;

/** The loop's only dependency on tools. */
export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for `execute`'s `args`; sent to the LLM verbatim. */
  parameters: JsonSchema;
  /** "sequential" forces the whole batch to run in call order. Default parallel. */
  executionMode?: "parallel" | "sequential";
  /**
   * Must never throw for expected failures — return a result whose text
   * describes the failure (I3). Must honor `signal` (abort mid-flight).
   */
  execute(
    toolCallId: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    /** Optional progress callback (long-running tools). */
    onUpdate?: (text: string) => void,
  ): Promise<ToolResult>;
}

/** Minimal JSON Schema (zero dependencies). */
export interface JsonSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: (string | number)[];
  [key: string]: unknown;
}

// ─────────────────────── Model catalog (models.json) ───────────────────────

/**
 * Per-model compat flags absorb endpoint differences so the wire layer
 * stays one code path. Start with what llama.cpp needs; grow as new
 * endpoints are added.
 */
export interface ModelCompat {
  /** Wire field for the output cap. Default "max_tokens". */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** false → omit stream_options.include_usage. Default true. */
  supportsUsageInStreaming?: boolean;
  /** Insert a synthetic assistant message after tool results, before a user message. */
  requiresAssistantAfterToolResult?: boolean;
  /** Merged verbatim into every request body (e.g. enable_thinking). */
  extraParams?: Record<string, unknown>;
}

export interface ModelConfig {
  /** The `model` field sent on the wire, e.g. "Qwen3.8-27B-UD-Q4_K_M". */
  id: string;
  /** Label for sessions/UI, e.g. "vks-llama". */
  provider: string;
  /** e.g. "http://172.30.70.11:8080/v1" */
  baseUrl: string;
  /**
   * "openai-completions" — /chat/completions (local llama.cpp, etc.).
   * "openai-responses" — /responses (OpenAI Responses API; the ChatGPT
   *   subscription backend, D15). The CLI picks the matching StreamFn.
   */
  api: "openai-completions" | "openai-responses";
  contextWindow: number;
  /** Default output cap (max_tokens) for this model. */
  maxTokens: number;
  temperature?: number;
  apiKey?: string;
  compat?: ModelCompat;
  /**
   * D15 — how the wire authenticates. "chatgpt-oauth": the access token is
   * resolved from the local ChatGPT OAuth token store (refreshed on expiry)
   * instead of a static `apiKey`. Only meaningful with
   * `api: "openai-responses"`.
   */
  auth?: "chatgpt-oauth";
}

// ──────────────────── 4. Worker registry (endpoint visibility) ──────────

/**
 * The status of one `tre. run` worker, as the other tre. processes (the
 * TUI's `workers` bottom field) see it. A worker writes one of these to its
 * own file in the shared worker dir (`~/.tre/workers/`, see
 * `src/cli/workers.ts`) on startup, refreshes it as it works, and marks it
 * done/failed on exit. The TUI polls the dir and renders the live set —
 * this is the CONTRACT between the writer (cli/main.ts) and the reader
 * (tui/state.ts + tui/run.tsx); it lives here so neither side imports the
 * other.
 */
export interface WorkerStatus {
  /** Stable worker id (the filename stem in the worker dir). */
  id: string;
  /** The model id the worker runs on (from models.json). */
  model: string;
  /** The endpoint's baseUrl (the "which endpoint" the user asked about). */
  endpoint: string;
  /** "running" while the worker works; "done"/"failed" on exit. */
  status: "running" | "done" | "failed";
  /** The worker's current turn number (0 before the first turn). */
  turn: number;
  /** The worker's most recent activity label (tool name, "thinking", …). */
  activity: string;
  /** Epoch ms of the last status write (the TUI prunes stale entries). */
  updatedAt: number;
  /** Epoch ms the worker started (for elapsed time). */
  startedAt: number;
  /** The worker's working directory (so the user sees WHAT it works on). */
  cwd: string;
  /** The worker's prompt (truncated) — what it was asked to do. */
  task: string;
}
