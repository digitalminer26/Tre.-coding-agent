/**
 * D15 — ChatGPT OAuth login flow (authorization-code + PKCE, public client).
 *
 * The flow (Codex-style, the supported way to use a ChatGPT subscription
 * programmatically):
 *   1. Generate PKCE (S256) + a random `state`.
 *   2. Start a loopback callback server on 127.0.0.1 at a REGISTERED port
 *      (1455, fallback 1457 — the fixed ports auth.openai.com accepts for
 *      this client id; a random port is rejected with
 *      `invalid_authorize_request`).
 *   3. Build the authorize URL and open the browser (or print it).
 *   4. The user logs in at auth.openai.com; the browser is redirected to
 *      `http://127.0.0.1:1455/auth/callback?code=…&state=…`.
 *   5. Exchange the code for tokens at the token endpoint (form-encoded,
 *      per Codex: authorization-code grants use form).
 *   6. Persist via the token store (0600).
 *
 * Headless/SSH fallback: the loopback callback only reaches the machine
 * running tre. When the browser is elsewhere, the user pastes the full
 * redirect URL (the one in the address bar after login) — the same
 * `code`/`state` arrive, just typed instead of fetched.
 *
 * Security: `state` is compared with a timing-safe check; the verifier and
 * code are never logged; the loopback server binds 127.0.0.1 only and is
 * closed as soon as the login settles (win or lose).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import {
  CHATGPT_AUTHORIZE_URL,
  CHATGPT_CALLBACK_PATH,
  CHATGPT_CALLBACK_PORTS,
  CHATGPT_CLIENT_ID,
  CHATGPT_SCOPES,
  CHATGPT_TOKEN_URL,
} from "./constants.js";
import {
  AuthError,
  writeTokens,
  type StoredTokens,
} from "./token-store.js";

export interface Pkce {
  /** Raw verifier (43–128 chars); sent at token exchange. */
  verifier: string;
  /** base64url(sha256(verifier)); sent at authorize time. */
  challenge: string;
}

/** Generate a PKCE S256 pair. */
export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface AuthorizeParams {
  redirectUri: string;
  state: string;
  challenge: string;
  clientId?: string;
  authorizeUrl?: string;
  scopes?: string;
}

/**
 * Codex-specific authorize extensions. The public client is Codex's, and
 * these two flags select the intended ChatGPT-subscription UX for it
 * (organization claims in the id_token; the simplified consent flow).
 * Codex also sends an `originator` telemetry param — we omit it: it
 * identifies Codex itself, and we are not Codex.
 */
const CODEX_AUTHORIZE_EXTRA: Record<string, string> = {
  id_token_add_organizations: "true",
  codex_cli_simplified_flow: "true",
};

/** Build the authorize URL (pure — unit-testable). */
export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId ?? CHATGPT_CLIENT_ID,
    redirect_uri: p.redirectUri,
    scope: p.scopes ?? CHATGPT_SCOPES,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    ...CODEX_AUTHORIZE_EXTRA,
  });
  return `${(p.authorizeUrl ?? CHATGPT_AUTHORIZE_URL).replace(/\/+$/, "")}?${q.toString()}`;
}

export interface CallbackResult {
  code: string;
  state: string;
}

export interface LoginOpts {
  /** Token file (tests). Default: tokenFilePath(). */
  file?: string;
  /** Injectable transport (tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests). Default: Date.now. */
  now?: () => number;
  /** Open the browser at `url`. Default: `open` (darwin) / `xdg-open` (linux),
   *  best-effort (failure just means "copy the URL"). */
  openBrowser?: (url: string) => void;
  /** Called with the authorize URL once built, BEFORE the browser is opened.
   *  Lets the caller PRINT it — essential on headless/SSH machines where
   *  `xdg-open` is absent and the URL would otherwise be invisible. */
  onAuthorizeUrl?: (url: string) => void;
  /** Ask the user to paste the redirect URL (headless fallback). Omit to
   *  disable the manual path (loopback only). */
  prompt?: (text: string) => Promise<string>;
  /** End-to-end login timeout. Default 5 minutes. */
  timeoutMs?: number;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Token endpoint (tests). Default: production. */
  tokenUrl?: string;
  /** Client id (tests). Default: the Codex public client id. */
  clientId?: string;
}

/**
 * Run the full login flow. Resolves with the stored tokens.
 * Throws `AuthError` on protocol/transport failure (message is user-facing).
 *
 * The loopback callback and the (optional) manual paste race; whichever
 * delivers a valid `code`+`state` first wins. The loopback server is closed
 * as soon as the login settles. The manual readline, if still pending, is
 * abandoned — for the one-shot `tre. login chatgpt` command the process
 * exits right after, so it is bounded by process lifetime.
 */
export async function runLogin(opts: LoginOpts = {}): Promise<StoredTokens> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 300_000;

  const pkce = generatePkce();
  const state = randomUUID();

  // ── one-shot deferred: the callback server and the manual paste both ──
  // ── settle this; whichever wins, the other is abandoned. ──
  let settle: (r: CallbackResult | Error) => void = () => undefined;
  const settled = new Promise<CallbackResult>((resolve, reject) => {
    settle = (r) => (r instanceof Error ? reject(r) : resolve(r));
  });

  // ── loopback callback server (127.0.0.1, REGISTERED port) ──
  // auth.openai.com only accepts this client's redirect URIs on the fixed
  // Codex ports (1455, fallback 1457). A random port is unregistered →
  // `invalid_authorize_request`. Never fall back to a random port.
  const server = http.createServer();
  let serverClosed = false;
  const closeServer = (): void => {
    if (serverClosed) return;
    serverClosed = true;
    server.close();
  };

  const bindPort = (port: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(port, "127.0.0.1");
    });
  let serverPort: number | null = null;
  for (const port of CHATGPT_CALLBACK_PORTS) {
    try {
      await bindPort(port);
      serverPort = port;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") {
        throw new AuthError(
          `callback server: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // EADDRINUSE → try the next registered port.
    }
  }
  if (serverPort === null) {
    throw new AuthError(
      `callback ports ${CHATGPT_CALLBACK_PORTS.join(" and ")} are in use — ` +
        "close the other OpenAI sign-in (e.g. `codex login`) and retry",
    );
  }
  const redirectUri = `http://127.0.0.1:${serverPort}${CHATGPT_CALLBACK_PATH}`;
  const authorizeUrl = buildAuthorizeUrl({
    redirectUri,
    state,
    challenge: pkce.challenge,
    clientId: opts.clientId,
  });
  // Print the URL BEFORE opening the browser: on headless/SSH machines the
  // browser open is a no-op, so the printed URL is the ONLY way the user
  // reaches the sign-in page (they open it on another machine, then paste
  // the redirect URL back). Without this, headless login is impossible.
  opts.onAuthorizeUrl?.(authorizeUrl);

  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CHATGPT_CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const code = url.searchParams.get("code") ?? "";
    const gotState = url.searchParams.get("state") ?? "";
    const errParam = url.searchParams.get("error");
    if (errParam) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end(`login failed: ${errParam}`);
      settle(new AuthError(`authorization error: ${errParam}`));
      return;
    }
    if (!timingSafeState(gotState, state)) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("state mismatch — please retry");
      settle(new AuthError("callback state mismatch"));
      return;
    }
    if (code === "") {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("missing authorization code — please retry");
      settle(new AuthError("callback: missing authorization code"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      "<!doctype html><meta charset='utf-8'><title>tre.</title>" +
        "<body style='font-family:system-ui;padding:2rem'>" +
        "<h2>✓ Logged in</h2><p>You can close this tab and return to the terminal.</p>",
    );
    settle({ code, state: gotState });
  });
  server.once("error", (err) => settle(new AuthError(`callback server: ${err.message}`)));

  // ── open the browser (best-effort) — BEFORE the manual prompt, so the ──
  // ── user sees the authorize URL before being asked to paste a redirect. ──
  // All post-bind setup (browser open, manual prompt, timeout/abort, race)
  // runs inside ONE try/finally: if any of it throws synchronously (e.g. an
  // injected openBrowser or prompt), the loopback server is still closed —
  // the listener must not outlive the login attempt.
  let cb: CallbackResult;
  try {
    const open = opts.openBrowser ?? defaultOpenBrowser;
    open(authorizeUrl);

    // ── manual paste fallback (headless / SSH) ──
    if (opts.prompt) {
      opts.prompt(
        "  (or, if you logged in on ANOTHER machine: paste the full redirect\n" +
          `   URL from the address bar — http://127.0.0.1:${serverPort}${CHATGPT_CALLBACK_PATH}?code=…&state=…\n` +
          "   — and press enter. Leave empty to keep waiting for the local callback.)\n> ",
      )
        .then((line) => {
          const trimmed = line.trim();
          if (trimmed === "") return; // stay pending: keep waiting for loopback
          const url = new URL(trimmed);
          const code = url.searchParams.get("code") ?? "";
          const gotState = url.searchParams.get("state") ?? "";
          if (!timingSafeState(gotState, state)) {
            settle(new AuthError("pasted URL: state mismatch"));
            return;
          }
          if (code === "") {
            settle(new AuthError("pasted URL: missing code parameter"));
            return;
          }
          settle({ code, state: gotState });
        })
        .catch((err) => settle(err instanceof Error ? err : new AuthError(String(err))));
    }

    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new AuthError(`login timed out after ${Math.round(timeoutMs / 1000)}s`)),
        timeoutMs,
      );
      t.unref?.();
    });
    const abort = new Promise<never>((_, reject) => {
      if (opts.signal) {
        if (opts.signal.aborted) reject(new AuthError("login aborted"));
        else
          opts.signal.addEventListener(
            "abort",
            () => reject(new AuthError("login aborted")),
            { once: true },
          );
      }
    });

    try {
      cb = await Promise.race([settled, timeout, abort]);
    } catch (err) {
      throw err instanceof AuthError ? err : new AuthError(String(err));
    }
  } catch (err) {
    // A synchronously-throwing setup callback (openBrowser/prompt) must not
    // escape raw — wrap it like the race path does. The finally still closes
    // the loopback server, so the listener never outlives the attempt.
    throw err instanceof AuthError ? err : new AuthError(String(err));
  } finally {
    closeServer();
  }

  // ── code → tokens (form-encoded, per Codex) ──
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: opts.clientId ?? CHATGPT_CLIENT_ID,
    code: cb.code,
    redirect_uri: redirectUri,
    code_verifier: pkce.verifier,
  });
  let res: Response;
  try {
    res = await fetchImpl(opts.tokenUrl ?? CHATGPT_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: opts.signal,
    });
  } catch (err) {
    throw new AuthError(
      `token exchange transport failure: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    throw new AuthError(`token exchange failed (HTTP ${res.status})`);
  }
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(body);
  } catch {
    throw new AuthError("token exchange returned a non-JSON body");
  }
  if (typeof j.access_token !== "string" || typeof j.refresh_token !== "string") {
    throw new AuthError("token exchange response missing access_token/refresh_token");
  }
  const tokens: StoredTokens = {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: now() + (typeof j.expires_in === "number" ? j.expires_in : 3600) * 1000,
    savedAt: now(),
  };
  writeTokens(tokens, opts.file);
  return tokens;
}

/** Constant-time state comparison (lengths may differ → safe wrapper). */
function timingSafeState(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Best-effort browser open: `open` on darwin, `xdg-open` elsewhere. */
function defaultOpenBrowser(url: string): void {
  try {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => undefined); // no xdg-open → user copies the URL
    child.unref();
  } catch {
    /* the URL is printed by the caller regardless */
  }
}
