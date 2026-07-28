// Company-search saves (starred + recent companies) — the self-contained seam
// behind the Company Search page's left rail. One per-user table
// (`company_search_saves`, migration 20260728_01), keyed
// unique(user_id, company_number).
//
// Every function is tolerant of an unmigrated production database: if the table
// or its columns do not exist yet (Postgres 42P01 / 42703), reads degrade to
// empty lists and writes to no-ops — the feature simply stays dormant until the
// owner runs the migration, and a missing table is NEVER an error to the user.
// (Mirrors the 42703 idiom in organisations.ts / middleware/auth.ts.)

import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

const TABLE = "company_search_saves";

// The most-recent non-starred rows kept per user; older ones are pruned on view.
export const RECENTS_CAP = 25;

/** A saved company as surfaced to the rail (camelCase, snapshot + flags). */
export interface CompanySave {
  companyNumber: string;
  companyName: string;
  companyStatus: string | null;
  starred: boolean;
  lastViewedAt: string | null;
}

/** Name/status snapshot captured when a company is viewed or starred. */
export interface CompanySnapshot {
  companyName: string;
  companyStatus?: string | null;
}

export interface CompanySavesList {
  /** Starred companies, ordered by company name (A→Z). */
  starred: CompanySave[];
  /** Non-starred recents, most-recently-viewed first, capped at RECENTS_CAP. */
  recents: CompanySave[];
}

// Row shape as stored.
type SaveRow = {
  company_number: string | null;
  company_name: string | null;
  company_status: string | null;
  starred: boolean | null;
  last_viewed_at: string | null;
};

/**
 * True for the two "unmigrated database" Postgres error codes we degrade on:
 * 42P01 (undefined_table) and 42703 (undefined_column). Any other error is a
 * genuine fault and propagates.
 */
function isMissingTableOrColumn(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "42P01" || code === "42703";
}

function toSave(row: SaveRow): CompanySave {
  return {
    companyNumber: row.company_number ?? "",
    companyName: row.company_name ?? "",
    companyStatus: row.company_status ?? null,
    starred: row.starred === true,
    lastViewedAt: row.last_viewed_at ?? null,
  };
}

const SELECT_COLUMNS =
  "company_number, company_name, company_status, starred, last_viewed_at";

/**
 * Record that a user viewed a company: upsert on (user_id, company_number),
 * bumping `last_viewed_at` and refreshing the name/status snapshot, WITHOUT
 * touching the `starred` flag or `created_at` (omitted from the payload, so an
 * existing star survives a re-view and the insert keeps its defaults). Then
 * prune: non-starred rows beyond the RECENTS_CAP most-recent for this user are
 * deleted (starred rows are never pruned).
 *
 * Best-effort: degrades to a no-op on an unmigrated database (42P01/42703).
 */
export async function recordCompanyView(
  db: Db,
  userId: string,
  company: {
    companyNumber: string;
    companyName: string;
    companyStatus?: string | null;
  },
): Promise<void> {
  const { error } = await db.from(TABLE).upsert(
    {
      user_id: userId,
      company_number: company.companyNumber,
      company_name: company.companyName,
      company_status: company.companyStatus ?? null,
      last_viewed_at: new Date().toISOString(),
    },
    { onConflict: "user_id,company_number" },
  );
  if (error) {
    if (isMissingTableOrColumn(error)) return;
    throw error;
  }

  await pruneRecents(db, userId);
}

/**
 * Delete this user's non-starred rows beyond the RECENTS_CAP most-recent.
 * Starred rows are excluded from the ordering entirely, so they are never
 * pruned however old their last view. Degrades to a no-op on an unmigrated DB.
 */
async function pruneRecents(db: Db, userId: string): Promise<void> {
  const { data, error } = await db
    .from(TABLE)
    .select("id, last_viewed_at")
    .eq("user_id", userId)
    .eq("starred", false)
    .order("last_viewed_at", { ascending: false });
  if (error) {
    if (isMissingTableOrColumn(error)) return;
    throw error;
  }

  const rows = (data ?? []) as { id: string }[];
  if (rows.length <= RECENTS_CAP) return;

  const staleIds = rows.slice(RECENTS_CAP).map((r) => r.id);
  const { error: deleteError } = await db
    .from(TABLE)
    .delete()
    .eq("user_id", userId)
    .in("id", staleIds);
  if (deleteError) {
    if (isMissingTableOrColumn(deleteError)) return;
    throw deleteError;
  }
}

/**
 * Set (or clear) a company's starred flag for a user. Starring a company not
 * yet in the table inserts it with the supplied snapshot (`company_name` is NOT
 * NULL, so a snapshot is required to create a row). When a snapshot is present
 * the write is an upsert that also refreshes the name/status; without one it can
 * only flip the flag on an existing row (a nameless insert is impossible), so an
 * unstar of a missing row is a safe no-op.
 *
 * Degrades to a no-op on an unmigrated database (42P01/42703).
 */
export async function setCompanyStar(
  db: Db,
  userId: string,
  companyNumber: string,
  starred: boolean,
  snapshot?: CompanySnapshot,
): Promise<void> {
  const name = snapshot?.companyName?.trim();

  if (name) {
    const { error } = await db.from(TABLE).upsert(
      {
        user_id: userId,
        company_number: companyNumber,
        company_name: name,
        company_status: snapshot?.companyStatus ?? null,
        starred,
      },
      { onConflict: "user_id,company_number" },
    );
    if (error) {
      if (isMissingTableOrColumn(error)) return;
      throw error;
    }
    return;
  }

  // No snapshot: flip the flag on an existing row only (NOT NULL name blocks a
  // bare insert). Missing row ⇒ nothing to update ⇒ no-op.
  const { error } = await db
    .from(TABLE)
    .update({ starred })
    .eq("user_id", userId)
    .eq("company_number", companyNumber);
  if (error) {
    if (isMissingTableOrColumn(error)) return;
    throw error;
  }
}

/**
 * List a user's saved companies: starred (ordered by company name, A→Z) and
 * recents (non-starred, most-recently-viewed first, capped at RECENTS_CAP).
 * Cross-user isolation is enforced by the `user_id` filter — never trust a
 * client-supplied id; callers pass the authenticated caller's id.
 *
 * Degrades to empty lists on an unmigrated database (42P01/42703).
 */
export async function listCompanySaves(
  db: Db,
  userId: string,
): Promise<CompanySavesList> {
  const empty: CompanySavesList = { starred: [], recents: [] };

  const starredResult = await db
    .from(TABLE)
    .select(SELECT_COLUMNS)
    .eq("user_id", userId)
    .eq("starred", true)
    .order("company_name", { ascending: true });
  if (starredResult.error) {
    if (isMissingTableOrColumn(starredResult.error)) return empty;
    throw starredResult.error;
  }

  const recentsResult = await db
    .from(TABLE)
    .select(SELECT_COLUMNS)
    .eq("user_id", userId)
    .eq("starred", false)
    .order("last_viewed_at", { ascending: false })
    .limit(RECENTS_CAP);
  if (recentsResult.error) {
    if (isMissingTableOrColumn(recentsResult.error)) return empty;
    throw recentsResult.error;
  }

  return {
    starred: ((starredResult.data ?? []) as SaveRow[]).map(toSave),
    recents: ((recentsResult.data ?? []) as SaveRow[]).map(toSave),
  };
}
