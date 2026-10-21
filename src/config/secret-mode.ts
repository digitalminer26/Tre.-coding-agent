/**
 * M3 (audit 2026-10-21): durable machine-level secret files must not be
 * group-/other-readable. `~/.tre/tre/models.json` (inline apiKeys),
 * `~/.tre/models.json` (legacy), and `~/.tre/telegram.json` (bot token)
 * shipped 0644 on this machine — while `chatgpt-auth.json` was correctly
 * 0600 via token-store's write-time enforcement. Files written by tools
 * OUTSIDE this codebase (the telegram skill's config, hand-edited configs)
 * can't be fixed at write time, so startup enforces the mode: every known
 * secret file that exists with group/other bits set is chmod'd to
 * `mode & 0o600` and a one-line warning is reported (the warn lines are the
 * caller's to print — this module stays I/O-silent except the chmod).
 *
 * The posture mirrors token-store.ts (0600 + mode re-check); this module is
 * the READ-side complement. Never throws: a failed chmod is reported as a
 * warning line (the user must know a secret stayed open), never a crash.
 */
import { chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The known secret files (machine-level), relative to `home`. The price
 *  cache is deliberately NOT here — it holds public catalog data. */
export function secretFilePaths(home: string = homedir()): string[] {
  return [
    join(home, ".tre", "telegram.json"), // bot token
    join(home, ".tre", "tre", "models.json"), // inline apiKeys
    join(home, ".tre", "models.json"), // legacy catalog (apiKeys)
    join(home, ".tre", "chatgpt-auth.json"), // refresh token (already 0600 at write)
    join(home, ".tre", "tokenomics.json"), // ingest token
  ];
}

export interface HardenResult {
  /** Files whose mode was fixed (now `old & 0o600`). */
  readonly fixed: string[];
  /** Human one-liners: what was fixed, and what could NOT be fixed. */
  readonly warnings: string[];
}

/**
 * Chmod every existing secret file with group/other bits set down to
 * `mode & 0o600`. Idempotent (a 0600 file is untouched); missing files are
 * skipped; a chmod failure is a warning, never a throw.
 */
export function hardenSecretFiles(home: string = homedir()): HardenResult {
  const fixed: string[] = [];
  const warnings: string[] = [];
  for (const file of secretFilePaths(home)) {
    let mode: number;
    try {
      mode = statSync(file).mode;
    } catch {
      continue; // missing / unreadable stat — nothing to do
    }
    if ((mode & 0o077) === 0) continue; // already owner-only
    const next = mode & 0o600;
    try {
      chmodSync(file, next);
      fixed.push(file);
      warnings.push(
        `security: ${file} was mode ${(mode & 0o777).toString(8)} ` +
          `(group/other-readable) — tightened to ${(next & 0o777).toString(8)}.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(
        `security WARNING: ${file} is mode ${(mode & 0o777).toString(8)} ` +
          `(group/other-readable) and could NOT be tightened: ${msg}`,
      );
    }
  }
  return { fixed, warnings };
}
