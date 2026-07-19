// Companies House research routes (WS7) — powers the Company Search page.
// Read-only passthroughs over the shared Companies House client/bundle used
// by the chat tools, with per-request key resolution (user BYO key first,
// server env fallback — resolved by getUserApiKeys).
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
  searchCompanies,
} from "../lib/companiesHouse";
import { getCompanyBundle } from "../lib/legalSourcesTools/companiesHouseTools";
import { safeErrorLog } from "../lib/safeError";

export const companiesRouter = Router();

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
      return { status: KEY_MISSING_RESPONSE.status, body: { ...KEY_MISSING_RESPONSE.body } };
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

async function resolveCompaniesHouseKey(userId: string): Promise<string | null> {
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

// GET /companies/:companyNumber/filing-history?page=  (25 filings per page)
companiesRouter.get(
  "/:companyNumber/filing-history",
  requireAuth,
  async (req, res) => {
    try {
      const userId = res.locals.userId as string;
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
      const result = await getFilingHistory(
        apiKey,
        req.params.companyNumber,
        { itemsPerPage, startIndex: (page - 1) * itemsPerPage },
      );
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
    const apiKey = await resolveCompaniesHouseKey(userId);
    if (!apiKey) {
      return void res
        .status(KEY_MISSING_RESPONSE.status)
        .json(KEY_MISSING_RESPONSE.body);
    }
    const bundle = await getCompanyBundle(apiKey, req.params.companyNumber);
    res.json(bundle);
  } catch (err) {
    logAndRespond("get-company", err, res);
  }
});
