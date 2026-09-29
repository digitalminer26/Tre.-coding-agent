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

  // Walk backward from the last unit, growing the kept suffix until it
  // reaches keepTokens; never below the 2nd unit (kept ≥ 2 units,
  // toSummarize non-empty).
  let keepFrom = bounds[bounds.length - 1]!;
  let acc = 0;
  for (let bi = bounds.length - 1; bi >= 1; bi--) {
    keepFrom = bounds[bi]!;
    acc = 0;
    for (let i = keepFrom; i < context.length; i++) acc += per[i]!;
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
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}\n…[truncated ${s.length - max} chars]…\n${s.slice(s.length - half)}`;
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
  const seen = new Set<string>();
  const push = (list: string[], p: string): void => {
    if (list.length >= FILE_OPS_CAP || seen.has(p)) return;
    seen.add(p);
    list.push(p);
  };
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type !== "toolCall") continue;
      const p = b.arguments.path;
      if (typeof p !== "string" || p.trim() === "") continue;
      if (b.name === "read") push(read, p);
      else if (b.name === "write" || b.name === "edit") push(modified, p);
      // bash (and anything else): not parsed — commands are ambiguous.
    }
  }
  return { read, modified };
}

/** The FILES section of the summarizer prompt ("" when no file ops). */
function filesSection(plan: CompactionPlan): string {
  const ops = extractFileOps(plan.toSummarize);
  if (ops.read.length === 0 && ops.modified.length === 0) return "";
  const lines = ["FILES (extracted from the transcript — verified, copy verbatim):"];
  if (ops.read.length > 0) lines.push(`read: ${ops.read.join(", ")}`);
  if (ops.modified.length > 0) lines.push(`modified: ${ops.modified.join(", ")}`);
  return lines.join("\n");
}

/** The user message for the summarizer call. `transcriptOpts` (D retry)
 *  shrink the transcript clips; `contextWindow` (A3) scales the total
 *  transcript budget to the model's window. */
export function summarizePrompt(
  plan: CompactionPlan,
  transcriptOpts?: { perMessageChars?: number; totalChars?: number; toolResultChars?: number },
  contextWindow?: number,
): string {
  // A3: the folded prefix must fit the window anyway — let the summarizer
  // use its full available input (default 24000 for unknown windows).
  const totalChars =
    transcriptOpts?.totalChars ??
    (contextWindow && contextWindow > 0 ? Math.max(24000, Math.floor(contextWindow / 4)) : 24000);
  const transcript = renderTranscript(plan.toSummarize, {
    includeThinking: false, // A2: decisions live in text/tool calls, not reasoning traces
    totalChars,
    ...transcriptOpts,
  });
  const files = filesSection(plan);
  const base = `Summarize the conversation below so the agent can continue without seeing it. Use these sections:
1. GOAL — the user's goal(s) and constraints they stated, verbatim where possible.
2. DONE — what was completed: files touched, commands run and their outcomes, decisions made.
3. STATE — what is in progress, what is blocked or failed, open questions.
4. FILES — copy the FILES section below VERBATIM (it was extracted from the transcript; do not guess paths).
5. NEXT — the immediate next step(s) to continue the work.
Be concrete (exact paths, commands, values). Omit chit-chat. Under 500 words.

${files ? files + "\n\n" : ""}${plan.isIterative ? "An earlier summary of the older context is included at the top of the transcript; produce an UPDATED summary that folds it in with the newer messages. Do not repeat its header line.\n\n" : ""}TRANSCRIPT:
${transcript}`;
  return base;
}

export interface CompactContextResult {
  summary: string;
  kept: AgentMessage[];
  /** The last assistant usage that tripped the trigger (for the session entry). */
  tokensBefore: number;
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
  return { notice: makeSummaryMessage(lines.join("\n")), kept: plan.kept };
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
  /** D — retry with a shrunken transcript (halved clips). */
  transcriptOpts?: { perMessageChars?: number; totalChars?: number; toolResultChars?: number };
  /** A6 — skip the shouldCompact trigger check (manual /compact). */
  force?: boolean;
}): Promise<CompactContextResult | undefined> {
  let lastAssistant: AssistantMessage | undefined;
  for (let i = opts.context.length - 1; i >= 0; i--) {
    const m = opts.context[i]!;
    if (m.role === "assistant") {
      lastAssistant = m;
      break;
    }
  }
  if (!opts.force && !shouldCompact(lastAssistant?.usage, opts.model.contextWindow, opts.model.maxTokens)) {
    return undefined;
  }
  // The keep target must fit the model's window: with a small contextWindow,
  // keeping the 8192 default would leave the compacted context LARGER than
  // the window (WS10 e2e s12). Cap it at what the trigger already budgets:
  // window - maxTokens - slack.
  const windowCap = Math.max(512, opts.model.contextWindow - opts.model.maxTokens - 1024);
  const cpt = opts.charsPerToken ?? 4;
  const plan = planCompaction(opts.context, Math.min(opts.keepTokens ?? 8192, windowCap), cpt);
  if (!plan) return undefined;

  let text = "";
  let failed = false;
  try {
    for await (const ev of opts.streamFn(opts.model, {
      systemPrompt: SUMMARIZER_SYSTEM,
      messages: [
        {
          role: "user",
          content: summarizePrompt(plan, opts.transcriptOpts, opts.model.contextWindow),
          timestamp: Date.now(),
        },
      ],
      tools: [],
    }, { signal: opts.signal })) {
      if (ev.type === "text_delta") text += ev.delta;
      if (ev.type === "done") {
        if (ev.message.stopReason === "error") failed = true;
      }
    }
  } catch {
    // I3: the stream contract says it never throws, but be defensive.
    failed = true;
  }
  if (failed || text.trim() === "") return undefined;
  return { summary: text.trim(), kept: plan.kept, tokensBefore: lastAssistant?.usage?.totalTokens ?? 0 };
}
