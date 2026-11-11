import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate, exitCodeForStop, parseActivateArgs } from "../src/host/activate.js";
import { runHostEpisode, runScheduledHostEpisode } from "../src/host/supervise.js";
import { DecisionJournal, readEpisodeState, type EpisodeGraph } from "../src/episode/journal.js";
import type { SupervisorConfig, ComposePorts } from "../src/supervisor/compose.js";

const graph = (): EpisodeGraph => ({ schema: "tre-graph/1", episodeId: "schedule-entry", goal: "test",
  tasks: ["a", "b"].map((id) => ({ id, persona: "implementer", promptRef: "p", dependsOn: [] })),
});

test("schedule entry: parse surface and existing closed exit map", async () => {
  const p = parseActivateArgs(["--graph", "g", "--schedule", "--max-parallel", "2"]);
  assert.ok(!("error" in p) && !("help" in p));
  assert.equal(p.schedule, true); assert.equal(p.maxParallel, 2);
  assert.deepEqual(parseActivateArgs(["--graph", "g", "--schedule", "--task", "a"]), { error: "--schedule and --task are mutually exclusive" });
  assert.deepEqual(parseActivateArgs(["--schedule"]), { error: "--graph is required" });
  for (const n of ["0", "-1", "1.5", "NaN", "Infinity"]) assert.ok("error" in parseActivateArgs(["--graph", "g", "--schedule", "--max-parallel", n]));
  const logs: string[] = [];
  assert.equal(await activate(["--help"], (s) => logs.push(s)), 0);
  assert.match(logs.join("\n"), /--schedule/);
  assert.equal(exitCodeForStop("completed"), 0);
  assert.equal(exitCodeForStop("halt"), 5);
  assert.equal(exitCodeForStop("shutdown"), 5);
});

async function accepted(cfg: SupervisorConfig, ports: ComposePorts): Promise<void> {
  await ports.journal.append({ kind: "acceptance", schema: "tre-supervisor/1", id: `d-${cfg.taskId}-acc`,
    episodeId: cfg.episodeId, taskId: cfg.taskId, ts: Date.now(), taskRevision: 1, verdict: "complete", criteria: [] } as never);
}

test("schedule entry: two scripted tasks share one lease, ledger admission, durable acceptance and derived terminal slots", async () => {
  const root = await mkdtemp(join(tmpdir(), "sched-entry-"));
  const calls: string[] = []; const tokens: string[] = [];
  try {
    const res = await runScheduledHostEpisode({ graph: graph(), episodesRoot: root, grantedBy: "test", log: () => {},
      loop: async (cfg, ports) => {
        calls.push(cfg.taskId); tokens.push(cfg.intentScope!);
        const lease = JSON.parse(await readFile(join(root, "schedule-entry", "host.lease"), "utf8")) as { token: string };
        assert.equal(cfg.intentScope, lease.token);
        assert.ok(ports.investigate); assert.ok(ports.gate); assert.ok(ports.steer);
        await accepted(cfg, ports);
        // Corrupt old projection must never become input to the final write.
        await writeFile(join(root, "schedule-entry", "state.json"), "corrupt");
        return { stopped: "accepted-finish", iterations: [], investigationCount: 0 };
      },
    });
    assert.deepEqual(calls.sort(), ["a", "b"]);
    assert.equal(new Set(tokens).size, 1);
    assert.equal(res.admissions, 2); assert.equal(exitCodeForStop(res.result.stopped), 0, JSON.stringify({ d: res.denials, o: res.taskOutcomes }));
    const state = await readEpisodeState(join(res.episodePath, "state.json"));
    assert.deepEqual(state.slots, {}); // scheduler has drained its live set
    assert.deepEqual(Object.values(state.tasks).map((t) => t.status), ["done", "done"]);
    const journal = await DecisionJournal.forEpisode(res.episodePath);
    const { records } = await journal.read();
    assert.equal(records.filter((r) => r.kind === "decision-outcome" && r.notes?.includes('"kind":"sched-admit"')).length, 2);
    await assert.rejects(readFile(join(res.episodePath, "host.lease")), { code: "ENOENT" });
    assert.ok(res.disclosures.some((s) => s.includes("NO per-task isolation")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schedule entry: ledger-backed admission refuses unapproved models before scripted loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "sched-gate-entry-"));
  try {
    const g = graph();
    g.policy = { authority: { paths: [], notPaths: [], models: ["allowed"] } };
    g.tasks.forEach((t) => { t.model = "not-approved"; });
    let calls = 0;
    const res = await runScheduledHostEpisode({ graph: g, episodesRoot: root, grantedBy: "test", log: () => {},
      loop: async () => { calls++; return { stopped: "completed", iterations: [], investigationCount: 0 }; },
    });
    assert.equal(calls, 0); assert.equal(res.admissions, 0);
    assert.equal(res.denials.length, 2);
    assert.ok(res.denials.every((d) => d.reason.includes("model")), JSON.stringify(res.denials));
    assert.equal(exitCodeForStop(res.result.stopped), 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schedule entry: same host.lease excludes both a second scheduler and M1; loop throws are named outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sched-lease-entry-"));
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const wait = new Promise<void>((r) => { release = r; });
  const opts = { graph: graph(), episodesRoot: root, grantedBy: "test", log: () => {} };
  const first = runScheduledHostEpisode({ ...opts, loop: async () => {
    entered(); await wait; throw new Error("scripted worker failure");
  } });
  try {
    await started;
    await assert.rejects(runScheduledHostEpisode(opts), /lease|active/);
    await assert.rejects(runHostEpisode({ ...opts, taskId: "a" }), /lease|active/);
  } finally { release(); }
  try {
    const res = await first;
    assert.equal(res.taskOutcomes.a?.stopped, "loop-error");
    assert.equal(exitCodeForStop(res.result.stopped), 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schedule entry: accepted stop without current durable acceptance fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "sched-accept-entry-"));
  try {
    const res = await runScheduledHostEpisode({ graph: graph(), episodesRoot: root, grantedBy: "test", log: () => {},
      loop: async () => ({ stopped: "accepted-finish", iterations: [], investigationCount: 0 }),
    });
    assert.equal(exitCodeForStop(res.result.stopped), 5);
    assert.ok(Object.values(res.taskOutcomes).every((t) => t.status === "failed"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
