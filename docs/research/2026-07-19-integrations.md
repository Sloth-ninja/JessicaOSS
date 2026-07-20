# Integration research: Quill/Unity and HM Land Registry — 19 July 2026

> Condensed from two research agents. Owner decisions marked. UK English.

## Quill / Unity "Interactive API" (practice management — Aria Grace Law migrates to Unity)

**Docs:** https://github.com/quillpinpoint/interactive-api/wiki — 6 pages only, and
**Quill's team has confirmed this is the complete documentation**, so absences are
real. "Not strictly RESTful" (pre-REST design), JSON over HTTPS, two sub-APIs:
CRM (`api.{quill-domain}/quillapi5/`, tenant via a header confusingly named
`ClientId`) and Money (`i3.{quill-domain}/api/{tenantUri}/`).

**Auth:** OpenID Connect / OAuth 2.0 Authorization Code flow. App credentials
issued manually by Quill via a Google Form (wiki → "Register your App"). Tokens are
**per-user** (a real Unity user logs in; 90-day refresh token; no machine-to-machine
flow) — every write is attributed to that solicitor. Storage fit: the MCP-connector
encrypted-blob pattern (per-user refresh token), app secret via env (`QUILL_*`).

**Capabilities:** create/read clients + contacts; create/read/search/archive cases
(matters); record time (`POST /TimeRecording`, keyed by `OrqaId` not `Code` — two
ID systems coexist, capture both); Money reads (WIP/balances/ledgers) and POST-only
billing writes; poll-based change feeds (`/clients-changed`, `/cases-changed`);
lookups (branches, case types, fee earners…). **No document/DMS API at all** — no
upload/download/list; the headline "push a DOCX into the DMS" is not buildable.
No sandbox, no published rate limits, no webhooks, no versioning policy. Quirks:
BST offset must be URL-encoded (`%2B`); Business hours-style availability unknown.

**Owner decisions:** integration **PARKED to v1.1** (after Playbooks + Word add-in);
owner gets Unity access w/c 20 July. Plan when picked up: **one-day read-only spike
against the live tenant as go/no-go** (token flow, list cases, one matter, one
ledger) → if sound, v1 = connect-account flow + `get_matter_details` +
**time-recording as the headline feature** + flag-gated `create_matter` (tested
with one throwaway case — no sandbox exists) + `file_document_to_dms` as an honest
stub. Registration form questions: sandbox? rate limits? tenant's `{quill-domain}`,
`TenantId`, `tenantUri`?

**Clio comparison (future second integration):** self-serve developer portal,
documented REST v4 (~282 endpoints), OAuth, **full Documents API** (the capability
Unity lacks), EU data residency. Better for the wider market; Unity matters because
the pilot firm runs it.

## HM Land Registry (Business Gateway)

**The per-user model the owner wants is exactly how Business Gateway works** — each
fee-earner's own Business e-services credentials ride in every request; £7/electronic
official copy bills to the *firm's* variable direct debit. **The catch:** JessicaOS
must itself become an authorised channel — development licence + HMLR-issued test
then production SSL certificate (mutual TLS identifies the platform), vendor
testing. Without that, users entering HMLR passwords into a third-party app breach
their own conditions of use (clause 4.2). No OAuth — literal passwords, so the
AES-256-GCM encrypted per-user path is mandatory when built.

**Onboarding:** email **channelpartners@landregistry.gov.uk** (dev licence + test
cert; ask whether REST endpoints for official-copy *ordering* are coming — much of
the transactional surface is still SOAP/XML). Test env `bgtest.landregistry.gov.uk`.
Fees since Dec 2024: £7 electronic copies; every live call is charged (no test mode
in production) → the product needs an explicit per-call cost confirmation + per-
matter audit trail. Caching is tenant-scoped only: never serve one firm's purchased
copy to another; register data is Crown copyright and personal data under UK GDPR.

**Recommended path:** **v1 (no agreement needed)** — open data (Price Paid /
landregistry.data.gov.uk SPARQL, CCOD/OCOD via use-land-property-data.service.gov.uk
with its no-resale licence) + deep links into the portal with the title pre-resolved;
solicitor uploads the purchased PDF into JessicaOS's existing document pipeline.
**v2** — Business Gateway proper once the channel-partner paperwork completes.
A "Land Registry — Connect account (coming soon)" nav stub ships with WS7.
