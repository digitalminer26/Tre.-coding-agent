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

// ────────────────────────── stall detection (2026-09-27) ──────────────────────
//
// The kernel sandbox makes some operations fail with "Operation not
// permitted" (EPERM): bash reading system files, writing system dirs, and
// git push over ssh (~/.ssh is read-denied). The file tools (read/write/
// edit) fail the same way on denied paths. The failure is DETERMINISTIC —
// the same operation fails identically forever — but the tool result does
// not say so, so a model that doesn't recognize the signature keeps
// retrying, and only the loop's 3-identical-batch guard eventually stops
// it — and only when the retries are byte-identical. A model that
// REPHRASES the command each time (`git push` → `git push origin main` →
// `git push --set-upstream …`) defeats that guard: every batch is "new".
//
// The stall guard closes that hole: it keys on the TOOL, not the
// arguments. The same tool failing 3 times in a row with a permission
// signature (arguments may vary — rephrasing is exactly the stall
// pattern) is a model banging on the sandbox boundary. The third failure
// is replaced in-band with STALL_TEXT (I3: every call gets a result) and
// the run stops with stopReason "stall" (the loop maps the `stall` detail
// onto it). The call WAS executed — a permission denial is a harmless
// no-op — so a legitimate third operation that SUCCEEDS never trips the
// guard.
//
// Only failures that carry a permission signature count: a transient
// failure (non-zero exit, timeout, network blip) is a legitimate retry —
// the signature filter keeps the guard from eating normal retry behavior.
// A DIFFERENT tool or a SUCCESS resets the count.
//
// The two guards are complementary: byte-identical retries are caught by
// the loop guard (pre-execution, stopReason "loop"); rephrased retries
// are caught here (stopReason "stall").

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

/** Permission-denial signatures in tool error text (case-insensitive).
 *  Covers the kernel-sandbox EPERM spellings (bash + file tools) and the
 *  classic EACCES/EPERM messages. Exported for tests. */
export const STALL_PERMISSION_PATTERNS: RegExp[] = [
  /operation not permitted/i,
  /permission denied/i,
  /eacces/i,
  /eperm/i,
];

/** True when a failed tool result looks like a deterministic
 *  permission/sandbox denial (the kind of failure that repeats forever). */
export function isPermissionStallText(texts: string[]): boolean {
  return texts.some((t) => STALL_PERMISSION_PATTERNS.some((re) => re.test(t)));
}

/**
 * The stall guard's in-band answer: the tool has now failed 3 times in a
 * row with a permission denial, so this call is NOT executed and the run
 * stops with stopReason "stall" (the loop maps the `stall` detail onto it).
 * The model is told the failure is deterministic, what to do instead, and
 * how the user can lift the boundary (--no-sandbox for system-maintenance
 * work).
 */
export function stallText(toolName: string): string {
  return (
    `This call was NOT executed: the "${toolName}" tool has now failed 3 ` +
    "times in a row with a permission denial (Operation not permitted / " +
    "permission denied). That failure is deterministic — the sandbox " +
    "boundary will not move, so rephrasing or retrying the same operation " +
    "will not help, and the run stops here (stopReason 'stall'). Change " +
    "approach: use a different tool or a target INSIDE the workspace (a " +
    "path the sandbox allows), or finish with a text-only reply explaining " +
    "the blocked step. If the task genuinely requires system-level access " +
    "(e.g. git push over ssh, which needs ~/.ssh), tell the user to re-run " +
    "with --no-sandbox."
  );
}

/**
 * Build the loop's `executeToolCall` from the pipeline. `tools` is only used
 * for descriptive error text; the loop has already resolved the tool.
 *
 * The executor carries the stall guard's state (per executor instance — the
 * CLI builds one per run, so it is per-run like the loop's batch history):
 * the last failed call's identity (tool name + stable-JSON args) and how
 * many consecutive times it failed with a permission signature.
 */
export function makeToolExecutor(hooks: ToolPipelineHooks = {}): ExecuteToolCall {
  // Stall-guard state (see the module header): the tool that is currently
  // stalling (keyed on TOOL NAME — rephrased arguments must not reset the
  // chain) and how many consecutive permission failures it has had.
  let lastFailTool: string | undefined;
  let failCount = 0;
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
    //    net for tools that violate the contract (kept in-band: a thrown
    //    tool is a broken tool, and its failure must still feed the
    //    stall guard below).
    let result: ToolResult;
    try {
      result = (await tool.execute(call.id, args, signal, onUpdate)) ?? {
        content: [],
      };
    } catch (err) {
      result = {
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

    // 5. stall guard — the same tool failing 3 times in a row with a
    //    permission signature is a model banging on the sandbox boundary
    //    (arguments may vary — rephrasing is exactly the stall pattern).
    //    The count is per TOOL, not per argument: rephrasing must not
    //    reset it. The third failure is replaced in-band with STALL_TEXT
    //    (I3: every call gets a result) + details.stall; the loop maps
    //    that detail onto stopReason "stall" and stops. The call WAS
    //    executed (a permission denial is a harmless no-op), so a
    //    legitimate third operation that SUCCEEDS never trips the guard —
    //    a success resets the count, as does any non-permission failure
    //    (transient errors are normal retries).
    if (result.isError === true) {
      const permission = isPermissionStallText(
        result.content.map((c) => c.text),
      );
      if (permission) {
        if (tool.name === lastFailTool) {
          failCount += 1;
        } else {
          lastFailTool = tool.name;
          failCount = 1;
        }
        if (failCount >= 3) {
          return {
            content: text(stallText(tool.name)),
            isError: true,
            details: { stall: true },
          };
        }
      } else {
        // Not a permission failure — it may be transient. Reset.
        lastFailTool = undefined;
        failCount = 0;
      }
    } else {
      lastFailTool = undefined;
      failCount = 0;
    }

    return result;
  };
}
