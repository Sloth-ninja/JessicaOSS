import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(__dirname, "__fixtures__", "legislation");
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const CA2006_S994 = read("ca2006-section994.xml");
const TUPE_REG4 = read("tupe-regulation4.xml");
const ERA1996_S98_CLEAN = read("era1996-section98-clean.xml");
const CA2006_TITLE_FEED = read("ca2006-title-feed.xml");
const LTA1954_TITLE_FEED_REGNAL = read("lta1954-title-feed-regnal.xml");
const NO_RESULTS_FEED = read("no-results-feed.xml");

function jsonResponse(body: string, init?: { status?: number }) {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/xml" },
  });
}

describe("legislation.ts", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // parseCitation — natural citation parsing
  // -------------------------------------------------------------------------
  describe("parseCitation", () => {
    it("parses section-first with dotted prefix: 's.994 Companies Act 2006'", async () => {
      const { parseCitation } = await import("./legislation");
      expect(parseCitation("s.994 Companies Act 2006")).toEqual({
        kind: "act-section",
        sectionNumber: "994",
        title: "Companies Act 2006",
        year: 2006,
      });
    });

    it("parses 'section N of the ... Act YYYY'", async () => {
      const { parseCitation } = await import("./legislation");
      expect(
        parseCitation("section 98 of the Employment Rights Act 1996"),
      ).toEqual({
        kind: "act-section",
        sectionNumber: "98",
        title: "Employment Rights Act 1996",
        year: 1996,
      });
    });

    it("parses act-first: 'Employment Rights Act 1996, s 98'", async () => {
      const { parseCitation } = await import("./legislation");
      expect(parseCitation("Employment Rights Act 1996, s 98")).toEqual({
        kind: "act-section",
        title: "Employment Rights Act 1996",
        year: 1996,
        sectionNumber: "98",
      });
    });

    it("parses a bare SI number: 'SI 2006/246'", async () => {
      const { parseCitation } = await import("./legislation");
      expect(parseCitation("SI 2006/246")).toEqual({
        kind: "si",
        year: 2006,
        number: "246",
      });
    });

    it("parses a regulation fragment with SI number: 'reg 4 of SI 2006/246'", async () => {
      const { parseCitation } = await import("./legislation");
      expect(parseCitation("reg 4 of SI 2006/246")).toEqual({
        kind: "si",
        year: 2006,
        number: "246",
        fragmentKind: "regulation",
        fragmentNumber: "4",
      });
    });

    it("parses SI-number-first with trailing regulation: 'SI 2006/246, reg 4'", async () => {
      const { parseCitation } = await import("./legislation");
      expect(parseCitation("SI 2006/246, reg 4")).toEqual({
        kind: "si",
        year: 2006,
        number: "246",
        fragmentKind: "regulation",
        fragmentNumber: "4",
      });
    });

    it("parses a regulation number + SI title: 'reg 3 TUPE Regulations 2006'", async () => {
      const { parseCitation } = await import("./legislation");
      expect(parseCitation("reg 3 TUPE Regulations 2006")).toEqual({
        kind: "si-title",
        title: "TUPE Regulations 2006",
        year: 2006,
        fragmentKind: "regulation",
        fragmentNumber: "3",
      });
    });

    it("parses a full SI title with 'of the': 'regulation 4 of the Transfer of Undertakings (Protection of Employment) Regulations 2006'", async () => {
      const { parseCitation } = await import("./legislation");
      expect(
        parseCitation(
          "regulation 4 of the Transfer of Undertakings (Protection of Employment) Regulations 2006",
        ),
      ).toEqual({
        kind: "si-title",
        title:
          "Transfer of Undertakings (Protection of Employment) Regulations 2006",
        year: 2006,
        fragmentKind: "regulation",
        fragmentNumber: "4",
      });
    });

    it("parses title-first regulations: 'TUPE Regulations 2006, reg 4'", async () => {
      const { parseCitation } = await import("./legislation");
      expect(parseCitation("TUPE Regulations 2006, reg 4")).toEqual({
        kind: "si-title",
        title: "TUPE Regulations 2006",
        year: 2006,
        fragmentKind: "regulation",
        fragmentNumber: "4",
      });
    });

    it("parses an article fragment (not regulation)", async () => {
      const { parseCitation } = await import("./legislation");
      expect(parseCitation("art 3 of SI 2007/2194")).toEqual({
        kind: "si",
        year: 2007,
        number: "2194",
        fragmentKind: "article",
        fragmentNumber: "3",
      });
    });

    it("parses a bare Act title with no section", async () => {
      const { parseCitation } = await import("./legislation");
      expect(parseCitation("Companies Act 2006")).toEqual({
        kind: "act",
        title: "Companies Act 2006",
        year: 2006,
      });
    });

    it("returns null for unparseable input", async () => {
      const { parseCitation } = await import("./legislation");
      expect(parseCitation("this is not a citation")).toBeNull();
      expect(parseCitation("[2024] UKSC 12")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // resolveByTitle — Atom feed resolution
  // -------------------------------------------------------------------------
  describe("resolveByTitle", () => {
    it("resolves a modern Act to its canonical /type/year/number URI", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(CA2006_TITLE_FEED));
      const { resolveByTitle } = await import("./legislation");
      const result = await resolveByTitle("Companies Act 2006", 2006);
      expect(result).toEqual({
        resolved: true,
        uri: "/ukpga/2006/46",
        type: "ukpga",
        title: "Companies Act 2006",
      });
    });

    it("resolves a pre-1963 Act catalogued under a regnal-year id", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(LTA1954_TITLE_FEED_REGNAL));
      const { resolveByTitle } = await import("./legislation");
      const result = await resolveByTitle("Landlord and Tenant Act 1954", 1954);
      expect(result).toEqual({
        resolved: true,
        uri: "/ukpga/Eliz2/2-3/56",
        type: "ukpga",
        title: "Landlord and Tenant Act 1954",
      });
    });

    it("caches a resolved title for subsequent calls (single fetch)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(CA2006_TITLE_FEED));
      const { resolveByTitle } = await import("./legislation");
      await resolveByTitle("Companies Act 2006", 2006);
      const second = await resolveByTitle("Companies Act 2006", 2006);
      expect(second.resolved).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns {resolved:false, reason} when no feed entry matches", async () => {
      fetchMock.mockResolvedValue(jsonResponse(NO_RESULTS_FEED));
      const { resolveByTitle } = await import("./legislation");
      const result = await resolveByTitle("Nonexistent Statute 2099", 2099);
      expect(result.resolved).toBe(false);
      if (!result.resolved) {
        expect(result.reason).toMatch(/Nonexistent Statute 2099/);
      }
    });

    it("never throws — a fetch rejection surfaces as {resolved:false}", async () => {
      fetchMock.mockRejectedValue(new Error("network down"));
      const { resolveByTitle } = await import("./legislation");
      const result = await resolveByTitle("Whatever Act 2020", 2020);
      expect(result.resolved).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getProvision — CLML fetch + extraction
  // -------------------------------------------------------------------------
  describe("getProvision", () => {
    it("extracts heading, text, extent and unapplied effects for s.994 CA2006", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(CA2006_S994));
      const { getProvision } = await import("./legislation");
      const result = await getProvision("/ukpga/2006/46", {
        kind: "section",
        number: "994",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.provision.heading).toBe("Petition by company member");
      expect(result.provision.text).toContain("unfairly prejudicial");
      expect(result.provision.text).toContain(
        "A member of a company may apply to the court by petition",
      );
      expect(result.provision.extent).toBe("E+W+S+N.I.");
      expect(result.provision.outstandingEffects).toBe(true);
      expect(result.provision.unappliedEffects.length).toBe(2);
      expect(result.provision.unappliedEffects[0].notes).toMatch(
        /not applied to legislation\.gov\.uk/,
      );
      expect(result.provision.canonicalUrl).toBe(
        "https://www.legislation.gov.uk/ukpga/2006/46/section/994",
      );
    });

    it("extracts a regulation fragment from an SI (TUPE reg 4) with outstanding effects", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(TUPE_REG4));
      const { getProvision } = await import("./legislation");
      const result = await getProvision("/uksi/2006/246", {
        kind: "regulation",
        number: "4",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.provision.heading).toBe(
        "Effect of relevant transfer on contracts of employment",
      );
      expect(result.provision.text).toContain(
        "a relevant transfer shall not operate so as to terminate the contract of employment",
      );
      expect(result.provision.outstandingEffects).toBe(true);
    });

    it("reports outstandingEffects:false and an empty list when none are present", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(ERA1996_S98_CLEAN));
      const { getProvision } = await import("./legislation");
      const result = await getProvision("/ukpga/1996/18", {
        kind: "section",
        number: "98",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.provision.heading).toBe("General.");
      expect(result.provision.text).toContain("it is for the employer to show");
      expect(result.provision.outstandingEffects).toBe(false);
      expect(result.provision.unappliedEffects).toEqual([]);
    });

    it("returns {ok:false, reason} on a non-2xx response, never throwing", async () => {
      fetchMock.mockResolvedValue(jsonResponse("not found", { status: 404 }));
      const { getProvision } = await import("./legislation");
      const result = await getProvision("/ukpga/2006/46", {
        kind: "section",
        number: "99999",
      });
      expect(result.ok).toBe(false);
    });

    it("retries once on a 5xx response", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse("boom", { status: 502 }))
        .mockResolvedValueOnce(jsonResponse(CA2006_S994));
      const { getProvision } = await import("./legislation");
      const result = await getProvision("/ukpga/2006/46", {
        kind: "section",
        number: "994",
      });
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("caches provision fetches (second call for same uri/fragment/version hits cache)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(CA2006_S994));
      const { getProvision } = await import("./legislation");
      await getProvision("/ukpga/2006/46", { kind: "section", number: "994" });
      await getProvision("/ukpga/2006/46", { kind: "section", number: "994" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // lookupCitation / verifyCitation — end-to-end orchestration used by tools
  // -------------------------------------------------------------------------
  describe("lookupCitation", () => {
    it("resolves an act-section citation end to end", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(CA2006_TITLE_FEED))
        .mockResolvedValueOnce(jsonResponse(CA2006_S994));
      const { lookupCitation } = await import("./legislation");
      const result = await lookupCitation("s.994 Companies Act 2006");
      expect(result.resolved).toBe(true);
      if (!result.resolved) return;
      expect(result.canonicalUrl).toBe(
        "https://www.legislation.gov.uk/ukpga/2006/46/section/994",
      );
      expect(result.outstandingEffects).toBe(true);
    });

    it("returns {resolved:false, citation, reason} for an unparseable citation, never throwing", async () => {
      const { lookupCitation } = await import("./legislation");
      const result = await lookupCitation("not a real citation at all");
      expect(result.resolved).toBe(false);
      if (result.resolved) return;
      expect(result.citation).toBe("not a real citation at all");
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it("returns {resolved:false} when the Act title cannot be resolved", async () => {
      fetchMock.mockResolvedValue(jsonResponse(NO_RESULTS_FEED));
      const { lookupCitation } = await import("./legislation");
      const result = await lookupCitation("s.1 Nonexistent Statute 2099");
      expect(result.resolved).toBe(false);
    });
  });

  describe("verifyCitation", () => {
    it("returns {resolved:false, reason} for an SI that does not exist", async () => {
      fetchMock.mockResolvedValue(jsonResponse("not found", { status: 404 }));
      const { verifyCitation } = await import("./legislation");
      const bad = await verifyCitation("SI 2099/1");
      expect(bad.resolved).toBe(false);
      expect(bad.reason).toBeDefined();
    });

    it("returns {resolved:true, url} for a bare SI number that fetches OK", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(TUPE_REG4));
      const { verifyCitation } = await import("./legislation");
      const result = await verifyCitation("SI 2006/246");
      expect(result.resolved).toBe(true);
      expect(result.url).toBe("https://www.legislation.gov.uk/uksi/2006/246");
    });
  });

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------
  describe("search", () => {
    it("returns matches with title/type/year/number/url", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(CA2006_TITLE_FEED));
      const { search } = await import("./legislation");
      const matches = await search("Companies Act 2006");
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0]).toEqual({
        title: "Companies Act 2006",
        type: "ukpga",
        year: 2006,
        number: "46",
        url: "https://www.legislation.gov.uk/ukpga/2006/46",
      });
    });
  });
});
