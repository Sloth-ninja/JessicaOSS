import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../legislation", () => ({
  lookupCitation: vi.fn(),
  verifyCitation: vi.fn(),
  search: vi.fn(),
}));

import { lookupCitation, verifyCitation, search } from "../legislation";
import {
  LEGISLATION_TOOLS,
  LEGISLATION_SYSTEM_PROMPT,
  executeLegislationToolCall,
} from "./legislationTools";

describe("legislationTools", () => {
  beforeEach(() => {
    vi.mocked(lookupCitation).mockReset();
    vi.mocked(verifyCitation).mockReset();
    vi.mocked(search).mockReset();
  });

  it("exposes the three OpenAI-shaped tools by name", () => {
    const names = LEGISLATION_TOOLS.map((t) => t.function.name);
    expect(names).toEqual([
      "legislation_lookup",
      "legislation_search",
      "legislation_verify_citations",
    ]);
    for (const tool of LEGISLATION_TOOLS) {
      expect(tool.type).toBe("function");
      expect(tool.function.parameters.type).toBe("object");
    }
  });

  it("system prompt instructs verification-before-final-answer and forbids inventing case law", () => {
    expect(LEGISLATION_SYSTEM_PROMPT).toMatch(/legislation_verify_citations/);
    expect(LEGISLATION_SYSTEM_PROMPT).toMatch(/NO source for case law/i);
    expect(LEGISLATION_SYSTEM_PROMPT).toMatch(/BAILII/);
  });

  describe("legislation_lookup", () => {
    it("returns an ok event with title/url/outstanding_effects on success", async () => {
      vi.mocked(lookupCitation).mockResolvedValue({
        resolved: true,
        canonicalUrl:
          "https://www.legislation.gov.uk/ukpga/2006/46/section/994",
        title: "Companies Act 2006, s.994",
        heading: "Petition by company member",
        text: "A member of a company may apply...",
        extent: "E+W+S+N.I.",
        outstandingEffects: true,
        unappliedEffects: [{ notes: "not applied", type: "inserted" }],
      });
      const { content, event } = await executeLegislationToolCall(
        "legislation_lookup",
        { citation: "s.994 Companies Act 2006" },
      );
      expect(event).toMatchObject({
        type: "legislation_tool_call",
        tool_name: "legislation_lookup",
        status: "ok",
        title: "Companies Act 2006, s.994",
        url: "https://www.legislation.gov.uk/ukpga/2006/46/section/994",
        outstanding_effects: true,
      });
      const parsed = JSON.parse(content);
      expect(parsed.resolved).toBe(true);
      expect(parsed.outstanding_effects).toBe(true);
      expect(parsed.text).toContain("A member of a company");
    });

    it("returns an error event with the reason when unresolved, never throwing", async () => {
      vi.mocked(lookupCitation).mockResolvedValue({
        resolved: false,
        citation: "s.1 Nonexistent Act 2099",
        reason: 'No legislation.gov.uk entry found for "Nonexistent Act 2099".',
      });
      const { content, event } = await executeLegislationToolCall(
        "legislation_lookup",
        { citation: "s.1 Nonexistent Act 2099" },
      );
      expect(event.status).toBe("error");
      expect(event.error).toMatch(/Nonexistent Act 2099/);
      const parsed = JSON.parse(content);
      expect(parsed.resolved).toBe(false);
    });
  });

  describe("legislation_search", () => {
    it("returns matches on success", async () => {
      vi.mocked(search).mockResolvedValue([
        {
          title: "Companies Act 2006",
          type: "ukpga",
          year: 2006,
          number: "46",
          url: "https://www.legislation.gov.uk/ukpga/2006/46",
        },
      ]);
      const { content, event } = await executeLegislationToolCall(
        "legislation_search",
        { title_query: "Companies Act 2006" },
      );
      expect(event.status).toBe("ok");
      const parsed = JSON.parse(content);
      expect(parsed.matches).toHaveLength(1);
    });
  });

  describe("legislation_verify_citations", () => {
    it("reports ok when every citation resolves", async () => {
      vi.mocked(verifyCitation).mockImplementation(async (c: string) => ({
        citation: c,
        resolved: true,
        url: "https://www.legislation.gov.uk/x",
      }));
      const { content, event } = await executeLegislationToolCall(
        "legislation_verify_citations",
        { citations: ["s.994 Companies Act 2006", "SI 2006/246"] },
      );
      expect(event.status).toBe("ok");
      const parsed = JSON.parse(content);
      expect(parsed.results).toHaveLength(2);
      expect(
        parsed.results.every((r: { resolved: boolean }) => r.resolved),
      ).toBe(true);
    });

    it("reports error status and includes failing citations when any citation fails", async () => {
      vi.mocked(verifyCitation).mockImplementation(async (c: string) =>
        c.includes("Nonexistent")
          ? { citation: c, resolved: false, reason: "not found" }
          : {
              citation: c,
              resolved: true,
              url: "https://www.legislation.gov.uk/x",
            },
      );
      const { event } = await executeLegislationToolCall(
        "legislation_verify_citations",
        { citations: ["s.994 Companies Act 2006", "s.1 Nonexistent Act 2099"] },
      );
      expect(event.status).toBe("error");
      expect(event.error).toMatch(/Nonexistent Act 2099/);
    });

    it("treats a missing/malformed citations array as empty rather than throwing", async () => {
      const { content, event } = await executeLegislationToolCall(
        "legislation_verify_citations",
        {},
      );
      expect(event.status).toBe("ok");
      const parsed = JSON.parse(content);
      expect(parsed.results).toEqual([]);
    });
  });

  it("returns an error event for an unknown tool name rather than throwing", async () => {
    const { event } = await executeLegislationToolCall("legislation_bogus", {});
    expect(event.status).toBe("error");
  });
});
