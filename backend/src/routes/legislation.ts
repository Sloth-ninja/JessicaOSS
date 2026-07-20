// Legislation research routes (WS7) — powers the Research › Legislation page.
// Thin read-only wrappers over the already-tested legislation.gov.uk client in
// lib/legislation.ts (search + lookupCitation). No key gating: legislation.gov.uk
// is a fully open API (Open Government Licence), so unlike Company Search there
// is nothing to configure.
//
// Every handler body is wrapped in try/catch: Express 4 does not catch
// rejections from async handlers and Node 22 kills the process on unhandled
// rejections (see docs/DURABLE_LESSONS.md, 2026-07-19). Error responses use
// fixed, friendly `detail` strings only — raw errors are logged server-side
// and never reach the client.
//
// A failed citation lookup is a DOMAIN RESULT, not an error: an unparseable or
// unresolvable citation returns HTTP 200 { resolved:false, citation, reason }.
// Only an unexpected throw (network/parse crash inside the lib) yields a 5xx.

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { search, lookupCitation } from "../lib/legislation";
import { safeErrorLog } from "../lib/safeError";

export const legislationRouter = Router();

// GET /legislation/search?title= — free-text Act/SI title search.
legislationRouter.get("/search", requireAuth, async (req, res) => {
  try {
    const title =
      typeof req.query.title === "string" ? req.query.title.trim() : "";
    if (!title) {
      return void res
        .status(400)
        .json({ detail: "A legislation title to search for is required." });
    }
    const matches = await search(title);
    res.json({ matches });
  } catch (err) {
    console.error("[legislation/search] request failed", safeErrorLog(err));
    res.status(502).json({
      detail: "Could not reach legislation.gov.uk. Please try again later.",
    });
  }
});

// GET /legislation/lookup?citation= — parse + resolve + fetch a natural-language
// UK statutory citation (e.g. "s.994 Companies Act 2006"). The success payload
// uses the same snake_case field names the chat tool emits (legislationTools.ts)
// so the shared LegislationPanel props line up on the frontend.
legislationRouter.get("/lookup", requireAuth, async (req, res) => {
  try {
    const citation =
      typeof req.query.citation === "string" ? req.query.citation.trim() : "";
    if (!citation) {
      return void res
        .status(400)
        .json({ detail: "A citation to look up is required." });
    }
    const result = await lookupCitation(citation);
    if (!result.resolved) {
      // Domain result, not an error: HTTP 200 with the reason so the UI can
      // explain why the citation could not be resolved.
      return void res.json({
        resolved: false,
        citation: result.citation,
        reason: result.reason,
      });
    }
    res.json({
      resolved: true,
      title: result.title,
      url: result.canonicalUrl,
      heading: result.heading,
      text: result.text,
      extent: result.extent,
      outstanding_effects: result.outstandingEffects,
      unapplied_effects: result.unappliedEffects,
    });
  } catch (err) {
    console.error("[legislation/lookup] request failed", safeErrorLog(err));
    res.status(502).json({
      detail: "Could not reach legislation.gov.uk. Please try again later.",
    });
  }
});
