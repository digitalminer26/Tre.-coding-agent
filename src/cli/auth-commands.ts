/**
 * D15 — `tre. login` / `tre. auth` subcommands.
 *
 *   tre. login [chatgpt]   run the ChatGPT OAuth login (opens the browser,
 *                          waits for the loopback callback or a pasted URL,
 *                          stores the tokens).
 *   tre. auth status       show the stored login (email, plan, expiry).
 *   tre. auth logout       delete the stored tokens.
 *
 * These are one-shot commands: they run and return an exit code (0 ok, 2
 * user error). They do NOT need a model / models.json — the CLI dispatches
 * them before any model loading.
 */
import { createInterface, type Interface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runLogin } from "../auth/chatgpt-oauth.js";
import {
  AuthError,
  clearTokens,
  readTokens,
  tokenFilePath,
} from "../auth/token-store.js";

export interface CommandSinks {
  out: { write(s: string, cb?: () => void): unknown };
  err: { write(s: string, cb?: () => void): unknown };
}

/**
 * Run the ChatGPT login. `prompt` (a readline-backed question) enables the
 * manual paste fallback for headless/SSH use.
 */
export async function runLoginCommand(
  sinks: CommandSinks,
  prompt?: (q: string) => Promise<string>,
): Promise<number> {
  sinks.out.write(
    "ChatGPT login (Codex-style OAuth — uses your ChatGPT subscription, no API key)\n",
  );
  try {
    const tokens = await runLogin({ prompt });
    const modelId = await discoverChatGptModel(tokens.accessToken);
    ensureChatGptModelCatalog(modelId);
    const who = [tokens.email, tokens.planType ? `plan: ${tokens.planType}` : null]
      .filter(Boolean)
      .join(", ");
    sinks.out.write(
      `✓ Logged in${who ? ` (${who})` : ""} — tokens saved to ${tokenFilePath()}\n`,
    );
    sinks.out.write("ChatGPT model added to ~/.tre/tre/models.json. Run tre. to start using it.\n");
    return 0;
  } catch (err) {
    if (err instanceof AuthError) {
      sinks.err.write(`login failed: ${err.message}\n`);
    } else {
      sinks.err.write(`login failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return 2;
  }
}

/**
 * The `client_version` the Codex model-list endpoint requires in the query
 * string (verified live 2026-10-05: without it the endpoint answers
 * `400 … 'loc': ('query', 'client_version'), 'msg': 'Field required'`).
 * The list is version-gated: recent Codex versions get the full catalog,
 * older ones a reduced set (some get NONE — an empty list is a valid 200).
 * We send a current 1.x version so discovery sees the full catalog; the
 * `/responses` endpoint itself does not require the param.
 */
const CODEX_CLIENT_VERSION = "1.0.0";

/** Create/update the per-install model catalog without discarding existing
 * entries. ChatGPT OAuth login is useful immediately with the Responses API. */
export async function discoverChatGptModel(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(
    `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new Error(`ChatGPT model discovery failed (HTTP ${response.status}); model catalog was not written`);
  }
  const payload: unknown = await response.json();
  const ids = extractModelIds(payload);
  if (ids.length === 0) {
    throw new Error("ChatGPT model discovery returned no usable models; model catalog was not written");
  }
  return ids[0]!;
}

function extractModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const value = payload as Record<string, unknown>;
  const list = Array.isArray(value.models) ? value.models : Array.isArray(value.data) ? value.data : [];
  return list.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim()];
    if (!item || typeof item !== "object") return [];
    const model = item as Record<string, unknown>;
    const id = typeof model.slug === "string" ? model.slug : model.id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
}

function ensureChatGptModelCatalog(id: string): void {
  const file = join(homedir(), ".tre", "tre", "models.json");
  mkdirSync(join(homedir(), ".tre", "tre"), { recursive: true });
  let catalog: { default?: string; models?: Array<Record<string, unknown>> } = {};
  if (existsSync(file)) {
    try {
      catalog = JSON.parse(readFileSync(file, "utf8")) as typeof catalog;
    } catch {
      throw new Error(`existing ${file} is invalid; refusing to overwrite it`);
    }
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
      throw new Error(`existing ${file} is invalid; refusing to overwrite it`);
    }
  }
  if (!Array.isArray(catalog.models)) catalog.models = [];
  const current = catalog.models.find((model) => model.provider === "chatgpt" && model.auth === "chatgpt-oauth");
  const wasDefault = catalog.default === current?.id;
  const entry = {
    id,
    provider: "chatgpt",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    api: "openai-responses",
    auth: "chatgpt-oauth",
    contextWindow: 200000,
    maxTokens: 32768,
    compat: { extraParams: { store: false } },
  };
  if (current) Object.assign(current, entry);
  else catalog.models.push(entry);
  if (current && wasDefault) catalog.default = id;
  catalog.default ??= id;
  writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
}

/** Show the stored login status. */
export function authStatusCommand(sinks: CommandSinks): number {
  const tokens = readTokens();
  if (tokens === null) {
    sinks.out.write(
      `no ChatGPT login on record (looked in ${tokenFilePath()})\n` +
        `run: tre. login\n`,
    );
    return 0;
  }
  const now = Date.now();
  const expires = new Date(tokens.expiresAt).toISOString();
  const state = tokens.expiresAt > now ? "valid (access token unexpired)" : "access token expired (will refresh on next use)";
  const lines = [
    "ChatGPT login:",
    `  file:    ${tokenFilePath()}`,
    `  email:   ${tokens.email ?? "(not stored)"}`,
    `  plan:    ${tokens.planType ?? "(not stored)"}`,
    `  expires: ${expires}  [${state}]`,
  ];
  sinks.out.write(lines.join("\n") + "\n");
  return 0;
}

/** Delete the stored tokens. */
export function authLogoutCommand(sinks: CommandSinks): number {
  const file = tokenFilePath();
  const removed = clearTokens(file);
  sinks.out.write(
    removed
      ? `logged out — deleted ${file}\n`
      : `nothing to delete (no ${file})\n`,
  );
  return 0;
}

/**
 * A readline-backed question for the manual paste fallback. Reads ONE line
 * from stdin, then closes the interface. Returns "" on EOF.
 */
export function makeStdinPrompt(): (q: string) => Promise<string> {
  let rl: Interface | null = null;
  return (q: string) =>
    new Promise<string>((resolve) => {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(q, (line) => {
        rl?.close();
        resolve(line);
      });
    });
}
