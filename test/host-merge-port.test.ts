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
import { mkdtemp, rm, writeFile, readFile, chmod, mkdir } from "node:fs/promises";
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

test("P9 audit p12c5 cycle-2 C2-F2: a gate installing a clean-filter forge + stat-cache refresh fails CLOSED — the neutralized chain exposes the forged bytes, the branch never moves", async (t) => {
  const repo = await makeRepo(t, "ep-c2f2");
  const root = await mkdtemp(join(tmpdir(), "tre-host-mp-c2f2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);

  // The C2-F2 forge shape (probe, git 2.54): INSIDE the merge-gate
  // worktree the command defines a conventional clean filter mapping
  // ANY bytes to the committed blob of base.txt, assigns it via
  // .gitattributes, rewrites base.txt with UNSAFE bytes, then runs a
  // PLAIN `git status` — which converts through the poison and may
  // record the entry's stat cache as CLEAN. A later `status` with only
  // `-c filter.x.clean=cat` changes CONVERSION CONFIG, which does not
  // invalidate the cached cleanliness. The fix busts the stat cache
  // FIRST (`update-index --really-refresh` under the same neutralized
  // argv; exit 1 = "needs update" is the dirt we came to expose) and
  // only then re-runs the neutralized status. On this Apple Git build
  // the unfixed status also re-detects the M (it re-stats by size), so
  // this test PINS THE FIXED CHAIN's verdict rather than the
  // false-clean itself — the false-clean class is documented as
  // empirically build-dependent (probe notes, p12c5 cycle 2).
  const gateCmd = 'if [ -f .git ]; then git config filter.x.clean "printf base\\n"; printf "*.txt filter=x\\n" > .gitattributes; printf FORGED-PAYLOAD > base.txt; git status --porcelain >/dev/null 2>&1; fi; exit 0';
  const preHead = head(repo, "refs/heads/ep1");

  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-c2f2", gateCmd), taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { t.diagnostic(l); },
  });

  assert.notEqual(res.result.stopped, "accepted-finish", `a clean-filter-forge gate must not yield an integrated finish (got ${res.result.stopped})`);
  assert.equal(res.result.stopped, "halt");
  assert.equal(res.result.detail, "integration-refused");

  const evidence = (await readFile(join(root, "ep-c2f2", "acceptance", "evidence.jsonl"), "utf8"))
    .split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { sha?: string; text?: string });
  const candidateGate = evidence.filter((e) => /merge-gate/.test(e.text ?? "") && /tracked-mutation-post-gate/.test(e.text ?? ""));
  assert.ok(candidateGate.length >= 1,
    `expected the forged base.txt exposed as tracked-mutation-post-gate through the refresh+status chain, got ${JSON.stringify(evidence.map((e) => e.text?.slice(0, 160)))}`);
  assert.equal(head(repo, "refs/heads/ep1"), preHead, "the episode branch stands at the pre-run head — the forged candidate never landed");
});

test("P9 audit p12c5 cycle-2 C2-F2b: a gate CORRUPTING the worktree index fails the stat-refresh path CLOSED (stat-refresh-failed-post-gate)", async (t) => {
  const repo = await makeRepo(t, "ep-c2f2b");
  const root = await mkdtemp(join(tmpdir(), "tre-host-mp-c2f2b-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);

  // C2-F2b: the refresh's exit-code contract is load-bearing — 1 is
  // EXPECTED dirt ("needs update"), anything ELSE non-zero is a FATAL
  // and the cache was NOT busted, so the following status could still
  // read poisoned entries: fail CLOSED before ever consulting it.
  // Probe (git 2.54): a naive `printf GARBAGE >> index` does NOT make
  // this build's index read corrupt (the trailing bytes are ignored —
  // refresh exits 0); the version field must break: flipping byte 7 of
  // the DIRC header gives "error: bad index version 88 / fatal: index
  // file corrupt" with exit 128. A linked worktree's gitdir resolves
  // via `git rev-parse --git-path index`.
  const gateCmd = 'if [ -f .git ]; then i="$(git rev-parse --git-path index)"; printf X | dd of="$i" bs=1 seek=7 count=1 conv=notrunc 2>/dev/null; fi; exit 0';
  const preHead = head(repo, "refs/heads/ep1");

  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-c2f2b", gateCmd), taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { t.diagnostic(l); },
  });

  assert.notEqual(res.result.stopped, "accepted-finish", `an index-corrupting gate must not integrate (got ${res.result.stopped})`);
  assert.equal(res.result.stopped, "halt");
  assert.equal(res.result.detail, "integration-refused");

  const evidence = (await readFile(join(root, "ep-c2f2b", "acceptance", "evidence.jsonl"), "utf8"))
    .split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { sha?: string; text?: string });
  const candidateGate = evidence.filter((e) => /merge-gate/.test(e.text ?? "") && /stat-refresh-failed-post-gate|index-flags-unreadable-post-gate/.test(e.text ?? ""));
  assert.ok(candidateGate.length >= 1,
    `expected stat-refresh-failed-post-gate (fatal refresh fails CLOSED before the status is consulted), got ${JSON.stringify(evidence.map((e) => e.text?.slice(0, 160)))}`);
  assert.equal(head(repo, "refs/heads/ep1"), preHead, "the episode branch stands at the pre-run head");
});

// ─── Cycle-3 audit (MG-C3-1 / MG-C3-2): gitdir redirect + mtime stat forge ─

test("P9 audit cycle-3 MG-C3-2: a stat-cache forge with mtime-backdating (status inside the gate, FORGED bytes hidden from a driver-only status) fails CLOSED via the fresh-index observation", async (t) => {
  const repo = await makeRepo(t, "ep-mgc32");
  const root = await mkdtemp(join(tmpdir(), "tre-host-mp-mgc32-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);

  // The exact cycle-3 probe (real git 2.54, wt3-wt6): define clean
  // filter x mapping ANY bytes to base.txt's committed blob, rewrite
  // base.txt FORGED, backdate its mtime BELOW the index stat stamp,
  // then run a plain `git status` INSIDE the gate — that converts
  // through the poison and records the entry CLEAN in the stat cache.
  // The OLD chain (`update-index --really-refresh` + status, both with
  // filter.x clean pinned to cat) then read the tree CLEAN — the
  // refresh re-stamped from size+mtime without re-converting, so the
  // forged raw bytes passed. The NEW chain builds a FRESH INDEX
  // (`read-tree HEAD` into a throwaway GIT_INDEX_FILE) during the
  // observation: pristine stat entries force a full re-read +
  // identity-conversion of every tracked file, so FORGED raw bytes
  // can only report as modified (verified: fresh-index status reports
  // " M base.txt" where the poisoned cache chain said clean).
  const gateCmd = 'if [ -f .git ]; then git config filter.x.clean "printf base\\n"; printf "*.txt filter=x\\n" > .gitattributes; printf FORGED-CYCLE3 > base.txt; touch -t 202001010101 base.txt; git status --porcelain >/dev/null 2>&1; fi; exit 0';
  const preHead = head(repo, "refs/heads/ep1");

  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-mgc32", gateCmd), taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { t.diagnostic(l); },
  });

  assert.notEqual(res.result.stopped, "accepted-finish", `an mtime-poisoned clean-filter forge must not yield an integrated finish (got ${res.result.stopped})`);
  assert.equal(res.result.stopped, "halt");
  assert.equal(res.result.detail, "integration-refused");

  const evidence = (await readFile(join(root, "ep-mgc32", "acceptance", "evidence.jsonl"), "utf8"))
    .split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { sha?: string; text?: string });
  const candidateGate = evidence.filter((e) => /merge-gate/.test(e.text ?? "") && /tracked-mutation-post-gate/.test(e.text ?? ""));
  assert.ok(candidateGate.length >= 1,
    `expected the mtime-forged base.txt exposed as tracked-mutation-post-gate through the FRESH-INDEX chain, got ${JSON.stringify(evidence.map((e) => e.text?.slice(0, 160)))}`);
  assert.equal(head(repo, "refs/heads/ep1"), preHead, "the episode branch stands at the pre-run head — the forged candidate never landed");
});

test("P9 audit cycle-3 MG-C3-1: a gate RELOCATING its gitdir (worktree move + gitdir-pointer rewrite) fails CLOSED — the pre-gate layout snapshot no longer matches", async (t) => {
  const repo = await makeRepo(t, "ep-mgc31");
  const root = await mkdtemp(join(tmpdir(), "tre-host-mp-mgc31-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);

  // The cycle-3 probe: the merge gate runs with write access to its
  // OWN worktree registration. `git worktree move` relocates the
  // worktree AND rewrites the .git pointer, after which every
  // post-gate observation (`rev-parse HEAD`, status, ls-files) still
  // resolves — against the MOVED repo — and HEAD still equals the
  // candidate sha, so a naive chain stamps PASS on a worktree whose
  // on-disk bytes are no longer observed where the host thinks they
  // are. The fix snapshots the REALPATH'd gitdir + common dir and a
  // digest of the gitdir-layout files (HEAD/alternates/commondir/
  // gitdir/worktrees) BEFORE the gate and re-checks after: any drift
  // fails closed with gitdir-relocated-post-gate. The probe here is
  // the minimal deterministic redirect: move the linked worktree's
  // admin dir and replace it with a symlink — HEAD, status, and
  // ls-files all still resolve (through the symlink) with HEAD ==
  // candidate sha, so only the realpath'd identity check exposes it.
  const gateCmd = 'if [ -f .git ]; then p="$(git rev-parse --absolute-git-dir)"; mv "$p" "$p.evil" && ln -s "$p.evil" "$p"; fi; exit 0';
  const preHead = head(repo, "refs/heads/ep1");

  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-mgc31", gateCmd), taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { t.diagnostic(l); },
  });

  assert.notEqual(res.result.stopped, "accepted-finish", `a gitdir-relocating gate must not integrate (got ${res.result.stopped})`);
  assert.equal(res.result.stopped, "halt");
  assert.equal(res.result.detail, "integration-refused");

  const evidence = (await readFile(join(root, "ep-mgc31", "acceptance", "evidence.jsonl"), "utf8"))
    .split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { sha?: string; text?: string });
  const candidateGate = evidence.filter((e) => /merge-gate/.test(e.text ?? "") && /gitdir-relocated-post-gate|git-layout-drift-post-gate|git-layout-unobservable-post-gate/.test(e.text ?? ""));
  assert.ok(candidateGate.length >= 1,
    `expected gitdir-relocated-post-gate (pre-gate layout snapshot mismatch), got ${JSON.stringify(evidence.map((e) => e.text?.slice(0, 160)))}`);
  assert.equal(head(repo, "refs/heads/ep1"), preHead, "the episode branch stands at the pre-run head");
});

test("P9 audit p12c5 cycle-2 C2-F3 (audit finding 3): an UNRESOLVED seq-high-water record is HELD — the next activation re-derives the SAME seq (crash recovery stays reachable)", async (t) => {
  const repo = await makeRepo(t, "ep-c2f3");
  const root = await mkdtemp(join(tmpdir(), "tre-host-mp-c2f3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);

  // C2-F3: the OLD allocator advanced unconditionally past EVERY
  // persisted seq-high-water record — but a record only PROVES the seq
  // was spent once its identity reached an ACKED terminal. A crashed
  // allocation (intent appended, no outcome) left a record whose seq
  // was never consumed; advancing past it made the next activation
  // derive a NEW identity, stranding the open intent beyond P12's
  // recovery. The fix consumes a high-water ONLY when an acked merge
  // outcome carries that allocation seq (`<actionId>#o<seq>[r<k>][f]`).
  // Fixture: a valid, UNCONSUMED high-water at seq 7 seeded before the
  // first activation. Pre-fix the merge would run at seq 8 (a fresh
  // external identity over a phantom-spent seq); post-fix it must run
  // at seq 0 — observable through the outcome record id's `#o<seq>` suffix.
  const epDir = join(root, "ep-c2f3");
  await mkdir(join(epDir, "events"), { recursive: true });
  await writeFile(join(epDir, "events", "decisions.jsonl"),
    JSON.stringify({ schema: "tre-supervisor/1", kind: "seq-high-water", id: "seqhw-ep-c2f3-t1-7", ts: 1700000000, episodeId: "ep-c2f3", taskId: "t1", seq: 7 }) + "\n");

  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-c2f3", "test -f base.txt"), taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    log: (l) => { t.diagnostic(l); },
  });
  assert.equal(res.result.stopped, "accepted-finish", `a phantom high-water must not block integration (${res.result.stopped}; detail=${res.result.detail ?? ""})`);

  const journal = await DecisionJournal.forEpisode(epDir);
  const { records } = await journal.read();
  const recs = records as { kind?: string; action?: string; actionId?: string; id?: string; seq?: number }[];
  // P12's OWN terminal carries the allocation seq in its id suffix
  // (`a-<taskId>-merge-<16hex>#o<seq>`); the loop-side sup-… outcome
  // does not name the seq, so read P12's record directly.
  const p12Outcome = recs.find((r) => r.kind === "decision-outcome" && typeof r.id === "string" && /^a-t1-merge-[0-9a-f]{16}#o\d/.test(r.id));
  assert.ok(p12Outcome, `expected a P12 merge terminal (a-t1-merge-<hex>#o<seq>) in the journal, got ${JSON.stringify(recs.map((r) => String(r.id)))}`);
  // Audit finding 3: an UNRESOLVED high-water (no acked outcome) is
  // HELD, never skipped — the allocator re-derives seq 7 (the open
  // allocation) rather than dropping to 0, so P12 can reach the
  // identity that owns any open intent / act-unknown terminal there.
  assert.match(p12Outcome.id as string, /#o7$/,
    `an unresolved high-water(seq=7) must be RE-DERIVED, not skipped to 0 (id ${p12Outcome.id as string}); skipping it bypassed recovery of the identity at seq 7`);
  // The re-derived allocation re-records the same high-water (max is
  // idempotent), and the seeded record survives untouched.
  const hws = recs.filter((r) => r.kind === "seq-high-water").map((r) => r.seq).sort((a, b) => (a as number) - (b as number));
  assert.deepEqual(hws, [7, 7], "the seeded seq-7 record survives and the re-derived allocation re-records seq 7 (idempotent max)");
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

// MG-C4-A3 regression (audit finding 1, A3 BUG-staged-divergence): the
// gate's OWN index may diverge from HEAD while the on-disk bytes stay
// clean. `diff-index --cached` WITHOUT --quiet exits 0 even when the
// index differs, so the staged check must read the exit as a verdict.
// The gate restages a rewritten file and restores the worktree copy —
// status is clean, the staged tree is forged.
test("MG-C4-A3 audit-1: a gate that stages altered content and restores the worktree fails CLOSED — the staged-tree divergence is refused", async (t) => {
  const repo = await makeRepo(t, "ep-staged");
  const root = await mkdtemp(join(tmpdir(), "tre-host-mp-staged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);

  const gateCmd = "if [ -f .git ]; then printf FORGED > base.txt; git add base.txt; printf 'base\\n' > base.txt; fi; exit 0";
  const preHead = head(repo, "refs/heads/ep1");

  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-staged", gateCmd), taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { t.diagnostic(l); },
  });

  assert.notEqual(res.result.stopped, "accepted-finish", `a staged-divergent gate must not integrate (got ${res.result.stopped}; detail=${res.result.detail ?? ""})`);
  assert.equal(res.result.detail, "integration-refused");

  const evidence = (await readFile(join(root, "ep-staged", "acceptance", "evidence.jsonl"), "utf8"))
    .split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { sha?: string; text?: string });
  const stagedGate = evidence.filter((e) => /merge-gate/.test(e.text ?? "") && /staged-tree-divergence-post-gate/.test(e.text ?? ""));
  assert.ok(stagedGate.length >= 1, `expected staged-tree-divergence-post-gate, got ${JSON.stringify(evidence.map((e) => e.text?.slice(0, 160)))}`);
  assert.equal(head(repo, "refs/heads/ep1"), preHead, "the episode branch stands at the pre-run head");
});

// MG-C4-A3 regression (A3 BUG-class `blob-overwrite`): a gate that
// corrupts a LOOSE OBJECT at its hash path makes the same sha resolve
// to different bytes for the next reader while every path-level digest
// and every status stays silent (probe, git 2.54: `git status` on a
// store with a corrupted blob exits 0 CLEAN; `fsck` alone sees it —
// and `fsck --connectivity-only` does NOT re-hash content, so the
// post-gate check is the FULL fsck). The gate below overwrites the
// candidate's OWN base.txt blob with valid-zlib but foreign bytes —
// exactly the reinterpretation-at-identity attack — and must be
// refused by the object-store-fsck-post-gate evidence path.
test("MG-C4-A3: a gate that corrupts a loose blob fails CLOSED — full fsck exposes the corruption, the branch never moves", async (t) => {
  const repo = await makeRepo(t, "ep-fsck");
  const root = await mkdtemp(join(tmpdir(), "tre-host-mp-fsck-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);

  // Runs ONLY in the detached merge-gate worktree (the `-f .git` test:
  // linked worktrees carry .git as a FILE). Resolve the candidate's OWN
  // base.txt blob through git itself, then overwrite the loose object
  // with different content under the SAME hash path. Loose objects are
  // 0444 — chmod first. The split uses cut (a nested-`${var%p}` form
  // cannot survive the adapter's shell-quoting — probe: exit 2 from
  // the policy gate before the trigger ever fired). The write's exit
  // status is deliberately NOT checked here: if the forgery silently
  // fails, the test's own evidence assertion below fails LOUD (never
  // a vacuous pass).
  // The forged object is a VALID Git loose object (zlib stream of a
  // `blob <len>\0` header plus foreign bytes) stored under the
  // ORIGINAL hash path — so it inflates and reads fine, and only a
  // full fsck re-hashing the content exposes the hash mismatch.
  // python3 is used to write it: git's own tooling cannot author a
  // mismatched object.
  const gateCmd = 'if [ -f .git ]; then'
    + ' oid=$(git rev-parse HEAD:base.txt);'
    + ' od=$(git rev-parse --git-path objects);'
    + ' pre=$(printf %s "$oid" | cut -c 1-2);'
    + ' suf=$(printf %s "$oid" | cut -c 3-);'
    + ' chmod u+w "$od/$pre/$suf" 2>/dev/null;'
    + ' python3 -c \'import zlib,sys; open(sys.argv[1],"wb").write(zlib.compress(b"blob 7\\0FORGED\\n"))\' "$od/$pre/$suf" 2>/dev/null;'
    + ' fi; exit 0';
  const preHead = head(repo, "refs/heads/ep1");

  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-fsck", gateCmd), taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { t.diagnostic(l); },
  });

  assert.notEqual(res.result.stopped, "accepted-finish", `a store-corrupting gate must not yield an integrated finish (got ${res.result.stopped}; detail=${res.result.detail ?? ""})`);
  assert.equal(res.result.detail, "integration-refused", "the stop discloses the integration refusal");

  const evidence = (await readFile(join(root, "ep-fsck", "acceptance", "evidence.jsonl"), "utf8"))
    .split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { sha?: string; text?: string });
  const fsckGate = evidence.filter((e) => /merge-gate/.test(e.text ?? "") && /object-store-fsck-post-gate/.test(e.text ?? ""));
  assert.ok(fsckGate.length >= 1, `expected a candidate merge-gate run failed by object-store-fsck-post-gate, got ${JSON.stringify(evidence.map((e) => e.text?.slice(0, 160)))}`);
  // The evidence carries the fsck exit (non-zero) — never a bare string.
  assert.match(String(fsckGate[0]?.text ?? ""), /object-store-fsck-post-gate:exit=[1-9]/, "the refusal names the failing fsck exit code");

  assert.equal(head(repo, "refs/heads/ep1"), preHead, "the episode branch stands at the pre-run head — a candidate over a corrupt store never landed");
});

// MG-C4-A3 regression (A3 BUG-class `tracked-eol`): a CANDIDATE COMMIT
// carrying `.gitattributes` with `text eol=crlf` bends git's BUILT-IN
// conversions — no filter pin touches them. Un-neutralized, the gate
// worktree materializes CRLF bytes (≠ the raw blob), the gate rewrites
// the file TO those CRLF bytes, and `status` reads CLEAN: the accepted
// verdict is certified against bytes that were never the candidate's
// (A3 fixture: MERGED_BASE_HEX stayed "base" — stale certification of
// an untested worktree state). The fix pins GIT_ATTR_SOURCE to the
// empty tree on the materialization AND the observation, so the
// on-disk bytes are raw and the rewrite reports modified.
test("MG-C4-A3: a candidate with eol=crlf attributes cannot mask gate-rewritten bytes — the raw-comparing status fails the gate CLOSED", async (t) => {
  // The task branch adds `.gitattributes` (eol rule over base.txt) →
  // the MERGED candidate commit carries it, so the conversion rule is
  // part of what is being certified.
  const repo = await makeRepo(t, "ep-eol", { "task.txt": "task work\n", ".gitattributes": "base.txt text eol=crlf\n" });
  const root = await mkdtemp(join(tmpdir(), "tre-host-mp-eol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);

  // Worktree-only mutation: CRLF bytes where the candidate blob says
  // LF. With attribute identity pinned the fresh-index status MUST see
  // it; un-pinned, git's own smudge comparison declares it clean.
  const gateCmd = "if [ -f .git ]; then printf 'base\\r\\n' > base.txt; fi; exit 0";
  const preHead = head(repo, "refs/heads/ep1");

  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-eol", gateCmd), taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { t.diagnostic(l); },
  });

  assert.notEqual(res.result.stopped, "accepted-finish", `the eol-masked mutation must not certify (got ${res.result.stopped}; detail=${res.result.detail ?? ""})`);
  assert.equal(res.result.detail, "integration-refused", "the stop discloses the integration refusal");

  const evidence = (await readFile(join(root, "ep-eol", "acceptance", "evidence.jsonl"), "utf8"))
    .split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { sha?: string; text?: string });
  const eolGate = evidence.filter((e) => /merge-gate/.test(e.text ?? "") && /tracked-mutation-post-gate/.test(e.text ?? ""));
  assert.ok(eolGate.length >= 1, `expected the raw-comparing post-gate status to report the CRLF rewrite as a tracked mutation, got ${JSON.stringify(evidence.map((e) => e.text?.slice(0, 160)))}`);

  assert.equal(head(repo, "refs/heads/ep1"), preHead, "the episode branch stands at the pre-run head");
});
