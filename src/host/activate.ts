#!/usr/bin/env node
/**
 * P17 — the activation entry point for the host episode (docs/18 §0.1).
 *
 * `tre.-episode` is the SECOND production entry of this repo: where
 * `tre.` (src/cli/main.ts) is a single agent session, this binary starts
 * ONE supervised recovery episode through the sanctioned host wiring
 * (src/host/supervise.ts → runHostEpisode). It adds NO policy of its
 * own — every authority decision stays with the ledger (P8), the
 * planner (P10), the executor (P11), and the escalation channel (P13).
 *
 * Shape of the thinness (docs/18 §0.1, §8): the composition loop imports
 * NOTHING; the host module (supervise.ts) owns the durable singletons;
 * THIS module is above the host and owns only: argv parsing, the
 * stop-reason → exit-code mapping, the process stderr sink, and the
 * OPTIONAL Telegram delivery wiring (docs/19 §6: enabling delivery was
 * always a host-wiring decision — this flag is that decision made at
 * activation). test/host-activation.test.ts pins the import set of this
 * file: it may import ONLY node: builtins, ./supervise.js, and the two
 * Telegram modules.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runHostEpisode } from "./supervise.js";
import { makeTelegramBridge } from "../telegram/bridge.js";
import { makeTelegramDeliver } from "../telegram/escalation.js";

// ─── Args ──────────────────────────────────────────────────────────────────

export interface ActivateArgs {
  /** Path to the episode graph file (validated on read by the host). */
  graphPath: string;
  /** The task this supervisor loop drives (exactly one, docs/18 §1). */
  taskId: string;
  /** Grant identity for every gate request + journal record (§14.7). */
  grantedBy: string;
  /** Episodes root (S4). Absent → the host default ($HOME/.tre/episodes). */
  episodesRoot?: string;
  /** The task's working tree (W1-C1): worker cwd + evidence identity. */
  worktreePath?: string;
  /** Worker spawn command override (default `tre.`). */
  workerCommand?: string;
  /** P9 merge port (docs/16 §0.6): integration branch the merge advances
   *  (a single git branch-name ELEMENT matching ^[A-Za-z0-9][A-Za-z0-9._-]*$
   *  — P12's SAFE_ID grammar; slash-containing names are refused at parse,
   *  P9 audit cycle-2 F4). Absent = the merge port stays unwired (docs/15 §3). */
  episodeBranch?: string;
  /** P9 audit cycle-2 F3: operator-raised baseline for the integration
   *  executionSeq (recovery after reconciling an act-unknown terminal —
   *  docs/16 §2). Absent = derived from the journal. */
  integrationSeqBump?: number;
  /** Loop-structure cap (docs/18 §3). */
  maxIterations?: number;
  /** Wire the Telegram escalation delivery ACT (docs/19 §5/§6). */
  telegram: boolean;
}

const USAGE = [
  "usage: tre.-episode --graph <file> --task <id> [options]",
  "",
  "Run ONE supervised recovery episode (docs/18) through the host wiring.",
  "",
  "  --graph <file>          the episode graph (validated on read)",
  "  --task <id>             the task the loop drives (exactly one)",
  "  --granted-by <id>       grant identity for gate requests (default: cli-activate)",
  "  --episodes-root <dir>   episodes root (default: $HOME/.tre/episodes)",
  "  --worktree <dir>        the task's working tree (worker cwd + identity)",
  "  --worker <cmd>          worker spawn command (default: tre.)",
  "  --episode-branch <name>  integration branch for the P9 merge port (single branch-name element; absent = merge stays unwired)",
  "  --integration-seq-bump <n>  operator-raised integration seq (act-unknown recovery AFTER reconciling; docs/16 §2)",
  "  --max-iterations <n>    loop-structure cap (default: the loop's own)",
  "  --telegram              wire the Telegram escalation delivery (docs/19 §6)",
  "  --help                  this text",
].join("\n");

/** Parse argv. Returns the args, a help request, or a one-line usage
 *  error (exit 2). */
export type ActivateParse = ActivateArgs | { help: true } | { error: string };

export function parseActivateArgs(argv: string[]): ActivateParse {
  let graphPath: string | undefined;
  let taskId: string | undefined;
  let grantedBy = "cli-activate";
  let episodesRoot: string | undefined;
  let worktreePath: string | undefined;
  let workerCommand: string | undefined;
  let episodeBranch: string | undefined;
  let integrationSeqBump: number | undefined;
  let maxIterations: number | undefined;
  let telegram = false;

  const needValue = (flag: string, value: string | undefined): string | undefined =>
    value === undefined || value.startsWith("--") ? `${flag} requires a value` : undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") return { help: true };
    else if (a === "--graph") {
      const err = needValue(a, argv[i + 1]);
      if (err !== undefined) return { error: err };
      graphPath = argv[++i];
    } else if (a === "--task") {
      const err = needValue(a, argv[i + 1]);
      if (err !== undefined) return { error: err };
      taskId = argv[++i];
    } else if (a === "--granted-by") {
      const err = needValue(a, argv[i + 1]);
      if (err !== undefined) return { error: err };
      grantedBy = argv[++i]!;
    } else if (a === "--episodes-root") {
      const err = needValue(a, argv[i + 1]);
      if (err !== undefined) return { error: err };
      episodesRoot = argv[++i];
    } else if (a === "--worktree") {
      const err = needValue(a, argv[i + 1]);
      if (err !== undefined) return { error: err };
      worktreePath = argv[++i];
    } else if (a === "--worker") {
      const err = needValue(a, argv[i + 1]);
      if (err !== undefined) return { error: err };
      workerCommand = argv[++i];
    } else if (a === "--episode-branch") {
      const err = needValue(a, argv[i + 1]);
      if (err !== undefined) return { error: err };
      episodeBranch = argv[++i];
      // P9 audit cycle-2 F4: the OLD guard was ref-shaped but ADMITTED
      // slash-containing names (`integrate/ep1`), which P12's context
      // validator (SAFE_ID — a SINGLE path element) categorically
      // refuses: the operator ran the whole worker episode only to
      // halt at integration with `context:episodeBranch`. The guard is
      // now the EXACT grammar P12 admits, so a name that would be
      // refused at integration never starts a worker. git's
      // check-ref-format stays the downstream authority for everything
      // this grammar admits (P12 re-checks per call); the policy guards
      // (never `main`, never the `agent` namespace) stay P12's alone.
      if (episodeBranch === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(episodeBranch)) {
        return { error: "--episode-branch must be a single git branch-name element matching ^[A-Za-z0-9][A-Za-z0-9._-]*$ (P12's grammar — no '/', no '..', must start alphanumeric)" };
      }
    } else if (a === "--integration-seq-bump") {
      const raw = argv[i + 1];
      const err = needValue(a, raw);
      if (err !== undefined) return { error: err };
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n < 0) return { error: "--integration-seq-bump must be a non-negative integer" };
      integrationSeqBump = n;
      i++;
    } else if (a === "--max-iterations") {
      const raw = argv[i + 1];
      const err = needValue(a, raw);
      if (err !== undefined) return { error: err };
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) return { error: "--max-iterations must be a positive integer" };
      maxIterations = n;
      i++;
    } else if (a === "--telegram") {
      telegram = true;
    } else {
      return { error: `unknown argument: ${a}` };
    }
  }

  if (graphPath === undefined) return { error: "--graph is required" };
  if (taskId === undefined) return { error: "--task is required" };
  return {
    graphPath,
    taskId,
    grantedBy,
    ...(episodesRoot !== undefined ? { episodesRoot } : {}),
    ...(worktreePath !== undefined ? { worktreePath } : {}),
    ...(workerCommand !== undefined ? { workerCommand } : {}),
    ...(episodeBranch !== undefined ? { episodeBranch } : {}),
    ...(integrationSeqBump !== undefined ? { integrationSeqBump } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    telegram,
  };
}

// ─── Exit codes ────────────────────────────────────────────────────────────

/**
 * Stop reason → process exit code. The mapping is CLOSED (every
 * SupervisorResult stopped value appears; an unmapped value cannot ride
 * out as exit 0):
 *   0 accepted-finish | completed — the episode reached its end-state
 *   3 loop-error                  — the loop itself failed
 *   4 initial-run-denied          — the gate denied before any act
 *   5 every other stop            — bounded/steered non-completion:
 *     halt, hold, parked, shutdown, max-iterations,
 *     escalation-exhausted, finish-unjudged, no-initial-signal
 * (1 is reserved for a THROWING setup failure — bad graph, bad ids —
 * handled by the caller; 2 is a usage error.)
 */
export function exitCodeForStop(stopped: string): number {
  switch (stopped) {
    case "accepted-finish":
    case "completed":
      return 0;
    case "loop-error":
      return 3;
    case "initial-run-denied":
      return 4;
    default:
      return 5;
  }
}

// ─── Log hardening (P18-A2) ───────────────────────────────────────────────

/** P18-A2 (sol audit cycle 1): every operator-visible line this binary
 *  writes crosses here FIRST. The untrusted material reaching the log is
 *  argv verbatim (usage errors echo `--flag <value>`), filesystem paths,
 *  and Error text from the loop — any of which can carry newlines (forging
 *  a second, dispatch-shaped log line), ANSI/control sequences (terminal
 *  takeover of the operator's terminal), or unbounded length. The hardening
 *  is a single-line, control-free, length-bounded, printable-only rendering;
 *  a log line can never execute, paginate, or fake another line. */
export const LOG_LINE_CAP = 1000;
export function sanitizeLogLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  const printable = String(line).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g, "\u2423");
  // P18-C1 F5 (audit): bare \r survived the LF/CRLF pass and a lone CR is
  // a terminal CURSOR-RETURN — "done ✔\r          " visually erases the
  // line in most terminals, which is the same injection class the LF pass
  // exists to stop. A bare CR renders as the same visible ⏎ marker.
  const one = printable.replace(/\r\n|\n|\r/g, " ⏎ ");
  // P18-C2 F9 (sol audit cycle 1): U+2028/U+2029 are LINE SEPARATORS for
  // Unicode-aware viewers/JSON consumers — they must break visibly like
  // LF did. And the bidi controls (U+202A–U+202E, U+2066–U+2069, LRM/RLM)
  // reorder operator-visible text (a U+202E after "rm -" renders the rest
  // of the line in the WRONG visual order). Both render as the same
  // visible ␦ marker — no reordering, no invisible break, no forgery.
  const flat = one
    .replace(/[\u2028\u2029]/g, " ⏎ ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "\u2426");
  if (flat.length <= LOG_LINE_CAP) return flat;
  return `${flat.slice(0, LOG_LINE_CAP - 3)}\u2026`;
}

/** Compose a sink that sanitizes each untrusted line before writing it
 *  (P18-A2). Trusted multi-line text (USAGE) is emitted through the raw
 *  sink by the caller; everything derived from argv/paths/errors goes
 *  through this. */
export function hardenedLog(log: (line: string) => void): (line: string) => void {
  return (line: string) => log(sanitizeLogLine(line));
}

// ─── Entry ─────────────────────────────────────────────────────────────────

/** Run the activation. Returns the exit code; never throws — a host
 *  setup failure (bad graph, unreadable episode, Telegram wiring failure)
 *  is reported as exit 1 (P18-A5: the Telegram factory is INSIDE the
 *  never-throw boundary — before this it could reject the API or crash
 *  the CLI as an unhandled rejection). */
export async function activate(argv: string[], logRaw: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): Promise<number> {
  // P18-C2 F10 (sol audit cycle 1): the never-throw contract covers the
  // WHOLE entry, including its reporting. `logRaw` is caller-supplied and
  // may throw (a closed stderr, a hostile test double) — that must not
  // escape as a rejection, not even while reporting a caught failure.
  // Every sink call is individually firewalled; if even the hardened
  // render throws, the line is dropped (the exit code still returns).
  const log = (line: string): void => {
    try { logRaw(sanitizeLogLine(line)); } catch { /* sink failed: drop, never escape */ }
  };
  const logTrusted = (line: string): void => {
    try { logRaw(line); } catch { /* sink failed: drop, never escape */ }
  };
  try {
    const parsed = parseActivateArgs(argv);
    if ("help" in parsed) {
      logTrusted(USAGE); // trusted, built-in multi-line text
      return 0;
    }
    if ("error" in parsed) {
      log(parsed.error);
      logTrusted("");
      logTrusted(USAGE);
      return 2;
    }
    const args = parsed;

    let deliver: ReturnType<typeof makeTelegramDeliver> | undefined;
    try {
      deliver = args.telegram
        ? (() => {
            const bridge = makeTelegramBridge(process.cwd());
            if (!bridge.enabled) {
              log("telegram: bridge disabled (no machine config or helper) — escalations disclose as NOT delivered");
            }
            return makeTelegramDeliver(bridge);
          })()
        : undefined;
    } catch (err) {
      // P18-A5: setup (bridge construction) failed — honest exit 1, still
      // inside the never-throw contract.
      log(`setup failed: ${safeErrText(err)}`);
      return 1;
    }

    try {
      const res = await runHostEpisode({
        graphPath: args.graphPath,
        taskId: args.taskId,
        grantedBy: args.grantedBy,
        ...(args.episodesRoot !== undefined ? { episodesRoot: args.episodesRoot } : {}),
        ...(args.worktreePath !== undefined ? { worktreePath: args.worktreePath } : {}),
        ...(args.workerCommand !== undefined ? { workerCommand: args.workerCommand } : {}),
        ...(args.episodeBranch !== undefined ? { episodeBranch: args.episodeBranch } : {}),
        ...(args.integrationSeqBump !== undefined ? { integrationSeqBump: args.integrationSeqBump } : {}),
        ...(args.maxIterations !== undefined ? { maxIterations: args.maxIterations } : {}),
        ...(deliver !== undefined ? { escalationDeliver: deliver } : {}),
        log,
      });
      const r = res.result;
      log(`episode ${res.episodePath} stopped: ${r.stopped}${r.detail !== undefined ? ` (${r.detail})` : ""} iterations=${r.iterations.length} investigations=${r.investigationCount} steer=${res.steerStats.linesRead}/${res.steerStats.injected}`);
      if (r.error !== undefined) {
        log(`loop error: ${safeErrText(r.error)}`);
      }
      return exitCodeForStop(r.stopped);
    } catch (err) {
      // Host setup failure (before any loop state existed): honest exit 1.
      log(`setup failed: ${safeErrText(err)}`);
      return 1;
    }
  } catch (err) {
    // P18-C2 F10: the LAST firewall — argument parsing, the usage path,
    // or anything above that throws (a trapping argv element reaching a
    // sink) is reported through the firewalled log and exits 1. activate
    // resolves with a code; it never rejects.
    log(`activation error: ${safeErrText(err)}`);
    return 1;
  }
}

/** F10: render a caught value for the log WITHOUT trusting it — `name`
 *  and `message` are getter-attackable on a hostile Error, and a plain
 *  value's `toString` may throw. This runs inside catch blocks, so it
 *  must never throw itself. */
function safeErrText(err: unknown): string {
  try {
    if (err instanceof Error) {
      let name = "Error";
      try { if (typeof err.name === "string") name = err.name; } catch { /* trapped name */ }
      let message = "";
      try { if (typeof err.message === "string") message = err.message; } catch { /* trapped message */ }
      return `${name}: ${message}`;
    }
    if (err !== null && typeof err === "object") {
      // A plain {name, message} pair (the loop's stop-result error shape)
      // must render as before, with each property read through its guard.
      let name: string | undefined;
      let message: string | undefined;
      try { if (typeof (err as { name?: unknown }).name === "string") name = (err as { name: string }).name; } catch { /* trapped */ }
      try { if (typeof (err as { message?: unknown }).message === "string") message = (err as { message: string }).message; } catch { /* trapped */ }
      if (name !== undefined || message !== undefined) return `${name ?? "error"}: ${message ?? ""}`;
    }
    return String(err);
  } catch {
    return "unprintable error";
  }
}

// `node dist/src/host/activate.js ...` (or via the npm bin shim — argv[1]
// is the symlink, so compare realpath). When imported by tests, this stays
// false.
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
  void activate(process.argv.slice(2)).then((code) => process.exit(code));
}
