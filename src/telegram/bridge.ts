/**
 * Telegram bridge for the PLAIN CLI (one-shot + REPL) — the same stdlib-
 * `python3` helper the TUI uses, resolved across the canonical skill roots
 * (`<cwd>/.tre/skills` then `~/.tre/agent/skills`; see ./paths.ts), but with
 * a LONG-POLL seam (`pollLong`) for the background driver.
 *
 * Why python3 (not node/curl): under the tre. kernel sandbox, curl and git
 * fail TLS and node is not on the sandboxed PATH; python3 (/usr/bin/python3)
 * is on the PATH and its urllib TLS works — verified. The LLM endpoint is
 * NOT involved in polling: a poll is one HTTPS GET to the Telegram Bot API
 * (`getUpdates`); the LLM is only spent when a real message arrives and a
 * turn runs to answer it.
 *
 * The TUI keeps its own bridge (src/tui/telegram.ts) with a non-blocking
 * `setInterval` poller; this one adds `pollLong(timeoutSec, signal)` so the
 * background driver can block up to N seconds per poll (lower latency, fewer
 * spawns) and be interrupted on stop. The spawn logic is intentionally a
 * small duplicate of the TUI's rather than a shared refactor — keeping the
 * TUI untouched (see HANDOFF for the future consolidation).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveTelegramHelper } from "./paths.js";

const pExecFile = promisify(execFile);

/** The poll's long-poll window (seconds) — the driver blocks up to this per
 *  poll, so the loop self-paces (no hot loop). 15s is the default. */
export const TELEGRAM_LONG_POLL_SEC = 15;
/** Hard cap per helper call. The helper's own HTTP read is
 *  `60 + pollTimeoutSec`; this spawn timeout is a BACKSTOP above that (a hung
 *  python process must not wedge the driver). */
const TELEGRAM_SPAWN_MARGIN_MS = 90_000;

export interface TelegramMessage {
  chatId: string;
  sender: string;
  text: string;
}

/** The driver's I/O seam. `pollLong` blocks up to `timeoutSec` for a message
 *  (returning null on timeout) and MUST honor `signal` (the driver kills the
 *  in-flight poll on stop). Throws on a helper failure (the driver backs off). */
export interface TelegramBridge {
  /** True once a `.tre/telegram.json` config + the helper exist (setup done). */
  enabled: boolean;
  /** One long-poll: block up to `timeoutSec` seconds. Null when no message. */
  pollLong(timeoutSec: number, signal?: AbortSignal): Promise<TelegramMessage[] | null>;
  /** Send `text` to the configured chat (chunked by the helper). */
  send(text: string): Promise<void>;
}

/**
 * Build a bridge for the workspace `cwd`. `enabled` is false when the config
 * or the helper is missing (setup not done) — the driver then never starts.
 * The helper resolves its config/state against its OWN cwd, so the spawn pins
 * cwd to the workspace.
 */
export function makeTelegramBridge(cwd: string, home?: string): TelegramBridge {
  // Resolve the helper across the canonical skill roots (project then user
  // agent-skills) — see ./paths.ts. The config + state stay cwd-relative
  // (per-workspace deployment state). `home` is injectable for tests.
  const script = resolveTelegramHelper(cwd, home);
  const outDir = join(cwd, ".tre", "telegram");
  const enabled =
    existsSync(join(cwd, ".tre", "telegram.json")) && script !== null;
  const run = async (args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> => {
    if (script === null) {
      throw new Error(
        "telegram: helper not found in any skill root " +
          "(<cwd>/.tre/skills or ~/.tre/agent/skills) — the bridge is disabled",
      );
    }
    const { stdout } = await pExecFile("python3", [script, ...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      signal, // on abort, node kills the child (the in-flight long-poll ends)
    });
    return stdout;
  };
  const parse = (out: string): TelegramMessage[] | null => {
    const t = out.trim();
    if (t === "" || t.startsWith("telegram: no new messages")) return null;
    const msgs: TelegramMessage[] = [];
    for (const line of out.split("\n")) {
      const m = line.match(/^\[(\S+) from ([^\]]+)\] (.*)$/);
      if (m) msgs.push({ chatId: m[1]!, sender: m[2]!, text: m[3]! });
    }
    return msgs.length > 0 ? msgs : null;
  };
  return {
    enabled,
    async pollLong(timeoutSec, signal) {
      // The spawn timeout is the long-poll window + the helper's HTTP margin
      // + headroom — a backstop, not the primary pacing (the long-poll is).
      const out = await run(
        ["poll", "--timeout", String(timeoutSec)],
        (timeoutSec + 60 + TELEGRAM_SPAWN_MARGIN_MS / 1000) * 1000,
        signal,
      );
      return parse(out);
    },
    async send(text) {
      const file = join(outDir, "out.txt");
      // The write tool is workspace-confined, but this is the driver (not the
      // agent under test) — a direct fs write of the message body is the same
      // boundary the skill's send flow uses.
      mkdirSync(outDir, { recursive: true });
      writeFileSync(file, text, "utf8");
      await run(["send", file], 60_000);
    },
  };
}
