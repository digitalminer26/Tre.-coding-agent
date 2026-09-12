/**
 * WS3 — the tool execution pipeline (docs/01 §5), built as the loop's
 * `ExecuteToolCall` seam so the loop stays decoupled from the tool system.
 *
 * Per call (after the loop's lookup — unknown tools are handled there):
 *   1. validate args against the tool's JSON schema
 *   2. beforeToolCall hook — may rewrite args or BLOCK (this is WS7's
 *      approval/permission seam; the block reason goes back to the LLM)
 *   3. execute with AbortSignal + partial-update callback
 *   4. afterToolCall hook — may rewrite the result (redaction, annotation)
 *
 * I3: this never throws. Every failure path returns a ToolResult with
 * `isError: true` whose text the model reads (D7).
 */
import type {
  ExecuteToolCall,
  Tool,
  ToolCallBlock,
  ToolResult,
} from "../types.js";
import { validateArgs } from "./validate.js";

/** beforeToolCall: return undefined (allow, args unchanged), a rewritten
 *  args object (allow with new args), or a block decision. */
export type BeforeToolCall = (
  tool: Tool,
  call: ToolCallBlock,
) =>
  | { args?: Record<string, unknown> }
  | { blocked: string }
  | undefined
  | Promise<{ args?: Record<string, unknown> } | { blocked: string } | undefined>;

/** afterToolCall: return undefined (keep result) or a replacement result. */
export type AfterToolCall = (
  tool: Tool,
  call: ToolCallBlock,
  result: ToolResult,
) => ToolResult | undefined | Promise<ToolResult | undefined>;

export interface ToolPipelineHooks {
  beforeToolCall?: BeforeToolCall;
  afterToolCall?: AfterToolCall;
}

const text = (t: string) => [{ type: "text" as const, text: t }];

/**
 * Build the loop's `executeToolCall` from the pipeline. `tools` is only used
 * for descriptive error text; the loop has already resolved the tool.
 */
export function makeToolExecutor(hooks: ToolPipelineHooks = {}): ExecuteToolCall {
  return async (tool, call, signal, onUpdate) => {
    // 1. validate — malformed args never reach the tool.
    const validationError = validateArgs(tool.parameters, call.arguments);
    if (validationError !== undefined) {
      return {
        content: text(`Invalid arguments for "${tool.name}": ${validationError}`),
        isError: true,
      };
    }

    let args: Record<string, unknown> = call.arguments;

    // 2. beforeToolCall — the approval/permission seam (WS7).
    if (hooks.beforeToolCall) {
      let decision;
      try {
        decision = await hooks.beforeToolCall(tool, call);
      } catch (err) {
        // A broken hook must not kill the run (I3) — fail the call.
        return {
          content: text(
            `beforeToolCall hook failed for "${tool.name}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
          isError: true,
        };
      }
      if (decision && "blocked" in decision) {
        return {
          content: text(`Tool "${tool.name}" was blocked: ${decision.blocked}`),
          isError: true,
        };
      }
      if (decision?.args) args = decision.args;
    }

    // 3. execute — tools return errors in-band (I3); the catch is a safety
    //    net for tools that violate the contract.
    let result: ToolResult;
    try {
      result = (await tool.execute(call.id, args, signal, onUpdate)) ?? {
        content: [],
      };
    } catch (err) {
      return {
        content: text(
          `Tool "${tool.name}" threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
        isError: true,
      };
    }

    // 4. afterToolCall — may rewrite the result.
    if (hooks.afterToolCall) {
      try {
        const replacement = await hooks.afterToolCall(tool, call, result);
        if (replacement) result = replacement;
      } catch {
        // A broken hook never changes the outcome — keep the tool's result.
      }
    }

    return result;
  };
}
