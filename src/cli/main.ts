#!/usr/bin/env node
/**
 * WS6 — CLI / integration seam (PLAN.md §WS6, vertical slice §4).
 *
 * First place all modules meet: models.json (WS1) + system prompt & skills
 * (WS4) + tools (WS3) + loop (WS2) + wire (WS1) + session (WS5).
 *
 * Usage:
 *   tre. run "prompt"     one-shot: run to completion, exit
 *   tre.                  interactive: the Ink TUI on a TTY, the plain REPL
 *                         when stdin is piped (--plain forces the REPL)
 *   tre. tui              interactive Ink TUI (explicit)
 *   tre. --plain          interactive plain REPL (explicit, even on a TTY)
 *
 * (Tre Coding Agent — the legacy `coding-agent` command is an alias for `tre.`)
 *
 * Options:
 *   --model <id>       model id from models.json (default: the file's "default")
 *   --models <file>    models.json path (default: nearest models.json above the
 *                      launch dir, then ~/.tre/models.json)
 *   --tools <list>     comma list of read,write,edit,bash; "all" (default) or "none"
 *   --cwd <dir>        working directory the agent operates in (default: process.cwd())
 *   --session <file>   session file: created if absent, resumed if present
 *   --resume <file>    resume an EXISTING session (error if absent)
 *   --session-auto     session file under ~/.tre/sessions/ (never inside the repo)
 *   --skills <dir>     skills dir (repeatable); defaults: <cwd>/.pi/skills then
 *                      ~/.pi/agent/skills (project skills shadow user skills by name)
 *   --max-turns <n>    per-cycle LLM-turn budget (default: derived from the
 *                      model's contextWindow/maxTokens — see deriveMaxTurns)
 *   --max-continuations <n>
 *                      C26: how many times the loop auto-continues when a
 *                      cycle's budget is exhausted (default 3 → 4 cycles).
 *                      The runaway-loop guard (3 identical batches in a row)
 *                      is always on, regardless of this value.
 *
 * Behavior:
 *   - Streaming assistant text goes to stdout as deltas; tool lines to stdout;
 *     diagnostics (error/aborted/length) to stderr.
 *   - SIGINT during a run aborts that run (the loop keeps the partial,
 *     stopReason "aborted"); a second SIGINT exits (130). In the REPL an
 *     aborted run just returns to the prompt.
 *   - Session persistence: the user message is appended BEFORE the run (a
 *     mid-run kill keeps the prompt); the run's new messages are appended
 *     after agent_end. Resume = WS5 replaySession.
 *   - I3: run failures are data (exit codes), never uncaught throws.
 */
import { homedir } from "node:os";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline";
// C23: MUST be evaluated before ink is loaded — it registers a resolve hook
// that redirects terminal-size to a fd-safe shim. ink is therefore imported
// DYNAMICALLY in the tui branch below (a static import would link the whole
// module graph — including ink — before register() runs, making the hook
// too late).
import "../tui/terminal-size-fix.js";
// C29: MUST also run before ink is linked — see the module doc for why
// (kills the DEV reconciler's per-render performance.measure at the root).
import "../tui/prod-env.js";
import { findModelsFile, loadModelsFile, resolveModel } from "../config/models.js";
import {
  compactContext,
  makeSummaryMessage,
  shouldCompact,
} from "../context/compact.js";
import { openAiStream } from "../wire/openai-completions.js";
import { runLoop, type SteeringQueue } from "../loop/agent-loop.js";
import { buildSystemPrompt } from "../prompt/system-prompt.js";
import { loadSkillsIndex } from "../prompt/skills.js";
import { DEFAULT_TOOLS, createBashTool, makeToolExecutor } from "../tools/index.js";
import {
  makeSafetyHooks,
  makeAskQueue,
  type ApprovalMode,
  type AskApproval,
} from "../tools/safety.js";
import {
  Session,
  defaultSessionPath,
  replaySession,
  type Session as SessionType,
} from "../session/session.js";

import { QUIET_ON_SUCCESS_TOOLS, lengthEndNote } from "../types.js";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  ExecuteToolCall,
  ModelConfig,
  StopReason,
  StreamFn,
  Tool,
  UserMessage,
} from "../types.js";

// ─────────────────────────────── options / parsing ───────────────────────────────

export interface CliOptions {
  oneShot: boolean;
  /** Interactive UI: "auto" (default — TUI on a TTY, plain REPL when stdin
   *  is piped), "tui" (the `tui` subcommand), or "plain" (--plain). */
  ui: "auto" | "plain" | "tui";
  prompt?: string;
  modelId?: string;
  /** D19: undefined = auto-locate (nearest models.json above cwd, then ~/.tre/). */
  modelsPath?: string;
  tools: string;
  cwd: string;
  sessionPath?: string;
  resumePath?: string;
  /** D20: fresh session under ~/.tre/sessions/ (outside any repository). */
  sessionAuto: boolean;
  skillDirs: string[];
  /** C24: undefined = derive from the model (contextWindow/maxTokens);
   *  an explicit --max-turns N overrides the derivation, smaller or larger.
   *  C26: the cap is per-CYCLE — the loop auto-continues on exhaustion.
   *  The runaway-loop guard is always on — there is no "no cap" state. */
  maxTurns?: number;
  /** C26: undefined = default (3 auto-continuations → 4 cycles).
   *  0 restores the old hard-stop-at-first-budget-hit behavior. */
  maxContinuations?: number;
  /** --yes: auto-approve everything EXCEPT sensitive + destructive (those
   *  confirm in every mode). */
  yes: boolean;
  /** --no-approve: never prompt; only read-only, non-sensitive bash is
   *  allowed, everything else is blocked. */
  noApprove: boolean;
  /** --ask (default): prompt only for sensitive + destructive; read-only,
   *  reversible, and in-workspace write/edit run without a prompt. */
  ask: boolean;
  /** --no-compact (WS9): disable auto-compaction (default: always on). */
  noCompact: boolean;
  /** --compact-keep (WS9): estimated tokens kept after a compaction. */
  compactKeepTokens: number;
  /** --no-sandbox (WS11): run bash without the kernel file-access sandbox
   *  (default: sandboxed on darwin; the flag is a no-op elsewhere). */
  noSandbox: boolean;
}

export interface ParsedArgs extends CliOptions {
  errors: string[];
}

const KNOWN_TOOLS = new Set(DEFAULT_TOOLS.map((t) => t.name));

/** Hand-rolled arg parse (zero deps). `errors` is non-empty when the argv is invalid.
 *  Flags consume the NEXT argv entry as their value (skipped by the loop). */
export function parseArgs(argv: string[]): ParsedArgs {
  const opts: ParsedArgs = {
    oneShot: false,
    ui: "auto",
    tools: "all",
    cwd: process.cwd(),
    sessionAuto: false,
    skillDirs: [],
    // C24: undefined = derive from the model in runLoop (never hardcoded).
    maxTurns: undefined,
    // C26: undefined = default continuation count (4 cycles) in runLoop.
    maxContinuations: undefined,
    yes: false,
    noApprove: false,
    ask: false,
    noCompact: false,
    compactKeepTokens: 8192,
    noSandbox: false,
    errors: [],
  };
  let i = 0;
  let plainFlag = false; // tracked separately so `tui --plain` / `--plain tui`
  // is a conflict either way (not a silent last-one-wins overwrite).
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "run") {
      opts.oneShot = true;
      i++;
    } else if (a === "tui") {
      opts.ui = "tui";
      i++;
    } else if (a === "--model" || a === "--models" || a === "--tools" || a === "--cwd" ||
               a === "--session" || a === "--resume" || a === "--skills" || a === "--max-turns" ||
               a === "--max-continuations" || a === "--compact-keep") {
      const v = argv[i + 1];
      if (v === undefined) {
        opts.errors.push(`${a} needs a value`);
        i += 1;
        continue;
      }
      if (a === "--model") opts.modelId = v;
      else if (a === "--models") opts.modelsPath = v;
      else if (a === "--tools") opts.tools = v;
      else if (a === "--cwd") opts.cwd = v;
      else if (a === "--session") opts.sessionPath = v;
      else if (a === "--resume") opts.resumePath = v;
      else if (a === "--skills") opts.skillDirs.push(v);
      else if (a === "--max-turns") {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) opts.errors.push("--max-turns must be a positive integer");
        else opts.maxTurns = n;
      } else if (a === "--max-continuations") {
        // C26: 0 is valid (legacy hard-stop) — non-negative integer.
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) opts.errors.push("--max-continuations must be a non-negative integer");
        else opts.maxContinuations = n;
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) opts.errors.push("--compact-keep must be a positive integer");
        else opts.compactKeepTokens = n;
      }
      i += 2;
    } else if (a === "--yes" || a === "--no-approve" || a === "--ask" ||
               a === "--no-compact" || a === "--no-sandbox" || a === "--session-auto" ||
               a === "--plain") {
      if (a === "--yes") opts.yes = true;
      else if (a === "--no-approve") opts.noApprove = true;
      else if (a === "--ask") opts.ask = true;
      else if (a === "--no-compact") opts.noCompact = true;
      else if (a === "--session-auto") opts.sessionAuto = true;
      else if (a === "--plain") plainFlag = true;
      else opts.noSandbox = true;
      i++;
    } else if (a === "--help" || a === "-h") {
      opts.errors.push("help");
      i++;
    } else if (!a.startsWith("--")) {
      opts.prompt = opts.prompt === undefined ? a : `${opts.prompt} ${a}`;
      i++;
    } else {
      opts.errors.push(`unknown option: ${a}`);
      i++;
    }
  }
  if (opts.oneShot && opts.prompt === undefined) {
    opts.errors.push("`run` needs a prompt: tre. run \"your prompt\"");
  }
  if (plainFlag) {
    if (opts.ui === "tui") {
      opts.errors.push("conflict: `tui` and --plain are mutually exclusive");
    } else {
      opts.ui = "plain";
    }
  }
  if (opts.ui === "tui" && opts.prompt !== undefined) {
    opts.errors.push("`tui` takes no prompt: tre. tui [--flags]");
  }
  if (opts.sessionPath && opts.resumePath) {
    opts.errors.push("--session and --resume are mutually exclusive");
  }
  if (opts.sessionAuto && (opts.sessionPath || opts.resumePath)) {
    opts.errors.push("conflict: --session-auto cannot be combined with --session/--resume");
  }
  {
    const flags: [string, boolean][] = [
      ["--yes", opts.yes],
      ["--no-approve", opts.noApprove],
      ["--ask", opts.ask],
    ];
    const on = flags.filter(([, v]) => v).map(([f]) => f);
    if (on.length > 1) opts.errors.push(`approval flags are mutually exclusive: ${on.join(", ")}`);
  }
  return opts;
}

/** Resolve the --tools spec against the known toolset. Returns [tools, error]. */
export function resolveTools(spec: string): { tools: Tool[]; error?: string } {
  if (spec === "all") return { tools: DEFAULT_TOOLS };
  if (spec === "none") return { tools: [] };
  const names = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !KNOWN_TOOLS.has(n));
  if (unknown.length > 0) {
    return { tools: [], error: `unknown tool(s): ${unknown.join(", ")} (known: ${[...KNOWN_TOOLS].join(", ")})` };
  }
  return { tools: DEFAULT_TOOLS.filter((t) => names.includes(t.name)) };
}

/** Default skill dir resolution: project first, then user (both optional). */
export function defaultSkillDirs(cwd: string): string[] {
  return [`${cwd}/.pi/skills`, `${homedir()}/.pi/agent/skills`];
}

/** Load + dedupe skills across dirs by name (earlier dirs win). */
export async function loadSkills(dirs: string[]) {
  const seen = new Set<string>();
  const out: { name: string; description: string; filePath: string }[] = [];
  for (const dir of dirs) {
    for (const entry of await loadSkillsIndex(dir)) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push(entry);
    }
  }
  return out;
}

// ───────────────────────────────── run core ─────────────────────────────────

export interface RunAgentOptions {
  model: ModelConfig;
  systemPrompt: string;
  tools: Tool[];
  streamFn: StreamFn;
  signal: AbortSignal;
  initialMessages: AgentMessage[];
  /** May be async (WS9: the compaction hook awaits session appends). */
  onEvent?: (ev: AgentEvent) => void | Promise<void>;
  /** Between LLM turns: swap the context (WS9 compaction). */
  prepareNextTurn?: (context: AgentMessage[], turn: number) =>
    | AgentMessage[]
    | undefined
    | Promise<AgentMessage[] | undefined>;
  maxTurns?: number;
  /** C26: undefined = default (3 auto-continuations); 0 = legacy hard stop. */
  maxContinuations?: number;
  /** Tool pipeline (WS7 safety hooks); default: raw tool.execute. */
  executeToolCall?: ExecuteToolCall;
  /** Steering queue (TUI): guidance typed during the run, drained per turn. */
  steeringQueue?: SteeringQueue;
}

export interface RunOutcome {
  stopReason: StopReason;
  errorMessage?: string;
  /** Final context (initialMessages + everything the run added). */
  messages: AgentMessage[];
}

/**
 * One agent run (one user turn): run the loop, forward events to onEvent.
 * Never throws for endpoint/tool failures (I3) — they surface in the
 * outcome. Throws only for programming errors (bad wiring).
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunOutcome> {
  let outcome: RunOutcome | undefined;
  for await (const ev of runLoop({
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    initialMessages: opts.initialMessages,
    tools: opts.tools,
    streamFn: opts.streamFn,
    signal: opts.signal,
    prepareNextTurn: opts.prepareNextTurn,
    maxTurns: opts.maxTurns,
    maxContinuations: opts.maxContinuations,
    executeToolCall: opts.executeToolCall,
    steeringQueue: opts.steeringQueue,
  })) {
    await opts.onEvent?.(ev);
    if (ev.type === "agent_end") {
      const last = ev.messages[ev.messages.length - 1]!;
      outcome = {
        stopReason: ev.stopReason,
        messages: ev.messages,
      };
      if (last.role === "assistant" && last.stopReason === "error" && last.errorMessage) {
        outcome.errorMessage = last.errorMessage;
      }
    }
  }
  if (!outcome) throw new Error("runLoop ended without agent_end (contract violation)");
  return outcome;
}

/** Map a run outcome to a process exit code. */
export function exitCodeFor(stopReason: StopReason): number {
  switch (stopReason) {
    case "stop":
      return 0;
    case "aborted":
      return 130;
    case "error":
    case "length":
      return 1;
    case "toolUse":
      // Ran out of turns while the model still wanted to call a tool.
      return 1;
    case "budget":
      // C26: every cycle's turn budget was exhausted (the loop auto-
      // continues per cycle) — explicit, resumable (distinct from 0 =
      // done, 1 = provider error, 2 = usage error).
      return 3;
    case "loop":
      // C26: runaway-loop detection stopped the run (3 identical batches
      // in a row) — resumable like budget: a new prompt breaks the pattern.
      return 3;
  }
}

// ───────────────────────────────── printer ─────────────────────────────────

export interface PrintSinks {
  out: { write(s: string, cb?: () => void): unknown };
  err: { write(s: string, cb?: () => void): unknown };
}

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The event → terminal printer. Streaming text deltas go to `out` as they
 * arrive (no echo, no framing); tool lines are one line each; diagnostics go
 * to `err`. Thinking deltas are not printed. `sessionPath` (optional) lets
 * the budget note name a resume target when a session file is in use.
 */
export function printEvent(ev: AgentEvent, sinks: PrintSinks, sessionPath?: string): void {
  switch (ev.type) {
    case "text_delta":
      sinks.out.write(ev.delta);
      break;
    case "done":
      if (ev.message.content.some((b) => b.type === "text")) sinks.out.write("\n");
      break;
    case "tool_execution_start":
      // D19: file-access tools (read/write/edit) are silent on success —
      // only a denial earns a line.
      if (!QUIET_ON_SUCCESS_TOOLS.has(ev.toolCall.name)) {
        sinks.out.write(`\n→ ${ev.toolCall.name} ${oneLine(JSON.stringify(ev.toolCall.arguments), 120)}\n`);
      }
      break;
    case "tool_execution_end": {
      if (QUIET_ON_SUCCESS_TOOLS.has(ev.result.toolName) && ev.result.isError !== true) {
        break; // D19: quiet tool succeeded — no line at all
      }
      const text = ev.result.content
        .map((c) => c.text)
        .join(" ")
        .replace(/\s+/g, " ");
      sinks.out.write(`  ${ev.result.isError ? "✗" : "✓"} ${oneLine(text, 200)}\n`);
      break;
    }
    case "context_compacted":
      sinks.err.write(
        `\n✂ context compacted: ~${Math.round(ev.tokensBefore / 100) / 10}k tokens → summary (${ev.summaryChars} chars) + last ${ev.messagesKept} message(s) kept\n`,
      );
      break;
    case "turn_budget":
      // C26: informational — the run continues on a fresh cycle.
      sinks.err.write(
        `\n⏳ turn budget (${ev.maxTurns}) reached — continuing (cycle ${ev.cycle}/${ev.maxCycles})\n`,
      );
      break;
    case "agent_end":
      if (ev.stopReason === "error") {
        const last = ev.messages[ev.messages.length - 1]!;
        const msg = last.role === "assistant" && last.errorMessage ? last.errorMessage : "provider error";
        sinks.err.write(`\nerror: ${msg}\n`);
      } else if (ev.stopReason === "aborted") {
        sinks.err.write("\naborted\n");
      } else if (ev.stopReason === "length") {
        sinks.err.write(`\n${lengthEndNote(ev.messages)}\n`);
      } else if (ev.stopReason === "budget") {
        // C26: name the cycles only when more than one actually ran.
        const note =
          ev.maxTurns !== undefined
            ? ev.maxCycles !== undefined && ev.maxCycles > 1
              ? `budget: max ${ev.maxTurns} turns × ${ev.maxCycles} cycles reached`
              : `budget: max ${ev.maxTurns} turns reached`
            : "budget: turn cap reached";
        const resume = sessionPath !== undefined ? ` (resume: --resume ${sessionPath})` : "";
        sinks.err.write(`\n${note}${resume}\n`);
      } else if (ev.stopReason === "loop") {
        const resume = sessionPath !== undefined ? ` (resume: --resume ${sessionPath})` : "";
        sinks.err.write(
          `\nloop: the model repeated the same tool call(s) 3 times in a row — stopped to avoid a runaway loop (the repeat was not executed)${resume}\n`,
        );
      }
      break;
    default:
      break; // start/turn/tool-call stream events: nothing to print
  }
}

/** Wait for pending stdout/stderr writes to flush before exiting (TTY/pipe). */
async function flushSinks(sinks: PrintSinks): Promise<void> {
  await Promise.all([
    new Promise<void>((r) => sinks.out.write("", () => r())),
    new Promise<void>((r) => sinks.err.write("", () => r())),
  ]);
}

// ─────────────────────────────── one turn (persist) ───────────────────────────────

/**
 * One REPL/one-shot turn: append the user message to the session FIRST (a
 * kill mid-run keeps the prompt), run the loop, persisting each new message
 * as it enters the context (WS9: compaction boundaries need the entry ids,
 * and a kill mid-run keeps the whole run, not just the prompt). Returns
 * { outcome, context }.
 */
export async function runTurn(opts: {
  model: ModelConfig;
  systemPrompt: string;
  tools: Tool[];
  streamFn: StreamFn;
  controller: AbortController;
  context: AgentMessage[];
  session?: SessionType;
  prompt: string;
  sinks: PrintSinks;
  /** C24: undefined = derive the runaway-loop cap from the model.
   *  C26: per-cycle budget (the loop auto-continues on exhaustion). */
  maxTurns?: number;
  /** C26: undefined = default continuation count; 0 = legacy hard stop. */
  maxContinuations?: number;
  executeToolCall?: ExecuteToolCall;
  /** WS9: message → session entry id (session-lifetime; resume seeds it
   *  from the replayed context). */
  entryIds?: Map<AgentMessage, string>;
  /** WS9: disable auto-compaction (default: on — compaction is context
   *  management, independent of session persistence). */
  noCompact?: boolean;
  /** WS9: estimated tokens kept after a compaction (default 8192). */
  compactKeepTokens?: number;
  /** WS10: extra consumer of the event stream (the TUI renders from it). */
  tap?: (ev: AgentEvent) => void;
  /** Steering queue (TUI): guidance typed during the run, drained per turn. */
  steeringQueue?: SteeringQueue;
}): Promise<{ outcome: RunOutcome; context: AgentMessage[] }> {
  const { controller, context, session } = opts;
  const user: UserMessage = { role: "user", content: opts.prompt, timestamp: Date.now() };
  const seeded: AgentMessage[] = [...context, user];
  const ids = opts.entryIds ?? new Map<AgentMessage, string>();
  if (session) ids.set(user, await session.appendMessage(user));

  const persist = (m: AgentMessage): Promise<void> =>
    (async () => {
      const id = await session!.appendMessage(m);
      ids.set(m, id);
    })();

  // WS9 (D10): between LLM turns, if the last assistant usage would push
  // the next prompt past the window, fold the older messages into a
  // summary (one silent LLM call) and replace the context with
  // [summary, …kept]. Compaction is CONTEXT management — it runs whenever
  // the trigger fires, with or without a session file; the session (when
  // present) additionally gets a `compaction` entry so a resume replays the
  // boundary. The UI gets a context_compacted event. A failed/empty summary
  // call skips compaction (context unchanged) — it never fails the run (I3).
  let prepareNextTurn: ((ctx: AgentMessage[]) => Promise<AgentMessage[] | undefined>) | undefined;
  if (!opts.noCompact) {
    prepareNextTurn = async (ctx: AgentMessage[]) => {
      const r = await compactContext({
        streamFn: opts.streamFn,
        model: opts.model,
        signal: controller.signal,
        context: ctx,
        keepTokens: opts.compactKeepTokens,
      });
      if (!r) {
        // I3 skip visibility (WS10 e2e s12): when the trigger DID fire, a
        // missing result means the summary call failed or came back empty —
        // say so, instead of the skip being invisible.
        const lastAsst = [...ctx]
          .reverse()
          .find((m): m is AssistantMessage => m.role === "assistant");
        if (
          lastAsst &&
          shouldCompact(
            lastAsst.usage,
            opts.model.contextWindow,
            opts.model.maxTokens,
          )
        ) {
          opts.sinks.err.write(
            "compaction skipped: summary call failed or returned empty (context unchanged)\n",
          );
        }
        return undefined;
      }
      const summaryMsg = makeSummaryMessage(r.summary);
      if (session) {
        // The compaction entry references the first kept message so a resume
        // knows where the summary boundary is — session-only bookkeeping.
        const firstId = ids.get(r.kept[0]!);
        if (!firstId) {
          opts.sinks.err.write("note: compaction skipped — kept messages have no session entry ids\n");
          return undefined;
        }
        const entryId = await session.appendCompaction(r.summary, firstId, r.tokensBefore);
        ids.set(summaryMsg, entryId);
      }
      await report({
        type: "context_compacted",
        tokensBefore: r.tokensBefore,
        messagesKept: r.kept.length,
        summaryChars: r.summary.length,
      });
      return [summaryMsg, ...r.kept];
    };
  }

  const report = (ev: AgentEvent): Promise<void> => onEvent(ev);
  const onEvent = async (ev: AgentEvent): Promise<void> => {
    if (session) {
      // Incremental persistence: every message lands in the file the moment
      // it becomes part of the context (same file order as the old
      // append-after-agent_end — user, then the run's messages in event
      // order).
      if (ev.type === "done") await persist(ev.message);
      else if (ev.type === "tool_execution_end") await persist(ev.result);
      else if (ev.type === "steer")
        // The steer's user message is pushed to the context by the loop but
        // travels only as an event — persist it here so a resumed session
        // keeps the guidance the user gave mid-run.
        await persist({ role: "user", content: ev.text, timestamp: Date.now() });
    }
    opts.tap?.(ev);
    printEvent(ev, opts.sinks, session?.path);
  };

  const outcome = await runAgent({
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    streamFn: opts.streamFn,
    signal: controller.signal,
    initialMessages: seeded,
    onEvent,
    prepareNextTurn,
    maxTurns: opts.maxTurns,
    maxContinuations: opts.maxContinuations,
    executeToolCall: opts.executeToolCall,
    steeringQueue: opts.steeringQueue,
  });

  return { outcome, context: outcome.messages };
}

// ─────────────────────────────────── main ───────────────────────────────────

const HELP = `tre. — Tre Coding Agent: a small, fully-owned coding-agent harness

Usage:
  tre. run "prompt"             one-shot run (exit when the run ends)
  tre.                          interactive: the Ink TUI on a TTY, the plain
                                REPL when stdin is piped
  tre. tui                      interactive Ink TUI (streaming,
                                ↑/↓ history, ctrl+c abort/quit)
  tre. --plain                  interactive plain REPL (even on a TTY)

Steering (TUI): while a run is in flight, typing a line and pressing enter
injects it as a user message mid-run — the model reacts to it on its next
turn instead of waiting for a new prompt. /quit (or /exit) still aborts.

Options:
  --model <id>       model id from models.json (default: the file's "default")
  --models <file>    models.json path (default: nearest models.json above the
                     launch dir, then ~/.tre/models.json)
  --tools <list>     read,write,edit,bash — or "all" (default) / "none"
  --cwd <dir>        project root: the agent's working directory and the
                     sandbox boundary for file tools (default: process cwd)
  --session <file>   session file: create if absent, resume if present
  --resume <file>    resume an existing session file
  --session-auto     session file under ~/.tre/sessions/ (never inside the repo)
  --skills <dir>     skills dir (repeatable)
  --max-turns <n>    per-run LLM-turn cap (default: derived from the model's
                     contextWindow/maxTokens — hundreds of turns for a large
                     window; the runaway guard is always on)
  --ask              (DEFAULT) prompt only for SENSITIVE reads and
                     DESTRUCTIVE/irreversible actions; read-only bash,
                     reversible git/npm ops, and in-workspace write/edit
                     run without a prompt
  --yes              auto-approve everything except SENSITIVE and
                     DESTRUCTIVE (both confirm in every mode)
  --no-approve       never prompt: only read-only, non-sensitive bash is
                     allowed; everything else is blocked with an error
                     result (fail-closed, for non-interactive runs)
  --no-compact       disable auto-compaction (on by default — context management, session or not)
  --compact-keep <n> estimated tokens to keep after a compaction (default
                     8192)
  --no-sandbox       run bash without the kernel file-access sandbox
                     (on by default on macOS; no-op elsewhere)
  --plain            interactive plain REPL (one prompt per line) instead of
                     the TUI — the default when stdin is piped anyway

Safety (WS7/WS11): the read tool may read any file on the system (no root
restriction) — EXCEPT sensitive material (secret/key paths: ~/.ssh/,
~/.aws/, ~/.gnupg/, ~/.kube/, ~/.config/gcloud/, ~/.docker/config.json,
~/.netrc, /etc/shadow, id_rsa*/id_ed25519*, *.pem/*.key/*.p12/*.pfx,
.env-family), which confirms in every mode. write/edit are sandboxed to
the project root (--cwd or the process cwd) — paths that escape it (../,
absolute paths, symlinks) are refused. On macOS the bash tool runs in the
project root under a kernel (Seatbelt) sandbox with the same boundary;
elsewhere it runs in the project root unsandboxed.
Approval (D8): the user is only prompted to confirm SENSITIVE reads and
DESTRUCTIVE/irreversible actions (recursive rm, ANY git push,
git reset --hard, forced git clean, git branch -D, git checkout . /
checkout -- <path> / git restore, dd to /dev/*, raw-device redirects,
mkfs, fork bomb, shutdown/reboot). The default mode (ask) runs everything
else without a prompt — read-only bash (ls/cat/grep/… and read-only
git/kubectl/docker subcommands), reversible bash (git add/commit/stash/
switch/checkout <branch>/branch <new>/tag <new>, npm run/test), and
in-workspace write/edit. --yes auto-approves everything except sensitive
and destructive; --no-approve allows ONLY read-only, non-sensitive bash.
Anything but y is a denial, and a denial comes back to the model as an
error result.

SIGINT during a run aborts the run (second SIGINT exits).`;

export interface MainDeps {
  streamFn?: StreamFn;
  cwd?: string;
  /** Injectable sinks (tests capture output); defaults to the real streams. */
  sinks?: PrintSinks;
  /** Injectable approval prompt (tests); default: a readline question. */
  askApproval?: AskApproval;
}

/**
 * WS7: one-shot default approver — a throwaway readline per question
 * (nothing else consumes stdin in one-shot mode). Non-TTY stdin → deny
 * immediately (fail-closed: no human can answer; use --yes/--no-approve).
 * EOF/error → deny. TTY: the question is shown as the readline prompt.
 */
function makeTempReadlineAsk(): AskApproval {
  return (question) => {
    if (!process.stdin.isTTY) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let rl: Interface | undefined;
      let settled = false;
      const done = (v: boolean): void => {
        if (settled) return;
        settled = true;
        try {
          rl?.close();
        } catch {
          // already closed — fine
        }
        resolve(v);
      };
      try {
        rl = createInterface({ input: process.stdin, output: process.stdout });
      } catch {
        done(false);
        return;
      }
      rl.setPrompt(question);
      rl.prompt();
      rl.once("line", (line: string) => done(/^y(es)?$/i.test(line.trim())));
      rl.once("close", () => done(false));
    });
  };
}

/**
 * WS7: wraps an approver — serializes prompts (a parallel batch may hold
 * several gated calls, only one question may be on screen at a time) and,
 * on non-TTY stdin, logs the question to stderr (the readline prompt is
 * not visible there).
 */
export function makeInteractiveAsk(inner: AskApproval, err: PrintSinks["err"]): AskApproval {
  const queued = makeAskQueue(inner);
  return (q) => {
    if (!process.stdin.isTTY) err.write(q + "\n");
    return queued(q);
  };
}

/**
 * Entry point. Returns the process exit code; never throws for expected
 * failures (I3). `deps` is for tests (inject streamFn/sinks); the real entry
 * uses the openAiStream wire layer.
 */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const args = parseArgs(argv);
  const sinks: PrintSinks = deps.sinks ?? { out: process.stdout, err: process.stderr };
  if (args.errors.includes("help")) {
    sinks.out.write(HELP + "\n");
    return 0;
  }
  if (args.errors.length > 0) {
    for (const e of args.errors) sinks.err.write(`error: ${e}\n`);
    return 2;
  }

  // models (D19: --models wins; otherwise locate — nearest models.json above
  // the launch directory, then the permanent ~/.tre/models.json)
  const modelsPath = args.modelsPath ?? findModelsFile(undefined, path.resolve(process.cwd()));
  if (modelsPath === null) {
    sinks.err.write(
      `error: models.json not found — searched ${path.resolve(process.cwd())} and its parents, then ~/.tre/models.json; pass --models <file>\n`,
    );
    return 2;
  }
  let model: ModelConfig;
  try {
    model = resolveModel(loadModelsFile(modelsPath), args.modelId);
  } catch (err) {
    sinks.err.write(`error: cannot load ${modelsPath}: ${String(err)}\n`);
    return 2;
  }

  // tools
  const { tools, error: toolError } = resolveTools(args.tools);
  if (toolError) {
    sinks.err.write(`error: ${toolError}\n`);
    return 2;
  }

  // WS7: project root — the sandbox boundary for the file tools and the
  // working directory for bash.
  const root = path.resolve(args.cwd);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    sinks.err.write(`error: cwd ${root} is not an existing directory\n`);
    return 2;
  }
  // bash runs in the project root, so its relative paths mean the same
  // thing as the file tools' (the safety hook resolves those against it);
  // on darwin the child is kernel-sandboxed to the same boundary (WS11).
  const wiredTools = tools.map((t) =>
    t.name === "bash" ? createBashTool(root, { sandbox: !args.noSandbox }) : t,
  );

  // skills
  const skillDirs = args.skillDirs.length > 0 ? args.skillDirs : defaultSkillDirs(root);
  const skills = await loadSkills(skillDirs);

  // system prompt
  const systemPrompt = buildSystemPrompt({
    cwd: root,
    tools: wiredTools,
    model: model.id,
    skills,
  });

  // D20 boundary (--session-auto): resolve a fresh session path OUTSIDE any
  // repository (~/.tre/sessions/) so the agent under test can never read or
  // edit its own history. The parent dir is created up front (the first write
  // must not fail on a missing directory) and `session: <path>` goes to stderr
  // ONCE at startup — an orchestrator captures it to build its --resume
  // command. Without the flag there is still no session file; combining
  // --session-auto with --session/--resume was rejected in parseArgs.
  let autoSessionPath: string | undefined;
  if (args.sessionAuto) {
    autoSessionPath = defaultSessionPath();
    mkdirSync(path.dirname(autoSessionPath), { recursive: true });
    sinks.err.write(`session: ${autoSessionPath}\n`);
  }

  // session (resume / create / --session-auto)
  let session: SessionType | undefined;
  let context: AgentMessage[] = [];
  // WS9: message → session entry id, for the session's lifetime. Seeded
  // from the replay on resume (a compaction's firstKeptEntryId must name a
  // kept message's entry); filled as new messages are appended.
  const entryIds = new Map<AgentMessage, string>();
  const sessionFile = args.resumePath ?? args.sessionPath ?? autoSessionPath;
  if (sessionFile !== undefined) {
    try {
      if (args.resumePath || existsSync(sessionFile)) {
        const replayed = await replaySession(sessionFile);
        session = await Session.open(sessionFile);
        context = replayed.context;
        replayed.context.forEach((m, i) => entryIds.set(m, replayed.contextEntryIds[i]!));
        if (replayed.model && !args.modelId) {
          try {
            model = resolveModel(loadModelsFile(modelsPath), replayed.model.id);
          } catch {
            sinks.err.write(`note: session model "${replayed.model.id}" not in models.json — using ${model.id}\n`);
          }
        }
        if (replayed.droppedTornTail) {
          sinks.err.write(`note: session ${sessionFile} had a torn trailing line — it was dropped\n`);
        }
        sinks.err.write(`resumed ${sessionFile}: ${context.length} context message(s)\n`);
      } else {
        session = await Session.create(sessionFile, {
          cwd: root,
          model: { id: model.id, provider: model.provider },
        });
      }
    } catch (err) {
      sinks.err.write(`error: session: ${String(err)}\n`);
      return 2;
    }
  }

  const streamFn = deps.streamFn ?? openAiStream;

  // WS7: safety hooks (path sandbox + approval gate) wired into the loop's
  // tool pipeline. Default mode is "ask" (prompt only sensitive +
  // destructive); --yes auto-approves everything except sensitive +
  // destructive; --no-approve allows only read-only non-sensitive bash.
  const mode: ApprovalMode =
    args.noApprove ? "no" : args.yes ? "yes" : "ask";
  const buildExecutor = (ask: AskApproval) =>
    makeToolExecutor({ beforeToolCall: makeSafetyHooks({ root, mode, ask }) });

  // Bare `tre.` (ui "auto"): the Ink TUI on a TTY, the plain REPL when stdin
  // is piped (a pipe has no terminal for raw mode — the REPL is the
  // non-interactive fallback). Explicit `tui` / `--plain` skip this.
  const ui: "plain" | "tui" =
    args.ui === "tui" ? "tui" : args.ui === "plain" ? "plain" : process.stdin.isTTY ? "tui" : "plain";

  // WS10: the Ink TUI — same setup as the REPL, different presentation.
  // It installs its own SIGINT handling (abort while busy / exit 130 idle).
  if (ui === "tui") {
    // Ink needs raw-mode stdin, which only a TTY provides — fail cleanly
    // (I3) instead of dumping Ink's raw-mode error.
    if (!process.stdin.isTTY) {
      sinks.err.write(
        "error: `tui` needs an interactive terminal; use `tre. run \"...\"` or `tre. --plain` without one\n",
      );
      return 2;
    }
    // C23: dynamic — see the terminal-size-fix import above. Loading ink
    // after the resolve hook is registered is what makes the fix apply.
    const { runTui } = await import("../tui/run.js");
    const code = await runTui({
      model,
      systemPrompt,
      tools: wiredTools,
      streamFn,
      session,
      context,
      entryIds,
      maxTurns: args.maxTurns,
      maxContinuations: args.maxContinuations,
      buildExecutor,
      noCompact: args.noCompact,
      compactKeepTokens: args.compactKeepTokens,
      // D15: static labels for the TUI's /display-bottom fields.
      cwd: root,
      sessionPath: sessionFile,
      deps: { askApproval: deps.askApproval },
    });
    if (session) await session.close();
    return code;
  }

  // SIGINT: first aborts the active run, second exits (plain CLI only).
  let controller = new AbortController();
  let active = false;
  const onSigint = (): void => {
    if (active) controller.abort();
    else process.exit(130);
  };
  process.on("SIGINT", onSigint);

  let rl: Interface | undefined;
  try {
    if (args.oneShot) {
      active = true;
      const ask = deps.askApproval ?? makeTempReadlineAsk();
      const executor = buildExecutor(makeInteractiveAsk(ask, sinks.err));
      const { outcome } = await runTurn({
        model, systemPrompt, tools: wiredTools, streamFn, controller, context, session,
        prompt: args.prompt!, sinks, maxTurns: args.maxTurns, maxContinuations: args.maxContinuations,
        executeToolCall: executor,
        entryIds, noCompact: args.noCompact, compactKeepTokens: args.compactKeepTokens,
      });
      await flushSinks(sinks);
      return exitCodeFor(outcome.stopReason);
    }

    // REPL
    const r = createInterface({ input: process.stdin, output: process.stdout });
    rl = r;
    // WS7: one pending question at a time — either the "you> " REPL prompt
    // or a tool-approval prompt — both routed to the same readline
    // interface. Piped stdin can still answer (each line resolves the
    // pending question).
    type Consumer =
      | { kind: "user"; resolve: (line: string | null) => void }
      | { kind: "approve"; resolve: (yes: boolean) => void };
    let consumer: Consumer | undefined;
    let rlClosed = false;
    // Piped stdin can burst several lines (and EOF) in one tick, before the
    // REPL loop is awaiting the next question. Lines that arrive with no
    // pending consumer are queued instead of dropped (WS10 e2e s8: the second
    // piped prompt was lost and the REPL exited after the first turn).
    const queuedLines: string[] = [];
    const settle = (fn: (c: Consumer) => void): void => {
      const c = consumer;
      if (!c) return;
      consumer = undefined;
      fn(c);
    };
    r.on("line", (line: string) => {
      const c = consumer;
      if (!c) {
        queuedLines.push(line);
        return;
      }
      consumer = undefined;
      if (c.kind === "user") c.resolve(line);
      else c.resolve(/^y(es)?$/i.test(line.trim()));
    });
    r.on("close", () => {
      rlClosed = true;
      settle((c) => (c.kind === "user" ? c.resolve(null) : c.resolve(false)));
    });
    const askLine = (): Promise<string | null> =>
      new Promise((resolve) => {
        // Drain the queue before prompting or declaring EOF — burst lines
        // are older than the question being asked.
        const queued = queuedLines.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        // A piped stdin closes the interface itself at EOF — never prompt
        // a closed interface (ERR_USE_AFTER_CLOSE).
        if (rlClosed) {
          resolve(null);
          return;
        }
        consumer = { kind: "user", resolve };
        r.setPrompt("you> ");
        r.prompt();
      });
    const replAsk: AskApproval = (question) =>
      new Promise((resolve) => {
        if (rlClosed) {
          resolve(false);
          return;
        }
        consumer = { kind: "approve", resolve };
        r.setPrompt(question);
        r.prompt();
      });
    const ask = deps.askApproval ?? replAsk;
    const executor = buildExecutor(makeInteractiveAsk(ask, sinks.err));
    sinks.err.write("tre. REPL — /quit to exit, SIGINT aborts the current run\n");
    for (;;) {
      // EOF on piped stdin — but only once queued burst lines are drained:
      // stdin can close in the same tick the piped lines arrive (WS10 e2e s8).
      if (rlClosed && queuedLines.length === 0) break;
      const line = await askLine();
      if (line === null) break; // EOF (Ctrl-D)
      const prompt = line.trim();
      if (prompt === "") continue;
      if (prompt === "/quit" || prompt === "/exit") break;
      if (prompt.startsWith("/")) {
        sinks.err.write(`unknown command: ${prompt}\n`);
        continue;
      }
      controller = new AbortController();
      active = true;
      try {
        const result = await runTurn({
          model, systemPrompt, tools: wiredTools, streamFn, controller, context, session,
          prompt, sinks, maxTurns: args.maxTurns, maxContinuations: args.maxContinuations,
          executeToolCall: executor,
          entryIds, noCompact: args.noCompact, compactKeepTokens: args.compactKeepTokens,
        });
        context = result.context;
      } finally {
        active = false;
      }
    }
    await flushSinks(sinks);
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
    // Cleanup is best-effort: the REPL may already have ended (EOF).
    try {
      rl?.close();
    } catch {
      // already closed — fine
    }
    if (session) await session.close();
  }
}

// `node dist/src/cli/main.js ...` (or via the npm bin shim — argv[1] is the
// symlink, so compare realpath). When imported by tests, this stays false.
const entryPath = fileURLToPath(import.meta.url);
if (
  process.argv[1] &&
  (() => {
    try {
      return realpathSync(process.argv[1]!) === entryPath;
    } catch {
      return false;
    }
  })()
) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
