/**
 * WS12 — MCP stdio bridge (scope: docs/10-mcp-scope.md §4.1/§4.4, the
 * "stdio spawn is new; reuse the bash.ts process-group kill pattern, not its
 * spawn API").
 *
 * Spawns a long-lived MCP server child with PERSISTENT piped
 * stdin/stdout/stderr (the client owns the streams — `spawnSandboxedBash`
 * cannot be reused: it takes shell text and uses `stdio: ["ignore","pipe",
 * "pipe"]`, so it cannot carry MCP stdin). The child leads its OWN process
 * group (`detached: true`) so teardown can kill the whole tree (a
 * sandbox-exec→server or bwrap→server tree, not just the direct child).
 *
 * Sandbox (per-server `sandbox: true`, OFF by default — §5.4):
 *   - darwin → `generateBashSandboxPolicy` (Seatbelt), spawned as
 *     `sandbox-exec -f <policy> <command> <args…>` (the command is exec'd
 *     directly, NOT through a shell — the policy is file-confined,
 *     network-open, the same profile as bash).
 *   - linux  → `buildBwrapArgs` (Bubblewrap) invoked DIRECTLY with the
 *     already-merged MCP env (NOT via `spawnLinuxSandboxedBash` /
 *     `buildBwrapChildEnv`, which are bash-only and would re-scrub the env
 *     and drop the explicit `env` entries / defeat `inheritEnv` — the
 *     documented exception, §4.1). The merged env reaches the child via
 *     `--clearenv` + one `--setenv` per key (exactly the merged env, no
 *     parent leakage).
 *   - FAIL-CLOSED: `sandbox: true` with an unavailable backend (or a
 *     missing sandbox-exec/bwrap binary) fails startup with an explicit
 *     reason — it NEVER falls back to an unsandboxed spawn.
 *   - inherited sandbox (`TRE_SANDBOX=1` in the parent): no wrapper is
 *     applied (the enclosing policy is inherited as-is; a nested
 *     sandbox_apply would EPERM) — this is NOT a sandbox-unavailable
 *     failure, so it does not fail-closed.
 *
 * Teardown (the bash.ts process-group pattern):
 *   - `kill()` — SYNCHRONOUS, immediate: SIGKILL the process group, then
 *     the child as fallback. Idempotent. Used on terminal failure and as
 *     the synchronous `process.exit` backstop.
 *   - `close()` — GRACEFUL, async: close stdin → wait for the GROUP to exit
 *     → SIGTERM group → wait → SIGKILL group → CONFIRM the whole group is
 *     gone. Escalation is on group liveness (a descendant outliving the
 *     leader is reaped, not leaked). Resolves only when the group is
 *     confirmed gone; rejects if it survives the kill bound. Idempotent.
 *     Used on clean shutdown / handled signals / restart.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateBashSandboxPolicy,
  sandboxExecPath,
  bashSandboxAvailable,
} from "../tools/sandbox.js";
import {
  buildBwrapArgs,
  createEmptyRootSkeleton,
  bwrapPath,
  linuxSandboxAvailable,
} from "../tools/sandbox-linux.js";

/** Graceful-close wait between each step (scope §4.4: 2s). */
const MCP_CLOSE_STEP_MS = 2000;

/** Bound on waiting for the child's exit event after SIGKILL. SIGKILL is
 *  effectively immediate; this only guards against a child the kernel has
 *  not yet reaped (or a wedged exit event). */
const MCP_KILL_WAIT_MS = 2000;

/** A spawned MCP server child + its teardown handles. The client consumes
 *  `stdin`/`stdout`/`stderr` (persistent pipes) and calls `close`/`kill`. */
export interface McpSpawn {
  child: ChildProcess;
  /** The child's stdin (persistent pipe — always present). */
  stdin: Writable;
  /** The child's stdout (persistent pipe — always present). */
  stdout: Readable;
  /** The child's stderr (persistent pipe — always present). */
  stderr: Readable;
  /** Graceful, awaitable: stdin EOF → exit, escalating to SIGTERM/SIGKILL.
   *  Resolves when the escalation is DONE. Idempotent (one shared chain). */
  close(): Promise<void>;
  /** Immediate: SIGKILL the process group (then the child). Idempotent. */
  kill(): void;
  /** Release the sandbox policy file / empty-root dir. Idempotent,
   *  best-effort. */
  dispose(): Promise<void>;
}

export interface McpSpawnOptions {
  /** The server's resolved `cwd` (the child's working directory; NOT a
   *  sandbox root). */
  cwd: string;
  /** The fully-constructed child env (three layers + marker layer, from
   *  `mcpChildEnv`). Passed to the child AS-IS. */
  env: Record<string, string>;
  /** `sandbox: true` from the server config. */
  sandbox: boolean;
  /** The validated workspace (the sandbox's rw working dir / confinement
   *  root). */
  workspace: string;
  /** Validated extra roots (re-allowed in the policy, like bash). */
  extraRoots?: string[];
  /** The parent process already runs under a kernel policy
   *  (`TRE_SANDBOX=1`) — no wrapper is applied (inherited confinement). */
  inheritedSandbox: boolean;
}

/** Spawn an MCP server child. Resolves once the child is spawned (its pipes
 *  attached); REJECTS on a fail-closed sandbox failure (before any child is
 *  spawned) OR on a spawn-level failure (ENOENT/EACCES — the child's
 *  `error` event before the `spawn` ack, per-server startup isolation). A
 *  post-start transport death (the child dies mid-session) is NOT a spawn
 *  concern — the client detects it (stdout EOF → fail()). */
export async function spawnMcpServer(
  command: string,
  args: string[],
  opts: McpSpawnOptions,
): Promise<McpSpawn> {
  const platform = process.platform;
  const inherited = opts.inheritedSandbox;

  // ── Sandbox decision (fail-closed; never an unsandboxed fallback) ──────
  // inheritedSandbox: the enclosing policy is inherited as-is — no wrapper,
  // and NOT a failure (a nested sandbox_apply would EPERM).
  if (opts.sandbox && !inherited) {
    if (platform === "darwin") {
      if (!bashSandboxAvailable()) {
        throw new Error(
          "sandbox:true but the Seatbelt backend is unavailable (fail-closed — no unsandboxed fallback)",
        );
      }
      return spawnDarwinSandboxed(command, args, opts);
    }
    if (platform === "linux") {
      if (!linuxSandboxAvailable()) {
        throw new Error(
          "sandbox:true but the Bubblewrap backend is unavailable (fail-closed — no unsandboxed fallback)",
        );
      }
      return spawnLinuxSandboxed(command, args, opts);
    }
    // win32 (or any other platform): no sandbox backend exists.
    throw new Error(
      `sandbox:true but no sandbox backend exists on ${platform} (fail-closed — no unsandboxed fallback)`,
    );
  }

  // ── Unsandboxed (or inherited-sandbox) child ────────────────────────────
  // Plain spawn with the merged env. `detached: true` → the child leads its
  // own process group (so kill() can SIGKILL the whole tree).
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  await attachErrorGuard(child);
  return finish(child, async () => {});
}

/** Attach the child's `error` listener + await the spawn ack (scope §4.4:
 *  a spawn-level failure — ENOENT/EACCES — surfaces as the spawn's REJECTION
 *  (a startup error for THIS server, per-server isolation), never as an
 *  unhandled 'error' event that crashes the host).
 *
 * Two phases, ONE listener:
 *   - before the `spawn` ack: an `error` event is a spawn failure → the
 *     promise rejects (and the listener detaches — there is no child to
 *     watch anymore).
 *   - after the `spawn` ack: the same listener stays attached for the
 *     child's lifetime in SWALLOW mode — a post-start spawn error
 *     (ENOENT at exec time / EPERM delivery) is swallowed, never re-thrown
 *     (an uncaught rethrow would crash the host, the exact bug this guard
 *     exists to prevent). Transport death remains the CLIENT's detection
 *     job (stdout EOF → fail()); this listener is the crash PREVENTION. */
function attachErrorGuard(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let spawned = false;
    const onSpawn = (): void => {
      spawned = true; // the once() listener removes itself
      resolve(); // the child is up — the guard's job is done (the error
      // listener STAYS attached in swallow mode for the child's
      // lifetime: a post-start 'error' event is swallowed, never re-thrown).
    };
    const onError = (err: Error): void => {
      if (spawned) return; // post-start: swallowed, NOT thrown (see above).
      // Pre-spawn spawn failure: detach and reject — the caller fails THIS
      // server's startup (per-server isolation, §4.4).
      child.off("spawn", onSpawn);
      child.off("error", onError);
      reject(err);
    };
    child.once("spawn", onSpawn);
    child.on("error", onError);
  });
}

/** darwin `sandbox:true`: `sandbox-exec -f <policy> <command> <args…>`. */
async function spawnDarwinSandboxed(
  command: string,
  args: string[],
  opts: McpSpawnOptions,
): Promise<McpSpawn> {
  const sandboxExec = sandboxExecPath();
  if (!sandboxExec) {
    throw new Error(
      "sandbox:true but the sandbox-exec binary is not found (fail-closed)",
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "coding-agent-mcp-sb-"));
  const policyPath = join(
    dir,
    `policy-${randomBytes(8).toString("hex")}.sb`,
  );
  try {
    await writeFile(
      policyPath,
      generateBashSandboxPolicy(opts.workspace, opts.extraRoots ?? []),
      { mode: 0o600 },
    );
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  const child = spawn(sandboxExec, ["-f", policyPath, command, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  try {
    await attachErrorGuard(child);
  } catch (e) {
    // Spawn failed: release the policy file — the sandbox resource must not
    // outlive a server that never started.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return finish(child, async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
}

/** linux `sandbox:true`: bwrap invoked DIRECTLY with the merged MCP env
 *  (`--clearenv` + one `--setenv` per key — exactly the merged env, no
 *  parent leakage, no bash-only re-scrub). The command is exec'd directly
 *  (NOT via a shell — `buildBwrapArgs`'s `-- <shell> -c <command>` tail is
 *  replaced with `-- <command> <args…>`), and the child's `--chdir` is the
 *  server's `cwd` (the workspace is the confinement root, not the workdir). */
async function spawnLinuxSandboxed(
  command: string,
  args: string[],
  opts: McpSpawnOptions,
): Promise<McpSpawn> {
  const binary = bwrapPath();
  if (!binary) {
    throw new Error(
      "sandbox:true but the bwrap binary is not found (fail-closed)",
    );
  }
  const emptyRoot = await mkdtemp(join(tmpdir(), "coding-agent-mcp-bw-"));
  try {
    createEmptyRootSkeleton(emptyRoot, opts.workspace, opts.extraRoots ?? []);
  } catch (e) {
    await rm(emptyRoot, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  // buildBwrapArgs emits the mount ops + `--chdir <workspace>` + unshare
  // flags + `-- <shell> -c <command>`. Rebuild the tail to exec the command
  // directly and chdir to the server's cwd.
  const base = buildBwrapArgs({
    command: command,
    cwd: opts.workspace,
    extraRoots: opts.extraRoots ?? [],
    emptyRoot,
    shell: command,
  });
  // baseWithoutTail = the mount ops + `--chdir <cwd>` + unshare flags, with
  // the `-- <shell> -c <command>` tail dropped and the chdir target swapped
  // to the server's cwd.
  const baseWithoutTail: string[] = [];
  for (let i = 0; i < base.length; i++) {
    const a = base[i]!;
    if (a === "--") break; // drop the `-- <shell> -c <command>` tail
    if (a === "--chdir") {
      baseWithoutTail.push("--chdir", opts.cwd);
      i++; // skip the original <workspace>
      continue;
    }
    baseWithoutTail.push(a);
  }
  // --clearenv + one --setenv per merged key (the merged env is passed
  // directly, NOT re-scrubbed through buildBwrapChildEnv). These are bwrap
  // OPTIONS — they must precede the `--` command separator.
  const envArgs: string[] = ["--clearenv"];
  for (const [k, v] of Object.entries(opts.env)) {
    if (v !== undefined && v !== null) envArgs.push("--setenv", k, String(v));
  }
  const fullArgs = [...baseWithoutTail, ...envArgs, "--", command, ...args];
  const child = spawn(binary, fullArgs, {
    cwd: opts.cwd,
    env: opts.env, // bwrap's own env (its internal needs); the CHILD env is
    // the --setenv set above.
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  try {
    await attachErrorGuard(child);
  } catch (e) {
    // Spawn failed: release the empty-root skeleton — it must not outlive a
    // server that never started.
    await rm(emptyRoot, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return finish(child, async () => {
    await rm(emptyRoot, { recursive: true, force: true }).catch(() => {});
  });
}

/** Shared: attach the process-group teardown + dispose to a running child.
 *  `dispose` releases the sandbox policy file / empty-root dir. */
function finish(
  child: ChildProcess,
  dispose: () => Promise<void>,
): McpSpawn {
  let disposed = false;
  // Cached graceful-close chain: repeated close() awaits THE SAME chain
  // instead of racing step timers (double SIGTERM/SIGKILL mid-flight is
  // harmless, but awaiting a stale chain could report completion before the
  // escalation finished).
  let closeChain: Promise<void> | null = null;

  // Synchronous, immediate kill: SIGKILL the process group (the child is
  // detached, so the group id IS the child's pid), then the child as
  // fallback (Windows / already-dead group). Idempotent.
  const kill = () => {
    if (child.pid !== undefined && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        /* group already gone — fall through to the single-child kill */
      }
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  };

  // A process group has no single "all members exited" event (the leader's
  // 'exit' fires for the leader only; descendants are reaped independently as
  // they die). So group liveness is PROBED: `kill(-pid, 0)` succeeds while
  // ANY member of the group is alive. ESRCH → the whole group is gone;
  // EPERM → the group exists but we lack permission (treat as alive). Probing
  // the GROUP (not just the leader's exitCode) is what catches a descendant
  // that outlives the leader on stdin EOF — the audit's leak.
  const groupAlive = (): boolean => {
    if (child.pid !== undefined && process.platform !== "win32") {
      try {
        process.kill(-child.pid, 0); // signal 0 = liveness probe (no signal)
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    // win32 / no pid: fall back to the leader's exit state.
    return child.exitCode === null && child.signalCode === null;
  };

  // Poll (bounded) until the WHOLE group is gone. Resolves `true` when the
  // group has fully exited, `false` when the bound expires with the group
  // still alive. The bound keeps a pathological unkillable group from
  // hanging shutdown; a `false` result means "could not confirm termination"
  // (the caller decides how to treat it — close() treats it as a failure,
  // NOT a success).
  const waitForGroupGoneBounded = (ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (!groupAlive()) return resolve(true);
      let settled = false;
      const done = (gone: boolean): void => {
        if (settled) return;
        settled = true;
        clearInterval(iv);
        clearTimeout(timer);
        resolve(gone);
      };
      const iv = setInterval(() => {
        if (!groupAlive()) done(true);
      }, 50);
      const timer = setTimeout(() => done(!groupAlive()), ms);
    });

  // Graceful, AWAITABLE, idempotent: close stdin → wait for the group to
  // exit → SIGTERM the group → wait → SIGKILL the group → CONFIRM the whole
  // group is gone. Escalation is based on GROUP liveness (not just the
  // leader's exit) so a descendant that outlives the leader is escalated and
  // reaped, not leaked. The returned promise RESOLVES only when the group is
  // confirmed gone; it REJECTS if the group survives the SIGKILL bound (an
  // unconfirmed termination is a failure, not a silent success). Repeated
  // calls return the SAME in-flight chain (no double escalation).
  const close = (): Promise<void> => {
    if (closeChain) return closeChain;
    const chain: Promise<void> = (async () => {
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
      // Give the group a chance to exit on stdin EOF (poll up to the step).
      const exitedOnEof = await waitForGroupGoneBounded(MCP_CLOSE_STEP_MS);
      if (exitedOnEof) return;
      // Group still alive (leader or descendants) → SIGTERM the group.
      try {
        if (child.pid !== undefined && process.platform !== "win32") {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        /* already dead */
      }
      const termGone = await waitForGroupGoneBounded(MCP_CLOSE_STEP_MS);
      if (termGone) return;
      // Still alive after SIGTERM → SIGKILL the group, then CONFIRM the whole
      // group is gone (bounded). If it isn't gone within the bound, reject —
      // "close resolved" must really mean "group gone".
      kill();
      const killedGone = await waitForGroupGoneBounded(MCP_KILL_WAIT_MS);
      if (!killedGone) {
        throw new Error(
          "MCP spawn: process group did not exit within the kill bound after SIGKILL (unconfirmed termination — possible leaked descendants)",
        );
      }
    })();
    closeChain = chain;
    // A FAILED chain (the group survived SIGKILL) is not cached: the next
    // close() re-runs the escalation, so a retry can actually re-confirm.
    chain.catch(() => {
      if (closeChain === chain) closeChain = null;
    });
    return chain;
  };

  const disposeFn = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await dispose();
  };

  // The spawn always uses piped stdio, so the streams are present; assert
  // non-null (a null here is a programming error, not a runtime state).
  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    throw new Error("MCP spawn: expected piped stdio (a stream is missing)");
  }
  return {
    child,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    close,
    kill,
    dispose: disposeFn,
  };
}
