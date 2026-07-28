// HM Land Registry Price Paid open-data client (WS7 — Land Registry v1).
//
// Source: HM Land Registry Price Paid Linked Data SPARQL endpoint
// (https://landregistry.data.gov.uk/landregistry/query). Fully open data under
// the Open Government Licence v3.0 — no API key, no charge (CLAUDE.md data
// integration 4: v1 is open data only; Business Gateway is deferred).
//
// Why SPARQL rather than the linked-data REST facade: one request filters by
// postcode, joins the address + property type + estate type, orders by
// transaction date, and caps the result set server-side. The REST facade would
// need several round trips and its own pagination to assemble the same rows.
// The query text is FIXED — only a postcode that has already been validated and
// normalised to `[A-Z0-9 ]` (see normalizePostcode) is interpolated into the
// SPARQL string literal, so it cannot break out of the quotes.
//
// Never hangs a request: the upstream fetch is aborted after 10s
// (docs/DURABLE_LESSONS.md — "log, don't die" only degrades honestly if the
// request still returns). A small TTL cache + single-flight de-dup mirror
// companiesHouse.ts's chGet. Raw upstream text is never thrown to callers —
// errors carry a fixed message plus an optional status only.

import { SingleFlight, TokenBucket } from "./rateLimit";

const SPARQL_ENDPOINT = "https://landregistry.data.gov.uk/landregistry/query";
const USER_AGENT = "JessicaOS/0.1 (+https://github.com/Sloth-ninja/JessicaOSS)";
const FETCH_TIMEOUT_MS = 10_000;

/** Cap on the number of transactions returned (most recent first). */
export const MAX_RESULTS = 25;

// Politeness limiter for the shared public endpoint. There is no per-key
// concept here (keyless open data), so this is a single process-wide bucket.
const BUCKET_CAPACITY = 30;
const BUCKET_WINDOW_MS = 10_000;

// Price Paid data is republished monthly, so a generous TTL is safe.
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

export class LandRegistryError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "LandRegistryError";
    this.status = status;
  }
}

export interface PricePaidEntry {
  /** Composed, display-ready address (SAON, PAON street, town) — title-cased. */
  address: string;
  /** "Detached" / "Semi-detached" / "Terraced" / "Flat" / "Other", or null. */
  propertyType: string | null;
  tenure: "Freehold" | "Leasehold" | null;
  /** Price paid in whole pounds. */
  price: number;
  /** Transaction date as ISO `YYYY-MM-DD` (the frontend renders DD/MM/YYYY). */
  date: string;
}

// ---------------------------------------------------------------------------
// Postcode validation / normalisation. MUST run before the value reaches any
// query string. Accepts the standard UK shapes (the inward code is always
// digit + two letters); returns the canonical uppercase, single-space form, or
// null for anything that is not a well-formed postcode.
// ---------------------------------------------------------------------------

const POSTCODE_RE = /^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/;

export function normalizePostcode(input: string): string | null {
  if (typeof input !== "string") return null;
  const compact = input.toUpperCase().replace(/\s+/g, "");
  if (!POSTCODE_RE.test(compact)) return null;
  // Inward code (the part after the space) is always the final three chars.
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

// ---------------------------------------------------------------------------
// Result normalisation
// ---------------------------------------------------------------------------

type SparqlValue = { value?: unknown } | undefined;
type SparqlBinding = Record<string, SparqlValue>;
interface SparqlResults {
  results?: { bindings?: unknown };
}

function binding(b: SparqlBinding, key: string): string | undefined {
  const cell = b[key];
  const value = cell?.value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** "st john's road" / "CHURCH HILL" → "St John's Road" / "Church Hill". */
function toTitleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(
      /(^|\s)([a-z])/g,
      (_, sep: string, ch: string) => sep + ch.toUpperCase(),
    );
}

function composeAddress(b: SparqlBinding): string {
  const parts = ["saon", "paon", "street", "town"].map((k) => {
    const raw = binding(b, k);
    return raw ? toTitleCase(raw) : undefined;
  });
  const [saon, paon, street, town] = parts;
  const streetLine = [paon, street].filter(Boolean).join(" ");
  return [saon, streetLine, town].filter(Boolean).join(", ");
}

const PROPERTY_TYPE_LABELS: Record<string, string> = {
  detached: "Detached",
  "semi-detached": "Semi-detached",
  terraced: "Terraced",
  "flat-maisonette": "Flat",
  other: "Other",
  otherpropertytype: "Other",
  "other-property-type": "Other",
};

/** Maps a `.../def/common/{slug}` URI to a human label; null when absent. */
function propertyTypeLabel(uri: string | undefined): string | null {
  const slug = uri?.split("/").pop()?.toLowerCase();
  if (!slug) return null;
  if (PROPERTY_TYPE_LABELS[slug]) return PROPERTY_TYPE_LABELS[slug];
  // Unknown-but-present type: prettify the slug rather than drop it.
  return slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function tenureLabel(uri: string | undefined): "Freehold" | "Leasehold" | null {
  const slug = uri?.split("/").pop()?.toLowerCase();
  if (slug === "freehold") return "Freehold";
  if (slug === "leasehold") return "Leasehold";
  return null;
}

function normalizeResults(json: unknown): PricePaidEntry[] {
  const bindings = (json as SparqlResults)?.results?.bindings;
  if (!Array.isArray(bindings)) return [];

  const entries: PricePaidEntry[] = [];
  for (const raw of bindings) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as SparqlBinding;
    const amountRaw = binding(b, "amount");
    const date = binding(b, "date");
    if (!amountRaw || !date) continue;
    const price = Number.parseInt(amountRaw, 10);
    if (!Number.isFinite(price)) continue;
    entries.push({
      address: composeAddress(b),
      propertyType: propertyTypeLabel(binding(b, "propertyType")),
      tenure: tenureLabel(binding(b, "estateType")),
      price,
      date,
    });
  }

  // The query already orders newest-first, but sort defensively (ISO dates sort
  // lexicographically) and enforce the cap here regardless of upstream limits.
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return entries.slice(0, MAX_RESULTS);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

function buildQuery(postcode: string): string {
  // `postcode` is guaranteed `[A-Z0-9 ]` by normalizePostcode, so it cannot
  // contain a quote or backslash and is safe to embed in the string literal.
  return `prefix xsd: <http://www.w3.org/2001/XMLSchema#>
prefix lrppi: <http://landregistry.data.gov.uk/def/ppi/>
prefix lrcommon: <http://landregistry.data.gov.uk/def/common/>
SELECT ?paon ?saon ?street ?town ?amount ?date ?propertyType ?estateType
WHERE {
  VALUES ?postcode { "${postcode}"^^xsd:string }
  ?addr lrcommon:postcode ?postcode .
  ?transx lrppi:propertyAddress ?addr ;
          lrppi:pricePaid ?amount ;
          lrppi:transactionDate ?date .
  OPTIONAL { ?addr lrcommon:saon ?saon }
  OPTIONAL { ?addr lrcommon:paon ?paon }
  OPTIONAL { ?addr lrcommon:street ?street }
  OPTIONAL { ?addr lrcommon:town ?town }
  OPTIONAL { ?transx lrppi:propertyType ?propertyType }
  OPTIONAL { ?transx lrppi:estateType ?estateType }
}
ORDER BY DESC(?date)
LIMIT ${MAX_RESULTS}`;
}

async function runQuery(postcode: string): Promise<PricePaidEntry[]> {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(buildQuery(postcode))}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/sparql-results+json",
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });
  } catch {
    // AbortError (10s timeout) or a network failure — never surface raw text.
    throw new LandRegistryError(
      "Could not reach HM Land Registry. Please try again.",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new LandRegistryError(
      `HM Land Registry request failed with status ${res.status}.`,
      res.status,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new LandRegistryError(
      "HM Land Registry returned an unreadable response.",
    );
  }
  return normalizeResults(json);
}

// ---------------------------------------------------------------------------
// In-process TTL cache + single-flight de-dup (keyed on the normalised
// postcode). Module-level state; reset between tests via the helper below.
// ---------------------------------------------------------------------------

let bucket = new TokenBucket(BUCKET_CAPACITY, BUCKET_WINDOW_MS);
let inflight = new SingleFlight<PricePaidEntry[]>();
type CacheEntry = { value: PricePaidEntry[]; expiresAt: number };
let cacheStore = new Map<string, CacheEntry>();

/** Test-only: clears all module-level state between test cases. */
export function resetLandRegistryStateForTests(): void {
  bucket = new TokenBucket(BUCKET_CAPACITY, BUCKET_WINDOW_MS);
  inflight = new SingleFlight<PricePaidEntry[]>();
  cacheStore = new Map<string, CacheEntry>();
}

function cacheGet(key: string): PricePaidEntry[] | undefined {
  const entry = cacheStore.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cacheStore.delete(key);
    return undefined;
  }
  // Refresh recency (LRU-ish eviction order).
  cacheStore.delete(key);
  cacheStore.set(key, entry);
  return entry.value;
}

function cacheSet(key: string, value: PricePaidEntry[]): void {
  if (cacheStore.size >= MAX_CACHE_ENTRIES && !cacheStore.has(key)) {
    const oldestKey = cacheStore.keys().next().value;
    if (oldestKey !== undefined) cacheStore.delete(oldestKey);
  }
  cacheStore.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Looks up Price Paid transactions for a UK postcode, newest first, capped at
 * MAX_RESULTS. Throws LandRegistryError(400) for an invalid postcode (the
 * value never reaches a query string), and LandRegistryError for upstream /
 * timeout failures.
 */
export async function getPricePaidByPostcode(
  postcodeRaw: string,
): Promise<PricePaidEntry[]> {
  const postcode = normalizePostcode(postcodeRaw);
  if (!postcode) {
    throw new LandRegistryError("Invalid postcode.", 400);
  }

  const cached = cacheGet(postcode);
  if (cached) return cached;

  return inflight.run(postcode, async () => {
    // Re-check in case a concurrent caller populated the cache while waiting.
    const cachedAgain = cacheGet(postcode);
    if (cachedAgain) return cachedAgain;

    if (!bucket.tryRemoveToken()) {
      throw new LandRegistryError(
        "Too many Land Registry lookups just now. Please try again shortly.",
        429,
      );
    }

    const results = await runQuery(postcode);
    cacheSet(postcode, results);
    return results;
  });
}
