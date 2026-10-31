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
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
