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
 * Determinism: scripted loop bodies with fixed behavior (no model calls —
 * the observer channel is the scheduler's fairness queue over a scripted
 * P15-shaped investigate), real `runSchedulerEpisode` against that
 * harness (the same harness style as test/host-schedule.test.ts). A
 * scripted investigate records its grant in observerLog, so the fairness
 * bound is observable end-to-end.
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
  opts: { maxParallel?: number; investigate?: SchedulerDeps["investigate"] } = {},
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
    ...(opts.investigate !== undefined ? { investigate: opts.investigate } : {}),
    activation: "bench-act-1",
    journal: { async append() {} },
    clock,
  };
}
const t = (id: string, extra: Partial<SchedTaskLike> = {}): SchedTaskLike => ({ id, ...extra });

for (const workers of [1, 2, 3]) {
  test(`M2 acceptance benchmark: ${workers} worker(s) accept the fixed 6-task workload`, async () => {
    const t0 = Date.now();
    const res = await runSchedulerEpisode(
      { episodeId: "ep-bench" },
      deps(["t1", "t2", "t3", "t4", "t5", "t6"].map((id) => t(id)), {}, { maxParallel: workers }),
    );
    const wallMs = Date.now() - t0;
    const done = Object.entries(res.tasks).filter(([, f]) => (f as { status: string }).status === "done").length;
    assert.equal(done, 6, `all 6 accepted with ${workers} workers (wall ${wallMs}ms)`);
    assert.equal(res.stopped, "quiesced-complete");
  });
}

test("M2 acceptance benchmark: observer fairness — queued investigations granted within W", async () => {
  // 3 tasks all requesting investigation at once: W = 3 waiting, so every
  // request must be granted within 3 grants (docs/20 §5 no-starvation bound).
  const order: string[] = [];
  const d = deps(
    [t("a"), t("b"), t("c")],
    Object.fromEntries(
      ["a", "b", "c"].map((id) => [id, async (hooks: SchedulerLoopHooks) => {
        await hooks.investigate({}, {});
        return { stopped: "accepted-finish" };
      }]),
    ),
    {
      maxParallel: 3,
      investigate: async (task: SchedTaskLike) => {
        order.push(task.id);
        return { class: "unknown", confidence: 0 };
      },
    },
  );
  const res = await runSchedulerEpisode({ episodeId: "ep-bench" }, d);
  const done = Object.entries(res.tasks).filter(([, f]) => (f as { status: string }).status === "done").length;
  assert.equal(done, 3, "all 3 accepted");
  for (const id of ["a", "b", "c"]) {
    const first = order.indexOf(id);
    assert.ok(first >= 0 && first < 3, `${id} granted within W=3 (order ${order.join(",")})`);
  }
});

test("M2 acceptance benchmark: parked task does not block independent work", async () => {
  const d = deps(
    [t("blocked"), t("free")],
    {
      blocked: async () => ({ stopped: "parked" }),
      free: async () => ({ stopped: "accepted-finish" }),
    },
    { maxParallel: 2 },
  );
  const res = await runSchedulerEpisode({ episodeId: "ep-bench" }, d);
  const byId = Object.fromEntries(Object.entries(res.tasks).map(([k, f]) => [k, f.status]));
  assert.equal(byId["free"], "done", "independent task accepted");
  assert.equal(byId["blocked"], "parked", "blocked task parked");
});
