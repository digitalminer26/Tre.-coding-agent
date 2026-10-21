/**
 * Telegram path resolution — shared by the TUI bridge
 * (`src/tui/telegram.ts`) and the plain-CLI bridge (`src/telegram/bridge.ts`).
 *
 * WHY THIS EXISTS (the 2026-10-02 "message sat undelivered" fix):
 * Both bridges previously probed ONLY `<cwd>/.tre/skills/telegram/telegram.py`
 * for the helper. But the CANONICAL skill roots are the two dirs the skills
 * loader scans (`src/cli/main.ts` defaultSkillsDirs): the project
 * `<cwd>/.tre/skills` (shadows) and the user `~/.tre/agent/skills`. On a
 * machine where the helper is installed in the USER agent-skills dir — the
 * normal place — the bridge's `enabled` check saw "missing" and the poller
 * timer was never started, so incoming bot messages sat in Telegram's queue
 * until a manual poll. Resolving the helper across BOTH roots (and fixing the
 * code, not the deployment) is the durable repair.
 *
 * CONFIG + STATE are MACHINE-LEVEL (the 2026-10-05 "config consistency"
 * cleanup): the bot token + poll offset live under `~/.tre` —
 * `~/.tre/telegram.json` (config) and `~/.tre/telegram/` (state) — NOT in the
 * workspace. tre. is launched from arbitrary directories, so a per-machine
 * credential must not depend on the launch dir; a bot configured once must
 * work from any cwd. Only the HELPER (code) is resolved across skill roots
 * (project shadows user); the config + state are always the machine-level
 * `~/.tre` paths below.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The ALLOWED chat ids — the M2 cross-chat leak fix. A bot's `getUpdates`
 * queue carries messages from EVERY chat that has ever talked to it; the
 * bridges previously fed them all into the agent regardless of the owner's
 * configured `chatId` (a stranger who had found the bot could steer the
 * session, and the reply went to the owner's chat). The helper prints every
 * update it consumes, so the filter lives HERE, at parse time: a message
 * whose chat id is not in this allowlist is dropped before it reaches the
 * model. The offset still advances past it (the helper consumed it) — that
 * is the intended behavior: foreign chats are ignored, not retried.
 *
 * Source: `~/.tre/telegram.json` `chatId` (the chat the bridge SENDS to).
 * An empty/missing chatId means "setup incomplete" → NO chat is allowed
 * (fail closed; the bridges are disabled in that state anyway).
 */
export function telegramAllowedChatIds(home: string = homedir()): Set<string> {
  const ids = new Set<string>();
  try {
    const cfg = JSON.parse(
      readFileSync(telegramConfigPath(home), "utf8"),
    ) as { chatId?: unknown };
    if (typeof cfg.chatId === "string" && cfg.chatId.trim() !== "") {
      ids.add(cfg.chatId.trim());
    }
  } catch {
    // unreadable/invalid config → empty allowlist (fail closed)
  }
  return ids;
}

/**
 * Parse the helper's poll output into messages, DROPPING every line whose
 * chat id is not in `allowed`. This is the single parse point shared by
 * both bridges (the TUI driver and the plain-CLI driver) so the filter
 * cannot drift between them. Returns the surviving messages as
 * `[chatId, sender, text]` tuples in print order.
 */
export function parseTelegramPollOutput(
  out: string,
  allowed: Set<string>,
): [string, string, string][] {
  const msgs: [string, string, string][] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\[(\S+) from ([^\]]+)\] (.*)$/);
    if (!m) continue;
    if (!allowed.has(m[1]!)) continue; // M2: cross-chat leak — drop foreign chats
    msgs.push([m[1]!, m[2]!, m[3]!]);
  }
  return msgs;
}

/**
 * Resolve the telegram helper (`telegram.py`) across the canonical skill
 * roots. Returns the first that exists, or `null` when the helper is not
 * installed in any root. Project shadows user (same order the skills loader
 * uses). `home` is injectable for tests.
 */
export function resolveTelegramHelper(
  cwd: string,
  home: string = homedir(),
): string | null {
  const roots = [
    join(cwd, ".tre", "skills"),
    join(home, ".tre", "agent", "skills"),
  ];
  for (const root of roots) {
    const p = join(root, "telegram", "telegram.py");
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * The machine-level telegram CONFIG path: `~/.tre/telegram.json`.
 * Machine-wide (not workspace-relative) so the bot works from any launch
 * dir. `home` is injectable for tests.
 */
export function telegramConfigPath(home: string = homedir()): string {
  return join(home, ".tre", "telegram.json");
}

/**
 * The machine-level telegram STATE dir: `~/.tre/telegram/` (holds
 * `last_update_id` + `out.txt`). Machine-wide (not workspace-relative).
 * `home` is injectable for tests.
 */
export function telegramStateDir(home: string = homedir()): string {
  return join(home, ".tre", "telegram");
}
