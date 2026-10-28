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
 *      also stopped by strict tool/args/error matching; same-error
 *      guard 2026-11-27 (redesigned per audit): the SAME non-permission
 *      error text CONSECUTIVELY under any args — in-band warning at 3
 *      in a row, hard stall at 5; ANY other outcome resets the streak.
 *      All guards act AFTER the call executed: they replace or annotate
 *      the failing call's result in-band; they never un-run a call).
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
  /**
   * L5 (audit 2026-10-21): per-call wall-clock cap. Return a timeout in ms
   * for `tool`, or undefined for no cap. Default (see defaultToolTimeoutMs):
   * 30s for the file tools (read/write/edit) — a hung NFS read or a FIFO
   * without a writer used to wedge the loop forever, because only bash
   * honored the abort signal. bash/subtask/MCP are exempt (their own,
   * longer timeouts; subtask legitimately runs for minutes).
   */
  toolTimeoutMs?: (tool: Tool) => number | undefined;
}

/** L5: the default per-call cap for the file tools (generous — a false kill
 *  is worse than a slow hang). Exported for tests. */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
/** L5: tools with their own (longer) timeout machinery — never capped here. */
const PIPELINE_TIMEOUT_EXEMPT = new Set(["bash", "subtask"]);
/** The default `toolTimeoutMs`: cap the file tools, exempt bash/subtask/MCP. */
export function defaultToolTimeoutMs(tool: Tool): number | undefined {
  if (PIPELINE_TIMEOUT_EXEMPT.has(tool.name)) return undefined;
  if (tool.name.startsWith("mcp__")) return undefined; // MCP has per-call timeouts
  return DEFAULT_TOOL_TIMEOUT_MS;
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

/** H3 — identical non-permission failures are tracked over each tool's
 * last eight calls, with the same conservative threshold as H1. */
export const REPEAT_FAILURE_WINDOW = 8;
export const REPEAT_FAILURE_THRESHOLD = 3;
/** Same-error guard (added 2026-11-05 as "H3", redesigned 2026-11-27
 * per audit) — the args-insensitive same-error streak: the same tool
 * returning the SAME error text (whitespace-normalized) BACK-TO-BACK.
 * One record per tool ({errorText, streak}): ANY other outcome for the
 * tool — success, permission denial, empty text, or a DIFFERENT error
 * — deletes the record, so independent targets that merely share a
 * generic error cannot accumulate across unrelated work; only a genuine
 * rephrase-while-stuck run keeps climbing (the 2026-10-27 burst:
 * "sed … ,+30p" → "sed … ,+32p" → … landing on the identical message,
 * which H2's args key and the loop's identical-batch guard both miss).
 * Two rungs (the hard stop at 3 false-positived on legitimate
 * per-target probing — the audit finding; two identical retries stay
 * fully silent):
 *   - SAME_ERROR_WARN_THRESHOLD (3): the failing result is returned
 *     VERBATIM plus an appended in-band guard notice (details.
 *     sameErrorWarn) — an approach-changing nudge; the run CONTINUES.
 *   - SAME_ERROR_STALL_THRESHOLD (5): the result is REPLACED in-band
 *     with details.stall + guard "same-error-stall" and the loop stops
 *     the run (stopReason "stall"). Like H1/H2 the triggering call WAS
 *     executed — the guard acts after execution and can never prevent
 *     one (only the loop's sequential stall-skip avoids running calls
 *     already queued in the same batch). */
export const SAME_ERROR_WARN_THRESHOLD = 3;
export const SAME_ERROR_STALL_THRESHOLD = 5;

/**
 * Family-window warn rung (docs/08 §10, 2026-11-28 audit — measured on 985
 * session logs). The consecutive guard above keys on the EXACT error text
 * and requires it IN A ROW; the 2026-11-28 sed loop
 * (`sed -n ",+Np"`, 15 failures across ~90 bash calls, only the digit and
 * incidental grep output varying) reset it on every call. Neither the key
 * (digit-exact) nor the counter (consecutive) alone fixes that — both axes
 * are needed, and measurements showed digit masking with a consecutive
 * counter adds ZERO stops across 985 sessions (the masked failures are
 * never adjacent). This rung keeps the existing guard untouched and adds:
 *   - key: familyFailureKey (digits masked) — catches the sed shape;
 *   - counter: SAME_FAMILY_WARN_THRESHOLD failures of ONE family within
 *     SAME_FAMILY_WINDOW calls of that tool — interleaved successes and
 *     unrelated failures occupy slots but never reset (the probe-loop
 *     semantics already proven by H1).
 * Suppresses itself unless ≥2 DISTINCT error texts share the family:
 * byte-identical repeats are H2's job (args-keyed), and a single
 * repeatedly-identical text is the consecutive guard's job — this rung
 * announces only the varied-but-same-shape signature.
 * WARN ONLY (no stall rung): the hard-stop thresholds here have not had
 * the per-fire audit the consecutive ladder got; landing follows the
 * promote-by-commit convention. */
export const SAME_FAMILY_WARN_THRESHOLD = 3;
export const SAME_FAMILY_WINDOW = 8;

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

/**
 * Family key (docs/08 §10, 2026-11-28 audit): the whitespace-normalized
 * error with every digit RUN masked ("#+#"). Digits are masked, not
 * removed — ",+18p" → ",+#p" keeps every character around the variable
 * part, so only errors of the same SHAPE collide. Rationale (measured on
 * 985 session logs, not assumed): the commonest way models rephrase a
 * broken approach is to vary a digit (sed ranges, line numbers, timeouts,
 * byte offsets), so digit-preserving keys miss exactly the loops the
 * same-error guard exists to catch. normalizeFailure stays digit-exact —
 * it describes ONE error; this key groups a FAMILY of them.
 * Exported for contract tests.
 */
export function familyFailureKey(text: string): string {
  const norm = text.trim().replace(/\s+/g, " ");
  return norm.length === 0 ? "" : norm.replace(/\d+/g, "#");
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
  // Same-error streak (2026-11-27 redesign): ONE record per tool — the
  // error text of the tool's most recent consecutive non-permission
  // failure and how many in a row match it. Deleted by any other
  // outcome, so no unbounded per-errorText map and no stale streaks.
  // Declared up here (2026-11-27 audit, finding 2) because the
  // pre-execution paths — validation failure, blocked gate, broken hook —
  // are "other outcomes" too and must break the streak, exactly like a
  // success.
  const sameErrorStreaks = new Map<string, { errorText: string; streak: number }>();
  const breakSameErrorStreak = (toolName: string): void => {
    sameErrorStreaks.delete(toolName);
  };
  // Family-window state (docs/08 §10): per tool, per error FAMILY, the
  // (call index, error text) pairs inside the window. Pruned to the
  // window on EVERY recorded failure — for all families, not just the
  // current one — so both the pairs AND the distinct-text set expire
  // together (2026-11-28 audit, finding 2: texts used to live forever,
  // letting one stale distinct text satisfy the ≥2-texts rule long after
  // its call left the window), and each tool caps its tracked families
  // so state stays bounded like H1's window.
  const familyWindows = new Map<
    string,
    Map<string, { call: number; text: string }[]>
  >();
  const FAMILY_MAX_TRACKED = 32;
  // Per-tool OUTCOME sequence (2026-11-28 auditor cycle 2): the windowed
  // guards record state when a result EXISTS, but the executor is entered
  // in dispatch order and returns in completion order — a parallel batch
  // (or any concurrent caller) used to allocate indices at entry while
  // recording later, producing NEGATIVE window deltas (`idx - stale` is
  // always < the window) so entries never pruned: the family window
  // retained one pair per call, and H2 false-stalled on three completions
  // no real "last 8" contained. The index is now allocated at the single
  // outcome seam each call takes (the three pre-execution returns or
  // step 5) — monotonic per tool, non-negative deltas everywhere. The
  // observable semantics become "the last N OUTCOMES of this tool", the
  // only order the guard can honestly see under concurrency; in serial
  // use (the loop's sequential lane, single-call turns) outcome order IS
  // call order, so behavior is unchanged there.
  const callsByTool = new Map<string, number>();
  const nextCallIndex = (toolName: string): number => {
    const n = (callsByTool.get(toolName) ?? 0) + 1;
    callsByTool.set(toolName, n);
    return n;
  };
  // 2026-11-28 auditor cycle 1, finding 1: pre-execution outcomes
  // (validation failure, blocked call, broken beforeToolCall hook) ARE
  // calls of this tool — the windowed guards promise "within its last N
  // calls", and until now every early return skipped both the per-tool
  // call index and the H1 slot, so arbitrarily many blocked calls between
  // two real failures left the failures adjacent for H1/H2/family (an 8
  // "blocked" sandwich kept 3 denials firing H1). The three early returns
  // go through this helper: they consume their call index AND occupy the
  // H1 window slot as the NON-permission outcome they are (the tool never
  // ran — its failure text is the gate's, not a denial or a tool error,
  // and must not feed any failure counter).
  const occupyNonPermissionSlot = (toolName: string): void => {
    nextCallIndex(toolName);
    const entry = stallByTool.get(toolName) ?? { window: [] as boolean[], count: 0 };
    entry.window.push(false);
    if (entry.window.length > STALL_WINDOW) entry.window.shift();
    entry.count = entry.window.reduce((n, f) => n + (f ? 1 : 0), 0);
    stallByTool.set(toolName, entry);
  };
  return async (tool, call, signal, onUpdate) => {
    // 1. validate — malformed args never reach the tool.
    const validationError = validateArgs(tool.parameters, call.arguments);
    if (validationError !== undefined) {
      // 2026-11-27 audit, finding 2: a rejected call is "another outcome"
      // — it breaks the same-error streak, or a malformed call between two
      // identical failures would let the streak climb across unrelated
      // work (a false warn/stall one call early). It also occupies its
      // window slot (2026-11-28 auditor cycle 1).
      breakSameErrorStreak(tool.name);
      occupyNonPermissionSlot(tool.name);
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
        // A broken hook must not kill the run (I3) — fail the call. It
        // also breaks the same-error streak (2026-11-27 audit, finding 2):
        // the failure is the HOOK's, not the tool's, so it must not extend
        // a streak of the tool's own errors — and it occupies its window
        // slot (2026-11-28 auditor cycle 1).
        breakSameErrorStreak(tool.name);
        occupyNonPermissionSlot(tool.name);
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
        // A blocked call never ran — another outcome, so the streak breaks
        // (2026-11-27 audit, finding 2) and it occupies its window slot
        // (2026-11-28 auditor cycle 1: eight blocked calls between two
        // denials must slide them out of H1's last-8 window).
        breakSameErrorStreak(tool.name);
        occupyNonPermissionSlot(tool.name);
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
    // L5 (audit 2026-10-21): a wall-clock cap (default 30s for the file
    // tools) so a hung read/write can never wedge the loop. The abandoned
    // promise keeps running to settle (nothing can cancel it mid-syscall),
    // but the LOOP moves on with a timeout error result.
    const timeoutMs = hooks.toolTimeoutMs
      ? hooks.toolTimeoutMs(tool)
      : defaultToolTimeoutMs(tool);
    let result: ToolResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exec = tool.execute(call.id, args, signal, onUpdate) ?? Promise.resolve({
        content: [],
      } as ToolResult);
      result = timeoutMs
        ? await Promise.race([
            exec,
            new Promise<ToolResult>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      `timed out after ${Math.round(timeoutMs / 1000)}s ` +
                        `(the tool may still be running in the background)`,
                    ),
                  ),
                timeoutMs,
              );
              timer.unref?.(); // never keep the process alive for the cap
            }),
          ])
        : await exec;
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

    // 4b. Expose the effective target AFTER hook rewriting, not the
    //     original model path: safety resolves relative paths against the
    //     workspace, which can differ from process.cwd() (--cwd).
    //     2026-11-27 audit fix: this used to sit at the very END of the
    //     executor, so every guard verdict that returns before it (notably
    //     the same-error WARN rung, whose result the loop keeps and feeds
    //     into F1's progress scan) silently dropped `progressTarget` — the
    //     loop then fell back to the model's original path
    //     (agent-loop.ts:1403-1407) and split a run's unverified-edit
    //     counts across two keyspaces. Attaching it here (still after the
    //     result hooks, so redaction cannot drop the execution fact) means
    //     every path below either carries it (the warn rung spreads
    //     `...result`) or replaces the whole result to stop the run.
    if ((tool.name === "write" || tool.name === "edit") && typeof args.path === "string") {
      result = { ...result, details: { ...result.details, progressTarget: resolve(args.path) } };
    }

    // 5a. H1 window bookkeeping — MUST run before any verdict below can
    // return (2026-11-27 audit, finding 1). Every call of the tool
    // occupies a slot in the window (success, permission failure, or
    // non-permission failure) and the count is the number of permission
    // failures inside it; the verdict is evaluated later, but nothing may
    // skip the push. The warn rung used to return here first, so warned
    // calls never shifted the window and stale denials stayed counted —
    // H1 then fired on a call whose real last-8 history held one denial.
    //
    // The per-tool OUTCOME INDEX (2026-11-28 auditor cycle 2) is
    // allocated here — at the single seam every executed outcome passes —
    // so window deltas are non-negative even when parallel batches
    // complete out of dispatch order. This is the only seam: the three
    // pre-execution returns already allocated theirs (with a false H1
    // slot) inside occupyNonPermissionSlot.
    const repeatCallIndex = nextCallIndex(tool.name);
    const stallEntry =
      stallByTool.get(tool.name) ?? { window: [] as boolean[], count: 0 };
    const permission =
      result.isError === true &&
      isPermissionStallText(result.content.map((c) => c.text));
    stallEntry.window.push(permission);
    if (stallEntry.window.length > STALL_WINDOW) stallEntry.window.shift();
    stallEntry.count = stallEntry.window.reduce((n, f) => n + (f ? 1 : 0), 0);
    stallByTool.set(tool.name, stallEntry);

    // 5. H2 same-failure guard — strict same tool + canonical args +
    // normalized non-permission error text. The bounded call-index history
    // prevents stale repeats from accumulating; changing diagnostics do not
    // match. (repeatCallIndex was allocated at the TOP of the executor —
    // 2026-11-28 auditor cycle 1 — so the pre-execution returns consumed
    // their indices too.)
    if (result.isError === true) {
      const errorText = normalizeFailure(result.content.map((c) => c.text));
      if (errorText && !isPermissionStallText([errorText])) {
        const signatureKey = `${tool.name}\u0000${stableArgs(args)}\u0000${errorText}`;
        const entry = repeatFailures.get(signatureKey) ?? { calls: [] };
        entry.calls = entry.calls.filter((n) => repeatCallIndex - n < REPEAT_FAILURE_WINDOW);
        entry.calls.push(repeatCallIndex);
        repeatFailures.set(signatureKey, entry);
        // Same-error streak bookkeeping (2026-11-27 redesign): one
        // record per tool. The SAME normalized error as the tool's last
        // consecutive non-permission failure continues the streak; a
        // different error starts a fresh one of 1. Recorded BEFORE the
        // H2 verdict so the count stays exact on the path where H2
        // returns first (byte-identical repeats also climb this streak —
        // an exact-repeat loop is the same-error pattern with args fixed).
        const streak = sameErrorStreaks.get(tool.name);
        const sameErrorCount =
          streak !== undefined && streak.errorText === errorText
            ? streak.streak + 1
            : 1;
        sameErrorStreaks.set(tool.name, { errorText, streak: sameErrorCount });
        // Family-window bookkeeping (docs/08 §10) — recorded BEFORE any
        // verdict below may return (the 2026-11-27 audit finding 1
        // principle): every failure occupies its slot exactly once, so an
        // H2/stall early-return cannot leave the family window a call
        // behind. The VERDICT stays below, after H2 and the consecutive
        // stall own their signatures.
        //
        // 2026-11-28 audit (finding 1): the FIRST pass pushed the new
        // pair only AFTER eviction — and eviction ranked families by
        // their newest call, so a brand-new family (empty history) ranked
        // oldest and was evicted before its first call landed, silently
        // stopping admission after FAMILY_MAX_TRACKED families. The order
        // below is the fix: prune expired entries, record the pair, then
        // evict — the call being recorded can never be the eviction
        // victim. Eviction ranks by the family's NEWEST call (the
        // long-dead family leaves first; the busy one stays).
        const famKey = familyFailureKey(errorText);
        if (famKey) {
          const famByTool: Map<string, { call: number; text: string }[]> =
            familyWindows.get(tool.name) ?? new Map();
          // Prune EVERY family to the current window first, so no family
          // keeps pairs (or the distinct texts derived from them) past
          // its expiry (2026-11-28 audit, finding 2).
          for (const [k, entries] of famByTool) {
            const live = entries.filter((e) => repeatCallIndex - e.call < SAME_FAMILY_WINDOW);
            if (live.length === 0) famByTool.delete(k);
            else if (live.length !== entries.length) famByTool.set(k, live);
          }
          const entries = famByTool.get(famKey) ?? [];
          entries.push({ call: repeatCallIndex, text: errorText });
          famByTool.set(famKey, entries);
          if (famByTool.size > FAMILY_MAX_TRACKED) {
            // Drop the family whose NEWEST call is oldest (bounded state).
            let oldest: string | undefined;
            let oldestCall = Infinity;
            for (const [k, v] of famByTool) {
              const lastCall = v[v.length - 1]?.call ?? 0;
              if (lastCall < oldestCall) {
                oldest = k;
                oldestCall = lastCall;
              }
            }
            // The family just recorded has the newest call of all, so it
            // can never be `oldest` — admission never self-evicts.
            if (oldest !== undefined && oldest !== famKey) famByTool.delete(oldest);
          }
          familyWindows.set(tool.name, famByTool);
        }
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
        // Same-error guard (added 2026-11-05, ladder redesigned 2026-11-27
        // per audit) — the rephrase-while-stuck pattern: the model reads
        // the error, "changes something", but the error is a fixed
        // property of its approach (wrong sed range syntax, wrong
        // constructor signature), so every rephrase lands on the
        // identical message. H2 (args-keyed) and the loop's
        // identical-batch guard both miss this. Two rungs on the
        // consecutive streak (a hard stop at 3 false-positived on
        // legitimate per-target probing — audit finding):
        //   - warn (3 in a row): return the REAL error verbatim plus an
        //     appended approach-changing notice; the run continues.
        //   - stall (5 in a row): replace the result in-band with
        //     details.stall; the loop maps it onto stopReason "stall".
        // Both rungs act AFTER execution: the triggering call ran (its
        // result is annotated or replaced) — the guard never prevents a
        // call from running. Neither rung can skip H1's window bookkeeping
        // (5a runs first, 2026-11-27 audit finding 1).
        if (
          sameErrorCount >= SAME_ERROR_STALL_THRESHOLD &&
          entry.calls.length < REPEAT_FAILURE_THRESHOLD // H2 already owns exact repeats
        ) {
          const wasExecuted = result.details?.notExecuted !== true;
          return {
            content: text(
              `Same-error stall: the "${tool.name}" tool returned the same error ${sameErrorCount} times IN A ROW, under different arguments (rephrasing did not change the outcome). ${
                wasExecuted
                  ? "This call WAS executed; its result is REPLACED by this notice"
                  : "This call was NOT executed; its result is REPLACED by this notice"
              }, and the run stops here (stopReason 'stall'). Stop rephrasing: the error message names the cause — read the file/class it points at, or switch tool/approach, or explain the unresolved failure.`,
            ),
            isError: true,
            details: {
              ...(wasExecuted ? {} : { notExecuted: true }),
              stall: true,
              // NOT `repeatFailure` — that flag is H2's (same args too);
              // the same-error guard announces itself with `sameError` +
              // the evidence guard.
              sameError: true,
              stallEvidence: {
                guard: "same-error-stall",
                tool: tool.name,
                repeats: sameErrorCount,
                consecutive: true,
                errorExcerpt: guardExcerpt(errorText),
              } satisfies GuardEvidence,
            },
          };
        }
        if (sameErrorCount >= SAME_ERROR_WARN_THRESHOLD) {
          // Warn rung: the real error stays verbatim (the model must
          // still read it); the notice rides along in-band. Additive
          // details only — the execution fact and every other detail
          // pass through untouched.
          return {
            ...result,
            content: [
              ...result.content,
              ...text(
                `(guard: the "${tool.name}" tool has returned this SAME error ${sameErrorCount} times in a row under different arguments — rephrasing is not changing the outcome. The error names the cause: read the file/class it points at, or switch to a different tool/approach before retrying. ${SAME_ERROR_STALL_THRESHOLD} in a row stops the run.)`,
              ),
            ],
            details: { ...result.details, sameErrorWarn: sameErrorCount },
          };
        }
        // Family-window warn rung (docs/08 §10) — ADDITIVE: the exact-text
        // consecutive ladder above owns its signatures untouched (byte
        // repeats defer to H2; one text IN A ROW is the consecutive
        // guard's domain — including alternating identical texts, which
        // test/tools.test.ts pins as silent). This rung announces only
        // ≥2 DISTINCT error texts of the same family within the window:
        // the loop the exact key and the consecutive counter both miss.
        // (The window was already updated above, before the verdicts.)
        // 2026-11-28 audit, finding 2: distinctness is computed from the
        // LIVE window entries only — a text whose calls have all expired
        // no longer counts, so the ≥2-texts rule really means "two
        // distinct texts inside the last SAME_FAMILY_WINDOW calls".
        if (famKey) {
          const fam = familyWindows.get(tool.name)?.get(famKey);
          const distinctTexts = new Set((fam ?? []).map((e) => e.text));
          if (
            fam !== undefined &&
            fam.length >= SAME_FAMILY_WARN_THRESHOLD &&
            distinctTexts.size >= 2
          ) {
            return {
              ...result,
              content: [
                ...result.content,
                ...text(
                  `(guard: the "${tool.name}" tool returned ${fam.length} failures of the SAME error family within its last ${SAME_FAMILY_WINDOW} calls — the messages differ only in digits/incidental output, so the approach has not changed. The error names the cause: read the file/class it points at, or switch tool/approach before retrying.)`,
                ),
              ],
              details: {
                ...result.details,
                sameFamilyWarn: fam.length,
                sameFamilyWindow: SAME_FAMILY_WINDOW,
              },
            };
          }
        }
      } else {
        // Outcome is not a same-error candidate (success, permission
        // denial — H1's domain — or empty error text): the streak is
        // broken. ONE record per tool, deleted outright — no stale
        // streaks and no unbounded per-errorText state (the previous
        // design kept zeroed entries forever; the audit found its reset
        // branch was unreachable dead code inside the error-only `if`).
        breakSameErrorStreak(tool.name);
      }
    } else {
      // Success: same broken-streak rule as above.
      breakSameErrorStreak(tool.name);
    }

    // 6. stall guard (docs/08 H1) — the VERDICT only: the window and count
    //    were advanced in 5a, before any guard could return (2026-11-27
    //    audit, finding 1), so every call occupies its slot exactly once
    //    and no early return can leave stale denials counted. Permission
    //    failures of one tool within its last STALL_WINDOW calls are a
    //    model banging on the sandbox boundary (arguments may vary —
    //    rephrasing is exactly the stall pattern; interleaved successes
    //    must NOT reset — the probe loop). The failing call is replaced
    //    in-band with STALL_TEXT (I3: every call gets a result) +
    //    details.stall; the loop maps that detail onto stopReason "stall"
    //    and stops. The call WAS executed (a denial is a harmless no-op).
    //    Each tool is counted independently — a different tool has its own
    //    window and count.
    if (permission && stallEntry.count >= STALL_THRESHOLD) {
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
            denials: stallEntry.count,
            window: STALL_WINDOW,
            errorExcerpt: guardExcerpt(result.content.map((c) => c.text).join("\n")),
          } satisfies GuardEvidence,
        },
      };
    }

    return result;
  };
}
