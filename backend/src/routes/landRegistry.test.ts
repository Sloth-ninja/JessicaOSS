import { describe, expect, it } from "vitest";
import { LandRegistryError } from "../lib/landRegistry";
import { landRegistryErrorResponse } from "./landRegistry";

describe("landRegistryErrorResponse", () => {
  it("maps an invalid-postcode (400) error to a fixed 400", () => {
    const { status, body } = landRegistryErrorResponse(
      new LandRegistryError("Invalid postcode.", 400),
    );
    expect(status).toBe(400);
    expect(body.detail).toBe("Enter a valid UK postcode.");
  });

  it("maps any upstream LandRegistryError to a fixed generic 502", () => {
    const { status, body } = landRegistryErrorResponse(
      new LandRegistryError(
        "HM Land Registry request failed with status 500.",
        500,
      ),
    );
    expect(status).toBe(502);
    expect(body.detail).toBe(
      "Could not reach HM Land Registry. Please try again later.",
    );
  });

  it("maps a timeout/rate-limit error to the same generic 502", () => {
    const { status, body } = landRegistryErrorResponse(
      new LandRegistryError("Too many Land Registry lookups just now.", 429),
    );
    expect(status).toBe(502);
    expect(body.detail).toBe(
      "Could not reach HM Land Registry. Please try again later.",
    );
  });

  it("maps unknown errors to the generic 502 and never leaks raw text", () => {
    const { status, body } = landRegistryErrorResponse(
      new Error("connect ECONNREFUSED 10.0.0.1 super-secret-detail"),
    );
    expect(status).toBe(502);
    expect(body.detail).toBe(
      "Could not reach HM Land Registry. Please try again later.",
    );
    expect(body.detail).not.toMatch(/secret/);
  });
});
