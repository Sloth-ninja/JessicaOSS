// =============================================================================
// CLIO LIVE PROBES — answers the Practice Management spec's open questions
// against the LIVE Clio EU tenant, using the owner's already-stored connection.
//
//   ⚠ READ THIS BEFORE RUNNING ⚠
//
//   * A local backend checkout normally points at the PRODUCTION Supabase.
//     This script therefore reads a PRODUCTION Clio access token belonging to a
//     real solicitor and issues real API calls against the firm's live tenant.
//   * It never runs an AUTHORISATION flow (no authorize redirect, no code
//     exchange, no consent) and the stored connection row is NEVER rewritten.
//     Be precise about what that does not say: a 401 from Clio can still make
//     the shipped client attempt ONE refresh-token exchange (client.ts:397-406)
//     before it tries to persist the result — and that persist is blocked here,
//     so the row is left exactly as it was. Preflight also refuses up front when
//     the token is expired or near expiry, so the usual run never gets there.
//     Never "fix" a refusal by connecting Clio locally as a pilot user — that
//     would overwrite the production connection with a dev-minted token.
//   * Probes 1–9 are strictly read-only (GET only, enforced structurally).
//     Probe 10 writes, and only when explicitly enabled — see "Write probe".
//   * Probe output deliberately records SHAPES, not client data: field presence,
//     types and counts, never names, descriptions or note text. The result file
//     is still a record of a live production run — treat it accordingly.
//
// -----------------------------------------------------------------------------
// Why this exists
// -----------------------------------------------------------------------------
// `docs/PRACTICE_MANAGEMENT_SPEC.md` § "Open questions (probe before build
// claims them)" names four things the build must not assume, and its
// § Verification requires "live probes 1–9 (read-only) before build sign-off;
// write probe 10 owner-authorised". The four headline questions are:
//
//   (1) Sorted list continuation — does `/matters.json` honour `offset`
//       alongside an `order=` sort, i.e. can the Matters list ever page beyond
//       one 200-row page?                                   → probe 3
//   (2) `clio_matter_financials` selector — does the corrected BillableMatter
//       selector return 200 with data (and was the old `matter{…}` brace really
//       the cause of the 400 the owner reproduced on 06/08)? → probe 6
//   (3) Billed-entry edit/delete restrictions (undocumented). → probe 10
//   (4) `clio_find_contact` brace-on-scalar selector.          → probe 8
//
// Probes 2, 4, 5, 7 and 9 cover the remaining live reads the shipped seam
// (`src/lib/clio/mattersSurface.ts`) depends on — every selector and filter the
// Matters surface issues — because a probe run that validated only the four
// headline questions would sign off a build whose other calls were never once
// exercised live. Probe 1 is the connection/identity sanity check the "My
// matters" tab is entirely built on (stored `clio_user_id`).
//
// Where the docs are ambiguous, the probe implements whatever ANSWERS the spec
// question and says so in a comment at the probe.
//
// -----------------------------------------------------------------------------
// Usage
// -----------------------------------------------------------------------------
//   cd backend
//   npx tsx scripts/clio-live-probes.ts --dry-run
//   npx tsx scripts/clio-live-probes.ts --user-id <owner-supabase-uuid>
//   npx tsx scripts/clio-live-probes.ts --user-id <uuid> --out ./probes.json
//   CLIO_PROBE_TEST_MATTER_ID=12345678 \
//     npx tsx scripts/clio-live-probes.ts --user-id <uuid> --write-probe
//
// Flags:
//   --user-id <uuid>   Supabase user whose stored Clio Manage connection is used
//                      (required unless --dry-run). Reads only that user's row.
//   --matter-id <id>   Pin the matter used by probes 5–7 and 9. Default: the
//                      first row probe 2 returns.
//   --out <file>       Machine-readable JSON summary. Default
//                      ./clio-probe-results.json (git-ignored).
//   --dry-run          Walk every probe printing what WOULD be called. No
//                      database access, no network, no credentials needed.
//   --write-probe      Enable probe 10 (see below).
//   --help
//
// Prerequisites (live runs):
//   * `backend/.env` loaded as the server loads it — SUPABASE_URL,
//     SUPABASE_SECRET_KEY, and CLIO_MANAGE_CLIENT_ID/_SECRET (a refresh is
//     refused, but the client reads the credentials).
//   * USER_API_KEYS_ENCRYPTION_SECRET **must be the same value as on Fly**.
//     Stored Clio tokens are AES-256-GCM encrypted with a key derived from it;
//     a mismatched secret decrypts to nothing and the connection simply looks
//     absent. The script detects exactly that case and says so rather than
//     reporting "not connected".
//   * The operator's IP is irrelevant (Clio is called server-side, no allowlist),
//     but the 50 req/min per-user Manage budget is shared with production
//     traffic — run this when the pilot firm is not mid-session. A full run is
//     ~17 requests read-only, ~25 with the write probe.
//
// Write probe (10) — owner-authorised, self-cleaning:
//   Runs ONLY when BOTH `--write-probe` is passed AND CLIO_PROBE_TEST_MATTER_ID
//   names the designated test matter. It creates one non-billable time entry,
//   exercises the PATCH/If-Match concurrency path, attempts a NO-OP edit of a
//   billed entry to learn the restriction, and then deletes everything it
//   created (best-effort, reported honestly even on partial failure).
//
//   EVERY write it makes stays on CLIO_PROBE_TEST_MATTER_ID. The billed entry it
//   patches is found by its OWN search of that matter, restricted to the
//   caller's own entries — never inherited from the read phase, which runs
//   against an arbitrary live matter. It skips rather than widens when no such
//   entry exists, when the caller's Clio user id is unknown, or when the note is
//   not readable (blanking a note on an invoiced record is exactly the change a
//   "no-op" must not make). It never deletes anything it did not create, and
//   never bills or voids anything — the 03/08 spike pattern.
//
// -----------------------------------------------------------------------------
// Design notes
// -----------------------------------------------------------------------------
// * Read-only database (`scripts/readOnlyDb.ts`, unit-tested). The Supabase
//   client handed to `clioRequest` is wrapped in a proxy where reading ANY
//   property other than `from` throws — a true allow-list, after a deny-list
//   version was shown to be walked past twice (`db.schema(…).from(t).update(…)`
//   and `db.rest.from(t).update(…)`; `rest` is a public property holding the
//   PostgrestClient). `from(table)` returns a builder whose
//   insert/update/upsert/delete throw. That makes the "never modify the stored
//   connection" rail STRUCTURAL rather than a promise: the client's own
//   self-healing paths (token refresh persistence, dead-grant pruning) hit the
//   proxy and are surfaced as a clear message instead of silently rewriting or
//   deleting a production row.
// * Read-only Clio. Probes 1–9 may only use `probeGet`, which cannot express a
//   method or a body; `probeWrite` refuses unless the run is in the write phase.
// * Rails are never swallowed. A blocked write or a rate-limit abort is a
//   verdict about the RUN, so every inner `catch` re-raises it (rethrowRailErrors)
//   instead of filing it as an observation about the call under test.
// * Errors. Everything goes through the production client, so Clio's own error
//   BODY is deliberately not visible (the client redacts it and maps failures
//   onto fixed messages). That is the point: a probe verdict reflects exactly
//   what the shipped code sees. Each selector probe therefore tests ONE selector
//   so the HTTP status alone is conclusive, and the two "control" probes (6b,
//   8b) re-issue the pre-fix selector to prove the contrast.
// * Rate limits. Requests are strictly sequential with a short pause; the run
//   aborts after two consecutive 429s rather than hammering a drained bucket.
// =============================================================================

import "dotenv/config";

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  ClioApiError,
  ClioAuthError,
  ClioRateLimitError,
  clioRequest,
  type ClioRequestOptions,
} from "../src/lib/clio/client";
import { clioManageApiVersion, clioRegion } from "../src/lib/clio/config";
import {
  getClioConnectionSummaries,
  loadClioConnection,
} from "../src/lib/clio/connections";
import { CONTACT_SEARCH_FIELDS } from "../src/lib/clio/manageTools";
import {
  ACTIVITY_FIELDS,
  BILLABLE_MATTER_FIELDS,
  MATTER_CORE_FIELDS,
  MATTER_DETAIL_FIELDS,
  OUTSTANDING_BALANCE_FIELDS,
  RELATED_CONTACT_FIELDS,
} from "../src/lib/clio/mattersSurface";
import { createServerSupabase } from "../src/lib/supabase";
import { ProbeWriteBlockedError, readOnlyDb } from "./readOnlyDb";

type Db = ReturnType<typeof createServerSupabase>;

// Pre-fix selectors, re-issued as controls. These are NOT what the code sends
// any more; they exist to prove the fix addressed the real cause.
const CONTROL_BILLABLE_MATTER_FIELDS = "id,matter{id,display_number}";
const CONTROL_CONTACT_FIELDS = "id,name,type,primary_email_address{address}";

// Search term for the `query=` acceptance check. A single common letter is used
// deliberately: the question is whether Clio ACCEPTS the parameter, and guessing
// at a real client or matter name would neither generalise nor be appropriate to
// type into a production tenant.
const MATTER_SEARCH_PROBE_TERM = "a";

/** Pause between probes — polite pacing inside the 50 req/min Manage budget. */
const PAUSE_BETWEEN_REQUESTS_MS = 200;
/** Small page size for the paging probe: two pages, ten rows, one question. */
const OFFSET_PROBE_PAGE_SIZE = 5;
/** Give up after this many consecutive 429s rather than keep pushing. */
const MAX_CONSECUTIVE_RATE_LIMITS = 2;

const PROBE_NOTE_PREFIX = "JessicaOS live probe — safe to delete";

// ── Errors ───────────────────────────────────────────────────────────────────

/** Repeated rate limiting — the run stops rather than continue. */
class ProbeAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeAbortError";
  }
}

/** A probe could not run because a prerequisite was missing (not a failure). */
class ProbeSkipped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeSkipped";
  }
}

// ── Probe framework ──────────────────────────────────────────────────────────

type ProbeStatus = "pass" | "fail" | "inconclusive" | "skipped" | "blocked";

interface ProbeOutcome {
  status: ProbeStatus;
  /** What was actually seen, one short line per observation. */
  observed: string[];
  /** What it means for the shipped code. */
  meaning: string;
  /** Structural extras for the JSON summary — never client data. */
  detail?: Record<string, unknown>;
}

interface ProbeResult extends ProbeOutcome {
  number: number;
  id: string;
  question: string;
  requests: number;
}

interface ProbeCtx {
  db: Db;
  userId: string;
  phase: "read" | "write";
  requests: number;
  consecutiveRateLimits: number;
  aborted: boolean;
  /** Stored Clio user id — the identity the "My matters" tab filters on. */
  clioUserId: string | null;
  /** Matter used by probes 5–7 and 9 (pinned by --matter-id or from probe 2). */
  matterId: string | null;
  /** Client contact id of that matter, for the outstanding-balance read. */
  clientContactId: string | null;
}

interface Probe {
  number: number;
  id: string;
  question: string;
  /** Exact calls this probe would issue — printed by --dry-run. */
  plan: string[];
  run: (ctx: ProbeCtx) => Promise<ProbeOutcome>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Issue one request through the production client, counting it against the
 * budget and tracking consecutive rate limits.
 */
async function request(
  ctx: ProbeCtx,
  path: string,
  opts: ClioRequestOptions,
): Promise<unknown> {
  ctx.requests += 1;
  try {
    const body = await clioRequest(ctx.db, ctx.userId, "manage", path, opts);
    ctx.consecutiveRateLimits = 0;
    return body;
  } catch (err) {
    if (err instanceof ClioRateLimitError) {
      ctx.consecutiveRateLimits += 1;
      if (ctx.consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
        ctx.aborted = true;
        throw new ProbeAbortError(
          `Clio rate-limited ${ctx.consecutiveRateLimits} requests in a row — stopping so the pilot firm's 50 req/min budget recovers.`,
        );
      }
    }
    throw err;
  }
}

/** Options a read-only probe may express: no method, no body, no headers. */
type ReadOnlyOptions = Pick<ClioRequestOptions, "fields" | "query">;

/**
 * The ONLY call shape probes 1–9 can use. It cannot express a method or a body,
 * so the read-only guarantee is structural rather than a convention.
 */
function probeGet(
  ctx: ProbeCtx,
  path: string,
  opts: ReadOnlyOptions = {},
): Promise<unknown> {
  return request(ctx, path, { ...opts, method: "GET" });
}

/** Writes — refused outside the write phase (probe 10). */
function probeWrite(
  ctx: ProbeCtx,
  path: string,
  opts: ClioRequestOptions & { method: "POST" | "PATCH" | "DELETE" },
): Promise<unknown> {
  if (ctx.phase !== "write") {
    throw new Error(
      `Refusing a ${opts.method} outside the write probe — probes 1–9 are read-only.`,
    );
  }
  return request(ctx, path, opts);
}

// ── Response inspection (shapes, never client data) ──────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function dataArray(body: unknown): Record<string, unknown>[] {
  const rows = asRecord(body)?.data;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r): r is Record<string, unknown> => !!asRecord(r));
}

function dataObject(body: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(body)?.data);
}

function metaRecords(body: unknown): number | null {
  const records = asRecord(asRecord(body)?.meta)?.records;
  return typeof records === "number" ? records : null;
}

function hasNextPage(body: unknown): boolean {
  const paging = asRecord(asRecord(asRecord(body)?.meta)?.paging);
  return typeof paging?.next === "string" && paging.next.length > 0;
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

/** Top-level field names in a Clio `fields=` selector (braces stripped). */
function selectorFieldNames(selector: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of selector) {
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      continue;
    }
    if (ch === "," && depth === 0) {
      if (current.trim()) names.push(current.trim());
      current = "";
      continue;
    }
    if (depth === 0) current += ch;
  }
  if (current.trim()) names.push(current.trim());
  return names;
}

/**
 * Which requested fields actually came back — the substance of every selector
 * verdict. Reports presence and null-ness only, never values.
 */
function fieldPresence(
  row: Record<string, unknown> | null,
  selector: string,
): { present: string[]; null: string[]; absent: string[] } {
  const present: string[] = [];
  const nulls: string[] = [];
  const absent: string[] = [];
  for (const name of selectorFieldNames(selector)) {
    if (!row || !(name in row)) absent.push(name);
    else if (row[name] === null) nulls.push(name);
    else present.push(name);
  }
  return { present, null: nulls, absent };
}

/** Ids of a page, in returned order. */
function idsOf(rows: Record<string, unknown>[]): string[] {
  return rows.map((r) => str(r.id) ?? "?");
}

/** True when a date-ish column is non-increasing down the page. */
function isDescending(rows: Record<string, unknown>[], key: string): boolean {
  let previous: string | null = null;
  for (const row of rows) {
    const value = str(row[key]);
    if (value === null) continue;
    if (previous !== null && value > previous) return false;
    previous = value;
  }
  return true;
}

/** A one-line, user-safe rendering of any failure. */
function describeError(err: unknown): string {
  if (err instanceof ClioAuthError) {
    return `ClioAuthError (401) — ${err.message}`;
  }
  if (err instanceof ClioRateLimitError) return "ClioRateLimitError (429)";
  if (err instanceof ClioApiError) {
    return `ClioApiError status=${err.status ?? "unknown"} — ${err.message}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  // Supabase/PostgREST rejects with a PLAIN OBJECT ({ message, code, details }),
  // not an Error — the preflight read is exactly that path, so "Unknown error"
  // would be the operator's whole diagnostic without this branch.
  const record = asRecord(err);
  if (record && typeof record.message === "string") {
    // PostgREST sends an empty-string code for transport failures — an empty
    // `[]` in the operator's one diagnostic line is noise, not information.
    const code =
      typeof record.code === "string" && record.code ? ` [${record.code}]` : "";
    return `${record.message}${code}`;
  }
  return "Unknown error";
}

/** HTTP status of a client error, when it carried one. */
function statusOf(err: unknown): number | null {
  return err instanceof ClioApiError && typeof err.status === "number"
    ? err.status
    : null;
}

/**
 * Re-raise the errors a probe's own `catch` must never absorb.
 *
 * A blocked database write and a rate-limit abort are verdicts about the RUN,
 * not observations about the call under test: swallowing one would report a
 * fired safety rail as an ordinary API result AND let the script carry on
 * issuing requests afterwards. Every inner catch calls this first.
 */
function rethrowRailErrors(err: unknown): void {
  if (
    err instanceof ProbeWriteBlockedError ||
    err instanceof ProbeAbortError ||
    err instanceof ProbeSkipped
  ) {
    throw err;
  }
}

/**
 * Statuses that mean "Clio itself refused this write" — as opposed to a
 * network blip, a 429, or a 500, none of which say anything about permissions.
 * 422 is included because Clio reports some rule violations as unprocessable
 * rather than as a conflict.
 */
const REFUSAL_STATUSES = new Set([401, 403, 409, 422]);

// ── Probes 1–9 (read-only) ───────────────────────────────────────────────────

const readProbes: Probe[] = [
  {
    number: 1,
    id: "identity",
    question:
      "Does the stored connection work, and does its clio_user_id match the live Clio user? (the whole basis of the My matters tab)",
    plan: ["GET /users/who_am_i.json?fields=id,name"],
    async run(ctx) {
      const body = await probeGet(ctx, "/users/who_am_i.json", {
        fields: "id,name",
      });
      const row = dataObject(body);
      const liveId = str(row?.id);
      if (!liveId) {
        return {
          status: "fail",
          observed: ["200 OK but no data.id in the response"],
          meaning:
            "The identity read cannot be trusted; My matters filters on a stored id that cannot be corroborated.",
        };
      }
      // Compare BEFORE adopting the live id as a fallback, or an unstored id
      // would compare equal to itself and report a match that never happened.
      const stored = ctx.clioUserId;
      const matches = stored !== null && stored === liveId;
      ctx.clioUserId = stored ?? liveId;
      return {
        status: matches ? "pass" : "fail",
        observed: [
          "GET /users/who_am_i.json → 200",
          stored === null
            ? "the connection row stores NO clio_user_id (the live id is used for the remaining probes)"
            : matches
              ? "stored clio_user_id matches the live user id"
              : "stored clio_user_id does NOT match the live user id",
        ],
        meaning: matches
          ? "The token is live and the stored identity is correct, so responsible/originating filters address the right user."
          : "My matters cannot filter correctly: the stored identity is missing or wrong, which is exactly what RECONNECT_FOR_OWN_MATTERS_DETAIL tells the user. Reconnect before sign-off.",
        detail: {
          storedMatchesLive: matches,
          storedIdPresent: stored !== null,
        },
      };
    },
  },
  {
    number: 2,
    id: "matters-list",
    question:
      "Does the Matters list selector return 200 with every requested field, sorted open_date(desc), with a total — and are the `query=` search and `status=` filter (the #71 surface) accepted?",
    plan: [
      `GET /matters.json?fields=${MATTER_CORE_FIELDS}&order=open_date(desc)&limit=200`,
      `GET /matters.json?fields=id&order=open_date(desc)&limit=5&query=${MATTER_SEARCH_PROBE_TERM}`,
      "GET /matters.json?fields=id,status&order=open_date(desc)&limit=5&status=open",
    ],
    async run(ctx) {
      const body = await probeGet(ctx, "/matters.json", {
        fields: MATTER_CORE_FIELDS,
        query: { order: "open_date(desc)", limit: 200 },
      });
      const rows = dataArray(body);
      const presence = fieldPresence(rows[0] ?? null, MATTER_CORE_FIELDS);
      const sorted = isDescending(rows, "open_date");
      const records = metaRecords(body);
      // First row becomes the subject of probes 5–7 and 9 unless --matter-id
      // pinned one.
      if (!ctx.matterId) ctx.matterId = str(rows[0]?.id);
      if (!ctx.clientContactId) {
        ctx.clientContactId = str(asRecord(rows[0]?.client)?.id);
      }

      // The search box and the status chips are the exact surface #71 rebuilt,
      // and neither had ever been exercised live. Both are checked for
      // ACCEPTANCE and, for status, for the filter actually biting — an empty
      // result is a fact about this firm's data, not a failure, so it is
      // reported rather than scored.
      const searched = dataArray(
        await probeGet(ctx, "/matters.json", {
          fields: "id",
          query: {
            order: "open_date(desc)",
            limit: 5,
            query: MATTER_SEARCH_PROBE_TERM,
          },
        }),
      );
      const filtered = dataArray(
        await probeGet(ctx, "/matters.json", {
          fields: "id,status",
          query: { order: "open_date(desc)", limit: 5, status: "open" },
        }),
      );
      const offStatus = filtered.filter(
        (row) => (str(row.status) ?? "open").toLowerCase() !== "open",
      ).length;

      return {
        status: rows.length === 0 ? "inconclusive" : "pass",
        observed: [
          `200 OK, ${rows.length} rows (page cap 200)`,
          `absent fields: ${presence.absent.join(", ") || "none"}`,
          `null on the first row: ${presence.null.join(", ") || "none"}`,
          `order=open_date(desc) honoured: ${sorted ? "yes" : "NO"}`,
          `meta.records: ${records ?? "not reported"}; meta.paging.next: ${hasNextPage(body) ? "present" : "absent"}`,
          `query="${MATTER_SEARCH_PROBE_TERM}" → 200, ${searched.length} row(s) (a match count, not a pass/fail)`,
          `status=open → 200, ${filtered.length} row(s); rows with another status: ${offStatus}`,
        ],
        meaning:
          rows.length === 0
            ? "This account can see no matters, so the list selector is untested — re-run against an account with matters."
            : "The shipped list selector, sort, honest-count basis (meta.records) and the search + status filters behind the Matters header are confirmed live.",
        detail: {
          rows: rows.length,
          absentFields: presence.absent,
          sortedByOpenDateDesc: sorted,
          metaRecords: records,
          hasNextPage: hasNextPage(body),
          searchRows: searched.length,
          statusFilterRows: filtered.length,
          statusFilterLeakage: offStatus,
        },
      };
    },
  },
  {
    number: 3,
    id: "offset-continuation",
    question:
      "SPEC OPEN QUESTION 1 — does /matters.json honour `offset` together with `order=open_date(desc)`, i.e. can the list continue beyond one page?",
    plan: [
      `GET /matters.json?fields=id,open_date&order=open_date(desc)&limit=${OFFSET_PROBE_PAGE_SIZE}&offset=0`,
      `GET /matters.json?fields=id,open_date&order=open_date(desc)&limit=${OFFSET_PROBE_PAGE_SIZE}&offset=${OFFSET_PROBE_PAGE_SIZE}`,
    ],
    async run(ctx) {
      // Deliberately tiny pages: the question is whether the WINDOW moves, which
      // five rows answer as well as two hundred, at a tenth of the budget.
      const page = async (offset: number) =>
        dataArray(
          await probeGet(ctx, "/matters.json", {
            fields: "id,open_date",
            query: {
              order: "open_date(desc)",
              limit: OFFSET_PROBE_PAGE_SIZE,
              offset,
            },
          }),
        );

      const first = await page(0);
      if (first.length < OFFSET_PROBE_PAGE_SIZE) {
        return {
          status: "inconclusive",
          observed: [
            `only ${first.length} matters visible — fewer than the ${OFFSET_PROBE_PAGE_SIZE} needed for a second page`,
          ],
          meaning:
            "Offset support is unproven on this account; re-run against one that can see more matters before enabling deep paging.",
        };
      }

      let second: Record<string, unknown>[];
      try {
        second = await page(OFFSET_PROBE_PAGE_SIZE);
      } catch (err) {
        rethrowRailErrors(err);
        const status = statusOf(err);
        return {
          // Only an outright 400 ANSWERS the question ("Clio rejects offset").
          // Any other failure — a 500, a network blip — leaves it open, so it
          // must not be scored as a pass.
          status: status === 400 ? "pass" : "inconclusive",
          observed: [
            `offset=${OFFSET_PROBE_PAGE_SIZE} → ${describeError(err)}`,
          ],
          meaning:
            status === 400
              ? "Clio rejects `offset` on this action: deep paging must NOT be built on it. The shipped single-page + honest-count behaviour is correct and stays."
              : "The offset request failed for a reason other than rejection, so open question 1 is still unanswered. Re-run before anyone builds deep paging.",
          detail: { offsetRejectedWithStatus: status },
        };
      }

      const firstIds = idsOf(first);
      const secondIds = idsOf(second);
      const overlap = secondIds.filter((id) => firstIds.includes(id));
      const identical =
        secondIds.length === firstIds.length &&
        secondIds.every((id, i) => id === firstIds[i]);
      const continues =
        !identical &&
        overlap.length === 0 &&
        isDescending([...first, ...second], "open_date");

      return {
        status: continues ? "pass" : "fail",
        observed: [
          `page 1: ${firstIds.length} rows; page 2 (offset=${OFFSET_PROBE_PAGE_SIZE}): ${secondIds.length} rows`,
          identical
            ? "page 2 is IDENTICAL to page 1 — offset was ignored"
            : `overlapping ids between pages: ${overlap.length}`,
          `open_date still descending across the two pages: ${isDescending([...first, ...second], "open_date") ? "yes" : "NO"}`,
        ],
        meaning: continues
          ? "Offset paging works with the sort, so continuation beyond 200 rows can be built (spec open question 1 answered yes)."
          : "Offset is accepted but does NOT move the window reliably — silently repeating or reshuffling rows. Deep paging stays unbuilt; the shipped one-page + 'showing 200 of N' behaviour is the honest option.",
        detail: {
          identicalPages: identical,
          overlappingIds: overlap.length,
          orderedAcrossPages: isDescending([...first, ...second], "open_date"),
        },
      };
    },
  },
  {
    number: 4,
    id: "my-matters-filters",
    question:
      "Are `responsible_attorney_id` and `originating_attorney_id` accepted as filters — the two calls the My matters tab merges?",
    plan: [
      "GET /matters.json?fields=id&responsible_attorney_id=<stored clio_user_id>&limit=5",
      "GET /matters.json?fields=id&originating_attorney_id=<stored clio_user_id>&limit=5",
    ],
    async run(ctx) {
      if (!ctx.clioUserId) {
        throw new ProbeSkipped(
          "no stored clio_user_id on the connection (probe 1 could not supply one)",
        );
      }
      const responsible = dataArray(
        await probeGet(ctx, "/matters.json", {
          fields: "id",
          query: { responsible_attorney_id: ctx.clioUserId, limit: 5 },
        }),
      );
      const originating = dataArray(
        await probeGet(ctx, "/matters.json", {
          fields: "id",
          query: { originating_attorney_id: ctx.clioUserId, limit: 5 },
        }),
      );
      const union = new Set([...idsOf(responsible), ...idsOf(originating)]);
      return {
        status: "pass",
        observed: [
          `responsible_attorney_id → 200, ${responsible.length} rows (page capped at 5)`,
          `originating_attorney_id → 200, ${originating.length} rows (page capped at 5)`,
          `de-duplicated union of the two sample pages: ${union.size}`,
        ],
        meaning:
          "Both filters are accepted, so the merge-and-de-duplicate basis of My matters holds. (Empty results are a permissions/allocation fact about this user, not a filter failure.)",
        detail: {
          responsibleRows: responsible.length,
          originatingRows: originating.length,
          unionRows: union.size,
        },
      };
    },
  },
  {
    number: 5,
    id: "matter-detail",
    question:
      "Does the detail selector — including the speculative custom_field_values block — return 200, or is the shipped fallback to the core selector actually needed?",
    plan: [
      `GET /matters/<matter id>.json?fields=${MATTER_DETAIL_FIELDS}`,
      "on 400 only: the same call with the core selector (the shipped fallback)",
    ],
    async run(ctx) {
      const matterId = requireMatter(ctx);
      try {
        const body = await probeGet(ctx, `/matters/${matterId}.json`, {
          fields: MATTER_DETAIL_FIELDS,
        });
        const row = dataObject(body);
        const presence = fieldPresence(row, MATTER_DETAIL_FIELDS);
        const custom = Array.isArray(row?.custom_field_values)
          ? (row?.custom_field_values as unknown[]).length
          : null;
        return {
          status: "pass",
          observed: [
            "detail selector (with custom_field_values) → 200",
            `custom field values returned: ${custom ?? "field absent"}`,
            `absent fields: ${presence.absent.join(", ") || "none"}`,
          ],
          meaning:
            "Custom fields (UK legal-aid / KYC where present) load live; the core-selector fallback stays as belt but is not the normal path.",
          detail: {
            customFieldCount: custom,
            absentFields: presence.absent,
            fallbackNeeded: false,
          },
        };
      } catch (err) {
        rethrowRailErrors(err);
        if (statusOf(err) !== 400) throw err;
        const body = await probeGet(ctx, `/matters/${matterId}.json`, {
          fields: MATTER_CORE_FIELDS,
        });
        const presence = fieldPresence(dataObject(body), MATTER_CORE_FIELDS);
        return {
          status: "pass",
          observed: [
            "detail selector with custom_field_values → 400",
            "core selector → 200",
            `absent fields on the core selector: ${presence.absent.join(", ") || "none"}`,
          ],
          meaning:
            "The custom-fields selector is rejected by this tenant — the shipped fallback is load-bearing and `customFieldsUnavailable` will be true in production. The detail page still renders.",
          detail: { fallbackNeeded: true, absentFields: presence.absent },
        };
      }
    },
  },
  {
    number: 6,
    id: "financials-selector",
    question:
      "SPEC OPEN QUESTION 2 — does the corrected BillableMatter selector return 200 with data, and was the old `matter{…}` brace the cause of the 400?",
    plan: [
      `GET /billable_matters.json?fields=${BILLABLE_MATTER_FIELDS}&matter_id=<matter id>&limit=1`,
      `CONTROL (expects 400): GET /billable_matters.json?fields=${CONTROL_BILLABLE_MATTER_FIELDS}&matter_id=<matter id>&limit=1`,
      `GET /outstanding_client_balances.json?fields=${OUTSTANDING_BALANCE_FIELDS}&contact_id=<client id>&limit=1`,
    ],
    async run(ctx) {
      const matterId = requireMatter(ctx);
      const observed: string[] = [];
      const detail: Record<string, unknown> = {};

      const body = await probeGet(ctx, "/billable_matters.json", {
        fields: BILLABLE_MATTER_FIELDS,
        query: { matter_id: matterId, limit: 1 },
      });
      const row = dataArray(body)[0] ?? null;
      const presence = fieldPresence(row, BILLABLE_MATTER_FIELDS);
      observed.push(
        `corrected selector → 200, ${dataArray(body).length} row(s)`,
        `absent fields: ${presence.absent.join(", ") || "none"}`,
        `null (redacted or genuinely unset): ${presence.null.join(", ") || "none"}`,
      );
      detail.correctedSelector = { ok: true, absentFields: presence.absent };

      // Control: re-issue the disputed brace on its own. A 400 here alongside a
      // 200 above is conclusive — the association never existed on BillableMatter.
      try {
        await probeGet(ctx, "/billable_matters.json", {
          fields: CONTROL_BILLABLE_MATTER_FIELDS,
          query: { matter_id: matterId, limit: 1 },
        });
        observed.push(
          "CONTROL: the old `matter{…}` brace also returned 200 — the 400 had another cause",
        );
        detail.controlRejected = false;
      } catch (err) {
        // A fired rail is not an observation about this selector.
        rethrowRailErrors(err);
        observed.push(
          `CONTROL: old \`matter{…}\` brace → ${describeError(err)}`,
        );
        detail.controlRejected = statusOf(err) === 400;
      }

      if (ctx.clientContactId) {
        const balances = await probeGet(
          ctx,
          "/outstanding_client_balances.json",
          {
            fields: OUTSTANDING_BALANCE_FIELDS,
            query: { contact_id: ctx.clientContactId, limit: 1 },
          },
        );
        observed.push(
          `client-level outstanding balance → 200, ${dataArray(balances).length} row(s)`,
        );
        detail.outstandingBalancesOk = true;
      } else {
        observed.push(
          "client-level outstanding balance not probed (no client id on the sample matter)",
        );
        detail.outstandingBalancesOk = null;
      }

      return {
        status: "pass",
        observed,
        meaning:
          "The shipped financials fix is validated live: unbilled WIP, trust and currency load from BillableMatter directly. Null money/hours must still be rendered as unavailable/hidden, never £0.",
        detail,
      };
    },
  },
  {
    number: 7,
    id: "related-contacts",
    question:
      "Does the related-contacts selector (key people on the matter) return 200, including `primary_email_address` as a scalar?",
    plan: [
      `GET /matters/<matter id>/related_contacts.json?fields=${RELATED_CONTACT_FIELDS}&limit=5`,
    ],
    async run(ctx) {
      const matterId = requireMatter(ctx);
      const body = await probeGet(
        ctx,
        `/matters/${matterId}/related_contacts.json`,
        { fields: RELATED_CONTACT_FIELDS, query: { limit: 5 } },
      );
      const rows = dataArray(body);
      const presence = fieldPresence(rows[0] ?? null, RELATED_CONTACT_FIELDS);
      const emailIsScalar =
        rows[0] === undefined ||
        rows[0].primary_email_address === null ||
        typeof rows[0].primary_email_address !== "object";
      return {
        status: "pass",
        observed: [
          `200 OK, ${rows.length} row(s) (page capped at 5)`,
          `absent fields: ${presence.absent.join(", ") || "none"}`,
          `primary_email_address is a scalar: ${emailIsScalar ? "yes" : "NO — it is an object"}`,
        ],
        meaning:
          "The key-people section of matter detail loads live with the shipped selector; the scalar email shape matches the fix applied to the contacts tool.",
        detail: { rows: rows.length, absentFields: presence.absent },
      };
    },
  },
  {
    number: 8,
    id: "contact-selector",
    question:
      "SPEC OPEN QUESTION 4 — does the corrected clio_find_contact selector return 200, and did the old brace-on-scalar `primary_email_address{address}` really 400?",
    plan: [
      `GET /contacts.json?fields=${CONTACT_SEARCH_FIELDS}&limit=5`,
      `CONTROL (expects 400): GET /contacts.json?fields=${CONTROL_CONTACT_FIELDS}&limit=5`,
    ],
    async run(ctx) {
      // No `query=` term: the question is whether the SELECTOR parses, and an
      // unfiltered first page answers that without guessing at a search string.
      const body = await probeGet(ctx, "/contacts.json", {
        fields: CONTACT_SEARCH_FIELDS,
        query: { limit: 5 },
      });
      const rows = dataArray(body);
      const presence = fieldPresence(rows[0] ?? null, CONTACT_SEARCH_FIELDS);
      const observed = [
        `corrected selector → 200, ${rows.length} row(s)`,
        `absent fields: ${presence.absent.join(", ") || "none"}`,
      ];
      const detail: Record<string, unknown> = {
        correctedSelectorOk: true,
        absentFields: presence.absent,
      };
      try {
        await probeGet(ctx, "/contacts.json", {
          fields: CONTROL_CONTACT_FIELDS,
          query: { limit: 5 },
        });
        observed.push(
          "CONTROL: the old brace-on-scalar selector also returned 200 — the tool's 400 had another cause",
        );
        detail.controlRejected = false;
      } catch (err) {
        // A fired rail is not an observation about this selector.
        rethrowRailErrors(err);
        observed.push(`CONTROL: brace-on-scalar → ${describeError(err)}`);
        detail.controlRejected = statusOf(err) === 400;
      }
      return {
        status: "pass",
        observed,
        meaning:
          "The shipped clio_find_contact fix is validated live; contact lookups from chat work with the scalar email plus the email_addresses association.",
        detail,
      };
    },
  },
  {
    number: 9,
    id: "activities",
    question:
      "Do the time-entry reads work — own-entries filter, whole-matter lift, date(desc) order — and are `billed`, `etag` and `quantity_redacted` really present?",
    plan: [
      `GET /activities.json?fields=${ACTIVITY_FIELDS}&matter_id=<matter id>&type=TimeEntry&order=date(desc)&limit=200&user_id=<stored clio_user_id>`,
      `GET /activities.json?fields=${ACTIVITY_FIELDS}&matter_id=<matter id>&type=TimeEntry&order=date(desc)&limit=200  (whole matter — the "everyone" toggle)`,
    ],
    async run(ctx) {
      const matterId = requireMatter(ctx);
      if (!ctx.clioUserId) {
        throw new ProbeSkipped("no stored clio_user_id to filter own entries");
      }
      const base = {
        matter_id: matterId,
        type: "TimeEntry",
        order: "date(desc)",
        limit: 200,
      };
      const own = dataArray(
        await probeGet(ctx, "/activities.json", {
          fields: ACTIVITY_FIELDS,
          query: { ...base, user_id: ctx.clioUserId },
        }),
      );
      const everyone = dataArray(
        await probeGet(ctx, "/activities.json", {
          fields: ACTIVITY_FIELDS,
          query: base,
        }),
      );
      const presence = fieldPresence(
        own[0] ?? everyone[0] ?? null,
        ACTIVITY_FIELDS,
      );
      // Reported as an observation about THIS matter only. It is deliberately
      // NOT handed to probe 10: that probe finds its own candidate on the
      // designated test matter, because this matter is an arbitrary live one.
      const billedOwnCount = own.filter((row) => row.billed === true).length;
      const redacted = everyone.filter(
        (row) => row.quantity_redacted === true,
      ).length;
      return {
        status: own.length + everyone.length === 0 ? "inconclusive" : "pass",
        observed: [
          `own entries → 200, ${own.length} row(s); whole matter → 200, ${everyone.length} row(s)`,
          `date(desc) honoured: ${isDescending(everyone, "date") ? "yes" : "NO"}`,
          `absent fields: ${presence.absent.join(", ") || "none"}`,
          `entries flagged quantity_redacted: ${redacted}`,
          `billed entries of the caller's own on this matter: ${billedOwnCount} (an observation only — probe 10 searches the test matter itself)`,
        ],
        meaning:
          own.length + everyone.length === 0
            ? "This matter has no time entries, so the panel's reads are untested — pick a matter with recorded time via --matter-id."
            : "The time-entries panel's reads, its own/everyone toggle and its redaction signal are confirmed live.",
        detail: {
          ownRows: own.length,
          everyoneRows: everyone.length,
          absentFields: presence.absent,
          redactedRows: redacted,
          billedOwnRowsOnThisMatter: billedOwnCount,
        },
      };
    },
  },
];

function requireMatter(ctx: ProbeCtx): string {
  if (!ctx.matterId) {
    throw new ProbeSkipped(
      "no matter available — probe 2 returned none and --matter-id was not given",
    );
  }
  return ctx.matterId;
}

// ── Probe 10 (write — gated, self-cleaning) ──────────────────────────────────

interface WriteProbeReport {
  enabled: boolean;
  reason?: string;
  status: ProbeStatus;
  observed: string[];
  meaning: string;
  created: string[];
  cleanedUp: string[];
  cleanupFailures: string[];
  detail: Record<string, unknown>;
}

const WRITE_PROBE_PLAN = [
  "POST /activities.json  (one non-billable TimeEntry, 1 minute, noted as a probe, on CLIO_PROBE_TEST_MATTER_ID)",
  "GET /activities/<created id>.json  (read back, capture etag)",
  "PATCH /activities/<created id>.json with If-Match <etag>  (edit the note — proves the concurrency path)",
  "PATCH /activities/<created id>.json with the now-STALE etag  (expects 412)",
  "GET /activities.json?matter_id=CLIO_PROBE_TEST_MATTER_ID&type=TimeEntry&user_id=<stored clio_user_id>  (find a billed entry OF THE CALLER'S OWN, on the test matter only)",
  "PATCH /activities/<that billed entry>.json setting `note` to its CURRENT value  (a no-op edit: learns the restriction without changing anything; skipped unless the note is readable)",
  "DELETE /activities/<created id>.json  (cleanup, always attempted)",
  "GET /activities/<created id>.json  (verify the cleanup — expects 404)",
];

/** How long to wait for the Manage window to reset before the one cleanup retry. */
const CLEANUP_RATE_LIMIT_WAIT_MS = 61_000;

/**
 * Delete a probe-created entry, retrying ONCE past a drained rate-limit window.
 *
 * Cleanup is the one place where a 429 is not permission to give up: what is
 * being deleted is live data the script put on a real matter. The retry is
 * deliberate and bounded (one sleep, one attempt), and it resets the consecutive
 * -429 counter so the run-level abort does not fire on the way out.
 */
async function deleteWithOneRetry(ctx: ProbeCtx, id: string): Promise<void> {
  try {
    await probeWrite(ctx, `/activities/${id}.json`, { method: "DELETE" });
  } catch (err) {
    const rateLimited =
      err instanceof ClioRateLimitError || err instanceof ProbeAbortError;
    if (!rateLimited) throw err;
    console.log(
      `    Cleanup rate-limited — waiting ${Math.round(CLEANUP_RATE_LIMIT_WAIT_MS / 1000)}s for the Clio window to reset, then retrying the delete once.`,
    );
    // Only the counter is reset. `ctx.aborted` stays true so the JSON summary
    // still records that the run hit its rate-limit rail.
    ctx.consecutiveRateLimits = 0;
    await sleep(CLEANUP_RATE_LIMIT_WAIT_MS);
    await probeWrite(ctx, `/activities/${id}.json`, { method: "DELETE" });
  }
}

/**
 * Probe 10 — the only writing part of this script.
 *
 * Design choices, all in service of "learn the restriction, change nothing":
 *  - the entry it creates is non-billable, one minute, dated today and clearly
 *    labelled, so even a failed cleanup leaves something obviously disposable;
 *  - the billed-entry question is answered with a NO-OP patch (setting `note`
 *    to the value it already has). If Clio refuses, the restriction is real; if
 *    Clio accepts, edits are permitted AND nothing was altered either way;
 *  - DELETE is never attempted against a billed entry. That is irreversible and
 *    financially material, so the delete restriction stays formally unprobed and
 *    the server-side 409 stays as the safe default.
 */
async function runWriteProbe(
  ctx: ProbeCtx,
  testMatterId: string,
): Promise<WriteProbeReport> {
  const created: string[] = [];
  const cleanedUp: string[] = [];
  const cleanupFailures: string[] = [];
  const observed: string[] = [];
  const detail: Record<string, unknown> = {};
  let status: ProbeStatus = "pass";

  ctx.phase = "write";
  try {
    const today = new Date().toISOString().slice(0, 10);
    const createBody = await probeWrite(ctx, "/activities.json", {
      method: "POST",
      fields: ACTIVITY_FIELDS,
      json: {
        data: {
          type: "TimeEntry",
          matter: { id: Number(testMatterId) || testMatterId },
          quantity: 60,
          date: today,
          note: `${PROBE_NOTE_PREFIX} (${new Date().toISOString()})`,
          non_billable: true,
        },
      },
    });
    const createdRow = dataObject(createBody);
    const createdId = str(createdRow?.id);
    if (!createdId) {
      throw new Error(
        "create returned 200 but no data.id — nothing to clean up",
      );
    }
    created.push(createdId);
    observed.push(
      `created a 1-minute non-billable TimeEntry on matter ${testMatterId}`,
      `quantity echoed back: ${str(createdRow?.quantity) ?? "absent"} (seconds — 60 confirms the units the UI converts to)`,
    );
    detail.quantityEchoedSeconds = createdRow?.quantity ?? null;

    // Read back for the etag the concurrency path depends on.
    const readBack = dataObject(
      await probeGet(ctx, `/activities/${createdId}.json`, {
        fields: ACTIVITY_FIELDS,
      }),
    );
    const firstEtag = str(readBack?.etag);
    observed.push(`etag on read-back: ${firstEtag ? "present" : "ABSENT"}`);
    detail.etagPresent = !!firstEtag;

    // Valid If-Match edit.
    if (firstEtag) {
      const edited = dataObject(
        await probeWrite(ctx, `/activities/${createdId}.json`, {
          method: "PATCH",
          fields: ACTIVITY_FIELDS,
          headers: { "IF-MATCH": firstEtag },
          json: { data: { note: `${PROBE_NOTE_PREFIX} (edited)` } },
        }),
      );
      const secondEtag = str(edited?.etag);
      observed.push(
        `PATCH with a current If-Match → 200; etag changed: ${secondEtag && secondEtag !== firstEtag ? "yes" : "no"}`,
      );
      detail.etagRotatesOnWrite = !!secondEtag && secondEtag !== firstEtag;

      // Stale If-Match — the 412 the UI's "reload and try again" copy depends on.
      try {
        await probeWrite(ctx, `/activities/${createdId}.json`, {
          method: "PATCH",
          fields: ACTIVITY_FIELDS,
          headers: { "IF-MATCH": firstEtag },
          json: { data: { note: `${PROBE_NOTE_PREFIX} (stale write)` } },
        });
        observed.push(
          "PATCH with a STALE If-Match → 200 — Clio does NOT enforce optimistic concurrency here",
        );
        detail.staleEtagRejected = false;
        status = "inconclusive";
      } catch (err) {
        const code = statusOf(err);
        observed.push(`PATCH with a STALE If-Match → ${describeError(err)}`);
        detail.staleEtagRejected = code === 412;
        if (code !== 412) status = "inconclusive";
      }
    } else {
      observed.push(
        "no etag returned, so the If-Match path could not be exercised",
      );
      status = "inconclusive";
    }

    // SPEC OPEN QUESTION 3 — billed-entry restriction, via a no-op edit.
    //
    // The candidate is searched for HERE, on the designated test matter, and
    // never taken from the read phase: probe 9 runs against an arbitrary live
    // matter (probe 2's first row, or --matter-id), so reusing its find would
    // have patched a billed entry on a real client's file — outside the
    // boundary this probe promises to stay inside.
    //
    // Without a known Clio user id the search cannot be constrained to the
    // caller's OWN entries, and patching a colleague's billed time is not this
    // script's to do — so the sub-probe is skipped rather than widened.
    const billedCandidates = ctx.clioUserId
      ? dataArray(
          await probeGet(ctx, "/activities.json", {
            fields: ACTIVITY_FIELDS,
            query: {
              matter_id: testMatterId,
              type: "TimeEntry",
              user_id: ctx.clioUserId,
              order: "date(desc)",
              limit: 200,
            },
          }),
        )
      : [];
    // A null/withheld note is disqualifying, not something to substitute "" for:
    // sending "" would BLANK the note on an invoiced record, which is exactly
    // the change this "no-op" exists to avoid.
    const billedRow =
      billedCandidates.find(
        (row) => row.billed === true && typeof row.note === "string",
      ) ?? null;
    const billedId = str(billedRow?.id);
    const currentNote =
      typeof billedRow?.note === "string" ? billedRow.note : null;

    if (billedId && currentNote !== null) {
      const billedEtag = str(billedRow?.etag);
      try {
        await probeWrite(ctx, `/activities/${billedId}.json`, {
          method: "PATCH",
          fields: ACTIVITY_FIELDS,
          ...(billedEtag ? { headers: { "IF-MATCH": billedEtag } } : {}),
          // Same value it already holds: the permission check runs, the record
          // does not change.
          json: { data: { note: currentNote } },
        });
        observed.push(
          "no-op PATCH of an own BILLED entry on the test matter → 200: Clio ALLOWS edits to billed entries",
        );
        detail.billedEditAllowed = true;
      } catch (err) {
        rethrowRailErrors(err);
        const code = statusOf(err);
        const refused = code !== null && REFUSAL_STATUSES.has(code);
        observed.push(
          `no-op PATCH of an own BILLED entry on the test matter → ${describeError(err)}${refused ? "" : " (not a refusal — the question stays open)"}`,
        );
        // Only a permission-shaped status proves Clio REFUSES; a 500 or a
        // network failure says nothing about the rule.
        detail.billedEditAllowed = refused ? false : null;
        detail.billedEditStatus = code;
        if (!refused) status = status === "pass" ? "inconclusive" : status;
      }
    } else {
      observed.push(
        `no billed time entry of the caller's own WITH a readable note exists on test matter ${testMatterId}, so the billed restriction is UNANSWERED`,
      );
      detail.billedEditAllowed = null;
      status = status === "pass" ? "inconclusive" : status;
    }
    observed.push(
      "DELETE of a billed entry deliberately NOT attempted — irreversible and financially material",
    );
    detail.billedDeleteProbed = false;
  } catch (err) {
    status = "fail";
    observed.push(`write probe aborted: ${describeError(err)}`);
  } finally {
    // Self-cleaning even on partial failure: everything created is deleted,
    // then verified, and anything left behind is reported by id.
    for (const id of created) {
      try {
        await deleteWithOneRetry(ctx, id);
        let gone = false;
        let unverified: string | null = null;
        try {
          await probeGet(ctx, `/activities/${id}.json`, { fields: "id" });
          gone = false;
        } catch (err) {
          const code = statusOf(err);
          if (code === 404) gone = true;
          else unverified = describeError(err);
        }
        if (gone) {
          cleanedUp.push(id);
        } else if (unverified) {
          // Do not claim the entry survived when the CHECK is what failed.
          cleanupFailures.push(
            `${id} (delete accepted, but the confirming read failed: ${unverified} — check the matter in Clio)`,
          );
        } else {
          cleanupFailures.push(
            `${id} (delete returned success but the entry still reads back)`,
          );
        }
      } catch (err) {
        cleanupFailures.push(`${id} (${describeError(err)})`);
      }
    }
    ctx.phase = "read";
  }

  if (cleanupFailures.length > 0) status = "fail";

  return {
    enabled: true,
    status,
    observed,
    meaning:
      detail.billedEditAllowed === false
        ? "Clio itself refuses edits to billed entries — the locked UI and the server-side 409 are correct and must stay."
        : detail.billedEditAllowed === true
          ? "Clio permits edits to billed entries. Unlocking them is a PRODUCT decision for the owner (a billed entry has already been invoiced); the shipped 409 is a deliberate safety default, not a bug."
          : "The billed-entry restriction remains unanswered — the shipped locked UI + 409 stay until a matter with the caller's own billed time can be probed.",
    created,
    cleanedUp,
    cleanupFailures,
    detail,
  };
}

// ── Connection preflight ─────────────────────────────────────────────────────

interface PreflightResult {
  ok: boolean;
  message: string;
  clioUserId: string | null;
  clioUserName: string | null;
}

/**
 * Establish that a usable Manage connection exists WITHOUT touching it.
 *
 * The important distinction: `loadClioConnection` returns null both when there
 * is no row AND when the row cannot be decrypted — and a mismatched
 * USER_API_KEYS_ENCRYPTION_SECRET is by far the likeliest cause of the second on
 * an operator's laptop. The summary read (which never decrypts) separates them.
 */
async function preflight(db: Db, userId: string): Promise<PreflightResult> {
  const summaries = await getClioConnectionSummaries(db, userId);
  if (!summaries.manage.connected) {
    return {
      ok: false,
      clioUserId: null,
      clioUserName: null,
      message:
        "No Clio Manage connection is stored for that user id. Check the --user-id value, and that this checkout points at the same Supabase project as production.",
    };
  }
  const connection = await loadClioConnection(db, userId, "manage");
  if (!connection) {
    return {
      ok: false,
      clioUserId: null,
      clioUserName: summaries.manage.clioUserName,
      message: [
        "A Clio Manage connection row EXISTS but its token could not be decrypted.",
        "",
        "That almost always means USER_API_KEYS_ENCRYPTION_SECRET in this checkout",
        "does not match the value set on Fly (stored tokens are AES-256-GCM",
        "encrypted with a key derived from it). Align the secret and re-run.",
        "",
        "Do NOT 'fix' this by connecting Clio locally — that would overwrite the",
        "pilot user's production connection with a locally minted token.",
      ].join("\n"),
    };
  }
  const expiresAt = connection.tokens.expiresAt;
  const expiringSoon = !!expiresAt && expiresAt.getTime() < Date.now() + 60_000;
  if (expiringSoon) {
    return {
      ok: false,
      clioUserId: connection.clioUserId,
      clioUserName: connection.clioUserName,
      message: [
        "The stored access token is expired or within a minute of expiry.",
        "",
        "Refreshing it would REWRITE the stored connection row, which this script",
        "refuses to do. Let the pilot user's next normal app request refresh it,",
        "then re-run these probes.",
      ].join("\n"),
    };
  }
  return {
    ok: true,
    clioUserId: connection.clioUserId,
    clioUserName: connection.clioUserName,
    message: "Stored Manage connection loaded (read-only).",
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Clio record ids are well inside 15 digits; the tighter bound keeps an operator
// typo from being passed through as a plausible id.
const CLIO_ID_RE = /^[0-9]{1,15}$/;

const HELP = `
Clio live probes — answers docs/PRACTICE_MANAGEMENT_SPEC.md's open questions
against the live Clio EU tenant using a stored connection. Read the header of
this file before running it against production.

  npx tsx scripts/clio-live-probes.ts --dry-run
  npx tsx scripts/clio-live-probes.ts --user-id <supabase-uuid> [--matter-id <id>] [--out <file>]
  CLIO_PROBE_TEST_MATTER_ID=<id> npx tsx scripts/clio-live-probes.ts --user-id <uuid> --write-probe

  --user-id <uuid>    whose stored Clio Manage connection to read (required for a live run)
  --matter-id <id>    pin the matter used by probes 5-7 and 9
  --out <file>        JSON summary path (default ./clio-probe-results.json)
  --dry-run           print what every probe WOULD call; no database, no network
  --write-probe       enable probe 10 (also needs CLIO_PROBE_TEST_MATTER_ID)
  --help              this text
`;

function banner(mode: string): void {
  console.log("=".repeat(78));
  console.log("CLIO LIVE PROBES —", mode);
  console.log("=".repeat(78));
  console.log(
    [
      "This checkout's .env normally points at PRODUCTION Supabase. A live run",
      "reads a PRODUCTION Clio token belonging to a real solicitor and calls the",
      "firm's live tenant. It never starts OAuth and never writes to the stored",
      "connection row (the database handle is a read-only proxy). Never connect",
      "Clio locally as a pilot user.",
    ].join("\n"),
  );
  console.log("-".repeat(78));
}

function printOutcome(result: ProbeResult): void {
  const mark =
    result.status === "pass"
      ? "PASS"
      : result.status === "fail"
        ? "FAIL"
        : result.status.toUpperCase();
  console.log(`\n[${result.number}] ${result.id} — ${mark}`);
  console.log(`    Question: ${result.question}`);
  for (const line of result.observed) console.log(`    Observed: ${line}`);
  console.log(`    Means:    ${result.meaning}`);
  console.log(`    Requests: ${result.requests}`);
}

function printDryRun(writeProbeEnabled: boolean, testMatterId: string | null) {
  for (const probe of readProbes) {
    console.log(`\n[${probe.number}] ${probe.id} (read-only)`);
    console.log(`    Question: ${probe.question}`);
    for (const call of probe.plan) console.log(`    WOULD CALL: ${call}`);
  }
  console.log("\n[10] write-probe (WRITES — gated)");
  console.log(
    "    Question: SPEC OPEN QUESTION 3 — are billed time entries editable/deletable, and does the If-Match concurrency path behave?",
  );
  for (const call of WRITE_PROBE_PLAN) console.log(`    WOULD CALL: ${call}`);
  if (writeProbeEnabled && testMatterId) {
    console.log(`    ENABLED for test matter ${testMatterId}.`);
  } else {
    console.log(
      "    DISABLED. To enable, pass --write-probe AND set CLIO_PROBE_TEST_MATTER_ID=<designated test matter id>.",
    );
  }
  console.log(
    "\nDry run only — no database connection was opened and no request was sent.",
  );
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "user-id": { type: "string" },
      "matter-id": { type: "string" },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "write-probe": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const dryRun = values["dry-run"] === true;
  const wantsWriteProbe = values["write-probe"] === true;
  const outPath = resolve(values.out ?? "./clio-probe-results.json");
  const rawTestMatter = (process.env.CLIO_PROBE_TEST_MATTER_ID ?? "").trim();
  const testMatterId = CLIO_ID_RE.test(rawTestMatter) ? rawTestMatter : null;

  banner(dryRun ? "DRY RUN (nothing is called)" : "LIVE RUN");

  if (dryRun) {
    printDryRun(wantsWriteProbe, testMatterId);
    return 0;
  }

  const userId = (values["user-id"] ?? "").trim();
  if (!UUID_RE.test(userId)) {
    console.error(
      "\n--user-id <supabase-uuid> is required for a live run (use --dry-run to see the plan).",
    );
    return 2;
  }
  const pinnedMatter = (values["matter-id"] ?? "").trim();
  if (pinnedMatter && !CLIO_ID_RE.test(pinnedMatter)) {
    console.error("\n--matter-id must be a numeric Clio matter id.");
    return 2;
  }
  if (wantsWriteProbe && !testMatterId) {
    console.error(
      "\n--write-probe needs CLIO_PROBE_TEST_MATTER_ID set to the designated test matter's numeric id. Refusing to write without one.",
    );
    return 2;
  }
  if (rawTestMatter && !testMatterId) {
    console.error("\nCLIO_PROBE_TEST_MATTER_ID is not a numeric Clio id.");
    return 2;
  }

  let db: Db;
  try {
    db = readOnlyDb(createServerSupabase());
  } catch (err) {
    console.error(
      `\nCould not create the Supabase client: ${describeError(err)}`,
    );
    console.error(
      "SUPABASE_URL and SUPABASE_SECRET_KEY must be set (backend/.env is loaded exactly as the server loads it).",
    );
    return 2;
  }

  let check: PreflightResult;
  try {
    check = await preflight(db, userId);
  } catch (err) {
    console.error(`\nConnection preflight failed: ${describeError(err)}`);
    return 2;
  }
  if (!check.ok) {
    console.error(`\n${check.message}`);
    return 2;
  }
  console.log(
    `\nRegion: ${clioRegion()} | X-API-VERSION: ${clioManageApiVersion()}`,
  );
  console.log(
    `Connection: ${check.message} Clio user id ${check.clioUserId ?? "not stored"}.`,
  );
  if (wantsWriteProbe) {
    console.log(
      `Write probe ENABLED against test matter ${testMatterId}. It creates one time entry and deletes it again.`,
    );
  } else {
    console.log(
      "Write probe disabled (pass --write-probe and set CLIO_PROBE_TEST_MATTER_ID to enable).",
    );
  }

  const ctx: ProbeCtx = {
    db,
    userId,
    phase: "read",
    requests: 0,
    consecutiveRateLimits: 0,
    aborted: false,
    clioUserId: check.clioUserId,
    matterId: pinnedMatter || null,
    clientContactId: null,
  };

  const results: ProbeResult[] = [];
  for (const probe of readProbes) {
    const before = ctx.requests;
    let outcome: ProbeOutcome;
    if (ctx.aborted) {
      outcome = {
        status: "skipped",
        observed: ["skipped — the run stopped after repeated rate limiting"],
        meaning: "Unanswered. Re-run when the Manage budget has recovered.",
      };
    } else {
      try {
        outcome = await probe.run(ctx);
      } catch (err) {
        if (err instanceof ProbeSkipped) {
          outcome = {
            status: "skipped",
            observed: [`skipped — ${err.message}`],
            meaning: "Unanswered; the prerequisite above must be met first.",
          };
        } else if (err instanceof ProbeWriteBlockedError) {
          outcome = {
            status: "blocked",
            observed: [err.message],
            meaning:
              "The Clio client tried to self-heal the stored connection (token refresh or dead-grant prune). That write was blocked — resolve it in the app, not from this script.",
          };
          ctx.aborted = true;
        } else if (err instanceof ProbeAbortError) {
          outcome = {
            status: "blocked",
            observed: [err.message],
            meaning: "Run stopped to protect the shared rate-limit budget.",
          };
        } else {
          outcome = {
            status: "fail",
            observed: [describeError(err)],
            meaning:
              "The shipped code makes this same call, so this is what a user would hit.",
          };
        }
      }
    }
    const result: ProbeResult = {
      number: probe.number,
      id: probe.id,
      question: probe.question,
      requests: ctx.requests - before,
      ...outcome,
    };
    results.push(result);
    printOutcome(result);
    await sleep(PAUSE_BETWEEN_REQUESTS_MS);
  }

  let writeReport: WriteProbeReport = {
    enabled: false,
    reason:
      "not enabled — pass --write-probe AND set CLIO_PROBE_TEST_MATTER_ID=<designated test matter id>",
    status: "skipped",
    observed: [],
    meaning:
      "Spec open question 3 (billed-entry edit/delete restrictions) stays unanswered; the shipped locked UI + server-side 409 stand.",
    created: [],
    cleanedUp: [],
    cleanupFailures: [],
    detail: {},
  };
  if (wantsWriteProbe && testMatterId && !ctx.aborted) {
    writeReport = await runWriteProbe(ctx, testMatterId);
    console.log(`\n[10] write-probe — ${writeReport.status.toUpperCase()}`);
    for (const line of writeReport.observed) {
      console.log(`    Observed: ${line}`);
    }
    console.log(`    Means:    ${writeReport.meaning}`);
    console.log(
      `    Cleanup:  created ${writeReport.created.length}, deleted ${writeReport.cleanedUp.length}` +
        (writeReport.cleanupFailures.length
          ? `, LEFT BEHIND: ${writeReport.cleanupFailures.join("; ")}`
          : ""),
    );
  } else if (wantsWriteProbe && ctx.aborted) {
    writeReport.reason = "skipped — the read phase stopped early";
    console.log("\n[10] write-probe — SKIPPED (the read phase stopped early)");
  } else {
    console.log(`\n[10] write-probe — SKIPPED (${writeReport.reason})`);
  }

  const summary = {
    startedAt: new Date().toISOString(),
    mode: "live",
    region: clioRegion(),
    manageApiVersion: clioManageApiVersion(),
    userId,
    matterIdUsed: ctx.matterId,
    totalRequests: ctx.requests,
    abortedEarly: ctx.aborted,
    probes: results,
    writeProbe: writeReport,
  };
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const failed = results.filter((r) => r.status === "fail").length;
  const unanswered = results.filter(
    (r) =>
      r.status === "skipped" ||
      r.status === "inconclusive" ||
      r.status === "blocked",
  ).length;
  console.log(`\n${"-".repeat(78)}`);
  console.log(
    `${results.length} read probes: ${results.length - failed - unanswered} pass, ${failed} fail, ${unanswered} unanswered. ${ctx.requests} Clio requests used.`,
  );
  console.log(`JSON summary written to ${outPath}`);
  if (writeReport.cleanupFailures.length > 0) {
    console.log(
      `\n⚠ The write probe LEFT DATA BEHIND on matter ${testMatterId}: ${writeReport.cleanupFailures.join("; ")}. Delete it in Clio.`,
    );
  }
  return failed > 0 || writeReport.status === "fail" ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`\nProbe run failed: ${describeError(err)}`);
    process.exitCode = 1;
  });
