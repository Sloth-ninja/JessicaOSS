import { Router } from "express";
import type { Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { createServerSupabase } from "../lib/supabase";
import { ClioApiError } from "../lib/clio/client";
import { minutesToSeconds } from "../lib/clio/manageTools";
import { ClioValidationError } from "../lib/clio/toolShared";
import {
  areLinksAvailable,
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
 * Auth is router-level (`use(requireAuth, …)` below, so it cannot be forgotten
 * on a future route) and every handler is asyncHandler-wrapped. Reads use the
 * CALLER's own Clio token, so matter visibility is exactly what that
 * solicitor's Clio login allows — no firm token, no cross-user read path.
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

// ── Rate limiting ────────────────────────────────────────────────────────────
//
// This bucket is keyed PER USER, not per IP, and therefore lives here rather
// than alongside the other limiters in index.ts: an app-level limiter runs
// before any route's auth, so `res.locals.userId` is not populated yet.
//
// The distinction matters commercially — the pilot firm NATs its whole office
// through one address, so an IP-keyed bucket counts the whole office as one
// caller. `/clio-matters` is therefore EXEMPTED from the app-level general
// limiter in index.ts; without that exemption the shared 300-per-15-minutes IP
// allowance would still bind first, and a couple of solicitors browsing matters
// would degrade every other route for their colleagues. IP is kept here only as
// the pre-auth fallback (a request that somehow reaches the limiter before auth
// has populated `res.locals.userId`).
//
// Clio's own 50 req/min per-user token budget is the real constraint; this only
// stops a runaway client burning it.

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const clioMattersLimiter = rateLimit({
  windowMs: envInt("RATE_LIMIT_CLIO_MATTERS_WINDOW_MINUTES", 15) * 60 * 1000,
  max: envInt("RATE_LIMIT_CLIO_MATTERS_MAX", 300),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  // Namespaced so a user id can never collide with an address literal.
  keyGenerator: (req: Request, res: Response) => {
    const userId = res.locals.userId as string | undefined;
    if (userId) return `user:${userId}`;
    // Unreachable in practice: requireAuth is mounted ahead of this limiter on
    // the same router and 401s before it when there is no session, so
    // res.locals.userId is always populated by the time we get here. Kept as a
    // pre-auth belt, and routed through `ipKeyGenerator` because a raw req.ip
    // gives every address in an IPv6 /64 its own bucket — one client can hold
    // trillions, so the limit would be trivially bypassable. Passing req.ip
    // straight through is what express-rate-limit refuses as
    // ERR_ERL_KEY_GEN_IPV6 (observed in the route suite before this change).
    return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : "ip:unknown";
  },
  message: {
    detail: "Too many Clio requests. Please try again shortly.",
  },
});

// Router-level, in this order, so the limiter can see the authenticated user.
// This covers EVERY route below (including any added later) — the individual
// handlers therefore do not repeat `requireAuth`.
clioMattersRouter.use(requireAuth, clioMattersLimiter);

// Workspace ids are uuids; a malformed one 404s here rather than reaching
// Postgres, where it would raise 22P02 and surface as a generic 500.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WORKSPACE_NOT_FOUND_DETAIL = "Workspace not found.";
const LINKS_UNAVAILABLE_DETAIL =
  "Linking a workspace to a Clio matter is not available yet.";
const ALREADY_LINKED_DETAIL = "That matter already has a linked workspace.";
// The other side of the same relationship — the workspace, not the matter, is
// the one already spoken for. Distinct copy so the user knows which to change.
const WORKSPACE_ALREADY_LINKED_DETAIL =
  "That workspace is already linked to a Clio matter.";
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
      if (outcome === "workspace_already_linked") {
        return void res
          .status(409)
          .json({ detail: WORKSPACE_ALREADY_LINKED_DETAIL });
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
  asyncHandler(async (req, res) => {
    const { userId } = callerOf(res);
    const db = createServerSupabase();
    try {
      const list = await listMatters(db, userId, {
        tab: optionalString(req.query.tab),
        query: optionalString(req.query.query),
        status: optionalString(req.query.status),
      });
      // Carried on the list too, not just on the detail: the "Link to a Clio
      // matter" affordance lives on the Matters page and in the link picker,
      // neither of which loads a matter detail. Probed here rather than inside
      // the seam because the list itself is cached for 60s and a capability
      // must not be.
      res.json({ ...list, linksUnavailable: !(await areLinksAvailable(db)) });
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
      // "No link" and "linking does not exist here yet" are distinct: the
      // second must stop the page offering to start a workspace at all, so it
      // travels as its own flag rather than as an indistinguishable null.
      const linksUnavailable = link === "unsupported";
      res.json({
        ...detail,
        link: linksUnavailable ? null : link,
        linksUnavailable,
      });
    } catch (err) {
      handleClioError(err, res);
    }
  }),
);

// GET /clio-matters/:matterId/contacts — key people.
clioMattersRouter.get(
  "/:matterId/contacts",
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
      if (outcome === "workspace_already_linked") {
        return void res
          .status(409)
          .json({ detail: WORKSPACE_ALREADY_LINKED_DETAIL });
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
