/**
 * WS4 — skills loader.
 *
 * A skill is a directory containing a `SKILL.md` with (minimal, pi-compatible)
 * YAML frontmatter:
 *
 *   ---
 *   name: my-skill
 *   description: What it does and when to use it.
 *   ---
 *   (body — how to use it)
 *
 * Only the INDEX (name + description + path) goes into the system prompt;
 * the body is read ON DEMAND by the model via the `read` tool — that's the
 * whole design (PLAN.md WS4).
 *
 * Exception: frontmatter `always: true` marks an ALWAYS-ACTIVE skill — its
 * body is included verbatim in the system prompt (see `SkillIndexEntry`).
 * Use it for skills that must be in effect even when the user is absent,
 * e.g. a messaging channel the agent is expected to monitor and answer.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

export interface SkillIndexEntry {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md — the model reads it on demand. */
  filePath: string;
  /** Frontmatter `always: true` → the body is included VERBATIM in the
   *  system prompt. For skills that must be active even when the user is
   *  absent (e.g. a messaging channel the agent is expected to monitor). */
  always?: boolean;
  /** The SKILL.md body (after the frontmatter, trimmed). Present only for
   *  `always` skills — on-demand skills keep the index lean. */
  body?: string;
}

/** Split a SKILL.md into frontmatter + body. Returns `null` when there is no
 *  frontmatter block (the whole file is then the body). The body is
 *  everything after the closing `---` line. */
function splitSkillMd(
  raw: string,
): { fm: Record<string, string>; body: string } | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = raw.slice(3, end);
  const nl = raw.indexOf("\n", end + 1);
  const body = nl === -1 ? "" : raw.slice(nl + 1);
  const out: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const line of block.split("\n")) {
    if (!line.trim()) continue;
    // continuation line (indented) — append to the previous key
    if (/^\s+\S/.test(line) && currentKey) {
      out[currentKey] = `${out[currentKey]} ${line.trim()}`;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) {
      currentKey = m[1]!;
      out[currentKey] = m[2]!.trim().replace(/^["']|["']$/g, "");
    }
  }
  return { fm: out, body };
}

/** Parse one SKILL.md. `fallbackName` = the skill dir's name, used when the
 *  frontmatter omits `name`. Missing description → empty string (the prompt
 *  renders whatever exists; a skill with no description is a lint issue, not
 *  a load failure). Frontmatter `always: true` → the body is captured and
 *  the prompt includes it verbatim (always-active skill). */
export function parseSkillMd(
  filePath: string,
  raw: string,
  fallbackName: string,
): SkillIndexEntry {
  const split = splitSkillMd(raw);
  const fm = split?.fm ?? {};
  const body = (split?.body ?? raw).trim();
  const entry: SkillIndexEntry = {
    name: fm.name && fm.name !== "" ? fm.name : fallbackName,
    description: fm.description ?? "",
    filePath,
  };
  if (fm.always === "true") {
    entry.always = true;
    entry.body = body;
  }
  return entry;
}

/**
 * Scan `skillsDir` for immediate subdirectories containing a `SKILL.md`
 * and return their index entries, sorted by name (deterministic).
 * A missing/unreadable skills dir yields `[]` (skills are optional).
 */
export async function loadSkillsIndex(skillsDir: string): Promise<SkillIndexEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillIndexEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = `${skillsDir}/${entry.name}/SKILL.md`;
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      continue; // no SKILL.md in this dir — not a skill
    }
    out.push(parseSkillMd(filePath, raw, entry.name));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
