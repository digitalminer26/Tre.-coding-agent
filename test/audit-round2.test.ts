/**
 * Round-2 audit (`.tre/audit-round2.md`) regression tests — MG-C5-A1 / A2 / A3
 * plus round-2 CYCLE-1 audit fixes — MG-C5-F1 / F2 / F3 / F4.
 *
 *  A1 (HIGH, src/host/supervise.ts): identity conversion was not pinned
 *  for `core.autocrlf`. A repo carrying `core.autocrlf=true` (set BEFORE
 *  the gate snapshot — so the layout digest never moves) made a gate that
 *  rewrote tracked files to CRLF read CLEAN under the converting status:
 *  the host accepted/integrated while the committed blob stayed LF. Fix:
 *  `PINNED_NEUTRALIZING_CONFIG` (core.autocrlf=false + eol/safecrlf/
 *  symlinks/ident) rides EVERY filterNeutralizeArgs consumer, so both
 *  materialization and both status scans compare RAW bytes; a MID-GATE
 *  flip is additionally caught by the effective-config layer of the
 *  layout digest (git-layout-drift-post-gate).
 *
 *  A2 (HIGH, src/host/supervise.ts): interpretation symlinks bound only
 *  the LINK TEXT, not the consumed target bytes. Fix: a digested symlink
 *  is fingerprinted THROUGH its resolved target (realpath): target bytes
 *  + link text + resolved path; unresolvable/unreadable is its own
 *  fail-closed marker.
 *
 *  F1 (HIGH, round-2 cycle-1 audit): A2's fingerprint detects target
 *  CHANGES but not a conversion rule PRE-SEEDED before the episode —
 *  an unchanged `info/attributes` passes the digest while EVERY
 *  observation (materialization AND both status scans) applies the same
 *  `text eol=crlf` rule (info/attributes outranks GIT_ATTR_SOURCE), so
 *  CRLF worktree bytes sailed through accepted-finish/integrated. Fix:
 *  `attributesObservable` requires the highest-precedence attribute
 *  source to be EMPTY/ABSENT before the candidate worktree is even
 *  added (detail `attributes-source-not-empty-pre-gate`; observeIdentity
 *  fails closed the same way). Covered below for BOTH the regular-file
 *  and the symlink-backed pre-seeded rule.
 *
 *  F2 (MED, round-2 cycle-1 audit): the old A1b flipped autocrlf with
 *  `git config`, which mutates the already-digested common config FILE —
 *  the plain content digest caught the drift even with the effective-
 *  config binding REMOVED (mutation-tested), so it never tested the
 *  layer it claimed. New shape: autocrlf lives in an `include.path`
 *  external file; the gate rewrites ONLY that file (the repo config is
 *  byte-identical across the run — asserted), and only the EFFECTIVE-
 *  value binding (`git config --get-all core.autocrlf` folded into the
 *  layout digest) can catch it. Removing core.autocrlf from effKeys
 *  makes this test fail (verified by mutation).
 *
 *  A3 + F3 (MED, src/host/supervise.ts): the act-unknown recovery hint
 *  was computed BEFORE the held seq-high-water was folded in, advising
 *  a bump the same journal then refused again. Fix: the advice is
 *  emitted AFTER the final derivation as max(executionSeq, seq of each
 *  act-unknown terminal) + 1. Round-2 cycle-1 F3 additions: (a) the
 *  end-to-end test now CONSUMES the parsed advice from the first
 *  (refused) activation instead of hard-coding 8, and asserts the
 *  refusal is P12's `not-replayable` for the seeded identity; (b) a
 *  terminal-above-high-water case with MULTIPLE act-unknown terminals
 *  (seqs 5 and 12, high-water 3) proves the advice exceeds the LARGEST
 *  terminal sequence (13), not just the held high-water — removing the
 *  terminal-seq maximum from the derivation makes it fail (mutation-
 *  tested: it would advise 4).
 *
 *  F4 (LOW, round-2 cycle-1 audit): every negative case below now pins
 *  the FULL stop contract — `stopped === "halt"` AND `detail ===
 *  "integration-refused"` — plus the P12/supervisor REASON recorded in
 *  the durable journal (`refused (gate-denied)` for gate-path refusals,
 *  `refused (not-replayable)` for the seeded act-unknown), not just
 *  "not accepted-finish".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, chmod, mkdir, symlink, readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionJournal, validateSupervisorRecord, type EpisodeGraph } from "../src/episode/journal.js";
import { runHostEpisode, attributesObservable, observeIdentity, collectAcceptanceEvidence } from "../src/host/supervise.js";
import { sameArtifact } from "../src/acceptance/evaluator.js";

function git(dir: string, args: string[]): { status: number; out: string } {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 30000 });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`
    .split("\n").filter((l) => !/^warning:/.test(l)).join("\n");
  if ((r.status ?? -1) !== 0) throw new Error(`git ${args.join(" ")} failed: ${out}`);
  return { status: r.status ?? 0, out: out.trim() };
}
const head = (dir: string, ref: string): string => git(dir, ["rev-parse", "--verify", `${ref}^{commit}`]).out;

type Graph = EpisodeGraph;
function baseGraph(episodeId: string, gateCmd: string): Graph {
  return {
    schema: "tre-graph/1",
    episodeId,
    goal: "round-2 audit regression",
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

/** Throwaway repo (host-merge-port.test.ts shape): `ep1` and
 *  `agent/<ep>/t1` diverge cleanly; checked out on a neutral branch.
 *  `afterInit` runs after `git init`+identity config and BEFORE the
 *  first commit, so fixtures (autocrlf, info/attributes symlinks) are
 *  part of the repo's PRE-EXISTING state — the point of A1/A2/F1. */
async function makeRepo(t: { diagnostic: (m: string) => void; after: (fn: () => void) => void }, episodeId: string, afterInit?: (dir: string) => Promise<void>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tre-r2-repo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "ep1", "."]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  if (afterInit) await afterInit(dir);
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

const gateEvidence = async (root: string, episodeId: string): Promise<{ sha?: string; text?: string }[]> => {
  const raw = await readFile(join(root, episodeId, "acceptance", "evidence.jsonl"), "utf8");
  return raw.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { sha?: string; text?: string });
};

/** F4 helper: the durable supervisor outcome notes for this episode —
 *  the P12 refusal reason the closeIntent line recorded verbatim. */
const outcomeNotes = async (root: string, episodeId: string): Promise<string[]> => {
  const journal = await DecisionJournal.forEpisode(join(root, episodeId));
  const { records } = await journal.read();
  return (records as { kind?: string; notes?: unknown }[])
    .filter((r) => r.kind === "decision-outcome")
    .map((r) => String(r.notes ?? ""));
};

/** F4: the FULL stop contract of a refused integration (round-2
 *  cycle-1 audit F4): halted, integration-refused, and the P12/supervisor
 *  reason recorded in the durable journal. NOTE (F4 audit trail): the
 *  P12 `reason` for a denied gate is coarse — `gate-denied` (or
 *  `gate-timeout`/`gate-sha-mismatch`) — and does NOT carry the gate
 *  adapter's `detail` (e.g. `attributes-source-not-empty-pre-gate`);
 *  merge.ts folds the detail only into the intent `rationale`, and a
 *  PRE-GATE denial never reaches the intent stage at all. So F1a/F1b
 *  pin `gate-denied` like A1, and distinguish the pre-gate path with a
 *  guardrail assertion (no `merge-gate ` evidence row was ever written). */
async function assertRefusedStop(t: { diagnostic: (m: string) => void }, root: string, episodeId: string, res: { result: { stopped: string; detail?: string } }, reason: string): Promise<void> {
  assert.equal(res.result.stopped, "halt", `refusal must HALT the episode (got ${res.result.stopped}; detail=${res.result.detail ?? ""})`);
  assert.equal(res.result.detail, "integration-refused", `refusal detail must be integration-refused (got ${res.result.detail ?? ""})`);
  const notes = await outcomeNotes(root, episodeId);
  assert.ok(notes.some((n) => n.includes(`integration merge refused (${reason})`)),
    `durable journal must record the refusal reason '${reason}', got ${JSON.stringify(notes.map((n) => n.slice(0, 120)))}`);
  t.diagnostic(`refused stop contract pinned: halt / integration-refused / (${reason})`);
}

/** F1 (audit follow-up): the contract for an attribute rule seeded before
 *  the episode is FAIL-CLOSED, not a specific layer. Measured: in this
 *  fixture the identity layer (unobservable -> unique digest) makes the
 *  acceptance verdict `uncertain`, so the episode escalates and never
 *  reaches the merge; the pre-gate check is a defense-in-depth layer that
 *  this fixture cannot isolate (disabling it leaves the outcome unchanged).
 *  So the assertion is the OUTCOME, not which check fired: never accepted,
 *  never integrated. The leftover-directory check is still exact. */
function assertPreGateNonMerge(t: { diagnostic: (m: string) => void }, res: { result: { stopped: string; detail?: string } }, episodeId: string): void {
  assert.notEqual(res.result.stopped, "accepted-finish", "the pre-gate refusal must never accept/integrate");
  assert.notEqual(res.result.detail, "integrated", "the pre-gate refusal must never report integrated");
  t.diagnostic(`pre-gate non-merge pinned for ${episodeId}: ${res.result.stopped} / ${res.result.detail ?? ""}`);
}

// ─── A1: core.autocrlf is pinned on every observed git call ───────────────

test("round-2 A1: a repo with pre-set core.autocrlf=true cannot mask gate-written CRLF bytes — the raw-comparing chain fails the gate CLOSED", async (t) => {
  // PRE-EXISTING config (before the gate snapshot): the layout digest
  // binds it identically pre AND post gate, so the ONLY defense is the
  // unconditional core.autocrlf=false pin on materialization + status.
  const repo = await makeRepo(t, "ep-r2-a1", async (d) => { git(d, ["config", "core.autocrlf", "true"]); });
  const root = await mkdtemp(join(tmpdir(), "tre-r2-a1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);
  const preHead = head(repo, "refs/heads/ep1");

  // The gate rewrites tracked bytes to CRLF — under a CONVERTING status
  // (the pre-fix observation) that reads CLEAN against the LF blob.
  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-r2-a1", "if [ -f .git ]; then printf 'base\\r\\n' > base.txt; fi; exit 0"),
    taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { t.diagnostic(l); },
  });

  // F4: full stop contract, and the refusal reason from the durable journal.
  await assertRefusedStop(t, root, "ep-r2-a1", res, "gate-denied");
  const evidence = await gateEvidence(root, "ep-r2-a1");
  const m = evidence.filter((e) => /merge-gate/.test(e.text ?? "") && /tracked-mutation-post-gate/.test(e.text ?? ""));
  assert.ok(m.length >= 1, `expected tracked-mutation-post-gate under the raw-comparison pin, got ${JSON.stringify(evidence.map((e) => e.text?.slice(0, 160)))}`);
  assert.equal(head(repo, "refs/heads/ep1"), preHead, "the episode branch stands at the pre-run head");
});

test("round-2 A1b (F2): a gate flipping core.autocrlf through an include.path (repo config byte-identical) fails CLOSED via the EFFECTIVE-config layer of the layout digest", async (t) => {
  // F2 (round-2 cycle-1 audit): the old fixture wrote the flip with
  // `git config core.autocrlf true`, which MUTATES the already-digested
  // common config file — the plain content digest caught the drift with
  // the effective-value binding REMOVED (mutation-verified), so the
  // test never exercised the layer it claimed. Here autocrlf lives in
  // an EXTERNAL include file: the gate rewrites only that file, the
  // repo's own config bytes never change (asserted below), and the ONLY
  // defense that can move the digest is the effective-config binding
  // (`git config --get-all core.autocrlf` folded into gitLayoutDigest).
  const ext = await mkdtemp(join(tmpdir(), "tre-r2-a1b-ext-"));
  t.after(() => rm(ext, { recursive: true, force: true }));
  const extFile = join(ext, "autocrlf.cfg");
  await writeFile(extFile, "[core]\n\tautocrlf = false\n");
  const repo = await makeRepo(t, "ep-r2-a1b", async (d) => {
    git(d, ["config", "include.path", extFile]);
  });
  const root = await mkdtemp(join(tmpdir(), "tre-r2-a1b-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);
  const preHead = head(repo, "refs/heads/ep1");
  const preConfig = await readFile(join(repo, ".git", "config"));

  // NO content change at all — the external-config flip alone is the
  // attack surface (a converted post-gate status would read any future
  // CRLF rewrite clean).
  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-r2-a1b", `if [ -f .git ]; then printf '[core]\\n\\tautocrlf = true\\n' > ${extFile}; fi; exit 0`),
    taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { t.diagnostic(l); },
  });

  await assertRefusedStop(t, root, "ep-r2-a1b", res, "gate-denied");
  const evidence = await gateEvidence(root, "ep-r2-a1b");
  const m = evidence.filter((e) => /merge-gate/.test(e.text ?? "") && /git-layout-drift-post-gate/.test(e.text ?? ""));
  assert.ok(m.length >= 1, `expected git-layout-drift-post-gate from the EFFECTIVE-config binding, got ${JSON.stringify(evidence.map((e) => e.text?.slice(0, 160)))}`);
  // F2 isolation: every DIGESTED repo file stayed byte-identical — the
  // drift the digest saw could ONLY have come from the effective layer.
  const postConfig = await readFile(join(repo, ".git", "config"));
  assert.ok(postConfig.equals(preConfig), "the repo's own config bytes must be unchanged — only the external include flipped, so ONLY the effective-config binding can catch this");
  assert.equal(head(repo, "refs/heads/ep1"), preHead, "the episode branch stands at the pre-run head");
});

// ─── A2: interpretation symlinks are fingerprinted THROUGH the target ─────

test("round-2 A2: an existing .git/info/attributes SYMLINK whose external target the gate rewrites (text eol=crlf) fails CLOSED — the consumed bytes move the digest", async (t) => {
  // The link text NEVER changes (so a text-only fingerprint stays put)
  // and info/attributes OVERRIDES GIT_ATTR_SOURCE (so the raw-comparison
  // pin alone is bypassed): the only defense is hashing the CONSUMED
  // target bytes, which the gate mutates to `base.txt text eol=crlf`
  // right before writing CRLF working bytes. The target is EMPTY at
  // snapshot time so the F1 pre-gate emptiness check passes — this test
  // is specifically about the MID-GATE rewrite.
  const ext = await mkdtemp(join(tmpdir(), "tre-r2-a2-ext-"));
  t.after(() => rm(ext, { recursive: true, force: true }));
  const extFile = join(ext, "attrs");
  await writeFile(extFile, ""); // empty at snapshot time
  const repo = await makeRepo(t, "ep-r2-a2", async (d) => {
    await mkdir(join(d, ".git", "info"), { recursive: true });
    await symlink(extFile, join(d, ".git", "info", "attributes"));
  });
  const root = await mkdtemp(join(tmpdir(), "tre-r2-a2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);
  const preHead = head(repo, "refs/heads/ep1");

  const gateCmd = `if [ -f .git ]; then printf 'base.txt text eol=crlf\\n' > ${extFile}; printf 'base\\r\\n' > base.txt; fi; exit 0`;
  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-r2-a2", gateCmd),
    taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { t.diagnostic(l); },
  });

  await assertRefusedStop(t, root, "ep-r2-a2", res, "gate-denied");
  const evidence = await gateEvidence(root, "ep-r2-a2");
  const m = evidence.filter((e) => /merge-gate/.test(e.text ?? "") && /git-layout-drift-post-gate/.test(e.text ?? ""));
  assert.ok(m.length >= 1, `expected git-layout-drift-post-gate from the consumed-target fingerprint, got ${JSON.stringify(evidence.map((e) => e.text?.slice(0, 160)))}`);
  assert.equal(head(repo, "refs/heads/ep1"), preHead, "the episode branch stands at the pre-run head");
});

// ─── F1: a PRE-EXISTING (never-changing) info/attributes conversion rule ─

test("round-2 F1a: a regular-file .git/info/attributes seeded BEFORE the episode with 'base.txt text eol=crlf' is refused pre-gate — no candidate certification under an active highest-precedence rule", async (t) => {
  // The round-2 cycle-1 repro: the rule predates every digest and NEVER
  // changes, so the layout digest is silent; materialization AND both
  // status scans apply the SAME rule, so gate-written CRLF bytes read
  // CLEAN against the LF blob (accepted-finish/integrated pre-fix —
  // the CRLF mask). GIT_ATTR_SOURCE cannot outrank info/attributes and
  // no -c pin re-ranks the source list, so the only honest close is to
  // refuse certification while that source carries any effective rule.
  const repo = await makeRepo(t, "ep-r2-f1a", async (d) => {
    await mkdir(join(d, ".git", "info"), { recursive: true });
    await writeFile(join(d, ".git", "info", "attributes"), "base.txt text eol=crlf\n");
  });
  const root = await mkdtemp(join(tmpdir(), "tre-r2-f1a-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);
  const preHead = head(repo, "refs/heads/ep1");

  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-r2-f1a", "if [ -f .git ]; then printf 'base\\r\\n' > base.txt; fi; exit 0"),
    taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { t.diagnostic(l); },
  });

  assertPreGateNonMerge(t, res, "ep-r2-f1a");
  // The refusal is PRE-GATE: no integration-gate evidence row may exist
  // at all — the gate command was never run against a candidate whose
  // certification would be unsound (vs A1, where the gate RAN and the
  // post-gate re-observation caught the mutation).
  const evidence = await gateEvidence(root, "ep-r2-f1a");
  assert.ok(!evidence.some((e) => (e.text ?? "").startsWith("merge-gate ")),
    `pre-gate refusal must NOT run the integration gate, got ${JSON.stringify(evidence.map((e) => (e.text ?? "").slice(0, 100)))}`);
  // F3 (audit follow-up): the refusal happens BEFORE allocation — no
  // merge-gate directory is left behind at all.
  const gateParent = join(root, "ep-r2-f1a", "merge-gate");
  const leftovers = await readdir(gateParent).catch(() => [] as string[]);
  assert.deepEqual(leftovers, [], `a pre-gate refusal must not allocate a gate dir, found ${JSON.stringify(leftovers)}`);
  // The rule file survives untouched (fail-closed refuses, never "fixes").
  assert.equal(await readFile(join(repo, ".git", "info", "attributes"), "utf8"), "base.txt text eol=crlf\n");
  assert.equal(head(repo, "refs/heads/ep1"), preHead, "the episode branch stands at the pre-run head");
});

test("round-2 F1b: a symlink-backed .git/info/attributes PRE-SEEDED with the rule (never touched during the episode) is likewise refused pre-gate", async (t) => {
  // Same attack through the symlink indirection: nothing changes during
  // the episode at all, so the A2 mid-gate fingerprint is irrelevant —
  // the emptiness requirement is the defense.
  const ext = await mkdtemp(join(tmpdir(), "tre-r2-f1b-ext-"));
  t.after(() => rm(ext, { recursive: true, force: true }));
  const extFile = join(ext, "attrs");
  await writeFile(extFile, "base.txt text eol=crlf\n");
  const repo = await makeRepo(t, "ep-r2-f1b", async (d) => {
    await mkdir(join(d, ".git", "info"), { recursive: true });
    await symlink(extFile, join(d, ".git", "info", "attributes"));
  });
  const root = await mkdtemp(join(tmpdir(), "tre-r2-f1b-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);
  const preHead = head(repo, "refs/heads/ep1");

  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-r2-f1b", "if [ -f .git ]; then printf 'base\\r\\n' > base.txt; fi; exit 0"),
    taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { t.diagnostic(l); },
  });

  assertPreGateNonMerge(t, res, "ep-r2-f1b");
  // Same pre-gate contract through the symlink indirection: the gate
  // command never runs, and the external target is left exactly as the
  // episode found it.
  const evidence = await gateEvidence(root, "ep-r2-f1b");
  assert.ok(!evidence.some((e) => (e.text ?? "").startsWith("merge-gate ")),
    `pre-gate refusal must NOT run the integration gate, got ${JSON.stringify(evidence.map((e) => (e.text ?? "").slice(0, 100)))}`);
  assert.equal(await readFile(extFile, "utf8"), "base.txt text eol=crlf\n", "the refused episode leaves the attributes target untouched");
  assert.equal(head(repo, "refs/heads/ep1"), preHead, "the episode branch stands at the pre-run head");
});

test("round-2 F1c (unit): attributesObservable — absent/empty/comment-only are observable; any effective rule, unreadable or dangling symlink is NOT", async (t) => {
  const repo = await makeRepo(t, "ep-r2-f1c");
  const attr = join(repo, ".git", "info", "attributes");
  const info = join(repo, ".git", "info");

  assert.equal(await attributesObservable(repo), true, "absent is empty is observable");

  await mkdir(info, { recursive: true });
  await writeFile(attr, "");
  assert.equal(await attributesObservable(repo), true, "empty file is observable");

  await writeFile(attr, "# only a comment\n\n   \n");
  assert.equal(await attributesObservable(repo), true, "comment/whitespace-only carries no effective rule");

  await writeFile(attr, "base.txt text eol=crlf\n");
  assert.equal(await attributesObservable(repo), false, "an effective conversion rule is NOT observable");

  await rm(attr);
  const ext = await mkdtemp(join(tmpdir(), "tre-r2-f1c-ext-"));
  t.after(() => rm(ext, { recursive: true, force: true }));
  await symlink(join(ext, "attrs"), attr); // DANGLING: link text is not empty-rule-observable
  assert.equal(await attributesObservable(repo), false, "a dangling symlink is not observable (fail closed)");

  const extFile = join(ext, "attrs");
  await writeFile(extFile, "*.txt text\n");
  assert.equal(await attributesObservable(repo), false, "symlink through an external file WITH a rule is not observable");

  await writeFile(extFile, "#nothing\n");
  assert.equal(await attributesObservable(repo), true, "symlink to an effectively-empty file is observable");
});

// ─── A3: the act-unknown bump hint is emitted AFTER the final derivation ─

/** Mirror of merge.ts's actionId derivation (drift-pinned: canonical +
 *  idDigest + the realpath'd repoRoot, audit C3-F5 identity) so a test
 *  can seed a REAL act-unknown terminal at a chosen seq. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}
function p12ActionId(repo: string, episodeId: string, taskId: string, episodeBranch: string, seq: number): string {
  const s = canonical({ repoRoot: realpathSync(repo), episodeId, taskId, episodeBranch, seq });
  return `a-${taskId}-merge-${createHash("sha256").update(s).digest("hex").slice(0, 16)}`;
}

/** Append a REAL act-unknown terminal (unacked, no `no-effect:` prefix,
 *  carrying the exact P12 identity `a-t1-merge-<16hex>#o<seq>`) to the
 *  episode journal. */
async function appendActUnknown(root: string, episodeId: string, repo: string, seq: number): Promise<string> {
  const actionId = p12ActionId(repo, episodeId, "t1", "ep1", seq);
  const epDir = join(root, episodeId);
  await mkdir(join(epDir, "events"), { recursive: true });
  const terminal = {
    schema: "tre-supervisor/1", id: `${actionId}#o${seq}`, ts: 1700000111000 + seq,
    episodeId, taskId: "t1", kind: "decision-outcome",
    actionId, acked: false, progress: "none",
    notes: "act-unknown: advance-unverified (reference transaction contradicted by re-read)",
  };
  validateSupervisorRecord(terminal as never); // the seed must be P4-valid
  await appendLine(join(epDir, "events", "decisions.jsonl"), terminal);
  return actionId;
}
async function appendSeqHighWater(root: string, episodeId: string, seq: number): Promise<void> {
  const epDir = join(root, episodeId);
  await mkdir(join(epDir, "events"), { recursive: true });
  const hw = {
    schema: "tre-supervisor/1", id: `seqhw-${episodeId}-t1-${seq}`, ts: 1700000100000 + seq,
    episodeId, taskId: "t1", kind: "seq-high-water", seq,
  };
  validateSupervisorRecord(hw as never);
  await appendLine(join(epDir, "events", "decisions.jsonl"), hw);
}
async function appendLine(path: string, obj: unknown): Promise<void> {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(path, JSON.stringify(obj) + "\n");
}

/** Seed act-unknown@7 + high-water7 — the state the round-2 A3 repro left. */
async function seedActUnknownAtSeq7(root: string, episodeId: string, repo: string): Promise<string> {
  await appendSeqHighWater(root, episodeId, 7);
  return appendActUnknown(root, episodeId, repo, 7);
}

test("round-2 A3: seeded act-unknown@seq7 + high-water7 — the disclosure must advise a bump that EXCEEDS the held seq (8), not the pre-derivation count (1)", async (t) => {
  const repo = await makeRepo(t, "ep-r2-a3a");
  const root = await mkdtemp(join(tmpdir(), "tre-r2-a3a-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);
  const seededActionId = await seedActUnknownAtSeq7(root, "ep-r2-a3a", repo);
  const preHead = head(repo, "refs/heads/ep1");

  const lines: string[] = [];
  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-r2-a3a", "test -f base.txt"),
    taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { lines.push(l); t.diagnostic(l); },
  });

  // The held high-water re-derives seq 7; P12 honestly refuses the
  // seeded act-unknown identity → the merge is refused. F4: full stop
  // contract + the P12 dedup reason `not-replayable` in the journal.
  await assertRefusedStop(t, root, "ep-r2-a3a", res, "not-replayable");
  assert.equal(head(repo, "refs/heads/ep1"), preHead, "the episode branch stands at the pre-run head");

  const hint = lines.find((l) => l.startsWith("integration-act-unknown"));
  assert.ok(hint, `expected the act-unknown disclosure, got ${JSON.stringify(lines)}`);
  assert.ok(hint.includes("--integration-seq-bump 8"),
    `the remedy must EXCEED the held/derived seq 7 (advise bump 8); following the old pre-derivation hint (bump 1) re-derived seq 7 and P12 refused AGAIN — got: ${hint}`);
  assert.ok(!/--integration-seq-bump [0-7](\D|$)/.test(hint),
    `any advice at or below the held seq 7 reproduces the refusal loop — got: ${hint}`);
});

test("round-2 F3: act-unknown terminals ABOVE the held high-water (seqs 5 and 12, high-water 3) — the advice must exceed the LARGEST terminal sequence (13)", async (t) => {
  // Round-2 cycle-1 audit F3: both old fixtures put the terminal AT the
  // high-water, so executionSeq already supplied the maximum and the
  // terminal-seq maximum was never exercised (removing it left the
  // tests green). Here the derivation must fold in the terminals' OWN
  // sequences: max(bump 0, held high-water 3, terminals 5 and 12) + 1
  // = 13. Drop the terminal-maximum from the derivation and the advice
  // collapses to 4 (verified by mutation against the compiled module).
  const repo = await makeRepo(t, "ep-r2-f3");
  const root = await mkdtemp(join(tmpdir(), "tre-r2-f3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);
  await appendSeqHighWater(root, "ep-r2-f3", 3);
  await appendActUnknown(root, "ep-r2-f3", repo, 5);
  await appendActUnknown(root, "ep-r2-f3", repo, 12);

  const lines: string[] = [];
  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-r2-f3", "test -f base.txt"),
    taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { lines.push(l); t.diagnostic(l); },
  });

  // The fresh activation allocates a NEW identity (seq 3 held, the
  // terminals live at 5/12 — different identities) and integrates for
  // real; the CONTRACT here is that the disclosure names a bump that
  // exceeds the largest stranded sequence.
  // (seq 3 is a never-used identity, so the fresh activation MAY
  // integrate for real — the contract under test is the DISCLOSURE:
  // when act-unknown terminals exist, the named remedy must clear them
  // all.)
  const hint = lines.find((l) => l.startsWith("integration-act-unknown"));
  assert.ok(hint, `expected the act-unknown disclosure, got ${JSON.stringify(lines)}`);
  assert.ok(hint.includes("--integration-seq-bump 13"),
    `advice must EXCEED the largest terminal sequence (12) — expected bump 13, got: ${hint}`);
  assert.ok(!/--integration-seq-bump (?:[0-9]|1[0-2])(\D|$)/.test(hint),
    `any advice at or below the largest stranded terminal 12 reproduces the refusal loop — got: ${hint}`);
});

test("round-2 A3 end-to-end (F3): a real refused activation, then a restart at the PARSED advised seq, clears the seeded act-unknown and integrates (#o8 acked)", async (t) => {
  // Round-2 cycle-1 audit F3: the old fixture seeded a SECOND episode
  // and passed a literal `integrationSeqBump: 8` — it never consumed
  // the first activation's recommendation. One root, two sequential
  // activations (the lease releases between them — verified by probe):
  // run 1 refuses not-replayable and DISCLOSES the remedy; the parsed
  // number drives the restart; run 2 integrates with an ACKED terminal
  // allocated at the advised seq.
  const repo = await makeRepo(t, "ep-r2-a3b");
  const root = await mkdtemp(join(tmpdir(), "tre-r2-a3b-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);
  const seededActionId = await seedActUnknownAtSeq7(root, "ep-r2-a3b", repo);
  const preHead = head(repo, "refs/heads/ep1");

  // ── run 1: honest refusal of the seeded identity + the disclosure ──
  const lines1: string[] = [];
  const res1 = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-r2-a3b", "test -f base.txt"),
    taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { lines1.push(l); t.diagnostic(l); },
  });
  await assertRefusedStop(t, root, "ep-r2-a3b", res1, "not-replayable");
  assert.equal(head(repo, "refs/heads/ep1"), preHead, "run 1 changed nothing on the episode branch");

  const hint = lines1.find((l) => l.startsWith("integration-act-unknown"));
  assert.ok(hint, "run 1 must disclose the act-unknown remedy");
  const parsed = /--integration-seq-bump (\d+)/.exec(hint);
  assert.ok(parsed !== null && parsed[1] !== undefined, `the disclosure must carry a parseable bump, got: ${hint}`);
  const advised = Number(parsed[1]);
  assert.ok(Number.isSafeInteger(advised) && advised > 7, `the parsed advice must exceed the stranded seq 7 (got ${advised})`);

  // ── run 2: restart with the PARSED advice ───────────────────────────
  const lines2: string[] = [];
  const res2 = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-r2-a3b", "test -f base.txt"),
    taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    integrationSeqBump: advised,
    maxIterations: 1,
    log: (l) => { lines2.push(l); t.diagnostic(l); },
  });

  assert.equal(res2.result.stopped, "accepted-finish", `the advised bump (${advised}) must clear the seeded terminal (${res2.result.stopped}; detail=${res2.result.detail ?? ""})`);
  assert.notEqual(head(repo, "refs/heads/ep1"), preHead, "the episode branch advanced — the merge ran");

  const journal = await DecisionJournal.forEpisode(join(root, "ep-r2-a3b"));
  const { records } = await journal.read();
  const recs = records as { kind?: string; id?: string; actionId?: string; acked?: boolean }[];
  // The seeded identity is STILL unacked (never silently rewritten)…
  assert.ok(recs.some((r) => r.id === `${seededActionId}#o7` && r.acked === false),
    "the seeded act-unknown terminal must remain as seeded (never retro-acked)");
  // …and the NEW identity at the advised seq executed for real.
  const merged = recs.find((r) => r.kind === "decision-outcome" && typeof r.id === "string" && new RegExp(`^a-t1-merge-[0-9a-f]{16}#o${advised}$`).test(r.id) && r.acked === true);
  assert.ok(merged, `expected an ACKED P12 terminal allocated at the advised seq ${advised}, got ${JSON.stringify(recs.map((r) => String(r.id)))}`);
});

// ─── F1 (audit follow-up): NBSP-prefixed rule is NOT an empty source ──────

test("round-2 follow-up F1: an info/attributes line '\\u00a0# text eol=crlf' (Git applies it to the path '\\u00a0#') is refused pre-gate — never integrated", async (t) => {
  // The previous emptiness check stripped `#…` anywhere and used JS \s
  // (which includes NBSP): this line looked empty, Git still applied the
  // rule to the NBSP-named path, and the CRLF write integrated (repro
  // .tre/review-probes/audit-unicode-rule.mjs). The conservative parser
  // only ignores blank lines and lines whose FIRST char is '#'.
  const repo = await makeRepo(t, "ep-r2-f1u", async (d) => {
    await mkdir(join(d, ".git", "info"), { recursive: true });
    await writeFile(join(d, ".git", "info", "attributes"), "\u00a0# text eol=crlf\n");
    await writeFile(join(d, "\u00a0#"), "base\n");
    git(d, ["add", "-A"]);
    git(d, ["commit", "-q", "-m", "nbsp file"]);
  });
  const root = await mkdtemp(join(tmpdir(), "tre-r2-f1u-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);
  const preHead = head(repo, "refs/heads/ep1");

  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-r2-f1u", "if [ -f .git ]; then printf 'base\\r\\n' > '\u00a0#'; fi; exit 0"),
    taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo, episodeBranch: "ep1",
    maxIterations: 1,
    log: (l) => { t.diagnostic(l); },
  });

  assertPreGateNonMerge(t, res, "ep-r2-f1u");
  assert.equal(head(repo, "refs/heads/ep1"), preHead, "the episode branch stands at the pre-run head");
  const merged = spawnSync("git", ["show", "ep1:\u00a0#"], { cwd: repo, encoding: "utf8" }).stdout;
  assert.equal(merged, "base\n", "the merged blob must not have been integrated with CRLF bytes");
});

test("round-2 follow-up F1 (unit): Git-compatible emptiness — blank and first-char '#' lines only; NBSP-prefixed or indented rules are NOT observable", async (t) => {
  const repo = await makeRepo(t, "ep-r2-f1unit");
  const attr = join(repo, ".git", "info", "attributes");
  await mkdir(join(repo, ".git", "info"), { recursive: true });
  await writeFile(attr, "# comment\n\n   \n");
  assert.equal(await attributesObservable(repo), true, "comments and blank lines are observable-empty");
  await writeFile(attr, "\u00a0# text eol=crlf\n");
  assert.equal(await attributesObservable(repo), false, "NBSP before # is a real rule to git, not a comment");
  await writeFile(attr, "  base.txt text\n");
  assert.equal(await attributesObservable(repo), false, "an indented rule is not observable-empty");
  await writeFile(attr, "base.txt text # trailing\n");
  assert.equal(await attributesObservable(repo), false, "a trailing # does not make a rule a comment");
});

// ─── F2 (audit follow-up): unobservable identities are never comparable ─

test("round-2 follow-up F2: observeIdentity on an unobservable tree yields a fresh digest each call — two observations of the same tree never compare equal", async (t) => {
  const repo = await makeRepo(t, "ep-r2-f2");
  await mkdir(join(repo, ".git", "info"), { recursive: true });
  await writeFile(join(repo, ".git", "info", "attributes"), "base.txt text eol=crlf\n");
  const sha = head(repo, "refs/heads/ep1");

  const a = await observeIdentity(repo, sha);
  const b = await observeIdentity(repo, sha);
  assert.equal(a.dirty, true, "an unobservable tree is dirty-unknown");
  assert.notEqual(a.dirtyDigest, b.dirtyDigest, "a constant digest would let two unobservable observations compare EQUAL");
  assert.equal(sameArtifact(a, b), false, "an unobservable identity must never be the same artifact as another observation");
});

test("round-2 follow-up F2 (end-to-end): under an unobservable identity a gate FORGING worktree bytes never earns a complete acceptance verdict — the run is never accepted", async (t) => {
  // The repro (.tre/review-probes/audit-unknown-identity.mjs): a plain
  // pre-seeded info/attributes rule makes every observation dirty-
  // UNKNOWN; the old constant failure digest made pre- and post-gate
  // observations compare EQUAL, so a gate overwriting base.txt with
  // forged content still produced `accepted-finish` with a COMPLETE
  // acceptance verdict. With non-comparable identities the post-gate
  // observation can never match the current one: the evidence is
  // missing, not certified — the loop must not finish accepted.
  const repo = await makeRepo(t, "ep-r2-f2e2e", async (d) => {
    await mkdir(join(d, ".git", "info"), { recursive: true });
    await writeFile(join(d, ".git", "info", "attributes"), "base.txt text eol=crlf\n");
  });
  const root = await mkdtemp(join(tmpdir(), "tre-r2-f2e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);

  const res = await runHostEpisode({
    episodesRoot: root, graph: baseGraph("ep-r2-f2e2e", "printf 'FORGED\\n' > base.txt; exit 0"),
    taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo,
    maxIterations: 1,
    log: (l) => { t.diagnostic(l); },
  });

  assert.notEqual(res.result.stopped, "accepted-finish", `an unobservable tree must never accept (got ${res.result.stopped}; detail=${res.result.detail ?? ""})`);
  assert.notEqual(res.result.detail, "integrated", "the forge must never integrate");
  // And the acceptance record that DID run must be UNCERTAIN with the
  // missing-evidence entries — never `complete`.
  const journal = await DecisionJournal.forEpisode(join(root, "ep-r2-f2e2e"));
  const { records } = await journal.read();
  const acc = (records as { kind?: string; verdict?: string; remainingWork?: string[] }[]).filter((r) => r.kind === "acceptance");
  assert.ok(acc.length > 0, "at least one acceptance record must exist");
  assert.ok(acc.every((r) => r.verdict !== "complete"), `no acceptance verdict may be complete under an unobservable identity, got ${JSON.stringify(acc.map((r) => r.verdict))}`);
  assert.ok(acc.every((r) => Array.isArray(r.remainingWork) && r.remainingWork.length > 0),
    "an uncertain verdict under unobservable identity must carry remaining work (missing evidence), never an empty list");
});


// ─── R3-F2 (audit round-3): unobservable identities refuse THEMSELVES ──────

test("round-3 R3-F2: the no-worktree fallback and every fail-closed observation carry unobservable:true and refuse sameArtifact against THEMSELVES", async () => {
  // The nonce (round-2 F2) closed equality ACROSS observations; the hole
  // it left was equality OF one observation: evidence and current minted
  // from the SAME call are reference-equal, so any self-comparison passed.
  // The structural marker closes that. Direct unit shape:
  const UNOBS = { sha: "a".repeat(40), dirty: true as const, unobservable: true as const, dirtyDigest: "x".repeat(64) };
  assert.equal(sameArtifact(UNOBS, UNOBS), false, "self-comparison of an unobservable identity must refuse");
  assert.equal(sameArtifact(UNOBS, { ...UNOBS }), false, "…and a structural copy");
  // The host's no-worktree fallback carries it:
  const root = await mkdtemp(join(tmpdir(), "tre-r3-f2-fb-"));
  try {
    const graph: Graph = {
      schema: "tre-graph/1", episodeId: "ep-r3-fb", goal: "g",
      tasks: [{ id: "t1", persona: "w", promptRef: "p", dependsOn: [], acceptance: { criteria: [], requiredChecks: [], artifacts: [] } }],
      policy: { baseCommit: "abc123" },
    };
    const ev = await collectAcceptanceEvidence({ graph, taskId: "t1", epPath: join(root, "eps") });
    assert.equal(ev.current.unobservable, true, "the fallback is flagged unobservable");
    assert.equal(sameArtifact(ev.current, ev.current), false, "the fallback refuses itself");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("round-3 R3-F2 (end-to-end, the probe shape): empty criteria + ARTIFACT-ONLY acceptance under an unobservable tree never accepts — the pre-seeded info/attributes gate forge must not earn `complete`", async (t) => {
  // .tre/review-probes/audit-nonce-artifact-only.mjs: the exact shape the
  // nonce could NOT close. With criteria:[] and requiredChecks:[], the
  // ONLY evidence is the artifact row — and its identity comes from the
  // same observation as `current`. Reference-equal digests compared
  // equal, the artifact exists with a digest, and the run accepted with
  // verdict `complete` while the gate had just overwritten base.txt with
  // FORGED bytes. The marker makes the artifact row's identity refuse
  // `current`: the artifact never counts as current evidence.
  const repo = await makeRepo(t, "ep-r3-f2e2e", async (d) => {
    await mkdir(join(d, ".git", "info"), { recursive: true });
    await writeFile(join(d, ".git", "info", "attributes"), "base.txt text eol=crlf\n");
  });
  const root = await mkdtemp(join(tmpdir(), "tre-r3-f2e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = await exitZeroWorker(root);
  const graph = baseGraph("ep-r3-f2e2e", "printf 'FORGED\\n' > base.txt; exit 0");
  graph.tasks[0]!.acceptance = { criteria: [], requiredChecks: [], artifacts: ["base.txt"] };

  const res = await runHostEpisode({
    episodesRoot: root, graph,
    taskId: "t1", grantedBy: "test-harness",
    workerCommand: worker, worktreePath: repo,
    maxIterations: 1,
    log: (l) => { t.diagnostic(l); },
  });

  assert.notEqual(res.result.stopped, "accepted-finish",
    `artifact-only acceptance under an unobservable identity must never finish accepted (got ${res.result.stopped}; detail=${res.result.detail ?? ""})`);
  assert.notEqual(res.result.detail, "integrated", "the forge must never integrate");
  const journal = await DecisionJournal.forEpisode(join(root, "ep-r3-f2e2e"));
  const { records } = await journal.read();
  const acc = (records as { kind?: string; verdict?: string; remainingWork?: string[]; artifact?: { unobservable?: boolean } }[])
    .filter((r) => r.kind === "acceptance");
  assert.ok(acc.length > 0, "at least one acceptance record must exist");
  assert.ok(acc.every((r) => r.verdict !== "complete"),
    `no acceptance verdict may be complete under an unobservable identity, got ${JSON.stringify(acc.map((r) => r.verdict))}`);
  assert.ok(acc.every((r) => Array.isArray(r.remainingWork) && r.remainingWork.length > 0),
    "an uncertain verdict under unobservable identity must carry remaining work (missing evidence), never an empty list");
  // The reduced host-loop append (compose.ts) carries no `artifact`
  // field; where a FULL record is converted (toAcceptanceRecord) the
  // marker rides into the durable shape — pinned in acceptance.test.ts
  // (R3-F2 unit) together with the journal's boolTrue validation.
  assert.ok(acc.every((r) => r.artifact === undefined || r.artifact.unobservable === true),
    "a journaled artifact identity, if present, declares an unmeasured identity is one");
});
