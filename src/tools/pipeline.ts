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
 * L2: structure adapted from @earendil-works/pi-agent-core 0.85.1 (MIT,
 *      © Mario Zechner) — the per-call pipeline: validate →
 *      beforeToolCall (rewrite or block) → execute(signal, onUpdate) →
 *      afterToolCall, errors never leave as exceptions (docs/01 §5, §9).
 *      Simplified: no prepareArguments step.
 *      Added: the stall guard (permission-denial failures of one tool
 *      within its recent window stop the run; 2026-09-27, windowed per
 *      docs/08 H1 2026-09-30; H2 identical non-permission failures are
 *      also stopped by strict tool/args/error matching).
 *
 * I3: this never throws. Every failure path returns a ToolResult with
 * `isError: true` whose text the model reads (D7).
 */
import { resolve } from "node:path";
import type {
  ExecuteToolCall,
  GuardEvidence,
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
// arguments. The same tool failing 3 times with a permission signature
// within its recent calls (arguments may vary — rephrasing is exactly
// the stall pattern) is a model banging on the sandbox boundary. The
// failing call is replaced in-band with STALL_TEXT (I3: every call gets
// a result) and the run stops with stopReason "stall" (the loop maps the
// `stall` detail onto it). The call WAS executed — a permission denial
// is a harmless no-op.
//
// WINDOWED (docs/08 H1, 2026-09-30): the count is "how many permission
// failures of this tool within its last STALL_WINDOW (8) calls", NOT
// "how many in a row". A model PROBEING the boundary interleaves
// legitimate successful calls with the denied ones (`ls dir` denied,
// `ls other` ok, `ls dir` denied, …) — consecutive counting never reaches
// 3, and the loop burns the whole turn budget (the 2026-09-30 WIP
// session: the same directory displayed over and over). A success or a
// non-permission failure no longer resets the count; it occupies a slot
// in the window, and the window sliding past a failure drops it (a stale
// denial 8+ calls ago must not stall a fresh retry). Each tool has its
// OWN count + window — a different tool never inherits or resets it.
//
// Only failures that carry a permission signature count: a transient
// failure (non-zero exit, timeout, network blip) is a legitimate retry —
// the signature filter keeps the guard from eating normal retry behavior.
//
// The two guards are complementary: byte-identical retries are caught by
// the loop guard (pre-execution, stopReason "loop"); rephrased or
// interleaved retries are caught here (stopReason "stall").

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

/** afterToolCall: return undefined (keep result) or a replacement result.
 *  F1 (docs/08 §9): a replacement may DROP `details`, but it cannot erase
 *  the execution fact — the pipeline restores `notExecuted: true` when the
 *  original result carried it (redaction must not fake ground contact). */
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

/** docs/08 H1 — the stall guard's window: the last N calls of a tool
 *  (any outcome) in which its permission failures are counted. 8 is wide
 *  enough that a normal retry discipline (fail → investigate → retry)
 *  never accumulates 3 wall-hits, narrow enough that a probe loop reaches
 *  the threshold within a handful of turns. Exported for tests/tuning. */
export const STALL_WINDOW = 8;
/** docs/08 H1 — the stall threshold: permission failures of one tool
 *  within its window. 3 (two identical retries remain legitimate). */
export const STALL_THRESHOLD = 3;

/** H2 — identical non-permission failures are tracked over each tool's
 * last eight calls, with the same conservative threshold as H1. */
export const REPEAT_FAILURE_WINDOW = 8;
export const REPEAT_FAILURE_THRESHOLD = 3;

function stableArgs(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableArgs).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableArgs(obj[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

/** Normalize only inconsequential whitespace; do not erase error details
 * such as paths, codes, or changing network diagnostics. */
function normalizeFailure(texts: string[]): string {
  return texts.map((text) => text.trim().replace(/\s+/g, " ")).join("\n");
}

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
 * The stall guard's in-band answer: the tool has now failed 3 times with a
 * permission denial within its last 8 calls, so the result of the failing
 * call is REPLACED by this notice and the run stops with stopReason
 * "stall" (the loop maps the `stall` detail onto it). The model is told
 * the failure is deterministic, what to do instead, and how the user can
 * lift the boundary (--no-sandbox for system-maintenance work).
 * `executed` (default true — a kernel denial IS an execution) drives the
 * first clause honestly: a result carrying `notExecuted` (F1, docs/08 §9)
 * must not be described as having run. Parameterized on purpose — a
 * string-splice over this text would silently revert the wording if the
 * prefix were ever edited (fifth audit pass).
 */
export function stallText(toolName: string, executed = true): string {
  return (
    (executed
      ? "This call WAS executed, but its result was REPLACED by this notice: "
      : "This call was NOT executed; its result is REPLACED by this notice: ") +
    `the "${toolName}" tool has now failed 3 times with a permission denial ` +
    "(Operation not permitted / permission denied) within its last 8 calls. " +
    "That failure is deterministic — the sandbox boundary will not move, so " +
    "rephrasing or retrying the same operation will not help, and the run " +
    "stops here (stopReason 'stall'). Change approach: use a different tool " +
    "or a target INSIDE the workspace (a path the sandbox allows), or finish " +
    "with a text-only reply explaining the blocked step. If the task " +
    "genuinely requires system-level access (e.g. git push over ssh, which " +
    "needs ~/.ssh), tell the user to re-run with --no-sandbox."
  );
}

/** D33 (docs/08 §10) — the persisted excerpt cap: big enough for a real
 *  denial or traceback head, small enough that one entry never dominates
 *  the JSONL. The display truncates further (one line). */
export const GUARD_EXCERPT_MAX = 2000;

/** Build a D33 error excerpt: whitespace collapsed to ONE line, capped.
 *  (Raw denial text and normalized failure text converge on the same
 *  shape: a single capped line the display can print verbatim.)
 *  Exported for tests. */
export function guardExcerpt(text: string): string {
  const oneLine = text.trim().replace(/\s+/g, " ");
  return oneLine.length > GUARD_EXCERPT_MAX
    ? oneLine.slice(0, GUARD_EXCERPT_MAX)
    : oneLine;
}

/**
 * Build the loop's `executeToolCall` from the pipeline. `tools` is only used
 * for descriptive error text; the loop has already resolved the tool.
 *
 * The executor carries the stall guard's state (per executor instance — the
 * CLI builds one per run, so it is per-run like the loop's batch history):
 * per tool, the window of its last STALL_WINDOW calls (any outcome) and
 * how many of those were permission failures (docs/08 H1).
 */
export function makeToolExecutor(hooks: ToolPipelineHooks = {}): ExecuteToolCall {
  // Stall-guard state (see the module header; docs/08 H1): per tool, a
  // window of its last STALL_WINDOW calls (true = permission failure) and
  // the count of permission failures within it. A success or a
  // non-permission failure does NOT reset the count (the probe loop) — it
  // occupies a slot in the window. Each tool is counted independently.
  const stallByTool = new Map<string, { window: boolean[]; count: number }>();
  const repeatFailures = new Map<string, { calls: number[] }>();
  const callsByTool = new Map<string, number>();
  return async (tool, call, signal, onUpdate) => {
    // 1. validate — malformed args never reach the tool.
    const validationError = validateArgs(tool.parameters, call.arguments);
    if (validationError !== undefined) {
      return {
        content: text(`Invalid arguments for "${tool.name}": ${validationError}`),
        isError: true,
        // F1 (docs/08 §9): a malformed call never reached the tool — same
        // "never executed" contract as the gate paths, so a rejected `bash`
        // is not a measurement and a rejected `write`/`edit` does not count.
        details: { notExecuted: true },
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
          // F1 (docs/08 §9): the call never executed — the gate itself broke.
          details: { notExecuted: true },
        };
      }
      if (decision && "blocked" in decision) {
        return {
          content: text(`Tool "${tool.name}" was blocked: ${decision.blocked}`),
          isError: true,
          // F1 (docs/08 §9, D32): the safety gate refused the call — it was
          // NEVER EXECUTED. F1's A3 reset keys on execution (a blocked bash
          // is not a measurement), and this flag is the honest cross-seam
          // signal (the loop must not regex-match pipeline prose). Additive
          // on details, like D33's stallEvidence.
          details: { notExecuted: true },
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
    // F1 (docs/08 §9, sixth audit pass): the EXECUTION FACT is
    // authoritative and independent of content redaction — capture it
    // before the hook and restore it after, so a replacement that drops
    // `details` (the documented redaction shape: new content, keep the
    // error flag) cannot turn a never-executed call into apparent ground
    // contact (an A3 bash reset / a false TUI recovery).
    const neverExecuted = result.details?.notExecuted === true;
    if (hooks.afterToolCall) {
      try {
        const replacement = await hooks.afterToolCall(tool, call, result);
        if (replacement) result = replacement;
      } catch {
        // A broken hook never changes the outcome — keep the tool's result.
      }
    }
    if (neverExecuted && result.details?.notExecuted !== true) {
      result = { ...result, details: { ...result.details, notExecuted: true } };
    }

    // 5. H2 same-failure guard — strict same tool + canonical args +
    // normalized non-permission error text. The bounded call-index history
    // prevents stale repeats from accumulating; changing diagnostics do not match.
    const repeatCallIndex = (callsByTool.get(tool.name) ?? 0) + 1;
    callsByTool.set(tool.name, repeatCallIndex);
    if (result.isError === true) {
      const errorText = normalizeFailure(result.content.map((c) => c.text));
      if (errorText && !isPermissionStallText([errorText])) {
        const signatureKey = `${tool.name}\u0000${stableArgs(args)}\u0000${errorText}`;
        const entry = repeatFailures.get(signatureKey) ?? { calls: [] };
        entry.calls = entry.calls.filter((n) => repeatCallIndex - n < REPEAT_FAILURE_WINDOW);
        entry.calls.push(repeatCallIndex);
        repeatFailures.set(signatureKey, entry);
        if (entry.calls.length >= REPEAT_FAILURE_THRESHOLD) {
          // F1 (docs/08 §9, audit fix): the replacement must not erase the
          // execution fact — a never-executed call (e.g. a bash spawn
          // failure) stays `notExecuted` here, or the TUI would read the
          // stall notice as ground contact and falsely recover A3. The
          // wording follows the fact instead of asserting execution.
          const wasExecuted = result.details?.notExecuted !== true;
          return {
            content: text(
              `Repeated identical failure detected: the "${tool.name}" tool returned the same error for the same arguments ${REPEAT_FAILURE_THRESHOLD} times within ${REPEAT_FAILURE_WINDOW} calls of that tool. ${
                wasExecuted
                  ? "The call WAS executed"
                  : "The call was NOT executed"
              }; its result is replaced and the run stops here (stopReason 'stall'). Change the operation or explain the unresolved failure.`,
            ),
            isError: true,
            // D33: stallEvidence names the trigger alongside the legacy
            // `stall` flag (additive on Record<string, unknown> — the
            // loop's details.stall check and existing tests are untouched).
            details: {
              ...(wasExecuted ? {} : { notExecuted: true }),
              stall: true,
              repeatFailure: true,
              stallEvidence: {
                guard: "repeat-failure",
                tool: tool.name,
                repeats: REPEAT_FAILURE_THRESHOLD,
                window: REPEAT_FAILURE_WINDOW,
                errorExcerpt: guardExcerpt(errorText),
              } satisfies GuardEvidence,
            },
          };
        }
      }
    }

    // 6. stall guard (docs/08 H1) — permission failures of one tool within
    //    its last STALL_WINDOW calls are a model banging on the sandbox
    //    boundary (arguments may vary — rephrasing is exactly the stall
    //    pattern; interleaved successes must NOT reset — the probe loop).
    //    Every call of the tool occupies a slot in the window (success,
    //    permission failure, or non-permission failure); the count is the
    //    number of permission failures inside it, so a stale failure slides
    //    out after STALL_WINDOW calls. The failing call is replaced
    //    in-band with STALL_TEXT (I3: every call gets a result) +
    //    details.stall; the loop maps that detail onto stopReason "stall"
    //    and stops. The call WAS executed (a denial is a harmless no-op).
    //    Each tool is counted independently — a different tool has its own
    //    window and count.
    {
      const entry =
        stallByTool.get(tool.name) ?? { window: [] as boolean[], count: 0 };
      const permission =
        result.isError === true &&
        isPermissionStallText(result.content.map((c) => c.text));
      entry.window.push(permission);
      if (entry.window.length > STALL_WINDOW) entry.window.shift();
      entry.count = entry.window.reduce((n, f) => n + (f ? 1 : 0), 0);
      stallByTool.set(tool.name, entry);
      if (permission && entry.count >= STALL_THRESHOLD) {
        // F1 (docs/08 §9, audit fix): same rule as the H2 replacement —
        // never erase the execution fact. A permission denial normally IS
        // an execution (the kernel answered), but a result that says it
        // never ran stays marked, and the notice says so honestly.
        const wasExecuted = result.details?.notExecuted !== true;
        return {
          content: text(stallText(tool.name, wasExecuted)),
          isError: true,
          // D33: the denial's OWN text (the raw result, not STALL_TEXT —
          // the notice is boilerplate; the evidence is what was denied).
          details: {
            ...(wasExecuted ? {} : { notExecuted: true }),
            stall: true,
            stallEvidence: {
              guard: "permission-stall",
              tool: tool.name,
              denials: entry.count,
              window: STALL_WINDOW,
              errorExcerpt: guardExcerpt(result.content.map((c) => c.text).join("\n")),
            } satisfies GuardEvidence,
          },
        };
      }
    }

    // Expose the effective target AFTER hook rewriting, not the original
    // model path: safety resolves relative paths against the workspace,
    // which can differ from process.cwd() (--cwd). Attach after result hooks
    // so annotations/redaction cannot accidentally drop this execution fact.
    if ((tool.name === "write" || tool.name === "edit") && typeof args.path === "string") {
      result = { ...result, details: { ...result.details, progressTarget: resolve(args.path) } };
    }
    return result;
  };
}
