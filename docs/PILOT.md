# JessicaOS Pilot Programme

## Purpose

Before any public launch, JessicaOS is being piloted privately at
`jessicaoss.com` with a small group of solicitors at Aria Grace Law. The goal
is to find out, from real practitioners, whether the workflows, citations,
and UK terminology hold up in day-to-day use — and to fix what doesn't —
before opening the product up more widely. See `docs/DEPLOYMENT.md` for the
deployment side of this; this document is about the pilot programme itself.

## Invite flow

The pilot is **invite-only**. There is no public sign-up during the pilot
(see `docs/DEPLOYMENT.md` §3). Each pilot solicitor is added individually via
the Supabase dashboard (**Authentication → Users → Invite user**), which
sends a Supabase-templated email containing a magic sign-in link. There is no
separate JessicaOS-specific invite system — the Supabase invite email is the
only invite mechanism for the pilot.

If an invite email does not arrive, check the custom SMTP configuration
first (`docs/DEPLOYMENT.md` §3) — the pilot project must not rely on
Supabase's rate-limited built-in mailer.

## Ground rules for pilot solicitors

**Please use synthetic or public documents only until the owner and the
supervising solicitor have completed a data-protection review of this
deployment.** JessicaOS is a young platform; storage, logging, deletion, and
model-provider data flows for this specific pilot deployment have not yet
been reviewed for use with real client or matter documents. Treat this pilot
the same way you would treat any new, unaudited legal-tech tool: do not
upload privileged, confidential, client, matter, personnel, or firm
knowledge-management material. Use disposable NDAs, sample contracts, public
court documents, or other non-sensitive test files instead. `docs/safe-local-testing.md`
has more detail on the reasoning and on how to test the non-LLM flows first
if you want to get a feel for the app before adding any documents at all.
This restriction will be revisited once the review above has taken place; you
will be told explicitly if and when it changes.

## What feedback we want

- **Workflow accuracy** — did the generated summary, checklist, or tabular
  review correctly capture what's actually in the document? Any missed
  issues, wrong clause references, or invented facts?
- **UK terminology** — any place the assistant, a workflow template, or the
  UI used US legal terms or conventions instead of UK ones (see the
  terminology table in the project's `CLAUDE.md` if you want the full list
  we're checking against — e.g. "attorney" instead of "solicitor", US date
  formats, US citation styles).
- **Citation trust** — did every statutory citation look right, and could you
  verify it? Report anything that looks fabricated or unverifiable
  immediately — this is treated as a serious bug, not a style note.
- **Speed** — anywhere the assistant, document upload, or DOCX generation
  felt slow enough to interrupt your work.
- **Confusion points** — anywhere the interface, a workflow's purpose, or an
  assistant response was unclear or surprising.

## How to give feedback

Use the **Pilot Feedback** issue template on the repository's GitHub Issues
page (`.github/ISSUE_TEMPLATE/pilot-feedback.yml`). If you don't have GitHub
access, contact the person who invited you and they will file it on your
behalf.

## Expected cadence

The pilot is expected to run for around **two weeks** in the first instance,
with a review checkpoint at the end to decide whether to extend, adjust
scope, or move toward public launch. This may change based on how quickly
useful feedback comes in — you'll be told if the timeline shifts.

## A reminder for every pilot participant

**All JessicaOS output is AI-generated.** Every summary, checklist, tabular
review result, and drafted document must be reviewed by a qualified
solicitor before it is used or relied on for any purpose. JessicaOS is a
drafting and review aid, not a substitute for professional legal judgement.
