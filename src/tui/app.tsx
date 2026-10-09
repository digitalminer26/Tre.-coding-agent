/**
 * WS10 — the Ink app (D11). A dumb renderer of `TuiState`: it holds no
 * agent logic and no event handling — every key is routed to a callback
 * the driver (run.ts) wires to the pure state functions. That split keeps
 * the testable surface in state.ts and makes this file purely presentational.
 */
import React from "react";
import { Box, Text, useInput, useStdout } from "ink";
import cliTruncate from "cli-truncate";
import stringWidth from "string-width";
import type { SelectionAnchor, TuiItem, TuiState, VisibleSlice } from "./state.js";
import { itemLines, type RLine } from "./lines.js";
import { isSgrMouse, parseSgrMouse } from "./mouse.js";
import {
  BOTTOM_FIELDS,
  FIXED_NON_ITEM_LINES,
  RESERVED_BOTTOM_LINES,
  approvalLine,
  bottomLineColors,
  bottomLines,
  dispWidth,
  fitItemsScrollable,
  inputWrap,
  modelPickerMenu,
  selectedRanges,
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

// ── Mouse-selection highlight (TRE_MOUSE=1) ────────────────────────────────
// A selected range is painted as a background on the SELECTED CELLS only —
// the cells the user can see highlighted are exactly the cells /copy copies
// (same display-column math, charWidth/dispWidth — the shared width rule).
// The tint is a 256-color gray (#5f5f5f, the "selected text" gray of most
// terminals): Ink colorizes it through chalk, which degrades to the nearest
// 16-color bg (bgGray) on terminals without 256-color support — the
// highlight stays visible at every color level.
const SEL_BG = "#5f5f5f";
/** Split a line's display columns at `c`: [before, at, after] — a wide char
 * straddling the boundary goes to `after` (a half cell is not renderable). */
function splitAtCols(s: string, c: number): [string, string, string] {
  let before = "";
  let at = "";
  let col = 0;
  let rest = "";
  for (const grapheme of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)) {
    const g = grapheme.segment;
    const w = stringWidth(g);
    if (col + w <= c) before += g;
    else if (col >= c) rest += g;
    else at += g;
    col += w;
  }
  return [before, at, rest];
}
/** Re-style one rendered line: the cells in [from, to) get the selection
 * background; every original span keeps its own styling (color/dim/bold
 * untouched — the highlight COMPOSES with the existing colors, it does not
 * replace them). The span text is split at display columns (splitAtCols),
 * so a selection edge mid-span yields up to three runs per span. */
function highlightLine(line: RLine, from: number, to: number): RLine {
  const spans: RLine["spans"] = [];
  let col = 0;
  for (const sp of line.spans) {
    const w = dispWidth(sp.text);
    const end = col + w;
    const a = Math.max(col, from); // selected start, in this span's text
    const b = Math.min(end, to); // selected end, in this span's text
    if (a < b) {
      const [pre, tail] = splitAtCols(sp.text, a - col);
      const [sel2, post2] = splitAtCols(tail, b - a);
      if (pre !== "") spans.push({ ...sp, text: pre });
      if (sel2 !== "") spans.push({ ...sp, text: sel2, bg: SEL_BG });
      if (post2 !== "") spans.push({ ...sp, text: post2 });
    } else {
      spans.push(sp);
    }
    col = end;
  }
  return { spans };
}

// C27 — mouse-wheel scrolling. SGR (mode 1006) and X11 (4-byte) wheel
// events arrive at Ink as RAW input text (no parsed `name`): button 64/65
// (SGR) or 62/63 (X11), the `M` suffix = press (one event per notch); the
// `m` release is ignored (anchored below) so a press+release pair scrolls
// once. Clicks/drags/releases are the other SGR sequences — the mouse
// selection (below) parses them; anything unrecognized is swallowed, never
// typed.
const MOUSE_WHEEL_UP = /^\[<(64|62);\d+;\d+M$/;
const MOUSE_WHEEL_DOWN = /^\[<(65|63);\d+;\d+M$/;
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
  /** Mouse selection: a left-button PRESS in the item viewport (the App
   * mapped the terminal cell to a content anchor). */
  onSelectStart: (anchor: SelectionAnchor) => void;
  /** Mouse selection: a button-held MOTION (drag) — move the endpoint. */
  onSelectUpdate: (anchor: SelectionAnchor) => void;
  onSelectEnd?: () => void;
  /** Mouse selection: Esc — clear the selection. */
  onSelectClear: () => void;
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
  // Mouse selection (opt-in, TRE_MOUSE=1): the item viewport is the frame's
  // rows 2..(1+budget) (the header is row 1); the fit guarantees the item
  // area is exactly `budget` rows tall (visible lines + pad). A terminal
  // (row, col) maps to a CONTENT anchor through the visible slices — rows
  // outside the item area (header, hint, menu, picker, separators, input,
  // bottom display) are NOT selectable (a press there is ignored).
  const itemAreaHeight =
    layout.visible.reduce((a, v) => a + (v.to - v.from), 0) + layout.pad;
  const anchorAt = (row: number, col: number): SelectionAnchor | null => {
    // 1-based terminal row → 0-based item-area row (the header is row 1).
    const areaRow = row - 2;
    if (areaRow < 0 || areaRow >= itemAreaHeight) return null;
    let r = areaRow;
    for (const slice of layout.visible) {
      const h = slice.to - slice.from;
      if (r < h) {
        const idx = state.items.indexOf(slice.item);
        if (idx < 0) return null;
        const line = slice.from + r;
        const prev = idx > 0 ? state.items[idx - 1] : undefined;
        const lineText = itemLines(slice.item, width, prev)[line]?.spans
          .map((sp) => sp.text)
          .join("") ?? "";
        // 1-based terminal col → 0-based display col, clamped to the line's
        // display width (a press past the end of the line selects to its
        // end; wide chars count 2 — dispWidth, the shared width rule).
        return { itemIndex: idx, line, col: Math.max(0, Math.min(col - 1, dispWidth(lineText))) };
      }
      r -= h;
    }
    // In the pad (below the last visible slice): the nearest content edge —
    // the last rendered line of the last visible slice, to its end.
    const last = layout.visible[layout.visible.length - 1];
    if (last === undefined) return null; // empty content: nothing to select
    const idx = state.items.indexOf(last.item);
    if (idx < 0) return null;
    const prev = idx > 0 ? state.items[idx - 1] : undefined;
    const lineText = itemLines(last.item, width, prev)[last.to - 1]?.spans
      .map((sp) => sp.text)
      .join("") ?? "";
    return { itemIndex: idx, line: last.to - 1, col: dispWidth(lineText) };
  };
  // The selection's per-line column ranges, computed ONCE per render (the
  // visible slices are highlighted against it below). null = no selection.
  const nearestAnchor = (row: number, col: number): SelectionAnchor | null => {
    if (layout.visible.length === 0) return null;
    const firstRow = 2;
    const lastRow = firstRow + itemAreaHeight - 1;
    const clampedRow = Math.max(firstRow, Math.min(row, lastRow));
    if (row < firstRow) return anchorAt(firstRow, 1);
    if (row > lastRow) return anchorAt(lastRow, width);
    return anchorAt(clampedRow, col);
  };
  const selRanges =
    state.selection === null
      ? null
      : selectedRanges(state, (i) => {
          const it = state.items[i];
          if (it === undefined) return [];
          const p = i > 0 ? state.items[i - 1] : undefined;
          return itemLines(it, width, p).map((l) => l.spans.map((sp) => sp.text).join(""));
        });
  const selForSlice = (slice: VisibleSlice): Map<number, [number, number]> | null => {
    if (selRanges === null) return null;
    const idx = state.items.indexOf(slice.item);
    const map = new Map<number, [number, number]>();
    for (const r of selRanges) {
      if (r.itemIndex === idx && r.line >= slice.from && r.line < slice.to) {
        map.set(r.line, [r.from, r.to]);
      }
    }
    return map.size > 0 ? map : null;
  };

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
    // Mouse selection (opt-in, TRE_MOUSE=1): the driver enables SGR mouse
    // reporting (1002 + 1006) only then, so these events arrive only in
    // mouse mode. A left-button PRESS in the item viewport starts a
    // selection (anchorAt maps the terminal cell to content coordinates);
    // a button-held MOTION (SGR b=32) updates the endpoint; a RELEASE
    // (suffix `m`) fixes it — the selection stays visible for /copy.
    // Esc clears it (selectClear via onSelectClear). Presses outside the
    // item viewport (header, hint, menu, separators, input, bottom display)
    // map to null and are ignored — they never type, never activate
    // controls, and never start a selection.
    if (process.env.TRE_MOUSE) {
      const ev = parseSgrMouse(input);
      if (ev !== null) {
        if (ev.button === "left" && ev.pressed && !ev.motion) {
          const a = anchorAt(ev.row, ev.col);
          if (a !== null) props.onSelectStart(a);
        } else if (ev.button === "left" && ev.pressed && ev.motion) {
          const a = anchorAt(ev.row, ev.col) ?? nearestAnchor(ev.row, ev.col);
          if (a !== null) props.onSelectUpdate(a);
        } else if (!ev.pressed) {
          props.onSelectEnd?.();
        }
        // Non-left buttons are ignored.
        return;
      }
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
    // Any other SGR mouse event (clicks, drags, releases — e.g. when the
    // terminal reports mouse events without TRE_MOUSE=1, or a release that
    // needs no callback): swallow it — it would otherwise land in the input
    // line as garbage text.
    if (isSgrMouse(input)) {
      return;
    }
    // Mouse selection: Esc clears an ACTIVE selection (a selection can only
    // exist in mouse mode, so this never fires otherwise). Placed after the
    // approval/picker branches (they own Esc there) and before the catch-all
    // swallow — with no selection, Esc keeps its current behavior (swallowed).
    if (key.escape && state.selection !== null) {
      props.onSelectClear();
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
        <Item
          key={i}
          slice={slice}
          prev={prevOf(state.items, slice.item)}
          width={width}
          sel={selForSlice(slice)}
        />
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
function Item({
  slice,
  prev,
  width,
  sel,
}: {
  slice: VisibleSlice;
  prev: TuiItem | undefined;
  width: number;
  /** The selection's column ranges for this slice's lines, keyed by the
   * line's index in the item's FULL rendered lines (slice.from..slice.to);
   * null = no selected line in this slice. */
  sel: Map<number, [number, number]> | null;
}): React.ReactElement {
  const lines = itemLines(slice.item, width, prev).slice(slice.from, slice.to);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const lineIdx = slice.from + i;
        const range = sel !== null ? sel.get(lineIdx) : undefined;
        const styled = range !== undefined ? highlightLine(line, range[0], range[1]) : line;
        return (
          <Text key={i}>
            {styled.spans.map((sp, j) => (
              <Text key={j} color={sp.color} dimColor={sp.dim} bold={sp.bold} backgroundColor={sp.bg}>
                {sp.text}
              </Text>
            ))}
          </Text>
        );
      })}
    </Box>
  );
}
