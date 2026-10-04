import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildWorkerStatus, makeWorkerTap, workerOutcomeStatus } from "../src/cli/main.js";
import { readWorkerStatuses } from "../src/cli/workers.js";
import type { ModelConfig, WorkerStatus } from "../src/types.js";

const model = { id: "m1", baseUrl: "https://example.test" } as ModelConfig;

test("buildWorkerStatus initializes and truncates task", () => {
  const status = buildWorkerStatus("w1", model, "/work", `  ${"hello ".repeat(30)}  `, 123);
  assert.equal(status.status, "running");
  assert.equal(status.turn, 0);
  assert.equal(status.task.length, 120);
  assert.equal(status.updatedAt, 123);
  assert.equal(status.startedAt, 123);
});

test("worker tap updates turn and tool activity in registry", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-worker-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const status: WorkerStatus = buildWorkerStatus("w1", model, "/work", "task", 10);
  const tap = makeWorkerTap(status, dir);
  tap({ type: "turn_start", turn: 4 } as never);
  assert.equal(readWorkerStatuses(dir)[0]?.turn, 4);
  tap({ type: "tool_execution_start", toolCall: { name: "bash" } } as never);
  assert.equal(readWorkerStatuses(dir)[0]?.activity, "bash");
});

test("worker outcome status distinguishes clean and abnormal stops", () => {
  assert.equal(workerOutcomeStatus("stop"), "done");
  assert.equal(workerOutcomeStatus("error"), "failed");
  assert.equal(workerOutcomeStatus("aborted"), "failed");
});
