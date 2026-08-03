// Clio connector routes. Two routers built by the same factory and mounted at
// `/clio` (Manage) and `/clio-grow` (Grow) in index.ts — the OAuth callback
// paths therefore equal the exact registered redirect URIs
// (`/clio/oauth/callback`, `/clio-grow/oauth/callback`).
//
// Per product:
//   GET  /oauth/start      (auth)            → { authorizationUrl }
//   GET  /oauth/callback   (no auth)         → redirect to the connectors page
// Shared (product-agnostic, reachable under either mount):
//   GET  /status           (auth)            → { manage, grow } connection state
//   POST /:product/disconnect (auth + MFA)   → best-effort deauthorize + delete
//
// Every handler guarantees a response (asyncHandler or a whole-body try/catch)
// and returns fixed, generic error `detail`s — raw Clio/DB text is only logged
// server-side, redacted (docs/DURABLE_LESSONS.md, #22/#33 contract).

import { Router } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { createServerSupabase } from "../lib/supabase";
import { safeErrorLog } from "../lib/safeError";
import { clioConfigured, type ClioProduct } from "../lib/clio/config";
import {
  deauthorizeClio,
  startClioOAuth,
  completeClioOAuth,
  ClioOAuthError,
} from "../lib/clio/oauth";
import {
  deleteClioConnection,
  getClioConnectionSummaries,
  loadClioConnection,
} from "../lib/clio/connections";
import { clioRequest } from "../lib/clio/client";

function frontendConnectorsUrl(params: Record<string, string>): string {
  const base = (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
  const url = new URL(`${base}/account/connectors`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * Best-effort cheap count of matters the user can see (Manage only). Reads
 * `meta.records` from a 1-row page rather than paginating. Returns undefined on
 * any error so the status payload simply omits the count — never fails status.
 */
async function manageMattersVisible(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
): Promise<number | undefined> {
  try {
    const body = (await clioRequest(db, userId, "manage", "/matters.json", {
      fields: "id",
      query: { limit: 1 },
    })) as { meta?: { records?: unknown } } | null;
    const records = body?.meta?.records;
    return typeof records === "number" ? records : undefined;
  } catch {
    return undefined;
  }
}

function isProduct(value: string): value is ClioProduct {
  return value === "manage" || value === "grow";
}

/**
 * Build a Clio router bound to a product for its OAuth legs. Status and
 * disconnect are product-agnostic (status reports both; disconnect takes a
 * `:product` param), so both mounts expose them identically.
 */
export function createClioRouter(product: ClioProduct): Router {
  const router = Router();

  // GET /oauth/start — mint an authorize URL for this product.
  router.get(
    "/oauth/start",
    requireAuth,
    asyncHandler(async (_req, res) => {
      const userId = res.locals.userId as string;
      if (!clioConfigured(product)) {
        return void res
          .status(503)
          .json({ detail: "Clio is not configured on this server." });
      }
      try {
        const { authorizationUrl } = startClioOAuth(userId, product);
        res.json({ authorizationUrl });
      } catch (err) {
        console.error("[clio/oauth/start] failed", {
          product,
          error: safeErrorLog(err),
        });
        res.status(400).json({
          detail: "Could not start connecting Clio. Please try again.",
        });
      }
    }),
  );

  // GET /oauth/callback — Clio redirects the browser here (no bearer). Validate
  // state + code, complete the exchange, and bounce back to the connectors page.
  router.get(
    "/oauth/callback",
    asyncHandler(async (req, res) => {
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const code = typeof req.query.code === "string" ? req.query.code : "";
      const oauthError =
        typeof req.query.error === "string" ? req.query.error : "";
      const db = createServerSupabase();
      try {
        if (oauthError) throw new ClioOAuthError();
        await completeClioOAuth(product, state, code, db);
        res.redirect(
          frontendConnectorsUrl({ clio: product, clioStatus: "connected" }),
        );
      } catch (err) {
        console.error("[clio/oauth/callback] failed", {
          product,
          hasCode: !!code,
          error: safeErrorLog(err),
        });
        res.redirect(
          frontendConnectorsUrl({ clio: product, clioStatus: "error" }),
        );
      }
    }),
  );

  // GET /status — connection state for BOTH products (+ cheap Manage count).
  router.get(
    "/status",
    requireAuth,
    asyncHandler(async (_req, res) => {
      const userId = res.locals.userId as string;
      const db = createServerSupabase();
      const summaries = await getClioConnectionSummaries(db, userId);
      let mattersVisible: number | undefined;
      if (summaries.manage.connected) {
        mattersVisible = await manageMattersVisible(db, userId);
      }
      res.json({
        manage: {
          ...summaries.manage,
          configured: clioConfigured("manage"),
          ...(mattersVisible !== undefined ? { mattersVisible } : {}),
        },
        grow: {
          ...summaries.grow,
          configured: clioConfigured("grow"),
        },
      });
    }),
  );

  // POST /:product/disconnect — MFA-gated, like other sensitive account ops.
  router.post(
    "/:product/disconnect",
    requireAuth,
    requireMfaIfEnrolled,
    asyncHandler(async (req, res) => {
      const userId = res.locals.userId as string;
      const target = req.params.product;
      if (!isProduct(target)) {
        return void res.status(400).json({ detail: "Unknown Clio product." });
      }
      const db = createServerSupabase();
      // Best-effort remote deauthorize using the stored token BEFORE deleting
      // the row — a clean disconnect must revoke the grant so a reconnect after
      // a permissions change does not silently reuse the stale grant. Local
      // deletion proceeds even if the revoke fails.
      try {
        const connection = await loadClioConnection(db, userId, target);
        if (connection) {
          await deauthorizeClio(target, connection.tokens.accessToken);
        }
      } catch (err) {
        console.error("[clio/disconnect] deauthorize step failed", {
          product: target,
          error: safeErrorLog(err),
        });
      }
      await deleteClioConnection(db, userId, target);
      res.json({ ok: true });
    }),
  );

  return router;
}

export const clioManageRouter = createClioRouter("manage");
export const clioGrowRouter = createClioRouter("grow");
