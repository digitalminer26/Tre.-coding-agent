/**
 * WS12 — MCP support: config + child-env construction (scope:
 * docs/10-mcp-scope.md §4.1, the single source of truth for the env
 * contract).
 *
 * Two concerns, both pure (no I/O here — the tre.json walk is C36's
 * `findTreConfig`/`loadTreConfig`):
 *
 *   1. `validateMcpServers` — startup validation of the parsed
 *      `mcpServers` map (fail-closed, exit-2 posture, like `extraRoots`):
 *      `command` present, `cwd` resolves to an EXISTING directory relative
 *      to the launch dir, no sandbox-root grant for `cwd` (scope §4.1:
 *      "is NOT added to sandbox roots" — the confinement roots are the
 *      validated workspace + extra roots, independent of `cwd`).
 *
 *   2. `buildMcpChildEnv` — the three-layer child env (scope §4.1, in
 *      order):
 *        (1) the allowlisted baseline — `BWRAP_ENV_ALLOWLIST` imported from
 *            `tools/sandbox-linux.ts` (the SAME list; do not copy it);
 *        (2) the explicit per-server `env` entries (win over baseline;
 *            forward-declared variables the parent does not have are passed
 *            as declared);
 *        (3) `inheritEnv: true` ADDS the full parent environment UNDER the
 *            explicit entries (explicit `env` wins; the parent env may hold
 *            tokens/keys — documented credential-exposure warning).
 *      Then `markerEnv` (the FINAL layer, applied LAST, non-overridable)
 *      wins over any explicit `env` or inherited value of the same name:
 *        - `TRE_SANDBOX=1` — the child runs under a kernel policy, directly
 *          (`sandbox: true`) or inherited (the parent already has
 *          `TRE_SANDBOX=1`, WS11/D12 nesting); NOT set for an unsandboxed
 *          child with no inherited sandbox — and in NO case can a server
 *          `env` entry set it to a falsified value;
 *        - `GIT_CONFIG_NOSYSTEM=1` — every child (the system git config is
 *          denied by the policy; an unreadable-but-present `/etc/gitconfig`
 *          is fatal to git — EPERM is not the ENOENT it gets where the file
 *          is absent);
 *        - `TMPDIR=/tmp` — ONLY linux `sandbox: true` children (the bwrap
 *          rootfs is new and the host TMPDIR does not exist there);
 *        - PATH fallback — linux, when the merged env has no usable PATH
 *          (`BWRAP_DEFAULT_PATH`).
 *
 * `markerEnv` is a NEW function, separate from `buildBwrapChildEnv`
 * (bash-only — it re-applies the allowlist and would silently drop the
 * explicit `env` entries and defeat `inheritEnv`; the bwrap invocation gets
 * the already-merged env directly, scope §4.1/§5.4).
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  BWRAP_DEFAULT_PATH,
  BWRAP_ENV_ALLOWLIST,
} from "../tools/sandbox-linux.js";
import type { McpServerConfig } from "../config/tre-config.js";

/** Startup validation (fail-closed, like a bad `extraRoots`): returns a
 *  human-readable reason per offending server, `[]` when the map is
 *  valid. `launchDir` is the resolved launch directory — relative `cwd`
 *  values resolve against it. A server with `disabled: true` is still
 *  validated (a disabled server with a broken `cwd` is a config error the
 *  user should fix, not a silent skip). */
export function validateMcpServers(
  servers: Record<string, McpServerConfig>,
  launchDir: string,
): string[] {
  const errors: string[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (typeof cfg.command !== "string" || cfg.command.trim().length === 0) {
      errors.push(`mcpServers["${name}"].command must be a non-empty string`);
      continue;
    }
    const cwd = resolveMcpCwd(cfg.cwd, launchDir);
    if (!existsSync(cwd)) {
      errors.push(`mcpServers["${name}"].cwd does not exist: ${cwd}`);
    } else if (!isDir(cwd)) {
      errors.push(`mcpServers["${name}"].cwd is not a directory: ${cwd}`);
    }
  }
  return errors;
}

/** Resolve a server `cwd` against the launch directory (scope §4.1:
 *  "`cwd` resolves relative to the launch directory"). Empty (the parse
 *  default) → the launch directory itself. Absolute paths pass through
 *  (resolved, for a canonical form). */
export function resolveMcpCwd(cwd: string, launchDir: string): string {
  if (cwd === "" || cwd === undefined) return resolve(launchDir);
  return isAbsolute(cwd) ? resolve(cwd) : resolve(launchDir, cwd);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The final, non-overridable marker layer (scope §4.1). Applied LAST, over
 *  the merged three-layer env; a marker key set by an explicit `env` entry
 *  or inherited parent value is IGNORED for that key — the marker wins.
 *  `inheritedSandbox` = the parent process already runs under a kernel
 *  policy (`TRE_SANDBOX=1` in the parent env, WS11/D12 nesting semantics).
 *  Pure: returns a NEW object, never mutates `merged`. */
export function markerEnv(
  merged: Record<string, string>,
  opts: { sandbox: boolean; inheritedSandbox: boolean; platform: NodeJS.Platform },
): Record<string, string> {
  const out: Record<string, string> = { ...merged };
  // TRE_SANDBOX — directly sandboxed OR inherited enclosing sandbox. A
  // falsified explicit/inherited value ("0") is overwritten when the marker
  // applies; when it does not apply, the key is REMOVED (a server env entry
  // cannot claim a sandbox tre. did not put there).
  if (opts.sandbox || opts.inheritedSandbox) {
    out.TRE_SANDBOX = "1";
  } else {
    delete out.TRE_SANDBOX;
  }
  // GIT_CONFIG_NOSYSTEM — every child (cheap, harmless when unsandboxed).
  out.GIT_CONFIG_NOSYSTEM = "1";
  if (opts.platform === "linux" && opts.sandbox) {
    // bwrap rootfs is new — the host TMPDIR does not exist there.
    out.TMPDIR = "/tmp";
  }
  if (opts.platform === "linux") {
    // The merged env may have no usable PATH (the baseline carries the
    // parent's PATH only when present; an explicit env may have removed
    // it) — the child must still be able to find its binaries.
    if (out.PATH === undefined || out.PATH === "") out.PATH = BWRAP_DEFAULT_PATH;
  }
  return out;
}

/** The three-layer child env (scope §4.1), BEFORE the marker layer.
 *  `parentEnv` is the tre. process env (only consulted when
 *  `inheritEnv: true` — the baseline layer reads it too, for the
 *  allowlisted keys, which is the documented baseline behavior). */
export function buildMcpChildEnv(
  cfg: Pick<McpServerConfig, "env" | "inheritEnv">,
  parentEnv: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  // Layer 1 — the allowlisted baseline (the SAME list bwrap children get;
  // a missing/empty parent PATH is NOT patched here — the PATH fallback is
  // a linux-sandbox marker, applied in `markerEnv`).
  for (const k of BWRAP_ENV_ALLOWLIST) {
    const v = parentEnv[k];
    if (v !== undefined) env[k] = v;
  }
  // Layer 2 — explicit per-server entries win over the baseline.
  for (const [k, v] of Object.entries(cfg.env ?? {})) env[k] = v;
  // Layer 3 — inheritEnv ADDS the full parent env UNDER the explicit
  // entries (explicit wins; only keys not already present are added).
  if (cfg.inheritEnv) {
    for (const [k, v] of Object.entries(parentEnv)) {
      if (v !== undefined && env[k] === undefined) env[k] = v;
    }
  }
  return env;
}

/** Full child env for a server: three layers + the marker layer.
 *  `inheritedSandbox` = `parentEnv.TRE_SANDBOX === "1"` (the caller passes
 *  it in so the function stays pure and testable). */
export function mcpChildEnv(
  cfg: Pick<McpServerConfig, "env" | "inheritEnv" | "sandbox">,
  parentEnv: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const merged = buildMcpChildEnv(cfg, parentEnv);
  return markerEnv(merged, {
    sandbox: cfg.sandbox,
    inheritedSandbox: parentEnv.TRE_SANDBOX === "1",
    platform,
  });
}
