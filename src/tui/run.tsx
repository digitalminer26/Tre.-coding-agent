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
 */
import React from "react";
import { statSync } from "node:fs";
import { render } from "ink";
import { App } from "./app.js";
import { startPerfEntrySweep } from "./perf-sweep.js";
import {
  approvalAnswer,
  applyEvent,
  handleSlashCommand,
  inputBackspace,
  inputChar,
  inputHistory,
  inputMove,
  makeInitialState,
  menuComplete,
  menuNav,
  noteError,
  pushUser,
  scrollBy,
  scrollToBottom,
  scrollToTop,
  setApproval,
  steerInput,
  submitInput,
  type TuiState,
} from "./state.js";
import { makeInteractiveAsk, runTurn, type PrintSinks } from "../cli/main.js";
import type { SteeringQueue } from "../loop/agent-loop.js";
import type { AskApproval } from "../tools/safety.js";
import type {
  AgentMessage,
  ExecuteToolCall,
  ModelConfig,
  StreamFn,
  Tool,
} from "../types.js";
import type { Session } from "../session/session.js";

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
  deps?: {
    /** Injected approver (tests): bypasses the TUI's y/n prompt. */
    askApproval?: AskApproval;
  };
}

export async function runTui(opts: TuiRunOptions): Promise<number> {
  // D15: static labels for the /display-bottom fields (cwd, session).
  const info: Record<string, string> = { cwd: opts.cwd ?? process.cwd() };
  if (opts.sessionPath !== undefined) info.session = opts.sessionPath;
  let state: TuiState = makeInitialState(opts.model.id, info);
  let context: AgentMessage[] = opts.context;
  let exitCode = 0;
  let controller = new AbortController();
  let mounted = true;
  let app: ReturnType<typeof render>;
  // Steering: guidance typed while a run is in flight. The loop drains it
  // before each LLM call; runPrompt replaces it with a fresh queue per run,
  // so leftovers from an aborted run are discarded (never delivered later).
  let steerQueue: SteeringQueue = { push: () => {}, drain: () => [] };

  // ── state + render ───────────────────────────────────────────────────────
  const setState = (s: TuiState): void => {
    state = s;
    // Late events (e.g. the aborted agent_end after a /quit-abort) arrive
    // after unmount — never rerender a dead instance.
    if (mounted) app.rerender(React.createElement(App, { state, ...handlers }));
  };
  const quit = (code: number): void => {
    exitCode = code;
    mounted = false;
    app.unmount();
  };

  const runPrompt = async (prompt: string): Promise<void> => {
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
        model: opts.model,
        systemPrompt: opts.systemPrompt,
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
        steeringQueue: steerQueue,
        tap: (ev) => setState(applyEvent(state, ev)),
      });
      context = result.context;
    } catch (err) {
      // I3: runTurn does not throw for expected failures — this is a net.
      setState(noteError({ ...state, busy: false }, `run error: ${String(err)}`));
    }
  };

  const handlers = {
    onChar: (ch: string): void => setState(inputChar(state, ch)),
    onBackspace: (): void => setState(inputBackspace(state)),
    onMove: (dir: -1 | 1): void => setState(inputMove(state, dir)),
    onHistory: (dir: -1 | 1): void => {
      // D16: arrows steer the completion menu when it is visible, else the
      // prompt history.
      const nav = menuNav(state, dir);
      if (nav !== null) {
        setState(nav);
        return;
      }
      setState(inputHistory(state, dir));
    },
    onSubmit: (): void => {
      // D16: enter first completes the selected menu candidate (one more
      // enter submits the completed word).
      const completed = menuComplete(state);
      if (completed !== null) {
        setState(completed);
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
        // Steering (TUI): a non-empty, non-slash line typed while busy is
        // guidance for the running loop — echo it as a user item and queue
        // it for the loop's next drain. /quit above already won; slash
        // commands and empty lines fall through (swallowed, as before).
        if (state.busy && trimmed !== "" && !trimmed.startsWith("/")) {
          const s = steerInput(state, trimmed);
          if (s !== null) {
            steerQueue.push(s.text);
            setState(s.state);
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
      // D15: slash commands are UI commands, not runs — dispatch through the
      // pure handler, then clear the busy flag submitInput raised. The
      // driver measures the session file (I/O) for /stats.
      const slash = handleSlashCommand(r.state, prompt, sessionSizeBytes(opts.sessionPath));
      if (slash.handled) {
        setState({ ...slash.state, busy: false });
        return;
      }
      if (prompt.startsWith("/")) {
        setState(noteError({ ...r.state, busy: false }, `unknown command: ${prompt}`));
        return;
      }
      setState(pushUser(r.state, prompt));
      void runPrompt(prompt);
    },
    onCtrlC: (): void => {
      if (state.busy) controller.abort();
      else quit(130);
    },
    onApproval: (ok: boolean): void => setState(approvalAnswer(state, ok)),
    onQuit: (): void => quit(0),
    // C28: output scrollback — pure state transitions (see state.ts).
    onScrollBy: (delta: number, maxScroll: number): void =>
      setState(scrollBy(state, delta, maxScroll)),
    onScrollToTop: (): void => setState(scrollToTop(state)),
    onScrollToBottom: (): void => setState(scrollToBottom(state)),
  };

  // C27: terminal mouse-wheel forwarding (SGR mode 1006) so wheel events
  // reach the input parser. The DRIVER owns the terminal: enable once here
  // (never inside a component — a raw write would corrupt the frame
  // stream). Opt out with TRE_NO_MOUSE=1 (keeps terminal text selection).
  let mouseMode = false;
  if (!process.env.TRE_NO_MOUSE) {
    process.stdout.write("\u001b[?1006h");
    mouseMode = true;
  }
  const restoreMouseMode = (): void => {
    if (mouseMode) {
      mouseMode = false;
      process.stdout.write("\u001b[?1006l");
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

  // ── approval + executor ──────────────────────────────────────────────────
  const ask: AskApproval =
    opts.deps?.askApproval ??
    ((q: string) =>
      new Promise<boolean>((resolve) => {
        setState(setApproval(state, q, resolve));
      }));
  const executor = opts.buildExecutor(makeInteractiveAsk(ask, NULL_SINKS.err));

  // ── lifecycle ────────────────────────────────────────────────────────────
  const onSigint = (): void => {
    // Fallback for non-raw-mode stdin; in raw mode Ink delivers ctrl+c as
    // a key event (handlers.onCtrlC) instead of a process signal.
    if (state.busy) controller.abort();
    else {
      restoreMouseMode(); // process.exit skips the finally below
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);
  try {
    await app.waitUntilExit();
  } finally {
    restoreMouseMode();
    stopPerfSweep();
    process.off("SIGINT", onSigint);
  }
  return exitCode;
}
