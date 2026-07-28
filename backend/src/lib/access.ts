/**
 * Project / document access helpers.
 *
 * Sharing makes the previous "scope by user_id" pattern incorrect — a doc
 * can belong to user A's project that A has shared with B's email, and B
 * must still be able to read/edit it. These helpers centralize the
 * "owner OR shared project member" check so every route uses the same
 * logic instead of re-implementing the join.
 *
 * Returned `isOwner` lets callers gate operations that should stay
 * owner-only (delete, rename, member management).
 */

import type { createServerSupabase } from "./supabase";
import { getTombstonedIds } from "./deletionGovernance";
import { getUserOrganisationId } from "./organisations";

type Db = ReturnType<typeof createServerSupabase>;

export type ProjectAccess =
    | {
          ok: true;
          isOwner: boolean;
          project: {
              id: string;
              user_id: string;
              shared_with: string[] | null;
              visibility?: string | null;
              organisation_id?: string | null;
          };
      }
    | { ok: false };

// Postgres "undefined_column" / "undefined_table" — the firm-visibility columns
// (projects/tabular_reviews visibility + organisation_id) do not exist yet on an
// unmigrated database (migration 20260728_02). We degrade so the firm branch is
// silently absent rather than failing owner/sharee access. Mirrors the
// organisations / deletionGovernance 42703 idiom.
function isMissingFirmColumn(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code = (error as { code?: unknown }).code;
    return code === "42703" || code === "42P01";
}

/**
 * The caller's organisation id. `provided === undefined` means "not resolved by
 * the caller — look it up" (42703-tolerant ⇒ null); a supplied value (incl. an
 * explicit null for a known-orgless caller) is used as-is so a request that has
 * already resolved the org id can thread it through instead of re-querying.
 */
async function resolveCallerOrgId(
    db: Db,
    userId: string,
    provided: string | null | undefined,
): Promise<string | null> {
    if (provided !== undefined) return provided;
    return getUserOrganisationId(db, userId);
}

/**
 * Firm-visibility predicate, applied identically everywhere: an item is
 * firm-visible to the caller when it is stamped `visibility='firm'` AND its
 * `organisation_id` equals the caller's own organisation id. A null caller org
 * (orgless / unmigrated) never matches.
 */
function isFirmVisibleRow(
    row: { visibility?: string | null; organisation_id?: string | null },
    callerOrgId: string | null,
): boolean {
    return (
        !!callerOrgId &&
        row.visibility === "firm" &&
        !!row.organisation_id &&
        row.organisation_id === callerOrgId
    );
}

type ProjectAccessRow = {
    id: string;
    user_id: string;
    shared_with: string[] | null;
    visibility?: string | null;
    organisation_id?: string | null;
};

/**
 * Load the columns `checkProjectAccess` needs, tolerating an unmigrated database.
 * Tries the firm-visibility columns first; on a missing-column error falls back
 * to the legacy column set so owner/sharee access still resolves (the firm
 * branch is then simply unavailable). A not-found row yields null either way.
 */
async function loadProjectAccessRow(
    db: Db,
    projectId: string,
): Promise<ProjectAccessRow | null> {
    const withFirm = await db
        .from("projects")
        .select("id, user_id, shared_with, visibility, organisation_id")
        .eq("id", projectId)
        .single();
    if (withFirm.error && isMissingFirmColumn(withFirm.error)) {
        const legacy = await db
            .from("projects")
            .select("id, user_id, shared_with")
            .eq("id", projectId)
            .single();
        return (legacy.data as ProjectAccessRow | null) ?? null;
    }
    return (withFirm.data as ProjectAccessRow | null) ?? null;
}

export async function checkProjectAccess(
    projectId: string,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
    userOrgId?: string | null,
): Promise<ProjectAccess> {
    const proj = await loadProjectAccessRow(db, projectId);
    if (!proj) return { ok: false };
    // A tombstoned matter is not accessible to ANYONE — including the owner
    // (WS8×WS9): tombstoning sets only deleted_at, so without this a firm-visible
    // (or shared, or owned) soft-deleted matter would keep passing the branches
    // below for its whole retention window. Folding the guard into this choke
    // point makes every project sub-route (documents/chats/people/upload/…)
    // inherit the detail routes' existing 404 behaviour. 42703-tolerant (empty
    // set on an unmigrated DB). Owners manage tombstoned items only via the admin
    // Pending deletions surface, which reads the tables directly (not this path).
    const tombstoned = await getTombstonedIds(db, "project", { ids: [projectId] });
    if (tombstoned.has(projectId)) return { ok: false };
    if (proj.user_id === userId) {
        return { ok: true, isOwner: true, project: proj };
    }
    const sharedWith = Array.isArray(proj.shared_with) ? proj.shared_with : [];
    const email = (userEmail ?? "").toLowerCase();
    if (
        email &&
        sharedWith.some((e) => (e ?? "").toLowerCase() === email)
    ) {
        return { ok: true, isOwner: false, project: proj };
    }
    // Firm branch (WS9): a firm-visible matter is readable by any member of the
    // owner's organisation. Firm viewers are NOT owners. Resolved only after the
    // cheap owner/sharee checks miss (avoids an org lookup on the common path).
    const orgId = await resolveCallerOrgId(db, userId, userOrgId);
    if (isFirmVisibleRow(proj, orgId)) {
        return { ok: true, isOwner: false, project: proj };
    }
    return { ok: false };
}

/**
 * Check whether the current user can access a document the caller has
 * already loaded (saves a round-trip vs. having the helper re-fetch).
 * Owner-of-doc passes immediately; otherwise we fall through to a
 * project-membership check via `shared_with`.
 */
export async function ensureDocAccess(
    doc: { id?: string; user_id: string; project_id: string | null },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
    userOrgId?: string | null,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
    // A tombstoned single document is hidden immediately (WS8 PR G): fetch-by-id
    // routes return 404 so it cannot resurface while awaiting purge. Project
    // documents are never tombstoned in v1. 42703-tolerant (empty set on an
    // unmigrated DB) — see docs/DELETION_GOVERNANCE_SPEC.md.
    if (doc.id) {
        const tombstoned = await getTombstonedIds(db, "document", {
            ids: [doc.id],
        });
        if (tombstoned.has(doc.id)) return { ok: false };
    }
    // A document in a tombstoned parent matter is denied to EVERYONE — including
    // the document's owner (WS8×WS9). This must precede the owner short-circuit
    // below, or a doc owner (or a firm colleague who uploaded a doc into someone
    // else's now-tombstoned firm matter) could still GET/download it for the
    // whole retention window. Mirrors ensureReviewAccess (tombstone before owner).
    // Standalone docs (project_id null) are unaffected. 42703-tolerant.
    if (doc.project_id) {
        const parentTombstoned = await getTombstonedIds(db, "project", {
            ids: [doc.project_id],
        });
        if (parentTombstoned.has(doc.project_id)) return { ok: false };
    }
    if (doc.user_id === userId) return { ok: true, isOwner: true };
    if (!doc.project_id) return { ok: false };
    // A document in a firm-visible matter inherits that matter's access via
    // checkProjectAccess's firm branch (WS9).
    const access = await checkProjectAccess(
        doc.project_id,
        userId,
        userEmail,
        db,
        userOrgId,
    );
    if (access.ok) return { ok: true, isOwner: false };
    return { ok: false };
}

/**
 * Same shape as `ensureDocAccess`, for tabular_reviews. A review can be
 * shared in two ways:
 *   1. Indirectly — if `project_id` is set, everyone with project access
 *      can read/operate on it.
 *   2. Directly — `tabular_reviews.shared_with` is a per-review email list
 *      so standalone reviews (project_id null) can also be shared.
 * The owner (review.user_id) always has access.
 */
export async function ensureReviewAccess(
    review: {
        id?: string;
        user_id: string;
        project_id: string | null;
        shared_with?: string[] | null;
        visibility?: string | null;
        organisation_id?: string | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
    userOrgId?: string | null,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
    // A tombstoned review is not accessible to ANYONE — including the owner
    // (WS8×WS9): the review's write sub-routes (/generate, /chat, …) load the row
    // and call this helper but never re-checked the tombstone, so a soft-deleted
    // review stayed readable AND writable for its whole retention window. Fold the
    // guard in here (mirrors ensureDocAccess). A project-scoped review's PARENT
    // matter tombstone is covered separately by checkProjectAccess below.
    // 42703-tolerant. Callers pass a select("*") row so `id` is present.
    if (review.id) {
        const tombstoned = await getTombstonedIds(db, "tabular-review", {
            ids: [review.id],
        });
        if (tombstoned.has(review.id)) return { ok: false };
    }
    if (review.user_id === userId) return { ok: true, isOwner: true };
    const email = (userEmail ?? "").toLowerCase();
    if (email && Array.isArray(review.shared_with)) {
        if (review.shared_with.some((e) => (e ?? "").toLowerCase() === email)) {
            return { ok: true, isOwner: false };
        }
    }
    if (!review.project_id) {
        // Standalone review: it can be firm-visible in its own right (WS9). A
        // project-scoped review instead inherits its matter's visibility via the
        // checkProjectAccess firm branch below. The review object must carry
        // visibility/organisation_id for this branch to fire (absent ⇒ off).
        const orgId = await resolveCallerOrgId(db, userId, userOrgId);
        if (isFirmVisibleRow(review, orgId)) {
            return { ok: true, isOwner: false };
        }
        return { ok: false };
    }
    const access = await checkProjectAccess(
        review.project_id,
        userId,
        userEmail,
        db,
        userOrgId,
    );
    if (access.ok) return { ok: true, isOwner: false };
    return { ok: false };
}

/**
 * Filter user-supplied document IDs down to documents the caller can read.
 *
 * Tabular review routes accept document IDs from request bodies. Without this
 * check, a caller with access to any review could attach arbitrary document
 * UUIDs and later cause /generate or /regenerate-cell to extract those bytes.
 */
export async function filterAccessibleDocumentIds(
    documentIds: string[],
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
    userOrgId?: string | null,
): Promise<string[]> {
    if (documentIds.length === 0) return [];
    const { data: docs } = await db
        .from("documents")
        .select("id, user_id, project_id")
        .in("id", documentIds);
    const rows = (docs ?? []) as {
        id: string;
        user_id: string;
        project_id: string | null;
    }[];
    if (rows.length === 0) return [];

    // Tombstoned documents are hidden immediately (WS8 PR G): the single choke
    // point for every tabular doc-context path (create / update / generate /
    // regenerate cell) — a soft-deleted single document must not be extractable
    // into cells. 42703-tolerant. See docs/DELETION_GOVERNANCE_SPEC.md.
    const tombstoned = await getTombstonedIds(db, "document", {
        ids: documentIds,
    });

    // Documents in a firm-visible matter become attachable: listAccessibleProjectIds
    // includes firm-visible projects (WS9), so their documents pass the check below.
    const accessibleProjectIds = new Set(
        await listAccessibleProjectIds(userId, userEmail, db, userOrgId),
    );
    const allowed: string[] = [];
    for (const doc of rows) {
        if (tombstoned.has(doc.id)) continue;
        if (doc.user_id === userId) {
            allowed.push(doc.id);
        } else if (
            doc.project_id &&
            accessibleProjectIds.has(doc.project_id)
        ) {
            allowed.push(doc.id);
        }
    }
    return allowed;
}

/**
 * Returns the set of project IDs the user can access — own projects plus
 * any project where their email is in `shared_with`. Used to scope chat
 * lists and similar collection queries.
 */
export async function listAccessibleProjectIds(
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
    userOrgId?: string | null,
): Promise<string[]> {
    const orgId = await resolveCallerOrgId(db, userId, userOrgId);
    const [{ data: own }, { data: shared }, { data: firm }] = await Promise.all([
        db.from("projects").select("id").eq("user_id", userId),
        userEmail
            ? db
                  .from("projects")
                  .select("id")
                  .filter("shared_with", "cs", JSON.stringify([userEmail]))
                  .neq("user_id", userId)
            : Promise.resolve({ data: [] as { id: string }[] }),
        // Firm-visible matters in the caller's organisation (WS9). A missing
        // visibility/organisation_id column (unmigrated) errors the query → null
        // data → contributes nothing (branch silently absent).
        orgId
            ? db
                  .from("projects")
                  .select("id")
                  .eq("visibility", "firm")
                  .eq("organisation_id", orgId)
                  .neq("user_id", userId)
            : Promise.resolve({ data: [] as { id: string }[] }),
    ]);
    const ids = new Set<string>();
    for (const p of (own ?? []) as { id: string }[]) ids.add(p.id);
    for (const p of (shared ?? []) as { id: string }[]) ids.add(p.id);
    for (const p of (firm ?? []) as { id: string }[]) ids.add(p.id);
    return [...ids];
}
