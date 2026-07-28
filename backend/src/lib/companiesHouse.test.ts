import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompaniesHouseError,
  normalizeCompanyNumber,
  getCompanyProfile,
  getCompanyOfficers,
  getCompanyPSCs,
  getFilingDocument,
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

describe("getFilingDocument", () => {
  const API_KEY = "test-key-abc123";
  const DOC_BASE = "https://document-api.company-information.service.gov.uk";
  const METADATA_URL = `${DOC_BASE}/document/abc123`;
  const CONTENT_URL = `${DOC_BASE}/document/abc123/content`;

  beforeEach(() => {
    resetCompaniesHouseStateForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pdfResponse(bytes: Uint8Array, headers: Record<string, string>) {
    return new Response(bytes.buffer as ArrayBuffer, { status: 200, headers });
  }

  it("resolves the metadata → content chain and returns the bytes, type and filename", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
      void init;
      const u = String(url);
      if (u.includes("/filing-history/")) {
        return Promise.resolve(
          jsonResponse({
            date: "2024-03-01",
            type: "CS01",
            links: { document_metadata: METADATA_URL },
          }),
        );
      }
      if (u === METADATA_URL) {
        return Promise.resolve(
          jsonResponse({ links: { document: CONTENT_URL } }),
        );
      }
      if (u === CONTENT_URL) {
        return Promise.resolve(
          pdfResponse(pdfBytes, {
            "content-type": "application/pdf",
            "content-length": String(pdfBytes.byteLength),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getFilingDocument(API_KEY, "13927967", "abc123");

    expect(result.contentType).toBe("application/pdf");
    expect(result.filename).toBe("13927967-2024-03-01-CS01.pdf");
    expect(Buffer.from(pdfBytes).equals(result.bytes)).toBe(true);

    // The signed-content hop is fetched with Accept: application/pdf.
    const contentCall = fetchMock.mock.calls.find(
      (c) => String(c[0]) === CONTENT_URL,
    );
    expect(contentCall).toBeDefined();
    expect(
      (contentCall?.[1] as { headers?: Record<string, string> })?.headers
        ?.Accept,
    ).toBe("application/pdf");
  });

  it("throws a 404 when the filing transaction has no document_metadata link", async () => {
    const fetchMock = vi.fn((url?: string | URL) => {
      void url;
      return Promise.resolve(
        jsonResponse({ date: "2024-03-01", type: "CS01" }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getFilingDocument(API_KEY, "13927967", "abc123"),
    ).rejects.toMatchObject({ status: 404 });
    // Never reaches the document API host.
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes(DOC_BASE)),
    ).toBe(false);
  });

  it("throws a 404 when the document metadata has no content link", async () => {
    const fetchMock = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes("/filing-history/")) {
        return Promise.resolve(
          jsonResponse({ links: { document_metadata: METADATA_URL } }),
        );
      }
      return Promise.resolve(jsonResponse({ links: {} }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getFilingDocument(API_KEY, "13927967", "abc123"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a document whose declared size exceeds the guard", async () => {
    const fetchMock = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes("/filing-history/")) {
        return Promise.resolve(
          jsonResponse({ links: { document_metadata: METADATA_URL } }),
        );
      }
      if (u === METADATA_URL) {
        return Promise.resolve(
          jsonResponse({ links: { document: CONTENT_URL } }),
        );
      }
      return Promise.resolve(
        pdfResponse(new Uint8Array([0]), {
          "content-type": "application/pdf",
          "content-length": String(26 * 1024 * 1024),
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getFilingDocument(API_KEY, "13927967", "abc123"),
    ).rejects.toBeInstanceOf(CompaniesHouseError);
  });

  it("aborts and rejects a streamed body that exceeds the cap despite no honest Content-Length", async () => {
    // 26 MB in a single chunk, streamed with NO content-length header — the
    // fast-path check can't catch it, so the streaming counter must abort.
    const oversizeChunk = new Uint8Array(26 * 1024 * 1024);
    let streamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversizeChunk);
        // Deliberately never close: we expect a cancel before the next read.
      },
      cancel() {
        streamCancelled = true;
      },
    });
    const fetchMock = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes("/filing-history/")) {
        return Promise.resolve(
          jsonResponse({ links: { document_metadata: METADATA_URL } }),
        );
      }
      if (u === METADATA_URL) {
        return Promise.resolve(
          jsonResponse({ links: { document: CONTENT_URL } }),
        );
      }
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getFilingDocument(API_KEY, "13927967", "abc123"),
    ).rejects.toMatchObject({ status: 502 });
    // The transfer was torn down, not fully buffered.
    expect(streamCancelled).toBe(true);
  });

  it("forces a non-allowlisted upstream content type to application/octet-stream", async () => {
    const bytes = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]); // "<html"
    const fetchMock = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes("/filing-history/")) {
        return Promise.resolve(
          jsonResponse({ links: { document_metadata: METADATA_URL } }),
        );
      }
      if (u === METADATA_URL) {
        return Promise.resolve(
          jsonResponse({ links: { document: CONTENT_URL } }),
        );
      }
      return Promise.resolve(
        pdfResponse(bytes, { "content-type": "text/html; charset=utf-8" }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getFilingDocument(API_KEY, "13927967", "abc123");
    expect(result.contentType).toBe("application/octet-stream");
  });

  it("rejects host-spoofing metadata links (suffix-domain and userinfo bypass) without a key-attached fetch", async () => {
    const bypassUrls = [
      // Suffix-domain: real host is a prefix of an attacker domain.
      "https://document-api.company-information.service.gov.uk.evil.com/doc",
      // Userinfo trick: everything before '@' is credentials, real host is evil.com.
      "https://document-api.company-information.service.gov.uk@evil.com/doc",
    ];
    for (const bypassUrl of bypassUrls) {
      resetCompaniesHouseStateForTests();
      const fetchMock = vi.fn((url?: string | URL) => {
        void url;
        return Promise.resolve(
          jsonResponse({ links: { document_metadata: bypassUrl } }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        getFilingDocument(API_KEY, "13927967", "abc123"),
      ).rejects.toMatchObject({ status: 404 });
      // The authenticated request must never reach the spoofed host.
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes("evil.com")),
      ).toBe(false);
    }
  });

  it("rejects a metadata link that points off the document API host (SSRF guard)", async () => {
    const fetchMock = vi.fn((url?: string | URL) => {
      void url;
      return Promise.resolve(
        jsonResponse({
          links: { document_metadata: "https://evil.example.com/doc" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getFilingDocument(API_KEY, "13927967", "abc123"),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      fetchMock.mock.calls.some((c) =>
        String(c[0]).includes("evil.example.com"),
      ),
    ).toBe(false);
  });

  it("rejects an empty API key without any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getFilingDocument("", "13927967", "abc123"),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
