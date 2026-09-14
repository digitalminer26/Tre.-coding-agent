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
 * `/quit` (or `/exit`) ends the session with code 0.
 */
import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import {
  approvalAnswer,
  applyEvent,
  inputBackspace,
  inputChar,
  inputHistory,
  makeInitialState,
  noteError,
  pushUser,
  setApproval,
  submitInput,
  type TuiState,
} from "./state.js";
import { makeInteractiveAsk, runTurn, type PrintSinks } from "../cli/main.js";
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
  maxTurns: number;
  /** Builds the safety-wired tool executor for the given approver. */
  buildExecutor: (ask: AskApproval) => ExecuteToolCall;
  noCompact?: boolean;
  compactKeepTokens?: number;
  deps?: {
    /** Injected approver (tests): bypasses the TUI's y/n prompt. */
    askApproval?: AskApproval;
  };
}

export async function runTui(opts: TuiRunOptions): Promise<number> {
  let state: TuiState = makeInitialState(opts.model.id);
  let context: AgentMessage[] = opts.context;
  let exitCode = 0;
  let controller = new AbortController();
  let mounted = true;
  let app: ReturnType<typeof render>;

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
        executeToolCall: executor,
        entryIds: opts.entryIds,
        noCompact: opts.noCompact,
        compactKeepTokens: opts.compactKeepTokens,
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
    onHistory: (dir: -1 | 1): void => setState(inputHistory(state, dir)),
    onSubmit: (): void => {
      const r = submitInput(state);
      if (r === null) {
        // Busy (or an empty line): an explicit /quit still wins — abort the
        // running turn and exit 0. Without this, /quit is swallowed by the
        // busy guard while its characters sit in the input line, looking dead.
        if ((state.input === "/quit" || state.input === "/exit") && state.busy) {
          controller.abort();
          quit(0);
        }
        return;
      }
      const prompt = r.prompt;
      if (prompt === "/quit" || prompt === "/exit") {
        quit(0);
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
  };

  app = render(React.createElement(App, { state, ...handlers }), { exitOnCtrlC: false });

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
    else process.exit(130);
  };
  process.on("SIGINT", onSigint);
  try {
    await app.waitUntilExit();
  } finally {
    process.off("SIGINT", onSigint);
  }
  return exitCode;
}
