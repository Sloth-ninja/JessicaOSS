// Clio connector configuration: region-derived host maps, OAuth client
// credentials, and redirect-URI derivation. Self-contained per the
// architectural rule (CLAUDE.md 22/07) — no upstream entanglement.
//
// Two independent products, each a separate Clio app with its own OAuth
// client and its own callback path:
//   - Manage: day-to-day practice management (matters, contacts, time,
//     documents, billing read). Confidential client, no PKCE.
//   - Grow ("Clio Platform"): client intake (leads, intake matters + notes).
//     PKCE S256 + client secret; refresh tokens ROTATE on every use.
//
// Region is EU today (UK firms are EU-region; tokens are region-bound). The
// host maps are structured so us/ca/au can be added without touching callers.

export type ClioProduct = "manage" | "grow";

export type ClioRegion = "us" | "eu" | "ca" | "au";

export interface ClioProductHosts {
  /** OAuth authorize endpoint (browser redirect target). */
  authorizeUrl: string;
  /** OAuth token endpoint (code exchange + refresh). */
  tokenUrl: string;
  /** Best-effort token revocation/deauthorize endpoint (disconnect). */
  revokeUrl: string;
  /** API base for data calls (no trailing slash). */
  apiBase: string;
}

// Region prefix applied to the Clio Manage app host (US has no prefix).
const MANAGE_REGION_PREFIX: Record<ClioRegion, string> = {
  us: "app",
  eu: "eu.app",
  ca: "ca.app",
  au: "au.app",
};

// Region prefix for the Grow ("Platform") auth + API hosts (US has no prefix).
const GROW_AUTH_REGION_PREFIX: Record<ClioRegion, string> = {
  us: "auth.api",
  eu: "eu.auth.api",
  ca: "ca.auth.api",
  au: "au.auth.api",
};

const GROW_API_REGION_PREFIX: Record<ClioRegion, string> = {
  us: "api",
  eu: "eu.api",
  ca: "ca.api",
  au: "au.api",
};

/**
 * Resolve the configured region. Defaults to `eu` (the pilot firm). An
 * unrecognised value falls back to `eu` rather than throwing — a mis-set env
 * var must not break the whole backend at import time.
 */
export function clioRegion(): ClioRegion {
  const raw = (process.env.CLIO_REGION ?? "eu").trim().toLowerCase();
  if (raw === "us" || raw === "eu" || raw === "ca" || raw === "au") return raw;
  return "eu";
}

/**
 * Host map for a product in the current region. Verified live (03/08/2026):
 *   Manage EU authorize/token https://eu.app.clio.com/oauth/{authorize,token},
 *   deauthorize /oauth/deauthorize, API https://eu.app.clio.com/api/v4.
 *   Grow EU authorize/token/revoke https://eu.auth.api.clio.com/oauth/*,
 *   API https://eu.api.clio.com/grow.
 */
export function clioHosts(
  product: ClioProduct,
  region: ClioRegion = clioRegion(),
): ClioProductHosts {
  if (product === "manage") {
    const host = `${MANAGE_REGION_PREFIX[region]}.clio.com`;
    return {
      authorizeUrl: `https://${host}/oauth/authorize`,
      tokenUrl: `https://${host}/oauth/token`,
      revokeUrl: `https://${host}/oauth/deauthorize`,
      apiBase: `https://${host}/api/v4`,
    };
  }
  const authHost = `${GROW_AUTH_REGION_PREFIX[region]}.clio.com`;
  const apiHost = `${GROW_API_REGION_PREFIX[region]}.clio.com`;
  return {
    authorizeUrl: `https://${authHost}/oauth/authorize`,
    tokenUrl: `https://${authHost}/oauth/token`,
    revokeUrl: `https://${authHost}/oauth/revoke`,
    apiBase: `https://${apiHost}/grow`,
  };
}

// Space-separated scope requested at Grow authorize. Manage takes NO scope
// param — its permissions are fixed at app registration (verified 03/08).
export const CLIO_GROW_SCOPES = [
  "grow_lead_inbox_read",
  "grow_custom_action_read",
  "grow_matter_read",
  "grow_matter_note_read",
  "grow_contact_read",
  "grow_contact_note_read",
  "grow_user_read",
].join(" ");

/**
 * X-API-VERSION pinned on every Clio Manage request. Research: the header
 * exists and pinning the current major freezes response/field semantics (most
 * importantly `activities.quantity` in SECONDS). Overridable via env so an
 * operator can bump it without a code change; default is the current v4 major.
 */
export function clioManageApiVersion(): string {
  return (process.env.CLIO_MANAGE_API_VERSION ?? "4.0.11").trim() || "4.0.11";
}

/**
 * Optional date-based X-API-Version for Clio Grow ("Platform"). Grow versions
 * are date strings; the value is unverified at build time, so it is sent ONLY
 * when an operator sets CLIO_GROW_API_VERSION (an unknown/wrong date could be
 * rejected — default is to send no version header and take Grow's default).
 */
export function clioGrowApiVersion(): string | null {
  const raw = (process.env.CLIO_GROW_API_VERSION ?? "").trim();
  return raw || null;
}

export interface ClioClientCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * OAuth client credentials for a product, or null when unconfigured. Manage
 * uses CLIO_CLIENT_ID/SECRET; Grow uses CLIO_GROW_CLIENT_ID/SECRET (separate
 * app). Never logged — callers treat null as "connector unavailable".
 */
export function clioCredentials(
  product: ClioProduct,
): ClioClientCredentials | null {
  const idVar = product === "manage" ? "CLIO_CLIENT_ID" : "CLIO_GROW_CLIENT_ID";
  const secretVar =
    product === "manage" ? "CLIO_CLIENT_SECRET" : "CLIO_GROW_CLIENT_SECRET";
  const clientId = (process.env[idVar] ?? "").trim();
  const clientSecret = (process.env[secretVar] ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** True when a product's OAuth app is configured-enough to attempt. */
export function clioConfigured(product: ClioProduct): boolean {
  return clioCredentials(product) !== null;
}

/**
 * Base public URL of this backend, used to build the OAuth redirect URIs.
 * Mirrors the MCP OAuth callback base logic (routes/user.ts `backendPublicUrl`)
 * but WITHOUT a per-request host fallback: the redirect URI must equal one of
 * the values registered with Clio exactly, so it derives only from configured
 * env (API_PUBLIC_URL / BACKEND_URL) with the registered localhost literal
 * (127.0.0.1:3001 — `localhost` is banned by Clio) as the dev default.
 */
export function clioBackendBaseUrl(): string {
  return (
    process.env.API_PUBLIC_URL ||
    process.env.BACKEND_URL ||
    "http://127.0.0.1:3001"
  ).replace(/\/+$/, "");
}

/** The OAuth callback path for a product (the exact registered path). */
export function clioCallbackPath(product: ClioProduct): string {
  return product === "manage"
    ? "/clio/oauth/callback"
    : "/clio-grow/oauth/callback";
}

/** Full redirect URI for a product — must match a registered URI exactly. */
export function clioRedirectUri(product: ClioProduct): string {
  return `${clioBackendBaseUrl()}${clioCallbackPath(product)}`;
}
