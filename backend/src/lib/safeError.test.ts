import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GENERIC_ERROR_DETAIL,
  failRequest,
  redactSensitiveText,
  safeErrorLog,
  safeErrorMessage,
} from "./safeError";

// Error-visibility incident 04/08/2026: supabase-js PostgrestError objects
// ({ message, code?, details?, hint? }) reach these helpers as plain (non-Error)
// objects in production, and used to flatten to the literal "Unexpected error"
// — hiding the real cause from the logs. These tests pin the extraction of the
// known string fields, and that unknown shapes are still never logged wholesale.

describe("safeErrorMessage", () => {
  it("keeps existing behaviour for Error instances", () => {
    expect(safeErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("keeps existing behaviour for strings", () => {
    expect(safeErrorMessage("plain failure")).toBe("plain failure");
  });

  it("keeps the fallback for truly unknown shapes", () => {
    expect(safeErrorMessage(null)).toBe("Unexpected error");
    expect(safeErrorMessage(undefined)).toBe("Unexpected error");
    expect(safeErrorMessage(42)).toBe("Unexpected error");
    expect(safeErrorMessage({ foo: "bar" })).toBe("Unexpected error");
    expect(safeErrorMessage({ message: 123 })).toBe("Unexpected error");
    expect(safeErrorMessage({ message: "" })).toBe("Unexpected error");
    expect(safeErrorMessage(new Error(""))).toBe("Unexpected error");
  });

  it("honours a custom fallback", () => {
    expect(safeErrorMessage(null, "Stream error")).toBe("Stream error");
  });

  it("uses the message of a PostgrestError-shaped plain object", () => {
    expect(
      safeErrorMessage({
        message: "function get_projects_overview(uuid) does not exist",
        code: "42883",
        details: null,
        hint: "No function matches the given name and argument types.",
      }),
    ).toBe("function get_projects_overview(uuid) does not exist");
  });

  it("redacts secrets in an object-borne message", () => {
    const message = safeErrorMessage({
      message: "Incorrect API key provided: sk-abc123def456ghij.",
    });
    expect(message).not.toContain("sk-abc123def456ghij");
    expect(message).toContain("[redacted]");
  });
});

describe("safeErrorLog", () => {
  it("keeps existing behaviour for Error instances", () => {
    const logged = safeErrorLog(new TypeError("bad input"));
    expect(logged.name).toBe("TypeError");
    expect(logged.message).toBe("bad input");
    expect(logged.stack).toContain("TypeError");
  });

  it("keeps existing behaviour for strings and unknown shapes", () => {
    expect(safeErrorLog("raw string")).toEqual({
      name: null,
      message: "raw string",
    });
    expect(safeErrorLog(undefined)).toEqual({
      name: null,
      message: "Unexpected error",
    });
  });

  it("extracts message and code from a PostgrestError-shaped object", () => {
    const logged = safeErrorLog({
      message: "function get_projects_overview(uuid) does not exist",
      code: "42883",
    });
    expect(logged.name).toBe("42883");
    expect(logged.message).toBe(
      "function get_projects_overview(uuid) does not exist",
    );
    expect(logged.stack).toBeUndefined();
  });

  it("appends details and hint strings when present", () => {
    const logged = safeErrorLog({
      message: "permission denied for table user_api_keys",
      code: "42501",
      details: "role service_role lacks SELECT",
      hint: "Re-grant privileges to service_role",
    });
    expect(logged.message).toBe(
      "permission denied for table user_api_keys" +
        " | details: role service_role lacks SELECT" +
        " | hint: Re-grant privileges to service_role",
    );
  });

  it("ignores non-string code/details/hint", () => {
    const logged = safeErrorLog({
      message: "boom",
      code: 500,
      details: { nested: true },
      hint: null,
    });
    expect(logged.name).toBeNull();
    expect(logged.message).toBe("boom");
  });

  it("never logs unknown object fields wholesale", () => {
    const logged = safeErrorLog({
      message: "boom",
      apiKey: "sk-abc123def456ghij",
    });
    expect(JSON.stringify(logged)).not.toContain("sk-abc123def456ghij");
  });

  it("redacts message, details and hint", () => {
    const logged = safeErrorLog({
      message: "Incorrect API key provided: sk-abc123def456ghij.",
      details: "key sk-abc123def456ghij was rejected",
      hint: "check the key sk-abc123def456ghij",
    });
    expect(logged.message).not.toContain("sk-abc123def456ghij");
  });
});

describe("redactSensitiveText", () => {
  it("still redacts provider key patterns", () => {
    expect(
      redactSensitiveText("key sk-ant-abcdefgh12345678 leaked"),
    ).not.toContain("sk-ant-abcdefgh12345678");
  });
});

describe("failRequest", () => {
  const makeRes = (headersSent = false) => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    return { res: { headersSent, status }, status, json };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the redacted error server-side and sends the fixed generic detail", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { res, status, json } = makeRes();

    failRequest(res, "[projects] overview RPC failed", {
      message: "function get_projects_overview(uuid) does not exist",
      code: "42883",
    });

    expect(consoleError).toHaveBeenCalledWith(
      "[projects] overview RPC failed",
      {
        name: "42883",
        message: "function get_projects_overview(uuid) does not exist",
      },
    );
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ detail: GENERIC_ERROR_DETAIL });
    // The raw DB text must never appear in the response body.
    expect(JSON.stringify(json.mock.calls)).not.toContain(
      "get_projects_overview",
    );
  });

  it("honours a custom status and fixed detail", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { res, status, json } = makeRes();

    failRequest(
      res,
      "[tabular] review insert failed",
      new Error("boom"),
      500,
      "Failed to create review",
    );

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ detail: "Failed to create review" });
  });

  it("only logs when headers have already been sent", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { res, status } = makeRes(true);

    failRequest(res, "[chat] chat delete failed", new Error("late failure"));

    expect(consoleError).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
});
