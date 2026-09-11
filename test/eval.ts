/**
 * WS8 — eval harness: scores tool-call correctness of a model (via any
 * StreamFn) on a small task suite.
 *
 * `runEval({ streamFn, model, tasks })` sends each task prompt once, inspects
 * the toolCall blocks of the first assistant message, and scores them against
 * the expected tool name + argument subset. The real wire StreamFn is plugged
 * in by a later workstream (WS1/WS6) — this module only depends on the WS0
 * contracts, so it is fully testable with fake-stream.
 */
import { isDeepStrictEqual } from "node:util";
import type {
  AssistantMessage,
  ModelConfig,
  StreamFn,
  Tool,
  ToolCallBlock,
} from "../src/types.js";

export interface EvalTask {
  name: string;
  prompt: string;
  /** Tools the model may call for this task. */
  tools: Tool[];
  expected: {
    toolName: string;
    /** Each key must deep-equal the matching key of the emitted call's args. */
    argsSubset?: Record<string, unknown>;
  };
}

export interface EvalResult {
  task: string;
  pass: boolean;
  /** Human-readable verdict, e.g. "no tool call emitted". */
  reason: string;
  /** Tool calls the model actually emitted (name + parsed args). */
  calls: { name: string; args: Record<string, unknown> }[];
}

export interface EvalOptions {
  streamFn: StreamFn;
  model: ModelConfig;
  tasks: EvalTask[];
  systemPrompt?: string;
  signal?: AbortSignal;
}

/** Run one LLM call and return the final assistant message (or undefined). */
async function callOnce(
  streamFn: StreamFn,
  model: ModelConfig,
  task: EvalTask,
  systemPrompt: string,
  signal: AbortSignal,
): Promise<AssistantMessage | undefined> {
  let message: AssistantMessage | undefined;
  for await (const e of streamFn(
    model,
    {
      systemPrompt,
      messages: [{ role: "user", content: task.prompt, timestamp: Date.now() }],
      tools: task.tools,
    },
    { signal },
  )) {
    if (e.type === "done") message = e.message;
  }
  return message;
}

function scoreTask(task: EvalTask, message: AssistantMessage | undefined): EvalResult {
  const calls =
    message !== undefined
      ? message.content
          .filter((b): b is ToolCallBlock => b.type === "toolCall")
          .map((b) => ({ name: b.name, args: b.arguments }))
      : [];

  const result: EvalResult = { task: task.name, pass: false, reason: "", calls };

  if (message !== undefined && message.stopReason === "error") {
    result.reason = `stream error: ${message.errorMessage ?? "unknown"}`;
    return result;
  }
  if (calls.length === 0) {
    result.reason = "no tool call emitted";
    return result;
  }

  // Score against the FIRST emitted tool call.
  const first = calls[0]!;
  if (first.name !== task.expected.toolName) {
    result.reason = `wrong tool: expected "${task.expected.toolName}", got "${first.name}"`;
    return result;
  }
  for (const [k, v] of Object.entries(task.expected.argsSubset ?? {})) {
    if (!isDeepStrictEqual(first.args[k], v)) {
      result.reason = `arg "${k}" mismatch: expected ${JSON.stringify(v)}, got ${JSON.stringify(first.args[k])}`;
      return result;
    }
  }
  result.pass = true;
  result.reason = "ok";
  return result;
}

export async function runEval(opts: EvalOptions): Promise<EvalResult[]> {
  const { streamFn, model, tasks, signal = new AbortController().signal } = opts;
  const systemPrompt =
    opts.systemPrompt ??
    "You are a coding agent. Use tools to accomplish the task.";
  const results: EvalResult[] = [];
  for (const task of tasks) {
    if (signal.aborted) break;
    const message = await callOnce(streamFn, model, task, systemPrompt, signal);
    results.push(scoreTask(task, message));
  }
  return results;
}

/** Printable per-task pass/fail table. */
export function formatEvalReport(results: EvalResult[]): string {
  const width = Math.max(8, ...results.map((r) => r.task.length + 2));
  const rule = Math.max(width + 12, 40);
  const lines: string[] = ["EVAL REPORT", "-".repeat(rule)];
  for (const r of results) {
    lines.push(`${r.task.padEnd(width)} ${r.pass ? "PASS" : "FAIL"}  ${r.reason}`);
  }
  lines.push("-".repeat(rule));
  lines.push(`${results.filter((r) => r.pass).length}/${results.length} passed`);
  return lines.join("\n");
}
