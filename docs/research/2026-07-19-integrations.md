# Integration research: Quill/Unity and HM Land Registry — 19 July 2026

> Condensed from two research agents. Owner decisions marked. UK English.

## Quill / Unity "Interactive API" (practice management — Aria Grace Law migrates to Unity)

**Docs:** https://github.com/quillpinpoint/interactive-api/wiki — 6 pages only.
**Per the owner (19 July 2026, relayed from Quill's team): this is the complete
documentation**, so absences are treated as real until Quill says otherwise. "Not strictly RESTful" (pre-REST design), JSON over HTTPS, two sub-APIs:
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

Sources: wiki pages [Home/Authentication/CRM-API/Money-API/Register-your-App/Useful-links](https://github.com/quillpinpoint/interactive-api/wiki) (fetched 19/07/2026); Clio: [developer docs](https://docs.developers.clio.com/) and [API reference](https://docs.developers.clio.com/clio-manage/api-reference/).

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

Sources (fetched 19/07/2026): [Business Gateway tech docs](https://landregistry.github.io/bgtechdoc/) incl. [REST developer guide](https://landregistry.github.io/bgtechdoc/rest/get_started/developer_guide/) and [FAQ](https://landregistry.github.io/bgtechdoc/support/FAQ/); [conditions of use (incl. clause 4.2)](https://www.gov.uk/government/publications/conditions-of-use-hm-land-registry-business-e-services/conditions-of-use-portal-and-business-gateway); [direct integration guidance + channel-partner contact](https://www.gov.uk/guidance/direct-integration-with-business-gateway); fees: [Dec 2024 changes](https://www.gov.uk/government/news/changes-to-fees-for-hm-land-registrys-information-services-from-december) and [current fee schedule](https://www.gov.uk/guidance/hm-land-registry-information-services-fees); open data: [Use land and property data API](https://use-land-property-data.service.gov.uk/api-documentation).

## Addendum — 28 July 2026 (registration + endpoint verification)

Verified live: the real platform domain is **`quill-interactive.co.uk`**
(`app.myquill.com` is only the "i4" web front-end per Quill's own discovery
document at `https://discovery.quill-interactive.co.uk/default.json`, which
lists api/auth/docs/interactiveService/time/search hosts). Aria Grace Law's
`tenantUri` is **`aria-grace-law-cic`** (from the Money API URL Quill supplied).
The first app registration was unusable for a server integration: its redirect
URI was `https://global.consent.azure-apim.net/redirect/unity-…` (Microsoft
Power Platform's consent endpoint), so authorisation codes could never reach
JessicaOS. Re-registered 28/07 via the Google form with **Authorisation Code
Flow** and redirect URI `https://api.jessicaoss.com/quill/oauth/callback`
(localhost variant requested; sandbox/rate-limit/multi-redirect questions
asked). Env contract for the connector: `QUILL_CLIENT_ID`,
`QUILL_CLIENT_SECRET`, `QUILL_TENANT_ID`, `QUILL_DOMAIN=quill-interactive.co.uk`,
`QUILL_REDIRECT_URI`; `tenantUri` auto-discovered at runtime. Spike gated on
the new credentials arriving; first spike test = two-user permissions
comparison (the wiki is silent on permission bounding).
