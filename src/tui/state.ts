/**
 * WS10 — pure TUI state machine (no Ink, no I/O — unit-testable).
 *
 * The TUI consumes the SAME `AgentEvent` stream the plain CLI prints
 * (D5/D11): `applyEvent` folds one event into a `TuiState`, and the Ink
 * layer is a dumb renderer of that state. Input is handled by the small
 * pure functions at the bottom (char / backspace / history / submit /
 * approval) — the keybinding table itself lives in app.tsx.
 */
import { QUIET_ON_SUCCESS_TOOLS, type AgentEvent } from "../types.js";
import { renderEditDiff } from "./diff.js";
import wrapAnsi from "wrap-ansi";
import cliTruncate from "cli-truncate";

const oneLine = (s: string, n: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};

export type TuiItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean; thinking: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      argsText: string;
      /** Present for `edit` calls — unified-diff lines (see diff.ts). */
      diff?: string[];
      running: boolean;
      resultText?: string;
      isError?: boolean;
      /**
       * D19: set while a quiet (file-access) tool runs. The item is a
       * height-0 placeholder: dropped on success, unhidden on denial so
       * the ✗ + reason is the only file-access line the user ever sees.
       */
      hidden?: boolean;
    }
  | { kind: "compaction"; tokensBefore: number; messagesKept: number; summaryChars: number }
  | { kind: "error"; text: string }
  /** Slash-command feedback (dim line in the output area). */
  | { kind: "info"; text: string };

export interface TuiState {
  items: TuiItem[];
  /** Current input line. */
  input: string;
  /** Submitted prompts, oldest first (↑/↓ navigation). */
  history: string[];
  /** Index into `history` while navigating; null = typing a new line. */
  historyIdx: number | null;
  /** A runTurn is in flight (agent_start…agent_end). */
  busy: boolean;
  /** Current turn number (turn_start). */
  turn: number;
  /**
   * A tool-approval question is pending (D8). The TUI renders it and
   * routes the next y/n key to `resolve`.
   */
  approval: { question: string; resolve: (ok: boolean) => void } | null;
  modelLabel: string;
  /** D15: field keys shown in the reserved bottom lines, in order. */
  bottom: string[];
  /** D16: selected candidate in the slash-command menu (null = first). */
  suggestIdx: number | null;
  /** Cumulative Usage.totalTokens across assistant `done` events. */
  totalTokens: number;
  /** Static labels the driver supplies (cwd, session, …). */
  info: Record<string, string>;
}

export function makeInitialState(
  modelLabel: string,
  info: Record<string, string> = {},
): TuiState {
  return {
    items: [],
    input: "",
    history: [],
    historyIdx: null,
    busy: false,
    turn: 0,
    approval: null,
    modelLabel,
    bottom: [],
    suggestIdx: null,
    totalTokens: 0,
    info,
  };
}

/** Fold one AgentEvent into the state (returns a new state; I3: never throws). */
export function applyEvent(state: TuiState, ev: AgentEvent): TuiState {
  switch (ev.type) {
    case "agent_start":
      return { ...state, busy: true };
    case "agent_end": {
      let items = state.items;
      if (ev.stopReason === "error") {
        const last = ev.messages[ev.messages.length - 1];
        const msg =
          last !== undefined && last.role === "assistant" && last.errorMessage
            ? last.errorMessage
            : "provider error";
        items = [...items, { kind: "error", text: `error: ${msg}` }];
      } else if (ev.stopReason === "aborted") {
        items = [...items, { kind: "error", text: "aborted" }];
      } else if (ev.stopReason === "length") {
        items = [...items, { kind: "error", text: "length: output limit hit — tool-call arguments may be truncated" }];
      } else if (ev.stopReason === "budget") {
        // Cap hit is an outcome, not a dead end: the TUI stays usable —
        // the next prompt is a NEW run whose cap resets (the generic
        // agent_end path above clears busy/approval).
        const cap = ev.maxTurns !== undefined ? `max ${ev.maxTurns} turns` : "turns";
        items = [...items, { kind: "error", text: `budget: ${cap} reached — send another prompt to continue` }];
      }
      return { ...state, busy: false, approval: null, items };
    }
    case "turn_start":
      return { ...state, turn: ev.turn };
    case "start": {
      // First assistant event of a turn — open a streaming item.
      if (lastAssistantStreaming(state.items)) return state;
      return {
        ...state,
        items: [...state.items, { kind: "assistant", text: "", streaming: true, thinking: false }],
      };
    }
    case "text_delta": {
      const items = [...state.items];
      const last = items[items.length - 1];
      if (last !== undefined && last.kind === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + ev.delta, thinking: false };
      } else {
        items.push({ kind: "assistant", text: ev.delta, streaming: true, thinking: false });
      }
      return { ...state, items };
    }
    case "thinking_delta": {
      const items = [...state.items];
      const last = items[items.length - 1];
      if (last !== undefined && last.kind === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, thinking: true };
      } else {
        items.push({ kind: "assistant", text: "", streaming: true, thinking: true });
      }
      return { ...state, items };
    }
    case "toolcall_start":
    case "toolcall_delta":
      return state; // arguments stream in silently — shown at execution start
    case "done": {
      // Close the streaming item; drop the "thinking" indicator (the plain
      // CLI shows thinking text never — the TUI only hints at it live).
      // D15: tally usage for the optional `tokens` bottom field.
      const used = ev.message.usage?.totalTokens ?? 0;
      return {
        ...state,
        totalTokens: state.totalTokens + used,
        items: state.items.map((it) =>
          it.kind === "assistant" && it.streaming ? { ...it, streaming: false, thinking: false } : it,
        ),
      };
    }
    case "tool_execution_start": {
      // D19: quiet (file-access) tools start as hidden placeholders — no
      // line, and no diff work, until the outcome says otherwise.
      const quiet = QUIET_ON_SUCCESS_TOOLS.has(ev.toolCall.name);
      const diff =
        quiet ? undefined : ev.toolCall.name === "edit" ? renderEditDiff(ev.toolCall.arguments) : undefined;
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "tool",
            id: ev.toolCall.id,
            name: ev.toolCall.name,
            argsText: oneLine(JSON.stringify(ev.toolCall.arguments), 120),
            diff,
            running: true,
            ...(quiet ? { hidden: true } : {}),
          },
        ],
      };
    }
    case "tool_execution_update":
      // Long tool stdout previews: keep the last one as a live detail line.
      return withRunningTool(
        state,
        (t) => ({ ...t, resultText: oneLine(ev.text, 200) }),
        ev.toolCallId,
      );
    case "tool_execution_end": {
      const text = oneLine(ev.result.content.map((c) => c.text).join(" "), 200);
      if (QUIET_ON_SUCCESS_TOOLS.has(ev.result.toolName)) {
        if (ev.result.isError === true) {
          // Denial — the one file-access event worth showing (unhide in place).
          return withRunningTool(
            state,
            (t) => ({ ...t, running: false, hidden: false, resultText: text, isError: true }),
            ev.toolCallId,
          );
        }
        // Success — drop the placeholder entirely (no line at all).
        return {
          ...state,
          items: state.items.filter((it) => !(it.kind === "tool" && it.id === ev.toolCallId)),
        };
      }
      return withRunningTool(
        state,
        (t) => ({ ...t, running: false, resultText: text, isError: ev.result.isError === true }),
        ev.toolCallId,
      );
    }
    case "context_compacted":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "compaction",
            tokensBefore: ev.tokensBefore,
            messagesKept: ev.messagesKept,
            summaryChars: ev.summaryChars,
          },
        ],
      };
    default:
      return state;
  }
}

/**
 * Apply `fn` to the tool item whose id matches; defensive fallback: the
 * most recent still-running tool item.
 */
function withRunningTool(
  state: TuiState,
  fn: (t: Extract<TuiItem, { kind: "tool" }>) => Extract<TuiItem, { kind: "tool" }>,
  id: string,
): TuiState {
  const items = [...state.items];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "tool" && it.id === id) {
      items[i] = fn(it);
      return { ...state, items };
    }
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "tool" && it.running) {
      items[i] = fn(it);
      return { ...state, items };
    }
  }
  return state;
}

function lastAssistantStreaming(items: TuiItem[]): boolean {
  const last = items[items.length - 1];
  return last !== undefined && last.kind === "assistant" && last.streaming;
}

// ───────────────────────── input (pure key handling) ─────────────────────────

export function inputChar(s: TuiState, ch: string): TuiState {
  if (s.approval) return s; // input locked while an approval is pending
  return { ...s, input: s.input + ch, historyIdx: null };
}

export function inputBackspace(s: TuiState): TuiState {
  if (s.approval) return s;
  return { ...s, input: s.input.slice(0, -1), historyIdx: null };
}

/** dir: -1 = up (older), 1 = down (newer); below the newest → fresh line. */
export function inputHistory(s: TuiState, dir: -1 | 1): TuiState {
  if (s.history.length === 0) return s;
  if (s.historyIdx === null) {
    if (dir === 1) return s; // nothing newer than the fresh line
    return { ...s, historyIdx: s.history.length - 1, input: s.history[s.history.length - 1]! };
  }
  const next = s.historyIdx + dir;
  if (next < 0) return { ...s, historyIdx: null, input: "" };
  if (next >= s.history.length) return s;
  return { ...s, historyIdx: next, input: s.history[next]! };
}

/** Enter: null while busy/approving or on an empty line; else the prompt. */
export function submitInput(s: TuiState): { state: TuiState; prompt: string } | null {
  if (s.approval !== null || s.busy) return null;
  const prompt = s.input.trim();
  if (prompt === "") return null;
  return {
    state: { ...s, input: "", historyIdx: null, history: [...s.history, prompt], busy: true },
    prompt,
  };
}

export function pushUser(s: TuiState, text: string): TuiState {
  return { ...s, items: [...s.items, { kind: "user", text }] };
}

export function noteError(s: TuiState, text: string): TuiState {
  return { ...s, items: [...s.items, { kind: "error", text }] };
}

export function setApproval(s: TuiState, question: string, resolve: (ok: boolean) => void): TuiState {
  return { ...s, approval: { question, resolve } };
}

/** y/n/esc answer a pending approval; no-op when none is pending. */
export function approvalAnswer(s: TuiState, ok: boolean): TuiState {
  if (s.approval === null) return s;
  const resolve = s.approval.resolve;
  resolve(ok);
  return { ...s, approval: null };
}

// ---------------------------------------------------------------------------
// D14 — pinned-input layout (frame geometry). Pure functions consumed by the
// Ink renderer (app.tsx): they compute exact rendered line counts and which
// tail of items fits the frame. The height math MUST stay in lockstep with
// the `Item` rendering in app.tsx.
// ---------------------------------------------------------------------------

/** Lines reserved (blank) below the input line — future status info. */
export const RESERVED_BOTTOM_LINES = 3;
/** Top separator + input line + bottom separator + RESERVED_BOTTOM_LINES. */
export const PINNED_LINES = 6; // top separator + input line + bottom separator + RESERVED_BOTTOM_LINES
/** header(1) + hint(1) + PINNED_LINES(6). */
export const FIXED_NON_ITEM_LINES = 8; // header(1) + hint(1) + PINNED_LINES(6)

/**
 * Exact line count Ink renders for a plain full-width `<Text>{text}</Text>`
 * at the given terminal width. Empty string -> 0. Must mirror Ink's wrap
 * options exactly: `{ trim: false, hard: true }`.
 */
export function wrapLineCount(text: string, width: number): number {
  if (text === "") return 0;
  return wrapAnsi(text, Math.max(1, width), { trim: false, hard: true }).split("\n").length;
}

/**
 * Exact line count the renderer renders for one `TuiItem` at the given
 * terminal width. MUST stay in lockstep with the `Item` rendering in app.tsx.
 */
export function itemHeight(item: TuiItem, width: number): number {
  switch (item.kind) {
    case "user":
      // No prefix (D15): the user's text renders plain at full width.
      // Empty text still renders one line (a bare space in app.tsx).
      return item.text ? wrapLineCount(item.text, width) : 1;
    case "assistant":
      return (item.thinking ? 1 : 0) + (item.text ? wrapLineCount(item.text, width) : 0);
    case "tool": {
      if (item.hidden) return 0; // D19: quiet tool mid-flight — renders nothing
      const mark =
        item.resultText !== undefined
          ? item.isError
            ? "\u2717"
            : "\u2713"
          : item.running
            ? "\u2192"
            : "\u00b7";
      let count = wrapLineCount(`${mark} ${item.name} ${item.argsText}`, width);
      if (item.diff !== undefined) {
        for (const line of item.diff) {
          if (line !== "") count += wrapLineCount(line, width);
        }
      }
      if (item.resultText !== undefined) {
        count += wrapLineCount(`${mark} ${item.resultText}`, width);
      }
      return count;
    }
    case "compaction":
      // The item carries no `text` field; mirror the exact line app.tsx
      // renders so the height stays in lockstep with the renderer.
      return wrapLineCount(
        `\u2702 compacted: ~${Math.round(item.tokensBefore / 100) / 10}k tokens \u2192 summary (${item.summaryChars} chars) + last ${item.messagesKept} message(s) kept`,
        width,
      );
    case "error":
    case "info":
      return wrapLineCount(item.text, width);
  }
}

/** Sum of `itemHeight` over `items`. */
export function itemsHeight(items: TuiItem[], width: number): number {
  let total = 0;
  for (const item of items) {
    total += itemHeight(item, width);
  }
  return total;
}

/**
 * Choose the tail of items that fits the frame window plus the pad that
 * fills the rest. `budget = rows - FIXED_NON_ITEM_LINES - (hasApproval ? 1 : 0)`,
 * clamped to >= 1. Keeps the longest TAIL of items whose `itemsHeight` is
 * <= budget (never reorders; if only the last item fits, keep just it; if
 * even the last item alone exceeds the budget, keep just it and let
 * pad = 0 — the frame may then exceed rows, which Ink handles by scrolling;
 * bottom stays pinned). `pad = max(0, budget - itemsHeight(visible))`.
 */
export function fitItems(
  items: TuiItem[],
  width: number,
  rows: number,
  /** D16: lines reserved BELOW the item area (approval line, menu lines). */
  extraLines: number,
): { visible: TuiItem[]; pad: number } {
  const budget = Math.max(1, rows - FIXED_NON_ITEM_LINES - extraLines);
  if (items.length === 0) return { visible: [], pad: budget };
  let total = 0;
  let start = items.length;
  for (let i = items.length - 1; i >= 0; i--) {
    const h = itemHeight(items[i]!, width);
    if (total > 0 && total + h > budget) break;
    total += h;
    start = i;
  }
  const visible = items.slice(start);
  return { visible, pad: Math.max(0, budget - itemsHeight(visible, width)) };
}

/**
 * The input line content: the input with the type cursor (▍) at the end.
 * The cursor is ALWAYS shown — it marks where the next character lands,
 * so an empty input renders as the cursor alone (the row is never blank).
 * Truncated to exactly one row at width: the tail of a long input is kept
 * (cli-truncate adds the ellipsis and guarantees display width <= max(1,
 * width-1), leaving one column for the cursor).
 */
export function inputCursor(input: string, width: number): string {
  const w = Math.max(1, width);
  if (input === "") return "\u258d";
  return cliTruncate(input, w - 1, { position: "start" }) + "\u258d";
}

/** One-line approval question ending in ' [y/N]', truncated to width. */
export function approvalLine(question: string, width: number): string {
  return cliTruncate(question + " [y/N]", width, { position: "end" });
}

// ---------------------------------------------------------------------------
// D16 — slash-command completion menu. When the input line holds a bare
// command word (starts with "/", no spaces yet), the frame renders the
// matching commands GREY above the top separator — alphabetical, filtered by
// the typed prefix — with the selected one marked. ↑/↓ navigate (wrap),
// enter completes the word (a second enter submits), anything else just
// edits the word and the menu recomputes. All pure: the registry, the
// candidate filter, the nav/complete transitions, and the visible lines —
// the single source of truth shared by the render and the fitItems budget.
// ---------------------------------------------------------------------------

export interface SlashCommand {
  /** Command name without the leading "/". */
  name: string;
  /** Short description shown after the name in the menu. */
  summary: string;
}

/** The D16 registry — single source of truth for the menu; run.tsx
    dispatches by name. Adding a command = one entry here. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "display-bottom", summary: "set/clear the bottom display fields" },
  { name: "exit", summary: "end the session (alias of /quit)" },
  { name: "quit", summary: "end the session" },
];

/** At most this many lines the menu may take (more candidates → first N). */
export const MENU_MAX_LINES = 5;

/**
 * Candidate command lines ("/name") for the current input: only when the
 * input is a BARE command word — starts with "/", no spaces yet (a space
 * means arguments, where the menu hides). The word's stem prefix-filters
 * the registry; the result is alphabetical ("/" alone → all commands).
 */
export function slashCandidates(input: string): string[] {
  if (!input.startsWith("/") || input.includes(" ")) return [];
  const stem = input.slice(1);
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(stem)).map((c) => "/" + c.name).sort();
}

/**
 * The menu lines the frame renders above the top separator ("" → no menu).
 * Each line is exactly one row at `width`: `> /name — summary` (selected)
 * or `  /name — summary` (not). Hidden while an approval is pending (the
 * input is locked then anyway).
 */
export function suggestMenu(state: TuiState, width: number): { line: string; selected: boolean }[] {
  if (state.approval !== null) return [];
  const cands = slashCandidates(state.input);
  if (cands.length === 0) return [];
  const sel = Math.min(state.suggestIdx ?? 0, cands.length - 1);
  return cands.slice(0, MENU_MAX_LINES).map((cmd, i) => {
    const cmdDef = SLASH_COMMANDS.find((c) => "/" + c.name === cmd);
    const full = `${i === sel ? "> " : "  "}${cmd}${cmdDef ? " — " + cmdDef.summary : ""}`;
    return { line: cliTruncate(full, Math.max(1, width), { position: "end" }), selected: i === sel };
  });
}

/**
 * ↑/↓ while the menu is visible: move the selection (wrap-around). Null
 * when the menu is not visible — the caller falls through to history
 * navigation.
 */
export function menuNav(s: TuiState, dir: -1 | 1): TuiState | null {
  const cands = slashCandidates(s.input);
  if (cands.length === 0) return null;
  const cur = Math.min(s.suggestIdx ?? 0, cands.length - 1);
  return { ...s, suggestIdx: (cur + dir + cands.length) % cands.length };
}

/**
 * Enter while the menu is visible: if the typed word is not yet the exact
 * selected command, complete it (input = chosen + " "; the trailing space
 * hides the menu, so a second enter submits). Null → let the normal submit
 * path run (exact match, or no menu).
 */
export function menuComplete(s: TuiState): TuiState | null {
  const cands = slashCandidates(s.input);
  if (cands.length === 0) return null;
  const sel = Math.min(s.suggestIdx ?? 0, cands.length - 1);
  const chosen = cands[sel]!;
  if (s.input === chosen) return null; // exact → submit
  return { ...s, input: chosen + " ", suggestIdx: null };
}

// ---------------------------------------------------------------------------
// D15 — configurable bottom display. The RESERVED_BOTTOM_LINES under the
// input line were blank placeholders; `/display-bottom` now fills them with
// user-selected fields. All pure: the field registry, the value getters, the
// rendered lines, and the slash-command handler. The driver (run.tsx) routes
// submitted `/…` lines here before treating them as unknown commands.
// ---------------------------------------------------------------------------

/** Fields the user may pin into the bottom lines, in menu order. */
export const BOTTOM_FIELDS = ["model", "status", "turn", "tokens", "cwd", "session"] as const;
export type BottomField = (typeof BOTTOM_FIELDS)[number];

/** The value shown for one field ("—" when a static label is absent). */
function bottomValue(state: TuiState, field: BottomField): string {
  switch (field) {
    case "model":
      return state.modelLabel;
    case "status":
      return state.busy ? "working…" : "idle";
    case "turn":
      return String(state.turn);
    case "tokens":
      return state.totalTokens > 0 ? `${state.totalTokens} total` : "—";
    case "cwd":
      return state.info.cwd ?? "—";
    case "session":
      return state.info.session ?? "—";
  }
}

/**
 * The RESERVED_BOTTOM_LINES strings drawn under the input line: one
 * `field: value` per selected field, in order, each truncated to one row
 * at `width`. Fewer fields than lines → the rest are empty (the renderer
 * substitutes a space so the row keeps its height). Unknown keys are skipped
 * defensively — the command validates at set-time.
 */
export function bottomLines(state: TuiState, width: number): string[] {
  const lines: string[] = [];
  for (const key of state.bottom) {
    if (lines.length >= RESERVED_BOTTOM_LINES) break;
    const i = (BOTTOM_FIELDS as readonly string[]).indexOf(key);
    if (i === -1) continue;
    lines.push(
      cliTruncate(`${key}: ${bottomValue(state, BOTTOM_FIELDS[i]!)}`, Math.max(1, width), { position: "end" }),
    );
  }
  while (lines.length < RESERVED_BOTTOM_LINES) lines.push("");
  return lines;
}

/**
 * Handle a submitted `/…` line. Currently one command:
 *   /display-bottom            report current selection + the field menu
 *   /display-bottom off|none   clear the bottom lines
 *   /display-bottom f1 f2 …    set the fields (deduped, order preserved)
 * Feedback lands as an `info` item in the output area. `/quit` and `/exit`
 * are NOT handled here — the driver owns them (it must unmount). Returns
 * `handled: false` for every other line.
 */
export function handleSlashCommand(s: TuiState, line: string): { state: TuiState; handled: boolean } {
  const m = /^\/display-bottom(?:\s+(.*))?$/.exec(line.trim());
  if (m === null) return { state: s, handled: false };
  const words = (m[1] ?? "").split(/\s+/).filter((w) => w !== "");
  const menu = BOTTOM_FIELDS.join(" ");
  const withInfo = (st: TuiState, text: string): TuiState => ({
    ...st,
    items: [...st.items, { kind: "info", text }],
  });
  if (words.length === 0) {
    const cur = s.bottom.length > 0 ? s.bottom.join(" ") : "(none)";
    return { state: withInfo(s, `display-bottom: ${cur} — fields: ${menu}`), handled: true };
  }
  if (words.length === 1 && (words[0] === "off" || words[0] === "none")) {
    return { state: withInfo({ ...s, bottom: [] }, "display-bottom: off"), handled: true };
  }
  const unknown = words.find((w) => !(BOTTOM_FIELDS as readonly string[]).includes(w));
  if (unknown !== undefined) {
    return { state: withInfo(s, `display-bottom: unknown field '${unknown}' — fields: ${menu}`), handled: true };
  }
  const fields = [...new Set(words)];
  return { state: withInfo({ ...s, bottom: fields }, `display-bottom: ${fields.join(" ")}`), handled: true };
}
