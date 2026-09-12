#!/usr/bin/env node
/**
 * WS6 — CLI / integration seam (PLAN.md §WS6, vertical slice §4).
 *
 * First place all modules meet: models.json (WS1) + system prompt & skills
 * (WS4) + tools (WS3) + loop (WS2) + wire (WS1) + session (WS5).
 *
 * Usage:
 *   coding-agent run "prompt"     one-shot: run to completion, exit
 *   coding-agent                  interactive REPL (one prompt per line)
 *
 * Options:
 *   --model <id>       model id from models.json (default: the file's "default")
 *   --models <file>    models.json path (default: ./models.json)
 *   --tools <list>     comma list of read,write,edit,bash; "all" (default) or "none"
 *   --cwd <dir>        working directory the agent operates in (default: process.cwd())
 *   --session <file>   session file: created if absent, resumed if present
 *   --resume <file>    resume an EXISTING session (error if absent)
 *   --skills <dir>     skills dir (repeatable); defaults: <cwd>/.pi/skills then
 *                      ~/.pi/agent/skills (project skills shadow user skills by name)
 *   --max-turns <n>    per-run LLM-turn safety cap (default: 32)
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
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline";
import { loadModelsFile, resolveModel } from "../config/models.js";
import { openAiStream } from "../wire/openai-completions.js";
import { runLoop } from "../loop/agent-loop.js";
import { buildSystemPrompt } from "../prompt/system-prompt.js";
import { loadSkillsIndex } from "../prompt/skills.js";
import { DEFAULT_TOOLS } from "../tools/index.js";
import {
  Session,
  replaySession,
  type Session as SessionType,
} from "../session/session.js";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  ModelConfig,
  StopReason,
  StreamFn,
  Tool,
  UserMessage,
} from "../types.js";

// ─────────────────────────────── options / parsing ───────────────────────────────

export interface CliOptions {
  oneShot: boolean;
  prompt?: string;
  modelId?: string;
  modelsPath: string;
  tools: string;
  cwd: string;
  sessionPath?: string;
  resumePath?: string;
  skillDirs: string[];
  maxTurns: number;
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
    modelsPath: "./models.json",
    tools: "all",
    cwd: process.cwd(),
    skillDirs: [],
    maxTurns: 32,
    errors: [],
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "run") {
      opts.oneShot = true;
      i++;
    } else if (a === "--model" || a === "--models" || a === "--tools" || a === "--cwd" ||
               a === "--session" || a === "--resume" || a === "--skills" || a === "--max-turns") {
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
      else {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) opts.errors.push("--max-turns must be a positive integer");
        else opts.maxTurns = n;
      }
      i += 2;
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
    opts.errors.push("`run` needs a prompt: coding-agent run \"your prompt\"");
  }
  if (opts.sessionPath && opts.resumePath) {
    opts.errors.push("--session and --resume are mutually exclusive");
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
  onEvent?: (ev: AgentEvent) => void;
  maxTurns?: number;
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
    maxTurns: opts.maxTurns,
  })) {
    opts.onEvent?.(ev);
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
 * to `err`. Thinking deltas are not printed.
 */
export function printEvent(ev: AgentEvent, sinks: PrintSinks): void {
  switch (ev.type) {
    case "text_delta":
      sinks.out.write(ev.delta);
      break;
    case "done":
      if (ev.message.content.some((b) => b.type === "text")) sinks.out.write("\n");
      break;
    case "tool_execution_start":
      sinks.out.write(`\n→ ${ev.toolCall.name} ${oneLine(JSON.stringify(ev.toolCall.arguments), 120)}\n`);
      break;
    case "tool_execution_end": {
      const text = ev.result.content
        .map((c) => c.text)
        .join(" ")
        .replace(/\s+/g, " ");
      sinks.out.write(`  ${ev.result.isError ? "✗" : "✓"} ${oneLine(text, 200)}\n`);
      break;
    }
    case "agent_end":
      if (ev.stopReason === "error") {
        const last = ev.messages[ev.messages.length - 1]!;
        const msg = last.role === "assistant" && last.errorMessage ? last.errorMessage : "provider error";
        sinks.err.write(`\nerror: ${msg}\n`);
      } else if (ev.stopReason === "aborted") {
        sinks.err.write("\naborted\n");
      } else if (ev.stopReason === "length") {
        sinks.err.write("\nlength: output limit hit — tool-call arguments may be truncated\n");
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
 * kill mid-run keeps the prompt), run the loop, then append the run's new
 * messages. Returns { outcome, context }.
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
  maxTurns: number;
}): Promise<{ outcome: RunOutcome; context: AgentMessage[] }> {
  const { controller, context, session } = opts;
  const user: UserMessage = { role: "user", content: opts.prompt, timestamp: Date.now() };
  const seeded: AgentMessage[] = [...context, user];
  if (session) await session.appendMessage(user);

  const outcome = await runAgent({
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    streamFn: opts.streamFn,
    signal: controller.signal,
    initialMessages: seeded,
    onEvent: (ev) => printEvent(ev, opts.sinks),
    maxTurns: opts.maxTurns,
  });

  if (session) {
    for (const m of outcome.messages.slice(seeded.length)) {
      await session.appendMessage(m);
    }
  }
  return { outcome, context: outcome.messages };
}

// ─────────────────────────────────── main ───────────────────────────────────

const HELP = `coding-agent — minimal coding-agent harness

Usage:
  coding-agent run "prompt"     one-shot run (exit when the run ends)
  coding-agent                  interactive REPL

Options:
  --model <id>       model id from models.json (default: the file's "default")
  --models <file>    models.json path (default: ./models.json)
  --tools <list>     read,write,edit,bash — or "all" (default) / "none"
  --cwd <dir>        working directory the agent operates in
  --session <file>   session file: create if absent, resume if present
  --resume <file>    resume an existing session file
  --skills <dir>     skills dir (repeatable)
  --max-turns <n>    per-run LLM-turn cap (default 32)

SIGINT during a run aborts the run (second SIGINT exits).`;

export interface MainDeps {
  streamFn?: StreamFn;
  cwd?: string;
  /** Injectable sinks (tests capture output); defaults to the real streams. */
  sinks?: PrintSinks;
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

  // models
  let model: ModelConfig;
  try {
    model = resolveModel(loadModelsFile(args.modelsPath), args.modelId);
  } catch (err) {
    sinks.err.write(`error: cannot load ${args.modelsPath}: ${String(err)}\n`);
    return 2;
  }

  // tools
  const { tools, error: toolError } = resolveTools(args.tools);
  if (toolError) {
    sinks.err.write(`error: ${toolError}\n`);
    return 2;
  }

  // skills
  const skillDirs = args.skillDirs.length > 0 ? args.skillDirs : defaultSkillDirs(args.cwd);
  const skills = await loadSkills(skillDirs);

  // system prompt
  const systemPrompt = buildSystemPrompt({
    cwd: args.cwd,
    tools,
    model: model.id,
    skills,
  });

  // session (resume / create)
  let session: SessionType | undefined;
  let context: AgentMessage[] = [];
  if (args.resumePath || args.sessionPath) {
    const path = args.resumePath ?? args.sessionPath!;
    try {
      if (args.resumePath || existsSync(path)) {
        const replayed = await replaySession(path);
        session = await Session.open(path);
        context = replayed.context;
        if (replayed.model && !args.modelId) {
          try {
            model = resolveModel(loadModelsFile(args.modelsPath), replayed.model.id);
          } catch {
            sinks.err.write(`note: session model "${replayed.model.id}" not in models.json — using ${model.id}\n`);
          }
        }
        if (replayed.droppedTornTail) {
          sinks.err.write(`note: session ${path} had a torn trailing line — it was dropped\n`);
        }
        sinks.err.write(`resumed ${path}: ${context.length} context message(s)\n`);
      } else {
        session = await Session.create(path, {
          cwd: args.cwd,
          model: { id: model.id, provider: model.provider },
        });
      }
    } catch (err) {
      sinks.err.write(`error: session: ${String(err)}\n`);
      return 2;
    }
  }

  const streamFn = deps.streamFn ?? openAiStream;

  // SIGINT: first aborts the active run, second exits.
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
      const { outcome } = await runTurn({
        model, systemPrompt, tools, streamFn, controller, context, session,
        prompt: args.prompt!, sinks, maxTurns: args.maxTurns,
      });
      await flushSinks(sinks);
      return exitCodeFor(outcome.stopReason);
    }

    // REPL
    const r = createInterface({ input: process.stdin, output: process.stdout });
    rl = r;
    let rlClosed = false;
    r.on("close", () => (rlClosed = true));
    sinks.err.write("coding-agent REPL — /quit to exit, SIGINT aborts the current run\n");
    for (;;) {
      // A piped stdin closes the interface itself at EOF — never call
      // question() on a closed interface (ERR_USE_AFTER_CLOSE).
      if (rlClosed) break;
      const line = await new Promise<string | null>((resolve) =>
        r.question("you> ", (a) => resolve(a)),
      );
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
          model, systemPrompt, tools, streamFn, controller, context, session,
          prompt, sinks, maxTurns: args.maxTurns,
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
