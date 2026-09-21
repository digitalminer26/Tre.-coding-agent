/**
 * WS10 — the Ink app (D11). A dumb renderer of `TuiState`: it holds no
 * agent logic and no event handling — every key is routed to a callback
 * the driver (run.ts) wires to the pure state functions. That split keeps
 * the testable surface in state.ts and makes this file purely presentational.
 */
import React from "react";
import { Box, Text, useInput, useStdout } from "ink";
import cliTruncate from "cli-truncate";
import type { TuiItem, TuiState } from "./state.js";
import {
  approvalLine,
  bottomLines,
  fitItems,
  inputWrap,
  suggestMenu,
} from "./state.js";

/** Truncate a line to at most `w` display columns (ellipsis at the end). */
const oneLine = (s: string, w: number): string => cliTruncate(s, w, { position: "end" });

export interface AppProps {
  state: TuiState;
  onChar: (ch: string) => void;
  onBackspace: () => void;
  /** Move the input cursor left (-1) / right (1). */
  onMove: (dir: -1 | 1) => void;
  onHistory: (dir: -1 | 1) => void;
  onSubmit: () => void;
  onCtrlC: () => void;
  onApproval: (ok: boolean) => void;
  /** /quit while idle — exit 0 (the driver owns the unmount). */
  onQuit: () => void;
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
  // The input WRAPS at the terminal width (inputWrap): the extra lines beyond
  // the one the pinned block reserves steal item budget, exactly like the
  // approval line and the menu do — the frame stays exactly `rows` tall.
  const inputLines = inputWrap(state.input, state.cursorPos, width);
  const layout = fitItems(
    state.items,
    width,
    rows,
    (state.approval !== null ? 1 : 0) + menu.length + (inputLines.length - 1),
  );

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
        {oneLine(
          `tre. · ${state.modelLabel} — turn ${state.turn}${state.busy ? " · working…" : ""}`,
          width
        )}
      </Text>
      {layout.visible.map((item, i) => (
        // D19: hidden (quiet file-access) items are height-0 placeholders —
        // the fit math already counted them as nothing, so render nothing.
        item.kind === "tool" && item.hidden ? null : <Item key={i} item={item} />
      ))}
      {Array.from({ length: layout.pad }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
      {state.approval !== null && (
        <Text color="yellow">{approvalLine(state.approval.question, width)}</Text>
      )}
      <Text dimColor>
        {oneLine(
          state.approval !== null
            ? "y approve · n/esc deny"
            : "enter send · / commands · ↑/↓ history · ←/→ cursor · ctrl+c abort/quit · /quit exit",
          width
        )}
      </Text>
      {/* D16: slash-command completion menu — grey lines above the input,
          selected candidate marked with "> ". */}
      {menu.map((m, i) => (
        <Text key={`menu-${i}`} dimColor={!m.selected}>{m.line}</Text>
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
          (/display-bottom) — blank when nothing is selected. */}
      {bottomLines(state, width).map((line, i) => (
        <Text key={`reserved-${i}`} dimColor>{line || " "}</Text>
      ))}
    </Box>
  );
}

function Item({ item }: { item: TuiItem }): React.ReactElement {
  switch (item.kind) {
    case "user":
      // D15: plain text at full width — no 'you' prefix (the dedicated input
      // line already marks where typing happens).
      return <Text>{item.text || " "}</Text>;
    case "assistant":
      return (
        <Box flexDirection="column">
          {item.thinking && <Text dimColor>
            thinking…
          </Text>}
          <Text>
            {item.text}
            {item.streaming ? "▍" : ""}
          </Text>
        </Box>
      );
    case "tool": {
      const mark = item.resultText !== undefined ? (item.isError ? "✗" : "✓") : item.running ? "→" : "·";
      const color = item.isError ? "red" : item.resultText !== undefined ? "green" : "gray";
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={color}>{mark}</Text>
            <Text>
              {" "}
              {item.name} {item.argsText}
            </Text>
          </Box>
          {item.diff !== undefined &&
            item.diff.map((line, i) => (
              <Text key={i} color={line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : undefined}>
                {line}
              </Text>
            ))}
          {item.resultText !== undefined && (
            <Box>
              <Text dimColor>  {item.resultText}</Text>
            </Box>
          )}
        </Box>
      );
    }
    case "compaction":
      return (
        <Text color="magenta">
          ✂ compacted: ~{Math.round(item.tokensBefore / 100) / 10}k tokens → summary (
          {item.summaryChars} chars) + last {item.messagesKept} message(s) kept
        </Text>
      );
    case "error":
      return <Text color="red">{item.text}</Text>;
    case "info":
      return <Text dimColor>{item.text}</Text>;
  }
}
