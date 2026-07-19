// LLM tool definitions + system prompt + executor for the Companies House
// integration (WS1, docs/MIGRATION_SPEC.md §3). Wired into the chat engine
// through the `researchTools` seam in chatTools.ts, gated on whether the
// caller has a Companies House API key configured (per-user or server env).

import {
  CompaniesHouseError,
  getCompanyOfficers,
  getCompanyPSCs,
  getCompanyProfile,
  getFilingHistory,
  normalizeCompanyNumber,
  searchCompanies,
} from "../companiesHouse";
import type { OpenAIToolSchema } from "../llm";

export const COMPANIES_HOUSE_TOOLS: OpenAIToolSchema[] = [
  {
    type: "function",
    function: {
      name: "companies_house_search_companies",
      description:
        "Search the UK Companies House public register for companies by name. Returns each match's company name, number, status, and registered address. Use this to find a company's number when the user only gives you a name.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Company name or partial name to search for.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "companies_house_get_company",
      description:
        "Fetch a UK company's full record from Companies House in one call: profile (status, company type, incorporation date, registered office, SIC codes, accounts and confirmation-statement due dates), officers (directors/secretaries, active and resigned), and persons with significant control (PSCs). Company numbers are 8 characters, may be zero-padded, and may carry a jurisdiction prefix (e.g. SC for Scotland, NI for Northern Ireland).",
      parameters: {
        type: "object",
        properties: {
          company_number: {
            type: "string",
            description: "The company number, e.g. '13927967' or 'SC012345'.",
          },
        },
        required: ["company_number"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "companies_house_get_filing_history",
      description:
        "Fetch a UK company's filing history from Companies House (e.g. confirmation statements, accounts, officer changes). Paginated at 25 filings per page — pass `page` (1-based) for subsequent pages.",
      parameters: {
        type: "object",
        properties: {
          company_number: {
            type: "string",
            description: "The company number, e.g. '13927967'.",
          },
          page: {
            type: "integer",
            description: "1-based page number. Defaults to 1.",
          },
        },
        required: ["company_number"],
      },
    },
  },
];

export const COMPANIES_HOUSE_SYSTEM_PROMPT = `COMPANIES HOUSE (UK COMPANY DATA):
- You have tools to search and read the UK Companies House public register: companies_house_search_companies, companies_house_get_company, companies_house_get_filing_history.
- Company numbers are 8 characters. They may be zero-padded (e.g. "123" is registered as "00000123") and may carry a jurisdiction prefix (SC = Scotland, NI = Northern Ireland, OC = LLP, and others).
- ALWAYS state the company number and the retrieval date alongside any Companies House data you report, e.g. "Company no. 13927967, Companies House data retrieved 08/07/2026."
- This data comes from the public Companies House register (Crown copyright, Open Government Licence) — reporting it is not itself legal advice.
- If a tool call fails with a rate-limit error, stop making further Companies House calls for the rest of this turn and tell the user what you found so far.`;

export type CompaniesHouseToolEvent = {
  type: "companies_house_tool_call";
  tool_name: string;
  status: "ok" | "error";
  error?: string;
  company_number?: string;
  company_name?: string;
  /** Full structured payload (profile/officers/PSCs) — only set on get_company. */
  company?: unknown;
};

function errorMessageOf(err: unknown): string {
  if (err instanceof CompaniesHouseError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function errorResult(
  toolName: string,
  message: string,
  extra?: { company_number?: string },
): { content: string; event: CompaniesHouseToolEvent } {
  return {
    content: JSON.stringify({ error: message }),
    event: {
      type: "companies_house_tool_call",
      tool_name: toolName,
      status: "error",
      error: message,
      ...extra,
    },
  };
}

async function executeSearchCompanies(
  args: Record<string, unknown>,
  apiKey: string,
): Promise<{ content: string; event: CompaniesHouseToolEvent }> {
  const toolName = "companies_house_search_companies";
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return errorResult(toolName, "A search query is required.");
  }
  const result = await searchCompanies(apiKey, query);
  return {
    content: JSON.stringify(result),
    event: {
      type: "companies_house_tool_call",
      tool_name: toolName,
      status: "ok",
    },
  };
}

export type CompanyBundle = {
  company_number: string;
  retrieved_at: string;
  profile: unknown;
  officers: unknown;
  psc: unknown;
};

/**
 * Fetches a company's profile, officers, and PSCs in one aggregated bundle.
 * Shared by the chat tool (companies_house_get_company) and the /companies
 * route so both surfaces return the same shape. Officer/PSC failures degrade
 * gracefully — the profile is the core signal, so a rate-limit or transient
 * failure on the supplementary calls shouldn't blank out an otherwise-
 * successful lookup. A profile failure still rejects the whole call.
 */
export async function getCompanyBundle(
  apiKey: string,
  companyNumberRaw: string,
): Promise<CompanyBundle> {
  const companyNumber = normalizeCompanyNumber(companyNumberRaw);

  const profile = await getCompanyProfile(apiKey, companyNumber);

  const [officers, psc] = await Promise.all([
    getCompanyOfficers(apiKey, companyNumber).catch((err) => ({
      error: errorMessageOf(err),
    })),
    getCompanyPSCs(apiKey, companyNumber).catch((err) => ({
      error: errorMessageOf(err),
    })),
  ]);

  return {
    company_number: companyNumber,
    retrieved_at: new Date().toISOString(),
    profile,
    officers,
    psc,
  };
}

async function executeGetCompany(
  args: Record<string, unknown>,
  apiKey: string,
): Promise<{ content: string; event: CompaniesHouseToolEvent }> {
  const toolName = "companies_house_get_company";
  const companyNumberRaw =
    typeof args.company_number === "string" ? args.company_number : "";
  if (!companyNumberRaw.trim()) {
    return errorResult(toolName, "A company_number is required.");
  }

  const payload = await getCompanyBundle(apiKey, companyNumberRaw);
  const companyName = (payload.profile as Record<string, unknown> | undefined)
    ?.company_name as string | undefined;

  return {
    content: JSON.stringify(payload),
    event: {
      type: "companies_house_tool_call",
      tool_name: toolName,
      status: "ok",
      company_number: payload.company_number,
      company_name: companyName,
      company: payload,
    },
  };
}

async function executeGetFilingHistory(
  args: Record<string, unknown>,
  apiKey: string,
): Promise<{ content: string; event: CompaniesHouseToolEvent }> {
  const toolName = "companies_house_get_filing_history";
  const companyNumberRaw =
    typeof args.company_number === "string" ? args.company_number : "";
  if (!companyNumberRaw.trim()) {
    return errorResult(toolName, "A company_number is required.");
  }
  const companyNumber = normalizeCompanyNumber(companyNumberRaw);
  const page =
    typeof args.page === "number" && Number.isFinite(args.page)
      ? Math.max(1, Math.floor(args.page))
      : 1;
  const itemsPerPage = 25;
  const startIndex = (page - 1) * itemsPerPage;

  const result = await getFilingHistory(apiKey, companyNumber, {
    itemsPerPage,
    startIndex,
  });

  return {
    content: JSON.stringify(result),
    event: {
      type: "companies_house_tool_call",
      tool_name: toolName,
      status: "ok",
      company_number: companyNumber,
    },
  };
}

export async function executeCompaniesHouseToolCall(
  name: string,
  args: Record<string, unknown>,
  apiKey: string | null | undefined,
): Promise<{ content: string; event: CompaniesHouseToolEvent }> {
  if (!apiKey || !apiKey.trim()) {
    return errorResult(name, "Companies House API key invalid or missing");
  }

  try {
    if (name === "companies_house_search_companies") {
      return await executeSearchCompanies(args, apiKey);
    }
    if (name === "companies_house_get_company") {
      return await executeGetCompany(args, apiKey);
    }
    if (name === "companies_house_get_filing_history") {
      return await executeGetFilingHistory(args, apiKey);
    }
    return errorResult(name, `Unknown Companies House tool '${name}'.`);
  } catch (err) {
    const companyNumberRaw =
      typeof args.company_number === "string" ? args.company_number : undefined;
    return errorResult(name, errorMessageOf(err), {
      company_number: companyNumberRaw
        ? normalizeCompanyNumber(companyNumberRaw)
        : undefined,
    });
  }
}
