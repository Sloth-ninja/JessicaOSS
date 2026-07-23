import { createServerSupabase } from "./supabase";
import { listOrganisationMembers } from "./organisations";

type Db = ReturnType<typeof createServerSupabase>;

// Supported reporting windows for the admin usage dashboard (WS8 PR D). The
// period toggle governs the tiles, the member activity columns and the daily
// trend; the workflow-template table always reports both a 7d and a 30d column,
// so every event fetch floors at 30 days regardless of the requested period.
// Query ranges are therefore capped at 30 days — never an all-time scan.
export const USAGE_WINDOWS = [7, 30] as const;
const DEFAULT_DAYS = 7;
const FETCH_WINDOW_DAYS = 30;
const MS_PER_DAY = 86_400_000;

export interface UsagePeriodTotals {
    /** Members with any chat / workflow run / document in the requested window. */
    activeMembers: number;
    /** Members of the firm (denominator for "active x of y"). */
    totalMembers: number;
    /** Chats created in the requested window. */
    chats: number;
    /** Workflow runs (tabular reviews) created in the requested window. */
    workflowRuns: number;
    /** Documents uploaded in the requested window. */
    documents: number;
}

export interface UsageMemberRow {
    userId: string;
    displayName: string | null;
    email: string | null;
    /** Most recent activity within the 30-day fetch window; null if none. */
    lastActive: string | null;
    /** Chats in the requested window. */
    chats: number;
    /** Workflow runs in the requested window. */
    workflowRuns: number;
}

export interface UsageWorkflowRow {
    workflowId: string;
    title: string;
    runs7d: number;
    runs30d: number;
    /** Most recent run within the 30-day fetch window; null if none. */
    lastRun: string | null;
}

export interface UsageDailyPoint {
    /** UTC calendar day, YYYY-MM-DD. */
    date: string;
    chats: number;
}

export interface FirmUsage {
    period: { days: number; since: string; until: string };
    totals: UsagePeriodTotals;
    members: UsageMemberRow[];
    workflows: UsageWorkflowRow[];
    daily: UsageDailyPoint[];
}

/** Clamp an arbitrary ?days value to a supported window (default 7). */
export function normaliseUsageDays(value: unknown): number {
    const n =
        typeof value === "string"
            ? Number.parseInt(value, 10)
            : typeof value === "number"
              ? value
              : NaN;
    return (USAGE_WINDOWS as readonly number[]).includes(n) ? n : DEFAULT_DAYS;
}

/** UTC calendar-day key (YYYY-MM-DD) for an instant. */
function dayKey(instant: Date): string {
    return instant.toISOString().slice(0, 10);
}

/** Midnight-UTC ISO string for the start of the day `n-1` days before `now`
 *  (so the window is `n` calendar days inclusive of today). */
function windowSinceIso(now: Date, n: number): string {
    const startKey = dayKey(new Date(now.getTime() - (n - 1) * MS_PER_DAY));
    return `${startKey}T00:00:00.000Z`;
}

/** The `days` consecutive UTC day-keys ending today (oldest first). */
function windowDayKeys(now: Date, days: number): string[] {
    const keys: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
        keys.push(dayKey(new Date(now.getTime() - i * MS_PER_DAY)));
    }
    return keys;
}

// Narrow event-row shapes — only the columns the aggregation reads are selected.
type ChatRow = { created_at: string | null; user_id: string | null };
type DocumentRow = { created_at: string | null; user_id: string | null };
type ReviewRow = {
    created_at: string | null;
    user_id: string | null;
    workflow_id: string | null;
};
type WorkflowRow = { id: string; title: string | null };

/** Fetch a table's rows for the firm's members within the 30-day window.
 *  Filters by the members' ids (event tables store user_id as TEXT; the ids
 *  resolved from user_profiles are the uuid strings, usable directly in .in()).
 *  Returns [] for an empty member set — never issues an `IN ()`. */
async function fetchWindowRows<T>(
    db: Db,
    table: string,
    columns: string,
    memberIds: string[],
    fetchSinceIso: string,
): Promise<T[]> {
    if (memberIds.length === 0) return [];
    const { data, error } = await db
        .from(table)
        .select(columns)
        .in("user_id", memberIds)
        .gte("created_at", fetchSinceIso);
    if (error) throw error;
    return (data ?? []) as T[];
}

function parseTime(value: string | null): number | null {
    if (!value) return null;
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
}

/**
 * Compose the admin usage dashboard payload for one firm, org-scoped to the
 * caller's own members only.
 *
 * Watertight scoping: member ids come solely from `user_profiles` filtered by
 * `organisationId` (via `listOrganisationMembers`); every event query is then
 * filtered to that id set, so another firm's rows can never be counted. The
 * uuid→text gotcha (user_profiles.user_id is uuid; chats/tabular_reviews/
 * documents.user_id are TEXT) is handled by resolving ids first and filtering
 * the text columns by those string ids — never a cross-type join.
 *
 * All windowing is computed in code over narrow selects capped at 30 days
 * (fine at pilot scale). `now` is injectable for deterministic tests.
 */
export async function getOrganisationUsage(
    db: Db,
    organisationId: string,
    opts: { days?: number; now?: Date } = {},
): Promise<FirmUsage> {
    const days = normaliseUsageDays(opts.days);
    const now = opts.now ?? new Date();

    const fetchSinceIso = windowSinceIso(now, FETCH_WINDOW_DAYS);
    const windowSince = Date.parse(windowSinceIso(now, days));
    const window7 = Date.parse(windowSinceIso(now, 7));
    // Upper bound: a future-dated created_at (clock skew / bad data) must never
    // count in the tiles while falling outside the daily series' day range —
    // treat anything after `now` as no timestamp at all, everywhere.
    const nowMs = now.getTime();
    const eventTime = (value: string | null): number | null => {
        const t = parseTime(value);
        return t === null || t > nowMs ? null : t;
    };

    // Identity (name + email) reuses the member machinery; activity is layered
    // on top so the email pagination lives in exactly one place.
    const members = await listOrganisationMembers(db, organisationId);
    const memberIds = members.map((m) => m.userId);

    const [chatRows, reviewRows, documentRows] = await Promise.all([
        fetchWindowRows<ChatRow>(
            db,
            "chats",
            "created_at, user_id",
            memberIds,
            fetchSinceIso,
        ),
        fetchWindowRows<ReviewRow>(
            db,
            "tabular_reviews",
            "created_at, user_id, workflow_id",
            memberIds,
            fetchSinceIso,
        ),
        fetchWindowRows<DocumentRow>(
            db,
            "documents",
            "created_at, user_id",
            memberIds,
            fetchSinceIso,
        ),
    ]);

    // Resolve workflow titles for the templates that actually appear.
    const workflowIds = Array.from(
        new Set(
            reviewRows
                .map((r) => r.workflow_id)
                .filter((id): id is string => !!id),
        ),
    );
    const titleById = new Map<string, string>();
    if (workflowIds.length > 0) {
        const { data, error } = await db
            .from("workflows")
            .select("id, title")
            .in("id", workflowIds);
        if (error) throw error;
        for (const row of (data ?? []) as WorkflowRow[]) {
            if (row.title) titleById.set(row.id, row.title);
        }
    }

    // Per-member accumulators.
    const perMember = new Map<
        string,
        { chats: number; workflowRuns: number; lastActive: number | null }
    >();
    for (const id of memberIds) {
        perMember.set(id, { chats: 0, workflowRuns: 0, lastActive: null });
    }
    const bumpLastActive = (userId: string | null, t: number | null) => {
        if (!userId || t === null) return;
        const acc = perMember.get(userId);
        if (!acc) return; // defensive: only firm members were queried.
        if (acc.lastActive === null || t > acc.lastActive) acc.lastActive = t;
    };

    // Daily chat buckets for the trend, pre-seeded with every day (incl. zeros).
    const dayKeys = windowDayKeys(now, days);
    const dailyByKey = new Map<string, number>(dayKeys.map((k) => [k, 0]));

    const activeInWindow = new Set<string>();
    let chatsInWindow = 0;
    let documentsInWindow = 0;
    let workflowRunsInWindow = 0;

    for (const row of chatRows) {
        const t = eventTime(row.created_at);
        bumpLastActive(row.user_id, t);
        if (t === null || t < windowSince) continue;
        chatsInWindow++;
        if (row.user_id) {
            activeInWindow.add(row.user_id);
            const acc = perMember.get(row.user_id);
            if (acc) acc.chats++;
        }
        const key = dayKey(new Date(t));
        if (dailyByKey.has(key)) dailyByKey.set(key, dailyByKey.get(key)! + 1);
    }

    for (const row of documentRows) {
        const t = eventTime(row.created_at);
        bumpLastActive(row.user_id, t);
        if (t === null || t < windowSince) continue;
        documentsInWindow++;
        if (row.user_id) activeInWindow.add(row.user_id);
    }

    // Per-workflow-template accumulators (7d / 30d / last run).
    const perWorkflow = new Map<
        string,
        { runs7d: number; runs30d: number; lastRun: number | null }
    >();
    for (const row of reviewRows) {
        const t = eventTime(row.created_at);
        bumpLastActive(row.user_id, t);
        if (t !== null && t >= windowSince) {
            workflowRunsInWindow++;
            if (row.user_id) {
                activeInWindow.add(row.user_id);
                const acc = perMember.get(row.user_id);
                if (acc) acc.workflowRuns++;
            }
        }
        // Template table: only rows whose workflow resolves to a title.
        const wid = row.workflow_id;
        if (!wid || !titleById.has(wid) || t === null) continue;
        const wacc = perWorkflow.get(wid) ?? {
            runs7d: 0,
            runs30d: 0,
            lastRun: null,
        };
        wacc.runs30d++; // every fetched row is within the 30-day floor.
        if (t >= window7) wacc.runs7d++;
        if (wacc.lastRun === null || t > wacc.lastRun) wacc.lastRun = t;
        perWorkflow.set(wid, wacc);
    }

    const memberRows: UsageMemberRow[] = members.map((m) => {
        const acc = perMember.get(m.userId)!;
        return {
            userId: m.userId,
            displayName: m.displayName,
            email: m.email,
            lastActive:
                acc.lastActive === null
                    ? null
                    : new Date(acc.lastActive).toISOString(),
            chats: acc.chats,
            workflowRuns: acc.workflowRuns,
        };
    });
    // Busiest members first (chats, then workflow runs); stable-ish by name.
    memberRows.sort(
        (a, b) =>
            b.chats - a.chats ||
            b.workflowRuns - a.workflowRuns ||
            (a.displayName ?? a.email ?? "").localeCompare(
                b.displayName ?? b.email ?? "",
            ),
    );

    const workflowRows: UsageWorkflowRow[] = Array.from(
        perWorkflow.entries(),
    ).map(([workflowId, acc]) => ({
        workflowId,
        // Defensive fallback only: a workflow enters perWorkflow only after
        // `titleById.has(wid)` passed above, and workflows.title is NOT NULL,
        // so titleById.get() is always a string here in practice.
        title: titleById.get(workflowId) ?? "Untitled workflow",
        runs7d: acc.runs7d,
        runs30d: acc.runs30d,
        lastRun:
            acc.lastRun === null ? null : new Date(acc.lastRun).toISOString(),
    }));
    // Most-used templates first (30d), then 7d, then title.
    workflowRows.sort(
        (a, b) =>
            b.runs30d - a.runs30d ||
            b.runs7d - a.runs7d ||
            a.title.localeCompare(b.title),
    );

    const daily: UsageDailyPoint[] = dayKeys.map((date) => ({
        date,
        chats: dailyByKey.get(date) ?? 0,
    }));

    return {
        period: {
            days,
            since: windowSinceIso(now, days),
            until: now.toISOString(),
        },
        totals: {
            activeMembers: activeInWindow.size,
            totalMembers: members.length,
            chats: chatsInWindow,
            workflowRuns: workflowRunsInWindow,
            documents: documentsInWindow,
        },
        members: memberRows,
        workflows: workflowRows,
        daily,
    };
}
