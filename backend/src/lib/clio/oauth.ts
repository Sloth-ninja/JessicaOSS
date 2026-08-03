// Clio OAuth: authorization-code start + callback for both products, plus
// best-effort deauthorize on disconnect. Self-contained.
//
// State handling mirrors the MCP OAuth precedent (a server-held, one-time,
// TTL'd state that binds the callback to the user who started it) but keeps it
// in-process rather than in a DB table (no migration for a ~seconds-long
// handshake; the pilot runs a single always-warm machine). The state token is
// opaque random; the PKCE code_verifier is held server-side ONLY (never sent to
// the browser or Clio), keyed by a hash of the state. On callback we look the
// state up, verify it has not expired and that its product matches, consume it
// (one-time), and exchange the code.
//
// Manage is a confidential client with NO scope param (permissions fixed at app
// registration) and NO PKCE. Grow uses PKCE S256 + client secret and a
// space-separated scope param; its refresh tokens rotate on every use.

import crypto from "crypto";
import { createServerSupabase } from "../supabase";
import { safeErrorLog } from "../safeError";
import {
  CLIO_GROW_SCOPES,
  clioCredentials,
  clioHosts,
  clioRedirectUri,
  type ClioProduct,
} from "./config";
import {
  saveClioConnection,
  type ClioConnection,
  type ClioTokens,
} from "./connections";

type Db = ReturnType<typeof createServerSupabase>;

/** A user-safe OAuth failure — never carries raw provider text to the client. */
export class ClioOAuthError extends Error {
  constructor(message = "Clio authorisation failed. Please try again.") {
    super(message);
    this.name = "ClioOAuthError";
  }
}

// ---------------------------------------------------------------------------
// One-time, TTL'd, in-process OAuth state store. Keyed by sha256(state).
// ---------------------------------------------------------------------------

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface OAuthStateEntry {
  userId: string;
  product: ClioProduct;
  codeVerifier: string | null;
  expiresAt: number;
}

let oauthStates = new Map<string, OAuthStateEntry>();

/** Test-only: clears the in-process OAuth state store. */
export function resetClioOAuthStateForTests(): void {
  oauthStates = new Map<string, OAuthStateEntry>();
}

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function stateHash(state: string): string {
  return crypto.createHash("sha256").update(state).digest("hex");
}

function pruneExpiredStates(now: number): void {
  for (const [key, entry] of oauthStates) {
    if (entry.expiresAt <= now) oauthStates.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Token HTTP.
// ---------------------------------------------------------------------------

function parseTokenResponse(json: unknown): ClioTokens {
  if (!json || typeof json !== "object") {
    throw new ClioOAuthError();
  }
  const obj = json as Record<string, unknown>;
  const accessToken =
    typeof obj.access_token === "string" ? obj.access_token : null;
  if (!accessToken) throw new ClioOAuthError();
  const refreshToken =
    typeof obj.refresh_token === "string" ? obj.refresh_token : null;
  const expiresIn =
    typeof obj.expires_in === "number" && Number.isFinite(obj.expires_in)
      ? obj.expires_in
      : null;
  const scope = typeof obj.scope === "string" ? obj.scope : null;
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    scope,
  };
}

/**
 * POST an application/x-www-form-urlencoded token request to a product's token
 * endpoint and parse the token set. Used for both the authorization_code
 * exchange (here) and the refresh_token grant (client.ts). Throws
 * ClioOAuthError on any non-ok response or unparseable body — the raw body is
 * never surfaced.
 */
export async function postClioTokenRequest(
  product: ClioProduct,
  form: Record<string, string>,
): Promise<ClioTokens> {
  const { tokenUrl } = clioHosts(product);
  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    throw new ClioOAuthError("Could not reach Clio. Please try again.");
  }
  if (!res.ok) {
    throw new ClioOAuthError();
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ClioOAuthError();
  }
  return parseTokenResponse(json);
}

// ---------------------------------------------------------------------------
// Identity (who_am_i).
// ---------------------------------------------------------------------------

/**
 * Pull an {id, name} identity out of a who_am_i object, tolerating shape drift:
 * a top-level record OR one under `data`/`user`, a single `name` OR a
 * first_name/last_name pair. Returns null when neither an id nor a name is
 * present so the caller can fall through to the next candidate shape.
 */
function pickIdentity(
  source: unknown,
): { id: string | null; name: string | null } | null {
  if (!source || typeof source !== "object") return null;
  const o = source as Record<string, unknown>;
  const id = o.id != null ? String(o.id) : null;
  let name = typeof o.name === "string" && o.name.trim() ? o.name : null;
  if (!name) {
    const first = typeof o.first_name === "string" ? o.first_name : "";
    const last = typeof o.last_name === "string" ? o.last_name : "";
    const combined = `${first} ${last}`.trim();
    name = combined || null;
  }
  return id || name ? { id, name } : null;
}

/**
 * Best-effort identity fetch after a fresh connect, to snapshot
 * clio_user_id/clio_user_name for the connection-status display. Never throws:
 * a who_am_i hiccup just leaves the snapshot null (the connection is still
 * valid). Both products expose a live-verified who_am_i (spike 03/08):
 *   - Manage: GET /users/who_am_i.json?fields=id,name  ({data:{id,name}}),
 *   - Grow:   GET /users/who_am_i  (Platform shape — parsed defensively; the
 *             response carries the user + account/firm, so shape is tolerated).
 */
export async function fetchClioIdentity(
  product: ClioProduct,
  accessToken: string,
): Promise<{ id: string | null; name: string | null }> {
  try {
    const { apiBase } = clioHosts(product);
    const url =
      product === "manage"
        ? `${apiBase}/users/who_am_i.json?fields=id,name`
        : `${apiBase}/users/who_am_i`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!res.ok) return { id: null, name: null };
    const json = (await res.json()) as unknown;
    const obj =
      json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    // Manage nests under `data`; Grow may return the user at the top level or
    // under `data`/`user` — try each, defensively.
    return (
      pickIdentity(obj.data) ??
      pickIdentity(obj.user) ??
      pickIdentity(obj) ?? { id: null, name: null }
    );
  } catch (err) {
    console.error("[clio/oauth] who_am_i failed", safeErrorLog(err));
    return { id: null, name: null };
  }
}

// ---------------------------------------------------------------------------
// Start / callback.
// ---------------------------------------------------------------------------

export interface StartClioOAuthResult {
  authorizationUrl: string;
}

/**
 * Begin an authorization-code flow for (user, product). Mints a one-time state
 * bound to the user, stashes a PKCE verifier server-side for Grow, and returns
 * the authorize URL for the browser to visit. Throws ClioOAuthError when the
 * product's OAuth app is not configured.
 */
export function startClioOAuth(
  userId: string,
  product: ClioProduct,
): StartClioOAuthResult {
  const creds = clioCredentials(product);
  if (!creds) {
    throw new ClioOAuthError("Clio is not configured on this server.");
  }
  const { authorizeUrl } = clioHosts(product);
  const state = base64Url(crypto.randomBytes(32));
  const now = Date.now();
  pruneExpiredStates(now);

  const url = new URL(authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("redirect_uri", clioRedirectUri(product));
  url.searchParams.set("state", state);

  let codeVerifier: string | null = null;
  if (product === "grow") {
    // PKCE S256 + space-separated scope (Grow only). Manage takes no scope
    // param and no PKCE.
    codeVerifier = base64Url(crypto.randomBytes(64));
    const challenge = base64Url(
      crypto.createHash("sha256").update(codeVerifier).digest(),
    );
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("scope", CLIO_GROW_SCOPES);
  }

  oauthStates.set(stateHash(state), {
    userId,
    product,
    codeVerifier,
    expiresAt: now + OAUTH_STATE_TTL_MS,
  });

  return { authorizationUrl: url.toString() };
}

export interface CompleteClioOAuthResult {
  userId: string;
  product: ClioProduct;
  connection: ClioConnection;
}

/**
 * Complete an authorization-code flow: validate + consume the state, exchange
 * the code for tokens, snapshot identity, and persist the connection. The
 * `product` argument comes from the callback route's mount (the exact
 * registered path) and MUST match the product the state was minted for — a
 * mismatch is rejected. Throws ClioOAuthError on any failure.
 */
export async function completeClioOAuth(
  product: ClioProduct,
  state: string,
  code: string,
  db: Db = createServerSupabase(),
): Promise<CompleteClioOAuthResult> {
  if (!state || !code) throw new ClioOAuthError();
  const now = Date.now();
  pruneExpiredStates(now);

  const key = stateHash(state);
  const entry = oauthStates.get(key);
  // One-time use: consume immediately, before any await, so a replayed state
  // cannot race a second exchange.
  oauthStates.delete(key);
  if (!entry || entry.expiresAt <= now || entry.product !== product) {
    throw new ClioOAuthError();
  }

  const creds = clioCredentials(product);
  if (!creds)
    throw new ClioOAuthError("Clio is not configured on this server.");

  const form: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: clioRedirectUri(product),
  };
  if (product === "grow" && entry.codeVerifier) {
    form.code_verifier = entry.codeVerifier;
  }

  const tokens = await postClioTokenRequest(product, form);
  const identity = await fetchClioIdentity(product, tokens.accessToken);
  const connection = await saveClioConnection(db, {
    userId: entry.userId,
    product,
    tokens: {
      ...tokens,
      // Grow requests a fixed scope; record it for display when the response
      // omits it.
      scope: tokens.scope ?? (product === "grow" ? CLIO_GROW_SCOPES : null),
    },
    clioUserId: identity.id,
    clioUserName: identity.name,
  });

  return { userId: entry.userId, product, connection };
}

/**
 * Best-effort remote token revocation on disconnect. Manage refresh keeps the
 * OLD permission set and a silent re-auth reuses the existing grant, so a clean
 * disconnect MUST call the product's deauthorize/revoke endpoint — otherwise a
 * reconnect after a permissions change silently reuses the stale grant (the
 * clio-file-exporter gotcha). Failures are logged, never thrown: local deletion
 * proceeds regardless so the user is never stuck "connected".
 */
export async function deauthorizeClio(
  product: ClioProduct,
  accessToken: string,
): Promise<void> {
  const creds = clioCredentials(product);
  if (!creds) return;
  const { revokeUrl } = clioHosts(product);
  try {
    // Manage /oauth/deauthorize and Grow /oauth/revoke both accept the token in
    // the form body; include client credentials for the revoke variant.
    await fetch(revokeUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        token: accessToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }).toString(),
    });
  } catch (err) {
    console.error("[clio/oauth] deauthorize failed (best-effort)", {
      product,
      error: safeErrorLog(err),
    });
  }
}
