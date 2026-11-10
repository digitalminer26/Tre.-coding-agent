/**
 * Round-5 audit (`.tre/audits/r5-sol-report.md`) regression tests — R5-B1, R5-B2.
 *
 *  B1 (BLOCKER, src/host/supervise.ts): `submodule.<name>.ignore=all` in
 *  REPO config hides a POPULATED submodule's modified bytes from `git
 *  status` — both the old plain status and the round-4 fresh-index
 *  status (GIT_ATTR_SOURCE does not touch submodule handling; the
 *  runObservedGit pin `diff.ignoreSubmodules=none` covers DIFF, not
 *  STATUS). observeIdentity returned bare {sha} (clean, repeatable,
 *  mutually equal) while child/a held modified bytes; end-to-end through
 *  collectAcceptanceEvidence + evaluate this minted `complete`.
 *  Fix: `--ignore-submodules=none` on the COMMAND LINE of
 *  `observeStatusFresh` and both integration-gate status invocations —
 *  git precedence is cmd-line > config, and the flag is quiet/exit-0 on
 *  uninitialized submodules (verified; pinned by test 4 here).
 *
 *  B2 (BLOCKER, REGRESSION of the round-4 fresh-index port): the fresh
 *  index compares HEAD against the WORKTREE, so a staged divergence
 *  whose worktree file was RESTORED to HEAD content is invisible in
 *  porcelain (index holds "XXXX", worktree holds "base", porcelain
 *  empty, every ls-files tag `H`) and the bare-{sha} clean return fired
 *  BEFORE the write-tree real-index digest. Two DISTINCT staged states
 *  observed byte-equal CLEAN, while the integration gate's post-gate
 *  staged check (diff-index --cached) refuses exactly this state —
 *  acceptance/integration verdict split on the same tree.
 *  Fix: the clean branch is gated on the SAME real-index check the
 *  integration gate uses (`--no-optional-locks diff-index --cached
 *  --quiet --ignore-submodules=none HEAD --`): exit 1 falls through to
 *  the dirty path (whose digest folds in write-tree of the REAL index,
 *  so distinct staged payloads get distinct digests), exit >=128 /
 *  truncated fails closed as unobservable, exit 0 returns clean.
 *
 *  Controls here: honest clean still CLEAN (tests 1/4/6), uninitialized
 *  submodule still CLEAN (test 4), staged-then-unstaged returns to clean
 *  (test 6). Mutation-sensitive: reverting the cmd-line pin fails test 3;
 *  reverting the staged check to a bare clean return fails tests 1/2;
 *  running the staged check on the fresh index instead of the REAL one
 *  fails test 1 (the fresh index matches HEAD, the check must not).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EpisodeGraph } from "../src/episode/journal.js";
import { observeIdentity, collectAcceptanceEvidence } from "../src/host/supervise.js";
import { sameArtifact, evaluate } from "../src/acceptance/evaluator.js";

function git(dir: string, args: string[]): { status: number; out: string } {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 30000 });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`
    .split("\n").filter((l) => !/^warning:/.test(l)).join("\n");
  if ((r.status ?? -1) !== 0) throw new Error(`git ${args.join(" ")} failed: ${out}`);
  return { status: r.status ?? 0, out: out.trim() };
}

type Graph = EpisodeGraph;

const graphFor = (baseCommit: string, gateCmd = "exit 0"): Graph => ({
  schema: "tre-graph/1",
  episodeId: "ep-r5",
  goal: "round-5 audit regression",
  policy: { baseCommit, gate: { cmd: gateCmd, timeoutS: 30 } },
  tasks: [{
    id: "t1", persona: "worker", promptRef: "p", dependsOn: [],
    acceptance: { criteria: ["policy-gate"], requiredChecks: [], artifacts: ["child", "child/a"] },
  }],
});

async function makeRepo(t: { after: (fn: () => void) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tre-r5-repo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main", "."]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  return dir;
}
const commitAll = (dir: string, msg: string) => { git(dir, ["add", "-A"]); git(dir, ["commit", "-q", "-m", msg]); };

/** Parent repo with a POPULATED submodule at `child` (file transport,
 *  protocol allow pinned for the add only — nothing here reads config
 *  at observe time beyond the committed state + one ignore setting). */
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

test("R5-B2 (unit): staged divergence with the worktree restored to HEAD content must NOT observe clean — the real-index check catches what the fresh-index porcelain cannot see", async (t) => {
  const dir = await makeRepo(t);
  await writeFile(join(dir, "a.txt"), "base\n");
  commitAll(dir, "c1");
  const sha = git(dir, ["rev-parse", "HEAD"]).out;
  // Stage modified content, then restore ONLY the worktree file. The
  // fresh-index status (HEAD vs worktree) reports nothing; every
  // ls-files tag is H. Pre-fix this returned bare {sha} (clean).
  await writeFile(join(dir, "a.txt"), "XXXX\n");
  git(dir, ["add", "a.txt"]);
  await writeFile(join(dir, "a.txt"), "base\n");
  assert.equal(git(dir, ["write-tree"]).out !== git(dir, ["rev-parse", "HEAD^{tree}"]).out, true,
    "fixture: the REAL index tree differs from HEAD");
  const obs = await observeIdentity(dir, sha);
  assert.equal(obs.dirty, true, "staged tree != HEAD must never be stamped clean (pre-fix: clean)");
  assert.notEqual(obs.unobservable, true, "the divergence IS measured — the digest folds write-tree of the real index");
  const again = await observeIdentity(dir, sha);
  assert.equal(sameArtifact(obs, again), true, "the unchanged staged state re-observes equal (deterministic)");
});

test("R5-B2 (discriminating): distinct staged payloads under one restored worktree get distinct dirty digests, and neither equals a clean identity", async (t) => {
  const dir = await makeRepo(t);
  await writeFile(join(dir, "a.txt"), "base\n");
  commitAll(dir, "c1");
  const sha = git(dir, ["rev-parse", "HEAD"]).out;
  const cleanObs = await observeIdentity(dir, sha);
  assert.notEqual(cleanObs.dirty, true, "baseline clean");
  const stage = async (content: string) => {
    await writeFile(join(dir, "a.txt"), content);
    git(dir, ["add", "a.txt"]);
    await writeFile(join(dir, "a.txt"), "base\n"); // restore worktree only
  };
  await stage("XXXX\n");
  const d1 = await observeIdentity(dir, sha);
  await stage("YYYY\n");
  const d2 = await observeIdentity(dir, sha);
  await stage("XXXX\n");
  const d1b = await observeIdentity(dir, sha);
  assert.equal(sameArtifact(d1, d2), false, "two distinct staged states must NOT collide (pre-fix: both clean-equal)");
  assert.equal(sameArtifact(d1, d1b), true, "re-staging the same payload reproduces the same digest");
  assert.equal(sameArtifact(cleanObs, d1), false, "a staged-dirty tree is never the same artifact as clean");
});

test("R5-B1 (unit + end-to-end): submodule.<name>.ignore=all cannot hide modified child bytes — no clean identity, no `complete` verdict", async (t) => {
  const parent = await makeSubmoduleParent(t);
  const sha = git(parent, ["rev-parse", "HEAD"]).out;
  git(parent, ["config", "submodule.child.ignore", "all"]);
  await writeFile(join(parent, "child", "a"), "MODIFIED\n");
  // The config really does blind a plain status (fixture assertion):
  assert.equal(git(parent, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).out, "",
    "fixture: ignore=all hides the child delta from a plain status");
  const obs = await observeIdentity(parent, sha);
  assert.equal(obs.dirty, true, "modified child bytes must report dirty under the ignore=all config (pre-fix: clean)");
  assert.notEqual(obs.unobservable, true, "the delta IS measured (--ignore-submodules=none on the cmd line beats the config)");
  const root = await mkdtemp(join(tmpdir(), "tre-r5-ep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ev = await collectAcceptanceEvidence({ graph: graphFor(sha), taskId: "t1", epPath: join(root, "ep"), worktreePath: parent });
  assert.equal(ev.current.dirty, true, "the post-gate identity sees the child delta");
  const assessment = evaluate(ev);
  assert.notEqual(assessment.verdict, "complete",
    `no complete verdict over hidden-modified submodule bytes (got ${assessment.verdict}; reasons=${JSON.stringify(assessment.reasons)})`);
});

test("R5-B1 controls: an uninitialized submodule still observes CLEAN (no false dirt from --ignore-submodules=none), and a populated submodule WITHOUT the ignore setting still reports child dirt", async (t) => {
  const parent = await makeSubmoduleParent(t);
  const sha = git(parent, ["rev-parse", "HEAD"]).out;
  // uninitialized: deinit removes the child worktree; the pinned flag
  // must not turn that into false dirt or a crash.
  git(parent, ["submodule", "deinit", "-q", "-f", "child"]);
  const uninit = await observeIdentity(parent, sha);
  assert.notEqual(uninit.dirty, true, `uninitialized submodule parent stays clean (got dirty=${uninit.dirty}, unobservable=${uninit.unobservable})`);
  // re-init, then modify WITHOUT any ignore config (control for the
  // B1 fix not fabricating dirt on the normal dirty path)
  git(parent, ["submodule", "update", "--init", "-q"]);
  await writeFile(join(parent, "child", "a"), "MODIFIED\n");
  const dirty = await observeIdentity(parent, sha);
  assert.equal(dirty.dirty, true, "child dirt is seen without any ignore config (unchanged behavior)");
});

test("R5-B2 control: staged content that is later unstaged back to HEAD returns the tree to CLEAN (the staged check must not stick)", async (t) => {
  const dir = await makeRepo(t);
  await writeFile(join(dir, "a.txt"), "base\n");
  commitAll(dir, "c1");
  const sha = git(dir, ["rev-parse", "HEAD"]).out;
  await writeFile(join(dir, "a.txt"), "XXXX\n");
  git(dir, ["add", "a.txt"]);
  await writeFile(join(dir, "a.txt"), "base\n");
  const dirty = await observeIdentity(dir, sha);
  assert.equal(dirty.dirty, true, "staged divergence reads dirty");
  git(dir, ["reset", "-q", "--", "a.txt"]); // index back to HEAD
  const back = await observeIdentity(dir, sha);
  assert.notEqual(back.dirty, true, "after unstaging, the tree is clean again");
});

test("R5-B2 end-to-end: evidence stamped at the CLEAN identity goes STALE against a staged-only divergence — the pre-fix clean-observation made it current and minted `complete`", async (t) => {
  const dir = await makeRepo(t);
  await writeFile(join(dir, "a.txt"), "base\n");
  commitAll(dir, "c1");
  const sha = git(dir, ["rev-parse", "HEAD"]).out;
  const root = await mkdtemp(join(tmpdir(), "tre-r5-ep2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const g: Graph = {
    ...graphFor(sha),
    tasks: [{ id: "t1", persona: "worker", promptRef: "p", dependsOn: [], acceptance: { criteria: ["policy-gate"], requiredChecks: [], artifacts: ["a.txt"] } }],
  };
  // 1. Honest evidence at the clean tree (the gate PASS row binds clean).
  const ev = await collectAcceptanceEvidence({ graph: g, taskId: "t1", epPath: join(root, "ep"), worktreePath: dir });
  assert.notEqual(ev.current.dirty, true, "fixture: evidence collected on a clean tree");
  // 2. Attacker stages a divergence, restores the worktree file to HEAD.
  await writeFile(join(dir, "a.txt"), "XXXX\n");
  git(dir, ["add", "a.txt"]);
  await writeFile(join(dir, "a.txt"), "base\n");
  const diverged = await observeIdentity(dir, sha);
  assert.equal(diverged.dirty, true, "the diverged tree observes dirty (pre-fix: bare-clean)");
  // 3. Re-evaluate the SAME evidence against the diverged current: the
  //    clean-stamped gate row must be STALE (not sameArtifact), so no
  //    current PASS funds the verdict. Pre-fix, `diverged` was byte-equal
  //    to the clean identity — the old row read as current and the
  //    verdict re-minted `complete` over a tree with hidden staged bytes.
  const assessment = evaluate({ ...ev, current: diverged });
  assert.notEqual(assessment.verdict, "complete",
    "clean-stamped evidence must not fund `complete` against the staged-diverged identity (got " + assessment.verdict + "; reasons=" + JSON.stringify(assessment.reasons) + ")");
});
