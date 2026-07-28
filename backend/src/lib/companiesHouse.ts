// Typed client for the Companies House public data API
// (https://developer.company-information.service.gov.uk/). Free, requires
// a per-application API key registered by the caller (per-user stored key,
// else COMPANIES_HOUSE_API_KEY env fallback — resolved by callers via
// getUserApiKeys, not this module).
//
// Auth: HTTP Basic, API key as username, blank password.
// Rate limit: 600 requests / 5 minutes per key — we self-limit to 500
// (headroom) via an in-process token bucket, plus single-flight
// de-duplication and a small TTL cache to avoid redundant calls.
//
// Never include the API key value in a thrown error message — Companies
// House keys are not covered by safeError.ts's redaction patterns, so
// errors here are built from status + context only, never from raw
// request/response dumps.

import { SingleFlight, TokenBucket } from "./rateLimit";

const BASE_URL = "https://api.company-information.service.gov.uk";
const DOCUMENT_API_BASE =
  "https://document-api.company-information.service.gov.uk";

// Reject any filing document larger than this — a guard against pathological
// filings exhausting memory (we buffer the bytes before streaming them).
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

// Real limit is 600 req / 5 min per key; act at 500 for headroom.
const BUCKET_CAPACITY = 500;
const BUCKET_WINDOW_MS = 5 * 60 * 1000;

const PROFILE_TTL_MS = 15 * 60 * 1000; // profile / officers / PSCs
const SEARCH_TTL_MS = 5 * 60 * 1000;
const FILING_HISTORY_TTL_MS = 60 * 60 * 1000;

const MAX_CACHE_ENTRIES = 500;

export class CompaniesHouseError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "CompaniesHouseError";
    this.status = status;
  }
}

/**
 * Normalises a user/model-supplied company number: uppercases, and pads
 * the numeric portion to reach the standard 8-character length (e.g. a
 * bare "123" becomes "00000123"; a Scottish "SC12345" becomes "SC012345").
 * Inputs that don't look like `<letters><digits>` are returned
 * uppercased/trimmed as-is so the API can return its own error.
 */
export function normalizeCompanyNumber(input: string): string {
  const trimmed = input.trim().toUpperCase();
  const match = trimmed.match(/^([A-Z]*)(\d+)$/);
  if (!match) return trimmed;
  const [, prefix, digits] = match;
  const digitsNeeded = Math.max(8 - prefix.length, digits.length);
  return `${prefix}${digits.padStart(digitsNeeded, "0")}`;
}

// ---------------------------------------------------------------------------
// In-process rate limiting, single-flight de-dup, TTL cache.
// Module-level state is intentional: one process-wide limiter per API key,
// shared across requests/users within this backend instance.
// ---------------------------------------------------------------------------

let buckets = new Map<string, TokenBucket>();
let inflight = new SingleFlight<unknown>();

type CacheEntry = { value: unknown; expiresAt: number };
let cacheStore = new Map<string, CacheEntry>();

/** Test-only: clears all module-level state between test cases. */
export function resetCompaniesHouseStateForTests(): void {
  buckets = new Map<string, TokenBucket>();
  inflight = new SingleFlight<unknown>();
  cacheStore = new Map<string, CacheEntry>();
}

function bucketForKey(apiKey: string): TokenBucket {
  let bucket = buckets.get(apiKey);
  if (!bucket) {
    bucket = new TokenBucket(BUCKET_CAPACITY, BUCKET_WINDOW_MS);
    buckets.set(apiKey, bucket);
  }
  return bucket;
}

function cacheGet(key: string): { hit: true; value: unknown } | { hit: false } {
  const entry = cacheStore.get(key);
  if (!entry) return { hit: false };
  if (entry.expiresAt <= Date.now()) {
    cacheStore.delete(key);
    return { hit: false };
  }
  // Refresh recency (LRU-ish eviction order).
  cacheStore.delete(key);
  cacheStore.set(key, entry);
  return { hit: true, value: entry.value };
}

function cacheSet(key: string, value: unknown, ttlMs: number): void {
  if (cacheStore.size >= MAX_CACHE_ENTRIES && !cacheStore.has(key)) {
    const oldestKey = cacheStore.keys().next().value;
    if (oldestKey !== undefined) cacheStore.delete(oldestKey);
  }
  cacheStore.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function buildUrl(
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(path, BASE_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function authHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

async function fetchJson(
  url: string,
  apiKey: string,
  notFoundMessage: string | undefined,
): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: authHeader(apiKey) },
      });
    } catch {
      throw new CompaniesHouseError(
        "Failed to reach the Companies House API. Please try again.",
      );
    }

    if (res.ok) return res.json();

    if (res.status === 401) {
      throw new CompaniesHouseError(
        "Companies House API key invalid or missing",
        401,
      );
    }
    if (res.status === 404) {
      throw new CompaniesHouseError(
        notFoundMessage ?? "Company not found on the Companies House register.",
        404,
      );
    }
    if (res.status === 429) {
      throw new CompaniesHouseError(
        "Companies House rate limit exceeded — pausing requests until the 5-minute window resets.",
        429,
      );
    }
    if (res.status >= 500 && attempt < 2) {
      // One retry for transient server errors.
      continue;
    }
    throw new CompaniesHouseError(
      `Companies House request failed with status ${res.status}.`,
      res.status,
    );
  }
}

async function chGet(
  apiKey: string,
  path: string,
  query: Record<string, string | number | undefined> | undefined,
  opts: { ttlMs: number; notFoundMessage?: string },
): Promise<unknown> {
  if (!apiKey || !apiKey.trim()) {
    throw new CompaniesHouseError(
      "Companies House API key invalid or missing",
      401,
    );
  }
  const url = buildUrl(path, query);

  const cached = cacheGet(url);
  if (cached.hit) return cached.value;

  return inflight.run(url, async () => {
    // Re-check in case a concurrent caller populated the cache while this
    // call was waiting to be scheduled.
    const cachedAgain = cacheGet(url);
    if (cachedAgain.hit) return cachedAgain.value;

    const bucket = bucketForKey(apiKey);
    if (!bucket.tryRemoveToken()) {
      throw new CompaniesHouseError(
        "Companies House rate limit reached for this key — pausing requests until the 5-minute window resets.",
        429,
      );
    }

    const data = await fetchJson(url, apiKey, opts.notFoundMessage);
    cacheSet(url, data, opts.ttlMs);
    return data;
  });
}

export async function searchCompanies(
  apiKey: string,
  query: string,
  itemsPerPage = 20,
): Promise<unknown> {
  return chGet(
    apiKey,
    "/search/companies",
    { q: query, items_per_page: itemsPerPage },
    { ttlMs: SEARCH_TTL_MS },
  );
}

export async function getCompanyProfile(
  apiKey: string,
  companyNumberRaw: string,
): Promise<unknown> {
  const companyNumber = normalizeCompanyNumber(companyNumberRaw);
  return chGet(apiKey, `/company/${companyNumber}`, undefined, {
    ttlMs: PROFILE_TTL_MS,
    notFoundMessage: `No company found with number ${companyNumber}`,
  });
}

export async function getCompanyOfficers(
  apiKey: string,
  companyNumberRaw: string,
): Promise<unknown> {
  const companyNumber = normalizeCompanyNumber(companyNumberRaw);
  return chGet(apiKey, `/company/${companyNumber}/officers`, undefined, {
    ttlMs: PROFILE_TTL_MS,
    notFoundMessage: `No company found with number ${companyNumber}`,
  });
}

export async function getCompanyPSCs(
  apiKey: string,
  companyNumberRaw: string,
): Promise<unknown> {
  const companyNumber = normalizeCompanyNumber(companyNumberRaw);
  return chGet(
    apiKey,
    `/company/${companyNumber}/persons-with-significant-control`,
    undefined,
    {
      ttlMs: PROFILE_TTL_MS,
      notFoundMessage: `No company found with number ${companyNumber}`,
    },
  );
}

export async function getFilingHistory(
  apiKey: string,
  companyNumberRaw: string,
  opts?: { itemsPerPage?: number; startIndex?: number },
): Promise<unknown> {
  const companyNumber = normalizeCompanyNumber(companyNumberRaw);
  return chGet(
    apiKey,
    `/company/${companyNumber}/filing-history`,
    {
      items_per_page: opts?.itemsPerPage ?? 25,
      start_index: opts?.startIndex ?? 0,
    },
    {
      ttlMs: FILING_HISTORY_TTL_MS,
      notFoundMessage: `No company found with number ${companyNumber}`,
    },
  );
}

// ---------------------------------------------------------------------------
// Filing document retrieval (Companies House Document API).
//
// A filing-history transaction carries a `links.document_metadata` URL on the
// separate document-api host. Fetching a filing PDF is a three-hop dance:
//   1. GET the filing-history transaction         → links.document_metadata
//   2. GET that metadata URL (Document API)        → links.document (content)
//   3. GET the content URL with Accept: <mime>     → 302 to a signed S3 URL,
//                                                    which serves the bytes.
// Node's fetch (undici) drops the Authorization header when it follows a
// cross-origin redirect, so the API key never reaches the signed S3 host.
// ---------------------------------------------------------------------------

/**
 * Fetches a single filing-history transaction (the metadata for one filing),
 * which includes `links.document_metadata`, `date`, and `type`.
 */
export async function getFilingTransaction(
  apiKey: string,
  companyNumberRaw: string,
  transactionId: string,
): Promise<unknown> {
  const companyNumber = normalizeCompanyNumber(companyNumberRaw);
  return chGet(
    apiKey,
    `/company/${companyNumber}/filing-history/${transactionId}`,
    undefined,
    {
      ttlMs: FILING_HISTORY_TTL_MS,
      notFoundMessage: "This filing was not found on the register.",
    },
  );
}

function readLink(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const links = (value as { links?: unknown }).links;
  if (!links || typeof links !== "object") return undefined;
  const link = (links as Record<string, unknown>)[key];
  return typeof link === "string" && link.trim() ? link : undefined;
}

/** Sanitises a filing type/date into a filename-safe token. */
function filenameToken(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Maps a non-ok Document API response onto a CompaniesHouseError, mirroring
 * fetchJson's status handling. Never surfaces the raw body (which could echo
 * request context) — status + a fixed message only.
 */
function documentError(status: number): CompaniesHouseError {
  if (status === 401) {
    return new CompaniesHouseError(
      "Companies House API key invalid or missing",
      401,
    );
  }
  if (status === 404) {
    return new CompaniesHouseError(
      "This filing has no associated document.",
      404,
    );
  }
  if (status === 429) {
    return new CompaniesHouseError(
      "Companies House rate limit exceeded — pausing requests until the 5-minute window resets.",
      429,
    );
  }
  return new CompaniesHouseError(
    `Companies House document request failed with status ${status}.`,
    status,
  );
}

/**
 * Resolves and downloads the primary document for a filing-history
 * transaction, returning the raw bytes plus a content type and a sensible
 * download filename (company number + filing date + type + .pdf). Throws a
 * CompaniesHouseError (404) when the filing has no document, and a generic
 * error when the document exceeds the size guard.
 */
export async function getFilingDocument(
  apiKey: string,
  companyNumberRaw: string,
  transactionId: string,
): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
  if (!apiKey || !apiKey.trim()) {
    throw new CompaniesHouseError(
      "Companies House API key invalid or missing",
      401,
    );
  }
  const companyNumber = normalizeCompanyNumber(companyNumberRaw);

  const transaction = await getFilingTransaction(
    apiKey,
    companyNumber,
    transactionId,
  );
  const metadataUrl = readLink(transaction, "document_metadata");
  // Only ever follow a metadata link that lives on the Companies House
  // document API host — the URL comes from CH's own response, but a host
  // check keeps a tampered upstream from redirecting our authenticated
  // request anywhere else (defence in depth).
  if (!metadataUrl || !metadataUrl.startsWith(DOCUMENT_API_BASE)) {
    throw new CompaniesHouseError(
      "This filing has no associated document.",
      404,
    );
  }

  const bucket = bucketForKey(apiKey);
  if (!bucket.tryRemoveToken()) {
    throw new CompaniesHouseError(
      "Companies House rate limit reached for this key — pausing requests until the 5-minute window resets.",
      429,
    );
  }

  let metadataRes: Response;
  try {
    metadataRes = await fetch(metadataUrl, {
      headers: {
        Authorization: authHeader(apiKey),
        Accept: "application/json",
      },
    });
  } catch {
    throw new CompaniesHouseError(
      "Failed to reach the Companies House API. Please try again.",
    );
  }
  if (!metadataRes.ok) throw documentError(metadataRes.status);
  const metadata = (await metadataRes.json()) as unknown;

  const contentUrl = readLink(metadata, "document");
  // No content link, or one pointing off the CH document API host, means
  // there is no viewable document for this filing (defence in depth against
  // a tampered upstream response).
  if (!contentUrl || !contentUrl.startsWith(DOCUMENT_API_BASE)) {
    throw new CompaniesHouseError(
      "This filing has no associated document.",
      404,
    );
  }

  let contentRes: Response;
  try {
    contentRes = await fetch(contentUrl, {
      headers: {
        Authorization: authHeader(apiKey),
        Accept: "application/pdf",
      },
      redirect: "follow",
    });
  } catch {
    throw new CompaniesHouseError(
      "Failed to reach the Companies House API. Please try again.",
    );
  }
  if (!contentRes.ok) throw documentError(contentRes.status);

  const declaredLength = Number(contentRes.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOCUMENT_BYTES) {
    throw new CompaniesHouseError(
      "This filing document is too large to retrieve.",
      502,
    );
  }

  const buffer = Buffer.from(await contentRes.arrayBuffer());
  if (buffer.byteLength > MAX_DOCUMENT_BYTES) {
    throw new CompaniesHouseError(
      "This filing document is too large to retrieve.",
      502,
    );
  }

  const contentType =
    contentRes.headers.get("content-type")?.split(";")[0]?.trim() ||
    "application/pdf";

  const tx = transaction as { date?: unknown; type?: unknown };
  const parts = [
    companyNumber,
    filenameToken(tx.date),
    filenameToken(tx.type),
  ].filter((part) => part.length > 0);
  const filename = `${parts.join("-")}.pdf`;

  return { bytes: buffer, contentType, filename };
}
