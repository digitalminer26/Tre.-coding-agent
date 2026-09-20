/**
 * C23 — regression test: rendering ink frames under a real PTY must not
 * leak file descriptors.
 *
 * terminal-size@4 (ink dependency) leaked one /dev/tty fd plus one socketpair
 * per terminalSize() call on macOS, and ink calls it every frame — a long
 * `tre. tui` session exhausted the per-process fd cap (EMFILE). The fix
 * (src/tui/terminal-size-fix.ts) answers the size from process.stdout when
 * it is a TTY. This test spawns the built fix + ink inside a PTY (via
 * `script`), re-renders a few hundred frames, and asserts the fd count
 * stays flat. Without the fix the delta is ~4 fds/frame (hundreds).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // dist/test
const root = path.resolve(here, "..", ".."); // repo root
const fixPath = path.join(root, "dist", "src", "tui", "terminal-size-fix.js");
const inkPath = path.join(root, "node_modules", "ink", "build", "index.js");
const reactPath = path.join(root, "node_modules", "react", "index.js");

const CHILD = `
import "${fixPath}";
import React from ${JSON.stringify(reactPath)};
// ink MUST be imported dynamically: a static import would link the whole
// graph (including ink -> terminal-size) before register() in the fix runs.
const { render, Text } = await import(${JSON.stringify(inkPath)});
import fs from "node:fs";

if (!process.stdout.isTTY) {
  console.log(JSON.stringify({ err: "stdout is not a TTY" }));
  process.exit(2);
}
const fds = () => fs.readdirSync("/dev/fd").length;
const { rerender, unmount } = render(React.createElement(Text, null, "frame 0"));
await new Promise((r) => setTimeout(r, 100));
const base = fds();
const FRAMES = 300;
for (let i = 1; i <= FRAMES; i++) {
  rerender(React.createElement(Text, null, "frame " + i + " " + "x".repeat(60)));
  await new Promise((r) => setTimeout(r, 2));
}
const end = fds();
unmount();
console.log(JSON.stringify({ base, end, delta: end - base, frames: FRAMES }));
process.exit(end - base > 10 ? 1 : 0);
`;

test("ink render frames under a PTY do not leak fds (C23)", { timeout: 30000 }, (t, done) => {
  if (process.platform !== "darwin") {
    t.skip("needs a macOS PTY (script)");
    return;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "tre-fd-c23-"));
  const child = path.join(dir, "child.mjs");
  writeFileSync(child, CHILD);
  let out = "";
  try {
    out = execFileSync("script", ["-q", "/dev/null", process.execPath, child], {
      cwd: root,
      encoding: "utf8",
      timeout: 25000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    done(
      new Error(
        `PTY child failed (${String(e)}): tail=${String(
          (e as { stdout?: string }).stdout ?? ""
        ).slice(-400)}`
      )
    );
    return;
  }
  const matches = out.match(/\{.*?\}/g) ?? [];
  if (matches.length === 0) {
    done(new Error("no JSON line from PTY child; tail=" + out.slice(-400)));
    return;
  }
  let r: { err?: string; base?: number; end?: number; delta?: number };
  const last = matches[matches.length - 1] ?? "";
  try {
    r = JSON.parse(last);
  } catch {
    done(new Error("unparseable JSON from PTY child: " + last));
    return;
  }
  try {
    assert.equal(r.err, undefined, "child precondition failed: " + String(r.err));
    assert.ok(
      typeof r.delta === "number" && r.delta <= 10,
      `fd leak across 300 frames: base=${r.base} end=${r.end} delta=${r.delta}`
    );
    done();
  } catch (e) {
    done(e);
  }
});
