/**
 * WS4 — `buildSystemPrompt`: a deterministic system prompt assembled from
 *  - base identity (what this agent is, how it behaves)
 *  - one-liner per ENABLED tool (derived from `tool.description`)
 *  - guidelines DERIVED FROM THE TOOL SET (each enabled tool contributes
 *    its usage guideline; absent tools contribute nothing)
 *  - project-context files, verbatim
 *  - skills INDEX (name + description + path; bodies are read on demand)
 *  - working directory
 *
 * No timestamps, no randomness: same inputs → same string (test-pinned).
 */
import { readFileSync } from "node:fs";
import type { Tool } from "../types.js";
import type { SkillIndexEntry } from "./skills.js";

export interface SystemPromptOptions {
  /** Working directory the agent operates in. */
  cwd: string;
  /** The enabled tools — the prompt's tool section is derived from this. */
  tools: Tool[];
  /** Optional model id (context for the model, e.g. its name). */
  model?: string;
  /** Project-context files included verbatim (missing files are skipped). */
  projectContextFiles?: string[];
  /** Skills index (from `loadSkillsIndex`). */
  skills?: SkillIndexEntry[];
  /** Caller-supplied extra guidelines, appended after the derived ones. */
  extraGuidelines?: string[];
}

/** Guidelines derived from the enabled tool set. Each entry is keyed by the
 *  tool(s) it requires; a tool that isn't enabled contributes nothing. */
const TOOL_GUIDELINES: { requires: string[]; text: string }[] = [
  {
    requires: ["read"],
    text: "Read files before editing them; large files may be truncated with a pointer to continue — follow it.",
  },
  {
    requires: ["edit", "write"],
    text: "Use edit for targeted changes (the oldText must match exactly and uniquely); use write to create or fully overwrite a file.",
  },
  {
    requires: ["bash"],
    text: "Prefer running a command over guessing: check file contents, system state, and command results empirically.",
  },
  {
    requires: ["bash", "edit"],
    text: "After editing code, verify it compiles or runs (e.g. with bash) before declaring the work done.",
  },
];

function deriveGuidelines(tools: Tool[], extra: string[] = []): string[] {
  const names = new Set(tools.map((t) => t.name));
  const out: string[] = [];
  for (const g of TOOL_GUIDELINES) {
    if (g.requires.every((r) => names.has(r))) out.push(g.text);
  }
  out.push(...extra);
  return out;
}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const { cwd, tools, model, projectContextFiles = [], skills = [], extraGuidelines = [] } = opts;
  const sections: string[] = [];

  // 1. base identity
  sections.push(
    [
      "# Identity",
      "",
      "You are a minimal, fully-owned coding agent: a TypeScript harness that",
      "talks to an LLM endpoint and completes tasks by using tools — reading and",
      "writing files, editing code, running shell commands.",
      "You are goal-driven: plan briefly, act with tools, verify results, and",
      "keep responses concise.",
    ].join("\n"),
  );
  if (model) sections.push(`# Model\n\nYou are running as model \`${model}\`.`);

  // 2. tools — one line each, derived from the enabled set
  if (tools.length > 0) {
    const lines = tools.map((t) => `- **${t.name}** — ${t.description}`);
    sections.push(["# Tools", "", ...lines, ""].join("\n"));
  }

  // 3. guidelines — derived from the tool set + extras
  const guidelines = deriveGuidelines(tools, extraGuidelines);
  if (guidelines.length > 0) {
    sections.push(["# Guidelines", "", ...guidelines.map((g) => `- ${g}`), ""].join("\n"));
  }
  sections.push(
    [
      "# Error handling",
      "",
      "Errors are data, not failures: tool results may report problems (missing",
      "files, failed edits, non-zero exit codes). Read the error, adapt, and retry —",
      "do not stop on the first error.",
    ].join("\n"),
  );

  // 4. project context — verbatim, missing files skipped
  const ctxFiles = projectContextFiles
    .map((p) => {
      let raw: string;
      try {
        raw = readFileSync(p, "utf8");
      } catch {
        return null; // missing/unreadable — skip
      }
      return [`### ${p}`, "", raw.replace(/\s+$/, "") + "\n"].join("\n");
    })
    .filter((s): s is string => s !== null);
  if (ctxFiles.length > 0) {
    sections.push(["# Project context", "", ...ctxFiles, ""].join("\n"));
  }

  // 5. skills — INDEX only; bodies are read on demand via the read tool
  if (skills.length > 0) {
    const lines = skills.map(
      (s) => `- **${s.name}** — ${s.description}\n  path: ${s.filePath}`,
    );
    sections.push(
      [
        "# Skills",
        "",
        "Skills provide specialized instructions. When a task matches a skill's",
        "description, read its SKILL.md (via the read tool) BEFORE doing the task.",
        "",
        ...lines,
        "",
      ].join("\n"),
    );
  }

  // 6. working directory
  sections.push(["# Working directory", "", `All relative paths resolve against:\n\`${cwd}\``].join("\n"));

  return sections.join("\n\n");
}
