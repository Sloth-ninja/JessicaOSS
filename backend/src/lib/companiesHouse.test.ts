import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompaniesHouseError,
  normalizeCompanyNumber,
  getCompanyProfile,
  getCompanyOfficers,
  getCompanyPSCs,
  getFilingHistory,
  searchCompanies,
  resetCompaniesHouseStateForTests,
} from "./companiesHouse";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("normalizeCompanyNumber", () => {
  it("leaves an already-8-digit number unchanged", () => {
    expect(normalizeCompanyNumber("13927967")).toBe("13927967");
  });

  it("pads bare digits to 8 characters", () => {
    expect(normalizeCompanyNumber("123")).toBe("00000123");
  });

  it("uppercases and pads a prefixed number (Scotland)", () => {
    expect(normalizeCompanyNumber("sc12345")).toBe("SC012345");
  });

  it("uppercases and pads a prefixed number (Northern Ireland)", () => {
    expect(normalizeCompanyNumber("ni12345")).toBe("NI012345");
  });

  it("leaves an already-correct prefixed number unchanged", () => {
    expect(normalizeCompanyNumber("OC123456")).toBe("OC123456");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeCompanyNumber("  00214436  ")).toBe("00214436");
  });
});

describe("companiesHouse client", () => {
  const API_KEY = "test-key-abc123";

  beforeEach(() => {
    resetCompaniesHouseStateForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends HTTP Basic auth with the API key as username and a blank password", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await getCompanyProfile(API_KEY, "13927967");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(
      "https://api.company-information.service.gov.uk/company/13927967",
    );
    const expectedAuth = `Basic ${Buffer.from(`${API_KEY}:`).toString("base64")}`;
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: expectedAuth,
    });
  });

  it("calls the search endpoint with q and items_per_page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await searchCompanies(API_KEY, "aria grace law", 3);

    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/search/companies");
    expect(parsed.searchParams.get("q")).toBe("aria grace law");
    expect(parsed.searchParams.get("items_per_page")).toBe("3");
  });

  it("calls the filing-history endpoint with items_per_page and start_index", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await getFilingHistory(API_KEY, "00214436", {
      itemsPerPage: 100,
      startIndex: 0,
    });

    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/company/00214436/filing-history");
    expect(parsed.searchParams.get("items_per_page")).toBe("100");
    expect(parsed.searchParams.get("start_index")).toBe("0");
  });

  it("maps a 401 to an invalid-key error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "no" }, 401)),
    );

    await expect(getCompanyProfile(API_KEY, "13927967")).rejects.toThrow(
      CompaniesHouseError,
    );
    await expect(getCompanyProfile(API_KEY, "13927967")).rejects.toThrow(
      /invalid or missing/i,
    );
  });

  it("maps a 404 to a not-found error naming the company number", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "not found" }, 404)),
    );

    await expect(getCompanyProfile(API_KEY, "99999999")).rejects.toThrow(
      /no company found with number 99999999/i,
    );
  });

  it("maps a 429 to a rate-limit error without retrying", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "too many" }, 429));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCompanyProfile(API_KEY, "13927967")).rejects.toThrow(
      /rate limit/i,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once on a 5xx then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 502))
      .mockResolvedValueOnce(jsonResponse({ company_number: "13927967" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCompanyProfile(API_KEY, "13927967");
    expect(result).toMatchObject({ company_number: "13927967" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails after a second consecutive 5xx (one retry only)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: "boom again" }, 503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCompanyProfile(API_KEY, "13927967")).rejects.toThrow(
      CompaniesHouseError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never includes the API key in a thrown error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "no" }, 401)),
    );
    try {
      await getCompanyProfile(API_KEY, "13927967");
      throw new Error("expected getCompanyProfile to throw");
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(API_KEY);
    }
  });

  it("caches a profile lookup for the TTL window (no second fetch)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ company_number: "13927967" }));
    vi.stubGlobal("fetch", fetchMock);

    await getCompanyProfile(API_KEY, "13927967");
    await getCompanyProfile(API_KEY, "13927967");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches a profile after the cache TTL expires", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ company_number: "13927967" })),
      );
    vi.stubGlobal("fetch", fetchMock);

    await getCompanyProfile(API_KEY, "13927967");
    vi.advanceTimersByTime(16 * 60 * 1000); // past the 15-min profile TTL
    await getCompanyProfile(API_KEY, "13927967");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-fetches a search after the shorter search TTL expires but not before", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ items: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await searchCompanies(API_KEY, "aria grace law");
    vi.advanceTimersByTime(2 * 60 * 1000);
    await searchCompanies(API_KEY, "aria grace law");
    expect(fetchMock).toHaveBeenCalledTimes(1); // still within 5-min search TTL

    vi.advanceTimersByTime(4 * 60 * 1000); // total 6 min > 5-min TTL
    await searchCompanies(API_KEY, "aria grace law");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates concurrent identical GETs into a single fetch (single-flight)", async () => {
    let resolveFetch: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal("fetch", fetchMock);

    const p1 = getCompanyProfile(API_KEY, "13927967");
    const p2 = getCompanyProfile(API_KEY, "13927967");

    resolveFetch!(jsonResponse({ company_number: "13927967" }));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });

  it("enforces the per-key token bucket, refusing once the window's requests are exhausted", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ items: [] })));
    vi.stubGlobal("fetch", fetchMock);

    // Distinct URLs (distinct queries) so caching/single-flight don't
    // short-circuit the token bucket check.
    const attempts = 501;
    let rateLimited = 0;
    for (let i = 0; i < attempts; i++) {
      try {
        await searchCompanies(API_KEY, `query-${i}`);
      } catch (err) {
        if (err instanceof CompaniesHouseError && err.status === 429) {
          rateLimited += 1;
        } else {
          throw err;
        }
      }
    }
    expect(rateLimited).toBeGreaterThan(0);
  });

  it("refills the token bucket over time", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ items: [] })));
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 500; i++) {
      await searchCompanies(API_KEY, `bucket-drain-${i}`);
    }
    await expect(
      searchCompanies(API_KEY, "bucket-drain-over-limit"),
    ).rejects.toThrow(/rate limit/i);

    // Advance past the full 5-minute refill window.
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
    await expect(
      searchCompanies(API_KEY, "bucket-drain-after-refill"),
    ).resolves.toBeDefined();
  });
});
