import { describe, it, expect } from "vitest";
import { extractCitations } from "./citationExtraction";

describe("citationExtraction.ts", () => {
  // Extraction fixtures are deliberately duplicated with evals/src/citations.ts
  // (the regexes were ported from there — keep both in sync).

  describe("statute sections", () => {
    it("extracts section-first: 's.994 Companies Act 2006'", () => {
      const result = extractCitations(
        "Under s.994 Companies Act 2006, a member may petition the court.",
      );
      expect(result).toEqual([
        {
          raw: "s.994 Companies Act 2006",
          kind: "statute-section",
          section: "994",
          title: "Companies Act 2006",
          year: "2006",
        },
      ]);
    });

    it("extracts 'section N of the ... Act YYYY'", () => {
      const result = extractCitations(
        "See section 98 of the Employment Rights Act 1996 for fairness.",
      );
      expect(result).toEqual([
        {
          raw: "section 98 of the Employment Rights Act 1996",
          kind: "statute-section",
          section: "98",
          title: "Employment Rights Act 1996",
          year: "1996",
        },
      ]);
    });

    it("extracts act-first: 'Companies Act 2006, s 994'", () => {
      const result = extractCitations(
        "Companies Act 2006, s 994 governs unfair prejudice petitions.",
      );
      expect(result).toEqual([
        {
          raw: "Companies Act 2006, s 994",
          kind: "statute-section",
          title: "Companies Act 2006",
          year: "2006",
          section: "994",
        },
      ]);
    });

    it("extracts lettered section numbers: 's.172A'", () => {
      const result = extractCitations("Consider s.172A Companies Act 2006.");
      expect(result).toEqual([
        {
          raw: "s.172A Companies Act 2006",
          kind: "statute-section",
          section: "172A",
          title: "Companies Act 2006",
          year: "2006",
        },
      ]);
    });
  });

  describe("bare Acts and de-duplication", () => {
    it("extracts a bare Act mention at Act level", () => {
      const result = extractCitations(
        "claims for unfair dismissal arise under the Employment Rights Act 1996 generally.",
      );
      expect(result).toEqual([
        {
          raw: "Employment Rights Act 1996",
          kind: "act",
          title: "Employment Rights Act 1996",
          year: "1996",
        },
      ]);
    });

    it("swallows preceding capitalised words into the title (known ported-regex quirk, kept in sync with evals)", () => {
      const result = extractCitations(
        "Petitions are governed by the Companies Act 2006 in such cases.",
      );
      expect(result).toEqual([
        {
          raw: "Petitions are governed by the Companies Act 2006",
          kind: "act",
          title: "Petitions are governed by the Companies Act 2006",
          year: "2006",
        },
      ]);
    });

    it("suppresses a bare-Act mention already covered by a section reference", () => {
      const result = extractCitations(
        "s.994 Companies Act 2006 applies; the Companies Act 2006 is the governing statute.",
      );
      expect(result).toEqual([
        {
          raw: "s.994 Companies Act 2006",
          kind: "statute-section",
          section: "994",
          title: "Companies Act 2006",
          year: "2006",
        },
      ]);
    });

    it("keeps a bare mention of a DIFFERENT Act alongside a section reference", () => {
      const result = extractCitations(
        "s.994 Companies Act 2006 applies, as does the Insolvency Act 1986.",
      );
      expect(result).toHaveLength(2);
      expect(result).toContainEqual({
        raw: "Insolvency Act 1986",
        kind: "act",
        title: "Insolvency Act 1986",
        year: "1986",
      });
    });

    it("de-duplicates repeated citations of the same provision", () => {
      const result = extractCitations(
        "s.994 Companies Act 2006 ... and again s.994 Companies Act 2006.",
      );
      expect(result).toHaveLength(1);
    });
  });

  describe("statutory instruments", () => {
    it("extracts an SI number from 'SI 2006/246, reg 4'", () => {
      const result = extractCitations(
        "TUPE is SI 2006/246, reg 4 being the key provision.",
      );
      expect(result).toEqual([
        {
          raw: "SI 2006/246",
          kind: "si",
          year: "2006",
          number: "246",
        },
      ]);
    });

    it("accepts the dotted form 'S.I. 2005/1788'", () => {
      const result = extractCitations("See S.I. 2005/1788 for CIC rules.");
      expect(result).toEqual([
        {
          raw: "S.I. 2005/1788",
          kind: "si",
          year: "2005",
          number: "1788",
        },
      ]);
    });
  });

  describe("neutral case citations", () => {
    it("extracts '[2024] UKSC 12'", () => {
      const result = extractCitations(
        "The reasoning in [2024] UKSC 12 applies.",
      );
      expect(result).toEqual([
        { raw: "[2024] UKSC 12", kind: "neutral-case", year: "2024" },
      ]);
    });

    it("extracts '[2023] EWCA Civ 100'", () => {
      const result = extractCitations("Contrast [2023] EWCA Civ 100.");
      expect(result).toEqual([
        { raw: "[2023] EWCA Civ 100", kind: "neutral-case", year: "2023" },
      ]);
    });

    it("extracts EWHC (Ch) forms: '[2022] EWHC 123 (Ch)'", () => {
      const result = extractCitations("Applied in [2022] EWHC 123 (Ch).");
      expect(result).toEqual([
        { raw: "[2022] EWHC 123", kind: "neutral-case", year: "2022" },
      ]);
    });
  });

  describe("mixed text", () => {
    it("extracts every kind from one passage", () => {
      const result = extractCitations(
        "Under s.994 Companies Act 2006 and the Insolvency Act 1986, see " +
          "SI 2006/246 and [2024] UKSC 12.",
      );
      expect(result.map((c) => c.kind).sort()).toEqual([
        "act",
        "neutral-case",
        "si",
        "statute-section",
      ]);
    });

    it("returns an empty array when no citations are present", () => {
      expect(extractCitations("No citations in this sentence.")).toEqual([]);
    });
  });
});
