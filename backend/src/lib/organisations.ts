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
