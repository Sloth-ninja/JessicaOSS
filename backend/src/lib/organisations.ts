import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type OrganisationRole = "admin" | "member";

export interface OrganisationPolicies {
    /** Firm allows members to configure their own provider API keys. */
    memberApiKeys: boolean;
    /** Firm allows members to configure their own MCP connectors. */
    memberMcpConnectors: boolean;
}

export interface OrganisationMembership {
    id: string;
    name: string;
    role: OrganisationRole;
    policies: OrganisationPolicies;
}

// Columns embedded from the joined organisations row.
type OrganisationEmbed = {
    id: string | null;
    name: string | null;
    allow_member_api_keys: boolean | null;
    allow_member_mcp_connectors: boolean | null;
};

type MembershipRow = {
    organisation_id: string | null;
    role: string | null;
    // Supabase returns a many-to-one embed as a single object (or null); we
    // also tolerate an array shape defensively.
    organisation: OrganisationEmbed | OrganisationEmbed[] | null;
};

// One round-trip: the profile's membership columns plus the joined firm row.
const MEMBERSHIP_SELECT =
    "organisation_id, role, organisation:organisations(id, name, allow_member_api_keys, allow_member_mcp_connectors)";

// Postgres "undefined_column" — raised when the organisation_id / role columns
// (or the organisations table) do not exist yet on an unmigrated database. We
// degrade to orgless rather than failing the request, mirroring the
// enforceLoginMfaIfEnabled 42703 pattern (docs/DURABLE_LESSONS.md, middleware/auth.ts).
function isMissingOrganisationColumn(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code = (error as { code?: unknown }).code;
    return code === "42703";
}

function normaliseRole(value: unknown): OrganisationRole {
    return value === "admin" ? "admin" : "member";
}

function normaliseEmbed(
    embed: MembershipRow["organisation"],
): OrganisationEmbed | null {
    if (!embed) return null;
    const value = Array.isArray(embed) ? (embed[0] ?? null) : embed;
    if (!value || typeof value !== "object") return null;
    if (typeof value.id !== "string" || typeof value.name !== "string") {
        return null;
    }
    return value;
}

function toMembership(row: MembershipRow | null): OrganisationMembership | null {
    if (!row || !row.organisation_id) return null;
    const org = normaliseEmbed(row.organisation);
    if (!org || !org.id || !org.name) return null;
    return {
        id: org.id,
        name: org.name,
        role: normaliseRole(row.role),
        policies: {
            memberApiKeys: org.allow_member_api_keys === true,
            memberMcpConnectors: org.allow_member_mcp_connectors === true,
        },
    };
}

async function queryMembership(db: Db, userId: string) {
    return db
        .from("user_profiles")
        .select(MEMBERSHIP_SELECT)
        .eq("user_id", userId)
        .maybeSingle();
}

/**
 * Assign an orgless user to the configured default organisation as a member.
 *
 * Idempotent and race-safe: the orgless guard is encoded in the UPDATE
 * predicate itself (`.is("organisation_id", null)`), so concurrent profile
 * loads can never double-assign or stomp a real membership (DURABLE_LESSONS:
 * encode state transitions in the UPDATE predicate). Tolerates an unmigrated DB
 * (42703 → no-op). Returns the default org id when assignment was attempted
 * (caller re-reads), or null when no default is configured / the DB is
 * unmigrated.
 */
export async function assignDefaultOrganisation(
    db: Db,
    userId: string,
): Promise<string | null> {
    const defaultOrgId = process.env.DEFAULT_ORGANISATION_ID?.trim();
    if (!defaultOrgId) return null;

    const { error } = await db
        .from("user_profiles")
        .update({
            organisation_id: defaultOrgId,
            role: "member",
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .is("organisation_id", null);

    if (error) {
        if (isMissingOrganisationColumn(error)) return null;
        throw error;
    }
    return defaultOrgId;
}

/**
 * Resolve a user's organisation membership (firm + role + policies) in a single
 * join query. Orgless users with `DEFAULT_ORGANISATION_ID` set are auto-assigned
 * to the default firm (member) on first load, then re-read. Returns null for
 * genuinely orgless users and for unmigrated databases (42703-tolerant).
 */
export async function resolveUserOrganisation(
    db: Db = createServerSupabase(),
    userId: string,
): Promise<OrganisationMembership | null> {
    const { data, error } = await queryMembership(db, userId);
    if (error) {
        if (isMissingOrganisationColumn(error)) return null;
        throw error;
    }

    let row = data as MembershipRow | null;

    // Orgless: attempt default-org assignment, then re-read to pick up the join.
    if (row && !row.organisation_id) {
        const assigned = await assignDefaultOrganisation(db, userId);
        if (assigned) {
            const reread = await queryMembership(db, userId);
            if (reread.error) {
                if (isMissingOrganisationColumn(reread.error)) return null;
                throw reread.error;
            }
            row = reread.data as MembershipRow | null;
        }
    }

    return toMembership(row);
}

/**
 * True when the user is an organisation admin. Side-effect-free (no default-org
 * assignment): an orgless user is never an admin, so a lightweight role read is
 * sufficient. 42703-tolerant → false on an unmigrated database.
 */
export async function isAdmin(
    db: Db = createServerSupabase(),
    userId: string,
): Promise<boolean> {
    const { data, error } = await db
        .from("user_profiles")
        .select("organisation_id, role")
        .eq("user_id", userId)
        .maybeSingle();
    if (error) {
        if (isMissingOrganisationColumn(error)) return false;
        throw error;
    }
    const row = data as {
        organisation_id?: string | null;
        role?: string | null;
    } | null;
    if (!row || !row.organisation_id) return false;
    return normaliseRole(row.role) === "admin";
}

/**
 * The caller's organisation id, or null when orgless / unmigrated (42703).
 * Lightweight read used by the API-key precedence layer (user > firm > env) and
 * the admin routes to scope every operation to the caller's own firm.
 */
export async function getUserOrganisationId(
    db: Db = createServerSupabase(),
    userId: string,
): Promise<string | null> {
    const { data, error } = await db
        .from("user_profiles")
        .select("organisation_id")
        .eq("user_id", userId)
        .maybeSingle();
    if (error) {
        if (isMissingOrganisationColumn(error)) return null;
        throw error;
    }
    const row = data as { organisation_id?: string | null } | null;
    return row?.organisation_id ?? null;
}

/**
 * Update a firm's member policies (allow_member_api_keys /
 * allow_member_mcp_connectors) and return the resulting policy flags. Scoped to
 * the given organisation id (the admin routes resolve this from the caller's own
 * membership, so an admin can never touch another firm's row). Only the fields
 * present on `patch` are written; a select-back returns the authoritative state.
 */
export async function updateOrganisationPolicies(
    db: Db,
    organisationId: string,
    patch: Partial<OrganisationPolicies>,
): Promise<OrganisationPolicies> {
    const update: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
    };
    if (typeof patch.memberApiKeys === "boolean") {
        update.allow_member_api_keys = patch.memberApiKeys;
    }
    if (typeof patch.memberMcpConnectors === "boolean") {
        update.allow_member_mcp_connectors = patch.memberMcpConnectors;
    }

    const { data, error } = await db
        .from("organisations")
        .update(update)
        .eq("id", organisationId)
        .select("allow_member_api_keys, allow_member_mcp_connectors")
        .maybeSingle();
    if (error) throw error;

    const row = data as {
        allow_member_api_keys: boolean | null;
        allow_member_mcp_connectors: boolean | null;
    } | null;
    return {
        memberApiKeys: row?.allow_member_api_keys === true,
        memberMcpConnectors: row?.allow_member_mcp_connectors === true,
    };
}

export interface OrganisationMember {
    userId: string;
    displayName: string | null;
    email: string | null;
    role: OrganisationRole;
    createdAt: string | null;
}

type MemberProfileRow = {
    user_id: string;
    display_name: string | null;
    role: string | null;
    created_at: string | null;
};

/**
 * List a firm's members: profile fields (display name, role, created_at) joined
 * with the auth email where available. Emails come from the auth admin API (the
 * auth schema is not exposed to PostgREST); a member whose email cannot be
 * resolved simply reports null rather than failing the whole list.
 */
export async function listOrganisationMembers(
    db: Db = createServerSupabase(),
    organisationId: string,
): Promise<OrganisationMember[]> {
    const { data, error } = await db
        .from("user_profiles")
        .select("user_id, display_name, role, created_at")
        .eq("organisation_id", organisationId);
    if (error) throw error;

    const rows = (data ?? []) as MemberProfileRow[];

    // Resolve emails from the auth admin API. listUsers' `perPage` is a
    // PROJECT-wide cap (all users in the Supabase project), not per-firm, so we
    // paginate until a short page drains the list — guarded by MAX_PAGES so a
    // pathological project can never loop unbounded. A lookup failure degrades
    // to null emails, never a throw.
    const emailByUserId = new Map<string, string | null>();
    try {
        const PER_PAGE = 200;
        const MAX_PAGES = 20;
        for (let page = 1; page <= MAX_PAGES; page++) {
            const { data: authData, error: authError } =
                await db.auth.admin.listUsers({ page, perPage: PER_PAGE });
            if (authError) break;
            const users = authData?.users ?? [];
            for (const user of users) {
                if (user?.id) emailByUserId.set(user.id, user.email ?? null);
            }
            if (users.length < PER_PAGE) break; // last (short) page — drained.
        }
    } catch (err) {
        console.error("[organisations] member email lookup failed", {
            organisationId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
        email: emailByUserId.get(row.user_id) ?? null,
        role: normaliseRole(row.role),
        createdAt: row.created_at,
    }));
}

export type SetMemberRoleResult =
    | { ok: true; member: OrganisationMember }
    | { ok: false; reason: "not_found" | "last_admin" };

/**
 * Change a member's role, scoped to the caller's own firm and guarded against
 * removing the firm's last admin.
 *
 * Scoping and double-submit safety are encoded in the UPDATE predicate itself
 * (`.eq("user_id", …).eq("organisation_id", callerOrgId)` + select-back; zero
 * rows ⇒ the target is not in the caller's firm — DURABLE_LESSONS: encode state
 * transitions in the predicate). The last-admin guard needs an aggregate a
 * single PostgREST predicate can't express (no RPC — no new migration is
 * authorised for PR C), so it counts the *other* admins immediately before the
 * demotion and refuses when none remain. At pilot scale the residual
 * check-then-write window is acceptable; noted for a future DB-function upgrade.
 */
export async function setMemberRole(
    db: Db,
    params: {
        organisationId: string;
        targetUserId: string;
        role: OrganisationRole;
    },
): Promise<SetMemberRoleResult> {
    const { organisationId, targetUserId, role } = params;

    // Scoped read: the target must belong to the caller's firm.
    const { data: targetData, error: targetError } = await db
        .from("user_profiles")
        .select("user_id, display_name, role, created_at")
        .eq("user_id", targetUserId)
        .eq("organisation_id", organisationId)
        .maybeSingle();
    if (targetError) throw targetError;
    const target = targetData as MemberProfileRow | null;
    if (!target) return { ok: false, reason: "not_found" };

    // Last-admin guard: never demote the only remaining admin of the firm.
    // Roles are normalised the same way everywhere (normaliseRole) so the count
    // can't under/over-count on any non-normalised data.
    if (role === "member" && normaliseRole(target.role) === "admin") {
        const { data: adminData, error: adminError } = await db
            .from("user_profiles")
            .select("user_id, role")
            .eq("organisation_id", organisationId);
        if (adminError) throw adminError;
        const otherAdmins = (adminData ?? []).filter((r) => {
            const member = r as { user_id: string; role: string | null };
            return (
                member.user_id !== targetUserId &&
                normaliseRole(member.role) === "admin"
            );
        });
        if (otherAdmins.length === 0) {
            return { ok: false, reason: "last_admin" };
        }
    }

    // Guarded write: scoped to the caller's firm; select-back confirms a hit.
    const { data: updatedData, error: updateError } = await db
        .from("user_profiles")
        .update({ role, updated_at: new Date().toISOString() })
        .eq("user_id", targetUserId)
        .eq("organisation_id", organisationId)
        .select("user_id, display_name, role, created_at");
    if (updateError) throw updateError;
    const updated = (updatedData ?? []) as MemberProfileRow[];
    if (updated.length === 0) return { ok: false, reason: "not_found" };

    const row = updated[0];

    // Populate the member's email so the success payload matches the
    // OrganisationMember shape returned by listOrganisationMembers. A lookup
    // failure degrades to null rather than failing the (already-committed) role
    // change. (Smaller diff than threading email through the update select.)
    let email: string | null = null;
    try {
        const { data: authUser } = await db.auth.admin.getUserById(
            row.user_id,
        );
        email = authUser?.user?.email ?? null;
    } catch (err) {
        console.error("[organisations] member email lookup failed", {
            organisationId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return {
        ok: true,
        member: {
            userId: row.user_id,
            displayName: row.display_name,
            email,
            role: normaliseRole(row.role),
            createdAt: row.created_at,
        },
    };
}
