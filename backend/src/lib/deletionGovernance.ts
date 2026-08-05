import { createServerSupabase } from "./supabase";
import {
    resolveUserOrganisation,
    DEFAULT_RETENTION_DAYS,
} from "./organisations";
import { safeErrorLog } from "./safeError";
import {
    purgeProjectsByIds,
    purgeDocumentsByIds,
    purgeChatsByIds,
    purgeTabularReviewsByIds,
    purgeWorkflowsByIds,
} from "./userDataCleanup";

/**
 * Deletion governance (WS8 PR G). Self-contained seam (owner architectural rule
 * 22/07): firm members' destructive deletes become reversible tombstones
 * (deleted_at/deleted_by) held for the firm's retention window then hard-purged;
 * orgless self-hosters keep today's immediate hard delete. Everything here is
 * 42703/42P01-tolerant so it degrades to hard-delete/no-op if migration
 * 20260727_01 has not run. See docs/DELETION_GOVERNANCE_SPEC.md.
 */

type Db = ReturnType<typeof createServerSupabase>;

export type GovernedResourceType =
    | "project"
    | "document"
    | "chat"
    | "tabular-review"
    | "workflow";

export const GOVERNED_RESOURCE_TYPES: GovernedResourceType[] = [
    "project",
    "document",
    "chat",
    "tabular-review",
    "workflow",
];

const RESOURCE_TABLE: Record<GovernedResourceType, string> = {
    project: "projects",
    document: "documents",
    chat: "chats",
    "tabular-review": "tabular_reviews",
    workflow: "workflows",
};

// Cheapest display column per table (documents have none — enriched separately).
const DISPLAY_COLUMN: Partial<Record<GovernedResourceType, string>> = {
    project: "name",
    chat: "title",
    "tabular-review": "title",
    workflow: "title",
};

// Extra column that distinguishes sub-kinds sharing one table. `workflows`
// holds both prompt workflows and review templates (type='tabular'), and the
// admin Pending-deletions list must name each honestly.
const SUBTYPE_COLUMN: Partial<Record<GovernedResourceType, string>> = {
    workflow: "type",
};

export function resourceTypeToTable(value: string): string | null {
    return (RESOURCE_TABLE as Record<string, string>)[value] ?? null;
}

export function isGovernedResourceType(
    value: string,
): value is GovernedResourceType {
    return value in RESOURCE_TABLE;
}

export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 365;
export { DEFAULT_RETENTION_DAYS };

// Nil-uuid actor for system-driven audit rows (purge sweep). actor_user_id is a
// NOT NULL uuid; a sweep has no human actor.
const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse + clamp a retention value to [1, 365] whole days. Returns null when the
 * input is not a finite number (or numeric string) — the caller returns 400.
 */
export function clampRetentionDays(value: unknown): number | null {
    let n: number;
    if (typeof value === "number") n = value;
    else if (typeof value === "string" && value.trim() !== "") n = Number(value);
    else return null;
    if (!Number.isFinite(n)) return null;
    const int = Math.trunc(n);
    return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, int));
}

// Postgres "undefined_column" / "undefined_table" — the migration has not run.
function isMissingColumnOrTable(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code = (error as { code?: unknown }).code;
    return code === "42703" || code === "42P01";
}

// ── Decision ────────────────────────────────────────────────────────────────

export interface DeletionMode {
    /** true ⇒ tombstone (org member, OR fail-safe on a lookup error). */
    tombstone: boolean;
    /** The caller's firm id, or null (orgless, or fail-safe with unknown org). */
    organisationId: string | null;
}

/**
 * Decide whether a caller's destructive delete tombstones or hard-deletes.
 *
 * Org member → tombstone. Orgless → hard delete (unchanged). On ANY org-lookup
 * error this FAILS SAFE to tombstone (deliberate inversion of PR B's fail-open):
 * a tombstone is reversible, a hard delete is not, so a DB hiccup must never
 * destroy data. In the fail-safe case the org id is unknown, so audit is skipped
 * (best-effort). See docs/DELETION_GOVERNANCE_SPEC.md.
 */
export async function resolveDeletionMode(
    db: Db,
    userId: string,
): Promise<DeletionMode> {
    try {
        const membership = await resolveUserOrganisation(db, userId);
        if (membership) {
            return { tombstone: true, organisationId: membership.id };
        }
        return { tombstone: false, organisationId: null };
    } catch (err) {
        console.error(
            "[deletion] org lookup failed — failing SAFE to tombstone",
            { userId, error: safeErrorLog(err) },
        );
        return { tombstone: true, organisationId: null };
    }
}

// ── Tombstone (write) ─────────────────────────────────────────────────────────

export type TombstoneOutcome = "tombstoned" | "not_found" | "unsupported";

/**
 * Tombstone a single row. The state transition is encoded in the UPDATE
 * predicate (`.eq("id", …) [+ scope] .is("deleted_at", null)` + select-back;
 * zero rows ⇒ not_found), atomic against races/double-submits. `scope` adds the
 * ownership guard(s) the route already enforces (e.g. `{ user_id }`,
 * `{ is_system: false }`). A missing column/table (unmigrated) returns
 * "unsupported" so the caller falls back to hard delete.
 */
export async function tombstoneResource(
    db: Db,
    resourceType: GovernedResourceType,
    id: string,
    deletedBy: string,
    scope: Record<string, string | boolean | null> = {},
): Promise<TombstoneOutcome> {
    const table = RESOURCE_TABLE[resourceType];
    let query = (db as any)
        .from(table)
        .update({ deleted_at: new Date().toISOString(), deleted_by: deletedBy })
        .eq("id", id)
        .is("deleted_at", null);
    for (const [column, value] of Object.entries(scope)) {
        query = query.eq(column, value);
    }
    const { data, error } = await query.select("id");
    if (error) {
        if (isMissingColumnOrTable(error)) return "unsupported";
        throw error;
    }
    return ((data ?? []) as unknown[]).length > 0 ? "tombstoned" : "not_found";
}

/**
 * Tombstone every not-yet-tombstoned row a user owns in a table (bulk delete).
 * Returns the number tombstoned, or "unsupported" on an unmigrated database.
 */
export async function tombstoneAllForUser(
    db: Db,
    resourceType: GovernedResourceType,
    userId: string,
): Promise<number | "unsupported"> {
    const table = RESOURCE_TABLE[resourceType];
    const { data, error } = await (db as any)
        .from(table)
        .update({ deleted_at: new Date().toISOString(), deleted_by: userId })
        .eq("user_id", userId)
        .is("deleted_at", null)
        .select("id");
    if (error) {
        if (isMissingColumnOrTable(error)) return "unsupported";
        throw error;
    }
    return ((data ?? []) as unknown[]).length;
}

// ── Read exclusion (hide) ─────────────────────────────────────────────────────

/**
 * The subset of rows in a table that are currently tombstoned, as an id Set.
 * Used to post-filter the overview RPCs (which do not filter deleted_at) and
 * direct list/fetch reads. Degrades to an empty set on an unmigrated database or
 * any lookup error — it must never break the underlying read (a member seeing
 * their own soon-to-be-purged row is low-harm; failing the whole list is worse).
 */
export async function getTombstonedIds(
    db: Db,
    resourceType: GovernedResourceType,
    opts: { ids?: string[]; userId?: string } = {},
): Promise<Set<string>> {
    const table = RESOURCE_TABLE[resourceType];
    try {
        if (opts.ids && opts.ids.length === 0) return new Set();
        let query = (db as any)
            .from(table)
            .select("id")
            .not("deleted_at", "is", null);
        if (opts.ids) query = query.in("id", opts.ids);
        if (opts.userId) query = query.eq("user_id", opts.userId);
        const { data, error } = await query;
        if (error) {
            if (isMissingColumnOrTable(error)) return new Set();
            throw error;
        }
        return new Set(
            ((data ?? []) as { id: string }[])
                .map((row) => row.id)
                .filter((id): id is string => typeof id === "string"),
        );
    } catch (err) {
        console.error("[deletion] tombstoned-id lookup failed", {
            table,
            error: safeErrorLog(err),
        });
        return new Set();
    }
}

/** True when a single row is tombstoned (fetch-by-id 404 guard). */
export async function isResourceTombstoned(
    db: Db,
    resourceType: GovernedResourceType,
    id: string,
): Promise<boolean> {
    const set = await getTombstonedIds(db, resourceType, { ids: [id] });
    return set.has(id);
}

// ── Audit (best-effort) ───────────────────────────────────────────────────────

export type DeletionAuditAction =
    | "requested"
    | "restored"
    | "expedited"
    | "purged"
    | "exported"
    // WS9 firm visibility flips — deletion_audit_logs is the seed of the general
    // admin audit log; these share the same append-only surface.
    | "firm_shared"
    | "firm_reverted";

/**
 * Best-effort append to deletion_audit_logs — never throws, never blocks the
 * request (mirrors insertMcpAuditLog). Skips silently when no organisation id is
 * resolvable (orgless / fail-safe tombstone): the log is org-scoped by design.
 */
export async function insertDeletionAudit(
    db: Db,
    params: {
        organisationId: string | null;
        actorUserId: string;
        action: DeletionAuditAction;
        resourceType: string;
        resourceId?: string | null;
        detail?: Record<string, unknown>;
    },
): Promise<void> {
    if (!params.organisationId) return;
    try {
        const { error } = await db.from("deletion_audit_logs").insert({
            organisation_id: params.organisationId,
            actor_user_id: params.actorUserId,
            action: params.action,
            resource_type: params.resourceType,
            resource_id: params.resourceId ?? null,
            detail: params.detail ?? {},
        });
        if (error) {
            console.error("[deletion] failed to write audit log", {
                action: params.action,
                error: safeErrorLog(error),
            });
        }
    } catch (err) {
        console.error("[deletion] audit insert threw", {
            action: params.action,
            error: safeErrorLog(err),
        });
    }
}

// ── Retention ─────────────────────────────────────────────────────────────────

/**
 * Persist a firm's retention window (already clamped by the caller) and return
 * the stored value.
 */
export async function updateOrganisationRetention(
    db: Db,
    organisationId: string,
    retentionDays: number,
): Promise<number> {
    const { data, error } = await db
        .from("organisations")
        .update({
            retention_days: retentionDays,
            updated_at: new Date().toISOString(),
        })
        .eq("id", organisationId)
        .select("retention_days")
        .maybeSingle();
    if (error) throw error;
    const row = data as { retention_days: number | null } | null;
    return typeof row?.retention_days === "number"
        ? row.retention_days
        : retentionDays;
}

interface OwnerRetention {
    organisationId: string | null;
    retentionDays: number;
}

/**
 * Resolve each owner's firm + retention window in one query. Owners are the
 * event tables' TEXT user_id (which hold uuid strings); user_profiles.user_id is
 * uuid — matched by string, never a raw cross-type join (DURABLE_LESSONS
 * 2026-07-22). Owners not found, orgless owners, and any lookup miss fall back to
 * the default window. 42703/42P01-tolerant.
 */
export async function getRetentionContextForOwners(
    db: Db,
    ownerIds: string[],
): Promise<Map<string, OwnerRetention>> {
    const map = new Map<string, OwnerRetention>();
    const unique = [...new Set(ownerIds.filter((id): id is string => !!id))];
    if (unique.length === 0) return map;
    try {
        const { data, error } = await db
            .from("user_profiles")
            .select(
                "user_id, organisation_id, organisation:organisations(retention_days)",
            )
            .in("user_id", unique);
        if (error) {
            if (isMissingColumnOrTable(error)) return map;
            throw error;
        }
        for (const raw of (data ?? []) as Array<{
            user_id?: unknown;
            organisation_id?: unknown;
            organisation?: unknown;
        }>) {
            const uid =
                typeof raw.user_id === "string"
                    ? raw.user_id.toLowerCase()
                    : null;
            if (!uid) continue;
            const orgId =
                typeof raw.organisation_id === "string"
                    ? raw.organisation_id
                    : null;
            const embed = Array.isArray(raw.organisation)
                ? raw.organisation[0]
                : raw.organisation;
            const rd = (embed as { retention_days?: unknown } | null)
                ?.retention_days;
            const retentionDays =
                orgId && typeof rd === "number" && rd > 0
                    ? rd
                    : DEFAULT_RETENTION_DAYS;
            map.set(uid, { organisationId: orgId, retentionDays });
        }
        return map;
    } catch (err) {
        console.error("[deletion] retention context lookup failed", {
            error: safeErrorLog(err),
        });
        return map;
    }
}

// ── Purge (hard delete after retention) ───────────────────────────────────────

const PURGE_BY_IDS: Record<
    GovernedResourceType,
    (db: Db, ids: string[]) => Promise<number>
> = {
    project: purgeProjectsByIds,
    document: purgeDocumentsByIds,
    chat: purgeChatsByIds,
    "tabular-review": purgeTabularReviewsByIds,
    workflow: purgeWorkflowsByIds,
};

/** Run the existing hard-delete path (incl. storage cleanup) for a set of ids. */
export async function purgeResourcesByIds(
    db: Db,
    resourceType: GovernedResourceType,
    ids: string[],
): Promise<number> {
    return PURGE_BY_IDS[resourceType](db, ids);
}

export interface PurgeSummary {
    total: number;
    byType: Record<GovernedResourceType, number>;
}

function emptyByType(): Record<GovernedResourceType, number> {
    return {
        project: 0,
        document: 0,
        chat: 0,
        "tabular-review": 0,
        workflow: 0,
    };
}

/**
 * Sweep every governed table for tombstoned rows past their owner's firm
 * retention window and hard-delete them via the existing per-id purge helpers.
 * Best-effort and self-contained: a failure on one table is logged and skipped,
 * never propagated (the sweep runs on boot + every 6h and must never crash the
 * process). Writes one `purged` audit row per org per sweep with per-type counts.
 * 42703/42P01-tolerant (a missing table/column is skipped). `now` is injectable
 * for deterministic tests.
 */
export async function runDeletionPurge(
    db: Db = createServerSupabase(),
    now: Date = new Date(),
): Promise<PurgeSummary> {
    const byType = emptyByType();
    const nowMs = now.getTime();
    // orgId → { resourceType: count } for the per-org audit rows.
    const orgCounts = new Map<string, Record<string, number>>();

    for (const resourceType of GOVERNED_RESOURCE_TYPES) {
        const table = RESOURCE_TABLE[resourceType];
        let rows: Array<{
            id: string | null;
            user_id: string | null;
            deleted_at: string | null;
        }>;
        try {
            // Explicit cap at Supabase's default 1000-row ceiling: at pilot
            // scale a sweep never hits it, and if it ever did the 6-hourly
            // re-run drains the tail batch-by-batch (self-healing). Revisit with
            // proper batching if a firm's backlog ever approaches this.
            const { data, error } = await (db as any)
                .from(table)
                .select("id, user_id, deleted_at")
                .not("deleted_at", "is", null)
                .limit(1000);
            if (error) {
                if (isMissingColumnOrTable(error)) continue;
                throw error;
            }
            rows = (data ?? []) as typeof rows;
        } catch (err) {
            console.error("[deletion] purge scan failed", {
                table,
                error: safeErrorLog(err),
            });
            continue;
        }
        if (rows.length === 0) continue;

        const ctx = await getRetentionContextForOwners(
            db,
            rows
                .map((row) => row.user_id)
                .filter((id): id is string => !!id),
        );

        const due: Array<{ id: string; orgId: string | null }> = [];
        for (const row of rows) {
            if (!row.id || !row.deleted_at) continue;
            const owner = row.user_id
                ? ctx.get(row.user_id.toLowerCase())
                : undefined;
            const retentionDays = owner?.retentionDays ?? DEFAULT_RETENTION_DAYS;
            const orgId = owner?.organisationId ?? null;
            const deletedMs = new Date(row.deleted_at).getTime();
            if (!Number.isFinite(deletedMs)) continue;
            if (deletedMs < nowMs - retentionDays * DAY_MS) {
                due.push({ id: row.id, orgId });
            }
        }
        if (due.length === 0) continue;

        try {
            await purgeResourcesByIds(
                db,
                resourceType,
                due.map((d) => d.id),
            );
        } catch (err) {
            console.error("[deletion] purge delete failed", {
                table,
                error: safeErrorLog(err),
            });
            continue;
        }

        byType[resourceType] += due.length;
        for (const d of due) {
            if (!d.orgId) continue;
            const counts = orgCounts.get(d.orgId) ?? {};
            counts[resourceType] = (counts[resourceType] ?? 0) + 1;
            orgCounts.set(d.orgId, counts);
        }
    }

    for (const [orgId, counts] of orgCounts) {
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        await insertDeletionAudit(db, {
            organisationId: orgId,
            actorUserId: SYSTEM_ACTOR_ID,
            action: "purged",
            resourceType: "sweep",
            detail: { counts, total },
        });
    }

    const total = Object.values(byType).reduce((a, b) => a + b, 0);
    return { total, byType };
}

// ── Admin surface (pending deletions / restore / expedite) ────────────────────

/** The firm's member user ids (TEXT-comparable uuid strings). 42703-tolerant. */
export async function getOrganisationMemberIds(
    db: Db,
    organisationId: string,
): Promise<string[]> {
    const { data, error } = await db
        .from("user_profiles")
        .select("user_id")
        .eq("organisation_id", organisationId);
    if (error) {
        if (isMissingColumnOrTable(error)) return [];
        throw error;
    }
    return ((data ?? []) as { user_id?: unknown }[])
        .map((row) => (typeof row.user_id === "string" ? row.user_id : null))
        .filter((id): id is string => !!id);
}

async function getOrganisationRetentionDays(
    db: Db,
    organisationId: string,
): Promise<number> {
    const { data, error } = await db
        .from("organisations")
        .select("retention_days")
        .eq("id", organisationId)
        .maybeSingle();
    if (error) {
        if (isMissingColumnOrTable(error)) return DEFAULT_RETENTION_DAYS;
        throw error;
    }
    const rd = (data as { retention_days?: unknown } | null)?.retention_days;
    return typeof rd === "number" && rd > 0 ? rd : DEFAULT_RETENTION_DAYS;
}

export interface PendingDeletion {
    resourceType: GovernedResourceType;
    /** Sub-kind within the resource's table (workflows: 'tabular' = a review
     *  template, anything else = a prompt workflow). Null where the table has
     *  no sub-kind, or on an unmigrated/absent column. */
    resourceSubtype: string | null;
    id: string;
    displayName: string | null;
    deletedBy: string | null;
    deletedAt: string | null;
    daysRemaining: number;
}

/**
 * List the firm's tombstoned rows across all governed tables, scoped to the
 * firm's members. Returns the newest deletions first. 42703/42P01-tolerant (an
 * unmigrated database yields an empty list).
 */
export async function listPendingDeletions(
    db: Db,
    organisationId: string,
    now: Date = new Date(),
): Promise<PendingDeletion[]> {
    const memberIds = await getOrganisationMemberIds(db, organisationId);
    if (memberIds.length === 0) return [];
    const retentionDays = await getOrganisationRetentionDays(
        db,
        organisationId,
    );
    const nowMs = now.getTime();

    const pending: PendingDeletion[] = [];
    for (const resourceType of GOVERNED_RESOURCE_TYPES) {
        const table = RESOURCE_TABLE[resourceType];
        const displayColumn = DISPLAY_COLUMN[resourceType];
        const subtypeColumn = SUBTYPE_COLUMN[resourceType];
        const columns = ["id", "user_id", "deleted_at", "deleted_by"];
        if (displayColumn) columns.push(displayColumn);
        if (subtypeColumn) columns.push(subtypeColumn);
        let rows: Array<Record<string, unknown>>;
        try {
            // Cap at Supabase's default 1000-row ceiling (pilot-scale; a firm's
            // pending list never approaches this, and the purge sweep drains old
            // tombstones regardless).
            const { data, error } = await (db as any)
                .from(table)
                .select(columns.join(", "))
                .in("user_id", memberIds)
                .not("deleted_at", "is", null)
                .limit(1000);
            if (error) {
                if (isMissingColumnOrTable(error)) continue;
                throw error;
            }
            rows = (data ?? []) as Array<Record<string, unknown>>;
        } catch (err) {
            console.error("[deletion] pending-deletions scan failed", {
                table,
                error: safeErrorLog(err),
            });
            continue;
        }

        for (const row of rows) {
            const id = typeof row.id === "string" ? row.id : null;
            if (!id) continue;
            const deletedAt =
                typeof row.deleted_at === "string" ? row.deleted_at : null;
            const elapsedDays = deletedAt
                ? Math.floor((nowMs - new Date(deletedAt).getTime()) / DAY_MS)
                : 0;
            const displayName =
                displayColumn && typeof row[displayColumn] === "string"
                    ? (row[displayColumn] as string)
                    : null;
            pending.push({
                resourceType,
                resourceSubtype:
                    subtypeColumn && typeof row[subtypeColumn] === "string"
                        ? (row[subtypeColumn] as string)
                        : null,
                id,
                displayName,
                deletedBy:
                    typeof row.deleted_by === "string" ? row.deleted_by : null,
                deletedAt,
                daysRemaining: Math.max(0, retentionDays - elapsedDays),
            });
        }
    }

    // Enrich documents (no title column) with a best-effort version filename.
    await enrichDocumentDisplayNames(db, pending);

    pending.sort((a, b) => {
        const at = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
        const bt = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
        return bt - at;
    });
    return pending;
}

async function enrichDocumentDisplayNames(
    db: Db,
    pending: PendingDeletion[],
): Promise<void> {
    const docIds = pending
        .filter((p) => p.resourceType === "document")
        .map((p) => p.id);
    if (docIds.length === 0) return;
    try {
        const { data, error } = await db
            .from("document_versions")
            .select("document_id, filename")
            .in("document_id", docIds);
        if (error) return; // best-effort — leave the fallback label
        const byDoc = new Map<string, string>();
        for (const raw of (data ?? []) as Array<{
            document_id?: unknown;
            filename?: unknown;
        }>) {
            const docId =
                typeof raw.document_id === "string" ? raw.document_id : null;
            const filename =
                typeof raw.filename === "string" ? raw.filename : null;
            if (docId && filename && !byDoc.has(docId)) byDoc.set(docId, filename);
        }
        for (const p of pending) {
            if (p.resourceType === "document" && !p.displayName) {
                p.displayName = byDoc.get(p.id) ?? null;
            }
        }
    } catch {
        // best-effort enrichment only
    }
}

export type AdminActionOutcome =
    | "ok"
    | "not_found"
    | "unsupported";

/**
 * Clear a member's tombstone (restore). Scoped to the firm's members and encoded
 * in the UPDATE predicate (`.eq("id") .in("user_id", members) .not(deleted_at is
 * null)` + select-back; zero rows ⇒ not_found). 42703 ⇒ "unsupported".
 */
export async function restoreResource(
    db: Db,
    resourceType: GovernedResourceType,
    id: string,
    memberIds: string[],
): Promise<AdminActionOutcome> {
    if (memberIds.length === 0) return "not_found";
    const table = RESOURCE_TABLE[resourceType];
    const { data, error } = await (db as any)
        .from(table)
        .update({ deleted_at: null, deleted_by: null })
        .eq("id", id)
        .in("user_id", memberIds)
        .not("deleted_at", "is", null)
        .select("id");
    if (error) {
        if (isMissingColumnOrTable(error)) return "unsupported";
        throw error;
    }
    return ((data ?? []) as unknown[]).length > 0 ? "ok" : "not_found";
}

/**
 * Immediately hard-delete a member's tombstoned row (expedite). Verifies the row
 * belongs to the firm and is tombstoned before running the purge path. 42703 ⇒
 * "unsupported".
 */
export async function expediteResource(
    db: Db,
    resourceType: GovernedResourceType,
    id: string,
    memberIds: string[],
): Promise<AdminActionOutcome> {
    if (memberIds.length === 0) return "not_found";
    const table = RESOURCE_TABLE[resourceType];
    const { data, error } = await (db as any)
        .from(table)
        .select("id")
        .eq("id", id)
        .in("user_id", memberIds)
        .not("deleted_at", "is", null)
        .maybeSingle();
    if (error) {
        if (isMissingColumnOrTable(error)) return "unsupported";
        throw error;
    }
    if (!data) return "not_found";
    await purgeResourcesByIds(db, resourceType, [id]);
    return "ok";
}
