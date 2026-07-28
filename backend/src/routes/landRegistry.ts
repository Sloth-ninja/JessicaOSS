// Land Registry research routes (WS7) — powers the Research › Land Registry
// page. Read-only wrapper over the open-data Price Paid client in
// lib/landRegistry.ts. No key gating: HM Land Registry Price Paid is fully open
// data (Open Government Licence v3.0), so unlike Company Search there is nothing
// to configure. v1 has NO account-connection path by design — Business Gateway
// requires channel-partner authorisation (CLAUDE.md data integration 4), so no
// HMLR credential ever reaches this backend.
//
// Every handler body is wrapped in try/catch: Express 4 does not catch
// rejections from async handlers and Node 22 kills the process on unhandled
// rejections (see docs/DURABLE_LESSONS.md, 2026-07-19). Error responses use
// fixed, friendly `detail` strings only — raw upstream errors are logged
// server-side and never reach the client.

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getPricePaidByPostcode, LandRegistryError } from "../lib/landRegistry";
import { safeErrorLog } from "../lib/safeError";

export const landRegistryRouter = Router();

/**
 * Maps an error from the Land Registry client onto a fixed HTTP response. A
 * validation failure (invalid postcode) is a 400 with a fixed detail; anything
 * else is a generic 502 — never the raw error text. Exported for unit tests.
 */
export function landRegistryErrorResponse(err: unknown): {
  status: number;
  body: { detail: string };
} {
  if (err instanceof LandRegistryError && err.status === 400) {
    return { status: 400, body: { detail: "Enter a valid UK postcode." } };
  }
  return {
    status: 502,
    body: {
      detail: "Could not reach HM Land Registry. Please try again later.",
    },
  };
}

// GET /land-registry/price-paid?postcode= — sold-price history for a postcode.
landRegistryRouter.get("/price-paid", requireAuth, async (req, res) => {
  try {
    const postcode =
      typeof req.query.postcode === "string" ? req.query.postcode.trim() : "";
    if (!postcode) {
      return void res.status(400).json({ detail: "A postcode is required." });
    }
    const entries = await getPricePaidByPostcode(postcode);
    res.json({ entries });
  } catch (err) {
    const { status, body } = landRegistryErrorResponse(err);
    console.error(
      "[land-registry/price-paid] request failed",
      safeErrorLog(err),
    );
    res.status(status).json(body);
  }
});
