/**
 * WS8 — in-process scripted StreamFn for pure loop tests (no network).
 *
 * `fakeStream(turns)` returns a `StreamFn` (src/types.ts contract) that, on its
 * Nth call, plays back `turns[N-1]` as a legal `AssistantStreamEvent` sequence:
 * `start` first, `done` last, and EVERY event carries the full cumulative
 * in-progress assistant message (contract invariant I2).
 *
 * Tool-call arguments are serialized to JSON and emitted as `argsDelta`
 * fragments split mid-token, exactly as a real SSE stream delivers them; the
 * partial's `arguments` are best-effort parsed (last successful parse wins).
 *
 * The fake also honors a real `AbortSignal`: if the caller aborts mid-turn the
 * stream stops and ends with `done` / stopReason "aborted" (I3: never throws
 * out of the stream).
 */
import type {
  AgentMessage,
  AssistantMessage,
  AssistantStreamEvent,
  ModelConfig,
  StreamFn,
  TextBlock,
  Tool,
  ToolCallBlock,
  Usage,
} from "../src/types.js";

export interface FakeToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export type FakeTurn =
  | { type: "text"; text: string; usage?: Usage }
  | { type: "thinking"; thinking: string; text?: string }
  | {
      type: "toolcall";
      calls: FakeToolCall[];
      /** Optional text emitted alongside the tool calls. */
      text?: string;
      usage?: Usage;
    }
  | { type: "error"; message: string }
  | { type: "aborted" }
  | {
      type: "length";
      /** Turn truncated by the output cap; call args may be cut mid-JSON. */
      text?: string;
      calls?: FakeToolCall[];
      usage?: Usage;
    };

const DEFAULT_MODEL: ModelConfig = {
  id: "fake-model",
  provider: "fake",
  baseUrl: "http://fake.invalid/v1",
  api: "openai-completions",
  contextWindow: 32000,
  maxTokens: 4096,
};

function baseMessage(model: ModelConfig, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    model: model.id,
    provider: model.provider,
    stopReason: "stop",
    timestamp,
  };
}

/** Split a string into `n` chunks (n<=1 → the whole string). */
function chunk(s: string, n: number): string[] {
  if (n <= 1 || s.length === 0) return [s];
  const size = Math.ceil(s.length / n);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** Best-effort JSON parse — returns the parsed object or {} (mid-stream). */
function salvageParse(raw: string): Record<string, unknown> {
  if (raw.length === 0) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    /* mid-stream fragment: expected */
  }
  return {};
}

async function* playTurn(
  turn: FakeTurn,
  model: ModelConfig,
  signal: AbortSignal,
): AsyncGenerator<AssistantStreamEvent> {
  const partial = baseMessage(model, Date.now());
  let stopReason: AssistantMessage["stopReason"] = "stop";
  let aborted = false;

  /**
   * Snapshot for I2: every event carries its own copy of the in-progress
   * message, so earlier events keep the state they had at emission time
   * (text blocks are mutated in place while streaming).
   */
  const snap = (): AssistantMessage => ({
    ...partial,
    content: partial.content.map((b) => ({ ...b })),
  });

  yield { type: "start", partial: snap() };

  const pushText = (delta: string): AssistantStreamEvent => {
    const block = partial.content.find((b): b is TextBlock => b.type === "text");
    if (block) block.text += delta;
    else partial.content.push({ type: "text", text: delta });
    return { type: "text_delta", delta, partial: snap() };
  };

  /** Build (not yield) the delta events for a piece of text. */
  const buildTextDeltas = (text: string, n: number): AssistantStreamEvent[] =>
    chunk(text, n).map(pushText);

  /** Build the start/delta events for a batch of tool calls. */
  const buildCallEvents = (calls: FakeToolCall[]): AssistantStreamEvent[] => {
    const out: AssistantStreamEvent[] = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      const id = call.id ?? `call_${i + 1}`;
      const block: ToolCallBlock = { type: "toolCall", id, name: call.name, arguments: {} };
      partial.content.push(block);
      out.push({
        type: "toolcall_start",
        index: i,
        id,
        name: call.name,
        partial: snap(),
      });
      const raw = JSON.stringify(call.args ?? {});
      let emitted = 0;
      for (const d of chunk(raw, Math.max(2, Math.ceil(raw.length / 12)))) {
        emitted += d.length;
        // The partial tracks the last successfully-parsed prefix (I2 best-effort).
        block.arguments = salvageParse(raw.slice(0, emitted));
        out.push({ type: "toolcall_delta", index: i, argsDelta: d, partial: snap() });
      }
    }
    return out;
  };

  /** Yield pre-built events, honoring the abort signal between them. */
  async function* emit(events: AssistantStreamEvent[]): AsyncGenerator<AssistantStreamEvent> {
    for (const e of events) {
      if (signal.aborted) {
        aborted = true;
        return;
      }
      yield e;
    }
  }

  switch (turn.type) {
    case "text": {
      yield* emit(buildTextDeltas(turn.text, 3));
      partial.usage = turn.usage;
      break;
    }
    case "thinking": {
      const tBlock = { type: "thinking" as const, thinking: "" };
      partial.content.push(tBlock);
      const thinkEvents: AssistantStreamEvent[] = [];
      for (const d of chunk(turn.thinking, 2)) {
        tBlock.thinking += d;
        thinkEvents.push({ type: "thinking_delta", delta: d, partial });
      }
      yield* emit(thinkEvents);
      if (turn.text && !aborted) yield* emit(buildTextDeltas(turn.text, 2));
      break;
    }
    case "toolcall": {
      if (turn.text) yield* emit(buildTextDeltas(turn.text, 2));
      yield* emit(buildCallEvents(turn.calls));
      stopReason = "toolUse";
      partial.usage = turn.usage;
      break;
    }
    case "length": {
      if (turn.text) yield* emit(buildTextDeltas(turn.text, 2));
      if (turn.calls) yield* emit(buildCallEvents(turn.calls));
      stopReason = "length";
      partial.usage = turn.usage;
      break;
    }
    case "error": {
      stopReason = "error";
      break;
    }
    case "aborted": {
      stopReason = "aborted";
      break;
    }
  }

  if (aborted) stopReason = "aborted";
  const done: AssistantMessage = { ...snap(), stopReason };
  if (turn.type === "error") done.errorMessage = turn.message;
  yield { type: "done", message: done };
}

export function fakeStream(turns: FakeTurn[], opts?: { model?: ModelConfig }): StreamFn {
  const model = opts?.model ?? DEFAULT_MODEL;
  let call = 0;
  return (_m, _ctx, o): AsyncIterable<AssistantStreamEvent> => {
    const turn = turns[call];
    if (turn === undefined) {
      throw new Error(
        `fakeStream: script exhausted after ${turns.length} turn(s) — call ${call + 1} has no scripted turn`,
      );
    }
    call += 1;
    return playTurn(turn, model, o.signal);
  };
}

/** Collect a StreamFn's full event stream (test helper). */
export async function collectEvents(
  streamFn: StreamFn,
  model: ModelConfig,
  ctx: {
    systemPrompt?: string;
    messages?: AgentMessage[];
    tools?: Tool[];
  } = {},
  signal?: AbortSignal,
): Promise<AssistantStreamEvent[]> {
  const events: AssistantStreamEvent[] = [];
  for await (const e of streamFn(
    model,
    {
      systemPrompt: ctx.systemPrompt ?? "",
      messages: ctx.messages ?? [],
      tools: ctx.tools ?? [],
    },
    { signal: signal ?? new AbortController().signal },
  )) {
    events.push(e);
  }
  return events;
}
