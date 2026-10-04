/**
 * D15 — OpenAI Responses API wire layer (the ChatGPT subscription backend).
 *
 * A second `StreamFn` alongside `openAiStream` (chat/completions). Same
 * contract (docs/02-contracts.md): request building, SSE parse → normalized
 * `AssistantStreamEvent`s, tool-call accumulation + salvage, usage capture,
 * exactly one `start`…`done` per call (I2/I3). The loop, tools, session, and
 * TUI are untouched — the CLI picks this StreamFn when
 * `model.api === "openai-responses"`.
 *
 * Wire differences from chat/completions (verified against the OpenAI
 * Responses API + the openai/codex reference implementation):
 *   - endpoint: `POST {baseUrl}/responses` (baseUrl ends in `/v1`)
 *   - body: `{ model, instructions, input: Item[], tools, stream,
 *     max_output_tokens, temperature }` — the conversation is an `input`
 *     array of typed items (message / function_call / function_call_output),
 *     not a `messages` array.
 *   - SSE: `event: response.*` frames — `output_text.delta`,
 *     `reasoning_text.delta` / `reasoning_summary_text.delta`,
 *     `function_call_arguments.delta` (keyed by `item_id`),
 *     `output_item.added` / `.done` (full item), `completed` / `incomplete` /
 *     `failed` (terminal, with `response.usage`).
 *   - auth: a `Bearer` access token from the local ChatGPT OAuth token
 *     store (`model.auth === "chatgpt-oauth"`), resolved (and refreshed on
 *     expiry) INSIDE the async generator before the first yield — the
 *     "expiring OAuth token" seam reserved in PLAN.md §8. A static
 *     `apiKey`/`opts.apiKey` also works (tests, non-subscription keys).
 *
 * L3: original implementation (the chat/completions wire is the structural
 * reference; the Responses event vocabulary is from the OpenAI API docs +
 * codex-rs/codex-api/src/sse/responses.rs fixtures).
 */
import type {
  AssistantMessage,
  AssistantStreamEvent,
  ContentBlock,
  LlmContext,
  ModelConfig,
  StreamFn,
  ToolCallBlock,
  Usage,
} from "../types.js";
import { HttpError, sseStream } from "./http.js";
import { isAbort } from "./abort.js";
import { parseToolArgs, sanitizeCallId } from "./openai-completions.js";
import { AuthError, AuthRequiredError, resolveAccessToken } from "../auth/token-store.js";
import { CHATGPT_API_BASE } from "../auth/constants.js";

// ───────────────────────── request building ─────────────────────────

/** One Responses-API `input` item. */
export type ResponsesItem =
  | {
      type: "message";
      role: "user" | "assistant";
      content: { type: "input_text" | "output_text"; text: string }[];
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/**
 * Convert the provider-neutral context into Responses `input` items.
 *   user            → message/input_text
 *   assistant text  → message/output_text
 *   assistant call  → function_call (one item per call)
 *   toolResult      → function_call_output
 * Empty assistant messages (no text, no calls) are skipped — the API
 * rejects them.
 */
export function convertToItems(ctx: LlmContext): ResponsesItem[] {
  const out: ResponsesItem[] = [];
  for (const m of ctx.messages) {
    if (m.role === "user") {
      out.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: m.content }],
      });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      const calls = m.content.filter((b): b is ToolCallBlock => b.type === "toolCall");
      if (text.length === 0 && calls.length === 0) continue;
      if (text.length > 0) {
        out.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      for (const c of calls) {
        out.push({
          type: "function_call",
          call_id: sanitizeCallId(c.id),
          name: c.name,
          arguments: JSON.stringify(c.arguments ?? {}),
        });
      }
      continue;
    }
    // toolResult → function_call_output
    out.push({
      type: "function_call_output",
      call_id: sanitizeCallId(m.toolCallId),
      output: m.content.map((b) => b.text).join("\n"),
    });
  }
  return out;
}

/** Build the full Responses request body. */
export function buildResponsesParams(
  model: ModelConfig,
  ctx: LlmContext,
): Record<string, unknown> {
  const compat = model.compat ?? {};
  const params: Record<string, unknown> = {
    model: model.id,
    input: convertToItems(ctx),
    stream: true,
    max_output_tokens: model.maxTokens,
  };
  if (ctx.systemPrompt) params.instructions = ctx.systemPrompt;
  if (ctx.tools.length > 0) {
    params.tools = ctx.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
  if (typeof model.temperature === "number") params.temperature = model.temperature;
  if (compat.extraParams) Object.assign(params, compat.extraParams);
  return params;
}

export function responsesUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/responses";
}

// ───────────────────────── token resolution ─────────────────────────

/**
 * Resolve the Bearer token for one request:
 *   - `model.auth === "chatgpt-oauth"` → the token store (refresh on
 *     expiry). `AuthRequiredError`/`AuthError` are converted to a
 *     user-facing message (I3 — no exceptions cross the StreamFn boundary).
 *   - otherwise → `opts.apiKey ?? model.apiKey` (static; tests).
 */
async function resolveBearer(
  model: ModelConfig,
  opts: { apiKey?: string; signal: AbortSignal },
): Promise<{ token: string; error?: string }> {
  if (model.auth === "chatgpt-oauth") {
    try {
      const token = await resolveAccessToken({ signal: opts.signal });
      return { token };
    } catch (err) {
      if (isAbort(err)) return { token: "", error: "aborted" };
      if (err instanceof AuthRequiredError) return { token: "", error: err.message };
      if (err instanceof AuthError) return { token: "", error: `ChatGPT auth: ${err.message}` };
      return { token: "", error: `ChatGPT auth: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const token = opts.apiKey ?? model.apiKey ?? "";
  if (token === "") return { token: "", error: "no API key and no ChatGPT login on record" };
  return { token };
}

// ───────────────────────── usage + helpers ─────────────────────────

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

function mapUsage(u: ResponsesUsage | undefined): Usage | undefined {
  if (!u) return undefined;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  return {
    input,
    output,
    totalTokens: u.total_tokens ?? input + output,
    ...(typeof u.input_tokens_details?.cached_tokens === "number"
      ? { cacheRead: u.input_tokens_details.cached_tokens }
      : {}),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface RespItem {
  type?: string;
  id?: string;
  role?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: { type?: string; text?: string }[];
}

interface RespResponse {
  id?: string;
  status?: string;
  error?: { code?: string; message?: string };
  usage?: ResponsesUsage;
  incomplete_details?: { reason?: string };
}

function describeError(err: unknown): string {
  if (err instanceof HttpError) {
    let detail = err.body ?? "";
    try {
      const j: unknown = JSON.parse(detail);
      if (isPlainObject(j) && isPlainObject(j.error)) {
        const m = (j.error as Record<string, unknown>).message;
        if (typeof m === "string") detail = m;
      }
    } catch {
      /* keep raw body */
    }
    return `HTTP ${err.status}: ${detail}`.slice(0, 1000);
  }
  return err instanceof Error ? err.message : String(err);
}

// ─────────────────────── streaming state machine ───────────────────────

interface ToolEntry {
  /** The function_call item id (the `item_id` deltas reference). */
  itemId: string;
  /** The call id (what function_call_output references). */
  id: string;
  name: string;
  raw: string;
  lastGood: Record<string, unknown>;
  block: ToolCallBlock;
}

/**
 * The OpenAI Responses API StreamFn.
 *
 * Usage: `events = openAiResponsesStream(model, ctx, { signal })` — the
 * `apiKey` opt is ignored when `model.auth === "chatgpt-oauth"` (the token
 * store wins).
 */
export const openAiResponsesStream: StreamFn = (model, ctx, opts) => {
  return (async function* (): AsyncGenerator<AssistantStreamEvent> {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      model: model.id,
      provider: model.provider,
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const tools = new Map<string, ToolEntry>(); // itemId → entry
    let finish: { reason: AssistantMessage["stopReason"]; message?: string } | undefined;
    let usage: Usage | undefined;
    let sawRefusal = false;

    const snap = (): AssistantMessage => ({
      ...message,
      content: message.content.map((b) => ({ ...b })),
    });

    const appendText = (delta: string): void => {
      const block = message.content.find((b): b is { type: "text"; text: string } => b.type === "text");
      if (block) block.text += delta;
      else message.content.push({ type: "text", text: delta });
    };
    const appendThinking = (delta: string): void => {
      const block = message.content.find(
        (b): b is { type: "thinking"; thinking: string } => b.type === "thinking",
      );
      if (block) block.thinking += delta;
      else message.content.push({ type: "thinking", thinking: delta });
    };

    /**
     * Fold a `function_call` item (from output_item.added/.done) into the
     * tool table. `added` usually arrives before the argument deltas (name +
     * call_id known early); `done` carries the authoritative `arguments`
     * string. Deltas keyed by `item_id` are matched here by item id.
     */
    const upsertFunctionCall = (item: RespItem): void => {
      const itemId = item.id ?? "";
      const callId = sanitizeCallId(item.call_id ?? itemId, tools.size);
      let entry = itemId !== "" ? tools.get(itemId) : undefined;
      if (!entry) {
        entry = {
          itemId: itemId || `item_${tools.size}`,
          id: callId,
          name: item.name ?? "",
          raw: "",
          lastGood: {},
          block: { type: "toolCall", id: callId, name: item.name ?? "", arguments: {} },
        };
        tools.set(entry.itemId, entry);
        message.content.push(entry.block);
      }
      if (item.name) {
        entry.name = item.name;
        entry.block.name = entry.name;
      }
      if (callId !== entry.id) {
        entry.id = callId;
        entry.block.id = callId;
      }
      if (typeof item.arguments === "string" && item.arguments.length > 0) {
        // `done` carries the full argument JSON — authoritative.
        entry.raw = item.arguments;
        try {
          const v: unknown = JSON.parse(item.arguments);
          if (isPlainObject(v)) entry.lastGood = v;
        } catch {
          /* keep last good */
        }
        entry.block.arguments = entry.lastGood;
      }
    };

    yield { type: "start", partial: snap() };

    // Resolve the Bearer token BEFORE the first network call (a refresh may
    // take a round-trip). A failed resolution is a clean done(error) — I3.
    const { token, error: tokenError } = await resolveBearer(model, opts);
    if (tokenError !== undefined) {
      finish =
        tokenError === "aborted"
          ? { reason: "aborted" }
          : { reason: "error", message: tokenError };
    }

    if (finish === undefined) {
      try {
        const frames = sseStream({
          url: responsesUrl(model.baseUrl || CHATGPT_API_BASE),
          body: JSON.stringify(buildResponsesParams(model, ctx)),
          apiKey: token,
          signal: opts.signal,
        });
        for await (const frame of frames) {
          if (frame.data === "[DONE]") break;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(frame.data) as Record<string, unknown>;
          } catch {
            continue; // non-JSON data line: ignore
          }
          const type =
            (typeof payload.type === "string" ? payload.type : undefined) ?? frame.event;
          switch (type) {
            case "response.output_text.delta": {
              const delta = typeof payload.delta === "string" ? payload.delta : "";
              if (delta.length > 0) {
                appendText(delta);
                yield { type: "text_delta", delta, partial: snap() };
              }
              break;
            }
            case "response.reasoning_text.delta":
            case "response.reasoning_summary_text.delta": {
              const delta = typeof payload.delta === "string" ? payload.delta : "";
              if (delta.length > 0) {
                appendThinking(delta);
                yield { type: "thinking_delta", delta, partial: snap() };
              }
              break;
            }
            case "response.refusal.delta": {
              sawRefusal = true;
              const delta = typeof payload.delta === "string" ? payload.delta : "";
              if (delta.length > 0) {
                appendText(delta);
                yield { type: "text_delta", delta, partial: snap() };
              }
              break;
            }
            case "response.output_item.added":
            case "response.output_item.done": {
              const item = payload.item as RespItem | undefined;
              if (item?.type === "function_call") upsertFunctionCall(item);
              break;
            }
            case "response.function_call_arguments.delta": {
              const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
              const frag = typeof payload.delta === "string" ? payload.delta : "";
              if (itemId === "" || frag.length === 0) break;
              let entry = tools.get(itemId);
              if (!entry) {
                entry = {
                  itemId,
                  id: sanitizeCallId("", tools.size),
                  name: "",
                  raw: "",
                  lastGood: {},
                  block: { type: "toolCall", id: "", name: "", arguments: {} },
                };
                tools.set(itemId, entry);
                message.content.push(entry.block);
              }
              entry.raw += frag;
              try {
                const v: unknown = JSON.parse(entry.raw);
                if (isPlainObject(v)) entry.lastGood = v;
              } catch {
                /* mid-stream: keep last good parse */
              }
              entry.block.arguments = entry.lastGood;
              yield {
                type: "toolcall_delta",
                index: tools.size - 1,
                argsDelta: frag,
                partial: snap(),
              };
              break;
            }
            case "response.completed": {
              const r = payload.response as RespResponse | undefined;
              usage = mapUsage(r?.usage);
              if (sawRefusal) {
                finish = { reason: "error", message: "content filter: the model refused the request" };
              } else {
                finish = {
                  reason: message.content.some((b) => b.type === "toolCall") ? "toolUse" : "stop",
                };
              }
              break;
            }
            case "response.incomplete": {
              const r = payload.response as RespResponse | undefined;
              usage = mapUsage(r?.usage);
              const reason = r?.incomplete_details?.reason;
              finish =
                reason === "content_filter"
                  ? { reason: "error", message: "content filter triggered" }
                  : { reason: "length" };
              break;
            }
            case "response.failed": {
              const r = payload.response as RespResponse | undefined;
              usage = mapUsage(r?.usage);
              finish = {
                reason: "error",
                message:
                  (typeof r?.error?.message === "string" && r.error.message) ||
                  `response failed (${r?.error?.code ?? "unknown"})`,
              };
              break;
            }
            default:
              // created / in_progress / metadata / content_part.* /
              // function_call_arguments.done / *_done — no action needed.
              break;
          }
        }
        if (opts.signal.aborted) finish = { reason: "aborted" };
        else if (!finish) {
          finish = message.content.length > 0
            ? { reason: "stop" }
            : { reason: "error", message: "stream ended without a terminal event" };
        }
      } catch (err) {
        finish = isAbort(err)
          ? { reason: "aborted" }
          : { reason: "error", message: describeError(err) };
      }
    }

    // Authoritative parse of tool-call args (the partials were best-effort).
    for (const entry of tools.values()) {
      entry.block.arguments = parseToolArgs(entry.raw);
    }

    const done: AssistantMessage = { ...snap(), stopReason: finish.reason };
    if (finish.message) done.errorMessage = finish.message;
    if (usage) done.usage = usage;
    yield { type: "done", message: done };
  })();
};

/** Test helper: run a StreamFn to completion and collect its events. */
export async function collectResponsesStream(
  streamFn: StreamFn,
  model: ModelConfig,
  ctx: LlmContext,
  opts: { apiKey?: string; signal: AbortSignal },
): Promise<AssistantStreamEvent[]> {
  const out: AssistantStreamEvent[] = [];
  for await (const e of streamFn(model, ctx, opts)) out.push(e);
  return out;
}
