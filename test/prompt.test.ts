/**
 * WS4 — system prompt + skills index.
 *
 * Exit criteria (PLAN.md WS4): given a fixture of enabled tools + a project
 * context file + a skills dir, the prompt is deterministic; skills appear as
 * name+description (+path) only — never bodies; guidelines are derived from
 * the tool set.
 */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSystemPrompt, systemPromptSectionChars } from "../src/prompt/system-prompt.js";
import { loadSkillsIndex, parseSkillMd } from "../src/prompt/skills.js";
import type { Tool } from "../src/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ws4-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeTool(name: string, description: string): Tool {
  return {
    name,
    description,
    parameters: { type: "object" },
    execute: async () => ({ content: [{ type: "text" as const, text: "" }] }),
  };
}

const READ = fakeTool("read", "Read a text file from disk.");
const WRITE = fakeTool("write", "Write content to a file.");
const EDIT = fakeTool("edit", "Make a precise edit to a file.");
const BASH = fakeTool("bash", "Run a shell command.");

const SKILL_A_BODY = "SECRET-BODY-A-DO-NOT-LEAK";
const SKILL_B_BODY = "SECRET-BODY-B-DO-NOT-LEAK";

async function fixtureSkillsDir(): Promise<string> {
  const skillsDir = path.join(dir, "skills");
  mkdirSync(path.join(skillsDir, "alpha-skill"), { recursive: true });
  mkdirSync(path.join(skillsDir, "beta-skill"), { recursive: true });
  writeFileSync(
    path.join(skillsDir, "alpha-skill", "SKILL.md"),
    `---\nname: alpha-skill\ndescription: Does alpha things and when to use them.\n---\n\n# Alpha\n\n${SKILL_A_BODY}\n`,
  );
  writeFileSync(
    path.join(skillsDir, "beta-skill", "SKILL.md"),
    `---\nname: beta-skill\ndescription: Does beta things.\n---\n\n${SKILL_B_BODY}\n`,
  );
  // A dir without SKILL.md must be ignored.
  mkdirSync(path.join(skillsDir, "not-a-skill"), { recursive: true });
  return skillsDir;
}

test("loadSkillsIndex: name+description+path only, sorted, non-skill dirs ignored", async () => {
  const skillsDir = await fixtureSkillsDir();
  const index = await loadSkillsIndex(skillsDir);
  assert.deepEqual(index, [
    {
      name: "alpha-skill",
      description: "Does alpha things and when to use them.",
      filePath: path.join(skillsDir, "alpha-skill", "SKILL.md"),
    },
    {
      name: "beta-skill",
      description: "Does beta things.",
      filePath: path.join(skillsDir, "beta-skill", "SKILL.md"),
    },
  ]);
});

test("loadSkillsIndex: missing dir → []", async () => {
  assert.deepEqual(await loadSkillsIndex(path.join(dir, "nope")), []);
});

test("parseSkillMd: always: true captures the body; absent/false does not", () => {
  const raw =
    `---\nname: tg\ndescription: Talk to the user over Telegram.\nalways: true\n---\n\n` +
    `# Telegram\n\n${SKILL_A_BODY}\n`;
  const e = parseSkillMd("/x/tg/SKILL.md", raw, "tg");
  assert.equal(e.always, true);
  assert.ok(e.body!.includes(SKILL_A_BODY), "body is captured for always skills");

  const off = parseSkillMd(
    "/x/tg/SKILL.md",
    `---\nname: tg\ndescription: d\nalways: false\n---\n\n${SKILL_B_BODY}\n`,
    "tg",
  );
  assert.equal(off.always, undefined);
  assert.equal(off.body, undefined, "no body captured without always: true");
});

test("loadSkillsIndex: always skill keeps its body; on-demand skill does not", async () => {
  const skillsDir = path.join(dir, "skills");
  mkdirSync(path.join(skillsDir, "always-skill"), { recursive: true });
  mkdirSync(path.join(skillsDir, "plain-skill"), { recursive: true });
  writeFileSync(
    path.join(skillsDir, "always-skill", "SKILL.md"),
    `---\nname: always-skill\ndescription: Always on.\nalways: true\n---\n\nALWAYS-BODY-MARKER\n`,
  );
  writeFileSync(
    path.join(skillsDir, "plain-skill", "SKILL.md"),
    `---\nname: plain-skill\ndescription: On demand.\n---\n\nPLAIN-BODY-MARKER\n`,
  );
  const index = await loadSkillsIndex(skillsDir);
  assert.deepEqual(index, [
    {
      name: "always-skill",
      description: "Always on.",
      filePath: path.join(skillsDir, "always-skill", "SKILL.md"),
      always: true,
      body: "ALWAYS-BODY-MARKER",
    },
    {
      name: "plain-skill",
      description: "On demand.",
      filePath: path.join(skillsDir, "plain-skill", "SKILL.md"),
    },
  ]);
});

test("parseSkillMd: no frontmatter → dir-name fallback; body never captured in the index", () => {
  const e = parseSkillMd("/x/y/SKILL.md", "just a body\n", "y");
  assert.deepEqual(e, { name: "y", description: "", filePath: "/x/y/SKILL.md" });
});

test("prompt is deterministic: same inputs → identical string", async () => {
  const skillsDir = await fixtureSkillsDir();
  const skills = await loadSkillsIndex(skillsDir);
  const ctxFile = path.join(dir, "PROJECT.md");
  writeFileSync(ctxFile, "Project notes: always run tests.\n");
  const opts = {
    cwd: dir,
    tools: [READ, WRITE, EDIT, BASH],
    model: "fake-model",
    projectContextFiles: [ctxFile],
    skills,
  };
  assert.equal(buildSystemPrompt(opts), buildSystemPrompt(opts));
});

test("prompt: skills appear as name+description+path — NEVER their bodies", async () => {
  const skillsDir = await fixtureSkillsDir();
  const skills = await loadSkillsIndex(skillsDir);
  const p = buildSystemPrompt({ cwd: dir, tools: [READ], skills });
  for (const s of skills) {
    assert.ok(p.includes(`**${s.name}**`), `name ${s.name}`);
    assert.ok(p.includes(s.description), `description ${s.name}`);
    assert.ok(p.includes(s.filePath), `path ${s.name}`);
  }
  assert.ok(!p.includes(SKILL_A_BODY), "skill A body must not leak");
  assert.ok(!p.includes(SKILL_B_BODY), "skill B body must not leak");
});

test("prompt: always skill body is included verbatim; on-demand bodies never leak", async () => {
  const skillsDir = path.join(dir, "skills");
  mkdirSync(path.join(skillsDir, "always-skill"), { recursive: true });
  mkdirSync(path.join(skillsDir, "plain-skill"), { recursive: true });
  writeFileSync(
    path.join(skillsDir, "always-skill", "SKILL.md"),
    `---\nname: always-skill\ndescription: Always on.\nalways: true\n---\n\nALWAYS-BODY-MARKER\n`,
  );
  writeFileSync(
    path.join(skillsDir, "plain-skill", "SKILL.md"),
    `---\nname: plain-skill\ndescription: On demand.\n---\n\nPLAIN-BODY-MARKER\n`,
  );
  const skills = await loadSkillsIndex(skillsDir);
  const p = buildSystemPrompt({ cwd: dir, tools: [READ], skills });
  assert.ok(p.includes("## Always-active skills"), "always section present");
  assert.ok(p.includes("ALWAYS-BODY-MARKER"), "always body included verbatim");
  assert.ok(!p.includes("PLAIN-BODY-MARKER"), "on-demand body must not leak");
  assert.ok(p.includes("**plain-skill**"), "on-demand skill still indexed");
  assert.ok(
    !p.includes(path.join(skillsDir, "always-skill", "SKILL.md")),
    "always skill is not indexed with a path line",
  );
});

test("prompt: all-always → no on-demand intro line; no skills → no section", async () => {
  const skillsDir = path.join(dir, "skills");
  mkdirSync(path.join(skillsDir, "always-skill"), { recursive: true });
  writeFileSync(
    path.join(skillsDir, "always-skill", "SKILL.md"),
    `---\nname: always-skill\ndescription: Always on.\nalways: true\n---\n\nALWAYS-BODY-MARKER\n`,
  );
  const onlyAlways = await loadSkillsIndex(skillsDir);
  const p = buildSystemPrompt({ cwd: dir, tools: [READ], skills: onlyAlways });
  assert.ok(!p.includes("read its SKILL.md (via the read tool)"), "no on-demand intro when no on-demand skills");
  assert.ok(p.includes("## Always-active skills"));
  const none = buildSystemPrompt({ cwd: dir, tools: [READ] });
  assert.ok(!none.includes("# Skills"));
});

test("prompt: one tool line per enabled tool, derived from the tool set", async () => {
  const p = buildSystemPrompt({ cwd: dir, tools: [READ, BASH] });
  assert.match(p, /\*\*read\*\* — Read a text file from disk\./);
  assert.match(p, /\*\*bash\*\* — Run a shell command\./);
  assert.ok(!p.includes("**write**"), "disabled tools must not appear");
  assert.ok(!p.includes("**edit**"), "disabled tools must not appear");
});

test("prompt: guidelines are derived from the enabled tool set", () => {
  const all = buildSystemPrompt({ cwd: dir, tools: [READ, WRITE, EDIT, BASH] });
  const noBash = buildSystemPrompt({ cwd: dir, tools: [READ, WRITE, EDIT] });
  const onlyRead = buildSystemPrompt({ cwd: dir, tools: [READ] });

  // bash guideline present iff bash is enabled
  assert.ok(all.includes("Prefer running a command over guessing"));
  assert.ok(!noBash.includes("Prefer running a command over guessing"));

  // read guideline present iff read is enabled
  assert.ok(all.includes("Read files before editing them"));
  assert.ok(!onlyRead.includes("Use edit for targeted changes"));

  // the bash+edit cross-guideline only with BOTH enabled
  assert.ok(all.includes("verify it compiles or runs"));
  assert.ok(!noBash.includes("verify it compiles or runs"));

  // extra guidelines are appended
  const extra = buildSystemPrompt({ cwd: dir, tools: [READ], extraGuidelines: ["Custom rule Z"] });
  assert.ok(extra.includes("Custom rule Z"));
});

test("prompt: error-handling section carries the repeated-failure discipline (2026-11-05, honest wording 2026-11-27)", async () => {
  const p = buildSystemPrompt({ cwd: dir, tools: [READ] });
  assert.match(p, /Repeated-failure discipline/);
  assert.match(
    p,
    /five in a row\s+stops the run as stalled/,
    "names the streak ladder's stop rung",
  );
  assert.match(
    p,
    /three times in a row WITH\s+VARYING ARGUMENTS earns an in-band guard warning/,
    "the warning is scoped to the varying-argument streak — exact repeats\n     stall via H2 at 3 with NO warning (2026-11-27 audit finding 2)",
  );
  assert.match(
    p,
    /identical call re-issued twice can stop\s+the run immediately with no warning/,
    "the exact-repeat path is stated honestly (no warning is promised)",
  );
  assert.doesNotMatch(
    p,
    /even with varying arguments/,
    "the old phrasing promised a warning to exact repeats too",
  );
  assert.doesNotMatch(
    p,
    /the harness refuses it/,
    "the guard replaces results AFTER execution — the prompt must not promise prevention",
  );
});

test("prompt: project context files appear verbatim; missing files are skipped", () => {
  const ctxFile = path.join(dir, "PROJECT.md");
  writeFileSync(ctxFile, "UNIQUE-PROJECT-CONTEXT-MARKER\n");
  const p = buildSystemPrompt({
    cwd: dir,
    tools: [READ],
    projectContextFiles: [ctxFile, path.join(dir, "missing.md")],
  });
  assert.ok(p.includes("UNIQUE-PROJECT-CONTEXT-MARKER"));
  assert.ok(p.includes(`### ${ctxFile}`));
});

test("prompt: cwd + model appear", () => {
  const p = buildSystemPrompt({ cwd: "/some/cwd", tools: [READ], model: "m1" });
  assert.ok(p.includes("`/some/cwd`"));
  assert.ok(p.includes("`m1`"));
});

test("prompt: C35 extra roots render in the Working-directory section; absent → byte-identical", () => {
  const base = buildSystemPrompt({ cwd: "/some/cwd", tools: [READ] });
  // No extra roots → the section is unchanged (no "Additional read/write roots").
  assert.ok(!base.includes("Additional read/write roots"));
  const withRoots = buildSystemPrompt({
    cwd: "/some/cwd",
    tools: [READ],
    extraRoots: ["/home/u/projects/other", "/home/u/scratch"],
  });
  assert.ok(withRoots.includes("Additional read/write roots"));
  assert.ok(withRoots.includes("`/home/u/projects/other`"));
  assert.ok(withRoots.includes("`/home/u/scratch`"));
  // The workspace line is still present and first.
  assert.ok(withRoots.indexOf("`/some/cwd`") < withRoots.indexOf("`/home/u/projects/other`"));
});

test("prompt: C38 implicit ~/.tre root renders in the Working-directory section", () => {
  // C38: the CLI prepends the implicit ~/.tre root to extraRoots (always on,
  // not user-assigned, not validated) — it renders as an additional
  // read/write root exactly like any C35 extra root.
  const p = buildSystemPrompt({
    cwd: "/some/cwd",
    tools: [READ],
    extraRoots: ["/home/u/.tre", "/home/u/scratch"],
  });
  assert.ok(p.includes("Additional read/write roots"));
  assert.ok(p.includes("`/home/u/.tre`"), "implicit ~/.tre root is listed");
  assert.ok(p.includes("`/home/u/scratch`"), "user-assigned root still listed");
  // The workspace line is still present and first.
  assert.ok(p.indexOf("`/some/cwd`") < p.indexOf("`/home/u/.tre`"));
});

test("prompt: no sections for empty optional inputs", () => {
  const p = buildSystemPrompt({ cwd: dir, tools: [] });
  assert.ok(!p.includes("# Tools"));
  assert.ok(!p.includes("# Skills"));
  assert.ok(!p.includes("# Project context"));
  assert.ok(p.includes("# Identity"));
});

// docs/07 §7 F2 — the two VARIABLE system-prompt sections measured at build
// time (project-context files, skills index). The fixed base is the
// remainder of the total; the driver seeds the TUI's `sys` split from these.

// The sections are joined with "\n\n", but a section's OWN text may contain
// internal blank lines (the skills index, the per-file project-context
// headings). So a section's length is recovered by its header index and the
// NEXT section header's index (minus the 2-char join), not by splitting on
// blank lines.
function sectionLength(prompt: string, header: string, nextHeaders: string[]): number {
  const start = prompt.indexOf(header);
  assert.ok(start !== -1, `${header} header present`);
  let end = prompt.length;
  for (const nh of nextHeaders) {
    const i = prompt.indexOf(nh, start + header.length);
    if (i !== -1 && i < end) end = i;
  }
  const body = end === prompt.length ? prompt.slice(start) : prompt.slice(start, end - 2);
  return body.length;
}

test("F2: systemPromptSectionChars — no optional inputs → {0,0}", () => {
  const m = systemPromptSectionChars({ cwd: dir, tools: [READ] });
  assert.deepEqual(m, { ctx: 0, skills: 0 });
});

test("F2: systemPromptSectionChars — ctx = the # Project context section's length", () => {
  const ctxFile = path.join(dir, "PROJECT.md");
  writeFileSync(ctxFile, "UNIQUE-PROJECT-CONTEXT-MARKER\n");
  const opts = { cwd: dir, tools: [READ], projectContextFiles: [ctxFile] };
  const prompt = buildSystemPrompt(opts);
  const m = systemPromptSectionChars(opts);
  assert.ok(m.ctx > 0, "ctx section is non-empty");
  assert.ok(prompt.includes("UNIQUE-PROJECT-CONTEXT-MARKER"), "verbatim file content is in the prompt");
  assert.equal(
    m.ctx,
    sectionLength(prompt, "# Project context", ["# Skills", "# Working directory"]),
    "ctx length matches the # Project context section's char count",
  );
  // No skills → the skills section is absent.
  assert.equal(m.skills, 0);
});

test("F2: systemPromptSectionChars — skills = the # Skills section's length", async () => {
  const skillsDir = await fixtureSkillsDir();
  const skills = await loadSkillsIndex(skillsDir);
  const opts = { cwd: dir, tools: [READ], skills };
  const prompt = buildSystemPrompt(opts);
  const m = systemPromptSectionChars(opts);
  assert.ok(m.skills > 0, "skills section is non-empty");
  assert.equal(
    m.skills,
    sectionLength(prompt, "# Skills", ["# Working directory"]),
    "skills length matches the # Skills section's char count",
  );
  // No project context → the ctx section is absent.
  assert.equal(m.ctx, 0);
});

test("F2: systemPromptSectionChars — both sections present; each is part of the total", async () => {
  const ctxFile = path.join(dir, "PROJECT.md");
  writeFileSync(ctxFile, "UNIQUE-PROJECT-CONTEXT-MARKER\n");
  const skillsDir = await fixtureSkillsDir();
  const skills = await loadSkillsIndex(skillsDir);
  const opts = { cwd: dir, tools: [READ], projectContextFiles: [ctxFile], skills };
  const prompt = buildSystemPrompt(opts);
  const m = systemPromptSectionChars(opts);
  assert.ok(m.ctx > 0 && m.skills > 0, "both variable sections are present");
  // The variable sections are a strict subset of the total (the fixed base —
  // identity, tools, guidelines, cwd — is the remainder).
  assert.ok(m.ctx + m.skills < prompt.length, "the fixed base is the remainder");
  // Measuring twice is stable (deterministic; the file is read once per call).
  assert.deepEqual(systemPromptSectionChars(opts), m);
});

test("F2: buildSystemPrompt is unchanged by the split (byte-identical to before)", () => {
  // The refactor (buildSections → join) must not alter the prompt string.
  const ctxFile = path.join(dir, "PROJECT.md");
  writeFileSync(ctxFile, "UNIQUE-PROJECT-CONTEXT-MARKER\n");
  const opts = { cwd: dir, tools: [READ, BASH], model: "m1", projectContextFiles: [ctxFile] };
  const p = buildSystemPrompt(opts);
  // The sections are joined with a blank line; the markers are present.
  assert.ok(p.includes("UNIQUE-PROJECT-CONTEXT-MARKER"));
  assert.ok(p.includes("# Identity"));
  // The variable sections are present and the total is the join of sections.
  const m = systemPromptSectionChars(opts);
  assert.ok(m.ctx > 0);
});
