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
      // No prefix (D15): full width, but CYAN — the user's echoed prompt is
      // colored so it is distinguishable from the assistant's plain
      // (default-fg) reply. Color only: no text/width change, so the
      // lockstep contract (itemLines.length === itemHeight) holds. Empty text
      // still renders one blank row (a bare space in the renderer), colored
      // for uniformity (invisible either way).
      return item.text
        ? wrapRows(item.text, width).map((l) => ({ spans: [{ text: l, color: "cyan" }] }))
        : [{ spans: [{ text: " ", color: "cyan" }] }];
    case "assistant": {
      const lines: RLine[] = [];
      // The model's reasoning (the wire's `reasoning_content`), accumulated
      // by the state machine. Rendered as a DISTINCT block above the reply so
      // it reads as the model's aside, not part of the answer:
      //   · a dim header ("thinking…" while it streams, "thinking" once done)
      //   · the reasoning under a dim "│ " gutter, wrapped at width−2 so the
      //     gutter + text never exceed the terminal width
      //   · a blank line separating the block from the reply.
      // Empty when the model did not think (no lines at all). The gutter and
      // the blank line are part of the height (itemHeight counts them) — the
      // lockstep contract (itemLines.length === itemHeight) holds.
      if (item.thinkingText !== "") {
        lines.push({ spans: [{ text: item.thinking ? "thinking…" : "thinking", dim: true }] });
        for (const l of wrapRows(item.thinkingText, Math.max(1, width - 2)))
          lines.push({ spans: [{ text: "│ " + l, dim: true }] });
        lines.push({ spans: [{ text: " " }] }); // blank line: thinking | reply
      }
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
      // The mark carries the OUTCOME (red ✗ / green ✓ / yellow → in flight);
      // the name+args are one blue run — the tool line reads as a unit, and
      // blue separates it from the cyan user prompt and the plain reply.
      const color = item.isError ? "red" : item.resultText !== undefined ? "green" : "yellow";
      // Header: mark + name + args, wrapped as ONE string (exactly how
      // itemHeight counts it), then the wrapped rows are re-split at the
      // mark / name boundaries into colored spans. wrap-ansi's hard wrap
      // only inserts newlines (it never reorders or drops characters —
      // joined, the rows are the original string), so the split is exact.
      const head = wrapRows(`${mark} ${item.name} ${item.argsText}`, width);
      // Segment boundaries in the ORIGINAL string: the mark is [0, 1), the
      // name [1, nameEnd), the args [nameEnd, ∞). Each wrapped row covers
      // [off, off+len) of it (off = the row's start offset — the rows are
      // contiguous slices of the original), so a row is colored by clipping
      // those segments to its range.
      const nameEnd = mark.length + 1 + item.name.length;
      const segs: [number, number, string | undefined][] = [
        [0, mark.length, color],
        [mark.length, nameEnd, "blue"],
        [nameEnd, Number.POSITIVE_INFINITY, undefined],
      ];
      let off = 0;
      for (const l of head) {
        const end = off + l.length;
        const spans: RSpan[] = [];
        for (const [s, e, c] of segs) {
          const a = Math.max(off, s);
          const b = Math.min(end, e);
          if (b > a) spans.push({ text: l.slice(a - off, b - off), ...(c !== undefined ? { color: c } : {}) });
        }
        lines.push({ spans });
        off = end;
      }
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
