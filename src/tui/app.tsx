/**
 * WS10 — the Ink app (D11). A dumb renderer of `TuiState`: it holds no
 * agent logic and no event handling — every key is routed to a callback
 * the driver (run.ts) wires to the pure state functions. That split keeps
 * the testable surface in state.ts and makes this file purely presentational.
 */
import React from "react";
import { Box, Text, useInput, useStdout } from "ink";
import cliTruncate from "cli-truncate";
import type { TuiItem, TuiState, VisibleSlice } from "./state.js";
import { itemLines } from "./lines.js";
import {
  BOTTOM_FIELDS,
  FIXED_NON_ITEM_LINES,
  RESERVED_BOTTOM_LINES,
  approvalLine,
  bottomLineColors,
  bottomLines,
  fitItemsScrollable,
  inputWrap,
  modelPickerMenu,
  suggestMenu,
  workersLineAnsi,
} from "./state.js";

/** Truncate a line to at most `w` display columns (ellipsis at the end). */
const oneLine = (s: string, w: number): string => cliTruncate(s, w, { position: "end" });

/**
 * C31: the item rendered immediately above `it` in the CONTENT (its
 * absolute predecessor in `items`), or undefined when it is first — the
 * SAME predecessor the fit math uses for the item's leading blank line, so
 * the render counts what it draws. `items` is the very array the fit
 * received (state.items), so identity lookup is exact.
 */
const prevOf = (items: TuiItem[], it: TuiItem): TuiItem | undefined => {
  const i = items.indexOf(it);
  return i > 0 ? items[i - 1] : undefined;
};

// C27 — mouse-wheel scrolling. SGR (mode 1006) and X11 (4-byte) wheel
// events arrive at Ink as RAW input text (no parsed `name`): button 64/65
// (SGR) or 62/63 (X11), the `M` suffix = press (one event per notch); the
// `m` release is ignored (anchored below) so a press+release pair scrolls
// once. Clicks/drags are other SGR sequences — swallowed, never typed.
const MOUSE_WHEEL_UP = /^\[<(64|62);\d+;\d+M$/;
const MOUSE_WHEEL_DOWN = /^\[<(65|63);\d+;\d+M$/;
const MOUSE_SGR = /^\[</;
/** One wheel notch scrolls this many lines. */
const SCROLL_LINES = 3;

export interface AppProps {
  state: TuiState;
  onChar: (ch: string) => void;
  /** C28: scroll the output by `delta` rows; `maxScroll` = the current
   * scrollable range (total content height − item budget, from the fit). */
  onScrollBy: (delta: number, maxScroll: number) => void;
  /** C27: jump to the top / bottom of the output. */
  onScrollToTop: () => void;
  onScrollToBottom: () => void;
  onBackspace: () => void;
  /** Move the input cursor left (-1) / right (1). */
  onMove: (dir: -1 | 1) => void;
  onHistory: (dir: -1 | 1) => void;
  onSubmit: () => void;
  onCtrlC: () => void;
  onApproval: (ok: boolean) => void;
  /** /quit while idle — exit 0 (the driver owns the unmount). */
  onQuit: () => void;
  /** C38: the model picker is open — ↑/↓ move the highlight (dir -1/1). */
  onModelPickerNav: (dir: -1 | 1) => void;
  /** C38: enter on the highlighted model — switch + close the picker. */
  onModelPickerConfirm: () => void;
  /** C38: esc — close the picker without switching. */
  onModelPickerClose: () => void;
}

export function App(props: AppProps): React.ReactElement {
  const { state } = props;

  // Pinned input layout (D14): the frame is exactly `rows` lines tall by
  // construction, so Ink runs in "fullscreen" mode and the bottom stays
  // pinned. Width/rows MUST mirror Ink's getWindowSize fallbacks (80x24).
  const { stdout } = useStdout();
  const width = stdout.columns > 0 ? stdout.columns : 80;
  const rows = stdout.rows > 0 ? stdout.rows : 24;
  // `!== null` (not `!== undefined`): TuiState.approval is `{...} | null` —
  // `!== undefined` is true for null too, which would shrink the budget by 1
  // on every idle frame and make the frame rows-1 tall (not fullscreen).
  // D16: the completion menu (visible only for bare "/" command words)
  // renders BETWEEN the hint and the top separator, so it steals budget
  // from the item area exactly like the approval line does.
  const menu = suggestMenu(state, width);
  // C38: the model picker lines (empty when the picker is closed).
  const picker = modelPickerMenu(state, width);
  // The input WRAPS at the terminal width (inputWrap): the extra lines beyond
  // the one the pinned block reserves steal item budget, exactly like the
  // approval line and the menu do — the frame stays exactly `rows` tall.
  const inputLines = inputWrap(state.input, state.cursorPos, width);
  // C28: the item area is a scrollable viewport pinned at content row
  // viewTop (null = follow the bottom). `extra` = the lines reserved below
  // the item area (approval, menu, picker, wrapped input) — the SAME
  // reservation the fit math uses.
  const extra =
    (state.approval !== null ? 1 : 0) + menu.length + picker.length + (inputLines.length - 1);
  const layout = fitItemsScrollable(state.items, width, rows, extra, state.viewTop);
  // A page = one item-area budget (Shift halves it) — sized in the SAME
  // rows the fit uses, so PgUp/PgDn move exactly one window of content.
  // (Mouse-mode setup lives in run.tsx — the driver owns the terminal; a
  // component must never write raw escapes to stdout, which would corrupt
  // the frame stream.)
  const page = Math.max(1, rows - FIXED_NON_ITEM_LINES - extra);
  const halfPage = Math.max(1, Math.floor(page / 2));
  // The wheel only scrolls when the driver enabled mouse tracking
  // (TRE_MOUSE=1, run.tsx) — the hint names it only then.
  const wheel = process.env.TRE_MOUSE ? "/wheel" : "";

  // The keybinding table: the ONLY place that maps keys to intents.
  useInput((input, key) => {
    if (process.env.TUI_DEBUG) console.error("TUIKEY", JSON.stringify(input), "ret=", key.return, "ctrl=", key.ctrl, "esc=", key.escape);
    if (key.ctrl && input === "c") {
      props.onCtrlC();
      return;
    }
    if (state.approval !== null) {
      // While an approval is pending, only y / enter / n / esc mean anything.
      // A chunk like "y\r" arrives as ONE string (Ink does not split \r in
      // multi-char chunks) — look at the first character only; a bare Enter
      // arrives as key.return with an empty input string.
      const first = input.replace(/[\r\n].*$/, "");
      // /quit at an approval prompt: deny the pending call and exit —
      // without this the user is stuck (input is locked while approving).
      if (first === "/quit" || first === "/exit") {
        props.onApproval(false);
        props.onQuit();
        return;
      }
      if (first === "y" || key.return) props.onApproval(true);
      else if (first === "n" || key.escape) props.onApproval(false);
      return;
    }
    if (state.modelPicker !== null) {
      // C38: the model picker is open — the input is locked (as with an
      // approval): only ↑/↓ (move the highlight), enter (switch to the
      // highlighted model) and esc (close, no switch) mean anything.
      // (The input line is always empty while the picker is open — it was
      // cleared by the `/models` submit that opened it — so no /quit path
      // is needed here; ctrl+c still aborts/exits as usual.)
      if (key.upArrow) props.onModelPickerNav(-1);
      else if (key.downArrow) props.onModelPickerNav(1);
      else if (key.return) props.onModelPickerConfirm();
      else if (key.escape) props.onModelPickerClose();
      return;
    }
    if (key.return) {
      props.onSubmit();
      return;
    }
    // A chunk containing \r/\n (fast typing coalesces keys; pastes include
    // newlines) = the typed part, then a submit.
    if (input.includes("\r") || input.includes("\n")) {
      const parts = input.split(/[\r\n]/);
      const head = parts[0] ?? "";
      if (head !== "") props.onChar(head);
      props.onSubmit();
      const tail = parts.slice(1).join("\n");
      if (tail !== "") props.onChar(tail);
      return;
    }
    if (key.leftArrow) {
      props.onMove(-1);
      return;
    }
    if (key.rightArrow) {
      props.onMove(1);
      return;
    }
    if (key.upArrow) {
      props.onHistory(-1);
      return;
    }
    if (key.downArrow) {
      props.onHistory(1);
      return;
    }
    if (key.backspace || key.delete) {
      props.onBackspace();
      return;
    }
    // C27/C28: scroll the output area. Placed BEFORE the ctrl catch-all
    // below (Ctrl+Home/End/Ctrl+U/Ctrl+D arrive with key.ctrl set) and
    // before the char path (mouse SGR sequences have no `name` and would
    // be typed otherwise). delta = rows the viewport moves UP: wheel up /
    // PageUp / Ctrl+U add, wheel down / PageDown / Ctrl+D subtract
    // (scrollBy clamps; reaching the bottom resumes following).
    if (MOUSE_WHEEL_UP.test(input)) {
      props.onScrollBy(SCROLL_LINES, layout.maxScroll);
      return;
    }
    if (MOUSE_WHEEL_DOWN.test(input)) {
      props.onScrollBy(-SCROLL_LINES, layout.maxScroll);
      return;
    }
    if (key.pageUp) {
      props.onScrollBy(key.shift ? halfPage : page, layout.maxScroll);
      return;
    }
    if (key.pageDown) {
      props.onScrollBy(key.shift ? -halfPage : -page, layout.maxScroll);
      return;
    }
    if (key.home) {
      props.onScrollToTop();
      return;
    }
    if (key.end) {
      props.onScrollToBottom();
      return;
    }
    // Ctrl+U / Ctrl+D — half-page scroll (Emacs convention). The
    // laptop-friendly fallback: PgUp/PgDn/Home/End don't exist on many
    // compact keyboards, but Ctrl+letter always does (raw 0x15 / 0x04,
    // parsed by Ink as ctrl+u / ctrl+d). Placed BEFORE the ctrl catch-all
    // below (which would otherwise swallow them) and the char path (a raw
    // ctrl byte has no printable char to type).
    if (key.ctrl && input === "u") {
      props.onScrollBy(halfPage, layout.maxScroll);
      return;
    }
    if (key.ctrl && input === "d") {
      props.onScrollBy(-halfPage, layout.maxScroll);
      return;
    }
    // Any other SGR mouse event (clicks, drags, releases): ignore — it
    // would otherwise land in the input line as garbage text.
    if (MOUSE_SGR.test(input)) {
      return;
    }
    if (key.tab || key.escape || key.ctrl) return;
    if (input !== "" && !key.meta) props.onChar(input);
  });

  // Frame, top -> bottom (exactly `rows` lines by construction):
  //   header(1) + visible items + pad + [approval(1)] + hint(1)
  //   + [D16 menu lines (0..MENU_MAX_LINES)]
  //   + top separator(1) + input (1..N lines, wraps at width) + bottom separator(1)
  //   + RESERVED_BOTTOM_LINES bottom-display lines (D15: /display-bottom).
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {/* busy = YELLOW, not dim: the one moment the header should jump
            out is while the agent is working (the dim chrome is the
            resting state). The base is truncated to leave room for the
            indicator — the header is ALWAYS exactly one row (frame
            contract), so the busy suffix must never push it past width. */}
        {oneLine(
          `tre. · ${state.modelLabel} — turn ${state.turn}`,
          state.busy ? Math.max(1, width - " · working…".length) : width
        )}
        {state.busy && <Text color="yellow"> · working…</Text>}
      </Text>
      {layout.visible.map((slice, i) => (
        <Item key={i} slice={slice} prev={prevOf(state.items, slice.item)} width={width} />
      ))}
      {Array.from({ length: layout.pad }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
      {state.approval !== null && (
        <Text color="yellow">{approvalLine(state.approval.question, width)}</Text>
      )}
      {/* C27: the hint line doubles as the scroll status — while the view
          is frozen above the bottom, say where it is and how to get back.
          The wheel only works when the driver enabled mouse tracking
          (TRE_MOUSE=1, run.tsx) — don't promise it in the hint otherwise. */}
      <Text dimColor>
        {oneLine(
          state.approval !== null
            ? "y approve · n/esc deny"
            : state.modelPicker !== null
              ? "↑/↓ select · enter switch model · esc close"
              : layout.eff > 0
              ? `↑${layout.eff}/${layout.maxScroll} scrolled — PgDn${wheel} ↓ to bottom · Home top · /quit exit`
              : `enter send · PgUp/PgDn/Ctrl+U/Ctrl+D${wheel} scroll · ↑/↓ history · /quit exit`,
          width
        )}
      </Text>
      {/* D16: slash-command completion menu — grey lines above the input,
          selected candidate marked with "> " and YELLOW (C31: the resting
          chrome is dim; the pick is the one line that should stand out). */}
      {menu.map((m, i) => (
        <Text key={`menu-${i}`} dimColor={!m.selected} color={m.selected ? "yellow" : undefined}>
          {m.line}
        </Text>
      ))}
      {/* C38: the model picker — the same grey-menu treatment as the D16
          completion menu (selected row marked with "> " and YELLOW). The
          picker and the completion menu are never visible at once (the
          picker only opens after the `/models` submit, which clears the
          input). */}
      {picker.map((m, i) => (
        <Text key={`picker-${i}`} dimColor={!m.selected} color={m.selected ? "yellow" : undefined}>
          {m.line}
        </Text>
      ))}
      <Text color="gray">{"\u2500".repeat(width)}</Text>
      {/* D15: no 'you' prefix — the input is plain text. The cursor
          (inputWrap) renders at state.cursorPos, so its LOCATION is visible
          (not just at the end); it is always present, so the block is never
          zero-height. The input WRAPS at the terminal width — each wrapped
          line is one row (the fit budget above accounts for the extras). */}
      {inputLines.map((line, i) => (
        <Text key={`input-${i}`}>{line === "" ? " " : line}</Text>
      ))}
      <Text color="gray">{"\u2500".repeat(width)}</Text>
      {/* D15: the reserved lines are the user-configurable bottom display
          (/display-bottom) — blank when nothing is selected. The `context`
          line is tinted by compaction urgency (green → yellow → red); the
          `workers` line is colored PER WORKER (running → green, a model that
          already ran → gray — see workersLineAnsi); the rest stay dim. The
          `keys` array mirrors bottomLines' iteration EXACTLY (same skip of
          unknown keys, same RESERVED_BOTTOM_LINES cap, same padding) so line
          i's key pairs with line i's text — including when an unknown key
          would shift indices. */}
      {(() => {
        const lines = bottomLines(state, width);
        const colors = bottomLineColors(state);
        const keys: (string | undefined)[] = [];
        for (const key of state.bottom) {
          if (keys.length >= RESERVED_BOTTOM_LINES) break;
          if (!(BOTTOM_FIELDS as readonly string[]).includes(key)) continue;
          keys.push(key);
        }
        while (keys.length < RESERVED_BOTTOM_LINES) keys.push(undefined);
        return lines.map((line, i) => {
          const isWorkers = keys[i] === "workers";
          // The workers line is an ANSI string that ALREADY carries its own
          // per-worker SGR codes (green/gray/dim), so it must NOT be wrapped
          // in dimColor (that would dim the bright-green running worker).
          // Every other line keeps the single-color behavior (dim when the
          // tint is undefined, else that tint).
          if (isWorkers) {
            return (
              <Text key={`reserved-${i}`}>
                {workersLineAnsi(state, width)}
              </Text>
            );
          }
          const color = colors[i];
          return (
            <Text key={`reserved-${i}`} dimColor={color === undefined} color={color}>
              {line || " "}
            </Text>
          );
        });
      })()}
    </Box>
  );
}

/**
 * One visible slice of an item (C28): draws EXACTLY lines [from, to) of
 * `itemLines(item, width, prev)` — the same lines the fit math counted (the
 * fit computes them with the item's ABSOLUTE predecessor in the content;
 * `prev` is that predecessor, reconstructed from the contiguous visible
 * slice), so a straddling item is clipped, never dropped, and the frame
 * stays exactly `rows` tall. (D15/D19 notes moved to lines.ts with the line
 * shapes.)
 */
function Item({ slice, prev, width }: { slice: VisibleSlice; prev: TuiItem | undefined; width: number }): React.ReactElement {
  const lines = itemLines(slice.item, width, prev).slice(slice.from, slice.to);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>
          {line.spans.map((sp, j) => (
            <Text key={j} color={sp.color} dimColor={sp.dim} bold={sp.bold}>
              {sp.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}
