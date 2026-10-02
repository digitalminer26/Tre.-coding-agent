/**
 * Telegram bridge for the TUI driver — a 15-second poller that turns
 * incoming bot messages into agent prompts and routes the agent's replies
 * back to the bot.
 *
 * The LLM endpoint is NOT involved in polling: a poll is one non-blocking
 * HTTPS GET to the Telegram Bot API (`getUpdates`, `timeout: 0`) via the
 * skill's stdlib-`python3` helper. The helper is resolved across the
 * canonical skill roots (`<cwd>/.tre/skills` then `~/.tre/agent/skills`) —
 * see `src/telegram/paths.ts` — so a deployment that installs it in the user
 * agent-skills dir still enables the poller (the 2026-10-02 fix). The LLM is
 * only spent when a real message arrives and a turn runs to answer it.
 * `python3` is the sandbox-safe network path (curl/git TLS is broken under
 * the kernel sandbox; node is not on the sandboxed PATH).
 *
 * The driver owns the timer; this module keeps the pure/async helpers so
 * the driver's lifecycle code stays readable.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveTelegramHelper } from "../telegram/paths.js";

const pExecFile = promisify(execFile);

/** Poll cadence: every 15 seconds while the TUI is open. */
export const TELEGRAM_POLL_MS = 15_000;
/** Hard cap per helper call — a hung network call must not wedge the poller. */
const TELEGRAM_TIMEOUT_MS = 15_000;

export interface TelegramBridge {
  /** True once a `.tre/telegram.json` config exists (setup done). */
  enabled: boolean;
  /**
   * One non-blocking poll. Returns the new messages as `[chatId, sender,
   * text]` tuples, or null when there are none. Throws on a helper failure
   * (the driver logs and retries on the next tick).
   */
  poll(): Promise<[string, string, string][] | null>;
  /** Send `text` to the configured chat (chunked by the helper). */
  send(text: string): Promise<void>;
}

/**
 * Build a bridge for the workspace `cwd`. `enabled` is false when the
 * config is missing (setup not done) — the driver then never starts the
 * timer. The helper resolves its config/state against its OWN cwd, so the
 * spawn pins cwd to the workspace.
 */
export function makeTelegramBridge(cwd: string): TelegramBridge {
  // Resolve the helper across the canonical skill roots (project then user
  // agent-skills) — see src/telegram/paths.ts. The config + state stay
  // cwd-relative (per-workspace deployment state).
  const script = resolveTelegramHelper(cwd);
  const outDir = join(cwd, ".tre", "telegram");
  const enabled =
    existsSync(join(cwd, ".tre", "telegram.json")) && script !== null;
  const run = async (args: string[]): Promise<string> => {
    if (script === null) {
      throw new Error(
        "telegram: helper not found in any skill root " +
          "(<cwd>/.tre/skills or ~/.tre/agent/skills) — the bridge is disabled",
      );
    }
    const { stdout } = await pExecFile("python3", [script, ...args], {
      cwd,
      timeout: TELEGRAM_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  };
  return {
    enabled,
    async poll() {
      const out = (await run(["poll"])).trim();
      if (out === "" || out.startsWith("telegram: no new messages")) return null;
      const msgs: [string, string, string][] = [];
      for (const line of out.split("\n")) {
        const m = line.match(/^\[(\S+) from ([^\]]+)\] (.*)$/);
        if (m) msgs.push([m[1]!, m[2]!, m[3]!]);
      }
      return msgs.length > 0 ? msgs : null;
    },
    async send(text: string) {
      const file = join(outDir, "out.txt");
      // The write tool is workspace-confined, but this is the driver (not the
      // agent under test) — a direct fs write of the message body is the
      // same boundary the skill's send flow uses.
      mkdirSync(outDir, { recursive: true });
      writeFileSync(file, text, "utf8");
      await run(["send", file]);
    },
  };
}
