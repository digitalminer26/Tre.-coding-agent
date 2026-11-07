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

// ─── Entry ─────────────────────────────────────────────────────────────────

/** Run the activation. Returns the exit code; never throws — a host
 *  setup failure (bad graph, unreadable episode) is reported as exit 1. */
export async function activate(argv: string[], log: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): Promise<number> {
  const parsed = parseActivateArgs(argv);
  if ("help" in parsed) {
    log(USAGE);
    return 0;
  }
  if ("error" in parsed) {
    log(parsed.error);
    log("");
    log(USAGE);
    return 2;
  }
  const args = parsed;

  const deliver = args.telegram
    ? (() => {
        const bridge = makeTelegramBridge(process.cwd());
        if (!bridge.enabled) {
          log("telegram: bridge disabled (no machine config or helper) — escalations disclose as NOT delivered");
        }
        return makeTelegramDeliver(bridge);
      })()
    : undefined;

  try {
    const res = await runHostEpisode({
      graphPath: args.graphPath,
      taskId: args.taskId,
      grantedBy: args.grantedBy,
      ...(args.episodesRoot !== undefined ? { episodesRoot: args.episodesRoot } : {}),
      ...(args.worktreePath !== undefined ? { worktreePath: args.worktreePath } : {}),
      ...(args.workerCommand !== undefined ? { workerCommand: args.workerCommand } : {}),
      ...(args.maxIterations !== undefined ? { maxIterations: args.maxIterations } : {}),
      ...(deliver !== undefined ? { escalationDeliver: deliver } : {}),
      log,
    });
    const r = res.result;
    log(`episode ${res.episodePath} stopped: ${r.stopped}${r.detail !== undefined ? ` (${r.detail})` : ""} iterations=${r.iterations.length} investigations=${r.investigationCount} steer=${res.steerStats.linesRead}/${res.steerStats.injected}`);
    if (r.error !== undefined) {
      log(`loop error: ${r.error.name}: ${r.error.message}`);
    }
    return exitCodeForStop(r.stopped);
  } catch (err) {
    // Host setup failure (before any loop state existed): honest exit 1.
    log(`setup failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return 1;
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
