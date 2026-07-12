/**
 * legislation.gov.uk client (WS2 — docs/MIGRATION_SPEC.md §4).
 *
 * Fully open API, no key required (Open Government Licence permits
 * computational reuse). This module is intentionally self-contained: it does
 * NOT import from evals/ (a standalone package that hits the same live API
 * for golden-set verification) and does NOT share rate-limit state with
 * WS1's Companies House client.
 *
 * CLML element names actually verified against live responses while building
 * this module (fetched 2026-07-08, see backend/src/lib/__fixtures__/legislation
 * for trimmed captures):
 *   - Outstanding/prospective-amendment flag: `ukm:PrimaryMetadata` (Acts) or
 *     `ukm:SecondaryMetadata` (SIs) contains zero or more
 *     `ukm:UnappliedEffects > ukm:UnappliedEffect` elements. Each
 *     `ukm:UnappliedEffect` carries `Type`, `Notes` (human-readable — usually
 *     states "This amendment not applied to legislation.gov.uk..." or is
 *     phrased as a future/prospective change), `AffectedProvisions`, and
 *     `RequiresApplied` ("true" | "false") as attributes on the opening tag.
 *     This block is present on EVERY page of an affected Act/SI (it is not
 *     scoped to the one section/regulation being fetched) — matching the
 *     "outstanding changes" banner legislation.gov.uk shows site-wide for
 *     that instrument. CLAUDE.md requires this never be hidden, so
 *     `outstandingEffects`/`unappliedEffects` are always populated and
 *     surfaced by the caller regardless of which fragment was requested.
 *   - Provision heading: the nearest preceding `<Title>` element (e.g. the
 *     enclosing `P1group`'s Title) — real examples: "Petition by company
 *     member" (CA2006 s.994), "Effect of relevant transfer on contracts of
 *     employment" (TUPE reg.4), "General." (ERA1996 s.98).
 *   - Provision body/fragment element: both Acts and SIs wrap the requested
 *     section/regulation/article in a `<P1 id="section-994">` /
 *     `<P1 id="regulation-4">` element regardless of type — `id` is the only
 *     thing that varies.
 *   - Extent: `RestrictExtent="E+W+S+N.I."` (etc.) on the nearest ancestor
 *     (usually the wrapping `P1group`).
 *   - Pre-1963 Acts (e.g. Landlord and Tenant Act 1954) are catalogued under
 *     regnal-year ids (`/id/ukpga/Eliz2/2-3/56`) rather than `/year/number` —
 *     `resolveByTitle` below matches by the entry's `<ukm:Year Value="…">`
 *     rather than assuming the URI path contains a plain calendar year.
 */

const BASE_URL = "https://www.legislation.gov.uk";
const USER_AGENT = "JessicaOS/0.1 (+https://github.com/Sloth-ninja/JessicaOSS)";

// ---------------------------------------------------------------------------
// Politeness: local token bucket, ~1 req/s with a burst of 5. Not shared with
// any other integration's limiter.
// ---------------------------------------------------------------------------

class TokenBucket {
  private tokens: number;
  private readonly queue: (() => void)[] = [];
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly capacity: number,
    refillPerSecond: number,
  ) {
    this.tokens = capacity;
    this.timer = setInterval(() => this.refill(), 1000 / refillPerSecond);
    // Never keep the process alive just for this timer (dev/test runs).
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  private refill() {
    if (this.tokens < this.capacity) this.tokens += 1;
    while (this.tokens > 0 && this.queue.length > 0) {
      this.tokens -= 1;
      const next = this.queue.shift();
      next?.();
    }
  }

  acquire(): Promise<void> {
    if (this.tokens > 0) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
}

const rateLimiter = new TokenBucket(5, 1);

async function politeFetch(url: string): Promise<Response> {
  await rateLimiter.acquire();
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (res.status >= 500 && res.status < 600) {
    await rateLimiter.acquire();
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  }
  return res;
}

// ---------------------------------------------------------------------------
// Caching: small bounded in-memory TTL maps (no shared cache/throttle utils
// exist elsewhere in backend/src/lib — see backend-seam-map.md §10).
// ---------------------------------------------------------------------------

class TtlCache<V> {
  private readonly store = new Map<string, { value: V; expires: number }>();

  constructor(private readonly maxEntries: number) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }
}

const HOUR_MS = 60 * 60 * 1000;
const TITLE_URI_TTL_MS = 24 * HOUR_MS;
const CURRENT_PROVISION_TTL_MS = 6 * HOUR_MS;
const POINT_IN_TIME_PROVISION_TTL_MS = 7 * 24 * HOUR_MS;

const titleUriCache = new TtlCache<ResolveResult>(200);
const provisionCache = new TtlCache<GetProvisionResult>(500);

// ---------------------------------------------------------------------------
// Citation parsing
// ---------------------------------------------------------------------------

export type LegislationFragmentKind =
  | "section"
  | "regulation"
  | "article"
  | "schedule";

export type LegislationCitationIntent =
  | { kind: "act"; title: string; year: number }
  | {
      kind: "act-section";
      title: string;
      year: number;
      sectionNumber: string;
    }
  | {
      kind: "si";
      year: number;
      number: string;
      fragmentKind?: "regulation" | "article";
      fragmentNumber?: string;
    }
  | {
      kind: "si-title";
      title: string;
      year: number;
      fragmentKind: "regulation" | "article";
      fragmentNumber: string;
    };

// Title fragments (letters, digits, apostrophes, parentheses, spaces) ending
// in "Act YYYY" / "Regulations YYYY". Intentionally case-insensitive
// (citations arrive as tool-call arguments, not scanned prose, so the extra
// leniency doesn't add meaningful false-positive risk).
const ACT_TITLE_SRC =
  "[A-Za-z][A-Za-z0-9()'\\u2019]*(?:\\s+[A-Za-z0-9()'\\u2019]+)*?\\s+Act\\s+(\\d{4})";
const REGS_TITLE_SRC =
  "[A-Za-z][A-Za-z0-9()'\\u2019]*(?:\\s+[A-Za-z0-9()'\\u2019]+)*?\\s+Regulations\\s+(\\d{4})";
const SECTION_PREFIX_SRC = "(?:s|ss|section|sections)\\.?";
const REG_PREFIX_SRC =
  "(reg|regs|regulation|regulations|art|arts|article|articles)\\.?";
const OF_THE_SRC = "(?:of\\s+(?:the\\s+)?)?";

function normalizeFragmentPrefix(word: string): "regulation" | "article" {
  return /^art/i.test(word) ? "article" : "regulation";
}

/**
 * Parse a natural UK statutory citation string (as a user or model would
 * write it) into a structured resolution intent. Returns null — never
 * throws — when the string cannot be recognised as any known citation
 * shape; the raw string is preserved by callers for a readable error.
 */
export function parseCitation(raw: string): LegislationCitationIntent | null {
  const text = raw.trim();
  if (!text) return null;

  // "s.994 Companies Act 2006" / "section 98 of the Employment Rights Act 1996"
  {
    const re = new RegExp(
      `\\b${SECTION_PREFIX_SRC}\\s*(\\d+[A-Za-z]*)\\s+${OF_THE_SRC}(${ACT_TITLE_SRC})\\b`,
      "i",
    );
    const m = re.exec(text);
    if (m) {
      return {
        kind: "act-section",
        sectionNumber: m[1],
        title: m[2].trim(),
        year: Number(m[3]),
      };
    }
  }

  // "Employment Rights Act 1996, s 98" / "Companies Act 2006 s.994"
  {
    const re = new RegExp(
      `\\b(${ACT_TITLE_SRC})\\s*,?\\s*${SECTION_PREFIX_SRC}\\s*(\\d+[A-Za-z]*)\\b`,
      "i",
    );
    const m = re.exec(text);
    if (m) {
      return {
        kind: "act-section",
        title: m[1].trim(),
        year: Number(m[2]),
        sectionNumber: m[3],
      };
    }
  }

  // "reg 3 TUPE Regulations 2006" / "regulation 4 of the ... Regulations 2006"
  {
    const re = new RegExp(
      `\\b${REG_PREFIX_SRC}\\s*(\\d+[A-Za-z]*)\\s+${OF_THE_SRC}(${REGS_TITLE_SRC})\\b`,
      "i",
    );
    const m = re.exec(text);
    if (m) {
      return {
        kind: "si-title",
        title: m[3].trim(),
        year: Number(m[4]),
        fragmentKind: normalizeFragmentPrefix(m[1]),
        fragmentNumber: m[2],
      };
    }
  }

  // "TUPE Regulations 2006, reg 4"
  {
    const re = new RegExp(
      `\\b(${REGS_TITLE_SRC})\\s*,?\\s*${REG_PREFIX_SRC}\\s*(\\d+[A-Za-z]*)\\b`,
      "i",
    );
    const m = re.exec(text);
    if (m) {
      return {
        kind: "si-title",
        title: m[1].trim(),
        year: Number(m[2]),
        fragmentKind: normalizeFragmentPrefix(m[3]),
        fragmentNumber: m[4],
      };
    }
  }

  // "reg 4 of SI 2006/246"
  {
    const re = new RegExp(
      `\\b${REG_PREFIX_SRC}\\s*(\\d+[A-Za-z]*)\\D{0,20}?\\bS\\.?I\\.?\\s*(\\d{4})\\/(\\d+)\\b`,
      "i",
    );
    const m = re.exec(text);
    if (m) {
      return {
        kind: "si",
        year: Number(m[3]),
        number: m[4],
        fragmentKind: normalizeFragmentPrefix(m[1]),
        fragmentNumber: m[2],
      };
    }
  }

  // "SI 2006/246, reg 4"
  {
    const re = new RegExp(
      `\\bS\\.?I\\.?\\s*(\\d{4})\\/(\\d+)\\b\\D{0,20}?${REG_PREFIX_SRC}\\s*(\\d+[A-Za-z]*)\\b`,
      "i",
    );
    const m = re.exec(text);
    if (m) {
      return {
        kind: "si",
        year: Number(m[1]),
        number: m[2],
        fragmentKind: normalizeFragmentPrefix(m[3]),
        fragmentNumber: m[4],
      };
    }
  }

  // Bare SI number: "SI 2006/246"
  {
    const re = new RegExp(`\\bS\\.?I\\.?\\s*(\\d{4})\\/(\\d+)\\b`, "i");
    const m = re.exec(text);
    if (m) {
      return { kind: "si", year: Number(m[1]), number: m[2] };
    }
  }

  // Bare Act title: "Companies Act 2006"
  {
    const re = new RegExp(`\\b(${ACT_TITLE_SRC})\\b`, "i");
    const m = re.exec(text);
    if (m) {
      return { kind: "act", title: m[1].trim(), year: Number(m[2]) };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// resolveByTitle / search — Atom feed
// ---------------------------------------------------------------------------

const TYPE_ORDER = ["ukpga", "uksi", "asp", "asc", "anaw", "nisr"] as const;

export type ResolveResult =
  | { resolved: true; uri: string; type: string; title: string }
  | { resolved: false; reason: string };

function extractAtomEntries(atom: string): string[] {
  return [...atom.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
}

/**
 * Resolve an Act/SI title (+ optional year) to its canonical
 * `/{type}/{path}` URI via the Atom title-search feed. Cached 24h (titles
 * are stable). Never throws: network failures resolve to
 * `{resolved:false, reason}`.
 */
export async function resolveByTitle(
  title: string,
  year?: number,
): Promise<ResolveResult> {
  const cacheKey = `${title.trim().toLowerCase()}|${year ?? ""}`;
  const cached = titleUriCache.get(cacheKey);
  if (cached) return cached;

  for (const type of TYPE_ORDER) {
    let atom: string;
    try {
      const res = await politeFetch(
        `${BASE_URL}/${type}/data.feed?title=${encodeURIComponent(title)}`,
      );
      if (!res.ok) continue;
      atom = await res.text();
    } catch {
      continue;
    }

    for (const entry of extractAtomEntries(atom)) {
      if (year !== undefined) {
        const yearMatch = /<ukm:Year Value="(\d+)"/.exec(entry);
        if (!yearMatch || Number(yearMatch[1]) !== year) continue;
      }
      // Modern ids: /id/{type}/{year}/{number}. Pre-1963 Acts: regnal-year
      // ids such as /id/ukpga/Eliz2/2-3/56 — capture whatever follows the
      // type segment verbatim rather than assuming a 2-segment shape.
      const idMatch = new RegExp(`/id/${type}/([^"<\\s]+)`).exec(entry);
      if (idMatch) {
        const result: ResolveResult = {
          resolved: true,
          uri: `/${type}/${idMatch[1]}`,
          type,
          title,
        };
        titleUriCache.set(cacheKey, result, TITLE_URI_TTL_MS);
        return result;
      }
    }
  }

  const failure: ResolveResult = {
    resolved: false,
    reason: `No legislation.gov.uk entry found for "${title}"${year ? ` (${year})` : ""}.`,
  };
  titleUriCache.set(cacheKey, failure, TITLE_URI_TTL_MS);
  return failure;
}

export type LegislationSearchMatch = {
  title: string;
  type: string;
  year?: number;
  number?: string;
  url: string;
};

/** Free-text title search across the common legislation types. */
export async function search(
  titleQuery: string,
): Promise<LegislationSearchMatch[]> {
  const matches: LegislationSearchMatch[] = [];
  for (const type of TYPE_ORDER) {
    let atom: string;
    try {
      const res = await politeFetch(
        `${BASE_URL}/${type}/data.feed?title=${encodeURIComponent(titleQuery)}`,
      );
      if (!res.ok) continue;
      atom = await res.text();
    } catch {
      continue;
    }
    for (const entry of extractAtomEntries(atom)) {
      const titleMatch = /<title>([^<]*)<\/title>/.exec(entry);
      const idMatch = new RegExp(`/id/${type}/([^"<\\s]+)`).exec(entry);
      if (!titleMatch || !idMatch) continue;
      const yearMatch = /<ukm:Year Value="(\d+)"/.exec(entry);
      const numberMatch = /<ukm:Number Value="([^"]+)"/.exec(entry);
      matches.push({
        title: titleMatch[1],
        type,
        year: yearMatch ? Number(yearMatch[1]) : undefined,
        number: numberMatch?.[1],
        url: `${BASE_URL}/${type}/${idMatch[1]}`,
      });
      if (matches.length >= 10) return matches;
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// getProvision — CLML fetch + extraction
// ---------------------------------------------------------------------------

export type UnappliedEffectSummary = {
  type?: string;
  notes?: string;
  affectedProvisions?: string;
  requiresApplied?: boolean;
};

export type Provision = {
  uri: string;
  fragment?: string;
  version?: string;
  canonicalUrl: string;
  heading: string | null;
  text: string;
  extent: string | null;
  outstandingEffects: boolean;
  unappliedEffects: UnappliedEffectSummary[];
};

export type GetProvisionResult =
  | { ok: true; provision: Provision }
  | { ok: false; reason: string };

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
      String.fromCharCode(parseInt(code, 16)),
    );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find `<Tag ... id="targetId" ...>...</Tag>` in raw CLML by locating the
 * opening tag (any tag name) with a matching `id` attribute, then walking
 * forward counting same-tag open/close to find the balanced close tag.
 * CLML wraps a requested section/regulation/article/schedule fragment in a
 * `P1`-level element regardless of legislation type — only `id` varies.
 */
function extractElementById(
  xml: string,
  id: string,
): { openAttrs: string; startIdx: number; inner: string } | null {
  const openTagRe = new RegExp(
    `<([A-Za-z][\\w:]*)([^>]*\\bid="${escapeRegExp(id)}"[^>]*)>`,
  );
  const m = openTagRe.exec(xml);
  if (!m) return null;
  const tag = m[1];
  const startIdx = m.index;
  const openTagEnd = startIdx + m[0].length;

  const tagRe = new RegExp(`<${tag}(?:\\s[^>]*)?>|</${tag}>`, "g");
  tagRe.lastIndex = openTagEnd;
  let depth = 1;
  let endIdx = -1;
  let mm: RegExpExecArray | null;
  while ((mm = tagRe.exec(xml))) {
    if (mm[0].startsWith("</")) depth -= 1;
    else depth += 1;
    if (depth === 0) {
      endIdx = mm.index;
      break;
    }
  }
  if (endIdx === -1) return null;
  return { openAttrs: m[2], startIdx, inner: xml.slice(openTagEnd, endIdx) };
}

function extractPrecedingHeading(
  xml: string,
  beforeIdx: number,
): string | null {
  const titleRe = /<Title(?:\s[^>]*)?>([\s\S]*?)<\/Title>/g;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(xml))) {
    if (m.index >= beforeIdx) break;
    last = m[1];
  }
  if (last === null) return null;
  const text = decodeXmlEntities(last.replace(/<[^>]+>/g, "")).trim();
  return text || null;
}

function extractExtent(
  xml: string,
  ownAttrs: string,
  beforeIdx: number,
): string | null {
  const ownMatch = /RestrictExtent="([^"]*)"/.exec(ownAttrs);
  if (ownMatch) return ownMatch[1];
  const extentRe = /RestrictExtent="([^"]*)"/g;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = extentRe.exec(xml))) {
    if (m.index >= beforeIdx) break;
    last = m[1];
  }
  return last;
}

function extractPlainText(fragmentXml: string): string {
  let text = fragmentXml.replace(/<Pnumber[^>]*>/g, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeXmlEntities(text);
  text = text
    .replace(/[ \t\r]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  return text;
}

function parseAttrs(tagSrc: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z][\w:]*)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagSrc))) attrs[m[1]] = m[2];
  return attrs;
}

function extractUnappliedEffects(xml: string): UnappliedEffectSummary[] {
  const effects: UnappliedEffectSummary[] = [];
  const re = /<ukm:UnappliedEffect\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = parseAttrs(m[1]);
    effects.push({
      type: attrs.Type,
      notes: attrs.Notes,
      affectedProvisions: attrs.AffectedProvisions,
      requiresApplied:
        attrs.RequiresApplied === undefined
          ? undefined
          : attrs.RequiresApplied === "true",
    });
  }
  return effects;
}

function fragmentId(fragment: {
  kind: LegislationFragmentKind;
  number: string;
}): string {
  return `${fragment.kind}-${fragment.number}`;
}

/**
 * Fetch a provision's CLML (`data.xml`) and extract its text, heading,
 * extent, and outstanding/unapplied-effects flags. `uri` is a canonical
 * resource path such as `/ukpga/2006/46` (no `/data.xml` suffix). `version`
 * is a point-in-time date (`YYYY-MM-DD`), `"enacted"`, or `"made"`; omitted
 * means the latest revised version.
 *
 * Never throws: HTTP failures and CLML shapes that don't contain the
 * requested fragment both resolve to `{ok:false, reason}`.
 */
export async function getProvision(
  uri: string,
  fragment?: { kind: LegislationFragmentKind; number: string },
  version?: string,
): Promise<GetProvisionResult> {
  const cacheKey = `${uri}|${fragment ? fragmentId(fragment) : ""}|${version ?? "latest"}`;
  const cached = provisionCache.get(cacheKey);
  if (cached) return cached;

  const path = [
    uri,
    fragment ? `${fragment.kind}/${fragment.number}` : null,
    version,
  ]
    .filter(Boolean)
    .join("/");
  const fetchUrl = `${BASE_URL}${path}/data.xml`;
  const canonicalUrl = `${BASE_URL}${[uri, fragment ? `${fragment.kind}/${fragment.number}` : null].filter(Boolean).join("/")}`;

  let res: Response;
  try {
    res = await politeFetch(fetchUrl);
  } catch (err) {
    return {
      ok: false,
      reason: `Could not reach legislation.gov.uk: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    const result: GetProvisionResult = {
      ok: false,
      reason: `legislation.gov.uk returned HTTP ${res.status} for ${fetchUrl}`,
    };
    // Don't cache 4xx/5xx — a transient issue or a not-yet-existing fragment
    // shouldn't be remembered as permanently missing.
    return result;
  }
  const xml = await res.text();

  const unappliedEffects = extractUnappliedEffects(xml);

  let heading: string | null = null;
  let text: string;
  let extent: string | null = null;

  if (fragment) {
    const found = extractElementById(xml, fragmentId(fragment));
    if (!found) {
      return {
        ok: false,
        reason: `Fetched ${fetchUrl} but could not find fragment "${fragmentId(fragment)}" in the CLML body.`,
      };
    }
    heading = extractPrecedingHeading(xml, found.startIdx);
    extent = extractExtent(xml, found.openAttrs, found.startIdx);
    text = extractPlainText(found.inner);
  } else {
    // Whole-instrument lookup (bare Act/SI citation) — use the document
    // title as heading and the top-level RestrictExtent as extent; body
    // text is intentionally not flattened (would be the entire Act).
    const titleMatch = /<dc:title>([^<]*)<\/dc:title>/.exec(xml);
    heading = titleMatch ? decodeXmlEntities(titleMatch[1]).trim() : null;
    const topExtent = /<Legislation\b[^>]*\bRestrictExtent="([^"]*)"/.exec(xml);
    extent = topExtent ? topExtent[1] : null;
    text = heading ?? "";
  }

  const provision: Provision = {
    uri,
    fragment: fragment ? `${fragment.kind}/${fragment.number}` : undefined,
    version,
    canonicalUrl,
    heading,
    text,
    extent,
    outstandingEffects: unappliedEffects.length > 0,
    unappliedEffects,
  };
  const result: GetProvisionResult = { ok: true, provision };
  const ttl =
    version && version !== "latest"
      ? POINT_IN_TIME_PROVISION_TTL_MS
      : CURRENT_PROVISION_TTL_MS;
  provisionCache.set(cacheKey, result, ttl);
  return result;
}

// ---------------------------------------------------------------------------
// lookupCitation / verifyCitation — orchestration used by legislationTools.ts
// ---------------------------------------------------------------------------

export type LegislationLookupSuccess = {
  resolved: true;
  canonicalUrl: string;
  title: string;
  heading: string | null;
  text: string;
  extent: string | null;
  outstandingEffects: boolean;
  unappliedEffects: UnappliedEffectSummary[];
};

export type LegislationLookupResult =
  | LegislationLookupSuccess
  | { resolved: false; citation: string; reason: string };

function fragmentLabel(kind: "regulation" | "article"): string {
  return kind === "article" ? "art." : "reg.";
}

function toLookupSuccess(
  provision: Provision,
  title: string,
): LegislationLookupSuccess {
  return {
    resolved: true,
    canonicalUrl: provision.canonicalUrl,
    title,
    heading: provision.heading,
    text: provision.text,
    extent: provision.extent,
    outstandingEffects: provision.outstandingEffects,
    unappliedEffects: provision.unappliedEffects,
  };
}

/**
 * Parse, resolve, and fetch a natural-language UK statutory citation in one
 * call. Never throws: every failure mode (unparseable input, unresolvable
 * title, missing fragment, network error) returns
 * `{resolved:false, citation, reason}`.
 */
export async function lookupCitation(
  raw: string,
): Promise<LegislationLookupResult> {
  const intent = parseCitation(raw);
  if (!intent) {
    return {
      resolved: false,
      citation: raw,
      reason: `Could not parse "${raw}" as a UK statutory citation.`,
    };
  }

  switch (intent.kind) {
    case "act": {
      const resolved = await resolveByTitle(intent.title, intent.year);
      if (!resolved.resolved) {
        return { resolved: false, citation: raw, reason: resolved.reason };
      }
      const provisionResult = await getProvision(resolved.uri);
      if (!provisionResult.ok) {
        return {
          resolved: false,
          citation: raw,
          reason: provisionResult.reason,
        };
      }
      return toLookupSuccess(provisionResult.provision, intent.title);
    }
    case "act-section": {
      const resolved = await resolveByTitle(intent.title, intent.year);
      if (!resolved.resolved) {
        return { resolved: false, citation: raw, reason: resolved.reason };
      }
      const provisionResult = await getProvision(resolved.uri, {
        kind: "section",
        number: intent.sectionNumber,
      });
      if (!provisionResult.ok) {
        return {
          resolved: false,
          citation: raw,
          reason: provisionResult.reason,
        };
      }
      return toLookupSuccess(
        provisionResult.provision,
        `${intent.title}, s.${intent.sectionNumber}`,
      );
    }
    case "si": {
      const uri = `/uksi/${intent.year}/${intent.number}`;
      const fragment =
        intent.fragmentKind && intent.fragmentNumber
          ? { kind: intent.fragmentKind, number: intent.fragmentNumber }
          : undefined;
      const provisionResult = await getProvision(uri, fragment);
      if (!provisionResult.ok) {
        return {
          resolved: false,
          citation: raw,
          reason: provisionResult.reason,
        };
      }
      const label = fragment
        ? `SI ${intent.year}/${intent.number}, ${fragmentLabel(fragment.kind)} ${fragment.number}`
        : `SI ${intent.year}/${intent.number}`;
      return toLookupSuccess(provisionResult.provision, label);
    }
    case "si-title": {
      const resolved = await resolveByTitle(intent.title, intent.year);
      if (!resolved.resolved) {
        return { resolved: false, citation: raw, reason: resolved.reason };
      }
      const provisionResult = await getProvision(resolved.uri, {
        kind: intent.fragmentKind,
        number: intent.fragmentNumber,
      });
      if (!provisionResult.ok) {
        return {
          resolved: false,
          citation: raw,
          reason: provisionResult.reason,
        };
      }
      return toLookupSuccess(
        provisionResult.provision,
        `${intent.title}, ${fragmentLabel(intent.fragmentKind)} ${intent.fragmentNumber}`,
      );
    }
  }
}

export type LegislationVerifyResult = {
  citation: string;
  resolved: boolean;
  url?: string;
  reason?: string;
};

/** Cheap existence check for the citation-verification batch tool. */
export async function verifyCitation(
  raw: string,
): Promise<LegislationVerifyResult> {
  const result = await lookupCitation(raw);
  if (result.resolved) {
    return { citation: raw, resolved: true, url: result.canonicalUrl };
  }
  return { citation: raw, resolved: false, reason: result.reason };
}
