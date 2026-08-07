import { describe, expect, it } from "vitest";
import {
  MISSING_COLUMN_CODES,
  MISSING_TABLE_CODES,
  isUnmigratedSchemaError,
} from "./postgrestCodes";

// Codes measured against PostgREST 14.16 in a local container (07/08/2026 —
// docs/DURABLE_LESSONS.md 2026-08-07). PGRST205 is the one that actually fires
// on Supabase for a missing table; a 42P01-only check silently never matches.
describe("isUnmigratedSchemaError", () => {
  it.each([...MISSING_TABLE_CODES, ...MISSING_COLUMN_CODES])(
    "tolerates %s",
    (code) => {
      expect(isUnmigratedSchemaError({ code })).toBe(true);
    },
  );

  it("includes PGRST205 — the missing-TABLE code a live Supabase returns", () => {
    expect(MISSING_TABLE_CODES).toContain("PGRST205");
    expect(isUnmigratedSchemaError({ code: "PGRST205" })).toBe(true);
  });

  it.each([
    ["23505", "unique violation"],
    ["42501", "permission denied"],
    ["PGRST116", "no rows returned"],
    ["22P02", "invalid uuid text"],
  ])("does not swallow %s (%s)", (code) => {
    expect(isUnmigratedSchemaError({ code })).toBe(false);
  });

  it("is false for non-error shapes rather than throwing", () => {
    expect(isUnmigratedSchemaError(null)).toBe(false);
    expect(isUnmigratedSchemaError(undefined)).toBe(false);
    expect(isUnmigratedSchemaError("42P01")).toBe(false);
    expect(isUnmigratedSchemaError({})).toBe(false);
    expect(isUnmigratedSchemaError({ code: 42703 })).toBe(false);
  });
});
