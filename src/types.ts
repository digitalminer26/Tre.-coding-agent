/**
 * WS0 — the three contracts that decouple the workstreams.
 *
 *   1. AgentMessage (+ ContentBlock, Usage, StopReason) — the shared,
 *      provider-neutral message language of wire, loop, session, and UI.
 *   2. AgentEvent / AssistantStreamEvent — the event vocabulary.
 *   3. StreamFn + Tool — the loop's only two dependencies.
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
 */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

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
    }
  | { type: "turn_start"; turn: number }
  | { type: "turn_end"; turn: number }
  | { type: "tool_execution_start"; toolCall: ToolCallBlock }
  | { type: "tool_execution_update"; toolCallId: string; text: string }
  | { type: "tool_execution_end"; toolCallId: string; result: ToolResultMessage }
  | AssistantStreamEvent;

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
  /** Surfaced on the ToolResultMessage.details of the matching message. */
  details?: Record<string, unknown>;
  /** If true on every result of a batch, the loop stops after the batch. */
  terminate?: boolean;
}

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
  /** Only "openai-completions" for the MVP; the union grows later. */
  api: "openai-completions";
  contextWindow: number;
  /** Default output cap (max_tokens) for this model. */
  maxTokens: number;
  temperature?: number;
  apiKey?: string;
  compat?: ModelCompat;
}
