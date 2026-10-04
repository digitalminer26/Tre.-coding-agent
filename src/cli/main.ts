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
 *   --skills <dir>     skills dir (repeatable); defaults: <cwd>/.tre/skills then
 *                      ~/.tre/agent/skills (project skills shadow user skills by name)
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
import { spawnSync } from "node:child_process";
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
import {
  buildModelsSetupGuide,
  findModelsFile,
  hasEndpoint,
  loadModelsFile,
  readActiveModelLenient,
  resolveModel,
} from "../config/models.js";
import { expandTilde, findTreConfig, loadTreConfig } from "../config/tre-config.js";
import {
  calibrateCharsPerToken,
  compactContext,
  estimateTokens,
  makeSummaryMessage,
  ruleBasedShrink,
  shouldCompact,
  SUMMARY_MARKER,
} from "../context/compact.js";
import { openAiStream } from "../wire/openai-completions.js";
import { openAiResponsesStream } from "../wire/openai-responses.js";
import { makeStreamDispatcher } from "../wire/dispatcher.js";
import { runLoop, type SteeringQueue } from "../loop/agent-loop.js";
import { isDirectInvocation, restartCommand } from "../tui/restart.js";
import { buildSystemPrompt } from "../prompt/system-prompt.js";
import { loadSkillsIndex, type SkillIndexEntry } from "../prompt/skills.js";
import { DEFAULT_TOOLS, createBashTool, makeToolExecutor } from "../tools/index.js";
import {
  makeSafetyHooks,
  makeAskQueue,
  validateExtraRoot,
  type ApprovalMode,
  type AskApproval,
} from "../tools/safety.js";
import {
  Session,
  defaultSessionPath,
  replaySession,
  type Session as SessionType,
} from "../session/session.js";
import { makeTelegramBridge, TELEGRAM_LONG_POLL_SEC, type TelegramBridge, type TelegramMessage } from "../telegram/bridge.js";
import { TelegramDriver } from "../telegram/driver.js";
import { workerDir, workerId, writeWorkerStatus } from "./workers.js";

import { QUIET_ON_SUCCESS_TOOLS, lengthEndNote } from "../types.js";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  ExecuteToolCall,
  ModelConfig,
  StopReason,
  StreamFn,
  TextBlock,
  Tool,
  UserMessage,
  WorkerStatus,
} from "../types.js";

export function buildWorkerStatus(
  id: string,
  model: ModelConfig,
  cwd: string,
  prompt: string,
  now: number = Date.now(),
): WorkerStatus {
  const task = prompt.replace(/\\s+/g, " ").trim().slice(0, 120);
  return {
    id, model: model.id, endpoint: model.baseUrl, status: "running", turn: 0,
    activity: "starting", updatedAt: now, startedAt: now, cwd, task,
  };
}

export function makeWorkerTap(status: WorkerStatus, dir: string): (ev: AgentEvent) => void {
  return (ev) => {
    try {
      if (ev.type === "turn_start") {
        status.turn = ev.turn;
        status.activity = "working";
      } else if (ev.type === "tool_execution_start") {
        status.activity = ev.toolCall.name;
      }
      status.updatedAt = Date.now();
      writeWorkerStatus(dir, status);
    } catch {
      // Registry visibility must never interfere with a worker run.
    }
  };
}

export function workerOutcomeStatus(reason: StopReason): "done" | "failed" {
  return reason === "stop" ? "done" : "failed";
}

// ─────────────────────────────── options / parsing ───────────────────────────────

export interface CliOptions {
  oneShot: boolean;
  /** Interactive UI: "auto" (default — TUI on a TTY, plain REPL when stdin
   *  is piped), "tui" (the `tui` subcommand), or "plain" (--plain). */
  ui: "auto" | "plain" | "tui";
  /**
   * D15: a one-shot auth subcommand — `login [chatgpt]` or
   * `auth status|logout`. Dispatched BEFORE any model loading.
   */
  command?: { name: "login" | "auth"; target?: string };
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
  /** --yes (default): auto-approve everything EXCEPT system-level (sys)
   *  sensitive reads + destructive commands (blocked in every mode). */
  yes: boolean;
  /** --no-approve: never prompt; only read-only, non-sensitive bash is
   *  allowed, everything else is blocked. */
  noApprove: boolean;
  /** --ask: prompt for sensitive + destructive (workspace-scoped) and
   *  mutating bash; read-only, reversible, and in-workspace write/edit run
   *  without a prompt (the pre-auto-approve behavior). */
  ask: boolean;
  /** --no-compact (WS9): disable auto-compaction (default: always on). */
  noCompact: boolean;
  /** --compact-keep (WS9): estimated tokens kept after a compaction. */
  compactKeepTokens: number;
  /** --no-sandbox (WS11): run bash without the kernel file-access sandbox
   *  (default: sandboxed on darwin; the flag is a no-op elsewhere). */
  noSandbox: boolean;
  /** C35: --extra-root <dir> (repeatable): explicitly assigned additional
   *  read/write regions (non-sensitive dirs under the user's home), in
   *  addition to the workspace. ONE-SHOT — applies to this launch only, never
   *  written to tre.json (the durable baseline; C36). Validated at startup;
   *  a refusal exits 2. */
  extraRoots: string[];
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
    extraRoots: [],
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
    } else if (a === "login") {
      // D15: `tre. login [chatgpt]` — the only provider for now.
      opts.command = { name: "login" };
      if (argv[i + 1] === "chatgpt") i++;
      i++;
    } else if (a === "auth") {
      // D15: `tre. auth [status|logout]` (default: status).
      const target = argv[i + 1];
      if (target === "status" || target === "logout") {
        opts.command = { name: "auth", target };
        i += 2;
      } else {
        opts.command = { name: "auth", target: "status" };
        i++;
      }
    } else if (a === "--model" || a === "--models" || a === "--tools" || a === "--cwd" ||
               a === "--session" || a === "--resume" || a === "--skills" || a === "--max-turns" ||
               a === "--max-continuations" || a === "--compact-keep" || a === "--extra-root") {
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
      else if (a === "--extra-root") opts.extraRoots.push(v);
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
  return [`${cwd}/.tre/skills`, `${homedir()}/.tre/agent/skills`];
}

/** Load + dedupe skills across dirs by name (earlier dirs win). */
export async function loadSkills(dirs: string[]): Promise<SkillIndexEntry[]> {
  const seen = new Set<string>();
  const out: SkillIndexEntry[] = [];
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
    case "stall":
      // The same tool failed 3× with a permission denial within its recent
      // calls (the deterministic sandbox wall — docs/08 H1: windowed, so
      // interleaved successes don't hide it) — resumable like loop: a
      // different approach or --no-sandbox breaks the pattern.
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
      // D: degraded = the LLM summary failed twice; the folded prefix was
      // replaced by a rule-based notice (no LLM summary).
      const degradedNote = ev.degraded ? " [degraded: rule-based shrink, no LLM summary]" : "";
      sinks.err.write(
        `\n✂ context compacted: ~${Math.round(ev.tokensBefore / 100) / 10}k tokens → summary (${ev.summaryChars} chars) + last ${ev.messagesKept} message(s) kept${degradedNote}\n`,
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
      } else if (ev.stopReason === "stall") {
        const resume = sessionPath !== undefined ? ` (resume: --resume ${sessionPath})` : "";
        sinks.err.write(
          `\nstall: the same tool failed 3 times with a permission denial within its last 8 calls — the sandbox boundary is deterministic, so the repeat was not executed. Change approach (a workspace path / a command the sandbox allows) or re-run with --no-sandbox${resume}\n`,
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

// ─────────────────────────────── compaction (shared) ───────────────────────────────

/**
 * D — the compaction ladder, shared by the auto trigger (prepareNextTurn)
 * and the manual `/compact` (A6). When the trigger fired (or `force`) but
 * `compactContext` returned undefined:
 *   1. retry once with a shrunken transcript (halved clips) — covers
 *      transient failures and "summarizer input too big";
 *   2. rule-based fallback (no LLM) — the folded prefix becomes a small
 *      notice (SUMMARY_MARKER + count + file ops); the event carries
 *      `degraded: true`;
 *   3. no plan at all (context too short to fold) → skip, stderr message.
 * Session entry + `context_compacted` event are written here (one place).
 * Returns the new context, or undefined when nothing could be compacted.
 */
export async function compactNow(deps: {
  streamFn: StreamFn;
  model: ModelConfig;
  signal: AbortSignal;
  context: AgentMessage[];
  session?: SessionType | null;
  ids: Map<AgentMessage, string>;
  systemPrompt: string;
  compactKeepTokens?: number;
  charsPerToken?: number;
  /** A6: skip the shouldCompact trigger check (manual /compact). */
  force?: boolean;
  sinks: PrintSinks;
  onEvent: (ev: AgentEvent) => Promise<void>;
}): Promise<AgentMessage[] | undefined> {
  const { session, ids, sinks } = deps;
  const cpt = deps.charsPerToken ?? 4;
  const lastAsst = [...deps.context]
    .reverse()
    .find((m): m is AssistantMessage => m.role === "assistant");
  if (!deps.force && !shouldCompact(lastAsst?.usage, deps.model.contextWindow, deps.model.maxTokens)) {
    return undefined;
  }
  const tokensBefore = lastAsst?.usage?.totalTokens ?? 0;
  const windowCap = Math.max(512, deps.model.contextWindow - deps.model.maxTokens - 1024);
  const keepTokens = Math.min(deps.compactKeepTokens ?? 8192, windowCap);
  const emit = async (
    rawSummary: string,
    kept: AgentMessage[],
    degraded: boolean,
  ): Promise<AgentMessage[] | undefined> => {
    const summaryMsg = makeSummaryMessage(rawSummary);
    if (session) {
      const firstId = ids.get(kept[0]!);
      if (!firstId) {
        sinks.err.write("note: compaction skipped — kept messages have no session entry ids\n");
        return undefined;
      }
      const entryId = await session.appendCompaction(rawSummary, firstId, tokensBefore);
      ids.set(summaryMsg, entryId);
    }
    const newContext = [summaryMsg, ...kept];
    await deps.onEvent({
      type: "context_compacted",
      tokensBefore,
      messagesKept: kept.length,
      summaryChars: rawSummary.length,
      contextTokens: estimateTokens(newContext, cpt),
      ...(degraded ? { degraded: true } : {}),
    });
    return newContext;
  };

  let r = await compactContext({
    streamFn: deps.streamFn,
    model: deps.model,
    signal: deps.signal,
    context: deps.context,
    keepTokens,
    charsPerToken: cpt,
    force: deps.force,
  });
  if (r) return await emit(r.summary, r.kept, false);

  // D1: retry once with a shrunken transcript (halved clips).
  sinks.err.write("compaction: summary call failed — retrying with a smaller transcript\n");
  r = await compactContext({
    streamFn: deps.streamFn,
    model: deps.model,
    signal: deps.signal,
    context: deps.context,
    keepTokens,
    charsPerToken: cpt,
    transcriptOpts: { perMessageChars: 750, totalChars: 12000, toolResultChars: 1000 },
    force: deps.force,
  });
  if (r) return await emit(r.summary, r.kept, false);

  // D2: rule-based fallback (no LLM).
  const shrink = ruleBasedShrink(deps.context, keepTokens, cpt);
  if (shrink) {
    sinks.err.write("compaction: summary failed twice — fell back to rule-based shrink\n");
    // The notice is a full UserMessage (marker + raw); the session entry
    // stores the raw part so replay re-adds the marker (same as the LLM path).
    const raw = shrink.notice.content.startsWith(SUMMARY_MARKER)
      ? shrink.notice.content.slice(SUMMARY_MARKER.length + 2)
      : shrink.notice.content;
    return await emit(raw, shrink.kept, true);
  }
  // D3: context too short to fold — today's skip behavior.
  sinks.err.write("compaction failed and no safe shrink is possible — the next call may exceed the window.\n");
  return undefined;
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
  /** Calibrated chars-per-token (calibrateCharsPerToken) — session-lifetime
   *  state the driver carries across turns; runTurn refines it from each
   *  assistant usage and returns the updated value. Default 4 (uncalibrated). */
  charsPerToken?: number;
  /** WS10: extra consumer of the event stream (the TUI renders from it). */
  tap?: (ev: AgentEvent) => void;
  /** Steering queue (TUI): guidance typed during the run, drained per turn. */
  steeringQueue?: SteeringQueue;
}): Promise<{ outcome: RunOutcome; context: AgentMessage[]; charsPerToken: number }> {
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
  // Session-lifetime calibrated chars-per-token (A1): the driver seeds it
  // (opts.charsPerToken) and each runTurn returns the refined value.
  let cpt = opts.charsPerToken ?? 4;
  let prepareNextTurn: ((ctx: AgentMessage[]) => Promise<AgentMessage[] | undefined>) | undefined;
  if (!opts.noCompact) {
    prepareNextTurn = async (ctx: AgentMessage[]) => {
      // Calibrate the token estimate from the last real usage (chars/4
      // underestimates dense code/JSON 2–3×, which would leave the
      // compacted context OVER the window → immediate re-compaction).
      const lastAsst = [...ctx]
        .reverse()
        .find((m): m is AssistantMessage => m.role === "assistant");
      if (lastAsst?.usage) {
        cpt = calibrateCharsPerToken(lastAsst.usage, ctx, opts.systemPrompt.length);
      }
      // D: the trigger check, retry ladder, rule-based fallback, session
      // entry, and the context_compacted event all live in compactNow.
      return compactNow({
        streamFn: opts.streamFn,
        model: opts.model,
        signal: controller.signal,
        context: ctx,
        session,
        ids,
        systemPrompt: opts.systemPrompt,
        compactKeepTokens: opts.compactKeepTokens,
        charsPerToken: cpt,
        sinks: opts.sinks,
        onEvent: report,
      });
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

  return { outcome, context: outcome.messages, charsPerToken: cpt };
}

/** Extract the final assistant text from a run's context (the reply that
 *  goes back to the bot). Empty when the run produced no text (e.g. it ended
 *  on a tool call or an error) — the caller then sends a fallback. */
export function finalAssistantText(ctx: AgentMessage[]): string {
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

ChatGPT Plus (no API key — D15):
  tre. login [chatgpt]          log in with your ChatGPT account (opens the
                                browser; waits for the local callback or a
                                pasted redirect URL). Stores tokens in
                                ~/.tre/chatgpt-auth.json.
  tre. auth status              show the stored login (email, plan, expiry)
  tre. auth logout              delete the stored tokens
  Then point a models.json entry at the Responses API:
    { "api": "openai-responses", "auth": "chatgpt-oauth",
      "baseUrl": "https://api.openai.com/v1", "id": "<model>" }

Steering (TUI): while a run is in flight, typing a line and pressing enter
injects it as a user message mid-run — the model reacts to it on its next
turn instead of waiting for a new prompt. /quit (or /exit) still aborts.
/restart relaunches tre. in place (same session + settings) without
quitting — the new process resumes the session automatically.

Options:
  --model <id>       model id from models.json (default: the file's "default")
  --models <file>    models.json path (default: nearest models.json above the
                     launch dir, then ~/.tre/models.json)
  --tools <list>     read,write,edit,bash — or "all" (default) / "none"
  --cwd <dir>        project root: the agent's working directory and the
                     sandbox boundary for file tools (default: process cwd)
  --extra-root <dir> C35: an ADDITIONAL read/write root in addition to the
                     workspace (repeatable). ONE-SHOT: it applies to THIS launch
                     only and is NEVER written to tre.json — re-pass it on each
                     launch, or add it to tre.json to make it durable. Must be
                     an existing, non-sensitive dir under your home dir — the
                     startup refuses otherwise (the kernel sandbox + the
                     write/edit path sandbox both re-allow it; siblings and
                     everything else stay denied). C36: the DURABLE baseline is
                     tre.json (nearest above the launch dir, then
                     ~/.tre/tre.json) with { "extraRoots": [ ... ] }; the flag
                     appends to it for this launch. Entries (config or flag)
                     may use ~ or ~/ (expanded against your home dir, like a
                     shell) — e.g. ~/kubeconfigs
  --session <file>   session file: create if absent, resume if present
  --resume <file>    resume an existing session file
  --session-auto     session file under ~/.tre/sessions/ (never inside the repo)
  --skills <dir>     skills dir (repeatable)
  --max-turns <n>    per-run LLM-turn cap (default: derived from the model's
                     contextWindow/maxTokens — hundreds of turns for a large
                     window; the runaway guard is always on)
  --ask              prompt for SENSITIVE + DESTRUCTIVE (workspace-scoped)
                     and mutating bash; read-only bash, reversible
                     git/npm/filesystem ops, and in-workspace write/edit run
                     without a prompt (the pre-auto-approve behavior)
  --yes              (DEFAULT) auto-approve everything except SYSTEMIC
                     sensitive reads + destructive commands (blocked in
                     every mode); workspace-scoped work runs without a
                     prompt
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
restriction) — EXCEPT system-level sensitive material (secret/key paths that
resolve OUTSIDE the workspace: ~/.ssh/, ~/.aws/, ~/.gnupg/, ~/.kube/,
~/.config/gcloud/, ~/.docker/config.json, ~/.netrc, /etc/shadow,
id_rsa*/id_ed25519*, *.pem/*.key/*.p12/*.pfx, .env-family), which is
BLOCKED in every mode (across the board). A sensitive path INSIDE the
workspace (e.g. a project .env) is allowed in the default mode. write/edit
are sandboxed to the project root (--cwd or the process cwd) — paths that
escape it (../, absolute paths, symlinks) are refused. C35: --extra-root
adds explicitly assigned read/write roots (non-sensitive dirs under your
home) to that boundary, for the file tools AND the bash sandbox — ONE-SHOT
(this launch only, never written to tre.json); the durable baseline is
tre.json (C36), which the flag appends to. On macOS
the bash tool runs in the project root under a kernel (Seatbelt) sandbox
with the same boundary; elsewhere it runs in the project root unsandboxed.
Approval (D8): the DEFAULT mode (yes) auto-approves everything except
SYSTEMIC sensitive reads and SYSTEMIC destructive commands (dd to /dev/*,
raw-device redirects, mkfs, fork bomb, shutdown/reboot — inherently
system-wide), which are BLOCKED in every mode. Workspace-scoped destructive
actions (recursive rm, ANY git push, git reset --hard, forced git clean,
git branch -D, git checkout . / checkout -- <path> / git restore) are
allowed in the default mode — the sandbox confines them to the workspace and
the codebase is backed up to git. --ask prompts for those (plus SENSITIVE
and mutating bash) instead; --no-approve allows ONLY read-only,
non-sensitive bash. Anything but y is a denial, and a denial/block comes
back to the model as an error result.

SIGINT during a run aborts the run (second SIGINT exits).`;

export interface MainDeps {
  streamFn?: StreamFn;
  cwd?: string;
  /** Injectable sinks (tests capture output); defaults to the real streams. */
  sinks?: PrintSinks;
  /** Injectable approval prompt (tests); default: a readline question. */
  askApproval?: AskApproval;
  /** Injectable REPL input stream (tests): a fresh Readable per test — the
   *  shared process.stdin can only be pushed-to ONCE (EOF), so multiple
   *  REPL tests in one process would otherwise hit ERR_STREAM_PUSH_AFTER_EOF. */
  stdin?: NodeJS.ReadableStream;
  /** C36: override the tre.json path (tests). undefined = the normal
   *  lookup (nearest tre.json above the launch dir, then ~/.tre/tre.json). */
  treConfigPath?: string;
  /** Telegram driver bridge (tests inject a fake). undefined = the real
   *  spawn-based bridge (enabled only when .tre/telegram.json + the helper
   *  exist). */
  telegramBridge?: TelegramBridge;
  /** Worker registry dir override (tests); undefined uses the shared home registry. */
  workerDir?: string;
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
 * The behavior-settings lines shown at startup: the CURRENT approval mode +
 * sandbox state, what is always blocked (systemic sensitive/destructive),
 * and the OPTIONAL flags that change the behavior. `mode` is the resolved
 * ApprovalMode; `sandboxOn` is whether the kernel sandbox is active;
 * `durableRoots` (C36, from tre.json) and `oneShotRoots` (C35, from the
 * --extra-root flag) are the explicitly assigned additional read/write
 * regions, shown SEPARATELY so the one-shot-vs-durable distinction is
 * unmissable (each is omitted from the summary when empty; a one-shot root
 * also earns a note that it does not persist). The TUI seeds this as a
 * single multi-line info item; the plain CLI prints it to stderr.
 */
export function behaviorSettingsLines(
  mode: ApprovalMode,
  sandboxOn: boolean,
  durableRoots: string[] = [],
  oneShotRoots: string[] = [],
  skills: { name: string; description: string }[] = [],
): string[] {
  const approval =
    mode === "yes"
      ? "auto-approve (default) — workspace-scoped work runs without a prompt"
      : mode === "ask"
        ? "ask — prompt for SENSITIVE + DESTRUCTIVE + mutating bash"
        : "no-approve (fail-closed) — only read-only, non-sensitive bash runs";
  const totalRoots = durableRoots.length + oneShotRoots.length;
  const sandbox = sandboxOn
    ? totalRoots > 0
      ? `on (bash confined to the workspace + extra roots)`
      : "on (bash confined to the workspace)"
    : "off (--no-sandbox)";
  const lines = [
    "Getting started:",
    "  ChatGPT login: tre. login chatgpt (opens a browser; tokens are stored in ~/.tre/chatgpt-auth.json)",
    "  tre. can work with your configured models, inspect and edit project files, run commands, and use available skills.",
    "Behavior:",
    `  approval: ${approval}`,
    `  sandbox:  ${sandbox}`,
  ];
  if (durableRoots.length > 0) {
    lines.push(
      `  extra roots (durable, from tre.json): ${durableRoots.join(", ")}  (read+write, in addition to the workspace)`,
    );
  }
  if (oneShotRoots.length > 0) {
    lines.push(
      `  extra roots (THIS LAUNCH ONLY, --extra-root): ${oneShotRoots.join(", ")}  (read+write, in addition to the workspace)`,
    );
    lines.push(
      "  note: --extra-root is one-shot (this launch only) and is NOT written to tre.json — to make a root durable, add it to tre.json",
    );
  }
  if (skills.length > 0) {
    lines.push(`  skills:   ${skills.length} available`);
    for (const skill of skills) {
      const desc =
        skill.description.length > 60 ? skill.description.slice(0, 60) + "…" : skill.description;
      lines.push(`    · ${skill.name} — ${desc}`);
    }
  }
  lines.push(
    "  blocked:  system-level sensitive reads + destructive commands (across the board)",
    "  optional: --ask (prompt per call) · --no-approve (fail-closed) · --no-sandbox · --extra-root <dir> (one-shot)",
  );
  return lines;
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

  // D15: one-shot auth subcommands run BEFORE any model loading — they do
  // not need a models.json. `login` reads stdin for the manual paste
  // fallback (headless/SSH); `auth status|logout` are pure file ops.
  if (args.command) {
    const { authLogoutCommand, authStatusCommand, makeStdinPrompt, runLoginCommand } =
      await import("./auth-commands.js");
    if (args.command.name === "login") {
      return await runLoginCommand(
        { out: sinks.out, err: sinks.err },
        process.stdin.isTTY ? makeStdinPrompt() : undefined,
      );
    }
    if (args.command.target === "logout") {
      return authLogoutCommand({ out: sinks.out, err: sinks.err });
    }
    return authStatusCommand({ out: sinks.out, err: sinks.err });
  }

  // models (D19: --models wins; otherwise locate — nearest models.json above
  // the launch directory, then the permanent ~/.tre/models.json).
  //
  // Deployability: a fresh checkout / first run on a new machine has no
  // endpoint wired up yet. Rather than a bare "not found" error, the startup
  // prints a step-by-step configuration guide — REQUIRED vs OPTIONAL fields,
  // each REQUIRED field marked populated (show the value) or needed (show a
  // placeholder) — whenever there is NO endpoint configuration populated
  // (no models.json, or the active model's baseUrl is blank).
  const modelsPath = args.modelsPath ?? findModelsFile(undefined, path.resolve(process.cwd()));
  let model: ModelConfig;
  // C34: the full catalog (all models, not just the active one) — the TUI's
  // /models lists + switches across it. Loaded once; the active model is
  // resolved from it below.
  let modelsFile: ReturnType<typeof loadModelsFile>;
  if (modelsPath === null) {
    sinks.err.write(
      buildModelsSetupGuide({}, "~/.tre/models.json (or pass --models <file>)") + "\n",
    );
    return 2;
  }
  // A file that does not even parse (or has no models) cannot be strict-
  // loaded; the lenient reader still tells the guide what is populated.
  const lenient = readActiveModelLenient(modelsPath);
  if (lenient === null || !hasEndpoint(lenient)) {
    sinks.err.write(buildModelsSetupGuide(lenient ?? {}, modelsPath) + "\n");
    return 2;
  }
  try {
    modelsFile = loadModelsFile(modelsPath);
    model = resolveModel(modelsFile, args.modelId);
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
  // C36: durable extra roots — tre.json (nearest above the launch dir, then
  // ~/.tre/tre.json) supplies the baseline; the --extra-root flag APPENDS
  // (per-launch additions). A malformed tre.json refuses the startup
  // (exit 2), like a bad --extra-root — never a silent ignore.
  const treConfigPath =
    deps.treConfigPath ?? findTreConfig(undefined, path.resolve(process.cwd()));
  let configExtraRoots: string[] = [];
  if (treConfigPath !== null) {
    try {
      configExtraRoots = loadTreConfig(treConfigPath).extraRoots;
    } catch (err) {
      sinks.err.write(`error: ${treConfigPath}: ${String(err)}\n`);
      return 2;
    }
  }
  // C35: validate the explicitly assigned extra roots BEFORE wiring anything
  // (fail-closed: a root that would widen the boundary onto a secret surface
  // or outside the home dir refuses the startup). Tracked in two lists so the
  // startup summary can label each: durableRoots (C36, from tre.json — persist
  // across launches) and oneShotRoots (C35, from --extra-root — THIS launch
  // only, never written to tre.json). extraRoots = durable + one-shot is the
  // combined boundary wired into the bash policy / write-edit sandbox / prompt.
  const durableRoots: string[] = [];
  for (let i = 0; i < configExtraRoots.length; i++) {
    const dir = expandTilde(configExtraRoots[i]!);
    const reason = validateExtraRoot(path.resolve(dir));
    if (reason !== undefined) {
      sinks.err.write(`error: ${treConfigPath} extraRoots[${i}]: ${reason}\n`);
      return 2;
    }
    durableRoots.push(path.resolve(dir));
  }
  const oneShotRoots: string[] = [];
  for (let i = 0; i < args.extraRoots.length; i++) {
    const dir = args.extraRoots[i]!;
    const resolved = expandTilde(dir);
    const reason = validateExtraRoot(path.resolve(resolved));
    if (reason !== undefined) {
      sinks.err.write(`error: --extra-root ${dir} (${reason})\n`);
      return 2;
    }
    oneShotRoots.push(path.resolve(resolved));
  }
  const extraRoots: string[] = [...durableRoots, ...oneShotRoots];
  // bash runs in the project root, so its relative paths mean the same
  // thing as the file tools' (the safety hook resolves those against it);
  // on darwin the child is kernel-sandboxed to the same boundary (WS11).
  // C35: extra roots are re-allowed in the per-call kernel policy AND in
  // the write/edit path sandbox — one boundary, both layers.
  const wiredTools = tools.map((t) =>
    t.name === "bash"
      ? createBashTool(root, { sandbox: !args.noSandbox, extraRoots })
      : t,
  );

  // skills
  const skillDirs = args.skillDirs.length > 0 ? args.skillDirs : defaultSkillDirs(root);
  const skills = await loadSkills(skillDirs);

  // system prompt
  let systemPrompt = buildSystemPrompt({
    cwd: root,
    tools: wiredTools,
    model: model.id,
    skills,
    extraRoots,
  });

  // Every interactive TUI run gets a durable session by default. Sessions
  // stay outside repositories (~/.tre/sessions/) so the agent cannot read or
  // edit its own history. Explicit --session/--resume always take precedence;
  // --session-auto retains its existing behavior for non-TUI invocations too.
  const ui: "plain" | "tui" =
    args.ui === "tui" ? "tui" : args.ui === "plain" ? "plain" : process.stdin.isTTY ? "tui" : "plain";
  let autoSessionPath: string | undefined;
  if (args.sessionAuto || (ui === "tui" && !args.sessionPath && !args.resumePath)) {
    autoSessionPath = defaultSessionPath();
    mkdirSync(path.dirname(autoSessionPath), { recursive: true });
    sinks.err.write(`session: ${autoSessionPath}\n`);
  }

  // session (resume / create / --session-auto)
  let session: SessionType | undefined;
  let context: AgentMessage[] = [];
  // A1: session-lifetime calibrated chars-per-token (runTurn refines it
  // from each assistant usage; the REPL carries it across turns).
  let cpt = 4;
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
            model = resolveModel(modelsFile, replayed.model.id);
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

  // D15: route each LLM call to the wire matching the CURRENT model's `api`
  // — chat/completions (local llama.cpp, etc.) vs the OpenAI Responses API
  // (ChatGPT subscription backend). This is what makes mid-session `/models`
  // switches work ACROSS backends: the TUI/REPL re-resolves the active
  // ModelConfig on a switch and passes it to runTurn, and the dispatcher
  // picks the wire per call. Nothing is pinned at startup. `deps.streamFn`
  // (tests) wins.
  const streamFn: StreamFn =
    deps.streamFn ?? makeStreamDispatcher(openAiStream, openAiResponsesStream);

  // WS7: safety hooks (path sandbox + approval gate) wired into the loop's
  // tool pipeline. The DEFAULT mode is "yes" (auto-approve): the kernel
  // sandbox confines bash to the workspace and the codebase is backed up to
  // git, so workspace-scoped work runs without a prompt; only SYSTEMIC
  // (sys) sensitive reads and destructive commands are blocked (across the
  // board). --ask opts into the prompt-per-call behavior; --no-approve is
  // the fail-closed mode (only read-only, non-sensitive bash).
  const mode: ApprovalMode = args.noApprove ? "no" : args.ask ? "ask" : "yes";
  const buildExecutor = (ask: AskApproval) =>
    makeToolExecutor({
      beforeToolCall: makeSafetyHooks({ root, mode, ask, extraRoots }),
    });

  // The behavior-settings summary shown at startup: the CURRENT approval
  // mode + sandbox state, and the OPTIONAL flags that change them. The TUI
  // seeds it as a single multi-line info item; the plain CLI prints it to
  // stderr (below). Durable (tre.json) and one-shot (--extra-root) roots are
  // passed separately so the summary labels each (one-shot is flagged as
  // this-launch-only + not written to tre.json).
  const behavior = behaviorSettingsLines(mode, !args.noSandbox, durableRoots, oneShotRoots, skills);

  // Bare `tre.` (ui "auto"): the Ink TUI on a TTY, the plain REPL when stdin
  // is piped (a pipe has no terminal for raw mode — the REPL is the
  // non-interactive fallback). Explicit `tui` / `--plain` skip this.
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
    const { aggregateSessionUsage, defaultUsageDirs } = await import("../session/session.js");
    // Scan where sessions actually live (~/.tre/sessions, <root>/.tre/sessions,
    // and the delegation worker-log trees in both) — a bare `tre.` writes
    // neither of the flat dirs, so the delegation tree is the real source.
    const historicalModelUsage = await aggregateSessionUsage(defaultUsageDirs(root));
    const code = await runTui({
      historicalModelUsage,
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
      // C34: the full catalog + a prompt rebuild for /models switches (the
      // system prompt embeds the model name, so a switch must rebuild it).
      modelsFile,
      rebuildSystemPrompt: (modelId: string) =>
        buildSystemPrompt({ cwd: root, tools: wiredTools, model: modelId, skills, extraRoots }),
      // D15: static labels for the TUI's /display-bottom fields.
      cwd: root,
      sessionPath: sessionFile,
      // The startup behavior-settings summary — seeded as a single multi-line
      // info item so the user sees the current approval/sandbox behavior and
      // the optional flags before the first prompt.
      startupInfo: behavior.join("\n"),
      deps: { askApproval: deps.askApproval },
      // /restart: re-exec this exact argv (the child resumes the session
      // file automatically). Pass the FULL process.argv — restartCommand
      // strips argv[0] (the node binary); passing a pre-sliced array would
      // drop the entry script (double-slice).
      restartArgs: autoSessionPath && !args.sessionPath && !args.resumePath
        ? [process.argv[0]!, process.argv[1]!, ...process.argv.slice(2).filter((a) => a !== "--session-auto"), "--resume", autoSessionPath]
        : process.argv,
    });
    if (session) await session.close();
    return code;
  }

  // Plain CLI (one-shot + REPL): the TUI shows the behavior summary as an
  // info item, so here it goes to stderr (the transcript sink is the model's
  // context; the behavior summary is for the human).
  for (const line of behavior) sinks.err.write(line + "\n");

  // ── Telegram background driver (plain CLI: one-shot + REPL) ─────────────
  // Long-polls the bot in the background (one getUpdates per cycle, blocking
  // up to 15s). A message STEERS the in-flight turn (if any) or runs a turn
  // + replies (when idle, REPL only). LOOP PREVENTION lives in the driver
  // (long-poll self-pacing + min-interval guard + capped backoff) — see
  // src/telegram/driver.ts. Inert when the bridge is not enabled (no
  // .tre/telegram.json + helper). The driver is created per branch below
  // (one-shot vs REPL) because the executor + turn bookkeeping differ.
  const telegramBridge = deps.telegramBridge ?? makeTelegramBridge(root);
  // The in-flight run's steer sink (the driver's onSteer pushes into it).
  let activeSteer: SteeringQueue | null = null;
  // One steering queue per run — a closure over a plain array (the contract
  // is push/drain; the loop drains before each LLM call).
  const makeSteerQueue = (): SteeringQueue => {
    const state: { q: string[] } = { q: [] };
    return {
      push: (t) => state.q.push(t),
      drain: () => {
        const out = state.q;
        state.q = [];
        return out;
      },
    };
  };
  const telegramInfo = (text: string): void => {
    sinks.err.write(`telegram: ${text}\n`);
  };
  const telegramDriverOpts = {
    onPollError: (err: unknown, delayMs: number) =>
      telegramInfo(`poll error — backing off ${Math.round(delayMs / 1000)}s: ${String(err)}`),
    onHandlerError: (err: unknown) => telegramInfo(`idle-turn error: ${String(err)}`),
  };

  // SIGINT: first aborts the active run, second exits (plain CLI only).
  let controller = new AbortController();
  let active = false;
  let lastInt = 0;
  const onSigint = (): void => {
    if (active) {
      const now = Date.now();
      if (now - lastInt < 2000) {
        telegramDriver?.stop();
        process.exit(130);
      }
      controller.abort();
      lastInt = now;
    } else process.exit(130);
  };
  process.on("SIGINT", onSigint);

  let rl: Interface | undefined;
  // The REPL's background Telegram driver (declared here so the `finally` can
  // stop it — a block-scoped const inside the `try` would be out of scope).
  let telegramDriver: TelegramDriver | undefined;
  try {
    if (args.oneShot) {
      active = true;
      const ask = deps.askApproval ?? makeTempReadlineAsk();
      const executor = buildExecutor(makeInteractiveAsk(ask, sinks.err));
      const steerQueue = makeSteerQueue();
      // The background driver STEERS this one-shot run (a message that arrives
      // mid-run is injected as guidance on the next turn). allowIdleTurns is
      // false: one-shot is a single turn — a message with no run in flight does
      // NOT start a new run. The driver is loop-prevented (see driver.ts).
      const driver = new TelegramDriver(
        telegramBridge,
        { onSteer: (m) => steerQueue.push(`[telegram from ${m.sender}] ${m.text}`) },
        { ...telegramDriverOpts, allowIdleTurns: false },
      );
      void driver.start();
      const workerIdValue = workerId();
      const worker = buildWorkerStatus(workerIdValue, model, root, args.prompt!);
      const dir = deps.workerDir ?? workerDir();
      try {
        try { writeWorkerStatus(dir, worker); } catch { /* Visibility is best-effort. */ }
        const { outcome } = await driver.withTurn(() =>
          runTurn({
            model, systemPrompt, tools: wiredTools, streamFn, controller, context, session,
            prompt: args.prompt!, sinks, maxTurns: args.maxTurns, maxContinuations: args.maxContinuations,
            executeToolCall: executor,
            entryIds, noCompact: args.noCompact, compactKeepTokens: args.compactKeepTokens,
            steeringQueue: steerQueue,
            tap: makeWorkerTap(worker, dir),
          }),
        );
        driver.stop();
        worker.status = workerOutcomeStatus(outcome.stopReason);
        worker.activity = worker.status === "done" ? "done" : outcome.stopReason;
        worker.updatedAt = Date.now();
        try { writeWorkerStatus(dir, worker); } catch { /* Visibility is best-effort. */ }
        await flushSinks(sinks);
        return exitCodeFor(outcome.stopReason);
      } finally {
        // Leave the done/failed status for the TUI to show until its stale-TTL prune.
        driver.stop();
      }
    }

    // REPL
    const r = createInterface({ input: deps.stdin ?? process.stdin, output: process.stdout });
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
    // The REPL's background driver: a message STEERS the in-flight turn
    // (onSteer → activeSteer) or, when idle, runs a turn + replies (onIdle,
    // serialized with user turns by the driver's mutex). Loop-prevented
    // (long-poll self-pacing + min-interval guard + capped backoff — driver.ts).
    const td = new TelegramDriver(
      telegramBridge,
      {
        onSteer: (m) => {
          activeSteer?.push(`[telegram from ${m.sender}] ${m.text}`);
        },
        onIdle: async (msgs) => {
          const prompt = msgs.map((m) => `[telegram from ${m.sender}] ${m.text}`).join("\n");
          // Mirror the user-turn bookkeeping so SIGINT aborts the idle turn
          // (active=true → onSigint aborts `controller`, not exits).
          active = true;
          controller = new AbortController();
          const steerQueue = makeSteerQueue();
          activeSteer = steerQueue;
          try {
            const result = await runTurn({
              model, systemPrompt, tools: wiredTools, streamFn, controller, context, session,
              prompt, sinks, maxTurns: args.maxTurns, maxContinuations: args.maxContinuations,
              executeToolCall: executor,
              entryIds, noCompact: args.noCompact, compactKeepTokens: args.compactKeepTokens,
              charsPerToken: cpt,
              steeringQueue: steerQueue,
            });
            context = result.context;
            cpt = result.charsPerToken;
            const reply = finalAssistantText(result.context);
            await telegramBridge.send(
              reply !== "" ? reply : "I received your message but produced no reply this turn.",
            );
            telegramInfo("replied via the bot");
          } finally {
            active = false;
            lastInt = 0;
            activeSteer = null;
          }
        },
      },
      telegramDriverOpts,
    );
    if (telegramBridge.enabled) {
      telegramInfo(`polling every ${TELEGRAM_LONG_POLL_SEC}s (long-poll; reply via bot)`);
      void td.start();
    }
    telegramDriver = td;
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
      // A6: manual compaction — the same compactNow the auto trigger uses,
      // forced (the trigger check is skipped). The ✂ line prints via the
      // context_compacted event, like the auto path.
      if (prompt === "/compact") {
        if (args.noCompact) {
          sinks.err.write("compact: compaction disabled (--no-compact)\n");
        } else {
          const newCtx = await compactNow({
            streamFn,
            model,
            signal: controller.signal,
            context,
            session,
            ids: entryIds,
            systemPrompt,
            compactKeepTokens: args.compactKeepTokens,
            charsPerToken: cpt,
            force: true,
            sinks,
            onEvent: async (ev) => {
              printEvent(ev, sinks, session?.path);
            },
          });
          if (newCtx === undefined) {
            sinks.err.write("compact: nothing to compact (context too short)\n");
          } else {
            context = newCtx;
          }
        }
        continue;
      }
      // /restart — re-exec the same argv as a child that inherits the
      // terminal, BLOCKING until it exits (spawnSync, no `detached` — same
      // reason as the TUI driver: a detached grandchild is NOT the tty's
      // foreground process group, so once the shell reclaims the terminal
      // the child can't read keyboard input). The child resumes the session
      // file automatically; when it exits, the REPL exits with the child's
      // status (the finally-block cleanup still runs). Only when launched
      // directly as the entry file (a module import has no re-executable
      // argv).
      if (prompt === "/restart") {
        const spec = restartCommand(process.argv, process.env);
        if (spec === null || !isDirectInvocation(process.argv[1], entryPath)) {
          sinks.err.write("restart: not available in this launch — quit and run tre. again\n");
        } else {
          // The child owns the terminal and handles its own SIGINT; drop the
          // REPL's handler for the duration so a Ctrl+C during the child's
          // run isn't acted on by the REPL too (after spawnSync returns).
          process.off("SIGINT", onSigint);
          const result = spawnSync(spec.execPath, spec.args, {
            stdio: "inherit",
            env: spec.env,
          });
          await flushSinks(sinks);
          return result.error ? 1 : (result.status ?? 0);
        }
        continue;
      }
      // /models — switch the active model mid-session (plain REPL). With no
      // argument, list the catalog. The wire follows the new model per call
      // (the dispatcher above picks by `model.api`), so switching between a
      // local chat/completions model and a ChatGPT Responses model works.
      if (prompt === "/models") {
        const lines = modelsFile.models.map((m) =>
          `${m.id === model.id ? "* " : "  "}${m.id}  [${m.api}]`,
        );
        sinks.err.write(`models (active: ${model.id}):\n${lines.join("\n")}\n`);
        continue;
      }
      if (prompt.startsWith("/models ")) {
        const id = prompt.slice("/models ".length).trim();
        try {
          model = resolveModel(modelsFile, id);
          systemPrompt = buildSystemPrompt({ cwd: root, tools: wiredTools, model: model.id, skills, extraRoots });
          sinks.err.write(`model: ${model.id} [${model.api}]\n`);
        } catch (err) {
          sinks.err.write(`model: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        continue;
      }
      if (prompt.startsWith("/")) {
        sinks.err.write(`unknown command: ${prompt}\n`);
        continue;
      }
      controller = new AbortController();
      active = true;
      const steerQueue = makeSteerQueue();
      activeSteer = steerQueue;
      try {
        // Run under the driver's turn mutex so a telegram idle-turn and a user
        // turn never run concurrently on the shared context.
        const result = await td.withTurn(() =>
          runTurn({
            model, systemPrompt, tools: wiredTools, streamFn, controller, context, session,
            prompt, sinks, maxTurns: args.maxTurns, maxContinuations: args.maxContinuations,
            executeToolCall: executor,
            entryIds, noCompact: args.noCompact, compactKeepTokens: args.compactKeepTokens,
            charsPerToken: cpt,
            steeringQueue: steerQueue,
          }),
        );
        context = result.context;
        cpt = result.charsPerToken;
      } finally {
        active = false;
        lastInt = 0;
        activeSteer = null;
      }
    }
    await flushSinks(sinks);
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
    // Stop the background Telegram driver (kills the in-flight poll child and
    // wakes any backoff sleep) so the process can exit cleanly.
    if (telegramBridge.enabled) telegramDriver?.stop();
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
