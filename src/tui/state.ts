/**
 * WS10 — pure TUI state machine (no Ink, no I/O — unit-testable).
 *
 * The TUI consumes the SAME `AgentEvent` stream the plain CLI prints
 * (D5/D11): `applyEvent` folds one event into a `TuiState`, and the Ink
 * layer is a dumb renderer of that state. Input is handled by the small
 * pure functions at the bottom (char / backspace / history / submit /
 * approval) — the keybinding table itself lives in app.tsx.
 */
import { QUIET_ON_SUCCESS_TOOLS, lengthEndNote, type AgentEvent, type ModelConfig, type Usage, type WorkerStatus } from "../types.js";
import { renderEditDiff } from "./diff.js";
import { itemLines } from "./lines.js";
import wrapAnsi from "wrap-ansi";
import cliTruncate from "cli-truncate";

const oneLine = (s: string, n: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};

/**
 * C34 — a model as the TUI sees it: the id (wire + switch key) plus the
 * fields the TUI displays or uses for the context field. The FULL ModelConfig
 * (baseUrl, apiKey, compat, temperature) stays in the driver — the state
 * machine is pure and never talks to the wire, so it only carries what it
 * renders. The driver re-resolves the full config by id on a switch.
 */
export interface ModelOption {
  id: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
}

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
  /**
   * Slash-command feedback (dim line in the output area). `startup` marks
   * the startup behavior block — it renders in COLOR (cyan header, green
   * labels) instead of all-dim; see `itemLines` in lines.ts.
   */
  | { kind: "info"; text: string; startup?: boolean };

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
  /**
   * C34: the model catalog (light: id + the fields the TUI shows/switches)
   * from models.json. Feeds `/models` (list + switch). The driver seeds it;
   * the full ModelConfig (baseUrl, apiKey, compat) stays in the driver, which
   * re-resolves on a switch. Empty when no catalog was supplied.
   */
  models: ModelOption[];
  /** D15: field keys shown in the reserved bottom lines, in order.
   *  C32: seeded from the persisted config (~/.tre/tui.json) and saved
   *  back by the driver after every `/display-bottom` change. */
  bottom: string[];
  /** D16: selected candidate in the slash-command menu (null = first). */
  suggestIdx: number | null;
  /**
   * C38: the interactive model picker is open — `models[index]` is the
   * highlighted entry (null = closed). Opened by bare `/models` (on the
   * active model's row); ↑/↓ move the highlight (modelPickerNav), enter
   * switches to the highlighted model (modelPickerConfirm), esc closes
   * without switching (modelPickerClose). While open the input is locked,
   * exactly like a pending approval.
   */
  modelPicker: number | null;
  /** Cumulative Usage.totalTokens across assistant `done` events. */
  totalTokens: number;
  /** Session token usage, accumulated separately by provider/model id. */
  modelUsage: Record<string, { total: number; promptNew: number; promptCached: number; generated: number }>;
  /** Count of tool executions started (tool_execution_start events). */
  toolCalls: number;
  /**
   * The model's context window (tokens) — static, from ModelConfig. Drives
   * the `context` bottom field; 0/absent = unknown (renders "—").
   */
  contextWindow: number;
  /** The model's output cap (maxTokens) — static, from ModelConfig. */
  maxTokens: number;
  /**
   * Estimated tokens of the system prompt (chars/4) — static for the session
   * (the prompt is built once at startup). Feeds the `context` field's
   * breakdown and the `/context` report: the prompt is the fixed floor every
   * turn pays, so it is shown separately from the growing message history.
   * 0 = unknown (no prompt supplied — the TUI always supplies one).
   */
  systemPromptTokens: number;
  /**
   * Estimated tokens of the CURRENT compaction summary (chars/4) — set on
   * each `context_compacted` (the summary is a user message in context, so
   * it is part of contextTokens; this tracks it separately so the breakdown
   * can show system / summary / messages). 0 = no compaction yet.
   */
  summaryTokens: number;
  /**
   * Estimated tokens of the CURRENT context (what the next prompt would
   * start from): the last `done` usage's totalTokens (prompt+completion of
   * the last call), or — after a compaction — the estimate of the new
   * [summary, …kept] context (the event's contextTokens). 0 = unknown
   * (no assistant turn yet).
   */
  contextTokens: number;
  /**
   * docs/07 item 1 — the LAST assistant call's full usage (input, output,
   * cache read/write). null until the first `done` with usage. Feeds the
   * `cache` bottom field and the `/context` report's last-call line.
   */
  lastUsage: Usage | null;
  /** docs/07 item 1 — session-cumulative cached prompt tokens (0 when the
   *  endpoint never reports `prompt_tokens_details.cached_tokens`). */
  cacheReadTotal: number;
  /** docs/07 item 1 — session-cumulative cache-write tokens (0 when the
   *  endpoint never reports them). */
  cacheWriteTotal: number;
  /**
   * docs/07 item 2 — the change in context size on the last `done`/compaction
   * (new − old), or null when it can't be computed (first turn, or the event
   * carried no size). Feeds the `context` field's `+N`/`−N` suffix and the
   * `/context` report's growth line.
   */
  contextDelta: number | null;
  /** docs/07 item 2 — the last up to 8 context deltas (a compaction resets it
   *  to `[delta]` — the pre-compaction trend is not comparable to after). The
   *  turns-until-compaction prediction uses the MEAN, so one noisy turn doesn't
   *  wreck the estimate. */
  deltaHistory: number[];
  /** docs/07 item 4 — how many times compaction has fired this session.
   *  0 = none yet. Feeds the `context` field's `×N` suffix and the `/context`
   *  report's history line. */
  compactionCount: number;
  /** docs/07 item 4 — the LAST compaction event (what it compressed, how much
   *  it kept, whether it degraded to the rule-based fallback). null until the
   *  first `context_compacted`. */
  lastCompaction: {
    tokensBefore: number;
    messagesKept: number;
    summaryChars: number;
    degraded: boolean;
  } | null;
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
  /**
   * Endpoint visibility: the LIVE worker set from the shared on-disk
   * registry (~/.tre/workers/, src/cli/workers.ts) — one entry per
   * concurrent `tre. run` process on another endpoint. The driver's 5s
   * poller (run.tsx) fills it; the state machine only CARRIES it (it never
   * reads the disk — the TUI stays pure). Feeds the `workers` bottom field.
   */
  workers: WorkerStatus[];
}

export function makeInitialState(
  modelLabel: string,
  info: Record<string, string> = {},
  window: number = 0,
  maxTokens: number = 0,
  /** C32: bottom fields restored from the persisted config (~/.tre/tui.json). */
  bottom: string[] = [],
  /** Estimated system-prompt tokens (chars/4) — the fixed floor of the context. */
  systemPromptTokens: number = 0,
  /** C34: the model catalog (light) for `/models` — seeded by the driver. */
  models: ModelOption[] = [],
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
    bottom,
    suggestIdx: null,
    modelPicker: null,
    totalTokens: 0,
    modelUsage: {},
    toolCalls: 0,
    contextWindow: window,
    maxTokens,
    systemPromptTokens,
    summaryTokens: 0,
    contextTokens: 0,
    lastUsage: null,
    cacheReadTotal: 0,
    cacheWriteTotal: 0,
    contextDelta: null,
    deltaHistory: [],
    compactionCount: 0,
    lastCompaction: null,
    info,
    viewTop: null,
    models,
    // Endpoint visibility: the driver's workers poller (run.tsx) fills this
    // after mount — it is never a makeInitialState argument (the state
    // machine does no I/O; the poller owns the registry read).
    workers: [],
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
      } else if (ev.stopReason === "stall") {
        // The same tool failed 3× with a permission denial within its
        // recent calls (the deterministic sandbox wall — docs/08 H1: the
        // count is windowed, so interleaved successes don't hide it). The
        // failing call was NOT executed; a different approach (or
        // --no-sandbox) breaks the pattern.
        items = [
          ...items,
          {
            kind: "error",
            text: "stall: the same tool failed 3 times with a permission denial within its last 8 calls — the sandbox boundary is deterministic, so the repeat was not executed. Change approach (a workspace path / a command the sandbox allows) or re-run with --no-sandbox — send another prompt to continue",
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
      // docs/07 item 2: the context grew by (new − old) on this turn —
      // computed only when the new size is known (usage present) AND the old
      // size was known (a prior turn/compaction set contextTokens). First
      // turn or a usage-less endpoint → no delta (null), no history change.
      const newContext = used > 0 ? used : state.contextTokens;
      const delta =
        used > 0 && state.contextTokens > 0 ? newContext - state.contextTokens : null;
      return {
        ...state,
        totalTokens: state.totalTokens + used,
        modelUsage: (() => {
          const id = ev.message.model;
          const prior = state.modelUsage[id] ?? { total: 0, promptNew: 0, promptCached: 0, generated: 0 };
          const usage = ev.message.usage;
          if (!usage) return state.modelUsage;
          const promptCached = Math.min(usage.input, usage.cacheRead ?? 0);
          const next = {
            total: prior.total + usage.totalTokens,
            promptNew: prior.promptNew + usage.input - promptCached,
            promptCached: prior.promptCached + promptCached,
            generated: prior.generated + usage.output,
          };
          return { ...state.modelUsage, [id]: next };
        })(),
        // The last call (prompt + completion) is a close proxy for
        // the context size the NEXT prompt starts from — the same number
        // the compaction trigger (shouldCompact) compares against the
        // window. No usage (some endpoints) → keep the previous estimate.
        contextTokens: newContext,
        contextDelta: delta,
        deltaHistory: delta === null ? state.deltaHistory : [...state.deltaHistory, delta].slice(-8),
        // docs/07 item 1: keep the last call's FULL usage (input/output +
        // cache read/write) for the `cache` field and the report; the
        // cache fields are cumulative across the session. Absent
        // `cached_tokens` (endpoints that don't report it) → 0, and the
        // display treats "no data" as unknown, not a 0% hit rate.
        lastUsage: ev.message.usage ?? state.lastUsage,
        cacheReadTotal: state.cacheReadTotal + (ev.message.usage?.cacheRead ?? 0),
        cacheWriteTotal: state.cacheWriteTotal + (ev.message.usage?.cacheWrite ?? 0),
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
    case "context_compacted": {
      // docs/07 item 2: the compaction SHRINKS the context — the delta is
      // (new − old), a large NEGATIVE number, recorded only when the event
      // carries the new estimate (ev.contextTokens) AND the old size was
      // known. It RESETS the delta history to [delta]: the pre-compaction
      // trend is not comparable to the post-compaction one.
      const delta =
        ev.contextTokens !== undefined && state.contextTokens > 0
          ? ev.contextTokens - state.contextTokens
          : null;
      return {
        ...state,
        // The context is now [summary, …kept] — the estimate the event
        // carries is what the next prompt starts from (pre-event usage
        // would overstate it). Event without the field → keep the last
        // usage-based estimate.
        contextTokens: ev.contextTokens ?? state.contextTokens,
        contextDelta: delta,
        deltaHistory: delta === null ? state.deltaHistory : [delta],
        // docs/07 item 4: how often compaction has fired + what the LAST one
        // did (so the report can show the compression, and flag a degraded
        // rule-based fallback).
        compactionCount: state.compactionCount + 1,
        lastCompaction: {
          tokensBefore: ev.tokensBefore,
          messagesKept: ev.messagesKept,
          summaryChars: ev.summaryChars,
          degraded: ev.degraded === true,
        },
        // The summary is a user message in the new context — track its size
        // separately so the context breakdown can show system / summary /
        // messages. Estimate from the summary's char count (chars/4, the
        // same estimator the loop uses).
        summaryTokens: Math.ceil(ev.summaryChars / 4),
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
    }
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
  if (s.modelPicker !== null) return s; // C38: input locked while the model picker is open
  const pos = clampCursor(s.cursorPos, s.input.length);
  const input = s.input.slice(0, pos) + ch + s.input.slice(pos);
  return { ...s, input, cursorPos: pos + ch.length, historyIdx: null };
}

export function inputBackspace(s: TuiState): TuiState {
  if (s.approval) return s;
  if (s.modelPicker !== null) return s; // C38: input locked while the model picker is open
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
  if (s.modelPicker !== null) return s; // C38: input locked while the model picker is open
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
  if (s.approval !== null || s.modelPicker !== null || s.busy) return null; // C38: picker open = enter confirms the picker, not a submit
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
      // viewTop is intentionally NOT reset: a steer is queued into the
      // running loop, and the user's scroll position (e.g. reading earlier
      // output) must survive. If they were following the bottom, viewTop
      // is already null and stays null; if they scrolled up, the window
      // stays put (the new user item lands below the viewport).
    },
    text: t,
  };
}

/**
 * C32: Enter on a slash line while a run is in flight. The line is a UI
 * command, NOT a steer — it must never be queued for the loop. Clear it
 * exactly like submitInput does (input, cursor, history) and return the
 * cleared state plus the trimmed line; the driver hands the line to
 * handleSlashCommand (and persists a /display-bottom change). null when
 * idle, while approving, or for empty/non-slash lines (those take their
 * own paths: submitInput / steerInput).
 */
export function submitSlashBusy(s: TuiState): { state: TuiState; line: string } | null {
  if (s.approval !== null || !s.busy) return null;
  const line = s.input.trim();
  if (line === "" || !line.startsWith("/")) return null;
  return {
    state: {
      ...s,
      input: "",
      cursorPos: 0,
      historyIdx: null,
      history: [...s.history, line],
    },
    line,
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
 * terminal width. MUST stay in lockstep with the `Item` rendering in
 * app.tsx (the lines it counts are itemLines in lines.ts). `prev` = the
 * item rendered immediately above (undefined = first): it decides the C31
 * leading blank line (a blank before every non-first item, and before a
 * non-user item that follows a user item) — the SAME rule lines.ts applies
 * (blankBefore), so the count and the render agree.
 */
export function itemHeight(item: TuiItem, width: number, prev?: TuiItem): number {
  // C31: the leading blank line (see blankBefore in lines.ts — mirrored
  // here so the count and the render share one rule). Hidden tools render
  // nothing, not even the separator.
  const blank =
    item.kind !== "tool" || !item.hidden
      ? prev === undefined
        ? 0
        : item.kind === "user" || prev.kind === "user"
          ? 1
          : 0
      : 0;
  switch (item.kind) {
    case "user":
      // C31: the prompt gets a ❯ icon (2 columns) and its text hangs under
      // it — wrapped at width−2 (the icon column is constant, so the wrap
      // width is constant too). Empty text still renders one line.
      return blank + (item.text ? wrapLineCount(item.text, Math.max(1, width - 2)) : 1);
    case "assistant": {
      // The streaming cursor renders as part of the text — count it (C28:
      // before, the cursor line rendered but did not count, overflowing the
      // frame by one row mid-stream).
      const text = item.text + (item.streaming ? "\u258d" : "");
      // The accumulated reasoning renders as a distinct block above the
      // reply (lines.ts): one dim header line ("◦ thinking…"), the
      // reasoning under a "│ " gutter wrapped at width−2, and a blank line
      // before the reply — count exactly what the renderer draws.
      const think =
        item.thinkingText !== ""
          ? 1 + wrapLineCount(item.thinkingText, Math.max(1, width - 2)) + 1
          : 0;
      // The renderer expands Markdown table blocks into aligned rows (and
      // retains the assistant gutter), so count those exact rendered rows.
      return blank + itemLines(item, width).length;
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
        // C31: diff lines hang under the header — wrapped at width−2 (the
        // 2-space indent applies to EVERY row, so the wrap sees width−2).
        for (const line of item.diff) {
          if (line !== "") count += wrapLineCount(line, Math.max(1, width - 2));
        }
      }
      if (item.resultText !== undefined) {
        // C31: the result hangs under the header too — the 2-space indent
        // applies to every row, so the wrap sees width−2 (the mark+space
        // prefix is the same 2 columns).
        count += wrapLineCount(item.resultText, Math.max(1, width - 2));
      }
      return blank + count;
    }
    case "compaction":
      // The item carries no `text` field; mirror the exact line app.tsx
      // renders so the height stays in lockstep with the renderer. C31: the
      // ✂ icon (2 columns) leads; the text hangs under it (width−2).
      return (
        blank +
        wrapLineCount(
          `compacted: ~${Math.round(item.tokensBefore / 100) / 10}k tokens \u2192 summary (${item.summaryChars} chars) + last ${item.messagesKept} message(s) kept`,
          Math.max(1, width - 2),
        )
      );
    case "error":
    case "info":
      // C31: a ⚠ / ℹ icon (2 columns) leads; the text hangs under it
      // (width−2). Empty text renders nothing (no icon alone).
      return blank + wrapLineCount(item.text, Math.max(1, width - 2));
  }
}

/** Sum of `itemHeight` over `items` (each item sees its predecessor). */
export function itemsHeight(items: TuiItem[], width: number): number {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += itemHeight(items[i]!, width, items[i - 1]);
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
    // C31: each item's height counts its C31 leading blank line — the SAME
    // `prev` the render side uses (its actual predecessor in `items`).
    const h = itemHeight(items[i]!, width, items[i - 1]);
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
  // Identity-cached layouts make unchanged historical items O(1) across
  // stream updates and scrolling. The WeakMap cache in lines.ts keys on the
  // immutable item identity, width, and predecessor (separator semantics).
  const lineLists = items.map((it, i) => itemLines(it, width, items[i - 1]));
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
  { name: "compact", summary: "manually compact the context now (summarize older messages)" },
  { name: "context", summary: "context breakdown: system/summary/messages + compaction trigger" },
  { name: "display-bottom", summary: "set/clear the bottom display fields" },
  { name: "exit", summary: "end the session (alias of /quit)" },
  { name: "models", summary: "pick the active model (↑/↓ + enter) / /models <id> switches" },
  { name: "usage", summary: "historical token totals by model across local sessions" },
  { name: "quit", summary: "end the session" },
  { name: "restart", summary: "restart tre. in place (same session + settings; no quit/re-invoke)" },
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
/**
 * The candidates the menu actually shows: the bare-command prefix filter
 * (slashCandidates) capped to MENU_MAX_LINES. suggestMenu, menuNav and
 * menuComplete all operate on THIS list, so the selection marker is always
 * on a visible line even when the registry grows past the cap (the overflow
 * commands are still reachable by typing them in full).
 */
function visibleCandidates(input: string): string[] {
  return slashCandidates(input).slice(0, MENU_MAX_LINES);
}

export function suggestMenu(state: TuiState, width: number): { line: string; selected: boolean }[] {
  if (state.approval !== null) return [];
  const cands = visibleCandidates(state.input);
  if (cands.length === 0) return [];
  const sel = Math.min(state.suggestIdx ?? 0, cands.length - 1);
  return cands.map((cmd, i) => {
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
  const cands = visibleCandidates(s.input);
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
  const cands = visibleCandidates(s.input);
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
export const BOTTOM_FIELDS = ["model", "status", "turn", "tokens", "context", "cache", "cwd", "session", "workers"] as const;
export type BottomField = (typeof BOTTOM_FIELDS)[number];

/** Compact token count: 0 → "0", 999 → "1k", 45234 → "45.2k", 2100000 → "2.1M". */
function fmtTokens(t: number): string {
  if (t <= 0) return "0";
  if (t >= 1_000_000) return `${Math.round(t / 100_000) / 10}M`;
  return `${Math.round(t / 100) / 10}k`;
}

/**
 * The compaction trigger threshold — the value of `contextTokens` at which
 * compact.ts's `shouldCompact` fires: `totalTokens + maxTokens + slack >
 * window`, i.e. `totalTokens > window − maxTokens − slack` (slack 1024).
 * 0 = unknown (no window). This is the SAME number the loop compares
 * against, so the bottom field reports the real trigger, not a guess.
 */
export function compactThreshold(window: number, maxTokens: number, slack = 1024): number {
  if (window <= 0) return 0;
  // Clamp to 0 when the window is smaller than the output budget + slack
  // (compaction could never make the context fit): the trigger is then
  // "always due", which the display treats the same as an unknown window.
  return Math.max(0, window - maxTokens - slack);
}

/**
 * docs/07 item 2 — render a context delta compactly: `+820` for a growth,
 * `−170k` for a shrink (U+2212 minus, matching the spec's negative form).
 * `fmtTokens` handles the magnitude; the sign is added here (fmtTokens(0) →
 * "0", so a flat turn renders `+0` — still worth showing). No leading space:
 * the `context` field joins its parts with " · ", which supplies the spacing.
 */
function fmtDelta(d: number): string {
  const mag = fmtTokens(Math.abs(d));
  return d < 0 ? `−${mag}` : `+${mag}`;
}

/**
 * docs/07 item 2 — the turns-until-compaction prediction line for the
 * `/context` report, or null when it must be omitted. The MEAN of the delta
 * history (not the last value) smooths one noisy turn. Three cases:
 *   - `headroom <= 0` → null (already at/past the trigger — the DUE line
 *     covers it; a "~N turns" prediction would be meaningless);
 *   - `avgDelta <= 0` (the context is flat or shrinking, e.g. right after a
 *     compaction) → "compaction is not approaching";
 *   - otherwise → `~N turns until compaction` where N = floor(headroom/avg).
 * No history yet (the first turn) → null (nothing to average).
 */
function compactionPrediction(state: TuiState): string | null {
  const bd = contextBreakdown(state);
  if (bd.headroom <= 0 || state.deltaHistory.length === 0) return null;
  const avg = state.deltaHistory.reduce((a, b) => a + b, 0) / state.deltaHistory.length;
  if (avg <= 0) return "compaction is not approaching";
  return `~${Math.floor(bd.headroom / avg)} turns until compaction`;
}

/**
 * Where the current context's tokens come from, plus when compaction fires.
 * The state machine holds one context number (contextTokens — the last
 * usage's total, or the post-compaction estimate) and the static system
 * prompt size, so the breakdown is a three-way split:
 *   system   — the fixed prompt floor (every turn pays it).
 *   summary  — the current compaction summary (a user message in context;
 *              0 until the first compaction).
 *   messages — the rest of the message history (prompts, replies, tool
 *              results).
 *   total    — contextTokens (system + summary + messages).
 *   threshold— the compaction trigger (compactThreshold).
 *   headroom — threshold − total (negative = compaction is due).
 */
export interface ContextBreakdown {
  system: number;
  summary: number;
  messages: number;
  total: number;
  threshold: number;
  headroom: number;
}

export function contextBreakdown(state: TuiState): ContextBreakdown {
  const total = state.contextTokens;
  const system = state.systemPromptTokens;
  const summary = state.summaryTokens;
  const messages = Math.max(0, total - system - summary);
  const threshold = compactThreshold(state.contextWindow, state.maxTokens);
  return { system, summary, messages, total, threshold, headroom: threshold - total };
}

/**
 * The multi-line report `/context` appends as an info item: the used/window
 * total, the system / summary / messages split (where the tokens come
 * from), and the compaction trigger with its headroom. "—" marks an unknown
 * window; the no-usage case reports the window alone (nothing to break down
 * yet).
 */
export function contextReport(state: TuiState): string {
  const bd = contextBreakdown(state);
  const win = state.contextWindow > 0 ? fmtTokens(state.contextWindow) : "—";
  if (bd.total <= 0) {
    return win === "—" ? "context: — (no usage yet)" : `context: ${win} window (no usage yet)`;
  }
  const pct = state.contextWindow > 0 ? ` (${Math.round((bd.total / state.contextWindow) * 100)}%)` : "";
  const lines = [
    `context: ${fmtTokens(bd.total)}/${win}${pct}`,
    `  system prompt: ${fmtTokens(bd.system)} (fixed floor)`,
  ];
  if (bd.summary > 0) lines.push(`  summary: ${fmtTokens(bd.summary)}`);
  lines.push(`  messages: ${fmtTokens(bd.messages)}`);
  // docs/07 item 1: the last call's in/out split + how much of the input
  // came from the endpoint's prompt cache, and the session-cumulative
  // cache traffic. Omitted entirely when the endpoint reports no cache
  // data (no misleading zeros).
  const u = state.lastUsage;
  if (u) {
    const cached =
      u.cacheRead !== undefined && u.cacheRead > 0 ? ` (cached ${fmtTokens(u.cacheRead)})` : "";
    lines.push(`  last call: in ${fmtTokens(u.input)}${cached} / out ${fmtTokens(u.output)}`);
  }
  if (state.cacheReadTotal > 0 || state.cacheWriteTotal > 0) {
    const w = state.cacheWriteTotal > 0 ? ` · write ${fmtTokens(state.cacheWriteTotal)}` : "";
    lines.push(`  session cache: read ${fmtTokens(state.cacheReadTotal)}${w}`);
  }
  if (bd.threshold > 0) {
    lines.push(
      bd.headroom > 0
        ? `  compaction: at ${fmtTokens(bd.threshold)} — ${fmtTokens(bd.headroom)} headroom left`
        : `  compaction: DUE — over the trigger by ${fmtTokens(-bd.headroom)}`,
    );
  }
  // docs/07 item 4: how often compaction has fired this session and what the
  // LAST one did (tokensBefore → summary size + msgs kept). The summary size
  // is the same chars/4 estimate the breakdown's `summary` line uses. A
  // (degraded) suffix marks a rule-based fallback (no LLM summary).
  if (state.compactionCount > 0 && state.lastCompaction !== null) {
    const lc = state.lastCompaction;
    const summaryTok = fmtTokens(Math.ceil(lc.summaryChars / 4));
    const degraded = lc.degraded ? " (degraded)" : "";
    lines.push(
      `  compactions: ${state.compactionCount} · last: ${fmtTokens(lc.tokensBefore)} → ${summaryTok} summary + ${lc.messagesKept} msgs kept${degraded}`,
    );
  }
  // docs/07 item 2: how fast the context is filling (the last turn's delta +
  // the mean of the recent history) and how many turns until compaction.
  // Omitted on the first turn (no delta yet).
  if (state.contextDelta !== null) {
    const avg =
      state.deltaHistory.reduce((a, b) => a + b, 0) / state.deltaHistory.length;
    lines.push(
      `  growth: ${fmtDelta(state.contextDelta)} last turn · ${fmtDelta(avg)} avg (${state.deltaHistory.length} turn${state.deltaHistory.length === 1 ? "" : "s"})`,
    );
    const pred = compactionPrediction(state);
    if (pred !== null) lines.push(`  ${pred}`);
  }
  return lines.join("\n");
}

/**
 * The urgency color for the `context` bottom field, by how close the context
 * is to the compaction trigger (not the raw window — compaction fires at the
 * threshold, which is window − output − slack, so "close to the window" is
 * the wrong scale). Unknown (no window or no usage yet) → undefined (dim).
 */
export function contextUrgencyColor(state: TuiState): string | undefined {
  const bd = contextBreakdown(state);
  if (bd.threshold <= 0 || bd.total <= 0) return undefined;
  const ratio = bd.total / bd.threshold;
  if (ratio >= 0.9) return "red";
  if (ratio >= 0.7) return "yellow";
  return "green";
}

/** The value shown for one field ("—" when a static label is absent). */
export function bottomValue(state: TuiState, field: BottomField): string {
  switch (field) {
    case "model":
      return state.modelLabel;
    case "status":
      return state.busy ? "working…" : "idle";
    case "turn":
      return String(state.turn);
    case "tokens":
      return state.totalTokens > 0 ? `${state.totalTokens} total` : "—";
    case "context": {
      // Window from the model config; used = the last call's usage
      // (prompt+completion ≈ next prompt size — the compaction trigger's
      // own number) or, right after a compaction, the estimate of the new
      // [summary, …kept] context. Beyond used/window it shows WHERE the
      // tokens come from (system prompt / summary / messages) and WHEN
      // compaction fires (the trigger `@T`; "DUE" when already over it).
      // The headroom number lives in the multi-line `/context` report — the
      // one-liner stays short enough to fit a bottom line. "—" marks an
      // unknown side.
      const win = state.contextWindow > 0 ? fmtTokens(state.contextWindow) : "—";
      if (state.contextTokens <= 0) return `${win === "—" ? "—" : `${win} window (no usage yet)`}`;
      const bd = contextBreakdown(state);
      const pct = state.contextWindow > 0 ? ` (${Math.round((bd.total / state.contextWindow) * 100)}%)` : "";
      const parts = [
        `${fmtTokens(bd.total)}/${win}${pct}`,
        `sys ${fmtTokens(bd.system)}`,
        ...(bd.summary > 0 ? [`sum ${fmtTokens(bd.summary)}`] : []),
        `msgs ${fmtTokens(bd.messages)}`,
      ];
      if (bd.threshold > 0) {
        parts.push(bd.headroom > 0 ? `@${fmtTokens(bd.threshold)}` : "DUE");
      }
      // docs/07 item 4: how many times compaction has fired (×1 is already
      // notable) — omitted until the first compaction.
      if (state.compactionCount > 0) parts.push(`×${state.compactionCount}`);
      // docs/07 item 2: how much the context changed on the last turn
      // (`+820` / ` −170k`) — omitted on the first turn (no prior size).
      if (state.contextDelta !== null) parts.push(fmtDelta(state.contextDelta));
      return parts.join(" · ");
    }
    case "cache": {
      // docs/07 item 1: the last call's prompt-cache hit rate — how much of
      // the input the endpoint served from cache. `—` when the endpoint
      // never reports cached_tokens (absence of the field is NOT a 0% hit
      // rate — the two must not be confused).
      const u = state.lastUsage;
      if (!u || u.cacheRead === undefined || u.input <= 0) return "—";
      const pct = Math.min(100, Math.round((u.cacheRead / u.input) * 100));
      return `cached ${fmtTokens(u.cacheRead)}/${fmtTokens(u.input)} (${pct}%)`;
    }
    case "cwd":
      return state.info.cwd ?? "—";
    case "session":
      return state.info.session ?? "—";
    case "workers":
      // Endpoint visibility: the live worker set (state.workers, filled by
      // the driver's poller). Compact one-liner: `<count>: <model> t<turn>
      // <activity>` per worker, joined with " · "; done/failed workers get a
      // ✓/✗ mark so a finished endpoint stays visible until it is pruned.
      // More than 3 workers → the first 3 + a `+N` suffix (this is ONE
      // bottom line; bottomLines truncates it to the terminal width).
      return workersBottomValue(state.workers);
  }
}

/**
 * One worker's segment string: `<model> t<turn>` + optional ` <activity>` +
 * optional done/failed mark. Shared by `workersBottomValue` (the plain
 * one-liner) and `workersBottomSpans` (the per-worker colored spans) so the
 * two can never drift. An empty activity (before a worker's first tool) is
 * omitted — no dangling space in the segment.
 */
function workerSegment(w: WorkerStatus): string {
  const mark = w.status === "done" ? " ✓" : w.status === "failed" ? " ✗" : "";
  const act = w.activity !== "" ? ` ${w.activity}` : "";
  return `${w.model} t${w.turn}${act}${mark}`;
}

/**
 * The `workers` field's one-liner, split out of bottomValue's switch to
 * keep the case readable (same pure contract: state in, string out).
 * See the `workers` case for the format.
 */
function workersBottomValue(workers: WorkerStatus[]): string {
  if (workers.length === 0) return "none";
  const shown = workers.slice(0, 3).map(workerSegment);
  const extra = workers.length - 3;
  const base = shown.join(" · ");
  // The overflow suffix is a count, not a worker — it is appended with a
  // plain space (not the " · " worker separator) so it reads as a summary
  // tail: `a t0 · b t0 · c t0 +1`.
  return extra > 0 ? `${workers.length}: ${base} +${extra}` : `${workers.length}: ${base}`;
}

/**
 * One segment of the `workers` bottom line: the plain text (byte-identical to
 * `workerSegment`) plus the per-worker color. `running` → "green" (the active
 * endpoint for the current workstream); `done`/`failed` → "gray" (a model that
 * already ran — its name + turn count stay visible, dimmed).
 */
export interface WorkerSpan {
  text: string;
  color: "green" | "gray";
}

/**
 * The per-worker segments of the `workers` bottom line, in display order
 * (same order as `workersBottomValue`: oldest-start first, first 3 shown,
 * overflow collapsed into the `+N` suffix). Pure: `state.workers` in, spans
 * out. The renderer (app.tsx) draws a dim `workers: ` prefix, these spans
 * joined by a dim " · ", and a dim ` +N` suffix when `extra > 0`.
 */
export function workersBottomSpans(
  workers: WorkerStatus[],
): { spans: WorkerSpan[]; extra: number; count: number } {
  const count = workers.length;
  const spans = workers.slice(0, 3).map(
    (w): WorkerSpan => ({
      text: workerSegment(w),
      color: w.status === "running" ? "green" : "gray",
    }),
  );
  const extra = Math.max(0, count - 3);
  return { spans, extra, count };
}

/**
 * The `workers` reserved line as an ANSI string, exactly ONE row: a dim
 * `workers: ` prefix + dim `<count>: ` (the same count the plain one-liner
 * carries), the per-worker spans from `workersBottomSpans` (running → green,
 * done/failed → gray — a model that already ran keeps its name + turn count
 * visible, dimmed), joined by a dim " · ", and a dim ` +N` overflow suffix.
 * The SGR codes match Ink's palette (green = \x1b[32m,
 * gray = \x1b[90m, dim = \x1b[2m — chalk's named colors), so the line renders
 * identically to the JSX the rest of the chrome uses. The whole line is
 * truncated to one row at `width` (cli-truncate is ANSI-aware — SGR codes
 * survive, so the frame stays exactly `rows` tall).
 */
export function workersLineAnsi(state: TuiState, width: number): string {
  const { spans, extra, count } = workersBottomSpans(state.workers);
  const dim = (s: string): string => `\u001b[2m${s}\u001b[0m`;
  // No workers → the plain "workers: none" (dim), matching the old one-liner.
  if (count === 0) return cliTruncate(dim("workers: none"), Math.max(1, width), { position: "end" });
  // The dim `workers: ` prefix + dim `<count>: ` (the same count the plain
  // one-liner carries) + the per-worker spans (green/gray) + dim ` +N`.
  const parts: string[] = [dim("workers: "), dim(`${count}: `)];
  spans.forEach((s, i) => {
    if (i > 0) parts.push(dim(" · "));
    parts.push(s.color === "green" ? `\u001b[32m${s.text}\u001b[0m` : `\u001b[90m${s.text}\u001b[0m`);
  });
  if (extra > 0) parts.push(dim(` +${extra}`));
  return cliTruncate(parts.join(""), Math.max(1, width), { position: "end" });
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
 * The tint for the `workers` bottom field, by how many workers are RUNNING
 * (endpoint visibility): any running → "green" (endpoints are actively
 * working), workers present but none running (all done/failed) → "yellow"
 * (the fan-out has settled — worth a look), none at all → undefined (dim —
 * the field shows "none", which is not news).
 */
export function workersUrgencyColor(state: TuiState): string | undefined {
  const w = state.workers;
  if (w.length === 0) return undefined;
  return w.some((x) => x.status === "running") ? "green" : "yellow";
}

/**
 * The colors for the RESERVED_BOTTOM_LINES, aligned one-for-one with
 * `bottomLines(state, width)`: the `context` field is tinted by compaction
 * urgency (green → yellow → red as the context nears the trigger; undefined
 * = dim when unknown), the `workers` field by how many workers are running
 * (green/yellow/undefined — see workersUrgencyColor), every other field is
 * undefined (the renderer dims it). It mirrors bottomLines' iteration
 * EXACTLY (same skip of unknown keys, same RESERVED_BOTTOM_LINES cap, same
 * padding) so line i's color pairs with line i's text — including when an
 * unknown key would shift indices.
 */
export function bottomLineColors(state: TuiState): (string | undefined)[] {
  const colors: (string | undefined)[] = [];
  for (const key of state.bottom) {
    if (colors.length >= RESERVED_BOTTOM_LINES) break;
    if (!(BOTTOM_FIELDS as readonly string[]).includes(key)) continue;
    if (key === "context") colors.push(contextUrgencyColor(state));
    else if (key === "workers") colors.push(workersUrgencyColor(state));
    else colors.push(undefined);
  }
  while (colors.length < RESERVED_BOTTOM_LINES) colors.push(undefined);
  return colors;
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
 * C34 — the multi-line report `/models` (no arg) appends as an info item:
 * one line per model in the catalog, the ACTIVE one marked with `*`. Each
 * line shows id + provider + window (so a switch's effect on the context
 * field is visible before it happens). An empty catalog reports the bare
 * "no models" note (the driver seeds the catalog, so this only happens if
 * it supplied none).
 */
export function modelsListReport(state: TuiState): string {
  if (state.models.length === 0) return "models: (no catalog supplied)";
  const lines = state.models.map((m) => {
    const active = m.id === state.modelLabel ? "* " : "  ";
    return `${active}${m.id}  [${m.provider}]  window ${fmtTokens(m.contextWindow)}`;
  });
  return `models (${state.models.length}) — * = active:\n` + lines.join("\n");
}

/**
 * C34 — the pure model switch: find `modelId` in the catalog and return the
 * state with the active model's identity + context field re-seeded (the
 * driver re-resolves the FULL ModelConfig by id and rebuilds the stream —
 * the state machine only updates what it renders). Returns null when the id
 * is unknown (the caller reports it) — so a typo can never silently switch.
 * The context estimate (contextTokens) is left as-is: the next turn's usage
 * will re-measure it against the new window.
 */
export function applyModelSwitch(state: TuiState, modelId: string): TuiState | null {
  const m = state.models.find((x) => x.id === modelId);
  if (m === undefined) return null;
  return {
    ...state,
    modelLabel: m.id,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  };
}

// ── C38 — the interactive model picker ─────────────────────────────────────
// Bare `/models` opens a modal list of the catalog (the active model's row
// highlighted); ↑/↓ move the highlight, enter switches to the highlighted
// model, esc closes without switching. The state machine only carries the
// highlight (modelPicker); the SWITCH itself is applyModelSwitch (the driver
// re-resolves the full ModelConfig by id, as for the typed `/models <id>`).
// The picker is an input lock like a pending approval: while open, typing,
// history and submit are inert (the keybinding table in app.tsx routes
// arrows/enter/esc here instead).

/** The row the picker opens on: the ACTIVE model's index (null when the
 * catalog is empty or the active model is not in it — e.g. a catalog that
 * was replaced after startup). */
export function modelPickerInitialIndex(state: TuiState): number | null {
  const i = state.models.findIndex((m) => m.id === state.modelLabel);
  return i >= 0 ? i : null;
}

/** Open the picker (bare `/models`). No catalog → the closed state,
 * unchanged (the caller reports "no catalog supplied"). */
export function modelPickerOpen(state: TuiState): TuiState {
  const idx = modelPickerInitialIndex(state);
  if (idx === null) return state;
  return { ...state, modelPicker: idx };
}

/**
 * ↑/↓ while the picker is open: move the highlight (wrap-around, like the
 * D16 completion menu). Null when the picker is closed — the caller falls
 * through to history navigation.
 */
export function modelPickerNav(s: TuiState, dir: -1 | 1): TuiState | null {
  if (s.modelPicker === null || s.models.length === 0) return null;
  const cur = Math.min(s.modelPicker, s.models.length - 1);
  return { ...s, modelPicker: (cur + dir + s.models.length) % s.models.length };
}

/**
 * Enter while the picker is open: switch to the highlighted model (the
 * switch is applyModelSwitch — label + context field re-seeded; the driver
 * re-resolves the full ModelConfig by id, exactly as for a typed
 * `/models <id>`), then close the picker. Null when the picker is closed —
 * the caller runs the normal submit path.
 */
export function modelPickerConfirm(s: TuiState): TuiState | null {
  if (s.modelPicker === null || s.models.length === 0) return null;
  const cur = Math.min(s.modelPicker, s.models.length - 1);
  const m = s.models[cur]!;
  const next = applyModelSwitch(s, m.id);
  if (next === null) return { ...s, modelPicker: null }; // defensive: can't happen
  return { ...next, modelPicker: null };
}

/** Esc while the picker is open: close it, no switch. Null when closed. */
export function modelPickerClose(s: TuiState): TuiState | null {
  if (s.modelPicker === null) return null;
  return { ...s, modelPicker: null };
}

/**
 * The picker lines the frame renders above the top separator ("" → no
 * picker). One row per model: `> id  [provider]  window Nk` (highlighted)
 * or two leading spaces (not) — the same line shape modelsListReport uses
 * for its info item, so the modal and the list read identically. Hidden
 * while an approval is pending (the input is locked then anyway).
 */
export function modelPickerMenu(state: TuiState, width: number): { line: string; selected: boolean }[] {
  if (state.modelPicker === null || state.approval !== null) return [];
  const sel = Math.min(state.modelPicker, state.models.length - 1);
  return state.models.map((m, i) => {
    const full = `${i === sel ? "> " : "  "}${m.id}  [${m.provider}]  window ${fmtTokens(m.contextWindow)}`;
    return { line: cliTruncate(full, Math.max(1, width), { position: "end" }), selected: i === sel };
  });
}

/**
 * A plain info item (dim in the output area). Returns the `info` VARIANT
 * (a `TuiItem`) so callers can read `startup` directly (undefined here).
 */
export const infoItem = (text: string): { kind: "info"; text: string; startup?: boolean } => ({
  kind: "info",
  text,
});

/**
 * A startup info item — the startup behavior block. Carries `startup: true`
 * so `itemLines` (lines.ts) colors it (cyan "Behavior:" header, green
 * labels) instead of the all-dim plain-info rendering. Returns the `info`
 * VARIANT (a `TuiItem`) so callers can read `startup` directly.
 */
export const startupInfoItem = (text: string): { kind: "info"; text: string; startup?: boolean } => ({
  kind: "info",
  text,
  startup: true,
});

/**
 * Handle a submitted `/…` line. Commands:
 *   /context                   multi-line info item: the context breakdown
 *                              (system prompt / summary / messages) and the
 *                              compaction trigger + headroom
 *   /display-bottom            report current selection + the field menu
 *   /display-bottom off|none   clear the bottom lines
 *   /display-bottom f1 f2 …    set the fields (deduped, order preserved)
 *   /models                    C38: opens the interactive model picker
 *                              (modelPicker: the catalog as a modal, the
 *                              active model's row highlighted; ↑/↓ move,
 *                              enter switches, esc closes). No catalog →
 *                              the "no models" note as an info item.
 *   /models <id>               switch the active model (re-seeds modelLabel +
 *                              the context field; the driver re-resolves the
 *                              full ModelConfig by id — see applyModelSwitch)
 *   /stats                     one info line: turns, tokens, tool calls,
 *                              session file (path + size in bytes)
 * Feedback lands as an `info` item in the output area. `/quit` and `/exit`
 * are NOT handled here — the driver owns them (it must unmount). `/restart`
 * IS handled here (it appends the "relaunching" feedback info item); the
 * re-exec itself is performed by the driver. Returns `handled: false` for
 * every other line. `sessionBytes` is the session
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
  if (line.trim() === "/context") {
    return { state: withInfo(s, contextReport(s)), handled: true };
  }
  if (line.trim() === "/usage") {
    const rows = Object.entries(s.modelUsage).sort(([a], [b]) => a.localeCompare(b));
    const report = rows.length === 0
      ? "usage: no reported token usage in local sessions"
      : "usage — all local sessions by model (total prompts / new prompt / cached prompt / generated):\n" + rows.map(([id, u]) => `  ${id}: ${fmtTokens(u.promptNew + u.promptCached)} / ${fmtTokens(u.promptNew)} / ${fmtTokens(u.promptCached)} / ${fmtTokens(u.generated)}`).join("\n");
    return { state: withInfo(s, report), handled: true };
  }
  const mm = /^\/models(?:\s+(.*))?$/.exec(line.trim());
  if (mm !== null) {
    const arg = (mm[1] ?? "").trim();
    if (arg === "") {
      // C38: bare /models opens the interactive picker (↑/↓ + enter/esc)
      // instead of a static list. No catalog → the old note (the driver
      // seeds the catalog, so this only happens if it supplied none).
      if (s.models.length === 0) {
        return { state: withInfo(s, modelsListReport(s)), handled: true };
      }
      return { state: modelPickerOpen(s), handled: true };
    }
    const next = applyModelSwitch(s, arg);
    if (next === null) {
      const known = s.models.map((m) => m.id).join(", ") || "(none)";
      return { state: withInfo(s, `models: unknown model '${arg}' — known: ${known}`), handled: true };
    }
    return { state: withInfo(next, `models: switched to ${arg} (window ${fmtTokens(next.contextWindow)})`), handled: true };
  }
  if (line.trim() === "/restart") {
    return { state: withInfo(s, "restart: relaunching tre. — the session resumes in the new process"), handled: true };
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
