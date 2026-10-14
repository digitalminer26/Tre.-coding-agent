/**
 * C36 — tre.json: durable, per-project configuration.
 *
 * Fields:
 *   - `extraRoots` (C35 durability): the explicitly assigned additional
 *     read/write roots that today must be re-passed as `--extra-root <dir>`
 *     on every launch. tre.json persists them, so a project's boundary is
 *     part of the project.
 *   - `mcpServers` (WS12): durable MCP server configs
 *     (docs/10-mcp-scope.md §4.1) — same walk-up lookup, same fail-closed
 *     parse posture.
 *
 * tre.json shape:
 *   { "extraRoots": [ "/abs/or/~/relative/dir", ... ],
 *     "mcpServers": { "fs": { "command": "npx", "args": [...], ... } } }
 *
 * Entries may start with `~` or `~/` (expanded against the home dir at
 * startup, like a shell) — e.g. `"~/kubeconfigs"`. `~` alone means the home
 * dir itself. A bare `~name` is NOT expanded (no user-lookup — it would
 * resolve to the literal `~name` path and fail the exists check, fail-closed).
 *
 * Lookup (mirrors D19's models.json convention): walk UP from the launch
 * directory looking for a `tre.json` — the same convention as a `.git`
 * directory or a `models.json` — then fall back to the permanent home
 * location `~/.tre/tre.json`. A found file is read LENIENTLY: a missing or
 * empty `extraRoots` is an empty list; a malformed value (non-array /
 * non-string entry) is a startup error (exit 2) — the same fail-closed
 * posture as a bad `--extra-root`, never a silent ignore.
 *
 * Precedence: the CLI flag wins — `--extra-root` entries are APPENDED after
 * the tre.json entries (both are validated; a bad tre.json entry refuses the
 * startup just like a bad flag). So tre.json is the durable baseline and the
 * flag is the per-launch override/addition.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface TreConfig {
  /** Durable extra roots (C35). Each entry is validated at startup exactly
   *  like a `--extra-root` value (exists, non-sensitive, under home). */
  extraRoots: string[];
  /** WS12: durable MCP server configs (docs/10-mcp-scope.md §4.1). Parsed
   *  leniently (absent → empty map) and validated fail-closed at startup by
   *  `validateMcpServers` in `src/mcp/config.ts` — the same posture as
   *  `extraRoots` (a malformed entry refuses startup, never a silent
   *  ignore). */
  mcpServers: Record<string, McpServerConfig>;
}

/** One `mcpServers` entry in tre.json (WS12, scope §4.1). `command` is
 *  required; every other key is optional with a documented default. */
export interface McpServerConfig {
  /** Executable to spawn (resolved via the child's PATH). Required. */
  command: string;
  /** argv passed to `command` (default `[]`). */
  args: string[];
  /** Explicit env entries (default `{}`). Win over the allowlisted baseline
   *  and any inherited parent env (scope §4.1 layer 2). */
  env: Record<string, string>;
  /** Working directory (default: launch directory). Relative paths resolve
   *  against the launch directory. Must exist as a directory; NOT added to
   *  sandbox roots. */
  cwd: string;
  /** Optional per-server tool allowlist (default: all tools the server
   *  exposes). */
  tools: string[];
  /** Skip the server entirely — no spawn, no tools (default `false`). */
  disabled: boolean;
  /** Opt the server's tools into the default-`yes` approval posture
   *  (default `false` — untrusted MCP tools prompt in `yes`/`ask` and are
   *  blocked in `no`, scope §5.3). */
  trust: boolean;
  /** Opt the server PROCESS into the kernel sandbox (default `false` —
   *  scope §5.4). File-confined, network-open, same policy as bash. */
  sandbox: boolean;
  /** ADD the full parent environment UNDER the explicit `env` entries
   *  (default `false` — minimal by default; the parent env may hold
   *  tokens/keys, so this key carries a documented credential-exposure
   *  warning, scope §4.1). */
  inheritEnv: boolean;
}

/** Parse a tre.json string. Throws a descriptive error on a malformed
 *  `extraRoots` (CLI-level input validation — allowed to throw before any
 *  StreamFn call, like parseModelsFile). */
export function parseTreConfig(raw: string): TreConfig {
  const j = JSON.parse(raw) as { extraRoots?: unknown; mcpServers?: unknown };
  const extraRoots: string[] = [];
  if (j.extraRoots !== undefined) {
    if (!Array.isArray(j.extraRoots)) {
      throw new Error("tre.json: 'extraRoots' must be an array of directory strings");
    }
    for (const [i, v] of j.extraRoots.entries()) {
      if (typeof v !== "string" || v.trim().length === 0) {
        throw new Error(`tre.json: extraRoots[${i}] must be a non-empty directory string`);
      }
      extraRoots.push(v);
    }
  }
  return { extraRoots, mcpServers: parseMcpServers(j.mcpServers) };
}

/** WS12 — parse + normalize the `mcpServers` field of tre.json (scope §4.1).
 *  Absent/empty → `{}` (MCP is opt-in — no field, no servers). The field's
 *  TYPE is validated here (fail-closed, like `extraRoots`); the per-entry
 *  semantics (cwd existence, etc.) are validated at startup by
 *  `validateMcpServers` in `src/mcp/config.ts`. Defaults are applied at
 *  parse time so the rest of the codebase sees fully-normalized entries. */
function parseMcpServers(v: unknown): Record<string, McpServerConfig> {
  if (v === undefined) return {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("tre.json: 'mcpServers' must be an object mapping server names to configs");
  }
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(v)) {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("tre.json: mcpServers: server names must be non-empty strings");
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`tre.json: mcpServers["${name}"] must be an object`);
    }
    const e = raw as Record<string, unknown>;
    if (typeof e.command !== "string" || e.command.trim().length === 0) {
      throw new Error(`tre.json: mcpServers["${name}"].command must be a non-empty string`);
    }
    out[name] = {
      command: e.command,
      args: parseStringArray(e.args, `mcpServers["${name}"].args`),
      env: parseStringMap(e.env, `mcpServers["${name}"].env`),
      cwd: e.cwd === undefined ? "" : (parseString(e.cwd, `mcpServers["${name}"].cwd`) ?? ""),
      tools: parseStringArray(e.tools, `mcpServers["${name}"].tools`),
      disabled: parseBool(e.disabled, `mcpServers["${name}"].disabled`, false),
      trust: parseBool(e.trust, `mcpServers["${name}"].trust`, false),
      sandbox: parseBool(e.sandbox, `mcpServers["${name}"].sandbox`, false),
      inheritEnv: parseBool(e.inheritEnv, `mcpServers["${name}"].inheritEnv`, false),
    };
  }
  return out;
}

function parseString(v: unknown, what: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`tre.json: ${what} must be a non-empty string`);
  }
  return v;
}

function parseStringArray(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`tre.json: ${what} must be an array of strings`);
  const out: string[] = [];
  for (const [i, x] of v.entries()) {
    if (typeof x !== "string" || x.trim().length === 0) {
      throw new Error(`tre.json: ${what}[${i}] must be a non-empty string`);
    }
    out.push(x);
  }
  return out;
}

function parseStringMap(v: unknown, what: string): Record<string, string> {
  if (v === undefined) return {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`tre.json: ${what} must be an object mapping names to string values`);
  }
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== "string") throw new Error(`tre.json: ${what}["${k}"] must be a string`);
    out[k] = x;
  }
  return out;
}

function parseBool(v: unknown, what: string, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  if (typeof v !== "boolean") throw new Error(`tre.json: ${what} must be a boolean`);
  return v;
}

/** Read + parse a tre.json from disk. */
export function loadTreConfig(path: string): TreConfig {
  return parseTreConfig(readFileSync(path, "utf8"));
}

/**
 * Expand a leading `~` / `~/` in a config entry against the home dir (shell
 * convention — keeps tre.json portable across machines/users: `~/kubeconfigs`
 * instead of `/Users/<name>/kubeconfigs`). `~` alone → the home dir;
 * `~name` is NOT expanded (no user-lookup — it would resolve to the literal
 * `~name` path and fail the exists check, fail-closed). Non-`~` entries are
 * returned unchanged (absolute or cwd-relative, as before).
 */
export function expandTilde(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

/**
 * C36 — tre.json lookup. `explicit` (tests) wins and is returned as-is, even
 * if missing — the caller reports the error. Otherwise walk UP from `start`
 * (the launch directory, resolved) looking for a `tre.json` — the same
 * convention as models.json — then fall back to the permanent home location
 * `~/.tre/tre.json`. Returns null when nothing is found (no config = no
 * durable extra roots; the flag-only C35 behavior).
 */
export function findTreConfig(
  explicit: string | undefined,
  start: string,
  home: string = homedir(),
): string | null {
  if (explicit !== undefined) return explicit;
  let dir = start;
  for (;;) {
    const candidate = join(dir, "tre.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  const homeFile = join(home, ".tre", "tre.json");
  return existsSync(homeFile) ? homeFile : null;
}
