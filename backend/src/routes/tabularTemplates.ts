import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { createServerSupabase } from "../lib/supabase";
import { getUserOrganisationId } from "../lib/organisations";
import {
  TemplateValidationError,
  adminRevertTemplate,
  createTemplate,
  deleteTemplate,
  getTemplate,
  listFirmTemplatesForAdmin,
  listTemplates,
  setTemplateVisibility,
  updateTemplate,
} from "../lib/tabularTemplates";

/**
 * Review templates (saved tabular schemas v1) — thin routes over
 * lib/tabularTemplates.ts. Mounted at /tabular-templates. All handlers are
 * requireAuth + asyncHandler; the admin surface adds requireAdmin. Validation
 * failures surface the TemplateValidationError message (user-safe by
 * construction); everything else degrades to asyncHandler's fixed generic 500.
 */

export const tabularTemplatesRouter = Router();

const TEMPLATE_NOT_FOUND_DETAIL = "Template not found.";
const FIRM_SHARING_UNAVAILABLE_DETAIL = "Firm sharing is not available.";

// Template ids are uuids. A non-uuid `:id` (including the literal "admin" from
// a mistyped /tabular-templates/admin) gets the uniform 404 up front rather
// than reaching Postgres, where a malformed uuid raises 22P02 and would
// surface as a generic 500.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rejectNonUuidId(
  id: string,
  res: { status: (n: number) => { json: (b: unknown) => void } },
): boolean {
  if (UUID_RE.test(id)) return false;
  res.status(404).json({ detail: TEMPLATE_NOT_FOUND_DETAIL });
  return true;
}

/** 400 with the validation message for TemplateValidationError; rethrow rest. */
function handleValidationError(
  err: unknown,
  res: { status: (n: number) => { json: (b: unknown) => void } },
): void {
  if (err instanceof TemplateValidationError) {
    res.status(400).json({ detail: err.message });
    return;
  }
  throw err;
}

// ── Admin surface (registered first for clarity; distinct paths) ─────────────

// GET /tabular-templates/admin/firm — the org's firm-shared templates.
tabularTemplatesRouter.get(
  "/admin/firm",
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const orgId = await getUserOrganisationId(db, userId);
    if (!orgId) return void res.json([]);
    res.json(await listFirmTemplatesForAdmin(db, orgId));
  }),
);

// POST /tabular-templates/:id/admin-revert — revert a firm template to private.
tabularTemplatesRouter.post(
  "/:id/admin-revert",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const userId = res.locals.userId as string;
    if (rejectNonUuidId(req.params.id, res)) return;
    const db = createServerSupabase();
    const orgId = await getUserOrganisationId(db, userId);
    if (!orgId) {
      return void res.status(404).json({ detail: TEMPLATE_NOT_FOUND_DETAIL });
    }
    const outcome = await adminRevertTemplate(db, userId, orgId, req.params.id);
    if (outcome !== "reverted") {
      return void res.status(404).json({ detail: TEMPLATE_NOT_FOUND_DETAIL });
    }
    res.status(204).send();
  }),
);

// ── Member surface ───────────────────────────────────────────────────────────

// GET /tabular-templates — mine + email-shared + firm-shared, with the
// firm-support flag.
tabularTemplatesRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = (res.locals.userEmail as string | undefined) ?? null;
    const db = createServerSupabase();
    const orgId = await getUserOrganisationId(db, userId);
    res.json(await listTemplates(db, userId, userEmail, orgId));
  }),
);

// POST /tabular-templates — create a private template.
tabularTemplatesRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = res.locals.userId as string;
    const body = (req.body ?? {}) as {
      title?: unknown;
      practice?: unknown;
      columns?: unknown;
    };
    const db = createServerSupabase();
    try {
      const template = await createTemplate(db, userId, {
        // The seam validates these; the casts only satisfy its signature.
        title: body.title as string,
        practice: (body.practice ?? null) as string | null,
        columns: body.columns,
      });
      res.status(201).json(template);
    } catch (err) {
      handleValidationError(err, res);
    }
  }),
);

// GET /tabular-templates/:id — owner or firm-visible-in-caller's-org only.
tabularTemplatesRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = res.locals.userId as string;
    if (rejectNonUuidId(req.params.id, res)) return;
    const db = createServerSupabase();
    const orgId = await getUserOrganisationId(db, userId);
    const template = await getTemplate(db, userId, req.params.id, orgId);
    if (template === "not_found") {
      return void res.status(404).json({ detail: TEMPLATE_NOT_FOUND_DETAIL });
    }
    res.json(template);
  }),
);

// PATCH /tabular-templates/:id — owner-only rename / practice / columns.
tabularTemplatesRouter.patch(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = res.locals.userId as string;
    if (rejectNonUuidId(req.params.id, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: {
      title?: string;
      practice?: string | null;
      columns?: unknown;
    } = {
      ...("title" in body ? { title: body.title as string } : {}),
      ...("practice" in body
        ? { practice: body.practice as string | null }
        : {}),
      ...("columns" in body ? { columns: body.columns } : {}),
    };
    const db = createServerSupabase();
    try {
      const result = await updateTemplate(db, userId, req.params.id, patch);
      if (result === "not_found") {
        return void res.status(404).json({ detail: TEMPLATE_NOT_FOUND_DETAIL });
      }
      res.json(result);
    } catch (err) {
      handleValidationError(err, res);
    }
  }),
);

// DELETE /tabular-templates/:id — owner-only (tombstone-aware via the seam).
tabularTemplatesRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = res.locals.userId as string;
    if (rejectNonUuidId(req.params.id, res)) return;
    const db = createServerSupabase();
    const outcome = await deleteTemplate(db, userId, req.params.id);
    if (outcome !== "deleted") {
      return void res.status(404).json({ detail: TEMPLATE_NOT_FOUND_DETAIL });
    }
    res.status(204).send();
  }),
);

// PATCH /tabular-templates/:id/visibility — owner flip private ⇄ firm.
tabularTemplatesRouter.patch(
  "/:id/visibility",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = res.locals.userId as string;
    if (rejectNonUuidId(req.params.id, res)) return;
    const visibility = (req.body as { visibility?: unknown } | null)
      ?.visibility;
    if (visibility !== "private" && visibility !== "firm") {
      return void res
        .status(400)
        .json({ detail: "visibility must be 'private' or 'firm'." });
    }
    const db = createServerSupabase();
    const orgId = await getUserOrganisationId(db, userId);
    if (!orgId) {
      return void res
        .status(409)
        .json({ detail: FIRM_SHARING_UNAVAILABLE_DETAIL });
    }
    const result = await setTemplateVisibility(
      db,
      userId,
      req.params.id,
      visibility,
      orgId,
    );
    if (result === "unsupported") {
      return void res
        .status(409)
        .json({ detail: FIRM_SHARING_UNAVAILABLE_DETAIL });
    }
    if (result === "not_found") {
      return void res.status(404).json({ detail: TEMPLATE_NOT_FOUND_DETAIL });
    }
    res.json(result);
  }),
);
