# Rubric — Employment Contract vs Statutory Minima

Score each dimension 1–5; the overall score may not exceed `no_invented_facts`.

## issue_spotting_completeness

For each column, the output must (1) extract the contractual term, (2) state the
applicable statutory minimum, and (3) flag clearly whether the term meets,
exceeds, or falls short of that minimum. Columns to cover: written particulars,
notice, holiday, working hours/48-hour opt-out, pay vs National Minimum Wage,
sick pay (SSP), and pension auto-enrolment. 5 = all present, each with a clear
compliant/shortfall conclusion; deduct for each omitted column or column missing
the three-part structure.

## correct_law

Statutory-minimum statements must be accurate: s.1 Employment Rights Act 1996
(written particulars), s.86 Employment Rights Act 1996 (minimum notice — one
week per complete year up to 12 years, minimum one week after one month's
service), reg 13 / reg 13A Working Time Regulations 1998 (SI 1998/1833) (5.6
weeks' statutory holiday), reg 4 Working Time Regulations 1998 (SI 1998/1833)
(48-hour average weekly limit and opt-out requirements), National Minimum Wage
Act 1998 (current rate should be flagged as needing verification rather than
asserted from memory), and Pensions Act 2008 (auto-enrolment). Wrong or vague law
caps this at 2.

## uk_terminology

UK English and UK employment terminology throughout ("notice period", "statutory
sick pay", "annual leave" not "PTO", DD/MM/YYYY dates). Any US terminology from
the CLAUDE.md table caps this at 3.

## no_invented_facts

Every contractual term (rate of pay, notice period, holiday days, hours) must be
traceable to the source contract supplied with the output. Any contractual term
not present in the source is an invented fact: score 1 and list each in
`failures`.
