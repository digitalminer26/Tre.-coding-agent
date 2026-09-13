/**
 * WS10 — pure TUI state machine (no Ink, no I/O — unit-testable).
 *
 * The TUI consumes the SAME `AgentEvent` stream the plain CLI prints
 * (D5/D11): `applyEvent` folds one event into a `TuiState`, and the Ink
 * layer is a dumb renderer of that state. Input is handled by the small
 * pure functions at the bottom (char / backspace / history / submit /
 * approval) — the keybinding table itself lives in app.tsx.
 */
import type { AgentEvent } from "../types.js";
import { renderEditDiff } from "./diff.js";

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
    }
  | { kind: "compaction"; tokensBefore: number; messagesKept: number; summaryChars: number }
  | { kind: "error"; text: string };

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
}

export function makeInitialState(modelLabel: string): TuiState {
  return {
    items: [],
    input: "",
    history: [],
    historyIdx: null,
    busy: false,
    turn: 0,
    approval: null,
    modelLabel,
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
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === "assistant" && it.streaming ? { ...it, streaming: false, thinking: false } : it,
        ),
      };
    }
    case "tool_execution_start": {
      const diff = ev.toolCall.name === "edit" ? renderEditDiff(ev.toolCall.arguments) : undefined;
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
