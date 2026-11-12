/**
 * M2 acceptance benchmark (docs/20 §11.3, docs/11 §11.4 M2 exit evidence).
 *
 * Fixed deterministic workload: {1, 2, 3} workers × observer contention,
 * measuring accepted tasks/human-minutes vs the single-worker baseline.
 * The productivity measures are the docs/11 §11.4 ones — slot utilization
 * is explicitly NOT a success metric: N workers must not reduce accepted
 * tasks, must not starve any waiting observer request past the fairness
 * bound, and the independence invariant from §11.4 (one parked task does
 * not block independent work) must hold at every scale.
 *
 * NON-VACUOUS by construction (m2c6 M3/M4 review): loop bodies hold a
 * barrier gate open so N workers genuinely overlap — the benchmark
 * asserts peak overlap ≥ 2 at maxParallel ≥ 2 and ≥ 1 at 1. The fairness
 * case holds all three investigations inside the critical section at
 * once so the waiting set is non-empty (maxWaiting ≥ 2 asserted), every
 * request granted within W=3. The zero-observer comparison (§11.3, m2c6
 * M4) documents that with observerSlots=1 all 6 tasks still investigate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  runSchedulerEpisode,
  type SchedTaskLike,
  type SchedulerDeps,
  type SchedulerLoopHooks,
  type SchedLoopResultLike,
} from "../src/supervisor/schedule.js";

const NOW = 1000;
const clock = { now: () => NOW };
const cap4 = {
  async read() {
    return JSON.stringify({ schema: "tre-capacity/1", measuredAt: NOW, ttlS: 1e9, endpoints: { "*": { maxConcurrent: 4 } } });
  },
};

function deps(
  tasks: SchedTaskLike[],
  script: Record<string, (hooks: SchedulerLoopHooks, task: SchedTaskLike) => Promise<SchedLoopResultLike>>,
  opts: { maxParallel?: number; observerSlots?: number; investigate?: SchedulerDeps["investigate"] } = {},
): SchedulerDeps {
  return {
    graph: { async read() { return { episodeId: "ep-bench", tasks }; } },
    loop: async (_cfg: object, ports: object) => {
      const p = ports as { taskId: string; hooks: SchedulerLoopHooks };
      const body = script[p.taskId];
      return body ? await body(p.hooks, { id: p.taskId }) : { stopped: "accepted-finish" };
    },
    loopConfig: (task: SchedTaskLike) => ({ taskId: task.id }),
    loopPorts: (task: SchedTaskLike, hooks: SchedulerLoopHooks) => ({ taskId: task.id, hooks }),
    capacity: cap4,
    maxParallel: opts.maxParallel,
    ...(opts.observerSlots !== undefined ? { observerSlots: opts.observerSlots } : {}),
    ...(opts.investigate !== undefined ? { investigate: opts.investigate } : {}),
    activation: "bench-act-1",
    journal: { async append() {} },
    clock,
  };
}
const t = (id: string, extra: Partial<SchedTaskLike> = {}): SchedTaskLike => ({ id, ...extra });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

for (const workers of [1, 2, 3]) {
  test(`M2 acceptance benchmark: ${workers} worker(s) accept the fixed 6-task workload with real overlap`, async () => {
    let active = 0;
    let peak = 0;
    const ids = ["t1", "t2", "t3", "t4", "t5", "t6"];
    const t0 = Date.now();
    const res = await runSchedulerEpisode(
      { episodeId: "ep-bench" },
      deps(
        ids.map((id) => t(id)),
        Object.fromEntries(ids.map((id) => [id, async () => {
          active += 1;
          peak = Math.max(peak, active);
          await tick(); await tick(); // hold the gate open so siblings overlap
          active -= 1;
          return { stopped: "accepted-finish" };
        }])),
        { maxParallel: workers },
      ),
    );
    const wallMs = Date.now() - t0;
    const done = Object.values(res.tasks).filter((f) => f.status === "done").length;
    console.log(`M2-BENCH workers=${workers} done=${done} stopped=${res.stopped} wallMs=${wallMs} peak=${peak}`);
    assert.equal(done, 6, `all 6 accepted with ${workers} workers (wall ${wallMs}ms, peak overlap ${peak})`);
    assert.equal(res.stopped, "quiesced-complete");
    // m2c6 M3: the benchmark is vacuous unless overlap is demonstrated.
    assert.ok(peak >= Math.min(workers, 2), `expected real overlap at maxParallel=${workers} (peak ${peak})`);
  });
}

test("M2 acceptance benchmark: observer fairness — queued investigations granted within W", async () => {
  // m2c6 M4 / m2c7 closure: contention is OBSERVED (maxWaiting ≥ 2 — it
  // arises naturally at maxParallel=3; the rendezvous pins it so the
  // proof never depends on scheduling luck), the no-starvation bound is
  // ASSERTED (every request granted within W=3), and the single-slot
  // DISCIPLINE is asserted: observer calls NEVER overlap (peakInside ≤ 1;
  // m2c7 counter-proof: raising the ObserverQueue clamp in a dist scratch
  // fails this assertion, so it has genuine necessity).
  const order: string[] = [];
  let waiting = 0;
  let maxWaiting = 0;
  let inside = 0;
  let peakInside = 0;
  const grantDone: Record<string, () => void> = {};
  const granted: Record<string, Promise<void>> = {};
  for (const id of ["a", "b", "c"]) {
    granted[id] = new Promise<void>((r) => { grantDone[id] = r; });
  }
  const d = deps(
    [t("a"), t("b"), t("c")],
    Object.fromEntries(
      ["a", "b", "c"].map((id) => [id, async (hooks: SchedulerLoopHooks) => {
        waiting += 1;
        maxWaiting = Math.max(maxWaiting, waiting);
        grantDone[id]!(); // signal: this request is now inside
        await Promise.all([granted["a"], granted["b"], granted["c"]]); // all three queued together…
        await hooks.investigate({}, {}); // …then each takes its turn
        waiting -= 1;
        return { stopped: "accepted-finish" };
      }]),
    ),
    {
      maxParallel: 3,
      investigate: async (task: SchedTaskLike) => {
        inside += 1;
        peakInside = Math.max(peakInside, inside);
        order.push(task.id);
        await tick(); // hold the slot briefly so the next waiter visibly waits
        inside -= 1;
        return { class: "unknown", confidence: 0 };
      },
    },
  );
  const res = await runSchedulerEpisode({ episodeId: "ep-bench" }, d);
  assert.equal(Object.values(res.tasks).filter((f) => f.status === "done").length, 3, "all 3 accepted");
  console.log(`M2-BENCH fairness order=${order.join(",")} maxWaiting=${maxWaiting} grants=${order.length} peakInside=${peakInside}`);
  assert.ok(maxWaiting >= 2, `expected real contention (maxWaiting ${maxWaiting})`);
  assert.equal(peakInside, 1, "single global observer slot: investigations never overlap (D1 clamp)");
  for (const id of ["a", "b", "c"]) {
    const first = order.indexOf(id);
    assert.ok(first >= 0 && first < 3, `${id} granted within W=3 (order ${order.join(",")})`);
  }
});

test("M2 acceptance benchmark: observer slot comparison — 1 slot (docs/20 §11.3; m2c7: no 0-slot config exists, clamp is binding)", async () => {
  // docs/20 §11.3's "0/1 slot" phrasing: the shipped design (D1) CLAMPS
  // observerSlots to exactly 1 (schedule.ts ObserverQueue ctor) — a
  // zero-slot observer cannot exist by construction, so the measurable
  // comparison is "N loops × the single slot": all 6 tasks still
  // investigate, serialize, and accept.
  const investigated: string[] = [];
  let inside = 0;
  let peakInside = 0;
  const ids = ["t1", "t2", "t3", "t4", "t5", "t6"];
  const res = await runSchedulerEpisode(
    { episodeId: "ep-bench" },
    deps(
      ids.map((id) => t(id)),
      Object.fromEntries(ids.map((id) => [id, async (hooks: SchedulerLoopHooks) => {
        await hooks.investigate({}, {});
        return { stopped: "accepted-finish" };
      }])),
      {
        maxParallel: 3,
        // D1 binding clamp: REQUEST 3 slots — the queue serves exactly 1.
        // (m2c7 counter-proof: loosening the ObserverQueue ctor to honor
        // the request drives peakInside > 1 and fails this test.)
        observerSlots: 3,
        investigate: async (task: SchedTaskLike) => {
          inside += 1;
          peakInside = Math.max(peakInside, inside);
          investigated.push(task.id);
          await tick();
          inside -= 1;
          return { class: "unknown", confidence: 0 };
        },
      },
    ),
  );
  assert.equal(Object.values(res.tasks).filter((f) => f.status === "done").length, 6);
  assert.equal(investigated.length, 6, "every task investigated under the single slot");
  assert.equal(peakInside, 1, "the single slot serializes all 6 (no overlap even at maxParallel=3)");
});

test("M2 acceptance benchmark: parked task does not block independent work", async (tst) => {
  const d = deps(
    [t("blocked"), t("free")],
    {
      blocked: async () => ({ stopped: "parked" }),
      free: async () => ({ stopped: "accepted-finish" }),
    },
    { maxParallel: 2 },
  );
  // m2c6 M5: a hang must produce a bounded regression failure, not a
  // silent timeout — race the episode against a 10s guard.
  const res = (await Promise.race([
    runSchedulerEpisode({ episodeId: "ep-bench" }, d),
    new Promise((_, rej) => setTimeout(() => rej(new Error("episode hung: parked task blocked quiescence")), 10000)),
  ])) as Awaited<ReturnType<typeof runSchedulerEpisode>>;
  const byId = Object.fromEntries(Object.entries(res.tasks).map(([k, f]) => [k, f.status]));
  assert.equal(byId["free"], "done", "independent task accepted");
  assert.equal(byId["blocked"], "parked", "blocked task parked");
  // m2c6 M5: assert the quiescence CLASSIFICATION, not just fates — a
  // parked remainder must read quiesced-blocked, never quiesced-complete.
  assert.equal(res.stopped, "quiesced-blocked", "parked remainder classifies the episode blocked");
  tst.diagnostic?.(`M2-BENCH parked-episode stopped=${res.stopped}`);
});
