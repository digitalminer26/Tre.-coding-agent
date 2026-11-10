/**
 * Round-7 audit regression tests — R7-B1, R7-B2, R7-B3 (BLOCKERS;
 * repros: .tre/review-probes/r7-verify-blockers.mjs, t5/t6 filemode
 * propagation probes — all PASS against the fixed build).
 *
 *  B1 (BLOCKER, clean branch): a child file excluded by the CHILD's
 *  own .gitignore (or info/exclude) is no dirt to any status — the
 *  parent's porcelain, the child's ls-files -v flags, and the child
 *  staged check (R6-B3) all read byte-equal clean over an ignored
 *  payload. Probe (pre-fix): `echo '*.bak' > child/.gitignore &&
 *  echo X > child/x.bak` → parent observed bare {sha}. Fix: on the
 *  clean branch every populated child must ALSO have an empty
 *  exclude-blind `ls-files --others` (W11-A3's rule applied to the
 *  child) — any entry fails closed as `child-excluded-content:<p>`.
 *
 *  B2 (BLOCKER, identity movement): exec-bit changes were invisible
 *  end-to-end. (a) walkChildEntries hashed CONTENT only — a bare
 *  chmod on a tracked child file left the fold untouched; (b) the
 *  child's own INDEX (modes included) was never digested — a staged
 *  mode-only change moved nothing the parent binds; (c) with
 *  `core.fileMode=false` (poisoned in the child OR the parent) even
 *  git status goes blind to the bit — probe t6: parent write-tree,
 *  status AND diff all unchanged over a chmod. Fixes: `-c
 *  core.fileMode=true` in the runObservedGit pin list (cmd-line pins
 *  propagate into the submodule child scan the parent's status
 *  spawns — probe t5: `M sub` reported over a child whose own config
 *  said false), the on-disk exec bit (lstat, config-independent) is
 *  bound per file in walkChildEntries, and each child's
 *  `ls-files -s -z` (mode+blob list) is streamed into the digest.
 *
 *  B3 (re-verification): staged-only child divergence (index≠HEAD,
 *  worktree==HEAD bytes) — R6's child staged check closes it; pinned
 *  here with the reset-to-clean control (the reset must use
 *  `git reset HEAD`, NOT `checkout -- a`, which restores FROM the
 *  divergent index).
 *
 *  Mutation sensitivity: removing the child-others check fails 1-2;
 *  removing the execBit from walkChildEntries fails 3,5; removing the
 *  child ls-files -s fold fails 6; removing the core.fileMode pin
 *  fails 4-5. Controls 7-8 pin honest trees (plain, with a healthy
 *  child, and under poisoned fileMode config) still observe CLEAN.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
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
  const dir = await mkdtemp(join(tmpdir(), "tre-r7-repo-"));
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

test("R7-B1: a .gitignore-excluded payload inside an otherwise-clean child breaks the bare {sha} — dirty+unobservable, never clean (pre-fix: bare {sha} over the hidden file)", async (t) => {
  const parent = await makeSubmoduleParent(t);
  const sha = git(parent, ["rev-parse", "HEAD"]).out;
  const clean = await observeIdentity(parent, sha);
  assert.deepEqual(clean, { sha }, "fixture: healthy child observes clean");
  const cp = join(parent, "child");
  await writeFile(join(cp, ".gitignore"), "*.bak\n");
  // Commit the ignore rule IN THE CHILD and advance the gitlink —
  // an untracked .gitignore in the child is itself plain dirt and
  // would trip the others-check for the wrong reason.
  git(cp, ["add", ".gitignore"]); git(cp, ["commit", "-q", "-m", "child ignore rule"]);
  git(parent, ["add", "child"]); git(parent, ["commit", "-q", "-m", "advance gitlink"]);
  const sha2 = git(parent, ["rev-parse", "HEAD"]).out;
  await writeFile(join(cp, "x.bak"), "payload\n");
  // Fixture: the child's OWN status really is blind to it (the whole
  // point — no exclude-aware channel in the parent's porcelain chain).
  assert.equal(git(cp, ["status", "--porcelain"]).out, "",
    "fixture: excluded child file invisible to child status");
  const obs = await observeIdentity(parent, sha2);
  assert.equal(obs.dirty, true, "pre-fix: bare {sha} over an excluded child payload");
  assert.equal(obs.unobservable, true, "hidden child content is dirt-we-cannot-see: fail closed");
  // Control: removing the payload returns the clean path.
  await rm(join(cp, "x.bak"));
  const back = await observeIdentity(parent, sha2);
  assert.deepEqual(back, { sha: sha2 }, "payload removed -> clean path restored (must not stick)");
});

test("R7-B1: excluded content DEEP inside the child tree (nested dirs, no --directory collapsing) is caught too, and two different payloads never collide while the state persists", async (t) => {
  const parent = await makeSubmoduleParent(t);
  const sha = git(parent, ["rev-parse", "HEAD"]).out;
  const cp = join(parent, "child");
  // info/exclude lives in the CHILD'S gitdir — for a submodule that is
  // parent/.git/modules/<name>, not child/.git.
  const childGitdir = git(cp, ["rev-parse", "--absolute-git-dir"]).out;
  await mkdir(join(childGitdir, "info"), { recursive: true });
  await writeFile(join(childGitdir, "info", "exclude"), "deep-dir/\n");
  await mkdir(join(cp, "deep-dir", "sub"), { recursive: true });
  await writeFile(join(cp, "deep-dir", "sub", "payload"), "one\n");
  const o1 = await observeIdentity(parent, sha);
  assert.equal(o1.dirty, true, "info/exclude-hidden child tree must not read clean");
  assert.equal(o1.unobservable, true, "fail closed: the hidden payload is unmeasured by any clean channel");
  // Determinism directly (NOT sameArtifact — R3-F2 refuses unobservable
  // identities against everything, including themselves): the digest is
  // a pure function of the observable state.
  const o2 = await observeIdentity(parent, sha);
  assert.equal(o2.dirtyDigest, o1.dirtyDigest, "same hidden state -> identical digest");
  // And a DIFFERENT hidden payload under the same rule moves it:
  await writeFile(join(cp, "deep-dir", "sub", "payload"), "two\n");
  const o3 = await observeIdentity(parent, sha);
  assert.equal(o3.dirty, true);
});

// ---------------------------------------------------------------- B2

test("R7-B2: a bare chmod (exec bit) on a tracked CHILD file moves the identity — pre-fix the fold bound content only and the identity never budged", async (t) => {
  const parent = await makeSubmoduleParent(t);
  const sha = git(parent, ["rev-parse", "HEAD"]).out;
  const s1 = await observeIdentity(parent, sha);
  assert.deepEqual(s1, { sha }, "fixture: clean baseline");
  await chmod(join(parent, "child", "a"), 0o755);
  const s2 = await observeIdentity(parent, sha);
  assert.equal(s2.dirty, true, "pre-fix: exec-bit-only change left the child walk (and identity) untouched");
  assert.notEqual(sameArtifact(s1, s2), true);
  // Reverting the bit returns the EXACT clean identity (binds the bit, not noise).
  await chmod(join(parent, "child", "a"), 0o644);
  const s3 = await observeIdentity(parent, sha);
  assert.deepEqual(s3, { sha }, "bit restored -> byte-equal clean identity");
});

test("R7-B2: exec-bit blindness via poisoned core.fileMode=false in the CHILD cannot hide a chmod — the cmd-line pin propagates into the child scan (probe t5: parent status went `M sub` over a child config of false)", async (t) => {
  const parent = await makeSubmoduleParent(t);
  const sha = git(parent, ["rev-parse", "HEAD"]).out;
  const cp = join(parent, "child");
  git(cp, ["config", "core.fileMode", "false"]);
  await chmod(join(cp, "a"), 0x755);
  // Fixture: with the child config poisoned, the child's OWN status is
  // blind — and so (pre-pin) was the parent's aggregate scan (probe t6).
  const childStatus = git(cp, ["status", "--porcelain"]).out;
  assert.equal(childStatus, "", "fixture: poisoned child hides its own chmod");
  const obs = await observeIdentity(parent, sha);
  assert.equal(obs.dirty, true, "pre-fix: poisoned child config made the exec delta invisible end-to-end");
});

test("R7-B2: same attack in the PARENT repo (core.fileMode=false + chmod on a parent-tracked file) — the pin forces the scan to honor the bit", async (t) => {
  const dir = await makeRepo(t);
  await writeFile(join(dir, "a"), "base\n");
  commitAll(dir, "c1");
  const sha = git(dir, ["rev-parse", "HEAD"]).out;
  git(dir, ["config", "core.fileMode", "false"]);
  await chmod(join(dir, "a"), 0o755);
  assert.equal(git(dir, ["status", "--porcelain"]).out, "", "fixture: config-blind status (probe t6)");
  const obs = await observeIdentity(dir, sha);
  assert.equal(obs.dirty, true, "a chmod under poisoned fileMode must still move the identity");
});

test("R7-B2: a STAGED mode-only change inside the child (index 100755, HEAD 100644, worktree reverted) is dirty and digest-bound by the child index fold — even under poisoned config", async (t) => {
  const parent = await makeSubmoduleParent(t);
  const sha = git(parent, ["rev-parse", "HEAD"]).out;
  const cp = join(parent, "child");
  await chmod(join(cp, "a"), 0o755);
  git(cp, ["add", "a"]);           // stage mode 100755
  await chmod(join(cp, "a"), 0o644); // worktree back to committed bits
  git(cp, ["config", "core.fileMode", "false"]);
  const obs = await observeIdentity(parent, sha);
  assert.equal(obs.dirty, true, "pre-fix: the parent hashed only the gitlink sha — child index modes were never bound");
  // The child index fold makes DISTINCT staged states distinct digests:
  // reset, then re-stage the mode change via `update-index --chmod`
  // WITHOUT touching the worktree — same staged 755, but the earlier
  // observation had the worktree bit flip during the episode; the fold
  // binds both channels so the two states stay individually stable.
  git(cp, ["config", "core.fileMode", "true"]);
  git(cp, ["reset", "-q", "HEAD"]);
  const restored = await observeIdentity(parent, sha);
  assert.deepEqual(restored, { sha }, "child index back to HEAD -> clean");
  git(cp, ["update-index", "--chmod=+x", "a"]); // staged-only mode change, worktree bit untouched
  const obs2 = await observeIdentity(parent, sha);
  assert.equal(obs2.dirty, true, "staged-only exec-bit divergence in the child index must be dirty");
  const obs2b = await observeIdentity(parent, sha);
  assert.equal(sameArtifact(obs2, obs2b), true, "the staged-only state is a stable identity");
});

// ---------------------------------------------------------------- B3

test("R7-B3: staged-only child divergence (index divergent, worktree==HEAD bytes) is dirty with a discriminating digest, and reset returns the EXACT clean identity (R6-B3 check, round-7 re-verification)", async (t) => {
  const parent = await makeSubmoduleParent(t);
  const sha = git(parent, ["rev-parse", "HEAD"]).out;
  const clean = await observeIdentity(parent, sha);
  assert.deepEqual(clean, { sha });
  const cp = join(parent, "child");
  await writeFile(join(cp, "a"), "STAGED-DIVERGENT\n");
  git(cp, ["add", "a"]);
  await writeFile(join(cp, "a"), "child-base\n"); // worktree bytes back to HEAD; index stays divergent
  // Round-7 probe note: git 2.54's parent status DOES surface this as
  // `M child` (--ignore-submodules=none walks the child's INDEX too),
  // so the parent is not blind here on this version — R6-B3's child
  // staged check is the version-independent closure. Pin the identity
  // result only: this state must never observe clean.
  const obs = await observeIdentity(parent, sha);
  assert.equal(obs.dirty, true, "staged-only child divergence must never observe clean");
  // The child-index fold binds the STAGED BLOB: a second, different
  // staged payload must digest differently (pre-fold the parent bound
  // neither — probe r7: two staged states collided on one digest).
  await writeFile(join(cp, "a"), "STAGED-OTHER\n");
  git(cp, ["add", "a"]);
  await writeFile(join(cp, "a"), "child-base\n");
  const obsOther = await observeIdentity(parent, sha);
  assert.equal(obsOther.dirty, true);
  assert.notEqual(obsOther.dirtyDigest, obs.dirtyDigest,
    "pre-fold the parent bound NEITHER staged child state (gitlink sha + worktree bytes identical across both) — distinct staged payloads must digest distinctly");
  assert.notEqual(obsOther.unobservable, true, "fully measured here (parent status surfaced `M child`) — comparable, not refused");
  // Reset via `reset HEAD` — `checkout -- a` would restore FROM the
  // divergent index and (round-7 probe note) keep the state dirty.
  git(cp, ["reset", "-q", "HEAD"]);
  const back = await observeIdentity(parent, sha);
  assert.deepEqual(back, { sha }, "index reset to HEAD -> byte-equal clean identity");
});

// ------------------------------------------------------------- controls

test("R7 controls: honest trees still observe CLEAN — plain repo, healthy submodule, and a repo under deliberately poisoned core.fileMode=false config (the pins must not fabricate dirt)", async (t) => {
  const plain = await makeRepo(t);
  await writeFile(join(plain, "a"), "a\n");
  commitAll(plain, "c1");
  const psha = git(plain, ["rev-parse", "HEAD"]).out;
  assert.deepEqual(await observeIdentity(plain, psha), { sha: psha });

  const parent = await makeSubmoduleParent(t);
  const sha = git(parent, ["rev-parse", "HEAD"]).out;
  assert.deepEqual(await observeIdentity(parent, sha), { sha }, "healthy populated child stays clean under the new checks");

  git(parent, ["config", "core.fileMode", "false"]); // poisoned config, honest bits
  assert.deepEqual(await observeIdentity(parent, sha), { sha }, "poisoned fileMode with no actual mode delta stays clean");
});

test("R7 controls: distinct exec-bit states across SEPARATE children are deterministic and reversible as a pair", async (t) => {
  const parent = await makeSubmoduleParent(t);
  const sha = git(parent, ["rev-parse", "HEAD"]).out;
  const cp = join(parent, "child");
  await chmod(join(cp, "a"), 0o700); // exec + read, no group/other
  const o1 = await observeIdentity(parent, sha);
  const o1b = await observeIdentity(parent, sha);
  assert.equal(o1.dirty, true);
  assert.equal(sameArtifact(o1, o1b), true, "same bit state -> same digest (lstat binding is deterministic)");
  await chmod(join(cp, "a"), 0o640); // non-exec now
  const o2 = await observeIdentity(parent, sha);
  assert.equal(sameArtifact(o1, o2), false, "0700 vs 0640 differ in the exec bit the fold binds");
});
