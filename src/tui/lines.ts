/**
 * C28 — the rendered lines of one TuiItem, as data.
 *
 * Before C28 the LINE COUNT (itemHeight in state.ts) and the RENDERING
 * (Item in app.tsx) were two separate implementations of the same layout.
 * The C27 scroll viewport trusted the count and rendered with the other, so
 * an item straddling the window edge had to be dropped whole — a single
 * reply taller than the item budget (the common long-output shape) could
 * not be scrolled at all. C28 makes the lines sliceable: fit computes the
 * per-item line lists once, the viewport slices [from, to) of them, and the
 * renderer draws exactly those lines.
 *
 * CONTRACT (pinned in test/tui-pinned-layout.test.ts):
 *   itemLines(item, width).length === itemHeight(item, width)
 * The fit math counts lines and the viewport slices them; drift between the
 * two is a broken frame. When editing either, edit both and the test.
 */
import wrapAnsi from "wrap-ansi";
import type { TuiItem } from "./state.js";

/** One styled run inside a line (a line = one rendered terminal row). */
export interface RSpan {
  text: string;
  /** Ink `color` for this run (undefined = default foreground). */
  color?: string;
  /** Ink `dimColor` for this run. */
  dim?: boolean;
}

/** One rendered terminal row: one or more styled runs, in order. */
export interface RLine {
  spans: RSpan[];
}

/** Same wrap options Ink's full-width `<Text>` uses — keep them mirrored. */
const WRAP = { trim: false, hard: true };

function wrapRows(text: string, width: number): string[] {
  return wrapAnsi(text, Math.max(1, width), WRAP).split("\n");
}

const plain = (text: string): RLine => ({ spans: [{ text }] });

/**
 * The exact lines the TUI renders for `item` at `width` (see the module
 * contract). Height-0 items (hidden tools) yield [].
 */
export function itemLines(item: TuiItem, width: number): RLine[] {
  switch (item.kind) {
    case "user":
      // No prefix (D15): plain at full width; empty text still renders one
      // blank row (a bare space in the renderer).
      return item.text ? wrapRows(item.text, width).map(plain) : [plain(" ")];
    case "assistant": {
      const lines: RLine[] = [];
      if (item.thinking) lines.push({ spans: [{ text: "thinking…", dim: true }] });
      // The streaming cursor is part of the rendered text — and of the
      // height (itemHeight counts it): before C28 the cursor line rendered
      // but did not count, overflowing the frame by one row mid-stream.
      const text = item.text + (item.streaming ? "▍" : "");
      if (text !== "") for (const l of wrapRows(text, width)) lines.push(plain(l));
      return lines;
    }
    case "tool": {
      if (item.hidden) return []; // D19: quiet tool — renders nothing
      const lines: RLine[] = [];
      const mark =
        item.resultText !== undefined
          ? item.isError
            ? "✗"
            : "✓"
          : item.running
            ? "→"
            : "·";
      const color = item.isError ? "red" : item.resultText !== undefined ? "green" : "gray";
      // Header: mark (colored) + " name args", wrapped as one string —
      // exactly how itemHeight counts it.
      const head = wrapRows(`${mark} ${item.name} ${item.argsText}`, width);
      head.forEach((l, i) => {
        if (i === 0 && l !== "") lines.push({ spans: [{ text: l.charAt(0), color }, { text: l.slice(1) }] });
        else lines.push(plain(l));
      });
      if (item.diff !== undefined) {
        for (const line of item.diff) {
          if (line === "") continue;
          const dcolor = line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : undefined;
          for (const l of wrapRows(line, width)) lines.push({ spans: [{ text: l, color: dcolor }] });
        }
      }
      if (item.resultText !== undefined) {
        // itemHeight counts wrap(`${mark} ${result}`) — mark + space is two
        // columns, the renderer draws two spaces: same wrap, dim color.
        for (const l of wrapRows(`  ${item.resultText}`, width))
          lines.push({ spans: [{ text: l, dim: true }] });
      }
      return lines;
    }
    case "compaction": {
      const text = `✂ compacted: ~${Math.round(item.tokensBefore / 100) / 10}k tokens → summary (${item.summaryChars} chars) + last ${item.messagesKept} message(s) kept`;
      return wrapRows(text, width).map((l) => ({ spans: [{ text: l, color: "magenta" }] }));
    }
    case "error":
      return item.text ? wrapRows(item.text, width).map((l) => ({ spans: [{ text: l, color: "red" }] })) : [];
    case "info":
      return item.text ? wrapRows(item.text, width).map((l) => ({ spans: [{ text: l, dim: true }] })) : [];
  }
}
