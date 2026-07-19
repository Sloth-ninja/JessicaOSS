# Competitor scan: Legora and Harvey — 19 July 2026

> Condensed from two parallel research agents (web sources cited inline). Purpose:
> identify high-value, easy-to-build features for JessicaOS and record what NOT to
> copy. Owner decisions taken the same evening are marked ✅/❌.

## Where JessicaOS already wins (both scans agree — market these)

1. **Per-user BYO model keys + local/open-weights mode.** Harvey offers customers
   no model choice at all (admin-gated selection among Harvey-provisioned models);
   Legora is cloud-only, Azure/OpenAI/Google-centric, no Anthropic, no self-hosting.
   JessicaOS's encrypted per-user keys + `LOCAL_LLM_*` mode have no analogue.
2. **Live, falsifiable citation verification.** Harvey markets a self-reported
   ~0.2% hallucination rate (independently contested — Stanford RegLab, JELS 2025);
   Legora's citations are source-level with no disclosed methodology. JessicaOS
   verifies against legislation.gov.uk live and treats an unverifiable citation as
   a red build (hard rule 5).
3. **Companies House integration** — neither competitor has one.
4. **UK-specific workflow templates** (SPA, LTA 1954 lease, TUPE, disclosure) —
   Legora's template library has no named UK-transactional equivalents.
5. **MCP connector openness** — neither supports MCP; both do bespoke enterprise
   integrations only.
6. **Small-firm accessibility** — Harvey: ~$1–2k/seat/month, 25–50 seat minimums;
   Legora: ~10-seat floor, demo-gated, no public pricing. Both structurally exclude
   the small UK practices JessicaOS serves.

## Feature inventories (compact)

**Harvey** (harvey.ai): Assistant; Vault (100k-file tabular analysis); Knowledge
(500+ licensed sources incl. Ask LexisNexis); Agent Builder (500+ prebuilt, 25k
customer-built agents); Word/Outlook add-in (unified Ask+Edit, native tracked
changes); Deep Research; DMS connectors (iManage, NetDocuments, SharePoint, Box,
Aderant, Ironclad); Command Center admin analytics; Shared Spaces; mobile app;
FDE-embedded onboarding. UK: A&O Shearman (agentic packs), Macfarlanes (~80%
adoption), UK subsidiary CH #15905232. Sources: harvey.ai/platform, /security,
help.harvey.ai, aoshearman.com news, lawnext.com.

**Legora** (legora.com, ex-Leya, $5.6B val, $100M ARR): Tabular Review (with
collaboration: lock cells, mark-as-reviewed); Playbooks (firm red-lines applied in
Word add-in); Agent + "aOS"; Word Actions (fill template, anonymise, translate via
DeepL); Editor; Workflows (no-code); Lists (checklists/chronologies with per-row
clause citations); Portal (client-facing branded Q&A); Legal Research (UK content
via FromCounsel partnership); DMS (iManage, NetDocuments, SharePoint, Datasite);
Outlook add-in; Docusign. UK: Linklaters firmwide (~3,000 lawyers), Trowers &
Hamlins, Bird & Bird. Sources: legora.com/product/*, /newsroom, artificiallawyer.com,
imanage.com/technology-partners/legora.

## Ranked gaps for JessicaOS (value × ease on existing architecture)

| # | Feature | Effort | Status | Build shape |
|---|---|---|---|---|
| 1 | Admin usage dashboard (Command Center-lite) | S | queued next | SQL views over existing chat/workflow/doc tables + one admin page |
| 2 | Saved extraction schemas for Tabular Review → Lists (status/assignee/cite-to-clause columns; closing checklists, disclosure trackers) | S–M | queued next | extend tabular engine + template picker |
| 3 | Playbooks (firm red-lines → automated tracked-changes review) | M | ✅ approved | new rules table + tool in the existing tool-loop driving `docxTrackedChanges.ts` |
| 4 | Word add-in (Office.js task pane over existing /chat SSE + doc tools) | M | ✅ approved | thin client; Supabase JWT auth reused |
| 5 | Tabular collaboration (Supabase Realtime presence/locking/comments) | M | later | extends tabular data model |
| 6 | Portal (client-facing cited Q&A per matter) | L | deferred | new user class + permission boundary — post-pilot |
| — | Translate (DeepL) | S | ❌ rejected by owner | weak fit for domestic UK practice |

## Do-not-copy list

- Training a proprietary foundation model (stay pluggable; never out-train labs).
- Paid content aggregators (Lexis/FromCounsel-style walled gardens) — against the
  open-data ethos; BAILII remains prohibited, Find Case Law awaits TNA licence.
- FDE/white-glove GTM; enterprise-only opaque pricing; seat minimums.
- Legora's consumption/credit billing ("pay for the work, not for it being right").
- Citation-accuracy marketing without disclosed methodology — keep hard rule 5.
- Cloud-only lock-in; single-vendor model routing.
- Hiding prompt/playbook logic from end clients (sits badly with AGPL transparency).
