/**
 * D15 — ChatGPT OAuth token store + refresh.
 *
 * Owns the long-lived credential state for the ChatGPT subscription
 * backend: the access token (short-lived JWT), the refresh token
 * (long-lived), and expiry. The wire layer (openai-responses.ts) resolves
 * a fresh access token per request through `resolveAccessToken` — the
 * "expiring OAuth token" seam reserved in PLAN.md §8.
 *
 * Storage: a JSON file at `~/.tre/chatgpt-auth.json` (override: env
 * `TRE_CHATGPT_AUTH`), written 0600. The file is OUTSIDE the repo and
 * gitignored-by-location (home dir); never log or echo its contents.
 *
 * Refresh: `grant_type=refresh_token` against the token endpoint. Codex
 * sends the ChatGPT refresh as a JSON body (codex-rs/login/src/oauth/
 * client.rs: "ChatGPT refresh uses JSON"); `encoding` is injectable so a
 * live 400 can fall back to form without a code change. Token rotation:
 * some refresh responses omit a new refresh_token — keep the old one then.
 *
 * Errors are data at the boundary: `AuthRequiredError` means "no login /
 * login expired — run `tre. login chatgpt`"; `AuthError` is a transport
 * failure (retryable by the caller).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CHATGPT_AUTH_ENV,
  CHATGPT_AUTH_FILE,
  CHATGPT_CLIENT_ID,
  CHATGPT_TOKEN_URL,
} from "./constants.js";

/** One stored credential set (the whole file content). */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  /** From the id_token JWT claims (display only). */
  email?: string;
  /** From the id_token JWT claims ("plus" | "pro" | …). */
  planType?: string;
  /** Epoch ms when this file was last written. */
  savedAt: number;
}

/** No login on record (or the file is unreadable/corrupt) — run `tre. login chatgpt`. */
export class AuthRequiredError extends Error {
  constructor(message = "no ChatGPT login on record — run `tre. login chatgpt`") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

/** Transport/protocol failure talking to the token endpoint. */
export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * The token file path: env override wins, else `~/.tre/chatgpt-auth.json`.
 * `home` is injectable for tests.
 */
export function tokenFilePath(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CHATGPT_AUTH_ENV];
  if (override && override.trim() !== "") return override;
  return join(home, ".tre", CHATGPT_AUTH_FILE);
}

/** Read the stored tokens, or null when absent/invalid (never throws). */
export function readTokens(
  file: string = tokenFilePath(),
): StoredTokens | null {
  try {
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (
      typeof j.accessToken !== "string" || j.accessToken === "" ||
      typeof j.refreshToken !== "string" || j.refreshToken === "" ||
      typeof j.expiresAt !== "number"
    ) {
      return null;
    }
    const out: StoredTokens = {
      accessToken: j.accessToken,
      refreshToken: j.refreshToken,
      expiresAt: j.expiresAt,
      savedAt: typeof j.savedAt === "number" ? j.savedAt : 0,
    };
    if (typeof j.email === "string") out.email = j.email;
    if (typeof j.planType === "string") out.planType = j.planType;
    return out;
  } catch {
    return null;
  }
}

/**
 * Write the stored tokens (0600 — the refresh token is a standing
 * credential). Creates the parent dir.
 */
export function writeTokens(
  tokens: StoredTokens,
  file: string = tokenFilePath(),
): void {
  const dir = dirname(file);
  const temp = join(dir, `.${CHATGPT_AUTH_FILE}.${randomUUID()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
    if ((statSync(file).mode & 0o777) !== 0o600) {
      throw new Error("permissions not enforced");
    }
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // Best-effort cleanup; preserve the sanitized storage error.
    }
    throw new AuthError("could not store credentials securely (file permissions could not be enforced)");
  }
}

/** Delete the stored tokens (logout). No-op when absent. */
export function clearTokens(file: string = tokenFilePath()): boolean {
  try {
    if (!existsSync(file)) return false;
  } catch {
    return false;
  }
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export interface RefreshOpts {
  /** Token endpoint. Default: the production ChatGPT token URL. */
  tokenUrl?: string;
  /** Public client id. Default: the Codex client id. */
  clientId?: string;
  /** Body encoding for the refresh grant. Default "json" (Codex behavior). */
  encoding?: "json" | "form";
  /** Injectable transport (tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests). Default: Date.now. */
  now?: () => number;
  /** Token file (tests). Default: tokenFilePath(). */
  file?: string;
  /** Abort signal. */
  signal?: AbortSignal;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
}

/** Decode the `https://api.openai.com/profile` / `.../auth` JWT claims (email, plan). */
export function idTokenClaims(idToken: string): { email?: string; planType?: string } {
  try {
    const parts = idToken.split(".");
    const payload = parts[1] ?? "";
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const claims = JSON.parse(json) as Record<string, unknown>;
    const out: { email?: string; planType?: string } = {};
    const profile = claims["https://api.openai.com/profile"] as
      | Record<string, unknown>
      | undefined;
    const auth = claims["https://api.openai.com/auth"] as
      | Record<string, unknown>
      | undefined;
    if (profile && typeof profile.email === "string") out.email = profile.email;
    if (auth && typeof auth.chatgpt_plan_type === "string") {
      out.planType = auth.chatgpt_plan_type;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolve a usable access token: return the stored one when unexpired, else
 * refresh it (and persist the rotation). Throws `AuthRequiredError` when
 * there is no login or the refresh is rejected (re-login needed);
 * `AuthError` on transport failure.
 */
export async function resolveAccessToken(opts: RefreshOpts = {}): Promise<string> {
  const file = opts.file ?? tokenFilePath();
  const now = opts.now ?? Date.now;
  const stored = readTokens(file);
  if (stored === null) throw new AuthRequiredError();
  // 60s skew: never send a token that expires mid-request.
  if (stored.expiresAt - 60_000 > now()) return stored.accessToken;

  const refresh = await refreshTokens(stored.refreshToken, opts);
  const rotated: StoredTokens = {
    accessToken: refresh.accessToken,
    // Rotation: keep the old refresh token when the response omits a new one.
    refreshToken: refresh.refreshToken ?? stored.refreshToken,
    expiresAt: refresh.expiresAt,
    email: refresh.email ?? stored.email,
    planType: refresh.planType ?? stored.planType,
    savedAt: now(),
  };
  writeTokens(rotated, file);
  return rotated.accessToken;
}

async function refreshTokens(
  refreshToken: string,
  opts: RefreshOpts,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email?: string;
  planType?: string;
}> {
  const tokenUrl = opts.tokenUrl ?? CHATGPT_TOKEN_URL;
  const clientId = opts.clientId ?? CHATGPT_CLIENT_ID;
  const encoding = opts.encoding ?? "json";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;

  const params: Record<string, string> = {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  };
  const init: RequestInit =
    encoding === "json"
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params), signal: opts.signal }
      : {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(params).toString(),
          signal: opts.signal,
        };

  let res: Response;
  try {
    res = await fetchImpl(tokenUrl, init);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new AuthError(`token refresh transport failure: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    // 4xx on refresh = the refresh token is dead → re-login (not retryable).
    if (res.status >= 400 && res.status < 500) {
      throw new AuthRequiredError(
        `token refresh rejected (HTTP ${res.status}) — run \`tre. login chatgpt\` again`,
      );
    }
    throw new AuthError(`token refresh failed (HTTP ${res.status})`, res.status);
  }
  let j: TokenResponse;
  try {
    j = JSON.parse(body) as TokenResponse;
  } catch {
    throw new AuthError("token refresh returned a non-JSON body");
  }
  if (typeof j.access_token !== "string" || j.access_token === "") {
    throw new AuthError("token refresh response missing access_token");
  }
  const claims = typeof j.id_token === "string" ? idTokenClaims(j.id_token) : {};
  return {
    accessToken: j.access_token,
    ...(typeof j.refresh_token === "string" && j.refresh_token !== ""
      ? { refreshToken: j.refresh_token }
      : {}),
    expiresAt: now() + (typeof j.expires_in === "number" ? j.expires_in : 3600) * 1000,
    ...claims,
  };
}
