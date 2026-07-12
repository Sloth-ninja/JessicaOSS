/**
 * LLM tool surface for legislation.gov.uk (WS2 — docs/MIGRATION_SPEC.md §4).
 * Mirrors the shape of the old CourtListener verify-citations pattern per the
 * migration spec, with `legislation_uri` in place of `cluster_id`.
 */
import {
  lookupCitation,
  verifyCitation,
  search,
  type LegislationLookupResult,
} from "../legislation";
import type { OpenAIToolSchema } from "../llm";

export type LegislationToolEvent = {
  type: "legislation_tool_call";
  tool_name: string;
  status: "ok" | "error";
  error?: string;
  title?: string;
  url?: string;
  outstanding_effects?: boolean;
  /** Structured payload for the side panel (provision text/heading/extent/flags) — set on a successful lookup. */
  provision?: unknown;
};

export const LEGISLATION_TOOLS: OpenAIToolSchema[] = [
  {
    type: "function",
    function: {
      name: "legislation_lookup",
      description:
        'Look up a UK statutory provision on legislation.gov.uk from a natural citation, e.g. "s.994 Companies Act 2006", "reg 3 TUPE Regulations 2006", "SI 2006/246", or "Employment Rights Act 1996, s 98". Returns the provision text, heading, canonical URL, and a warning if the text carries outstanding (not-yet-applied) amendments.',
      parameters: {
        type: "object",
        properties: {
          citation: {
            type: "string",
            description:
              'A UK statutory citation in natural form, e.g. "s.994 Companies Act 2006".',
          },
        },
        required: ["citation"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "legislation_search",
      description:
        "Search legislation.gov.uk by title for an Act or Statutory Instrument when you don't have an exact citation — e.g. to find the correct short title or year for a regulation before looking it up.",
      parameters: {
        type: "object",
        properties: {
          title_query: {
            type: "string",
            description:
              'Full or partial title to search for, e.g. "Transfer of Undertakings".',
          },
        },
        required: ["title_query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "legislation_verify_citations",
      description:
        "Verify a batch of UK statutory citations against legislation.gov.uk before finalising an answer. Run this over every statutory reference you intend to cite. Returns, per citation, whether it resolved and its canonical URL, or the reason it did not.",
      parameters: {
        type: "object",
        properties: {
          citations: {
            type: "array",
            items: { type: "string" },
            description:
              "UK statutory citations to verify, in the same natural form used in your draft answer.",
          },
        },
        required: ["citations"],
      },
    },
  },
];

export const LEGISLATION_SYSTEM_PROMPT = `UK LEGISLATION RESEARCH:
- You have access to legislation.gov.uk (Acts of Parliament and Statutory Instruments) via legislation_lookup, legislation_search, and legislation_verify_citations. This is an official, verifiable source — not general knowledge, and not a substitute for it when it disagrees.
- Cite UK statutes in the standard UK style: "s.994 Companies Act 2006" for Act sections; Statutory Instruments as "SI 2006/246" or by name, e.g. "reg 4 of the Transfer of Undertakings (Protection of Employment) Regulations 2006 (SI 2006/246)".
- Before finalising any answer that cites a statutory provision, call legislation_verify_citations with every statutory reference you intend to use. Drop or correct any citation that fails to resolve — never present an unverified statutory citation as though it were confirmed.
- When a looked-up provision carries an outstanding-amendments warning (amendments not yet applied to the published text), tell the user explicitly and do not present the text as fully up to date.
- You have NO source for case law. Find Case Law (The National Archives) integration is deferred pending a computational-use licence, and BAILII must never be used or cited. Do not cite or invent case authority (neutral citations such as "[2024] UKSC 12") — you cannot verify it. If case law would help answer the question, say so plainly and recommend the solicitor check an authorised source themselves.`;

function formatLookupContent(
  citation: string,
  result: LegislationLookupResult,
): string {
  if (!result.resolved) {
    return JSON.stringify({ resolved: false, citation, reason: result.reason });
  }
  return JSON.stringify({
    resolved: true,
    title: result.title,
    url: result.canonicalUrl,
    heading: result.heading,
    extent: result.extent,
    outstanding_effects: result.outstandingEffects,
    unapplied_effects: result.unappliedEffects,
    text: result.text,
  });
}

async function runLookup(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; event: LegislationToolEvent }> {
  const citation = typeof args.citation === "string" ? args.citation : "";
  const result = await lookupCitation(citation);
  const content = formatLookupContent(citation, result);
  if (!result.resolved) {
    return {
      content,
      event: {
        type: "legislation_tool_call",
        tool_name: name,
        status: "error",
        error: result.reason,
      },
    };
  }
  return {
    content,
    event: {
      type: "legislation_tool_call",
      tool_name: name,
      status: "ok",
      title: result.title,
      url: result.canonicalUrl,
      outstanding_effects: result.outstandingEffects,
      provision: {
        heading: result.heading,
        text: result.text,
        extent: result.extent,
        unappliedEffects: result.unappliedEffects,
      },
    },
  };
}

async function runSearch(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; event: LegislationToolEvent }> {
  const titleQuery =
    typeof args.title_query === "string" ? args.title_query : "";
  try {
    const matches = await search(titleQuery);
    return {
      content: JSON.stringify({ query: titleQuery, matches }),
      event: {
        type: "legislation_tool_call",
        tool_name: name,
        status: "ok",
        title: titleQuery,
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      content: JSON.stringify({ query: titleQuery, matches: [], error }),
      event: {
        type: "legislation_tool_call",
        tool_name: name,
        status: "error",
        error,
      },
    };
  }
}

async function runVerifyCitations(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; event: LegislationToolEvent }> {
  const citations = Array.isArray(args.citations)
    ? args.citations.filter((c): c is string => typeof c === "string")
    : [];
  const results = await Promise.all(citations.map((c) => verifyCitation(c)));
  const failed = results.filter((r) => !r.resolved);
  return {
    content: JSON.stringify({ results }),
    event: {
      type: "legislation_tool_call",
      tool_name: name,
      status: failed.length === 0 ? "ok" : "error",
      error:
        failed.length === 0
          ? undefined
          : failed
              .map((r) => `${r.citation}: ${r.reason ?? "unresolved"}`)
              .join("; "),
    },
  };
}

/**
 * Execute a `legislation_*` tool call. Never throws: every failure mode is
 * captured in the returned event/content so the chat loop can keep going.
 */
export async function executeLegislationToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; event: LegislationToolEvent }> {
  if (name === "legislation_lookup") return runLookup(name, args);
  if (name === "legislation_search") return runSearch(name, args);
  if (name === "legislation_verify_citations")
    return runVerifyCitations(name, args);

  const error = `Unknown legislation tool "${name}".`;
  return {
    content: JSON.stringify({ error }),
    event: {
      type: "legislation_tool_call",
      tool_name: name,
      status: "error",
      error,
    },
  };
}
