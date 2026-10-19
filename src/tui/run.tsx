/**
 * WS10 — TUI driver (D11). Owns the Ink instance, the `TuiState`, and the
 * agent lifecycle: each submitted prompt becomes one `runTurn` (the SAME
 * function the plain CLI uses — session persistence, compaction, safety
 * hooks all behave identically); every `AgentEvent` is tapped into the
 * pure state machine and the Ink app re-renders. The TUI's sinks are
 * no-ops: it renders from the event stream, it does not print it.
 *
 * Keybindings (table in app.tsx): enter=send · ↑/↓=prompt history ·
 * ctrl+c=abort the run (busy) / exit 130 (idle) · y/n/esc=approval answer.
 * D16: while the input is a bare "/" command word, ↑/↓ navigate the
 * grey completion menu (menuNav) and enter completes the selected word
 * (menuComplete) before the normal submit path runs.
 * `/quit` (or `/exit`) ends the session with code 0.
 * D15: `/display-bottom [field …]` configures the reserved bottom lines
 * (pure handler in state.ts: handleSlashCommand); the driver dispatches it
 * before the unknown-command error, and passes static labels (cwd, session)
 * into the state via makeInitialState. Bare `/display-bottom` opens the
 * interactive field picker (the bottomFields modal — the model picker's
 * sibling: ↑/↓ move, space toggles, enter applies, esc discards); the
 * driver keeps an open-time baseline so esc restores and enter persists
 * only a real change.
 * C32: the bottom selection is PERSISTED — loaded from ~/.tre/tui.json at
 * startup (tui-config.ts) and saved back after every /display-bottom
 * change, so the layout survives between tre. sessions — and slash
 * commands are handled WHILE A RUN IS IN FLIGHT too (busy submits with a
 * "/" prefix go through the same handler: the line is cleared, the
 * feedback lands as an info item, and the run continues untouched).
 */
import React from "react";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { render } from "ink";
import { App } from "./app.js";
import { priceCachePath, resolveModelPrices } from "./model-prices.js";
import { restartCommand } from "./restart.js";
import { mcpStatusLine, type McpServerHandle } from "../mcp/registry.js";
import { startPerfEntrySweep } from "./perf-sweep.js";
import { isHighFrequencyStreamEvent, makeInputHandlers, makeRenderCoalescer, makeStateUpdateRouter } from "./render-coalesce.js";
import { loadTuiConfig, resolveBottomFields, saveTuiConfig, tuiConfigPath } from "./tui-config.js";
import { makeElapsedTicker } from "./elapsed-ticker.js";
import {
  approvalAnswer,
  applyEvent,
  bottomFieldsClose,
  bottomFieldsConfirm,
  bottomFieldsNav,
  bottomFieldsToggle,
  handleSlashCommand,
  inputBackspace,
  inputChar,
  inputHistory,
  inputMove,
  makeInitialState,
  menuComplete,
  menuNav,
  modelPickerClose,
  modelPickerConfirm,
  modelPickerNav,
  noteError,
  pushUser,
  scrollBy,
  scrollToBottom,
  scrollToTop,
  setApproval,
  startupInfoItem,
  steerInput,
  submitInput,
  submitSlashBusy,
  subtasksBusyArmed,
  subtasksPollTick,
  type TuiItem,
  type TuiState,
} from "./state.js";
import { type ClipboardAdapter } from "./clipboard.js";
import { makeCopySelection } from "./copy.js";
import { makeResizeHandler } from "./resize.js";
import { makeMouseGate } from "./mouse-gate.js";
import { mouseTrackingEnabled } from "./mouse.js";
import { compactNow, makeInteractiveAsk, runTurn, type PrintSinks } from "../cli/main.js";
import { ActiveWork } from "./active-work.js";
import { estimatePromptOverheadTokens } from "../context/compact.js";
import { pruneWorkerDir, readWorkerStatuses } from "../cli/workers.js";
import { canonicalSessionPath, readSubtasks, subtaskDir, subtaskKey } from "../tools/subtask.js";
import { resolveModel, type ModelsFile } from "../config/models.js";
import { makeTelegramBridge, TELEGRAM_POLL_MS } from "./telegram.js";
import type { SteeringQueue } from "../loop/agent-loop.js";
import type { AskApproval } from "../tools/safety.js";
import type {
  AgentMessage,
  ExecuteToolCall,
  ModelConfig,
  StreamFn,
  SubtaskInfo,
  TextBlock,
  Tool,
  WorkerStatus,
} from "../types.js";
import { aggregateSessionUsage, type ModelTokenTotals, type Session } from "../session/session.js";
import type { ModelOption } from "./state.js";

const NULL_SINKS: PrintSinks = {
  out: { write: () => true },
  err: { write: () => true },
};

/**
 * The session file's size in bytes for /stats — the DRIVER does the I/O
 * (state.ts stays pure). undefined when no session path is configured or
 * the file is missing/unreadable (the line then shows "?" for the size).
 */
function sessionSizeBytes(sessionPath: string | undefined): number | undefined {
  if (sessionPath === undefined) return undefined;
  try {
    return statSync(sessionPath).size;
  } catch {
    return undefined;
  }
}

/**
 * WS12 (scope §7) — the driver side of `/mcp`. Renders one line per MCP
 * server handle (mcpStatusLine: `ready (N tools) | starting | failed
 * (<reason>) | disabled`) and joins them with newlines. Returns undefined
 * when no servers were configured this launch (the handler then reports
 * "no servers configured"). state.ts stays pure — it receives this string.
 */
function mcpStatusText(handles: McpServerHandle[] | undefined): string | undefined {
  if (!handles || handles.length === 0) return undefined;
  return handles.map((h) => mcpStatusLine(h)).join("\n");
}

/**
 * C34 — the driver side of a `/models <id>` switch. The pure
 * `applyModelSwitch` (state.ts) already re-seeded modelLabel + the context
 * field in the returned state; this re-resolves the FULL ModelConfig by id
 * (baseUrl, apiKey, compat — the state machine never sees them). Returns the
 * new ModelConfig, or null when the id is not in the catalog (the pure
 * handler already reported it as unknown — the driver just does not switch).
 */
function resolveSwitchedModel(modelsFile: ModelsFile | undefined, modelId: string): ModelConfig | null {
  if (modelsFile === undefined) return null;
  try {
    return resolveModel(modelsFile, modelId);
  } catch {
    return null;
  }
}

/**
 * D25 (deferred item) — the TUI poller's busy-branch steer decision,
 * extracted as a PURE helper so it is unit-testable (the `telegramTick`
 * closure itself is not exported and cannot be driven from a test without a
 * full TUI render). Given the polled messages and the steer queue, build the
 * `[telegram from <sender>] <text>` prompts, push them to the queue, and
 * return the prompts (the caller appends them to the visible items + the
 * info line). No state mutation, no I/O.
 */
export function steerTelegramBatch(
  msgs: [string, string, string][],
  push: (prompt: string) => void,
): string[] {
  return msgs.map(([, sender, text]) => {
    const prompt = `[telegram from ${sender}] ${text}`;
    push(prompt);
    return prompt;
  });
}

/**
 * D25 — the TUI poller's BUSY-branch decision, extracted as a PURE helper so
 * the busy-vs-idle wiring is unit-testable (the `telegramTick` closure itself
 * is not exported and cannot be driven from a test without a full TUI render).
 * Given the current state, the polled batch, and the ACTIVE steering queue:
 * steer every message into the queue and return the NEW state (the prompts as
 * visible user items + the "steered" info line, in one atomic update). Returns
 * null for an empty batch (a no-op — no steer, no items, no info line). No I/O.
 */
export function steerTelegramBusy(
  state: TuiState,
  msgs: [string, string, string][],
  steerQueue: SteeringQueue,
): TuiState | null {
  if (msgs.length === 0) return null;
  const prompts = steerTelegramBatch(msgs, (p) => steerQueue.push(p));
  return {
    ...state,
    items: [
      ...state.items,
      ...prompts.map((text): TuiItem => ({ kind: "user", text })),
      { kind: "info", text: `telegram: ${msgs.length} message(s) steered into the running turn` },
    ],
  };
}

/**
 * /restart — the UNCONFIRMED-teardown abort transition, extracted as a PURE
 * helper so the decision is unit-testable (the `restartTui` closure is not
 * exported and cannot be driven from a test without a full TUI render).
 *
 * When `teardownMcp()` REJECTS, a process group survived the SIGKILL bound.
 * Spawning a replacement would run it for the whole child run alongside the
 * old (still-alive) MCP servers, and the process-exit backstop only fires
 * when the PARENT exits (after the child). So the restart is ABORTED: this
 * returns the NEW state with an `error` item telling the user (the servers
 * will be killed when this process exits; quit and re-run). The caller then
 * returns WITHOUT spawning. No I/O, no mutation of the input state.
 */
export function restartTeardownAborted(
  state: TuiState,
  err: unknown,
): TuiState {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    ...state,
    items: [
      ...state.items,
      {
        kind: "error",
        text: `restart aborted: MCP teardown did not confirm every server exited — ${msg} (the servers will be killed when this process exits; quit and re-run tre.)`,
      },
    ],
  };
}

/**
 * /restart — the ACTIVE-TURN drain, extracted as a PURE helper so the
 * decision is unit-testable (the `restartTui` closure is not exported).
 *
 * A busy /restart aborts the run (a signal, not completion). Before tearing
 * down MCP + spawning the replacement, the aborted run's async
 * tool-result/session/event work must settle (it persists the final
 * result/abort state). This races the turn's promise against a bound so a
 * run that ignores the abort cannot block the restart forever. Returns
 * `true` when the turn settled within the bound (safe to proceed), `false`
 * when it did not (the caller must NOT spawn a replacement against a
 * still-live turn). No I/O, no mutation.
 */
export async function drainTurnBounded(
  turn: Promise<unknown> | null,
  timeoutMs: number,
): Promise<boolean> {
  if (turn === null) return true; // no active turn — nothing to drain
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), timeoutMs);
  });
  const settled = turn.then(
    () => true as const,
    () => true as const, // a settled (rejected) turn is still SETTLED
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    // Clear the bound on EVERY path: a turn that settled first must not leave
    // a referenced timer keeping the process alive for the full timeoutMs.
    clearTimeout(timer);
  }
}

/** The ordering decision for a /restart, as data (see runRestartSequence). */
export type RestartOutcome =
  | { kind: "drain-timeout" }
  | { kind: "teardown-failed"; error: unknown }
  | { kind: "unmounted" }
  | { kind: "spawned" };

export interface RestartSequenceSteps {
  /** The active turn at the moment of the restart (null = idle). */
  activeTurn: () => Promise<unknown> | null;
  drainTimeoutMs: number;
  abortTurn: () => void;
  teardown?: () => Promise<void>;
  isMounted: () => boolean;
  spawn: () => void;
}

/**
 * The /restart ORDERING, extracted so it is testable without Ink: drain the
 * active turn (bounded) → tear down MCP (must confirm) → spawn the
 * replacement. Each later step runs ONLY if the earlier one succeeded:
 *  - drain timeout  → abort again, NO teardown, NO spawn;
 *  - teardown throws → NO spawn (old servers may still be alive);
 *  - unmounted during teardown → NO spawn (the process is exiting).
 * The caller maps the outcome to UI state and flags.
 */
export async function runRestartSequence(
  steps: RestartSequenceSteps,
): Promise<RestartOutcome> {
  // ONE overall deadline across every operation that becomes active during the
  // drain. A settled operation may be replaced by a newer one (a run or a
  // compaction started in the gap): the restart must drain that too, never
  // tear down under it. Ends only when nothing is active, or on the deadline.
  const deadline = Date.now() + steps.drainTimeoutMs;
  for (;;) {
    const drain = steps.activeTurn();
    if (drain === null) break;
    // Signal the active work FIRST: the abort is what lets an abort-aware run
    // or compaction settle. Waiting for the drain bound before aborting would
    // stall every cancellable operation for the full timeout.
    try {
      steps.abortTurn();
    } catch {
      /* already aborted */
    }
    const settled = await drainTurnBounded(drain, Math.max(0, deadline - Date.now()));
    // A still-unsettled operation that is STILL the active one is stuck.
    if (!settled && steps.activeTurn() === drain) {
      return { kind: "drain-timeout" };
    }
    // Settled. Loop again ONLY if a DIFFERENT operation took the slot in the
    // gap (a replacement); the same already-settled promise means nothing new
    // is active. If a replacement is still live past the deadline, give up.
    const next = steps.activeTurn();
    if (next === null || next === drain) break;
    if (Date.now() >= deadline) return { kind: "drain-timeout" };
  }
  if (steps.teardown) {
    try {
      await steps.teardown();
    } catch (error) {
      return { kind: "teardown-failed", error };
    }
  }
  if (!steps.isMounted()) return { kind: "unmounted" };
  steps.spawn();
  return { kind: "spawned" };
}

export interface TuiRunOptions {
  model: ModelConfig;
  systemPrompt: string;
  tools: Tool[];
  streamFn: StreamFn;
  session?: Session;
  /** Pre-turn context (resume replays into this). */
  context: AgentMessage[];
  /** Message → session entry id (resume-seeded; runTurn fills new ones). */
  entryIds: Map<AgentMessage, string>;
  /** C24: undefined = derive the runaway-loop cap from the model.
   *  C26: per-cycle budget (the loop auto-continues on exhaustion). */
  maxTurns?: number;
  /** C26: undefined = default continuation count; 0 = legacy hard stop. */
  maxContinuations?: number;
  /** Builds the safety-wired tool executor for the given approver. */
  buildExecutor: (ask: AskApproval) => ExecuteToolCall;
  noCompact?: boolean;
  compactKeepTokens?: number;
  /** D15: static labels for the `/display-bottom` fields. */
  cwd?: string;
  sessionPath?: string;
  /** Historical model totals loaded from all local session logs. */
  historicalModelUsage?: ModelTokenTotals;
  /**
   * The startup behavior-settings summary (approval mode, sandbox, what is
   * blocked, the optional flags). Seeded as a single multi-line INFO item so
   * the user sees the current behavior before the first prompt. Absent → no
   * startup item (the TUI behaves exactly as before).
   */
  startupInfo?: string;
  /**
   * C34: the parsed models.json catalog — feeds `/models` (list + switch).
   * The driver keeps the full ModelConfigs; on a switch it re-resolves by id
   * (resolveModel) and rebuilds the stream + system prompt. Absent → the
   * TUI's catalog is empty and `/models` reports "no catalog supplied".
   */
  modelsFile?: ModelsFile;
  /**
   * C34: rebuild the system prompt for a given model id (the prompt embeds
   * the model name). The driver calls it after a `/models <id>` switch so
   * the next run's prompt matches the active model. Absent → the prompt is
   * left as-is on a switch (the wire still uses the new model; only the
   * prompt's "# Model" line would be stale).
   */
  rebuildSystemPrompt?: (modelId: string) => string;
  /**
   * docs/07 §7 F2: the STARTUP prompt's variable-section char counts
   * (project-context files = `ctx`, skills index = `skills`) — the driver
   * measures them once at build time (systemPromptSectionChars). Converted
   * to tokens (chars/4, the same estimate as `systemPromptTokens`) and
   * seeded into the state; the `sys` number in the context field splits
   * into `sys N (ctx X · skills Y)`. Same lifecycle as systemPromptTokens:
   * seeded once, NOT updated on a /models switch. Absent → 0/0 (the split
   * is omitted — the old `sys N` rendering).
   */
  systemPromptSections?: { ctx: number; skills: number };
  deps?: {
    /** Injected approver (tests): bypasses the TUI's y/n prompt. */
    askApproval?: AskApproval;
    /** Injected clipboard adapter (tests): the `/copy` path writes through
     * this instead of the platform helper (pbcopy/xclip). Absent → the
     * default adapter (see clipboard.ts). */
    clipboardAdapter?: ClipboardAdapter;
  };
  /** The argv to re-exec for /restart (main.ts passes the FULL
   *  process.argv — restartCommand strips argv[0], the node binary);
   *  absent → /restart reports it is unavailable. */
  restartArgs?: string[];
  /**
   * The `subtasks` field's settle window in ms (the expiry poller — the
   * workers field's WORKER_STALE_MS analog). Defaults to 90_000. Injectable
   * so tests can drive the settle-to-"none" transition without waiting.
   */
  subtasksStaleMs?: number;
  /** The home directory used by the CLI's subtask tool (test injection). */
  home?: string;
  /**
   * WS12 (scope §7): the MCP server handles for the `/mcp` status command.
   * The driver renders one line per handle (mcpStatusLine) and feeds the
   * joined string into handleSlashCommand as the `mcpStatus` arg. Absent →
   * no servers were configured this launch → `/mcp` reports "no servers
   * configured".
   */
  mcpStatus?: McpServerHandle[];
  /**
   * WS12: graceful MCP teardown for `/restart` (main.ts provides it).
   * Awaited BEFORE the replacement TUI is spawned, so THIS process's MCP
   * servers are reaped before the new one starts. The process-exit backstop
   * alone cannot provide this ordering: under `spawnSync` the old process
   * (and its detached MCP servers) stays alive for the whole child run and is
   * only reaped when the parent finally exits.
   */
  teardownMcp?: () => Promise<void>;
  /** Notify main when the interactive driver acquires/releases SIGINT. */
  onSigintOwnership?: (owned: boolean) => void;
}

export async function runTui(opts: TuiRunOptions): Promise<number> {
  // D15: static labels for the /display-bottom fields (cwd, session).
  const info: Record<string, string> = { cwd: opts.cwd ?? process.cwd() };
  if (opts.sessionPath !== undefined) info.session = opts.sessionPath;
  // The model's window + output cap seed the `context` bottom field
  // (used/window/% — the compaction trigger's own numbers).
  // C32: the bottom selection is restored from the persisted TUI config
  // (~/.tre/tui.json) — a missing/corrupt file silently yields the default
  // (empty selection), so a first launch behaves exactly as before.
  const tuiConfig = loadTuiConfig();
  // The `subtasks` field is ON by default (like `workers` — a live
  // workstream indicator the user did not explicitly turn off). The seed
  // decision lives in resolveBottomFields (tui-config.ts, pure + unit-
  // tested): it seeds `["subtasks"]` only on a TRUE first launch (no config
  // file), honors an explicit `bottomSet` decision verbatim (including an
  // explicit off), and — critically — honors a PRE-UPGRADE config (file
  // present, no marker) verbatim so the upgrade never clobbers the user's
  // saved layout.
  const bottomFields = resolveBottomFields(tuiConfig, existsSync(tuiConfigPath()));
  // The marker's live value — flipped to true on the first /display-bottom
  // (any selection, including off) and persisted with the selection.
  let tuiConfigBottomSet = tuiConfig.bottomSet;
  // The bottomFields picker's open-time baseline (the selection it opened
  // with): captured when the picker transitions null→open, used by the
  // esc-close to restore (discarding the live space-toggles) and by the
  // enter-confirm to decide whether the applied selection changed (persist
  // only on a real change). null when the picker is closed.
  let bottomPickerBaseline: string[] | null = null;
  // The system prompt is the fixed floor of every turn's context — estimate
  // its size (chars/4, the loop's estimator) so the `context` field can show
  // where the tokens come from (system prompt vs the message history).
  const systemPromptTokens = Math.ceil((opts.systemPrompt ?? "").length / 4);
  // docs/07 §7 F2: the prompt's VARIABLE sections (project-context files,
  // skills index) — char counts measured once at build time by the driver,
  // converted to tokens with the SAME chars/4 estimate as systemPromptTokens
  // so the split's parts live on the same scale as the `sys` total. Seeded
  // once, like systemPromptTokens (NOT re-measured on a /models switch).
  const systemPromptSectionTokens = {
    ctx: Math.ceil((opts.systemPromptSections?.ctx ?? 0) / 4),
    skills: Math.ceil((opts.systemPromptSections?.skills ?? 0) / 4),
  };
  // C34: the ACTIVE model + system prompt are MUTABLE — `/models <id>`
  // re-resolves the full ModelConfig by id and rebuilds the prompt, so the
  // next run uses the new model. `opts.model`/`opts.systemPrompt` are the
  // startup values; `model`/`systemPrompt` are the live ones runPrompt reads.
  let model: ModelConfig = opts.model;
  let systemPrompt: string = opts.systemPrompt;
  // The light catalog the TUI renders (/models list) — id + the fields the
  // context field uses. The full ModelConfigs stay in opts.modelsFile.
  const catalog: ModelOption[] = (opts.modelsFile?.models ?? []).map((m) => ({
    id: m.id,
    provider: m.provider,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    compactionReserve: m.compactionReserve,
  }));
  let state: TuiState = makeInitialState(
    model.id,
    info,
    model.contextWindow,
    model.maxTokens,
    bottomFields,
    systemPromptTokens,
    catalog,
    systemPromptSectionTokens,
    // Preserve `undefined` (unset → TUI defaults to DEFAULT_COMPACTION_RESERVE);
    // a legitimate 0 must NOT be mapped to "unset" here.
    model.compactionReserve,
  );
  state = { ...state, modelUsage: opts.historicalModelUsage ?? {} };
  // OpenRouter pricing for the /models picker + list (model-prices.ts):
  // resolved in the BACKGROUND — a fresh TTL cache (24h) is served without a
  // network round-trip, otherwise one GET refreshes the cache file (so the
  // cache "updates every time tre. runs"). Fail-open: on any failure the
  // last fresh cache (or nothing) is used, so the picker renders exactly as
  // before. The resolved map lands in state.modelPrices via setStateNow
  // (a no-op repaint when the map is empty — e.g. no OpenRouter catalog).
  const pricesAbort = new AbortController();
  void resolveModelPrices({ file: priceCachePath(opts.home ?? homedir()), signal: pricesAbort.signal })
    .then((prices) => {
      if (pricesAbort.signal.aborted || !mounted) return;
      setStateNow({ ...state, modelPrices: prices });
    })
    .catch(() => undefined); // fail-open: prices are decoration, never a blocker
  // The startup behavior-settings summary — a single multi-line INFO item
  // (the ℹ gutter + dim text, wrapped at width−2) so the user sees the
  // current approval/sandbox behavior and the optional flags before the
  // first prompt. It scrolls away with the rest of the history.
  if (opts.startupInfo !== undefined && opts.startupInfo !== "") {
    state = { ...state, items: [startupInfoItem(opts.startupInfo)] };
  }
  let context: AgentMessage[] = opts.context;
  // A1: session-lifetime calibrated chars-per-token (runTurn refines it
  // from each assistant usage; carried across turns like `context`).
  let cpt = 4;
  let exitCode = 0;
  let controller = new AbortController();
  // F4: timestamp of the last SIGINT/ctrl+c while busy — a second interrupt
  // within SIGINT_GRACE_MS force-exits (a hung run that ignores the abort
  // would otherwise trap the user). Reset when a run settles (runPrompt).
  let lastInt = 0;
  const SIGINT_GRACE_MS = 2000;
  let mounted = true;
  let app: ReturnType<typeof render>;
  // Steering: guidance typed while a run is in flight. The loop drains it
  // before each LLM call; runPrompt replaces it with a fresh queue per run,
  // so leftovers from an aborted run are discarded (never delivered later).
  let steerQueue: SteeringQueue = { push: () => {}, drain: () => [] };

  // ── Telegram (15s poller) ────────────────────────────────────────────────
  // While the TUI is open, poll the bot every 15s. A poll is a non-blocking
  // HTTPS GET to the Telegram Bot API (the LLM endpoint is NOT involved);
  // the LLM is only spent when a real message arrives and a turn runs to
  // answer it. Incoming messages become prompts (idle → new run, busy →
  // steer into the running loop); the run's final text is replied via the
  // bot. The poller is inert until setup is done (~/.tre/telegram.json).
  const telegram = makeTelegramBridge(opts.cwd ?? process.cwd(), homedir());
  let telegramTimer: NodeJS.Timeout | undefined;
  // A poll that outlives the 15s cadence (slow Telegram, a 429 sleep) must
  // not overlap the next tick — overlapping polls can both read the same
  // offset file and double-consume updates. The tick self-reschedules
  // (setTimeout, not setInterval) and skips if the previous one is in flight.
  let telegramTickInFlight = false;
  // Routed through setState (not a bare `state =`) so the Ink app re-renders —
  // a bare mutation would update the state var but never repaint the frame.
  // setState is declared below but initialized before any of these are CALLED.
  const telegramInfo = (text: string): void => {
    setStateNow({ ...state, items: [...state.items, { kind: "info", text }] });
  };
  // Extract the final assistant text from a run's context (the reply that
  // goes back to the bot). Empty when the run produced no text (e.g. it
  // ended on a tool call or an error) — the caller then sends a fallback.
  const finalAssistantText = (ctx: AgentMessage[]): string => {
    for (let i = ctx.length - 1; i >= 0; i--) {
      const m = ctx[i]!;
      if (m.role !== "assistant") continue;
      const text = m.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (text !== "") return text;
    }
    return "";
  };
  const telegramTick = async (): Promise<void> => {
    // A previous poll is still in flight (it outlived the 15s cadence) —
    // skip; the in-flight tick reschedules the next one when it finishes.
    if (telegramTickInFlight) return;
    telegramTickInFlight = true;
    try {
      // D25: do NOT skip the tick while a run is in flight — the poll runs
      // either way, and the post-await busy re-check below decides: busy →
      // steer the batch into the running loop; idle → start a new run.
      let msgs: [string, string, string][] | null;
      try {
        msgs = await telegram.poll();
      } catch (err) {
        telegramInfo(`telegram poll error: ${String(err)}`);
        return; // retry on the next tick
      }
      if (msgs === null) return;
      // M6: the poll was in flight when stopTelegram() ran — a stop happened
      // during the await; do not act on these messages (no steer/run/reply).
      if (telegramStopped) return;
      // A /restart is in flight (the MCP teardown await is live, before
      // spawnSync freezes the loop). Do NOT steer into the (already-aborted)
      // run or start a fresh one against MCP servers that are closing — the
      // poll's await can land in that window. The messages are dropped (the
      // user is mid-restart); a re-send after the restart is the recovery.
      if (restartInFlight || restartFailed) return;
      // Re-check after the await: a run may be in flight either because it
      // was already running when the tick fired (D25: the tick no longer
      // early-returns on busy, so mid-turn messages are picked up here) or
      // because a user prompt started one while the poll was in flight.
      if (state.busy) {
        // Steer every message into the ACTIVE running loop (the queue that
        // runPrompt installed — it is drained before the next LLM call). No
        // reply is sent here: the running run's final text answers the user's
        // prompt. Empty batch → null (a no-op: no steer, no items, no info
        // line). One atomic state update (prompts + info line together).
        const next = steerTelegramBusy(state, msgs, steerQueue);
        if (next === null) return;
        setStateNow(next);
        return;
      }
      // Idle — fold the whole batch into ONE prompt (a single run answers all
      // of them, and one reply goes back to the bot). Folding avoids the
      // stale-queue trap: runPrompt installs a FRESH steering queue, so extra
      // messages pushed before the run would be lost. Set busy NOW (the
      // runPrompt→agent_start gap is async — the session append happens before
      // the first event, and busy is only flipped by agent_start) so a
      // concurrent user submit can't start a second runTurn on the same
      // context — exactly why submitInput sets busy eagerly. Follow the
      // bottom, as a fresh run does.
      // M6: a stop during the poll must not start a new run after quit/unmount.
      if (telegramStopped) return;
      const prompt = msgs.map(([, sender, text]) => `[telegram from ${sender}] ${text}`).join("\n");
      setStateNow({ ...state, busy: true, viewTop: null, items: [...state.items, { kind: "user", text: prompt }] });
      void (async () => {
        try {
          // runPrompt returns the run's resulting context, or null when the
          // run errored (the net case) — never read the shared `context` var
          // here, which would hold the PREVIOUS run's text on error.
          const resultCtx = await runPrompt(prompt);
          if (resultCtx === null) {
            telegramInfo("telegram: run errored — no reply sent");
            return;
          }
          const reply = finalAssistantText(resultCtx);
          // M6: the run settled after a stop — never send a reply post-quit.
          if (telegramStopped) return;
          await telegram.send(
            reply !== "" ? reply : "I received your message but produced no reply this turn.",
          );
          telegramInfo("telegram: replied via the bot");
        } catch (err) {
          telegramInfo(`telegram reply error: ${String(err)}`);
        }
      })();
    } finally {
      telegramTickInFlight = false;
    }
  };

  // ── state + render ───────────────────────────────────────────────────────
  //
  // Only high-frequency stream taps use coalesced paints. Interactive and
  // lifecycle updates bypass the window so their feedback is immediate.
  const coalescer = makeRenderCoalescer({
    paint: () => {
      if (mounted) app.rerender(React.createElement(App, { state, mouseEnabled, ...handlers }));
    },
  });
  const stateUpdates = makeStateUpdateRouter<TuiState>({
    getState: () => state,
    setState: (s) => { state = s; },
    schedule: () => { if (mounted) coalescer.schedule(); },
    paintNow: () => { if (mounted) coalescer.paintNow(); },
  });
  const setState = stateUpdates.stream;
  const setStateNow = stateUpdates.interactive;
  const resizeHandler = makeResizeHandler({
    stream: process.stdout,
    getState: () => state,
    setStateNow,
  });
  resizeHandler.attach();
  const mouseGate = makeMouseGate({ getState: () => state, setStateNow });
  const quit = (code: number): void => {
    resizeHandler.detach();
    exitCode = code;
    mounted = false;
    coalescer.cancel(); // a pending deferred paint must not fire post-unmount
    pricesAbort.abort(); // a quit mid-pricing-fetch must not outlive the app
    app.unmount();
  };

  /**
   * /restart — re-exec the same argv as a child that inherits the TTY,
   * BLOCKING until that child exits (spawnSync, no `detached`). The child
   * resumes the session file automatically (append-only log; resume =
   * replay) — nothing is re-sent.
   *
   * Why blocking + no detached (the earlier `detached:true` + `unref` +
   * immediate-exit version was broken): `detached` calls setsid(), so the
   * child becomes the leader of a NEW session — a grandchild of the shell
   * that is NOT the terminal's foreground process group. The moment the
   * parent exited, the shell (the tty's session leader) reclaimed the
   * terminal as its own foreground group, and the child could no longer read
   * keyboard input (SIGTTIN): the TUI came up but looked dead. By keeping
   * the parent ALIVE while the child runs (spawnSync blocks), the child stays
   * in the parent's process group — the tty's foreground group — for its
   * whole lifetime, and the shell never reclaims the tty. When the child
   * exits, the parent unmounts + exits with the child's status, and the shell
   * shows its prompt — indistinguishable from the user having typed `tre.`
   * again. The parent's Ink app stays mounted during the block, but its event
   * loop is frozen (spawnSync), so it neither re-renders nor steals input.
   */
  // Re-entry guard for /restart: set SYNCHRONOUSLY (before the first await)
  // so a second /restart during the teardown window is ignored — the event
  // loop is still live during the teardown await (before spawnSync freezes
  // it), so input can race it.
  let restartInFlight = false;
  // Set when the MCP teardown could NOT confirm every server exited. The
  // restart is aborted, but the app stays alive: /quit must still work and
  // /restart may retry the teardown. New runs are refused (they would start
  // against servers whose state is unknown). Cleared only by a successful
  // teardown.
  let restartFailed = false;
  const restartTui = async (): Promise<void> => {
    const spec = restartCommand(opts.restartArgs ?? [], process.env);
    if (spec === null) {
      setStateNow({ ...state, items: [...state.items, { kind: "info", text: "restart: no relaunch argv available — quit and run tre. again" }] });
      return;
    }
    if (restartInFlight) return; // a restart is already in flight (teardown or spawnSync)
    restartInFlight = true;
    // (A prior failed teardown is retried here — restartFailed is cleared
    // only when the retry actually confirms the servers are gone.)
    // DRAIN the active turn BEFORE tearing down MCP: the busy /restart path
    // aborted the run (a signal, not completion) — the aborted run still has
    // async tool-result/session/event work to finish (persisting its final
    // result/abort state). If we tore down + spawned the replacement before
    // that settled, spawnSync would freeze the parent mid-flight and the
    // replacement would replay the session before the parent recorded its
    // tail (the cycle-2 finding). Bounded: a run that ignores the abort must
    // not block the restart forever (the force-exit Ctrl+C is the escape).
    // Ordering (drain → teardown → spawn) lives in runRestartSequence so it
    // is unit-tested; this closure maps each outcome to UI state and flags.
    const outcome = await runRestartSequence({
      activeTurn: () => activeWork.current()?.promise ?? null,
      drainTimeoutMs: 5000,
      abortTurn: () => (activeWork.current()?.abort ?? controller).abort(),
      teardown: opts.teardownMcp,
      isMounted: () => mounted,
      spawn: () => {
        // The child (the new tre.) owns the terminal and handles its own
        // SIGINT, so drop the parent's handler for the duration.
        process.off("SIGINT", onSigint);
        const result = spawnSync(spec.execPath, spec.args, {
          stdio: "inherit",
          env: spec.env,
        });
        quit(result.error ? 1 : (result.status ?? 0));
      },
    });
    if (outcome.kind === "drain-timeout") {
      restartInFlight = false;
      setStateNow({
        ...state,
        items: [
          ...state.items,
          { kind: "error", text: "restart aborted: the running turn did not settle within 5s after abort — press Ctrl+C twice to force-exit" },
        ],
      });
      return;
    }
    if (outcome.kind === "teardown-failed") {
      // UNCONFIRMED termination: a process group survived the SIGKILL bound.
      // No replacement; the exit backstop reaps stragglers when this exits.
      restartInFlight = false;
      restartFailed = true;
      setStateNow(restartTeardownAborted(state, outcome.error));
      return;
    }
    restartFailed = false;
    if (outcome.kind === "unmounted") {
      // Quit during the teardown window: the process is already exiting.
      return;
    }
    // outcome.kind === "spawned": spawn() already quit() with the child's status.
  };

  const runPromptCore = async (prompt: string): Promise<AgentMessage[] | null> => {
    controller = new AbortController();
    // One steering queue per run — a closure over a plain array (the
    // contract is push/drain; the loop drains, onSubmit pushes).
    const steerState: { q: string[] } = { q: [] };
    steerQueue = {
      push: (t) => steerState.q.push(t),
      drain: () => {
        const out = steerState.q;
        steerState.q = [];
        return out;
      },
    };
    try {
      const result = await runTurn({
        model,
        systemPrompt,
        tools: opts.tools,
        streamFn: opts.streamFn,
        controller,
        context,
        session: opts.session,
        prompt,
        sinks: NULL_SINKS,
        maxTurns: opts.maxTurns,
        maxContinuations: opts.maxContinuations,
        executeToolCall: executor,
        entryIds: opts.entryIds,
        noCompact: opts.noCompact,
        compactKeepTokens: opts.compactKeepTokens,
        charsPerToken: cpt,
        steeringQueue: steerQueue,
        tap: (ev) => {
          // The elapsed clock follows the run's own events: armed on
          // agent_start, stopped on agent_end (see the timer above).
          if (ev.type === "agent_start") {
            onAgentStart();
            // Audit F1: reconcile the subtasks display the moment a run
            // starts — a deadline that elapsed while idle (or a list
            // first observed while this run was already busy) must not
            // stay on screen until the next 5s tick just because the
            // flag hadn't flipped yet. The tick runs on the PRE-event
            // state (busy still false → not armed), so the new run can
            // never exempt the previous workstream.
            subtasksTick();
          } else if (ev.type === "agent_end") onAgentEnd();
          (isHighFrequencyStreamEvent(ev) ? setState : setStateNow)(applyEvent(state, ev));
        },
      });
      context = result.context;
      cpt = result.charsPerToken;
      if (mounted) coalescer.paintNow(); // flush final state without fabricating an update
      lastInt = 0; // F4: run settled — reset the force-exit grace window
      return result.context;
    } catch (err) {
      // I3: runTurn does not throw for expected failures — this is a net.
      lastInt = 0; // F4: run settled (errored) — reset the grace window
      // The run died WITHOUT agent_end (a streamFn that throws before the
      // loop's first yield, or a wiring error) — the tap never stopped the
      // elapsed ticker, so stop it here or it would repaint forever (the
      // clock is cleared by the busy:false below, but the 1s timer is not).
      stopElapsedTick();
      setStateNow(noteError({ ...state, busy: false }, `run error: ${String(err)}`));
      return null;
    }
  };

  // The ACTIVE turn's completion promise (a user or telegram run). A /restart
  // while busy must DRAIN this before tearing down MCP + spawning the
  // replacement: the abort is a signal, not completion — the aborted run still
  // has async tool-result/session/event work to finish (persisting its final
  // result/abort state), and spawnSync would freeze the parent mid-flight,
  // letting the replacement replay the session before the parent recorded its
  // tail (the cycle-2 finding). The REPL drains its Telegram turn mutex the
  // same way; the TUI had no analogous barrier.
  // The ACTIVE work (a run OR a manual /compact) — see active-work.ts. /restart
  // reads it through runRestartSequence, so both are signalled and drained.
  const activeWork = new ActiveWork();
  const runPrompt = (prompt: string): Promise<AgentMessage[] | null> => {
    const p = runPromptCore(prompt);
    activeWork.track(p, controller);
    return p;
  };

  /**
   * A6 — manual `/compact` (idle only). A silent summarizer call OUTSIDE a
   * run: force:true skips the trigger, the ladder (D) and the session entry
   * are shared with auto-compaction via compactNow. Events flow through the
   * same applyEvent tap as a run (the ✂ line + context field update).
   * `context` (and the busy flag) update when the call settles.
   */
  const manualCompact = (s: TuiState): void => {
    if (opts.noCompact) {
      setStateNow({
        ...s,
        busy: false,
        items: [...s.items, { kind: "info", text: "compact: compaction disabled (--no-compact)" }],
      });
      return;
    }
    setStateNow({
      ...s,
      items: [...s.items, { kind: "info", text: "compact: summarizing older messages…" }],
    });
    const compactAbort = new AbortController();
    activeWork.track((async () => {
      try {
        const newCtx = await compactNow({
          streamFn: opts.streamFn,
          model,
          signal: compactAbort.signal,
          context,
          session: opts.session,
          ids: opts.entryIds,
          systemPrompt,
          compactKeepTokens: opts.compactKeepTokens,
          charsPerToken: cpt,
          // C2: the estimate-based trigger needs the same fixed overhead the
          // auto path passes (system prompt + tool schemas) — without it the
          // manual trigger under-counts the actual next request.
          promptOverheadTokens: estimatePromptOverheadTokens(systemPrompt.length, opts.tools, cpt),
          force: true,
          sinks: NULL_SINKS,
          onEvent: async (ev) => {
            // /compact is NOT a run: compactNow emits only compaction events
            // (context_compacted / compaction_skipped) — it never emits
            // agent_start/agent_end (those come from runLoop), so the
            // elapsed clock is untouched by a manual compact. The ✂ line and
            // context-field update flow through applyEvent like any event.
            (isHighFrequencyStreamEvent(ev) ? setState : setStateNow)(applyEvent(state, ev));
          },
        });
        if (newCtx === undefined) {
          setStateNow({
            ...state,
            busy: false,
            items: [...state.items, { kind: "info", text: "compact: nothing to compact (context too short)" }],
          });
        } else {
          context = newCtx;
          setStateNow({ ...state, busy: false });
        }
      } catch (err) {
        setStateNow(noteError({ ...state, busy: false }, `compact error: ${String(err)}`));
      }
    })(), compactAbort);
  };

  /**
   * `/copy` — copy the current mouse selection to the system clipboard.
   * The selection is read in CONTENT coordinates (copySelectionText, state.ts)
   * at the CURRENT terminal width (the rendered lines are width-dependent —
   * wrapping changes the line breaks, so the copy must use the width the
   * App renders at). The clipboard write is the driver's I/O (clipboard.ts,
   * injectable adapter); the result lands as an info item (success: the byte
   * count; failure: the reason — no helper, timeout, empty selection). The
   * selection itself is NOT cleared (the user may copy it again after a
   * scroll; Esc clears it). Never throws (I3): a clipboard failure is a
   * reported info item, not a crash.
   */
  const copySelection = makeCopySelection({
    getState: () => state,
    setStateNow,
    clipboardAdapter: opts.deps?.clipboardAdapter,
    isMounted: () => mounted,
    width: () => (process.stdout.columns > 0 ? process.stdout.columns : 80),
  });

  const inputHandlers = makeInputHandlers<TuiState>(
    () => state,
    stateUpdates,
    {
      char: (s, ch) => inputChar(s, ch),
      backspace: (s) => inputBackspace(s),
      move: (s, dir) => inputMove(s, dir),
      history: (s, dir) => {
        // D16: arrows steer the completion menu when it is visible, else the
        // prompt history.
        const nav = menuNav(s, dir);
        return nav !== null ? nav : inputHistory(s, dir);
      },
    },
  );

  const handlers = {
    ...inputHandlers,
    onSubmit: (): void => {
      // A /restart is in flight (MCP teardown window, before spawnSync
      // freezes the loop): the event loop is still live, so swallow ALL
      // input — a prompt submitted here would start a run mid-teardown (the
      // restart's controller.abort() already ran, so it would be a stray run).
      if (restartInFlight) return;
      if (restartFailed) {
        // A failed restart leaves the app alive but NOT able to run new turns
        // against servers of unknown state. /quit exits; /restart retries the
        // teardown; everything else is refused with a visible notice (never
        // swallowed silently).
        const cmd = state.input.trim();
        if (cmd === "/quit" || cmd === "/exit") {
          quit(0);
          return;
        }
        if (cmd === "/restart") {
          setStateNow({ ...state, input: "" });
          void restartTui();
          return;
        }
        setStateNow({
          ...state,
          input: "",
          items: [...state.items, { kind: "info", text: "restart failed earlier — /quit to exit, or /restart to retry the MCP teardown" }],
        });
        return;
      }
      // D16: enter first completes the selected menu candidate (one more
      // enter submits the completed word).
      const completed = menuComplete(state);
      if (completed !== null) {
        setStateNow(completed);
        return;
      }
      const r = submitInput(state);
      if (r === null) {
        // Busy (or an empty line): an explicit /quit still wins — abort the
        // running turn and exit 0. Without this, /quit is swallowed by the
        // busy guard while its characters sit in the input line, looking dead.
        // D16: trimmed — menu completion leaves "/quit " with a trailing space.
        const trimmed = state.input.trim();
        if ((trimmed === "/quit" || trimmed === "/exit") && state.busy) {
          controller.abort();
          quit(0);
        }
        // /restart while busy: abort the in-flight run (the session log
        // already holds every completed message — a torn tail is dropped
        // on replay by design), then re-exec.
        if (trimmed === "/restart" && state.busy) {
          // restartTui aborts the active work itself (via runRestartSequence),
          // so a busy compaction is signalled too — not only the run.
          // Fire-and-forget: onSubmit is sync, but restartTui awaits the MCP
          // teardown (event loop live) before spawnSync freezes it. The
          // synchronous restartInFlight guard inside restartTui prevents a
          // second /restart from racing the teardown window.
          void restartTui();
          return;
        }
        // C32: slash commands are UI commands — they are handled while a run
        // is in flight too (e.g. /display-bottom reconfigures the bottom
        // lines mid-task). submitSlashBusy clears the line (never a steer —
        // it must not be queued for the loop); the pure handler appends the
        // feedback info item and state.busy is left untouched, so the run
        // continues and the loop's next drain is unaffected. /quit above
        // already won; unhandled slash lines are swallowed (as before) and
        // non-slash lines steer.
        const slashBusy = submitSlashBusy(state);
        if (slashBusy !== null) {
          // A6: /compact is never a steer — reject it while a run is in
          // flight (the auto trigger will compact at the next turn boundary).
          if (slashBusy.line === "/compact") {
            setStateNow({
              ...slashBusy.state,
              items: [
                ...slashBusy.state.items,
                { kind: "info", text: "compact: cannot compact while a run is in flight" },
              ],
            });
            return;
          }
          // /copy while busy: the selection is on the rendered content, not
          // the running loop — it copies fine mid-run (the line was already
          // cleared by submitSlashBusy).
          if (slashBusy.line === "/copy") {
            copySelection();
            return;
          }
          const prevBottom = state.bottom;
          const slash = handleSlashCommand(slashBusy.state, slashBusy.line, sessionSizeBytes(opts.sessionPath), mcpStatusText(opts.mcpStatus));
          setStateNow(slash.handled ? slash.state : slashBusy.state);
          // The picker transitioned null→open (bare /display-bottom while
          // busy): snapshot the selection it opened with — esc restores it,
          // enter compares against it (persist only on a real change).
          if (slash.handled && slashBusy.state.bottomFields === null && slash.state.bottomFields !== null) {
            bottomPickerBaseline = slashBusy.state.bottom;
          }
          if (slash.handled && slash.state.bottom !== prevBottom) {
            // Preserve the `mouse` key — the file is the durable mouse
            // setting; /display-bottom must not clobber it. The bottomSet
            // marker flips to true on the FIRST /display-bottom (any
            // selection, including off) so an explicit off survives the
            // relaunch.
            tuiConfigBottomSet = true;
            saveTuiConfig({ bottom: slash.state.bottom, mouse: tuiConfig.mouse, bottomSet: tuiConfigBottomSet });
          }
          // C34: a /models <id> switch re-resolves the full ModelConfig (the
          // state machine only re-seeded the label + context field). The
          // running turn keeps the old model; the NEXT run uses the new one.
          if (slash.handled && slash.state.modelLabel !== slashBusy.state.modelLabel) {
            const nm = resolveSwitchedModel(opts.modelsFile, slash.state.modelLabel);
            if (nm !== null) {
              model = nm;
              if (opts.rebuildSystemPrompt !== undefined) systemPrompt = opts.rebuildSystemPrompt(nm.id);
            }
          }
          return;
        }
        // Steering (TUI): a non-empty, non-slash line typed while busy is
        // guidance for the running loop — echo it as a user item and queue
        // it for the loop's next drain. /quit above already won; slash
        // commands and empty lines fall through (swallowed, as before).
        if (state.busy && trimmed !== "" && !trimmed.startsWith("/")) {
          const s = steerInput(state, trimmed);
          if (s !== null) {
            steerQueue.push(s.text);
            setStateNow(s.state);
            return;
          }
        }
        return;
      }
      const prompt = r.prompt;
      if (prompt === "/quit" || prompt === "/exit") {
        quit(0);
        return;
      }
      if (prompt === "/restart") {
        // Fire-and-forget (onSubmit is sync): restartTui awaits the MCP
        // teardown before spawnSync; the restartInFlight guard inside prevents
        // a second /restart from racing the teardown window.
        void restartTui();
        return;
      }
      // A6: manual compaction — the driver runs the silent summarizer call
      // (side effects stay in the driver; the pure machine only carries the
      // registry entry for the completion menu).
      if (prompt === "/compact") {
        manualCompact(r.state);
        return;
      }
      // Mouse selection: /copy copies the current selection to the system
      // clipboard (driver I/O — clipboard.ts). It is a UI command like
      // /compact (handled before the generic slash dispatch, which would
      // report it as unknown). The selection survives the copy (Esc clears
      // it); only the input line is cleared (submitInput already did).
      if (prompt === "/copy") {
        copySelection();
        return;
      }
      // D15: slash commands are UI commands, not runs — dispatch through the
      // pure handler, then clear the busy flag submitInput raised. The
      // driver measures the session file (I/O) for /stats and the MCP
      // handles for /mcp.
      const prevBottom = state.bottom;
      const slash = handleSlashCommand(r.state, prompt, sessionSizeBytes(opts.sessionPath), mcpStatusText(opts.mcpStatus));
      if (slash.handled) {
        setStateNow({ ...slash.state, busy: false });
        // The picker transitioned null→open (bare /display-bottom): snapshot
        // the selection it opened with — esc restores it, enter compares
        // against it (persist only on a real change).
        if (r.state.bottomFields === null && slash.state.bottomFields !== null) {
          bottomPickerBaseline = r.state.bottom;
        }
        // C32: persist the bottom selection — /display-bottom is the only
        // handled command that changes it (the others keep the same array
        // reference, so this fires exactly on a real change). The bottomSet
        // marker flips to true on the FIRST /display-bottom (any selection,
        // including off) so an explicit off survives the relaunch.
        if (slash.state.bottom !== prevBottom) {
          // Preserve the `mouse` key — the file is the durable mouse
          // setting; /display-bottom must not clobber it.
          tuiConfigBottomSet = true;
          saveTuiConfig({ bottom: slash.state.bottom, mouse: tuiConfig.mouse, bottomSet: tuiConfigBottomSet });
        }
        // C34: a /models <id> switch re-resolves the full ModelConfig (the
        // state machine only re-seeded the label + context field); rebuild
        // the system prompt (it embeds the model name) so the next run is
        // fully consistent.
        if (slash.state.modelLabel !== r.state.modelLabel) {
          const nm = resolveSwitchedModel(opts.modelsFile, slash.state.modelLabel);
          if (nm !== null) {
            model = nm;
            if (opts.rebuildSystemPrompt !== undefined) systemPrompt = opts.rebuildSystemPrompt(nm.id);
          }
        }
        return;
      }
      if (prompt.startsWith("/")) {
        setStateNow(noteError({ ...r.state, busy: false }, `unknown command: ${prompt}`));
        return;
      }
      setStateNow(pushUser(r.state, prompt));
      void runPrompt(prompt);
    },
    onCtrlC: (): void => {
      if (state.busy) {
        // F4: first ctrl+c aborts; a second within the grace window
        // force-exits (a run that ignores the abort would otherwise trap us).
        const now = Date.now();
        if (now - lastInt < SIGINT_GRACE_MS) {
          stopTelegram();
          stopWorkersPoller();
          stopSubtasksPoller();
          stopElapsedTick();
          restoreMouseMode();
          process.exit(130);
        }
        controller.abort();
        lastInt = now;
      } else quit(130);
    },
    onApproval: (ok: boolean): void => setStateNow(approvalAnswer(state, ok)),
    onQuit: (): void => quit(0),
    // C38: the model picker — pure state transitions (nav/close); confirm
    // switches via applyModelSwitch AND re-resolves the full ModelConfig +
    // system prompt (the same driver work as a typed `/models <id>` switch).
    onModelPickerNav: (dir: -1 | 1): void => {
      const nav = modelPickerNav(state, dir);
      if (nav !== null) setStateNow(nav);
    },
    onModelPickerConfirm: (): void => {
      // Capture the OLD label BEFORE setState: setState reassigns the outer
      // `state` to the confirmed state, so comparing confirmed against
      // `state` afterwards would compare it to itself (always equal) and the
      // driver's model re-resolution would never fire — the header would
      // switch but the wire would keep the old model.
      const prevLabel = state.modelLabel;
      const confirmed = modelPickerConfirm(state);
      if (confirmed === null) return; // picker closed — nothing to do
      setStateNow(confirmed);
      if (confirmed.modelLabel !== prevLabel) {
        const nm = resolveSwitchedModel(opts.modelsFile, confirmed.modelLabel);
        if (nm !== null) {
          model = nm;
          if (opts.rebuildSystemPrompt !== undefined) systemPrompt = opts.rebuildSystemPrompt(nm.id);
        }
      }
    },
    onModelPickerClose: (): void => {
      const closed = modelPickerClose(state);
      if (closed !== null) setStateNow(closed);
    },
    // The /display-bottom field picker (bottomFields modal) — the same pure
    // state transitions as the model picker, plus the driver's bookkeeping:
    // the open-time baseline (captured on the null→open transition) is what
    // esc restores and what enter compares against to decide whether the
    // applied selection changed (persist only on a real change).
    onBottomFieldsNav: (dir: -1 | 1): void => {
      const nav = bottomFieldsNav(state, dir);
      if (nav !== null) setStateNow(nav);
    },
    onBottomFieldsToggle: (): void => {
      const toggled = bottomFieldsToggle(state);
      if (toggled !== null) setStateNow(toggled);
    },
    onBottomFieldsConfirm: (): void => {
      const confirmed = bottomFieldsConfirm(state);
      if (confirmed === null) return; // picker closed — nothing to do
      const baseline = bottomPickerBaseline;
      bottomPickerBaseline = null;
      setStateNow(confirmed);
      // Persist the applied selection when it differs from what the picker
      // opened with (the toggles edited state.bottom live — confirm only
      // closes; the change is already in confirmed.bottom).
      const changed = baseline !== null &&
        (confirmed.bottom.length !== baseline.length || confirmed.bottom.some((field, i) => field !== baseline[i]));
      if (changed) {
        tuiConfigBottomSet = true;
        saveTuiConfig({ bottom: confirmed.bottom, mouse: tuiConfig.mouse, bottomSet: tuiConfigBottomSet });
      }
    },
    onBottomFieldsClose: (): void => {
      const closed = bottomFieldsClose(state, bottomPickerBaseline ?? state.bottom);
      if (closed !== null) {
        bottomPickerBaseline = null;
        setStateNow(closed);
      }
    },
    // C28: output scrollback — pure state transitions (see state.ts).
    onScrollBy: (delta: number, maxScroll: number): void =>
      setStateNow(scrollBy(state, delta, maxScroll)),
    onScrollToTop: (): void => setStateNow(scrollToTop(state)),
    onScrollToBottom: (): void => setStateNow(scrollToBottom(state)),
    // Mouse selection (opt-in — mouse tracking enabled): pure state
    // transitions (see state.ts) gated by the drag flag (mouse-gate.ts) —
    // a motion is ignored unless a press is in flight. The App maps the
    // terminal cell to a content anchor; the clipboard is the driver's job
    // — /copy reads the selection and writes it through the injected
    // adapter (clipboard.ts).
    ...mouseGate,
  };

  // C27: terminal mouse-wheel forwarding so wheel/trackpad events reach the
  // input parser. The DRIVER owns the terminal: enable once here (never
  // inside a component — a raw write would corrupt the frame stream).
  //
  // OFF BY DEFAULT (selection-friendly): with a mouse-tracking mode active
  // the terminal forwards pointer events to the app INSTEAD of doing its
  // own highlight-and-copy, so native text selection dies. The default
  // stays off — but it is now PERSISTENTLY CONFIGURABLE: the `mouse` key of
  // ~/.tre/tui.json (the TUI's permanent home) turns it on without an env
  // var, and the env vars override the file either way for a one-off
  // launch (mouseTrackingEnabled, mouse.ts — the single source of truth;
  // the App receives the same value as a prop so routing and the modes can
  // never disagree):
  //   TRE_NO_MOUSE=1 → off (legacy opt-out, wins over everything)
  //   TRE_MOUSE=1    → on  (legacy opt-in)
  //   otherwise      → ~/.tre/tui.json "mouse" (default false)
  //
  // TWO modes, not one: 1006 is only the SGR *report format* — in
  // xterm-compatible terminals it enables NO mouse reporting on its own, so
  // a trackpad wheel is never forwarded and scrolling appears dead. 1002
  // (button-event tracking) is the base mode that actually makes the
  // terminal send events (wheel = button 64/65 press+release); 1006 then
  // shapes them as SGR `CSI < b ; x ; y M/m`, which the app parses. 1002 is
  // chosen over 1003 (any-event) so plain pointer motion is NOT reported —
  // less noise, and clicks/drags are still swallowed by the app.
  const mouseEnabled = mouseTrackingEnabled(process.env, tuiConfig.mouse);
  let mouseMode = false;
  if (mouseEnabled) {
    process.stdout.write("\u001b[?1002h\u001b[?1006h");
    mouseMode = true;
  }
  const restoreMouseMode = (): void => {
    if (mouseMode) {
      mouseMode = false;
      process.stdout.write("\u001b[?1006l\u001b[?1002l");
    }
  };
  // C28: restore the terminal on EVERY death path, not just the finally
  // above. 'exit' fires on process.exit / uncaught errors / normal exit;
  // SIGTERM/SIGHUP (service manager, terminal close) default to a bare
  // kill, so route them through process.exit to run the 'exit' handlers.
  // (SIGKILL can't run anything — nothing to be done; the pty_feed
  // watchdog's kill -9 is the only one we hit, and it tears the PTY down.)
  process.on("exit", restoreMouseMode);
  process.on("SIGTERM", () => process.exit(143));
  process.on("SIGHUP", () => process.exit(129));

  app = render(React.createElement(App, { state, mouseEnabled, ...handlers }), { exitOnCtrlC: false });

  // C25: React's DEV build fills Node's unbounded performance (User-Timing)
  // buffer with one entry per component render — the 40MB/turn heap growth
  // behind the 2GB OOM crash. Sweep it so long sessions stay flat.
  const stopPerfSweep = startPerfEntrySweep();

  // Telegram poller: start only when setup is done (a config exists). The
  // timer is unref'd so it never keeps the process alive on its own, and it
  // is cleared on every exit path below.
  let telegramStopped = false;
  const stopTelegram = (): void => {
    telegramStopped = true;
    if (telegramTimer !== undefined) {
      clearTimeout(telegramTimer);
      telegramTimer = undefined;
    }
  };
  if (telegram.enabled) {
    telegramInfo(`telegram: polling every ${TELEGRAM_POLL_MS / 1000}s (reply via bot)`);
    // Self-rescheduling setTimeout (not setInterval): the next tick is only
    // armed after the previous one settles, so a slow poll (a 429 sleep, a
    // hung network) can never overlap the next one — the in-flight guard in
    // telegramTick is the backstop for the same reason.
    const telegramArm = (): void => {
      if (telegramStopped) return; // a tick in flight at stop time must not re-arm
      telegramTimer = setTimeout(() => {
        void telegramTick().finally(telegramArm);
      }, TELEGRAM_POLL_MS);
      telegramTimer.unref?.();
    };
    telegramArm();
  }

  // ── Workers (5s poller) — endpoint visibility ───────────────────────────
  // While the TUI is open, poll the shared on-disk worker registry
  // (~/.tre/workers/, src/cli/workers.ts) every 5s. Each concurrent `tre. run`
  // process on another endpoint writes its WorkerStatus there (the WRITER
  // half of the feature); this poller reads the live set and, when it CHANGES
  // since the last tick, updates state.workers so the `workers` bottom field
  // re-renders. The read is the frozen contract (readWorkerStatuses — never
  // throws; stale entries already dropped); pruneWorkerDir opportunistically
  // deletes stale files so a crashed worker's file does not accumulate.
  //
  // Mirrors the Telegram poller's shape: a self-rescheduling, unref'd
  // setTimeout (never keeps the process alive on its own), started after the
  // Ink app is mounted, and cleared on every exit path (stopWorkersPoller in
  // the finally + the SIGINT force-exit paths). The tick body is wrapped in
  // try/catch (I3): a read/prune failure just means "no update this tick".
  const WORKERS_POLL_MS = 5000;
  let workersTimer: NodeJS.Timeout | undefined;
  let workersStopped = false;
  // The last rendered set's signature — a cheap change detector so an
  // unchanged set does not trigger a re-render (avoid churn every 5s).
  let workersSig = "";
  const stopWorkersPoller = (): void => {
    workersStopped = true;
    if (workersTimer !== undefined) {
      clearTimeout(workersTimer);
      workersTimer = undefined;
    }
  };
  const workersTick = (): void => {
    try {
      const workers: WorkerStatus[] = readWorkerStatuses();
      pruneWorkerDir(); // best-effort cleanup of stale files (I3: no-op on failure)
      const sig = JSON.stringify(workers);
      if (sig !== workersSig) {
        // The set CHANGED (a worker started/finished/updated, or one went
        // stale and dropped) — push it into state and re-render. setState
        // guards the rerender on `mounted`, so a tick racing an unmount is
        // harmless (it updates the state var but never repaints a dead app).
        workersSig = sig;
        setStateNow({ ...state, workers });
      }
    } catch {
      // I3: the poller must NEVER throw — a read/prune failure is swallowed
      // and the next tick retries.
    }
  };
  const workersArm = (): void => {
    if (workersStopped) return; // a tick in flight at stop time must not re-arm
    workersTimer = setTimeout(() => {
      workersTick();
      workersArm();
    }, WORKERS_POLL_MS);
    workersTimer.unref?.();
  };
  workersArm();

  // ── Subtask expiry tick (5s) ────────────────────────────────────────────
  // The `subtasks` field settles to "none" like the `workers` field does
  // when its entries go stale (pruneWorkerDir): once no subtask has been
  // created/marked within SUBTASK_STALE_MS, the field shows "none" until
  // the next subtask activity. The list itself is NOT cleared (the tool's
  // file keeps the full history — `list` still shows it); only the DISPLAY
  // expires. The file's `updatedAt` is refreshed by every create/mark, so
  // "quiet" is exactly "the workstream is over (or abandoned) and nobody
  // is touching it". A list with live items is exempt ONLY WHILE THE RUN
  // THAT PRODUCED THE LAST SUBTASK ACTIVITY IS IN FLIGHT (a long tool
  // call between marks must not blank the field) — the ARM-anchored
  // exemption (audit F1): busyArmed = subtasksBusyArmed(state), i.e. the
  // run's own create/mark armed it. An unrelated later run gets no
  // exemption; a live list from an abandoned workstream follows the same
  // quiet window while idle (or under an unrelated run) and settles to
  // "none" instead of pinning the field forever (audit F2).
  //
  // The poller mirrors the workers poller's shape (self-rescheduling,
  // unref'd, try/catch I3), but the tick's decision is the PURE
  // subtasksPollTick (state.ts): file-snapshot-only signature + derived-
  // flag comparison against the live state — the audit F1b self-heal
  // (an out-of-band flip of state.subtasksExpired no longer desyncs the
  // poller permanently) and the rev-model arm-ownership rule (the
  // exemption is bound to the armed activity's WRITE REVISION — exact per
  // write; a newer-rev snapshot disarms the exemption outright, and an
  // older-rev snapshot is never mirrored while the owning run is armed).
  // It only pushes
  // a new state when the file's view and the state disagree, so a quiet
  // session costs one cheap file read per 5s and no re-renders.
  // Sessionless runs (no session path — the tool then keeps the list in
  // memory only) have no file to read: the tick expires from the state's
  // own activity stamp (applyEvent mirrors `details.updatedAt` into
  // state.subtasksUpdatedAt) — audit F3.
  const SUBTASK_STALE_MS = opts.subtasksStaleMs ?? 90_000; // default = WORKER_STALE_MS
  let subtasksTimer: NodeJS.Timeout | undefined;
  let subtasksStopped = false;
  let subtasksSig: string | null = null; // null = not yet evaluated
  const stopSubtasksPoller = (): void => {
    subtasksStopped = true;
    if (subtasksTimer !== undefined) {
      clearTimeout(subtasksTimer);
      subtasksTimer = undefined;
    }
  };
  const subtasksTick = (): void => {
    try {
      // Sessionless runs (no session path) have no file — the tick decides
      // from the state's own activity stamp (audit F3); file-backed runs
      // read the snapshot and reconcile through the pure tick
      // (subtasksPollTick — the F1b self-heal lives there, unit-tested).
      let file: { items: SubtaskInfo[]; updatedAt: number; rev?: number } | null = null;
      if (opts.sessionPath !== undefined) {
        const dir = subtaskDir(opts.home ?? homedir());
        const sid = subtaskKey(canonicalSessionPath(resolve(opts.sessionPath)));
        file = readSubtasks(dir, sid); // I3: never throws (missing → empty list)
      }
      const r = subtasksPollTick({
        state: {
          subtasks: state.subtasks,
          subtasksExpired: state.subtasksExpired,
          subtasksUpdatedAt: state.subtasksUpdatedAt,
          // Audit F1: the exemption belongs to the run that produced the
          // last subtask activity — not to any run in flight.
          busyArmed: subtasksBusyArmed(state),
          // Audit F1b: …and to the SNAPSHOT that activity produced — a
          // list another process wrote (mirrored below) never inherits it.
          // In the rev model the sig is the fallback identity for a
          // legacy rev-0 arm only.
          subtasksArmedSig: state.subtasksArmedSig,
          // Rev model (audit F1c/F1-legacy/F2): the ownership identity is
          // the armed WRITE REVISION — exact per write, unlike a stamp.
          subtasksArmedRev: state.subtasksArmedRev,
          // The rev of the currently mirrored list (a pushed field the
          // self-healing comparison checks).
          subtasksRev: state.subtasksRev,
        },
        file,
        lastSig: subtasksSig,
        now: Date.now(),
        staleMs: SUBTASK_STALE_MS,
      });
      // Rev model: the snapshot on disk SUPERSEDED the armed write — a rev
      // strictly newer than the armed one (a foreign write, whatever its
      // content). An older-rev snapshot never disarms (a lagging read
      // cannot supersede; while this run is armed it is not even mirrored —
      // the tick's lagging-read skip). The exemption is over: clear the
      // arm so the deadline rules alone decide, until the run's NEXT real
      // subtask activity re-arms.
      if (r.disarm && state.subtasksArmedRun !== null) {
        setStateNow({
          ...state,
          subtasksArmedRun: null,
          subtasksArmedSig: "",
          subtasksArmedRev: 0,
        });
      }
      if (r.push) {
        subtasksSig = r.sig;
        // File changes from another process (or a list update) are mirrored
        // too; the expired flag is evaluated from the same snapshot so the
        // renderer cannot retain a stale list after the poller's first tick.
        setStateNow({
          ...state,
          subtasks: r.subtasks,
          subtasksExpired: r.subtasksExpired,
          subtasksUpdatedAt: r.subtasksUpdatedAt,
          // Mirror the snapshot's write identity with the snapshot itself.
          subtasksRev: r.rev,
        });
      }
    } catch {
      // I3: the poller must NEVER throw — a read failure is swallowed and
      // the next tick retries.
    }
  };
  const subtasksArm = (): void => {
    if (subtasksStopped) return; // a tick in flight at stop time must not re-arm
    subtasksTimer = setTimeout(() => {
      subtasksTick();
      subtasksArm();
    }, 5000);
    subtasksTimer.unref?.();
  };
  subtasksArm();

  // ── Elapsed-time tick (1s, armed only while busy) ───────────────────────
  // The header's right-most item is the RUN's elapsed time (runStartedAt →
  // now). Stream events repaint continuously while the model streams, but a
  // LONG TOOL CALL (bash can run minutes) emits no stream events — without
  // a tick the clock would freeze mid-run. So: while busy, repaint once a
  // second (a fresh state reference — the router no-ops on an identical
  // reference, and the elapsed value is computed at RENDER time in app.tsx,
  // so a fresh reference with identical data is exactly what repaints).
  //
  // The timer is ARMED, not always-running: it starts on `agent_start`
  // (the run's first event — the same event that sets runStartedAt) and
  // stops on `agent_end` (the run's last — the same event that clears
  // runStartedAt). While idle there is no pending 1s timer at all — the
  // old always-on version kept a live (unref'd) timer and a no-op repaint
  // pass alive for the whole session, and its `elapsedStopped` flag made it
  // un-armable after any exit path ran. A manual `/compact` is NOT a run
  // (compactNow emits no agent_start/agent_end — only compaction events),
  // so it leaves the clock untouched; the clock follows real runs only.
  // The arm/stop/tick contract itself is unit-tested in
  // test/elapsed-ticker.test.ts.
  const elapsedTicker = makeElapsedTicker({
    shouldPaint: () => state.busy && state.runStartedAt !== null && mounted,
    paint: () => setStateNow({ ...state }), // fresh reference → the router repaints
  });
  const stopElapsedTick = (): void => elapsedTicker.stop();
  const onAgentStart = (): void => elapsedTicker.arm();
  const onAgentEnd = (): void => elapsedTicker.stop();

  // ── approval + executor ──────────────────────────────────────────────────
  const ask: AskApproval =
    opts.deps?.askApproval ??
    ((q: string) =>
      new Promise<boolean>((resolve) => {
        setStateNow(setApproval(state, q, resolve));
      }));
  const executor = opts.buildExecutor(makeInteractiveAsk(ask, NULL_SINKS.err));

  // ── lifecycle ────────────────────────────────────────────────────────────
  const onSigint = (): void => {
    // Fallback for non-raw-mode stdin; in raw mode Ink delivers ctrl+c as
    // a key event (handlers.onCtrlC) instead of a process signal.
    if (state.busy) {
      // F4: first SIGINT aborts; a second within the grace window force-exits.
      const now = Date.now();
      if (now - lastInt < SIGINT_GRACE_MS) {
        stopTelegram();
        stopWorkersPoller();
        stopSubtasksPoller();
        stopElapsedTick();
        restoreMouseMode();
        process.exit(130);
      }
      controller.abort();
      lastInt = now;
    } else {
      stopTelegram(); // process.exit skips the finally below
      stopWorkersPoller();
      stopSubtasksPoller();
      stopElapsedTick();
      restoreMouseMode();
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);
  opts.onSigintOwnership?.(true);
  try {
    await app.waitUntilExit();
  } finally {
    stopTelegram();
    stopWorkersPoller();
    stopSubtasksPoller();
    stopElapsedTick();
    restoreMouseMode();
    stopPerfSweep();
    process.off("SIGINT", onSigint);
    opts.onSigintOwnership?.(false);
  }
  return exitCode;
}
