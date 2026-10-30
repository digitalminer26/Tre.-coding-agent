/**
 * WS2 — the core agent loop.
 *
 * `runLoop` consumes a StreamFn (wire layer) and Tools (tool layer), keeps
 * one `AgentMessage[]` context, and emits `AgentEvent`s: wire events pass
 * through unchanged, plus lifecycle events and tool events.
 *
 * L2: structure adapted from @earendil-works/pi-agent-core 0.85.1 (MIT,
 *      © Mario Zechner) — the inner loop: stream one assistant response
 *      into a single context slot, dispatch tool calls (parallel by
 *      default, sequential opt-out), append results in call order,
 *      `prepareNextTurn` hook between turns, batch `terminate`
 *      (docs/01 §4, §9 "Copy the inner loop + hooks").
 *      Simplified: no outer/inner split, no follow-up queue (steering
 *      covers it).
 *      Added: the `length`→fail-all guard (docs/01 §4.1), the no-call
 *      `length` nudge (C22), per-cycle turn budget + auto-continuation
 *      (C26), identical-batch loop detection (C26), stall stop,
 *      steering keep-alive.
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
 *    2026-10-28 audit fix — stall-aware sequential dispatch: once a call
 *    returns `details.stall`, later calls in a SEQUENTIAL batch are
 *    skipped with synthetic `notExecuted` in-band results (the only path
 *    that prevents a call from running; `evidence.skipped` counts them).
 *    Parallel batches cannot do this — the calls are in flight before any
 *    result exists; the pipeline guards stop the run after the batch.
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
 *  - Stall detection (tool pipeline): the same tool failing 3 times with a
 *    permission denial (the deterministic sandbox wall — "Operation not
 *    permitted") within its last 8 calls (docs/08 H1: windowed —
 *    interleaved successes do not reset) is NOT executed on the failing
 *    call, and the run stops with stopReason "stall". The pipeline
 *    answers in-band with `details.stall`; the loop maps it onto the stop
 *    reason.
 *  - Steering: guidance typed during a run is queued by the driver (a
 *    `SteeringQueue`) and delivered before the next LLM call — after the
 *    current turn's work completes, and BEFORE the `prepareNextTurn` hook
 *    (so queued user messages are in context when a hook decides, e.g.
 *    auto-compaction). A pending steer also KEEPS THE RUN ALIVE when the
 *    model would otherwise stop with a text-only reply.
 *    Abort/error/budget/loop breaks do NOT drain — the queue is per-run and
 *    the driver discards leftovers (a new prompt starts a fresh queue).
 */
import { resolve } from "node:path";
import type {
  AgentEvent,
  AgentMessage,
  GuardEvidence,
  ProgressKind,
  ProgressMode,
  SteerEntry,
  UserMessage,
  AssistantMessage,
  ExecuteToolCall,
  ModelConfig,
  StopReason,
  StreamFn,
  Tool,
  ToolCallBlock,
  TextBlock,
  ToolResult,
  ToolResultMessage,
} from "../types.js";

// The seam type lives in types.ts (contract home) so the tools layer can
// implement it without depending on the loop layer. Re-exported for
// compatibility with the WS2-era location.
export type { ExecuteToolCall } from "../types.js";

/**
 * Steering queue — the driver's seam for injecting user guidance into a run
 * that is already in flight. The driver pushes a line when the user submits
 * while busy; the loop drains it before each LLM call (and once more as a
 * keep-alive when the model would stop text-only). The queue is per-run:
 * abort/error/budget/loop breaks leave it undrained, and the driver
 * discards the leftovers when the run ends.
 */
export interface SteeringQueue {
  push(text: string | SteerEntry): void;
  /** P3a: drains may yield plain strings (TTY — the loop defaults them to
   *  `{requestId:"", source:"tty"}`) or tagged `SteerEntry` items. */
  drain(): (string | SteerEntry)[];
}

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
   * How many times the loop auto-retries after the loop guard (same tool-call
   * batch 3× in a row) fires, instead of stopping with stopReason "loop".
   * Default 1 (one approach-changing retry, then stop). 0 restores the old
   * behavior: the run stops at the first guard hit. Each retry resets the
   * identical-batch history and injects an approach-changing nudge, so the
   * model gets one fresh window to pick a different action; the cap bounds
   * the worst case to a small, fixed number of extra turns (no runaway).
   */
  maxGuardRetries?: number;
  /**
   * F1 (docs/08 §9, D32) — where the no-progress ladder stands:
   * "watch" (default at landing) fires the `progress_nudge` event and does
   * NOTHING else; "nudge" injects the context nudge; "stop" runs the full
   * ladder (nudge, then stopReason "progress" on recurrence). Promotion is
   * a one-line default flip whose commit carries the /stats_progress
   * telemetry that justified it. No CLI flag at landing (code-owned).
   */
  progressMode?: ProgressMode;
  /**
   * F1 (docs/08 §9) — auto-nudges per kind before the stop (per-run).
   * Default 1; 0 = hard stop on the first hit (the H5 convention).
   */
  maxProgressNudges?: number;
  /**
   * Hook between turns: return a reduced/rewritten context for the next
   * turn, or undefined to keep the current one.
   */
  prepareNextTurn?: (context: AgentMessage[], turn: number) =>
    | AgentMessage[]
    | undefined
    | Promise<AgentMessage[] | undefined>;
  executeToolCall?: ExecuteToolCall;
  /**
   * Steering queue (optional): guidance typed during the run is drained
   * before each LLM call and injected as a user message. See `SteeringQueue`.
   */
  steeringQueue?: SteeringQueue;
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

// 2026-10-28 audit fix — the sequential stall-skip notice. When one call
// in a sequential batch returns `details.stall`, the run is decided; every
// LATER call in the same batch is skipped with this in-band result
// (`notExecuted` + `stallSkipped`). Wording is honest: these calls were
// never dispatched — the only path where a call is prevented from running.
function stallSkipText(toolName: string): string {
  return (
    `Not executed: an earlier tool call in this batch stopped the run ` +
    `(stopReason 'stall'), so this queued "${toolName}" call was skipped. ` +
    "No need to re-issue it as-is — the stall must be resolved first."
  );
}

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

// C43 — premature-completion nudge. A model turn that announces the next
// action and then ends with NO tool call (stopReason "stop", zero calls)
// cuts the run short mid-task: observed live (session tre-20261029-155638,
// six occurrences) as "Now building the server target to verify it compiles:"
// and "Remote differs — check whether it's behind or diverged before
// pushing:" — every occurrence was a SHORT reply whose text ended with a
// colon: the model treated the colon as a handoff, then the stop token
// ended the turn before the call materialized. A legitimate final summary
// essentially never ends with ":" (it dangles syntactically), so the colon
// ending on a SHORT reply is a high-precision marker; long text-only
// answers (real summaries, explanations) are never nudged. One nudge per
// cycle, like the C22 length nudge; a second consecutive intent stop ends
// the run normally ("stop") — the model is allowed to end with prose.
const INTENT_NUDGE_TEXT =
  "Your previous message announced a next step and ended without a tool call. " +
  "If work remains, make that tool call now instead of describing it. If the " +
  "task is actually complete, reply with the final summary (no colon-ending " +
  "announcement) and stop.";

/** C43: true when a text-only stop looks like an announcement that lost its
 *  tool call: short reply (<=600 chars) whose text ends with ':'. */
export function isPrematureIntentStop(text: string): boolean {
  const t = text.trimEnd();
  return t.length > 0 && t.length <= 600 && t.endsWith(":");
}

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

// The loop guard fired, but the run is auto-retrying instead of stopping.
// This is an APPROACH-CHANGING nudge, not a "keep going" nudge: the whole
// point is that the model was stuck repeating the same failing action, so a
// blind "continue" would just re-fire the guard. The model must pick a
// DIFFERENT action. Bounded by DEFAULT_MAX_GUARD_RETRIES — at the cap the
// run stops with stopReason "loop" as before, so a genuinely stuck model
// still terminates in bounded time.
//
// Re-audit finding 2 (2026-10-27): the nudge is PATTERN-HONEST. The old
// constant claimed "the same tool call(s) 3 times in a row" for EVERY fire,
// which lied to the model on alternating-cycle fires and 12-batch cap fires
// (the model that trusts the text searches for the wrong pattern). The
// description names what actually fired, with the fired guard's own repeat
// count (issued batches including the refused one — the evidence's unit).
export function guardRetryText(isCycle: boolean, repeats: number): string {
  const pattern = isCycle
    ? `the same two tool-call batches have been issued alternately (X, Y, X, Y, X …) ${repeats} times`
    : `the same tool call(s) have been issued ${repeats} times in a row`;
  return (
    `Runaway loop guard: ${pattern} — this last repeat was not executed, ` +
    "and the run is continuing automatically. You are stuck on that action. " +
    "You MUST change your approach: pick a DIFFERENT tool, or different " +
    "arguments, or a different path. Do NOT re-issue the same call(s). If " +
    "the task is actually complete, reply with a final summary and call no " +
    "more tools."
  );
}

/** The identical-3×-in-a-row nudge (the classic fire) — retained as the
 *  exact constant for callers/tests that need the canonical text; equals
 *  `guardRetryText(false, 3)`. */
export const GUARD_RETRY_TEXT = guardRetryText(false, 3);

/**
 * How many times the loop auto-retries after the loop guard (same batch 3×)
 * fires, instead of stopping with stopReason "loop". Default 1: one
 * approach-changing retry, then the run stops (resumable, as before). The
 * retry resets the identical-batch history so the model gets a fresh window;
 * the cap bounds the worst case to a small, fixed number of extra turns, so
 * a genuinely stuck model still terminates (no runaway).
 */
export const DEFAULT_MAX_GUARD_RETRIES = 1;

// D27b audit F1 — an abort that lands after a COMPLETED assistant message
// that contains tool calls must still give every call a result (I3: every
// call gets a result), or the context is left with orphaned toolCall blocks
// that the wire layer would serialize as an invalid assistant-with-tool_calls
// but-no-tool-result history. The calls are NOT executed; each is failed
// in-band with this text.
export const ABORTED_CALL_TEXT =
  "The run was aborted before this tool call could run. It was NOT executed. " +
  "If you resume, re-issue it (or a corrected version) as your next action.";

// D27b audit F1 (error path) — a turn that errored (stopReason "error") AFTER
// emitting tool calls must still give every call a result (I3), or the context
// is left with orphaned toolCall blocks — the same invalid
// assistant-with-tool_calls-but-no-tool-result history the abort paths guard
// against. The calls are NOT executed; each is failed in-band with this text.
export const ERROR_CALL_TEXT =
  "The run ended in an error before this tool call could run. It was NOT " +
  "executed. If you resume, re-issue it (or a corrected version) as your next " +
  "action.";

/**
 * Batch shape limits (Qwen Flash Next audit, 2026-10-29): a response may
 * carry dozens or hundreds of calls — in one observed incident, 163 calls
 * in a single response with the exact same `bash` command repeated 66x
 * plus a near-identical variant 55x. Such megabatches are a runaway
 * signature even when nothing repeats across turns: they can launch large
 * concurrent side effects (notably parallel `bash`) before any per-call
 * guard sees a result. The loop therefore trims oversized batches before
 * dispatch:
 *   - MAX_BATCH_CALLS: hard cap on executed calls per response (a hard
 *     safeguard, always on, never disabled).
 *   - MAX_PARALLEL_CALLS: bound on CONCURRENT dispatch of `parallel`
 *     tools. Parallel dispatch currently means Promise.all (see the
 *     dispatch section below); the remainder of an oversized parallel
 *     group runs in follow-up chunks, preserving completion order.
 * Extra members are NOT executed: each gets an in-band error result and
 * `details.notExecuted` so skips are never mistaken for ground contact.
 * Both constants are exported for tests/tuning like the POLL_CAP family.
 */
export const MAX_BATCH_CALLS = 32;
export const MAX_PARALLEL_CALLS = 8;

/** In-band answer for calls trimmed by the batch-shape guard above. */
export const BATCH_TRIMMED_TEXT =
  "Batch limit reached: this response carried more tool calls than the " +
  "runaway-batch cap allows, so this call was NOT executed. Re-issue the " +
  "still-needed calls in smaller batches (at most a handful of independent " +
  "calls per response).";

/** In-band answer for a duplicate call skipped within the same batch.
 * Execution-neutral (2026-10-29 audit): the earlier occurrence may itself
 * have been trimmed, stall-skipped, or failed — it always has a result in
 * this batch's transcript, but claiming it "ran" would be a fabrication
 * the model can disprove. */
export const DUPLICATE_CALL_TEXT =
  "Duplicate call skipped: an identical call (same tool, same arguments) " +
  "appears earlier in this response, so this repeat was NOT executed. " +
  "Consult that call's result below instead of re-issuing it.";

/**
 * Split one assistant response's tool calls into the executable set and
 * the trimmed set. Pure (no execution) so tests can exercise it directly:
 *  - intra-batch exact duplicates (same tool + stable-JSON args) after the
 *    first occurrence are marked duplicate-skipped. The FIRST occurrence
 *    keeps its position and executes normally; every later repeat is
 *    reported with its own result so call-ID cardinality is preserved.
 *  - beyond MAX_BATCH_CALLS executable calls, the remainder is
 *    batch-trimmed. Trimming applies AFTER duplicate collapsing, so a
 *    163-call all-duplicate batch executes once rather than 32 times.
 * Returned `executable` preserves the model's call order. Exported for
 * tests.
 */
export function planBatch(
  calls: ToolCallBlock[],
): {
  executable: ToolCallBlock[];
  skipped: { call: ToolCallBlock; duplicate: boolean }[];
} {
  const executable: ToolCallBlock[] = [];
  const skipped: { call: ToolCallBlock; duplicate: boolean }[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    const key = `${call.name}:${stableJson(call.arguments)}`;
    if (seen.has(key)) {
      skipped.push({ call, duplicate: true });
      continue;
    }
    seen.add(key);
    if (executable.length < MAX_BATCH_CALLS) {
      executable.push(call);
    } else {
      skipped.push({ call, duplicate: false });
    }
  }
  return { executable, skipped };
};

/**
 * C26 — the identity of one tool-call batch: tool names + stable-JSON
 * arguments, in call order. Two batches are "the same" iff their
 * signatures match. Exported for tests.
 */
export function batchSignature(calls: ToolCallBlock[]): string {
  return calls.map((c) => `${c.name}:${stableJson(c.arguments)}`).join("\u0000");
}

// ─────────────────────── audit fix 2026-10-27: loop detection v2 ────────────
// The v1 detector compared batch SIGNATURES only, which had two failure
// modes found in the 2026-10-27 audit:
//
//  1. ALTERNATING loops evade it. `A → B → A → B → …` never puts three
//     IDENTICAL batches in a row, so a model ping-ponging between two
//     stuck actions ran until the turn budget. The cycle guard below
//     catches the same pattern at period 2: the last four executed
//     batches are [X, Y, X, Y] and the model is issuing the third
//     occurrence of X (CYCLE_MIN_HISTORY + current = 5 batches = 2.5
//     cycles; the run stops BEFORE executing the 5th, exactly as the
//     identical guard stops before the 3rd repeat).
//
//  2. Repeats with CHANGING results are progress, not loops. Polling a
//     file/status that keeps changing is the same batch every turn, and
//     v1 stopped it as a runaway even though every call returned NEW
//     information. Both guards still STOP fresh-result repeats but only
//     at the hard caps (POLL_CAP / CYCLE_CAP: bounded churn that never
//     acts on the information); before the caps, fresh results are
//     allowed to keep running. Repeats whose results STOPPED changing
//     (stable digests across the compared batches) stop early (3rd
//     identical / 3rd cycle of the current position).
//
// The result of a batch is the digest of its per-call results
// (resultEntryDigest: JSON error-flag + text, JSON-encoded per call and
// per batch so arbitrary text can never collide) plus a SEPARATE failure
// flag (any call isError or synthetic in-band) — result text is never
// parsed for failure. Synthetic in-band fills (length guard, unknown
// tool) record the constant synthetic digest; a repeat of the same fill
// is as stuck as a repeat of the same failure.

/** Audit fix — the minimum executed-batch history the cycle guard
 *  compares (the four batches [X, Y, X, Y] before the current one). */
export const CYCLE_MIN_HISTORY = 4;
/** Audit fix — the cycle guard's pattern length (period 2: alternating). */
export const CYCLE_PATTERN_LEN = 2;
/** Audit fix — the hard repeat caps: even a repeat whose results keep
 *  arriving FRESH is stopped once it runs this many batches in a row
 *  (identical POLL_CAP; strict alternation CYCLE_CAP). Generous enough
 *  that no legitimate poll/retry discipline hits it, small enough that
 *  bounded-churn loops die without waiting for the (huge) turn budget.
 *  The batch history keeps this many records. */
export const POLL_CAP = 12;
export const CYCLE_CAP = 12;
/** Audit fix — how many executed batches the loop remembers (the longest
 *  window any guard rule reads). */
export const LOOP_HISTORY_DEPTH = Math.max(POLL_CAP, CYCLE_CAP, CYCLE_MIN_HISTORY);

/**
 * The cycle guard's in-band answers (the alternating-pattern repeat, never
 * executed). Same "not executed" contract as LOOP_GUARD_TEXT (I3: every
 * call gets a result). STABLE means the pattern's results stopped changing
 * (stuck loop); EXHAUSTED means the pattern kept arriving fresh and hit the
 * hard cap (bounded churn that never acts on the information).
 */
export const CYCLE_GUARD_TEXT =
  "Runaway loop detected: the same two tool-call batches have been issued " +
  "alternately (X, Y, X, Y, X …) with unchanged results. This repeat was " +
  "not executed. Change your approach — re-read the latest results, pick a "
  + "different action, or finish with a text-only response explaining the " +
  "situation.";
export const CYCLE_CAP_GUARD_TEXT =
  `Runaway loop detected: the same two tool-call batches have been issued ` +
  `alternately (X, Y, X, Y, X …) ${CYCLE_CAP} times. Repeating is bounded: ` +
  `this repeat was not executed. Act on the information already gathered, ` +
  `pick a different action, or finish with a text-only response explaining ` +
  `the situation.`;

/** Cap-exhausted in-band answer for the identical-batch poll cap. */
export const LOOP_CAP_GUARD_TEXT =
  `Runaway loop detected: the same tool call(s) were issued ${POLL_CAP} ` +
  `times in a row. Repeating is bounded: this repeat was not executed. Act ` +
  `on the information already gathered, pick a different action, or finish ` +
  `with a text-only response explaining the situation.`;



/** Digest of one executed call's result. Each content block is encoded as
 *  its OWN JSON element ([type, text] / [type]) and the whole structure
 *  (isError flag + block array) is JSON-encoded in one step — no raw
 *  joins anywhere, so block boundaries survive even when block text
 *  contains separators, NULs, or JSON syntax (audit re-fix 2026-10-27:
 *  the previous version joined texts with \u0000 BEFORE encoding, so
 *  ["a","b"] and ["a\u0000b"] still digested identically). */
function resultEntryDigest(entry: {
  result: ToolResult;
  isError: boolean;
}): string {
  const blocks = (entry.result.content ?? []).map(
    (b): [string, string?] =>
      b.type === "text" ? ["t", b.text] : [b.type],
  );
  return JSON.stringify([entry.isError, blocks]);
}

/** Digest of a SYNTHETIC in-band fill (length guard, unknown tool): the
 *  text is a constant, so a repeated guarded batch is by definition a
 *  repeat with no new information — the same fill digest every time. */
const SYNTHETIC_FILL_DIGEST = "S:in-band-fill";

// ───────────────────────────────────────────────────────────────────────────
// F1 — progress detection (docs/08 §9, D32). The act–measure–act guards:
// thrashing that never repeats byte-identically (C26 misses), never hits a
// permission wall (H1 misses), and never produces same-error churn (H2
// misses). Turn-level state lives HERE (the pipeline is call-scoped).
// Nothing is persisted; the nudge rides the context only (like the budget
// and guard-retry nudges). Landing default: mode "watch" — the event fires,
// nothing else happens; promotion is a one-line default flip backed by the
// /stats_progress telemetry.
// ───────────────────────────────────────────────────────────────────────────

/** F1 variant B — consecutive turns whose non-empty batch is ALL failures
 *  (blocked calls count; a turn with no tool calls is neutral). Exported
 *  for tests/tuning, like STALL_WINDOW. */
export const NO_SUCCESS_TURNS = 3;
/** F1 variant A3 — writes/edits of the SAME normalized path with no
 *  executed bash call in between (a bash call — success OR failure — resets
 *  every path counter; a gate-blocked bash never ran and does not). */
export const UNVERIFIED_EDITS = 4;
/** F1 — nudges per kind before the stop (per-run). 0 = hard stop on the
 *  first hit (the H5 convention). */
export const MAX_PROGRESS_NUDGES = 1;

/** F1 variant B's nudge: an approach-changing instruction, not "keep going"
 *  (the model has produced zero successful tool calls for a while). */
export const NO_SUCCESS_NUDGE_TEXT =
  "No progress detected: your last tool calls ALL failed. Do NOT re-issue " +
  "similar calls — re-read the error results, state what you believe is " +
  "wrong and what you need from the user, or try a fundamentally different " +
  "approach. If the task cannot proceed, finish with a text-only reply " +
  "explaining the blocker.";

/** F1 variant A3's nudge: name the missing measurement, not a concept. */
export function noVerificationNudgeText(target: string, count: number): string {
  return (
    `No progress detected: you have edited ${target} ${count} times without ` +
    "running anything in between. Edits without measurement are guesses — " +
    "run the project's check (build/tests) to see whether the edits actually " +
    "work, or explain why verification is not applicable here before " +
    "continuing to edit."
  );
}

/** F1 A3's fallback target for executors without effective-path metadata:
 *  resolve a write/edit `path` against process cwd. The built-in pipeline
 *  instead supplies details.progressTarget AFTER workspace path rewriting,
 *  so --cwd and absolute/relative aliases count against the actual file.
 *  No case-folding; a heuristic, not a boundary. Exported for tests. */
export function progressTargetOf(call: ToolCallBlock): string | undefined {
  if (call.name !== "write" && call.name !== "edit") return undefined;
  const p = call.arguments.path;
  if (typeof p !== "string" || p === "") return undefined;
  return resolve(p);
}

/** Deep JSON.stringify with sorted object keys (argument identity that
 *  does not depend on key order).
 *
 *  Audit fix (2026-10-27): builds the JSON string DIRECTLY instead of
 *  rebuilding an object tree. The previous version assigned keys into a
 *  `{}` literal, so an argument object containing a JSON `__proto__` key
 *  (which `JSON.parse` produces as an OWN property) did not create a data
 *  key — it changed the temp object's prototype, the key vanished from the
 *  serialization, and two DIFFERENT argument objects (differing only under
 *  `__proto__`) got identical signatures. Emitting the string per key
 *  (keys sorted, `JSON.stringify` for both keys and scalar values) has no
 *  prototype to clobber: `{"__proto__":…}` serializes like any other key.
 */
function stableJson(value: unknown): string {
  const sort = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(sort).join(",")}]`;
    if (v !== null && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys
        .map((k) => `${JSON.stringify(k)}:${sort(obj[k])}`)
        .join(",")}}`;
    }
    return JSON.stringify(v) ?? String(v);
  };
  return sort(value);
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
  // D33 (docs/08 §10): the evidence for a guard stop, set at the stop
  // sites, attached to agent_end (present exactly for "loop"/"stall").
  let guardEvidence: GuardEvidence | undefined;
  let lengthNudged = false; // C22: the one retry for a no-call `length` stop
  let intentNudged = false; // C43: the one retry for a colon-ending intent stop
  // C26 — cycle bookkeeping: the budget is per-cycle, not per-run.
  const maxContinuations =
    options.maxContinuations !== undefined
      ? options.maxContinuations
      : DEFAULT_MAX_CONTINUATIONS;
  const maxCycles = maxContinuations + 1;
  let cycleStart = 0; // turn at which the current cycle began
  let continuations = 0;
  // Loop-guard auto-retry: how many times the same-batch-3× guard has fired
  // and been converted into an approach-changing retry (bounded by
  // maxGuardRetries). At the cap the run stops with stopReason "loop".
  const maxGuardRetries =
    options.maxGuardRetries !== undefined
      ? options.maxGuardRetries
      : DEFAULT_MAX_GUARD_RETRIES;
  let guardRetries = 0;
  // Loop detection (audit 2026-10-27 v2): the last up-to-LOOP_HISTORY_DEPTH
  // EXECUTED batches, each as a record with the batch signature, an
  // unambiguous JSON digest of its results, and whether any call failed.
  // The identical guard fires when a repeat stops bringing new information
  // (stable results); the cycle guard catches period-2 alternation
  // (X,Y,X,Y,X …) the same way. See the "loop detection v2" section above.
  let batchHistory: { sig: string; digest: string; failed: boolean }[] = [];

  /** Push one completed batch (signature + result digest + failure flag),
   *  keeping the last LOOP_HISTORY_DEPTH records. */
  const pushHistory = (
    sig: string,
    digest: string,
    failed: boolean,
  ): void => {
    batchHistory = [
      ...batchHistory.slice(-(LOOP_HISTORY_DEPTH - 1)),
      { sig, digest, failed },
    ];
  };

  // F1 (docs/08 §9, D32) — per-run no-progress state (act–measure–act).
  // Nothing here is persisted; the nudge rides the context only (like the
  // budget and guard-retry nudges). Landing default: "watch" — the event
  // fires and NOTHING else happens; promotion is a one-line default flip
  // backed by the /stats_progress telemetry.
  const progressMode: ProgressMode = options.progressMode ?? "watch";
  const maxProgressNudges =
    options.maxProgressNudges !== undefined
      ? options.maxProgressNudges
      : MAX_PROGRESS_NUDGES;
  // Variant B: consecutive all-failed turns (reset by any success, by a
  // steer, and — as an episode end — by firing).
  let noSuccessStreak = 0;
  // Variant A3: unverified write/edit count per normalized path; an
  // EXECUTED bash call clears the whole map (ground contact is global).
  const unverifiedEdits = new Map<string, number>();
  // Ladder budget per kind; ground truth deletes the entry (a post-
  // recovery hit starts a fresh ladder — "recurrence with no intervening
  // ground truth" falls out of this rule).
  const progressNudges = new Map<ProgressKind, number>();
  // One announcement per episode: set when the event fires, cleared by the
  // same ground truth as the ladder budget (a persisting condition does not
  // spam the event; a later episode re-announces).
  const progressFired = new Map<ProgressKind, boolean>();
  let progressStop: { kind: ProgressKind; count: number } | undefined;

  /**
   * Steering drain (D27). Delivers queued user guidance as user messages:
   * each is pushed to the context and carried in a `steer` event (the driver
   * persists the EXACT object — session entry ids are keyed by message
   * identity). Returns true when at least one steer was delivered.
   *
   * D27 Finding 2: a delivery RESETS the identical-batch loop guard
   * (`batchHistory`) — fresh user input can make a previously-repeated action
   * legitimate ("I changed a externally; read it again"). The per-cycle turn
   * budget is NOT reset (that counter is the runaway guard, not the loop
   * detector).
   */
  async function drainSteers(turn: number): Promise<AgentEvent[]> {
    const queue = options.steeringQueue;
    if (!queue) return [];
    const pending = queue.drain();
    const events: AgentEvent[] = [];
    for (const entry of pending) {
      // P3a (docs/11 §14.2): plain-string items (TTY, legacy callers) keep
      // byte-identical content with an empty-envelope default.
      const { text, requestId, source } = typeof entry === "string" ? { text: entry, requestId: "", source: "tty" } : entry;
      const message: UserMessage = { role: "user", content: text, timestamp: Date.now() };
      context.push(message);
      events.push({ type: "steer", turn, text, steering: { requestId: requestId ?? "", source: source ?? "tty" }, message });
    }
    if (pending.length > 0) {
      // D27 Finding 2 — external guidance makes a repeated batch legitimate
      // again; clear the consecutive-batch history (not the turn budget).
      batchHistory = [];
      // F1 (docs/08 §9): the same rule for variant B — fresh user input can
      // legitimize failing attempts (the guidance may explain the wall), so
      // the no-success streak and its episode state reset too.
      noSuccessStreak = 0;
      progressNudges.delete("no-success");
      progressFired.delete("no-success");
    }
    return events;
  }

  /**
   * D27b audit F1 — fail a completed tool-call batch IN-BAND without
   * executing it: every call gets a `toolResult` (I3: every call gets a
   * result) so the context stays a valid history, and the matching
   * `tool_execution_start`/`tool_execution_end` events are emitted so a
   * consumer can render them. Used when the run aborts OR errors after a
   * turn that already produced tool calls — the calls must not run, but
   * they may not be left dangling either.
   */
  async function* failInband(
    calls: ToolCallBlock[],
    text: string,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    for (const call of calls) {
      yield { type: "tool_execution_start", toolCall: call };
    }
    for (const call of calls) {
      const msg = resultMessage(
        call,
        {
          content: [{ type: "text", text }],
          // F1 (docs/08 §9): coherent contract — `notExecuted` means exactly
          // what it says on EVERY in-band result (failInband never runs the
          // calls), so F1's A3 reset rule holds across all producers.
          details: { notExecuted: true },
        },
        true,
      );
      context.push(msg);
      yield { type: "tool_execution_end", toolCallId: call.id, result: msg };
    }
  }

  while (true) {
    // D27b audit: check at the top of every iteration. The keep-alive and
    // length-nudge `continue` paths skip the end-of-body abort check, so a
    // cancellation that lands while the consumer handles their events is only
    // caught here (and it takes precedence over a coincident budget hit, which
    // would otherwise misreport "budget").
    if (signal.aborted) {
      stopReason = "aborted";
      break;
    }
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
      intentNudged = false; // C43: likewise the intent-completion retry
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

    // D27b audit: the consumer may abort while handling the previous turn's
    // events (or the run may already be aborted at the top of the loop — the
    // keep-alive/length-nudge `continue` paths skip the end-of-body check).
    // Check BEFORE the pre-hook drain so an aborted run does not deliver or
    // persist guidance that no model request will ever see.
    if (signal.aborted) {
      stopReason = "aborted";
      break;
    }

    // Steering: guidance typed during the run is queued by the driver and
    // delivered here — after the previous turn's work, before this LLM call.
    // It is drained BEFORE the prepareNextTurn hook so queued user messages
    // are in context when the hook decides (e.g. auto-compaction): they are
    // never dropped by a compaction decision. The message object is created
    // ONCE and carried in the event: the driver persists that same object
    // (session entry ids are keyed by message identity — a steer that
    // becomes the first kept message of a compaction must resolve its id).
    for (const ev of await drainSteers(turn)) yield ev;

    if (options.prepareNextTurn) {
      const next = await options.prepareNextTurn(context, turn);
      if (next !== undefined) context.splice(0, context.length, ...next);
    }

    // Audit follow-up (gpt-6.1-sol, D27): if the run was aborted while the
    // async hook ran, do NOT deliver guidance that arrived during the hook —
    // the documented policy is that abort breaks leave pending guidance
    // undrained (the driver discards the queue). Check BEFORE the post-hook
    // drain so a hook-time abort does not persist a steer that no model
    // request will ever see.
    if (signal.aborted) {
      stopReason = "aborted";
      break;
    }

    // D27 Finding 1: the hook is async (auto-compaction awaits an LLM call),
    // so guidance can arrive WHILE it runs. The pre-hook drain above is one-
    // shot; drain a SECOND time after the hook resolves and before the
    // stream call so that late guidance is not deferred to the next request.
    // Same helper → same `steer` event + message identity → the CLI persists
    // it through the existing path (entry-id map stays consistent).
    for (const ev of await drainSteers(turn)) yield ev;

    // D27 Finding 3: the hook is async, so the run may be aborted while it
    // runs (or while the consumer persists the steer events just emitted).
    // Check before starting work — do not invoke the streamFn after
    // cancellation (the wire layer honors the signal too, but the guard is
    // about not STARTING work after an abort).
    if (signal.aborted) {
      stopReason = "aborted";
      break;
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

    // D27b audit: the consumer may abort while handling turn_end (it awaits
    // persistence of the turn's messages). Check BEFORE response handling so
    // a cancellation cannot reach the keep-alive drain or the length-nudge
    // `continue` — both of which would deliver guidance or start work after
    // the abort. (An aborted stream already set message.stopReason to
    // "aborted" below; this covers the consumer-side abort, which leaves the
    // message intact.)
    //
    // D27b audit F1: if the turn that just ended already produced tool
    // calls, they must not be left dangling in context — fail them in-band
    // (no execution) before breaking, so the history stays valid.
    if (signal.aborted) {
      stopReason = "aborted";
      // D27b audit F1 (no-`done` overlap): when the turn ended WITHOUT a
      // `done` event (StreamFn contract violation), `message` is undefined
      // but the partial slot may already hold tool calls — derive them from
      // the same slot the `message === undefined` fallback below uses, and
      // fail them in-band too (I3: every call gets a result), so a
      // consumer-side abort cannot leave an orphaned toolCall in context.
      const source =
        message ?? (slot >= 0 ? (context[slot] as AssistantMessage) : undefined);
      const calls = source
        ? source.content.filter((b): b is ToolCallBlock => b.type === "toolCall")
        : [];
      if (calls.length > 0) {
        yield* failInband(calls, ABORTED_CALL_TEXT);
      }
      break;
    }

    if (message === undefined) {
      // StreamFn contract violation — no `done` event. The turn may still
      // have emitted tool calls (a `start` + toolcall events with no closing
      // done); "keep what we have" must not keep them DANGLING. Fail them
      // in-band (I3: every call gets a result) so the history stays valid,
      // then stop with the fallback "aborted" reason (no turn completed).
      const partial = slot >= 0 ? (context[slot] as AssistantMessage) : undefined;
      const calls = partial
        ? partial.content.filter((b): b is ToolCallBlock => b.type === "toolCall")
        : [];
      if (calls.length > 0) {
        yield* failInband(calls, ERROR_CALL_TEXT);
      }
      break;
    }
    stopReason = message.stopReason;

    if (message.stopReason === "error") {
      // D27b audit F1 (error path): the turn errored AFTER emitting tool
      // calls — the wire layer ends the stream with stopReason "error" when
      // an error payload or a network failure lands mid-turn, after calls
      // have already been streamed. They must not run, yet they must not be
      // left dangling in context either — fail them in-band (no execution)
      // so the history stays valid (I3: every call gets a result).
      const calls = message.content.filter(
        (b): b is ToolCallBlock => b.type === "toolCall",
      );
      if (calls.length > 0) {
        yield* failInband(calls, ERROR_CALL_TEXT);
      }
      break;
    }
    if (message.stopReason === "aborted") {
      // D27b audit F1: the stream was aborted mid-turn, but it may have
      // already emitted tool calls before the abort. They must not run, yet
      // they must not be left dangling in context either — fail them
      // in-band (no execution) so the history stays valid.
      const calls = message.content.filter(
        (b): b is ToolCallBlock => b.type === "toolCall",
      );
      if (calls.length > 0) {
        yield* failInband(calls, ABORTED_CALL_TEXT);
      }
      break;
    }

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
        continue; // the nudge consumes no turn (it is not an LLM call); bounded by the cycle guard (turn - cycleStart < maxTurns) and once per cycle (lengthNudged)
      }
      // Steering keep-alive: the model finished with a text-only reply, but
      // the user typed guidance while it ran — deliver it and keep going.
      // D27b audit: keep-alive only makes sense if a SUBSEQUENT LLM turn is
      // possible. After the `continue`, the top-of-loop budget check fires
      // when `turn - cycleStart >= maxTurns`; if every continuation is also
      // spent, that iteration breaks with "budget" and the guidance would
      // have been delivered + persisted but never sent to the model —
      // contradicting the policy that budget exits leave pending guidance
      // undrained. Leave the queue untouched in that case (the driver
      // discards it); drain otherwise, including when a continuation is still
      // available (the nudge resets the cycle and the steer rides the next
      // real turn).
      const runwayExhausted =
        turn - cycleStart >= maxTurns && continuations >= maxContinuations;
      if (!runwayExhausted) {
        const keepAlive = await drainSteers(turn);
        if (keepAlive.length > 0) {
          for (const ev of keepAlive) yield ev;
          // Real user guidance supersedes the C43 nudge (and resets it: the
          // model's next turn is steered, not a lost-announcement retry).
          intentNudged = false;
          continue;
        }
      }
      if (
        message.stopReason === "stop" &&
        !intentNudged &&
        turn - cycleStart < maxTurns &&
        isPrematureIntentStop(
          message.content
            .filter((b): b is TextBlock => b.type === "text")
            .map((b) => b.text)
            .join(""),
        )
      ) {
        // C43: an announcement ended the turn with no tool call. One nudge
        // lets the model issue the call it was about to make. The assistant
        // text is already in context (I2), so it sees its own announcement.
        intentNudged = true;
        context.push({
          role: "user",
          content: INTENT_NUDGE_TEXT,
          timestamp: Date.now(),
        });
        continue; // not itself an LLM turn (adds nothing to `turn`); the model's
        // retry response IS a normal turn and still counts against the cycle
        // budget (the nudge only fires while turn - cycleStart < maxTurns).
        // Bounded once per cycle by intentNudged.
      }
      break; // normal stop — or length with the nudge already spent
    }

    // C26 loop detection (audit v2, 2026-10-27): STABLE repeats (results
    // stopped changing) stop early (3rd identical / 3rd cycle of the
    // current position); FRESH-result repeats are bounded by the hard caps
    // (POLL_CAP / CYCLE_CAP batches of the same pattern). The current
    // batch is failed in-band (I3: every call still gets a result) and
    // NOT executed; the run then stops with stopReason "loop" (after the
    // bounded H5 auto-retry below). Cap stops get their own in-band text
    // (LOOP_CAP_GUARD_TEXT / CYCLE_CAP_GUARD_TEXT) so the model is told the
    // true reason (bounded polling), not a false "3 in a row" / "unchanged
    // results". See "loop detection v2" above.
    //
    // Cycle-rule exemption (same audit): a pattern containing a FAILED
    // batch is exempt from the STABLE cycle rule — repeated failures are
    // the H2 retry-stall / permission-stall guards' domain (they annotate
    // the 3rd failure in place and stop with "stall", carrying richer
    // evidence); a plain-identical failing batch still trips the identical
    // rule below, exactly as before v2.
    // The cross-turn loop/cycle guards see the EXECUTED subset: a trimmed
    // megabatch must not poison the identical-batch signature with its
    // unexecuted tail (the 163-call Qwen response would otherwise stamp a
    // 163-call signature into history). Skips are still in-context errors,
    // so a re-issued identical response trims/duplicates again the same way.
    const plannedForSignature = planBatch(calls);
    // The cross-turn loop/cycle guards see the EXECUTED subset: a trimmed
    // megabatch must not poison the identical-batch signature with its
    // unexecuted tail (the 163-call Qwen response would otherwise stamp a
    // 163-call signature into history). Skips are still in-context errors,
    // so a re-issued identical response trims/duplicates again the same way.
    const signature = batchSignature(plannedForSignature.executable);
    {
      const n = batchHistory.length;
      // Stable-result identical repeat: the last two executed batches ARE
      // this batch and their results were identical — the repeat stopped
      // bringing new information. (Unchanged from the C26 contract: this
      // fires on failed repeats too — the guard precedes execution, so it
      // deliberately never lets the pipeline see a 3rd identical batch.)
      const identicalStable =
        n >= 2 &&
        batchHistory[n - 1]!.sig === signature &&
        batchHistory[n - 2]!.sig === signature &&
        batchHistory[n - 1]!.digest === batchHistory[n - 2]!.digest;
      // Fresh-result cap: even when every repeat brought NEW results,
      // POLL_CAP identical batches in a row is bounded stopping — a model
      // polling forever never acts on the information. Only when the latest
      // digests are NOT stable (otherwise the stable rule already caught it).
      const identicalCapped =
        POLL_CAP > 2 &&
        n >= POLL_CAP - 1 &&
        !identicalStable &&
        batchHistory.slice(n - (POLL_CAP - 1)).every((b) => b.sig === signature);
      // Stable-result alternation: [X, Y, X, Y] executed (X ≠ Y) and the
      // current batch is the third X — and each position's results repeat
      // across cycles (dX1 === dX2, dY1 === dY2).
      // Re-audit (2026-10-27): the failure exemption must cover ALL FOUR
      // history records, not just the first pair (X, Y). A second-pair
      // record (X₂/Y₂) answered SYNTHETICALLY (a guard fill, an unknown
      // tool, an I3 throw — a constant or reused text) can digest the same
      // as the first pair's real result; checking only !X.failed &&
      // !Y.failed then declared a "stable" cycle from a run where the
      // second round never actually produced results. Same reasoning as the
      // length-fill fix (failed-record flag): repeated FAILURES are the
      // stall guards' domain, so the stable cycle rule stops only when all
      // four rounds were genuine, successful, repeating results.
      const alternatingStable =
        n >= CYCLE_MIN_HISTORY &&
        (() => {
          const h = batchHistory;
          const X = h[n - 4]!;
          const Y = h[n - 3]!;
          const X2 = h[n - 2]!;
          const Y2 = h[n - 1]!;
          return (
            X.sig !== Y.sig &&
            X2.sig === X.sig &&
            Y2.sig === Y.sig &&
            signature === X.sig &&
            X2.digest === X.digest &&
            Y2.digest === Y.digest &&
            !X.failed &&
            !Y.failed &&
            !X2.failed &&
            !Y2.failed
          );
        })();
      // Fresh-result alternation cap: 11 executed batches strictly
      // alternating X,Y (any results) and the current one continues the
      // pattern (the 12th) — alternating polling is bounded too. Only when
      // the stable rule did not already catch this turn (its results would
      // have to be fresh per position).
      const alternatingCapped =
        n >= CYCLE_CAP - 1 &&
        !alternatingStable &&
        (() => {
          const h = batchHistory.slice(n - (CYCLE_CAP - 1));
          if (h[0]!.sig === h[1]!.sig) return false;
          for (let i = 2; i < h.length; i++) if (h[i]!.sig !== h[i - 2]!.sig) return false;
          return signature === h[h.length - 2]!.sig;
        })();
      const cycleFired = alternatingStable || alternatingCapped;
      const capFired = identicalCapped || alternatingCapped;
      const fired = identicalStable || identicalCapped || cycleFired;
      if (fired) {
        const guardText = alternatingStable
          ? CYCLE_GUARD_TEXT
          : alternatingCapped
            ? CYCLE_CAP_GUARD_TEXT
            : identicalCapped
              ? LOOP_CAP_GUARD_TEXT
              : LOOP_GUARD_TEXT;
        // ONE counting unit everywhere: repeats = batches ISSUED in the
        // pattern including the refused one (identical-stable 3;
        // alternating-stable CYCLE_MIN_HISTORY + 1; caps POLL_CAP /
        // CYCLE_CAP).
        const repeats = alternatingStable
          ? CYCLE_MIN_HISTORY + 1
          : alternatingCapped
            ? CYCLE_CAP
            : identicalStable
              ? 3
              : POLL_CAP;
        // WHY a cap fired when "results stopped changing" is not the truth:
        // capReason failed = the capped repeats were early-exiting failures
        // (exempt from the STABLE rules; the stall guards own them); fresh
        // = at least some repeats succeeded (a live poll that never acts).
        // Window = the fired guard's own pattern length (the constants may
        // diverge one day).
        const capReason: "fresh" | "failed" | undefined = capFired
          ? batchHistory
              .slice(n - ((alternatingCapped ? CYCLE_CAP : POLL_CAP) - 1))
              .every((b) => b.failed)
            ? "failed"
            : "fresh"
          : undefined;
        for (const call of calls) {
          yield { type: "tool_execution_start", toolCall: call };
        }
        for (const call of calls) {
          const msg = resultMessage(
            call,
            {
              content: [{ type: "text", text: guardText }],
              // F1 (docs/08 §9): synthetic in-band fill — the call never
              // ran, so it is not ground contact for A3's bash reset
              // either (a guarded `bash` must not look like a measurement).
              details: { notExecuted: true },
            },
            true,
          );
          context.push(msg);
          yield { type: "tool_execution_end", toolCallId: call.id, result: msg };
        }
        // Bounded auto-retry: instead of stopping outright, convert the guard
        // hit into ONE approach-changing retry (default; maxGuardRetries 0
        // restores the old hard stop). The in-band error results above are
        // already in context, so the model sees exactly what was not executed
        // and why; the nudge tells it to pick a DIFFERENT action (not "keep
        // going" — that would just re-fire the guard). Clearing the batch
        // history gives the model a fresh window (both rules); the turn
        // budget still bounds the run, so a genuinely stuck model still
        // terminates.
        if (guardRetries < maxGuardRetries) {
          guardRetries += 1;
          batchHistory = [];
          // Re-audit finding 2 (2026-10-27): the nudge names the pattern
          // that actually fired with its own repeat count — the old
          // constant told the model "3 times in a row" on cycle and cap
          // fires, sending it hunting for the wrong pattern.
          context.push({
            role: "user",
            content: guardRetryText(cycleFired, repeats),
            timestamp: Date.now(),
          });
          yield {
            type: "guard_retry",
            turn,
            retry: guardRetries,
            maxRetries: maxGuardRetries,
            // Which pattern fired (audit re-fix 2026-10-27): the transcript
            // must not claim "3× in a row" when an alternating cycle fired;
            // the fired guard's own count rides along (re-audit 2026-10-27)
            // so the line states the true size, not a hard-coded 3.
            reason: cycleFired ? "cycle" : "identical",
            repeats,
          };
          continue; // the nudge consumes no turn (it is not an LLM call)
        }
        stopReason = "loop";
        // D33: name the trigger. The batch/pattern + `guardRetries` are
        // already in scope at the stop site — the evidence rides out on
        // agent_end. The cycle guard reports the pattern's two signatures;
        // the identical guard, the repeated batch (unchanged shape).
        // `repeats` = issued batches in the pattern including the refused
        // one (one counting unit for both guards); `stable` distinguishes
        // stuck from cap stops; `capReason` explains cap stops honestly
        // ("failed" repeats are not "changing results").
        guardEvidence = cycleFired
          ? {
              guard: "cycle-batch",
              signature: batchHistory.length >= 2
                ? `${batchHistory[n - 1]!.sig}\u0001${signature}`
                : signature,
              cycleLength: CYCLE_PATTERN_LEN,
              repeats,
              stable: !capFired,
              ...(capReason !== undefined ? { capReason } : {}),
              guardRetries,
            }
          : {
              guard: "identical-batch",
              signature,
              repeats,
              stable: !capFired,
              ...(capReason !== undefined ? { capReason } : {}),
              guardRetries,
            };
        break;
      }
    }
    // Not executed by a guard: the batch runs below and is recorded WITH
    // its result digest once execution completes (see the results loop
    // after `runOne`). The length guard records SYNTHETIC_FILL_DIGEST
    // above; there is no other path between here and the results loop.

    // §4.1 guard: truncated args may parse yet be incomplete — never execute.
    if (message.stopReason === "length") {
      for (const call of calls) {
        yield { type: "tool_execution_start", toolCall: call };
      }
      for (const call of calls) {
        const msg = resultMessage(
          call,
          {
            content: [{ type: "text", text: LENGTH_GUARD_TEXT }],
            // F1 (docs/08 §9): synthetic in-band fill — never executed (the
            // §4.1 rule: truncated args may not run), so never ground
            // contact for A3's bash reset.
            details: { notExecuted: true },
          },
          true,
        );
        context.push(msg);
        yield { type: "tool_execution_end", toolCallId: call.id, result: msg };
      }
      // Audit v2: a length-guarded batch never ran and its fill text is a
      // constant — record the synthetic digest so the SAME truncated batch
      // repeating still trips the guard (3rd stable repeat). Recorded as a
      // FAILED batch (re-audit finding 1, 2026-10-27): this is the same
      // synthetic in-band answer the unknown-tool/throw paths record as
      // failed, and the cycle guard's stable rule exempts failed records —
      // with failed:false here, alternating truncated batches [A,B,A,B] fed
      // the stable cycle rule their constant fill digest and the 5th batch
      // was refused (a stable cycle stop) although ZERO calls had run and
      // no real results ever repeated. The identical rule still fires on
      // these records (repeat with no new information, as documented).
      pushHistory(signature, JSON.stringify([SYNTHETIC_FILL_DIGEST]), true);
      continue; // the model re-issues on the next turn
    }

    // Batch-shape guard (see planBatch above): trim oversized batches and
    // collapse intra-batch exact duplicates BEFORE dispatch. Skipped calls
    // get synthetic in-band error results below (I3: every call gets a
    // result; F1: `notExecuted` so a skip is never mistaken for ground
    // contact). The trimmed batch — never the raw response — feeds the
    // signature, dispatch, results, digest, and history.
    const planned = planBatch(calls);
    const execCalls = planned.executable;

    const sequential = execCalls.some(
      (c) => byName.get(c.name)?.executionMode === "sequential",
    );

    for (const call of execCalls) {
      yield { type: "tool_execution_start", toolCall: call };
    }

    const results = new Map<string, { result: ToolResult; isError: boolean }>();
    const updates = new Map<string, string[]>();
    // 2026-10-28 audit fix: how many calls this batch skipped because an
    // earlier sequential call stalled (the honest "was prevented from
    // running" count; the stall banner names it when > 0).
    let skippedByStall = 0;
    const runOne = async (call: ToolCallBlock): Promise<void> => {
      const tool = byName.get(call.name);
      if (!tool) {
        results.set(call.id, {
          result: {
            content: [{ type: "text", text: `Tool "${call.name}" not found.` }],
            // F1 (docs/08 §9): no tool to run — never executed (counts as a
            // failure for B, but a not-found `bash` is not a measurement).
            details: { notExecuted: true },
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
      // 2026-10-28 audit fix — stall-aware sequential dispatch: once a
      // call in the batch returns `details.stall`, the run is already
      // decided, so every LATER call in this batch is skipped with a
      // synthetic in-band result (I3: every call gets a result; F1:
      // `notExecuted` so the skip is never mistaken for ground contact).
      // Parallel batches cannot do this — their calls are in flight
      // before any result exists (the honest limit, documented in the
      // module header); sequential mode ("any sequential tool opts the
      // whole batch in") is the deterministic lane.
      let stallSeen = false;
      for (const call of execCalls) {
        // The stall can come from a guard the LOOP itself synthesizes
        // (unknown tool / I3 throw inside runOne carry details too when a
        // custom executor sets them); check the stored result before
        // skipping anything.
        if (stallSeen) {
          results.set(call.id, {
            result: {
              content: [{ type: "text", text: stallSkipText(call.name) }],
              isError: true,
              details: { notExecuted: true, stallSkipped: true },
            },
            isError: true,
          });
          skippedByStall += 1;
          continue;
        }
        await runOne(call);
        if (results.get(call.id)?.result.details?.stall === true) {
          stallSeen = true;
        }
      }
    } else {
      // Qwen batch-shape fix: bound CONCURRENT parallel dispatch to
      // MAX_PARALLEL_CALLS. Oversized parallel groups run in follow-up
      // chunks of at most MAX_PARALLEL_CALLS, in call order; results still
      // land in call order below. Sequential batches are unaffected (they
      // already run strictly in order).
      for (let i = 0; i < execCalls.length; i += MAX_PARALLEL_CALLS) {
        await Promise.all(execCalls.slice(i, i + MAX_PARALLEL_CALLS).map((call) => runOne(call)));
      }
    }

    // Results (and their end events) always land in model call order.
    let allTerminate = true;
    let stalled = false;
    const digestParts: { digest: string; failure: boolean }[] = [];
    // Batch-shape skips get synthetic in-band results FIRST (never
    // dispatched), but everything downstream — context, end events, and the
    // guard history — iterates the ORIGINAL `calls` array, so results land
    // in model call order and the digest covers exactly the EXECUTED
    // subset (2026-10-29 audit fixes: skip records neither pad the digest
    // nor force batch failure; padding must not weaken loop guards).
    for (const skipped of planned.skipped) {
      results.set(skipped.call.id, {
        result: {
          content: [
            {
              type: "text" as const,
              text: skipped.duplicate ? DUPLICATE_CALL_TEXT : BATCH_TRIMMED_TEXT,
            },
          ],
          details: { notExecuted: true, batchSkipped: true },
        },
        isError: true,
      });
    }
    for (const call of calls) {
      const entry = results.get(call.id);
      const msg = resultMessage(
        call,
        entry?.result ?? { content: [{ type: "text", text: "(no result)" }] },
        entry?.isError ?? true,
      );
      // A batch-shape skip is synthetic: its in-band notice rides the
      // transcript and gets its end event IN CALL ORDER, but it is excluded
      // from the guard history (signature and digest cover the executed
      // subset only) and never informs terminate/stall.
      if (entry?.result.details?.batchSkipped === true) {
        context.push(msg);
        yield { type: "tool_execution_end", toolCallId: call.id, result: msg };
        continue;
      }
      digestParts.push({
        // A stall-skipped call is a synthetic in-band fill (never ran):
        // record it with the SYNTHETIC_FILL_DIGEST so a re-issued batch
        // still digests as constant and the cycle guard sees "failed,
        // exempt" records rather than fabricated per-call digests.
        digest:
          entry !== undefined && entry.result.details?.stallSkipped === true
            ? SYNTHETIC_FILL_DIGEST
            : resultEntryDigest(
                entry ?? {
                  result: { content: [{ type: "text", text: "(no result)" }] },
                  isError: true,
                },
              ),
        failure:
          entry !== undefined &&
          (entry.isError || entry.result.details?.notExecuted === true),
      });
      context.push(msg);
      for (const text of updates.get(call.id) ?? []) {
        yield { type: "tool_execution_update", toolCallId: call.id, text };
      }
      yield { type: "tool_execution_end", toolCallId: call.id, result: msg };
      if (!entry?.result.terminate) allTerminate = false;
      // Stall guard (tool pipeline): the same call failed 3× in a row with
      // a permission denial — the third repeat was answered in-band and NOT
      // executed. Stop the run; a new prompt (or a different approach)
      // breaks the pattern, so the run is resumable like "loop".
      if (entry?.result.details?.stall === true) {
        stalled = true;
        // D33: the pipeline names the trigger via details.stallEvidence
        // (absent on legacy/custom executors — evidence then stays
        // undefined and the display falls back to the static string).
        // First stall in the batch wins.
        const raw = entry.result.details.stallEvidence;
        if (
          guardEvidence === undefined &&
          raw !== null &&
          typeof raw === "object" &&
          "guard" in raw
        ) {
          guardEvidence = raw as GuardEvidence;
        }
      }
    }
    // A batch of ONLY synthetic skips never terminates (2026-10-29 audit:
    // with every member skipped there are no executed results to set the
    // flag, and silently breaking out would end the run without a stop
    // reason). Mixed batches are decided by their executed members alone.
    if (digestParts.length === 0) allTerminate = false;
    // 2026-10-28 audit fix: when the sequential stall-skip prevented calls
    // in this batch, say so on the evidence — the stall banner then states
    // the honest execution fact ("N further call(s) were skipped"). Only
    // the stall guards reach this point with evidence (the loop guards
    // break before dispatch), narrowed here for the type; legacy custom
    // executors without stallEvidence get no note (the headline makes no
    // execution claim either way).
    if (
      guardEvidence !== undefined &&
      skippedByStall > 0 &&
      guardEvidence.guard !== "identical-batch" &&
      guardEvidence.guard !== "cycle-batch"
    ) {
      guardEvidence = { ...guardEvidence, skipped: skippedByStall };
    }
    // Audit v2: record this executed batch (signature + result digest +
    // failure flag) for the loop/cycle guards. Digest parts are in call
    // order, matching the signature; JSON-encoded so block-boundary text
    // cannot collide. A batch is "failed" when any call errored OR was
    // answered synthetically in-band (unknown tool / I3 throw — never
    // executed): the cycle rule exempts those (the stall guards' domain).
    pushHistory(
      signature,
      JSON.stringify(digestParts.map((part) => part.digest)),
      digestParts.some((part) => part.failure),
    );
    if (stalled) {
      stopReason = "stall";
      break;
    }
    if (allTerminate) break;
    if (signal.aborted) {
      stopReason = "aborted";
      break;
    }

    // ── F1 (docs/08 §9, D32) — no-progress evaluation ────────────────────
    // Only an EXECUTED batch reaches this point: every guard path above
    // (loop, stall, length, abort, error) continues or breaks first, so the
    // synthetic in-band results never feed the counters. The nudge rides the
    // context AFTER the batch's results are all in it (I3 untouched); the
    // stop happens after the batch completed normally.
    {
      // Variant B — the turn's batch was non-empty and ALL results failed.
      // A success is ground truth: it resets the streak AND the ladder
      // (a later episode starts a fresh ladder).
      if (calls.length > 0) {
        let allFailed = true;
        for (const call of calls) {
          if (!results.get(call.id)?.isError) {
            allFailed = false;
            break;
          }
        }
        if (allFailed) noSuccessStreak += 1;
        else {
          noSuccessStreak = 0;
          progressNudges.delete("no-success");
          progressFired.delete("no-success");
        }
      }

      // Variant A3 — same-target edits with no executed bash in between.
      // In call order, so [edit x, bash] measures the edit; the reset keys
      // on EXECUTION (a failing `npm test` is precisely a measurement), so a
      // call the gate never ran (`details.notExecuted`) neither resets nor
      // counts. `read` never counts (progressTargetOf).
      let unverified: { target: string; count: number } | undefined;
      for (const call of calls) {
        if (results.get(call.id)?.result.details?.notExecuted === true) continue;
        if (call.name === "bash") {
          unverifiedEdits.clear(); // ground contact is global
          // Audit fix: an executed bash LATER in this same batch cancels a
          // threshold crossed earlier in it — [edit x ×4, bash] measured
          // the edits, so the turn must not fire (letting a stale candidate
          // through would stop a run in "stop" mode despite the
          // measurement). Only edits AFTER the bash re-arm the detection.
          unverified = undefined;
          progressNudges.delete("no-verification");
          progressFired.delete("no-verification");
          continue;
        }
        const effectiveTarget = results.get(call.id)?.result.details?.progressTarget;
        const target =
          (call.name === "write" || call.name === "edit") && typeof effectiveTarget === "string"
            ? resolve(effectiveTarget)
            : progressTargetOf(call);
        if (target === undefined) continue;
        const count = (unverifiedEdits.get(target) ?? 0) + 1;
        unverifiedEdits.set(target, count);
      }
      // Evaluate outstanding state, not just edits in this turn. When B
      // wins the single-action slot, A3 must survive to a later read-only
      // turn. An executed bash above clears the map, cancelling stale hits.
      for (const [target, count] of unverifiedEdits) {
        if (count >= UNVERIFIED_EDITS) unverified = { target, count };
      }

      // One ladder, both variants; first detection in the turn wins (the
      // other is re-detected next turn if it is still true). The event fires
      // in EVERY mode — it is the observation channel /stats_progress counts.
      type F1Action = {
        kind: ProgressKind;
        count: number;
        target?: string;
        inject?: string;
        stop?: boolean;
        /** Emit the progress_nudge event (once per episode — see below). */
        announce: boolean;
      };
      let action: F1Action | undefined;
      const consider = (kind: ProgressKind, count: number, target?: string) => {
        if (action !== undefined) return; // one action per turn
        // One ANNOUNCEMENT (event) per episode: ground truth clears the flag,
        // so a later episode re-announces; a persisting condition does not
        // spam. The event fires in every mode/configuration — it is the
        // observation channel /stats_progress counts.
        const announce = progressFired.get(kind) !== true;
        progressFired.set(kind, true);
        const given = progressNudges.get(kind) ?? 0;
        // The stop check comes FIRST: recurrence after the ladder is spent
        // (with no intervening ground truth — ground truth deletes the entry)
        // stops the run. `maxProgressNudges: 0` stops on the FIRST hit (the
        // H5 convention) — the announcement still rides along.
        if (progressMode === "stop" && given >= maxProgressNudges) {
          action = { kind, count, target, stop: true, announce };
          return;
        }
        if (progressMode === "watch" || given >= maxProgressNudges) {
          // "watch": pure observation — event only, nothing else. "nudge"
          // with the ladder spent: nothing left to inject (the stop is
          // disabled there) — silence until ground truth.
          action = announce ? { kind, count, target, announce } : undefined;
          return;
        }
        // "nudge"/"stop" with ladder budget left: inject the approach-
        // changing nudge (context-only, like the budget/guard-retry nudges).
        progressNudges.set(kind, given + 1);
        action = {
          kind,
          count,
          target,
          announce,
          inject:
            kind === "no-success"
              ? NO_SUCCESS_NUDGE_TEXT
              : noVerificationNudgeText(target ?? "", count),
        };
      };
      if (noSuccessStreak >= NO_SUCCESS_TURNS) consider("no-success", noSuccessStreak);
      if (unverified !== undefined)
        consider("no-verification", unverified.count, unverified.target);

      if (action !== undefined) {
        if (action.announce) {
          yield {
            type: "progress_nudge",
            turn,
            kind: action.kind,
            mode: progressMode,
            ...(action.target !== undefined ? { target: action.target } : {}),
            count: action.count,
          };
        }
        if (action.stop === true) {
          progressStop = { kind: action.kind, count: action.count };
          stopReason = "progress";
          break;
        }
        if (action.inject !== undefined) {
          context.push({ role: "user", content: action.inject, timestamp: Date.now() });
        }
      }
    }
  }

  yield {
    type: "agent_end",
    stopReason,
    messages: context,
    ...(stopReason === "budget" ? { maxTurns, maxCycles } : {}),
    ...(guardEvidence !== undefined ? { evidence: guardEvidence } : {}),
    ...(progressStop !== undefined ? { progress: progressStop } : {}),
  };
}

/** C26 — default auto-continuations per run (4 cycles total). */
export const DEFAULT_MAX_CONTINUATIONS = 3;
