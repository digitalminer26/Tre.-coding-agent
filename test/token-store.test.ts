/**
 * D15 — token store + refresh tests. No network: the token endpoint is a
 * mock fetch, the file lives in a temp dir, the clock is injected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AuthError,
  AuthRequiredError,
  clearTokens,
  idTokenClaims,
  readTokens,
  resolveAccessToken,
  tokenFilePath,
  writeTokens,
  type StoredTokens,
} from "../src/auth/token-store.js";

const NOW = 1_700_000_000_000;

function mkfile(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-tok-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "auth.json");
}

const okTokens = (over: Partial<StoredTokens> = {}): StoredTokens => ({
  accessToken: "AT",
  refreshToken: "RT",
  expiresAt: NOW + 3_600_000,
  savedAt: NOW,
  ...over,
});

test("tokenFilePath: env override wins, else ~/.tre/chatgpt-auth.json", () => {
  assert.equal(
    tokenFilePath("/home/u", { TRE_CHATGPT_AUTH: "/tmp/x.json" } as NodeJS.ProcessEnv),
    "/tmp/x.json",
  );
  assert.equal(
    tokenFilePath("/home/u", {} as NodeJS.ProcessEnv),
    path.join("/home/u", ".tre", "chatgpt-auth.json"),
  );
});

test("write/read roundtrip + 0600 perms", (t) => {
  const file = mkfile(t);
  writeTokens(okTokens({ email: "a@b.c", planType: "plus" }), file);
  const st = fs.statSync(file);
  assert.equal((st.mode & 0o777) === 0o600, true, `mode was ${st.mode & 0o777}`);
  const back = readTokens(file);
  assert.ok(back);
  assert.equal(back!.accessToken, "AT");
  assert.equal(back!.email, "a@b.c");
  assert.equal(back!.planType, "plus");
});

test("writeTokens: replaces a pre-existing permissive file with 0600", (t) => {
  const file = mkfile(t);
  fs.writeFileSync(file, "old credentials", { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  writeTokens(okTokens(), file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("writeTokens: storage failure throws a sanitized AuthError", (t) => {
  const file = mkfile(t);
  fs.mkdirSync(file);
  const tokens = okTokens({ accessToken: "secret-access", refreshToken: "secret-refresh" });
  assert.throws(
    () => writeTokens(tokens, file),
    (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.match(error.message, /could not store credentials securely/);
      assert.doesNotMatch(error.message, /secret-access|secret-refresh/);
      assert.ok(!error.message.includes(file));
      return true;
    },
  );
});

test("readTokens: missing / corrupt → null (never throws)", (t) => {
  const file = mkfile(t);
  assert.equal(readTokens(file), null);
  fs.writeFileSync(file, "{ not json", "utf8");
  assert.equal(readTokens(file), null);
  fs.writeFileSync(file, JSON.stringify({ accessToken: "x" }), "utf8"); // missing fields
  assert.equal(readTokens(file), null);
});

test("clearTokens: removes the file; no-op when absent", (t) => {
  const file = mkfile(t);
  assert.equal(clearTokens(file), false);
  writeTokens(okTokens(), file);
  assert.equal(clearTokens(file), true);
  assert.equal(fs.existsSync(file), false);
});

test("resolveAccessToken: unexpired → returns stored, no refresh call", async (t) => {
  const file = mkfile(t);
  writeTokens(okTokens(), file);
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw new Error("should not be called");
  }) as unknown as typeof fetch;
  const tok = await resolveAccessToken({ file, now: () => NOW, fetchImpl });
  assert.equal(tok, "AT");
  assert.equal(calls, 0);
});

test("resolveAccessToken: force → refresh even when unexpired (401 recovery)", async (t) => {
  const file = mkfile(t);
  writeTokens(okTokens(), file); // unexpired (NOW + 1h)
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ access_token: "AT-forced", expires_in: 3600 }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  // Without force: the unexpired token is returned, no refresh.
  const stored = await resolveAccessToken({ file, now: () => NOW, fetchImpl });
  assert.equal(stored, "AT");
  assert.equal(calls, 0);
  // With force: the refresh fires despite the unexpired token.
  const forced = await resolveAccessToken({ file, now: () => NOW, fetchImpl, force: true });
  assert.equal(forced, "AT-forced");
  assert.equal(calls, 1);
  assert.equal(readTokens(file)!.accessToken, "AT-forced"); // persisted
});

test("resolveAccessToken: expired → refresh (json), rotation persisted", async (t) => {
  const file = mkfile(t);
  writeTokens(okTokens({ expiresAt: NOW - 1000 }), file);
  const seen = { body: {} as Record<string, string>, ct: "" };
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    // The ChatGPT refresh grant is a JSON body (Codex behavior).
    seen.body = JSON.parse(String(init?.body)) as Record<string, string>;
    seen.ct = (init?.headers as Record<string, string>)["content-type"] ?? "";
    return new Response(
      JSON.stringify({
        access_token: "AT2",
        refresh_token: "RT2",
        expires_in: 3600,
        token_type: "Bearer",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const tok = await resolveAccessToken({ file, now: () => NOW, fetchImpl });
  assert.equal(tok, "AT2");
  assert.equal(seen.body.grant_type, "refresh_token");
  assert.equal(seen.body.refresh_token, "RT");
  assert.match(seen.ct, /application\/json/);
  const back = readTokens(file);
  assert.equal(back!.accessToken, "AT2");
  assert.equal(back!.refreshToken, "RT2"); // rotated
});

test("resolveAccessToken: refresh omits refresh_token → keep the old one", async (t) => {
  const file = mkfile(t);
  writeTokens(okTokens({ expiresAt: NOW - 1000 }), file);
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ access_token: "AT2", expires_in: 3600 }),
      { status: 200 },
    )) as unknown as typeof fetch;
  await resolveAccessToken({ file, now: () => NOW, fetchImpl });
  assert.equal(readTokens(file)!.refreshToken, "RT");
});

test("resolveAccessToken: 4xx → AuthRequiredError (re-login), 5xx → AuthError", async (t) => {
  const file = mkfile(t);
  writeTokens(okTokens({ expiresAt: NOW - 1000 }), file);
  const status400 = (async () =>
    new Response("nope", { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(
    () => resolveAccessToken({ file, now: () => NOW, fetchImpl: status400 }),
    AuthRequiredError,
  );
  const status500 = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(
    () => resolveAccessToken({ file, now: () => NOW, fetchImpl: status500 }),
    AuthError,
  );
});

test("resolveAccessToken: no stored tokens → AuthRequiredError", async (t) => {
  const file = mkfile(t);
  await assert.rejects(
    () => resolveAccessToken({ file, now: () => NOW }),
    AuthRequiredError,
  );
});

test("idTokenClaims: decodes email + chatgpt_plan_type from the JWT", () => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/profile": { email: "me@example.com" },
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
    }),
  ).toString("base64url");
  const jwt = `${header}.${payload}.sig`;
  assert.deepEqual(idTokenClaims(jwt), { email: "me@example.com", planType: "plus" });
  assert.deepEqual(idTokenClaims("garbage"), {});
});
