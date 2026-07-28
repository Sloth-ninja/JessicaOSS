// Companies House research routes (WS7) — powers the Company Search page.
// Read-only passthroughs over the shared Companies House client/bundle used
// by the chat tools, with per-request key resolution via getUserApiKeys
// (the per-user BYO key always takes precedence; the server env key is the
// shared fallback used only when a user has none — see the CLAUDE.md env
// registry).
//
// Every handler body is wrapped in try/catch: Express 4 does not catch
// rejections from async handlers and Node 22 kills the process on unhandled
// rejections (see docs/DURABLE_LESSONS.md, 2026-07-19). Error responses use
// fixed, friendly `detail` strings only — raw provider errors are logged
// server-side and never reach the client.

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { getUserApiKeys } from "../lib/userApiKeys";
import {
  CompaniesHouseError,
  getFilingHistory,
  normalizeCompanyNumber,
  searchCompanies,
} from "../lib/companiesHouse";
import { getCompanyBundle } from "../lib/legalSourcesTools/companiesHouseTools";
import { safeErrorLog } from "../lib/safeError";
import {
  listCompanySaves,
  recordCompanyView,
  setCompanyStar,
  type CompanySnapshot,
} from "../lib/companySearchSaves";

export const companiesRouter = Router();

// Snapshot field limits for the saves routes (name is stored NOT NULL).
const MAX_COMPANY_NAME = 200;
const MAX_COMPANY_STATUS = 50;

type ViewBodyResult =
  | { ok: true; value: { companyName: string; companyStatus: string | null } }
  | { ok: false; detail: string };

/**
 * Validate the POST /companies/:companyNumber/view body: `companyName` is
 * required, non-empty and ≤200 chars; `companyStatus` is optional and ≤50
 * chars. Exported for unit tests. Never trusts client-supplied ids — the caller
 * id always comes from the authenticated session, not the body.
 */
export function validateViewBody(body: unknown): ViewBodyResult {
  const obj = (body ?? {}) as Record<string, unknown>;

  const rawName = obj.companyName;
  if (typeof rawName !== "string" || !rawName.trim()) {
    return { ok: false, detail: "A company name is required." };
  }
  const companyName = rawName.trim();
  if (companyName.length > MAX_COMPANY_NAME) {
    return { ok: false, detail: "Company name is too long." };
  }

  const statusResult = parseOptionalStatus(obj.companyStatus);
  if (!statusResult.ok) return statusResult;

  return {
    ok: true,
    value: { companyName, companyStatus: statusResult.value },
  };
}

type StarBodyResult =
  | { ok: true; value: { starred: boolean; snapshot?: CompanySnapshot } }
  | { ok: false; detail: string };

/**
 * Validate the PUT /companies/:companyNumber/star body: `starred` is a required
 * boolean; `companyName` (≤200) / `companyStatus` (≤50) are an optional snapshot
 * used to insert a not-yet-saved company on first star. Exported for unit tests.
 */
export function validateStarBody(body: unknown): StarBodyResult {
  const obj = (body ?? {}) as Record<string, unknown>;

  if (typeof obj.starred !== "boolean") {
    return { ok: false, detail: "`starred` must be a boolean." };
  }
  const starred = obj.starred;

  const statusResult = parseOptionalStatus(obj.companyStatus);
  if (!statusResult.ok) return statusResult;

  let snapshot: CompanySnapshot | undefined;
  const rawName = obj.companyName;
  if (rawName !== undefined && rawName !== null) {
    if (typeof rawName !== "string") {
      return { ok: false, detail: "Company name is invalid." };
    }
    const companyName = rawName.trim();
    if (companyName.length > MAX_COMPANY_NAME) {
      return { ok: false, detail: "Company name is too long." };
    }
    if (companyName) {
      snapshot = { companyName, companyStatus: statusResult.value };
    }
  }

  return { ok: true, value: { starred, snapshot } };
}

function parseOptionalStatus(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; detail: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return { ok: false, detail: "Company status is invalid." };
  }
  const status = raw.trim();
  if (status.length > MAX_COMPANY_STATUS) {
    return { ok: false, detail: "Company status is too long." };
  }
  return { ok: true, value: status || null };
}

const KEY_MISSING_RESPONSE = {
  status: 409,
  body: {
    detail: "No Companies House API key is configured.",
    code: "companies_house_key_missing",
  },
} as const;

/**
 * Maps an error thrown by the Companies House client onto a fixed HTTP
 * response. Exported for unit tests. 401 from Companies House means the
 * configured key is invalid — surfaced the same as a missing key so the
 * frontend shows one "key not configured" state. Anything unrecognised is a
 * generic 502 with a FIXED detail — never the raw error text.
 */
export function companiesHouseErrorResponse(err: unknown): {
  status: number;
  body: { detail: string; code?: string };
} {
  if (err instanceof CompaniesHouseError) {
    if (err.status === 401) {
      return {
        status: KEY_MISSING_RESPONSE.status,
        body: { ...KEY_MISSING_RESPONSE.body },
      };
    }
    if (err.status === 404) {
      return {
        status: 404,
        body: { detail: "Company not found on the Companies House register." },
      };
    }
    if (err.status === 429) {
      return {
        status: 429,
        body: {
          detail:
            "Companies House rate limit reached. Please try again in a few minutes.",
        },
      };
    }
  }
  return {
    status: 502,
    body: {
      detail: "Could not reach Companies House. Please try again later.",
    },
  };
}

/**
 * Normalises a company number and rejects anything that isn't strictly
 * alphanumeric after normalisation (returns null). Defensive: the value is
 * interpolated into a Companies House URL path, so crafted input containing
 * path/query metacharacters ("..", "?", "/") must never reach the client.
 * Exported for unit tests.
 */
export function validateCompanyNumber(raw: string): string | null {
  const normalized = normalizeCompanyNumber(raw);
  return /^[A-Z0-9]+$/.test(normalized) ? normalized : null;
}

async function resolveCompaniesHouseKey(
  userId: string,
): Promise<string | null> {
  const apiKeys = await getUserApiKeys(userId, createServerSupabase());
  const key = apiKeys.companies_house;
  return key && key.trim() ? key : null;
}

function logAndRespond(
  scope: string,
  err: unknown,
  res: import("express").Response,
): void {
  const { status, body } = companiesHouseErrorResponse(err);
  console.error(`[companies/${scope}] request failed`, safeErrorLog(err));
  res.status(status).json(body);
}

// GET /companies/search?q=
companiesRouter.get("/search", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      return void res
        .status(400)
        .json({ detail: "A search query is required." });
    }
    const apiKey = await resolveCompaniesHouseKey(userId);
    if (!apiKey) {
      return void res
        .status(KEY_MISSING_RESPONSE.status)
        .json(KEY_MISSING_RESPONSE.body);
    }
    const result = await searchCompanies(apiKey, q);
    res.json(result);
  } catch (err) {
    logAndRespond("search", err, res);
  }
});

// GET /companies/saves — the caller's starred + recent companies for the rail.
// Registered before GET /:companyNumber so "saves" is never read as a company
// number. Best-effort: an unmigrated database yields empty lists, never an
// error (the lib degrades on 42P01/42703).
companiesRouter.get("/saves", requireAuth, async (_req, res) => {
  try {
    const userId = res.locals.userId as string;
    const saves = await listCompanySaves(createServerSupabase(), userId);
    res.json(saves);
  } catch (err) {
    console.error("[companies/saves] request failed", safeErrorLog(err));
    res.status(500).json({ detail: "Could not load your saved companies." });
  }
});

// POST /companies/:companyNumber/view — record a view (best-effort recents).
// Body: { companyName, companyStatus? }. The caller id is always the
// authenticated session, never trusted from the client.
companiesRouter.post("/:companyNumber/view", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const companyNumber = validateCompanyNumber(req.params.companyNumber);
    if (!companyNumber) {
      return void res.status(400).json({ detail: "Invalid company number." });
    }
    const parsed = validateViewBody(req.body);
    if (!parsed.ok) {
      return void res.status(400).json({ detail: parsed.detail });
    }
    await recordCompanyView(createServerSupabase(), userId, {
      companyNumber,
      companyName: parsed.value.companyName,
      companyStatus: parsed.value.companyStatus,
    });
    res.status(204).end();
  } catch (err) {
    console.error("[companies/view] request failed", safeErrorLog(err));
    res.status(500).json({ detail: "Could not record this view." });
  }
});

// PUT /companies/:companyNumber/star — set/clear the starred flag.
// Body: { starred: boolean, companyName?, companyStatus? } (the snapshot lets a
// not-yet-saved company be inserted on first star).
companiesRouter.put("/:companyNumber/star", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const companyNumber = validateCompanyNumber(req.params.companyNumber);
    if (!companyNumber) {
      return void res.status(400).json({ detail: "Invalid company number." });
    }
    const parsed = validateStarBody(req.body);
    if (!parsed.ok) {
      return void res.status(400).json({ detail: parsed.detail });
    }
    await setCompanyStar(
      createServerSupabase(),
      userId,
      companyNumber,
      parsed.value.starred,
      parsed.value.snapshot,
    );
    res.status(204).end();
  } catch (err) {
    console.error("[companies/star] request failed", safeErrorLog(err));
    res.status(500).json({ detail: "Could not update this company." });
  }
});

// GET /companies/:companyNumber/filing-history?page=  (25 filings per page)
companiesRouter.get(
  "/:companyNumber/filing-history",
  requireAuth,
  async (req, res) => {
    try {
      const userId = res.locals.userId as string;
      const companyNumber = validateCompanyNumber(req.params.companyNumber);
      if (!companyNumber) {
        return void res.status(400).json({ detail: "Invalid company number." });
      }
      const pageRaw = Number.parseInt(String(req.query.page ?? "1"), 10);
      const page =
        Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
      const itemsPerPage = 25;
      const apiKey = await resolveCompaniesHouseKey(userId);
      if (!apiKey) {
        return void res
          .status(KEY_MISSING_RESPONSE.status)
          .json(KEY_MISSING_RESPONSE.body);
      }
      const result = await getFilingHistory(apiKey, companyNumber, {
        itemsPerPage,
        startIndex: (page - 1) * itemsPerPage,
      });
      res.json(result);
    } catch (err) {
      logAndRespond("filing-history", err, res);
    }
  },
);

// GET /companies/:companyNumber — profile + officers + PSCs bundle
// (the CompanyPanelData shape the frontend CompanyPanel consumes).
companiesRouter.get("/:companyNumber", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const companyNumber = validateCompanyNumber(req.params.companyNumber);
    if (!companyNumber) {
      return void res.status(400).json({ detail: "Invalid company number." });
    }
    const apiKey = await resolveCompaniesHouseKey(userId);
    if (!apiKey) {
      return void res
        .status(KEY_MISSING_RESPONSE.status)
        .json(KEY_MISSING_RESPONSE.body);
    }
    const bundle = await getCompanyBundle(apiKey, companyNumber);
    res.json(bundle);
  } catch (err) {
    logAndRespond("get-company", err, res);
  }
});
