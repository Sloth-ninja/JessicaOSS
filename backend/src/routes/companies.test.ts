import { describe, expect, it } from "vitest";
import { CompaniesHouseError } from "../lib/companiesHouse";
import {
  companiesHouseErrorResponse,
  validateCompanyNumber,
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
