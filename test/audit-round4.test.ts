/**
 * Round-4 audit (`.tre/audits/r4-sol-report.md`) regression tests — R4-B1.
 *
 *  B1 (BLOCKER, src/host/supervise.ts): the ACCEPTANCE-side observation
 *  (`observeIdentity`) ran a plain `git status` trusting the REPO's own
 *  conversion settings on a STAT-CACHED index. A tracked `.gitattributes`
 *  (round-2's refusal only covered `$GIT_DIR/info/attributes`) naming
 *  `filter.evil` whose clean driver maps ANY bytes to the committed blob
 *  made mutated bytes compare clean-equal to HEAD; and a plain status run
 *  (the gate's own `git status`, or any earlier observation) refreshing
 *  the stat cache hid the change even from a later NEUTRALIZED scan.
 *  `sameArtifact` passed, gate + artifact evidence stamped on forged
 *  bytes, and the verdict `complete` was minted (repro
 *  .tre/review-probes/r4-false-clean.mjs; escalation r4-b1-episode.mjs).
 *  The integration gate had been hardened against this exact class the
 *  prior round (fresh-index read-tree + GIT_ATTR_SOURCE=EMPTY_TREE);
 *  acceptance was the same attack class, half the chain.
 *
 *  Fix: `observeStatusFresh` — every acceptance-side status observation
 *  builds a THROWAWAY index (`read-tree HEAD` into a temp GIT_INDEX_FILE)
 *  under `GIT_ATTR_SOURCE=<empty tree>` + the pinned neutralizing filter
 *  drivers, so NOTHING is cached (the index has no stat data — every
 *  tracked file is re-read and re-hashed raw) and NO conversion path
 *  exists. Any build/observation failure marks the identity
 *  dirty+unobservable (fail closed, never comparable). Mutation-tested:
 *  reverting to a plain `git status` makes tests 1–3 fail (the forged
 *  observation returns clean and the verdict flips to `complete`).
 *
 *  Control (test 4): the fresh index must not fabricate dirt — a clean
 *  tree still observes CLEAN (artifact-only acceptance still completes
 *  its honest verdict) and an honest dirty tree stays COMPARABLE across
 *  observations (the prior round's "fully-measured dirty trees stay
 *  equal" property, re-pinned under the new observation shape).
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

/** Poisoned repo (the exact r4-false-clean fixture): `base.txt` at the
 *  RAW bytes "base\n" (the evil filter is defined AFTER the commit so
 *  the committed blob is raw), `.gitattributes` TRACKED with
 *  `base.txt filter=evil`, and `filter.evil.clean` mapping any content
 *  to "base\n" — under a converting, stat-cached status the worktree
 *  reads clean whatever it holds. */
async function makePoisonedRepo(t: { after: (fn: () => void) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tre-r4b1-repo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main", "."]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  await writeFile(join(dir, ".gitattributes"), "base.txt filter=evil\n");
  await writeFile(join(dir, "base.txt"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  // Define the driver AFTER the commit so the blob stays raw "base\n".
  git(dir, ["config", "filter.evil.clean", "sed 's/.*/base/'"]);
  git(dir, ["config", "filter.evil.smudge", "cat"]);
  return dir;
}

const poisonGraph = (baseCommit: string): Graph => ({
  schema: "tre-graph/1",
  episodeId: "ep-r4b1",
  goal: "round-4 audit regression",
  policy: { baseCommit, gate: { cmd: "printf 'EVIL\\n' > base.txt; git status --porcelain >/dev/null; exit 0", timeoutS: 30 } },
  tasks: [{
    id: "t1", persona: "worker", promptRef: "p", dependsOn: [],
    acceptance: { criteria: ["policy-gate"], requiredChecks: [], artifacts: ["base.txt"] },
  }],
});

test("round-4 R4-B1 (unit): a tracked .gitattributes filter=evil cannot make forged bytes observe clean — the fresh-index status re-hashes raw and reports the delta, honestly dirty and comparable, even after a plain-status stat-cache refresh", async (t) => {
  const repo = await makePoisonedRepo(t);
  const sha = git(repo, ["rev-parse", "HEAD"]).out;
  const before = await observeIdentity(repo, sha);
  assert.ok(before.sha === sha, "clean baseline: sha observed");

  await writeFile(join(repo, "base.txt"), "EVIL\n"); // same length: mtime-only-size forgery
  // THE STAT-CACHE HALF of the attack: a plain (unpinned, repo-config)
  // `git status` — exactly what the gate ran pre-fix — stamps the
  // mutated file's stat under the poison so even a LATER neutral scan
  // used to read it clean.
  git(repo, ["status", "--porcelain"]);
  git(repo, ["status", "--porcelain"]);

  const after = await observeIdentity(repo, sha);
  assert.equal(after.dirty, true, "forged bytes MUST report dirty under the fresh-index observation (pre-fix: clean)");
  assert.notEqual(after.unobservable, true, "the delta IS measured (pinned drivers + fresh index): this is honest dirt, not a fail-closed blind spot");
  assert.equal(sameArtifact(before, after), false, "the forged tree must never be the same artifact as the clean baseline");
  const again = await observeIdentity(repo, sha);
  assert.equal(sameArtifact(after, again), true, "the honest dirty delta stays comparable across observations (no false-negative regression)");
});

test("round-4 R4-B1 (end-to-end, the audit's named regression): filter/stat-cache forgery through collectAcceptanceEvidence + evaluate yields NO `complete` verdict — the forged gate-written bytes never earn acceptance", async (t) => {
  const repo = await makePoisonedRepo(t);
  const sha = git(repo, ["rev-parse", "HEAD"]).out;
  const root = await mkdtemp(join(tmpdir(), "tre-r4b1-ep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // The graph gate mutates base.txt to forged bytes and runs a PLAIN
  // `git status` inside itself (the r4-false-clean shape): the pass is
  // claimed over a tree whose raw bytes differ from HEAD.
  const ev = await collectAcceptanceEvidence({ graph: poisonGraph(sha), taskId: "t1", epPath: join(root, "ep"), worktreePath: repo });
  assert.equal(ev.current.dirty, true, "the post-gate identity is dirty: forged bytes are seen (pre-fix: clean-equal to HEAD)");
  const assessment = evaluate(ev);
  assert.notEqual(assessment.verdict, "complete",
    `no complete verdict over forged worktree bytes (got ${assessment.verdict}; reasons=${JSON.stringify(assessment.reasons)})`);
  assert.ok(assessment.remainingWork.length > 0 || assessment.verdict === "uncertain" || assessment.verdict === "incomplete",
    "the non-complete verdict is fail-closed, never an unexplained pass");
});

test("round-4 R4-B1 (control): the fresh index fabricates no dirt — a CLEAN poisoned-config tree still observes clean, and its honest artifact-only acceptance still completes", async (t) => {
  const repo = await makePoisonedRepo(t);
  const sha = git(repo, ["rev-parse", "HEAD"]).out;
  const obs = await observeIdentity(repo, sha);
  assert.notEqual(obs.dirty, true, "clean tree under a filter-poisoned config must still observe CLEAN (GIT_ATTR_SOURCE=EMPTY pins the interpreter, not the whole observation)");
  assert.notEqual(obs.unobservable, true, "and comparable (no marker): the fix must not mark every observation unobservable");
  const root = await mkdtemp(join(tmpdir(), "tre-r4b1-ctl-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clean = {
    ...poisonGraph(sha),
    policy: { baseCommit: sha, gate: { cmd: "exit 0", timeoutS: 10 } },
  } as Graph;
  const ev = await collectAcceptanceEvidence({ graph: clean, taskId: "t1", epPath: join(root, "ep"), worktreePath: repo });
  const assessment = evaluate(ev);
  assert.equal(assessment.verdict, "complete",
    `the honest clean path must still complete (reasons=${JSON.stringify(assessment.reasons)})`);
});

test("round-4 R4-B1 (fresh-index durability): untracked additions stay visible through the throwaway index, and an honest dirty tree remains comparable across two full evidence collections", async (t) => {
  const repo = await makePoisonedRepo(t);
  const sha = git(repo, ["rev-parse", "HEAD"]).out;
  await writeFile(join(repo, "newfile.txt"), "untracked payload\n");
  const obs1 = await observeIdentity(repo, sha);
  assert.equal(obs1.dirty, true, "an untracked file is dirt");
  assert.notEqual(obs1.unobservable, true, "and it is MEASURED dirt (--untracked-files=all rides the fresh-index status)");
  const obs2 = await observeIdentity(repo, sha);
  assert.equal(sameArtifact(obs1, obs2), true, "unchanged state re-observes equal under the fresh index");
  await writeFile(join(repo, "newfile.txt"), "changed payload\n");
  const obs3 = await observeIdentity(repo, sha);
  assert.equal(sameArtifact(obs1, obs3), false, "changing the untracked bytes moves the identity");
});
