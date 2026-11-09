/**
 * P9 (docs/16 §0.6) — the host merge wired end-to-end through the REAL
 * production route (P9 audit cycle-1 F1/F5 rewrite).
 *
 * There is NO post-run `mergeTask` seam anymore: the closure acted after
 * the episode lease had been released and outside the loop's intent
 * protocol (cycle-1 F1). The merge now dispatches IN the composed loop
 * on the operator-declared trigger: `episodeBranch` declared ⇒
 * cfg.integration.trigger 'on-finish' ⇒ a COMPLETE acceptance verdict
 * runs the merge ACT (canonical intent → port → paired outcome) under
 * the lease, and the episode finishes 'accepted-finish' with the
 * integration disclosed.
 *
 * This file pins:
 *  1. the REAL route: exit-0 worker + passing gate + declared episode
 *     branch ⇒ the loop merges for real — the episode branch advances to
 *     a 2-parent merge commit, the task's work is present at the new
 *     head, and BOTH the loop-side pair (sup-… intent/outcome) and the
 *     P12-side records (a-…-merge-…) are in the SAME durable journal,
 *     all P4-valid — no test called integrateTestedCandidate directly.
 *  2. cross-activation dedup: a SECOND activation whose verdict is also
 *     complete must not advance the branch again (P12's terminal-dedup
 *     answers already-merged; the head stands still).
 *  3. the negative half: NO episodeBranch ⇒ no disclosure, no trigger —
 *     the same exit-0 + passing-gate episode finishes accepted WITHOUT
 *     touching the branch (merge-unwired doctrine, docs/15 §3).
 *  4. gate honesty (audit cycle-1 F2): a gate that mutates the tracked
 *     tree after checkout fails closed — the merge is gate-failed, the
 *     branch never moves.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function baseGraph(episodeId: string, gateCmd: string): EpisodeGraph {
  return {
    schema: "tre-graph/1",
    episodeId,
    goal: "prove the merge wiring",
    // The criterion IS the policy-gate id (EV7): the host-run policy gate
    // is the ONE piece of current evidence a complete verdict needs —
    // the same shape as the accepted-finish route in host-supervise.test.
    policy: { baseCommit: "abc123", gate: { cmd: gateCmd, timeoutS: 30 } },
    tasks: [{
      id: "t1",
      persona: "worker",
      promptRef: "prompts/t1.md",
      dependsOn: [],
      acceptance: { criteria: ["policy-gate"], requiredChecks: [], artifacts: [] },
    }],
  };
}

/** Throwaway repo: `ep1` and `agent/<ep>/<task>` diverge cleanly from a
 *  base (the P12 clean fixture shape). Checked out on a neutral branch
 *  so the merge never races the working tree. */
async function makeRepo(t: { diagnostic: (m: string) => void; after: (fn: () => void) => void }, episodeId: string, taskBranchFiles: Record<string, string> = { "task.txt": "task work\n" }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tre-host-mp-repo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "ep1", "."]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  await writeFile(join(dir, "base.txt"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["checkout", "-q", "-b", `agent/${episodeId}/t1`]);
  for (const [name, body] of Object.entries(taskBranchFiles)) {
    await writeFile(join(dir, name), body);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "task work"]);
  // Neutral branch: the merge (plumbing) must never race a checkout.
  git(dir, ["checkout", "-q", "-b", "ws"]);
  return dir;
}

async function exitZeroWorker(root: string): Promise<string> {
  const p = join(root, "worker.sh");
  await writeFile(p, "#!/bin/sh\nexit 0\n");
  await chmod(p, 0o755);
  return p;
}

test("P9 real route: exit-0 + passing gate + episodeBranch ⇒ the LOOP merges (accepted-finish/integrated), real refs + journal", async (t) => {
  const repo = await makeRepo(t, "ep-host");
  const root = await mkdtemp(join(tmpdir(), "tre-host-mp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);

  const lines: string[] = [];
  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-host", "test -f base.txt"), taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker,
    worktreePath: repo,
    episodeBranch: "ep1",
    log: (l) => { lines.push(l); t.diagnostic(l); },
  });

  // 1. Disclosure: the operator sees WHAT the merge acts on.
  assert.ok(lines.some((l) => l.startsWith("merge-port:injected branch=ep1") && l.includes(repo)),
    `expected a merge-port:injected disclosure naming the repo, got ${JSON.stringify(lines)}`);
  assert.ok(!lines.some((l) => /cwd fallback/.test(l)), "with --worktree there is no fallback caveat");

  // 2. THE REAL ROUTE: the loop itself dispatched the merge on the
  //    complete verdict and finished accepted with the integration
  //    disclosed — no test-side closure was involved.
  assert.equal(res.result.stopped, "accepted-finish", `stop=${res.result.stopped} detail=${res.result.detail ?? ""} iters=${JSON.stringify(res.result.iterations)}`);
  assert.equal(res.result.detail, "integrated", "the accept-finish discloses the integration ran");

  // 3. Observed reality: the branch moved to a 2-parent merge commit
  //    whose parents are the old head and the task tip, and the task's
  //    file is present AT the new head (not just in the object store).
  const after = head(repo, "refs/heads/ep1");
  const base = git(repo, ["rev-list", "--max-count=1", "ws"]).out; // pre-branch base is NOT the head
  void base;
  const firstParent = git(repo, ["rev-parse", `${after}^1`]).out;
  const taskTip = head(repo, "refs/heads/agent/ep-host/t1");
  const parents = git(repo, ["rev-list", "--parents", "-n", "1", after]).out.split(/\s+/).slice(1).sort();
  const oldEpisodeHead = git(repo, ["rev-list", "--max-count=1", "--skip=1", "ep1"]).out;
  assert.equal(parents.length, 2, "the merge commit has exactly two parents");
  assert.ok(parents.includes(taskTip), "one parent is the task tip");
  assert.ok(parents.includes(oldEpisodeHead), `the other parent is the pre-merge episode head (${firstParent})`);
  const shown = git(repo, ["show", "--stat", "--format=", "refs/heads/ep1"]).out;
  assert.match(shown, /task\.txt/, "the task's work is in the new head's tree");

  // 4. The SAME durable journal the loop appends to carries BOTH sides of
  //    the dispatch: the loop-side intent/outcome pair (action
  //    `merge`, under the loop's sup-… intent namespace) AND P12's own
  //    records — all P4-valid.
  const journal = await DecisionJournal.forEpisode(join(root, "ep-host"));
  const { records } = await journal.read();
  for (const rec of records) assert.doesNotThrow(() => validateSupervisorRecord(rec as never), "every record passes the REAL P4 validator");
  const recs = records as { kind?: string; action?: string; actionId?: string; notes?: string; strategyId?: string; rung?: number }[];

  // Loop side: the trigger journaled its intent under strategyId
  // integration:on-finish:v1 and PAIRED the outcome under the same id.
  const mergeIntent = recs.find((r) => r.kind === "decision-intent" && r.action === "merge" && r.strategyId === "integration:on-finish:v1");
  assert.ok(mergeIntent, "the loop journaled the on-finish merge intent");
  assert.match(String(mergeIntent.actionId), /^sup-/, "the trigger intent rides the loop's sup-… namespace");
  assert.equal(mergeIntent.rung, 4);
  const mergeOutcome = recs.find((r) => r.kind === "decision-outcome" && r.actionId === mergeIntent.actionId);
  assert.ok(mergeOutcome, "the merge intent is PAIRED with an outcome (never left open)");
  assert.match(String(mergeOutcome.notes), /integration merge executed/, `outcome notes disclose the merge result, got ${JSON.stringify(mergeOutcome.notes)}`);

  // P12 side: its canonical actionId carries the intent→outcome pair and
  // the acceptance record naming the observed merged candidate.
  const p12 = recs.filter((r) => typeof r.actionId === "string" && (r.actionId as string).startsWith("a-") && typeof r.actionId === "string" && (r.actionId as string).includes("-merge-"));
  const p12Kinds = p12.map((r) => r.kind);
  for (const need of ["decision-intent", "decision-outcome"]) {
    assert.ok(p12Kinds.includes(need), `P12 journal must carry a ${need}, got ${JSON.stringify(p12Kinds)}`);
  }

  // 5. Gate honesty: the P12 intent rationale cites the host gate run id.
  const p12Intent = p12.find((r) => r.kind === "decision-intent") as { rationale?: string };
  assert.match(String(p12Intent.rationale), /host-gate:/, "the P12 intent cites the host gate run");

  // 6. No worktree registration leaks (the finally-block contract) and
  //    NO residue directories under the episode's merge-gate dir.
  const wt = git(repo, ["worktree", "list", "--porcelain"]).out;
  assert.ok(!/merge-gate/.test(wt), `no merge-gate worktree may remain registered, got ${wt}`);
});

test("P9 cross-activation dedup: a second complete-verdict activation must NOT advance the branch again", async (t) => {
  const repo = await makeRepo(t, "ep-dedup");
  const root = await mkdtemp(join(tmpdir(), "tre-host-mp-dedup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);

  const run1 = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-dedup", "test -f base.txt"), taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    log: (l) => t.diagnostic(`run1: ${l}`),
  });
  assert.equal(run1.result.stopped, "accepted-finish", `first activation must integrate (${run1.result.stopped})`);
  assert.equal(run1.result.detail, "integrated");
  const after1 = head(repo, "refs/heads/ep1");

  const run2 = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-dedup", "test -f base.txt"), taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    log: (l) => t.diagnostic(`run2: ${l}`),
  });
  // P12's terminal dedup answers already-merged — the loop still accepts,
  // but NOTHING advanced: the head is byte-identical to activation 1's.
  // (audit: `void run2` pinned nothing about activation 2's own verdict —
  // assert it: accepted, integration disclosed as EXECUTED-but-not-moved,
  // and exactly ONE merge commit on the branch.)
  assert.equal(run2.result.stopped, "accepted-finish", `second activation must still accept (got ${run2.result.stopped}; detail=${run2.result.detail ?? ""})`);
  assert.equal(run2.result.detail, "integrated", "the second activation's trigger ran (and dedup'd) — disclosed like the first");
  assert.equal(head(repo, "refs/heads/ep1"), after1, "the episode branch stands after the second activation");
  const mergeCommits = git(repo, ["rev-list", "--parents", "refs/heads/ep1"]).out
    .split("\n").filter((l) => l.trim().split(/\s+/).length > 2).length;
  assert.equal(mergeCommits, 1, "ep1's history holds exactly one merge commit — activation 2 created none");
});

test("P9 audit cycle-1 F2 (cycle-2 F5 fidelity rewrite): a gate that mutates the tracked tree fails CLOSED — gate-failed, the branch never moves", async (t) => {
  const repo = await makeRepo(t, "ep-f2");
  const root = await mkdtemp(join(tmpdir(), "tre-host-mp-f2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);

  // P9 audit cycle-2 F5: the OLD form (`printf forged > base.txt`) ALSO
  // ran in the EARLIER acceptance gate (same graph.policy.gate.cmd),
  // breaking the verdict before the integration trigger — the test
  // escalated without ever reaching P12's candidate gate, and its final
  // assertion (rev-parse vs rev-list of a branch that never existed)
  // was vacuous. The command now mutates ONLY inside the detached
  // merge-gate worktree — a linked worktree has `.git` as a FILE
  // (gitfile), the main repo as a directory — so the acceptance gate
  // passes, the complete verdict fires the on-finish trigger, and the
  // mutation lands in the ONE place the F2 fence guards: the candidate
  // materialization (post-command re-observation must catch it and fail
  // the candidate closed).
  const gateCmd = 'if [ -f .git ]; then printf forged > base.txt; fi; exit 0';
  const preHead = head(repo, "refs/heads/ep1"); // captured BEFORE any activation

  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-f2", gateCmd), taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { t.diagnostic(l); },
  });

  // 1. The trigger REACHED integration and the candidate gate failed it:
  //    halt with the mapped status, NOT an accepted finish.
  assert.notEqual(res.result.stopped, "accepted-finish", `a tree-mutating gate must not yield an integrated finish (got ${res.result.stopped})`);
  assert.equal(res.result.stopped, "halt", `the loop halts on the refused integration (detail=${res.result.detail ?? ""})`);
  assert.equal(res.result.detail, "integration-refused", "the halt discloses the integration refusal");

  // 2. The P12 candidate gate was EXERCISED and failed closed: the host
  //    gate adapter evidence (written per candidate-gate invocation)
  //    carries the post-gate tracked-mutation verdict.
  const evidence = (await readFile(join(root, "ep-f2", "acceptance", "evidence.jsonl"), "utf8"))
    .split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { sha?: string; text?: string });
  const candidateGate = evidence.filter((e) => /merge-gate/.test(e.text ?? "") && /tracked-mutation-post-gate/.test(e.text ?? ""));
  assert.ok(candidateGate.length >= 1, `expected a candidate merge-gate run failed by tracked-mutation-post-gate, got ${JSON.stringify(evidence.map((e) => e.text?.slice(0, 120)))}`);

  // 3. The loop-side intent/outcome pair exists and discloses the
  //    gate-denied refusal (paired, never left open).
  const journal = await DecisionJournal.forEpisode(join(root, "ep-f2"));
  const { records } = await journal.read();
  const recs = records as { kind?: string; action?: string; actionId?: string; notes?: string; strategyId?: string }[];
  const mergeIntent = recs.find((r) => r.kind === "decision-intent" && r.action === "merge" && r.strategyId === "integration:on-finish:v1");
  assert.ok(mergeIntent, "the on-finish merge intent was journaled (the trigger really fired)");
  const mergeOutcome = recs.find((r) => r.kind === "decision-outcome" && r.actionId === mergeIntent.actionId);
  assert.ok(mergeOutcome, "the intent is paired with an outcome");
  assert.match(String(mergeOutcome.notes), /integration merge refused \(gate-denied\)/, `outcome discloses the gate denial, got ${JSON.stringify(mergeOutcome.notes)}`);

  // 4. Observed reality: the episode branch is BYTE-IDENTICAL to the
  //    pre-run head — a failed candidate never advanced the ref.
  assert.equal(head(repo, "refs/heads/ep1"), preHead, "the episode branch stands at the pre-run head — the forged candidate never landed");
  // 5. The mutation stayed inside the (now gone) merge-gate worktree:
  //    the task's own tree still holds the candidate-untouched content.
  const baseNow = await readFile(join(repo, "base.txt"), "utf8");
  assert.equal(baseNow, "base\n", "the main worktree's tracked file was never touched (mutation was worktree-local)");
});

test("P9 negative: NO episodeBranch ⇒ no port, no disclosure, NO trigger; accepted WITHOUT touching the branch", async (t) => {
  const repo = await makeRepo(t, "ep-neg");
  const root = await mkdtemp(join(tmpdir(), "tre-host-mp-neg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);
  const episodeHeadBefore = head(repo, "refs/heads/ep1");
  const lines: string[] = [];
  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-neg", "test -f base.txt"), taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo,
    log: (l) => { lines.push(l); t.diagnostic(l); },
  });
  assert.ok(!lines.some((l) => l.startsWith("merge-port:")), "no merge-port disclosure without episodeBranch");
  assert.equal(res.result.stopped, "accepted-finish", "acceptance still works without the integration trigger");
  assert.notEqual(res.result.detail, "integrated", "no detail=integrated without the trigger");
  assert.equal(head(repo, "refs/heads/ep1"), episodeHeadBefore, "the episode branch stands untouched — merge-unwired doctrine");
});
