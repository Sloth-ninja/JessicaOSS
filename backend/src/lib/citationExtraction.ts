/**
 * Citation extraction from free text (WS7 Citation Checker).
 *
 * Ported from evals/src/citations.ts — keep regexes in sync; extraction
 * fixtures duplicated in both suites. Only the extraction logic is ported:
 * this module deliberately does NOT import from evals/ (a standalone package
 * — see the design note in lib/legislation.ts header), and the evals resolver
 * is NOT ported either. Verification goes through `verifyCitation` in
 * lib/legislation.ts, the stronger resolver the chat tools already use.
 *
 * Case-law neutral citations (e.g. [2024] UKSC 12) currently have NO
 * permitted verification source: Find Case Law integration is deferred
 * pending The National Archives' computational-use licence, and BAILII must
 * never be used. Callers must surface these as unverifiable.
 */

export interface ExtractedCitation {
  raw: string;
  kind: "statute-section" | "act" | "si" | "neutral-case";
  title?: string;
  year?: string;
  number?: string;
  section?: string;
}

const ACT_TITLE =
  "([A-Z][A-Za-z()'\\u2019]*(?:\\s+[A-Za-z()'\\u2019]+)*?\\s+Act\\s+(\\d{4}))";

export function extractCitations(text: string): ExtractedCitation[] {
  const found = new Map<string, ExtractedCitation>();
  const add = (c: ExtractedCitation) => {
    const key = `${c.kind}|${c.title ?? ""}|${c.year ?? ""}|${c.number ?? ""}|${c.section ?? ""}`;
    if (!found.has(key)) found.set(key, c);
  };

  // "s.994 Companies Act 2006" / "section 994 of the Companies Act 2006"
  const sectionFirst = new RegExp(
    `\\b(?:s\\.?|ss\\.?|section)\\s*(\\d+[A-Z]*)\\s+(?:of\\s+the\\s+)?${ACT_TITLE}`,
    "g",
  );
  for (const m of text.matchAll(sectionFirst)) {
    add({
      raw: m[0],
      kind: "statute-section",
      section: m[1],
      title: m[2],
      year: m[3],
    });
  }

  // "Companies Act 2006, s 994"
  const actFirst = new RegExp(
    `\\b${ACT_TITLE}\\s*,\\s*(?:s\\.?|section)\\s*(\\d+[A-Z]*)`,
    "g",
  );
  for (const m of text.matchAll(actFirst)) {
    add({
      raw: m[0],
      kind: "statute-section",
      title: m[1],
      year: m[2],
      section: m[3],
    });
  }

  // Bare Act references ("the Employment Rights Act 1996") — resolved at Act level
  for (const m of text.matchAll(new RegExp(`\\b${ACT_TITLE}\\b`, "g"))) {
    const coveredBySection = [...found.values()].some(
      (c) => c.kind === "statute-section" && c.title === m[1],
    );
    if (!coveredBySection)
      add({ raw: m[0], kind: "act", title: m[1], year: m[2] });
  }

  // Statutory instruments by number: "SI 2006/246"
  for (const m of text.matchAll(/\bS\.?I\.?\s+(\d{4})\/(\d+)\b/g)) {
    add({ raw: m[0], kind: "si", year: m[1], number: m[2] });
  }

  // Neutral case citations: [2024] UKSC 12, [2023] EWCA Civ 1, [2022] EWHC 123 (Ch)
  for (const m of text.matchAll(
    /\[(\d{4})\]\s+(UKSC|UKPC|EWCA\s+(?:Civ|Crim)|EWHC|UKUT|UKFTT|EAT|UKEAT)\s+\d+/g,
  )) {
    add({ raw: m[0], kind: "neutral-case", year: m[1] });
  }

  return [...found.values()];
}
