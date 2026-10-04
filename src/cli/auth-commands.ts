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
    const who = [tokens.email, tokens.planType ? `plan: ${tokens.planType}` : null]
      .filter(Boolean)
      .join(", ");
    sinks.out.write(
      `✓ Logged in${who ? ` (${who})` : ""} — tokens saved to ${tokenFilePath()}\n`,
    );
    sinks.out.write("Now run tre. with a model whose api is \"openai-responses\".\n");
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
