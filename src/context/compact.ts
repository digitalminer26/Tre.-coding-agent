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
 *               ESTIMATED: chars/4), snapped to unit boundaries so a
 *               toolCall assistant message is never split from its
 *               ToolResultMessages, and always including the most recent
 *               user message (the current task must survive).
 *   summary   — ONE silent LLM call (no tools, events consumed, not yielded)
 *               over the folded messages. Iterative: if the context already
 *               starts with a previous summary, the prompt folds it in.
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

/** Estimated tokens for one message: total chars / 4 (ceiling). */
export function estimateMessageTokens(m: AgentMessage): number {
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
  return Math.ceil(chars / 4);
}

export function estimateTokens(messages: AgentMessage[]): number {
  let t = 0;
  for (const m of messages) t += estimateMessageTokens(m);
  return t;
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
): CompactionPlan | undefined {
  const bounds = unitBoundaries(context);
  if (bounds.length < 3) return undefined; // need ≥1 unit to fold + ≥2 kept
  const per = context.map(estimateMessageTokens);

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

  // The most recent user message must survive (it is itself a boundary).
  let lastUser = -1;
  for (let i = context.length - 1; i >= 0; i--) {
    if (context[i]!.role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser >= 0 && lastUser < keepFrom) keepFrom = lastUser;

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

/** Render messages as a transcript for the summarizer prompt. */
export function renderTranscript(
  messages: AgentMessage[],
  opts: { perMessageChars?: number; totalChars?: number } = {},
): string {
  const per = opts.perMessageChars ?? 1500;
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push(`[User] ${m.content}`);
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "text" && b.text) out.push(`[Assistant] ${b.text}`);
        if (b.type === "thinking" && b.thinking) out.push(`[Assistant thought] ${b.thinking}`);
        if (b.type === "toolCall")
          out.push(`[Assistant → tool] ${b.name} ${JSON.stringify(b.arguments)}`);
      }
    } else {
      const status = m.isError ? " (ERROR)" : "";
      for (const b of m.content) {
        out.push(`[Tool result: ${m.toolName}${status}] ${b.text}`);
      }
    }
  }
  let text = out.map((l) => clip(l, per)).join("\n");
  const total = opts.totalChars ?? 24000;
  if (text.length > total) text = clip(text, total);
  return text;
}

export const SUMMARIZER_SYSTEM =
  "You summarize a coding-agent conversation so the agent can continue without seeing the original. " +
  "Output ONLY the summary — no preamble, no questions.";

/** The user message for the summarizer call. */
export function summarizePrompt(plan: CompactionPlan): string {
  const transcript = renderTranscript(plan.toSummarize);
  const base = `Summarize the conversation below so the agent can continue without seeing it. Include:
1. The user's goal(s) and any constraints they stated.
2. What was done: files touched (paths), commands run and their outcomes, decisions made.
3. Current state: what is in progress, what is done, what is blocked or failed.
4. Anything the user explicitly asked to remember or avoid.
Be concrete (exact paths, commands, values). Omit chit-chat. Under 500 words.

${plan.isIterative ? "An earlier summary of the older context is included at the top of the transcript; produce an UPDATED summary that folds it in with the newer messages. Do not repeat its header line.\n\n" : ""}TRANSCRIPT:
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
}): Promise<CompactContextResult | undefined> {
  let lastAssistant: AssistantMessage | undefined;
  for (let i = opts.context.length - 1; i >= 0; i--) {
    const m = opts.context[i]!;
    if (m.role === "assistant") {
      lastAssistant = m;
      break;
    }
  }
  if (!shouldCompact(lastAssistant?.usage, opts.model.contextWindow, opts.model.maxTokens)) {
    return undefined;
  }
  const plan = planCompaction(opts.context, opts.keepTokens);
  if (!plan) return undefined;

  let text = "";
  let failed = false;
  try {
    for await (const ev of opts.streamFn(opts.model, {
      systemPrompt: SUMMARIZER_SYSTEM,
      messages: [{ role: "user", content: summarizePrompt(plan), timestamp: Date.now() }],
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
  return { summary: text.trim(), kept: plan.kept, tokensBefore: lastAssistant!.usage!.totalTokens };
}
