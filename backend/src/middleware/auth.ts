import { Request, Response, NextFunction } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerSupabase } from "../lib/supabase";
import {
  isAdmin,
  resolveUserOrganisation,
  type OrganisationPolicies,
} from "../lib/organisations";
import { safeErrorLog } from "../lib/safeError";

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

function summarizeMfaFactors(
  factors: Array<{
    factor_type?: string;
    status?: string;
  }> | null | undefined,
) {
  return (factors ?? []).map((factor) => ({
    type: factor.factor_type ?? "unknown",
    status: factor.status ?? "unknown",
  }));
}

function isLoginMfaBootstrapRoute(req: Request) {
  const path = req.originalUrl.split("?")[0];
  return (
    (req.method === "GET" || req.method === "POST") &&
    (path === "/user/profile" || path === "/users/profile")
  );
}

async function enforceLoginMfaIfEnabled(
  req: Request,
  res: Response,
  admin: SupabaseClient<any, "public", any>,
  token: string,
) {
  if (isLoginMfaBootstrapRoute(req)) return true;

  const { data, error } = await admin
    .from("user_profiles")
    .select("mfa_on_login")
    .eq("user_id", res.locals.userId)
    .maybeSingle();

  if (error) {
    devLog("[auth/mfa] login preference lookup failed", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      error: error.message,
      code: error.code,
    });
    if (error.code === "42703") return true;
    res.status(500).json({ detail: error.message });
    return false;
  }

  const profile = data as { mfa_on_login?: boolean } | null;
  if (profile?.mfa_on_login !== true) return true;

  const { data: assurance, error: assuranceError } =
    await admin.auth.mfa.getAuthenticatorAssuranceLevel(token);

  if (assuranceError) {
    devLog("[auth/mfa] login assurance lookup failed", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      error: assuranceError.message,
    });
    res.status(401).json({ detail: assuranceError.message });
    return false;
  }

  if (assurance.nextLevel === "aal2" && assurance.currentLevel !== "aal2") {
    devLog("[auth/mfa] login verification required", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
    });
    res.status(403).json({
      code: "mfa_verification_required",
      detail: "MFA verification required",
    });
    return false;
  }

  return true;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ detail: "Missing or invalid Authorization header" });
    return;
  }
  const token = auth.slice(7).trim();

  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";

  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ detail: "Server auth is not configured" });
    return;
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data } = await admin.auth.getUser(token);
  if (!data.user) {
    res.status(401).json({ detail: "Invalid or expired token" });
    return;
  }

  res.locals.userId = data.user.id;
  res.locals.userEmail = data.user.email?.toLowerCase() ?? "";
  res.locals.token = token;
  if (!(await enforceLoginMfaIfEnabled(req, res, admin, token))) {
    return;
  }
  next();
}

/**
 * Gate a route to organisation admins. Runs AFTER requireAuth (which populates
 * res.locals.userId). Non-admins and orgless users get a fixed 403 detail; the
 * whole body is wrapped so a rejected async call can never escape as an
 * unhandled rejection or leave the request hanging (docs/DURABLE_LESSONS.md).
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId =
      typeof res.locals.userId === "string" ? res.locals.userId : "";
    if (!userId) {
      res.status(401).json({ detail: "Missing auth session" });
      return;
    }

    const db = createServerSupabase();
    if (!(await isAdmin(db, userId))) {
      res.status(403).json({ detail: "Administrator access is required." });
      return;
    }
    next();
  } catch (err) {
    console.error("[auth/admin] admin check failed", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      error: safeErrorLog(err),
    });
    // Fixed generic detail — raw provider/DB text never reaches the client.
    res.status(500).json({ detail: "Something went wrong. Please try again." });
  }
}

export async function requireMfaIfEnrolled(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = typeof res.locals.token === "string" ? res.locals.token : "";
  if (!token) {
    devLog("[auth/mfa] missing auth session", {
      method: req.method,
      path: req.originalUrl,
    });
    res.status(401).json({ detail: "Missing auth session" });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";

  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ detail: "Server auth is not configured" });
    return;
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data, error } =
    await admin.auth.mfa.getAuthenticatorAssuranceLevel(token);

  if (error) {
    devLog("[auth/mfa] assurance lookup failed", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      error: error.message,
    });
    res.status(401).json({ detail: error.message });
    return;
  }

  devLog("[auth/mfa] assurance level", {
    method: req.method,
    path: req.originalUrl,
    userId: res.locals.userId,
    currentLevel: data.currentLevel,
    nextLevel: data.nextLevel,
    required: data.nextLevel === "aal2" && data.currentLevel !== "aal2",
  });

  if (isDev) {
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    devLog("[auth/mfa] user factors", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      factorCount: userData.user?.factors?.length ?? 0,
      factors: summarizeMfaFactors(userData.user?.factors),
      error: userError?.message ?? null,
    });
  }

  if (data.nextLevel === "aal2" && data.currentLevel !== "aal2") {
    devLog("[auth/mfa] verification required", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
    });
    res.status(403).json({
      code: "mfa_verification_required",
      detail: "MFA verification required",
    });
    return;
  }

  next();
}

/**
 * Gate a member-configurable WRITE route on a firm policy (WS8 PR B). Runs AFTER
 * requireAuth (which populates res.locals.userId). Behaviour:
 *
 *   - Orgless callers and firms whose policy is ON  → next() (unchanged).
 *   - Firms whose policy is OFF                      → fixed 403 `detail`.
 *   - Admins are NOT exempt: an admin's personal-key / personal-connector writes
 *     follow the same member policy (admins manage these on the firm surface).
 *
 * Resilience: the org lookup is reused (resolveUserOrganisation) and, on ANY
 * lookup error, this middleware FAILS OPEN — it logs and calls next() as though
 * the policy were ON. This is deliberate: transiently blocking a member's own
 * writes on a DB hiccup is worse for availability than a brief policy gap, and
 * the whole body is wrapped so a rejection can never escape as an unhandled
 * rejection or leave the request hanging (docs/DURABLE_LESSONS.md). The fixed
 * `detail` string keeps raw provider/DB text away from the client (#22 contract).
 */
export function requireMemberPolicy(
  policy: keyof OrganisationPolicies,
  detail: string,
) {
  return async function requireMemberPolicyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const userId =
      typeof res.locals.userId === "string" ? res.locals.userId : "";
    try {
      const db = createServerSupabase();
      const membership = await resolveUserOrganisation(db, userId);
      // Orgless callers and policy-ON firms: unchanged.
      if (!membership || membership.policies[policy]) {
        next();
        return;
      }
      res.status(403).json({ detail });
    } catch (err) {
      // Deliberate fail-open (see doc comment): availability beats a brief
      // policy gap on a transient lookup failure.
      console.error("[auth/policy] member policy check failed (fail-open)", {
        method: req.method,
        path: req.originalUrl,
        userId,
        policy,
        error: safeErrorLog(err),
      });
      next();
    }
  };
}
