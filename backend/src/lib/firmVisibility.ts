import { createServerSupabase } from "./supabase";
import { getTombstonedIds } from "./deletionGovernance";
import { safeErrorLog } from "./safeError";

/**
 * Firm visibility (WS9). Self-contained seam for the "firm library": an owner
 * flips their own matter/standalone-review to `visibility='firm'` (stamping the
 * organisation_id), and every member of that firm can then read it through the
 * normal access paths. Admins can revert. All flips are audited best-effort.
 *
 * Stamping (rather than deriving) the organisation_id means an owner who later
 * changes firms cannot silently re-scope the library — see
 * docs/FIRM_LIBRARY_SPEC.md. Everything here is 42703/42P01-tolerant so it
 * degrades to a no-op ("unsupported") on a database where migration
 * 20260728_02 has not run.
 */

type Db = ReturnType<typeof createServerSupabase>;

export type FirmResourceType = "project" | "tabular_review";

export type FirmVisibility = "private" | "firm";

const RESOURCE_TABLE: Record<FirmResourceType, string> = {
    project: "projects",
    tabular_review: "tabular_reviews",
};

export function isFirmResourceType(value: string): value is FirmResourceType {
    return value === "project" || value === "tabular_review";
}

/** Validate a request-body visibility value. Returns null when invalid. */
export function parseFirmVisibility(value: unknown): FirmVisibility | null {
    return value === "private" || value === "firm" ? value : null;
}

// Postgres "undefined_column" / "undefined_table" — migration 20260728_02 has
// not run. Mirrors the deletionGovernance / organisations 42703 idiom.
function isMissingColumnOrTable(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code = (error as { code?: unknown }).code;
    return code === "42703" || code === "42P01";
}

export type FirmVisibilityOutcome = "updated" | "not_found" | "unsupported";

/**
 * Owner flip of a matter/standalone-review between 'private' and 'firm'.
 *
 * The owner guard AND the target are encoded in the UPDATE predicate itself
 * (`.eq("id", …).eq("user_id", ownerId)` + select-back; zero rows ⇒ not_found —
 * DURABLE_LESSONS: encode state transitions in the predicate), so a sharee or a
 * mere admin can never flip an item they do not own. Flipping to 'firm' stamps
 * the owner's organisation_id; reverting clears it. 42703/42P01 ⇒ "unsupported".
 */
export async function setResourceVisibility(
    db: Db,
    resourceType: FirmResourceType,
    id: string,
    ownerId: string,
    params: { visibility: FirmVisibility; organisationId: string | null },
): Promise<FirmVisibilityOutcome> {
    const table = RESOURCE_TABLE[resourceType];
    const organisationId =
        params.visibility === "firm" ? params.organisationId : null;
    const { data, error } = await (db as any)
        .from(table)
        .update({
            visibility: params.visibility,
            organisation_id: organisationId,
            updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("user_id", ownerId)
        .select("id");
    if (error) {
        if (isMissingColumnOrTable(error)) return "unsupported";
        throw error;
    }
    return ((data ?? []) as unknown[]).length > 0 ? "updated" : "not_found";
}

/**
 * Admin revert of a firm-visible item back to private. Scoped to the caller's
 * OWN firm and to a currently-firm-visible row, both encoded in the UPDATE
 * predicate (`.eq("id", …).eq("organisation_id", orgId).eq("visibility",
 * "firm")` + select-back). An item belonging to another firm yields zero rows ⇒
 * not_found, so an admin can never revert outside their own organisation.
 * 42703/42P01 ⇒ "unsupported".
 */
export async function adminRevertResource(
    db: Db,
    resourceType: FirmResourceType,
    id: string,
    organisationId: string,
): Promise<FirmVisibilityOutcome> {
    const table = RESOURCE_TABLE[resourceType];
    const { data, error } = await (db as any)
        .from(table)
        .update({
            visibility: "private",
            organisation_id: null,
            updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("organisation_id", organisationId)
        .eq("visibility", "firm")
        .select("id");
    if (error) {
        if (isMissingColumnOrTable(error)) return "unsupported";
        throw error;
    }
    return ((data ?? []) as unknown[]).length > 0 ? "updated" : "not_found";
}

export interface FirmLibraryItem {
    id: string;
    /** Matter name / review title. */
    name: string | null;
    ownerUserId: string | null;
    ownerDisplayName: string | null;
    updatedAt: string | null;
    /** True when the caller owns the item (still listed — it is in the library). */
    isOwner: boolean;
    documentCount: number;
    /** Projects only: chats + reviews under the matter. */
    chatCount?: number;
    reviewCount?: number;
}

export interface FirmLibrary {
    projects: FirmLibraryItem[];
    reviews: FirmLibraryItem[];
}

/**
 * List a firm's library: firm-visible matters + standalone firm-visible reviews
 * in the caller's organisation. Implemented by reusing the two overview RPCs
 * (which already encode the firm predicate via `p_user_org_id` and return names,
 * counts and the owner display name) filtered to `visibility='firm'`, rather
 * than re-deriving counts with direct queries — one code path, consistent with
 * the matters/reviews lists. Project-scoped reviews inherit their matter's
 * visibility (own `visibility` stays 'private') so they never appear here; they
 * are reached through their matter. Tombstoned rows are excluded. Orgless
 * callers get an empty library.
 *
 * NOTE the reviews overview RPC does not return an owner display name, so review
 * owners are enriched here with a single user_profiles lookup.
 */
export async function listFirmLibrary(
    db: Db,
    userId: string,
    userEmail: string | null | undefined,
    organisationId: string | null,
): Promise<FirmLibrary> {
    if (!organisationId) return { projects: [], reviews: [] };

    const [projectsRes, reviewsRes] = await Promise.all([
        db.rpc("get_projects_overview", {
            p_user_id: userId,
            p_user_email: userEmail ?? null,
            p_user_org_id: organisationId,
        }),
        db.rpc("get_tabular_reviews_overview", {
            p_user_id: userId,
            p_user_email: userEmail ?? null,
            p_project_id: null,
            p_user_org_id: organisationId,
        }),
    ]);

    if (projectsRes.error && !isMissingColumnOrTable(projectsRes.error)) {
        throw projectsRes.error;
    }
    if (reviewsRes.error && !isMissingColumnOrTable(reviewsRes.error)) {
        throw reviewsRes.error;
    }

    const projectRows = (
        (projectsRes.data ?? []) as Record<string, unknown>[]
    ).filter((row) => row.visibility === "firm");
    const reviewRows = (
        (reviewsRes.data ?? []) as Record<string, unknown>[]
    ).filter((row) => row.visibility === "firm");

    const [projectTombstoned, reviewTombstoned] = await Promise.all([
        getTombstonedIds(db, "project", {
            ids: projectRows
                .map((row) => row.id)
                .filter((id): id is string => typeof id === "string"),
        }),
        getTombstonedIds(db, "tabular-review", {
            ids: reviewRows
                .map((row) => row.id)
                .filter((id): id is string => typeof id === "string"),
        }),
    ]);

    const projects: FirmLibraryItem[] = projectRows
        .filter((row) => !projectTombstoned.has(row.id as string))
        .map((row) => ({
            id: row.id as string,
            name: (row.name as string | null) ?? null,
            ownerUserId: (row.user_id as string | null) ?? null,
            ownerDisplayName: (row.owner_display_name as string | null) ?? null,
            updatedAt: (row.updated_at as string | null) ?? null,
            isOwner: row.is_owner === true,
            documentCount:
                typeof row.document_count === "number"
                    ? row.document_count
                    : 0,
            chatCount:
                typeof row.chat_count === "number" ? row.chat_count : 0,
            reviewCount:
                typeof row.review_count === "number" ? row.review_count : 0,
        }));

    const reviews: FirmLibraryItem[] = reviewRows
        .filter((row) => !reviewTombstoned.has(row.id as string))
        .map((row) => ({
            id: row.id as string,
            name: (row.title as string | null) ?? null,
            ownerUserId: (row.user_id as string | null) ?? null,
            ownerDisplayName: null,
            updatedAt: (row.updated_at as string | null) ?? null,
            isOwner: row.is_owner === true,
            documentCount:
                typeof row.document_count === "number"
                    ? row.document_count
                    : 0,
        }));

    await enrichReviewOwnerNames(db, reviews);

    return { projects, reviews };
}

/**
 * Best-effort: fill in `ownerDisplayName` for review items from user_profiles.
 * A lookup failure leaves the names null rather than failing the whole list
 * (mirrors attachDocumentOwnerLabels in projects.ts).
 */
async function enrichReviewOwnerNames(
    db: Db,
    reviews: FirmLibraryItem[],
): Promise<void> {
    const ownerIds = [
        ...new Set(
            reviews
                .map((review) => review.ownerUserId)
                .filter((id): id is string => typeof id === "string"),
        ),
    ];
    if (ownerIds.length === 0) return;
    try {
        const { data, error } = await db
            .from("user_profiles")
            .select("user_id, display_name")
            .in("user_id", ownerIds);
        if (error) return;
        const nameByUserId = new Map<string, string>();
        for (const row of (data ?? []) as {
            user_id?: unknown;
            display_name?: unknown;
        }[]) {
            const uid = typeof row.user_id === "string" ? row.user_id : null;
            const name =
                typeof row.display_name === "string" &&
                row.display_name.trim()
                    ? row.display_name.trim()
                    : null;
            if (uid && name) nameByUserId.set(uid, name);
        }
        for (const review of reviews) {
            if (review.ownerUserId) {
                review.ownerDisplayName =
                    nameByUserId.get(review.ownerUserId) ?? null;
            }
        }
    } catch (err) {
        console.error("[firmVisibility] review owner enrichment failed", {
            error: safeErrorLog(err),
        });
    }
}
