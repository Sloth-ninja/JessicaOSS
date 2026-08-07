// Per-user authenticated Clio client for both products. Handles:
//   - loading + decrypting the user's stored token (connections.ts),
//   - proactive refresh when the access token is near expiry, and a single
//     refresh+retry on a 401,
//   - atomic persistence of Grow's rotating refresh tokens (BEFORE the new
//     access token is used — a lost rotation strands the connection),
//   - the X-API-VERSION pin + `fields=` discipline on Manage,
//   - rate limits: Manage 50 req/min per user token (per-user bucket); Grow
//     3 req/s shared across ALL users (one app-wide bucket) — be frugal,
//     no polling loops in v1,
//   - honouring 429 Retry-After with a single capped retry, and proactive
//     backoff — when a response reports zero remaining + a reset, the next call
//     for that bucket waits until reset (capped) or fails fast,
//   - fixed, generic error mapping (raw Clio errors never reach users;
//     server-side logs are redacted via safeErrorLog).

import { TokenBucket } from "../rateLimit";
import { createServerSupabase } from "../supabase";
import { safeErrorLog } from "../safeError";
import {
  clioCredentials,
  clioGrowApiVersion,
  clioHosts,
  clioManageApiVersion,
  type ClioProduct,
} from "./config";
import {
  deleteClioConnection,
  loadClioConnection,
  persistRefreshedTokens,
  type ClioConnection,
} from "./connections";
import { ClioOAuthError, postClioTokenRequest } from "./oauth";

type Db = ReturnType<typeof createServerSupabase>;

/** Generic, user-safe Clio API failure. */
export class ClioApiError extends Error {
  status?: number;
  constructor(
    message = "Clio request failed. Please try again.",
    status?: number,
  ) {
    super(message);
    this.name = "ClioApiError";
    this.status = status;
  }
}

/** The user must (re)connect Clio — not connected, or auth irrecoverably failed. */
export class ClioAuthError extends ClioApiError {
  constructor(message = "Connect your Clio account to use this.") {
    super(message, 401);
    this.name = "ClioAuthError";
  }
}

/** Rate limit hit and not recoverable within one short retry. */
export class ClioRateLimitError extends ClioApiError {
  constructor(
    message = "Clio is rate-limiting requests just now. Please try again shortly.",
  ) {
    super(message, 429);
    this.name = "ClioRateLimitError";
  }
}

// ---------------------------------------------------------------------------
// Rate limiting. Module-level, process-wide (intentional — one limiter per
// user token for Manage, one shared limiter for the whole Grow app).
// ---------------------------------------------------------------------------

const MANAGE_BUCKET_CAPACITY = 50;
const MANAGE_BUCKET_WINDOW_MS = 60 * 1000;
// Grow: 3 req/s shared across all users. Model as a per-second bucket.
const GROW_BUCKET_CAPACITY = 3;
const GROW_BUCKET_WINDOW_MS = 1000;
// Never wait longer than this on a Retry-After before giving up (frugal).
const MAX_RETRY_AFTER_MS = 3000;

let manageBuckets = new Map<string, TokenBucket>();
let growBucket = new TokenBucket(GROW_BUCKET_CAPACITY, GROW_BUCKET_WINDOW_MS);
// Proactive backoff: when a response reports zero requests remaining, the next
// call for that same bucket must wait until the window resets rather than fire
// into a guaranteed 429. Keyed the same way as the rate bucket (per-user for
// Manage, app-wide for Grow); value is the absolute reset time (ms).
let backoffUntil = new Map<string, number>();

/** Test-only: reset all module-level client rate-limit state. */
export function resetClioClientStateForTests(): void {
  manageBuckets = new Map<string, TokenBucket>();
  growBucket = new TokenBucket(GROW_BUCKET_CAPACITY, GROW_BUCKET_WINDOW_MS);
  backoffUntil = new Map<string, number>();
}

/** Rate-bucket + backoff key: per-user for Manage, single app-wide for Grow. */
function bucketKey(product: ClioProduct, userId: string): string {
  return product === "grow" ? "grow" : `manage:${userId}`;
}

function acquireRateToken(product: ClioProduct, userId: string): boolean {
  if (product === "grow") return growBucket.tryRemoveToken();
  let bucket = manageBuckets.get(userId);
  if (!bucket) {
    bucket = new TokenBucket(MANAGE_BUCKET_CAPACITY, MANAGE_BUCKET_WINDOW_MS);
    manageBuckets.set(userId, bucket);
  }
  return bucket.tryRemoveToken();
}

/**
 * Parse a Retry-After header (delta-seconds or an HTTP-date) into milliseconds,
 * or null when absent/unparseable. Exported for unit testing.
 */
export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

/**
 * True when the rate-limit headers indicate zero requests remaining, i.e. the
 * next call should back off proactively rather than be issued. Exported for
 * unit testing.
 */
export function isRateLimitExhausted(headers: Headers): boolean {
  const remaining = headers.get("x-ratelimit-remaining");
  if (remaining == null) return false;
  const n = Number(remaining);
  return Number.isFinite(n) && n <= 0;
}

/**
 * Parse an X-RateLimit-Reset header into an ABSOLUTE reset time (ms), or null
 * when absent/unparseable. Tolerates the two shapes seen in the wild: a Unix
 * epoch in seconds (large value → absolute) and a delta in seconds-until-reset
 * (small value → now + delta). Exported for unit testing.
 */
export function parseRateLimitResetMs(
  headers: Headers,
  now: number = Date.now(),
): number | null {
  const raw = headers.get("x-ratelimit-reset");
  if (!raw) return null;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) {
    const dateMs = Date.parse(raw);
    return Number.isFinite(dateMs) ? dateMs : null;
  }
  // Values that look like a Unix epoch (seconds) are absolute; smaller values
  // are a delta in seconds from now.
  return n > 1_000_000_000 ? n * 1000 : now + n * 1000;
}

/**
 * After a response, record a proactive backoff for the bucket when the headers
 * say zero remaining and carry a future reset — so the NEXT call for that
 * bucket waits (or fails fast) instead of issuing a doomed request.
 */
function recordBackoff(
  product: ClioProduct,
  userId: string,
  headers: Headers,
  now: number,
): void {
  if (!isRateLimitExhausted(headers)) return;
  const resetMs = parseRateLimitResetMs(headers, now);
  if (resetMs != null && resetMs > now) {
    backoffUntil.set(bucketKey(product, userId), resetMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Token freshness / refresh.
// ---------------------------------------------------------------------------

function isNearExpiry(connection: ClioConnection): boolean {
  const expiresAt = connection.tokens.expiresAt;
  if (!expiresAt) return false;
  return expiresAt.getTime() < Date.now() + 60_000;
}

/**
 * Exchange the stored refresh token for a fresh access token and persist the
 * result ATOMICALLY before returning it. For Grow, Clio rotates the refresh
 * token on every use, so the response's new refresh token is persisted before
 * the new access token is used; if the response omits a refresh token (Manage
 * is non-rotating) the existing one is retained. A persistence failure throws
 * (the caller must not proceed) and leaves the stored row unchanged.
 */
export async function refreshClioConnection(
  db: Db,
  connection: ClioConnection,
): Promise<ClioConnection> {
  const creds = clioCredentials(connection.product);
  const refreshToken = connection.tokens.refreshToken;
  if (!creds || !refreshToken) {
    throw new ClioAuthError();
  }
  const tokens = await postClioTokenRequest(connection.product, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  // Grow returns a NEW refresh token that must replace the old one; Manage may
  // omit it, in which case the existing (long-lived) token is retained.
  const nextRefresh = tokens.refreshToken ?? refreshToken;
  return persistRefreshedTokens(db, connection.id, {
    ...tokens,
    refreshToken: nextRefresh,
    scope: tokens.scope ?? connection.tokens.scope,
  });
}

/**
 * Delete the stored connection when a refresh failed because the GRANT itself
 * was rejected (OAuth `invalid_grant`) — the refresh token is dead, so keeping
 * an unusable encrypted row only leaves a stale "connected" pill that never
 * self-heals. A transient/network refresh failure is NOT pruned (the grant may
 * still be good on the next attempt). Best-effort: a delete failure is swallowed
 * so it never masks the original auth error the caller is about to throw.
 */
async function pruneDeadClioGrant(
  db: Db,
  userId: string,
  product: ClioProduct,
  err: unknown,
): Promise<void> {
  if (!(err instanceof ClioOAuthError) || !err.invalidGrant) return;
  try {
    await deleteClioConnection(db, userId, product);
  } catch (delErr) {
    console.error("[clio/client] prune of dead grant failed", {
      product,
      error: safeErrorLog(delErr),
    });
  }
}

// ---------------------------------------------------------------------------
// Authenticated request.
// ---------------------------------------------------------------------------

export interface ClioRequestOptions {
  method?: string;
  /** Query params (values stringified; undefined dropped). */
  query?: Record<string, string | number | boolean | undefined>;
  /** Manage `fields=` selector — default responses are id+etag only. */
  fields?: string;
  /** JSON body (serialised + Content-Type set). */
  json?: unknown;
  /**
   * Extra request headers — the optimistic-concurrency `If-Match` on activity
   * updates is the only current use. Applied BENEATH the fixed headers, so a
   * caller can never override Authorization / X-API-VERSION / Accept.
   */
  headers?: Record<string, string>;
}

function buildUrl(
  apiBase: string,
  path: string,
  opts: ClioRequestOptions,
): string {
  const url = new URL(`${apiBase}${path.startsWith("/") ? path : `/${path}`}`);
  if (opts.fields) url.searchParams.set("fields", opts.fields);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Header names this module owns outright. A caller-supplied header matching any
// of these (in ANY casing) is DROPPED rather than merged: object spread is
// case-SENSITIVE, so `{ authorization: ... }` would survive alongside our
// `Authorization` — and `new Headers()` then joins case-differing duplicates
// into one comma-separated value ("Bearer attacker, Bearer real"), which some
// servers parse as the first. Dropping is the only safe merge.
const FIXED_HEADER_NAMES = new Set([
  "accept",
  "authorization",
  "x-api-version",
  "content-type",
]);

function headersFor(
  product: ClioProduct,
  accessToken: string,
  hasBody: boolean,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (FIXED_HEADER_NAMES.has(name.trim().toLowerCase())) continue;
    headers[name] = value;
  }
  headers.Accept = "application/json";
  headers.Authorization = `Bearer ${accessToken}`;
  if (product === "manage") {
    headers["X-API-VERSION"] = clioManageApiVersion();
  } else {
    const growVersion = clioGrowApiVersion();
    if (growVersion) headers["X-API-Version"] = growVersion;
  }
  if (hasBody) headers["Content-Type"] = "application/json";
  return headers;
}

async function doFetch(
  url: string,
  product: ClioProduct,
  accessToken: string,
  opts: ClioRequestOptions,
): Promise<Response> {
  const hasBody = opts.json !== undefined;
  return fetch(url, {
    method: opts.method ?? "GET",
    headers: headersFor(product, accessToken, hasBody, opts.headers),
    ...(hasBody ? { body: JSON.stringify(opts.json) } : {}),
  });
}

/**
 * Make an authenticated request to a product's API and return the parsed JSON
 * body (or null for a 204). Auto-refreshes a near-expiry token before the call,
 * retries once after a 401 (single refresh + retry), honours a 429 Retry-After
 * once (capped), applies a PROACTIVE backoff when a prior response reported zero
 * requests remaining (waits until the recorded reset, capped, else fails fast),
 * and maps every failure onto a fixed, generic error.
 */
export async function clioRequest(
  db: Db,
  userId: string,
  product: ClioProduct,
  path: string,
  opts: ClioRequestOptions = {},
): Promise<unknown> {
  let connection = await loadClioConnection(db, userId, product);
  if (!connection) throw new ClioAuthError();
  if (isNearExpiry(connection)) {
    try {
      connection = await refreshClioConnection(db, connection);
    } catch (err) {
      // A dead refresh grant here means the stored connection can never be
      // used again — prune it so status self-heals; transient failures rethrow
      // unchanged (the grant may still be good next time).
      await pruneDeadClioGrant(db, userId, product, err);
      throw err;
    }
  }

  const { apiBase } = clioHosts(product);
  const url = buildUrl(apiBase, path, opts);

  // Proactive backoff: a prior response for this bucket reported zero remaining,
  // so wait until its reset before issuing another request. If the wait exceeds
  // the cap, fail fast with the fixed rate-limit message rather than block.
  const key = bucketKey(product, userId);
  const until = backoffUntil.get(key);
  if (until !== undefined) {
    const now = Date.now();
    if (until > now) {
      const wait = until - now;
      if (wait > MAX_RETRY_AFTER_MS) throw new ClioRateLimitError();
      await sleep(wait);
    }
    // One-shot: the window has (or will have) reset — clear and proceed.
    backoffUntil.delete(key);
  }

  if (!acquireRateToken(product, userId)) {
    throw new ClioRateLimitError();
  }

  let res: Response;
  try {
    res = await doFetch(url, product, connection.tokens.accessToken, opts);
  } catch (err) {
    console.error("[clio/client] network error", {
      product,
      error: safeErrorLog(err),
    });
    throw new ClioApiError("Could not reach Clio. Please try again.");
  }

  // Single refresh + retry on an expired/invalid access token.
  if (res.status === 401) {
    try {
      connection = await refreshClioConnection(db, connection);
    } catch (err) {
      // Prune the connection when the refresh grant itself was rejected (dead
      // token) so the stale "connected" pill self-heals; transient failures
      // just surface as a reconnect prompt without deleting the row.
      await pruneDeadClioGrant(db, userId, product, err);
      throw new ClioAuthError();
    }
    if (!acquireRateToken(product, userId)) throw new ClioRateLimitError();
    try {
      res = await doFetch(url, product, connection.tokens.accessToken, opts);
    } catch (err) {
      console.error("[clio/client] network error (post-refresh)", {
        product,
        error: safeErrorLog(err),
      });
      throw new ClioApiError("Could not reach Clio. Please try again.");
    }
    if (res.status === 401) throw new ClioAuthError();
  }

  // Honour a 429 Retry-After exactly once (capped), then give up.
  if (res.status === 429) {
    const waitMs = parseRetryAfterMs(res.headers.get("retry-after"));
    if (waitMs != null && waitMs <= MAX_RETRY_AFTER_MS) {
      await sleep(waitMs);
      if (!acquireRateToken(product, userId)) throw new ClioRateLimitError();
      try {
        res = await doFetch(url, product, connection.tokens.accessToken, opts);
      } catch (err) {
        console.error("[clio/client] network error (post-429)", {
          product,
          error: safeErrorLog(err),
        });
        throw new ClioApiError("Could not reach Clio. Please try again.");
      }
    }
    if (res.status === 429) throw new ClioRateLimitError();
  }

  // Record a proactive backoff for the NEXT call if this response drained the
  // window (X-RateLimit-Remaining 0 + a future Reset).
  recordBackoff(product, userId, res.headers, Date.now());

  if (res.status === 204) return null;

  if (!res.ok) {
    console.error("[clio/client] request failed", {
      product,
      status: res.status,
    });
    if (res.status === 404) {
      throw new ClioApiError("That Clio record was not found.", 404);
    }
    if (res.status === 403) {
      throw new ClioApiError("Your Clio permissions do not allow that.", 403);
    }
    throw new ClioApiError(undefined, res.status);
  }

  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cursor pagination helpers.
// ---------------------------------------------------------------------------

/**
 * Follow Manage cursor pagination (`meta.paging.next` is a full next-page URL)
 * up to `maxPages`, concatenating each page's `data` array. Frugal by design —
 * a low page cap, no unbounded loops.
 */
export async function clioPaginateManage(
  db: Db,
  userId: string,
  path: string,
  opts: ClioRequestOptions = {},
  maxPages = 3,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let nextPath: string | null = path;
  // Only the first page carries the caller's fields/query; subsequent `next`
  // URLs already encode everything, so we stop re-applying them.
  let pageOpts: ClioRequestOptions = opts;
  for (let page = 0; page < maxPages && nextPath; page += 1) {
    const body = (await clioRequest(
      db,
      userId,
      "manage",
      nextPath,
      pageOpts,
    )) as { data?: unknown[]; meta?: { paging?: { next?: string } } } | null;
    if (Array.isArray(body?.data)) out.push(...body.data);
    const next = body?.meta?.paging?.next;
    if (typeof next === "string" && next) {
      // `next` is a full URL; fold path + querystring relative to the API base.
      const u = new URL(next);
      nextPath = `${u.pathname.replace(/^\/api\/v4/, "")}${u.search}`;
      pageOpts = { method: opts.method };
    } else {
      nextPath = null;
    }
  }
  return out;
}
