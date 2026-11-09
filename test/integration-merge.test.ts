/**
 * P12 — tested-candidate integration (docs/16) tests.
 *
 * Coverage (against REAL throwaway git repos in os.tmpdir(), pattern of
 * test/git-commit.test.ts):
 *  - §2 step 1 context: every validation-table refusal, hostile Proxy
 *    request, "." / ".." ids, port-shape refusals — all journal NOTHING.
 *  - §0 M4 ref-direction: "main" and the "agent" namespace refused before
 *    any git call; task branch derived, never caller-named.
 *  - §2 step 2 dedup: journal-unreadable, already-executed, not-replayable
 *    (act-unknown outcome), no-effect replay permitted with distinct ids,
 *    open-intent recovery (observed-descendant / head-equals-candidate /
 *    contained-by-other) and intent-open refusal.
 *  - §2 step 3 resolve: non-repo, missing branches, expectedTaskTip pin
 *    BEFORE the already-merged shortcut, equal-/ancestor containment.
 *  - §2 step 4 construct: conflict reports paths, journals nothing,
 *    advances nothing; working tree provably untouched by the whole flow.
 *  - §2 step 5 gate (M2): throws, denial, missing runId, sha mismatch,
 *    case-normalized sha match.
 *  - §2 step 6 reverify: task tip moved between gate and reverify.
 *  - §2 steps 7–9 advance/verify: happy-path merged (2-parent commit,
 *    intent→outcome→acceptance order), advance-failed (stale ref lock →
 *    provable no-effect), head-moved (gate advances the branch → CAS
 *    rejected → head-moved), act-unknown via a reference-transaction
 *    hook (exit-0 contradicted by the re-read → never no-effect, and
 *    the chained not-replayable on retry), intent-append failure blocks
 *    the CAS, outcome-append failure surfaces outcomeDurable:false.
 *  - Record fidelity: every journaled record passes the REAL P4
 *    validateSupervisorRecord (drift-pinned against src/episode/journal).
 *  - actionId determinism; taskBranchName drift guard against P6.
 *  - Cycle-1 audit closures: construct exit-1 classification on PAYLOAD
 *    (empty stdout → failed, never a bogus conflict — C1 F1); observed-
 *    despite-cas-error merged (C1 F9); M6 fence via hard re-read failure
 *    (C1 F9, fence id carries the per-actionId suffix — C1 F7); dedup
 *    precedence over a stale expectedTaskTip pin (C1 F6); interleaved
 *    no-effect→replay r-suffixed ids (C1 F9). Injection is a deterministic
 *    git PATH shim (execFile resolves "git" per call), never a race.
 *    F4 (stale-lock wedge) and F5 (case-insensitive refs) are documented
 *    known limitations in merge.ts; F10 layout-agnostic compartment test.
 *  - Compartment: src/integration imports only node: builtins.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { integrateTestedCandidate, taskBranchName, type IntegrationPorts, type IntegrationRequest } from "../src/integration/merge.js";
import { taskBranchName as p6TaskBranchName } from "../src/worktree/provision.js";
import { DecisionJournal, validateSupervisorRecord } from "../src/episode/journal.js";

// ─── git helper (git-commit.test.ts pattern: strip sandbox stderr noise) ───

function git(dir: string, args: string[]): { status: number; out: string } {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 30000 });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`
    .split("\n").filter((l) => !/^warning:/.test(l)).join("\n");
  if ((r.status ?? -1) !== 0) throw new Error(`git ${args.join(" ")} failed: ${out}`);
  return { status: r.status ?? 0, out: out.trim() };
}
const head = (dir: string, ref: string): string => git(dir, ["rev-parse", "--verify", `${ref}^{commit}`]).out;

/** Advance a branch by one empty commit WITHOUT touching the checkout
 *  (plumbing: commit-tree + update-ref) — simulates a concurrent writer. */
function advanceBranch(dir: string, branch: string, msg: string): string {
  const tip = head(dir, `refs/heads/${branch}`);
  const tree = git(dir, ["rev-parse", `${tip}^{tree}`]).out.trim();
  const sha = git(dir, ["commit-tree", tree, "-p", tip, "-m", msg]).out.trim();
  git(dir, ["update-ref", `refs/heads/${branch}`, sha]);
  return sha;
}

// ─── in-memory journal port ────────────────────────────────────────────────

type MemJournal = IntegrationPorts["journal"] & {
  records: Record<string, unknown>[];
  failFor?: (rec: { kind?: string }) => Error | undefined;
};
function memJournal(): MemJournal {
  const j: MemJournal = {
    records: [],
    async append(rec: object) {
      const err = j.failFor?.(rec as { kind?: string });
      if (err) throw err;
      j.records.push(structuredClone(rec) as Record<string, unknown>);
    },
    async read() { return { records: j.records.slice() }; },
  };
  return j;
}
const passGate: IntegrationPorts["gate"] = {
  async run(r) { return { pass: true, runId: "g1", sha: r.candidateSha }; },
};

function ports(journal = memJournal(), gate = passGate): IntegrationPorts {
  return { journal, gate };
}

// ─── repo fixtures ─────────────────────────────────────────────────────────

interface Fixture { dir: string; epHead: string; taskTip: string; base: string; cleanup: () => void }

/** Repo on a neutral branch `ws` (so the checked-out branch never moves):
 *  ep1 and agent/ep1/t1 diverge from a common base (clean by default;
 *  `conflict` → same file diverged; `contained` → task tip merged into
 *  ep1 already, no-ff). */
function makeRepo(t: { after: (fn: () => void) => void }, mode: "clean" | "conflict" | "contained" | "identical" = "clean"): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tre-p12-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "ep1", "."]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  const base = head(dir, "refs/heads/ep1");
  git(dir, ["checkout", "-q", "-b", "agent/ep1/t1"]);
  writeFileSync(join(dir, "task.txt"), "task work\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "task work"]);
  const taskTip = head(dir, "refs/heads/agent/ep1/t1");
  git(dir, ["checkout", "-q", "ep1"]);
  if (mode === "conflict") {
    writeFileSync(join(dir, "task.txt"), "ep edit\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "conflicting ep edit"]);
  } else if (mode === "contained") {
    git(dir, ["merge", "--no-ff", "-q", "-m", "landed by other", "agent/ep1/t1"]);
  } else if (mode === "identical") {
    git(dir, ["update-ref", "refs/heads/ep1", taskTip]);
  }
  git(dir, ["checkout", "-q", "-b", "ws"]);
  return { dir, epHead: head(dir, "refs/heads/ep1"), taskTip, base, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

let SEQ = 0;
function req(fx: { dir: string }, over: Partial<IntegrationRequest> = {}): IntegrationRequest {
  return {
    repoRoot: resolve(fx.dir), episodeId: "ep1", taskId: "t1", episodeBranch: "ep1",
    now: 1700000000000 + SEQ++, grantedBy: "human", ...over,
  };
}

// ─── §2 step 1: context refusals journal nothing, touch nothing ───────────

test("P12 context: malformed requests refused with context:* and zero journal writes", async (t) => {
  const fx = makeRepo(t);
  const p = ports();
  const bad: unknown[] = [null, undefined, 42, "x", [], true];
  for (const b of bad) {
    const r = await integrateTestedCandidate(b, p);
    assert.equal(r.status, "refused", JSON.stringify(b));
    assert.equal(r.stage, "context");
    assert.equal(r.reason, "context:shape");
  }
  const badField: Array<[Record<string, unknown>, string]> = [
    [{ repoRoot: "rel/path" }, "context:repoRoot"],
    [{ repoRoot: 5 }, "context:repoRoot"],
    [{ episodeId: "bad/ep" }, "context:episodeId"],
    [{ episodeId: "" }, "context:episodeId"],
    [{ episodeId: ".." }, "context:episodeId"],
    [{ episodeId: "." }, "context:episodeId"],
    [{ taskId: "a b" }, "context:taskId"],
    [{ taskId: ".." }, "context:taskId"],
    [{ episodeBranch: "two/levels" }, "context:episodeBranch"],
    [{ episodeBranch: "." }, "context:episodeBranch"],
    [{ now: NaN }, "context:now"],
    [{ now: -1 }, "context:now"],
    [{ now: "1" }, "context:now"],
    [{ executionSeq: 1.5 }, "context:executionSeq"],
    [{ executionSeq: -2 }, "context:executionSeq"],
    [{ grantedBy: "" }, "context:grantedBy"],
    [{ expectedTaskTip: "not-a-sha" }, "context:expectedTaskTip"],
  ];
  for (const [over, reason] of badField) {
    const r = await integrateTestedCandidate(req(fx, over as Partial<IntegrationRequest>), p);
    assert.equal(r.status, "refused", JSON.stringify(over));
    assert.equal(r.reason, reason);
  }
  assert.deepEqual((p.journal as MemJournal).records, [], "context refusals journal nothing");
});

test("P12 context: hostile Proxy request is fenced, never thrown", async (t) => {
  const fx = makeRepo(t);
  const p = ports();
  const hostile = new Proxy({}, {
    get(_t, key) {
      if (key === "repoRoot") throw new TypeError("hostile getter");
      return undefined;
    },
    has() { throw new TypeError("hostile has"); },
    getOwnPropertyDescriptor() { throw new TypeError("hostile gopd"); },
  });
  const r = await integrateTestedCandidate(hostile, p);
  // Cycle-3 audit C2-F2 contract: an accessor that throws ESCAPES to the
  // M6 fence (fail-closed) rather than being swallowed into a data-shape
  // refusal — a swallowed throw previously let a hostile expectedTaskTip
  // pin vanish fail-open. Fenced: status failed, stage context, NOTHING
  // journaled, nothing thrown.
  assert.equal(r.status, "failed");
  assert.equal(r.stage, "context");
  assert.match(r.reason ?? "", /^fence:context:/, `expected a fenced context escape: ${r.reason}`);
  assert.equal((p.journal as MemJournal).records.length, 0);
});

test("P12 context: port-shape refusals (journal/gate missing or broken)", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  const cases: Array<[unknown, string]> = [
    [undefined, "context:journal-port"],
    [{}, "context:journal-port"],
    [{ journal: {} }, "context:journal-port"],
    [{ journal: j }, "context:gate-port"],
    [{ journal: j, gate: {} }, "context:gate-port"],
  ];
  for (const [badPorts, reason] of cases) {
    const r = await integrateTestedCandidate(req(fx), badPorts as IntegrationPorts);
    assert.equal(r.status, "refused");
    assert.equal(r.reason, reason);
  }
});

// ─── §0 M4: ref-direction guards ──────────────────────────────────────────

test("P12 M4: episode branch 'main' and the 'agent' namespace are refused pre-git", async (t) => {
  const fx = makeRepo(t);
  const p = ports();
  const main = await integrateTestedCandidate(req(fx, { episodeBranch: "main" }), p);
  assert.equal(main.status, "refused");
  assert.equal(main.reason, "context:episodeBranch-main");
  const agent = await integrateTestedCandidate(req(fx, { episodeBranch: "agent" }), p);
  assert.equal(agent.status, "refused");
  assert.equal(agent.reason, "context:episodeBranch-agent-namespace");
  assert.equal((p.journal as MemJournal).records.length, 0);
});

test("P12 M4: the task branch is DERIVED — a stray caller-named branch is never merged", async (t) => {
  const fx = makeRepo(t);
  // Cycle-2 audit F6: `tempting` sits on a DIFFERENT commit (the base) —
  // pinning it to the task tip made the assertion a tautology (both
  // candidates were the same sha; the test passed even if the code had
  // honored the caller-named branch). Now: honoring `branch` would yield
  // taskTip === fx.base and this fails.
  git(fx.dir, ["branch", "tempting", `${fx.base}`]);
  assert.notEqual(fx.base, fx.taskTip, "fixture: tempting is on a distinct commit");
  const p = ports();
  const r = await integrateTestedCandidate({ ...req(fx), branch: "tempting" } as IntegrationRequest, p);
  assert.equal(r.status, "merged", `${r.stage}:${r.reason}`);
  assert.equal(r.taskTip, fx.taskTip, "merged the DERIVED agent/ep1/t1 tip, never the caller-named branch");
});

test("P12 drift guard: taskBranchName matches the P6 provisioner", () => {
  assert.equal(taskBranchName("ep1", "t1"), p6TaskBranchName("ep1", "t1"));
  assert.equal(taskBranchName("ep1", "t1"), "agent/ep1/t1");
});

// ─── §2 step 3: resolve ───────────────────────────────────────────────────

test("P12 resolve: non-repo repoRoot, missing branches", async (t) => {
  const fx = makeRepo(t);
  const p = ports();
  const notRepo = await integrateTestedCandidate(req({ dir: tmpdir() }), p);
  assert.equal(notRepo.status, "refused");
  assert.equal(notRepo.reason, "context:repoRoot-not-a-repo");

  const noEp = await integrateTestedCandidate(req(fx, { episodeBranch: "ghost", episodeId: "ep2" }), ports());
  assert.equal(noEp.reason, "resolve:episodeBranch-missing");
  const noTask = await integrateTestedCandidate(req(fx, { taskId: "t9" }), ports());
  assert.equal(noTask.reason, "resolve:taskBranch-missing:agent/ep1/t9");
});

test("P12 resolve: equal head is already-merged (no journal write)", async (t) => {
  const fx = makeRepo(t, "identical");
  const p = ports();
  const r = await integrateTestedCandidate(req(fx), p);
  assert.equal(r.status, "already-merged");
  assert.equal(r.stage, "resolve");
  assert.deepEqual(r.evidenceRefs, [`equal:head:${fx.epHead}`]);
  assert.equal((p.journal as MemJournal).records.length, 0);
});

test("P12 resolve: contained task tip is already-merged via ancestor, no journal write", async (t) => {
  const fx = makeRepo(t, "contained");
  const p = ports();
  const r = await integrateTestedCandidate(req(fx), p);
  assert.equal(r.status, "already-merged");
  assert.deepEqual(r.evidenceRefs, [`ancestor:task-tip:${fx.taskTip}`]);
  assert.equal((p.journal as MemJournal).records.length, 0);
});

test("P12 resolve: expectedTaskTip pin fires BEFORE the already-merged shortcut", async (t) => {
  const fx = makeRepo(t, "contained"); // graph alone would answer already-merged
  const p = ports();
  const r = await integrateTestedCandidate(req(fx, { expectedTaskTip: "a".repeat(40) }), p);
  assert.equal(r.status, "refused");
  assert.equal(r.reason, "resolve:expectedTaskTip-mismatch");
  assert.equal(r.taskTip, fx.taskTip);
  assert.equal((p.journal as MemJournal).records.length, 0);
});

test("P12 regression: leading-zero SHAs clear context validation (the 1-in-16 fix)", async (t) => {
  // The old SHA pattern `^(0|[1-9a-f](?:{39}|{63}))$` rejected every 40-hex
  // string starting with '0' — ~1/16 of real git SHAs — so integration
  // intermittently refused/died at construct. Functional pin: a well-formed
  // leading-zero pin passes validation and reaches the resolve comparison
  // (mismatch refusal), instead of `refused:context:…malformed`.
  const fx = makeRepo(t, "contained");
  const p = ports();
  const r = await integrateTestedCandidate(req(fx, { expectedTaskTip: "0".repeat(39) + "a" }), p);
  assert.equal(r.status, "refused");
  assert.equal(r.reason, "resolve:expectedTaskTip-mismatch", `${r.stage}:${r.reason}`);
});

test("P12 construct: conflict lists paths, journals nothing, advances nothing", async (t) => {
  const fx = makeRepo(t, "conflict");
  const p = ports();
  const r = await integrateTestedCandidate(req(fx), p);
  assert.equal(r.status, "conflict");
  assert.equal(r.stage, "construct");
  assert.match(r.reason ?? "", /conflict:paths:task\.txt/);
  assert.equal(r.candidateSha, undefined, "no candidate exists for a conflicted tree");
  assert.deepEqual(r.evidenceRefs, [`parents:${fx.epHead},${fx.taskTip}`]);
  assert.equal(head(fx.dir, "refs/heads/ep1"), fx.epHead, "episode branch untouched");
  assert.equal((p.journal as MemJournal).records.length, 0);
});

test("P12 M1/no-worktree-touch: dirty working tree survives the whole flow untouched", async (t) => {
  const fx = makeRepo(t);
  writeFileSync(join(fx.dir, "base.txt"), "uncommitted local edit\n");
  writeFileSync(join(fx.dir, "untracked.txt"), "mine\n");
  const porcelainBefore = git(fx.dir, ["status", "--porcelain"]).out;
  const p = ports();
  const r = await integrateTestedCandidate(req(fx), p);
  assert.equal(r.status, "merged");
  assert.equal(git(fx.dir, ["status", "--porcelain"]).out, porcelainBefore);
  assert.equal(git(fx.dir, ["cat-file", "blob", "HEAD:base.txt"]).out.includes("uncommitted"), false, "committed blob untouched by merge");
});

// ─── §2 step 5: gate (M2) ─────────────────────────────────────────────────

async function gateCase(t: { after: (fn: () => void) => void }, gate: IntegrationPorts["gate"]) {
  const fx = makeRepo(t);
  const p = ports(memJournal(), gate);
  const r = await integrateTestedCandidate(req(fx), p);
  return { fx, p, r };
}

test("P12 gate: throwing gate → gate-failed, nothing journaled, ref untouched", async (t) => {
  const { fx, p, r } = await gateCase(t, { async run() { throw new Error("gate exploded"); } });
  assert.equal(r.status, "gate-failed");
  assert.equal(r.reason, "gate-threw:Error");
  assert.ok(r.candidateSha, "candidate known (it was constructed)");
  assert.equal(head(fx.dir, "refs/heads/ep1"), fx.epHead);
  assert.equal((p.journal as MemJournal).records.length, 0);
});

test("P12 gate: denial → gate-denied; empty runId → gate-runid-invalid", async (t) => {
  const a = await gateCase(t, { async run(r) { return { pass: false, runId: "g1", sha: r.candidateSha }; } });
  assert.equal(a.r.status, "gate-failed");
  assert.equal(a.r.reason, "gate-denied");
  assert.equal((a.p.journal as MemJournal).records.length, 0);
  const b = await gateCase(t, { async run(r) { return { pass: true, runId: "", sha: r.candidateSha }; } });
  assert.equal(b.r.reason, "gate-runid-invalid");
});

test("P12 gate M2: sha binding — mismatch refused, case-normalized match accepted", async (t) => {
  const other = "f".repeat(40);
  const a = await gateCase(t, { async run() { return { pass: true, runId: "g1", sha: other }; } });
  assert.equal(a.r.status, "gate-failed");
  assert.equal(a.r.reason, "gate-sha-mismatch");
  assert.ok(a.r.evidenceRefs.some((e) => e.startsWith("gate-claimed:")));
  assert.equal(head(a.fx.dir, "refs/heads/ep1"), a.fx.epHead);
  const b = await gateCase(t, { async run(r) { return { pass: true, runId: "g1", sha: r.candidateSha.toUpperCase() }; } });
  assert.equal(b.r.status, "merged", "uppercase sha claim normalizes and matches");
});

// ─── §2 step 6: reverify ──────────────────────────────────────────────────

test("P12 reverify: task tip moved between gate and reverify → refused, journals nothing", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  const gate: IntegrationPorts["gate"] = {
    async run(r) {
      // a rogue (or racy) actor advances the TASK branch during the gate
      advanceBranch(fx.dir, "agent/ep1/t1", "late task commit");
      return { pass: true, runId: "g1", sha: r.candidateSha };
    },
  };
  const res = await integrateTestedCandidate(req(fx), ports(j, gate));
  assert.equal(res.status, "refused", `${res.stage}:${res.reason}`);
  assert.equal(res.stage, "reverify");
  assert.equal(res.reason, "task-tip-moved");
  assert.equal(j.records.length, 0, "reverify precedes the intent");
  assert.equal(head(fx.dir, "refs/heads/ep1"), fx.epHead);
});

// ─── §2 steps 7–9: advance / verify ───────────────────────────────────────

test("P12 merged: happy path — 2-parent candidate, intent→outcome→acceptance, evidence complete", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  const r = await integrateTestedCandidate(req(fx), ports(j));
  assert.equal(r.status, "merged", `${r.stage}:${r.reason}`);
  assert.equal(r.stage, "outcome");
  assert.equal(r.outcomeDurable, true);
  assert.equal(head(fx.dir, "refs/heads/ep1"), r.candidateSha);
  const parents = git(fx.dir, ["log", "-1", "--format=%P", "refs/heads/ep1"]).out.split(/\s+/);
  assert.deepEqual(parents, [fx.epHead, fx.taskTip], "episode parent first, task parent second");
  assert.ok(r.gateRunId);
  assert.deepEqual(r.evidenceRefs, [
    `candidate:${r.candidateSha}`, `parent:episode:${fx.epHead}`, `parent:task:${fx.taskTip}`,
    "gate:g1", "advance:observed",
  ]);
  assert.deepEqual(j.records.map((x) => x.kind), ["decision-intent", "decision-outcome", "acceptance"]);
  const intent = j.records[0] as Record<string, unknown>;
  assert.equal(intent.rung, 4);
  assert.equal(intent.action, "merge");
  assert.equal((intent.expectedEvidence as string), `candidate:${r.candidateSha}`);
  assert.deepEqual(intent.authority, { grantedBy: "human", sideEffect: "external" });
  const outcome = j.records[1] as Record<string, unknown>;
  assert.equal(outcome.acked, true);
  assert.equal(outcome.progress, "none");
  const acc = j.records[2] as Record<string, unknown>;
  assert.equal(acc.verdict, "complete");
  assert.deepEqual((acc.artifact as { sha: string }).sha, r.candidateSha);
});

test("P12 fidelity: every journaled record passes the REAL P4 validateSupervisorRecord", async (t) => {
  const fx = makeRepo(t);
  const dir = mkdtempSync(join(tmpdir(), "tre-p12-real-journal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const real = await DecisionJournal.open(join(dir, "decisions.jsonl"));
  const p: IntegrationPorts = { journal: real, gate: passGate };
  const r = await integrateTestedCandidate(req(fx), p);
  assert.equal(r.status, "merged");
  const read = await real.read();
  assert.equal(read.records.length, 3);
  for (const rec of read.records) {
    assert.doesNotThrow(() => validateSupervisorRecord(rec as never), `record ${JSON.stringify((rec as { kind?: string }).kind)} must validate`);
  }
});

test("P12 advance-failed: stale ref lock → CAS error, head unmoved → provable no-effect", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  // Simulate a concurrent ref writer: pre-existing lock file → update-ref
  // exits non-zero WITHOUT touching the ref.
  const gitDir = git(fx.dir, ["rev-parse", "--git-dir"]).out;
  const lockPath = join(fx.dir, gitDir, "refs", "heads", "ep1.lock");
  writeFileSync(lockPath, "stale lock\n");
  t.after(() => { try { rmSync(lockPath); } catch { /* already gone */ } });
  const r = await integrateTestedCandidate(req(fx), ports(j));
  assert.equal(r.status, "refused");
  assert.equal(r.stage, "advance");
  assert.equal(r.reason, "advance-failed");
  assert.equal(r.episodeHead, fx.epHead);
  assert.equal(head(fx.dir, "refs/heads/ep1"), fx.epHead);
  // intent landed (log-then-act), outcome says no-effect with acked:false
  assert.deepEqual(j.records.map((x) => x.kind), ["decision-intent", "decision-outcome"]);
  const outcome = j.records[1] as Record<string, unknown>;
  assert.equal(outcome.acked, false);
  assert.equal(outcome.notes, "no-effect: advance-failed");
});

test("P12 head-moved: gate advances the episode branch → CAS rejected, head-moved (not no-effect:advance-failed)", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  const gate: IntegrationPorts["gate"] = {
    async run(r) {
      // concurrent integration lands a DIFFERENT commit on ep1 mid-flight
      advanceBranch(fx.dir, "ep1", "other integration landed");
      return { pass: true, runId: "g1", sha: r.candidateSha };
    },
  };
  const res = await integrateTestedCandidate(req(fx), ports(j, gate));
  assert.equal(res.status, "refused", `${res.stage}:${res.reason}`);
  assert.equal(res.stage, "advance");
  assert.equal(res.reason, "head-moved");
  const moved = head(fx.dir, "refs/heads/ep1");
  assert.notEqual(moved, fx.epHead);
  assert.notEqual(moved, res.candidateSha, "our candidate never landed");
  assert.equal(res.episodeHead, moved);
  const outcome = j.records[1] as Record<string, unknown>;
  assert.equal(outcome.notes, "no-effect: head-moved", "nothing-happened IS provable (CAS exit rejected, head at third value)");
});

test("P12 act-unknown: exit-0 contradicted by the re-read → failed/advance-unverified, NEVER no-effect", async (t) => {
  const fx = makeRepo(t);
  // reference-transaction hook: after our CAS commits, an invisible actor
  // moves the ref again before the command exits (exit 0, head at a third
  // value) — the one state where nothing-happened is NOT provable.
  git(fx.dir, ["branch", "third", fx.base]);
  advanceBranch(fx.dir, "third", "third value");
  const third = head(fx.dir, "refs/heads/third");
  const hook = join(fx.dir, ".git", "hooks", "reference-transaction");
  writeFileSync(hook, [
    "#!/bin/sh",
    'if [ "$1" = committed ]; then',
    '  while read -r _old new ref; do',
    '    [ "$ref" = "refs/heads/ep1" ] && [ "$new" != "' + third + '" ] && git update-ref refs/heads/ep1 ' + third,
    "  done",
    "fi",
    "exit 0",
  ].join("\n"));
  chmodSync(hook, 0o755);
  const j = memJournal();
  const r = await integrateTestedCandidate(req(fx), ports(j));
  assert.equal(r.status, "failed");
  assert.equal(r.stage, "verify");
  assert.equal(r.reason, "advance-unverified");
  assert.equal(r.outcomeDurable, false, "landed-unknown is never claimed durable");
  assert.equal(head(fx.dir, "refs/heads/ep1"), third);
  const notes = j.records.map((x) => (x as { notes?: string }).notes ?? "");
  assert.ok(!notes.some((n) => n.startsWith("no-effect:")), "exit-0 contradiction must never claim no-effect");
  const outcome = j.records[1] as Record<string, unknown>;
  assert.equal(outcome.acked, false);
  assert.equal(outcome.notes, "act-unknown: advance-unverified");

  // Chained §2 step 2: the intent is open AND the outcome is un-acked and
  // unmarked → the action is NOT replayable; the next request must refuse.
  const p2 = ports(j); // same journal, fresh request identity (same seq → same actionId)
  const again = await integrateTestedCandidate(req(fx, { now: 1700000999000 }), p2);
  assert.equal(again.status, "refused");
  assert.equal(again.stage, "dedup");
  assert.equal(again.reason, "not-replayable");
});

test("P12 intent: journal append failure blocks the CAS entirely (log-then-act)", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  j.failFor = (rec) => rec.kind === "decision-intent" ? new Error("disk full") : undefined;
  const r = await integrateTestedCandidate(req(fx), ports(j));
  assert.equal(r.status, "refused");
  assert.equal(r.stage, "intent");
  assert.match(r.reason ?? "", /^intent-journal-failed:Error/);
  assert.equal(head(fx.dir, "refs/heads/ep1"), fx.epHead, "no advance without a landed intent");
  assert.equal(j.records.length, 0);
});

test("P12 durability: outcome-append failure surfaces outcomeDurable:false (observation still MERGED)", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  j.failFor = (rec) => rec.kind === "decision-outcome" ? new Error("fsync failed") : undefined;
  const r = await integrateTestedCandidate(req(fx), ports(j));
  assert.equal(r.status, "merged", "the observed advance is the authority");
  assert.equal(r.outcomeDurable, false);
  assert.equal(head(fx.dir, "refs/heads/ep1"), r.candidateSha);
  // intent + acceptance landed; the outcome record is the one that was lost
  assert.deepEqual(j.records.map((x) => x.kind), ["decision-intent", "acceptance"]);
});

// ─── §2 step 2: dedup ─────────────────────────────────────────────────────

test("P12 dedup: unreadable journal refuses; a second read failure per request (read once)", async (t) => {
  const fx = makeRepo(t);
  const r1 = await integrateTestedCandidate(req(fx), { journal: { async append() {}, async read() { throw new Error("io"); } }, gate: passGate });
  assert.equal(r1.status, "refused");
  assert.equal(r1.stage, "dedup");
  assert.equal(r1.reason, "journal-unreadable");
  const r2 = await integrateTestedCandidate(req(fx), { journal: { async append() {}, async read() { return { records: "not-an-array" as never }; } }, gate: passGate });
  assert.equal(r2.reason, "journal-unreadable");
  assert.equal(head(fx.dir, "refs/heads/ep1"), fx.epHead);
});

test("P12 dedup: acked outcome → already-executed; nothing runs again", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  const first = await integrateTestedCandidate(req(fx), ports(j));
  assert.equal(first.status, "merged");
  const second = await integrateTestedCandidate(req(fx, { now: 1700000500000 }), ports(j));
  assert.equal(second.status, "refused");
  assert.equal(second.stage, "dedup");
  assert.equal(second.reason, "already-executed");
  assert.equal(second.actionId, first.actionId, "same identity → same actionId");
  assert.equal(j.records.length, 3, "no additional records");
  assert.equal(head(fx.dir, "refs/heads/ep1"), first.candidateSha);
});

test("P12 dedup: no-effect outcome permits replay with distinct journal ids", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  const r = await integrateTestedCandidate(req(fx), ports(j));
  assert.equal(r.status, "merged");
  // rewrite history: the merged run collapsed to a provable no-effect pair
  const actionId = r.actionId;
  j.records.length = 0;
  j.records.push({ schema: "tre-supervisor/1", id: `${actionId}#i0`, ts: 1, episodeId: "ep1", kind: "decision-intent",
    actionId, rung: 4, action: "merge", expectedEvidence: `candidate:${r.candidateSha}`, authority: { grantedBy: "human", sideEffect: "external" } });
  j.records.push({ schema: "tre-supervisor/1", id: `${actionId}#o0`, ts: 1, episodeId: "ep1", kind: "decision-outcome",
    actionId, acked: false, progress: "none", notes: "no-effect: advance-failed" });
  git(fx.dir, ["update-ref", "refs/heads/ep1", fx.epHead]); // undo the merge
  const replay = await integrateTestedCandidate(req(fx, { now: 1700000700000 }), ports(j));
  assert.equal(replay.status, "merged", "provable no-effect is replayable");
  const newIds = j.records.slice(2).map((x) => x.id as string);
  assert.ok(!newIds.includes(`${actionId}#i0`) && !newIds.includes(`${actionId}#o0`), "replay uses distinct ids");
  assert.ok(newIds.some((i) => i.includes("r")), `replay ids carry the r-suffix: ${newIds.join(",")}`);
});

test("P12 dedup: open intent refuses reissue (unreadable candidate and unknown candidate)", async (t) => {
  const fx = makeRepo(t);
  // Foreign actionId's open intent must not block OUR fresh action.
  const j1 = memJournal();
  j1.records.push({ schema: "tre-supervisor/1", id: "i-foreign", ts: 1, episodeId: "ep1", kind: "decision-intent",
    actionId: "a-t1-merge-00000000", rung: 4, action: "merge", expectedEvidence: "candidate:" + "deadbeef".padEnd(40, "0"), authority: { grantedBy: "human", sideEffect: "external" } });
  const r1 = await integrateTestedCandidate(req(fx), ports(j1));
  assert.equal(r1.status, "merged", `another action's open intent is not ours to honour: ${r1.stage}:${r1.reason}`);

  // OUR action, intent open, expectedEvidence carries NO candidate →
  // unreadable: refuse with the dedicated reason.
  const j2 = memJournal();
  j2.records.push({ schema: "tre-supervisor/1", id: "i-uncand", ts: 1, episodeId: "ep1", kind: "decision-intent",
    actionId: r1.actionId, rung: 4, action: "merge", expectedEvidence: "no-candidate-here", authority: { grantedBy: "human", sideEffect: "external" } });
  git(fx.dir, ["update-ref", "refs/heads/ep1", fx.epHead]); // undo r1's landing
  const r2 = await integrateTestedCandidate(req(fx, { now: 1700000800000 }), ports(j2));
  assert.equal(r2.status, "refused");
  assert.equal(r2.stage, "dedup");
  assert.equal(r2.reason, "intent-open:candidate-unreadable");
  assert.equal(j2.records.length, 1, "a refused reissue journals nothing");

  // OUR action, intent open, candidate well-formed but head does not
  // descend from it and the task tip is NOT contained → plain intent-open.
  const j3 = memJournal();
  j3.records.push({ schema: "tre-supervisor/1", id: "i-open", ts: 1, episodeId: "ep1", kind: "decision-intent",
    actionId: r1.actionId, rung: 4, action: "merge", expectedEvidence: `candidate:${"a".repeat(40)}`, authority: { grantedBy: "human", sideEffect: "external" } });
  const r3 = await integrateTestedCandidate(req(fx, { now: 1700000800500 }), ports(j3));
  assert.equal(r3.status, "refused");
  assert.equal(r3.reason, "intent-open");
  assert.equal(j3.records.length, 1);
  assert.equal(head(fx.dir, "refs/heads/ep1"), fx.epHead, "refused reissues never touch the ref");
});

test("P12 recovery: open intent closes ONLY on observed reality", async (t) => {
  const fx = makeRepo(t);
  // 1) produce a real candidate by running the action once (fresh journal)
  const j0 = memJournal();
  const run1 = await integrateTestedCandidate(req(fx), ports(j0));
  assert.equal(run1.status, "merged", `run1: ${run1.stage}:${run1.reason}`);
  const candidate = run1.candidateSha as string;

  // 2) undo the merge; reopen with ONLY the intent for the SAME action
  const openIntent = (journal: MemJournal) => {
    journal.records.push({ schema: "tre-supervisor/1", id: `${run1.actionId}#i0`, ts: 1, episodeId: "ep1",
      kind: "decision-intent", actionId: run1.actionId, rung: 4, action: "merge",
      expectedEvidence: `candidate:${candidate}`, authority: { grantedBy: "human", sideEffect: "external" } });
  };
  git(fx.dir, ["update-ref", "refs/heads/ep1", fx.epHead]);

  // 2a) head does NOT descend from the candidate → refuse, do not reissue
  const ja = memJournal(); openIntent(ja);
  const ra = await integrateTestedCandidate(req(fx), ports(ja));
  assert.equal(ra.status, "refused");
  assert.equal(ra.reason, "intent-open");

  // 2b) head EQUALS the recorded candidate → recovered (head-equals-candidate)
  const jb = memJournal(); openIntent(jb);
  git(fx.dir, ["update-ref", "refs/heads/ep1", candidate]);
  const rb = await integrateTestedCandidate(req(fx), ports(jb));
  assert.equal(rb.status, "recovered");
  assert.ok(rb.evidenceRefs.includes("close:head-equals-candidate"));
  assert.equal(rb.outcomeDurable, true);

  // 2c) head is a DESCENDANT of the candidate → recovered (observed-descendant)
  const jc = memJournal(); openIntent(jc);
  advanceBranch(fx.dir, "ep1", "child of candidate");
  const rc = await integrateTestedCandidate(req(fx), ports(jc));
  assert.equal(rc.status, "recovered");
  assert.ok(rc.evidenceRefs.includes("close:observed-descendant"));

  // 2d) task tip contained via SOME OTHER integration (head moved past the
  // candidate): recovery must observe containment and close the intent —
  // NOT take the already-merged shortcut (that would strand it).
  const landOther = () => {
    git(fx.dir, ["update-ref", "refs/heads/ep1", fx.epHead]);
    // plumbing merge (ep1 is NOT the checked-out branch): merge-tree +
    // commit-tree + update-ref, bypassing the working tree entirely.
    const treeOut = git(fx.dir, ["merge-tree", "--write-tree", "refs/heads/ep1", "refs/heads/agent/ep1/t1"]).out;
    const tree = (treeOut.split("\n")[0] ?? "").trim();
    const commit = git(fx.dir, ["-c", "user.name=other", "-c", "user.email=o@x",
      "commit-tree", tree, "-p", fx.epHead, "-p", fx.taskTip, "-m", "other integration landed"]).out.trim();
    git(fx.dir, ["update-ref", "refs/heads/ep1", commit]);
  };
  landOther();
  const jd = memJournal(); openIntent(jd);
  const rc3 = await integrateTestedCandidate(req(fx, { now: 1700000900000 }), ports(jd));
  assert.equal(rc3.status, "recovered");
  assert.ok(rc3.evidenceRefs.includes("close:contained-by-other"));
  assert.equal(rc3.candidateSha, candidate, "the lost candidate is reported for the audit trail");

  // 2e) recovery closes the intent: after recovered, a retry sees an acked
  // outcome → already-executed
  const retry = await integrateTestedCandidate(req(fx, { now: 1700000900500 }), ports(jd));
  assert.equal(retry.status, "refused");
  assert.equal(retry.reason, "already-executed");
});

test("P12 recovery ordering: a landed merge must NOT strand the open intent as already-merged", async (t) => {
  const fx = makeRepo(t);
  const j0 = memJournal();
  const run1 = await integrateTestedCandidate(req(fx), ports(j0));
  const candidate = run1.candidateSha as string;
  // journal holds ONLY the open intent (outcome lost); head = candidate + 1
  const j = memJournal();
  j.records.push({ schema: "tre-supervisor/1", id: `${run1.actionId}#i0`, ts: 1, episodeId: "ep1",
    kind: "decision-intent", actionId: run1.actionId, rung: 4, action: "merge",
    expectedEvidence: `candidate:${candidate}`, authority: { grantedBy: "human", sideEffect: "external" } });
  // graph alone would answer already-merged (task tip contained); recovery is
  // checked FIRST and must win:
  const r = await integrateTestedCandidate(req(fx), ports(j));
  assert.equal(r.status, "recovered", "recovery beats the already-merged shortcut");
  assert.equal(r.candidateSha, candidate);
});

// ─── actionId determinism ─────────────────────────────────────────────────

test("P12 actionId: deterministic per identity, executionSeq disambiguates", async (t) => {
  const fx = makeRepo(t);
  const fake = { journal: memJournal(), gate: passGate };
  const a = await integrateTestedCandidate(req(fx, { now: 1 }), fake);
  const b = await integrateTestedCandidate(req(fx, { now: 2 }), fake); // now NOT in the digest
  const c = await integrateTestedCandidate(req(fx, { now: 3, executionSeq: 1 }), fake);
  assert.match(a.actionId, /^a-t1-merge-[0-9a-f]{16}$/);
  assert.equal(b.actionId, a.actionId, "same identity fields → same actionId (timestamp excluded)");
  assert.notEqual(c.actionId, a.actionId, "executionSeq disambiguates re-executions");
});

// ─── compartment guard ────────────────────────────────────────────────────

test("P12 compartment: src/integration imports ONLY node: builtins", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  // Layout-agnostic (audit C1 F10): under the compiled dist/test layout
  // this file sits at <root>/dist/test and the source is ../../src/…;
  // run source-relative (tsx --test test/*.ts) it is ../src/…. The old
  // pinned one-layout path ENOENT-crashed the other layout (a crash, not
  // an assertion — which is why bare `node --test test/*.ts` "fails").
  const candidates = [
    join(import.meta.dirname, "..", "src", "integration", "merge.ts"),
    join(import.meta.dirname, "..", "..", "src", "integration", "merge.ts"),
  ];
  const path = candidates.find((p) => existsSync(p));
  assert.ok(path !== undefined, `merge.ts source not found in either layout: ${candidates.join(" | ")}`);
  const src = readFileSync(path, "utf8");
  // C3-F8: the old double-quote-only static regex missed single-quoted
  // imports and dynamic import() specifiers entirely — an
  // `await import("express")` walked through green. Scan ALL three forms;
  // relative specifiers (".", "..") are excluded (they import no external
  // package), every other specifier must be a node: builtin.
  const specs = [
    ...[...src.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1] as string),
    ...[...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] as string),
    ...[...src.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] as string),
  ].filter((s) => !s.startsWith("."));
  assert.ok(specs.length > 0, "no import specifiers found — the guard regex is broken");
  for (const s of specs) assert.match(s, /^node:/, `forbidden import in src/integration: ${s}`);
  // Sanity: the widened guard actually sees the module's real imports.
  const staticCount = [...src.matchAll(/\bfrom\s*["']([^"']+)["']/g)].length;
  assert.ok(specs.length >= staticCount, "guard lost specifiers to the relative filter");
});

// ─── git PATH shim (deterministic ambiguity injection) ───────────────────
// execFile resolves "git" through process.env.PATH at call time, so a
// shim dir prepended for ONE integrate call injects exactly the
// ambiguous states the audit said were unprovable:
//  - "casfail": update-ref LANDS, then claims failure (exit 1) →
//    observed-despite-cas-error (audit C1 F9, previously untested).
//  - "fence":   update-ref lands and arms a marker; the verify re-read
//    then HARD-fails (exit 2) → the M6 fence (audit C1 F9: fence-*).
//  - "emptyexit1": merge-tree exits 1 with EMPTY stdout (ref vanished
//    between resolve and construct) → failed, NOT a bogus conflict
//    (audit C1 F1).
function gitShim(t: { after: (fn: () => void) => void }, mode: "casfail" | "fence" | "emptyexit1") {
  const dir = mkdtempSync(join(tmpdir(), "tre-p12-shim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" });
  const real = (probe.stdout ?? "").trim();
  if (!real) throw new Error("no real git on PATH for the shim");
  const marker = join(dir, "ARMED");
  const body = [
    "#!/bin/sh",
    `REAL="${real}"`,
    `MARKER="${marker}"`,
    'sub=""; for a in "$@"; do case "$a" in update-ref|merge-tree|rev-parse) sub="$a";; esac; done',
    mode === "casfail"
      ? 'if [ "$sub" = update-ref ]; then "$REAL" "$@"; [ $? -eq 0 ] && exit 1; exit 1; fi'
      : "",
    mode === "fence"
      ? 'if [ "$sub" = update-ref ]; then "$REAL" "$@" || exit $?; touch "$MARKER"; exit 0; fi\n'
        + 'if [ "$sub" = rev-parse ] && [ -f "$MARKER" ]; then exit 2; fi'
      : "",
    mode === "emptyexit1"
      // EXACTLY the observable state of a ref vanishing between resolve
      // and construct (probed on git 2.54): exit 1, empty stdout.
      ? 'if [ "$sub" = merge-tree ]; then exit 1; fi'
      : "",
    '"$REAL" "$@"',
    "",
  ].filter((l) => l !== "").join("\n");
  const shim = join(dir, "git");
  writeFileSync(shim, body);
  chmodSync(shim, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${saved}`;
  return { marker, stop: () => { process.env.PATH = saved; } };
}

test("P12 observed-despite-cas-error: CAS exits 1 AFTER the ref landed → MERGED, never refused", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  const shim = gitShim(t, "casfail");
  let r;
  try { r = await integrateTestedCandidate(req(fx), ports(j)); } finally { shim.stop(); }
  assert.equal(r.status, "merged", `${r.stage}:${r.reason} — observation is the authority (docs/16 §2 step 9)`);
  assert.equal(r.episodeHead, r.candidateSha);
  assert.equal(head(fx.dir, "refs/heads/ep1"), r.candidateSha, "the ref really moved (shim ran the real update-ref)");
  assert.ok((r.evidenceRefs ?? []).includes("advance:observed-despite-cas-error"),
    `expected the cas-error evidence tag, got ${JSON.stringify(r.evidenceRefs)}`);
  const outcome = j.records[1] as Record<string, unknown>;
  assert.equal(outcome.acked, true);
  assert.ok(j.records.some((x) => (x as { kind?: string }).kind === "acceptance"));
});

test("P12 M6 fence: hard re-read failure after the intent → fence:verify, act-unknown fence record, never no-effect", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  const shim = gitShim(t, "fence");
  let r;
  try { r = await integrateTestedCandidate(req(fx), ports(j)); } finally { shim.stop(); }
  assert.equal(r.status, "failed");
  assert.equal(r.stage, "verify");
  assert.match(r.reason ?? "", /^fence:verify:/);
  assert.equal(r.outcomeDurable, false);
  // Post-intent escape: intent + fence outcome (id carries the SAME
  // per-actionId suffix + the fence discriminator, audit C1 F7).
  assert.deepEqual(j.records.map((x) => x.kind), ["decision-intent", "decision-outcome"]);
  const fence = j.records[1] as Record<string, unknown>;
  assert.equal(fence.acked, false);
  assert.equal(fence.notes, "act-unknown: fence-verify:Error");
  assert.ok(String(fence.id).endsWith("f"), `fence outcome id must be distinct from the normal outcome id: ${fence.id}`);
  assert.notEqual(fence.id, `${r.actionId}#o0`);
});

test("P12 construct F1: merge-tree exit 1 with EMPTY stdout (ref vanished) → failed, not a bogus conflict", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  const shim = gitShim(t, "emptyexit1");
  let r;
  try { r = await integrateTestedCandidate(req(fx), ports(j)); } finally { shim.stop(); }
  assert.equal(r.status, "failed", `empty-stdout exit 1 is NOT a conflict: ${r.stage}:${r.reason}`);
  assert.equal(r.stage, "construct");
  assert.match(r.reason ?? "", /^git:merge-tree:/);
  assert.ok(!(r.reason ?? "").startsWith("conflict:"), "no bogus conflict:paths from an empty payload");
  assert.equal(head(fx.dir, "refs/heads/ep1"), fx.epHead, "ref untouched");
  assert.equal(j.records.length, 0, "construct failure journals nothing (pre-intent)");
});

test("P12 dedup precedence F6: a landed merge answers already-executed even when the pin would now mismatch", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  const run1 = await integrateTestedCandidate(req(fx), ports(j));
  assert.equal(run1.status, "merged");
  // The task branch moves AFTER our merge landed: the expectedTaskTip pin
  // WOULD mismatch, but dedup (step 2) precedes resolve (step 3) — the
  // pinned outcome is the authority for this identity. Reproducing an
  // executed action must never re-run resolve, let alone the CAS.
  advanceBranch(fx.dir, "agent/ep1/t1", "task moved after integration");
  const again = await integrateTestedCandidate(req(fx, { now: 1700000500000, expectedTaskTip: fx.taskTip }), ports(j));
  assert.equal(again.status, "refused");
  assert.equal(again.stage, "dedup");
  assert.equal(again.reason, "already-executed", "the acked outcome outranks the (now stale) pin");
  assert.equal(head(fx.dir, "refs/heads/ep1"), run1.candidateSha, "nothing ran again");
  assert.equal(j.records.length, 3, "intent+outcome+acceptance — the reissue journals nothing");
});

test("P12 dedup interleaving: no-effect then replay uses r-suffixed ids (second attempt)", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  // attempt 1: wedge the CAS with a stale lock → provable no-effect
  const gitDir = git(fx.dir, ["rev-parse", "--git-dir"]).out;
  const lockPath = join(fx.dir, gitDir, "refs", "heads", "ep1.lock");
  writeFileSync(lockPath, "stale lock\n");
  const r1 = await integrateTestedCandidate(req(fx), ports(j));
  assert.equal(r1.reason, "advance-failed");
  rmSync(lockPath);
  // attempt 2: same identity (no-effect is replayable) — ids must be
  // distinct AND follow the documented r-suffix scheme.
  const r2 = await integrateTestedCandidate(req(fx, { now: 1700000600000 }), ports(j));
  assert.equal(r2.status, "merged", `${r2.stage}:${r2.reason}`);
  const ids = j.records.map((x) => String((x as { id?: string }).id));
  assert.deepEqual(ids.slice(2).map((i) => i.replace(r2.actionId as string, "")),
    ["#i0r1", "#o0r1", "#acc0r1"], "replay ids count prior intents/outcomes per actionId");
  assert.equal(new Set(ids).size, ids.length, "every journal id is unique across attempts");
});

// ─── cycle-2 audit findings ───────────────────────────────────────────────

test("P12 C2-F1: case-folded 'main' guard — MAIN/MAIN-Mixed never reach git (macOS APFS rewrite)", async (t) => {
  const fx = makeRepo(t);
  const p = ports();
  for (const name of ["MAIN", "Main", "mAiN"]) {
    const r = await integrateTestedCandidate(req(fx, { episodeBranch: name } as Partial<IntegrationRequest>), p);
    assert.equal(r.status, "refused", `${name} must be refused (APFS: refs/heads/MAIN rewrites refs/heads/main)`);
    assert.equal(r.reason, "context:episodeBranch-main", `${name} → context:episodeBranch-main`);
  }
  assert.deepEqual((p.journal as MemJournal).records, [], "the guard is pre-git: nothing journaled");
});

test("P12 C2-F2: repo identity pinned — nested repoRoot refuses, injected GIT_DIR cannot redirect the CAS", async (t) => {
  const fx = makeRepo(t);
  // outer/ contains fx-like inner repo state at fx.dir/.nested — a
  // repoRoot nested INSIDE the toplevel git reports must refuse.
  const nested = join(fx.dir, ".nested");
  mkdirSync(nested, { recursive: true });
  const p = ports();
  const r = await integrateTestedCandidate(req(fx, { repoRoot: resolve(nested) } as Partial<IntegrationRequest>), p);
  assert.equal(r.status, "refused", "a non-repo dir inside a repo never targets the outer repo");
  assert.equal(r.reason, "context:repoRoot-outer-repo", `expected the outer-repo refusal, got ${r.reason}`);

  // GIT_DIR injection: with the env stripped by GIT_ENV this must behave
  // exactly like the unpolluted run (merged), NOT advance a ref in the
  // redirected repository. Point GIT_DIR at the inner .git of the NESTED
  // probe dir's parent is meaningless — set it to a DIFFERENT repo's git
  // dir and confirm the CAS still targets fx (via cwd), proving the env
  // never overrode it.
  const otherRepo = mkdtempSync(join(tmpdir(), "tre-p12-other-repo-"));
  t.after(() => rmSync(otherRepo, { recursive: true, force: true }));
  git(otherRepo, ["init", "-q", "-b", "ep1", "."]);
  git(otherRepo, ["config", "user.name", "test"]);
  git(otherRepo, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(otherRepo, "f.txt"), "x\n");
  git(otherRepo, ["add", "-A"]);
  git(otherRepo, ["commit", "-q", "-m", "other base"]);
  const otherEpHead = head(otherRepo, "refs/heads/ep1");
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(otherRepo, ".git");
  try {
    const ok = await integrateTestedCandidate(req(fx, { now: 1700000111000 }), ports());
    assert.equal(ok.status, "merged", `stripped env → normal merge: ${ok.stage}:${ok.reason}`);
    assert.equal(ok.episodeHead !== otherEpHead, true, "the merge targeted fx, never the GIT_DIR repo");
    assert.equal(head(otherRepo, "refs/heads/ep1"), otherEpHead, "the redirected-to repo's ref is untouched");
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
  }
});

test("P12 C2-F4: CAS exits 1 after landing AND a later writer moved head past the candidate → act-unknown, never no-effect", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  const casfailAncestor = () => {
    const dir = mkdtempSync(join(tmpdir(), "tre-p12-shim-anc-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const probe = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" });
    const real = (probe.stdout ?? "").trim();
    if (!real) throw new Error("no real git on PATH for the shim");
    const marker = join(dir, "ARMED");
    // update-ref LANDS, arms the marker, exits 1. Every LATER git call
    // (the verify re-read) first advances ep1 from our candidate (a
    // plausible concurrent integrator) and then fails.
    const body = [
      "#!/bin/sh",
      `REAL="${real}"`,
      `MARKER="${marker}"`,
      `REPO="${fx.dir}"`,
      'sub=""; for a in "$@"; do case "$a" in update-ref|rev-parse) sub="$a";; esac; done',
      'if [ "$sub" = update-ref ]; then "$REAL" "$@"; rc=$?; [ $rc -eq 0 ] && touch "$MARKER"; exit 1; fi',
      // First post-arm rev-parse: a plausible LATE integrator advances ep1
      // FROM our candidate, then the real re-read succeeds (headNow =
      // late commit). F4's ancestor probe then rules OUT no-effect.
      'if [ "$sub" = rev-parse ] && [ -f "$MARKER" ] && [ ! -f "$MARKER.done" ]; then',
      '  tree=$("$REAL" -C "$REPO" rev-parse "refs/heads/ep1^{tree}" 2>/dev/null)',
      '  c=$("$REAL" -C "$REPO" -c user.name=late -c user.email=l@x commit-tree "$tree" -p refs/heads/ep1 -m late 2>/dev/null)',
      '  "$REAL" -C "$REPO" update-ref refs/heads/ep1 "$c" 2>/dev/null',
      '  touch "$MARKER.done"',
      "fi",
      '"$REAL" "$@"',
      "",
    ].join("\n");
    const shim = join(dir, "git");
    writeFileSync(shim, body);
    chmodSync(shim, 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${dir}${delimiter}${saved}`;
    return { stop: () => { process.env.PATH = saved; } };
  };
  const shim = casfailAncestor();
  let r;
  try { r = await integrateTestedCandidate(req(fx), ports(j)); } finally { shim.stop(); }
  // head now has our candidate as ANCESTOR (our write landed, then a
  // later writer moved on) — provable-no-effect is FALSE: act-unknown.
  assert.equal(r.status, "failed", `landed-then-moved is act-unknown: ${r.stage}:${r.reason}`);
  assert.equal(r.stage, "verify");
  assert.equal(r.reason, "advance-unverified");
  assert.equal(r.outcomeDurable, false);
  assert.ok((r.evidenceRefs ?? []).includes("ancestor:head-has-candidate"),
    `expected the ancestor evidence tag, got ${JSON.stringify(r.evidenceRefs)}`);
  const kinds = j.records.map((x) => String((x as { kind?: string }).kind));
  assert.deepEqual(kinds, ["decision-intent", "decision-outcome"]);
  const outcome = j.records[1] as Record<string, unknown>;
  assert.equal(outcome.acked, false);
  assert.ok(String(outcome.notes).startsWith("act-unknown:"), `never no-effect: got ${outcome.notes}`);
  // And the identity is NOT replayable: the ancestor-of-head journal
  // would contradict an already-merged replay.
  const again = await integrateTestedCandidate(req(fx, { now: 1700000777000 }), ports(j));
  assert.equal(again.status, "refused");
  assert.equal(again.reason, "not-replayable", "act-unknown blocks replay (docs/16 §3 table)");
});

test("P12 C2-F8: nonexistent repoRoot → refused context:repoRoot-not-a-repo (never a fence failed)", async (t) => {
  const j = memJournal();
  const missing = join(tmpdir(), "tre-p12-definitely-not-here-9e1a7c");
  const r = await integrateTestedCandidate(
    { repoRoot: missing, episodeId: "ep1", taskId: "t1", episodeBranch: "ep1", now: 1700000999000, grantedBy: "human" }, ports(j));
  assert.equal(r.status, "refused", `nothing happened — must not be failed/outcome-unknown: ${r.stage}:${r.reason}`);
  assert.equal(r.stage, "context");
  assert.equal(r.reason, "context:repoRoot-not-a-repo");
  assert.deepEqual(j.records, [], "the documented negative journals nothing");
});

test("P12 C2-F9: a hung gate returns bounded — gate-timeout, no journal write, ref untouched", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  const saved = process.env.TRE_P12_GATE_TIMEOUT_MS;
  process.env.TRE_P12_GATE_TIMEOUT_MS = "1000";
  t.after(() => { if (saved === undefined) delete process.env.TRE_P12_GATE_TIMEOUT_MS; else process.env.TRE_P12_GATE_TIMEOUT_MS = saved; });
  const hangGate: IntegrationPorts["gate"] = { run: () => new Promise(() => { /* never settles */ }) };
  const t0 = Date.now();
  const r = await integrateTestedCandidate(req(fx), ports(j, hangGate));
  const dt = Date.now() - t0;
  assert.equal(r.status, "gate-failed", `hung gate must time out, not hang: ${r.stage}:${r.reason}`);
  assert.equal(r.reason, "gate-timeout");
  assert.ok(dt < 10_000, `returned bounded (${dt}ms)`);
  assert.deepEqual(j.records, [], "a gate timeout is pre-intent: zero journal writes");
  assert.equal(head(fx.dir, "refs/heads/ep1"), fx.epHead, "ref untouched");
});

// ─── cycle-2 audit F7: real-P4 validation over EVERY journal path ─────────

type Scenario = { label: string; run: (t2: { after: (fn: () => void) => void }, real: IntegrationPorts["journal"]) => Promise<unknown> };

/** One shim factory parameterized by mode (mirrors gitShim above but the
 *  real-journal scenarios live far from it; kept tiny and local). */
function modeShim(t2: { after: (fn: () => void) => void }, mode: "casfail" | "fence") {
  const dir = mkdtempSync(join(tmpdir(), `tre-p12-rv-${mode}-`));
  t2.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" });
  const real = (probe.stdout ?? "").trim();
  if (!real) throw new Error("no real git on PATH for the shim");
  const marker = join(dir, "ARMED");
  const body = [
    "#!/bin/sh", `REAL="${real}"`, `MARKER="${marker}"`,
    'sub=""; for a in "$@"; do case "$a" in update-ref|rev-parse) sub="$a";; esac; done',
    mode === "casfail"
      ? 'if [ "$sub" = update-ref ]; then "$REAL" "$@"; [ $? -eq 0 ] && exit 1; exit 1; fi'
      : 'if [ "$sub" = update-ref ]; then "$REAL" "$@" || exit $?; touch "$MARKER"; exit 0; fi\n'
        + 'if [ "$sub" = rev-parse ] && [ -f "$MARKER" ]; then exit 2; fi',
    '"$REAL" "$@"', "",
  ].join("\n");
  const shimPath = join(dir, "git");
  writeFileSync(shimPath, body);
  chmodSync(shimPath, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${saved}`;
  return () => { process.env.PATH = saved; };
}

test("P12 C2-F7: the REAL P4 validator accepts records from EVERY journaled path", async (t) => {
  const scenarios: Scenario[] = [
    { // happy merged path
      label: "merged",
      run: async (t2, real) => {
        const fx = makeRepo(t2);
        return integrateTestedCandidate(req(fx, { now: 1700003000001 }), { journal: real, gate: passGate });
      },
    },
    { // no-effect: stale lock wedges the CAS, head provably unmoved
      label: "no-effect:advance-failed",
      run: async (t2, real) => {
        const fx = makeRepo(t2);
        const gitDir = git(fx.dir, ["rev-parse", "--git-dir"]).out;
        const lockPath = join(fx.dir, gitDir, "refs", "heads", "ep1.lock");
        writeFileSync(lockPath, "stale lock\n");
        t2.after(() => { try { rmSync(lockPath); } catch { /* gone */ } });
        return integrateTestedCandidate(req(fx, { now: 1700003000002 }), { journal: real, gate: passGate });
      },
    },
    { // no-effect: head moved concurrently → CAS rejected
      label: "no-effect:head-moved",
      run: async (t2, real) => {
        const fx = makeRepo(t2);
        const mvGate: IntegrationPorts["gate"] = {
          async run(r2) { advanceBranch(fx.dir, "ep1", "concurrent landing"); return { pass: true, runId: "g1", sha: r2.candidateSha }; },
        };
        return integrateTestedCandidate(req(fx, { now: 1700003000003 }), { journal: real, gate: mvGate });
      },
    },
    { // act-unknown via the M6 fence (verify re-read hard-fails)
      label: "act-unknown:fence-verify",
      run: async (t2, real) => {
        const fx = makeRepo(t2);
        const stop = modeShim(t2, "fence");
        try { return await integrateTestedCandidate(req(fx, { now: 1700003000004 }), { journal: real, gate: passGate }); }
        finally { stop(); }
      },
    },
    { // observed-despite-cas-error: merged + outcome + acceptance after a lying exit
      label: "merged:observed-despite-cas-error",
      run: async (t2, real) => {
        const fx = makeRepo(t2);
        const stop = modeShim(t2, "casfail");
        try { return await integrateTestedCandidate(req(fx, { now: 1700003000005 }), { journal: real, gate: passGate }); }
        finally { stop(); }
      },
    },
    { // recovered: open intent closes on observed containment
      label: "recovered",
      run: async (t2, real) => {
        const fx = makeRepo(t2);
        // run once with a MEMORY journal to get the actionId+candidate,
        // then undo and replay the identity into the REAL journal holding
        // only the open intent — recovery closes it against observed refs.
        const j0 = memJournal();
        const run1 = await integrateTestedCandidate(req(fx, { now: 1700003000006 }), ports(j0));
        await real.append({ schema: "tre-supervisor/1", id: `${run1.actionId}#i0`, ts: 1, episodeId: "ep1",
          kind: "decision-intent", actionId: run1.actionId, rung: 4, action: "merge",
          expectedEvidence: `candidate:${run1.candidateSha}`, authority: { grantedBy: "human", sideEffect: "external" } });
        git(fx.dir, ["update-ref", "refs/heads/ep1", fx.epHead]); // undo run1's CAS
        // land the task tip via PLUMBING (ep1 is not checked out — `git
        // merge` would target `ws`): merge-tree + commit-tree + update-ref.
        const treeOut = git(fx.dir, ["merge-tree", "--write-tree", "refs/heads/ep1", "refs/heads/agent/ep1/t1"]).out;
        const tree = (treeOut.split("\n")[0] ?? "").trim();
        const other = git(fx.dir, ["-c", "user.name=other", "-c", "user.email=o@x",
          "commit-tree", tree, "-p", fx.epHead, "-p", run1.taskTip ?? fx.taskTip, "-m", "landed elsewhere"]).out.trim();
        git(fx.dir, ["update-ref", "refs/heads/ep1", other]); // task contained via other path
        return integrateTestedCandidate(req(fx, { now: 1700003000007 }), { journal: real, gate: passGate });
      },
    },
    { // replay r-suffixed ids (no-effect then successful replay)
      label: "replay:r-suffix",
      run: async (t2, real) => {
        const fx = makeRepo(t2);
        const gitDir = git(fx.dir, ["rev-parse", "--git-dir"]).out;
        const lockPath = join(fx.dir, gitDir, "refs", "heads", "ep1.lock");
        writeFileSync(lockPath, "stale lock\n");
        await integrateTestedCandidate(req(fx, { now: 1700003000008 }), { journal: real, gate: passGate });
        rmSync(lockPath);
        return integrateTestedCandidate(req(fx, { now: 1700003000009 }), { journal: real, gate: passGate });
      },
    },
  ];

  for (const sc of scenarios) {
    const dirw = mkdtempSync(join(tmpdir(), "tre-p12-realval-"));
    t.after(() => rmSync(dirw, { recursive: true, force: true }));
    const real = await DecisionJournal.open(join(dirw, "decisions.jsonl"));
    const result = await sc.run(t, real);
    void result;
    const read = await real.read();
    assert.ok(read.records.length >= 1, `${sc.label}: expected journal records`);
    for (const rec of read.records) {
      assert.doesNotThrow(() => validateSupervisorRecord(rec as never),
        `${sc.label}: record kind=${JSON.stringify((rec as { kind?: string }).kind)} id=${JSON.stringify((rec as { id?: string }).id)} must pass the REAL P4 validator`);
    }
  }
});

// ─── cycle-3 audit closures (C3-F1/F4/F5/F6/F7/F9) ───────────────────────

test("P12 C3-F1 sticky: an acked outcome is NEVER unset by a later no-effect record", async (t) => {
  // The exact C3-F1 race: execution A merges and ACKS; execution B (a CAS
  // loser appending no-effect under the same identity) lands AFTER the
  // ack. Last-wins scanning cleared `done` and the identity replayed —
  // merging a NEW tip under an identity the supervisor already accepted.
  const fx = makeRepo(t);
  const j = memJournal();
  const r1 = await integrateTestedCandidate(req(fx), ports(j));
  assert.equal(r1.status, "merged");
  // Forge B's late no-effect outcome for the SAME actionId (a journal
  // can always receive records out of order from another writer).
  // Cycle-4 audit F2: the forged record must carry the REAL schema id
  // ("tre-supervisor/1" — journal.ts DECISION_SCHEMA_ID) and pass the
  // real validateSupervisorRecord, or the interleaving it simulates is
  // not producible through a real DecisionJournal append.
  const lateNoEffect = {
    schema: "tre-supervisor/1", kind: "decision-outcome", id: `${r1.actionId}#o9`, ts: 1700000999999,
    episodeId: "ep1", taskId: "t1", actionId: r1.actionId, acked: false, progress: "none",
    notes: "no-effect: head-moved", evidenceRefs: [],
  };
  assert.doesNotThrow(() => validateSupervisorRecord(lateNoEffect as never), "forged record must be real-journal-producible");
  await j.append(lateNoEffect);
  advanceBranch(fx.dir, "agent/ep1/t1", "new task work"); // would enable a NEW merge
  const again = await integrateTestedCandidate(req(fx, { now: 1700000888001 }), ports(j));
  assert.equal(again.status, "refused", "acked is sticky-terminal");
  assert.equal(again.reason, "already-executed", `acked must win over the later no-effect: got ${again.reason}`);
});

test("P12 C3-F1 sticky: act-unknown outranks interleaved no-effect outcomes", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  // REAL act-unknown via the fence shim (exit-0 CAS contradicted by the
  // hard re-read failure) — the actionId must be the digest-true one.
  const shim = gitShim(t, "fence");
  let r1;
  try { r1 = await integrateTestedCandidate(req(fx, { now: 1700000888003 }), ports(j)); } finally { shim.stop(); }
  assert.equal(r1.reason, "fence:verify:Error");
  assert.equal((j.records[1] as Record<string, unknown>).notes, "act-unknown: fence-verify:Error");
  // A LATER writer interleaves a no-effect outcome for the same identity.
  // Cycle-4 audit F2: REAL schema id + real-validator check (see the
  // companion test) — a forgery with a fake schema would never survive
  // a DecisionJournal.append.
  const interleaved = {
    schema: "tre-supervisor/1", kind: "decision-outcome", id: `${r1.actionId}#o8`, ts: 1700000999998,
    episodeId: "ep1", taskId: "t1", actionId: r1.actionId, acked: false, progress: "none",
    notes: "no-effect: head-moved", evidenceRefs: [],
  };
  assert.doesNotThrow(() => validateSupervisorRecord(interleaved as never), "forged record must be real-journal-producible");
  await j.append(interleaved);
  const again = await integrateTestedCandidate(req(fx, { now: 1700000888004 }), ports(j));
  assert.equal(again.status, "refused");
  assert.equal(again.reason, "not-replayable", "a later no-effect must not wash out the sticky act-unknown");
});

test("P12 C3-F1 in-flight: a concurrent duplicate identity is refused, lock released after", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  let releaseGate: () => void = () => {};
  const holdGate: IntegrationPorts["gate"] = {
    run: (r2) => new Promise((res) => { releaseGate = () => res({ pass: true, runId: "g1", sha: r2.candidateSha }); }),
  };
  const p = ports(j, holdGate);
  const first = integrateTestedCandidate(req(fx, { now: 1700000888010 }), p);
  t.after(() => { releaseGate(); });
  // Yield until the first call is parked in its gate (same-identity calls
  // would otherwise both sit in the microtask queue). 60ms is generous
  // for the pre-gate git plumbing on a loaded runner.
  await new Promise((r) => setTimeout(r, 60));
  const dup = await integrateTestedCandidate(req(fx, { now: 1700000888011 }), ports(j));
  assert.equal(dup.status, "refused", `duplicate dispatch must not double-execute: ${JSON.stringify(dup)}`);
  assert.equal(dup.reason, "in-flight");
  assert.equal(j.records.length, 0, "the refused duplicate journaled nothing");
  releaseGate();
  const r1 = await first;
  assert.equal(r1.status, "merged");
  // Lock released on the normal return: a fresh identity (seq bump) runs.
  const next = await integrateTestedCandidate(req(fx, { now: 1700000888012, executionSeq: 1 }), ports(j));
  assert.notEqual(next.reason, "in-flight", "the reservation must not outlive the execution");
});

test("P12 C3-F4 killed writer: no reported exit code + moved head → act-unknown, never no-effect", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  const dir = mkdtempSync(join(tmpdir(), "tre-p12-shim-kill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" });
  const real = (probe.stdout ?? "").trim();
  if (!real) throw new Error("no real git on PATH for the shim");
  const marker = join(dir, "ARMED");
  // update-ref LANDS, arms, then is killed (137: NO exit status git ever
  // reported). The first post-arm rev-parse lets an unrelated integrator
  // RESET ep1 to a fresh root commit (erasing the ancestor evidence)
  // before the re-read succeeds at a third value.
  const body = [
    "#!/bin/sh", `REAL="${real}"`, `MARKER="${marker}"`, `REPO="${fx.dir}"`,
    'sub=""; for a in "$@"; do case "$a" in update-ref|rev-parse) sub="$a";; esac; done',
    'if [ "$sub" = update-ref ]; then "$REAL" "$@"; rc=$?; [ $rc -eq 0 ] && touch "$MARKER"; kill -9 $; fi',
    'if [ "$sub" = rev-parse ] && [ -f "$MARKER" ] && [ ! -f "$MARKER.done" ]; then',
    '  "$REAL" -C "$REPO" checkout -q --orphan resetter 2>/dev/null',
    '  "$REAL" -C "$REPO" rm -q -r --cached . 2>/dev/null',
    '  "$REAL" -C "$REPO" -c user.name=r -c user.email=r@x commit -q -m unrelated-root 2>/dev/null',
    '  "$REAL" -C "$REPO" update-ref refs/heads/ep1 "$("$REAL" -C "$REPO" rev-parse HEAD)" 2>/dev/null',
    '  "$REAL" -C "$REPO" checkout -q ep1 2>/dev/null; "$REAL" -C "$REPO" branch -q -D resetter 2>/dev/null',
    '  touch "$MARKER.done"',
    "fi",
    '"$REAL" "$@"', "",
  ].join("\n");
  const shim = join(dir, "git");
  writeFileSync(shim, body);
  chmodSync(shim, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${saved}`;
  let r;
  try { r = await integrateTestedCandidate(req(fx, { now: 1700000888020 }), ports(j)); } finally { process.env.PATH = saved; }
  assert.equal(r.status, "failed", `killed writer + third-value head is UNVERIFIABLE: ${r.stage}:${r.reason}`);
  assert.equal(r.stage, "verify");
  assert.equal(r.reason, "advance-unverified");
  assert.ok((r.evidenceRefs ?? []).length >= 1);
  const outcome = j.records[1] as Record<string, unknown>;
  assert.ok(String(outcome.notes).startsWith("act-unknown:"), `never no-effect: got ${JSON.stringify(outcome.notes)}`);
  assert.ok((outcome.evidenceRefs as string[]).some((e) => e.startsWith("close:")),
    `expected a close: evidence tag, got ${JSON.stringify(outcome.evidenceRefs)}`);
});

test("P12 C3-F4 unreadable head on CAS rejection → act-unknown (never head-unmoved/no-effect)", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  const dir = mkdtempSync(join(tmpdir(), "tre-p12-shim-noref-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" });
  const real = (probe.stdout ?? "").trim();
  const marker = join(dir, "ARMED");
  // CAS is CLEANLY rejected (exit 1, nothing written); the verify re-read
  // then finds the branch DELETED. "Unchanged from a value we cannot
  // read" is not evidence of no-effect (docs/15 §4 step 7 / docs/16 table).
  const body = [
    "#!/bin/sh", `REAL="${real}"`, `MARKER="${marker}"`, `REPO="${fx.dir}"`,
    'sub=""; for a in "$@"; do case "$a" in update-ref|rev-parse) sub="$a";; esac; done',
    'if [ "$sub" = update-ref ]; then touch "$MARKER"; exit 1; fi',
    'if [ "$sub" = rev-parse ] && [ -f "$MARKER" ] && [ ! -f "$MARKER.done" ]; then',
    '  "$REAL" -C "$REPO" update-ref -d refs/heads/ep1 2>/dev/null; touch "$MARKER.done"',
    "fi",
    '"$REAL" "$@"', "",
  ].join("\n");
  const shim = join(dir, "git");
  writeFileSync(shim, body);
  chmodSync(shim, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${saved}`;
  let r;
  try { r = await integrateTestedCandidate(req(fx, { now: 1700000888021 }), ports(j)); } finally { process.env.PATH = saved; }
  assert.equal(r.status, "failed", `head unreadable at verify is never no-effect: ${r.stage}:${r.reason}`);
  assert.equal(r.stage, "verify");
  assert.equal(r.reason, "advance-unverified");
  assert.ok(String((j.records[1] as Record<string, unknown>).notes).startsWith("act-unknown:"));
});

test("P12 C3-F6 gate timeout: env clamps to the 1s floor (valid tiny value is honored, not defaulted)", async (t) => {
  const fx = makeRepo(t);
  const saved = process.env.TRE_P12_GATE_TIMEOUT_MS;
  process.env.TRE_P12_GATE_TIMEOUT_MS = "1"; // valid positive → clamps UP to 1000ms
  t.after(() => { if (saved === undefined) delete process.env.TRE_P12_GATE_TIMEOUT_MS; else process.env.TRE_P12_GATE_TIMEOUT_MS = saved; });
  const slowGate: IntegrationPorts["gate"] = {
    run: async (r2) => { await new Promise((res) => setTimeout(res, 1500)); return { pass: true, runId: "g1", sha: r2.candidateSha }; },
  };
  const t0 = Date.now();
  const r = await integrateTestedCandidate(req(fx, { now: 1700000888030 }), ports(memJournal(), slowGate));
  const dt = Date.now() - t0;
  assert.equal(r.status, "gate-failed");
  assert.equal(r.reason, "gate-timeout");
  assert.ok(dt >= 900 && dt < 3000, `floor is 1s: fired after ${dt}ms (old bug: 600s default or raw 1ms)`);
});

test("P12 C3-F7 timeout identity: an adapter throwing gate-timeout TEXT is gate-threw, not the deadline", async (t) => {
  const fx = makeRepo(t);
  const textThrower: IntegrationPorts["gate"] = {
    run: async () => { throw new Error("gate-timeout: upstream monitor gave up (NOT our deadline)"); },
  };
  const r = await integrateTestedCandidate(req(fx, { now: 1700000888031 }), ports(memJournal(), textThrower));
  assert.equal(r.status, "gate-failed");
  assert.equal(r.reason, "gate-threw:Error",
    "message text must not impersonate the sentinel deadline: " + r.reason);
});

test("P12 C3-F5 dedup identity: trailing-slash repoRoot resolves to the SAME actionId", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  const r1 = await integrateTestedCandidate(req(fx, { now: 1700000888040 }), ports(j));
  assert.equal(r1.status, "merged");
  const r2 = await integrateTestedCandidate(req(fx, { now: 1700000888041, repoRoot: resolve(fx.dir) + "/" }), ports(j));
  assert.equal(r2.status, "refused", `trailing slash is the SAME repo: ${r2.status}:${r2.reason}`);
  assert.equal(r2.reason, "already-executed");
  assert.equal(r2.actionId, r1.actionId, "actionId is spelling-invariant");
});

test("P12 C3-F5 dedup identity: symlinked repoRoot resolves to the SAME actionId", async (t) => {
  const fx = makeRepo(t);
  const j = memJournal();
  const r1 = await integrateTestedCandidate(req(fx, { now: 1700000888042 }), ports(j));
  assert.equal(r1.status, "merged");
  const linkRoot = mkdtempSync(join(tmpdir(), "tre-p12-link-"));
  t.after(() => rmSync(linkRoot, { recursive: true, force: true }));
  const link = join(linkRoot, "repo");
  try { symlinkSync(resolve(fx.dir), link); } catch { return; } // fs without symlink support: nothing to prove
  const again = await integrateTestedCandidate(
    { ...req(fx, { now: 1700000888043 }), repoRoot: link }, ports(j));
  assert.equal(again.status, "refused", `symlink spelling is the SAME repo: ${again.status}:${again.reason}`);
  assert.equal(again.reason, "already-executed");
  assert.equal(again.actionId, r1.actionId);
});

test("P12 C3-F9 case-folded path identity: differently-cased repoRoot is the same repo (darwin)", async (t) => {
  const fx = makeRepo(t);
  const upper = resolve(fx.dir).replace(/\/tre-p12-[^/]+$/, (m) => m.toUpperCase());
  const j = memJournal();
  const r = await integrateTestedCandidate(
    { ...req(fx, { now: 1700000888050 }), repoRoot: upper }, ports(j));
  if (process.platform === "darwin") {
    // APFS case-insensitive: the UPPER spelling IS the repo — it must
    // merge, not fence every legitimate call over a case mismatch.
    assert.equal(r.status, "merged", `case-folded identity on darwin: ${r.stage}:${r.reason}`);
  } else {
    // Case-sensitive fs: the spelled path does not exist → clean refusal.
    assert.equal(r.status, "refused");
    assert.match(r.reason ?? "", /^context:repoRoot/);
  }
  assert.equal(head(fx.dir, "refs/heads/ep1"), j.records.length > 0 ? r.episodeHead : fx.epHead);
});

// ─── cycle-4 audit closures (C4-F1/F2/F3/F4) ─────────────────────────────

test("P12 C4-F1: a sticky acked outcome does NOT strand a late open intent — recovery closes it on observed reality", async (t) => {
  // The F1 interleaving: execution A merges and acks (sticky
  // already-executed). Then a LATE intent for the SAME identity reaches
  // the journal tail (a writer that appended its intent and died before
  // any outcome — §2 step 2: the tail intent is closed ONLY by observed
  // reality). Old code returned already-executed BEFORE the recovery
  // probe, so the tail intent was unclosable forever.
  const fx = makeRepo(t);
  const j = memJournal();
  const r1 = await integrateTestedCandidate(req(fx), ports(j));
  assert.equal(r1.status, "merged");
  const candidate = r1.candidateSha as string;
  // Late writer: appends ONLY an intent for the same identity, then dies.
  await j.append({
    schema: "tre-supervisor/1", kind: "decision-intent", id: `${r1.actionId}#i99`, ts: 1700000999800,
    episodeId: "ep1", taskId: "t1", actionId: r1.actionId, rung: 4, action: "merge",
    expectedEvidence: `candidate:${candidate}`, authority: { grantedBy: "human", sideEffect: "external" },
  } as never);
  assert.doesNotThrow(() => validateSupervisorRecord((j.records[3] ?? {}) as never), "late intent must be real-journal-producible");
  // Same identity re-issued: head still equals the recorded candidate →
  // the tail intent CLOSES (recovered), it is not swallowed by the
  // sticky ack.
  const again = await integrateTestedCandidate(req(fx, { now: 1700000888100 }), ports(j));
  assert.equal(again.status, "recovered", `the tail intent must be closable: ${again.stage}:${again.reason}`);
  assert.ok(again.evidenceRefs.includes("close:head-equals-candidate"));
  const tail = j.records[j.records.length - 1] as Record<string, unknown>;
  assert.equal(tail.kind, "decision-outcome");
  assert.equal(tail.acked, true);
  // AND the sticky terminal still holds afterwards: a THIRD issue with no
  // open intent finds already-executed, and journals nothing further.
  const third = await integrateTestedCandidate(req(fx, { now: 1700000888101 }), ports(j));
  assert.equal(third.status, "refused");
  assert.equal(third.reason, "already-executed");
});

test("P12 C4-F1: sticky act-unknown does not strand an open tail intent either", async (t) => {
  // act-unknown (not-replayable) + open tail intent: the recovery probe
  // is side-effect-free until reality proves closure — when reality
  // proves nothing (head descends from nothing, candidate unrelated),
  // the request still refuses intent-open, journaling nothing.
  const fx = makeRepo(t);
  const j = memJournal();
  const r1 = await integrateTestedCandidate(req(fx), ports(j));
  assert.equal(r1.status, "merged");
  git(fx.dir, ["update-ref", "refs/heads/ep1", fx.epHead]); // undo
  // un-acked act-unknown outcome (sticky not-replayable)
  await j.append({
    schema: "tre-supervisor/1", kind: "decision-outcome", id: `${r1.actionId}#o50`, ts: 1700000999700,
    episodeId: "ep1", taskId: "t1", actionId: r1.actionId, acked: false, progress: "none",
    notes: "act-unknown: advance-unverified", evidenceRefs: [],
  } as never);
  // late open intent at the tail, candidate unrelated to reality
  await j.append({
    schema: "tre-supervisor/1", kind: "decision-intent", id: `${r1.actionId}#i98`, ts: 1700000999800,
    episodeId: "ep1", taskId: "t1", actionId: r1.actionId, rung: 4, action: "merge",
    expectedEvidence: `candidate:${"b".repeat(40)}`, authority: { grantedBy: "human", sideEffect: "external" },
  } as never);
  const before = j.records.length;
  const again = await integrateTestedCandidate(req(fx, { now: 1700000888102 }), ports(j));
  assert.equal(again.status, "refused");
  // With an open tail intent the recovery branch runs first and finds
  // nothing observable → intent-open (NOT the old not-replayable
  // short-circuit); either way NOTHING is journaled and the ref is still
  // untouched.
  assert.equal(again.reason, "intent-open", `open-tail discipline: ${again.reason}`);
  assert.equal(j.records.length, before, "a refusal journals nothing");
  assert.equal(head(fx.dir, "refs/heads/ep1"), fx.epHead);
});

test("P12 C4-F2: the sticky interleaving is producible through the REAL DecisionJournal (no forged schema)", async (t) => {
  // The cycle-3 F1 tests forged outcome records with a fake schema id —
  // a real DecisionJournal.append (and the real P4 validator) would
  // reject them, so the interleaving was never proven reachable. This is
  // the real-journal end-to-end proof: merged (via the real journal), a
  // late no-effect outcome appended THROUGH the real journal, re-issue →
  // already-executed.
  const dirw = mkdtempSync(join(tmpdir(), "tre-p12-c4f2-"));
  t.after(() => rmSync(dirw, { recursive: true, force: true }));
  const fx = makeRepo(t);
  const real = await DecisionJournal.open(join(dirw, "decisions.jsonl"));
  const r1 = await integrateTestedCandidate(req(fx, { now: 1700000888110 }), { journal: real, gate: passGate });
  assert.equal(r1.status, "merged");
  // Late CAS-loser outcome for the SAME identity — through the REAL
  // append path (validate + fsync).
  await real.append({
    schema: "tre-supervisor/1", kind: "decision-outcome", id: `${r1.actionId}#o9`, ts: 1700000999999,
    episodeId: "ep1", taskId: "t1", actionId: r1.actionId, acked: false, progress: "none",
    notes: "no-effect: head-moved", evidenceRefs: [],
  } as never);
  advanceBranch(fx.dir, "agent/ep1/t1", "new task work");
  const again = await integrateTestedCandidate(req(fx, { now: 1700000888111 }), { journal: real, gate: passGate });
  assert.equal(again.status, "refused");
  assert.equal(again.reason, "already-executed", "acked stays sticky across a real-journal interleave");
  assert.equal(head(fx.dir, "refs/heads/ep1"), r1.candidateSha, "the refused replay never merges the new tip");
  const read = await real.read();
  for (const rec of read.records) {
    assert.doesNotThrow(() => validateSupervisorRecord(rec as never), "every on-disk record is validator-clean");
  }
});

test("P12 C4-F3: a BARE repo refuses with its own reason (context:repoRoot-bare), never the non-repo mask", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tre-p12-bare-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bareDir = join(dir, "repo.git");
  git(dir, ["init", "--bare", "-q", "repo.git"]);
  const j = memJournal();
  const r = await integrateTestedCandidate(
    { ...req({ dir }, { now: 1700000888120 }), repoRoot: resolve(bareDir) }, ports(j));
  assert.equal(r.status, "refused");
  assert.equal(r.reason, "context:repoRoot-bare",
    `a bare repo is a legitimate repo shape — the refusal must say so: ${r.reason}`);
  assert.equal(j.records.length, 0, "the refusal journals nothing");
  // Control: a plain non-repo dir keeps the ORIGINAL reason (F3 asked
  // for distinguishability, not a rename).
  const plain = mkdtempSync(join(tmpdir(), "tre-p12-plain-"));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  const r2 = await integrateTestedCandidate(
    { ...req({ dir: plain }, { now: 1700000888121 }), repoRoot: resolve(plain) }, ports(j));
  assert.equal(r2.status, "refused");
  assert.equal(r2.reason, "context:repoRoot-not-a-repo");
  // Third shape (probed): a NON-BARE .git dir ALSO fails --show-toplevel
  // with the work-tree message, but --is-bare-repository answers
  // "false" — the bare probe must not misclassify it as bare.
  const work = mkdtempSync(join(tmpdir(), "tre-p12-gitdir-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  git(work, ["init", "-q"]);
  const r3 = await integrateTestedCandidate(
    { ...req({ dir: work }, { now: 1700000888122 }), repoRoot: resolve(join(work, ".git")) }, ports(j));
  assert.equal(r3.status, "refused");
  assert.equal(r3.reason, "context:repoRoot-not-a-repo",
    `a non-bare .git dir hits the work-tree message but is NOT bare: ${r3.reason}`);
});

test("P12 C4-F4: killed writer (no reported exit) + head reverted to the OLD value → act-unknown close:aba, never no-effect", async (t) => {
  // ABA state: update-ref LANDS the candidate, the writer is killed
  // (137 — no exit git ever reported), and before our re-read an
  // unrelated actor RESETS ep1 back to the exact old value. Head reads
  // unmoved, which is exactly as consistent with "landed then reverted"
  // as with "never wrote" — with the writer's death unreported,
  // nothing-happened is NOT provable. Old code wrote no-effect.
  const fx = makeRepo(t);
  const j = memJournal();
  const dir = mkdtempSync(join(tmpdir(), "tre-p12-shim-aba-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" });
  const real = (probe.stdout ?? "").trim();
  if (!real) throw new Error("no real git on PATH for the shim");
  const marker = join(dir, "ARMED");
  const oldRef = join(dir, "OLDVAL");
  // update-ref refs/heads/ep1 <new> <old>: capture <old>, land, arm, die.
  // First post-arm rev-parse resets ep1 back to <old> (the ABA revert).
  const body = [
    "#!/bin/sh", `REAL="${real}"`, `MARKER="${marker}"`, `OLDREF="${oldRef}"`, `REPO="${fx.dir}"`,
    'sub=""; for a in "$@"; do case "$a" in update-ref|rev-parse) sub="$a";; esac; done',
    // Position-independent old-value capture: the P12 CAS call prepends
    // --no-replace-objects (cycle-3 F1), so fixed $n positions would
    // drift. Ask the REAL git what ep1 holds BEFORE landing.
    'if [ "$sub" = update-ref ]; then "$REAL" -C "$REPO" rev-parse --verify refs/heads/ep1 > "$OLDREF" 2>/dev/null; "$REAL" "$@"; rc=$?; [ $rc -eq 0 ] && touch "$MARKER"; kill -9 $$; fi',
    'if [ "$sub" = rev-parse ] && [ -f "$MARKER" ] && [ ! -f "$MARKER.done" ]; then',
    '  "$REAL" -C "$REPO" update-ref refs/heads/ep1 "$(cat "$OLDREF")" 2>/dev/null; touch "$MARKER.done"',
    "fi",
    '"$REAL" "$@"', "",
  ].join("\n");
  const shim = join(dir, "git");
  writeFileSync(shim, body);
  chmodSync(shim, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${saved}`;
  let r;
  try { r = await integrateTestedCandidate(req(fx, { now: 1700000888130 }), ports(j)); } finally { process.env.PATH = saved; }
  assert.equal(head(fx.dir, "refs/heads/ep1"), fx.epHead, "the revert really put the old value back");
  assert.equal(r.status, "failed", `unreported writer death + ABA head is UNVERIFIABLE: ${r.stage}:${r.reason}`);
  assert.equal(r.stage, "verify");
  assert.equal(r.reason, "advance-unverified");
  assert.equal(r.outcomeDurable, false, "landed-unknown is never claimed durable");
  const outcome = j.records[1] as Record<string, unknown>;
  assert.ok(String(outcome.notes).startsWith("act-unknown:"), `never no-effect: got ${JSON.stringify(outcome.notes)}`);
  assert.ok((outcome.evidenceRefs as string[]).includes("close:aba"),
    `expected the close:aba evidence tag, got ${JSON.stringify(outcome.evidenceRefs)}`);
  // The chained §2 rule: the identity is now sticky not-replayable —
  // recovery is a NEW identity (seq bump), not a same-identity retry.
  const again = await integrateTestedCandidate(req(fx, { now: 1700000888131 }), ports(j));
  assert.equal(again.status, "refused");
  assert.equal(again.reason, "not-replayable");
});
