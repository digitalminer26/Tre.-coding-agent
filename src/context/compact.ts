/**
 * WS9 — Context compaction (PLAN.md §WS9, D10).
 *
 * When the context approaches the model's window, the run folds the OLDER
 * messages into a structured summary and keeps the recent tail, so the next
 * turn fits:
 *
 *   trigger   — the last assistant message's real usage (`totalTokens` =
 *               prompt + completion of the last call, a close proxy for the
 *               NEXT prompt size) plus the output budget
 *               (`maxTokens` + 1024 slack) would exceed `contextWindow`.
 *   keep      — the most recent messages up to ~`keepTokens` (default 8192,
 *               ESTIMATED: chars/4; capped by the model's window:
 *               window - maxTokens - slack, so a compacted context can
 *               actually fit), snapped to unit boundaries so a toolCall
 *               assistant message is never split from its
 *               ToolResultMessages. The most recent user message is kept
 *               verbatim unless it is the ONLY user message (index 0) —
 *               then the task survives via the summary (the summarizer
 *               must record the user's goal and constraints).
 *   summary   — ONE silent LLM call (no tools, events consumed, not yielded)
 *               over the folded messages. Iterative: if the context already
 *               starts with a previous summary, the prompt folds it in.
 *               Structured: a sectioned prompt (GOAL/DONE/STATE/FILES/NEXT);
 *               the FILES section is extracted DETERMINISTICALLY from the
 *               folded tool calls (extractFileOps) so file paths never
 *               depend on the LLM remembering them.
 *   failure   — I3: a failed/empty summary call ABORTS COMPACTATION for that
 *               turn (context unchanged), never the run.
 *   fit       — the candidate is validated AFTER the summary: the complete
 *               new context (summary + kept + fixed prompt overhead) must be
 *               a strict reduction of the old context, or the compaction is
 *               refused (a summary larger than the prefix it replaces would
 *               enlarge the next request). The model's input budget is
 *               returned (`requestBudget`) so the caller can distinguish
 *               "fits" from "smaller but still over budget".
 *
 * This module is pure + one injected StreamFn (no I/O, no session). The CLI
 * (main.ts) owns the wiring: it writes the session `compaction` entry
 * (firstKeptEntryId needs the message→entry-id map only the session layer
 * knows) and emits the `context_compacted` event.
 */
import type {
  AgentMessage,
  AssistantMessage,
  ModelConfig,
  StreamFn,
  Usage,
  UserMessage,
} from "../types.js";

/** Marker prefix of a compaction summary message (single source of truth —
 *  session.ts materializes replayed summaries with the same format). */
export const SUMMARY_MARKER = "[Compaction summary of earlier context]";

/** The user message that carries a compaction summary into the context. */
export function makeSummaryMessage(summary: string, timestamp = Date.now()): UserMessage {
  return { role: "user", content: `${SUMMARY_MARKER}\n\n${summary}`, timestamp };
}

/** True for a compaction summary message (user message with the marker). */
export function isSummaryMessage(m: AgentMessage): boolean {
  return m.role === "user" && m.content.startsWith(SUMMARY_MARKER);
}

/** Estimated tokens for one message: total chars / charsPerToken (ceiling).
 *  charsPerToken defaults to 4 (the chars/4 heuristic); a calibrated value
 *  (calibrateCharsPerToken) makes the budget honest for dense content. */
export function estimateMessageTokens(m: AgentMessage, charsPerToken = 4): number {
  let chars = 0;
  if (m.role === "user") {
    chars = m.content.length;
  } else if (m.role === "assistant") {
    for (const b of m.content) {
      if (b.type === "text") chars += b.text.length;
      else if (b.type === "thinking") chars += b.thinking.length;
      else if (b.type === "toolCall") chars += b.name.length + JSON.stringify(b.arguments).length;
    }
  } else {
    // toolResult: toolName/isError live on the message, content is TextBlock[]
    chars += m.toolName.length;
    for (const b of m.content) chars += b.text.length;
  }
  return Math.ceil(chars / charsPerToken);
}

export function estimateTokens(messages: AgentMessage[], charsPerToken = 4): number {
  let t = 0;
  for (const m of messages) t += estimateMessageTokens(m, charsPerToken);
  return t;
}

/**
 * Fixed prompt overhead (system prompt + tool schemas) in estimated tokens.
 * The tool schemas are counted as `{name, description, parameters}` — the
 * same fields the wire layer serializes — so the estimate tracks what
 * actually goes into the prompt. Used by the compaction trigger (compactNow)
 * so the "actual next request" estimate includes the irreducible floor, not
 * just the message history. Structural parameter type: any Tool[] fits.
 */
export function estimatePromptOverheadTokens(
  systemChars: number,
  tools: readonly { name: string; description: string; parameters: unknown }[],
  charsPerToken = 4,
): number {
  const toolChars = tools.reduce(
    (n, t) => n + t.name.length + t.description.length + JSON.stringify(t.parameters).length,
    0,
  );
  return Math.ceil(systemChars / charsPerToken) + Math.ceil(toolChars / charsPerToken);
}

/**
 * Calibrated chars-per-token from ONE real usage sample. `usage` is the last
 * assistant message's usage; `context` is the context at the moment of that
 * call (it MAY include the last assistant message itself — it is excluded
 * from the estimate, since its tokens were not in the prompt); `systemChars`
 * is the system prompt's char count (its tokens are in the prompt but not in
 * the message list — added to the estimate, since the prompt included them).
 *
 * Ratio: estimated prompt (messages + system, chars/4) ÷ actual prompt
 * tokens (usage.input = totalTokens − output). Returns 4 (uncalibrated)
 * when the sample is degenerate; clamped to [1, 4] so a pathological sample
 * can't collapse the budget (Cline caps the same underestimate factor at 4).
 */
export function calibrateCharsPerToken(
  usage: Usage,
  context: AgentMessage[],
  systemChars: number,
): number {
  let est = estimateTokens(context);
  const last = context[context.length - 1];
  if (last && last.role === "assistant") est -= estimateMessageTokens(last);
  est += Math.ceil(systemChars / 4);
  const actual = usage.input; // prompt tokens (system + messages + tool schema)
  if (est <= 0 || actual <= 0) return 4;
  return Math.min(4, Math.max(1, (4 * est) / actual));
}

/**
 * Compaction trigger. `usage` is the LAST assistant message's usage
 * (totalTokens = last prompt + completion ≈ next prompt size). True when
 * `totalTokens + maxTokens + slack` would exceed the window. No usage (no
 * assistant turn yet) → false.
 */
export function shouldCompact(
  usage: Usage | undefined,
  contextWindow: number,
  maxTokens: number,
  slack = 1024,
): boolean {
  if (!usage) return false;
  return usage.totalTokens + maxTokens + slack > contextWindow;
}

export interface CompactionPlan {
  /** Index in `context` of the first KEPT message (a unit boundary). */
  keepFrom: number;
  /** context[0..keepFrom) — folded into the summary. */
  toSummarize: AgentMessage[];
  /** context[keepFrom..] — kept verbatim. Always a suffix of units; always
   *  contains the most recent user message; ≥ 2 units. */
  kept: AgentMessage[];
  /** True when the context already starts with an earlier summary (the new
   *  summary must fold it in). */
  isIterative: boolean;
}

/** A "unit" is one message, or an assistant-with-toolCalls plus its result
 *  messages. Unit boundaries: every index whose message is NOT a toolResult. */
function unitBoundaries(context: AgentMessage[]): number[] {
  const b: number[] = [];
  context.forEach((m, i) => {
    if (m.role !== "toolResult") b.push(i);
  });
  return b;
}

/**
 * Plan a compaction of `context`: choose `keepFrom` so the kept suffix is
 * ~`keepTokens` (estimated) of the most recent messages, a whole number of
 * units, and non-empty on both sides. Returns undefined when there is
 * nothing safe to fold (context too short, or the keep window would swallow
 * everything).
 */
export function planCompaction(
  context: AgentMessage[],
  keepTokens = 8192,
  charsPerToken = 4,
): CompactionPlan | undefined {
  const bounds = unitBoundaries(context);
  if (bounds.length < 3) return undefined; // need ≥1 unit to fold + ≥2 kept
  const per = context.map((m) => estimateMessageTokens(m, charsPerToken));

  // Linear backward suffix accumulation. A target is approximate: atomic
  // tool-call/result units may exceed it and are never split.
  let keepFrom = bounds[bounds.length - 1]!;
  let acc = 0;
  for (let bi = bounds.length - 1; bi >= 1; bi--) {
    keepFrom = bounds[bi]!;
    for (let i = keepFrom; i < (bi === bounds.length - 1 ? context.length : bounds[bi + 1]!); i++) {
      acc += per[i]!;
    }
    if (acc >= keepTokens) break;
  }

  // The most recent user message is kept verbatim (it is itself a unit
  // boundary); see the guard below for the single-prompt exception.
  let lastUser = -1;
  for (let i = context.length - 1; i >= 0; i--) {
    if (context[i]!.role === "user") {
      lastUser = i;
      break;
    }
  }
  // (WS10 e2e s12) The task still survives when lastUser === 0: the
  // summarizer prompt requires the user's goal and constraints in the summary.
  if (lastUser > 0 && lastUser < keepFrom) keepFrom = lastUser;

  if (keepFrom <= 0) return undefined; // the keep window ate everything
  return {
    keepFrom,
    toSummarize: context.slice(0, keepFrom),
    kept: context.slice(keepFrom),
    isIterative: isSummaryMessage(context[0]!),
  };
}

/** Middle-truncate long text (head + tail) for the summary prompt. */
function clip(s: string, max: number): string {
  const limit = Math.max(0, Math.floor(max));
  if (s.length <= limit) return s;
  if (limit === 0) return "";
  if (limit <= 3) return "…".slice(0, limit);
  const detailedMarker = `\n…[truncated ${s.length - limit} chars]…\n`;
  const marker = detailedMarker.length < limit ? detailedMarker : "\n…\n";
  if (marker.length >= limit) return marker.slice(0, limit);
  const remaining = limit - marker.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  const finalMarker = marker === detailedMarker ? marker : "…";
  return `${s.slice(0, head)}${finalMarker}${tail > 0 ? s.slice(-tail) : ""}`;
}

/** Render messages as a transcript for the summarizer prompt.
 *  A2: thinking blocks are the most ephemeral content — EXCLUDED by default
 *  (`includeThinking: true` opts back in). A3: tool results get their own
 *  clip (`toolResultChars`, default 2000) with the existing middle-
 *  truncation shape (head = imports/structure, tail = final error/exit);
 *  user/assistant lines keep the `perMessageChars` clip. */
export function renderTranscript(
  messages: AgentMessage[],
  opts: {
    perMessageChars?: number;
    totalChars?: number;
    includeThinking?: boolean;
    toolResultChars?: number;
  } = {},
): string {
  const per = opts.perMessageChars ?? 1500;
  const toolPer = opts.toolResultChars ?? 2000;
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push(`[User] ${m.content}`);
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "text" && b.text) out.push(`[Assistant] ${b.text}`);
        if (opts.includeThinking && b.type === "thinking" && b.thinking)
          out.push(`[Assistant thought] ${b.thinking}`);
        if (b.type === "toolCall")
          out.push(`[Assistant → tool] ${b.name} ${JSON.stringify(b.arguments)}`);
      }
    } else {
      const status = m.isError ? " (ERROR)" : "";
      for (const b of m.content) {
        out.push(`[Tool result: ${m.toolName}${status}] ${clip(b.text, toolPer)}`);
      }
    }
  }
  let text = out.map((l) => (l.startsWith("[Tool result:") ? l : clip(l, per))).join("\n");
  const total = opts.totalChars ?? 24000;
  if (text.length > total) text = clip(text, total);
  return text;
}

export const SUMMARIZER_SYSTEM =
  "You summarize a coding-agent conversation so the agent can continue without seeing the original. " +
  "Output ONLY the summary — no preamble, no questions.";

/** File paths touched by the folded messages, extracted DETERMINISTICALLY
 *  from the assistant toolCall blocks (read → read; write/edit → modified).
 *  bash is not parsed (its commands are ambiguous). */
export interface FileOps {
  read: string[];
  modified: string[];
}

/** Cap on listed paths per list — a summary that enumerates hundreds of
 *  paths is noise; the agent can re-read what it needs. */
const FILE_OPS_CAP = 50;

/**
 * Deterministic file-ops extraction (the FILES section of the summary).
 * Walks assistant toolCall blocks in order: `read` → read list,
 * `write`/`edit` → modified list. Non-string/empty/whitespace `path` args
 * are ignored; deduped, first-seen order, capped at FILE_OPS_CAP each.
 * Pure — no I/O, no model.
 */
export function extractFileOps(messages: AgentMessage[]): FileOps {
  const read: string[] = [];
  const modified: string[] = [];
  const seenRead = new Set<string>();
  const seenModified = new Set<string>();
  const push = (list: string[], seen: Set<string>, p: string): void => {
    if (list.length >= FILE_OPS_CAP || seen.has(p)) return;
    seen.add(p);
    list.push(p);
  };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    // Tool results belong to the immediately following result unit only;
    // never let a later/reused call id certify an earlier call.
    const results = new Map<string, boolean>();
    for (let j = i + 1; j < messages.length && messages[j]!.role === "toolResult"; j++) {
      const result = messages[j]!;
      if (result.role === "toolResult") results.set(result.toolCallId, !result.isError);
    }
    for (const b of m.content) {
      if (b.type !== "toolCall") continue;
      const p = b.arguments.path;
      if (typeof p !== "string" || p.trim() === "" || results.get(b.id) !== true) continue;
      if (b.name === "read") push(read, seenRead, p);
      else if (b.name === "write" || b.name === "edit") push(modified, seenModified, p);
      // bash (and anything else): not parsed — commands are ambiguous.
    }
  }
  return { read, modified };
}

/** The static (plan-independent) part of the summarizer prompt — the
 *  section instructions. Kept separate so `summarizePrompt` can budget the
 *  WHOLE request (instructions + FILES + transcript) against the model's
 *  window, not just the transcript. */
const SUMMARIZER_INSTRUCTIONS = `Summarize the conversation below so the agent can continue without seeing it. Use these sections:
1. GOAL — the user's goal(s) and constraints they stated, verbatim where possible.
2. DONE — what was completed: files touched, commands run and their outcomes, decisions made.
3. STATE — what is in progress, what is blocked or failed, open questions.
4. FILES — copy the FILES section below VERBATIM (it was extracted from the transcript; do not guess paths).
5. NEXT — the immediate next step(s) to continue the work.
Be concrete (exact paths, commands, values). Omit chit-chat. Under 500 words.`;

/** The FILES section of the summarizer prompt ("" when no file ops).
 *  `maxChars` bounds the WHOLE section (header + path lists) so a long
 *  path list can't defeat the request budget: whole paths are omitted
 *  first-seen-last, with an explicit count (never a truncated path — a
 *  half-path is worse than no path). */
function filesSection(plan: CompactionPlan, maxChars?: number): string {
  const ops = extractFileOps(plan.toSummarize);
  if (ops.read.length === 0 && ops.modified.length === 0) return "";
  const header = "FILES (extracted from the transcript — verified, copy verbatim):";
  const render = (read: string[], modified: string[]): string => {
    const lines = [header];
    if (read.length > 0) lines.push(`read: ${read.join(", ")}`);
    if (modified.length > 0) lines.push(`modified: ${modified.join(", ")}`);
    return lines.join("\n");
  };
  let read = ops.read;
  let modified = ops.modified;
  let section = render(read, modified);
  if (maxChars !== undefined && section.length > maxChars) {
    // Drop whole paths from the END of each list (least recently relevant).
    // Reserve room for the omission notice before deciding the section fits.
    const omittedText = (count: number) =>
      count > 0 ? `\n(${count} more path(s) omitted — re-read the transcript if you need them)` : "";
    while (
      section.length + omittedText(ops.read.length - read.length + ops.modified.length - modified.length).length > maxChars &&
      (read.length > 0 || modified.length > 0)
    ) {
      if (modified.length > 0 && (read.length === 0 || modified[modified.length - 1]!.length >= (read[read.length - 1]?.length ?? 0))) {
        modified = modified.slice(0, -1);
      } else {
        read = read.slice(0, -1);
      }
      section = render(read, modified);
    }
    const omitted = ops.read.length - read.length + ops.modified.length - modified.length;
    section += omittedText(omitted);
    if (section.length > maxChars) return ""; // even the FILES header cannot fit
  }
  return section;
}

/**
 * The user message for the summarizer call. The ENTIRE request is bounded
 * to `contextWindow` (A3): the static instructions, the FILES section, and
 * the transcript share one token budget — the transcript gets whatever is
 * left (its own `totalChars` clip is the floor of that remainder, so a
 * caller-supplied transcript budget never silently wins over the window).
 * `transcriptOpts` (D retry) shrink the per-message clips further.
 */
export function summarizePrompt(
  plan: CompactionPlan,
  transcriptOpts?: { perMessageChars?: number; totalChars?: number; toolResultChars?: number },
  contextWindow?: number,
  budget?: { charsPerToken?: number; outputTokens?: number },
): string {
  const window = contextWindow && contextWindow > 0 ? contextWindow : undefined;
  const cpt = budget?.charsPerToken && budget.charsPerToken > 0 ? budget.charsPerToken : 4;
  const instructions = SUMMARIZER_INSTRUCTIONS;
  const iterative = plan.isIterative
    ? "An earlier summary of the older context is included at the top of the transcript; produce an UPDATED summary that folds it in with the newer messages. Do not repeat its header line.\n\n"
    : "";
  const transcriptLabel = "TRANSCRIPT:\n";
  // The request contains this user message PLUS SUMMARIZER_SYSTEM. Reserve
  // both system input and the actual completion allowance. Use the same
  // calibrated chars/token ratio as transcript estimation and final check.
  const reservedOutputTokens = budget?.outputTokens ?? 1024;
  const requestInputChars = window
    ? Math.max(0, (window - Math.ceil(SUMMARIZER_SYSTEM.length / cpt) - reservedOutputTokens) * cpt)
    : undefined;
  const fixedChars = instructions.length + 2 + iterative.length + transcriptLabel.length;
  // Cap the FILES section at HALF the available budget (the budget after the
  // fixed instructions) so it can never starve the transcript: an uncapped
  // FILES list (many/long verified paths) could fill the whole budget and
  // leave the transcript — the user's goal and constraints — empty, so the
  // summarizer request could not meaningfully summarize the conversation.
  // Whole paths are omitted as necessary (filesSection). The -2 reserves the
  // two-character separator emitted after a nonempty FILES section (sizing it
  // before the section, not only in the transcript remainder, so a FILES
  // section that fills its half cannot push the separator past the window).
  const available = requestInputChars === undefined ? undefined : Math.max(0, requestInputChars - fixedChars);
  const filesMax = available === undefined ? undefined : Math.max(0, Math.floor(available / 2) - 2);
  const files = filesSection(plan, filesMax);
  // The returned prompt includes a two-character separator after a nonempty
  // FILES section; reserve it before assigning the remaining transcript.
  const filesWithSeparatorChars = files.length > 0 ? files.length + 2 : 0;
  let transcriptChars =
    requestInputChars === undefined
      ? undefined
      : Math.max(0, requestInputChars - fixedChars - filesWithSeparatorChars);
  // D retry: an explicit totalChars is a HARD cap (the caller already chose
  // the trade-off) — it can only shrink the window-derived budget.
  if (transcriptOpts?.totalChars !== undefined) {
    transcriptChars = transcriptChars === undefined ? transcriptOpts.totalChars : Math.min(transcriptChars, transcriptOpts.totalChars);
  } else if (transcriptChars === undefined) {
    transcriptChars = 24000; // no window: the legacy default
  }
  // The per-message clip must not exceed the total (renderTranscript clips
  // per line first — a per-clip larger than the total wastes the budget on
  // one line).
  const per = Math.min(transcriptOpts?.perMessageChars ?? 1500, Math.floor(transcriptChars / 2));
  const transcript = renderTranscript(plan.toSummarize, {
    includeThinking: false, // A2: decisions live in text/tool calls, not reasoning traces
    totalChars: transcriptChars,
    perMessageChars: per,
    toolResultChars: Math.min(transcriptOpts?.toolResultChars ?? 2000, transcriptChars),
  });
  return `${instructions}\n\n${files ? files + "\n\n" : ""}${iterative}TRANSCRIPT:\n${transcript}`;
}

export interface CompactContextResult {
  summary: string;
  kept: AgentMessage[];
  /** Estimated tokens of the NEW context ([summary, …kept]), INCLUDING
   *  system/tool-schema overhead — the size of the next request's prompt. */
  estimatedTokensAfter: number;
  /** Estimated tokens of the OLD context (same basis) — what the summary
   *  replaces. Compaction must be a strict reduction here. */
  estimatedTokensBefore: number;
  /** The last assistant usage that tripped the trigger (for the session entry). */
  tokensBefore: number;
  /** The model's conservative input budget (window − maxTokens − slack) —
   *  the hard limit `estimatedTokensAfter` is checked against. */
  requestBudget: number;
}

/**
 * D — deterministic shrink, no LLM. Same keep plan as `planCompaction`, but
 * the folded prefix is replaced by a small notice user message
 * (SUMMARY_MARKER + message count + the deterministic file-ops list)
 * instead of an LLM summary. The marker keeps session replay,
 * `isSummaryMessage`, and the iterative fold-in working unchanged; the
 * context strictly shrinks (notice ≈ a few hundred chars vs. the folded
 * prefix). Returns undefined when no plan exists (context too short).
 */
export function ruleBasedShrink(
  context: AgentMessage[],
  keepTokens: number,
  charsPerToken: number,
): { notice: UserMessage; kept: AgentMessage[] } | undefined {
  const plan = planCompaction(context, keepTokens, charsPerToken);
  if (!plan) return undefined;
  const ops = extractFileOps(plan.toSummarize);
  const lines = [
    `Earlier context (${plan.toSummarize.length} message(s)) was discarded without an LLM summary (the summarizer call failed).`,
    "Only the recent tail below is retained; re-read any file you need.",
  ];
  if (ops.read.length > 0) lines.push(`FILES read: ${ops.read.join(", ")}`);
  if (ops.modified.length > 0) lines.push(`FILES modified: ${ops.modified.join(", ")}`);
  // Keep the deterministic notice bounded even when path strings themselves
  // are unusually long. Paths are hints, not worth defeating compaction for.
  const noticeText = clip(lines.join("\n"), 512);
  const notice = makeSummaryMessage(noticeText);
  const before = estimateTokens(context, charsPerToken);
  const after = estimateTokens([notice, ...plan.kept], charsPerToken);
  // The initial summary marker is larger than tiny toy prefixes; keep the
  // legacy best-effort fallback there only when the full context shrinks.
  // If it grows, refuse to compact rather than worsen the next prompt.
  if (after >= before) return undefined;
  return { notice, kept: plan.kept };
}

/**
 * Run a compaction if `context` needs it: check the trigger on the last
 * assistant message's usage, plan the split, and make ONE silent summarizer
 * call (no tools). Returns undefined — never throws — when compaction is not
 * needed, the plan is empty, the stream fails, or the model produced no text
 * (I3: the caller then keeps the context as-is).
 */
export async function compactContext(opts: {
  streamFn: StreamFn;
  model: ModelConfig;
  signal: AbortSignal;
  context: AgentMessage[];
  keepTokens?: number;
  /** Calibrated chars-per-token (calibrateCharsPerToken); default 4. */
  charsPerToken?: number;
  /** Fixed prompt overhead (system prompt + tool schemas), in estimated
   *  tokens — included in `estimatedTokensAfter`. */
  promptOverheadTokens?: number;
  /** D — retry with a shrunken transcript (halved clips). */
  transcriptOpts?: { perMessageChars?: number; totalChars?: number; toolResultChars?: number };
  /** A6 — force a manual compaction even when usage is below threshold. */
  force?: boolean;
  /** Caller already evaluated the trigger (e.g. compactNow's request estimate). */
  triggered?: boolean;
}): Promise<CompactContextResult | undefined> {
  let lastAssistant: AssistantMessage | undefined;
  for (let i = opts.context.length - 1; i >= 0; i--) {
    const m = opts.context[i]!;
    if (m.role === "assistant") {
      lastAssistant = m;
      break;
    }
  }
  if (
    !opts.force &&
    !opts.triggered &&
    !shouldCompact(lastAssistant?.usage, opts.model.contextWindow, opts.model.maxTokens)
  ) {
    return undefined;
  }
  // The keep target must fit the model's window: with a small contextWindow,
  // keeping the 8192 default would leave the compacted context LARGER than
  // the window (WS10 e2e s12). Cap it at what the trigger already budgets:
  // window - maxTokens - slack.
  const cpt = opts.charsPerToken ?? 4;
  const promptOverhead = opts.promptOverheadTokens ?? 0;
  // Reserve fixed prompt overhead when the caller requires a fit check.
  // Keep at least 512 tokens for atomic units; final validation decides if
  // an indivisible suffix can actually fit.
  const windowCap = Math.max(512, opts.model.contextWindow - opts.model.maxTokens - 1024);
  const plan = planCompaction(opts.context, Math.min(opts.keepTokens ?? 8192, windowCap), cpt);
  if (!plan) return undefined;

  let text = "";
  let failed = false;
  let aborted = false;
  try {
    const summarizerModel = { ...opts.model, maxTokens: Math.min(1024, opts.model.maxTokens) };
    const prompt = summarizePrompt(
      plan,
      {
        perMessageChars: opts.transcriptOpts?.perMessageChars ?? 1500,
        totalChars: opts.transcriptOpts?.totalChars ?? Math.max(4000, Math.floor(opts.model.contextWindow / cpt)),
        toolResultChars: opts.transcriptOpts?.toolResultChars ?? 2000,
      },
      opts.model.contextWindow,
      { charsPerToken: cpt, outputTokens: summarizerModel.maxTokens },
    );
    // Use the identical calibrated estimate and completion reservation that
    // summarizePrompt used to construct this request.
    const summaryInputTokens = Math.ceil((SUMMARIZER_SYSTEM.length + prompt.length) / cpt);
    if (summaryInputTokens + summarizerModel.maxTokens > opts.model.contextWindow) return undefined;
    for await (const ev of opts.streamFn(summarizerModel, {
      systemPrompt: SUMMARIZER_SYSTEM,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      tools: [],
    }, { signal: opts.signal })) {
      if (ev.type === "text_delta") text += ev.delta;
      if (ev.type === "done") {
        if (
          ev.message.stopReason === "error" ||
          ev.message.stopReason === "aborted" ||
          ev.message.stopReason === "length"
        ) failed = true;
        if (ev.message.stopReason === "aborted") aborted = true;
      }
    }
  } catch {
    // I3: the stream contract says it never throws, but be defensive.
    failed = true;
  }
  if (failed || aborted || opts.signal.aborted || text.trim() === "") return undefined;
  // Final fit validation (the keep budget is only a PLANNING target — atomic
  // tool-call/result units can't be split, so the kept suffix may exceed it):
  // the COMPLETE candidate, summary + kept + fixed prompt overhead, is
  // estimated and returned. The caller (compactNow) owns the policy for a
  // candidate that still exceeds the window; `compactContext` itself only
  // refuses candidates that do not shrink the context at all — a summary
  // larger than the prefix it replaces would ENLARGE the next request,
  // which is strictly worse than skipping the compaction.
  const summaryMsg = makeSummaryMessage(text.trim());
  const estimatedTokensAfter = estimateTokens([summaryMsg, ...plan.kept], cpt) + promptOverhead;
  const estimatedTokensBefore = estimateTokens(opts.context, cpt) + promptOverhead;
  if (estimatedTokensAfter >= estimatedTokensBefore) return undefined;
  const requestBudget = opts.model.contextWindow - opts.model.maxTokens - 1024;
  return {
    summary: text.trim(),
    kept: plan.kept,
    estimatedTokensAfter,
    estimatedTokensBefore,
    tokensBefore: lastAssistant?.usage?.totalTokens ?? 0,
    requestBudget,
  };
}
