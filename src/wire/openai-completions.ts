/**
 * WS1 — OpenAI-compatible chat/completions wire layer (the first StreamFn).
 *
 * Owns (per docs/02-contracts.md, Contract 3):
 *   - request building (buildParams / convertMessages)
 *   - SSE parse → normalized AssistantStreamEvents
 *   - per-index tool-call argument accumulation + best-effort JSON salvage
 *   - usage capture, bounded retry (in wire/http.ts), abort
 *
 * Invariants: exactly one `start` … one `done` per call, even on failure
 * (I2/I3). Endpoint quirks live in ModelCompat — one code path for all
 * OpenAI-compatible servers (incl. llama.cpp, whose quirks: `model` is the
 * full GGUF path, thinking models emit `reasoning_content`).
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
import { HttpError, sseStream, type SseFrame } from "./http.js";
import { isAbort } from "./abort.js";

// ───────────────────────── request building ─────────────────────────

export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** One OpenAI-wire message (assistant `content` is a string, never an array). */
export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

/**
 * Sanitize a tool-call id for the wire: alphanumerics + `-_`, ≤ 64 chars.
 * Empty → synthesized. Applied both when receiving (once) and when resending
 * (idempotent), so ids stay stable across request/response cycles.
 */
export function sanitizeCallId(id: string, fallbackIndex?: number): string {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (clean.length > 0) return clean;
  return `call_${(fallbackIndex ?? 0) + 1}_${Date.now().toString(36)}`;
}

export function convertMessages(model: ModelConfig, ctx: LlmContext): WireMessage[] {
  const compat = model.compat ?? {};
  const out: WireMessage[] = [];
  if (ctx.systemPrompt) out.push({ role: "system", content: ctx.systemPrompt });

  const msgs = ctx.messages;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      const calls = m.content.filter((b) => b.type === "toolCall");
      // Empty assistant messages (no text, no calls) are skipped — some
      // endpoints reject them.
      if (text.length === 0 && calls.length === 0) continue;
      const msg: WireMessage = { role: "assistant", content: text };
      if (calls.length > 0) {
        msg.tool_calls = calls.map((c, j) => ({
          id: sanitizeCallId(c.id, j),
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        }));
      }
      out.push(msg);
      continue;
    }
    // toolResult → OpenAI "tool" message
    out.push({
      role: "tool",
      tool_call_id: sanitizeCallId(m.toolCallId, i),
      content: m.content.map((b) => b.text).join("\n"),
    });
    // Some endpoints require an assistant turn between tools and the next
    // user message.
    const next = msgs[i + 1];
    if (compat.requiresAssistantAfterToolResult && next?.role === "user") {
      out.push({ role: "assistant", content: "" });
    }
  }
  return out;
}

/** Build the full chat/completions request body. */
export function buildParams(model: ModelConfig, ctx: LlmContext): Record<string, unknown> {
  const compat = model.compat ?? {};
  const params: Record<string, unknown> = {
    model: model.id,
    messages: convertMessages(model, ctx),
    stream: true,
  };
  if (ctx.tools.length > 0) {
    params.tools = ctx.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  params[compat.maxTokensField ?? "max_tokens"] = model.maxTokens;
  if (typeof model.temperature === "number") params.temperature = model.temperature;
  if (compat.supportsUsageInStreaming !== false) {
    params.stream_options = { include_usage: true };
  }
  if (compat.extraParams) Object.assign(params, compat.extraParams);
  return params;
}

export function completionsUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/chat/completions";
}

// ─────────────────────── tool-call arg salvage ───────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Best-effort parse of accumulated tool-call argument JSON.
 *   1. straight JSON.parse
 *   2. repair of truncation (close a dangling string, then close open
 *      braces/brackets; if still bad, drop the trailing incomplete member
 *      and retry)
 *   3. {} — the loop's `length`→fail-all guard makes salvage best-effort
 */
export function parseToolArgs(raw: string): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (isPlainObject(v)) return v;
    return {};
  } catch {
    /* fall through to salvage */
  }
  const repaired = repairTruncatedJson(raw);
  if (repaired !== undefined) {
    try {
      const v: unknown = JSON.parse(repaired);
      if (isPlainObject(v)) return v;
    } catch {
      /* keep falling back */
    }
  }
  return {};
}

/** Close a JSON string truncated mid-value/mid-key. Returns undefined if hopeless. */
function repairTruncatedJson(raw: string): string | undefined {
  const attempt = (s: string): string | undefined => {
    let inStr = false;
    let esc = false;
    const stack: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{" || c === "[") stack.push(c);
      else if (c === "}" || c === "]") stack.pop();
    }
    let out = s;
    if (inStr) out += '"';
    const trimmed = out.replace(/[\s,]+$/, "");
    if (trimmed.endsWith(":")) out = trimmed + "null";
    for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === "{" ? "}" : "]";
    return out;
  };

  const first = attempt(raw);
  if (first === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(first);
    if (isPlainObject(v)) return first;
  } catch {
    /* try dropping the trailing incomplete member */
  }
  // Find the last top-level comma and retry on the shorter prefix.
  let inStr = false;
  let esc = false;
  let lastComma = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === ",") lastComma = i;
  }
  if (lastComma > 0) {
    const second = attempt(raw.slice(0, lastComma));
    if (second !== undefined) {
      try {
        const v: unknown = JSON.parse(second);
        if (isPlainObject(v)) return second;
      } catch {
        /* give up */
      }
    }
  }
  return undefined;
}

// ──────────────────────── streaming state machine ────────────────────────

interface ToolEntry {
  id: string;
  name: string;
  raw: string;
  lastGood: Record<string, unknown>;
  block: ToolCallBlock;
}

interface Finish {
  reason: AssistantMessage["stopReason"];
  message?: string;
}

function mapUsage(u: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}): Usage {
  return {
    input: u.prompt_tokens ?? 0,
    output: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
    ...(typeof u.prompt_tokens_details?.cached_tokens === "number"
      ? { cacheRead: u.prompt_tokens_details.cached_tokens }
      : {}),
  };
}

function mapFinish(reason: string): Finish {
  switch (reason) {
    case "stop":
      return { reason: "stop" };
    case "tool_calls":
    case "function_call":
      return { reason: "toolUse" };
    case "length":
      return { reason: "length" };
    case "content_filter":
      return { reason: "error", message: "content filter triggered" };
    default:
      return { reason: "stop" };
  }
}

interface ChoiceDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface Choice {
  delta?: ChoiceDelta;
  finish_reason?: string | null;
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

/**
 * The OpenAI-compatible StreamFn.
 *
 * Usage: `streamFn = openAiStream; events = streamFn(model, ctx, { signal })`.
 * (A per-model binding can be made with `.bind(null, model)` if desired.)
 */
export const openAiStream: StreamFn = (model, ctx, opts) => {
  return (async function* (): AsyncGenerator<AssistantStreamEvent> {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      model: model.id,
      provider: model.provider,
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const tools = new Map<number, ToolEntry>();
    let finish: Finish | undefined;
    let usage: Usage | undefined;

    const snap = (): AssistantMessage => ({
      ...message,
      content: message.content.map((b) => ({ ...b })),
    });

    yield { type: "start", partial: snap() };

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

    try {
      const frames = sseStream({
        url: completionsUrl(model.baseUrl),
        body: JSON.stringify(buildParams(model, ctx)),
        apiKey: opts.apiKey ?? model.apiKey,
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
        if (isPlainObject(payload.error)) {
          const e = payload.error as Record<string, unknown>;
          finish = {
            reason: "error",
            message:
              (typeof e.message === "string" ? e.message : JSON.stringify(e)).slice(0, 1000),
          };
          break;
        }
        const u = payload.usage as
          | {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
            }
          | undefined;
        if (u) usage = mapUsage(u);
        for (const choice of (payload.choices as Choice[] | undefined) ?? []) {
          const delta = choice.delta ?? {};
          if (typeof delta.content === "string" && delta.content.length > 0) {
            appendText(delta.content);
            yield { type: "text_delta", delta: delta.content, partial: snap() };
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            appendThinking(delta.reasoning_content);
            yield { type: "thinking_delta", delta: delta.reasoning_content, partial: snap() };
          }
          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            let entry = tools.get(idx);
            if (!entry) {
              const id = tc.id ? sanitizeCallId(tc.id, idx) : sanitizeCallId("", idx);
              entry = {
                id,
                name: tc.function?.name ?? "",
                raw: "",
                lastGood: {},
                block: { type: "toolCall", id, name: tc.function?.name ?? "", arguments: {} },
              };
              tools.set(idx, entry);
              message.content.push(entry.block);
              yield {
                type: "toolcall_start",
                index: idx,
                id: entry.id,
                name: entry.name,
                partial: snap(),
              };
            } else {
              if (tc.id && entry.id.startsWith("call_") && tc.id !== entry.id) {
                entry.id = sanitizeCallId(tc.id, idx);
                entry.block.id = entry.id;
              }
              if (tc.function?.name) {
                entry.name = tc.function.name;
                entry.block.name = entry.name;
              }
            }
            const frag = tc.function?.arguments;
            if (typeof frag === "string" && frag.length > 0) {
              entry.raw += frag;
              try {
                const v: unknown = JSON.parse(entry.raw);
                if (isPlainObject(v)) entry.lastGood = v;
              } catch {
                /* mid-stream: keep last good parse */
              }
              entry.block.arguments = entry.lastGood;
              yield { type: "toolcall_delta", index: idx, argsDelta: frag, partial: snap() };
            }
          }
          if (choice.finish_reason) finish = mapFinish(choice.finish_reason);
        }
      }
      if (opts.signal.aborted) finish = { reason: "aborted" };
      else if (!finish) {
        finish = message.content.length > 0
          ? { reason: "stop" }
          : { reason: "error", message: "stream ended without finish_reason" };
      }
    } catch (err) {
      finish = isAbort(err) ? { reason: "aborted" } : { reason: "error", message: describeError(err) };
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
export async function collectStream(
  streamFn: StreamFn,
  model: ModelConfig,
  ctx: LlmContext,
  opts: { apiKey?: string; signal: AbortSignal },
): Promise<AssistantStreamEvent[]> {
  const out: AssistantStreamEvent[] = [];
  for await (const e of streamFn(model, ctx, opts)) out.push(e);
  return out;
}
