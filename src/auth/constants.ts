/**
 * D15 — ChatGPT (Codex-style) OAuth + Responses API constants.
 *
 * Values verified against the openai/codex reference implementation
 * (`codex-rs/login/src/auth/manager.rs`, `codex-rs/login/src/oauth/*`):
 * a PUBLIC OAuth client (authorization-code + PKCE, no client secret) that
 * trades the user's ChatGPT login for an expiring access token (JWT) plus a
 * long-lived refresh token. The access token is sent as `Bearer` to the
 * Responses API and bills against the user's ChatGPT SUBSCRIPTION (rate
 * limits), not API billing.
 *
 * These are public identifiers (a public client id is not a secret), but the
 * tokens they mint ARE secrets — see token-store.ts for storage rules.
 */

/** Public OAuth client id (the same one Codex ships; public client, no secret). */
export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Authorization endpoint (the user logs in here). */
export const CHATGPT_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";

/** Token endpoint (code exchange + refresh). */
export const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Revocation endpoint (logout). */
export const CHATGPT_REVOKE_URL = "https://auth.openai.com/oauth/revoke";

/** Scopes requested at authorize time. */
export const CHATGPT_SCOPES = "openid profile email offline_access";

/**
 * Registered loopback callback ports for the shared Codex client id.
 * `auth.openai.com` only accepts redirect URIs on these ports for this
 * client (1455 default, 1457 fallback — the same pair Codex binds); a random
 * port is unregistered and the authorize endpoint rejects it with
 * `invalid_authorize_request`.
 */
export const CHATGPT_CALLBACK_PORTS = [1455, 1457] as const;

/** Registered callback path (NOT `/callback` — that path is unregistered). */
export const CHATGPT_CALLBACK_PATH = "/auth/callback";

/**
 * The ChatGPT subscription backend speaks the Responses API. `baseUrl` in
 * models.json is the API root; the wire appends `/responses`.
 */
export const CHATGPT_API_BASE = "https://api.openai.com/v1";

/**
 * Env override for the token file location (tests, multiple accounts).
 * Default: `~/.tre/chatgpt-auth.json`.
 */
export const CHATGPT_AUTH_ENV = "TRE_CHATGPT_AUTH";

/** Default token file name under `~/.tre/`. */
export const CHATGPT_AUTH_FILE = "chatgpt-auth.json";
