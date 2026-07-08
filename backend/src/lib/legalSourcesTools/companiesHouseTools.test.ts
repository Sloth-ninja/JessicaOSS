import { afterEach, describe, expect, it, vi } from "vitest";

const {
  searchCompaniesMock,
  getCompanyProfileMock,
  getCompanyOfficersMock,
  getCompanyPSCsMock,
  getFilingHistoryMock,
} = vi.hoisted(() => ({
  searchCompaniesMock: vi.fn(),
  getCompanyProfileMock: vi.fn(),
  getCompanyOfficersMock: vi.fn(),
  getCompanyPSCsMock: vi.fn(),
  getFilingHistoryMock: vi.fn(),
}));

vi.mock("../companiesHouse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../companiesHouse")>();
  return {
    ...actual,
    searchCompanies: searchCompaniesMock,
    getCompanyProfile: getCompanyProfileMock,
    getCompanyOfficers: getCompanyOfficersMock,
    getCompanyPSCs: getCompanyPSCsMock,
    getFilingHistory: getFilingHistoryMock,
  };
});

import {
  COMPANIES_HOUSE_SYSTEM_PROMPT,
  COMPANIES_HOUSE_TOOLS,
  executeCompaniesHouseToolCall,
} from "./companiesHouseTools";
import { CompaniesHouseError } from "../companiesHouse";

describe("COMPANIES_HOUSE_TOOLS", () => {
  it("exposes exactly the three expected tool names in OpenAI function shape", () => {
    const names = COMPANIES_HOUSE_TOOLS.map((t) => t.function.name);
    expect(names).toEqual([
      "companies_house_search_companies",
      "companies_house_get_company",
      "companies_house_get_filing_history",
    ]);
    for (const tool of COMPANIES_HOUSE_TOOLS) {
      expect(tool.type).toBe("function");
      expect(tool.function.parameters.type).toBe("object");
    }
  });

  it("requires query / company_number as appropriate", () => {
    const byName = Object.fromEntries(
      COMPANIES_HOUSE_TOOLS.map((t) => [t.function.name, t.function]),
    );
    expect(
      byName.companies_house_search_companies.parameters.required,
    ).toContain("query");
    expect(byName.companies_house_get_company.parameters.required).toContain(
      "company_number",
    );
    expect(
      byName.companies_house_get_filing_history.parameters.required,
    ).toContain("company_number");
  });
});

describe("COMPANIES_HOUSE_SYSTEM_PROMPT", () => {
  it("instructs the model on company-number format, citation, and rate-limit backoff", () => {
    expect(COMPANIES_HOUSE_SYSTEM_PROMPT).toMatch(/8 characters/i);
    expect(COMPANIES_HOUSE_SYSTEM_PROMPT).toMatch(/retrieval date/i);
    expect(COMPANIES_HOUSE_SYSTEM_PROMPT).toMatch(/rate-limit/i);
    expect(COMPANIES_HOUSE_SYSTEM_PROMPT).toMatch(/public.*register/i);
  });
});

describe("executeCompaniesHouseToolCall", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("errors without calling the client when no API key is available", async () => {
    const { content, event } = await executeCompaniesHouseToolCall(
      "companies_house_search_companies",
      { query: "aria grace law" },
      null,
    );
    expect(event).toMatchObject({
      type: "companies_house_tool_call",
      status: "error",
    });
    expect(JSON.parse(content).error).toMatch(/invalid or missing/i);
    expect(searchCompaniesMock).not.toHaveBeenCalled();
  });

  it("search_companies: returns an ok event and forwards the query", async () => {
    searchCompaniesMock.mockResolvedValue({
      items: [
        { company_name: "ARIA GRACE LAW CIC", company_number: "13927967" },
      ],
    });

    const { content, event } = await executeCompaniesHouseToolCall(
      "companies_house_search_companies",
      { query: "aria grace law" },
      "test-key",
    );

    expect(searchCompaniesMock).toHaveBeenCalledWith(
      "test-key",
      "aria grace law",
    );
    expect(event).toEqual({
      type: "companies_house_tool_call",
      tool_name: "companies_house_search_companies",
      status: "ok",
    });
    expect(JSON.parse(content)).toMatchObject({
      items: [{ company_number: "13927967" }],
    });
  });

  it("get_company: batches profile + officers + PSCs into one structured result", async () => {
    getCompanyProfileMock.mockResolvedValue({
      company_name: "ARIA GRACE LAW CIC",
      company_number: "13927967",
    });
    getCompanyOfficersMock.mockResolvedValue({
      items: [{ name: "HEALY, Lindsay Paul", officer_role: "director" }],
    });
    getCompanyPSCsMock.mockResolvedValue({
      items: [
        {
          name: "Mr Lindsay Paul Healy",
          kind: "individual-person-with-significant-control",
        },
      ],
    });

    const { content, event } = await executeCompaniesHouseToolCall(
      "companies_house_get_company",
      { company_number: "13927967" },
      "test-key",
    );

    expect(getCompanyProfileMock).toHaveBeenCalledWith("test-key", "13927967");
    expect(getCompanyOfficersMock).toHaveBeenCalledWith("test-key", "13927967");
    expect(getCompanyPSCsMock).toHaveBeenCalledWith("test-key", "13927967");

    expect(event.status).toBe("ok");
    expect(event.company_number).toBe("13927967");
    expect(event.company_name).toBe("ARIA GRACE LAW CIC");
    expect(event.company).toMatchObject({
      company_number: "13927967",
      profile: { company_name: "ARIA GRACE LAW CIC" },
    });

    const parsed = JSON.parse(content);
    expect(parsed.profile.company_name).toBe("ARIA GRACE LAW CIC");
    expect(parsed.officers.items[0].name).toBe("HEALY, Lindsay Paul");
    expect(parsed.psc.items[0].kind).toBe(
      "individual-person-with-significant-control",
    );
  });

  it("get_company: normalises a bare/short company number before calling the client", async () => {
    getCompanyProfileMock.mockResolvedValue({ company_number: "00000123" });
    getCompanyOfficersMock.mockResolvedValue({ items: [] });
    getCompanyPSCsMock.mockResolvedValue({ items: [] });

    await executeCompaniesHouseToolCall(
      "companies_house_get_company",
      { company_number: "123" },
      "test-key",
    );

    expect(getCompanyProfileMock).toHaveBeenCalledWith("test-key", "00000123");
  });

  it("get_company: a 404 on the profile fails the whole call with a clear error", async () => {
    getCompanyProfileMock.mockRejectedValue(
      new CompaniesHouseError("No company found with number 99999999", 404),
    );

    const { content, event } = await executeCompaniesHouseToolCall(
      "companies_house_get_company",
      { company_number: "99999999" },
      "test-key",
    );

    expect(event.status).toBe("error");
    expect(event.error).toMatch(/no company found with number 99999999/i);
    expect(JSON.parse(content).error).toMatch(/no company found/i);
  });

  it("get_company: officers/PSC failures degrade gracefully instead of failing the whole call", async () => {
    getCompanyProfileMock.mockResolvedValue({
      company_name: "ARIA GRACE LAW CIC",
      company_number: "13927967",
    });
    getCompanyOfficersMock.mockRejectedValue(
      new CompaniesHouseError("Companies House rate limit exceeded", 429),
    );
    getCompanyPSCsMock.mockResolvedValue({ items: [] });

    const { content, event } = await executeCompaniesHouseToolCall(
      "companies_house_get_company",
      { company_number: "13927967" },
      "test-key",
    );

    expect(event.status).toBe("ok");
    const parsed = JSON.parse(content);
    expect(parsed.officers.error).toMatch(/rate limit/i);
    expect(parsed.psc.items).toEqual([]);
  });

  it("get_filing_history: maps page to items_per_page/start_index", async () => {
    getFilingHistoryMock.mockResolvedValue({ items: [{ type: "CS01" }] });

    const { event } = await executeCompaniesHouseToolCall(
      "companies_house_get_filing_history",
      { company_number: "00214436", page: 2 },
      "test-key",
    );

    expect(getFilingHistoryMock).toHaveBeenCalledWith("test-key", "00214436", {
      itemsPerPage: 25,
      startIndex: 25,
    });
    expect(event.status).toBe("ok");
    expect(event.company_number).toBe("00214436");
  });

  it("get_filing_history: defaults to page 1 when omitted", async () => {
    getFilingHistoryMock.mockResolvedValue({ items: [] });

    await executeCompaniesHouseToolCall(
      "companies_house_get_filing_history",
      { company_number: "00214436" },
      "test-key",
    );

    expect(getFilingHistoryMock).toHaveBeenCalledWith("test-key", "00214436", {
      itemsPerPage: 25,
      startIndex: 0,
    });
  });

  it("never includes the raw API key in an error result", async () => {
    getCompanyProfileMock.mockRejectedValue(new Error("boom"));

    const { content, event } = await executeCompaniesHouseToolCall(
      "companies_house_get_company",
      { company_number: "13927967" },
      "super-secret-key",
    );

    expect(content).not.toContain("super-secret-key");
    expect(JSON.stringify(event)).not.toContain("super-secret-key");
  });

  it("returns an error event for an unknown tool name", async () => {
    const { content, event } = await executeCompaniesHouseToolCall(
      "companies_house_nonexistent",
      {},
      "test-key",
    );
    expect(event.status).toBe("error");
    expect(JSON.parse(content).error).toMatch(/unknown/i);
  });
});
