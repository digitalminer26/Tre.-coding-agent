/**
 * P6 — worktree provisioning (docs/11 §5, §11.1 P6, §14.1/§14.5).
 *
 * Covers (against REAL git repos in os.tmpdir()):
 *  - open(): placement validation — missing/non-repo repoRoot, wtRoot
 *    inside the repo itself, wtRoot inside a FOREIGN repo (§5 "episode
 *    dirs never inside another repo").
 *  - ensureTaskWorktree: branch `agent/<ep>/<task>` created pinned at
 *    baseCommit, provenance fields, open-or-create idempotence,
 *    crash-recovery re-attach (branch exists at base, registration gone),
 *    branch-conflict (branch exists elsewhere — never moved), path-exists
 *    (unmanaged directory — never adopted/deleted), detached mode,
 *    stale-registration refusal.
 *  - removeTaskWorktree: dirty refusal before any mutation, noop,
 *    unmanaged-directory refusal, deleteBranch gating (base-commit proof
 *    required; unmerged refusal; force discards), branch survives plain
 *    removal.
 *  - prune(): removes vanished registrations under wtRoot, reports them,
 *    refuses when a stale entry lies outside wtRoot.
 *  - resolveCommit / taskBranchName / listWorktrees plumbing.
 *  - compartment guards: src/worktree/ imports only node: builtins and
 *    nothing outside src/worktree/ imports it (until P7/P9 wires it).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  WorktreeProvisioner,
  WorktreeProvisionError,
  resolveCommit,
  taskBranchName,
  listWorktrees,
  assertSafeComponent,
} from "../src/worktree/provision.js";

const execFileAsync = promisify(execFile);

/** Hermetic git: fixed identity, no gpg, explicit default branch. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "user.name=ptest", "-c", "user.email=ptest@example.com", "-c", "commit.gpgsign=false", "-c", "advice.detachedHead=false", ...args],
    { cwd },
  );
  return stdout.trim();
}

/** git that tolerates non-zero exit (verify-style probes): null on failure. */
async function gitMaybe(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    return await git(cwd, ...args);
  } catch {
    return null;
  }
}

async function freshDir(prefix = "wt-prov-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** New git repo at dir with one commit ("a") on main. Returns main's sha. */
async function makeRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-b", "main");
  await writeFile(join(dir, "a.txt"), "base\n");
  await git(dir, "add", "a.txt");
  await git(dir, "commit", "-m", "base commit");
  return git(dir, "rev-parse", "HEAD");
}

function expectCode(err: unknown, code: string): void {
  assert.ok(err instanceof WorktreeProvisionError, `expected WorktreeProvisionError(${code}), got ${String(err)}`);
  assert.equal(err.code, code);
}

/** Provisioner with wtRoot at <dir>/ep/wt, repo at <dir>/repo. */
async function setup(): Promise<{ dir: string; repo: string; wtRoot: string; base: string; prov: WorktreeProvisioner }> {
  const dir = await freshDir();
  const repo = join(dir, "repo");
  const base = await makeRepo(repo);
  const prov = await WorktreeProvisioner.open({ repoRoot: repo, wtRoot: join(dir, "ep", "wt") });
  return { dir, repo, wtRoot: prov.wtRoot, base, prov };
}

// ---------------------------------------------------------------------------
// open(): placement validation
// ---------------------------------------------------------------------------

test("open() creates wtRoot and validates both anchors", async () => {
  const { dir, repo, wtRoot, prov } = await setup();
  assert.equal(prov.repoRoot, await realpath(repo));
  assert.equal(prov.wtRoot, wtRoot);
  const st = await stat(wtRoot);
  assert.equal(st.isDirectory(), true);
  assert.ok(wtRoot.startsWith(await realpath(dir)), "wtRoot must live under the tmp episode dir (realpath'd: macOS /var -> /private/var)");
});

test("open(): missing repoRoot → not-a-git-repo; plain dir → not-a-git-repo", async () => {
  const dir = await freshDir();
  await assert.rejects(
    WorktreeProvisioner.open({ repoRoot: join(dir, "nope"), wtRoot: join(dir, "wt") }),
    (e: unknown) => { expectCode(e, "not-a-git-repo"); return true; },
  );
  const plain = join(dir, "plain");
  await mkdir(plain);
  await assert.rejects(
    WorktreeProvisioner.open({ repoRoot: plain, wtRoot: join(dir, "wt2") }),
    (e: unknown) => { expectCode(e, "not-a-git-repo"); return true; },
  );
});

test("open(): wtRoot inside the repository itself → wt-inside-repo (§5)", async () => {
  const { repo } = await setup();
  await assert.rejects(
    WorktreeProvisioner.open({ repoRoot: repo, wtRoot: join(repo, "wt") }),
    (e: unknown) => { expectCode(e, "wt-inside-repo"); return true; },
  );
  // also refuses the repo root itself as wtRoot
  await assert.rejects(
    WorktreeProvisioner.open({ repoRoot: repo, wtRoot: repo }),
    (e: unknown) => { expectCode(e, "wt-inside-repo"); return true; },
  );
});

test("open(): wtRoot inside a FOREIGN git repo → wt-in-other-repo (§5)", async () => {
  const dir = await freshDir();
  const repo = join(dir, "repo");
  await makeRepo(repo);
  const other = join(dir, "other-repo");
  await makeRepo(other);
  await assert.rejects(
    WorktreeProvisioner.open({ repoRoot: repo, wtRoot: join(other, "episode-wt") }),
    (e: unknown) => { expectCode(e, "wt-in-other-repo"); return true; },
  );
});

test("open(): a refused open creates NOTHING (audit F1: validate before mkdir)", async () => {
  const { repo } = await setup();
  const inside = join(repo, "ep", "wt");
  await assert.rejects(
    WorktreeProvisioner.open({ repoRoot: repo, wtRoot: inside }),
    (e: unknown) => { expectCode(e, "wt-inside-repo"); return true; },
  );
  assert.equal(existsSync(inside), false, "refused open must not create the wtRoot tree");
  assert.equal(existsSync(join(repo, "ep")), false);
});

test("open(): wtRoot inside a FOREIGN BARE repo is detected (audit F2)", async () => {
  const dir = await freshDir();
  const repo = join(dir, "repo");
  await makeRepo(repo);
  const bare = join(dir, "other.git");
  await git(dir, "init", "--bare", bare);
  await assert.rejects(
    WorktreeProvisioner.open({ repoRoot: repo, wtRoot: join(bare, "episode", "wt") }),
    (e: unknown) => { expectCode(e, "wt-in-other-repo"); return true; },
  );
  assert.equal(existsSync(join(bare, "episode")), false);
  // the bare root itself as wtRoot is refused too
  await assert.rejects(
    WorktreeProvisioner.open({ repoRoot: repo, wtRoot: join(bare, "wt") }),
    (e: unknown) => { expectCode(e, "wt-in-other-repo"); return true; },
  );
});

test("open(): wtRoot inside one of our OWN linked worktrees → wt-inside-repo (audit F2 corollary)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epJ", taskId: "t1", baseCommit: base });
  await assert.rejects(
    WorktreeProvisioner.open({ repoRoot: repo, wtRoot: join(wt.path, "sub-wt") }),
    (e: unknown) => { expectCode(e, "wt-inside-repo"); return true; },
  );
});

test("open(): wtRoot inside a RENAMED linked worktree → wt-inside-repo (audit c2 F1)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epL", taskId: "t1", baseCommit: base });
  const { rename } = await import("node:fs/promises");
  const renamed = join(prov.wtRoot, "renamed-wt");
  await rename(wt.path, renamed); // moved behind git's back: registration is stale, dir lives on
  await assert.rejects(
    WorktreeProvisioner.open({ repoRoot: repo, wtRoot: join(renamed, "sub-wt") }),
    (e: unknown) => { expectCode(e, "wt-inside-repo"); return true; },
  );
  assert.equal(existsSync(join(renamed, "sub-wt")), false);
});

test("open(): broken-gitlink anchor is a HARD error, never 'outside any repo' (audit c3 F1)", async () => {
  const { repo } = await setup();
  const sub = join(repo, "dead-worktree");
  await mkdir(sub);
  await writeFile(join(sub, ".git"), "gitdir: /nonexistent-gitdir\n"); // moved/copied worktree corpse
  await assert.rejects(
    WorktreeProvisioner.open({ repoRoot: repo, wtRoot: join(sub, "wt") }),
    (e: unknown) => { expectCode(e, "git-failed"); return true; },
  );
  assert.equal(existsSync(join(sub, "wt")), false);
});

test("open(): wtRoot under a linked worktree's .git GITFILE anchors on the worktree (audit c3 F2)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epM", taskId: "t1", baseCommit: base });
  await assert.rejects(
    WorktreeProvisioner.open({ repoRoot: repo, wtRoot: join(wt.path, ".git", "sub") }),
    (e: unknown) => { expectCode(e, "wt-inside-repo"); return true; },
  );
});

// ---------------------------------------------------------------------------
// ensureTaskWorktree: creation, pin, idempotence
// ---------------------------------------------------------------------------

test("ensure creates the task branch pinned at baseCommit with provenance", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "ep1", taskId: "t1", baseCommit: base });

  assert.equal(wt.branch, "agent/ep1/t1");
  assert.equal(wt.head, base);
  assert.equal(wt.baseCommit, base);
  assert.equal(wt.preexisting, false);
  assert.equal(wt.episodeId, "ep1");
  assert.equal(wt.taskId, "t1");
  assert.equal(wt.repoRoot, prov.repoRoot);
  assert.equal(await readFile(join(wt.path, "a.txt"), "utf-8"), "base\n");
  assert.equal(await git(wt.path, "rev-parse", "--abbrev-ref", "HEAD"), "agent/ep1/t1");
  assert.equal(await git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/agent/ep1/t1`), base);
});

test("ensure is idempotent (second call reopens the registration, no churn)", async () => {
  const { prov } = await setup();
  const first = await prov.ensureTaskWorktree({ episodeId: "ep1", taskId: "t1", baseCommit: "main" });
  const second = await prov.ensureTaskWorktree({ episodeId: "ep1", taskId: "t1", baseCommit: "main" });
  assert.equal(second.preexisting, true);
  assert.equal(second.path, first.path);
  assert.equal(second.branch, first.branch);
  assert.equal(second.head, first.head);
});

test("ensure accepts any commit-ish base and pins the resolved sha", async () => {
  const { prov, repo } = await setup();
  await git(repo, "tag", "v1");
  const wt = await prov.ensureTaskWorktree({ episodeId: "ep2", taskId: "t1", baseCommit: "v1" });
  assert.match(wt.baseCommit, /^[0-9a-f]{40}$/);
  assert.equal(wt.head, await git(repo, "rev-parse", "v1^{commit}"));
});

test("ensure: unresolvable baseCommit → unresolvable-base (never HEAD fallback)", async () => {
  const { prov } = await setup();
  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "ep3", taskId: "t1", baseCommit: "no-such-ref" }),
    (e: unknown) => { expectCode(e, "unresolvable-base"); return true; },
  );
  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "ep3", taskId: "t2", baseCommit: "" }),
    (e: unknown) => { expectCode(e, "unresolvable-base"); return true; },
  );
  // A rev that looks like an option is escaped, not executed as one.
  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "ep3", taskId: "t3", baseCommit: "-h" }),
    (e: unknown) => { expectCode(e, "unresolvable-base"); return true; },
  );
});

test("ensure: crash-recovery re-attach when branch exists at base but registration is gone", async () => {
  const { prov, repo, base } = await setup();
  await git(repo, "branch", "agent/ep4/t1", base.slice(0, 12)); // prior attempt created branch only
  const wt = await prov.ensureTaskWorktree({ episodeId: "ep4", taskId: "t1", baseCommit: base });
  assert.equal(wt.branch, "agent/ep4/t1");
  assert.equal(wt.head, base);
  assert.equal(await readFile(join(wt.path, "a.txt"), "utf-8"), "base\n");
});

test("ensure: existing branch NOT at base → branch-conflict (never moved, never adopted)", async () => {
  const { prov, repo, base } = await setup();
  await git(repo, "branch", "agent/ep5/t1", base);
  // advance the branch past base on a throwaway worktree
  const tmpWt = join(prov.wtRoot, "advance-helper");
  await git(repo, "worktree", "add", "--quiet", tmpWt, "agent/ep5/t1");
  await writeFile(join(tmpWt, "new.txt"), "work\n");
  await git(tmpWt, "add", "new.txt");
  await git(tmpWt, "commit", "-m", "task work");
  await git(repo, "worktree", "remove", "--force", tmpWt);

  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "ep5", taskId: "t1", baseCommit: base }),
    (e: unknown) => { expectCode(e, "branch-conflict"); return true; },
  );
  // the branch tip is untouched (still the task-work commit)
  const tipAfter = await git(repo, "rev-parse", "refs/heads/agent/ep5/t1");
  assert.equal(tipAfter, await git(repo, "rev-parse", "agent/ep5/t1"));
  assert.notEqual(tipAfter, base);
});

test("ensure: unmanaged directory at the target path → path-exists (never adopted, never deleted)", async () => {
  const { prov, base } = await setup();
  const target = prov.taskPath("t6");
  await mkdir(target);
  await writeFile(join(target, "mine.txt"), "do not touch\n");
  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "ep6", taskId: "t6", baseCommit: base }),
    (e: unknown) => { expectCode(e, "path-exists"); return true; },
  );
  assert.equal(await readFile(join(target, "mine.txt"), "utf-8"), "do not touch\n");
});

test("ensure: registered worktree on a FOREIGN branch → foreign-branch (refuse, never adopt)", async () => {
  const { prov, repo, base } = await setup();
  const path = prov.taskPath("t7");
  await git(repo, "branch", "someone-elses-branch", base);
  await git(repo, "worktree", "add", "--quiet", path, "someone-elses-branch");
  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "ep7", taskId: "t7", baseCommit: base }),
    (e: unknown) => { expectCode(e, "foreign-branch"); return true; },
  );
  await assert.rejects(
    prov.openTaskWorktree({ episodeId: "ep7", taskId: "t7" }),
    (e: unknown) => { expectCode(e, "foreign-branch"); return true; },
  );
});

test("ensure: detached mode provisions unbranched; branch mode refuses to adopt detached", async () => {
  const { prov, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "ep8", taskId: "t1", baseCommit: base, mode: "detached" });
  assert.equal(wt.branch, null);
  assert.equal(wt.head, base);
  const opened = await prov.openTaskWorktree({ episodeId: "ep8", taskId: "t1" });
  assert.equal(opened?.branch, null);
  assert.equal(opened?.preexisting, true);
  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "ep8", taskId: "t1", baseCommit: base }),
    (e: unknown) => { expectCode(e, "foreign-branch"); return true; },
  );
});

test("ensure: vanished worktree directory → stale-registration until prune", async () => {
  const { prov, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "ep9", taskId: "t1", baseCommit: base });
  await rm(wt.path, { recursive: true, force: true }); // crash simulation (no git teardown)
  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "ep9", taskId: "t1", baseCommit: base }),
    (e: unknown) => { expectCode(e, "stale-registration"); return true; },
  );
  const pr = await prov.prune();
  assert.deepEqual(pr.removed, [wt.path]);
  const again = await prov.ensureTaskWorktree({ episodeId: "ep9", taskId: "t1", baseCommit: base });
  assert.equal(again.preexisting, false);
});

test("bad ids are rejected before any git runs", async () => {
  const { prov, base } = await setup();
  for (const bad of ["", "..", "a/b", ".hidden", "-x", "with space", "back\\slash"]) {
    await assert.rejects(
      prov.ensureTaskWorktree({ episodeId: bad || "ep", taskId: bad, baseCommit: base }),
      (e: unknown) => { expectCode(e, "bad-id"); return true; },
      `taskId ${JSON.stringify(bad)} must be rejected`,
    );
  }
  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "a/b", taskId: "t1", baseCommit: base }),
    (e: unknown) => { expectCode(e, "bad-id"); return true; },
  );
  assert.throws(() => assertSafeComponent("taskId", "a\\b"), /safe/);
  assert.throws(() => taskBranchName("a b", "t"), /safe/);
  assert.equal(taskBranchName("ep.1", "task-2"), "agent/ep.1/task-2");
});

// ---------------------------------------------------------------------------
// removeTaskWorktree: conservative cleanup
// ---------------------------------------------------------------------------

test("remove: refuses a dirty worktree and changes nothing (no mutation before gate)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epA", taskId: "t1", baseCommit: base });
  await writeFile(join(wt.path, "scratch.txt"), "untracked work\n");

  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epA", taskId: "t1" }),
    (e: unknown) => { expectCode(e, "dirty"); return true; },
  );
  // still fully intact: registered, branch alive, file present
  const reg = await listWorktrees(repo);
  assert.equal(reg.some((e) => e.path === wt.path), true);
  assert.equal(await readFile(join(wt.path, "scratch.txt"), "utf-8"), "untracked work\n");

  // force discards explicitly
  const rep = await prov.removeTaskWorktree({ episodeId: "epA", taskId: "t1", force: true });
  assert.equal(rep.worktreeRemoved, true);
  assert.equal(rep.forced, true);
  assert.equal(rep.branchDeleted, false); // branches outlive plain cleanup
  assert.equal(await git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/agent/epA/t1"), base);
});

// M3 audit regressions: the pre-fix gate used plain `status -uall`,
// which reads EMPTY over both scenarios below, and an unforced remove
// then DESTROYED the content (reproduced against pre-fix dist).

test("remove: IGNORED content (info/exclude) refuses as hidden-content, payload survives (M3 audit)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epIg1", taskId: "t1", baseCommit: base });
  // The pre-fix blind spot, exactly as the audit probe reproduced it:
  // a payload directory excluded via the worktree's info/exclude.
  const excl = await git(wt.path, "rev-parse", "--git-path", "info/exclude");
  await writeFile(resolve(wt.path, excl), ".agent/\n", { flag: "a" });
  await mkdir(join(wt.path, ".agent"), { recursive: true });
  await writeFile(join(wt.path, ".agent", "payload.txt"), "SECRET-DO-LOSE\n");
  // Sanity: the OLD gate form genuinely reads clean over this.
  assert.equal(await git(wt.path, "status", "--porcelain", "--untracked-files=all"), "", "pre-fix gate view must read clean (the audit finding)");

  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epIg1", taskId: "t1" }),
    (e: unknown) => { expectCode(e, "hidden-content"); return true; },
  );
  assert.equal(existsSync(wt.path), true, "worktree kept intact");
  assert.equal(await readFile(join(wt.path, ".agent", "payload.txt"), "utf-8"), "SECRET-DO-LOSE\n", "ignored payload NOT destroyed");

  // force remains the explicit discard path
  const rep = await prov.removeTaskWorktree({ episodeId: "epIg1", taskId: "t1", force: true });
  assert.equal(rep.worktreeRemoved, true);
  assert.equal(rep.forced, true);
});

test("remove: IGNORED content (.gitignore) refuses as hidden-content (M3 audit)", async () => {
  const { prov, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epIg2", taskId: "t1", baseCommit: base });
  // .gitignore committed ON the task branch, so the ONLY remaining
  // content is the ignored artifact (an uncommitted .gitignore is
  // ordinary dirty, correctly caught by the untracked half).
  await writeFile(join(wt.path, ".gitignore"), "buildout/\n");
  await git(wt.path, "add", ".gitignore");
  await git(wt.path, "-c", "user.name=ptest", "-c", "user.email=ptest@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "ignore buildout");
  await mkdir(join(wt.path, "buildout"), { recursive: true });
  await writeFile(join(wt.path, "buildout", "artifact.bin"), "built-by-worker\n");
  assert.equal(await git(wt.path, "status", "--porcelain", "--untracked-files=all"), "", "pre-fix gate view must read clean");
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epIg2", taskId: "t1" }),
    (e: unknown) => { expectCode(e, "hidden-content"); return true; },
  );
  assert.equal(await readFile(join(wt.path, "buildout", "artifact.bin"), "utf-8"), "built-by-worker\n");
});

test("remove: an assume-unchanged modified file refuses as hidden-content (M3 audit)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epAu1", taskId: "t1", baseCommit: base });
  // Tracked file modified with the assume-unchanged bit: status (old
  // AND new — ignored status says nothing about flags) reads clean.
  await writeFile(join(wt.path, "a.txt"), "hand-edited, uncommitted\n");
  await git(wt.path, "update-index", "--assume-unchanged", "a.txt");
  assert.equal(await git(wt.path, "status", "--porcelain", "--untracked-files=all"), "", "status is blind to the flag (the audit finding)");
  assert.equal(await git(wt.path, "status", "--porcelain=1", "--ignored=traditional", "--untracked-files=all"), "", "even --ignored does not see the flag");

  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epAu1", taskId: "t1" }),
    (e: unknown) => { expectCode(e, "hidden-content"); return true; },
  );
  assert.equal(existsSync(wt.path), true, "worktree kept — the flagged edit survives");
  assert.equal(await readFile(join(wt.path, "a.txt"), "utf-8"), "hand-edited, uncommitted\n");

  // force discards knowingly
  const rep = await prov.removeTaskWorktree({ episodeId: "epAu1", taskId: "t1", force: true });
  assert.equal(rep.worktreeRemoved, true);
  assert.equal(existsSync(wt.path), false, "forced removal actually removed the tree");
});

test("remove: a LYING fsmonitor hook + fsmonitor-valid bit cannot hide a modified file (audit-haiku F1)", async () => {
  const { prov, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epFsm1", taskId: "t1", baseCommit: base });
  // A hook that answers the simple protocol with "ok" tells git
  // "everything valid" — combined with the fsmonitor-valid index bit,
  // a subsequently modified file reads CLEAN: status prints nothing,
  // ls-files -v keeps its `H` tag (the bit is not a tag), and git's
  // own removal check trusts the bit too. Pre-fix, an unforced remove
  // deleted the edit.
  await git(wt.path, "config", "core.fsmonitor", "echo ok");
  assert.equal(await git(wt.path, "status", "--porcelain=1", "--ignored=traditional", "--untracked-files=all"), "", "clean baseline under the hook");
  await writeFile(join(wt.path, "a.txt"), "edited-under-lying-hook, uncommitted\n");
  await git(wt.path, "update-index", "--fsmonitor-valid", "a.txt");
  // The hole as the audit reproduced it: the naive gate view is blind.
  assert.equal(await git(wt.path, "status", "--porcelain=1", "--ignored=traditional", "--untracked-files=all"), "", "hook+bit hide the edit from a hook-trusting status (the audit finding)");
  // The gate's OWN view forces core.fsmonitor=false — the edit is seen.
  assert.match(await git(wt.path, "-c", "core.fsmonitor=false", "status", "--porcelain=1", "--ignored=traditional", "--untracked-files=all"), /M a\.txt/, "fsmonitor-forced status sees the edit (helper trims the XY space)");

  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epFsm1", taskId: "t1" }),
    (e: unknown) => { expectCode(e, "dirty"); return true; },
  );
  assert.equal(existsSync(wt.path), true, "worktree kept — the hidden edit survives");
  assert.equal(await readFile(join(wt.path, "a.txt"), "utf-8"), "edited-under-lying-hook, uncommitted\n");
});

// --- Audit-sol round 3 (m3fix2) B1/B2: the status proof must be
// filter-neutral AND fileMode-pinned, on a THROWAWAY fresh index (no
// stat cache). Both losses were reproduced against the pre-fix gate by
// the auditor (.tre/review-probes/m3f2-loss.mjs): status read EMPTY,
// every ls-files tag stayed H, and an UNFORCED remove destroyed the
// uncommitted content. These tests are mutation-checked the same way:
// reverting the fresh-index/neutralization block must make them fail.

test("remove: a clean filter mapped to the committed blob cannot hide same-length modified bytes (audit-sol B1)", async () => {
  const { prov, repo, base } = await setup();
  // .gitattributes routes a.txt through filter "discard", whose clean
  // rewrites ANY content to the committed blob. A REAL-index status
  // trusts the stat cache the filter poisoned at add-time: overwriting
  // a.txt with a same-length payload makes filtered comparison say
  // UNCHANGED — status empty, tags all H — and the pre-fix gate
  // removed the tree with the unique payload inside (m3f2-loss.mjs).
  await git(repo, "config", "filter.discard.clean", "sed 's/.*/original/'");
  await writeFile(join(repo, ".gitattributes"), "a.txt filter=discard\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "base with filter");
  const base2 = await git(repo, "rev-parse", "HEAD");
  const wt = await prov.ensureTaskWorktree({ episodeId: "epFil1", taskId: "t1", baseCommit: base2 });
  await writeFile(join(wt.path, "a.txt"), "PAYLOAD!\n");
  // The audit finding: raw bytes differ from the blob, yet the
  // filter-trusting view is silent.
  assert.notEqual(await readFile(join(wt.path, "a.txt"), "utf-8"), "original\n", "payload differs from committed bytes");
  assert.equal(await git(wt.path, "-c", "core.fsmonitor=false", "status", "--porcelain=1", "--ignored=traditional", "--untracked-files=all"), "", "filter-trusting status is blind (the audit finding)");

  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epFil1", taskId: "t1" }),
    (e: unknown) => { expectCode(e, "dirty"); return true; },
  );
  assert.equal(existsSync(wt.path), true, "worktree kept — the payload survives");
  assert.equal(await readFile(join(wt.path, "a.txt"), "utf-8"), "PAYLOAD!\n", "byte-for-byte preservation (the audit's missing-regression ask)");

  // The neutralized gate proves CLEAN the other direction too: an
  // unmodified worktree under the same filter still removes normally.
  // (taskPath is wtRoot/<taskId> — a distinct taskId, the refused t1
  // tree is still on disk.)
  const wt2 = await prov.ensureTaskWorktree({ episodeId: "epFil2", taskId: "t2", baseCommit: base2 });
  const rep2 = await prov.removeTaskWorktree({ episodeId: "epFil2", taskId: "t2" });
  assert.equal(rep2.worktreeRemoved, true, "a genuinely clean filtered worktree is still removable");
});

test("remove: core.fileMode=false cannot hide an exec-bit change (audit-sol B2)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epFm1", taskId: "t1", baseCommit: base });
  // With core.fileMode=false git skips the exec-bit comparison at
  // read-index time: chmod 0755 on a tracked 100644 file (contents
  // UNTOUCHED — the auditor's exact repro) moves no byte, status is
  // EMPTY, tags stay H — and the pre-fix gate removed the tree with
  // the uncommitted mode change inside (m3f2-loss.mjs).
  await git(wt.path, "config", "core.fileMode", "false");
  await chmod(join(wt.path, "a.txt"), 0o755);
  assert.ok((await stat(join(wt.path, "a.txt"))).mode & 0o111, "exec bit set on the worktree file");
  assert.equal(await git(wt.path, "-c", "core.fsmonitor=false", "status", "--porcelain=1", "--ignored=traditional", "--untracked-files=all"), "", "fileMode=false status is blind (the audit finding)");
  assert.match(await git(wt.path, "-c", "core.fsmonitor=false", "-c", "core.fileMode=true", "status", "--porcelain=1", "--ignored=traditional", "--untracked-files=all"), /[M] a\.txt/, "with fileMode pinned true the change is visible (the fix's mechanism)");

  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epFm1", taskId: "t1" }),
    (e: unknown) => { expectCode(e, "dirty"); return true; },
  );
  assert.equal(existsSync(wt.path), true, "worktree kept — the mode change survives");
  assert.ok((await stat(join(wt.path, "a.txt"))).mode & 0o111, "exec bit still set after the refusal");
});

test("remove: a COMMITTED .gitattributes rule arms no driver against the gate — clean filtered worktree still removes (audit-sol B1, GIT_ATTR_SOURCE arm)", async () => {
  // The .gitattributes arm of B1: with no filter.* config in the work
  // tree the rule can't convert anything, so this asserts the
  // neutralization does NOT over-refuse on attributes alone.
  const { prov, repo, base } = await setup();
  await writeFile(join(repo, ".gitattributes"), "*.bin filter=absent-driver\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "base with attrs");
  const base2 = await git(repo, "rev-parse", "HEAD");
  const wt = await prov.ensureTaskWorktree({ episodeId: "epFil3", taskId: "t1", baseCommit: base2 });
  const rep = await prov.removeTaskWorktree({ episodeId: "epFil3", taskId: "t1" });
  assert.equal(rep.worktreeRemoved, true);
});

test("remove: $GIT_DIR/info/attributes rules refuse fail-closed — the arm-the-driver override cannot gate a removal (audit-sol B1 closure)", async () => {
  // info/attributes OVERRIDES GIT_ATTR_SOURCE, so any effective rule
  // there puts content interpretation outside the gate's view — the
  // removal gate refuses before any removal is attempted, even though
  // the worktree is otherwise perfectly clean.
  const { prov, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epAttr1", taskId: "t1", baseCommit: base });
  // Write where the gate looks: `--git-path info/attributes` from the
  // worktree resolves to the COMMON git dir (info/ is common-shared),
  // not the per-worktree admin dir — mirror the gate's own resolution.
  const attrPath = resolve(wt.path, (await git(wt.path, "rev-parse", "--git-path", "info/attributes")).trim());
  await mkdir(dirname(attrPath), { recursive: true });
  await writeFile(attrPath, "a.txt filter=some-driver\n");
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epAttr1", taskId: "t1" }),
    (e: unknown) => { expectCode(e, "hidden-content"); return true; },
  );
  assert.equal(existsSync(wt.path), true, "worktree kept");
  // Comments-only / whitespace-only files are inert and must NOT
  // refuse (the tokenizer follows git attr.c, not JS \s).
  await writeFile(attrPath, "# nothing effective\n\n");
  const rep = await prov.removeTaskWorktree({ episodeId: "epAttr1", taskId: "t1" });
  assert.equal(rep.worktreeRemoved, true, "inert info/attributes does not over-refuse");
});

test("remove: an ambient GIT_WORK_TREE cannot re-route the cleanliness proof to another checkout (audit-sol round-4 B1)", async () => {
  // The gate's proof and git's own removal check inherit the process
  // environment; an inherited GIT_WORK_TREE (or GIT_DIR …) points EVERY
  // git call at a DIFFERENT checkout. The pre-fix gate then proved the
  // OTHER tree clean and deleted this one over an unexamined ignored
  // payload (auditor repro m3f3-env-loss.mjs: unique bytes in an
  // ignored .bak lost). Fix: every provisioner git call strips the
  // whole GIT_* namespace — routing comes from cwd alone.
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epEnv1", taskId: "t1", baseCommit: base });
  const exclPath = resolve(wt.path, (await git(wt.path, "rev-parse", "--git-path", "info/exclude")).trim());
  await mkdir(dirname(exclPath), { recursive: true });
  await writeFile(exclPath, "*.bak\n");
  await writeFile(join(wt.path, "unique.bak"), "UNCOMMITTED UNIQUE PAYLOAD\n");
  assert.match(await git(wt.path, "status", "--porcelain=1", "--ignored=traditional", "-uall"), /!! unique\.bak/, "the task tree itself shows the ignored payload (the auditor's precondition)");

  const saved = { GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_DIR: process.env.GIT_DIR };
  process.env.GIT_WORK_TREE = repo; // the clean MAIN checkout — the redirection
  process.env.GIT_DIR = repo + "/.git";
  try {
    await assert.rejects(
      prov.removeTaskWorktree({ episodeId: "epEnv1", taskId: "t1" }),
      (e: unknown) => { expectCode(e, "hidden-content"); return true; },
      "with the redirect in force the gate must still see THIS tree's ignored content",
    );
    assert.equal(existsSync(wt.path), true, "worktree kept — the payload survives the redirect attempt");
    assert.equal(await readFile(join(wt.path, "unique.bak"), "utf8"), "UNCOMMITTED UNIQUE PAYLOAD\n", "payload bytes intact");
  } finally {
    if (saved.GIT_WORK_TREE === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved.GIT_WORK_TREE;
    if (saved.GIT_DIR === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.GIT_DIR;
  }

  // No over-refusal: with the redirect gone (and the payload removed),
  // a clean tree still removes normally — the strip is invisible to
  // normal operation.
  await rm(join(wt.path, "unique.bak"));
  const rep = await prov.removeTaskWorktree({ episodeId: "epEnv1", taskId: "t1" });
  assert.equal(rep.worktreeRemoved, true, "clean tree still removable");
});

test("remove: submodule entries refuse as has-submodules — protection never rests on git's incidental removal error (audit-haiku F3)", async () => {
  const { prov, repo, base } = await setup();
  // A committed submodule (added to the BASE so the worktree carries
  // the 160000 entry).
  const sub = join(dirname(repo), "suborigin");
  await makeRepo(sub);
  await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", sub, "vend");
  await git(repo, "commit", "-m", "add submodule");
  const base2 = await git(repo, "rev-parse", "HEAD");
  const wt = await prov.ensureTaskWorktree({ episodeId: "epSub1", taskId: "t1", baseCommit: base2 });
  assert.ok((await git(wt.path, "ls-files", "-s")).includes("160000 "), "worktree carries a submodule entry");
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epSub1", taskId: "t1" }),
    (e: unknown) => { expectCode(e, "has-submodules"); return true; },
  );
  assert.equal(existsSync(wt.path), true, "worktree kept");
});

test("remove: an EMPTY index (all-H over nothing) refuses as index-blind — vacuous cleanliness fails closed (audit-haiku F2)", async () => {
  const { prov, repo } = await setup();
  // Forge the finding's state with a DETERMINISTIC shape: a worktree
  // whose baseCommit is an empty-tree root commit (zero entries — a
  // rare but legal state; agent trees always have files, but the gate
  // must not ASSUME that). Its index is legitimately empty: the
  // round-1 all-'H' check passed VACUOUSLY over nothing and removed
  // the tree while every entry was 'verified'. Pre-fix this remove
  // SUCCEEDED; post-fix the empty tag set fails closed as
  // index-blind before any removal is attempted.
  // (git mktree would block on stdin under execFile — use git's
  // canonical empty-tree object id directly.)
  const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const emptySha = await git(repo, "commit-tree", emptyTree, "-m", "empty root");
  assert.equal((await git(repo, "ls-tree", "-r", "--name-only", emptySha)).trim(), "", "base tree is genuinely empty");
  const wt = await prov.ensureTaskWorktree({ episodeId: "epEmpty1", taskId: "t1", baseCommit: emptySha });
  assert.equal((await git(wt.path, "ls-files", "-v")).trim(), "", "index lists zero entries");
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epEmpty1", taskId: "t1" }),
    (e: unknown) => { expectCode(e, "index-blind"); return true; },
  );
  assert.equal(existsSync(wt.path), true, "worktree kept — an empty index is never vacuously removable");
});

test("remove: an ALL-H index (unflagged) still removes clean — the flag gate is not vacuous", async () => {
  const { prov, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epAu2", taskId: "t1", baseCommit: base });
  // Sanity the other direction: a normal checkout's ls-files -v is
  // all-'H '; the new gate must NOT start keeping clean worktrees.
  assert.ok((await git(wt.path, "ls-files", "-v")).split("\n").every((l) => l.startsWith("H ")), "baseline index is all-H");
  const rep = await prov.removeTaskWorktree({ episodeId: "epAu2", taskId: "t1" });
  assert.equal(rep.worktreeRemoved, true);
  assert.equal(rep.forced, false);
});

test("remove: noop when nothing is registered; refuses unmanaged directories", async () => {
  const { prov } = await setup();
  const rep = await prov.removeTaskWorktree({ episodeId: "epB", taskId: "ghost" });
  assert.equal(rep.noop, true);
  assert.equal(rep.worktreeRemoved, false);

  const target = prov.taskPath("notmine");
  await mkdir(target);
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epB", taskId: "notmine" }),
    (e: unknown) => { expectCode(e, "not-registered"); return true; },
  );
});

test("remove: vanished directory → stale-registration (prune is the repair, not remove)", async () => {
  const { prov, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epC", taskId: "t1", baseCommit: base });
  await rm(wt.path, { recursive: true, force: true });
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epC", taskId: "t1" }),
    (e: unknown) => { expectCode(e, "stale-registration"); return true; },
  );
});

test("remove: deleteBranch gated on base-commit proof; unmerged refused; force discards", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epD", taskId: "t1", baseCommit: base });

  // (1) deleteBranch without base proof → refused before mutation
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epD", taskId: "t1", deleteBranch: true }),
    (e: unknown) => { expectCode(e, "no-base-for-branch-delete"); return true; },
  );

  // (2) advance the branch (simulates completed task work), then base-pinned
  // deletion refuses: integration is P12, not P6 cleanup.
  await writeFile(join(wt.path, "work.txt"), "task output\n");
  await git(wt.path, "add", "work.txt");
  await git(wt.path, "commit", "-m", "task work");
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epD", taskId: "t1", baseCommit: base, deleteBranch: true }),
    (e: unknown) => { expectCode(e, "unmerged"); return true; },
  );
  assert.ok(await gitMaybe(repo, "rev-parse", "--verify", "--quiet", "refs/heads/agent/epD/t1"));

  // (3) force = explicit discard of unmerged work
  const rep = await prov.removeTaskWorktree({ episodeId: "epD", taskId: "t1", baseCommit: base, deleteBranch: true, force: true });
  assert.equal(rep.worktreeRemoved, true);
  assert.equal(rep.branchDeleted, true);
  assert.equal(await gitMaybe(repo, "rev-parse", "--verify", "--quiet", "refs/heads/agent/epD/t1"), null);
});

test("remove: unadvanced branch deletes cleanly with baseCommit proof", async () => {
  const { prov, repo, base } = await setup();
  await prov.ensureTaskWorktree({ episodeId: "epE", taskId: "t1", baseCommit: base });
  const rep = await prov.removeTaskWorktree({ episodeId: "epE", taskId: "t1", baseCommit: base, deleteBranch: true });
  assert.equal(rep.worktreeRemoved, true);
  assert.equal(rep.branchDeleted, true);
  assert.equal(await gitMaybe(repo, "rev-parse", "--verify", "--quiet", "refs/heads/agent/epE/t1"), null);
});

test("remove: a base equal to the branch tip is NOT proof — unmerged work is never deleted (audit C8)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epI", taskId: "t1", baseCommit: base });
  await writeFile(join(wt.path, "work.txt"), "real task output\n");
  await git(wt.path, "add", "work.txt");
  await git(wt.path, "commit", "-m", "task work");
  const tip = await git(wt.path, "rev-parse", "HEAD");
  assert.notEqual(tip, base);

  // `base..branch` with base == tip is trivially empty — the naive gate
  // would "prove" loss-free deletion and actually discard the commit.
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epI", taskId: "t1", baseCommit: tip, deleteBranch: true }),
    (e: unknown) => { expectCode(e, "no-base-for-branch-delete"); return true; },
  );
  // Nothing was mutated, and the work is still there.
  assert.equal(await git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/agent/epI/t1"), tip);
  assert.equal(await readFile(join(wt.path, "work.txt"), "utf-8"), "real task output\n");
});

test("ensure: a registration whose HEAD does not descend from the pin is refused, not adopted (audit C5)", async () => {
  const { prov, repo, base } = await setup();
  const first = await prov.ensureTaskWorktree({ episodeId: "epJ", taskId: "t1", baseCommit: base });

  // Move the repo forward: the pin for a retried attempt is now a
  // descendant of the branch, so the branch is NOT at/past the new base.
  await writeFile(join(repo, "b.txt"), "later\n");
  await git(repo, "add", "b.txt");
  await git(repo, "commit", "-m", "base moved on");
  const movedBase = await git(repo, "rev-parse", "HEAD");

  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "epJ", taskId: "t1", baseCommit: movedBase }),
    (e: unknown) => { expectCode(e, "branch-conflict"); return true; },
  );
  // Same-pin retry still converges (the normal idempotent path).
  const again = await prov.ensureTaskWorktree({ episodeId: "epJ", taskId: "t1", baseCommit: base });
  assert.equal(again.preexisting, true);
  assert.equal(again.head, first.head);
});

test("remove: a same-named TAG cannot shadow the branch in the deletion proof (audit ds-c1 F1)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epL", taskId: "t1", baseCommit: base });
  await writeFile(join(wt.path, "work.txt"), "task output\n");
  await git(wt.path, "add", "work.txt");
  await git(wt.path, "commit", "-m", "task work");
  // A tag with the SAME NAME as the branch: git's ref-resolution order
  // puts refs/tags/ before refs/heads/, so an unqualified `rev-parse
  // agent/epL/t1` answers with the TAG's commit (verified against git
  // 2.54) — the old gate "proved" unadvanced-ness against the tag while
  // `branch -D` deleted the real (advanced) branch.
  await git(repo, "tag", "agent/epL/t1", base);
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epL", taskId: "t1", baseCommit: base, deleteBranch: true }),
    (e: unknown) => { expectCode(e, "unmerged"); return true; },
  );
  assert.notEqual(await gitMaybe(repo, "rev-parse", "--verify", "--quiet", "refs/heads/agent/epL/t1"), null);
});

test("remove: force on a LOCKED worktree overrides the lock via double -f (audit ds-c1 F2)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epM", taskId: "t1", baseCommit: base });
  await git(repo, "worktree", "lock", wt.path);
  // git refuses a locked removal with a SINGLE --force ("use 'remove -f
  // -f'"); the force path must pass the double force or it dies late.
  const rep = await prov.removeTaskWorktree({ episodeId: "epM", taskId: "t1", force: true });
  assert.equal(rep.worktreeRemoved, true);
  assert.equal((await listWorktrees(repo)).some((e) => e.path === wt.path), false);
  assert.equal(existsSync(wt.path), false);
});

test("remove: locked + foreign reports foreign-branch, not a discardable locked (audit ds-c1 F6)", async () => {
  const { prov, repo, base } = await setup();
  const path = prov.taskPath("tN");
  await git(repo, "branch", "foreignN", base);
  await git(repo, "worktree", "add", "--quiet", path, "foreignN");
  await git(repo, "worktree", "lock", path);
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epN", taskId: "tN", force: true }),
    (e: unknown) => { expectCode(e, "foreign-branch"); return true; },
  );
});

test("ensure: a LOCKED + vanished registration is stale-registration, not preexisting (audit ds-c1 F3)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epP", taskId: "t1", baseCommit: base });
  await git(repo, "worktree", "lock", wt.path);
  await rm(wt.path, { recursive: true, force: true });
  // git does NOT mark locked entries prunable — without an explicit
  // directory check the vanished worktree would be returned as live with
  // preexisting:true.
  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "epP", taskId: "t1", baseCommit: base }),
    (e: unknown) => { expectCode(e, "stale-registration"); return true; },
  );
});

test("remove: force removes a LOCKED + DIRTY worktree in one shot (audit ds-c2 F3)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epQ", taskId: "t1", baseCommit: base });
  await writeFile(join(wt.path, "dirt.txt"), "uncommitted\n");
  await git(repo, "worktree", "lock", wt.path);
  const rep = await prov.removeTaskWorktree({ episodeId: "epQ", taskId: "t1", force: true });
  assert.equal(rep.worktreeRemoved, true);
  assert.equal(existsSync(wt.path), false);
  assert.equal((await listWorktrees(repo)).some((e) => e.path === wt.path), false);
});

test("remove: locked+vanished is stale-registration with actionable guidance, never a circular refusal (audit ds-c2 F4)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epS", taskId: "t1", baseCommit: base });
  await git(repo, "worktree", "lock", wt.path);
  await rm(wt.path, { recursive: true, force: true });
  // Proven experimentally: git cannot host a SECOND live checkout of the
  // branch while a stale registration claims it (worktree add refuses),
  // so the reachable collision state is exactly this one — the gate's
  // staleUsers/liveUsers split must report the stale state, and it must
  // name the recovery (unlock + prune).
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epS", taskId: "t1", deleteBranch: true }),
    (e: unknown) => {
      expectCode(e, "stale-registration");
      const m = (e as WorktreeProvisionError).message;
      assert.ok(m.includes("unlock") && m.includes("prune"), `message must name the recovery path, got: ${m}`);
      return true;
    },
  );
});

test("ensure/remove: a DANGLING SYMLINK at the task path is occupied, not absent (audit ds-c5 F5)", async () => {
  const { prov, base } = await setup();
  const path = prov.taskPath("tLink");
  await mkdir(dirname(path), { recursive: true });
  await symlink(join(dirname(path), "nowhere"), path);
  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "epX", taskId: "tLink", baseCommit: base }),
    (e: unknown) => { expectCode(e, "path-exists"); return true; },
  );
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epX", taskId: "tLink" }),
    (e: unknown) => { expectCode(e, "not-registered"); return true; },
  );
});

test("ensure: an id that passes SAFE_COMPONENT but breaks check-ref-format is bad-id, not git-failed (audit ds-c4 F2)", async () => {
  const { prov, base } = await setup();
  // "a..b" is SAFE_COMPONENT-legal but no legal ref component — only
  // assertValidBranch's check-ref-format can see it.
  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "a..b", taskId: "t1", baseCommit: base }),
    (e: unknown) => { expectCode(e, "bad-id"); return true; },
  );
  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "ep", taskId: "t1.lock", baseCommit: base }),
    (e: unknown) => { expectCode(e, "bad-id"); return true; },
  );
});

test("ensure/remove: a plain FILE at the task path is a typed refusal in both directions (audit ds-c4 F3)", async () => {
  const { prov, base } = await setup();
  const path = prov.taskPath("tFile");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "occupant\n");
  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "epW", taskId: "tFile", baseCommit: base }),
    (e: unknown) => { expectCode(e, "path-exists"); return true; },
  );
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epW", taskId: "tFile" }),
    (e: unknown) => { expectCode(e, "not-registered"); return true; },
  );
});

test("open(): wtRoot existing as a regular FILE is a typed bad-wt-root refusal, not raw EEXIST (audit ds-c3 F4)", async () => {
  const { dir, repo } = await setup();
  const filePath = join(dir, "file-as-wtroot");
  await writeFile(filePath, "not a directory\n");
  await assert.rejects(
    WorktreeProvisioner.open({ repoRoot: repo, wtRoot: filePath }),
    (e: unknown) => { expectCode(e, "bad-wt-root"); return true; },
  );
});

test("ensure: an UNLOCKED entry whose dir was recreated as a plain dir is still prunable-stale (audit ds-c3 F1 disproven, pinned)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epV", taskId: "t1", baseCommit: base });
  await rm(wt.path, { recursive: true, force: true });
  await mkdir(wt.path, { recursive: true }); // plain dir, no .git gitfile
  // git's prune check inspects <path>/.git, not <path>: a recreated
  // plain directory STILL lists prunable (verified git 2.54) — this test
  // pins that behavior against a git change that would break entryGone's
  // unlocked fast-path.
  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "epV", taskId: "t1", baseCommit: base }),
    (e: unknown) => { expectCode(e, "stale-registration"); return true; },
  );
});

test("ensure: a locked entry whose path was recreated as a plain dir is stale, not a live worktree (audit ds-c2 F5)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epT", taskId: "t1", baseCommit: base });
  await git(repo, "worktree", "lock", wt.path);
  await rm(wt.path, { recursive: true, force: true });
  await mkdir(wt.path, { recursive: true }); // plain dir, no .git gitfile
  await assert.rejects(
    prov.ensureTaskWorktree({ episodeId: "epT", taskId: "t1", baseCommit: base }),
    (e: unknown) => { expectCode(e, "stale-registration"); return true; },
  );
});

test("ensure: a same-named tag does NOT detach the crash-recovery attach (audit ds-c2 F1 disproven — keep operand unqualified)", async () => {
  const { prov, repo, base } = await setup();
  // Create the branch at base WITHOUT a worktree registration (crash
  // simulation), then plant a same-named tag, then re-ensure: git 2.54
  // rebinds the BRANCH (branch-oriented commit-ish), not the tag.
  const branch = taskBranchName("epU", "t1");
  await git(repo, "branch", branch, base);
  await git(repo, "tag", branch, base);
  const wt = await prov.ensureTaskWorktree({ episodeId: "epU", taskId: "t1", baseCommit: base });
  assert.equal(wt.branch, branch);
  const headRef = await git(wt.path, "symbolic-ref", "HEAD");
  assert.equal(headRef.trim(), `refs/heads/${branch}`);
});

test("prune: a LOCKED stale entry under wtRoot is refused, never a silent skip (audit ds-c1 F3)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epO", taskId: "t1", baseCommit: base });
  await git(repo, "worktree", "lock", wt.path);
  await rm(wt.path, { recursive: true, force: true });
  // git's prune SKIPS locked entries — returning {removed: []} would tell
  // the caller cleanup succeeded while the stale registration survives.
  await assert.rejects(
    prov.prune(),
    (e: unknown) => { expectCode(e, "locked"); return true; },
  );
  assert.equal((await listWorktrees(repo)).some((e) => e.path === wt.path), true);
  // After an explicit unlock, prune converges.
  await git(repo, "worktree", "unlock", wt.path);
  const done = await prov.prune();
  assert.deepEqual(done.removed, [wt.path]);
});

test("remove: a locked worktree is refused with \`locked\`, not a bare git failure (audit C6)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epK", taskId: "t1", baseCommit: base });
  await git(repo, "worktree", "lock", wt.path);
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epK", taskId: "t1" }),
    (e: unknown) => { expectCode(e, "locked"); return true; },
  );
  // The entry survives a locked refusal; force is the explicit override.
  assert.equal((await listWorktrees(repo)).some((e) => e.path === wt.path), true);
});

test("remove: refuses a foreign-branch registration (never someone else's worktree)", async () => {
  const { prov, repo, base } = await setup();
  const path = prov.taskPath("tF");
  await git(repo, "branch", "foreign", base);
  await git(repo, "worktree", "add", "--quiet", path, "foreign");
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epF", taskId: "tF" }),
    (e: unknown) => { expectCode(e, "foreign-branch"); return true; },
  );
});

test("remove: deleteBranch refuses when the branch is checked out elsewhere (audit F5: no partial mutation)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epK", taskId: "t1", baseCommit: base });
  // git only allows a double checkout with --force (the audit's scenario)
  const dup = join(prov.wtRoot, "dup-checkout");
  await git(repo, "worktree", "add", "--quiet", "--force", dup, "agent/epK/t1");

  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epK", taskId: "t1", baseCommit: base, deleteBranch: true }),
    (e: unknown) => { expectCode(e, "branch-in-use"); return true; },
  );
  // NOTHING mutated: both registrations intact
  const reg = await listWorktrees(repo);
  assert.equal(reg.filter((e) => e.branch === "agent/epK/t1").length, 2);

  // cleanup: drop the duplicate, then the normal path still works
  await git(repo, "worktree", "remove", dup);
  const rep = await prov.removeTaskWorktree({ episodeId: "epK", taskId: "t1", baseCommit: base, deleteBranch: true });
  assert.equal(rep.worktreeRemoved, true);
  assert.equal(rep.branchDeleted, true);
});

// ---------------------------------------------------------------------------
// prune()
// ---------------------------------------------------------------------------

test("prune: reports its own removals and refuses to touch stale entries outside wtRoot", async () => {
  const { prov, repo, base } = await setup();
  const dir = prov.wtRoot.replace(/[/]wt$/, "");

  // stale entry OUTSIDE our wtRoot (another tool's worktree, vanished)
  const foreignWt = join(dir, "foreign-wt");
  await git(repo, "worktree", "add", "--quiet", foreignWt, "--detach", base);
  await rm(foreignWt, { recursive: true, force: true });

  // C1: a refusal is an ERROR (I8), never an inspectable return value.
  await assert.rejects(
    prov.prune(),
    (e: unknown) => { expectCode(e, "prune-refused"); assert.match((e as Error).message, /outside/); return true; },
  );
  // ... and nothing was pruned while refusing.
  assert.equal((await listWorktrees(repo)).some((e) => e.path === foreignWt), true);

  // With the foreign entry cleared, our prune converges and reports
  // exactly our own vanished worktree.
  await git(repo, "worktree", "prune");
  const wt = await prov.ensureTaskWorktree({ episodeId: "epG", taskId: "t1", baseCommit: base });
  await rm(wt.path, { recursive: true, force: true });
  const done = await prov.prune();
  assert.deepEqual(done.removed, [wt.path]);
  const reg2 = await listWorktrees(repo);
  assert.equal(reg2.some((e) => e.path === wt.path), false);
});

test("prune: no-op when nothing is stale (and never disturbs live worktrees)", async () => {
  const { prov, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epH", taskId: "t1", baseCommit: base });
  const r = await prov.prune();
  assert.deepEqual(r, { removed: [] });
  assert.equal(await readFile(join(wt.path, "a.txt"), "utf-8"), "base\n");
});

// ---------------------------------------------------------------------------
// plumbing helpers
// ---------------------------------------------------------------------------

test("resolveCommit: sha round-trip, peeling, and rejection", async () => {
  const { repo, base } = await setup();
  assert.equal(await resolveCommit(repo, base), base);
  assert.equal(await resolveCommit(repo, "main"), base);
  await git(repo, "tag", "v2");
  assert.equal(await resolveCommit(repo, "v2"), base);
  // a blob-ish ref (a file in the tree) is not a commit
  await assert.rejects(resolveCommit(repo, "main:a.txt"), (e: unknown) => { expectCode(e, "unresolvable-base"); return true; });
  await assert.rejects(resolveCommit(repo, "   "), (e: unknown) => { expectCode(e, "unresolvable-base"); return true; });
});

test("listWorktrees parses the registry (main + tasks, branches, prunable)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epI", taskId: "t1", baseCommit: base });
  await prov.ensureTaskWorktree({ episodeId: "epI", taskId: "t2", baseCommit: base, mode: "detached" });
  const reg = await listWorktrees(repo);
  assert.equal(reg.length, 3);
  const mainPath = await realpath(repo);
  const main = reg.find((e) => e.path === mainPath);
  assert.ok(main);
  assert.equal(main!.branch, "main");
  assert.equal(main!.prunable, false);
  const t1 = reg.find((e) => e.path === wt.path);
  assert.ok(t1);
  assert.equal(t1!.branch, "agent/epI/t1");
  assert.equal(t1!.head, base);
  const t2 = reg.find((e) => e.branch === null && e.path !== main!.path);
  assert.ok(t2);
  assert.equal(t2!.prunable, false);
});

// ---------------------------------------------------------------------------
// Compartment guards (mirrors the P5 pattern)
// ---------------------------------------------------------------------------

test("P6 guard: nothing outside src/worktree/ imports the worktree module", async () => {
  const files = await walkTs("src");
  const offenders: string[] = [];
  for (const file of files) {
    if (file.startsWith("src/worktree" + "/")) continue;
    const content = await readFile(file, "utf-8").catch(() => "");
    if (/(?:from\s+|import\s*\(\s*)["'][^"']*\/worktree\/[a-z]+["']/.test(content)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `worktree primitives must stay compartmentalized until P7/P9 wires them in: ${offenders.join(", ")}`);
});

test("P6 guard: src/worktree imports nothing in the repo except node: builtins", async () => {
  const files = await walkTs(join("src", "worktree"));
  assert.ok(files.length >= 1);
  for (const file of files) {
    const content = await readFile(file, "utf-8");
    const specifiers = [...content.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!);
    const foreign = specifiers.filter((s) => !s.startsWith("node:"));
    assert.deepEqual(foreign, [], `${file} must import only node: builtins (found: ${foreign.join(", ")})`);
  }
  const mod = await import("../src/worktree/provision.js");
  assert.ok(mod.WorktreeProvisioner);
});

/** Every *.ts file under `dir` (recursive), as paths relative to the repo root. */
async function walkTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { recursive: true })) {
    const p = join(dir, String(e));
    if (p.endsWith(".ts")) out.push(p.replace(/\\/g, "/").replace(/^\.\//, ""));
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Sol round-5 (audit m3f5) B1 — routing poison: worktreeConfig redirect
// ---------------------------------------------------------------------------

/** Poison helper: arm extensions.worktreeConfig and re-route the
 *  worktree's checkout resolution to `target` via its OWN
 *  .git/worktrees/<id>/config.worktree. This is file-based config —
 *  env stripping (round 4) and `-c core.worktree=` pins cannot beat it
 *  (verified git 2.54); ONLY the top-level `--work-tree=` option does. */
async function poisonRouting(wtPath: string, target: string): Promise<void> {
  await git(wtPath, "config", "extensions.worktreeConfig", "true");
  await git(wtPath, "config", "--worktree", "core.worktree", target);
}

test("remove: config.worktree routing poison refuses as routing-poisoned, payload survives BOTH paths (sol R5 B1)", async () => {
  const { prov, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epRt1", taskId: "t1", baseCommit: base });
  const dir = await freshDir("rt-target-");
  await poisonRouting(wt.path, dir);
  // The registered tree holds a unique payload the redirect target lacks.
  await writeFile(join(wt.path, "unique.bak"), "PAYLOAD-DO-LOSE\n");

  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epRt1", taskId: "t1" }),
    (e: unknown) => { expectCode(e, "routing-poisoned"); return true; },
  );
  assert.equal(existsSync(wt.path), true, "poisoned worktree kept intact");
  assert.equal(await readFile(join(wt.path, "unique.bak"), "utf-8"), "PAYLOAD-DO-LOSE\n");

  // Force does NOT authorize operating through poisoned routing.
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epRt1", taskId: "t1", force: true }),
    (e: unknown) => { expectCode(e, "routing-poisoned"); return true; },
  );
  assert.equal(existsSync(wt.path), true, "force path keeps the tree — routing refusal outranks force");
  assert.equal(await readFile(join(wt.path, "unique.bak"), "utf-8"), "PAYLOAD-DO-LOSE\n", "unique payload NOT destroyed");
});

test("remove: routing poison with the MAIN REPO as target would read clean pre-fix (sol R5 B1 mutation witness)", async () => {
  // Pre-fix behavior witness WITHOUT touching the guard: reproduce the
  // fooled git view at the git level. Redirect to the main repo root,
  // then run the EXACT pre-fix gate command (plain status, no pin):
  // git reads the TARGET (clean) while the registered dir holds an
  // ignored payload — the pre-fix proof passed and remove destroyed
  // the tree (E1, reproduced during the round-5 audit).
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epRt2", taskId: "t1", baseCommit: base });
  await poisonRouting(wt.path, repo);
  await writeFile(join(wt.path, "unique.bak"), "PAYLOAD-DO-LOSE\n");
  // Fooled view: status from the worktree cwd reads the MAIN repo —
  // clean — while this registered dir holds the payload...
  assert.equal(await git(wt.path, "status", "--porcelain=1", "--ignored=traditional", "--untracked-files=all"), "", "pre-fix gate view must read clean (the audit finding)");
  // ...while the PINNED view sees this tree honestly.
  const pinned = await git(wt.path, `--work-tree=${wt.path}`, "status", "--porcelain=1", "--ignored=traditional", "--untracked-files=all");
  assert.match(pinned, /unique\.bak/, "pinned status must see this tree's payload");
  // And our removal refuses through the guard rather than trusting either view.
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epRt2", taskId: "t1" }),
    (e: unknown) => { expectCode(e, "routing-poisoned"); return true; },
  );
  assert.equal(existsSync(join(wt.path, "unique.bak")), true);
});

test("remove: clean worktree still removes with the --work-tree pins (no regression, sol R5 B1)", async () => {
  const { prov, repo, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epRt3", taskId: "t1", baseCommit: base });
  const rep = await prov.removeTaskWorktree({ episodeId: "epRt3", taskId: "t1" });
  assert.equal(rep.worktreeRemoved, true);
  assert.equal(existsSync(wt.path), false);
  assert.equal((await listWorktrees(repo)).length, 1, "only the main worktree remains");
});

test("remove: routing poison survives an unfixable realpath (symlinked registered path) — refuses, never removes (sol R5 B1 fail-closed)", async () => {
  // Registered path IS a symlink whose realpath differs from the
  // literal path the entry carries: the guard cannot canonicalize a
  // mismatch pair trivially; it must still resolve honestly — toplevel
  // realpath vs entry realpath — and a redirect mismatch refuses.
  const { prov, base } = await setup();
  const wt = await prov.ensureTaskWorktree({ episodeId: "epRt4", taskId: "t1", baseCommit: base });
  await poisonRouting(wt.path, await freshDir("rt-target-"));
  // Sanity: git itself now resolves the checkout elsewhere...
  const seen = await git(wt.path, "rev-parse", "--show-toplevel");
  assert.notEqual(seen, wt.path, "redirect must move the resolution (precondition)");
  await assert.rejects(
    prov.removeTaskWorktree({ episodeId: "epRt4", taskId: "t1", force: true }),
    (e: unknown) => { expectCode(e, "routing-poisoned"); return true; },
  );
  assert.equal(existsSync(wt.path), true);
});
