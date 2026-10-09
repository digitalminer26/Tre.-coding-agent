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
 * into the state via makeInitialState.
 * C32: the bottom selection is PERSISTED — loaded from ~/.tre/tui.json at
 * startup (tui-config.ts) and saved back after every /display-bottom
 * change, so the layout survives between tre. sessions — and slash
 * commands are handled WHILE A RUN IS IN FLIGHT too (busy submits with a
 * "/" prefix go through the same handler: the line is cleared, the
 * feedback lands as an info item, and the run continues untouched).
 */
import React from "react";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { render } from "ink";
import { App } from "./app.js";
import { restartCommand } from "./restart.js";
import { startPerfEntrySweep } from "./perf-sweep.js";
import { isHighFrequencyStreamEvent, makeInputHandlers, makeRenderCoalescer, makeStateUpdateRouter } from "./render-coalesce.js";
import { loadTuiConfig, saveTuiConfig } from "./tui-config.js";
import {
  approvalAnswer,
  applyEvent,
  copySelectionText,
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
  selectClear,
  selectStart,
  selectUpdate,
  setApproval,
  startupInfoItem,
  steerInput,
  submitInput,
  submitSlashBusy,
  type SelectionAnchor,
  type TuiState,
} from "./state.js";
import { copyToClipboard, type ClipboardAdapter } from "./clipboard.js";
import { compactNow, makeInteractiveAsk, runTurn, type PrintSinks } from "../cli/main.js";
import { estimatePromptOverheadTokens } from "../context/compact.js";
import { pruneWorkerDir, readWorkerStatuses } from "../cli/workers.js";
import { resolveModel, type ModelsFile } from "../config/models.js";
import { makeTelegramBridge, TELEGRAM_POLL_MS } from "./telegram.js";
import type { SteeringQueue } from "../loop/agent-loop.js";
import type { AskApproval } from "../tools/safety.js";
import type {
  AgentMessage,
  ExecuteToolCall,
  ModelConfig,
  StreamFn,
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
  // The system prompt is the fixed floor of every turn's context — estimate
  // its size (chars/4, the loop's estimator) so the `context` field can show
  // where the tokens come from (system prompt vs the message history).
  const systemPromptTokens = Math.ceil((opts.systemPrompt ?? "").length / 4);
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
  }));
  let state: TuiState = makeInitialState(
    model.id,
    info,
    model.contextWindow,
    model.maxTokens,
    tuiConfig.bottom,
    systemPromptTokens,
    catalog,
  );
  state = { ...state, modelUsage: opts.historicalModelUsage ?? {} };
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
      // A run is in flight (state.busy is set synchronously before a run
      // starts, so it is accurate here) — skip this tick.
      if (state.busy) return;
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
      // Re-check after the await: a user prompt may have started a run while
      // the poll was in flight.
      if (state.busy) {
        // Steer every message into the ACTIVE running loop (the queue that
        // runPrompt installed — it is drained before the next LLM call). No
        // reply is sent here: the running run's final text answers the user's
        // prompt.
        for (const [, sender, text] of msgs) {
          const prompt = `[telegram from ${sender}] ${text}`;
          setStateNow({ ...state, items: [...state.items, { kind: "user", text: prompt }] });
          steerQueue.push(prompt);
        }
        telegramInfo(`telegram: ${msgs.length} message(s) steered into the running turn`);
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
      if (mounted) app.rerender(React.createElement(App, { state, ...handlers }));
    },
  });
  let selectionDragging = false;
  const onResize = (): void => {
    if (state.selection !== null) setStateNow(selectClear(state));
  };
  const stateUpdates = makeStateUpdateRouter<TuiState>({
    getState: () => state,
    setState: (s) => { state = s; },
    schedule: () => { if (mounted) coalescer.schedule(); },
    paintNow: () => { if (mounted) coalescer.paintNow(); },
  });
  const setState = stateUpdates.stream;
  const setStateNow = stateUpdates.interactive;
  process.stdout.on("resize", onResize);
  const quit = (code: number): void => {
    process.stdout.off("resize", onResize);
    exitCode = code;
    mounted = false;
    coalescer.cancel(); // a pending deferred paint must not fire post-unmount
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
  const restartTui = (): void => {
    const spec = restartCommand(opts.restartArgs ?? [], process.env);
    if (spec === null) {
      setStateNow({ ...state, items: [...state.items, { kind: "info", text: "restart: no relaunch argv available — quit and run tre. again" }] });
      return;
    }
    // The child (the new tre.) owns the terminal and handles its own SIGINT,
    // so drop the parent's handler for the duration — otherwise a Ctrl+C
    // during the child's run would be acted on by the parent too (after
    // spawnSync returns) and clobber the child's exit code.
    process.off("SIGINT", onSigint);
    const result = spawnSync(spec.execPath, spec.args, {
      stdio: "inherit",
      env: spec.env,
    });
    // Unmount + let the main flow exit with the child's status.
    quit(result.error ? 1 : (result.status ?? 0));
  };

  const runPrompt = async (prompt: string): Promise<AgentMessage[] | null> => {
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
        tap: (ev) => (isHighFrequencyStreamEvent(ev) ? setState : setStateNow)(applyEvent(state, ev)),
      });
      context = result.context;
      cpt = result.charsPerToken;
      if (mounted) coalescer.paintNow(); // flush final state without fabricating an update
      lastInt = 0; // F4: run settled — reset the force-exit grace window
      return result.context;
    } catch (err) {
      // I3: runTurn does not throw for expected failures — this is a net.
      lastInt = 0; // F4: run settled (errored) — reset the grace window
      setStateNow(noteError({ ...state, busy: false }, `run error: ${String(err)}`));
      return null;
    }
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
    void (async () => {
      try {
        const newCtx = await compactNow({
          streamFn: opts.streamFn,
          model,
          signal: new AbortController().signal,
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
          onEvent: async (ev) => (isHighFrequencyStreamEvent(ev) ? setState : setStateNow)(applyEvent(state, ev)),
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
    })();
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
  const copySelection = (): void => {
    const width = process.stdout.columns > 0 ? process.stdout.columns : 80;
    const text = copySelectionText(state, width);
    const slashState = state.busy ? submitSlashBusy(state)?.state : submitInput(state)?.state;
    const cleared = { ...(slashState ?? state), busy: state.busy, input: "", cursorPos: 0, historyIdx: null, history: [...state.history, "/copy"] };
    setStateNow(cleared);
    if (text === "") {
      setStateNow({ ...state, ...cleared, items: [...cleared.items, { kind: "info", text: "copy: nothing selected (drag in the output area with the mouse)" }] });
      return;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    void copyToClipboard(text, opts.deps?.clipboardAdapter).then((res) => {
      if (!mounted) return; // a copy that settles after quit must not re-render
      setStateNow({
        ...state,
        input: "",
        cursorPos: 0,
        historyIdx: null,
        history: state.history.includes("/copy") ? state.history : [...state.history, "/copy"],
        busy: state.busy,
        items: [
          ...state.items,
          {
            kind: "info",
            text: res.ok
              ? `copied ${bytes} byte(s) to the clipboard`
              : `copy failed: ${res.error}`,
          },
        ],
      });
    });
  };

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
          controller.abort();
          restartTui();
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
          const slash = handleSlashCommand(slashBusy.state, slashBusy.line, sessionSizeBytes(opts.sessionPath));
          setStateNow(slash.handled ? slash.state : slashBusy.state);
          if (slash.handled && slash.state.bottom !== prevBottom) {
            saveTuiConfig({ bottom: slash.state.bottom });
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
        restartTui();
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
      // driver measures the session file (I/O) for /stats.
      const prevBottom = state.bottom;
      const slash = handleSlashCommand(r.state, prompt, sessionSizeBytes(opts.sessionPath));
      if (slash.handled) {
        setStateNow({ ...slash.state, busy: false });
        // C32: persist the bottom selection — /display-bottom is the only
        // handled command that changes it (the others keep the same array
        // reference, so this fires exactly on a real change).
        if (slash.state.bottom !== prevBottom) {
          saveTuiConfig({ bottom: slash.state.bottom });
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
    // C28: output scrollback — pure state transitions (see state.ts).
    onScrollBy: (delta: number, maxScroll: number): void =>
      setStateNow(scrollBy(state, delta, maxScroll)),
    onScrollToTop: (): void => setStateNow(scrollToTop(state)),
    onScrollToBottom: (): void => setStateNow(scrollToBottom(state)),
    // Mouse selection (opt-in, TRE_MOUSE=1): pure state transitions (see
    // state.ts). The App maps the terminal cell to a content anchor; these
    // just fold the anchor into the selection. The clipboard is the driver's
    // job — /copy (below) reads the selection and writes it through the
    // injected adapter (clipboard.ts).
    onSelectStart: (anchor: SelectionAnchor): void => {
      selectionDragging = true;
      setStateNow(selectStart(state, anchor));
    },
    onSelectUpdate: (anchor: SelectionAnchor): void => {
      if (!selectionDragging) return;
      const next = selectUpdate(state, anchor);
      if (next !== null) setStateNow(next);
    },
    onSelectEnd: (): void => { selectionDragging = false; },
    onSelectClear: (): void => setStateNow(selectClear(state)),
  };

  // C27: terminal mouse-wheel forwarding so wheel/trackpad events reach the
  // input parser. The DRIVER owns the terminal: enable once here (never
  // inside a component — a raw write would corrupt the frame stream).
  //
  // OPT-IN (TRE_MOUSE=1), not on-by-default: with a mouse-tracking mode
  // active the terminal forwards pointer events to the app INSTEAD of doing
  // its own highlight-and-copy, so text selection dies — and the TUI is a
  // read-mostly surface. PgUp/PgDn/Home/End already cover scrolling, so
  // selection is the default; set TRE_MOUSE=1 for wheel/trackpad scrolling.
  // (Legacy: TRE_NO_MOUSE=1 still forces the no-wheel mode — it can only
  // keep what is already the default.)
  //
  // TWO modes, not one: 1006 is only the SGR *report format* — in
  // xterm-compatible terminals it enables NO mouse reporting on its own, so
  // a trackpad wheel is never forwarded and scrolling appears dead. 1002
  // (button-event tracking) is the base mode that actually makes the
  // terminal send events (wheel = button 64/65 press+release); 1006 then
  // shapes them as SGR `CSI < b ; x ; y M/m`, which the app parses. 1002 is
  // chosen over 1003 (any-event) so plain pointer motion is NOT reported —
  // less noise, and clicks/drags are still swallowed by the app.
  let mouseMode = false;
  if (process.env.TRE_MOUSE && !process.env.TRE_NO_MOUSE) {
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

  app = render(React.createElement(App, { state, ...handlers }), { exitOnCtrlC: false });

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
        restoreMouseMode();
        process.exit(130);
      }
      controller.abort();
      lastInt = now;
    } else {
      stopTelegram(); // process.exit skips the finally below
      stopWorkersPoller();
      restoreMouseMode();
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);
  try {
    await app.waitUntilExit();
  } finally {
    stopTelegram();
    stopWorkersPoller();
    restoreMouseMode();
    stopPerfSweep();
    process.off("SIGINT", onSigint);
  }
  return exitCode;
}
