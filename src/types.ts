/**
 * WS0 — the three contracts that decouple the workstreams.
 *
 *   1. AgentMessage (+ ContentBlock, Usage, StopReason) — the shared,
 *      provider-neutral message language of wire, loop, session, and UI.
 *   2. AgentEvent / AssistantStreamEvent — the event vocabulary.
 *   3. StreamFn + Tool — the loop's only two dependencies.
 *
 * L2: structure adapted from @earendil-works/pi-agent-core 0.85.1 (MIT,
 *      © Mario Zechner) — the provider-neutral message model (ContentBlock
 *      union, Usage, StopReason), the event vocabulary (AssistantStreamEvent
 *      with `partial` on every event; AgentEvent), and the Tool protocol
 *      (execute(toolCallId, args, signal, onUpdate), error-as-result) —
 *      docs/01 §3–5, §9 "Copy" / "Copy exactly".
 *      Simplified: no bashExecution/custom/branchSummary message kinds, no
 *      per-tool usage, no cost tracking, no prepareArguments.
 *      Added: StopReason "budget"/"loop"/"stall" (C26 + stall detection),
 *      `details` on tool results.
 *
 * Invariants (see docs/02-contracts.md):
 *   I1. Everything the model sees is a message; everything it can do is a
 *       tool; results flow back through the same message channel.
 *   I2. Every streaming event carries `partial` — the full in-progress
 *       assistant message — so one context slot is always consistent.
 *   I3. No exceptions cross module boundaries: failures become data
 *       (stopReason "error", isError tool results).
 */

// ──────────────────── 1. Messages (provider-neutral) ────────────────────

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  /** Provider-generated id; the wire layer normalizes length/charset. */
  id: string;
  name: string;
  /**
   * Parsed arguments. On in-flight (partial) messages this is best-effort
   * (may be {} mid-stream); only the parse on the `done` message is
   * authoritative. The wire layer owns JSON parse + salvage.
   */
  arguments: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface Usage {
  input: number;
  output: number;
  /** Prompt tokens served from cache, when the endpoint reports it. */
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens: number;
}

/**
 * Why an assistant message ended. Mirrors the wire's finish_reason:
 *   stop     — model finished normally
 *   length   — hit the output token cap (tool-call args may be truncated!)
 *   toolUse  — model wants to call tools
 *   error    — provider/transport failure; see errorMessage
 *   aborted  — AbortSignal fired; the partial is kept in context
 *   budget   — C26: EVERY cycle's turn budget was exhausted (the loop
 *              auto-continues per cycle; this is the final stop); set by
 *              the LOOP (never a wire finish_reason); the run is resumable
 *   loop     — C26: the model issued the same tool-call batch 3 times in
 *              a row (runaway-loop detection); the third repeat was not
 *              executed; set by the LOOP; the run is resumable
 *   stall    — the same tool failed 3 times with a permission denial
 *              (Operation not permitted / permission denied — the
 *              deterministic sandbox wall) within its last 8 calls (docs/08
 *              H1: windowed — interleaved successes do not reset); the
 *              failing call was not executed; set by the LOOP (from the
 *              tool pipeline's `stall` detail); the run is resumable
 */
// F1 (docs/08 §9, D32): "progress" = the no-progress detector stopped a run
// that kept acting without measuring (zero-success turns, or same-target
// edits with no executed bash between). Distinct from "loop" on purpose:
// H5's auto-retry is scoped to the identical-batch guard, and a reader must
// not conflate the two. Resumable like budget/loop/stall.
export type StopReason =
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "budget"
  | "loop"
  | "stall"
  | "progress";

/** F1 (docs/08 §9) — which no-progress condition fired. */
export type ProgressKind = "no-success" | "no-verification";

/** F1 rollout ladder (docs/08 §9): watch = observe only (the landing
 *  default), nudge = inject the context message, stop = the full ladder. */
export type ProgressMode = "watch" | "nudge" | "stop";

export interface UserMessage {
  role: "user";
  /** MVP: plain text. (Images etc. would extend this to ContentBlock[].) */
  content: string;
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  /** Ordered blocks, as the model emitted them (text and tool calls interleaved). */
  content: ContentBlock[];
  /** Model id as requested on the wire. */
  model: string;
  /** Provider label, e.g. "vks-llama". */
  provider: string;
  stopReason: StopReason;
  /** Set when stopReason === "error". */
  errorMessage?: string;
  usage?: Usage;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  /** Links to the ToolCallBlock.id this result answers. */
  toolCallId: string;
  toolName: string;
  /** MVP: text only. */
  content: TextBlock[];
  /** True when the tool failed. The text is what the model reads and reacts to. */
  isError?: boolean;
  /** Structured extras, e.g. { truncated: true, fullOutputPath: "…" }. */
  details?: Record<string, unknown>;
  timestamp: number;
}

/** The provider-neutral message type. The loop's context is AgentMessage[]. */
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

/**
 * D19 — file-access tools the UI stays silent about ON SUCCESS. A call is
 * shown only when it is DENIED (isError) — a whitelist denial is the only
 * directory-access news worth a line. Both consumers are the TUI
 * (state.ts: hidden item, unhidden or dropped on end) and the plain CLI
 * (printEvent: no start line, end line only on isError). bash is NOT here:
 * its command line is the approval surface.
 */
export const QUIET_ON_SUCCESS_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit"]);

// ───────────────────────────── 2. Events ─────────────────────────────

/**
 * Emitted by a StreamFn while one assistant message is generated.
 * `start` is always first, `done` always last; every event carries the
 * full in-progress assistant message (I2).
 */
export type AssistantStreamEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_delta"; delta: string; partial: AssistantMessage }
  | { type: "thinking_delta"; delta: string; partial: AssistantMessage }
  | {
      type: "toolcall_start";
      /** Position of this call within the response's tool_calls array. */
      index: number;
      id?: string;
      name?: string;
      partial: AssistantMessage;
    }
  | {
      type: "toolcall_delta";
      index: number;
      /** Raw JSON argument fragment (arguments arrive as string chunks). */
      argsDelta: string;
      partial: AssistantMessage;
    }
  | { type: "done"; message: AssistantMessage };

/**
 * D33 (docs/08 §10) — the evidence a guard stop was triggered by. One
 * discriminated union, shared by the `agent_end.evidence` event field, the
 * session `guardStop` entry, and the display lines. The privacy position:
 * signatures and excerpts are tool arguments/errors ALREADY persisted in
 * the session's message entries — this adds naming, not disclosure.
 * `errorExcerpt` is capped at excerpt() size for the persisted form;
 * display truncates further.
 */
export type GuardEvidence =
  | {
      /** C26 identical-batch guard → stopReason "loop". */
      guard: "identical-batch";
      /** batchSignature() output of the repeated batch. */
      signature: string;
      /** Total batches ISSUED in the pattern including the refused one:
       *  3 for a stuck (stable-result) repeat, POLL_CAP when fresh-result
       *  polling hit the hard cap. */
      repeats: number;
      /** true = the repeats stopped bringing new results (stuck loop);
       *  false = the run was stopped only by the polling cap (results may
       *  still have been changing — see `capReason`). */
      stable: boolean;
      /** Cap stops only (stable false, optional on old sessions): WHY the
       *  cap fired when "results stopped changing" is not the whole truth —
       *  fresh = every repeat brought new results; failed = the repeats
       *  were failing early exits (the stall guards' domain). */
      capReason?: "fresh" | "failed";
      /** H5 auto-retries spent before the stop (0 = legacy hard stop). */
      guardRetries: number;
    }
  | {
      /** C26 cycle guard (audit 2026-10-31) → stopReason "loop": the same
       *  ALTERNATING 2-batch pattern issued repeatedly. When `stable`, the
       *  pattern's results repeated too (no new information); otherwise the
       *  run hit the CYCLE_CAP alternation cap. */
      guard: "cycle-batch";
      /** The two batch signatures of the repeating pattern, joined with
       *  \u0001 (each batch signature joins its calls with \u0000). */
      signature: string;
      /** The pattern's cycle length (always 2 today). */
      cycleLength: number;
      /** Total batches ISSUED in the pattern including the refused one
       *  (5 for the stable stop [X, Y, X, Y, X]; CYCLE_CAP at the cap).
       *  Counting unit shared with identical-batch `repeats` — one unit,
       *  issued batches, everywhere. */
      repeats: number;
      /** true = stable (stuck) stop; false = cap-exhaustion stop. */
      stable: boolean;
      /** Cap stops only (see the identical-batch variant). */
      capReason?: "fresh" | "failed";
      /** H5 auto-retries spent before the stop (0 = legacy hard stop). */
      guardRetries: number;
    }
  | {
      /** H1 permission-stall guard → stopReason "stall". */
      guard: "permission-stall";
      tool: string;
      /** Permission denials of this tool inside `window` calls. */
      denials: number;
      /** STALL_WINDOW (8). */
      window: number;
      /** Raw denial text (one line, capped). */
      errorExcerpt: string;
    }
  | {
      /** H2 repeat-failure guard → stopReason "stall". */
      guard: "repeat-failure";
      tool: string;
      repeats: number;
      /** REPEAT_FAILURE_WINDOW (8). */
      window: number;
      /** Normalized error text (capped). */
      errorExcerpt: string;
    };

/**
 * The loop's event stream — what the CLI prints and the session persists.
 * Wire events pass through unchanged; the loop adds lifecycle + tool events.
 */
export type AgentEvent =
  | { type: "agent_start" }
  | {
      type: "agent_end";
      /** stopReason of the last assistant message. */
      stopReason: StopReason;
      /** Final context — what the session layer appends to the JSONL file. */
      messages: AgentMessage[];
      /**
       * Present when stopReason === "budget": the per-CYCLE cap that was
       * hit (so the UI can name it). A new prompt starts a new run with a
       * fresh count.
       */
      maxTurns?: number;
      /**
       * Present when stopReason === "budget": how many cycles the run got
       * (maxContinuations + 1) — the UI says "max N turns × M cycles
       * reached".
       */
      maxCycles?: number;
      /**
       * D33 (docs/08 §10): present exactly when stopReason is "loop" or
       * "stall" — WHICH trigger fired (the repeated batch's signature, or
       * the tool + denial count + error excerpt). Same conditional-field
       * pattern as maxTurns/maxCycles. The driver persists it (guardStop
       * session entry) and the display interpolates it; the loop is the
       * only producer.
       */
      evidence?: GuardEvidence;
      /**
       * F1 (docs/08 §9, D32): present exactly when stopReason === "progress"
       * — which no-progress condition stopped the run and the count that
       * crossed the threshold. Same conditional-field pattern as
       * maxTurns/maxCycles (budget) and evidence (loop/stall).
       */
      progress?: { kind: ProgressKind; count: number };
    }
  | {
      /**
       * C26 — a cycle's turn budget was exhausted and the loop auto-
       * continues (counter reset). Informational, not an error: the run
       * keeps going. Emitted by the loop between turns.
       */
      type: "turn_budget";
      /** Turn counter at the moment of exhaustion. */
      turn: number;
      /** Continuation number, 1-based (1 = the 2nd cycle begins). */
      cycle: number;
      /** Total cycles allowed (maxContinuations + 1). */
      maxCycles: number;
      /** The per-cycle cap that was exhausted. */
      maxTurns: number;
    }
  | {
      /**
       * The loop guard (same tool-call batch 3× in a row) fired, but the run
       * is auto-retrying INSTEAD of stopping: the loop injected an
       * approach-changing nudge and reset the identical-batch history so the
       * model gets one fresh window. Bounded (see the loop's
       * `DEFAULT_MAX_GUARD_RETRIES`): at the cap the run stops with
       * stopReason "loop" as before. Informational, not an error — the run
       * keeps going. Emitted by the loop at the guard site.
       */
      type: "guard_retry";
      /** Turn counter at the moment the guard fired. */
      turn: number;
      /** Retry number, 1-based (1 = the first autonomous retry). */
      retry: number;
      /** Total autonomous retries allowed before the run stops. */
      maxRetries: number;
      /** loop-v2 (audit re-fix 2026-11-02): WHICH pattern fired, so the
       *  transcript line never claims "3× in a row" for an alternating
       *  cycle fire. Optional: producers from before loop-v2 omit it and
       *  the display falls back to the generic "repeated batch". */
      reason?: "identical" | "cycle";
      /** Re-audit fix (2026-11-02): the fired guard's own repeat count —
       *  batches ISSUED including the refused one (the evidence's unit: 3
       *  identical-stable, 5 alternating-stable, the caps otherwise) — so
       *  the transcript states the true size instead of a hard-coded "3×".
       *  Optional on legacy producers (then the line makes no count claim). */
      repeats?: number;
    }
  | {
      /**
       * F1 (docs/08 §9, D32) — a no-progress condition was detected. Fires in
       * ALL modes (including "watch" — that is the observation channel);
       * mode says where the ladder stood, so telemetry can attribute fires.
       * Informational, not an error: in "watch"/"nudge" the run keeps going.
       */
      type: "progress_nudge";
      turn: number;
      kind: ProgressKind;
      /** The mode the run was in when the condition fired. */
      mode: ProgressMode;
      /** Normalized target path — only for "no-verification". */
      target?: string;
      /** The count that crossed the threshold (turns, or edits of target). */
      count: number;
    }
  | { type: "turn_start"; turn: number }
  | { type: "turn_end"; turn: number }
  | {
      /**
       * Steering: guidance the user typed while a run was in flight. The
       * driver queued it; the loop delivered it as a user message into the
       * context just before this LLM call. `message` is the EXACT object
       * pushed into the context — the driver persists that object (WS9:
       * session entry ids are keyed by message identity, so a compaction
       * whose first kept message is a steer must find its id). Informational
       * for the UI (it already echoed the line at submit time — a NO-OP in
       * applyEvent).
       */
      type: "steer";
      turn: number;
      text: string;
      message: UserMessage;
    }
  | { type: "tool_execution_start"; toolCall: ToolCallBlock }
  | { type: "tool_execution_update"; toolCallId: string; text: string }
  | { type: "tool_execution_end"; toolCallId: string; result: ToolResultMessage }
  | {
      /** D10 (WS9): the CLI's compaction hook replaced the context between
       *  LLM turns. Emitted by the CLI (runTurn), not by the loop. */
      type: "context_compacted";
      tokensBefore: number;
      messagesKept: number;
      summaryChars: number;
      /** Estimated tokens of the NEW context ([summary, …kept]) — what the
       *  next prompt starts from (estimateTokens; chars/4). */
      contextTokens?: number;
      /** D (failure escalation): the summary call failed twice and the
       *  context was shrunk by the rule-based fallback (no LLM summary). */
      degraded?: boolean;
      /** The compacted context is a strict reduction of the history but
       *  still exceeds the model's input budget (the kept tail is atomic —
       *  indivisible tool-call/result units can't be shrunk). It was kept
       *  anyway: smaller than before, larger than the budget. */
      overBudget?: boolean;
    }
  | {
      /** The compaction trigger fired (or was forced) but nothing could be
       *  compacted — the context is UNCHANGED. Carries the reason (the TUI
       *  renders it as a note item; the CLI prints it to stderr). Without
       *  this event the TUI's skip note was swallowed (compactNow writes to
       *  its sinks, which the TUI nulls out) and the user saw no sign that
       *  the context was left uncompacted. */
      type: "compaction_skipped";
      reason: string;
    }
  | AssistantStreamEvent;

/**
 * One-line explanation of a run that ended with stopReason "length".
 * The wording must be accurate for BOTH failure modes: the last assistant
 * message may hold a tool call whose arguments were truncated, or the model
 * may have spent the whole output budget on thinking/text and emitted NO
 * call at all (thinking models with a small maxTokens). The UI must not
 * claim one when the other is what happened.
 */
export function lengthEndNote(messages: AgentMessage[]): string {
  const lastAsst = [...messages].reverse().find((m) => m.role === "assistant");
  const hadCall =
    lastAsst !== undefined && lastAsst.content.some((b) => b.type === "toolCall");
  return hadCall
    ? "length: output limit hit — tool-call arguments may be truncated"
    : "length: output limit hit — response cut off before any tool call (thinking/text consumed the output budget)";
}

/** D33 (docs/08 §10) — the display's one-line evidence summary, shared by
 *  the TUI error item and the CLI stderr stop line: loop → the repeated
 *  batch's first line (tool + truncated args); stall → tool + count/window
 *  + the error excerpt. The signature part is hard-clamped to ~110 chars;
 *  with the static affixes the whole line stays within one terminal line
 *  for realistic triggers (~180 chars max). Exported for tests. */
export function guardEvidenceNote(evidence: GuardEvidence): string {
  const clip = (s: string, max: number): string =>
    s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
  if (evidence.guard === "identical-batch") {
    // batchSignature joins calls with \u0000; "name:json" may itself embed
    // newlines (string args). Show the FIRST call, flattened to one line.
    // `repeats` = batches issued incl. the refused one (3 stable, POLL_CAP
    // capped); the suffix says which — cap never claims "changing results"
    // (failed repeats digest as constant too), and legacy evidence without
    // `stable` (pre-loop-v2 sessions) makes no results claim either.
    const firstCall = (evidence.signature.split("\u0000", 1)[0] ?? "").replace(
      /[\n\r]+/g,
      " ",
    );
    const mode =
      evidence.stable === true
        ? `×${evidence.repeats} identical, same results`
        : evidence.stable === false
          ? `stopped at the ${evidence.repeats}-repeat cap`
          : `×${evidence.repeats} identical`;
    return `trigger: ${clip(firstCall, 110)} (${mode}${
      evidence.guardRetries > 0 ? `, after ${evidence.guardRetries} auto-retr${evidence.guardRetries > 1 ? "ies" : "y"}` : ""
    })`;
  }
  if (evidence.guard === "cycle-batch") {
    // The cycle guard's signature is the pattern's batches joined with
    // \u0001 (each batch signature joins its calls with \u0000): show the
    // first call of each pattern position, one flattened line. Same
    // counting unit as identical-batch: `repeats` = batches issued incl.
    // the refused one (5 stable, CYCLE_CAP capped).
    const parts = evidence.signature.split("\u0001");
    const shown = parts
      .map((p) => (p.split("\u0000", 1)[0] ?? "").replace(/[\n\r]+/g, " "))
      .map((p) => clip(p, 60));
    const mode =
      evidence.stable === true
        ? `alternating ×${evidence.repeats} batches, same results`
        : evidence.stable === false
          ? `stopped at the ${evidence.repeats}-alternating-batch cap`
          : `alternating ×${evidence.repeats} batches`;
    return `trigger: ${shown.join(" ⇄ ")} (${mode}${
      evidence.guardRetries > 0 ? `, after ${evidence.guardRetries} auto-retr${evidence.guardRetries > 1 ? "ies" : "y"}` : ""
    })`;
  }
  const count =
    evidence.guard === "permission-stall"
      ? `${evidence.denials}/${evidence.window} calls`
      : `${evidence.repeats}/${evidence.window} calls`;
  return `trigger: ${clip(evidence.tool, 30)} failed ${count}${
    evidence.errorExcerpt !== "" ? ` — ${clip(evidence.errorExcerpt, 90)}` : ""
  }`;
}

/** C26 loop-v2 (audit re-fix 2026-11-02) — the evidence-driven loop-stop
 *  headline, shared by the CLI banner and the TUI notice. The old
 *  hard-coded "repeated the same tool call(s) 3 times in a row" lied for
 *  cycle stops (an ALTERNATING pattern) and cap stops (12 issued batches,
 *  results possibly still changing — or failing, which digests as
 *  constant). `repeats` is one counting unit everywhere: batches ISSUED
 *  in the pattern including the refused one. Three-way phrasing, never
 *  over-claiming: stable → results stopped changing; cap (stable false) →
 *  repeating is bounded, no claim about results (fresh polls AND failed
 *  repeats digest the same way — the stall guards own failures); legacy
 *  evidence without `stable` (pre-evidence sessions) → generic phrasing. */
export function loopStopNote(evidence?: GuardEvidence): string {
  // Restrict to the loop guard variants (stall evidence never reaches this
  // display path, and only these variants carry stable/guardRetries).
  const loopEv =
    evidence?.guard === "identical-batch" || evidence?.guard === "cycle-batch"
      ? evidence
      : undefined;
  const isCycle = loopEv?.guard === "cycle-batch";
  const pattern = isCycle
    ? "the same two tool-call batches alternated"
    : "the model repeated the same tool call(s)";
  const count = loopEv
    ? `${loopEv.repeats} times${isCycle ? " (X, Y, X, Y, X …)" : " in a row"}`
    : "the same tool call(s) repeatedly";
  const retry =
    loopEv !== undefined && loopEv.guardRetries > 0
      ? ` after ${loopEv.guardRetries} auto-retr${loopEv.guardRetries === 1 ? "y" : "ies"}`
      : "";
  if (loopEv?.stable === true) {
    return `loop: ${pattern} ${count} with no change in results — stopped to avoid a runaway loop${retry} (the repeat was not executed)`;
  }
  if (loopEv !== undefined && loopEv.stable === false) {
    // Honest cap phrasing: never "changing results" — see the union docs.
    return `loop: ${pattern} ${count} without progress — repeating is bounded, so the loop stopped${retry} (this repeat was not executed)`;
  }
  // Legacy evidence without `stable` (pre-loop-v2 sessions): the count is
  // known but no claim about results either way.
  if (loopEv !== undefined) {
    return `loop: ${pattern} ${count} — stopped to avoid a runaway loop${retry} (the repeat was not executed)`;
  }
  return `loop: ${pattern} — stopped to avoid a runaway loop (the repeat was not executed)`;
}

/** Re-audit fix (2026-11-02) — the shared `guard_retry` transcript line for
 *  the CLI and the TUI. The old hard-coded "same tool call 3× in a row"
 *  lied on every non-identical-3 fire: an alternating cycle fire (5
 *  batches issued), any cap fire (12), and a legacy producer that gives no
 *  pattern at all. The count is the event's `repeats` (issued batches
 *  including the refused one — the evidence's unit); without it the line
 *  makes no count claim. Returns the sentence WITHOUT the trailing
 *  "(retry N/M)" suffix (each surface appends its own). */
export function guardRetryNote(
  reason?: "identical" | "cycle",
  repeats?: number,
): string {
  const pattern =
    reason === "cycle"
      ? "loop guard fired (two tool-call batches alternating"
      : reason === "identical"
        ? "loop guard fired (same tool call(s) repeated"
        : "loop guard fired (repeated tool-call batch";
  const count = repeats !== undefined ? `, ${repeats} batches issued incl. the refused one)` : ")";
  return `${pattern}${count} — retrying with a changed approach`;
}

// ─────────────────── 3. The loop's two dependencies ───────────────────

/** What one LLM call needs. Built by the loop; consumed by the wire layer. */
export interface LlmContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: Tool[];
}

/**
 * The loop's only dependency on the wire layer.
 * Owns: HTTP + bounded retry + abort, request building, SSE parse,
 * tool-call argument accumulation + best-effort JSON salvage, usage capture.
 * Does not own: context management, tool dispatch, anything loop-shaped.
 * Must end with exactly one `done` event — even on failure (I3).
 */
export type StreamFn = (
  model: ModelConfig,
  ctx: LlmContext,
  opts: { apiKey?: string; signal: AbortSignal },
) => AsyncIterable<AssistantStreamEvent>;

export interface ToolResult {
  content: TextBlock[];
  /**
   * Set by the tool pipeline (WS3) when the call failed (invalid args,
   * blocked by a hook, tool error). The loop marks the ToolResultMessage
   * `isError` accordingly — I3: tool failures are data, not exceptions (D7).
   */
  isError?: boolean;
  /** Surfaced on the ToolResultMessage.details of the matching message. */
  details?: Record<string, unknown>;
  /** If true on every result of a batch, the loop stops after the batch. */
  terminate?: boolean;
}

/**
 * The loop's tool-execution seam (Contract 4). Defaults in the loop to
 * `tool.execute` directly; WS3's full pipeline (validate → beforeToolCall →
 * execute → afterToolCall) is injected here so the loop stays decoupled
 * from the tool system. Lives in types.ts (not the loop) so the tools
 * layer can implement it without depending on the loop layer.
 */
export type ExecuteToolCall = (
  tool: Tool,
  call: ToolCallBlock,
  signal: AbortSignal,
  onUpdate?: (text: string) => void,
) => Promise<ToolResult>;

/** The loop's only dependency on tools. */
export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for `execute`'s `args`; sent to the LLM verbatim. */
  parameters: JsonSchema;
  /** "sequential" forces the whole batch to run in call order. Default parallel. */
  executionMode?: "parallel" | "sequential";
  /**
   * Must never throw for expected failures — return a result whose text
   * describes the failure (I3). Must honor `signal` (abort mid-flight).
   */
  execute(
    toolCallId: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    /** Optional progress callback (long-running tools). */
    onUpdate?: (text: string) => void,
  ): Promise<ToolResult>;
}

/** Minimal JSON Schema (zero dependencies). */
export interface JsonSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: (string | number)[];
  [key: string]: unknown;
}

// ─────────────────────── Model catalog (models.json) ───────────────────────

/**
 * Per-model compat flags absorb endpoint differences so the wire layer
 * stays one code path. Start with what llama.cpp needs; grow as new
 * endpoints are added.
 */
export interface ModelCompat {
  /** Wire field for the output cap. Default "max_tokens". */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** false → omit stream_options.include_usage. Default true. */
  supportsUsageInStreaming?: boolean;
  /** Insert a synthetic assistant message after tool results, before a user message. */
  requiresAssistantAfterToolResult?: boolean;
  /**
   * true → send a top-level `cache_control: { type: "ephemeral" }` in every
   * chat/completions request. OpenRouter's automatic prompt caching: the
   * provider applies the breakpoint to the last cacheable block and advances
   * it as the conversation grows. REQUIRED for Anthropic models (they never
   * cache implicitly — without it nothing is written to the cache); harmless
   * to omit elsewhere. Leave unset for all other endpoints.
   */
  promptCaching?: boolean;
  /** Merged verbatim into every request body (e.g. enable_thinking). */
  extraParams?: Record<string, unknown>;
  /**
   * true → the wire layer repairs llama.cpp's leaked Qwen chat-template
   * closing markers (`</parameter>`, `</function>`, `</tool_call>`) in streamed
   * tool-call argument JSON. Off by DEFAULT: valid JSON arguments are
   * applied VERBATIM, because a string value legitimately ending in one of
   * those tags (a file write, an edit target, an XML fixture) is
   * indistinguishable from a leak without the endpoint's cooperation. Only
   * set this on endpoints known to leak (the lab's Qwen llama.cpp servers).
   */
  repairsLeakedToolProtocol?: boolean;
}

export interface ModelConfig {
  /** The `model` field sent on the wire, e.g. "Qwen3.8-27B-UD-Q4_K_M". */
  id: string;
  /** Label for sessions/UI, e.g. "vks-llama". */
  provider: string;
  /** e.g. "http://172.30.70.11:8080/v1" */
  baseUrl: string;
  /**
   * "openai-completions" — /chat/completions (local llama.cpp, etc.).
   * "openai-responses" — /responses (OpenAI Responses API; the ChatGPT
   *   subscription backend, D15). The CLI picks the matching StreamFn.
   */
  api: "openai-completions" | "openai-responses";
  contextWindow: number;
  /** Default output cap (max_tokens) for this model. */
  maxTokens: number;
  /**
   * The compaction trigger's reserved headroom (tokens) — how much room the
   * `shouldCompact` trigger keeps for the model's next output before it fires
   * (`totalTokens + compactionReserve + slack > contextWindow`). DELIBERATELY
   * separate from `maxTokens`: `maxTokens` is the hard output cap sent to the
   * server (and the keep plan's post-compaction fit), while `compactionReserve`
   * is only the leading "start compacting now" threshold. A smaller reserve
   * delays compaction (fewer compactions per session) WITHOUT shrinking what
   * the model can emit. Optional — defaults to `DEFAULT_COMPACTION_RESERVE`
   * (see compact.ts) when unset.
   */
  compactionReserve?: number;
  temperature?: number;
  apiKey?: string;
  /**
   * Extra HTTP headers sent verbatim with every request to this model's
   * endpoint (merged under the default `accept`/`content-type` headers; an
   * entry here overrides them). For OpenRouter this is where the optional
   * attribution headers go: `X-Title` (a human label for the app) and
   * `HTTP-Referer` (where the app lives). Names must be valid HTTP token
   * characters and values must not contain control characters — validated
   * at config load (a typo would otherwise fail every request opaquely).
   */
  headers?: Record<string, string>;
  compat?: ModelCompat;
  /**
   * D15 — how the wire authenticates. "chatgpt-oauth": the access token is
   * resolved from the local ChatGPT OAuth token store (refreshed on expiry)
   * instead of a static `apiKey`. Only meaningful with
   * `api: "openai-responses"`.
   */
  auth?: "chatgpt-oauth";
}

// ──────────────────── 4. Worker registry (endpoint visibility) ──────────

/**
 * The status of one `tre. run` worker, as the other tre. processes (the
 * TUI's `workers` bottom field) see it. A worker writes one of these to its
 * own file in the shared worker dir (`~/.tre/workers/`, see
 * `src/cli/workers.ts`) on startup, refreshes it as it works, and marks it
 * done/failed on exit. The TUI polls the dir and renders the live set —
 * this is the CONTRACT between the writer (cli/main.ts) and the reader
 * (tui/state.ts + tui/run.tsx); it lives here so neither side imports the
 * other.
 */
export interface WorkerStatus {
  /** Stable worker id (the filename stem in the worker dir). */
  id: string;
  /** The model id the worker runs on (from models.json). */
  model: string;
  /** The endpoint's baseUrl (the "which endpoint" the user asked about). */
  endpoint: string;
  /** "running" while the worker works; "done"/"failed" on exit. */
  status: "running" | "done" | "failed";
  /** The worker's current turn number (0 before the first turn). */
  turn: number;
  /** The worker's most recent activity label (tool name, "thinking", …). */
  activity: string;
  /** Epoch ms of the last status write (the TUI prunes stale entries). */
  updatedAt: number;
  /** Epoch ms the worker started (for elapsed time). */
  startedAt: number;
  /** The worker's working directory (so the user sees WHAT it works on). */
  cwd: string;
  /** The worker's prompt (truncated) — what it was asked to do. */
  task: string;
}

/**
 * One subtask in the agent's current workstream (the `subtask` tool's
 * list, src/tools/subtask.ts). The TUI carries the list in state.subtasks
 * (fed by the tool's `details.subtasks` on tool_execution_end) to drive the
 * `subtasks` bottom field — `done/total <active subtask name>`.
 */
export interface SubtaskInfo {
  /** 1-based position in the list (assigned by `create`). */
  id: number;
  /** The subtask's name (what the user sees in the bottom display). */
  name: string;
  status: "queued" | "in-progress" | "done" | "failed";
}
