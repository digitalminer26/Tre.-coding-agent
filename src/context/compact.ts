/**
 * WS9 — Context compaction (PLAN.md §WS9, D10).
 *
 * When the context approaches the model's window, the run folds the OLDER
 * messages into a structured summary and keeps the recent tail, so the next
 * turn fits:
 *
 *   trigger   — the last assistant message's real usage (`totalTokens` =
 *               prompt + completion of the last call, a close proxy for the
 *               NEXT prompt size) plus the compaction reserve
 *               (`compactionReserve` + 1024 slack) would exceed
 *               `contextWindow`. The reserve is a SEPARATE knob from the
 *               model's output cap (`maxTokens`): it only sets the leading
 *               "start compacting now" threshold, so a smaller reserve delays
 *               compaction without shrinking what the model can emit.
 *   keep      — the most recent messages up to ~`keepTokens` (default 8192,
 *               ESTIMATED: chars/4; capped by the model's window minus the
 *               fixed prompt overhead AND the summarizer's output budget —
 *               window - maxTokens - slack - overhead - summaryBudget — so
 *               the candidate [summary, …kept] + overhead can actually fit
 *               the input budget), snapped to unit boundaries so a toolCall
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

/** The summarizer's output cap (tokens). A summary is structured prose
 *  (GOAL/DONE/STATE/FILES/NEXT, "under 500 words") — 1024 tokens was far
 *  more than the prose needs, but the cap ALSO bounds the summary that the
 *  keep plan reserves (`summaryBudget`), so it is the right lever for the
 *  over-budget failures: a smaller reservation → a larger keep window → a
 *  candidate that fits. 2048 keeps comfortable head room for a long FILES
 *  list (up to 50 verified paths) while still halving the old reservation.
 *  A summary that hits the cap (stopReason "length") is still ACCEPTED when
 *  it produced text — a truncated structured summary is a usable, strict
 *  reduction of the context (see the `length` handling in compactContext). */
export const SUMMARIZER_MAX_TOKENS = 2048;

/** The summarizer's output cap for a model: the fixed SUMMARIZER_MAX_TOKENS,
 *  clamped to the model's own maxTokens (a model that can't emit 2048 tokens
 *  can't emit a 2048-token summary). Single source of truth for the
 *  summarizer cap — used by compactContext (the call's maxTokens and the
 *  keep-plan reservation) and by compactNow (the same reservation, so the
 *  ruleBasedShrink fallback stays on the same budget). */
export function summarizerMaxTokens(model: ModelConfig): number {
  return Math.min(SUMMARIZER_MAX_TOKENS, model.maxTokens);
}

/** The compaction trigger's reserved headroom (tokens) — the default reserve
 *  when a model's `compactionReserve` is unset. This is the "start compacting
 *  now" threshold, NOT the model's output cap: it is deliberately smaller
 *  than a full `maxTokens` so compaction fires later (fewer compactions per
 *  session) while the model's `maxTokens` (the `max_tokens` sent to the
 *  server and the keep plan's post-compaction fit) is left untouched. 16384
 *  halves the old `maxTokens`-sized reserve on the 131k window (trigger
 *  ~97k → ~113k tokens) without touching output capacity. */
export const DEFAULT_COMPACTION_RESERVE = 16384;

/** The compaction reserve for a model: its `compactionReserve` when set,
 *  else DEFAULT_COMPACTION_RESERVE. Single source of truth for the trigger's
 *  reserve — used by shouldCompact (the loop's auto-compact decision) and by
 *  the TUI's compactThreshold (the displayed trigger), so the number the user
 *  sees is the number the loop actually compares against. */
export function compactionReserve(model: ModelConfig): number {
  return model.compactionReserve ?? DEFAULT_COMPACTION_RESERVE;
}

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
 * `totalTokens + reserve + slack` would exceed the window. `reserve` is the
 * model's COMPACTION RESERVE (compactionReserve), NOT its output cap — the
 * leading "start compacting now" threshold, kept separate from `maxTokens`
 * so delaying compaction never shrinks what the model can emit. No usage (no
 * assistant turn yet) → false.
 */
export function shouldCompact(
  usage: Usage | undefined,
  contextWindow: number,
  reserve: number,
  slack = 1024,
): boolean {
  if (!usage) return false;
  return usage.totalTokens + reserve + slack > contextWindow;
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
 *
 * `opts.preserveLastUser` (default true): keep the most recent user message
 * verbatim by extending the suffix back to it. `opts.shrinkToFit` (default
 * false): after the walk (and the last-user extension), keep folding the
 * oldest whole units until the suffix fits `keepTokens` — see the ladder
 * below. The combination `shrinkToFit + preserveLastUser:false` is the
 * D26 "last candidate" (fold everything but one unit); the caller uses it
 * only when the verbatim tail provably cannot fit the input window.
 */
export function planCompaction(
  context: AgentMessage[],
  keepTokens = 8192,
  charsPerToken = 4,
  opts: { preserveLastUser?: boolean; shrinkToFit?: boolean } = {},
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
  // D26 (lossless fit policy): `preserveLastUser: false` skips the extension
  // entirely — the live prompt is then foldable, and it is the CALLER's
  // contract (compactContext's keep ladder) to only ever use such a plan
  // when the alternative is dropping the user's task with nothing carried.
  let lastUser = -1;
  if (opts.preserveLastUser !== false) {
    for (let i = context.length - 1; i >= 0; i--) {
      if (context[i]!.role === "user") {
        lastUser = i;
        break;
      }
    }
    // (WS10 e2e s12) The task still survives when lastUser === 0: the
    // summarizer prompt requires the user's goal and constraints in the summary.
    if (lastUser > 0 && lastUser < keepFrom) keepFrom = lastUser;
  }

  // D26 (lossless fit policy) — the descend-to-budget ladder. The walk above
  // stops as soon as the suffix REACHES the budget, and an atomic unit can
  // overshoot it arbitrarily (one 50k-token tool result = a 50k suffix). When
  // `shrinkToFit` is set, keep folding the OLDEST WHOLE units of the suffix
  // (never split a toolCall/result unit) until the suffix fits or one unit
  // remains. With `preserveLastUser` on, the fold never crosses the live
  // prompt — the descent stops at it; with it off (the caller proved the
  // verbatim tail cannot fit the window at all), the live prompt itself may
  // be folded, carried onward by the summary. Off by DEFAULT: the legacy
  // walk keeps the overshoot (documented "planning target, not a guard").
  if (opts.shrinkToFit === true && keepFrom > 0) {
    let suffix = 0;
    for (let i = keepFrom; i < context.length; i++) suffix += per[i]!;
    const cap = Math.max(keepTokens, 0);
    while (suffix > cap) {
      let nextStart: number | undefined;
      for (const b of bounds) if (b > keepFrom && (nextStart === undefined || b < nextStart)) nextStart = b;
      if (nextStart === undefined) break; // one unit remains — that IS the floor
      // When preserving the live prompt: a fold whose range contains it would
      // drop the user's current task — stop the descent at lastUser.
      if (opts.preserveLastUser !== false && lastUser >= keepFrom && nextStart > lastUser) break;
      for (let i = keepFrom; i < nextStart; i++) suffix -= per[i]!;
      keepFrom = nextStart;
    }
  }

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
  let marker = detailedMarker;
  let finalMarker = detailedMarker;
  if (detailedMarker.length >= limit) {
    // Small limits: a marker the size of the budget would leave zero
    // content. Use a short marker (or plain truncation) so head/tail
    // survive proportionally instead of the line being all marker.
    finalMarker = limit >= 9 ? "\n…\n" : "";
    if (finalMarker.length >= limit) return marker.slice(0, limit); // unreachable guard
    marker = finalMarker;
  }
  const remaining = limit - marker.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${s.slice(0, head)}${finalMarker}${tail > 0 ? s.slice(-tail) : ""}`;
}

/** Render messages as a transcript for the summarizer prompt.
 *  A2: thinking blocks are the most ephemeral content — EXCLUDED by default
 *  (`includeThinking: true` opts back in). A3: tool results get their own
 *  clip (`toolResultChars`, default 2000) with the existing middle-
 *  truncation shape (head = imports/structure, tail = final error/exit);
 *  user/assistant lines keep the `perMessageChars` clip.
 *
 *  `priorityLastUser`: the LAST user message is the live task — when the
 *  D26 strict-fit ladder folds it into the summary, the summary's whole job
 *  is to carry it. `totalChars` is a HARD cap: non-priority groups are
 *  sacrificed oldest-first (and, if that is not enough, shrunk/clipped),
 *  then the priority lines are middle-clipped to the exact space left
 *  (head+tail of the live task survive first); a final clip guarantees the
 *  cap at any total (including 0). Default off (plain renders, e.g. the
 *  follow-up refresh). */
export function renderTranscript(
  messages: AgentMessage[],
  opts: {
    perMessageChars?: number;
    totalChars?: number;
    includeThinking?: boolean;
    toolResultChars?: number;
    priorityLastUser?: boolean;
  } = {},
): string {
  const per = opts.perMessageChars ?? 1500;
  const toolPer = opts.toolResultChars ?? 2000;
  // Render one message into its transcript lines (per-message clips applied;
  // `raw` for the priority message: its user line skips the per-clip so the
  // live task reaches the summarizer whole, bounded only by the total).
  const linesFor = (m: AgentMessage, raw = false): string[] => {
    const out: string[] = [];
    if (m.role === "user") {
      out.push(raw ? `[User] ${m.content}` : clip(`[User] ${m.content}`, per));
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "text" && b.text) out.push(clip(`[Assistant] ${b.text}`, per));
        if (opts.includeThinking && b.type === "thinking" && b.thinking)
          out.push(clip(`[Assistant thought] ${b.thinking}`, per));
        if (b.type === "toolCall")
          out.push(clip(`[Assistant → tool] ${b.name} ${JSON.stringify(b.arguments)}`, per));
      }
    } else {
      const status = m.isError ? " (ERROR)" : "";
      for (const b of m.content) {
        out.push(`[Tool result: ${m.toolName}${status}] ${clip(b.text, toolPer)}`);
      }
    }
    return out;
  };
  const joinAll = (groups: string[][]) => groups.flat().join("\n");

  const total = opts.totalChars ?? 24000;
  let priorityIndex = -1;
  if (opts.priorityLastUser) {
    for (let i = messages.length - 1; i >= 0; i--)
      if (messages[i]!.role === "user") {
        priorityIndex = i;
        break;
      }
  }
  if (priorityIndex < 0) {
    let text = joinAll(messages.map((m) => linesFor(m)));
    if (text.length > total) text = clip(text, total);
    return text;
  }

  // Priority mode: the last user message survives the total budget first,
  // but `totalChars` is a HARD cap (the summarizer's input guard rejects
  // over-budget transcripts, so the budget must be honored exactly):
  //  1. sacrifice NON-priority groups oldest-first until the rest could fit;
  //  2. shrink the priority lines to the budget left over (exact accounting
  //     for every newline/separator), middle-clipping them (head+tail
  //     survive) — the live task keeps its head and tail first;
  //  3. a final hard clip guarantees the contract at any total (incl. 0).
  const groups = messages.map((m, i) => linesFor(m, i === priorityIndex));
  let text = joinAll(groups);
  while (text.length > total) {
    // Drop the oldest remaining non-priority group.
    let dropped = false;
    for (let i = 0; i < groups.length; i++) {
      if (i === priorityIndex || groups[i]!.length === 0) continue;
      groups[i] = [];
      dropped = true;
      break;
    }
    if (!dropped) break; // only the priority message is left
    text = joinAll(groups);
  }
  if (text.length > total) {
    // Only the priority message's lines can be at fault: size them to what
    // is left after the surviving non-priority lines and every separator.
    const pLines = groups[priorityIndex]!;
    const otherLines = groups.filter((g, i) => i !== priorityIndex).flat();
    const otherChars = otherLines.length === 0 ? 0 : otherLines.reduce((n, l) => n + l.length, 0) + otherLines.length - 1;
    const nP = pLines.length;
    const joinSep = otherLines.length > 0 && nP > 0 ? 1 : 0;
    const avail = total - otherChars - joinSep - Math.max(0, nP - 1);
    if (avail <= 0) {
      groups[priorityIndex] = [];
    } else {
      const share = Math.floor(avail / nP);
      if (share <= 0) groups[priorityIndex] = [];
      else for (let i = 0; i < nP; i++) pLines[i] = clip(pLines[i]!, share);
    }
    text = joinAll(groups);
  }
  // Hard-cap guarantee: whatever survives, the result never exceeds `total`
  // (clip is exact: clip(s, 0) === "").
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
  transcriptOpts?: {
    perMessageChars?: number;
    totalChars?: number;
    toolResultChars?: number;
    priorityLastUser?: boolean;
  },
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
    priorityLastUser: transcriptOpts?.priorityLastUser,
  });
  return `${instructions}\n\n${files ? files + "\n\n" : ""}${iterative}TRANSCRIPT:\n${transcript}`;
}

/**
 * Sentinel outcome of `compactContext`: the summarizer stream reported
 * `stopReason: "aborted"` (the user pressed ESC). Distinct from `undefined`
 * ("nothing to compact / no candidate") because the CALLER's abort signal may
 * not be set — the abort came from the stream — and an aborted compaction is
 * USER INTENT: `compactNow` must stop its entire retry/fallback ladder
 * (audit finding 3: collapsing the abort into `undefined` let the ladder
 * retry and apply a lossy fallback right after the user cancelled).
 */
export const COMPACT_ABORTED: unique symbol = Symbol("compact-aborted");
export type CompactAborted = typeof COMPACT_ABORTED;

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
  /** D26 (lossless fit policy): the full candidate ([summary, …kept] +
   *  prompt overhead) fits `requestBudget`. False only on the legacy
   *  best-effort path (or when no strict-fit rung produced a reduction) —
   *  the candidate is still a strict reduction of the old context. */
  fitsInputBudget: boolean;
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
  opts: { preserveLastUser?: boolean; shrinkToFit?: boolean } = {},
): { notice: UserMessage; kept: AgentMessage[] } | undefined {
  const plan = planCompaction(context, keepTokens, charsPerToken, opts);
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
 * call (no tools). Never throws. Returns undefined when compaction is not
 * needed, the plan is empty, the stream fails, or the model produced no text
 * (I3: the caller then keeps the context as-is). Returns the
 * {@link COMPACT_ABORTED} sentinel when the summarizer stream reported a user
 * abort — the caller must treat that as terminal intent, NOT as "try
 * something else".
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
  /** D26 (lossless fit policy) — strict fit of the returned candidate. The
   *  keep plan descends a budget ladder: first keeping the most recent user
   *  prompt verbatim, and — only when that plan's candidate provably cannot
   *  fit the input budget — folding the oldest whole units instead (and, as
   *  the very last resort, folding the prompt itself, with the task carried
   *  by the summary). See the ladder below. The result always reports
   *  `fitsInputBudget`; false means the mandatory floor itself is
   *  irreducible and the caller takes its legacy best-effort path. */
  strictFit?: boolean;
  /** See {@link COMPACT_ABORTED}: a user abort during the summarizer stream
   *  is reported as the sentinel (not `undefined`) so the caller can stop. */
}): Promise<CompactContextResult | CompactAborted | undefined> {
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
    // The trigger uses the COMPACTION RESERVE (a leading threshold), not
    // maxTokens — the keep plan below still reserves the full maxTokens for
    // the post-compaction fit.
    !shouldCompact(lastAssistant?.usage, opts.model.contextWindow, compactionReserve(opts.model))
  ) {
    return undefined;
  }
  // The keep target must fit the model's window: with a small contextWindow,
  // keeping the 8192 default would leave the compacted context LARGER than
  // the window (WS10 e2e s12). Cap it at what the trigger already budgets:
  // window - maxTokens - slack.
  const cpt = opts.charsPerToken ?? 4;
  const promptOverhead = opts.promptOverheadTokens ?? 0;
  // The summarizer's output is bounded by its maxTokens (a summary that hits
  // the cap is rejected as stopReason "length"), so an ACCEPTED summary is at
  // most this many tokens. Reserve it in the keep plan alongside the fixed
  // prompt overhead: the candidate is [summary, …kept] + overhead, so the
  // keep window must leave room for BOTH the overhead and the summary, not
  // just the kept messages. (D26: the overhead was counted in the trigger
  // but not fully reserved against the kept context, so the candidate
  // exceeded the input budget by ~the summary's size.)
  const summaryBudget = summarizerMaxTokens(opts.model);
  // The reserved headroom is the budget the keep plan must fit within:
  // window − maxTokens − slack − overhead − summaryBudget. The keep plan
  // targets the headroom in ALL regimes (the old 512 floor is gone — it was
  // a no-op when headroom ≥ 512, and when headroom < 512 it DEFENDED the
  // reservation: a 512-token keep target left no room for the overhead +
  // summary, so the candidate could exceed the input budget by far more
  // than one atomic unit). A negative headroom is fine: planCompaction
  // with a small/negative keepTokens keeps the minimal atomic suffix (the
  // walk breaks on the first unit).
  //
  // Resulting guarantee (the keep budget is a PLANNING target, not a hard cap
  // — two bounded extensions can push the kept suffix past it):
  //   (1) atomic tool-call/result units can't be split, so the kept suffix may
  //       overshoot the target by at most ONE indivisible unit (and an
  //       accepted summary is bounded by the summarizer's maxTokens);
  //   (2) planCompaction's mandatory last-user preservation
  //       (`if (lastUser > 0 && lastUser < keepFrom) keepFrom = lastUser`)
  //       moves the keep boundary back to the most recent user message, which
  //       can be MANY units behind the target — so the kept suffix (and the
  //       candidate) can exceed the target by more than one indivisible unit.
  // In the normal regime (no last-user extension) the candidate
  // [summary, …kept] + overhead is bounded by requestBudget + one indivisible
  // unit; when the last-user extension fires it is bounded by requestBudget +
  // the extension (the extra units pulled in to keep the most recent user
  // message verbatim). When the headroom is below 512 (or negative), the plan
  // keeps the minimal atomic suffix and the candidate can still exceed
  // requestBudget — best effort. In ALL cases compactNow validates the
  // complete candidate against requestBudget after the summary and flags the
  // applied candidate `overBudget` when it exceeds the budget (it is still a
  // strict reduction of the old context), so the caller always knows when the
  // applied candidate was over budget.
  const headroom =
    opts.model.contextWindow - opts.model.maxTokens - 1024 - promptOverhead - summaryBudget;
  const windowCap = headroom;
  const keepTokens = Math.min(opts.keepTokens ?? 8192, windowCap);

  // D26 (lossless fit policy) — the keep ladder. When `strictFit` is set,
  // the plan is selected over a descending ladder (ONE summarizer call —
  // the rung is chosen BEFORE the call via an upper bound on the resulting
  // candidate, so the cost never scales with the ladder):
  //   (a) the legacy plan (the most recent user message kept verbatim);
  //   (b) the same plan descended to the keep budget (shrinkToFit) — folds
  //       the OLDEST whole units of the kept suffix first; it can never
  //       cross the live prompt, so this rung still preserves the task
  //       verbatim and only helps when the suffix overshoots the budget for
  //       reasons other than the prompt itself (e.g. a huge atomic tool
  //       unit behind it);
  //   (c) the last rung: fold down to the budget with the prompt foldable
  //       (preserveLastUser:false) — chosen ONLY when every rung that keeps
  //       the prompt verbatim provably cannot fit the input budget. The
  //       task survives via the summary (the summarizer prompt requires the
  //       user's goal), so this rung is lossless-by-summary, not
  //       lossless-verbatim; the alternative is an over-budget request that
  //       the provider rejects.
  // The upper bound for a rung is its kept suffix + the largest summary an
  // accepted response can produce (the summarizer's maxTokens) + overhead.
  // A rung whose bound exceeds requestBudget cannot produce a fitting
  // candidate at ANY summary size, so the deepest bound-fitting rung is the
  // shallowest one that can win; the final (actual-summary-size) check
  // below stays authoritative and may still return `fitsInputBudget:false`.
  const requestBudget = opts.model.contextWindow - opts.model.maxTokens - 1024;
  const estimatedTokensBefore = estimateTokens(opts.context, cpt) + promptOverhead;
  const suffixTokens = (p: CompactionPlan): number =>
    p.kept.reduce((s, m) => s + estimateMessageTokens(m, cpt), 0);
  // The summary rides into the context inside its wrapper (SUMMARY_MARKER +
  // separator + the summary text). The old bound omitted the wrapper, so a
  // "bound-fitting" fold candidate could still miss the budget by the
  // wrapper and have dropped the live prompt for nothing (audit finding 5).
  const summaryWrapperTokens = estimateMessageTokens(makeSummaryMessage(""), cpt);
  // Upper bound for a rung: kept suffix + the LARGEST summary an accepted
  // response can produce (the summarizer's maxTokens) + wrapper + overhead.
  // Above it the candidate can NEVER fit at any summary size; at/below it
  // the actual candidate (summary ≤ bound) is guaranteed to fit. A FAILED
  // bound is uncertainty, not proof of impossibility (audit finding 1): a
  // rung over the bound may still fit with a smaller actual summary.
  const boundFits = (p: CompactionPlan | undefined): boolean =>
    p !== undefined && suffixTokens(p) + summarizerMaxTokens(opts.model) + summaryWrapperTokens + promptOverhead <= requestBudget;
  // Floor for a plan: the smallest candidate it can ever produce — the kept
  // suffix + the wrapper around an EMPTY summary + overhead. Above the
  // floor even a zero-token summary cannot make the plan fit: this is proof
  // of impossibility (the only proof available for a summary carrier).
  const floorFits = (p: CompactionPlan | undefined): boolean =>
    p !== undefined && suffixTokens(p) + summaryWrapperTokens + promptOverhead <= requestBudget;

  let plan: CompactionPlan | undefined;
  let strictFoldRung = false; // true when the prompt-fold rung (c) was selected
  /** The fold plan to fall to AFTER a preserving candidate demonstrated it
   *  does not fit (fold-after-demonstration, audit finding 1). */
  let foldAfterDemo: CompactionPlan | undefined;
  if (opts.strictFit) {
    const p1 = planCompaction(opts.context, keepTokens, cpt, { preserveLastUser: true, shrinkToFit: false });
    const p2 = planCompaction(opts.context, keepTokens, cpt, { preserveLastUser: true, shrinkToFit: true });
    if (boundFits(p1)) {
      plan = p1;
    } else if (boundFits(p2)) {
      plan = p2;
    } else {
      // No prompt-preserving rung can bound-fit. FIRST check the cheapest
      // carrier compactNow still owns: the REAL rule-based notice (no LLM,
      // ≤512 chars) for the deepest preserving plan — measured as-is, not
      // bounded by a hypothetical 512-char notice, which proved nothing
      // (audit finding 2: the actual notice is usually much smaller, and
      // when it fits the preserving plan is KEPT and compactNow's notice
      // rung lands that fit with the live prompt verbatim).
      const noticePreservingPlan = p2 ?? p1;
      const realNotice = noticePreservingPlan
        ? ruleBasedShrink(opts.context, keepTokens, cpt, { preserveLastUser: true, shrinkToFit: true })
        : undefined;
      const noticePreservingFits =
        realNotice !== undefined &&
        estimateTokens([realNotice.notice, ...realNotice.kept], cpt) + promptOverhead <= requestBudget;
      plan = noticePreservingFits ? noticePreservingPlan : undefined;
      if (!noticePreservingFits) {
        const p3 = planCompaction(opts.context, keepTokens, cpt, {
          preserveLastUser: false,
          shrinkToFit: true,
        });
        // The prompt fold is legitimate only if it BUYS A FIT: strictly
        // deeper than the preserving plan AND a real summary budget is
        // left over its kept tail — the headroom after suffix + wrapper +
        // overhead. The old gate required the LARGEST summary to fit,
        // rejecting folds that would have fit with the actual summary
        // (audit finding 1); the fold rung now CAPS the summarizer's
        // output at the available headroom, so an accepted response is
        // guaranteed to fit — the fit is bought, not hoped for. Below a
        // usable stub (MIN_FOLD_SUMMARY_TOKENS) there is nothing to cap:
        // folding would lose the task verbatim for nothing, so keep the
        // preserving plan and let the caller apply the best candidate.
        const foldHeadroom = (p: CompactionPlan): number =>
          requestBudget - (suffixTokens(p) + summaryWrapperTokens + promptOverhead);
        const MIN_FOLD_SUMMARY_TOKENS = 64;
        const foldable =
          p3 && p3.keepFrom > (p2?.keepFrom ?? 0) && foldHeadroom(p3) >= MIN_FOLD_SUMMARY_TOKENS ? p3 : undefined;
        if (foldable && !floorFits(noticePreservingPlan)) {
          // No preserving summary — whatever its size — can ever fit: the
          // fold is necessary NOW, so make the single summarizer call on
          // the fold transcript (which carries the live prompt) instead of
          // wasting a call on a preserving plan that provably fails.
          plan = foldable;
          strictFoldRung = true;
        } else if (foldable) {
          // The preserving plan MIGHT fit (its floor does) — impossibility
          // is not proved, only uncertainty. Attempt the preserving plan
          // first; if the actual summary demonstrates it does not fit, the
          // fold is tried next (fold-after-demonstration, below).
          plan = noticePreservingPlan;
          foldAfterDemo = foldable;
        } else {
          plan = noticePreservingPlan;
        }
      }
    }
  } else {
    plan = planCompaction(opts.context, keepTokens, cpt);
  }
  if (!plan) return undefined;

  // Run the summarizer for one candidate plan. Returns the summary text, or
  // one of the terminal causes: "failed" (stream error — the caller's retry
  // ladder owns this), "aborted" (user cancel), "empty" (no text), or
  // "too-big" (the summarizer's own input doesn't fit the window — the old
  // `return undefined`; compactNow's shrunken-transcript retry is the cure).
  const summarizeFor = async (
    p: CompactionPlan,
    foldRung: boolean,
  ): Promise<{ text: string } | "failed" | "aborted" | "empty" | "too-big"> => {
    let text = "";
    let failed = false;
    let aborted = false;
    try {
      // Fold rung (strict fit): cap the summarizer's OUTPUT at the headroom
      // left over the kept suffix, so an accepted response is sized to
      // actually fit the budget instead of being allowed to blow it (audit
      // finding 1: "constrain their summary allowance to available
      // headroom"). The estimate (chars/cpt) and the provider's token count
      // can still drift, so `fitsInputBudget` below stays honest either way.
      let maxOut = summarizerMaxTokens(opts.model);
      if (foldRung && opts.strictFit) {
        const outHeadroom = requestBudget - (suffixTokens(p) + summaryWrapperTokens + promptOverhead);
        if (outHeadroom < maxOut) maxOut = Math.max(64, Math.floor(outHeadroom));
      }
      const summarizerModel = { ...opts.model, maxTokens: maxOut };
      const prompt = summarizePrompt(
        p,
        {
          perMessageChars: opts.transcriptOpts?.perMessageChars ?? 1500,
          totalChars: opts.transcriptOpts?.totalChars ?? Math.max(4000, Math.floor(opts.model.contextWindow / cpt)),
          toolResultChars: opts.transcriptOpts?.toolResultChars ?? 2000,
          // D26: on the prompt-fold rung the summary's whole job is to carry
          // the live task — the transcript must deliver it, so the last user
          // message survives the transcript budget first (oldest turns are
          // dropped, then clipped; the prompt is middle-clipped only when it
          // alone exceeds the budget). On preserving rungs the prompt is kept
          // verbatim, so the flag is a no-op there and stays off.
          priorityLastUser: foldRung,
        },
        opts.model.contextWindow,
        { charsPerToken: cpt, outputTokens: summarizerModel.maxTokens },
      );
      // Use the identical calibrated estimate and completion reservation that
      // summarizePrompt used to construct this request.
      const summaryInputTokens = Math.ceil((SUMMARIZER_SYSTEM.length + prompt.length) / cpt);
      if (summaryInputTokens + summarizerModel.maxTokens > opts.model.contextWindow) return "too-big";
      for await (const ev of opts.streamFn(summarizerModel, {
        systemPrompt: SUMMARIZER_SYSTEM,
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        tools: [],
      }, { signal: opts.signal })) {
        if (ev.type === "text_delta") text += ev.delta;
        if (ev.type === "done") {
          // `length` is NOT a failure: the model produced the maximum allowed
          // output (the summarizer cap) — a truncated but structured summary is
          // still usable and a strict reduction of the context, so it is
          // ACCEPTED (the final text.trim() === "" guard below still rejects a
          // length stop that yielded no text). Treating `length` as total
          // failure was the root cause of the 100% fallback rate: a structured
          // GOAL/DONE/STATE/FILES/NEXT summary of a long context regularly
          // exceeds the old 1024 cap, so every compaction fell through to the
          // lossy rule-based notice.
          if (
            ev.message.stopReason === "error" ||
            ev.message.stopReason === "aborted"
          ) failed = true;
          if (ev.message.stopReason === "aborted") aborted = true;
        }
      }
    } catch {
      // I3: the stream contract says it never throws, but be defensive.
      failed = true;
    }
    // Abort wins over failure: an aborted stream sets both flags above, and
    // the CAUSE decides the caller's move (a fold abort is terminal; a fold
    // failure preserves the candidate in hand).
    if (aborted || opts.signal.aborted) return "aborted";
    if (failed) return "failed";
    if (text.trim() === "") return "empty";
    return { text: text.trim() };
  };

  // Final fit validation (the keep budget is only a PLANNING target — atomic
  // tool-call/result units can't be split, so the kept suffix may exceed it):
  // the COMPLETE candidate, summary + kept + fixed prompt overhead, is
  // estimated and returned. The caller (compactNow) owns the policy for a
  // candidate that still exceeds the window; `compactContext` itself only
  // refuses candidates that do not shrink the context at all — a summary
  // larger than the prefix it replaces would ENLARGE the next request,
  // which is strictly worse than skipping the compaction.
  let outcome = await summarizeFor(plan, strictFoldRung);
  // A user abort at any summarizer call is TERMINAL (audit finding 3): the
  // stream's abort reason can be invisible to the caller (its own signal may
  // not be set), so `undefined` must not absorb it — report the sentinel and
  // let compactNow stop its ladder instead of retrying lossy fallbacks right
  // after the user cancelled.
  if (outcome === "aborted") return COMPACT_ABORTED;
  if (outcome === "failed" || outcome === "empty") return undefined;
  if (outcome === "too-big") return undefined;
  // Fold-after-demonstration (audit finding 1): the preserving plan was
  // selected because no impossibility proof existed — its floor fit, so a
  // small summary could fit. If the ACTUAL summary demonstrates the
  // candidate busts the budget, the fold (whose floor fit) is tried next:
  // the first call proved the preserving rung impossible, the second gets
  // the fit. A fitting preserving candidate never reaches the fold.
  if (
    opts.strictFit &&
    foldAfterDemo &&
    estimateTokens([makeSummaryMessage(outcome.text), ...plan.kept], cpt) + promptOverhead > requestBudget
  ) {
    const foldOutcome = await summarizeFor(foldAfterDemo, true);
    // A user abort during the fold is TERMINAL (the user pressed ESC) — no
    // candidate, no notice fallback, even though the preserving candidate is
    // still in hand. A stream failure/empty/too-big fold is different: the
    // preserving candidate survives (honestly over budget), and compactNow
    // falls through to the rule-based notice that fits (audit finding 2).
    if (foldOutcome === "aborted") return COMPACT_ABORTED;
    if (foldOutcome !== "failed" && foldOutcome !== "empty" && foldOutcome !== "too-big") {
      // A fold replaces the preserving candidate ONLY when it BUYS THE FIT
      // on the ACTUAL summary (audit finding 2): the call is capped in
      // PROVIDER tokens, the fit is judged in chars/cpt, and those units
      // drift — a capped response can still estimate over the budget. A
      // fold that does not fit discards the live prompt for nothing, so it
      // is thrown away and the preserving candidate is kept (honestly
      // over budget; compactNow's ladder owns the rest).
      const foldEstimate =
        estimateTokens([makeSummaryMessage(foldOutcome.text), ...foldAfterDemo.kept], cpt) + promptOverhead;
      if (foldEstimate <= requestBudget) {
        plan = foldAfterDemo;
        strictFoldRung = true;
        outcome = foldOutcome;
      }
    }
  }
  let estimatedTokensAfter =
    estimateTokens([makeSummaryMessage(outcome.text), ...plan.kept], cpt) + promptOverhead;
  // D26 audit round 2 (finding 1): the "fold must buy the fit" guard covers
  // the DIRECT fold rung too. The fold-after-demo path above already rejects
  // a drift-busted fold; the directly-selected fold (the preserving floor
  // provably cannot fit) ran under the same non-enforceable cap — the cap
  // rides on the summarizer model's maxTokens, which a compat.extraParams
  // override or a cap-ignoring endpoint can defeat. A response whose REAL
  // estimated size busts the request budget discards the live prompt for
  // NOTHING (the whole point of folding was to fit), so it is rejected:
  // `undefined` hands compactNow's ladder the notice rung, which keeps the
  // live prompt verbatim (over budget itself — the preserving floor proved
  // that irreducible — but never strictly worse than a prompt-losing
  // over-budget fold). The check covers EVERY strictFoldRung outcome: the
  // direct rung AND a fold adopted after demonstration.
  if (strictFoldRung && estimatedTokensAfter > requestBudget) return undefined;
  // A candidate must shrink the context — EXCEPT on the strict-fit prompt-
  // fold rung that ACTUALLY folded the live prompt: that rung was selected
  // because its bound provably fits the request budget, and the alternative
  // (falling through to compactNow's lossier notice rung) discards a proven
  // budget fit over a technicality. Audit round 2 (finding 2): a
  // preserveLastUser:false plan only ALLOWS folding the live prompt — the
  // descent can stop short of it (the suffix reaches the target first), so
  // `strictFoldRung` alone never proved the prompt was consumed. A fold
  // candidate that kept the live prompt verbatim is an ordinary candidate
  // and must clear the ordinary shrink bar (it is still budget-guarded
  // above); the growth exemption belongs solely to the case where the
  // prompt really crossed into the summary — there the candidate may be
  // larger than the original (the live prompt alone can exceed it) and is
  // still strictly better than an over-budget request.
  const liveUserIndex = (() => {
    for (let i = opts.context.length - 1; i >= 0; i--) if (opts.context[i]!.role === "user") return i;
    return -1;
  })();
  const livePromptFolded = liveUserIndex < 0 || plan.keepFrom > liveUserIndex;
  if (estimatedTokensAfter >= estimatedTokensBefore && !(strictFoldRung && livePromptFolded)) return undefined;
  return {
    summary: outcome.text,
    kept: plan.kept,
    estimatedTokensAfter,
    estimatedTokensBefore,
    tokensBefore: lastAssistant?.usage?.totalTokens ?? 0,
    requestBudget,
    fitsInputBudget: estimatedTokensAfter <= requestBudget,
  };
}
