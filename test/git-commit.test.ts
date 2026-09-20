/**
 * git-commit skill — scripts/git-commit.sh is the gated commit action:
 * clean-tree no-op (10), gate failure (11, nothing staged/committed),
 * a clean commit (0, verified), guardrail-zone rejection (1, no commit),
 * and usage errors (2). Fixtures are throwaway git repos with a trivial
 * GATE so the tests never run the real suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// This file compiles to dist/test/, so two levels up is the repository root.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMMIT_SCRIPT = path.join(repoRoot, "scripts", "git-commit.sh");

function sh(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string> } = { cwd: repoRoot }): { status: number; out: string } {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, ...opts.env }
  });
  return { status: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}

// Under the kernel sandbox git emits "warning: unable to access '/etc/...'"
// lines to stderr (it cannot read system files). Those are noise for these
// assertions — strip them so we assert on git's real output.
function git(dir: string, args: string[]): { status: number; out: string } {
  const r = sh("git", args, { cwd: dir });
  const out = r.out
    .split("\n")
    .filter((l) => !/^warning:/.test(l))
    .join("\n");
  return { status: r.status, out };
}

/** A throwaway git repo with identity + a trivial passing gate. */
function makeRepo(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-commit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

function runCommit(dir: string, args: string[], gate = "true"): { status: number; out: string } {
  return sh("sh", [COMMIT_SCRIPT, ...args], { cwd: dir, env: { GATE: gate } });
}

test("git-commit: clean tree is a no-op (exit 10, nothing committed)", (t) => {
  const dir = makeRepo(t);
  const before = git(dir, ["rev-parse", "HEAD"]).out.trim();
  const r = runCommit(dir, ["hello"]);
  assert.equal(r.status, 10);
  assert.match(r.out, /nothing to commit/);
  assert.equal(git(dir, ["rev-parse", "HEAD"]).out.trim(), before);
});

test("git-commit: dirty tree + passing gate commits and verifies (exit 0)", (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, "new.txt"), "added\n");
  const r = runCommit(dir, ["add new.txt"]);
  assert.equal(r.status, 0);
  assert.match(r.out, /gate passed/);
  assert.match(r.out, /OK — committed/);
  assert.equal(git(dir, ["log", "-1", "--pretty=%s"]).out.trim(), "add new.txt");
  assert.equal(git(dir, ["status", "--porcelain"]).out.trim(), "");
});

test("git-commit: failing gate exits 11, nothing staged or committed", (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, "new.txt"), "added\n");
  const before = git(dir, ["rev-parse", "HEAD"]).out.trim();
  const r = runCommit(dir, ["should not commit"], "false");
  assert.equal(r.status, 11);
  assert.match(r.out, /GATE FAILED/);
  assert.equal(git(dir, ["rev-parse", "HEAD"]).out.trim(), before);
  assert.equal(git(dir, ["status", "--porcelain"]).out.trim(), "?? new.txt");
});

test("git-commit: guardrail-zone commit is rejected (exit 1, no new commit)", (t) => {
  const dir = makeRepo(t);
  // A pre-commit hook that rejects changes to a protected path — mirrors the
  // real guardrail hook's contract (the agent must never bypass it).
  const hooks = path.join(dir, ".git", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(
    path.join(hooks, "pre-commit"),
    "#!/bin/sh\nif git diff --cached --name-only | grep -q '^protected\\.txt$'; then\n  echo 'GUARDRAIL: REJECTED' >&2\n  exit 1\nfi\nexit 0\n"
  );
  fs.chmodSync(path.join(hooks, "pre-commit"), 0o755);
  fs.writeFileSync(path.join(dir, "protected.txt"), "v1\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base-protected"]);
  const before = git(dir, ["rev-parse", "HEAD"]).out.trim();
  fs.writeFileSync(path.join(dir, "protected.txt"), "v2\n");
  const r = runCommit(dir, ["touch the zone"]);
  assert.equal(r.status, 1);
  assert.match(r.out, /COMMIT FAILED/);
  assert.equal(git(dir, ["rev-parse", "HEAD"]).out.trim(), before);
});

test("git-commit: no message is a usage error (exit 2)", (t) => {
  const dir = makeRepo(t);
  const r = runCommit(dir, []);
  assert.equal(r.status, 2);
  assert.match(r.out, /usage/);
});

test("git-commit: empty message is a usage error (exit 2)", (t) => {
  const dir = makeRepo(t);
  const r = runCommit(dir, [""]);
  assert.equal(r.status, 2);
  assert.match(r.out, /empty commit message/);
});

test("git-commit: outside a git repo is a usage error (exit 2)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-nogit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = runCommit(dir, ["hello"]);
  assert.equal(r.status, 2);
  assert.match(r.out, /not a git repository/);
});
