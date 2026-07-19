# Legal-language review log

> Running log of every legal-terminology and legal-content judgment made by agents in this
> fork, for review by a qualified solicitor. Items are grouped by status. When an item is
> reviewed, move it to "Signed off" with the reviewer's initials and date. This file is
> product copy provenance, not legal advice.

## Awaiting solicitor review

| # | Location | What was decided | Rationale / risk |
|---|---|---|---|
| R1 | `frontend/src/app/components/workflows/builtinWorkflows.ts` (LPA Review, carried-interest column) | Reworded to "the structure (fund-level waterfall, commonly called 'European', vs deal-by-deal, commonly called 'American')" — leads with the descriptive term, keeps both recognised market labels | Owner asked to keep market practice accurately described; both labels are genuine terms of art in PE fund structuring. Confirm the phrasing doesn't imply the labels are informal. |
| R2 | Disclosure Review template (same file) | Privilege split into three columns: legal advice privilege (confidential solicitor/legal adviser–client communication, dominant purpose of legal advice), litigation privilege (dominant purpose of litigation pending/reasonably contemplated), without prejudice (genuine settlement negotiations). CPR Part 31 / PD 57AD framing in the prompt | Direction decided by owner (MIGRATION_SPEC §6.1); exact tests paraphrased by agents — verify the dominant-purpose formulations are acceptable summaries. |
| R3 | Disclosure Review — without-prejudice column | No statutory citation given (protection is common-law) | Intentional; confirm. |
| R4 | Employment minima template — SSP column | No specific statute/SI cited (agents did not want to guess; candidates include the Social Security Contributions and Benefits Act 1992) | Add the correct citation if desired. |
| R5 | Employment minima template — pay column | Does not state a current NMW/NLW rate; instructs the model to flag that current rates must be verified | Rates change annually and no live rate source is integrated. |
| R6 | SPA Review — warranties column | References the presence of a tax covenant/tax deed without a citation (no single governing statute) | Confirm, or specify a house style. |
| R7 | Commercial Lease template — FRI column | `yes_no` format with supporting detail requested in the same answer | Matches existing template precedent; confirm binary-plus-basis is acceptable. |
| R8 | `evals/rubrics/disclosure-review.md` (correct_law section) | Keeps "lawyer–client communication" in the doctrinal description of legal advice privilege while the same rubric's terminology section prefers "solicitor" for role references | Legal advice privilege is not solicitor-specific as a matter of doctrine; confirm the distinction is wanted. |
| R9 | New template statutory citations | s.1159 / s.178 Companies Act 2006; s.24 / s.38A Landlord and Tenant Act 1954; SI 2006/246 regs 3, 4, 7, 13–15; s.1 / s.86 Employment Rights Act 1996; SI 1998/1833 regs 4, 13/13A; National Minimum Wage Act 1998; Pensions Act 2008; SI 1998/3132 (CPR) | Every citation resolves against the live legislation.gov.uk API (eval-gated); a solicitor should confirm each is cited for the right proposition in its column prompt. |
| R10 | All user-facing copy for the document-workspace feature (WS7, branch `ws7-matters-rename`: nav, breadcrumbs, modals, empty states, backend error details) | Workspace concept renamed "Project" → "Matter" in user-facing strings only ("New matter", "Matter not found", "Only the matter owner…"); identifiers, `/projects` URLs and DB names unchanged; "Project Finance" practice area deliberately untouched | "Matter" is the standard solicitors' term for a client engagement/file; confirm it also suits non-contentious document-workspace usage and that no string should instead say "case" or "file". |

## Signed off by owner (8 July 2026)

| # | Decision |
|---|---|
| S1 | "lawyers and legal professionals" retained in the assistant persona (umbrella usage). |
| S2 | "fetched opinion passage" → "fetched judgment passage" in the core system prompt. |
| S3 | Reference-rate examples now "(e.g. SONIA, SOFR, EURIBOR, base rate)" — SONIA added, others kept (USD tranches may legitimately reference SOFR). Prompt text only; no functional impact. |
| S4 | Parties example → "ABC Ltd, a company incorporated in England and Wales" (E&W is the product's default jurisdiction; Scotland and Northern Ireland support are future roadmap). |
| S5 | Examples are UK-first everywhere: governing-law example list leads with "English Law"; illustrative currency is GBP; browser date rendering pinned to `en-GB` in the five previously locale-floating spots; "bi-weekly" → "monthly, weekly, four-weekly". |
