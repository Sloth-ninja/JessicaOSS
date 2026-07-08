# Rubric — English-law SPA Review

Score each dimension 1–5; the overall score may not exceed `no_invented_facts`.

## issue_spotting_completeness

The review must cover: parties and target (including whether the target is a
subsidiary of the seller), the consideration and completion mechanism (completion
accounts vs locked box), conditions precedent and long-stop date, the scope of
warranties and whether a tax covenant is present, the limitations on liability
(cap, de minimis, basket, time limits), restrictive covenants, specific
indemnities, MAC/termination provisions, governing law and jurisdiction, and the
disclosure letter mechanism. 5 = all present and correctly prioritised; deduct for
each omitted category.

## correct_law

Statements about corporate structure, directors' duties, or statutory definitions
must be accurate under the Companies Act 2006. Any statutory reference must be
precise (e.g. `s.1159 Companies Act 2006` for the subsidiary definition, `s.178
Companies Act 2006` for the civil consequences of breach of directors' general
duties). Wrong or vague law caps this at 2.

## uk_terminology

UK English and UK corporate terminology throughout (company/Ltd/plc, "solicitor"
not "attorney", "completion" not "closing" where the agreement uses that language,
DD/MM/YYYY dates). Any US terminology from the CLAUDE.md table caps this at 3.

## no_invented_facts

Every factual claim (parties, figures, dates, clause references) must be
traceable to the source agreement supplied with the output. Any party, amount,
date, or clause reference not present in the source document is an invented
fact: score 1 and list each in `failures`.
