/**
 * WS7 — safety & permissions (PLAN.md §WS7).
 *
 *   - path sandbox: lexical (../, absolute) and realpath (symlink) escapes
 *   - approval gate: ask / yes / no modes; a denial is a block reason
 *   - destructive bash classification (D8): confirmed even under --yes
 *   - reversible bash: undoable mutations (git/npm + in-workspace fs verbs)
 *     run WITHOUT a prompt in ask/yes, and are still blocked in no
 *   - the approval question states reversibility for plain mutating calls
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
  checkPathWithinRoot,
  checkPathWithinRoots,
  destructiveBashPatterns,
  isReadOnlyBash,
  isReversibleBash,
  makeSafetyHooks,
  makeAskQueue,
  validateExtraRoot,
  type ApprovalMode,
} from "../src/tools/safety.js";
import { makeToolExecutor } from "../src/tools/pipeline.js";
import { bashTool } from "../src/tools/bash.js";
import { readTool, writeTool, editTool } from "../src/tools/index.js";
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
  // ANY push publishes to a remote → destructive (not just force-push)
  assert.deepEqual(destructiveBashPatterns("git push origin main"), [
    "git push (publishes to a remote)",
  ]);
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

// ─────────────────────────── reversible bash ───────────────────────────

test("isReversibleBash: git/npm forms (the pre-existing reversible set)", () => {
  assert.equal(isReversibleBash("git add -A"), true);
  assert.equal(isReversibleBash('git commit -m "x"'), true);
  assert.equal(isReversibleBash("git stash push"), true);
  assert.equal(isReversibleBash("git switch main"), true);
  assert.equal(isReversibleBash("git checkout feature"), true);
  assert.equal(isReversibleBash("git branch hotfix"), true);
  assert.equal(isReversibleBash("git tag v1.0"), true);
  assert.equal(isReversibleBash("npm test"), true);
  assert.equal(isReversibleBash("npm run build"), true);
  // compound of reversible + read-only
  assert.equal(isReversibleBash('git add -A && git commit -m "x"'), true);
  assert.equal(isReversibleBash("npm run build 2>&1 | tail -3"), true);
});

test("isReversibleBash: undoable filesystem verbs are reversible", () => {
  assert.equal(isReversibleBash("mv a b"), true);
  assert.equal(isReversibleBash("mv a b c"), true);
  assert.equal(isReversibleBash("cp a b"), true);
  assert.equal(isReversibleBash("cp -r src dest"), true);
  assert.equal(isReversibleBash("mkdir -p a/b"), true);
  assert.equal(isReversibleBash("rmdir a"), true);
  assert.equal(isReversibleBash("touch f.txt"), true);
  assert.equal(isReversibleBash("ln -s target link"), true);
  assert.equal(isReversibleBash("chmod 755 script.sh"), true);
  assert.equal(isReversibleBash("chown user:group file"), true);
  assert.equal(isReversibleBash("sed -i 's/a/b/' file.txt"), true);
  assert.equal(isReversibleBash("sed --in-place 's/a/b/' file.txt"), true);
  assert.equal(isReversibleBash("echo hi | tee out.txt"), true);
});

test("isReversibleBash: sed WITHOUT -i is a stdout print, not a mutation", () => {
  // no in-place flag → not classified reversible (it is read-only, handled
  // by the read-only classifier — the point here is it is NOT "reversible")
  assert.equal(isReversibleBash("sed 's/a/b/' file.txt"), false);
});

test("isReversibleBash: fail-closed on unknown / unsafe / destructive", () => {
  assert.equal(isReversibleBash("curl -s https://example.com"), false);
  assert.equal(isReversibleBash("pip install requests"), false);
  assert.equal(isReversibleBash("frobnicate x"), false);
  // a substitution with a SAFE inner (read-only/reversible) counts as an
  // opaque argument — the command stays reversible; an UNSAFE inner still
  // disqualifies; sudo always disqualifies.
  assert.equal(isReversibleBash("mv $(cat f) g"), true); // safe inner
  assert.equal(isReversibleBash("mv $(rm -rf x) g"), false); // unsafe inner
  assert.equal(isReversibleBash("sudo mv a b"), false);
  // rm is destructive (not reversible), even non-recursive
  assert.equal(isReversibleBash("rm file.txt"), false);
  // git checkout . / -- <path> discard uncommitted work → destructive
  assert.equal(isReversibleBash("git checkout ."), false);
  assert.equal(isReversibleBash("git checkout -- file.txt"), false);
  assert.equal(isReversibleBash("git reset --hard"), false);
  // an empty command is never reversible
  assert.equal(isReversibleBash(""), false);
});

// ──────────────────── safe command substitution / heredoc ────────────────────

test("isReadOnlyBash: a substitution with a read-only inner is read-only", () => {
  assert.equal(isReadOnlyBash("echo $(date)"), true);
  assert.equal(isReadOnlyBash("echo $(pwd)"), true);
  assert.equal(isReadOnlyBash("echo $(git status)"), true);
  assert.equal(isReadOnlyBash("echo $(ls -la)"), true);
  assert.equal(isReadOnlyBash("echo `date`"), true); // backtick form, safe inner
  // nested safe substitution
  assert.equal(isReadOnlyBash("echo $(echo $(pwd))"), true);
  // a compound whose segments each carry a safe substitution
  assert.equal(isReadOnlyBash("ls && echo $(date)"), true);
});

test("isReadOnlyBash: a substitution with an unsafe inner is NOT read-only", () => {
  assert.equal(isReadOnlyBash("echo $(rm -rf x)"), false);
  assert.equal(isReadOnlyBash("echo $(curl -s https://example.com)"), false);
  assert.equal(isReadOnlyBash("echo $(mv a b)"), false); // mutating inner
  assert.equal(isReadOnlyBash("echo `rm -rf x`"), false); // backtick, unsafe inner
  assert.equal(isReadOnlyBash("echo $(sudo ls)"), false); // sudo inside
  // an unbalanced substitution is fail-closed
  assert.equal(isReadOnlyBash("echo $(date"), false);
});

test("isReversibleBash: the standard commit forms with safe substitution/heredoc", () => {
  // the model's everyday commit shapes must NOT be gated in ask mode
  assert.equal(isReversibleBash('git commit -m "$(date)"'), true);
  assert.equal(isReversibleBash('git commit -m "$(git status --short)"'), true);
  // heredoc inside a substitution
  assert.equal(
    isReversibleBash('git commit -m "$(cat <<\'EOF\'\nfix: a change\nEOF\n)"'),
    true,
  );
  // a safe substitution in a compound of reversible + read-only
  assert.equal(isReversibleBash('git add -A && git commit -m "$(date)"'), true);
});

test("isReversibleBash: a substitution with an unsafe inner is NOT reversible", () => {
  assert.equal(isReversibleBash('git commit -m "$(rm -rf x)"'), false);
  assert.equal(isReversibleBash('git commit -m "$(curl -s https://example.com)"'), false);
  assert.equal(isReversibleBash("git commit -m `rm -rf x`"), false);
});

test("destructiveBashPatterns: a destructive inner is inherited by the outer command", () => {
  // The raw token scan cannot see `rm` glued to the `$(` token — the label
  // must be inherited from the substitution's inner command.
  const hits = destructiveBashPatterns('git commit -m "$(rm -rf /)"');
  assert.ok(hits.length > 0, `expected a destructive hit, got ${JSON.stringify(hits)}`);
  assert.equal(isReadOnlyBash('git commit -m "$(rm -rf /)"'), false);
  assert.equal(isReversibleBash('git commit -m "$(rm -rf /)"'), false);
  // nested substitution: the label must propagate two levels out
  const nested = destructiveBashPatterns('echo "$(echo $(rm -rf /))"');
  assert.ok(nested.length > 0, `expected a nested destructive hit, got ${JSON.stringify(nested)}`);
  // plain destructive commands are still caught (regression guard)
  assert.ok(destructiveBashPatterns("rm -rf build/").length > 0);
  assert.ok(destructiveBashPatterns("git push origin main").length > 0);
  // a read-only inner adds no destructive label
  assert.equal(destructiveBashPatterns('git commit -m "$(date)"').length, 0);
});

test("destructiveBashPatterns: git destructive checks match the SUBCOMMAND, not any argument word", () => {
  // the false positive that motivated this: `stash push` is local + undoable
  assert.equal(destructiveBashPatterns("git stash push -m wip").length, 0);
  assert.equal(isReversibleBash("git stash push -m wip"), true);
  // real pushes are still caught — including with global flags
  assert.ok(destructiveBashPatterns("git push origin main").length > 0);
  assert.deepEqual(destructiveBashPatterns("git push --force origin main"), ["git push --force"]);
  assert.ok(destructiveBashPatterns("git -C /some/repo push origin main").length > 0);
  assert.ok(destructiveBashPatterns("git -c user.name=x push --force origin main").length > 0);
  // other subcommands that merely CONTAIN a destructive word as an argument
  assert.equal(destructiveBashPatterns("git commit -m push").length, 0);
  // the remaining destructive git forms are unchanged
  assert.ok(destructiveBashPatterns("git reset --hard HEAD~1").length > 0);
  assert.ok(destructiveBashPatterns("git clean -fd").length > 0);
  assert.ok(destructiveBashPatterns("git branch -D old").length > 0);
  assert.ok(destructiveBashPatterns("git checkout .").length > 0);
  assert.ok(destructiveBashPatterns("git -C /r checkout .").length > 0);
  assert.equal(destructiveBashPatterns("git stash").length, 0);
  assert.equal(destructiveBashPatterns("git stash list").length, 0);
  assert.equal(destructiveBashPatterns("git status").length, 0);
});

test("isReversibleBash: sudo / redirect still disqualify even with a safe inner", () => {
  assert.equal(isReversibleBash('sudo git commit -m "x"'), false);
  assert.equal(isReversibleBash('git commit -m "x" > log.txt'), false);
});

// ─────────────────────────────── approval gate ───────────────────────────────

test("mode ask: reversible bash is NOT prompted (mv, mkdir, chmod, sed -i)", async (t) => {
  const { root } = await ws(t);
  let asked = 0;
  const hooks = makeSafetyHooks({
    root,
    mode: "ask",
    ask: async () => {
      asked++;
      return false;
    },
  });
  for (const cmd of ["mv a b", "mkdir -p d", "chmod 755 s.sh", "sed -i 's/a/b/' f.txt", "cp a b"]) {
    assert.equal(await hooks(bashTool, call("bash", { command: cmd })), undefined, cmd);
  }
  assert.equal(asked, 0, "reversible mutations must never reach the prompt");
});

test("mode ask: plain mutating bash (curl) is denied → block reason; nothing executed", async (t) => {
  const { root } = await ws(t);
  const hooks = makeSafetyHooks({ root, mode: "ask", ask: async () => false });
  const r = await hooks(bashTool, call("bash", { command: "curl -s https://example.com" }));
  assert.ok(blockedOf(r));
  assert.match(blockedOf(r)!, /denied/);
});

test("mode ask: bash approved → allow (undefined)", async (t) => {
  const { root } = await ws(t);
  const hooks = makeSafetyHooks({ root, mode: "ask", ask: async () => true });
  const r = await hooks(bashTool, call("bash", { command: "echo hi" }));
  assert.equal(r, undefined);
});

test("mode ask: read is NOT gated — never asked, path passed through untouched", async (t) => {
  const { root, outside } = await ws(t);
  let asked = 0;
  const hooks = makeSafetyHooks({
    root,
    mode: "ask",
    ask: async () => {
      asked++;
      return true;
    },
  });
  // Inside the root: path is passed through exactly as given (no rewrite).
  const r = await hooks(readTool, call("read", { path: "sub/a.txt" }));
  assert.equal(asked, 0);
  assert.equal(r, undefined, "no rewrite — read is unrestricted");
  // Outside the root: also passed through, never blocked, never asked.
  const r2 = await hooks(readTool, call("read", { path: join(outside, "secret.txt") }));
  assert.equal(asked, 0);
  assert.equal(r2, undefined, "reads outside the root are unrestricted");
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

test("mode yes: ws destructive is auto-approved (no prompt); sys destructive is blocked", async (t) => {
  const { root } = await ws(t);
  let asked = 0;
  const hooks = makeSafetyHooks({
    root,
    mode: "yes",
    ask: async () => {
      asked++;
      return false;
    },
  });
  // Workspace-scoped destructive (rm -rf) is AUTO-APPROVED in yes — the
  // sandbox confines it to the workspace and git keeps a backup.
  assert.equal(await hooks(bashTool, call("bash", { command: "rm -rf build" })), undefined);
  assert.equal(asked, 0, "ws destructive is auto-approved, not prompted");
  // System-level destructive (dd to a raw device) is BLOCKED in every mode.
  const sys = await hooks(bashTool, call("bash", { command: "dd if=x of=/dev/sda" }));
  assert.ok(blockedOf(sys));
  assert.match(blockedOf(sys)!, /systemic destructive/);
  assert.equal(asked, 0, "sys destructive is blocked, never prompted");
});

test("mode no: reversible bash is blocked (reversible is not the no-mode class)", async (t) => {
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
  // mv is now reversible — but "no" mode allows ONLY read-only bash, so a
  // reversible mutation is still blocked (no prompts, ever).
  const r = await hooks(bashTool, call("bash", { command: "mv a b" }));
  assert.ok(blockedOf(r));
  assert.match(blockedOf(r)!, /no-approve/);
  assert.equal(asked, 0);
});

test("mode no: read is blocked (fail-closed); ask/yes: plain reads unrestricted", async (t) => {
  const { root, outside } = await ws(t);
  // no mode allows only read-only bash — even plain reads are blocked
  // (reads are unrestricted by design, so no human oversight = fail-closed).
  const hooksNo = makeSafetyHooks({ root, mode: "no" });
  const rNo = await hooksNo(readTool, call("read", { path: "a.txt" }));
  assert.ok(blockedOf(rNo));
  assert.match(blockedOf(rNo)!, /no-approve/);
  // ask: plain reads remain unrestricted (inside and outside the root).
  const hooksAsk = makeSafetyHooks({ root, mode: "ask" });
  assert.equal(await hooksAsk(readTool, call("read", { path: "a.txt" })), undefined);
  assert.equal(
    await hooksAsk(readTool, call("read", { path: join(outside, "x.txt") })),
    undefined,
  );
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
  const r = await hooks(bashTool, call("bash", { command: "curl -s https://example.com" }));
  assert.ok(blockedOf(r));
  assert.match(blockedOf(r)!, /denied/);
});

test("approval question for a plain mutating command states it is not provably reversible", async (t) => {
  const { root } = await ws(t);
  let question = "";
  const hooks = makeSafetyHooks({
    root,
    mode: "ask",
    ask: (q) => {
      question = q;
      return false;
    },
  });
  await hooks(bashTool, call("bash", { command: "curl -s https://example.com" }));
  assert.match(question, /Approve bash/);
  assert.match(question, /not provably reversible/);
});

test("approval question for destructive keeps the DESTRUCTIVE tag (not the reversible one)", async (t) => {
  const { root } = await ws(t);
  let question = "";
  const hooks = makeSafetyHooks({
    root,
    mode: "ask",
    ask: (q) => {
      question = q;
      return false;
    },
  });
  await hooks(bashTool, call("bash", { command: "rm -rf /" }));
  assert.match(question, /DESTRUCTIVE: recursive rm/);
  assert.doesNotMatch(question, /not provably reversible/);
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
  const res = await exec(bashTool, call("bash", { command: "curl -s https://example.com" }), sig());
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


// ──────────────── read: unrestricted (no sandbox, no gate) ────────────────

test("read: any non-sensitive path passes through untouched (ask/yes); blocked in no", async (t) => {
  const { root, outside } = await ws(t);
  for (const mode of ["ask", "yes"] as ApprovalMode[]) {
    const hooks = makeSafetyHooks({ root, mode, ask: async () => true });
    // Absolute path outside the root.
    assert.equal(
      await hooks(readTool, call("read", { path: join(outside, "secret.txt") })),
      undefined,
      `mode ${mode}: absolute outside path must pass through`,
    );
    // ../ escape out of the root.
    assert.equal(
      await hooks(readTool, call("read", { path: "../outside/secret.txt" })),
      undefined,
      `mode ${mode}: ../ escape must pass through`,
    );
  }
  // no mode is fail-closed: reads are unrestricted by design, so without a
  // human to confirm, even plain reads are blocked.
  const hooksNo = makeSafetyHooks({ root, mode: "no" });
  const r = await hooksNo(readTool, call("read", { path: join(outside, "secret.txt") }));
  assert.ok(r && "blocked" in r, "mode no: read is blocked");
  assert.match(r.blocked, /no-approve/);
});

test("read: never prompts, even in mode ask (the ask callback is never called)", async (t) => {
  const { root } = await ws(t);
  let asked = 0;
  const hooks = makeSafetyHooks({
    root,
    mode: "ask",
    ask: async () => {
      asked++;
      return false;
    },
  });
  assert.equal(await hooks(readTool, call("read", { path: "/etc/hosts" })), undefined);
  assert.equal(asked, 0, "read must never reach the approval prompt");
});

test("read: pipeline integration — an outside-root read executes", async (t) => {
  const { root, outside } = await ws(t);
  const outsideFile = join(outside, "sys.txt");
  await writeFile(outsideFile, "system file content");
  const hooks = makeSafetyHooks({ root, mode: "ask", ask: async () => true });
  const exec = makeToolExecutor({ beforeToolCall: hooks });
  const res = await exec(readTool, call("read", { path: outsideFile }), sig());
  assert.ok(!res.isError, "reading outside the root is not an error");
  assert.match(res.content.map((c) => c.text).join(" "), /system file content/);
});

test("read: a directory lists its entries (EISDIR → listing, not an error)", async (t) => {
  const { root, outside } = await ws(t);
  const dir = join(outside, "somedir");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "a.txt"), "x");
  await mkdir(join(dir, "nested"));
  const res = await readTool.execute("c1", { path: dir }, new AbortController().signal, () => {});
  assert.ok(!res.isError, "listing a directory is not an error");
  const text = res.content.map((c) => c.text).join(" ");
  assert.match(text, /a\.txt/);
  assert.match(text, /nested/);
  assert.match(text, /is a directory/);
});

test("read: a missing path is a clean error result (not a throw)", async () => {
  const res = await readTool.execute(
    "c1",
    { path: "/definitely/not/here.txt" },
    new AbortController().signal,
    () => {},
  );
  assert.ok(res.isError, "missing file is an error result");
  assert.match(res.content.map((c) => c.text).join(" "), /cannot read/);
});

// ─────────────────────── default mode is "yes" (auto-approve) ───────────────────────

test("default mode (no mode option) is yes: plain mutating bash runs without a prompt", async (t) => {
  const { root } = await ws(t);
  let asked = 0;
  const hooks = makeSafetyHooks({
    root,
    ask: async () => {
      asked++;
      return false;
    },
  });
  // The default (yes) auto-approves workspace-scoped work — mutating bash
  // included — so no prompt is shown and the call is allowed.
  const r = await hooks(bashTool, call("bash", { command: "curl -s https://example.com" }));
  assert.equal(r, undefined, "the default mode auto-approves plain mutating bash");
  assert.equal(asked, 0, "the default mode must not prompt for plain mutating bash");
});

test("default mode (no mode option) is yes: sys sensitive + sys destructive are blocked", async (t) => {
  const { root } = await ws(t);
  let asked = 0;
  const hooks = makeSafetyHooks({
    root,
    ask: async () => {
      asked++;
      return true;
    },
  });
  // System-level sensitive (resolves outside the workspace) is BLOCKED in
  // every mode, including the default.
  const sens = await hooks(bashTool, call("bash", { command: "cat ~/.ssh/id_rsa" }));
  assert.ok(blockedOf(sens));
  assert.match(blockedOf(sens)!, /system-level sensitive/);
  // System-level destructive (dd to a raw device) is BLOCKED in every mode.
  const destr = await hooks(bashTool, call("bash", { command: "dd if=x of=/dev/sda" }));
  assert.ok(blockedOf(destr));
  assert.match(blockedOf(destr)!, /systemic destructive/);
  assert.equal(asked, 0, "sys sensitive/destructive are blocked, never prompted");
});

test("default mode (no mode option) is yes: write runs without a prompt, path rewritten", async (t) => {
  const { root } = await ws(t);
  let asked = 0;
  const hooks = makeSafetyHooks({
    root,
    ask: async () => {
      asked++;
      return true;
    },
  });
  const r = await hooks(writeTool, call("write", { path: "a.txt", content: "x" }));
  assert.ok(argsOf(r));
  assert.equal(argsOf(r)!.path, join(root, "a.txt"));
  assert.equal(asked, 0, "in-workspace writes are not prompted (reversible via git)");
});

test("write/edit are still sandboxed to the root in every mode", async (t) => {
  const { root, outside } = await ws(t);
  for (const mode of ["ask", "yes", "no"] as ApprovalMode[]) {
    const hooks = makeSafetyHooks({ root, mode, ask: async () => true });
    const r = await hooks(
      writeTool,
      call("write", { path: join(outside, "evil.txt"), content: "x" }),
    );
    assert.ok(blockedOf(r), `mode ${mode}: write outside must be blocked`);
    assert.match(blockedOf(r)!, /outside the project root/);
  }
});

// ─────────────────────────────── C35: extra roots ───────────────────────────────

test("C35 checkPathWithinRoots: allowed under ANY root, refused outside all", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "om-c35-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "root");
  const extra = join(base, "extra");
  const other = join(base, "other");
  await mkdir(root, { recursive: true });
  await mkdir(extra, { recursive: true });
  await mkdir(other, { recursive: true });

  // Under the primary root.
  const inRoot = await checkPathWithinRoots([root, extra], "a.txt");
  assert.equal(inRoot.ok, true);
  assert.equal(inRoot.ok && inRoot.path, join(root, "a.txt"));
  // Under the EXTRA root (absolute path).
  const inExtra = await checkPathWithinRoots([root, extra], join(extra, "b.txt"));
  assert.equal(inExtra.ok, true);
  assert.equal(inExtra.ok && inExtra.path, join(extra, "b.txt"));
  // Outside ALL roots → refused, naming the full boundary.
  const out = await checkPathWithinRoots([root, extra], join(other, "evil.txt"));
  assert.equal(out.ok, false);
  assert.match(out.ok ? "" : out.reason, /extra roots/);
  assert.match(out.ok ? "" : out.reason, /outside/);
  // Single-root list behaves like checkPathWithinRoot.
  const single = await checkPathWithinRoots([root], join(extra, "b.txt"));
  assert.equal(single.ok, false);
});

test("C35 write/edit: allowed under an extra root, refused outside all roots", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "om-c35-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "root");
  const extra = join(base, "extra");
  const other = join(base, "other");
  await mkdir(root, { recursive: true });
  await mkdir(extra, { recursive: true });
  await mkdir(other, { recursive: true });

  const hooks = makeSafetyHooks({ root, mode: "yes", extraRoots: [extra] });
  // write INTO the extra root → allowed + path rewritten to the canonical path.
  const rExtra = await hooks(
    writeTool,
    call("write", { path: join(extra, "ok.txt"), content: "x" }),
  );
  assert.ok(argsOf(rExtra), "a write into the extra root must be allowed");
  assert.equal(argsOf(rExtra)!.path, join(extra, "ok.txt"));
  // write OUTSIDE all roots → blocked, naming the extra roots.
  const rOut = await hooks(
    writeTool,
    call("write", { path: join(other, "evil.txt"), content: "x" }),
  );
  assert.ok(blockedOf(rOut));
  assert.match(blockedOf(rOut)!, /extra roots/);
  // edit into the extra root → allowed too.
  const rEdit = await hooks(
    editTool,
    call("edit", { path: join(extra, "ok.txt"), oldText: "x", newText: "y" }),
  );
  assert.ok(argsOf(rEdit), "an edit into the extra root must be allowed");
  assert.equal(argsOf(rEdit)!.path, join(extra, "ok.txt"));
});

test("C35 sensitive paths under an extra root stay (sys)-sensitive — never downgraded", async (t) => {
  // The guardrail property: the (ws)/(sys) split keeps using the PRIMARY root
  // only. A `.env` / `id_rsa` under an extra root is still system-level
  // sensitive and BLOCKED in every mode (an extra root widens the BOUNDARY,
  // it never downgrades a secret from (sys) to (ws)).
  const base = await mkdtemp(join(tmpdir(), "om-c35sens-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "root");
  const extra = join(base, "extra");
  await mkdir(root, { recursive: true });
  await mkdir(extra, { recursive: true });

  const hooks = makeSafetyHooks({ root, mode: "yes", extraRoots: [extra] });

  // A project .env INSIDE the workspace is (ws) — allowed in "yes".
  const wsEnv = await hooks(readTool, call("read", { path: join(root, ".env") }));
  assert.equal(wsEnv, undefined, "a workspace .env is (ws) and allowed in yes");

  // The SAME .env under the EXTRA root is (sys) — blocked in every mode.
  const erEnv = await hooks(readTool, call("read", { path: join(extra, ".env") }));
  assert.ok(blockedOf(erEnv), "a .env under an extra root must be blocked");
  assert.match(blockedOf(erEnv)!, /system-level sensitive/);

  // And via bash: cat of an extra-root secret is (sys) too.
  const erBash = await hooks(
    bashTool,
    call("bash", { command: `cat ${join(extra, ".env")}` }),
  );
  assert.ok(blockedOf(erBash), "bash cat of an extra-root .env must be blocked");
  assert.match(blockedOf(erBash)!, /system-level sensitive/);
});

test("C35 validateExtraRoot: accepts a plain dir under home; refuses missing, sensitive, outside-home", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "om-c35v-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  // The temp base stands in for "home" (validateExtraRoot takes home as a
  // parameter, so the test is hermetic — no real ~/.ssh needed).
  const plain = join(base, "projects", "repo");
  await mkdir(plain, { recursive: true });
  const sens = join(base, ".ssh");
  await mkdir(sens, { recursive: true });
  const sensFile = join(base, "projects", "server.key");
  await writeFile(sensFile, "k");
  const outside = join(base, "..", "om-c35v-outside-" + Date.now());
  await mkdir(outside, { recursive: true });
  t.after(() => rm(outside, { recursive: true, force: true }));

  assert.equal(validateExtraRoot(plain, base), undefined, "a plain dir under home is fine");
  assert.match(validateExtraRoot(join(base, "nope"), base)!, /does not exist/);
  assert.match(validateExtraRoot(sens, base)!, /sensitive path \(~\/\.ssh\/\)/);
  assert.match(validateExtraRoot(sensFile, base)!, /is not a directory/);
  assert.match(validateExtraRoot(outside, base)!, /outside your home directory/);
  // home itself is allowed (it is "under home" by the realPath identity).
  assert.equal(validateExtraRoot(base, base), undefined);
});
