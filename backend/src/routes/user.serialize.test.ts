import { describe, it, expect, vi } from "vitest";

// serializeProfile pulls model constants + resolveModel from ../lib/llm; stub
// them so the test is about the organisation/firm payload shape, not model
// resolution. resolveModel echoes the chosen value (value ?? fallback).
vi.mock("../lib/llm", () => ({
  DEFAULT_TABULAR_MODEL: "tabular-default",
  DEFAULT_TITLE_MODEL: "title-default",
  CLAUDE_LOW_MODELS: ["claude-low"],
  OPENAI_LOW_MODELS: ["openai-low"],
  resolveModel: (value: string | null, fallback: string) => value ?? fallback,
}));

import { serializeProfile } from "./user";
import type { OrganisationMembership } from "../lib/organisations";

const baseRow = {
  display_name: "Jane Solicitor",
  organisation: "Aria Grace Law",
  message_credits_used: 3,
  credits_reset_date: "2026-08-01T00:00:00.000Z",
  tier: "Pilot",
  title_model: null,
  tabular_model: "gemini-3-flash-preview",
  mfa_on_login: true,
};

const ARIA: OrganisationMembership = {
  id: "org-1",
  name: "Aria Grace Law CIC",
  role: "member",
  policies: { memberApiKeys: true, memberMcpConnectors: false },
};

describe("serializeProfile — organisation payload shape", () => {
  it("keeps the free-text organisation string untouched alongside the structured firm", () => {
    const out = serializeProfile(baseRow, undefined, ARIA);
    // Free-text field is unchanged (still a string).
    expect(out.organisation).toBe("Aria Grace Law");
    // Structured membership is emitted under `firm`.
    expect(out.firm).toEqual(ARIA);
  });

  it("reports isAdmin=false for a member", () => {
    const out = serializeProfile(baseRow, undefined, ARIA);
    expect(out.isAdmin).toBe(false);
    expect(out.firm?.role).toBe("member");
  });

  it("reports isAdmin=true for an admin", () => {
    const admin: OrganisationMembership = { ...ARIA, role: "admin" };
    const out = serializeProfile(baseRow, undefined, admin);
    expect(out.isAdmin).toBe(true);
    expect(out.firm?.role).toBe("admin");
  });

  it("emits firm=null and isAdmin=false for an orgless user (default arg)", () => {
    const out = serializeProfile(baseRow, undefined);
    expect(out.firm).toBeNull();
    expect(out.isAdmin).toBe(false);
    // Free-text organisation is independent of firm membership.
    expect(out.organisation).toBe("Aria Grace Law");
  });

  it("carries the firm's policy flags through unchanged", () => {
    const out = serializeProfile(baseRow, undefined, {
      ...ARIA,
      policies: { memberApiKeys: false, memberMcpConnectors: true },
    });
    expect(out.firm?.policies).toEqual({
      memberApiKeys: false,
      memberMcpConnectors: true,
    });
  });
});
