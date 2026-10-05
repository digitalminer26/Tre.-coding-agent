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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
