import { Router } from "express";
import type { Response } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { createServerSupabase } from "../lib/supabase";
import { ClioApiError } from "../lib/clio/client";
import { minutesToSeconds } from "../lib/clio/manageTools";
import { ClioValidationError } from "../lib/clio/toolShared";
import {
  createWorkspaceForMatter,
  deleteActivity,
  getLinkForMatter,
  getMatterDetail,
  linkWorkspace,
  listActivities,
  listMatters,
  listRelatedContacts,
  unlinkWorkspace,
  updateActivity,
} from "../lib/clio/mattersSurface";

/**
 * Practice Management (Clio-backed Matters) — thin routes over
 * lib/clio/mattersSurface.ts. Mounted at /clio-matters; see
 * docs/PRACTICE_MANAGEMENT_SPEC.md.
 *
 * Every handler is requireAuth + asyncHandler and reads Clio with the CALLER's
 * own token, so matter visibility is exactly what that solicitor's Clio login
 * allows — there is no firm token and no cross-user read path.
 *
 * Error contract (the #72 pattern): ClioValidationError / ClioApiError messages
 * are fixed and user-safe by construction and pass through as the `detail`;
 * anything else falls to asyncHandler's generic 500 with the real cause logged
 * server-side. No raw Clio or Postgres text ever reaches a client.
 *
 * Time durations cross this boundary in MINUTES (what the UI shows) and are
 * converted to the seconds Clio stores here — the seam only ever sees seconds.
 */

export const clioMattersRouter = Router();

// Workspace ids are uuids; a malformed one 404s here rather than reaching
// Postgres, where it would raise 22P02 and surface as a generic 500.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WORKSPACE_NOT_FOUND_DETAIL = "Workspace not found.";
const LINKS_UNAVAILABLE_DETAIL =
  "Linking a workspace to a Clio matter is not available yet.";
const ALREADY_LINKED_DETAIL = "That matter already has a linked workspace.";
const NOT_WORKSPACE_OWNER_DETAIL =
  "Only the owner of a workspace can link or unlink it.";

// Clio statuses that are meaningful to a browser client; anything else (a Clio
// 5xx, an unmapped code) becomes a 502 — this server is not broken, its
// upstream is.
const CLIO_STATUS_PASSTHROUGH = new Set([400, 401, 403, 404, 409, 412, 429]);

/** Map a Clio/validation failure onto its fixed detail; rethrow anything else. */
function handleClioError(err: unknown, res: Response): void {
  if (err instanceof ClioValidationError) {
    res.status(400).json({ detail: err.message });
    return;
  }
  if (err instanceof ClioApiError) {
    const status =
      err.status && CLIO_STATUS_PASSTHROUGH.has(err.status) ? err.status : 502;
    res.status(status).json({ detail: err.message });
    return;
  }
  throw err;
}

function callerOf(res: Response): {
  userId: string;
  userEmail: string | null;
} {
  return {
    userId: res.locals.userId as string,
    userEmail: (res.locals.userEmail as string | undefined) ?? null,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ── Time entries (literal path — registered before the /:matterId routes) ─────

// PATCH /clio-matters/activities/:activityId — edit one of the caller's own,
// unbilled entries. Body: { minutes?, note?, date?, etag? }.
clioMattersRouter.patch(
  "/activities/:activityId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = callerOf(res);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const db = createServerSupabase();
    try {
      // Minutes → seconds happens HERE, once: the UI speaks minutes, Clio
      // stores seconds, and the seam is given seconds only.
      const quantitySeconds =
        body.minutes === undefined ? undefined : minutesToSeconds(body.minutes);
      const updated = await updateActivity(db, userId, req.params.activityId, {
        ...(quantitySeconds !== undefined ? { quantitySeconds } : {}),
        ...("note" in body ? { note: String(body.note ?? "") } : {}),
        ...("date" in body ? { date: String(body.date ?? "") } : {}),
        ...(typeof body.etag === "string" ? { etag: body.etag } : {}),
      });
      res.json(updated);
    } catch (err) {
      handleClioError(err, res);
    }
  }),
);

// DELETE /clio-matters/activities/:activityId — delete one of the caller's own,
// unbilled entries.
clioMattersRouter.delete(
  "/activities/:activityId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = callerOf(res);
    const db = createServerSupabase();
    try {
      await deleteActivity(db, userId, req.params.activityId);
      res.status(204).send();
    } catch (err) {
      handleClioError(err, res);
    }
  }),
);

// ── Workspace links (literal path) ───────────────────────────────────────────

// POST /clio-matters/links — link an EXISTING workspace to a Clio matter.
// Body: { projectId, clioMatterId }.
clioMattersRouter.post(
  "/links",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, userEmail } = callerOf(res);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectId = optionalString(body.projectId) ?? "";
    if (!UUID_RE.test(projectId)) {
      return void res.status(404).json({ detail: WORKSPACE_NOT_FOUND_DETAIL });
    }
    const db = createServerSupabase();
    try {
      const outcome = await linkWorkspace(db, userId, userEmail, {
        projectId,
        clioMatterId: optionalString(body.clioMatterId) ?? "",
      });
      if (outcome === "unsupported") {
        return void res.status(409).json({ detail: LINKS_UNAVAILABLE_DETAIL });
      }
      if (outcome === "already_linked") {
        return void res.status(409).json({ detail: ALREADY_LINKED_DETAIL });
      }
      if (outcome === "forbidden") {
        return void res
          .status(403)
          .json({ detail: NOT_WORKSPACE_OWNER_DETAIL });
      }
      if (outcome === "not_found") {
        return void res
          .status(404)
          .json({ detail: WORKSPACE_NOT_FOUND_DETAIL });
      }
      res.status(201).json(outcome);
    } catch (err) {
      handleClioError(err, res);
    }
  }),
);

// DELETE /clio-matters/links/:projectId — unlink a workspace (owner only).
clioMattersRouter.delete(
  "/links/:projectId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, userEmail } = callerOf(res);
    if (!UUID_RE.test(req.params.projectId)) {
      return void res.status(404).json({ detail: WORKSPACE_NOT_FOUND_DETAIL });
    }
    const db = createServerSupabase();
    try {
      const outcome = await unlinkWorkspace(
        db,
        userId,
        userEmail,
        req.params.projectId,
      );
      if (outcome === "unsupported") {
        return void res.status(409).json({ detail: LINKS_UNAVAILABLE_DETAIL });
      }
      if (outcome === "forbidden") {
        return void res
          .status(403)
          .json({ detail: NOT_WORKSPACE_OWNER_DETAIL });
      }
      if (outcome === "not_found") {
        return void res
          .status(404)
          .json({ detail: WORKSPACE_NOT_FOUND_DETAIL });
      }
      res.status(204).send();
    } catch (err) {
      handleClioError(err, res);
    }
  }),
);

// ── Matters ──────────────────────────────────────────────────────────────────

// GET /clio-matters?tab=mine|all&query=&status=open,pending
clioMattersRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = callerOf(res);
    const db = createServerSupabase();
    try {
      res.json(
        await listMatters(db, userId, {
          tab: optionalString(req.query.tab),
          query: optionalString(req.query.query),
          status: optionalString(req.query.status),
        }),
      );
    } catch (err) {
      handleClioError(err, res);
    }
  }),
);

// GET /clio-matters/:matterId — overview, custom fields, financials, and the
// caller-visible workspace link (one payload, so the detail page needs no
// follow-up round-trip for the workspace section).
clioMattersRouter.get(
  "/:matterId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, userEmail } = callerOf(res);
    const db = createServerSupabase();
    try {
      const detail = await getMatterDetail(db, userId, req.params.matterId);
      const link = await getLinkForMatter(
        db,
        userId,
        userEmail,
        req.params.matterId,
      );
      res.json({ ...detail, link });
    } catch (err) {
      handleClioError(err, res);
    }
  }),
);

// GET /clio-matters/:matterId/contacts — key people.
clioMattersRouter.get(
  "/:matterId/contacts",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = callerOf(res);
    const db = createServerSupabase();
    try {
      const contacts = await listRelatedContacts(
        db,
        userId,
        req.params.matterId,
      );
      res.json({ contacts, count: contacts.length });
    } catch (err) {
      handleClioError(err, res);
    }
  }),
);

// GET /clio-matters/:matterId/activities?everyone=true — time entries, the
// caller's own unless `everyone` is set.
clioMattersRouter.get(
  "/:matterId/activities",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = callerOf(res);
    const db = createServerSupabase();
    try {
      res.json(
        await listActivities(db, userId, req.params.matterId, {
          everyone: req.query.everyone === "true",
        }),
      );
    } catch (err) {
      handleClioError(err, res);
    }
  }),
);

// POST /clio-matters/:matterId/workspace — lazily create + link the matter's
// JessicaOS workspace.
clioMattersRouter.post(
  "/:matterId/workspace",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, userEmail } = callerOf(res);
    const db = createServerSupabase();
    try {
      const outcome = await createWorkspaceForMatter(
        db,
        userId,
        userEmail,
        req.params.matterId,
      );
      if (outcome === "unsupported") {
        return void res.status(409).json({ detail: LINKS_UNAVAILABLE_DETAIL });
      }
      if (outcome === "already_linked") {
        return void res.status(409).json({ detail: ALREADY_LINKED_DETAIL });
      }
      if (outcome === "forbidden") {
        return void res
          .status(403)
          .json({ detail: NOT_WORKSPACE_OWNER_DETAIL });
      }
      if (outcome === "not_found") {
        return void res.status(404).json({ detail: "Matter not found." });
      }
      res.status(201).json(outcome);
    } catch (err) {
      handleClioError(err, res);
    }
  }),
);
