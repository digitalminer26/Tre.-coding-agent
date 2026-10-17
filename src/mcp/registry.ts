/**
 * WS12 — MCP server registry (scope: docs/10-mcp-scope.md §4.3/§4.4/§6/§7).
 *
 * The testable core of the CLI wiring: it starts the configured stdio
 * servers (spawn → client → startup → tool import), tracks each server's
 * §4.4 state (`disabled | starting | ready | failed`, with reason), and
 * owns the PROCESS-GROUP teardown + sandbox-resource release the client
 * does not (the client tears down its transport; the registry releases the
 * spawn's policy file / empty-root dir and drives the graceful close).
 *
 * Per-server isolation (§4.4): one server's startup failure NEVER aborts
 * the launch — it is marked `failed` (its tools absent), the others
 * proceed. A terminal startup failure is a FULL teardown: the client
 * rejects its pending requests and kills the transport; the registry
 * releases the sandbox resources (the client's `fail` does not `dispose`).
 *
 * Teardown (the bash.ts process-group pattern, §4.4):
 *   - `teardown()` — GRACEFUL, async, idempotent: client.close() (settles
 *     pending + starts the graceful close) + AWAIT the spawn's close chain
 *     (confirm the group is gone) + spawn.dispose() (releases the policy
 *     file / empty-root dir). Resolves when the group is confirmed gone;
 *     REJECTS if the group survives the SIGKILL bound (unconfirmed
 *     termination). Used on clean shutdown (the `finally` block, every exit
 *     path) and /restart.
 *   - `killAll()` — SYNCHRONOUS, idempotent: client.kill() (settle pending +
 *     detach + the synchronous group-SIGKILL via the transport) +
 *     spawn.kill() + spawn.dispose() (best-effort, fire-and-forget). The
 *     backstop for immediate `process.exit` paths — it must not await.
 *
 * `startMcpServers` takes an INJECTED `spawnFn` (the real `spawnMcpServer`,
 * or a mock in tests) so the whole start/import/teardown lifecycle is
 * testable without a child process.
 */
import type { McpServerConfig } from "../config/tre-config.js";
import { resolveMcpCwd, mcpChildEnv } from "./config.js";
import {
  McpClient,
  type McpState,
  type McpTool,
  type McpToolCallResult,
  type McpTransport,
} from "./client.js";
import {
  importMcpServerTools,
  makeMcpResourceTool,
  type AdaptedMcpTool,
  type McpCallFn,
} from "./adapter.js";
import type { McpSpawn } from "./spawn.js";
import type { Tool } from "../types.js";

/** A per-server handle: its §4.4 state, its imported tools, and its
 *  teardown handles. `client`/`spawn` are present for a started server
 *  (absent when `disabled`). */
export interface McpServerHandle {
  name: string;
  state: McpState;
  reason: string;
  /** The imported (adapted) tools — empty until `ready`. */
  tools: AdaptedMcpTool[];
  client: McpClient | null;
  spawn: McpSpawn | null;
  /** GRACEFUL, async, idempotent (clean shutdown / restart). Resolves when
   *  the group is confirmed gone. REJECTS if the group survives the SIGKILL
   *  bound (an unconfirmed termination) — callers must not treat that as a
   *  clean shutdown. */
  teardown(): Promise<void>;
  /** SYNCHRONOUS, idempotent (the `process.exit` backstop). */
  kill(): void;
}

/** The result of `startMcpServers`: one handle per configured server
 *  (disabled servers included) + the flat list of imported tools to
 *  register (additive to the built-in set). */
export interface McpStartResult {
  handles: McpServerHandle[];
  /** The flat list of tools to register (additive to the built-in set): the
   *  per-server imported tools PLUS, when ≥1 server is ready, the single
   *  `mcp_resource` tool (tier 2 — resources). */
  tools: Tool[];
}

export interface McpStartOptions {
  /** The resolved launch directory (the `cwd` resolution base). */
  launchDir: string;
  /** The validated workspace (the sandbox's rw confinement root). */
  workspace: string;
  /** Validated extra roots (re-allowed in the policy, like bash). */
  extraRoots: string[];
  /** The parent process env (the three-layer child env's source). */
  parentEnv: Record<string, string | undefined>;
  /** The built-in tool names (seeded into `claimed` so an MCP wire name can
   *  never shadow a built-in — the atomic-rejection collision set, §4.3). */
  builtinNames?: string[];
  /** The client timing overrides (defaults in tests). */
  clientOpts?: {
    callTimeoutMs?: number;
    probeTimeoutMs?: number;
    startupBudgetMs?: number;
    stallMs?: number;
  };
}

/** The spawn seam (the real `spawnMcpServer`, or a mock in tests). */
export type McpSpawnFn = (
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    sandbox: boolean;
    workspace: string;
    extraRoots: string[];
    inheritedSandbox: boolean;
  },
) => Promise<McpSpawn>;

/** Every spawn created by a startup that has not been torn down yet — BOTH
 *  the servers still starting AND the ones already ready while a sibling is
 *  still starting. Module-level so the process backstop (installed before any
 *  spawn) can reach all of them. A spawn leaves this set only when its
 *  process group is confirmed gone by close(). Sending a kill is NOT proof
 *  of termination, so emergency kills retain ownership for later backstops. */
const liveSpawns = new Set<McpSpawn>();

/** SYNCHRONOUS, idempotent: SIGKILL every live spawn — startup-pending,
 *  startup-ready, or owned by a not-yet-torn-down result. The process-exit /
 *  signal backstop. Safe to call with nothing live. */
export function reapPendingSpawns(): void {
  for (const s of liveSpawns) {
    try {
      s.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Kill a failed startup, then confirm termination before releasing ownership
 *  or sandbox resources. Failure stays registered for the process backstop. */
async function cleanupFailedSpawn(spawn: McpSpawn): Promise<void> {
  spawn.kill();
  await spawn.close();
  liveSpawns.delete(spawn);
  await spawn.dispose();
}

/** Start every configured server (per-server isolation: one failure never
 *  aborts the launch). Returns one handle per server (disabled included) +
 *  the flat list of imported tools. */
export async function startMcpServers(
  servers: Record<string, McpServerConfig>,
  spawnFn: McpSpawnFn,
  opts: McpStartOptions,
): Promise<McpStartResult> {
  const handles: McpServerHandle[] = [];
  const tools: Tool[] = [];
  // Seed `claimed` with the built-in names so an MCP wire name can never
  // shadow a built-in (the atomic-rejection collision set, §4.3).
  const claimed = new Set<string>(opts.builtinNames ?? []);

  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.disabled) {
      handles.push(makeDisabledHandle(name));
      continue;
    }
    let spawn: McpSpawn | null = null;
    let client: McpClient | null = null;
    let imported: AdaptedMcpTool[] = [];
    let reason = "";
    let state: McpState = "starting";
    try {
      const cwd = resolveMcpCwd(cfg.cwd, opts.launchDir);
      const env = mcpChildEnv(cfg, opts.parentEnv, process.platform);
      spawn = await spawnFn(cfg.command, cfg.args ?? [], {
        cwd,
        env,
        sandbox: cfg.sandbox,
        workspace: opts.workspace,
        extraRoots: opts.extraRoots,
        inheritedSandbox: opts.parentEnv.TRE_SANDBOX === "1",
      });
      // Registered as pending the moment it exists: a signal during the
      // startup await below must still reap it (no handle owns it yet).
      liveSpawns.add(spawn);
      client = new McpClient(name, spawnTransport(spawn), opts.clientOpts ?? {});
      const allTools: McpTool[] = await client.start();
      // Per-server tool allowlist (§4.1): a non-empty `tools` list restricts
      // the import to the named tools (the MCP-scoped equivalent of --tools).
      const allow = new Set(cfg.tools ?? []);
      const mcpTools: McpTool[] =
        allow.size > 0 ? allTools.filter((t) => allow.has(t.name)) : allTools;
      const call: McpCallFn = makeCallFn(client, name);
      const outcome = importMcpServerTools(name, mcpTools, call, claimed, {
        trusted: cfg.trust,
      });
      if (outcome.rejected) {
        // A residual collision → atomic rejection of THIS server (the others
        // continue). The client is torn down (a rejected import is a startup
        // failure — the server must not be left running).
        reason = `tool import rejected: ${outcome.rejected.conflicting.join(", ")}`;
        state = "failed";
        client.kill(); // a rejected import is a startup FAILURE — kill, don't close gracefully
        let cleaned = false;
        try {
          await cleanupFailedSpawn(spawn);
          cleaned = true;
        } catch (e) {
          reason += `; cleanup unconfirmed: ${e instanceof Error ? e.message : String(e)}`;
        }
        handles.push(
          makeHandle(name, state, reason, [], client, spawn, cleaned),
        );
        continue;
      }
      outcome.imported.forEach((it) => claimed.add(it.wireName));
      imported = outcome.imported.map((it) => it.tool);
      tools.push(...imported);
      state = "ready";
    } catch (e) {
      // A startup failure (spawn rejection, probe/handshake error, timeout,
      // pagination limit, admission failure). FULL teardown: the client has
      // already rejected its pending + killed the transport (its `fail`);
      // the kill() here is the defensive no-op arm (a client that exists
      // but never failed — kill it the same way). Release the sandbox
      // resources (the client's `fail` does not dispose).
      reason = e instanceof Error ? e.message : String(e);
      state = "failed";
      if (client) client.kill();
      let cleaned = spawn === null;
      if (spawn) {
        try {
          await cleanupFailedSpawn(spawn);
          cleaned = true;
        } catch (cleanupError) {
          reason += `; cleanup unconfirmed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
        }
      }
      handles.push(makeHandle(name, state, reason, [], client ?? null, spawn ?? null, cleaned));
      continue;
    }
    const readyHandle = makeHandle(name, state, reason, imported, client, spawn, false);
    if (state === "ready" && client) {
      // Ready-state terminal failure (stdout EOF / write error / framing
      // violation AFTER startup): the client's fail() kills the transport,
      // but the REGISTRY must also run its FULL teardown — confirm the group
      // is gone, release the sandbox policy file / empty-root dir, and drop
      // the liveSpawns entry. Without this, those stayed owned until the
      // user quit or /restarts. The handle's teardown() is idempotent (one
      // cached chain), so this hook and a later teardownAll() share it.
      // Fire-and-forget: fail() is synchronous; a teardown rejection is
      // swallowed here (the process-exit backstop still covers an
      // unconfirmed group).
      client.onTerminalFailure = () => {
        void readyHandle.teardown().catch(() => {});
      };
    }
    handles.push(readyHandle);
  }
  // The single `mcp_resource` tool (tier 2 — resources): ONE tool for ALL
  // ready servers, appended ONLY IF at least one server reached `ready`.
  // It is NOT per-server, so the per-server `tools` allowlist does NOT apply
  // to it (it is tre.'s own fixed-name tool, not a server-provided one).
  // The lookup covers EVERY handle (ready for calls; all for the not-found
  // error message) so the model can self-correct on a wrong server name.
  if (handles.some((h) => h.state === "ready")) {
    const lookup = (serverName: string) => {
      const h = handles.find((x) => x.name === serverName);
      return h ? { client: h.client, state: h.state, reason: h.reason } : null;
    };
    const serverInfo = handles.map((h) => ({
      name: h.name,
      state: h.state,
      reason: h.reason,
    }));
    tools.push(makeMcpResourceTool(lookup, serverInfo));
  }
  return { handles, tools };
}

/** The transport the client speaks over (the spawn's persistent pipes +
 *  teardown handles). */
function spawnTransport(spawn: McpSpawn): McpTransport {
  return {
    stdin: spawn.stdin,
    stdout: spawn.stdout,
    stderr: spawn.stderr,
    close: () => {
      // Fire-and-forget from the client's graceful close. A FAILED chain
      // (group survived SIGKILL) must not become an unhandled rejection: the
      // awaited teardown() path reports it, and the retry re-runs the chain.
      spawn.close().catch(() => {});
    },
    kill: () => spawn.kill(),
  };
}

/** The adapter's call seam: invoke the server's tool by its ORIGINAL name
 *  and return the client's mapped result. The abort signal is attached to the
 *  exact request created for this call (not merely its tool name), so parallel
 *  invocations of the same tool cannot cancel one another. */
function makeCallFn(client: McpClient, serverName: string): McpCallFn {
  return (toolName, args, signal) => client.callTool(toolName, args, signal);
}

function makeDisabledHandle(name: string): McpServerHandle {
  return {
    name,
    state: "disabled",
    reason: "",
    tools: [],
    client: null,
    spawn: null,
    teardown: async () => {},
    kill: () => {},
  };
}

function makeHandle(
  name: string,
  state: McpState,
  reason: string,
  tools: AdaptedMcpTool[],
  client: McpClient | null,
  spawn: McpSpawn | null,
  alreadyTornDown: boolean,
): McpServerHandle {
  let confirmedGone = alreadyTornDown;
  // Cached graceful teardown: repeated callers await the SAME in-flight
  // promise. Crucially, `kill()` is NOT gated on this promise — a host exit
  // during a graceful shutdown must still SIGKILL the group (the audit's
  // finding: a `disposed` flag set before the await disabled the backstop).
  let teardownP: Promise<void> | null = alreadyTornDown ? Promise.resolve() : null;
  const teardown = (): Promise<void> => {
    if (teardownP) return teardownP;
    const attempt: Promise<void> = (async () => {
      // client.close() is the GRACEFUL arm: it starts the spawn's close chain
      // (stdin EOF → group exits → SIGTERM → SIGKILL → confirm group gone).
      // AWAIT that chain BEFORE disposing sandbox resources (the group may
      // still hold the policy file / empty-root dir open).
      client?.close();
      if (spawn) {
        // The client's transport.close() and this spawn.close() share ONE
        // chain, so awaiting it here is the same chain — and if it REJECTS
        // (the group survived the SIGKILL bound — an UNCONFIRMED termination)
        // we must NOT silently proceed: dispose would race a live group, and
        // the caller must be told the teardown did not fully succeed.
        await spawn.close();
      }
      confirmedGone = true;
      if (spawn) liveSpawns.delete(spawn);
      if (spawn) await spawn.dispose();
    })();
    teardownP = attempt;
    // A FAILED attempt (unconfirmed group) must be retryable: drop the cached
    // rejection so the next teardown() re-runs the close chain instead of
    // replaying the old failure. A success stays cached (idempotent).
    attempt.catch(() => {
      if (teardownP === attempt) teardownP = null;
    });
    return attempt;
  };
  const kill = (): void => {
    if (confirmedGone) return;
    // Synchronous backstop (the `process.exit` path — no await allowed):
    // SIGKILL NOW, regardless of an in-flight graceful teardown. Every
    // operation here is idempotent, so a repeat after a completed teardown
    // is harmless.
    client?.kill();
    // Repeatable until close() confirms termination. Do not dispose sandbox
    // resources or unregister a possibly-live group merely because kill ran.
    if (spawn) spawn.kill();
  };
  return { name, state, reason, tools, client, spawn, teardown, kill };
}

/** GRACEFUL, async, idempotent: tear down EVERY server (the clean-shutdown
 *  path — the `finally` block, every exit path, /restart). Runs the
 *  per-server teardowns concurrently (each is independent) and AWAITs ALL of
 *  them (every group is reaped, even if one fails). RESOLVES when every group
 *  is confirmed gone; REJECTS with a combined error if ANY group survived the
 *  SIGKILL bound (an unconfirmed termination the caller must not treat as a
 *  clean shutdown). */
export async function teardownAll(result: McpStartResult): Promise<void> {
  const results = await Promise.allSettled(
    result.handles.map((h) => h.teardown()),
  );
  const failures = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
  if (failures.length > 0) {
    throw new Error(`MCP teardown did not fully complete: ${failures.join("; ")}`);
  }
}

/** SYNCHRONOUS, idempotent: kill EVERY server's process group (the
 *  `process.exit` backstop — must not await). */
export function killAll(result: McpStartResult): void {
  for (const h of result.handles) h.kill();
}

/** The §7 `/mcp` status line for one server. State/reason are read LIVE
 *  from the client (not the startup snapshot): a server that died after a
 *  clean ready (stdout EOF → client fail) reports `failed` here — the old
 *  behavior kept saying `ready` for a dead process. Disabled/disconnected
 *  handles (no client) report their own state. */
export function mcpStatusLine(h: McpServerHandle): string {
  // A registry-level failure (rejected import, startup failure) is final and
  // keeps its reason. Otherwise the client's LIVE state wins: a server that
  // died after ready (fail() → closed) must read `failed`, not the stale
  // startup snapshot `ready`.
  let { state, reason } = h;
  if (h.state !== "failed" && h.client) ({ state, reason } = h.client.getState());
  switch (state) {
    case "ready":
      return `${h.name} — ready (${h.tools.length} tool${h.tools.length === 1 ? "" : "s"})`;
    case "starting":
      return `${h.name} — starting`;
    case "failed":
      return `${h.name} — failed (${reason || h.reason})`;
    case "disabled":
      return `${h.name} — disabled`;
    default:
      return `${h.name} — ${state}`;
  }
}
