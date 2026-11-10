/**
 * Round-6 audit regression tests — R6-B1, R6-B2, R6-B3 (all BLOCKERS;
 * Sol's repros: .tre/review-probes/r6-observation-window.mjs PASSed
 * pre-fix, r6-identities.mjs documented the child-digest collision).
 *
 *  B1 (BLOCKER, runObservedGit): `core.fsmonitor` is a REPO-CONFIG-
 *  SELECTED EXECUTABLE that every index-touching command runs — not
 *  under core.hooksPath, not stopped by --no-optional-locks. The
 *  per-status/-diff pins left every OTHER real-index read (ls-files
 *  -v, ls-files --others, the staged diff-index, write-tree) open:
 *  a v2 hook that rewrites a tracked file and answers "no changes"
 *  made those reads observe a stat-stamped CLEAN index over freshly
 *  modified bytes (probe: observeIdentity returned bare {sha} while
 *  the hook had rewritten `a` to "S1"). Fix: `-c core.fsmonitor=false
 *  -c core.untrackedCache=false` in the runObservedGit pin list —
 *  every observed invocation, cmd-line precedence beats config.
 *
 *  B2 (BLOCKER, observeIdentity dirty digest): the parent's status/
 *  diff describe a submodule child only in AGGREGATE, so with
 *  `submodule.<name>.ignore=all` (and for the untracked-in-child
 *  case) TWO DISTINCT child content states digested IDENTICALLY —
 *  evidence stamped at child-state S1 stayed "current" (sameArtifact)
 *  over S2. Fix: a deterministic RAW WALK of every populated child
 *  (its HEAD sha + every entry path/size/content-hash, `.git`
 *  skipped at every level, symlinks as target strings, caps fail
 *  closed) is folded into the dirty digest.
 *
 *  B3 (BLOCKER, clean branch): a child's OWN index can hide content —
 *  `cd child && git update-index --assume-unchanged a; echo S1 > a`
 *  left the parent reading byte-equal CLEAN (bare {sha}) over real
 *  content delta; same for skip-worktree and for staged divergence
 *  inside the child. Fix: on the clean branch only, a recursive
 *  (bounded) child check — every populated child must have an
 *  all-`H` ls-files -v tag set AND a staged index matching its HEAD;
 *  any flag / divergence / unreadable child fails closed as
 *  dirty+unobservable with the discriminator.
 *
 *  Mutation sensitivity: reverting the runObservedGit pins fails
 *  tests 1-2; reverting the child walk fails 3-4; reverting the
 *  clean-branch child check fails 5-6. Controls (7-8) pin that an
 *  honest tree — with and without a healthy submodule — still
 *  observes CLEAN, and that resetting a child flag returns it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeIdentity } from "../src/host/supervise.js";
import { sameArtifact } from "../src/acceptance/evaluator.js";

function git(dir: string, args: string[]): { status: number; out: string } {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 30000 });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`
    .split("\n").filter((l) => !/^warning:/.test(l)).join("\n");
  if ((r.status ?? -1) !== 0) throw new Error(`git ${args.join(" ")} failed: ${out}`);
  return { status: r.status ?? 0, out: out.trim() };
}

async function makeRepo(t: { after: (fn: () => void) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tre-r6-repo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main", "."]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  return dir;
}
const commitAll = (dir: string, msg: string) => { git(dir, ["add", "-A"]); git(dir, ["commit", "-q", "-m", msg]); };

/** Parent repo with a POPULATED submodule at `child`. */
async function makeSubmoduleParent(t: { after: (fn: () => void) => void }): Promise<string> {
  const childDir = await makeRepo(t);
  await writeFile(join(childDir, "a"), "child-base\n");
  commitAll(childDir, "child c1");
  const parent = await makeRepo(t);
  await writeFile(join(parent, "p.txt"), "p\n");
  commitAll(parent, "parent c1");
  git(parent, ["-c", "protocol.file.allow=always", "submodule", "add", "--name", "child", childDir, "child"]);
  commitAll(parent, "add submodule");
  return parent;
}

// ---------------------------------------------------------------- B1

test("R6-B1: a core.fsmonitor v2 hook that rewrites a tracked file must NOT fire during observation — the tree stays observed honestly (pre-fix: bare {sha} over rewritten bytes)", async (t) => {
  const dir = await makeRepo(t);
  await writeFile(join(dir, "a"), "base\n");
  commitAll(dir, "c1");
  const sha = git(dir, ["rev-parse", "HEAD"]).out;
  // v2 hook: rewrite `a`, then answer "no changes" (empty + NUL-NUL).
  // OUTSIDE the repo dir — an untracked helper inside would be honest
  // dirt of its own and mask the assertion.
  const helperDir = await mkdtemp(join(tmpdir(), "tre-r6-fsm-"));
  t.after(() => rm(helperDir, { recursive: true, force: true }));
  const helper = join(helperDir, "fsm.sh");
  await writeFile(helper, "#!/bin/sh\nprintf 'S1\\n' > a\nprintf 'token\\000/\\000'\n");
  await chmod(helper, 0o755);
  git(dir, ["config", "core.fsmonitor", helper]);
  git(dir, ["config", "core.fsmonitorHookVersion", "2"]);
  const obs = await observeIdentity(dir, sha);
  // The pin means git NEVER spawns the hook: the worktree byte is the
  // committed content, and the identity is the honest clean one.
  assert.equal(await readFile(join(dir, "a"), "utf8"), "base\n",
    "pre-fix the hook rewrote this file DURING observation");
  assert.deepEqual(obs, { sha }, "honest tree under a neutralized fsmonitor is still clean");
});

test("R6-B1: an fsmonitor hook that rewrites AND reports no changes can never mint a clean identity — the mutation shows as dirty (the window is closed on every real-index read)", async (t) => {
  const dir = await makeRepo(t);
  await writeFile(join(dir, "a"), "base\n");
  commitAll(dir, "c1");
  const sha = git(dir, ["rev-parse", "HEAD"]).out;
  // Rewrite to DIFFERENT bytes by an outside hand first (state S1),
  // then install a hook claiming everything is unchanged: whatever
  // git answers, the fresh-index scan digests the raw bytes and the
  // staged check runs on the real index — no channel serves the lie.
  await writeFile(join(dir, "a"), "EVIL\n");
  const helperDir2 = await mkdtemp(join(tmpdir(), "tre-r6-fsm2-"));
  t.after(() => rm(helperDir2, { recursive: true, force: true }));
  const helper = join(helperDir2, "fsm2.sh");
  await writeFile(helper, "#!/bin/sh\nprintf 'token\\000/\\000'\n");
  await chmod(helper, 0o755);
  git(dir, ["config", "core.fsmonitor", helper]);
  git(dir, ["config", "core.fsmonitorHookVersion", "2"]);
  const obs = await observeIdentity(dir, sha);
  assert.equal(obs.dirty, true, "modified bytes under a lying fsmonitor must never read clean");
});

// ---------------------------------------------------------------- B2

test("R6-B2: two distinct child content states (ignore=all) now digest DIFFERENTLY — evidence stamped at child-state S1 is stale against S2 (pre-fix: sameArtifact==true)", async (t) => {
  const parent = await makeSubmoduleParent(t);
  const sha = git(parent, ["rev-parse", "HEAD"]).out;
  git(parent, ["config", "submodule.child.ignore", "all"]);
  const cp = join(parent, "child");
  await writeFile(join(cp, "a"), "S1\n");
  const s1 = await observeIdentity(parent, sha);
  await writeFile(join(cp, "a"), "S2\n");
  const s2 = await observeIdentity(parent, sha);
  assert.equal(s1.dirty, true, "child delta shows as dirty (--ignore-submodules=none pin, R5-B1)");
  assert.equal(s2.dirty, true);
  assert.notEqual(s1.unobservable, true, "the child walk measures the full child state");
  assert.equal(sameArtifact(s1, s2), false,
    "pre-fix the parent digest never bound child bytes: s1===s2 (Sol r6-identities)");
  // Deterministic: the same child state re-observes equal.
  await writeFile(join(cp, "a"), "S1\n");
  const s1b = await observeIdentity(parent, sha);
  assert.equal(sameArtifact(s1, s1b), true, "child-state S1 is a stable identity");
});

test("R6-B2: untracked bytes inside a child are bound too — two payloads under one untracked child path get distinct digests", async (t) => {
  const parent = await makeSubmoduleParent(t);
  const sha = git(parent, ["rev-parse", "HEAD"]).out;
  git(parent, ["config", "submodule.child.ignore", "all"]);
  const cp = join(parent, "child");
  await writeFile(join(cp, "new"), "S1\n");
  const u1 = await observeIdentity(parent, sha);
  await writeFile(join(cp, "new"), "S2\n");
  const u2 = await observeIdentity(parent, sha);
  assert.equal(u1.dirty, true);
  assert.equal(u2.dirty, true);
  assert.equal(sameArtifact(u1, u2), false,
    "pre-fix both untracked-child states shared one identity (Sol r6-identities u1/u2)");
});

// ---------------------------------------------------------------- B3

test("R6-B3: assume-unchanged INSIDE the child cannot hide modified child bytes from the parent's clean branch — dirty+unobservable, never bare {sha}", async (t) => {
  const parent = await makeSubmoduleParent(t);
  const sha = git(parent, ["rev-parse", "HEAD"]).out;
  const cp = join(parent, "child");
  git(cp, ["update-index", "--assume-unchanged", "a"]);
  await writeFile(join(cp, "a"), "S1\n");
  // The parent's own porcelain really is clean over this (fixture):
  assert.equal(git(parent, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]).out, "",
    "fixture: a flagged child hides its delta from the parent's status");
  const obs = await observeIdentity(parent, sha);
  assert.equal(obs.dirty, true, "pre-fix: bare {sha} — a clean identity over hidden child content");
  assert.equal(obs.unobservable, true, "the hidden delta cannot be measured from the parent: fail closed");
});

test("R6-B3: skip-worktree INSIDE the child fails the clean branch closed the same way", async (t) => {
  const parent = await makeSubmoduleParent(t);
  const sha = git(parent, ["rev-parse", "HEAD"]).out;
  const cp = join(parent, "child");
  git(cp, ["update-index", "--skip-worktree", "a"]);
  const obs = await observeIdentity(parent, sha);
  assert.equal(obs.dirty, true, "an S-flagged child entry is dirt-we-cannot-see on the clean path");
  assert.equal(obs.unobservable, true);
  // Control: resetting the flag returns the parent tree to clean.
  git(cp, ["update-index", "--no-skip-worktree", "a"]);
  const back = await observeIdentity(parent, sha);
  assert.deepEqual(back, { sha }, "flag reset -> clean path restored (the check must not stick)");
});

// ------------------------------------------------------------- controls

test("R6 controls: an honest parent WITHOUT submodules, and an honest parent WITH a healthy populated child, both still observe CLEAN — the new child machinery fabricates no dirt", async (t) => {
  const plain = await makeRepo(t);
  await writeFile(join(plain, "a.txt"), "base\n");
  commitAll(plain, "c1");
  const plainSha = git(plain, ["rev-parse", "HEAD"]).out;
  assert.deepEqual(await observeIdentity(plain, plainSha), { sha: plainSha }, "plain repo clean control");

  const parent = await makeSubmoduleParent(t);
  const sha = git(parent, ["rev-parse", "HEAD"]).out;
  const clean = await observeIdentity(parent, sha);
  assert.deepEqual(clean, { sha }, "healthy populated submodule: clean control (no false dirt from the walk/check)");
  const again = await observeIdentity(parent, sha);
  assert.deepEqual(again, { sha }, "and it is stable across re-observations");
});

test("R6 control: child HEAD move still reports dirty through the parent (R5-B1 behavior preserved under the new digest)", async (t) => {
  const childDir = await makeRepo(t);
  await writeFile(join(childDir, "a"), "v1\n");
  commitAll(childDir, "child c1");
  await writeFile(join(childDir, "a"), "v2\n");
  commitAll(childDir, "child c2");
  const parent = await makeRepo(t);
  await writeFile(join(parent, "p.txt"), "p\n");
  commitAll(parent, "parent c1");
  git(parent, ["-c", "protocol.file.allow=always", "submodule", "add", "--name", "child", childDir, "child"]);
  commitAll(parent, "add submodule");
  const sha = git(parent, ["rev-parse", "HEAD"]).out;
  const cp = join(parent, "child");
  const clean = await observeIdentity(parent, sha);
  assert.deepEqual(clean, { sha }, "baseline: child at the recorded gitlink is clean");
  git(cp, ["checkout", "-q", "HEAD~1"]);
  const obs = await observeIdentity(parent, sha);
  assert.equal(obs.dirty, true, "child HEAD move must report dirty (regression of R5-B1)");
  assert.equal(sameArtifact(obs, await observeIdentity(parent, sha)), true, "stable across observations");
  git(cp, ["checkout", "-q", "main"]);
  assert.deepEqual(await observeIdentity(parent, sha), { sha }, "back at the gitlink: clean again");
});
