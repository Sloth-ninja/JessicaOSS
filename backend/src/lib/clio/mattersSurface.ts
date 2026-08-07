// Practice Management surface — the self-contained seam behind the
// `/clio-matters` routes. See docs/PRACTICE_MANAGEMENT_SPEC.md.
//
// Model (owner decisions 06/08/2026):
//   - NO matter data is persisted. Every list/detail/activity read is a LIVE
//     Clio Manage read through the existing per-user client (`clioRequest` +
//     `loadClioConnection`) — never a firm token, never another user's token, so
//     a member sees exactly what their own Clio login allows.
//   - The ONLY stored Clio artefact is the id/number pair in
//     `matter_workspace_links`, anchoring a JessicaOS workspace (a `projects`
//     row) to a Clio matter. That table arrives in migration 20260807_01; until
//     it is applied every links read/write DEGRADES to "unsupported"
//     (PGRST205/42P01/42703/PGRST204 — see isLinksSchemaMissing) rather than
//     throwing, so the rest of the surface keeps working on an unmigrated
//     database.
//   - A short in-memory list cache (per user+tab+query+status, 60s TTL, capped)
//     absorbs tab-switching. Nothing survives a restart; it is cleared for the
//     caller on every activity write.
//
// Probe-gated (spec "Open questions" — live probes pending owner action):
//   1. Sorted list continuation. Cursor paging is documented `id(asc)`-only and
//      `offset` support is contradictory across doc pages, so v1 ships ONE
//      200-row page sorted `open_date(desc)` and reports the cap honestly
//      (`capped` / `hasMore` / `totalEntries`). No deep paging until the offset
//      probe passes.
//   3. Billed-entry edit/delete restrictions are undocumented, so a billed entry
//      is REFUSED server-side (fixed 409 detail) — the belt behind the locked
//      UI — until the write probe says otherwise.
//
// Field selectors are one-level-nested and deliberately conservative: an
// invalid selector is a 400 on the WHOLE call (the shipped
// `clio_matter_financials` bug), so speculative fields are confined to the
// matter-detail call, which falls back to the core selector and reports
// `customFieldsUnavailable` rather than failing the page.

import { checkProjectAccess } from "../access";
import { getUserOrganisationId } from "../organisations";
import { isUnmigratedSchemaError } from "../postgrestCodes";
import { safeErrorLog } from "../safeError";
import { createServerSupabase } from "../supabase";
import { ClioApiError, ClioAuthError, clioRequest } from "./client";
import { loadClioConnection } from "./connections";
import { parseMatterStatusFilter } from "./manageTools";
import { ClioValidationError } from "./toolShared";

type Db = ReturnType<typeof createServerSupabase>;

const LINKS_TABLE = "matter_workspace_links";

/** Clio caps index actions at 200 rows; v1 fetches exactly one such page. */
export const MATTERS_PAGE_SIZE = 200;
/** Time entries on one matter — same single-page discipline. */
export const ACTIVITIES_PAGE_SIZE = 200;

// Core matter selector: every column the Matters list and detail overview need.
const MATTER_CORE_FIELDS =
  "id,etag,display_number,description,status,open_date,close_date," +
  "client{id,name},responsible_attorney{id,name},originating_attorney{id,name}," +
  "practice_area{id,name}";

// Detail adds custom field values (UK legal-aid / KYC fields where the firm has
// them). This is the one speculative part of the selector set, so the detail
// call falls back to MATTER_CORE_FIELDS on a 400 (see getMatterDetail).
const MATTER_DETAIL_FIELDS = `${MATTER_CORE_FIELDS},custom_field_values{id,field_type,value,custom_field{id,name}}`;

// Unbilled WIP. Docs-verified 06/08: BillableMatter carries display_number and
// client DIRECTLY — the shipped `matter{...}` brace was a 400 on every call.
// Keep in step with the same selector in lib/clio/manageTools.ts.
const BILLABLE_MATTER_FIELDS =
  "id,display_number,unbilled_amount,unbilled_hours,amount_in_trust,currency_code,client{id,name}";

// Outstanding balances are aggregated PER CLIENT by Clio — there is no
// per-matter figure, so the UI labels this as the client-level balance.
const OUTSTANDING_BALANCE_FIELDS =
  "id,total_outstanding_balance,contact{id,name}";

const RELATED_CONTACT_FIELDS = "id,name,type,primary_email_address";

const ACTIVITY_FIELDS =
  "id,etag,date,quantity,quantity_redacted,note,type,non_billable,billed," +
  "price,total,user{id,name}";

// Fixed, user-safe details (the #72 pattern — raw Clio/DB text never reaches a
// client).
export const BILLED_ENTRY_DETAIL =
  "This time entry has been billed in Clio, so it cannot be changed here.";
export const NOT_OWN_ENTRY_DETAIL =
  "You can only change time entries you recorded yourself.";
export const ETAG_CONFLICT_DETAIL =
  "This entry changed in Clio — reload and try again.";
export const RECONNECT_FOR_OWN_MATTERS_DETAIL =
  "Reconnect your Clio account to see your own matters and time entries.";

// ── Shapes returned to the routes (Clio's raw JSON never leaves this module) ──

export interface ClioRef {
  id: string;
  name: string | null;
}

export interface MatterListRow {
  id: string;
  etag: string | null;
  displayNumber: string | null;
  description: string | null;
  status: string | null;
  openDate: string | null;
  closeDate: string | null;
  client: ClioRef | null;
  responsibleSolicitor: ClioRef | null;
  originatingSolicitor: ClioRef | null;
  practiceArea: ClioRef | null;
}

export type MattersTab = "mine" | "all";

export interface ListMattersOptions {
  tab?: string;
  query?: string;
  status?: string;
}

export interface MattersListResult {
  matters: MatterListRow[];
  count: number;
  /** Clio's own total when it reports one (`meta.records`), else null. */
  totalEntries: number | null;
  /** True when this single page filled up — "showing 200 of N". */
  capped: boolean;
  /** True when Clio says further pages exist (v1 does not fetch them). */
  hasMore: boolean;
  tab: MattersTab;
}

export interface MatterCustomField {
  id: string;
  name: string | null;
  type: string | null;
  value: unknown;
}

/**
 * Money/hours a viewer's Clio permissions may WITHHOLD. A withheld figure
 * arrives as null, which is NOT zero — the `*Hidden` flags let the UI say
 * "Hidden by your Clio permissions" instead of rendering £0.
 */
export interface MatterFinancials {
  unbilledAmount: number | null;
  unbilledAmountHidden: boolean;
  unbilledHours: number | null;
  unbilledHoursHidden: boolean;
  amountInTrust: number | null;
  amountInTrustHidden: boolean;
  currencyCode: string | null;
  clientId: string | null;
  clientName: string | null;
  clientOutstandingBalance: number | null;
  clientOutstandingBalanceHidden: boolean;
}

export interface MatterDetail extends MatterListRow {
  customFields: MatterCustomField[];
  /** True when Clio rejected the custom-fields selector (page still renders). */
  customFieldsUnavailable: boolean;
  financials: MatterFinancials | null;
  /** True when the financials calls failed (e.g. billing permissions). */
  financialsUnavailable: boolean;
}

export interface MatterContact {
  id: string;
  name: string | null;
  type: string | null;
  email: string | null;
}

export interface MatterActivity {
  id: string;
  etag: string | null;
  date: string | null;
  /** Duration in SECONDS, exactly as Clio stores it; null when redacted. */
  quantitySeconds: number | null;
  /** Clio's own redaction flag for the duration. */
  quantityRedacted: boolean;
  note: string | null;
  billable: boolean;
  billed: boolean;
  price: number | null;
  total: number | null;
  /**
   * True when Clio returned no price AND no total. That can mean a permissions
   * redaction OR simply a rate-less entry, so the UI must render it as "—" /
   * "not available", never as the "Hidden by your Clio permissions" claim —
   * only `quantityRedacted` states redaction outright.
   */
  amountsUnavailable: boolean;
  user: ClioRef | null;
  isOwn: boolean;
  /** Billed entries are locked: no edit/delete until the write probe lands. */
  locked: boolean;
}

export interface MatterActivitiesResult {
  activities: MatterActivity[];
  count: number;
  capped: boolean;
  /** False = the caller's own entries only (the default). */
  everyone: boolean;
}

export interface MatterWorkspaceLink {
  projectId: string;
  projectName: string | null;
  clioMatterId: string;
  clioDisplayNumber: string | null;
  createdAt: string | null;
}

export type LinkFailure =
  | "unsupported"
  | "not_found"
  | "forbidden"
  /** The MATTER already has a workspace this caller can see. */
  | "already_linked"
  /** The WORKSPACE is already anchored to a matter (unique(project_id)). */
  | "workspace_already_linked";

export interface CreatedWorkspace {
  link: MatterWorkspaceLink;
  projectId: string;
  projectName: string;
}

// ── Small helpers ────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value.length ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function ref(value: unknown): ClioRef | null {
  const row = asRecord(value);
  const id = row ? str(row.id) : null;
  if (!id) return null;
  return { id, name: row ? str(row.name) : null };
}

function dataArray(body: unknown): Record<string, unknown>[] {
  const root = asRecord(body);
  const data = root?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== null);
}

/** Clio wraps a single record in `{ data: {...} }`. */
function dataObject(body: unknown): Record<string, unknown> | null {
  const root = asRecord(body);
  return root ? asRecord(root.data) : null;
}

function totalFromMeta(body: unknown): number | null {
  const meta = asRecord(asRecord(body)?.meta);
  const records = meta ? num(meta.records) : null;
  return records;
}

function hasNextPage(body: unknown): boolean {
  const paging = asRecord(asRecord(asRecord(body)?.meta)?.paging);
  const next = paging?.next;
  return typeof next === "string" && next.length > 0;
}

function normaliseMatter(row: Record<string, unknown>): MatterListRow | null {
  const id = str(row.id);
  if (!id) return null;
  return {
    id,
    etag: str(row.etag),
    displayNumber: str(row.display_number),
    description: str(row.description),
    status: str(row.status),
    openDate: str(row.open_date),
    closeDate: str(row.close_date),
    client: ref(row.client),
    responsibleSolicitor: ref(row.responsible_attorney),
    originatingSolicitor: ref(row.originating_attorney),
    practiceArea: ref(row.practice_area),
  };
}

/**
 * True when a Supabase error means migration 20260807_01 has not run. Thin
 * alias over the shared predicate — the code table and the measurements behind
 * it live in lib/postgrestCodes.ts (PGRST205 is the code that actually fires
 * for a missing table on Supabase; 42P01 alone would never match).
 */
export function isLinksSchemaMissing(error: unknown): boolean {
  return isUnmigratedSchemaError(error);
}

/** Postgres unique_violation — the `unique(project_id)` link constraint. */
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === "23505";
}

/**
 * Clio matter/activity ids are numeric. Validated before they reach a request
 * path so a malformed id fails fast with a fixed message rather than becoming a
 * 404 round-trip (and never becomes path structure — see the parse-not-prefix
 * rule, DURABLE_LESSONS 2026-07-28).
 */
/** Workspace (project) ids are uuids — guarded before they reach Postgres. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isClioId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,20}$/.test(value);
}

function requireClioId(value: unknown, what: string): string {
  if (!isClioId(value)) {
    throw new ClioValidationError(`That ${what} is not valid.`);
  }
  return value;
}

/** The caller's own Clio user id — the basis of "my matters"/"my entries". */
async function requireClioUserId(db: Db, userId: string): Promise<string> {
  const connection = await loadClioConnection(db, userId, "manage");
  if (!connection) throw new ClioAuthError();
  if (!connection.clioUserId) {
    throw new ClioAuthError(RECONNECT_FOR_OWN_MATTERS_DETAIL);
  }
  return connection.clioUserId;
}

// ── List cache ───────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 200;

interface CacheEntry {
  at: number;
  value: MattersListResult;
}

let listCache = new Map<string, CacheEntry>();

function cacheKey(
  userId: string,
  tab: MattersTab,
  query: string,
  status: string,
): string {
  return `${userId}:${tab}:${query}:${status}`;
}

function cacheGet(key: string, now: number): MattersListResult | null {
  const hit = listCache.get(key);
  if (!hit) return null;
  if (now - hit.at > CACHE_TTL_MS) {
    listCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key: string, value: MattersListResult, now: number): void {
  // Refresh insertion order so the eviction below drops the OLDEST entry.
  listCache.delete(key);
  listCache.set(key, { at: now, value });
  while (listCache.size > CACHE_MAX_ENTRIES) {
    const oldest = listCache.keys().next();
    if (oldest.done) break;
    listCache.delete(oldest.value);
  }
}

/**
 * Drop every cached list for ONE user. Called after any write that could change
 * what they see. Deliberately per-user: another user's cache is derived from
 * their own token and must not be invalidated (or read) across callers.
 */
export function clearMattersCacheForUser(userId: string): void {
  const prefix = `${userId}:`;
  for (const key of [...listCache.keys()]) {
    if (key.startsWith(prefix)) listCache.delete(key);
  }
}

/** Test-only: drop all cached lists. */
export function resetMattersSurfaceStateForTests(): void {
  listCache = new Map<string, CacheEntry>();
}

// ── Matter list ──────────────────────────────────────────────────────────────

const MAX_MATTER_QUERY_LENGTH = 256;

function parseTab(raw: unknown): MattersTab {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!value || value === "mine") return "mine";
  if (value === "all") return "all";
  throw new ClioValidationError("Choose either your matters or all matters.");
}

function parseQuery(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length > MAX_MATTER_QUERY_LENGTH) {
    throw new ClioValidationError(
      "That search is too long — use 256 characters or fewer.",
    );
  }
  return value;
}

async function fetchMatterPage(
  db: Db,
  userId: string,
  query: Record<string, string | number | undefined>,
): Promise<{ rows: MatterListRow[]; total: number | null; more: boolean }> {
  const body = await clioRequest(db, userId, "manage", "/matters.json", {
    fields: MATTER_CORE_FIELDS,
    query: { ...query, limit: MATTERS_PAGE_SIZE },
  });
  if (!asRecord(body)) {
    throw new ClioApiError(
      "Clio's response could not be read. Please try again.",
    );
  }
  const rows = dataArray(body)
    .map(normaliseMatter)
    .filter((row): row is MatterListRow => row !== null);
  return { rows, total: totalFromMeta(body), more: hasNextPage(body) };
}

function sortByOpenDateDesc(rows: MatterListRow[]): MatterListRow[] {
  return [...rows].sort((a, b) => {
    const left = a.openDate ?? "";
    const right = b.openDate ?? "";
    if (left === right)
      return (a.displayNumber ?? "").localeCompare(b.displayNumber ?? "");
    return left < right ? 1 : -1;
  });
}

/**
 * One list view = ONE Clio call ("all"), or two ("mine": responsible ∪
 * originating, which Clio cannot express as a single filter). Results are
 * de-duplicated by id and sorted `open_date` descending.
 *
 * Counts are honest: `totalEntries` is Clio's own `meta.records` when it reports
 * one; on the merged "mine" tab a total is only claimed when NEITHER page was
 * capped (otherwise the union size is unknowable without deep paging, which is
 * probe-gated).
 */
export async function listMatters(
  db: Db,
  userId: string,
  options: ListMattersOptions = {},
): Promise<MattersListResult> {
  const tab = parseTab(options.tab);
  const query = parseQuery(options.query);
  const status = parseMatterStatusFilter(options.status) ?? "";

  const key = cacheKey(userId, tab, query, status);
  const now = Date.now();
  const cached = cacheGet(key, now);
  if (cached) return cached;

  const shared = {
    ...(query ? { query } : {}),
    ...(status ? { status } : {}),
  };

  let result: MattersListResult;
  if (tab === "all") {
    const page = await fetchMatterPage(db, userId, {
      ...shared,
      order: "open_date(desc)",
    });
    result = {
      matters: page.rows,
      count: page.rows.length,
      totalEntries: page.total,
      capped: page.rows.length >= MATTERS_PAGE_SIZE,
      hasMore: page.more,
      tab,
    };
  } else {
    const clioUserId = await requireClioUserId(db, userId);
    // Sequential, not parallel: the two calls share ONE 50 req/min per-user
    // budget and the client's proactive backoff is per-bucket, so firing them
    // together would race the same bucket for no material latency win.
    const responsible = await fetchMatterPage(db, userId, {
      ...shared,
      responsible_attorney_id: clioUserId,
    });
    const originating = await fetchMatterPage(db, userId, {
      ...shared,
      originating_attorney_id: clioUserId,
    });
    const byId = new Map<string, MatterListRow>();
    for (const row of [...responsible.rows, ...originating.rows]) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
    const merged = sortByOpenDateDesc([...byId.values()]);
    const capped =
      responsible.rows.length >= MATTERS_PAGE_SIZE ||
      originating.rows.length >= MATTERS_PAGE_SIZE;
    result = {
      matters: merged,
      count: merged.length,
      // Only a complete union can be counted honestly; a capped page means the
      // real total is unknown, so we claim nothing rather than sum (which would
      // double-count matters the caller both runs and originated).
      totalEntries: capped ? null : merged.length,
      capped,
      hasMore: capped || responsible.more || originating.more,
      tab,
    };
  }

  cacheSet(key, result, now);
  return result;
}

// ── Matter detail (+ financials) ─────────────────────────────────────────────

function normaliseCustomFields(row: Record<string, unknown>): {
  fields: MatterCustomField[];
} {
  const raw = row.custom_field_values;
  if (!Array.isArray(raw)) return { fields: [] };
  const fields: MatterCustomField[] = [];
  for (const entry of raw) {
    const value = asRecord(entry);
    const id = value ? str(value.id) : null;
    if (!value || !id) continue;
    fields.push({
      id,
      name: str(asRecord(value.custom_field)?.name),
      type: str(value.field_type),
      value: value.value ?? null,
    });
  }
  return { fields };
}

async function loadFinancials(
  db: Db,
  userId: string,
  matterId: string,
  clientId: string | null,
): Promise<MatterFinancials> {
  const billableBody = await clioRequest(
    db,
    userId,
    "manage",
    "/billable_matters.json",
    {
      fields: BILLABLE_MATTER_FIELDS,
      query: { matter_id: matterId, limit: 1 },
    },
  );
  const billable = dataArray(billableBody)[0] ?? null;

  // Clio aggregates outstanding balances per CLIENT only — there is no
  // per-matter figure, so this is fetched (and labelled) as the client's.
  let outstanding: Record<string, unknown> | null = null;
  if (clientId) {
    const outstandingBody = await clioRequest(
      db,
      userId,
      "manage",
      "/outstanding_client_balances.json",
      {
        fields: OUTSTANDING_BALANCE_FIELDS,
        query: { contact_id: clientId, limit: 1 },
      },
    );
    outstanding = dataArray(outstandingBody)[0] ?? null;
  }

  const unbilledAmount = billable ? num(billable.unbilled_amount) : null;
  const unbilledHours = billable ? num(billable.unbilled_hours) : null;
  const amountInTrust = billable ? num(billable.amount_in_trust) : null;
  const clientBalance = outstanding
    ? num(outstanding.total_outstanding_balance)
    : null;

  return {
    unbilledAmount,
    // A figure is only "hidden" when Clio RETURNED the record but withheld the
    // value; no record at all simply means there is nothing to show.
    unbilledAmountHidden: !!billable && unbilledAmount === null,
    unbilledHours,
    unbilledHoursHidden: !!billable && unbilledHours === null,
    amountInTrust,
    amountInTrustHidden: !!billable && amountInTrust === null,
    currencyCode: billable ? str(billable.currency_code) : null,
    clientId,
    clientName: billable ? str(asRecord(billable.client)?.name) : null,
    clientOutstandingBalance: clientBalance,
    clientOutstandingBalanceHidden: !!outstanding && clientBalance === null,
  };
}

/**
 * Matter overview + financials. Three Clio calls at most (matter, unbilled WIP,
 * client balance) — well inside the per-user budget, and each failure is
 * contained: a rejected custom-fields selector falls back to the core selector,
 * and a financials failure (commonly a billing-permissions 403) leaves the rest
 * of the page intact rather than 500-ing it.
 */
export async function getMatterDetail(
  db: Db,
  userId: string,
  rawMatterId: string,
): Promise<MatterDetail> {
  const matterId = requireClioId(rawMatterId, "matter id");
  const path = `/matters/${matterId}.json`;

  let row: Record<string, unknown> | null = null;
  let customFieldsUnavailable = false;
  try {
    row = dataObject(
      await clioRequest(db, userId, "manage", path, {
        fields: MATTER_DETAIL_FIELDS,
      }),
    );
  } catch (err) {
    // A 400 here means Clio rejected the SELECTOR (the custom-field part is the
    // only un-probed piece). Retry once with the core selector so the page still
    // loads, and log loudly — this is exactly the shipped-selector bug class and
    // must be visible in the logs, not silently absorbed.
    if (!(err instanceof ClioApiError) || err.status !== 400) throw err;
    console.error("[clio/matters] detail selector rejected — retrying core", {
      error: safeErrorLog(err),
    });
    customFieldsUnavailable = true;
    row = dataObject(
      await clioRequest(db, userId, "manage", path, {
        fields: MATTER_CORE_FIELDS,
      }),
    );
  }

  const base = row ? normaliseMatter(row) : null;
  if (!base) {
    throw new ClioApiError("That Clio matter was not found.", 404);
  }
  const { fields } = row ? normaliseCustomFields(row) : { fields: [] };

  let financials: MatterFinancials | null = null;
  let financialsUnavailable = false;
  try {
    financials = await loadFinancials(
      db,
      userId,
      base.id,
      base.client?.id ?? null,
    );
  } catch (err) {
    financialsUnavailable = true;
    console.error("[clio/matters] financials unavailable", {
      error: safeErrorLog(err),
    });
  }

  return {
    ...base,
    customFields: fields,
    customFieldsUnavailable,
    financials,
    financialsUnavailable,
  };
}

/** The matter's related contacts ("key people"). */
export async function listRelatedContacts(
  db: Db,
  userId: string,
  rawMatterId: string,
): Promise<MatterContact[]> {
  const matterId = requireClioId(rawMatterId, "matter id");
  const body = await clioRequest(
    db,
    userId,
    "manage",
    `/matters/${matterId}/related_contacts.json`,
    { fields: RELATED_CONTACT_FIELDS, query: { limit: 50 } },
  );
  const out: MatterContact[] = [];
  for (const row of dataArray(body)) {
    const id = str(row.id);
    if (!id) continue;
    out.push({
      id,
      name: str(row.name),
      type: str(row.type),
      email: str(row.primary_email_address),
    });
  }
  return out;
}

// ── Time entries ─────────────────────────────────────────────────────────────

function normaliseActivity(
  row: Record<string, unknown>,
  clioUserId: string | null,
): MatterActivity | null {
  const id = str(row.id);
  if (!id) return null;
  const user = ref(row.user);
  const price = num(row.price);
  const total = num(row.total);
  const billed = row.billed === true;
  return {
    id,
    etag: str(row.etag),
    date: str(row.date),
    quantitySeconds: num(row.quantity),
    quantityRedacted: row.quantity_redacted === true,
    note: str(row.note),
    billable: row.non_billable !== true,
    billed,
    price,
    total,
    // Deliberately "unavailable", NOT "hidden": a null price/total can equally
    // mean a rate-less entry, so the UI must not claim "Hidden by your Clio
    // permissions" off the back of it. `quantityRedacted` is Clio's ONLY
    // explicit redaction signal and is passed through untouched.
    amountsUnavailable: price === null && total === null,
    user,
    isOwn: !!clioUserId && !!user && user.id === clioUserId,
    // Probe-gated: billed entries carry no edit/delete affordance, and the
    // server refuses those writes too (see assertEditableActivity).
    locked: billed,
  };
}

/**
 * A matter's TimeEntry activities, newest first. Defaults to the CALLER's own
 * entries; `everyone` lifts the filter to the whole matter (still bounded by
 * what their own Clio token may read).
 */
export async function listActivities(
  db: Db,
  userId: string,
  rawMatterId: string,
  options: { everyone?: boolean } = {},
): Promise<MatterActivitiesResult> {
  const matterId = requireClioId(rawMatterId, "matter id");
  const everyone = options.everyone === true;
  const clioUserId = await requireClioUserId(db, userId);
  const body = await clioRequest(db, userId, "manage", "/activities.json", {
    fields: ACTIVITY_FIELDS,
    query: {
      matter_id: matterId,
      type: "TimeEntry",
      order: "date(desc)",
      limit: ACTIVITIES_PAGE_SIZE,
      ...(everyone ? {} : { user_id: clioUserId }),
    },
  });
  const activities = dataArray(body)
    .map((row) => normaliseActivity(row, clioUserId))
    .filter((row): row is MatterActivity => row !== null);
  return {
    activities,
    count: activities.length,
    capped: activities.length >= ACTIVITIES_PAGE_SIZE,
    everyone,
  };
}

async function loadActivity(
  db: Db,
  userId: string,
  activityId: string,
): Promise<Record<string, unknown> | null> {
  return dataObject(
    await clioRequest(db, userId, "manage", `/activities/${activityId}.json`, {
      fields: ACTIVITY_FIELDS,
    }),
  );
}

/**
 * Guard every activity write: the entry must exist, belong to the CALLER's own
 * Clio user, and not be billed. The billed refusal is the server-side belt
 * behind the locked UI while open question 3 (undocumented billed-entry write
 * restrictions) is un-probed — better a fixed 409 than a half-applied write.
 * Returns the current etag when Clio reports one.
 */
async function assertEditableActivity(
  db: Db,
  userId: string,
  activityId: string,
): Promise<{ etag: string | null; clioUserId: string }> {
  const clioUserId = await requireClioUserId(db, userId);
  const row = await loadActivity(db, userId, activityId);
  if (!row) throw new ClioApiError("That Clio time entry was not found.", 404);
  const owner = ref(row.user);
  if (!owner || owner.id !== clioUserId) {
    throw new ClioApiError(NOT_OWN_ENTRY_DETAIL, 403);
  }
  if (row.billed === true) {
    throw new ClioApiError(BILLED_ENTRY_DETAIL, 409);
  }
  return { etag: str(row.etag), clioUserId };
}

export interface ActivityPatch {
  /** Already converted from the UI's minutes by the route boundary. */
  quantitySeconds?: number;
  note?: string;
  /** YYYY-MM-DD. */
  date?: string;
  /** The etag the client last saw — optimistic concurrency. */
  etag?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NOTE_LENGTH = 4000;

// An etag becomes an outbound HTTP header VALUE, so it is constrained to
// printable ASCII and a sane length before it can travel — a client-supplied
// string must never be able to carry control characters (header injection) or
// an unbounded body into a request we issue.
const ETAG_RE = /^[\x21-\x7e]{1,200}$/;

/**
 * Update one of the caller's own time entries with optimistic concurrency.
 *
 * The client's etag is preferred for `If-Match`; when it does not match what
 * Clio currently holds we fail with the fixed conflict detail BEFORE writing.
 * When the client supplies none (or Clio omits the field), the etag read during
 * the ownership pre-check is used instead — a narrower read-modify-write window
 * than no protection at all. A Clio 412 maps onto the same fixed detail.
 */
export async function updateActivity(
  db: Db,
  userId: string,
  rawActivityId: string,
  patch: ActivityPatch,
): Promise<MatterActivity> {
  const activityId = requireClioId(rawActivityId, "time entry id");

  const data: Record<string, unknown> = {};
  if (patch.quantitySeconds !== undefined) {
    if (!Number.isFinite(patch.quantitySeconds) || patch.quantitySeconds <= 0) {
      throw new ClioValidationError(
        "Enter the time to record as a positive number of minutes.",
      );
    }
    data.quantity = Math.round(patch.quantitySeconds);
  }
  if (patch.note !== undefined) {
    const note = patch.note.trim();
    if (!note) {
      throw new ClioValidationError("A description of the work is required.");
    }
    if (note.length > MAX_NOTE_LENGTH) {
      throw new ClioValidationError(
        "That description is too long — use 4000 characters or fewer.",
      );
    }
    data.note = note;
  }
  if (patch.date !== undefined) {
    if (!DATE_RE.test(patch.date)) {
      throw new ClioValidationError("Enter the date as DD/MM/YYYY.");
    }
    data.date = patch.date;
  }
  if (Object.keys(data).length === 0) {
    throw new ClioValidationError("There is nothing to change on that entry.");
  }

  const clientEtag = patch.etag?.trim();
  if (clientEtag && !ETAG_RE.test(clientEtag)) {
    throw new ClioValidationError(ETAG_CONFLICT_DETAIL);
  }

  const current = await assertEditableActivity(db, userId, activityId);
  if (clientEtag && current.etag && clientEtag !== current.etag) {
    throw new ClioApiError(ETAG_CONFLICT_DETAIL, 412);
  }
  const ifMatch = clientEtag || current.etag;

  let body: unknown;
  try {
    body = await clioRequest(
      db,
      userId,
      "manage",
      `/activities/${activityId}.json`,
      {
        method: "PATCH",
        fields: ACTIVITY_FIELDS,
        ...(ifMatch ? { headers: { "IF-MATCH": ifMatch } } : {}),
        json: { data },
      },
    );
  } catch (err) {
    if (err instanceof ClioApiError && err.status === 412) {
      throw new ClioApiError(ETAG_CONFLICT_DETAIL, 412);
    }
    throw err;
  }

  clearMattersCacheForUser(userId);
  const row = dataObject(body);
  const updated = row ? normaliseActivity(row, current.clioUserId) : null;
  if (!updated) {
    throw new ClioApiError(
      "Clio's response could not be read. Please try again.",
    );
  }
  return updated;
}

/** Delete one of the caller's own, unbilled time entries. */
export async function deleteActivity(
  db: Db,
  userId: string,
  rawActivityId: string,
): Promise<void> {
  const activityId = requireClioId(rawActivityId, "time entry id");
  await assertEditableActivity(db, userId, activityId);
  await clioRequest(db, userId, "manage", `/activities/${activityId}.json`, {
    method: "DELETE",
  });
  clearMattersCacheForUser(userId);
}

// ── Workspace links ──────────────────────────────────────────────────────────

interface LinkRow {
  project_id: string;
  clio_matter_id: string;
  clio_display_number: string | null;
  created_by: string | null;
  created_at: string | null;
}

const LINK_COLUMNS =
  "project_id, clio_matter_id, clio_display_number, created_by, created_at";

function toLink(row: LinkRow, projectName: string | null): MatterWorkspaceLink {
  return {
    projectId: row.project_id,
    projectName,
    clioMatterId: row.clio_matter_id,
    clioDisplayNumber: row.clio_display_number,
    createdAt: row.created_at,
  };
}

// A matter is normally linked to one workspace; the cap only bounds the access
// filtering below on a pathological dataset.
const MAX_LINK_CANDIDATES = 10;

async function selectLinks(
  db: Db,
  column: "project_id" | "clio_matter_id",
  value: string,
): Promise<LinkRow[] | "unsupported"> {
  const { data, error } = await db
    .from(LINKS_TABLE)
    .select(LINK_COLUMNS)
    .eq(column, value)
    // Deterministic candidate order: oldest link first, so which workspace a
    // multi-linked matter resolves to never depends on Postgres's row order.
    .order("created_at", { ascending: true })
    .limit(MAX_LINK_CANDIDATES);
  if (error) {
    if (isLinksSchemaMissing(error)) return "unsupported";
    throw error;
  }
  return ((data as LinkRow[] | null) ?? []).slice(0, MAX_LINK_CANDIDATES);
}

async function loadProjectName(
  db: Db,
  projectId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("projects")
    .select("name")
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw error;
  return data ? str((data as { name?: unknown }).name) : null;
}

/**
 * The link for a Clio matter, filtered to what the CALLER may actually see.
 *
 * A link row is only a pair of ids, but the workspace it points at is real
 * content: another member's private workspace linked to the same matter must
 * not surface here. `checkProjectAccess` is the shared choke point that also
 * excludes tombstoned matters (DURABLE_LESSONS 2026-07-28), so a soft-deleted
 * workspace stops being offered the moment it is deleted — not when it is
 * finally purged.
 */
async function findAccessibleLink(
  db: Db,
  userId: string,
  userEmail: string | null | undefined,
  matterId: string,
): Promise<MatterWorkspaceLink | null | "unsupported"> {
  const rows = await selectLinks(db, "clio_matter_id", matterId);
  if (rows === "unsupported") return "unsupported";
  if (rows.length === 0) return null;
  const userOrgId = await getUserOrganisationId(db, userId);
  // The caller's OWN link wins over a colleague's when a matter carries more
  // than one — otherwise "open the workspace" could send them to someone
  // else's simply because it was created first. `selectLinks` already fixed the
  // tie-break order, so this is a stable partition, not a re-sort.
  const candidates = [
    ...rows.filter((row) => row.created_by === userId),
    ...rows.filter((row) => row.created_by !== userId),
  ];
  for (const row of candidates) {
    const access = await checkProjectAccess(
      row.project_id,
      userId,
      userEmail,
      db,
      userOrgId,
    );
    if (!access.ok) continue;
    return toLink(row, await loadProjectName(db, row.project_id));
  }
  return null;
}

/**
 * The caller-visible link for a matter.
 *
 * Returns the "unsupported" sentinel rather than collapsing it to null: "there
 * is no link" and "linking does not exist on this deployment yet" are different
 * facts, and only the second one means the surface must stop OFFERING to link.
 * Flattening them is what let the detail page show a "Start workspace" button
 * that could only ever answer with a 409.
 */
export async function getLinkForMatter(
  db: Db,
  userId: string,
  userEmail: string | null | undefined,
  rawMatterId: string,
): Promise<MatterWorkspaceLink | null | "unsupported"> {
  const matterId = requireClioId(rawMatterId, "matter id");
  return await findAccessibleLink(db, userId, userEmail, matterId);
}

/**
 * Whether workspace linking is usable at all on this deployment — false until
 * migration `20260807_01` creates `matter_workspace_links`.
 *
 * The link reads and writes already degrade to "unsupported", but a surface has
 * to know BEFORE it draws an affordance: a "Start workspace" button that always
 * refuses is a lie, not a degrade. One zero-row probe; a missing table is
 * answered from PostgREST's schema cache and never reaches Postgres.
 *
 * Fails OPEN on any other error (the 2026-07-27 rule: this is an availability
 * gate, not a destructive operation). A transient DB blip must not tell a
 * solicitor the feature does not exist — the write path's own fixed refusal is
 * the honest backstop.
 */
export async function areLinksAvailable(db: Db): Promise<boolean> {
  const { error } = await db.from(LINKS_TABLE).select("project_id").limit(1);
  if (error) {
    if (isLinksSchemaMissing(error)) return false;
    console.error("[clio/matters] links availability probe failed", {
      error: safeErrorLog(error),
    });
  }
  return true;
}

/** The link on a given workspace, or null when absent/unsupported/tombstoned. */
export async function getLinkForProject(
  db: Db,
  userId: string,
  userEmail: string | null | undefined,
  projectId: string,
): Promise<MatterWorkspaceLink | null> {
  // Workspace ids are uuids; a malformed one would reach Postgres as 22P02 and
  // surface as a 500 rather than the "no link" this should answer.
  if (!UUID_RE.test(projectId)) return null;
  const rows = await selectLinks(db, "project_id", projectId);
  if (rows === "unsupported" || rows.length === 0) return null;
  const userOrgId = await getUserOrganisationId(db, userId);
  const access = await checkProjectAccess(
    projectId,
    userId,
    userEmail,
    db,
    userOrgId,
  );
  if (!access.ok) return null;
  return toLink(rows[0], await loadProjectName(db, projectId));
}

async function insertLink(
  db: Db,
  userId: string,
  input: {
    projectId: string;
    clioMatterId: string;
    clioDisplayNumber: string | null;
    organisationId: string | null;
  },
): Promise<LinkRow | "unsupported" | "workspace_already_linked"> {
  const { data, error } = await db
    .from(LINKS_TABLE)
    .insert({
      project_id: input.projectId,
      clio_matter_id: input.clioMatterId,
      clio_display_number: input.clioDisplayNumber,
      organisation_id: input.organisationId,
      created_by: userId,
    })
    .select(LINK_COLUMNS)
    .single();
  if (error) {
    if (isLinksSchemaMissing(error)) return "unsupported";
    // The constraint is unique(project_id), so this is always the WORKSPACE
    // side of the relationship — that workspace is already anchored to some
    // matter. The matter side is caught by the pre-check in linkWorkspace.
    if (isUniqueViolation(error)) return "workspace_already_linked";
    throw error;
  }
  return data as LinkRow;
}

/**
 * Link an EXISTING workspace to a Clio matter. Owner-only: sharing or firm
 * visibility does not confer the right to re-anchor someone else's workspace.
 */
export async function linkWorkspace(
  db: Db,
  userId: string,
  userEmail: string | null | undefined,
  input: { projectId: string; clioMatterId: string },
): Promise<MatterWorkspaceLink | LinkFailure> {
  const matterId = requireClioId(input.clioMatterId, "matter id");
  const userOrgId = await getUserOrganisationId(db, userId);
  const access = await checkProjectAccess(
    input.projectId,
    userId,
    userEmail,
    db,
    userOrgId,
  );
  if (!access.ok) return "not_found";
  if (!access.isOwner) return "forbidden";

  // Same matter-side pre-check createWorkspaceForMatter runs, so both entry
  // points answer identically when the caller can already see a workspace for
  // this matter — without it, linking here would quietly create a SECOND link
  // for the matter and make `getLinkForMatter` order-dependent.
  const existing = await findAccessibleLink(db, userId, userEmail, matterId);
  if (existing === "unsupported") return "unsupported";
  if (existing) {
    // Re-linking the very workspace that is already linked is a no-op, not an
    // error — report it as the workspace-side conflict it is.
    return existing.projectId === input.projectId
      ? "workspace_already_linked"
      : "already_linked";
  }

  // Confirms the caller's own Clio token can see the matter (never trust a
  // client-supplied display number) before anything is stored.
  const matter = await getMatterSummary(db, userId, matterId);
  if (!matter) return "not_found";

  const row = await insertLink(db, userId, {
    projectId: input.projectId,
    clioMatterId: matterId,
    clioDisplayNumber: matter.displayNumber,
    organisationId: userOrgId,
  });
  if (row === "unsupported" || row === "workspace_already_linked") return row;
  return toLink(row, await loadProjectName(db, input.projectId));
}

/** Remove a link. Owner-only, mirroring linkWorkspace. */
export async function unlinkWorkspace(
  db: Db,
  userId: string,
  userEmail: string | null | undefined,
  projectId: string,
): Promise<"unlinked" | LinkFailure> {
  const userOrgId = await getUserOrganisationId(db, userId);
  const access = await checkProjectAccess(
    projectId,
    userId,
    userEmail,
    db,
    userOrgId,
  );
  if (!access.ok) return "not_found";
  if (!access.isOwner) return "forbidden";
  const { error } = await db
    .from(LINKS_TABLE)
    .delete()
    .eq("project_id", projectId)
    // Defence in depth: links are only ever created by the workspace owner, so
    // this predicate is redundant with the ownership check above — but it means
    // an ownership-check regression can still never delete another user's row.
    .eq("created_by", userId);
  if (error) {
    if (isLinksSchemaMissing(error)) return "unsupported";
    throw error;
  }
  return "unlinked";
}

async function getMatterSummary(
  db: Db,
  userId: string,
  matterId: string,
): Promise<MatterListRow | null> {
  const row = dataObject(
    await clioRequest(db, userId, "manage", `/matters/${matterId}.json`, {
      fields: MATTER_CORE_FIELDS,
    }),
  );
  return row ? normaliseMatter(row) : null;
}

const MAX_WORKSPACE_NAME_DESCRIPTION = 80;

/** `0001-0007 — Acme Ltd acquisition`, truncated; never an empty name. */
export function workspaceNameForMatter(matter: MatterListRow): string {
  const number = matter.displayNumber?.trim() ?? "";
  const description = (matter.description ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_WORKSPACE_NAME_DESCRIPTION);
  if (number && description) return `${number} — ${description}`;
  if (number) return number;
  if (description) return description;
  return `Clio matter ${matter.id}`;
}

/**
 * Lazily create the JessicaOS workspace for a matter and link it.
 *
 * Link support is checked BEFORE the workspace is created so an unmigrated
 * database cannot leave an orphan matter behind; if the link insert still fails
 * (a race with the migration), the just-created workspace is removed again.
 * The organisation stamp goes on the LINK row only — a workspace's own
 * `organisation_id` carries WS9 firm-visibility meaning and must stay unset
 * until its owner actually shares it.
 */
export async function createWorkspaceForMatter(
  db: Db,
  userId: string,
  userEmail: string | null | undefined,
  rawMatterId: string,
): Promise<CreatedWorkspace | LinkFailure> {
  const matterId = requireClioId(rawMatterId, "matter id");

  // Checked before anything is created: an unmigrated links table must not
  // leave an orphan workspace behind, and a matter this caller can already see
  // a workspace for is never given a second one.
  const existing = await findAccessibleLink(db, userId, userEmail, matterId);
  if (existing === "unsupported") return "unsupported";
  if (existing) return "already_linked";

  const matter = await getMatterSummary(db, userId, matterId);
  if (!matter) return "not_found";

  const userOrgId = await getUserOrganisationId(db, userId);
  const name = workspaceNameForMatter(matter);
  const { data: project, error } = await db
    .from("projects")
    .insert({
      user_id: userId,
      name,
      cm_number: matter.displayNumber,
      shared_with: [],
    })
    .select("id, name")
    .single();
  if (error) throw error;
  const projectId = str((project as { id?: unknown } | null)?.id);
  if (!projectId) {
    throw new Error("Created workspace could not be read back.");
  }

  const row = await insertLink(db, userId, {
    projectId,
    clioMatterId: matterId,
    clioDisplayNumber: matter.displayNumber,
    organisationId: userOrgId,
  });
  if (row === "unsupported" || row === "workspace_already_linked") {
    // Roll the workspace back — a matter created for a link that never landed
    // is an orphan the user never asked for. Best-effort: a failed cleanup is
    // logged, never masking the outcome the caller must handle.
    const cleanup = await db.from("projects").delete().eq("id", projectId);
    if (cleanup.error) {
      console.error("[clio/matters] orphan workspace cleanup failed", {
        error: safeErrorLog(cleanup.error),
      });
    }
    return row;
  }
  return { link: toLink(row, name), projectId, projectName: name };
}
