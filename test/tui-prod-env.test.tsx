/**
 * C29 — regression test: the DEV React reconciler must not create
 * User-Timing entries during TUI rendering.
 *
 * The reconciler (loaded by ink whenever NODE_ENV is unset) calls
 * performance.measure() once per component commit; Node keeps those
 * PerformanceMeasure objects until cleared. At a dense streaming
 * re-render rate (~16k/s), the between-sweep buffer peaked at 78k
 * entries / ~700 MB RSS and could cross the ~2 GB heap limit between
 * sweeps (the "Ineffective mark-compacts" OOM). The fix (src/tui/
 * prod-env.ts, imported by main.ts before ink is linked) removes
 * console.timeStamp, which flips the reconciler's supportsUserTiming
 * gate to false at module init.
 *
 * This file imports prod-env.js FIRST (before ink loads in this test
 * process) so the assertions exercise the real, fixed code path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// Side effect on import: removes console.timeStamp. MUST come before the
// dynamic ink import below (the DEV reconciler reads the gate at link time).
import "../src/tui/prod-env.js";
import React from "react";
import { render } from "ink-testing-library";

test("C29: the prod-env side effect removed console.timeStamp", () => {
  assert.notEqual(
    typeof console.timeStamp,
    "function",
    "console.timeStamp must be gone before the DEV reconciler loads",
  );
});

test("C29: 200 ink re-renders create ZERO new User-Timing measures", async () => {
  const { Box, Text } = await import("ink");
  // Baseline first: node:test and prior tests in this process may have
  // created timing entries — we only assert on NEW ones.
  const before = performance.getEntriesByType("measure").length;
  // A fresh tree per render: every render commits Box + Text components,
  // which is exactly what the DEV reconciler instruments (stage-level
  // "Mount"/"Update"/"Layout" measures plus per-component ones).
  let unmountFrame = render(React.createElement(Box, null, "probe"));
  for (let i = 1; i < 200; i++) {
    unmountFrame.unmount();
    unmountFrame = render(
      React.createElement(Box, null, React.createElement(Text, null, `x${i}`)),
    );
  }
  unmountFrame.unmount();
  // Give the reconciler a tick to flush any late commits.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    performance.getEntriesByType("measure").length,
    before,
    "200 renders must not add a single measure to the buffer",
  );
});

test("C29 (mechanism): WITHOUT prod-env, the DEV reconciler DOES create entries", async () => {
  // Documents the failure mode the fix removes: a plain `node` process
  // (NODE_ENV unset, no prod-env import) rendering ink produces
  // \u200b-prefixed measures. If this starts failing, React stopped
  // creating entries and the C29/C25 machinery is redundant.
  const { spawnSync } = await import("node:child_process");
  const code = `
    (async () => {
      const React = require("react");
      const { render, Box, Text } = await import("ink");
      const before = performance.getEntriesByType("measure").length;
      const { unmount } = render(React.createElement(Box, null,
        React.createElement(Text, null, "probe")));
      await new Promise((r) => setTimeout(r, 150));
      unmount();
      await new Promise((r) => setTimeout(r, 50));
      const created =
        performance.getEntriesByType("measure").length - before;
      // stderr: ink renders its frames to the child's stdout.
      process.stderr.write(String(created));
      process.exit(created > 0 ? 0 : 3);
    })();
  `;
  const res = spawnSync(process.execPath, ["-e", code], {
    cwd: import.meta.dirname + "/..",
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(
    res.status,
    0,
    `probe child should produce entries (exit ${res.status}, stderr: ${res.stderr?.slice(0, 300)})`,
  );
  const n = Number.parseInt(
    ((res.stderr || "").trim().split(/\s+/).pop() || ""),
    10,
  );
  assert.ok(n > 0, `expected >0 measures without the fix, got ${n}`);
});
