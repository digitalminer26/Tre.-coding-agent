/**
 * C36 — tre.json: durable extra roots.
 *
 * Unit coverage for the config module (parse/load/find — mirrors the
 * D19 models.json test shape) plus the CLI integration: the tre.json
 * baseline + the --extra-root flag append, and the fail-closed startup
 * refusals (malformed file, sensitive / outside-home entries).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findTreConfig,
  loadTreConfig,
  parseTreConfig,
} from "../src/config/tre-config.js";
import { main } from "../src/cli/main.js";
import { fakeStream } from "./fake-stream.js";
import type { ModelConfig } from "../src/types.js";

const MODEL: ModelConfig = {
  id: "fake-model",
  provider: "fake",
  baseUrl: "http://fake.invalid/v1",
  api: "openai-completions",
  contextWindow: 32000,
  maxTokens: 4096,
};

async function workspace(t: test.TestContext): Promise<{ dir: string; models: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const models = path.join(dir, "models.json");
  fs.writeFileSync(models, JSON.stringify({ default: MODEL.id, models: [MODEL] }));
  return { dir, models };
}

function mkSinks() {
  let out = "";
  let err = "";
  return {
    sinks: {
      out: { write: (s: string, cb?: () => void) => { out += s; cb?.(); return true; } },
      err: { write: (s: string, cb?: () => void) => { err += s; cb?.(); return true; } },
    },
    out: () => out,
    err: () => err,
  };
}

/** Escape a path for use as a literal in a RegExp (function form — no $&). */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);

// ─────────────────────────────── parse ───────────────────────────────

test("parseTreConfig: no extraRoots → empty list", () => {
  assert.deepEqual(parseTreConfig("{}"), { extraRoots: [] });
  assert.deepEqual(parseTreConfig('{"extraRoots": []}'), { extraRoots: [] });
});

test("parseTreConfig: a list of dirs is kept in order", () => {
  const c = parseTreConfig('{"extraRoots": ["/a/b", "~/scratch", "rel/dir"]}');
  assert.deepEqual(c.extraRoots, ["/a/b", "~/scratch", "rel/dir"]);
});

test("parseTreConfig: malformed extraRoots → descriptive throw", () => {
  assert.throws(() => parseTreConfig('{"extraRoots": "nope"}'), /'extraRoots' must be an array/);
  assert.throws(() => parseTreConfig('{"extraRoots": [1]}'), /extraRoots\[0\] must be a non-empty/);
  assert.throws(() => parseTreConfig('{"extraRoots": ["  "]}'), /extraRoots\[0\] must be a non-empty/);
  assert.throws(() => parseTreConfig("{ not json"), /JSON/);
});

// ─────────────────────────────── load + find ───────────────────────────────

test("loadTreConfig: reads and parses a file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, "tre.json");
  fs.writeFileSync(p, '{"extraRoots": ["/x"]}');
  assert.deepEqual(loadTreConfig(p), { extraRoots: ["/x"] });
});

test("findTreConfig: explicit path wins even if it does not exist", () => {
  assert.equal(findTreConfig("/nonexistent/nope.json", "/tmp", "/nonhome"), "/nonexistent/nope.json");
});

test("findTreConfig: walks up from the launch directory", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nested = path.join(dir, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  const found = path.join(dir, "tre.json");
  fs.writeFileSync(found, "{}");
  assert.equal(findTreConfig(undefined, nested, "/nonhome"), found);
});

test("findTreConfig: home fallback when nothing above the launch dir", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".tre"), { recursive: true });
  const homeFile = path.join(home, ".tre", "tre.json");
  fs.writeFileSync(homeFile, "{}");
  assert.equal(findTreConfig(undefined, dir, home), homeFile);
});

test("findTreConfig: null when neither walk nor home has one", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(findTreConfig(undefined, dir, path.join(dir, "nohome")), null);
});

// ─────────────────────────── CLI integration ───────────────────────────

test(
  "main: tre.json extraRoots + --extra-root flag → both validated, flag appends",
  {
    // A valid extra root must be an EXISTING dir under home (the C35 guard).
    // The repo root qualifies (it is under ~ and non-sensitive); a sub-dir of
    // it is the flag's root. Skip when the repo is not under home (CI).
    skip:
      !process.env.HOME || !process.cwd().startsWith(process.env.HOME + "/")
        ? "repo is not under $HOME — no valid in-home extra root to point at"
        : false,
  },
  async (t) => {
    const { dir, models } = await workspace(t);
    const extra1 = process.cwd(); // the repo root (durable, from tre.json)
    const extra2 = path.join(process.cwd(), "test"); // a sub-dir (from the flag)
    const cfg = path.join(dir, "tre.json");
    fs.writeFileSync(cfg, JSON.stringify({ extraRoots: [extra1] }));
    const S = mkSinks();
    const code = await main(
      ["run", "x", "--tools", "none", "--models", models, "--extra-root", extra2, "--cwd", dir],
      {
        streamFn: fakeStream([{ type: "text", text: "ok" }]),
        sinks: S.sinks,
        treConfigPath: cfg,
      },
    );
    assert.equal(code, 0, `startup should succeed (stderr: ${S.err()})`);
    // The durable root AND the flag root are both in the boundary summary,
    // in order (tre.json first, then the flag).
    assert.match(S.err(), new RegExp(`extra roots: ${esc(extra1)}, ${esc(extra2)}  \\(read\\+write`));
  },
);

test(
  "main: tre.json with a SENSITIVE extra root → refuses startup (exit 2)",
  {
    // A sensitive dir must be UNDER home to reach the sensitive check (the
    // home check runs first). The repo root is under home; create a temp
    // sensitive-named dir there and remove it after.
    skip:
      !process.env.HOME || !process.cwd().startsWith(process.env.HOME + "/")
        ? "repo is not under $HOME — no in-home sensitive dir to point at"
        : false,
  },
  async (t) => {
    const { dir, models } = await workspace(t);
    // A dir named exactly `.ssh` (the canonical secret surface) under the
    // repo (which is under home, so it reaches the sensitive check). Lives
    // under test/ so a leftover (interrupted test) is a nested dir, not a
    // top-level repo .ssh.
    const ssh = path.join(process.cwd(), "test", ".ssh");
    fs.rmSync(ssh, { recursive: true, force: true });
    fs.mkdirSync(ssh, { recursive: true });
    t.after(() => fs.rmSync(ssh, { recursive: true, force: true }));
    const cfg = path.join(dir, "tre.json");
    fs.writeFileSync(cfg, JSON.stringify({ extraRoots: [ssh] }));
    const S = mkSinks();
    const code = await main(
      ["run", "x", "--tools", "none", "--models", models, "--cwd", dir],
      { streamFn: fakeStream([{ type: "text", text: "ok" }]), sinks: S.sinks, treConfigPath: cfg },
    );
    assert.equal(code, 2);
    assert.match(S.err(), /extraRoots\[0\]/);
    assert.match(S.err(), /sensitive path/);
  },
);

test("main: tre.json with an OUTSIDE-HOME extra root → refuses startup (exit 2)", async (t) => {
  const { dir, models } = await workspace(t);
  const outside = path.join(os.tmpdir(), "tre-cfg-outside-never");
  fs.mkdirSync(outside, { recursive: true });
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const cfg = path.join(dir, "tre.json");
  fs.writeFileSync(cfg, JSON.stringify({ extraRoots: [outside] }));
  const S = mkSinks();
  const code = await main(
    ["run", "x", "--tools", "none", "--models", models, "--cwd", dir],
    { streamFn: fakeStream([{ type: "text", text: "ok" }]), sinks: S.sinks, treConfigPath: cfg },
  );
  assert.equal(code, 2);
  assert.match(S.err(), /outside your home directory/);
});

test("main: tre.json with a MISSING extra root → refuses startup (exit 2)", async (t) => {
  const { dir, models } = await workspace(t);
  const cfg = path.join(dir, "tre.json");
  fs.writeFileSync(cfg, JSON.stringify({ extraRoots: [path.join(dir, "nope")] }));
  const S = mkSinks();
  const code = await main(
    ["run", "x", "--tools", "none", "--models", models, "--cwd", dir],
    { streamFn: fakeStream([{ type: "text", text: "ok" }]), sinks: S.sinks, treConfigPath: cfg },
  );
  assert.equal(code, 2);
  assert.match(S.err(), /does not exist/);
});

test("main: malformed tre.json → refuses startup (exit 2), never a silent ignore", async (t) => {
  const { dir, models } = await workspace(t);
  const cfg = path.join(dir, "tre.json");
  fs.writeFileSync(cfg, '{"extraRoots": "nope"}');
  const S = mkSinks();
  const code = await main(
    ["run", "x", "--tools", "none", "--models", models, "--cwd", dir],
    { streamFn: fakeStream([{ type: "text", text: "ok" }]), sinks: S.sinks, treConfigPath: cfg },
  );
  assert.equal(code, 2);
  assert.match(S.err(), /'extraRoots' must be an array/);
});

test(
  "main: no tre.json → flag-only C35 behavior unchanged (no extra roots)",
  {
    // Hermetic only when the NORMAL lookup (nearest tre.json above the launch
    // dir, then ~/.tre/tre.json) finds nothing — otherwise the user's real
    // config would leak into this test.
    skip: findTreConfig(undefined, process.cwd(), process.env.HOME ?? "") !== null
      ? "a tre.json exists in the normal lookup path — cannot assert 'no config'"
      : false,
  },
  async (t) => {
    const { dir, models } = await workspace(t);
    const S = mkSinks();
    const code = await main(
      ["run", "x", "--tools", "none", "--models", models, "--cwd", dir],
      { streamFn: fakeStream([{ type: "text", text: "ok" }]), sinks: S.sinks },
    );
    assert.equal(code, 0, `startup should succeed (stderr: ${S.err()})`);
    // No extra roots → the summary line is absent.
    assert.doesNotMatch(S.err(), /extra roots:/);
  },
);
