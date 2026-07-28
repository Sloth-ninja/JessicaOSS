import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Keep the real CompaniesHouseError / normalizeCompanyNumber (the route's
// validators and error mapping depend on them) and only stub getFilingDocument
// so the document route can be driven without a live Companies House call.
vi.mock("../lib/companiesHouse", async (importActual) => {
  const actual = await importActual<typeof import("../lib/companiesHouse")>();
  return { ...actual, getFilingDocument: vi.fn() };
});

vi.mock("../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "test-user";
    next();
  },
}));

vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => ({}) as unknown,
}));

vi.mock("../lib/userApiKeys", () => ({
  getUserApiKeys: vi.fn(),
}));

import { CompaniesHouseError, getFilingDocument } from "../lib/companiesHouse";
import { getUserApiKeys } from "../lib/userApiKeys";
import {
  companiesHouseErrorResponse,
  companiesRouter,
  validateCompanyNumber,
  validateTransactionId,
  validateViewBody,
  validateStarBody,
} from "./companies";

describe("companiesHouseErrorResponse", () => {
  it("maps a 401 (invalid/missing key) to 409 with the key-missing code", () => {
    const { status, body } = companiesHouseErrorResponse(
      new CompaniesHouseError(
        "Companies House API key invalid or missing",
        401,
      ),
    );
    expect(status).toBe(409);
    expect(body).toEqual({
      detail: "No Companies House API key is configured.",
      code: "companies_house_key_missing",
    });
  });

  it("maps a 404 to 404 with a fixed safe message", () => {
    const { status, body } = companiesHouseErrorResponse(
      new CompaniesHouseError("No company found with number 99999999", 404),
    );
    expect(status).toBe(404);
    expect(body.detail).toBe(
      "Company not found on the Companies House register.",
    );
    // The client's own message (which may echo user input) never passes through.
    expect(body.detail).not.toMatch(/99999999/);
  });

  it("maps a 429 to 429 with a friendly message", () => {
    const { status, body } = companiesHouseErrorResponse(
      new CompaniesHouseError("Companies House rate limit exceeded", 429),
    );
    expect(status).toBe(429);
    expect(body.detail).toMatch(/rate limit/i);
    expect(body.detail).toMatch(/try again/i);
  });

  it("maps any other CompaniesHouseError to a fixed generic 502", () => {
    const { status, body } = companiesHouseErrorResponse(
      new CompaniesHouseError(
        "Companies House request failed with status 500.",
        500,
      ),
    );
    expect(status).toBe(502);
    expect(body.detail).toBe(
      "Could not reach Companies House. Please try again later.",
    );
  });

  it("maps unknown errors to the same fixed generic 502 (never raw text)", () => {
    const { status, body } = companiesHouseErrorResponse(
      new Error("connect ECONNREFUSED supabase super-secret-key"),
    );
    expect(status).toBe(502);
    expect(body.detail).toBe(
      "Could not reach Companies House. Please try again later.",
    );
    expect(JSON.stringify(body)).not.toContain("super-secret-key");
  });

  it("maps a keyless CompaniesHouseError (no status) to the generic 502", () => {
    const { status } = companiesHouseErrorResponse(
      new CompaniesHouseError(
        "Failed to reach the Companies House API. Please try again.",
      ),
    );
    expect(status).toBe(502);
  });
});

describe("validateCompanyNumber", () => {
  it("accepts and normalises legitimate company numbers, but rejects path/query metacharacters", () => {
    expect(validateCompanyNumber("13927967")).toBe("13927967");
    expect(validateCompanyNumber("123")).toBe("00000123");
    expect(validateCompanyNumber("sc12345")).toBe("SC012345");
    // Values that could redirect the outgoing Companies House request onto
    // an unintended path or add query parameters must never pass through.
    expect(validateCompanyNumber("../search")).toBeNull();
    expect(validateCompanyNumber("13927967?foo=bar")).toBeNull();
    expect(validateCompanyNumber("13927967/officers")).toBeNull();
    expect(validateCompanyNumber("")).toBeNull();
    expect(validateCompanyNumber("  ")).toBeNull();
  });
});

describe("validateViewBody", () => {
  it("accepts a valid name (+ optional status) and trims", () => {
    const r = validateViewBody({
      companyName: "  MARKS AND SPENCER P.L.C.  ",
      companyStatus: "active",
    });
    expect(r).toEqual({
      ok: true,
      value: {
        companyName: "MARKS AND SPENCER P.L.C.",
        companyStatus: "active",
      },
    });
  });

  it("treats a missing/blank status as null", () => {
    expect(validateViewBody({ companyName: "Acme Ltd" })).toEqual({
      ok: true,
      value: { companyName: "Acme Ltd", companyStatus: null },
    });
  });

  it("rejects a missing or empty company name (400)", () => {
    expect(validateViewBody({}).ok).toBe(false);
    expect(validateViewBody({ companyName: "   " }).ok).toBe(false);
    expect(validateViewBody({ companyName: 42 }).ok).toBe(false);
  });

  it("rejects a name over 200 chars (400)", () => {
    const r = validateViewBody({ companyName: "x".repeat(201) });
    expect(r.ok).toBe(false);
  });

  it("rejects a status over 50 chars (400)", () => {
    const r = validateViewBody({
      companyName: "Acme Ltd",
      companyStatus: "s".repeat(51),
    });
    expect(r.ok).toBe(false);
  });
});

describe("validateStarBody", () => {
  it("accepts a boolean starred with an optional snapshot", () => {
    expect(
      validateStarBody({ starred: true, companyName: "Acme Ltd" }),
    ).toEqual({
      ok: true,
      value: {
        starred: true,
        snapshot: { companyName: "Acme Ltd", companyStatus: null },
      },
    });
  });

  it("accepts starred alone (no snapshot) for an unstar", () => {
    expect(validateStarBody({ starred: false })).toEqual({
      ok: true,
      value: { starred: false, snapshot: undefined },
    });
  });

  it("rejects a non-boolean starred (400)", () => {
    expect(validateStarBody({ starred: "yes" }).ok).toBe(false);
    expect(validateStarBody({}).ok).toBe(false);
    expect(validateStarBody({ starred: 1 }).ok).toBe(false);
  });

  it("rejects an over-long snapshot name/status (400)", () => {
    expect(
      validateStarBody({ starred: true, companyName: "x".repeat(201) }).ok,
    ).toBe(false);
    expect(
      validateStarBody({
        starred: true,
        companyName: "Acme Ltd",
        companyStatus: "s".repeat(51),
      }).ok,
    ).toBe(false);
  });
});

describe("validateTransactionId", () => {
  it("accepts alphanumeric ids (with _ and -) and rejects path/query metacharacters", () => {
    expect(validateTransactionId("MDAxMjM0NTY3OA")).toBe("MDAxMjM0NTY3OA");
    expect(validateTransactionId("abc-123_XYZ")).toBe("abc-123_XYZ");
    expect(validateTransactionId("  trim-me  ")).toBe("trim-me");
    expect(validateTransactionId("../secret")).toBeNull();
    expect(validateTransactionId("abc/content")).toBeNull();
    expect(validateTransactionId("abc?foo=bar")).toBeNull();
    expect(validateTransactionId("")).toBeNull();
    expect(validateTransactionId("  ")).toBeNull();
  });
});

describe("GET /companies/:companyNumber/filing-history/:transactionId/document", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use("/companies", companiesRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  );

  beforeEach(() => {
    vi.mocked(getFilingDocument).mockReset();
    vi.mocked(getUserApiKeys).mockReset();
    // Default: caller has a configured Companies House key.
    vi.mocked(getUserApiKeys).mockResolvedValue({
      companies_house: "ch-key",
    } as Awaited<ReturnType<typeof getUserApiKeys>>);
  });

  function request(path: string) {
    return fetch(`${baseUrl}${path}`);
  }

  it("streams the document bytes with PDF content-type and an inline filename", async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
    vi.mocked(getFilingDocument).mockResolvedValue({
      bytes,
      contentType: "application/pdf",
      filename: "13927967-2024-03-01-CS01.pdf",
    });

    const res = await request(
      "/companies/13927967/filing-history/abc123/document",
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      'inline; filename="13927967-2024-03-01-CS01.pdf"',
    );
    const received = Buffer.from(await res.arrayBuffer());
    expect(received.equals(bytes)).toBe(true);
    expect(getFilingDocument).toHaveBeenCalledWith(
      "ch-key",
      "13927967",
      "abc123",
    );
  });

  it("returns a generic 404 when the filing has no document", async () => {
    vi.mocked(getFilingDocument).mockRejectedValue(
      new CompaniesHouseError("This filing has no associated document.", 404),
    );

    const res = await request(
      "/companies/13927967/filing-history/abc123/document",
    );
    const body = (await res.json()) as { detail: string };

    expect(res.status).toBe(404);
    expect(body.detail).toBe(
      "Company not found on the Companies House register.",
    );
  });

  it("returns 409 companies_house_key_missing when no key is configured", async () => {
    vi.mocked(getUserApiKeys).mockResolvedValue(
      {} as Awaited<ReturnType<typeof getUserApiKeys>>,
    );

    const res = await request(
      "/companies/13927967/filing-history/abc123/document",
    );
    const body = (await res.json()) as { detail: string; code: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("companies_house_key_missing");
    expect(getFilingDocument).not.toHaveBeenCalled();
  });

  it("returns a generic 502 (no raw text) when the document is oversize", async () => {
    vi.mocked(getFilingDocument).mockRejectedValue(
      new CompaniesHouseError(
        "This filing document is too large to retrieve.",
        502,
      ),
    );

    const res = await request(
      "/companies/13927967/filing-history/abc123/document",
    );
    const body = (await res.json()) as { detail: string };

    expect(res.status).toBe(502);
    expect(body.detail).toBe(
      "Could not reach Companies House. Please try again later.",
    );
    expect(body.detail).not.toMatch(/too large/i);
  });

  it("rejects an invalid transaction id with a 400 before any client call", async () => {
    const res = await request(
      "/companies/13927967/filing-history/..%2Fsecret/document",
    );
    expect(res.status).toBe(400);
    expect(getFilingDocument).not.toHaveBeenCalled();
  });
});
