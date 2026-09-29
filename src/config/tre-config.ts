/**
 * C36 — tre.json: durable, per-project configuration.
 *
 * The first (and only, for now) field is `extraRoots` (C35 durability): the
 * explicitly assigned additional read/write roots that today must be re-passed
 * as `--extra-root <dir>` on every launch. tre.json persists them, so a
 * project's boundary is part of the project.
 *
 * tre.json shape:
 *   { "extraRoots": [ "/abs/or/~/relative/dir", ... ] }
 *
 * Lookup (mirrors D19's models.json convention): walk UP from the launch
 * directory looking for a `tre.json` — the same convention as a `.git`
 * directory or a `models.json` — then fall back to the permanent home
 * location `~/.tre/tre.json`. A found file is read LENIENTLY: a missing or
 * empty `extraRoots` is an empty list; a malformed value (non-array /
 * non-string entry) is a startup error (exit 2) — the same fail-closed
 * posture as a bad `--extra-root`, never a silent ignore.
 *
 * Precedence: the CLI flag wins — `--extra-root` entries are APPENDED after
 * the tre.json entries (both are validated; a bad tre.json entry refuses the
 * startup just like a bad flag). So tre.json is the durable baseline and the
 * flag is the per-launch override/addition.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface TreConfig {
  /** Durable extra roots (C35). Each entry is validated at startup exactly
   *  like a `--extra-root` value (exists, non-sensitive, under home). */
  extraRoots: string[];
}

/** Parse a tre.json string. Throws a descriptive error on a malformed
 *  `extraRoots` (CLI-level input validation — allowed to throw before any
 *  StreamFn call, like parseModelsFile). */
export function parseTreConfig(raw: string): TreConfig {
  const j = JSON.parse(raw) as { extraRoots?: unknown };
  if (j.extraRoots === undefined) return { extraRoots: [] };
  if (!Array.isArray(j.extraRoots)) {
    throw new Error("tre.json: 'extraRoots' must be an array of directory strings");
  }
  const extraRoots: string[] = [];
  for (const [i, v] of j.extraRoots.entries()) {
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new Error(`tre.json: extraRoots[${i}] must be a non-empty directory string`);
    }
    extraRoots.push(v);
  }
  return { extraRoots };
}

/** Read + parse a tre.json from disk. */
export function loadTreConfig(path: string): TreConfig {
  return parseTreConfig(readFileSync(path, "utf8"));
}

/**
 * C36 — tre.json lookup. `explicit` (tests) wins and is returned as-is, even
 * if missing — the caller reports the error. Otherwise walk UP from `start`
 * (the launch directory, resolved) looking for a `tre.json` — the same
 * convention as models.json — then fall back to the permanent home location
 * `~/.tre/tre.json`. Returns null when nothing is found (no config = no
 * durable extra roots; the flag-only C35 behavior).
 */
export function findTreConfig(
  explicit: string | undefined,
  start: string,
  home: string = homedir(),
): string | null {
  if (explicit !== undefined) return explicit;
  let dir = start;
  for (;;) {
    const candidate = join(dir, "tre.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  const homeFile = join(home, ".tre", "tre.json");
  return existsSync(homeFile) ? homeFile : null;
}
