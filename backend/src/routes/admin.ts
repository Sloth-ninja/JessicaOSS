import { Router } from "express";
import {
    requireAuth,
    requireAdmin,
    requireMfaIfEnrolled,
} from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { createServerSupabase } from "../lib/supabase";
import {
    getUserOrganisationId,
    listOrganisationMembers,
    setMemberRole,
    updateOrganisationPolicies,
    type OrganisationPolicies,
} from "../lib/organisations";
import {
    getOrganisationApiKeyStatus,
    saveOrganisationApiKey,
} from "../lib/organisationApiKeys";
import { normalizeApiKeyProvider } from "../lib/userApiKeys";

export const adminRouter = Router();

// Every admin route is gated to an authenticated organisation admin. requireAuth
// populates res.locals.{userId,token}; requireAdmin confirms the admin role.
// Mutating routes additionally step up through requireMfaIfEnrolled, mirroring
// the personal /user routes.
adminRouter.use(requireAuth, requireAdmin);

const ADMIN_REQUIRED = "Administrator access is required.";

// Resolve the caller's firm. requireAdmin already proved they are an admin (and
// therefore belong to a firm); a null here would be an unexpected race, handled
// with the same fixed 403 rather than leaking any detail.
async function callerOrganisationId(
    db: ReturnType<typeof createServerSupabase>,
    userId: string,
): Promise<string | null> {
    return getUserOrganisationId(db, userId);
}

// GET /admin/firm-keys — per-provider configured flags (never key material).
adminRouter.get(
    "/firm-keys",
    asyncHandler(async (_req, res) => {
        const db = createServerSupabase();
        const orgId = await callerOrganisationId(
            db,
            res.locals.userId as string,
        );
        if (!orgId) return void res.status(403).json({ detail: ADMIN_REQUIRED });
        res.json(await getOrganisationApiKeyStatus(orgId, db));
    }),
);

// PUT /admin/firm-keys/:provider — save (or, on empty/null, delete) the firm's
// key for a provider. Mirrors PUT /user/api-keys/:provider semantics.
adminRouter.put(
    "/firm-keys/:provider",
    requireMfaIfEnrolled,
    asyncHandler(async (req, res) => {
        const provider = normalizeApiKeyProvider(req.params.provider);
        if (!provider)
            return void res.status(400).json({ detail: "Unsupported provider" });

        const apiKey =
            typeof req.body?.api_key === "string" ? req.body.api_key : null;
        const db = createServerSupabase();
        const orgId = await callerOrganisationId(
            db,
            res.locals.userId as string,
        );
        if (!orgId) return void res.status(403).json({ detail: ADMIN_REQUIRED });

        await saveOrganisationApiKey(orgId, provider, apiKey, db);
        res.json(await getOrganisationApiKeyStatus(orgId, db));
    }),
);

// GET /admin/members — the firm's members (name/email/role/created_at).
adminRouter.get(
    "/members",
    asyncHandler(async (_req, res) => {
        const db = createServerSupabase();
        const orgId = await callerOrganisationId(
            db,
            res.locals.userId as string,
        );
        if (!orgId) return void res.status(403).json({ detail: ADMIN_REQUIRED });
        res.json({ members: await listOrganisationMembers(db, orgId) });
    }),
);

// PATCH /admin/members/:userId/role — promote/demote a member of the caller's
// own firm. Refuses (409) demoting the firm's last admin; scoped so an admin can
// never touch another firm's member (404).
adminRouter.patch(
    "/members/:userId/role",
    requireMfaIfEnrolled,
    asyncHandler(async (req, res) => {
        const role = (req.body as { role?: unknown } | null)?.role;
        if (role !== "admin" && role !== "member") {
            return void res
                .status(400)
                .json({ detail: "role must be 'admin' or 'member'." });
        }

        const db = createServerSupabase();
        const orgId = await callerOrganisationId(
            db,
            res.locals.userId as string,
        );
        if (!orgId) return void res.status(403).json({ detail: ADMIN_REQUIRED });

        const result = await setMemberRole(db, {
            organisationId: orgId,
            targetUserId: req.params.userId,
            role,
        });
        if (!result.ok) {
            if (result.reason === "last_admin") {
                return void res.status(409).json({
                    detail: "You cannot remove the last administrator of your firm.",
                });
            }
            return void res
                .status(404)
                .json({ detail: "That member is not part of your firm." });
        }
        res.json({ member: result.member });
    }),
);

// Parse a PATCH /admin/policies body: {memberApiKeys?, memberMcpConnectors?}.
// Only these two boolean fields are accepted; at least one must be present.
function parsePolicyPatch(body: unknown):
    | { ok: true; patch: Partial<OrganisationPolicies> }
    | { ok: false; detail: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { ok: false, detail: "Expected a JSON object" };
    }
    const raw = body as Record<string, unknown>;
    const allowed = ["memberApiKeys", "memberMcpConnectors"] as const;
    const invalid = Object.keys(raw).find(
        (key) => !(allowed as readonly string[]).includes(key),
    );
    if (invalid) {
        return { ok: false, detail: `Unsupported policy field: ${invalid}` };
    }
    const patch: Partial<OrganisationPolicies> = {};
    for (const key of allowed) {
        if (key in raw) {
            if (typeof raw[key] !== "boolean") {
                return { ok: false, detail: `${key} must be a boolean` };
            }
            patch[key] = raw[key] as boolean;
        }
    }
    if (
        patch.memberApiKeys === undefined &&
        patch.memberMcpConnectors === undefined
    ) {
        return { ok: false, detail: "No policy fields to update." };
    }
    return { ok: true, patch };
}

// PATCH /admin/policies — update the firm's member policies (which member
// self-service surfaces are permitted). Scoped to the caller's own firm; MFA
// stepped up like the other mutating admin routes. Returns the resulting flags.
adminRouter.patch(
    "/policies",
    requireMfaIfEnrolled,
    asyncHandler(async (req, res) => {
        const parsed = parsePolicyPatch(req.body);
        if (!parsed.ok) {
            return void res.status(400).json({ detail: parsed.detail });
        }

        const db = createServerSupabase();
        const orgId = await callerOrganisationId(
            db,
            res.locals.userId as string,
        );
        if (!orgId) return void res.status(403).json({ detail: ADMIN_REQUIRED });

        const policies = await updateOrganisationPolicies(
            db,
            orgId,
            parsed.patch,
        );
        res.json({ policies });
    }),
);
