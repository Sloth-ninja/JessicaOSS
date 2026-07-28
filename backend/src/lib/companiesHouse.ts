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
// The Companies House Document API lives on its own host. We only ever attach
// the API key to a request whose parsed URL host EXACTLY equals this value —
// never a substring/prefix match (see isDocumentApiUrl).
const DOCUMENT_API_HOST = "document-api.company-information.service.gov.uk";

// Reject any filing document larger than this. Enforced by streaming the body
// with a running byte counter and aborting the moment the cap is exceeded, so
// a lying Content-Length or a chunked response can never balloon memory.
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

// Only these content types are ever echoed back with `Content-Disposition:
// inline`. Anything else (an HTML error page, an unexpected type from a
// tampered link) is forced to application/octet-stream so a browser never
// renders untrusted upstream content inline.
const ALLOWED_DOCUMENT_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/octet-stream",
]);

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

/**
 * True only when `u` is an https URL whose host is EXACTLY the Companies House
 * Document API host. Parses the URL rather than string-prefixing, so it
 * rejects suffix-domain spoofs
 * (`https://document-api.company-information.service.gov.uk.evil.com/…`) and
 * userinfo tricks
 * (`https://document-api.company-information.service.gov.uk@evil.com/…`) —
 * both of which a naive `startsWith` would wave through, exfiltrating the API
 * key attached to the initial request.
 */
function isDocumentApiUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.host === DOCUMENT_API_HOST;
  } catch {
    return false;
  }
}

/**
 * Reads a fetch Response body into a Buffer, aborting the transfer the moment
 * the running byte count exceeds `maxBytes`. Streaming (rather than
 * `arrayBuffer()` then checking) means a chunked or Content-Length-lying
 * response can never buffer more than one chunk past the cap before we abort.
 */
async function readBodyWithCap(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<Buffer> {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body) {
    // No stream available — degrade to a buffered read, still size-checked.
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new CompaniesHouseError(
        "This filing document is too large to retrieve.",
        502,
      );
    }
    return buf;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        /* best effort — the abort already tore down the transfer */
      }
      throw new CompaniesHouseError(
        "This filing document is too large to retrieve.",
        502,
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
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
  // document API host — the URL comes from CH's own response, but an exact
  // host check keeps a tampered upstream from redirecting our authenticated
  // request (and the API key on it) anywhere else.
  if (!metadataUrl || !isDocumentApiUrl(metadataUrl)) {
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
  // there is no viewable document for this filing (same exact-host guard as
  // the metadata link — never key-attach to a spoofed host).
  if (!contentUrl || !isDocumentApiUrl(contentUrl)) {
    throw new CompaniesHouseError(
      "This filing has no associated document.",
      404,
    );
  }

  // The content fetch is abortable so the streaming size guard can tear the
  // transfer down the instant the cap is exceeded.
  const controller = new AbortController();
  let contentRes: Response;
  try {
    contentRes = await fetch(contentUrl, {
      headers: {
        Authorization: authHeader(apiKey),
        Accept: "application/pdf",
      },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch {
    throw new CompaniesHouseError(
      "Failed to reach the Companies House API. Please try again.",
    );
  }
  if (!contentRes.ok) throw documentError(contentRes.status);

  // Fast path: reject an honestly-declared oversize before reading a byte.
  const declaredLength = Number(contentRes.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOCUMENT_BYTES) {
    controller.abort();
    throw new CompaniesHouseError(
      "This filing document is too large to retrieve.",
      502,
    );
  }

  // Streamed read with a running cap — protects against a lying/absent
  // Content-Length or a chunked response.
  const buffer = await readBodyWithCap(
    contentRes,
    MAX_DOCUMENT_BYTES,
    controller,
  );

  // Never echo an arbitrary upstream content type back with an inline
  // disposition — allowlist, else force a download-only octet-stream.
  const rawContentType =
    contentRes.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase() ?? "";
  const contentType = ALLOWED_DOCUMENT_CONTENT_TYPES.has(rawContentType)
    ? rawContentType
    : "application/octet-stream";

  const tx = transaction as { date?: unknown; type?: unknown };
  const parts = [
    companyNumber,
    filenameToken(tx.date),
    filenameToken(tx.type),
  ].filter((part) => part.length > 0);
  const filename = `${parts.join("-")}.pdf`;

  return { bytes: buffer, contentType, filename };
}
