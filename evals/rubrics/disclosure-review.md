# Rubric — Disclosure Review

Score each dimension 1–5; the overall score may not exceed `no_invented_facts`.

## issue_spotting_completeness

For each document, the output must record: date, type of document, sender,
recipient(s), a concise factual summary, persons mentioned, and a considered
privilege assessment split across the three decided categories — legal advice
privilege, litigation privilege, and without prejudice — each with a Yes/No answer
and a short stated basis. 5 = all present and correctly reasoned; deduct for each
omitted category, and deduct further if the three privilege categories are
collapsed back into a single "privileged?" judgement.

## correct_law

Privilege conclusions must reflect the correct dominant-purpose tests: legal
advice privilege requires a confidential lawyer–client communication for the
dominant purpose of giving/receiving legal advice; litigation privilege requires
a confidential communication or document created for the dominant purpose of
litigation that was pending, reasonably contemplated, or existing; without
prejudice protection requires a genuine attempt at settlement negotiation. The
disclosure process itself should be correctly framed under CPR Part 31 (and, if
mentioned, PD 57AD in the Business and Property Courts) — no case-law citations
should appear (Find Case Law is deferred; BAILII is prohibited). Wrong or vague
law, or any case-law citation, caps this at 2.

## uk_terminology

UK English and UK litigation terminology throughout ("disclosure" not
"discovery", "solicitor" not "lawyer" where a role is meant, "claimant" not
"plaintiff", DD/MM/YYYY dates). Any US terminology from the CLAUDE.md table caps
this at 3.

## no_invented_facts

Every factual claim (dates, senders, recipients, document content) must be
traceable to the source document supplied with the output. Any detail not
present in the source is an invented fact: score 1 and list each in `failures`.
