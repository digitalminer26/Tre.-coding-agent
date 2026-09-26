/**
 * C32 — persistent TUI configuration: the `/display-bottom` selection.
 *
 * The bottom-display selection (D15) used to live only in the TUI's
 * memory — every relaunch started with the bottom lines blank. It is now
 * stored in `~/.tre/tui.json` (the TUI's permanent home, next to
 * models.json and sessions/) and the TUI driver (run.tsx) loads it at
 * startup and saves it after every change, so the layout survives
 * between tre. sessions.
 *
 * I3 throughout: a missing/corrupt/unwritable file is DATA, never a
 * crash. `loadTuiConfig` returns the default (empty selection) and never
 * throws; `saveTuiConfig` is best-effort — a config that cannot be
 * persisted still works for the session's lifetime, it just does not
 * survive the relaunch.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { BOTTOM_FIELDS } from "./state.js";

/** The persisted TUI settings. New keys land here as features grow. */
export interface TuiConfig {
  /** D15: field keys shown in the reserved bottom lines, in order. */
  bottom: string[];
}

export function defaultTuiConfig(): TuiConfig {
  return { bottom: [] };
}

/** The config file's location: `~/.tre/tui.json` (`home` for tests). */
export function tuiConfigPath(home: string = homedir()): string {
  return join(home, ".tre", "tui.json");
}

/**
 * Load the config from `file` (default `~/.tre/tui.json`). A missing
 * file, corrupt JSON, or a non-object top level all yield the DEFAULT
 * config (I3: this function never throws). `bottom` is normalized
 * exactly the way `/display-bottom` normalizes its arguments: non-
 * strings dropped, unknown fields dropped, duplicates removed, order
 * preserved — the field registry (BOTTOM_FIELDS) is the source of
 * truth, so a hand-edited file can never select a field that does not
 * exist.
 */
export function loadTuiConfig(file: string = tuiConfigPath()): TuiConfig {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return defaultTuiConfig();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultTuiConfig();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return defaultTuiConfig();
  }
  const obj = parsed as Record<string, unknown>;
  const bottom = Array.isArray(obj.bottom)
    ? [
        ...new Set(
          obj.bottom.filter(
            (k): k is string =>
              typeof k === "string" && (BOTTOM_FIELDS as readonly string[]).includes(k),
          ),
        ),
      ]
    : [];
  return { bottom };
}

/**
 * Persist `cfg` to `file` (default `~/.tre/tui.json`). Best-effort (I3):
 * the parent directory is created when missing, and ANY write failure
 * (read-only home, disk full) is swallowed — the caller keeps the
 * selection in memory and the TUI keeps working. Returns true when the
 * file was written, false when it could not be.
 */
export function saveTuiConfig(cfg: TuiConfig, file: string = tuiConfigPath()): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}
