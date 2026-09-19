/**
 * WS7 — safety & permissions (PLAN.md §WS7).
 *
 *   - path sandbox: lexical (../, absolute) and realpath (symlink) escapes
 *   - approval gate: ask / yes / no modes; a denial is a block reason
 *   - destructive bash classification (D8): confirmed even under --yes
 *   - pipeline integration: a blocked call becomes an isError ToolResult
 *     whose text is the block reason — the exact contract the loop feeds
 *     back to the model (I3: data, not a throw).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bashOutsidePaths,
  checkPathWithinRoot,
  destructiveBashPatterns,
  makeSafetyHooks,
  makeAskQueue,
} from "../src/tools/safety.js";
import { makeToolExecutor } from "../src/tools/pipeline.js";
import { bashTool } from "../src/tools/bash.js";
import { readTool, writeTool } from "../src/tools/index.js";
import type { Tool, ToolCallBlock } from "../src/types.js";

type Decision = { args?: Record<string, unknown> } | { blocked: string } | undefined;

/** Temp workspace: base/{root,outside}; root is the sandbox boundary. */
async function tmpWorkspace(): Promise<{
  root: string;
  outside: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), "om-safety-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { root, outside, cleanup: () => rm(base, { recursive: true, force: true }) };
}

/** Test-context-aware wrapper: registers cleanup via t.after. */
async function ws(t: { after: (fn: () => void | Promise<void>) => void }): Promise<{ root: string; outside: string }> {
  const w = await tmpWorkspace();
  t.after(() => w.cleanup());
  return { root: w.root, outside: w.outside };
}

const call = (name: string, arguments_: Record<string, unknown>, id = "c1"): ToolCallBlock => ({
  type: "toolCall",
  id,
  name,
  arguments: arguments_,
});

const blockedOf = (r: Decision): string | undefined =>
  r && "blocked" in r ? r.blocked : undefined;
const argsOf = (r: Decision): Record<string, unknown> | undefined =>
  r && "args" in r ? r.args : undefined;

// ─────────────────────────────── path sandbox ───────────────────────────────

test("checkPathWithinRoot: relative path inside root → ok + rewritten", async (t) => {
  const { root } = await ws(t);
  const r = await checkPathWithinRoot(root, "a/b.txt");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.path, resolve(root, "a/b.txt"));
});

test("checkPathWithinRoot: a/.. collapse that stays inside → ok", async (t) => {
  const { root } = await ws(t);
  const r = await checkPathWithinRoot(root, "a/../b.txt");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.path, join(root, "b.txt"));
});

test("checkPathWithinRoot: ../ escape → refused", async (t) => {
  const { root, outside } = await ws(t);
  await writeFile(join(outside, "evil.txt"), "x");
  const r = await checkPathWithinRoot(root, "../outside/evil.txt");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /outside the project root/);
});

test("checkPathWithinRoot: absolute path outside → refused", async (t) => {
  const { root, outside } = await ws(t);
  const r = await checkPathWithinRoot(root, join(outside, "x.txt"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /outside the project root/);
});

test("checkPathWithinRoot: symlink to a dir outside → refused", async (t) => {
  const { root, outside } = await ws(t);
  await writeFile(join(outside, "evil.txt"), "x");
  await symlink(outside, join(root, "link"));
  const r = await checkPathWithinRoot(root, "link/evil.txt");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /symlink/);
});

test("checkPathWithinRoot: symlink INSIDE the root → allowed", async (t) => {
  const { root } = await ws(t);
  await writeFile(join(root, "real.txt"), "x");
  await symlink(join(root, "real.txt"), join(root, "inlink"));
  const r = await checkPathWithinRoot(root, "inlink");
  assert.equal(r.ok, true);
});

test("checkPathWithinRoot: root does not exist → refused (fail-closed)", async (t) => {
  const { root } = await ws(t);
  const r = await checkPathWithinRoot(join(root, "missing"), "x.txt");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /does not exist/);
});

// ─────────────────────── destructive bash patterns (D8) ───────────────────────

test("destructiveBashPatterns: recursive rm (all spellings)", () => {
  assert.deepEqual(destructiveBashPatterns("rm -rf /tmp/x"), ["recursive rm"]);
  assert.deepEqual(destructiveBashPatterns("rm -r dir"), ["recursive rm"]);
  assert.deepEqual(destructiveBashPatterns("rm -R /"), ["recursive rm"]);
  assert.deepEqual(destructiveBashPatterns("rm --recursive --force x"), ["recursive rm"]);
  assert.deepEqual(destructiveBashPatterns("sudo rm -fr /etc/passwd"), ["recursive rm"]);
  assert.deepEqual(destructiveBashPatterns("/bin/rm -rf /"), ["recursive rm"]);
});

test("destructiveBashPatterns: non-recursive rm is NOT destructive", () => {
  assert.deepEqual(destructiveBashPatterns("rm file.txt"), []);
  assert.deepEqual(destructiveBashPatterns("rm -f file.txt"), []);
});

test("destructiveBashPatterns: force-push variants", () => {
  assert.deepEqual(destructiveBashPatterns("git push -f origin main"), ["git push --force"]);
  assert.deepEqual(destructiveBashPatterns("git push --force origin main"), ["git push --force"]);
  assert.deepEqual(
    destructiveBashPatterns("git push --force-with-lease origin main"),
    ["git push --force"],
  );
  assert.deepEqual(destructiveBashPatterns("git push origin main"), []);
});

test("destructiveBashPatterns: raw device writes", () => {
  assert.deepEqual(
    destructiveBashPatterns("dd if=/dev/zero of=/dev/sda"),
    ["dd writing to a raw device"],
  );
  assert.deepEqual(
    destructiveBashPatterns("dd if=/dev/zero of=/dev/sda bs=1M"),
    ["dd writing to a raw device"],
  );
  assert.deepEqual(destructiveBashPatterns("dd if=/dev/zero of=file.img"), []);
  assert.deepEqual(destructiveBashPatterns("echo x > /dev/sda"), ["write to a raw block device"]);
  assert.deepEqual(
    destructiveBashPatterns("cat foo > /dev/nvme0n1p1"),
    ["write to a raw block device"],
  );
});

test("destructiveBashPatterns: mkfs / fork bomb / power", () => {
  assert.deepEqual(destructiveBashPatterns("mkfs.ext4 /dev/sdb1"), ["mkfs (filesystem creation)"]);
  assert.deepEqual(destructiveBashPatterns(":(){ :|:& };:"), ["fork bomb"]);
  assert.deepEqual(destructiveBashPatterns("shutdown -h now"), ["system shutdown/reboot"]);
  assert.deepEqual(destructiveBashPatterns("reboot"), ["system shutdown/reboot"]);
});

test("destructiveBashPatterns: innocuous commands → no hits", () => {
  assert.deepEqual(destructiveBashPatterns("ls -la"), []);
  assert.deepEqual(destructiveBashPatterns("echo hello && pwd"), []);
  assert.deepEqual(destructiveBashPatterns("git commit -m 'add feature'"), []);
});

test("destructiveBashPatterns: over-triggering is documented (echoed rm)", () => {
  // Over-prompting is safe; under-prompting is not: even a bare echo of the
  // command text triggers the classifier.
  assert.deepEqual(destructiveBashPatterns("echo rm -rf /"), ["recursive rm"]);
});

// ─────────────────────────────── approval gate ───────────────────────────────

test("mode ask: bash denied → block reason; nothing executed", async (t) => {
  const { root } = await ws(t);
  const hooks = makeSafetyHooks({ root, mode: "ask", ask: async () => false });
  const r = await hooks(bashTool, call("bash", { command: "echo hi" }));
  assert.ok(blockedOf(r));
  assert.match(blockedOf(r)!, /denied/);
});

test("mode ask: bash approved → allow (undefined)", async (t) => {
  const { root } = await ws(t);
  const hooks = makeSafetyHooks({ root, mode: "ask", ask: async () => true });
  const r = await hooks(bashTool, call("bash", { command: "echo hi" }));
  assert.equal(r, undefined);
});

test("mode ask: read is NOT gated — never asked, path rewritten", async (t) => {
  const { root } = await ws(t);
  let asked = 0;
  const hooks = makeSafetyHooks({
    root,
    mode: "ask",
    ask: async () => {
      asked++;
      return true;
    },
  });
  const r = await hooks(readTool, call("read", { path: "sub/a.txt" }));
  assert.equal(asked, 0);
  assert.ok(argsOf(r));
  assert.equal(argsOf(r)!.path, join(root, "sub", "a.txt"));
});

test("mode yes: non-destructive bash/write auto-approve (ask never called)", async (t) => {
  const { root } = await ws(t);
  let asked = 0;
  const hooks = makeSafetyHooks({
    root,
    mode: "yes",
    ask: async () => {
      asked++;
      return true;
    },
  });
  assert.equal(await hooks(bashTool, call("bash", { command: "ls" })), undefined);
  // write/edit are path tools — the hook rewrites the path even under
  // "yes" (that rewrite is what makes --cwd work).
  const r = await hooks(writeTool, call("write", { path: "a.txt", content: "x" }));
  assert.ok(argsOf(r));
  assert.equal(argsOf(r)!.path, join(root, "a.txt"));
  assert.equal(asked, 0);
});

test("mode yes: destructive bash still confirms; denial → blocked", async (t) => {
  const { root } = await ws(t);
  const hooks = makeSafetyHooks({ root, mode: "yes", ask: async () => false });
  const r = await hooks(bashTool, call("bash", { command: "rm -rf /" }));
  assert.ok(blockedOf(r));
  assert.match(blockedOf(r)!, /destructive/i);
  assert.match(blockedOf(r)!, /recursive rm/);
});

test("mode yes: destructive bash confirmed → allow", async (t) => {
  const { root } = await ws(t);
  let asked = 0;
  const hooks = makeSafetyHooks({
    root,
    mode: "yes",
    ask: async () => {
      asked++;
      return true;
    },
  });
  assert.equal(await hooks(bashTool, call("bash", { command: "rm -rf /" })), undefined);
  assert.equal(asked, 1);
});

test("mode no: gated tools blocked without prompting", async (t) => {
  const { root } = await ws(t);
  let asked = 0;
  const hooks = makeSafetyHooks({
    root,
    mode: "no",
    ask: async () => {
      asked++;
      return true;
    },
  });
  const r = await hooks(bashTool, call("bash", { command: "ls" }));
  assert.ok(blockedOf(r));
  assert.match(blockedOf(r)!, /no-approve/);
  assert.equal(asked, 0);
});

test("mode no: read still works (sandboxed, ungated)", async (t) => {
  const { root } = await ws(t);
  const hooks = makeSafetyHooks({ root, mode: "no" });
  const r = await hooks(readTool, call("read", { path: "a.txt" }));
  assert.ok(argsOf(r));
});

test("sandbox applies in every mode: --yes cannot write outside the root", async (t) => {
  const { root, outside } = await ws(t);
  const hooks = makeSafetyHooks({ root, mode: "yes" });
  const r = await hooks(writeTool, call("write", { path: join(outside, "evil.txt"), content: "x" }));
  assert.ok(blockedOf(r));
  assert.match(blockedOf(r)!, /outside the project root/);
});

test("missing path argument → blocked (validation layer is defense-in-depth)", async (t) => {
  const { root } = await ws(t);
  const hooks = makeSafetyHooks({ root, mode: "yes" });
  const r = await hooks(writeTool, call("write", { content: "x" }));
  assert.ok(blockedOf(r));
  assert.match(blockedOf(r)!, /missing required string argument "path"/);
});

test("a throwing ask() is treated as denial (fail-closed)", async (t) => {
  const { root } = await ws(t);
  const hooks = makeSafetyHooks({
    root,
    mode: "ask",
    ask: async () => {
      throw new Error("stdin gone");
    },
  });
  const r = await hooks(bashTool, call("bash", { command: "ls" }));
  assert.ok(blockedOf(r));
  assert.match(blockedOf(r)!, /denied/);
});

test("makeAskQueue: serializes prompts FIFO", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const order: number[] = [];
  let gate: () => void;
  const release = new Promise<void>((r) => (gate = r));
  const inner = (q: string) =>
    new Promise<boolean>((resolve) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(Number(q));
      void release.then(() => {
        inFlight--;
        resolve(true);
      });
    });
  const ask = makeAskQueue(inner);
  // The gate must release BEFORE awaiting — the queued prompts are what
  // the await is waiting for (releasing after the await is a deadlock).
  const resultsPromise = Promise.all([ask("1"), ask("2"), ask("3")]);
  setTimeout(() => gate!(), 0);
  const results = await resultsPromise;
  assert.deepEqual(results, [true, true, true]);
  assert.equal(maxInFlight, 1, "only one prompt on screen at a time");
  assert.deepEqual(order, [1, 2, 3], "FIFO order");
});

// ───────────────────────── pipeline integration (I3) ─────────────────────────

const sig = () => new AbortController().signal;

test("blocked bash → isError result whose text IS the block reason", async (t) => {
  const { root } = await ws(t);
  const hooks = makeSafetyHooks({ root, mode: "ask", ask: async () => false });
  const exec = makeToolExecutor({ beforeToolCall: hooks });
  const res = await exec(bashTool, call("bash", { command: "echo hi" }), sig());
  assert.equal(res.isError, true);
  const text = res.content.map((c) => c.text).join(" ");
  assert.match(text, /Tool "bash" was blocked/);
  assert.match(text, /denied/);
});

test("approved bash actually executes", async (t) => {
  const { root } = await ws(t);
  const hooks = makeSafetyHooks({ root, mode: "ask", ask: async () => true });
  const exec = makeToolExecutor({ beforeToolCall: hooks });
  const res = await exec(bashTool, call("bash", { command: "echo approved-here" }), sig());
  assert.ok(!res.isError, "a successful call is not an error result");
  assert.match(res.content.map((c) => c.text).join(" "), /approved-here/);
});

test("sandbox rewrite reaches the tool: write lands under the root", async (t) => {
  const { root } = await ws(t);
  const hooks = makeSafetyHooks({ root, mode: "ask", ask: async () => true });
  const exec = makeToolExecutor({ beforeToolCall: hooks });
  const res = await exec(
    writeTool,
    call("write", { path: "deep/a.txt", content: "under root" }),
    sig(),
  );
  assert.ok(!res.isError, "an approved write is not an error result");
  const onDisk = await readFile(join(root, "deep", "a.txt"), "utf8");
  assert.equal(onDisk, "under root");
});

test("sandbox refusal: write outside never touches the disk", async (t) => {
  const { root, outside } = await ws(t);
  const hooks = makeSafetyHooks({ root, mode: "yes" });
  const exec = makeToolExecutor({ beforeToolCall: hooks });
  const res = await exec(
    writeTool,
    call("write", { path: "../outside/evil.txt", content: "x" }),
    sig(),
  );
  assert.equal(res.isError, true);
  await assert.rejects(readFile(join(outside, "evil.txt"), "utf8"));
});

/** A stub tool to prove the hook also applies to unknown/extra tools. */
const stubTool: Tool = {
  name: "stub",
  description: "stub",
  parameters: { type: "object", properties: {} },
  async execute() {
    return { content: [{ type: "text", text: "ran" }] };
  },
};

test("non-gated, non-path tools pass through untouched", async (t) => {
  const { root } = await ws(t);
  const hooks = makeSafetyHooks({ root, mode: "no" });
  const r = await hooks(stubTool, call("stub", {}));
  assert.equal(r, undefined);
});

// ─────────────────────────── D13: workspace-scoped (local) mode ───────────────────────────

/** bashOutsidePaths unit tests — root is a fixed string, no fs needed. */
test("bashOutsidePaths: workspace-relative and system-safe paths → []", () => {
  const root = "/w";
  const inside = [
    "ls", "ls src/", "npm ci", "git status",
    "cat src/a.ts", "mkdir -p build && touch build/x.txt",
    "echo hi > notes.txt", "echo hi >> build/log.txt",
    "cat $PWD/x.txt", "cat ${PWD}/x.txt",
    "cat /tmp/x.log", "cat /private/tmp/x.log",
    "cat /var/folders/ab/cd/x", 
    "cat /usr/bin/node", "cat /System/Library/CoreServices/SystemVersion.plist",
    "cat /opt/homebrew/bin/node", "cat /Library/Preferences/com.apple.plist",
    "touch /dev/null", "cat /dev/null",
    "cat 2>&1", "echo ok > /dev/null",
  ];
  for (const cmd of inside) {
    assert.deepEqual(bashOutsidePaths(cmd, root), [], `expected inside: ${cmd}`);
  }
});

test("bashOutsidePaths: paths outside the safe locations are listed", () => {
  const root = "/w";
  const home = process.env.HOME!;
  assert.deepEqual(bashOutsidePaths("cat /etc/hosts", root), ["/etc/hosts"]);
  assert.deepEqual(bashOutsidePaths("echo hi >/etc/hosts", root), ["/etc/hosts"]);
  assert.deepEqual(bashOutsidePaths("echo hi > /etc/hosts", root), ["/etc/hosts"]);
  assert.deepEqual(bashOutsidePaths("cat < /etc/passwd", root), ["/etc/passwd"]);
  assert.deepEqual(bashOutsidePaths("cp /etc/hosts /tmp/copy", root), ["/etc/hosts"]);
  assert.deepEqual(bashOutsidePaths(`cat ${home}/notes.txt`, root), [`${home}/notes.txt`]);
  assert.deepEqual(bashOutsidePaths("cat ~/notes.txt", root), [`${home}/notes.txt`]);
  assert.deepEqual(bashOutsidePaths("cat $HOME/notes.txt", root), [`${home}/notes.txt`]);
  assert.deepEqual(bashOutsidePaths("cat $HOME/x.txt $PWD/y.txt", root), [`${home}/x.txt`]);
  // A plain flag, a relative filename, and a URL (no leading /) stay quiet.
  assert.deepEqual(bashOutsidePaths("npm ci --save-dev foo", root), []);
  assert.deepEqual(bashOutsidePaths("cat notes.txt", root), []);
});

test("bashOutsidePaths: unresolvable env-var paths fail toward the prompt", () => {
  const root = "/w";
  const r = bashOutsidePaths("cat $SOME_VAR/x.txt", root);
  assert.ok(r.includes("$SOME_VAR/x.txt"));
});

test("bashOutsidePaths: quotes make text literal (no false outside hits)", () => {
  const root = "/w";
  assert.deepEqual(bashOutsidePaths(`echo "a /etc/hosts b"`, root), []);
  assert.deepEqual(bashOutsidePaths("cat 'src/a b.ts'", root), []);
});

test("mode local (default): workspace bash auto-approves without prompting", async (t) => {
  const { root } = await ws(t);
  let asked = 0;
  const ask = async () => { asked++; return true; };
  // NO mode given — D13 changed the default from "ask" to "local".
  const hooks = makeSafetyHooks({ root, ask });
  for (const cmd of ["ls", "cat src/a.ts", "npm ci", "cat /usr/bin/node", "echo hi > notes.txt"]) {
    assert.equal(await hooks(bashTool, call("bash", { command: cmd })), undefined, cmd);
  }
  assert.equal(asked, 0);
});

test("mode local: explicit --local behaves the same as the default", async (t) => {
  const { root } = await ws(t);
  const hooks = makeSafetyHooks({ root, mode: "local", ask: async () => true });
  assert.equal(await hooks(bashTool, call("bash", { command: "ls" })), undefined);
});

test("mode local: bash touching an outside path prompts, naming it", async (t) => {
  const { root } = await ws(t);
  let question = "";
  const hooks = makeSafetyHooks({
    root, mode: "local", ask: async (q) => { question = q; return true; },
  });
  const r = await hooks(bashTool, call("bash", { command: "cat /etc/hosts" }));
  assert.equal(r, undefined); // approved
  assert.match(question, /outside the workspace: \/etc\/hosts/);
  assert.match(question, /Approve bash/);
});

test("mode local: outside-path prompt denied → blocked, nothing executed", async (t) => {
  const { root } = await ws(t);
  const hooks = makeSafetyHooks({ root, mode: "local", ask: async () => false });
  const r = await hooks(bashTool, call("bash", { command: "cat /etc/hosts" }));
  assert.ok(blockedOf(r));
  assert.match(blockedOf(r)!, /denied/);
});

test("mode local: write/edit auto-approve (the path sandbox already confines them)", async (t) => {
  const { root } = await ws(t);
  let asked = 0;
  const hooks = makeSafetyHooks({
    root, mode: "local",
    ask: async () => { asked++; return true; },
  });
  const r = await hooks(writeTool, call("write", { path: "a.txt", content: "x" }));
  assert.ok(argsOf(r));
  assert.equal(argsOf(r)!.path, join(root, "a.txt"));
  assert.equal(asked, 0);
});

test("mode local: destructive bash still confirms even INSIDE the workspace (D8)", async (t) => {
  const { root } = await ws(t);
  let question = "";
  const hooks = makeSafetyHooks({
    root, mode: "local",
    ask: async (q) => { question = q; return true; },
  });
  const r = await hooks(bashTool, call("bash", { command: "rm -rf build" }));
  assert.equal(r, undefined); // confirmed
  assert.match(question, /DESTRUCTIVE: recursive rm/);
});

test("mode local: destructive OUTSIDE the workspace prompts with both tags", async (t) => {
  const { root } = await ws(t);
  let question = "";
  const hooks = makeSafetyHooks({
    root, mode: "local",
    ask: async (q) => { question = q; return false; },
  });
  const r = await hooks(bashTool, call("bash", { command: "rm -rf /etc" }));
  assert.ok(blockedOf(r));
  assert.match(question, /DESTRUCTIVE: recursive rm/);
  assert.match(question, /outside the workspace: \/etc/);
});

test("mode local: an unresolvable $VAR path prompts (conservative)", async (t) => {
  const { root } = await ws(t);
  let asked = 0;
  const hooks = makeSafetyHooks({ root, mode: "local", ask: async () => { asked++; return true; } });
  assert.equal(await hooks(bashTool, call("bash", { command: "cat $SOME_VAR/x.txt" })), undefined);
  assert.equal(asked, 1);
});

test("mode ask is unchanged by D13: even plain 'ls' prompts (--ask regression)", async (t) => {
  const { root } = await ws(t);
  let asked = 0;
  const hooks = makeSafetyHooks({ root, mode: "ask", ask: async () => { asked++; return true; } });
  assert.equal(await hooks(bashTool, call("bash", { command: "ls" })), undefined);
  assert.equal(asked, 1);
});
