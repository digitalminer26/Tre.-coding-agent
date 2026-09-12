/**
 * WS2 — the core agent loop.
 *
 * `runLoop` consumes a StreamFn (wire layer) and Tools (tool layer), keeps
 * one `AgentMessage[]` context, and emits `AgentEvent`s: wire events pass
 * through unchanged, plus lifecycle events and tool events.
 *
 * Contract notes (docs/02-contracts.md):
 *  - I2: the in-progress assistant message lives in ONE context slot —
 *    pushed on `start`, replaced on every event — so an abort at any point
 *    leaves a consistent (possibly truncated) message in context.
 *  - I3: the loop never throws for endpoint or tool failures — they become
 *    data (stopReason "error", isError tool results). The only thing that
 *    may propagate is a StreamFn that violates its own contract (WS8's
 *    fakeStream does so ON PURPOSE to surface test-script bugs).
 *
 * Behaviors (docs/01-walkthrough-harness-llm.md §4–5):
 *  - `length` guard: a response that hit the output cap has ALL its tool
 *    calls failed with an error result instead of executed (truncated args
 *    may parse — even validate — yet be incomplete).
 *  - Tool batches run in parallel by default; if ANY tool in the batch is
 *    `executionMode: "sequential"`, the whole batch runs in call order.
 *    Results are appended to context in call order, always.
 *  - Batch `terminate`: if EVERY result carries `terminate: true`, the run
 *    stops after the batch.
 *  - `prepareNextTurn` hook between turns (WS5 auto-compaction lands here).
 */
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  ModelConfig,
  StopReason,
  StreamFn,
  Tool,
  ToolCallBlock,
  ToolResult,
  ToolResultMessage,
} from "../types.js";

/**
 * The loop's tool-execution seam. Defaults to `tool.execute` directly;
 * WS3's full pipeline (validate → beforeToolCall → execute → afterToolCall)
 * is injected here so the loop stays decoupled from the tool system.
 */
export type ExecuteToolCall = (
  tool: Tool,
  call: ToolCallBlock,
  signal: AbortSignal,
  onUpdate?: (text: string) => void,
) => Promise<ToolResult>;

export interface AgentLoopOptions {
  model: ModelConfig;
  systemPrompt: string;
  /** Context so far. Copied — the caller's array is not mutated. */
  initialMessages: AgentMessage[];
  tools: Tool[];
  streamFn: StreamFn;
  apiKey?: string;
  signal: AbortSignal;
  /** Safety cap on LLM turns. Default 32. */
  maxTurns?: number;
  /**
   * Hook between turns: return a reduced/rewritten context for the next
   * turn, or undefined to keep the current one.
   */
  prepareNextTurn?: (context: AgentMessage[], turn: number) =>
    | AgentMessage[]
    | Promise<AgentMessage[]>;
  executeToolCall?: ExecuteToolCall;
}

const DEFAULT_MAX_TURNS = 32;

const LENGTH_GUARD_TEXT =
  "Tool call arguments may be truncated: the response hit the output token " +
  "limit, so they may be incomplete. Do not rely on them — re-issue the " +
  "tool call with complete arguments.";

function resultMessage(
  call: ToolCallBlock,
  result: ToolResult,
  isError: boolean,
): ToolResultMessage {
  const content =
    result.content.length > 0
      ? result.content
      : [{ type: "text" as const, text: "(no output)" }];
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content,
    ...(isError ? { isError: true } : {}),
    ...(result.details !== undefined ? { details: result.details } : {}),
    timestamp: Date.now(),
  };
}

export async function* runLoop(
  options: AgentLoopOptions,
): AsyncGenerator<AgentEvent, void, unknown> {
  const { model, systemPrompt, tools, streamFn, apiKey, signal } = options;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const executeToolCall: ExecuteToolCall =
    options.executeToolCall ??
    ((tool, call, sig, onUpdate) =>
      tool.execute(call.id, call.arguments, sig, onUpdate));
  const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]));

  const context: AgentMessage[] = [...options.initialMessages];
  yield { type: "agent_start" };

  let turn = 0;
  let stopReason: StopReason = "aborted"; // fallback: no assistant turn ran

  while (true) {
    if (turn >= maxTurns) break;
    turn += 1;
    yield { type: "turn_start", turn };

    if (options.prepareNextTurn) {
      const next = await options.prepareNextTurn(context, turn);
      if (next !== undefined) context.splice(0, context.length, ...next);
    }

    // ── stream one assistant response into a single context slot (I2) ──
    let slot = -1;
    let message: AssistantMessage | undefined;
    for await (const event of streamFn(
      model,
      { systemPrompt, messages: context, tools },
      { apiKey, signal },
    )) {
      yield event; // wire events pass through unchanged
      if (event.type === "start") {
        context.push(event.partial);
        slot = context.length - 1;
      } else if (event.type === "done") {
        message = event.message;
      } else if (slot >= 0) {
        context[slot] = event.partial; // I2: replace the SAME slot
      }
    }
    if (message !== undefined && slot >= 0) context[slot] = message;

    yield { type: "turn_end", turn };
    if (message === undefined) break; // StreamFn contract violation — keep what we have
    stopReason = message.stopReason;

    if (message.stopReason === "error" || message.stopReason === "aborted") break;

    const calls = message.content.filter((b): b is ToolCallBlock => b.type === "toolCall");
    if (calls.length === 0) break; // normal stop — or length with nothing to retry

    // §4.1 guard: truncated args may parse yet be incomplete — never execute.
    if (message.stopReason === "length") {
      for (const call of calls) {
        yield { type: "tool_execution_start", toolCall: call };
      }
      for (const call of calls) {
        const msg = resultMessage(
          call,
          { content: [{ type: "text", text: LENGTH_GUARD_TEXT }] },
          true,
        );
        context.push(msg);
        yield { type: "tool_execution_end", toolCallId: call.id, result: msg };
      }
      continue; // the model re-issues on the next turn
    }

    const sequential = calls.some(
      (c) => byName.get(c.name)?.executionMode === "sequential",
    );

    for (const call of calls) {
      yield { type: "tool_execution_start", toolCall: call };
    }

    const results = new Map<string, { result: ToolResult; isError: boolean }>();
    const updates = new Map<string, string[]>();
    const runOne = async (call: ToolCallBlock): Promise<void> => {
      const tool = byName.get(call.name);
      if (!tool) {
        results.set(call.id, {
          result: {
            content: [{ type: "text", text: `Tool "${call.name}" not found.` }],
          },
          isError: true,
        });
        return;
      }
      try {
        const result = await executeToolCall(tool, call, signal, (text) => {
          const list = updates.get(call.id) ?? [];
          list.push(text);
          updates.set(call.id, list);
        });
        results.set(call.id, {
          result:
            result ?? { content: [{ type: "text", text: "(no output)" }] },
          isError: false,
        });
      } catch (err) {
        // A tool violating I3 (throwing) must not kill the run.
        results.set(call.id, {
          result: {
            content: [
              {
                type: "text",
                text: `Tool "${call.name}" threw: ${
                  err instanceof Error ? err.stack ?? err.message : String(err)
                }`,
              },
            ],
          },
          isError: true,
        });
      }
    };

    if (sequential) {
      for (const call of calls) await runOne(call);
    } else {
      await Promise.all(calls.map((call) => runOne(call)));
    }

    // Results (and their end events) always land in call order.
    let allTerminate = true;
    for (const call of calls) {
      const entry = results.get(call.id);
      const msg = resultMessage(
        call,
        entry?.result ?? { content: [{ type: "text", text: "(no result)" }] },
        entry?.isError ?? true,
      );
      context.push(msg);
      for (const text of updates.get(call.id) ?? []) {
        yield { type: "tool_execution_update", toolCallId: call.id, text };
      }
      yield { type: "tool_execution_end", toolCallId: call.id, result: msg };
      if (!entry?.result.terminate) allTerminate = false;
    }
    if (allTerminate) break;
    if (signal.aborted) {
      stopReason = "aborted";
      break;
    }
  }

  yield { type: "agent_end", stopReason, messages: context };
}
