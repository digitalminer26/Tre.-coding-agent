/**
 * WS10 — pure TUI state machine (no Ink, no I/O — unit-testable).
 *
 * The TUI consumes the SAME `AgentEvent` stream the plain CLI prints
 * (D5/D11): `applyEvent` folds one event into a `TuiState`, and the Ink
 * layer is a dumb renderer of that state. Input is handled by the small
 * pure functions at the bottom (char / backspace / history / submit /
 * approval) — the keybinding table itself lives in app.tsx.
 */
import { QUIET_ON_SUCCESS_TOOLS, lengthEndNote, type AgentEvent } from "../types.js";
import { renderEditDiff } from "./diff.js";
import { itemLines } from "./lines.js";
import wrapAnsi from "wrap-ansi";
import cliTruncate from "cli-truncate";

const oneLine = (s: string, n: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};

export type TuiItem =
  | { kind: "user"; text: string }
  | {
      kind: "assistant";
      text: string;
      streaming: boolean;
      /** A reasoning model is emitting (or emitted) thinking. */
      thinking: boolean;
      /**
       * Accumulated `thinking_delta` text (the model's reasoning, from the
       * wire's `reasoning_content`). Rendered dimmed above the reply; kept
       * after `done` so the reasoning stays visible. Empty when the model
       * did not think.
       */
      thinkingText: string;
    }
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
  /**
   * Cursor position in `input` (0..input.length): where the next typed
   * character lands. The input row renders the type cursor (▍) at this
   * position, so its location is visible while editing.
   */
  cursorPos: number;
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
  /** Count of tool executions started (tool_execution_start events). */
  toolCalls: number;
  /** Static labels the driver supplies (cwd, session, …). */
  info: Record<string, string>;
  /**
   * C28: the CONTENT row the viewport's top edge sits at (absolute in the
   * content), or null = follow the bottom (the default). While pinned, new
   * output lands BELOW the window — the view stays put until the user
   * scrolls back down (a C27 "rows above bottom" offset would drift as
   * output appends). Clamped to the scrollable range at render time.
   */
  viewTop: number | null;
}

export function makeInitialState(
  modelLabel: string,
  info: Record<string, string> = {},
): TuiState {
  return {
    items: [],
    input: "",
    cursorPos: 0,
    history: [],
    historyIdx: null,
    busy: false,
    turn: 0,
    approval: null,
    modelLabel,
    bottom: [],
    suggestIdx: null,
    totalTokens: 0,
    toolCalls: 0,
    info,
    viewTop: null,
  };
}

/** Fold one AgentEvent into the state (returns a new state; I3: never throws). */
export function applyEvent(state: TuiState, ev: AgentEvent): TuiState {
  switch (ev.type) {
    case "agent_start":
      // C27/C28: a new run's output is the interesting thing — follow the bottom.
      return { ...state, busy: true, viewTop: null };
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
        items = [...items, { kind: "error", text: lengthEndNote(ev.messages) }];
      } else if (ev.stopReason === "budget") {
        // C26: the loop auto-continues per cycle — reaching "budget" means
        // EVERY cycle was exhausted. Still an outcome, not a dead end: the
        // TUI stays usable and the next prompt starts a new run.
        // C26: name the cycles only when more than one actually ran.
        const cap =
          ev.maxTurns !== undefined
            ? ev.maxCycles !== undefined && ev.maxCycles > 1
              ? `max ${ev.maxTurns} turns × ${ev.maxCycles} cycles`
              : `max ${ev.maxTurns} turns`
            : "turns";
        items = [...items, { kind: "error", text: `budget: ${cap} reached — send another prompt to continue` }];
      } else if (ev.stopReason === "loop") {
        // C26: runaway-loop detection (3 identical batches in a row). The
        // third repeat was NOT executed; a new prompt breaks the pattern.
        items = [
          ...items,
          {
            kind: "error",
            text: "loop: the model repeated the same tool call(s) 3 times in a row — stopped to avoid a runaway loop — send another prompt to continue",
          },
        ];
      }
      return { ...state, busy: false, approval: null, items };
    }
    case "turn_start":
      return { ...state, turn: ev.turn };
    case "steer":
      // No-op: the user item was already pushed at submit time (steerInput)
      // — the loop's steer event only confirms delivery. Do NOT double-add.
      return state;
    case "turn_budget":
      // C26: informational — the run continues on a fresh cycle.
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "info",
            text: `turn budget (${ev.maxTurns}) reached — continuing (cycle ${ev.cycle}/${ev.maxCycles})`,
          },
        ],
      };
    case "start": {
      // First assistant event of a turn — open a streaming item.
      if (lastAssistantStreaming(state.items)) return state;
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "assistant", text: "", streaming: true, thinking: false, thinkingText: "" },
        ],
      };
    }
    case "text_delta": {
      const items = [...state.items];
      const last = items[items.length - 1];
      if (last !== undefined && last.kind === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + ev.delta, thinking: false };
      } else {
        items.push({ kind: "assistant", text: ev.delta, streaming: true, thinking: false, thinkingText: "" });
      }
      return { ...state, items };
    }
    case "thinking_delta": {
      // Accumulate the reasoning text (the wire's `reasoning_content`):
      // before, only the `thinking` flag was set, so the TUI showed a static
      // "thinking…" hint and the actual thinking was never visible.
      const items = [...state.items];
      const last = items[items.length - 1];
      if (last !== undefined && last.kind === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, thinking: true, thinkingText: last.thinkingText + ev.delta };
      } else {
        items.push({ kind: "assistant", text: "", streaming: true, thinking: true, thinkingText: ev.delta });
      }
      return { ...state, items };
    }
    case "toolcall_start":
    case "toolcall_delta":
      return state; // arguments stream in silently — shown at execution start
    case "done": {
      // Close the streaming item. The live "thinking" flag clears, but the
      // accumulated thinkingText STAYS — the reasoning is part of the
      // record (the plain CLI prints nothing; the TUI shows it dimmed).
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
        // /stats: count every tool execution that started (including the
        // quiet file-access tools that render no line).
        toolCalls: state.toolCalls + 1,
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

/** Clamp a cursor position into [0, len] (defensive: stale index). */
const clampCursor = (pos: number, len: number): number =>
  Math.max(0, Math.min(pos, len));

export function inputChar(s: TuiState, ch: string): TuiState {
  if (s.approval) return s; // input locked while an approval is pending
  const pos = clampCursor(s.cursorPos, s.input.length);
  const input = s.input.slice(0, pos) + ch + s.input.slice(pos);
  return { ...s, input, cursorPos: pos + ch.length, historyIdx: null };
}

export function inputBackspace(s: TuiState): TuiState {
  if (s.approval) return s;
  const pos = clampCursor(s.cursorPos, s.input.length);
  if (pos === 0) return s; // nothing before the cursor to delete
  const input = s.input.slice(0, pos - 1) + s.input.slice(pos);
  return { ...s, input, cursorPos: pos - 1, historyIdx: null };
}

/**
 * Move the cursor left (dir -1) or right (dir 1). No-op at either end.
 * (The cursor is a column into `input`, not a display column — movement is
 * per code unit; the row is truncated for display, but the full string is
 * what the cursor addresses.)
 */
export function inputMove(s: TuiState, dir: -1 | 1): TuiState {
  if (s.approval) return s;
  const pos = clampCursor(s.cursorPos, s.input.length) + dir;
  if (pos < 0 || pos > s.input.length) return s;
  return { ...s, cursorPos: pos };
}

/** dir: -1 = up (older), 1 = down (newer); below the newest → fresh line. */
export function inputHistory(s: TuiState, dir: -1 | 1): TuiState {
  if (s.history.length === 0) return s;
  if (s.historyIdx === null) {
    if (dir === 1) return s; // nothing newer than the fresh line
    const line = s.history[s.history.length - 1]!;
    return { ...s, historyIdx: s.history.length - 1, input: line, cursorPos: line.length };
  }
  const next = s.historyIdx + dir;
  if (next < 0) return { ...s, historyIdx: null, input: "", cursorPos: 0 };
  if (next >= s.history.length) return s;
  const line = s.history[next]!;
  return { ...s, historyIdx: next, input: line, cursorPos: line.length };
}

/**
 * Enter: null while busy/approving or on an empty line; else the prompt.
 * The DRIVER routes busy submits to `steerInput` (steering) — this function
 * only handles the idle case (a fresh prompt starts a new run).
 */
export function submitInput(s: TuiState): { state: TuiState; prompt: string } | null {
  if (s.approval !== null || s.busy) return null;
  const prompt = s.input.trim();
  if (prompt === "") return null;
  return {
    state: {
      ...s,
      input: "",
      cursorPos: 0,
      historyIdx: null,
      history: [...s.history, prompt],
      busy: true,
      // C27/C28: a fresh prompt's output is the interesting thing — follow
      // the bottom again.
      viewTop: null,
    },
    prompt,
  };
}

export function pushUser(s: TuiState, text: string): TuiState {
  return { ...s, items: [...s.items, { kind: "user", text }] };
}

/**
 * Enter while a run is in flight: STEER. The line is not a new prompt —
 * it is queued by the driver for the running loop and echoed here as a
 * user item (same shape as pushUser: no new item kind, no render change).
 * null when idle, while approving, or for empty/slash lines (the driver
 * owns the /quit-abort path).
 */
export function steerInput(
  s: TuiState,
  text: string,
): { state: TuiState; text: string } | null {
  if (s.approval !== null || !s.busy) return null;
  const t = text.trim();
  if (t === "" || t.startsWith("/")) return null;
  return {
    state: {
      ...s,
      input: "",
      cursorPos: 0,
      historyIdx: null,
      history: [...s.history, t],
      items: [...s.items, { kind: "user", text: t }],
      // Follow the bottom: the steer's effect (the model's reaction) is
      // the interesting thing.
      viewTop: null,
    },
    text: t,
  };
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
// C28 — output scrollback (content-anchored viewport). Pure state
// transitions; the row MATH lives in fitItemsScrollable below.
//
// C27 stored `scrollUp` (rows above the bottom). That offset drifts: as
// output appends, "N rows above the bottom" points at different content,
// and an item straddling the window edge could only be dropped whole, so
// content dominated by ONE item taller than the budget — a single long
// reply, the common shape — could not be scrolled at all. C28 stores the
// CONTENT row the viewport's top edge sits at (`viewTop`): absolute, so a
// pinned view stays pinned as output appends, and straddling items are
// clipped (see fitItemsScrollable).
// ---------------------------------------------------------------------------

/**
 * Scroll the viewport by `delta` ROWS (positive = up toward older content,
 * negative = down toward the bottom). `maxScroll` is the current scrollable
 * range (total content height − item budget, from the last fit). Reaching
 * the bottom resumes following (null), so new output keeps streaming into
 * the view.
 */
export function scrollBy(s: TuiState, delta: number, maxScroll: number): TuiState {
  const cur = s.viewTop === null ? maxScroll : Math.min(s.viewTop, maxScroll);
  const next = Math.max(0, Math.min(maxScroll, cur - delta));
  const resolved = next >= maxScroll ? null : next;
  return resolved === s.viewTop ? s : { ...s, viewTop: resolved };
}

/** Back to following the bottom (new output appears at the bottom). */
export function scrollToBottom(s: TuiState): TuiState {
  return s.viewTop === null ? s : { ...s, viewTop: null };
}

/** To the top of the content (content row 0). */
export function scrollToTop(s: TuiState): TuiState {
  return s.viewTop === 0 ? s : { ...s, viewTop: 0 };
}

// ---------------------------------------------------------------------------
// D14 — pinned-input layout (frame geometry). Pure functions consumed by the
// Ink renderer (app.tsx): they compute exact rendered line counts and which
// tail of items fits the frame. The height math MUST stay in lockstep with
// the `Item` rendering in app.tsx.
// ---------------------------------------------------------------------------

/** Lines reserved (blank) below the input line — future status info. */
export const RESERVED_BOTTOM_LINES = 3;
/**
 * Top separator + input line(1) + bottom separator + RESERVED_BOTTOM_LINES.
 * The input WRAPS at the terminal width (inputWrap): the MINIMUM block is
 * 1 input line; the caller adds the extra wrapped lines to the fitItems
 * budget (extraLines), so the frame stays exactly `rows` tall.
 */
export const PINNED_LINES = 6; // top separator + input line(1) + bottom separator + RESERVED_BOTTOM_LINES
/** header(1) + hint(1) + PINNED_LINES(6). */
export const FIXED_NON_ITEM_LINES = 8; // header(1) + hint(1) + PINNED_LINES(6)

/**
 * C27: the item area's row budget for the given frame — rows available for
 * output items after fixed chrome + caller-reserved lines. Exported so the
 * renderer can size scroll page steps in the same rows the fit uses.
 */
export function itemAreaBudget(rows: number, extraLines: number): number {
  return Math.max(1, rows - FIXED_NON_ITEM_LINES - extraLines);
}

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
    case "assistant": {
      // The streaming cursor renders as part of the text — count it (C28:
      // before, the cursor line rendered but did not count, overflowing the
      // frame by one row mid-stream).
      const text = item.text + (item.streaming ? "\u258d" : "");
      // The accumulated reasoning renders as a distinct block above the
      // reply (lines.ts): one dim header line, the reasoning under a "│ "
      // gutter wrapped at width−2, and a blank line before the reply —
      // count exactly what the renderer draws.
      const think =
        item.thinkingText !== ""
          ? 1 + wrapLineCount(item.thinkingText, Math.max(1, width - 2)) + 1
          : 0;
      return think + wrapLineCount(text, width);
    }
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
 * pad = 0 — the frame may then exceed rows. The CALLER (fitItemsScrollable)
 * CLIPS that overflowing tail item back to the budget before rendering: an
 * unclipped overflow would make the frame taller than the viewport, which
 * trips Ink's full-clear fallback (\u001b[3J erases the terminal scrollback).
 * `pad = max(0, budget - itemsHeight(visible))`.
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
 * C28 — fit result with scrollback. The item area is a viewport over the
 * full content (all items, not just the tail). `viewTop` is the CONTENT row
 * the viewport's top edge sits at (null = follow the bottom — exactly the
 * legacy `fitItems` window). While pinned, items straddling a window edge
 * are CLIPPED to their visible rows (sliced), never skipped: the viewport
 * renders exactly `budget` content rows, so any content — including a
 * single item taller than the budget — scrolls. `visible` is always a
 * contiguous slice (no reordering).
 */
/** One visible piece of an item: rendered lines [from, to) of itemLines. */
export interface VisibleSlice {
  item: TuiItem;
  /** First rendered line of `item` shown by the viewport. */
  from: number;
  /** One past the last rendered line shown. */
  to: number;
}

export interface FitWithScroll {
  /** Contiguous slice of `items` intersecting the viewport (clipped). */
  visible: VisibleSlice[];
  /** Blank lines below the window (follow path only; 0 while pinned). */
  pad: number;
  /** Total rendered lines of ALL items at `width` (0 when none). */
  total: number;
  /** Scrollable range: max(0, total − budget). */
  maxScroll: number;
  /** Rows between the viewport's bottom edge and the content's bottom. */
  eff: number;
}

export function fitItemsScrollable(
  items: TuiItem[],
  width: number,
  rows: number,
  extraLines: number,
  viewTop: number | null,
): FitWithScroll {
  const budget = itemAreaBudget(rows, extraLines);
  // One wrap pass: the per-item rendered line lists — both the height
  // counts AND the sliceable rows (re-wrapping via itemHeight would do the
  // work twice per frame).
  const lineLists = items.map((it) => itemLines(it, width));
  const total = lineLists.reduce((a, l) => a + l.length, 0);
  const maxScroll = Math.max(0, total - budget);

  // Follow the bottom (or nothing to scroll): the legacy fitItems tail
  // window + pad, expressed as full-item slices — every pre-C28 frame is
  // unchanged (except the now-counted streaming cursor row).
  if (viewTop === null || total <= budget) {
    const legacy = fitItems(items, width, rows, extraLines);
    const start = items.length - legacy.visible.length;
    // C30: the legacy window keeps a tail item WHOLE even when it alone
    // exceeds the budget (fitItems' documented "let pad = 0 — the frame may
    // then exceed rows, which Ink handles by scrolling"). Ink does NOT
    // handle that: an overflowing frame trips shouldClearTerminalForFrame →
    // clearTerminal, and \u001b[3J erases the TERMINAL SCROLLBACK — the
    // "output clears on a new turn, can't scroll back" bug. Clip the tail
    // to the budget instead (the SAME clip the pinned path applies), so the
    // frame is never taller than the viewport and no clear is ever emitted.
    // When the tail fits (the common case) the clip is a no-op and the frame
    // is byte-identical to the legacy window.
    let shown = 0;
    const visible: VisibleSlice[] = [];
    for (let i = 0; i < legacy.visible.length; i++) {
      const item = legacy.visible[i]!;
      const h = lineLists[start + i]!.length;
      const room = budget - shown;
      if (room <= 0) break;
      if (h <= room) {
        visible.push({ item, from: 0, to: h });
        shown += h;
      } else {
        // The tail item overflows: show its LAST `room` lines (follow the
        // bottom) and clip the rest. Keep the ORIGINAL item and record the
        // line range [h-room, h) — the renderer slices itemLines to it (the
        // same mechanism the pinned path uses), so no per-kind rebuild.
        visible.push({ item, from: h - room, to: h });
        shown += room;
        break;
      }
    }
    return { visible, pad: Math.max(0, budget - shown), total, maxScroll, eff: 0 };
  }

  // Pinned: the viewport covers content rows [W, W + budget). Straddlers
  // are clipped to the window, so the frame holds exactly `budget` content
  // rows — even when one item taller than the budget dominates the content.
  const W = Math.max(0, Math.min(viewTop, maxScroll));
  const bottomEdge = W + budget;
  const out: VisibleSlice[] = [];
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    const h = lineLists[i]!.length;
    const start = acc;
    const end = acc + h;
    acc = end;
    const from = Math.max(start, W) - start;
    const to = Math.min(end, bottomEdge) - start;
    if (to > from) out.push({ item: items[i]!, from, to });
  }
  return { visible: out, pad: 0, total, maxScroll, eff: maxScroll - W };
}

/**
 * Display width of one code point (a small, owned approximation of
 * string-width — no new dependency): 0 for zero-width combining marks, 2 for
 * wide (CJK/Hangul) chars, 1 otherwise. The input row is plain text (no ANSI),
 * so per-code-point widths are enough to window it to one display row.
 */
function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x1ab0 && cp <= 0x1aff)) return 0;
  return 1;
}

/** Total display width of a string (sum of per-code-point widths). */
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/**
 * The input line content as an ARRAY of display lines: the input with the
 * type cursor (▍) rendered at `cursorPos` (where the next character lands),
 * so the cursor's LOCATION is visible, not just at the end. The cursor is
 * ALWAYS shown — an empty input renders as the cursor alone (one line).
 *
 * Wrapped to at most `width` display columns per line (wide/CJK chars count
 * as 2). Wrapping is word-aware: an overflowing line breaks at the LAST space
 * inside it (the space is consumed, never repeated); with no space it
 * hard-breaks at the column limit. A space that would start a wrapped line is
 * dropped (no leading spaces on lines 1+). Trailing spaces are trimmed at each
 * wrap point (the LAST line is never trimmed), so no wrapped line has leading
 * or trailing whitespace. Every line is ≤ `width` display columns, so the
 * frame geometry (fitItems) can count them exactly.
 */
export function inputWrap(input: string, cursorPos: number, width: number): string[] {
  const w = Math.max(1, width);
  const pos = clampCursor(cursorPos, input.length);
  const full = input.slice(0, pos) + "\u258d" + input.slice(pos);
  const lines: string[] = [];
  let cur = "";
  let curW = 0;
  for (const ch of full) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (curW + cw > w) {
      // Overflow: break before `ch`, preferring the last space in `cur` at a
      // display column > 0 (a space at column 0 would yield an empty line).
      let breakAt = -1;
      let col = 0;
      let idx = 0;
      for (const c of cur) {
        if (c === " " && col > 0) breakAt = idx;
        col += charWidth(c.codePointAt(0)!);
        idx += c.length;
      }
      if (breakAt > 0) {
        // Trim trailing spaces at the wrap point: the break lands on the LAST
        // space, but an earlier space of the same run would otherwise trail
        // the line (the "aaa " bug). The LAST line is never trimmed.
        lines.push(cur.slice(0, breakAt).replace(/ +$/, ""));
        cur = cur.slice(breakAt + 1);
        curW = dispWidth(cur);
      } else {
        lines.push(cur.replace(/ +$/, ""));
        cur = "";
        curW = 0;
      }
      if (ch === " ") continue; // a space never starts a line
      cur += ch;
      curW += cw;
    } else if (ch === " " && cur === "" && lines.length > 0) {
      // A space never starts a WRAPPED line. Only line 0 may start with a
      // space (it mirrors a leading space of the input). Without this, a
      // space run after the break point leaked its extra spaces onto the
      // start of the next line.
      continue;
    } else {
      cur += ch;
      curW += cw;
    }
  }
  lines.push(cur);
  return lines;
}

/**
 * How many display lines the input block renders at `width` (1 for empty or
 * short input; more when the input wraps). MUST stay in lockstep with the
 * App's input rendering (app.tsx) — it feeds the fitItems budget so the
 * frame stays exactly `rows` tall while the input wraps.
 */
export function inputWrapLineCount(input: string, cursorPos: number, width: number): number {
  return Math.max(1, inputWrap(input, cursorPos, width).length);
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
  { name: "stats", summary: "session stats: turns, tokens, tool calls, session size" },
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
 * The one-line report `/stats` appends as an info item: session turn
 * count, cumulative tokens, tool-call count, and the session file size
 * (bytes, when the caller could measure it — the driver does the I/O;
 * this stays pure). "—" marks a value the session does not carry: no
 * session file was configured (info.session absent) or its size is
 * unknown (undefined) — a missing/unreadable file reports as unknown.
 */
export function statsLine(state: TuiState, sessionBytes?: number): string {
  const session = state.info.session !== undefined ? `${state.info.session} (${sessionBytes ?? "?"} bytes)` : "—";
  return `stats: ${state.turn} turn(s), ${state.totalTokens} tokens, ${state.toolCalls} tool call(s), session: ${session}`;
}

/**
 * Handle a submitted `/…` line. Two commands:
 *   /display-bottom            report current selection + the field menu
 *   /display-bottom off|none   clear the bottom lines
 *   /display-bottom f1 f2 …    set the fields (deduped, order preserved)
 *   /stats                     one info line: turns, tokens, tool calls,
 *                              session file (path + size in bytes)
 * Feedback lands as an `info` item in the output area. `/quit` and `/exit`
 * are NOT handled here — the driver owns them (it must unmount). Returns
 * `handled: false` for every other line. `sessionBytes` is the session
 * file size in bytes, measured by the CALLER (the driver does the I/O —
 * this stays pure); undefined → the size renders as "?" (unknown).
 */
export function handleSlashCommand(
  s: TuiState,
  line: string,
  sessionBytes?: number,
): { state: TuiState; handled: boolean } {
  const withInfo = (st: TuiState, text: string): TuiState => ({
    ...st,
    items: [...st.items, { kind: "info", text }],
  });
  if (line.trim() === "/stats") {
    return { state: withInfo(s, statsLine(s, sessionBytes)), handled: true };
  }
  const m = /^\/display-bottom(?:\s+(.*))?$/.exec(line.trim());
  if (m === null) return { state: s, handled: false };
  const words = (m[1] ?? "").split(/\s+/).filter((w) => w !== "");
  const menu = BOTTOM_FIELDS.join(" ");
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
