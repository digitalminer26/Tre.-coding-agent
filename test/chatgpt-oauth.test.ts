/**
 * D15 — ChatGPT OAuth flow tests. The token endpoint is a mock fetch; the
 * loopback callback is exercised with a REAL http request to the registered
 * port (1455, or 1457 when 1455 is occupied — or via the manual paste path).
 * No external network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAuthorizeUrl,
  generatePkce,
  runLogin,
} from "../src/auth/chatgpt-oauth.js";
import { AuthError, readTokens } from "../src/auth/token-store.js";

const NOW = 1_700_000_000_000;

function mkfile(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-oauth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "auth.json");
}

const tokenEndpoint = (calls: { body: URLSearchParams }[]) =>
  (async (_url: string, init?: RequestInit) => {
    calls.push({ body: new URLSearchParams(String(init?.body)) });
    return new Response(
      JSON.stringify({
        access_token: "AT-login",
        refresh_token: "RT-login",
        expires_in: 3600,
        token_type: "Bearer",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

/** Fire the loopback callback on a FRESH connection (a real browser redirect
 *  does exactly this). The global `fetch` pools keep-alive sockets per
 *  origin, and these tests bind a fresh server on the SAME registered port
 *  (1455) per `runLogin`; a pooled socket to a previous (closed) server would
 *  steal the next callback and starve the live server until the 300s login
 *  timeout — the intermittent `npm test` hang (2026-10-04). `http.get` with
 *  `Connection: close` opens a new socket each time and never reuses the pool. */
function fireCallback(url: string): void {
  const req = http.get(url, { headers: { connection: "close" } }, (res) => {
    res.resume();
  });
  req.on("error", () => undefined); // server already closed — the flow rejects
}

test("generatePkce: challenge = base64url(sha256(verifier))", () => {
  const { verifier, challenge } = generatePkce();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  const expected = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(challenge, expected);
});

test("buildAuthorizeUrl: carries PKCE + state + public client id", () => {
  const url = buildAuthorizeUrl({
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    state: "st-1",
    challenge: "chal",
  });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://auth.openai.com/oauth/authorize");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("code_challenge"), "chal");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("state"), "st-1");
  assert.equal(u.searchParams.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assert.equal(u.searchParams.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.match(u.searchParams.get("scope") ?? "", /offline_access/);
  // Codex-specific extras (the public client is Codex's); no originator.
  assert.equal(u.searchParams.get("id_token_add_organizations"), "true");
  assert.equal(u.searchParams.get("codex_cli_simplified_flow"), "true");
  assert.equal(u.searchParams.get("originator"), null);
});

test("runLogin: binds the registered callback port + path (1455 /auth/callback)", async (t) => {
  const file = mkfile(t);
  let openedUrl = "";
  const openBrowser = (url: string): void => {
    openedUrl = url;
    const u = new URL(url);
    const redirectUri = u.searchParams.get("redirect_uri")!;
    const state = u.searchParams.get("state")!;
    setTimeout(() => {
      fireCallback(`${redirectUri}?code=TESTCODE&state=${encodeURIComponent(state)}`);
    }, 0);
  };
  await runLogin({ file, now: () => NOW, fetchImpl: tokenEndpoint([]), openBrowser });
  const redirectUri = new URL(openedUrl).searchParams.get("redirect_uri")!;
  const r = new URL(redirectUri);
  assert.equal(r.hostname, "127.0.0.1");
  assert.ok(
    r.port === "1455" || r.port === "1457",
    `redirect_uri must use a registered port, got :${r.port}`,
  );
  assert.equal(r.pathname, "/auth/callback");
});

test("runLogin: 1455 in use → falls back to 1457", async (t) => {
  const file = mkfile(t);
  // Occupy 1455 so the first bind attempt gets EADDRINUSE.
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(1455, "127.0.0.1", resolve));
  t.after(() => blocker.close());
  let openedUrl = "";
  const openBrowser = (url: string): void => {
    openedUrl = url;
    const u = new URL(url);
    const redirectUri = u.searchParams.get("redirect_uri")!;
    const state = u.searchParams.get("state")!;
    setTimeout(() => {
      fireCallback(`${redirectUri}?code=TESTCODE&state=${encodeURIComponent(state)}`);
    }, 0);
  };
  await runLogin({ file, now: () => NOW, fetchImpl: tokenEndpoint([]), openBrowser });
  const r = new URL(new URL(openedUrl).searchParams.get("redirect_uri")!);
  assert.equal(r.port, "1457");
  assert.equal(r.pathname, "/auth/callback");
});

test("runLogin: 1455 AND 1457 in use → rejects (no random-port fallback)", async (t) => {
  const file = mkfile(t);
  const blockers = [1455, 1457].map((port) => http.createServer());
  await Promise.all(
    [1455, 1457].map(
      (port, i) =>
        new Promise<void>((resolve) => blockers[i]!.listen(port, "127.0.0.1", resolve)),
    ),
  );
  t.after(() => {
    for (const s of blockers) s.close();
  });
  await assert.rejects(
    () => runLogin({ file, now: () => NOW, fetchImpl: tokenEndpoint([]) }),
    (err: unknown) =>
      err instanceof AuthError &&
      /1455 and 1457 are in use/.test(err.message) &&
      /codex login/.test(err.message),
  );
});

test("runLogin: loopback callback → code exchange (form) → tokens stored", async (t) => {
  const file = mkfile(t);
  const calls: { body: URLSearchParams }[] = [];
  let openedUrl = "";
  const openBrowser = (url: string): void => {
    openedUrl = url;
    // Fire the callback once the server is up (openBrowser runs after listen).
    const u = new URL(url);
    const redirectUri = u.searchParams.get("redirect_uri")!;
    const state = u.searchParams.get("state")!;
    setTimeout(() => {
      fireCallback(`${redirectUri}?code=TESTCODE&state=${encodeURIComponent(state)}`);
    }, 0);
  };
  const tokens = await runLogin({
    file,
    now: () => NOW,
    fetchImpl: tokenEndpoint(calls),
    openBrowser,
  });
  assert.equal(tokens.accessToken, "AT-login");
  assert.equal(tokens.refreshToken, "RT-login");
  // The code exchange was form-encoded with the PKCE verifier.
  assert.equal(calls[0]!.body.get("grant_type"), "authorization_code");
  assert.equal(calls[0]!.body.get("code"), "TESTCODE");
  assert.ok(calls[0]!.body.get("code_verifier") !== null);
  assert.equal(calls[0]!.body.get("redirect_uri"), new URL(openedUrl).searchParams.get("redirect_uri"));
  // Persisted.
  assert.equal(readTokens(file)!.accessToken, "AT-login");
});

test("runLogin: manual paste path (headless) → tokens stored", async (t) => {
  const file = mkfile(t);
  const calls: { body: URLSearchParams }[] = [];
  let openedUrl = "";
  const openBrowser = (url: string): void => {
    openedUrl = url;
  };
  // The user pastes the redirect URL (with code + state) after login.
  const prompt = async (): Promise<string> => {
    const u = new URL(openedUrl);
    const redirectUri = u.searchParams.get("redirect_uri")!;
    const state = u.searchParams.get("state")!;
    return `${redirectUri}?code=PASTED&state=${encodeURIComponent(state)}`;
  };
  const tokens = await runLogin({
    file,
    now: () => NOW,
    fetchImpl: tokenEndpoint(calls),
    openBrowser,
    prompt,
  });
  assert.equal(tokens.accessToken, "AT-login");
  assert.equal(calls[0]!.body.get("code"), "PASTED");
});

test("runLogin: callback state mismatch → AuthError", async (t) => {
  const file = mkfile(t);
  let openedUrl = "";
  const openBrowser = (url: string): void => {
    openedUrl = url;
    const u = new URL(url);
    const redirectUri = u.searchParams.get("redirect_uri")!;
    setTimeout(() => {
      fireCallback(`${redirectUri}?code=X&state=WRONG`);
    }, 0);
  };
  await assert.rejects(
    () =>
      runLogin({
        file,
        now: () => NOW,
        fetchImpl: tokenEndpoint([]),
        openBrowser,
      }),
    (err: unknown) => err instanceof AuthError && /state mismatch/.test(err.message),
  );
});

test("runLogin: token endpoint 400 → AuthError (exchange failed)", async (t) => {
  const file = mkfile(t);
  let openedUrl = "";
  const openBrowser = (url: string): void => {
    openedUrl = url;
    const u = new URL(url);
    const redirectUri = u.searchParams.get("redirect_uri")!;
    const state = u.searchParams.get("state")!;
    setTimeout(() => {
      fireCallback(`${redirectUri}?code=X&state=${encodeURIComponent(state)}`);
    }, 0);
  };
  const fetchImpl = (async () =>
    new Response("bad", { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(
    () =>
      runLogin({
        file,
        now: () => NOW,
        fetchImpl,
        openBrowser,
      }),
    (err: unknown) => err instanceof AuthError && /exchange failed/.test(err.message),
  );
});

test("runLogin: callback with matching state but EMPTY code → rejected at callback (no token exchange)", async (t) => {
  const file = mkfile(t);
  const calls: { body: URLSearchParams }[] = [];
  let openedUrl = "";
  const openBrowser = (url: string): void => {
    openedUrl = url;
    const u = new URL(url);
    const redirectUri = u.searchParams.get("redirect_uri")!;
    const state = u.searchParams.get("state")!;
    setTimeout(() => {
      // Matching state, empty code.
      fireCallback(`${redirectUri}?code=&state=${encodeURIComponent(state)}`);
    }, 0);
  };
  await assert.rejects(
    () =>
      runLogin({
        file,
        now: () => NOW,
        fetchImpl: tokenEndpoint(calls),
        openBrowser,
      }),
    (err: unknown) =>
      err instanceof AuthError &&
      /missing authorization code/.test(err.message) &&
      !/exchange failed/.test(err.message),
  );
  // The empty code was rejected at callback validation — the token endpoint
  // was never called.
  assert.equal(calls.length, 0);
});

test("runLogin: openBrowser throwing synchronously → AuthError, settles promptly, listener closed", async (t) => {
  const file = mkfile(t);
  const calls: { body: URLSearchParams }[] = [];
  const openBrowser = (): void => {
    throw new Error("boom");
  };
  // Must settle promptly (not hang on the 5-minute login timeout) and the
  // error must be wrapped in AuthError, not escape as a raw throw.
  await assert.rejects(
    () =>
      runLogin({
        file,
        now: () => NOW,
        fetchImpl: tokenEndpoint(calls),
        openBrowser,
        timeoutMs: 5_000,
      }),
    (err: unknown) =>
      err instanceof AuthError && /boom/.test(err.message),
  );
  assert.equal(calls.length, 0);
});
