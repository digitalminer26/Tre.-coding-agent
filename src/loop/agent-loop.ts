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
 *    may parse — even validate — yet be incomplete). A `length` stop with
 *    NO tool calls (the reply died mid text/thinking) retries once with a
 *    nudge — the partial stays in context — so one over-long reply cannot
 *    kill a run; a second `length` with no calls stops.
 *  - Tool batches run in parallel by default; if ANY tool in the batch is
 *    `executionMode: "sequential"`, the whole batch runs in call order.
 *    Results are appended to context in call order, always.
 *  - Batch `terminate`: if EVERY result carries `terminate: true`, the run
 *    stops after the batch.
 *  - `prepareNextTurn` hook between turns (WS5 auto-compaction lands here).
 *  - Turn cap (C24, refined by C26): the turn budget is ALWAYS on —
 *    `maxTurns` defaults to `deriveMaxTurns(model.contextWindow,
 *    model.maxTokens)` (hundreds of turns for a 200k/8k model); an
 *    explicit value overrides. C26 makes the cap per-CYCLE: when it is hit,
 *    the loop injects a continuation nudge ("you're out of this cycle's
 *    budget — summarize if done, else keep working") and resets the counter,
 *    up to `maxContinuations` times (default 3 → 4 cycles). A genuinely
 *    stuck model is caught by LOOP DETECTION instead of a count: the same
 *    tool-call batch signature issued 3 times in a row is NOT executed on
 *    the third repeat, and the run stops with stopReason "loop".
 */
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  ExecuteToolCall,
  ModelConfig,
  StopReason,
  StreamFn,
  Tool,
  ToolCallBlock,
  ToolResult,
  ToolResultMessage,
} from "../types.js";

// The seam type lives in types.ts (contract home) so the tools layer can
// implement it without depending on the loop layer. Re-exported for
// compatibility with the WS2-era location.
export type { ExecuteToolCall } from "../types.js";

export interface AgentLoopOptions {
  model: ModelConfig;
  systemPrompt: string;
  /** Context so far. Copied — the caller's array is not mutated. */
  initialMessages: AgentMessage[];
  tools: Tool[];
  streamFn: StreamFn;
  apiKey?: string;
  signal: AbortSignal;
  /**
   * Safety cap on LLM turns (the runaway-loop guard). Always on: when
   * omitted, it is DERIVED from the model's window/output cap via
   * `deriveMaxTurns` — the guard is never disabled, only resized. An
   * explicit value (e.g. `--max-turns N`) overrides the derivation,
   * smaller or larger.
   */
  maxTurns?: number;
  /**
   * C26 — how many times the loop auto-continues after a cycle's turn
   * budget is exhausted (each continuation resets the counter). Default 3
   * (4 cycles total). 0 restores the old behavior: the run stops at the
   * first budget hit. The real runaway protection is loop detection
   * (3 identical batches in a row), not this count.
   */
  maxContinuations?: number;
  /**
   * Hook between turns: return a reduced/rewritten context for the next
   * turn, or undefined to keep the current one.
   */
  prepareNextTurn?: (context: AgentMessage[], turn: number) =>
    | AgentMessage[]
    | undefined
    | Promise<AgentMessage[] | undefined>;
  executeToolCall?: ExecuteToolCall;
}

/**
 * C24 — derive the runaway-loop turn cap from the model's contextWindow and
 * maxTokens (the same two parameters auto-compaction keys off, WS9).
 *
 * Formula:  maxTurns = clamp( floor( (contextWindow / maxTokens) * 10 ), 64, 4096 )
 *
 * Rationale:
 *  - contextWindow / maxTokens is "how many full responses (each up to
 *    maxTokens) fit in this model's window" — a natural capability scale that
 *    grows with the window and shrinks as the output cap grows (a model that
 *    emits more per turn needs fewer turns for the same job).
 *  - The cap is a RUNAWAY guard, not a context budget: compaction (WS9) keeps
 *    the running context bounded, so a legitimate multi-step job's length is
 *    NOT limited by the window — the cap only has to be large enough that no
 *    real job ever hits it, and small enough that a genuinely stuck loop
 *    (zero progress) still dies in bounded time.
 *  - The ×10 multiplier is what makes it "ample": it gives a 200k-window /
 *    8k-output model 200000/8000 × 10 = 250 turns — hundreds of turns of
 *    runway, comfortably above any realistic legitimate job, while a truly
 *    stuck loop still terminates after 250 calls. Smaller models scale down
 *    (80k/16k → 50, floored to 64; 32k/4k → 80); the floor/ceiling keep
 *    degenerate configs (tiny window, huge output cap) sane.
 *  - Floor 64: even a small window must allow a real job to run (the old
 *    hardcoded default was 32 — this floor is strictly more generous).
 *    Ceiling 4096: a stuck loop must still terminate in bounded time.
 *
 * The cap stays ON all the time — this only sizes it; an explicit `maxTurns`
 * option (or `--max-turns N`) overrides the derivation, smaller or larger.
 */
export function deriveMaxTurns(contextWindow: number, maxTokens: number): number {
  const ratio =
    maxTokens > 0 ? (contextWindow / maxTokens) * 10 : Number.POSITIVE_INFINITY;
  const turns = Math.floor(ratio);
  return Math.min(4096, Math.max(64, Number.isFinite(turns) ? turns : 4096));
}

const LENGTH_GUARD_TEXT =
  "Tool call arguments may be truncated: the response hit the output token " +
  "limit, so they may be incomplete. Do not rely on them — re-issue the " +
  "tool call with complete arguments.";

// C22 — a `length` stop with no tool calls means the reply died inside
// text/thinking: nothing to salvage as a call. One nudge lets the model
// re-issue the work in smaller pieces; a second `length` with no calls
// stops the run (stopReason "length", as before).
const LENGTH_NUDGE_TEXT =
  "Your previous response hit the output token limit before any tool call. " +
  "Continue from where it stopped — re-issue the work in smaller pieces (for " +
  "example, split a large file write across several smaller calls) so each " +
  "response fits under the limit.";

// C26 — injected when a cycle's turn budget is exhausted. The run does NOT
// stop: the counter resets and the model is told to either finish (text
// only, no tools) or keep working. This replaces the old hard stop that
// forced the user to resend a prompt mid-job.
export const BUDGET_CONTINUE_TEXT =
  "Cycle turn budget exhausted — the run continues automatically. " +
  "If the task is complete, reply with a final summary and do NOT call any " +
  "more tools. Otherwise keep working: briefly state what remains, then make " +
  "your next tool call.";

// C26 — loop detection: the same tool-call batch (same tools, same
// arguments, same order) issued 3 times in a row. The third repeat is a
// runaway-loop signature (a model stuck re-issuing identical work), so it
// is NOT executed and the run stops with stopReason "loop". Two identical
// batches are still allowed (legitimate retries exist).
export const LOOP_GUARD_TEXT =
  "Runaway loop detected: the same tool call(s) were issued 3 times in a " +
  "row. This repeat was not executed. Change your approach — re-read the " +
  "latest results, pick a different action, or finish with a text-only " +
  "response explaining the situation.";

/**
 * C26 — the identity of one tool-call batch: tool names + stable-JSON
 * arguments, in call order. Two batches are "the same" iff their
 * signatures match. Exported for tests.
 */
export function batchSignature(calls: ToolCallBlock[]): string {
  return calls.map((c) => `${c.name}:${stableJson(c.arguments)}`).join("\u0000");
}

/** Deep JSON.stringify with sorted object keys (argument identity that
 *  does not depend on key order). */
function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sort((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

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
  // C24: the runaway-loop guard is always on. An explicit maxTurns wins;
  // otherwise the cap is DERIVED from the model's window/output cap — never
  // a hardcoded constant, so the guard is session-independent (like
  // auto-compaction, WS9).
  const maxTurns = options.maxTurns ?? deriveMaxTurns(model.contextWindow, model.maxTokens);
  const executeToolCall: ExecuteToolCall =
    options.executeToolCall ??
    ((tool, call, sig, onUpdate) =>
      tool.execute(call.id, call.arguments, sig, onUpdate));
  const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]));

  const context: AgentMessage[] = [...options.initialMessages];
  yield { type: "agent_start" };

  let turn = 0;
  let stopReason: StopReason = "aborted"; // fallback: no assistant turn ran
  let lengthNudged = false; // C22: the one retry for a no-call `length` stop
  // C26 — cycle bookkeeping: the budget is per-cycle, not per-run.
  const maxContinuations =
    options.maxContinuations !== undefined
      ? options.maxContinuations
      : DEFAULT_MAX_CONTINUATIONS;
  const maxCycles = maxContinuations + 1;
  let cycleStart = 0; // turn at which the current cycle began
  let continuations = 0;
  // C26 — loop detection: signatures of the last two issued batches.
  let sigHistory: string[] = [];

  while (true) {
    if (turn - cycleStart >= maxTurns) {
      // Budget hit. C26: the cap is a CYCLE trigger, not a hard stop —
      // nudge + reset, up to maxContinuations times. Only when every
      // continuation is spent does the run stop (stopReason "budget",
      // resumable, as before).
      if (continuations >= maxContinuations) {
        stopReason = "budget";
        break;
      }
      continuations += 1;
      cycleStart = turn;
      lengthNudged = false; // the no-call length retry is per-cycle
      context.push({ role: "user", content: BUDGET_CONTINUE_TEXT, timestamp: Date.now() });
      yield {
        type: "turn_budget",
        turn,
        cycle: continuations,
        maxCycles,
        maxTurns,
      };
      continue; // the nudge consumes no turn (it is not an LLM call)
    }
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
    if (calls.length === 0) {
      if (
        message.stopReason === "length" &&
        !lengthNudged &&
        turn - cycleStart < maxTurns
      ) {
        // C22: no tool call to salvage — retry once. The partial is already
        // in context (I2: pushed on start, replaced on done), so the model
        // sees exactly where it stopped.
        lengthNudged = true;
        context.push({
          role: "user",
          content: LENGTH_NUDGE_TEXT,
          timestamp: Date.now(),
        });
        continue; // consumes a turn like any other (maxTurns still caps)
      }
      break; // normal stop — or length with the nudge already spent
    }

    // C26 loop detection: the same batch 3× in a row is a runaway loop.
    // The third repeat is failed in-band (I3: every call still gets a
    // result) and NOT executed, then the run stops with stopReason "loop".
    const signature = batchSignature(calls);
    {
      const n = sigHistory.length;
      if (
        n >= 2 &&
        sigHistory[n - 1] === signature &&
        sigHistory[n - 2] === signature
      ) {
        for (const call of calls) {
          yield { type: "tool_execution_start", toolCall: call };
        }
        for (const call of calls) {
          const msg = resultMessage(
            call,
            { content: [{ type: "text", text: LOOP_GUARD_TEXT }] },
            true,
          );
          context.push(msg);
          yield { type: "tool_execution_end", toolCallId: call.id, result: msg };
        }
        stopReason = "loop";
        break;
      }
    }
    sigHistory = [...sigHistory.slice(-1), signature];

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
          // D7: the pipeline reports failures in-band (I3); a throw here is
          // an I3 violation (broken tool) and is marked isError in the catch.
          isError: result?.isError === true,
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

  yield {
    type: "agent_end",
    stopReason,
    messages: context,
    ...(stopReason === "budget" ? { maxTurns, maxCycles } : {}),
  };
}

/** C26 — default auto-continuations per run (4 cycles total). */
export const DEFAULT_MAX_CONTINUATIONS = 3;
