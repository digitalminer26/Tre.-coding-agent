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
import { buildSystemPrompt } from "../src/prompt/system-prompt.js";
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

test("prompt: no sections for empty optional inputs", () => {
  const p = buildSystemPrompt({ cwd: dir, tools: [] });
  assert.ok(!p.includes("# Tools"));
  assert.ok(!p.includes("# Skills"));
  assert.ok(!p.includes("# Project context"));
  assert.ok(p.includes("# Identity"));
});
