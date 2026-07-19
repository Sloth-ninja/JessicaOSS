import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import {
  extractCitations,
  type ExtractedCitation,
} from "../lib/citationExtraction";
import { verifyCitation } from "../lib/legislation";
import { safeErrorLog } from "../lib/safeError";

export const citationsRouter = Router();

// Request/response caps: a paste-in draft, not a bulk API. Text above the cap
// is rejected outright (413); citations beyond the cap are silently dropped
// (50 sequential lookups already take ~1 minute at the politeness rate).
//
// The 20k text cap is a ReDoS mitigation, not just a UX bound: the ported
// ACT_TITLE regex (kept byte-identical to evals/src/citations.ts per the sync
// mandate) is O(n²), and extraction runs synchronously before the first await
// — a pathological 100k paste blocked the event loop ~6.7s (stalling every
// request, including SSE chat). At 20k the worst case stays well under ~0.5s.
// A future synced regex fix in both suites remains the proper cure.
const MAX_TEXT_LENGTH = 20_000;
const MAX_CITATIONS_PER_REQUEST = 50;

// Fixed copy required by the WS7 plan — do not reword without owner sign-off.
const CASE_LAW_REASON =
  "Case-law citations cannot be verified: Find Case Law integration is deferred pending The National Archives' computational-use licence, and BAILII must never be used. Check an authorised source.";

type CitationCheckResult = {
  raw: string;
  kind: ExtractedCitation["kind"];
  status: "verified" | "unverified" | "unverifiable";
  url?: string;
  reason?: string;
};

// POST /citations/check — extract statutory citations from pasted text and
// verify each against live legislation.gov.uk.
citationsRouter.post("/check", requireAuth, async (req, res) => {
  // Whole handler is try/catch-wrapped: Express 4 does not catch async
  // rejections and Node 22 kills the process on them (DURABLE_LESSONS
  // 2026-07-19). The catch returns a FIXED generic detail only.
  try {
    const { text } = (req.body ?? {}) as { text?: unknown };
    if (typeof text !== "string" || !text.trim()) {
      return res
        .status(400)
        .json({ detail: "Provide the text to check as { text }." });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(413).json({
        detail:
          "That text is too long to check in one go (20,000 character limit). Split the draft and check it in parts.",
      });
    }

    const citations = extractCitations(text).slice(
      0,
      MAX_CITATIONS_PER_REQUEST,
    );

    const results: CitationCheckResult[] = [];
    // Deliberately SEQUENTIAL: verifyCitation goes through legislation.ts's
    // politeness token bucket (~1 req/s) — parallelising here would just
    // queue on the bucket while holding more memory, and keeps ordering
    // stable for the UI.
    //
    // Conscious trade-off: that bucket is GLOBAL to the legislation.gov.uk
    // client, shared with the chat tools' legislation lookups — one
    // 50-citation check can queue chat lookups for tens of seconds. This is
    // by design: politeness to the upstream host requires a single bucket.
    for (const citation of citations) {
      if (citation.kind === "neutral-case") {
        results.push({
          raw: citation.raw,
          kind: citation.kind,
          status: "unverifiable",
          reason: CASE_LAW_REASON,
        });
        continue;
      }
      const verified = await verifyCitation(citation.raw);
      if (verified.resolved) {
        results.push({
          raw: citation.raw,
          kind: citation.kind,
          status: "verified",
          url: verified.url,
        });
      } else {
        results.push({
          raw: citation.raw,
          kind: citation.kind,
          status: "unverified",
          reason: verified.reason,
        });
      }
    }

    return res.json({ results });
  } catch (err) {
    console.error("[citations] check failed", safeErrorLog(err));
    return res
      .status(500)
      .json({ detail: "Citation check failed. Please try again." });
  }
});
