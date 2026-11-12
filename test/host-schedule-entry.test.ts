import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate, exitCodeForStop, parseActivateArgs } from "../src/host/activate.js";
import { asideName, runHostEpisode, runScheduledHostEpisode } from "../src/host/supervise.js";
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
  // M2 audit cycle 2 (R1): --max-parallel WITHOUT --schedule is a usage
  // error, never a silently-ignored flag (the M1 path drops it).
  assert.deepEqual(parseActivateArgs(["--graph", "g", "--task", "t", "--max-parallel", "2"]), { error: "--max-parallel requires --schedule" });
  assert.ok(!("error" in parseActivateArgs(["--schedule", "--max-parallel", "2", "--graph", "g"])), "--max-parallel with --schedule still parses");
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

test("schedule entry: state.json slots is a LIVE projection rebuilt on each admission and terminal (R2)", async () => {
  const root = await mkdtemp(join(tmpdir(), "sched-slots-entry-"));
  const logs: string[] = [];
  let release!: () => void;
  const opened = new Promise<void>((r) => { release = r; });
  let bothRunning!: () => void;
  const gate = new Promise<void>((r) => { bothRunning = r; });
  let inFlight = 0;
  const statePath = join(root, "schedule-entry", "state.json");
  let run: ReturnType<typeof runScheduledHostEpisode> | undefined;
  try {
    const g = graph();
    // Distinct endpoints so BOTH tasks can hold a slot at once (no machine
    // capacity file → each endpoint serializes at 1; distinct models = 2).
    // The ledger admission preflight denies an unlisted model, so the graph
    // must AUTHORIZE both endpoints (it fails closed otherwise).
    g.policy = { authority: { paths: [], notPaths: [], models: ["endpoint-a", "endpoint-b"] } };
    g.tasks[0]!.model = "endpoint-a"; g.tasks[1]!.model = "endpoint-b";
    run = runScheduledHostEpisode({ graph: g, episodesRoot: root, grantedBy: "test", log: (l) => logs.push(l),
      loop: async (cfg, ports) => {
        inFlight += 1;
        if (inFlight === 2) bothRunning();
        await opened;
        await accepted(cfg, ports);
        return { stopped: "accepted-finish", iterations: [], investigationCount: 0 };
      },
    });
    // BOUNDED gate: if the two admissions never overlap, fail LOUD with the
    // scheduler's own log rather than hanging the whole test file.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`both loops never ran concurrently (inFlight=${inFlight}); scheduler log: ${logs.join(" | ")}`)), 10_000);
    });
    try { await Promise.race([gate, timeout]); } finally { if (timer !== undefined) clearTimeout(timer); }
    // Bounded spin (no fixed sleep): the host serializes projection writes,
    // so the file settles within a few ms of the second publish.
    let mid: Record<string, string | null> | undefined;
    for (let i = 0; i < 1000; i++) {
      try {
        const st = JSON.parse(await readFile(statePath, "utf8")) as { slots?: Record<string, string | null> };
        mid = st.slots;
        if (Object.keys(st.slots ?? {}).length === 2) break;
      } catch { mid = undefined; }
      await new Promise((r) => setTimeout(r, 1));
    }
    assert.deepEqual(mid, { "endpoint-a#a": "a", "endpoint-b#b": "b" },
      `mid-run slots reflect the LIVE set (scheduler log: ${logs.join(" | ")})`);
    release();
    const res = await run;
    assert.equal(res.admissions, 2);
    const finalState = await readEpisodeState(join(res.episodePath, "state.json"));
    assert.deepEqual(finalState.slots, {}, "the final write restores the drained (empty) live set");
    assert.deepEqual(Object.values(finalState.tasks).map((t) => t.status), ["done", "done"]);
  } finally {
    release();
    await run?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("schedule entry: a corrupt state.json mid-run is preserved aside, never overwritten by the slots projection (W1-M7)", async () => {
  const root = await mkdtemp(join(tmpdir(), "sched-corrupt-mid-"));
  const logs: string[] = [];
  // M2 audit cycle 2 (bug): the R2 projection's read-failure branch used to
  // be `catch { existing = undefined }` and then OVERWROTE the file — the
  // established W1-M7 rule (runPark) instead moves unreadable bytes aside
  // and skips the durable write. Here a task's loop corrupts state.json
  // mid-run; the next projection publish must leave a `.unreadable-*` copy
  // with the corrupt bytes and must NOT clobber it.
  const CORRUPT = '{"schema":"tre-episode-state/1","tasks":{"hint-row":{"status":"done"}}  CORRUPT-EVIDENCE';
  const statePath = join(root, "schedule-entry", "state.json");
  try {
    const g = graph();
    g.policy = { authority: { paths: [], notPaths: [], models: ["endpoint-a"] } };
    g.tasks.forEach((t) => { t.model = "endpoint-a"; }); // one endpoint → the two loops serialize
    let corrupted = false;
    const res = await runScheduledHostEpisode({ graph: g, episodesRoot: root, grantedBy: "test", log: (l) => logs.push(l),
      loop: async (cfg, ports) => {
        if (cfg.taskId === "a") {
          // Bounded spin FIRST: let the admission projection settle so the
          // corruption cannot be clobbered by an in-flight write (the c2
          // auditor's probe corrupted too early and lost that race).
          for (let i = 0; i < 2000; i++) {
            try {
              const st = JSON.parse(await readFile(statePath, "utf8")) as { slots?: Record<string, string | null> };
              if (Object.keys(st.slots ?? {}).length === 1) break;
            } catch { /* projection not written yet */ }
            await new Promise((r) => setTimeout(r, 1));
          }
          await writeFile(statePath, CORRUPT);
          corrupted = true;
        }
        await accepted(cfg, ports);
        return { stopped: "accepted-finish", iterations: [], investigationCount: 0 };
      },
    });
    assert.ok(corrupted, "the loop ran and corrupted state.json");
    // The scheduler is UNAFFECTED by the projection skip: both tasks still
    // admit, accept and finish (the projection is disclosure-only, S6).
    assert.equal(res.admissions, 2, JSON.stringify({ d: res.denials, o: res.taskOutcomes }));
    assert.equal(exitCodeForStop(res.result.stopped), 0, JSON.stringify({ d: res.denials, o: res.taskOutcomes }));
    const dir = join(root, "schedule-entry");
    const files = await readdir(dir);
    const aside = files.filter((f) => f.includes(".unreadable-"));
    assert.equal(aside.length, 1, `exactly one preserved copy (dir: ${files.join(", ")})`);
    assert.equal(await readFile(join(dir, aside[0]!), "utf8"), CORRUPT, "the preserved copy holds the corrupt bytes verbatim");
    assert.ok(logs.some((l) => l.includes("SKIPPED")), `the skipped write is disclosed (log: ${logs.join(" | ")})`);
    // state.json (a cache, S6) is rebuilt by the final terminal write.
    const finalState = await readEpisodeState(statePath);
    assert.deepEqual(finalState.slots, {});
    assert.deepEqual(Object.values(finalState.tasks).map((t) => t.status), ["done", "done"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schedule entry: two asides of the same base within one millisecond never collide (M2 audit c4)", async () => {
  // Audit c3 finding: `${base}.unreadable-${now()}` is ms-granular and a
  // POSIX rename REPLACES its target — a same-ms second aside would destroy
  // the first preserved copy. asideName() probes deterministically.
  const dir = await mkdtemp(join(tmpdir(), "aside-name-"));
  const base = join(dir, "state.json");
  const TS = 1_700_000_000_000;
  try {
    // No occupant: the bare ts name is used (unchanged shape).
    assert.equal(await asideName(base, TS), `${base}.unreadable-${TS}`);
    // Occupy exactly that name, as a first aside would.
    await writeFile(`${base}.unreadable-${TS}`, "first");
    assert.equal(await asideName(base, TS), `${base}.unreadable-${TS}.1`, "the taken ms name is skipped, not replaced");
    await writeFile(`${base}.unreadable-${TS}.1`, "second");
    assert.equal(await asideName(base, TS), `${base}.unreadable-${TS}.2`, "probes upward past every occupant");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("schedule entry: a corrupt state.json reaching the FINAL write is preserved aside, never replaced (W1-M7)", async () => {
  const root = await mkdtemp(join(tmpdir(), "sched-corrupt-final-"));
  const logs: string[] = [];
  const CORRUPT = '{"schema":"tre-episode-state/1","tasks":{"hint-row":{"status":"done"}}  CORRUPT-EVIDENCE';
  const dir = join(root, "schedule-entry");
  try {
    // Deterministic construction that avoids racing the write chain: NO
    // task is admitted (both models unapproved), so NO projection write
    // ever runs and the terminal merge write is the FIRST reader of the
    // pre-existing corrupt bytes (the realistic "previous run crashed and
    // left a corrupt cache" case). The final write must preserve-aside and
    // skip rather than silently replace the evidence with `{}`.
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "state.json"), CORRUPT);
    const g = graph();
    g.policy = { authority: { paths: [], notPaths: [], models: ["allowed"] } };
    g.tasks.forEach((t) => { t.model = "not-approved"; });
    const res = await runScheduledHostEpisode({ graph: g, episodesRoot: root, grantedBy: "test", log: (l) => logs.push(l) });
    assert.equal(res.admissions, 0, JSON.stringify({ d: res.denials }));
    const files = await readdir(dir);
    const aside = files.filter((f) => f.includes(".unreadable-"));
    assert.equal(aside.length, 1, `exactly one preserved copy (dir: ${files.join(", ")})`);
    assert.equal(await readFile(join(dir, aside[0]!), "utf8"), CORRUPT, "the preserved copy holds the corrupt bytes verbatim");
    assert.ok(!files.includes("state.json"), "the corrupt file was NOT replaced by a fresh terminal object");
    assert.ok(logs.some((l) => l.includes("SKIPPED")), `the skipped terminal write is disclosed (log: ${logs.join(" | ")})`);
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
