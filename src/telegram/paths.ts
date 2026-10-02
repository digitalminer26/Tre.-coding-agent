/**
 * Telegram helper-path resolution — shared by the TUI bridge
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
 * Only the HELPER (code) is resolved across roots. The CONFIG
 * (`<cwd>/.tre/telegram.json`) and STATE (`<cwd>/.tre/telegram/`) stay
 * cwd-relative — they are per-workspace deployment state, not code.
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
