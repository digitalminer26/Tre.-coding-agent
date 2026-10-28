/**
 * WS1 — OpenAI-compatible chat/completions wire layer (the first StreamFn).
 *
 * Owns (per docs/02-contracts.md, Contract 3):
 *   - request building (buildParams / convertMessages)
 *   - SSE parse → normalized AssistantStreamEvents
 *   - per-index tool-call argument accumulation + best-effort JSON salvage
 *   - usage capture, bounded retry (in wire/http.ts), abort
 *
 * L2: structure adapted from @earendil-works/pi-ai 0.85.1 (MIT, © Mario
 *      Zechner) — the OpenAI-compatible wire shape (docs/01 §2–3):
 *      request building (assistant content as a string, tool args as a
 *      JSON string, per-model compat flags), SSE → normalized events
 *      (`start`/`text_delta`/`thinking_delta`/`toolcall_*`/`done`), and
 *      the best-effort salvage parse of truncated tool-call argument JSON
 *      (docs/01 §3, §4.1, §9 "Simplify"/"Copy"). The implementation is L3.
 *
 * Invariants: exactly one `start` … one `done` per call, even on failure
 * (I2/I3). Endpoint quirks live in ModelCompat — one code path for all
 * OpenAI-compatible servers (incl. llama.cpp, whose quirks: `model` is the
 * full GGUF path, thinking models emit `reasoning_content`).
 */
import type {
  AssistantMessage,
  AssistantStreamEvent,
  ContentBlock,
  LlmContext,
  ModelConfig,
  StreamFn,
  ToolCallBlock,
  Usage,
} from "../types.js";
import { HttpError, sseStream, type SseFrame } from "./http.js";
import { isAbort } from "./abort.js";

// ───────────────────────── request building ─────────────────────────

export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** One OpenAI-wire message (assistant `content` is a string, never an array). */
export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

/**
 * Sanitize a tool-call id for the wire: alphanumerics + `-_`, ≤ 64 chars.
 * Empty → synthesized. Applied both when receiving (once) and when resending
 * (idempotent), so ids stay stable across request/response cycles.
 */
export function sanitizeCallId(id: string, fallbackIndex?: number): string {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (clean.length > 0) return clean;
  return `call_${(fallbackIndex ?? 0) + 1}_${Date.now().toString(36)}`;
}

export function convertMessages(model: ModelConfig, ctx: LlmContext): WireMessage[] {
  const compat = model.compat ?? {};
  const out: WireMessage[] = [];
  if (ctx.systemPrompt) out.push({ role: "system", content: ctx.systemPrompt });

  const msgs = ctx.messages;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      const calls = m.content.filter((b) => b.type === "toolCall");
      // Empty assistant messages (no text, no calls) are skipped — some
      // endpoints reject them.
      if (text.length === 0 && calls.length === 0) continue;
      const msg: WireMessage = { role: "assistant", content: text };
      if (calls.length > 0) {
        msg.tool_calls = calls.map((c, j) => ({
          id: sanitizeCallId(c.id, j),
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        }));
      }
      out.push(msg);
      continue;
    }
    // toolResult → OpenAI "tool" message
    out.push({
      role: "tool",
      tool_call_id: sanitizeCallId(m.toolCallId, i),
      content: m.content.map((b) => b.text).join("\n"),
    });
    // Some endpoints require an assistant turn between tools and the next
    // user message.
    const next = msgs[i + 1];
    if (compat.requiresAssistantAfterToolResult && next?.role === "user") {
      out.push({ role: "assistant", content: "" });
    }
  }
  return out;
}

/** Build the full chat/completions request body. */
export function buildParams(model: ModelConfig, ctx: LlmContext): Record<string, unknown> {
  const compat = model.compat ?? {};
  const params: Record<string, unknown> = {
    model: model.id,
    messages: convertMessages(model, ctx),
    stream: true,
  };
  if (ctx.tools.length > 0) {
    params.tools = ctx.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  // OpenRouter automatic prompt caching (docs/features/prompt-caching): a
  // top-level `cache_control` makes the provider apply a breakpoint to the
  // last cacheable block and advance it as the conversation grows. Anthropic
  // models NEVER cache implicitly — without this, nothing is ever written to
  // the cache. Only sent when the model opts in (compat.promptCaching).
  if (compat.promptCaching) {
    params.cache_control = { type: "ephemeral" };
  }
  // Slot affinity (prompt-cache): llama-server --parallel assigns slots by
  // hash of the official OpenAI `user` field. When the model opts in and the
  // session dispatcher injected an affinityKey, send it — this pins the
  // session's requests to one slot so concurrent sessions stop evicting each
  // other's prefix cache. Only sent when both are set: absent = old behavior.
  if (compat.slotAffinity && ctx.affinityKey !== undefined) {
    params.user = ctx.affinityKey;
  }
  params[compat.maxTokensField ?? "max_tokens"] = model.maxTokens;
  if (typeof model.temperature === "number") params.temperature = model.temperature;
  if (compat.supportsUsageInStreaming !== false) {
    params.stream_options = { include_usage: true };
  }
  if (compat.extraParams) Object.assign(params, compat.extraParams);
  return params;
}

export function completionsUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/chat/completions";
}

// ─────────────────────── tool-call arg salvage ───────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The leaked closing-protocol tail: a value ending in whitespace, one of
 *  the Qwen chat-template close markers, and nothing but whitespace after.
 *  Anchored at the END of the string so interior tag-like content (XML
 *  fixtures, heredocs, file writes: "first\n</function>\nlast") is NEVER
 *  matched — only a marker the model leaked at the very end of an argument. */
const LEAKED_TAIL_RE = /[ \t]{0,64}(?:\r?\n)?[ \t]{0,64}<\/(?:parameter|function|tool_call)>(?:\r?\n|[ \t])*$/;

/** Remove leaked protocol tails from string VALUES of a parsed args object
 *  (recursing into nested objects/arrays). Values not ending in a marker
 *  are returned untouched. */
function stripLeakedTails(v: unknown): unknown {
  if (typeof v === "string") {
    // Loop: leaked markers arrive stacked (`...</parameter>\n</function>\n
    // </tool_call>`); each pass removes the last one until the tail is clean.
    let s = v;
    while (LEAKED_TAIL_RE.test(s)) s = s.replace(LEAKED_TAIL_RE, "");
    return s;
  }
  if (Array.isArray(v)) return v.map(stripLeakedTails);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = stripLeakedTails(val);
    return out;
  }
  return v;
}

function tryParseObject(s: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(s);
    return isPlainObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort parse of accumulated tool-call argument JSON.
 *   1. straight JSON.parse (UNTOUCHED — legitimate arguments containing
 *      tag-like content are never altered)
 *   2. repair of truncation (close a dangling string, then close open
 *      braces/brackets; if still bad, drop the trailing incomplete member
 *      and retry)
 *   3. {} — the loop's `length`→fail-all guard makes salvage best-effort
 *
 * PROTOCOL-LEAK REPAIR IS OPT-IN (`repairLeakedProtocol`, i.e.
 * `compat.repairsLeakedToolProtocol` on the model): llama.cpp's Qwen3.8
 * chat template asks for XML-like tool calls and its parser can leak the
 * closing markers into the TAIL of a string argument, e.g.
 * {"command":"printf hello\n</parameter>"}. A value legitimately ENDING in
 * one of those tags (a file write, an edit target, an XML fixture — e.g.
 * {"content":"<function>hello</function>"}) is textually indistinguishable
 * from a leak, so stripping unconditionally corrupted valid arguments
 * (audit finding 1). OFF (the default): parsed values are returned
 * verbatim. ON (only for known-leaking endpoints): after parsing, each
 * string value's leaked tail (LEAKED_TAIL_RE) is removed, and the
 * salvage path first strips structural leak sequences text-wide from
 * already-invalid input. Truncation repair (2) runs either way — closing
 * open containers never alters complete values.
 */
export function parseToolArgs(
  raw: string,
  opts?: { repairLeakedProtocol?: boolean },
): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  const repair = opts?.repairLeakedProtocol === true;
  const direct = tryParseObject(raw);
  if (direct !== undefined) {
    return (repair ? stripLeakedTails(direct) : direct) as Record<string, unknown>;
  }
  // Invalid JSON (truncated, or — on leaking endpoints — markers spliced
  // mid-document): strip structural leak sequences text-wide for the
  // salvage attempt only, and only when the endpoint is known to leak.
  // Two cleaning variants, tried in LOSSLESS-FIRST order. (1) Plain strip:
  // markers spliced inside an unterminated value (`{"command":"echo\n
  // </function>\n, keep-going`) — deleting the marker keeps the value
  // intact and truncation repair closes the string, so ALL the content
  // survives. (2) Quote-restoring, only when variant 1 yields no parse:
  // llama.cpp swallows the value's CLOSING QUOTE when it leaks —
  // `{"command":"ls\n</parameter>\n,"path":"a.ts"` — so the whole
  // `<newline></marker><newline>` sequence is replaced WITH the quote the
  // endpoint ate. Variant 1 cannot parse that shape (the swallowed quote
  // leaves `"ls,"path"`), and variant 2 is lossy for variant-1-shaped input
  // (it closes the value early and drops the trailing member), so the
  // order is: preserve content whenever possible, restore the quote when
  // that is provably the leak shape. Without repair only the plain text
  // is tried.
  // The quote-restoring variant matches a RUN of consecutive leaked markers
  // (audit round 4, finding 1): the endpoint often emits the whole closing
  // chain (`</parameter>\n</function>\n</tool_call>`) and swallowed exactly ONE
  // closing quote — replacing each marker with a quote produced `"ls""` +
  // stray tags (no parse), and the first match eating its trailing newline
  // made the NEXT marker unmatched (no leading newline). One run → one
  // restored quote, so `ls\n</parameter>\n</function>\n,"path":"a.ts"` becomes
  // `ls","path":"a.ts"`.
  //
  // Round 5 (finding 1): the restoration is RUN-AWARE, not unconditional.
  // In one document some values may have lost their closing quote while
  // others kept theirs (`"command":"ls\n</parameter>\n,"path":"a.ts
  // </parameter>\n"`); inserting a quote into an INTACT run corrupts the
  // survivor (`a.ts""` → no parse, both fields lost to the drop salvage).
  // A run is therefore repaired by what FOLLOWS it: a surviving `"` right
  // after the run means the quote was never eaten → DELETE the run (the
  // quote stays); anything else (`,` `}` EOF, junk) means the quote was
  // swallowed → insert exactly ONE quote.
  // Round 5 (finding 2): the separator between markers in a run allows
  // REPEATED newlines/whitespace — a blank line between `</parameter>` and
  // `</function>` must not split the chain (else neither marker matches
  // with a leading separator and the whole run fails to restore).
  // Leaked-run grammar. A protocol separator is a real newline or an UNPAIRED
  // JSON `\n` escape (an even number of backslashes precedes its backslash).
  // A marker may ALSO follow literal user text `\\n` (an escaped backslash
  // then `n`) directly: LITERAL_LEAD is a zero-width assertion, so the user's
  // escape pair is never consumed and is kept by every replacement below.
  const SEP_RE = String.raw`(?<=(?:^|[^\\])(?:\\\\)*)\\r\\n|(?<=(?:^|[^\\])(?:\\\\)*)\\n|(?<=(?:^|[^\\])(?:\\\\)*)\\t|\r?\n`;
  const LITERAL_LEAD_RE = "(?<=(?:^|[^\\\\])(?:\\\\\\\\)*\\\\\\\\n)";
  const MARK_RE = "<\\/(?:parameter|function|tool_call)>";
  const LEAD_RE = "(?:" + SEP_RE + "|" + LITERAL_LEAD_RE + ")";
  const RUN_MARK_RE = "<\\/(?:parameter|function|tool_call)>";
  // Bounded filler around separators: unbounded whitespace runs inside this
  // grammar made matching superlinear (an 8k-space run ≈ 1s, 32k ≈ 20s — the
  // lookbehind in SEP_RE re-scans per position, audit finding 1). The bounds
  // are a MEASURED LIMIT, not an observed-shape survey: gaps cap at 64 chars
  // and a chain at 64 separator units / 64 markers (raising 8→64 costs
  // nothing measurable — well under 1ms even on a 32k-newline input — so the
  // generous chain bound is free). A longer run simply fails to match and
  // falls through to `{}` salvage, the same as HEAD.
  const GAP_RE = "[ \\t]{0,64}";
  const SEP_UNIT_RE = GAP_RE + "(?:" + SEP_RE + ")" + GAP_RE;
  // A whole leaked run: lead, marker, further (separator-linked) markers,
  // and trailing separators/gaps.
  const runRe = new RegExp(
    GAP_RE + LEAD_RE + GAP_RE + MARK_RE +
      "(?:" + SEP_UNIT_RE + "(?:" + SEP_UNIT_RE + ")*" + MARK_RE + "){0,64}" +
      "(?:" + SEP_UNIT_RE + "){0,64}" + GAP_RE,
    "g",
  );
  // The plain strip removes each lead+marker pair and keeps everything else.
  const markerRe = new RegExp(LEAD_RE + "[ \\t]*" + MARK_RE, "g");
  // Trailing separator run at the END of the document. Bounded like the run
  // grammar: `(?:SEP)+` on a 32k-newline tail scanned superlinearly (each
  // repeat re-runs SEP's lookbehind over the consumed prefix). 64 separators
  // matches the chain bound; raising 8→64 measured free.
  const trailingSepRe = new RegExp("(?:" + GAP_RE + "(?:" + SEP_RE + ")){0,64}" + GAP_RE + "$", "g");
  // A run immediately followed by a surviving quote is an intact leaked tail
  // (delete it); normalizing it in both variants keeps blank-line separators
  // from inflating the plain variant's payload score.
  const intactRunsCleaned = repair
    ? raw.replace(runRe, (run: string, offset: number, s: string) =>
        s[offset + run.length] === '"' ? (run.includes("</") ? "" : run) : run,
      )
    : raw;
  const cleanedVariants = repair
    ? [
        // Plain strip: markers removed, the rest kept verbatim.
        intactRunsCleaned.replace(markerRe, "").replace(trailingSepRe, ""),
        // Quote restore: a run followed by non-quote context had its quote swallowed.
        intactRunsCleaned
          .replace(runRe, (run: string, offset: number, s: string) => (s[offset + run.length] === '"' ? (run.includes("</") ? "" : '"') : '"'))
          .replace(trailingSepRe, ""),
      ]
    : [raw];
  // Two passes over the cleaning variants (audit round 3, finding 1): PASS 1
  // accepts only NON-DROPPING repairs (the whole document closed) — a
  // member-dropping salvage of the plain variant must never suppress a full
  // recovery the quote-restoring variant could still parse (e.g.
  // `{"other":1,"command":"ls\n</parameter>\n,"path":"a.ts"}`: the plain strip
  // drops `path` at a stray comma, quote restore recovers all three fields).
  // PASS 2 allows the lossy member-drop fallback for genuinely truncated
  // input where nothing else parses.
  //
  // Within a pass, if both variants parse, prefer the candidate that retains
  // the most semantic payload AFTER leaked tails are stripped. Document
  // length is not a safe proxy: a shorter quote-restored variant can close an
  // intact string early, causing trailing members to be dropped (audit
  // finding: an intact command followed by a malformed later member). Break
  // ties by shortest repaired document, which favors treating adjacent
  // marker/newline runs as protocol rather than user text. This is still a
  // heuristic for ambiguous malformed JSON, but it preserves the fuller
  // argument value when repair paths disagree.
  const repairPass = (allowDrop: boolean): Record<string, unknown> | undefined => {
    let candidates: { doc: string; v: Record<string, unknown>; score: number }[] = [];
    for (const cleaned of cleanedVariants) {
      const repaired = repairTruncatedJson(cleaned, allowDrop);
      if (repaired === undefined) continue;
      const parsed = tryParseObject(repaired);
      if (parsed === undefined) continue;
      const v = (repair ? stripLeakedTails(parsed) : parsed) as Record<string, unknown>;
      // Lossless repair keeps the established shortest-document preference:
      // it treats adjacent marker/newline runs as protocol. In the lossy
      // member-dropping pass, however, a longer parsed value is evidence that
      // the repair preserved more of an intact argument rather than closing
      // it prematurely at a marker.
      const score = allowDrop ? JSON.stringify(v).length : 0;
      candidates.push({ doc: repaired, v, score });
    }
    if (candidates.length === 0) return undefined;
    const maxScore = Math.max(...candidates.map((candidate) => candidate.score));
    candidates = candidates.filter((candidate) => candidate.score === maxScore);
    candidates.sort((a, b) => a.doc.length - b.doc.length);
    return candidates[0]!.v;
  };
  const won = repairPass(false) ?? repairPass(true);
  if (won !== undefined) return (repair ? stripLeakedTails(won) : won) as Record<string, unknown>;
  return {};
}

/** Close a JSON string truncated mid-value/mid-key. Returns undefined if hopeless.
 *  `allowDropMember: false` disables the trailing-member-dropping fallback, so
 *  a result is then provably NON-LOSSY (the whole document closed) — used by
 *  the leak-repair loop, which must not let a member-dropping salvage of one
 *  cleaning variant suppress a full recovery of another (audit round 3). */
function repairTruncatedJson(raw: string, allowDropMember = true): string | undefined {
  const attempt = (s: string): string | undefined => {
    let inStr = false;
    let esc = false;
    const stack: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{" || c === "[") stack.push(c);
      else if (c === "}" || c === "]") stack.pop();
    }
    // Manual whitespace/comma suffix trim. The previous regex form ended in
    // a dollar anchor and V8 re-ran that match at every start index, so a
    // long whitespace/quote tail made attempt() superlinear (64k spaces took
    // about one second per call, audit finding 1). A backward scan is linear
    // in the suffix, not quadratic in the document.
    let out = s;
    if (inStr) out += '"';
    let end = out.length;
    while (
      end > 0 &&
      (out[end - 1] === " " ||
        out[end - 1] === "\t" ||
        out[end - 1] === "\n" ||
        out[end - 1] === "\r" ||
        out[end - 1] === ",")
    ) {
      end--;
    }
    const trimmed = out.slice(0, end);
    if (trimmed.endsWith(":")) out = trimmed + "null";
    for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === "{" ? "}" : "]";
    return out;
  };

  const first = attempt(raw);
  if (first === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(first);
    if (isPlainObject(v)) return first;
  } catch {
    /* try dropping the trailing incomplete member */
  }
  // Find the last top-level comma and retry on the shorter prefix.
  let inStr = false;
  let esc = false;
  let lastComma = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === ",") lastComma = i;
  }
  if (lastComma > 0 && allowDropMember) {
    const second = attempt(raw.slice(0, lastComma));
    if (second !== undefined) {
      try {
        const v: unknown = JSON.parse(second);
        if (isPlainObject(v)) return second;
      } catch {
        /* give up */
      }
    }
  }
  return undefined;
}

// ──────────────────────── streaming state machine ────────────────────────

interface ToolEntry {
  id: string;
  name: string;
  raw: string;
  lastGood: Record<string, unknown>;
  block: ToolCallBlock;
}

interface Finish {
  reason: AssistantMessage["stopReason"];
  message?: string;
}

function mapUsage(u: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}): Usage {
  return {
    input: u.prompt_tokens ?? 0,
    output: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
    ...(typeof u.prompt_tokens_details?.cached_tokens === "number"
      ? { cacheRead: u.prompt_tokens_details.cached_tokens }
      : {}),
    // OpenRouter reports cache writes separately (explicit-caching models,
    // e.g. Anthropic via `cache_control`); endpoints without explicit
    // caching simply omit the field.
    ...(typeof u.prompt_tokens_details?.cache_write_tokens === "number"
      ? { cacheWrite: u.prompt_tokens_details.cache_write_tokens }
      : {}),
  };
}

function mapFinish(reason: string): Finish {
  switch (reason) {
    case "stop":
      return { reason: "stop" };
    case "tool_calls":
    case "function_call":
      return { reason: "toolUse" };
    case "length":
      return { reason: "length" };
    case "content_filter":
      return { reason: "error", message: "content filter triggered" };
    default:
      return { reason: "stop" };
  }
}

interface ChoiceDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface Choice {
  delta?: ChoiceDelta;
  finish_reason?: string | null;
}

function describeError(err: unknown): string {
  if (err instanceof HttpError) {
    let detail = err.body ?? "";
    try {
      const j: unknown = JSON.parse(detail);
      if (isPlainObject(j) && isPlainObject(j.error)) {
        const m = (j.error as Record<string, unknown>).message;
        if (typeof m === "string") detail = m;
      }
    } catch {
      /* keep raw body */
    }
    return `HTTP ${err.status}: ${detail}`.slice(0, 1000);
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The OpenAI-compatible StreamFn.
 *
 * Usage: `streamFn = openAiStream; events = streamFn(model, ctx, { signal })`.
 * (A per-model binding can be made with `.bind(null, model)` if desired.)
 */
export const openAiStream: StreamFn = (model, ctx, opts) => {
  return (async function* (): AsyncGenerator<AssistantStreamEvent> {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      model: model.id,
      provider: model.provider,
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const tools = new Map<number, ToolEntry>();
    let finish: Finish | undefined;
    let usage: Usage | undefined;

    const snap = (): AssistantMessage => ({
      ...message,
      content: message.content.map((b) => ({ ...b })),
    });

    yield { type: "start", partial: snap() };

    const appendText = (delta: string): void => {
      const block = message.content.find((b): b is { type: "text"; text: string } => b.type === "text");
      if (block) block.text += delta;
      else message.content.push({ type: "text", text: delta });
    };
    const appendThinking = (delta: string): void => {
      const block = message.content.find(
        (b): b is { type: "thinking"; thinking: string } => b.type === "thinking",
      );
      if (block) block.thinking += delta;
      else message.content.push({ type: "thinking", thinking: delta });
    };

    try {
      const frames = sseStream({
        url: completionsUrl(model.baseUrl),
        body: JSON.stringify(buildParams(model, ctx)),
        apiKey: opts.apiKey ?? model.apiKey,
        headers: model.headers,
        signal: opts.signal,
      });
      for await (const frame of frames) {
        if (frame.data === "[DONE]") break;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(frame.data) as Record<string, unknown>;
        } catch {
          continue; // non-JSON data line: ignore
        }
        if (isPlainObject(payload.error)) {
          const e = payload.error as Record<string, unknown>;
          finish = {
            reason: "error",
            message:
              (typeof e.message === "string" ? e.message : JSON.stringify(e)).slice(0, 1000),
          };
          break;
        }
        const u = payload.usage as
          | {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
              prompt_tokens_details?: {
                cached_tokens?: number;
                cache_write_tokens?: number;
              };
            }
          | undefined;
        if (u) usage = mapUsage(u);
        for (const choice of (payload.choices as Choice[] | undefined) ?? []) {
          const delta = choice.delta ?? {};
          if (typeof delta.content === "string" && delta.content.length > 0) {
            appendText(delta.content);
            yield { type: "text_delta", delta: delta.content, partial: snap() };
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            appendThinking(delta.reasoning_content);
            yield { type: "thinking_delta", delta: delta.reasoning_content, partial: snap() };
          }
          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            let entry = tools.get(idx);
            if (!entry) {
              const id = tc.id ? sanitizeCallId(tc.id, idx) : sanitizeCallId("", idx);
              entry = {
                id,
                name: tc.function?.name ?? "",
                raw: "",
                lastGood: {},
                block: { type: "toolCall", id, name: tc.function?.name ?? "", arguments: {} },
              };
              tools.set(idx, entry);
              message.content.push(entry.block);
              yield {
                type: "toolcall_start",
                index: idx,
                id: entry.id,
                name: entry.name,
                partial: snap(),
              };
            } else {
              if (tc.id && entry.id.startsWith("call_") && tc.id !== entry.id) {
                entry.id = sanitizeCallId(tc.id, idx);
                entry.block.id = entry.id;
              }
              if (tc.function?.name) {
                entry.name = tc.function.name;
                entry.block.name = entry.name;
              }
            }
            const frag = tc.function?.arguments;
            if (typeof frag === "string" && frag.length > 0) {
              entry.raw += frag;
              try {
                const v: unknown = JSON.parse(entry.raw);
                if (isPlainObject(v)) entry.lastGood = v;
              } catch {
                /* mid-stream: keep last good parse */
              }
              entry.block.arguments = entry.lastGood;
              yield { type: "toolcall_delta", index: idx, argsDelta: frag, partial: snap() };
            }
          }
          if (choice.finish_reason) finish = mapFinish(choice.finish_reason);
        }
      }
      if (opts.signal.aborted) finish = { reason: "aborted" };
      else if (!finish) {
        finish = message.content.length > 0
          ? { reason: "stop" }
          : { reason: "error", message: "stream ended without finish_reason" };
      }
    } catch (err) {
      finish = isAbort(err) ? { reason: "aborted" } : { reason: "error", message: describeError(err) };
    }

    // Authoritative parse of tool-call args (the partials were best-effort).
    // Protocol-leak repair only for endpoints flagged as leaking (opt-in):
    // parsed values are verbatim everywhere else.
    const repairProtocol = model.compat?.repairsLeakedToolProtocol === true;
    for (const entry of tools.values()) {
      entry.block.arguments = parseToolArgs(entry.raw, { repairLeakedProtocol: repairProtocol });
    }

    const done: AssistantMessage = { ...snap(), stopReason: finish.reason };
    if (finish.message) done.errorMessage = finish.message;
    if (usage) done.usage = usage;
    yield { type: "done", message: done };
  })();
};

/** Test helper: run a StreamFn to completion and collect its events. */
export async function collectStream(
  streamFn: StreamFn,
  model: ModelConfig,
  ctx: LlmContext,
  opts: { apiKey?: string; signal: AbortSignal },
): Promise<AssistantStreamEvent[]> {
  const out: AssistantStreamEvent[] = [];
  for await (const e of streamFn(model, ctx, opts)) out.push(e);
  return out;
}
