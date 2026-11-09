/**
 * P9 audit cycle-3 regression tests (C3-F1 HIGH, C3-F2 MEDIUM).
 *
 *  C3-F1 (src/integration/merge.ts): replacement refs (refs/replace/*)
 *  redirect object interpretation. A forged replacement making the RAW
 *  task tip an ANCESTOR of the episode head made the resolve stage's
 *  containment probe answer already-merged while the raw task work was
 *  absent from the raw head. Fix: GIT_NO_REPLACE_OBJECTS=1 in gitEnv()
 *  AND the --no-replace-objects CLI flag pinned on every call through
 *  execCapture (the module's single git choke point), so ancestry,
 *  construct, recovery, re-verify, and the CAS all resolve RAW objects.
 *
 *  C3-F2 (src/host/supervise.ts): the host's seq-recomputation loop
 *  classified EVERY unacked merge outcome as an act-unknown terminal —
 *  but P12's own sticky rule (merge.ts dedup scan) treats an outcome
 *  whose notes start with "no-effect:" as provably effect-free and
 *  REPLAYABLE. The host announced a replayable refusal as a stranded
 *  act-unknown on every activation. Fix: mirror P12's rule — only an
 *  unacked outcome WITHOUT the "no-effect:" note prefix increments the
 *  disclosure counter.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { integrateTestedCandidate, type IntegrationPorts } from "../src/integration/merge.js";
import { DecisionJournal, validateSupervisorRecord, type EpisodeGraph } from "../src/episode/journal.js";
import { runHostEpisode } from "../src/host/supervise.js";

function git(dir: string, args: string[]): { status: number; out: string } {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 30000 });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`
    .split("\n").filter((l) => !/^warning:/.test(l)).join("\n");
  if ((r.status ?? -1) !== 0) throw new Error(`git ${args.join(" ")} failed: ${out}`);
  return { status: r.status ?? 0, out: out.trim() };
}
const head = (dir: string, ref: string): string => git(dir, ["rev-parse", "--verify", `${ref}^{commit}`]).out;

// ─── C3-F1: replacement refs must never redirect P12 ─────────────────────

test("P12 cycle-3 F1: a forged replacement ref making the task tip an ancestor of ep-head must NOT fake already-merged — the merge runs on RAW objects", async (t) => {
  // Clean diverged repo (the standard P12 fixture shape), ws checked out.
  const dir = await mkdtemp(join(tmpdir(), "tre-c3f1-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "ep1", "."]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  await writeFile(join(dir, "base.txt"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["checkout", "-q", "-b", "agent/ep1/t1"]);
  await writeFile(join(dir, "task.txt"), "task work\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "task work"]);
  const rawTaskTip = head(dir, "refs/heads/agent/ep1/t1");
  git(dir, ["checkout", "-q", "ep1"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "ep-only work"]);
  const epHead = head(dir, "refs/heads/ep1");
  git(dir, ["checkout", "-q", "-b", "ws"]);

  // The forged object: SAME tree as the raw episode head but with the RAW
  // task tip as a PARENT — under substitution the episode head "already
  // contains" the task branch, so a naive containment probe answers
  // already-merged while the raw head has no task work at all.
  const sub = git(dir, [
    "commit-tree", `${epHead}^{tree}`, "-p", rawTaskTip, "-m", "forged substituted head",
  ]).out.trim();
  git(dir, ["replace", epHead, sub]);

  // The FORGERY IS REAL for a naive git call (no env/flag pin): with the
  // replacement active, git itself claims the task tip is an ancestor of
  // the (substituted) episode head.
  const naiveEnv: NodeJS.ProcessEnv = { ...process.env };
  delete naiveEnv.GIT_NO_REPLACE_OBJECTS;
  const naive = spawnSync("git", ["merge-base", "--is-ancestor", rawTaskTip, epHead],
    { cwd: dir, encoding: "utf8", env: naiveEnv });
  assert.equal(naive.status, 0,
    "control: the forged replacement really does make the task tip a substituted ancestor (else the test pins nothing)");
  const pinnedProbe = spawnSync("git", ["--no-replace-objects", "merge-base", "--is-ancestor", rawTaskTip, epHead],
    { cwd: dir, encoding: "utf8" });
  assert.equal(pinnedProbe.status, 1, "control: --no-replace-objects restores the RAW (non-ancestor) answer");
  // ...and the RAW episode head really has NO task work (that is the
  // false "already-merged" this forgery would produce).
  const rawShow = spawnSync("git", ["--no-replace-objects", "show", `${epHead}:task.txt`],
    { cwd: dir, encoding: "utf8" });
  assert.notEqual(rawShow.status, 0, "control: the raw episode head does NOT contain the task work");

  // The REAL route: P12 must merge (not answer already-merged) and the
  // advanced head must carry the RAW objects.
  const j: IntegrationPorts["journal"] = {
    async append() { /* in-memory, content-agnostic for this route */ },
    async read() { return { records: [] }; },
  } as IntegrationPorts["journal"];
  const gate: IntegrationPorts["gate"] = {
    async run(r) { return { pass: true, runId: "g-c3f1", sha: r.candidateSha }; },
  };
  let seq = 0;
  const r = await integrateTestedCandidate(
    { repoRoot: resolve(dir), episodeId: "ep1", taskId: "t1", episodeBranch: "ep1",
      now: 1700000000000 + seq++, grantedBy: "human" },
    { journal: j, gate },
  );
  assert.equal(r.status, "merged",
    `replacement refs must not fake already-merged — got ${r.stage}:${r.reason}`);
  assert.equal(head(dir, "refs/heads/ep1"), r.candidateSha, "the raw head advanced to the candidate");
  const parents = git(dir, ["log", "-1", "--format=%P", "refs/heads/ep1"]).out.split(/\s+/);
  assert.deepEqual(parents, [epHead, rawTaskTip],
    "the merge's parents are the RAW ep head and the RAW task tip (not the substituted object)");
  const raw = git(dir, ["show", `${r.candidateSha}:task.txt`]).out;
  assert.equal(raw, "task work", "the raw task work is present at the new head");
});

// ─── helpers for the host-route F2 tests ─────────────────────────────────

function baseGraph(episodeId: string, gateCmd: string): EpisodeGraph {
  return {
    schema: "tre-graph/1",
    episodeId,
    goal: "prove the disclosure classification",
    policy: { baseCommit: "abc123", gate: { cmd: gateCmd, timeoutS: 30 } },
    tasks: [{
      id: "t1", persona: "worker", promptRef: "prompts/t1.md", dependsOn: [],
      acceptance: { criteria: ["policy-gate"], requiredChecks: [], artifacts: [] },
    }],
  };
}

async function makeRepo(t: { after: (fn: () => void) => void }, episodeId: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tre-c3f2-repo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "ep1", "."]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  await writeFile(join(dir, "base.txt"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["checkout", "-q", "-b", `agent/${episodeId}/t1`]);
  await writeFile(join(dir, "task.txt"), "task work\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "task work"]);
  git(dir, ["checkout", "-q", "-b", "ws"]);
  return dir;
}

async function exitZeroWorker(root: string): Promise<string> {
  const p = join(root, "worker.sh");
  await writeFile(p, "#!/bin/sh\nexit 0\n");
  await chmod(p, 0o755);
  return p;
}

/** Run ONE real activation to a completed merge; returns the journal, the
 *  log lines, and the actionId of the acked merge outcome (the exact
 *  P12 identity grammar the host's seq scan matches). */
async function activationWithMergedOutcome(t: { after: (fn: () => void) => void; diagnostic: (m: string) => void }, episodeId: string) {
  const repo = await makeRepo(t, episodeId);
  const root = await mkdtemp(join(tmpdir(), "tre-c3f2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);
  const lines: string[] = [];
  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph(episodeId, "test -f base.txt"), taskId: "t1",
    grantedBy: "test-harness", workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    log: (l) => { lines.push(l); t.diagnostic(l); },
  });
  assert.equal(res.result.stopped, "accepted-finish", `activation must integrate (${res.result.stopped})`);
  const journal = await DecisionJournal.forEpisode(join(root, episodeId));
  const { records } = await journal.read();
  const acked = records.find((r) => r.kind === "decision-outcome" && r.acked === true
    && /^a-t1-merge-[0-9a-f]{16}$/.test((r as { actionId?: string }).actionId ?? ""));
  assert.ok(acked, "the activation journaled an acked merge outcome");
  return { repo, root, journal, lines, actionId: (acked as { actionId: string }).actionId, episodeId };
}

/** Append a synthetic UNACKED outcome (a provenance-pure CAS-rejection /
 *  act-unknown terminal) carrying the given notes, then run a SECOND
 *  activation over the SAME journal and return its log lines. */
async function seedUnackedOutcomeAndReactivate(
  t: { after: (fn: () => void) => void; diagnostic: (m: string) => void },
  a: { repo: string; root: string; journal: DecisionJournal; actionId: string; episodeId: string },
  notes: string,
): Promise<string[]> {
  const seeded = {
    schema: "tre-supervisor/1", id: `c3f2-seed-${notes.slice(0, 12)}`, ts: 1700000111000,
    episodeId: a.episodeId, taskId: "t1", kind: "decision-outcome",
    actionId: a.actionId, acked: false, progress: "none", notes,
  };
  validateSupervisorRecord(seeded as never); // the seed must be P4-valid
  await a.journal.append(seeded as never);
  const worker = await exitZeroWorker(a.root);
  const lines2: string[] = [];
  const run2 = await runHostEpisode({
    episodesRoot: a.root, graph: baseGraph(a.episodeId, "test -f base.txt"), taskId: "t1",
    grantedBy: "test-harness", workerCommand: worker, worktreePath: a.repo, episodeBranch: "ep1",
    log: (l) => { lines2.push(l); t.diagnostic(`run2: ${l}`); },
  });
  assert.equal(run2.result.stopped, "accepted-finish", "the activation still accepts");
  return lines2;
}

test("P9 host cycle-3 F2: an unacked 'no-effect:' outcome is replayable per P12's own sticky rule — the host must NOT announce it as a stranded act-unknown", async (t) => {
  const a = await activationWithMergedOutcome(t, "ep-c3f2a");
  const lines2 = await seedUnackedOutcomeAndReactivate(t, a, "no-effect: head-moved (CAS rejected, provably no effect)");
  assert.ok(!lines2.some((l) => l.startsWith("integration-act-unknown")),
    `a provably effect-free refusal must never be disclosed as act-unknown, got ${JSON.stringify(lines2)}`);
});

test("P9 host cycle-3 F2 contrast: an unacked outcome WITHOUT the no-effect prefix IS an act-unknown terminal — the disclosure still fires", async (t) => {
  const a = await activationWithMergedOutcome(t, "ep-c3f2b");
  const lines2 = await seedUnackedOutcomeAndReactivate(t, a, "act-unknown: advance-unverified (reference transaction contradicted by re-read)");
  assert.ok(lines2.some((l) => l.startsWith("integration-act-unknown")),
    `an unverifiable terminal MUST be disclosed with the --integration-seq-bump remedy, got ${JSON.stringify(lines2)}`);
  assert.ok(lines2.some((l) => l.startsWith("integration-act-unknown") && l.includes("--integration-seq-bump")),
    "the disclosure names the operator remedy");
});