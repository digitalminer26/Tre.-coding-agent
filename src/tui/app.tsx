/**
 * WS10 — the Ink app (D11). A dumb renderer of `TuiState`: it holds no
 * agent logic and no event handling — every key is routed to a callback
 * the driver (run.ts) wires to the pure state functions. That split keeps
 * the testable surface in state.ts and makes this file purely presentational.
 */
import React from "react";
import { Box, Text, useInput } from "ink";
import type { TuiItem, TuiState } from "./state.js";

export interface AppProps {
  state: TuiState;
  onChar: (ch: string) => void;
  onBackspace: () => void;
  onHistory: (dir: -1 | 1) => void;
  onSubmit: () => void;
  onCtrlC: () => void;
  onApproval: (ok: boolean) => void;
  /** /quit while idle — exit 0 (the driver owns the unmount). */
  onQuit: () => void;
}

export function App(props: AppProps): React.ReactElement {
  const { state } = props;

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

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {state.modelLabel} — turn {state.turn}
        {state.busy ? " · working…" : ""}
      </Text>
      {state.items.map((it, i) => (
        <Item key={i} item={it} />
      ))}
      <Box>
        <Text color="cyan">you</Text>
        <Text> {state.input}</Text>
      </Box>
      {state.approval !== null && (
        <Box>
          <Text color="yellow">{state.approval.question} [y/N]</Text>
        </Box>
      )}
      <Text dimColor>
        {state.approval !== null
          ? "y approve · n/esc deny"
          : "enter send · ↑/↓ history · ctrl+c abort/quit · /quit exit"}
      </Text>
    </Box>
  );
}

function Item({ item }: { item: TuiItem }): React.ReactElement {
  switch (item.kind) {
    case "user":
      return (
        <Box>
          <Text color="cyan">you</Text>
          <Text> {item.text}</Text>
        </Box>
      );
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
  }
}
