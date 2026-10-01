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
 * C31 — readability: every block type gets an icon (❯ user, ◆ assistant,
 * ◦ thinking, ⚠ error, ℹ info, ✂ compaction, ✓/✗/→ tools), wrapped text
 * hangs under a 2-column icon gutter, and a blank line separates a user
 * prompt from the block that follows it and any block from the next user
 * prompt (a new turn). The blank line is a LEADING line of the later item
 * (see blankBefore), so the per-item lockstep contract below holds with
 * the same `prev` on both sides, and a C30 clip of an over-budget item
 * drops the separator first (it is the item's first line).
 *
 * CONTRACT (pinned in test/tui-pinned-layout.test.ts):
 *   itemLines(item, width, prev).length === itemHeight(item, width, prev)
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

/**
 * C31: the blank line that separates blocks — one before EVERY item that is
 * not the first (a fresh prompt after a turn), and one before a NON-user
 * item that follows a user item (the prompt's reply block). `prev` is the
 * item rendered immediately above (undefined = the item is first). The
 * HEIGHT side (itemHeight) must count the same line with the same `prev`.
 */
function blankBefore(item: TuiItem, prev: TuiItem | undefined): boolean {
  if (prev === undefined) return false;
  if (item.kind === "user") return true;
  return prev.kind === "user";
}

/**
 * The exact lines the TUI renders for `item` at `width` (see the module
 * contract). Height-0 items (hidden tools) yield []. `prev` = the item
 * rendered immediately above (undefined = first) — it decides the C31
 * leading blank line.
 */
export function itemLines(item: TuiItem, width: number, prev?: TuiItem): RLine[] {
  const lines: RLine[] = [];
  if (item.kind !== "tool" || !item.hidden) {
    // The separator is part of THIS item's rendered lines (the lockstep
    // contract counts it — itemHeight gets the same `prev`).
    if (blankBefore(item, prev)) lines.push({ spans: [{ text: " " }] });
  }
  switch (item.kind) {
    case "user":
      // C31: the prompt gets a CYAN ❯ icon (2 columns) and its text HANGS
      // under it — wrapped at width−2, icon on line 1, 2-space indent on
      // the rest — so a multi-line prompt reads as one block. Empty text
      // still renders one blank row (a bare space), colored for uniformity.
      if (item.text) {
        const rows = wrapRows(item.text, Math.max(1, width - 2));
        rows.forEach((l, i) =>
          lines.push({ spans: [{ text: (i === 0 ? "❯ " : "  ") + l, color: "cyan" }] }),
        );
      } else {
        lines.push({ spans: [{ text: " ", color: "cyan" }] });
      }
      return lines;
    case "assistant": {
      const body: RLine[] = [];
      // The model's reasoning (the wire's `reasoning_content`), accumulated
      // by the state machine. Rendered as a DISTINCT block above the reply so
      // it reads as the model's aside, not part of the answer:
      //   · a dim header ("◦ thinking…" while it streams, "◦ thinking" done)
      //   · the reasoning under a dim "│ " gutter, wrapped at width−2 so the
      //     gutter + text never exceed the terminal width
      //   · a blank line separating the block from the reply.
      // Empty when the model did not think (no lines at all). The gutter and
      // the blank line are part of the height (itemHeight counts them) — the
      // lockstep contract (itemLines.length === itemHeight) holds.
      if (item.thinkingText !== "") {
        body.push({ spans: [{ text: "◦ " + (item.thinking ? "thinking…" : "thinking"), dim: true }] });
        for (const l of wrapRows(item.thinkingText, Math.max(1, width - 2)))
          body.push({ spans: [{ text: "│ " + l, dim: true }] });
        body.push({ spans: [{ text: " " }] }); // blank line: thinking | reply
      }
      // The streaming cursor is part of the rendered text — and of the
      // height (itemHeight counts it): before C28 the cursor line rendered
      // but did not count, overflowing the frame by one row mid-stream.
      // C31: a ◆ icon leads the reply (2 columns) and the text hangs under
      // it — wrapped at width−2, icon on line 1, 2-space indent on the rest
      // — so the reply reads as one block, distinct from the cyan prompt
      // and the dim reasoning.
      const text = item.text + (item.streaming ? "▍" : "");
      if (text !== "") {
        const rows = wrapRows(text, Math.max(1, width - 2));
        rows.forEach((l, i) => body.push({ spans: [{ text: (i === 0 ? "◆ " : "  ") + l }] }));
      }
      return [...lines, ...body];
    }
    case "tool": {
      if (item.hidden) return []; // D19: quiet tool — renders nothing
      const body: RLine[] = [];
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
        body.push({ spans });
        off = end;
      }
      if (item.diff !== undefined) {
        // C31: diff lines hang under the header — wrapped at width−2, then
        // every row gets the 2-space indent (indenting BEFORE the wrap would
        // only indent line 1).
        for (const line of item.diff) {
          if (line === "") continue;
          const dcolor = line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : undefined;
          for (const l of wrapRows(line, Math.max(1, width - 2)))
            body.push({ spans: [{ text: "  " + l, color: dcolor }] });
        }
      }
      if (item.resultText !== undefined) {
        // C31: the result hangs under the header too — wrapped at width−2,
        // 2-space indent on every row (itemHeight counts the same wrap).
        for (const l of wrapRows(item.resultText, Math.max(1, width - 2)))
          body.push({ spans: [{ text: "  " + l, dim: true }] });
      }
      return [...lines, ...body];
    }
    case "compaction": {
      // C31: the ✂ icon leads (2 columns); the text hangs under it.
      const text = `compacted: ~${Math.round(item.tokensBefore / 100) / 10}k tokens → summary (${item.summaryChars} chars) + last ${item.messagesKept} message(s) kept`;
      const rows = wrapRows(text, Math.max(1, width - 2));
      const body = rows.map((l, i) => ({ spans: [{ text: (i === 0 ? "✂ " : "  ") + l, color: "magenta" as const }] }));
      return [...lines, ...body];
    }
    case "error": {
      // C31: a ⚠ icon leads the error (2 columns); the text hangs under it.
      if (item.text === "") return lines;
      const rows = wrapRows(item.text, Math.max(1, width - 2));
      const body = rows.map((l, i) => ({ spans: [{ text: (i === 0 ? "⚠ " : "  ") + l, color: "red" as const }] }));
      return [...lines, ...body];
    }
    case "info": {
      // C31: an ℹ icon leads the info line (2 columns); the text hangs under it.
      if (item.text === "") return lines;
      const rows = wrapRows(item.text, Math.max(1, width - 2));
      if (item.startup) {
        // Startup behavior block: the SAME wrap and the SAME "ℹ "/"  " gutter
        // as the plain-info rendering — only the spans/colors change, so the
        // line count is identical and the lockstep contract with itemHeight
        // holds. Coloring is GENERIC (no hardcoded line names):
        //   · a line that is exactly "Behavior:" → whole line CYAN (not dim)
        //   · a "label:" line → GREEN label (gutter + indent + colon) + dim value
        //   · anything else → dim (unchanged)
        const body = rows.map((l, i) => {
          const gutter = i === 0 ? "ℹ " : "  ";
          if (l.trimStart() === "Behavior:") {
            return { spans: [{ text: gutter + l, color: "cyan" }] };
          }
          const m = /^(\s*)([A-Za-z][\w-]*):/.exec(l);
          if (m !== null) {
            // The green span is the gutter + the label match (up to and
            // including the colon); the remainder of the line is dim.
            return {
              spans: [
                { text: gutter + l.slice(0, m[0].length), color: "green" },
                { text: l.slice(m[0].length), dim: true },
              ],
            };
          }
          return { spans: [{ text: gutter + l, dim: true }] };
        });
        return [...lines, ...body];
      }
      const body = rows.map((l, i) => ({ spans: [{ text: (i === 0 ? "ℹ " : "  ") + l, dim: true }] }));
      return [...lines, ...body];
    }
  }
}
