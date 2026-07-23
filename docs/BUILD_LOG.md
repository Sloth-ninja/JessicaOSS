# JessicaOS Build Log

> Running record of what was done, by whom, and how it was verified — one entry per
> PR/workstream, newest first. Every PR must append an entry here (CLAUDE.md,
> definition of done). Keep entries factual: scope, key changes, verification
> evidence, decisions taken, anything deferred.

---

## 2026-07-23 — WS8 PR E: connectors gallery (branch `ws8-connectors-gallery`)

**Scope:** turn the personal MCP-connector page into a curated gallery — a Popular
row, All/Connected/Not-connected filters, a status column ("Connection issue"),
and one-click Connect for verified providers — plus a firm-admin curation card and
the org-scoped `enabled_connector_ids` shortlist (column already present from PR A).
Honesty rule strictly applied: a provider is only one-click if a public remote MCP
server with OAuth was verified to exist; everything else is an informational
"custom" entry with no dead Connect button.

**Provider verification (July 2026).** Each candidate checked for a public remote
MCP endpoint + OAuth before being listed one-click. The existing OAuth machinery
completes one-click either via Dynamic Client Registration (DCR) or via
env-provisioned client credentials keyed by host prefix (`oauthClientEnvFor`;
Google = `GOOGLE_MCP_OAUTH_*`).

| Provider | Verified endpoint / finding | Classification | Source |
|---|---|---|---|
| Google Drive | `https://drivemcp.googleapis.com/mcp/v1`, official, OAuth 2.0 (env prefix `GOOGLE_MCP_OAUTH`; code already first-classes Google) | **oauth** (Popular) | developers.google.com/workspace/guides/configure-mcp-servers |
| Gmail | `https://gmailmcp.googleapis.com/mcp/v1`, official, OAuth 2.0 | **oauth** (Popular) | developers.google.com/workspace/guides/configure-mcp-servers |
| Google Calendar | `https://calendarmcp.googleapis.com/mcp/v1`, official, OAuth 2.0 | **oauth** (Popular) | developers.google.com/workspace/calendar/api/guides/configure-mcp-server |
| Canva | `https://mcp.canva.com/mcp`, official, OAuth 2 + **DCR** (no operator config) | **oauth** | canva.dev/docs/mcp |
| Apollo.io | `https://mcp.apollo.io/mcp`, official, Streamable HTTP + OAuth (metadata published; browser sign-in) | **oauth** | docs.apollo.io/docs/apollo-mcp |
| Microsoft 365 / SharePoint / Outlook | No official Microsoft-hosted public remote MCP; only self-hosted community servers needing each firm's own Entra app | **custom** | github.com/softeria/ms-365-mcp-server |
| DocuSign | Hosted MCP exists (`mcp-d.docusign.com/mcp`) but in **beta**; production needs beta-programme enrolment | **custom** | fast.io/resources/mcp-server-for-docusign |
| Slack | Official hosted `mcp.slack.com/mcp` but **no DCR** — each firm registers its own Slack OAuth app | **custom** | truto.one/blog/best-mcp-server-for-slack-in-2026 |
| Microsoft Teams | No official Microsoft-hosted MCP; third-party/community only | **custom** | improvado.io/mcp/microsoft-teams |
| HubSpot | Official hosted `mcp.hubspot.com` (GA Apr 2026) but requires a HubSpot "MCP auth app" for credentials (not pure DCR) | **custom** | developers.hubspot.com/changelog/remote-hubspot-mcp-server-is-now-generally-available |
| Clio | No vendor-hosted MCP; open-source self-hosted, firm's own Clio OAuth app. Surfaced (UK-legal relevant) as informational | **custom** | github.com/oktopeak/clio-mcp |

Per-entry sources are also recorded as code comments in `mcpConnectorRegistry.ts`.

**Backend.**
- `lib/mcpConnectorRegistry.ts` — the curated constant (id/name/description/category/
  popular/availability, `serverUrl`+`authType`+`oauthEnvPrefix` for one-click) with
  `getConnectorRegistryEntry`, `isOneClickEntry`, `connectorRegistryIds`.
- `lib/mcpConnectorGallery.ts` — pure `deriveConnectionStatus`
  (connected/not_connected/connection_issue from matched/enabled/oauthConnected/
  most-recent-audit-error), `filterRegistryByOrgCuration` (empty ⇒ all), and
  `buildConnectorGallery` (registry × the caller's connectors, matched by canonical
  server URL, + unmatched customs appended).
- `lib/organisations.ts` — `getOrganisationEnabledConnectorIds` (42703-tolerant → [])
  and `setOrganisationEnabledConnectorIds`.
- `routes/user.ts` — `GET /user/connector-gallery` and `POST
  /user/connector-gallery/:registryId/connect` (create-or-reuse + start OAuth via
  existing machinery; `requireMemberPolicy("memberMcpConnectors")` + MFA gated;
  unknown/custom/not-curated id → 404 generic; SSRF guard preserved — the constant
  registry URL still flows through `validateRemoteMcpUrl`). All via `asyncHandler`.
- `routes/admin.ts` — `GET /admin/connector-gallery` (registry view, no server URLs)
  + `PATCH /admin/connector-gallery` (requireAdmin + MFA; validates every id against
  the registry, de-dupes, empty array = all visible).

**Frontend.**
- `account/connectors/page.tsx` rebuilt per the approved mock-up: Popular cards,
  filter tabs with counts, list with Type/Status and initial-letter tiles (NO real
  brand-logo assets), "Add ▾" menu retaining the existing custom-connector form as
  "Add custom connector". One-click Connect reuses the existing OAuth popup (helper
  `waitForOAuthPopup` extracted and shared). PR #38's neutral FirmManagedCard is
  preserved when the firm blocks personal connectors.
- `admin/firm-settings/page.tsx` — a "Connectors" curation card (checkbox list;
  empty stored curation renders as all-ticked = "all visible"; full tick-list saved
  back as [] canonical). MFA-guarded.
- `lib/mikeApi.ts` — `getConnectorGallery`, `connectGalleryConnector`,
  `getConnectorGalleryCuration`, `updateConnectorGalleryCuration` + types.

**Decisions / deviations.**
- Mock-up drew Microsoft 365 and DocuSign as one-click Popular cards; the honesty
  rule overrides the mock-up — both are "custom" (no verified DCR-capable public
  endpoint). Popular row is the three verified Google Workspace connectors.
- Policy-off members see the preserved neutral FirmManagedCard (not a gallery with
  disabled Add), because the connect route is policy-gated — a visible gallery would
  show only dead Connect buttons, contradicting the honesty rule.
- No migration, no new env vars (`enabled_connector_ids` exists from PR A;
  `GOOGLE_MCP_OAUTH_*` already consumed by `oauthClientEnvFor`).

**Verification.**
- Backend `npx tsc --noEmit` clean; `npx vitest run` **252 passed** (22 files),
  incl. **43 new** across `mcpConnectorRegistry.test.ts` (registry/honesty
  invariants), `mcpConnectorGallery.test.ts` (status derivation, org filtering incl.
  empty=all, unmatched customs), `routes/admin.test.ts` (curation authz + validation
  + empty-allowed) and `routes/user.connectorGallery.test.ts` (connect policy-gating
  403, unknown/custom id 404, curation exclusion, reuse-no-duplicate, happy path).
- Frontend `npx tsc --noEmit` clean; `eslint` on the three changed files at baseline
  (connectors page carries the same 3 pre-existing warnings as origin/main; no new
  problems).
- `npm run evals:smoke` from the main checkout: 4 passed / 0 failed.

**Integration note:** branched off origin/main before PR #39 (usage dashboard) landed;
expect only trivial conflicts (firm-admin sidebar, CLAUDE.md, BUILD_LOG) at merge.

---

## 2026-07-23 — Session handover refresh (branch `ws8-handover-refresh`)

**Scope:** docs-only, closing out the 21–23 July session for a fresh one.
`docs/HANDOVER.md` §3a rewritten to the live WS8 state (A/C/B/D merged +
deployed + firm seeded; PR E in flight; composed-range review, deploy, and
PRs F/G with their bundled-migration authorisation as the exact pickup steps),
§4a records the owner's 22/07 F/G decisions, and the two approved mock-up
artifact URLs are recorded (session scratchpads do not survive). `CLAUDE.md`
Current status updated to match, plus a new architectural rule (owner decision
22/07): new capability in self-contained modules with clean seams to upstream,
for licensing optionality (owner copyright in solely-authored modules).

**Verification:** docs-only diff; PR numbers/states checked against `gh pr
list`; artifact URLs are the published pages from this session; CI green on
the PR.

---

## 2026-07-22 — WS8 PR D: admin usage dashboard (branch `ws8-usage-dashboard`)

**Scope:** a read-only firm usage overview for organisation admins. One new
admin endpoint aggregates existing activity (chats, tabular reviews as workflow
runs, documents) into period totals, per-member activity, per-workflow-template
runs and a per-day chat trend; a new `(pages)/admin/dashboard` page renders it
per the approved mock-up (screen 1). **No migration, no new event capture, no
new env vars** — everything is derived from tables that already exist.

**Backend.**
- New `lib/usageStats.ts` — `getOrganisationUsage(db, orgId, {days, now})`
  composes the whole payload. **Watertight org-scoping:** member uuids come
  solely from `user_profiles` filtered by `organisation_id` (via the existing
  `listOrganisationMembers`, which also supplies name + email); every event
  query is then filtered to that id set, so another firm's rows can never be
  counted. **uuid→text gotcha handled:** `user_profiles.user_id` is uuid but
  `chats`/`tabular_reviews`/`documents.user_id` are TEXT — the ids are resolved
  first and the text columns filtered by those string ids (`.in()`), never a
  cross-type join. Narrow selects (`created_at, user_id[, workflow_id]`) floored
  at 30 days; all windowing/bucketing done in code (fine at pilot scale). `now`
  is injectable for deterministic tests. Empty-member orgs short-circuit (no
  `IN ()`). Decision: the workflow-template table always reports both a 7d and a
  30d column and last-active spans the 30d fetch, so the fetch floor is 30 days
  regardless of the `?days` toggle (still a cap, never an all-time scan); the
  toggle governs the tiles, member activity columns and the daily trend.
- `routes/admin.ts` adds `GET /admin/usage` (`requireAdmin` router-level,
  `asyncHandler`): `?days=7|30` (clamped by `normaliseUsageDays`, default 7),
  org resolved from the caller, fixed 403 detail when orgless. No mutation, so
  no MFA step-up (mirrors the other admin GETs).

**Frontend.**
- New `(pages)/admin/dashboard/page.tsx`: four stat tiles, a restrained SVG
  daily bar chart (single grey-900 accent, one faint baseline, DD/MM labels,
  tabular figures, per-bar values only in the 7d view — dataviz skill),
  a per-member activity table and a per-workflow-template table (both reuse the
  firm-settings light-grid pattern). 7d/30d period switch, loading skeletons and
  an error+retry state (incident discipline: never a bare spinner). Admin-gated
  on `profile.isAdmin` with a redirect, mirroring Firm settings. The data fetch
  runs in an `AbortController`-scoped effect with **no synchronous setState**
  (skeleton reset lives in the period/retry handlers) to satisfy the
  `react-hooks/set-state-in-effect` lint.
- `mikeApi.ts`: `getFirmUsage(days, signal)` + `FirmUsage*` types.
- `AppSidebar.tsx`: a **Dashboard** item (BarChart3) added above Firm settings in
  the existing isAdmin-gated Firm admin group.

**Tests.** `lib/usageStats.test.ts` (10 tests, fake chainable db supporting
`.in()`/`.gte()`): the watertight another-org-excluded case; uuid-string →
TEXT matching; multi-member totals + per-member counts with emails; empty org
(zeros + full zero-filled series); single member with null last-active; 7d
window edges (day −6 IN, day −7 OUT) + daily bucketing; last-active surfacing a
beyond-window-but-within-30d event; workflow 7d/30d split + last run + null
workflow_id handling; 30d period. `normaliseUsageDays` clamping.

**Verification.** Backend `tsc --noEmit` clean; `vitest run` **234 passed (20
files)**, incl. the 10 new. Frontend `tsc --noEmit` clean; ESLint on the three
changed files introduces **no new errors** (the one reported is the pre-existing
`AppSidebar` `setShouldAnimate` baseline error on an untouched line). `npm run
evals:smoke` from the main checkout: **4 passed, 0 failed**. Terminology: DD/MM/
YYYY dates, "Matters"/"solicitor"-consistent copy, UK English throughout.
**Deviation from the definition of done (UI screenshots):** the chart and tables
were NOT screenshotted in a running app — geometry was validated by reasoning
(7d shows per-bar values; 30d suppresses them and thins date labels to ~6 ticks)
and by parity with the approved mock-up (screen 1), not a live render.

**Deferred / decisions.** No usage-event table introduced — counts are proxies
from existing tables (a chat row = a chat; a tabular_reviews row = a workflow
run; a documents row = a document). If richer usage analytics are wanted later,
that is a separate migration-bearing PR. Workflow-template rows with an
unresolved/`null` `workflow_id` are excluded from the template table but still
counted in the workflow-runs total.

---

## 2026-07-22 — WS8 PR B: firm policy enforcement (keys + connectors) (branch `ws8-policy-enforcement`)

**Scope:** make the two firm policies from PR C real. When a caller belongs to a
firm whose policy is OFF, the matching personal WRITE routes are blocked (403,
fixed detail) and the matching member UI surface is hidden; admins can now flip
the policies live from Firm settings. Orgless self-hosters and policy-ON firms
are unchanged everywhere. No migration (`allow_member_api_keys` /
`allow_member_mcp_connectors` already exist from PR A); no new env vars.

**Backend.**
- New middleware factory `requireMemberPolicy(policy, detail)` in
  `middleware/auth.ts`: reuses the existing org lookup (`resolveUserOrganisation`)
  and gates a write route on a firm policy. Orgless callers and policy-ON firms
  pass through; a policy-OFF firm gets a fixed 403 detail. **Admins are NOT
  exempt** — an admin's personal-key / personal-connector writes follow the same
  member policy (admins manage these on the firm surface; simpler and safer).
  **Deliberate fail-open:** on ANY org-lookup error the middleware logs
  (`safeErrorLog`) and calls `next()` as though the policy were ON — transiently
  blocking a member's own writes on a DB hiccup is worse for availability than a
  brief policy gap, and the whole body is wrapped so a rejection can never escape
  as an unhandled rejection or hang the request (DURABLE_LESSONS 2026-07-21).
- Gated write routes (`routes/user.ts`): `PUT /user/api-keys/:provider`
  (`memberApiKeys`, "Personal API keys are managed by your firm."; the null-save
  "delete" is the same route, so it is blocked too) and the personal MCP
  connector writes — `POST /user/mcp-connectors`, `PATCH` + `DELETE
  /mcp-connectors/:connectorId`, `POST /mcp-connectors/:connectorId/oauth/start`
  (`memberMcpConnectors`, "Connectors are managed by your firm."). The gate runs
  BEFORE `requireMfaIfEnrolled` so a blocked write never prompts for step-up.
  **Reads stay open** (`GET` list/detail, plus `refresh-tools` / tool-toggle on
  existing connectors) so a member's existing connectors keep working in chat —
  only create/reconfigure/connect is gated, per the approved plan's explicit list.
- `organisations.ts` adds `updateOrganisationPolicies(db, orgId, patch)` —
  writes only the provided flags, select-back returns the authoritative state.
- `routes/admin.ts` adds `PATCH /admin/policies` (`requireAdmin` router-level +
  `requireMfaIfEnrolled`, `asyncHandler`): body `{memberApiKeys?,
  memberMcpConnectors?}` (booleans; at least one; unknown fields 400), scoped to
  the caller's own firm, returns `{ policies }`.

**Frontend.**
- New `(pages)/account/firmPolicy.tsx`: `personalApiKeysBlocked` /
  `personalConnectorsBlocked` helpers + a neutral `FirmManagedCard`.
- `account/layout.tsx` filters its TABS: the **API Keys** tab is absent when the
  firm's `memberApiKeys` is off, **Connectors** when `memberMcpConnectors` is off
  (org non-null). Default-permissive while the profile loads, so a tab never
  flickers away after paint. Direct navigation to a hidden route renders the
  neutral "Managed by your firm" card (api-keys + connectors pages), never an
  error. Model Preferences shows the "Model access is provided by <firm>" note
  when personal keys are off. Company Search's "add a key" empty state points a
  policy-OFF member at their firm admin instead of the hidden API Keys tab.
- Firm settings **Policies card is now live**: two `AccountToggle`s with an
  optimistic flip inside the MFA-guarded action, rollback on error, and a
  `reloadProfile()` on success so the admin's own tabs update immediately.
- `mikeApi.ts` adds `updateFirmPolicies`.

**Decisions.**
- *Admins are not exempt from the member key/connector write gate* — they use the
  firm-keys surface; one rule for the whole firm is simpler and safer than a
  role carve-out. Admins are of course NOT blocked from the `/admin` firm-key or
  policy routes.
- *Fail-open on lookup error* (see backend note) — availability over a brief,
  self-correcting policy gap; logged + code-commented at the seam.
- *Connector reads/refresh/tool-toggle stay open* — the plan gates
  create/update/delete/oauth-start; existing connectors must keep working in chat.

**Follow-up (independent review, round 2 — approve-with-fixes).**
- *Pre-existing personal keys under policy-OFF are now honestly inert, not
  silently active.* Two halves:
  (a) **Removal always allowed.** `requireMemberPolicy` gained an optional
  `shouldGate(req)` predicate; on `PUT /user/api-keys/:provider` only a real
  (non-empty) SAVE is gated — a null/empty api_key (removal) always passes, so
  members can always clean up their own keys (removal complies with the policy).
  (b) **Resolution is policy-aware.** `getUserApiKeys` / `getUserApiKeyStatus`
  now resolve the caller's org id AND `allow_member_api_keys` in ONE query
  (`getUserOrganisationKeyContext`, reused from the firm-key layer — no second
  lookup); when the policy is off the personal-key layer is SKIPPED (resolution =
  firm > env; status source never `"user"`). The existing fail-open is preserved:
  on an org/policy lookup error the personal key still applies (availability
  first). A saved-but-unused key is reported in a new optional
  `ApiKeyStatus.inertPersonalKeys` so the member can remove it.
- *Frontend:* the api-keys "managed by your firm" card now lists any lingering
  personal key with a **Remove** action and copy ("Your saved key is not
  currently used — your firm provides keys. You can remove it."), MFA-guarded,
  `reloadProfile` on success. `inertPersonalKeys` threads through
  `UserProfileContext`.
- *Minor:* comment at `GET /mcp-connectors/oauth/callback` noting it is
  transitively protected by the gated `oauth/start` (valid `state` only mintable
  there); corrected the `account/layout.tsx` default-permissive comment to state
  the real tradeoff (a policy-OFF tab may flash in then vanish during profile
  load — chosen so orgless / policy-ON stay flash-free; routes are
  server-enforced + neutral-carded).

**Verification.**
- Backend `npx tsc --noEmit` clean; `npx vitest run` **224 passed / 19 files**
  (round-2 additions: `userApiKeys.test.ts` policy-off resolution — personal key
  skipped for `getUserApiKeys` + status source `firm`/`env` + `inertPersonalKeys`
  + fail-open-still-includes-personal; `auth.policy.test.ts` save-only gate —
  SAVE→403, removal(null/empty)→pass).
- Superseded first-round count below (215) — kept for provenance:
- Backend `npx tsc --noEmit` clean; `npx vitest run` **215 passed / 19 files**
  (new `middleware/auth.policy.test.ts`: OFF→403 both details, ON→pass,
  admin-not-exempt→403, orgless→pass, lookup-error→fail-open-pass;
  `admin.test.ts` extended: PATCH /policies authz, MFA-gate, validation×3,
  scoped persistence; `user.serialize.test.ts` unchanged-shape still green).
- Frontend `npx tsc --noEmit` clean; ESLint 0 errors on changed files (only
  pre-existing baseline warnings in `connectors/page.tsx`). No framework for
  frontend unit tests yet — manual states to verify: member policy-OFF (tabs
  absent, direct-nav neutral cards, models note, company-search note), admin
  toggles (optimistic + rollback on induced error, MFA step-up), orgless
  (everything visible, no gating).
- Backend changed src files are 4-space and not prettier-clean on `main` (no
  prettier config; DURABLE_LESSONS 2026-07-07) — edits match existing style,
  `prettier --write` deliberately NOT run; the new test file is prettier-clean.
- `npm run evals:smoke` from the main checkout: 4 passed / 0 failed.

---

## 2026-07-22 — WS8 PR C: firm API keys, admin area, member roles (branch `ws8-firm-keys`)

**Scope:** the first user-visible firm-administration surface, built on the PR A
(#34) foundation. Admins get a **Firm settings** screen to manage the firm's
shared provider API keys and members' roles; every member's resolved API key now
layers **user > firm > env**. No new migration — the `organisation_api_keys`
table already exists from PR A. Orgless self-hosters are unchanged everywhere.

**Backend.**
- New `src/lib/apiKeyCrypto.ts`: the AES-256-GCM encrypt/decrypt (scheme
  unchanged, same key derivation) extracted from `userApiKeys.ts` so firm keys
  reuse it. `userApiKeys.ts` keeps thin wrappers (personal-key call sites + log
  tag untouched — minimal diff).
- New `src/lib/organisationApiKeys.ts`: `getOrganisationApiKeyStatus` (per-
  provider booleans, never key material), `getOrganisationApiKeys` (decrypted
  map, undecryptable rows skipped + logged), `saveOrganisationApiKey`
  (upsert/delete-on-empty, `onConflict organisation_id,provider`).
- `userApiKeys.ts` precedence extended to **user > firm > env**: `ApiKeySource`
  gains `"firm"`; both `getUserApiKeys` and `getUserApiKeyStatus` resolve the
  caller's org (`getUserOrganisationId`) and layer the firm's keys between env
  and personal. Orgless / unmigrated (42703) users skip the firm layer entirely.
- `organisations.ts` adds `getUserOrganisationId` (lightweight, 42703-tolerant),
  `listOrganisationMembers` (profile fields + auth email via `admin.listUsers`),
  and `setMemberRole` — scoping + double-submit safety encoded in the UPDATE
  predicate (`.eq(user_id).eq(organisation_id)` + select-back; zero rows ⇒
  `not_found`), plus a **last-admin guard** that counts the other admins
  immediately before a demotion and refuses (`last_admin`) when none remain. No
  RPC (no migration authorised); the residual check-then-write window is
  acceptable at pilot scale and noted for a future DB-function upgrade.
  **Recovery** if two concurrent demotions ever raced a firm to zero admins: an
  operator re-promotes a member directly on production Supabase with the
  service_role (SQL editor), scoped to the firm —
  `update public.user_profiles set role = 'admin', updated_at = now() where user_id = '<USER_ID>' and organisation_id = '<ORG_ID>';`
  — then the firm has an admin again and can self-manage.
- New `src/routes/admin.ts`, mounted at `/admin` in `index.ts`, all behind
  `requireAuth` + `requireAdmin` (router-level), every handler `asyncHandler`-
  wrapped with fixed generic details: `GET /admin/firm-keys`,
  `PUT /admin/firm-keys/:provider` (+ `requireMfaIfEnrolled`, delete-on-null),
  `GET /admin/members`, `PATCH /admin/members/:userId/role` (+
  `requireMfaIfEnrolled`; 409 last-admin, 404 out-of-firm, 400 bad role).

**Frontend.**
- `AppSidebar` gains a **Firm admin** group (label + "Firm settings" link),
  rendered only when `profile.isAdmin`. Dashboard is deferred to PR D (not
  stubbed).
- New `(pages)/admin/firm-settings/page.tsx`: Members (list, role badges,
  promote/demote with confirm + MFA step-up, last-admin demote disabled client-
  side, invite note pointing at Supabase for now), Firm API keys (per-provider
  rows, "Used by all members / your own key takes priority" note), and a
  read-only Policies preview card ("enforced in the next update" — enforcement
  is PR B, not faked here). Non-admins are redirected to `/assistant`.
- `account/api-keys` surfaces the new firm state: "Provided by your firm — your
  own key takes priority if added" (no Remove on a firm-provided key).
- `mikeApi.ts`: `ApiKeySource` gains `"firm"`; new `getFirmApiKeyStatus`,
  `saveFirmApiKey`, `getFirmMembers`, `updateFirmMemberRole` + types.

**Tests.** Backend vitest **201 passing** (was 175): rewrote `userApiKeys.test.ts`
to a table-aware mock covering the full user/firm/env/orgless precedence matrix
plus firm-layer read-failure degradation (skip firm, keep user/env); new
`organisationApiKeys.test.ts` (encrypt→decrypt round-trip, status booleans,
delete-on-empty, org scoping), `organisationMembers.test.ts` (`getUserOrganisationId`,
member list + emails, `setMemberRole` promote/demote/last-admin/cross-firm-scoping),
and `routes/admin.test.ts` (non-admin 403 on every route, firm-key save, member
list, role 200/400/404/409).

**Review fixes (approve-with-fixes, 22/07/2026).** Firm-key resolution in
`userApiKeys.ts` now wraps the whole firm layer in try/catch — any
`organisation_api_keys` read error is logged with a scoped tag and the firm layer
skipped (env fallback intact), so a transient error can never break chat key
resolution or profile status for a whole firm. `listOrganisationMembers` now
paginates `auth.admin.listUsers` until drained (guarded at 20 pages) — the
per-call `perPage` is a project-wide cap, not per-firm. The last-admin count now
filters via `normaliseRole` so it can't miscount non-normalised data.
`setMemberRole` populates the member's email in its success payload (degrading to
null on lookup failure). Firm-keys section gained a loading skeleton so "Not set"
never flashes before status loads.

**Verification.** Backend `tsc --noEmit` clean; `vitest run` 201/201. Frontend
`tsc --noEmit` clean; `eslint src` 34 errors / 77 warnings — **identical to the
main baseline** (all pre-existing; the two changed pages/components add zero).
`evals:smoke` from the main checkout: 4/4 pass. No new env vars, no dependency
changes, no migration.

## 2026-07-22 — WS8 PR A: organisations, admin role, profile plumbing (branch `ws8-org-foundation`)

**Scope:** foundation for firm administration. Adds the organisation (firm)
entity, an admin/member role on profiles, firm-level shared API keys, backend
resolution + an admin guard, and profile plumbing through to the frontend types.
**No gating behaviour** — the policy flags are present but unconsumed; this PR
changes nothing users can see yet. Self-hosters with no organisation keep the
existing per-user behaviour everywhere. Owner-approved design (22/07/2026): pilot
firm "Aria Grace Law CIC", admin `ezana-haddis@aria-grace.com`, new invitees
auto-assigned to the default org.

**Migration** `backend/migrations/20260721_01_firm_administration.sql` (basename
human-authorised in `.claude/hooks/authorized-migrations.json`; additive only, no
pilot data): `organisations` (name + `allow_member_api_keys` /
`allow_member_mcp_connectors` / `enabled_connector_ids` jsonb, default-closed);
`user_profiles` gains `organisation_id uuid references organisations on delete
set null` + `role text default 'member' check (admin|member)` + an index;
`organisation_api_keys` (encrypted, same AES-256-GCM columns as `user_api_keys`,
`unique(organisation_id, provider)`). RLS enabled on both new tables and
`revoke all … from anon, authenticated` (service_role untouched — the grant
posture from DURABLE_LESSONS). Mirrored verbatim into `backend/schema.sql`
(organisations created before `user_profiles` so the FK resolves in a fresh DB).

**Backend.** New `src/lib/organisations.ts`: `resolveUserOrganisation` (single
`user_profiles`⋈`organisations` join → `{id, name, role, policies}` | null),
`isAdmin` (side-effect-free role read), and `assignDefaultOrganisation` — orgless
users with `DEFAULT_ORGANISATION_ID` set are auto-assigned to the default firm as
members on first profile load; idempotent and race-safe via the orgless guard
encoded in the UPDATE predicate (`.is("organisation_id", null)`, DURABLE_LESSONS).
All paths tolerate an unmigrated DB (Postgres `42703` → orgless), mirroring the
`enforceLoginMfaIfEnabled` pattern. `src/middleware/auth.ts` adds `requireAdmin`
(runs after `requireAuth`; fixed 403 detail for non-admin/orgless; whole body
try/catch, generic 500). `routes/user.ts` `serializeProfile` now emits the
structured membership under **`firm`** plus `isAdmin`, resolved in `loadProfile`
and degrading to orgless (logged) on any org-subsystem error so the core profile
load can never be blocked (login-spinner incident).

**Frontend.** `mikeApi.ts` + `UserProfileContext` profile types carry
`firm: OrganisationMembership | null` and `isAdmin`. No consumption yet.

**Decision — `firm` vs `organisation` key.** `serializeProfile` already emits a
free-text `organisation` string (the user's self-entered firm name, edited on the
account page / collected at signup and consumed by the frontend). The structured
membership is therefore emitted under a distinct key `firm` to avoid a breaking
collision; the free-text field is left untouched (minimal-diff, no regression).

**Seed doc** `docs/FIRM_SETUP.md`: operator runbook — apply the migration to
production Supabase (paste file contents in the SQL editor, not a path), create
the `Aria Grace Law CIC` org, backfill existing profiles, promote the admin by
`auth.users` email, then set `DEFAULT_ORGANISATION_ID` as a Fly secret and
redeploy. `DEFAULT_ORGANISATION_ID` documented in `backend/.env.example` +
CLAUDE.md env registry.

**Verification.**
- Backend `npx tsc --noEmit` clean; `npx vitest run` → 15 files, 170 tests pass
  (+20 new: `organisations.test.ts` 15 — resolution, policy coercion, orgless,
  42703 fallback, default-org assignment + idempotency/no-stomp, isAdmin,
  no-side-effect; `user.serialize.test.ts` 5 — admin/member/orgless payload
  shapes + free-text/`firm` coexistence).
- Frontend `npx tsc --noEmit` clean; `npm run lint` at the main baseline (the two
  changed files introduce no new lint problems).
- `npm run evals:smoke` from the main checkout → 4 passed, 0 failed.

**Deferred:** admin-facing role/policy management UI + firm shared-key
consumption (PR B/C). RLS is enabled with no client policies (backend-only
access via service_role), matching the existing table posture.

## 2026-07-21 — Harden async handlers + profile-load error state (branch `harden-async-handlers`)

**Incident (21/07/2026):** production Supabase lost the `service_role` grant on
`user_api_keys`. `GET /user/profile` (`backend/src/routes/user.ts`) awaited
`getUserApiKeyStatus` with no try/catch, so it threw; after the #22
`unhandledRejection` guard the process no longer crashes — instead the request
never responds. The frontend gate (`MfaLoginGate`) blocks on
`UserProfileContext`'s `loading`, which only clears in a `finally`, so a hanging
fetch left every pilot user on an infinite login spinner. The DB grant is being
re-granted separately by the owner; this PR is the code-level defence so this
class of failure degrades honestly. See `docs/DURABLE_LESSONS.md` (2026-07-21).

**Scope:** defensive hardening only — no behaviour change on the success path.

**Backend — audit + wrap.** Audited every async route handler across
`backend/src/routes/*.ts` for a missing whole-body try/catch (the DURABLE_LESSONS
#22 rule). 56 unwrapped/partially-wrapped handlers found — well over the ~15
threshold at which CLAUDE.md permits a wrapper util over per-handler try/catch,
so added a tiny self-contained `backend/src/lib/asyncHandler.ts` (mirrors the
existing local `asyncRoute` idiom in `workflows.ts`, but self-responds with a
FIXED generic 500 `detail` + `console.error` via `safeErrorLog` rather than
forwarding to `next`, since there is no global error middleware) and applied it
surgically at each offending registration. Handlers already carrying a
whole-body try/catch were left untouched (minimal-diff, hard rule 8):
`workflows.ts` (all, already `asyncRoute`-wrapped), the WS7 routes
(`companies.ts`, `citations.ts`, `legislation.ts`, all fully wrapped), the
`user.ts` API-key/MCP/export/delete handlers, `projects.ts` `DELETE /:projectId`,
and `tabular.ts` `POST /prompt`. Wrapped, by file: `downloads.ts` 1;
`user.ts` 4 (`POST`/`GET`/`PATCH /profile`, `PATCH /security/mfa-login`);
`chat.ts` 7; `projectChat.ts` 1; `projects.ts` 14; `tabular.ts` 13;
`documents.ts` 16 (incl. the two `void handleEditResolution` accept/reject
routes, changed from `void`-discarding the promise to
`asyncHandler((req,res) => handleEditResolution(...))`). Streaming handlers keep
their own try/catch/finally; the wrapper's `res.headersSent` guard means it only
responds for a throw during pre-stream setup and never double-writes a live SSE
stream.

**Frontend — no more infinite spinner.** `getUserProfile()` now accepts an
optional `AbortSignal`. `UserProfileContext.loadProfile` time-boxes the request
with a 15s `AbortController` timeout and, on rejection/timeout, sets a new
`error` flag and clears `profile` (replacing the previous silent "unlimited
credits" fallback that hid the outage). `MfaLoginGate` renders a minimal centred
error state ("We could not load your account." + a Retry button that re-runs
`reloadProfile`) in the app's house style, checked before the loading gate.

**Verification:**
- Backend `npx tsc --noEmit` clean; `npx vitest run` → 13 files, 150 tests pass
  (added `src/routes/user.test.ts`: mocks `getUserApiKeyStatus` to reject →
  asserts `GET /user/profile` returns 500 with the fixed
  `"Something went wrong. Please try again."` detail and never leaks the raw
  `42501`/"permission denied" text).
- Frontend `npx tsc --noEmit` clean; `npm run lint` 112 problems
  (34 errors/78 warnings) — identical to the `origin/main` baseline, zero issues
  in changed files (the two `MfaLoginGate.tsx` set-state-in-effect errors are on
  the untouched pre-existing MFA effects; `git diff origin/main` confirms no
  added line calls `setGateState`).
- `npm run evals:smoke` from the main checkout → 4 passed, 0 failed, 0 skipped.
- Backend `prettier --check` NOT run as `--write` on the route files: the repo
  has no prettier config and these upstream files were already non-clean before
  this change (DURABLE_LESSONS 2026-07-07); edits preserve the existing style.
  New `asyncHandler.ts` is prettier-clean.

**Decisions:** wrapper util chosen over 56 hand-written try/catch blocks per the
CLAUDE.md >15 carve-out (smaller, uniform, cannot be forgotten on a pre-`try`
await). Frontend fallback profile deliberately removed in favour of an honest
error+retry — a legal tool must not silently render an "all clear" account state
during a backend outage.

---

## 2026-07-20 — WS7 close-out: status refresh (branch `ws7-closeout-status`)

**Scope:** docs-only. CLAUDE.md `## Current status` updated to WS7 COMPLETE with
the merged-PR ledger (#23–#31) and 20/07 live-verification evidence;
`docs/HANDOVER.md` §3 marked RESOLVED (workflow finished; all lanes landed).

**Verification:** live checks 20/07 — `/`, `/company-search`, `/legislation`,
`/citation-checker` all HTTP 200 on jessicaoss.com; `api.jessicaoss.com/health`
→ `{"ok":true}`; `gh pr list` shows no open PRs; single main worktree remains.

---

## 2026-07-20 — WS7: Land Registry coming-soon entry (branch `ws7-land-registry-stub`)

**Scope:** tiny UI-only stub — a disabled "Land Registry" entry in the Research
sidebar group, per the approved WS7 mock-up, so the deferred HM Land Registry
Business Gateway integration is visible in the product without being
clickable. No backend change; no new route.

**Key changes:**

- Frontend: `AppSidebar.tsx` — new `RESEARCH_NAV_ITEMS_DISABLED` array and a
  `renderDisabledNavItem` helper alongside the existing `renderNavItem`
  idiom (kept as a one-off inline special case rather than folding disabled
  state into `renderNavItem`, which assumes every item is a live route).
  Renders a muted, non-clickable row (`aria-disabled`, `cursor-not-allowed`)
  with the existing `Landmark` icon, a small "Connect account" pill bearing a
  padlock (`lucide-react` `Lock`) affordance, and a `title` tooltip reading
  "HM Land Registry integration coming soon" — visible whether the sidebar is
  open or collapsed. Mounted directly after `RESEARCH_NAV_ITEMS` in the
  Research group.
- README: roadmap line for HM Land Registry Business Gateway updated from
  "deferred; requires a commercial account" to "planned; requires channel-partner
  onboarding with HMLR (not yet started)" plus a pointer to the disabled nav
  entry. (The first draft of this PR claimed onboarding was "in progress" — the
  merge-gate review correctly rejected that as unsubstantiated; onboarding has
  not begun, and the copy now matches `CLAUDE.md`'s DEFERRED status honestly.)
  The nav tooltip likewise says "coming soon", not "in progress".

**Verification:** frontend `tsc --noEmit` clean; frontend `npm run lint` 112
problems (34 errors/78 warnings) — identical to the main baseline, zero
issues in changed files (the one `AppSidebar.tsx` finding is the pre-existing
setState-in-effect on the unrelated `shouldAnimate` effect, confirmed present
on `origin/main` before this change via `git stash`).

**Decisions / deferred:** genuinely non-interactive by design — no click
handler, no route, no account-connect flow yet; that lands with the real
HMLR Business Gateway workstream. No BUILD_PLAN/CLAUDE.md workstream table to
update (small addition to the already-merged WS7 Research group).
## 2026-07-20 — WS7 composed-range fix wave (branch `ws7-final-fixes`)

**Scope:** cross-cutting cleanup from a composed-range review of the whole WS7
train (`git diff 56896cf...origin/main` — PRs #23 Matters rename, #24 Citation
Checker, #25 Company Search, #28 research-doc sourcing, plus the byo-key-precedence
and legislation-panel merges). Per-PR review can't catch drift that only appears
once the commits sit together; this wave fixes the Important findings that class
produced. No behaviour change to any route or data path — copy, one page-header
markup fix, and one stale code comment.

**Key changes:**

- Frontend `(pages)/citation-checker/page.tsx`: brought Citation Checker's page
  header into line with the two Research pages that established the convention
  after it shipped (#24 landed before #25). `<PageHeader>` now uses
  `shrink` + `breadcrumbs={[{label:"Research"},{label:"Citation Checker"}]}`
  (was a bare `<h1>` title, no breadcrumbs) so the sidebar wayfinding trail
  reads "Research / Citation Checker" like Company Search and Legislation; the
  content wrapper gains `border-t border-gray-200` (with `pt-6` to replace the
  spacing the removed title provided) to match the header/body divider both
  sibling pages carry. Same file: the top-level fetch-error message switched
  from `text-red-600` to `text-gray-500` (finding 4) — red is now reserved for
  per-citation "Not found" status inside the results table, matching the other
  two Research pages' neutral house style for request-failed text.
- Backend `src/routes/companies.ts`: corrected the file-header key-precedence
  comment (finding 2). It still asserted "server env key takes precedence when
  set; per-user BYO key otherwise", which the owner-decided precedence flip
  (df11d28, `getUserApiKeys`) reversed everywhere except this file — user's
  decrypted key now always wins, env is the shared fallback. Comment now matches
  the code, `userApiKeys.ts`, the CLAUDE.md env registry, and the api-keys page
  copy. Comment-only; no code change.

**Verification:** backend `tsc --noEmit` clean; backend vitest 149/149 (incl.
`userApiKeys precedence (user key overrides env)`, which pins the behaviour the
corrected comment now describes); frontend `tsc --noEmit` clean; frontend
`npm run lint` unchanged from the main baseline (34 errors/78 warnings, all in
pre-existing upstream files — `eslint` on the changed `citation-checker/page.tsx`
reports zero issues); `npm run evals:smoke` 4/4 passed, run from the main
checkout per DURABLE_LESSONS 2026-07-08.

**Decisions / deferred:** three lower-severity findings from the same review were
left as-is by design. Finding 3 (Company Search Overview tab spells months out —
"21 February 2024" — while the Filing history tab and footer use numeric
DD/MM/YYYY) is a within-page style mismatch, not a date-order bug — both are
day-first and UK-correct, and `CompanyPanel.formatUkDate`'s long form is a
deliberate "reads unambiguously regardless of locale" choice; unifying it would
touch a shared component's presentation for no correctness gain. Finding 5 (the
Company Search PR's BUILD_LOG entry calls the Research sidebar group
"collapsible" though it ships as a static label) is an inaccuracy in a historical
log entry — not rewritten, since the log is a record of what each PR said at the
time. Two scope notes from the review, for awareness: the `ws7-land-registry-stub`
branch is not actually an ancestor of `origin/main` (the Research group has 3
items, not 4), and the Legislation-panel PR's own BUILD_LOG entry was silently
dropped during a merge-conflict resolution — a docs-only casualty; the code
(`routes/legislation.ts`, the page, sidebar ordering) all survived intact.

---

## 2026-07-20 — WS7 PR 4: Legislation panel (legislation.gov.uk) (branch `ws7-legislation-panel`)

**Scope:** third Research surface — a dedicated Research › Legislation page
backed by new authenticated `/legislation` backend routes, per the approved WS7
mock-up. One prominent input with two modes (look up a natural UK citation, or
search by Act/SI title), example chips teaching the citation grammar, a
master–detail split for title search, and a provision view reusing the existing
`assistant/LegislationPanel` with the amber outstanding-amendments band plus a
per-effect list beneath it (revision lag never hidden — CLAUDE.md data rule).

**Key changes:**

- Backend: new `src/routes/legislation.ts` (both `requireAuth`, every handler
  body in try/catch per DURABLE_LESSONS 2026-07-19), thin wrappers over the
  already-tested `lib/legislation.ts`: `GET /legislation/search?title=` →
  `search(q)` → `{matches}`; `GET /legislation/lookup?citation=` →
  `lookupCitation(raw)`. **No key gating** — legislation.gov.uk is a fully open
  API (OGL). A failed lookup is a domain result, not an error: unparseable or
  unresolvable citations return HTTP 200 `{resolved:false, citation, reason}`;
  only an unexpected throw yields a fixed generic 502 (`safeErrorLog`, raw
  errors server-side only). Success payload uses the same snake_case field
  names the chat tool emits (`legislationTools.ts`: `title, url, heading, text,
  extent, outstanding_effects, unapplied_effects`) so `LegislationPanel` props
  line up. Mounted behind the existing `researchLimiter` in `index.ts`.
- Frontend: new `(pages)/legislation/page.tsx` (single client page). Mode
  toggle + prominent input, **submit-on-enter only — no search-as-you-type**
  (a title search hits several feeds and can take 3–6s). States: initial
  prompt, loading skeletons, resolved provision (LegislationPanel + effects
  list), could-not-resolve card (shows the resolver's reason), no-matches, and
  network-error. Search matches carry Act/SI type badges and a year/number
  reference; selecting one opens its provision view. "Continue in Assistant"
  reuses `lib/assistantPrefill.ts`, writing `Regarding {citation} ({canonical
  url}): ` and routing to `/assistant`. `mikeApi.ts`: `searchLegislation(title)`
  / `lookupLegislation(citation)` with typed responses. Sidebar: "Legislation"
  (Landmark icon) added to the Research group between Company Search and
  Citation Checker via `renderNavItem`.

**Verification:** backend `tsc --noEmit` clean; backend vitest 140/140 (7 new
route-mapping tests in `routes/legislation.test.ts`, `vi.mock("../lib/
legislation")` per the `citations.test.ts`/`legislationTools.test.ts` pattern —
covers search wrapping, snake_case lookup mapping, the resolved:false 200
domain path, 400 on blank input, and fixed-502 error paths that never leak the
raw error); frontend `tsc --noEmit` clean; frontend `npm run lint` 112 problems
(34 errors/78 warnings) — identical to the main baseline, zero issues in
changed files (the one AppSidebar finding is the pre-existing line-104
setState-in-effect, not the nav additions); `npm run evals:smoke` 4/4 passed,
run from the main checkout per DURABLE_LESSONS 2026-07-08.

**Decisions / deferred:** no dedicated frontend test framework yet (upstream
ships none) — route behaviour is covered by the backend tests, the page is
pure composition of already-tested primitives. The provision view reuses
`LegislationPanel` unmodified (minimal diff); the per-effect list is rendered
by the page beneath the panel rather than added to the shared component.

**Review fix (PR #29):** `selectMatch` looked up every chosen search result by
its bare title. Acts parse from a bare title (`parseCitation` kind:`act`) but a
whole SI has no title-only parse branch, so SI search results — rendered with a
selectable "SI" badge — dead-ended on the "could not parse" card. Fixed: an
SI-typed match now resolves by its parseable `SI {year}/{number}` citation
(kind:`si`), Acts still resolve by title, and the title stays the human label
for the "Continue in Assistant" prefill. Selecting any search result now opens
its provision view as the entry above states. Backend unchanged (tsc clean,
vitest 140/140); frontend `tsc --noEmit` clean.

---

## 2026-07-20 — User API keys always take precedence over server env keys (branch `byo-key-precedence`)

**Scope:** owner-decided precedence flip. **Owner decision (19/07/2026):** "the
user's key should be prioritised, same with any key — it should always be the
user's own keys." This **reverses the env-first behaviour documented in the PR
#25 (WS7 Company Search) review**, where a set env key took precedence over a
user's own BYO key and the API-keys UI refused edits whenever an env key was
present. Applies to every provider (`claude` / `gemini` / `openai` /
`openrouter` / `companies_house`), not just Companies House.

**Key changes:**

- `backend/src/lib/userApiKeys.ts`:
  - `getUserApiKeys` — a user's decrypted key now overrides the env key for
    every provider; the env key remains the fallback when the user has none.
    Trim/decrypt behaviour preserved: a row that fails to decrypt (or decrypts
    empty) leaves the env fallback in place rather than nulling a live env key.
  - `getUserApiKeyStatus` — reports source `"user"` whenever a user key exists
    (even if an env key is also set); else `"env"`; else unconfigured
    (`false` / `null`). The env-masking `!status[provider]` guard was removed.
- `backend/src/routes/user.ts` — `PUT /user/api-keys/:provider` no longer
  returns the `hasEnvApiKey` 409 block; a user may always save or remove their
  own key. Removing a user key falls back to the env key (status returns to
  source `"env"`). MFA gating, try/catch, and the fixed generic 500 are
  unchanged; the now-unused `hasEnvApiKey` import was dropped.
- Frontend `(pages)/account/api-keys/page.tsx` — `isServerConfigured` is now
  informational, not a lock: the field stays editable, the reveal/Save controls
  are enabled, and an explanatory note renders ("A server default is available.
  Add your own key to use it instead — your key always takes priority."). Once a
  user saves their own key the status source becomes `"user"`, so the existing
  `hasSavedKey && !isServerConfigured` Remove affordance appears and reverting it
  falls back to the server default. Minimal adaptation of the existing
  ApiKeyField rendering.
- Docs: CLAUDE.md env registry — the provider-fallback row and the
  `COMPANIES_HOUSE_API_KEY` row now state that the per-user BYO key always takes
  precedence and the env key is the shared fallback. **Practical consequence:** a
  user with their own Companies House key now escapes the shared env-key rate
  bucket.

**Other consumers of the flipped functions (grep-audited, nothing left broken):**
`getUserApiKeys` is re-exported by `lib/userSettings.ts` and consumed by the
chat engine and `routes/companies.ts`; all simply receive the resolved key, so
they now transparently prefer the user's own key — the intended effect of the
decision, no assumptions broken. `hasEnvApiKey` had exactly one caller (the
removed 409 block) and is now unused by any route but kept exported for tests /
future use.

**Tests:** new `backend/src/lib/userApiKeys.test.ts` (vitest, sibling-test
style) — user key overrides env for every provider; env fallback when no user
key; delete reverts to env; decrypt-failure keeps env fallback; status sources
`user` / `env` / unconfigured and the revert-to-`env` transition. No prior test
asserted the 409 env block, so none needed changing.

**Verification (branch cut from `origin/main`):** backend `tsc --noEmit` clean;
backend vitest 142/142 (9 new here); frontend `tsc --noEmit` clean; frontend
`npm run lint` at the main baseline (34 errors / 78 warnings, all pre-existing;
the changed api-keys page lints clean); `npm run evals:smoke` run from the main
checkout per DURABLE_LESSONS.

---

## 2026-07-20 — Research-doc sourcing fixes (branch `research-doc-sourcing`)

**Scope:** docs-only follow-up prescribed by the retroactive review of PR #26 (which
merged review-waived under the model-handover time-box; the retroactive review
returned "Sound, with fixes"). `docs/research/2026-07-19-integrations.md`: the
Quill "complete documentation" claim is now attributed (owner-relayed, 19/07) and
both sections carry `Sources:` lists (Quill wiki pages, Clio docs, HMLR tech
docs/conditions-of-use/fees/open-data). `docs/research/2026-07-19-competitor-scan.md`:
header no longer claims inline citations and marks pricing/valuation figures as
publicly reported third-party estimates.

**Verification:** docs-only diff; every added URL was fetched during the 19/07
research session; CI green on the PR.

---

## 2026-07-19 — Handover pack: research briefs + HANDOVER.md (branch `handover-docs`)

**Scope:** docs-only, written at session end (Fable → Opus model handover). Adds
`docs/research/2026-07-19-competitor-scan.md` (Legora/Harvey condensed findings,
ranked gaps, do-not-copy list), `docs/research/2026-07-19-integrations.md`
(Quill/Unity API brief — no document API, per-user OAuth, time-recording headline,
v1.1 spike plan; HMLR Business Gateway brief — authorised-channel requirement,
fees, v1 open-data path), and `docs/HANDOVER.md` (infrastructure map, in-flight
WS7 workflow to verify, owner-set next-actions queue, owner-pending items,
operating rituals). CLAUDE.md: router rows for HANDOVER/research + Current status
refreshed to the WS7-in-flight state.

**Verification:** docs-only; paths referenced verified to exist on this branch.
Review waived under the model-handover time-box (noted honestly; docs carry no
code risk); expect keep-both BUILD_LOG conflicts with in-flight WS7 PRs.

---

## 2026-07-19 — WS7 PR 2: Company Search panel (Companies House) (branch `ws7-company-search`)

**Scope:** first Research surface — a dedicated Research › Company Search page
backed by new authenticated `/companies` backend routes, per the approved WS7
mock-up (320px master list / flex-1 detail split, Overview / Officers / PSCs /
Filing history tabs, neutral key-not-configured card, DD/MM/YYYY dates,
"Continue in Assistant" primary action).

**Key changes:**

- Backend: `getCompanyBundle(apiKey, companyNumber)` extracted from the
  `companies_house_get_company` chat tool (same graceful officer/PSC
  degradation) so the chat tool and the new route share one implementation.
  New `src/routes/companies.ts` (all `requireAuth`, every handler body in
  try/catch per DURABLE_LESSONS 2026-07-19): `GET /companies/search?q=`,
  `GET /companies/:companyNumber` (bundle), `GET
  /companies/:companyNumber/filing-history?page=` (25/page). Per-request key
  resolution via `getUserApiKeys` (env key takes precedence when set, per-user
  BYO key otherwise — precedence flip is an open owner decision, PR #25
  review); missing key →
  409 `{code: "companies_house_key_missing"}`; `CompaniesHouseError` mapping
  401→409 (same code), 404→404, 429→429, else fixed generic 502 — raw errors
  logged server-side only (`safeErrorLog`), never surfaced. New
  `researchLimiter` in `index.ts` (`RATE_LIMIT_RESEARCH_WINDOW_MINUTES`
  default 15 / `RATE_LIMIT_RESEARCH_MAX` default 120), applied to
  `/companies` and reusable for `/legislation`; both vars documented in
  `.env.example` and the CLAUDE.md env registry; module map updated.
- Frontend: new `(pages)/company-search/page.tsx` (single client page,
  master–detail state, no dynamic route) reusing PageHeader breadcrumbs,
  TableToolbar tabs, TablePrimitive skeletons, ui Button/Badge, and the
  existing CompanyPanel via a new additive optional `section` prop
  ("profile" | "officers" | "pscs") — default behaviour in the assistant side
  panel unchanged. New `components/research/FilingHistoryList.tsx`
  (lazy-fetched on tab open, paginated 25/page, DD/MM/YYYY, humanised filing
  descriptions, "View on Companies House" register link). States: empty,
  loading skeletons, key-not-configured card linking `/account/api-keys`
  (with the free-registration note), rate-limited/not-found/generic messages.
  Sidebar: collapsible "Research" group (Building2 icon), always visible.
  `mikeApi.ts`: `chSearchCompanies` / `chGetCompany` / `chGetFilingHistory`.
  Assistant prefill handoff: `lib/assistantPrefill.ts` (sessionStorage key
  `jessica.assistantPrefill`), InitialView peeks at first render + clears on
  mount, ChatInput takes an optional `initialValue` applied exactly once;
  "Continue in Assistant" writes "Using Companies House, review {name}
  (company no. {number}): " and routes to `/assistant`.

**Review fixes (independent review, Approve-with-fixes, all Minor):**
company numbers rejected with a fixed 400 unless strictly alphanumeric after
normalisation (`validateCompanyNumber`, exported + tested — path/query
metacharacters can never reach the outgoing Companies House URL); `typeof
"object"` guard on the page's profile narrowing; key-precedence docs
corrected to env-first reality (above).

**Verification (after merging origin/main incl. PR #24):** backend
`tsc --noEmit` clean; backend vitest 133/133 (11 new in this PR: 4
`getCompanyBundle`, 6 `companiesHouseErrorResponse` mapping, 1
`validateCompanyNumber`); frontend `tsc --noEmit` clean; frontend `npm run
lint` 112 problems
(34 errors/78 warnings) — byte-count identical to the main baseline, zero
issues in changed files (five new react-compiler errors during development
were fixed by restructuring, not suppression); `npm run evals:smoke` 4/4
passed, run from the main checkout detached at the branch commit per
DURABLE_LESSONS. Known integration note: trivial merge conflict expected with
PR #24 (ws7-citation-checker) in `AppSidebar.tsx` (both add the Research
group), `index.ts` and `mikeApi.ts` — resolved on this branch by merging
`origin/main` after #24 landed (Research nav group unified to hold both
entries; both limiters/mounts and both mikeApi sections kept).

---

## 2026-07-19 — WS7 PR 4: Citation Checker (branch `ws7-citation-checker`)

**Scope:** paste-in Citation Checker per the approved WS7 mock-up — new
`POST /citations/check` backend route (extract statutory citations from up to
20k characters of pasted text, verify each live against legislation.gov.uk)
and a new `/citation-checker` page in a "Research" sidebar group.

**Key changes:**

- `backend/src/lib/citationExtraction.ts` — extraction regexes ported from
  `evals/src/citations.ts` (provenance headers both ends; regexes kept
  byte-in-sync, including the bare-Act-vs-section de-dup and the known quirk
  that a sentence-initial capitalised run is swallowed into the Act title —
  tested, not "fixed", to preserve sync). The evals resolver was NOT ported:
  verification uses `verifyCitation` in `lib/legislation.ts` (the stronger
  resolver the chat tools use, with its ~1 req/s politeness bucket — hence
  strictly sequential verification, ≤50 citations per request).
- `backend/src/routes/citations.ts` — `requireAuth`, whole-handler try/catch
  with a fixed generic 500 detail (DURABLE_LESSONS 2026-07-19), 413 above
  20k chars, neutral-case citations always `unverifiable` with the fixed
  Find-Case-Law/BAILII copy. Own limiter `RATE_LIMIT_CITATIONS_MAX`
  (default 20 / 15 min; documented in `.env.example` + CLAUDE.md registry).
  The 20k text cap (reduced from the originally-shipped 100k after
  independent review) is the **ReDoS mitigation** for the O(n²) ported
  ACT_TITLE regex: extraction runs synchronously before the first await, and
  a pathological 100k paste blocked the Node event loop ~6.7s
  (reviewer-benchmarked), stalling all requests including SSE chat; at 20k
  the worst case stays well under ~0.5s. The regex itself stays byte-identical
  to evals per the sync mandate — a future synced regex fix in both suites
  remains recommended. Same review: verification consciously shares the
  global legislation.gov.uk politeness bucket with the chat tools (one
  50-citation check can queue chat legislation lookups for tens of seconds —
  by design; politeness to the upstream host requires a single bucket),
  now documented in the route.
- Frontend: `citation-checker/page.tsx` (textarea → single POST, skeleton
  checking state with "may take up to a minute" note, results table with
  green Verified rows linking to the canonical legislation.gov.uk URL, red
  Not found + reason, amber case-law rows, summary count line, footer
  disclaimer that verification confirms existence, not that the provision
  supports the proposition); `checkCitations` in `mikeApi.ts`; "Research"
  group + Citation Checker (ClipboardCheck) in `AppSidebar.tsx` (nav-item
  render refactored to a shared `renderNavItem`; a small merge conflict with
  `ws7-company-search`'s Research group is expected and fine).

**Verification:** backend `tsc --noEmit` clean; backend vitest 122/122 (25 new:
`citationExtraction.test.ts` fixtures incl. section-first/act-first/bare-act
de-dup/SI/neutral forms, and `routes/citations.test.ts` with mocked
`verifyCitation` covering status mapping, 50-citation cap, 20k cap/413,
neutral-case fixed copy, generic-500 no-leak). Frontend `tsc --noEmit` clean;
`npm run lint` 34 errors/78 warnings — byte-count identical to the main
baseline (no new issues; the one AppSidebar error is the pre-existing
upstream `setShouldAnimate`-in-effect finding at a shifted line).
`npm run evals:smoke` 4/4 from the main checkout (3/4 + clean CH-key skip
from the worktree); `git diff evals/` is exactly the one pointer comment.
Live smoke of the route logic: `s.994 Companies Act 2006` → verified
(`https://www.legislation.gov.uk/ukpga/2006/46/section/994`); dud
`s.9999 Companies Act 2006` → unverified (HTTP 404 reason).

---

## 2026-07-19 — WS7 PR 1: user-facing rename "Projects" → "Matters" (branch `ws7-matters-rename`)

**Scope:** string-only rename of the workspace concept from "Project" to "Matter"
across all user-facing copy — sidebar nav (FolderOpen icon kept), page headings,
breadcrumbs, modals, empty states, filter/column labels, aria-labels, toasts, the
privacy-data delete dialogs, and backend user-facing error `detail` strings
("Matter not found", "You cannot share a matter with yourself.", "Target matter
not found"). 99 strings across 27 files (23 frontend, 4 backend routes).

**Method:** `grep -ri "project" frontend/src backend/src/routes` (1,383 hits),
every hit classified copy vs identifier via a word-boundary filter plus manual
review; edits applied line-targeted with per-line assertions, then a post-edit
re-grep audit. Deliberately unchanged: code identifiers/types/props, route paths
(`/projects` URL stays — accepted owner trade-off per hard rule 8), DB
table/column names, log tags (`[projects]`, console.error text), code comments,
LLM-internal prompt text (`projectChat.ts` system prompt, `tabular.ts`
title-generation context), and "Project Finance" (practice area, a term of art).
Grammar reworked where substitution read oddly: "No {activeFilter} projects" →
"No matters shared with you" (branch only reachable on the shared-with-me
filter). Terminology decision logged as R10 in `docs/LEGAL_LANGUAGE_REVIEW.md`
for solicitor sign-off.

**Verification:** frontend `tsc --noEmit` clean; frontend `npm run lint` → 112
problems (34 errors/78 warnings), rule-level output byte-identical to main in the
same environment (no new issues; the documented 77-warning baseline had already
drifted to 78 on main); backend `tsc --noEmit` clean; backend vitest 97/97;
final re-grep audit confirms every remaining `project` hit is an
identifier/route/DB-name/log-tag/comment/prompt-internal (classification summary
in the PR body).

---

## 2026-07-19 — Pilot stability: API-keys crash fix + honest save errors (branch `fix-apikeys-stability`)

**Scope:** first live-user bug, found during owner QA. Symptoms: "Failed to save"
alerts for Claude, OpenAI and Companies House keys. Root causes (two distinct):

1. **Backend crash (the real outage):** `GET /user/api-keys` had no try/catch;
   Express 4 doesn't catch async-handler rejections and Node 22 kills the process
   on unhandled rejections — one transient Supabase error took the whole backend
   down mid-QA (Fly logs 19:21 UTC, machine restart). Fixed with a handler
   try/catch (500 + fixed generic detail) and process-level guards in `index.ts`:
   `unhandledRejection` logs and continues; `uncaughtException` logs and exits
   for a clean Fly restart (post-throw state may be corrupt — reviewer catch).
   Review also caught that the PUT handler's 500 previously echoed
   `errorMessage(err)` as `detail` — now a fixed message, raw error server-side
   only. Lesson + debugging signature appended to `docs/DURABLE_LESSONS.md`.
2. **Mute error UX:** Claude/Companies House saves were correctly rejected 409
   ("configured by the server environment" — those keys are Fly secrets, served
   to all pilot users), but the frontend swallowed the server's `detail` and
   showed a generic alert. `updateApiKey` now rethrows non-MFA errors and the
   api-keys page surfaces `MikeApiError` messages ("Could not save X: …").

**Verification:** backend `tsc` clean, 97/97 vitest; frontend `tsc` clean;
hook-enforced typecheck on every edit; CI green on the PR. Post-deploy check:
API-keys page renders Claude + Companies House as server-configured; OpenAI key
save succeeds (owner re-test).

---

## 2026-07-19 — Switch live site URLs to jessicaoss.com (branch `jessicaoss-urls`)

**Scope:** the three hardcoded `mikeoss.com` URLs that became switchable once
`jessicaoss.com` went live (flagged in PR #15's rebrand follow-up): `layout.tsx`
`metadataBase` + OpenGraph `url` → `https://jessicaoss.com`; `site-logo.tsx`
production landing href → `https://jessicaoss.com`.

**Deliberately NOT changed — owner + solicitor item:** the signup page's terms and
privacy links (`signup/page.tsx:271,280`) still point at `mikeoss.com/terms|privacy`.
No terms/privacy pages exist in this app, so retargeting them to jessicaoss.com would
404 — and the pilot needs its own Aria Grace Law terms and privacy policy drafted or
approved by the supervising solicitor before those links can point anywhere honest.
Mitigation: public sign-up is disabled in production Supabase (invite-only pilot), so
the signup page is not reachable as a working flow. Added to the owner review list.

**Verification:** frontend `tsc --noEmit` clean; `grep -rn "mikeoss.com" src/` →
only the two signup legal links remain (documented above); CI green on the PR.

---

## 2026-07-19 — Pilot deployment executed: platform live (branch `status-pilot-live`)

**Scope:** docs-only record of the deployment session (#13, #15, #17–#19 below carry
the deploy config/code; #14/#16 are docs/governance). Executed today, in order: Fly.io app `jessicaoss-api` created
(`lhr`) and deployed from the WS6 Dockerfile (secrets set by the owner, fresh
signing/encryption values); scaled to one always-warm machine per the pilot plan
after Fly auto-added an HA second; redeployed post-rebrand so production prompts use
the Jessica persona; TLS cert for `api.jessicaoss.com` issued (Let's Encrypt) once
the owner added grey-cloud A/AAAA records; frontend Worker `jessicaoss` deployed via
OpenNext with the apex custom domain attached at deploy time.

**Verification:** all checks below run live on 19 July: `https://api.jessicaoss.com/health` →
`{"ok":true}` over valid TLS; `https://jessicaoss.com` → HTTP 200 with title
"JessicaOS - AI Legal Platform"; `/login` → 200; CORS preflight from the apex origin
→ `access-control-allow-origin: https://jessicaoss.com`. Not yet verified (owner):
www→apex redirect (needs a proxied `www` DNS record + redirect rule) and the
in-browser §7 smoke items (sign-in, upload/download, Companies House lookup,
legislation lookup, workflow DOCX→PDF proving in-container LibreOffice).

---

## 2026-07-19 — Enable Worker custom-domain route (branch `enable-worker-route`)

**Scope:** one-line config activation. First Worker publish failed at the final step:
the Cloudflare account has no `workers.dev` subdomain registered and `wrangler.jsonc`
had its route commented out (deliberately, pending the DNS decision — see the
deploy-config entry). The `jessicaoss.com` zone is now live in the account (API DNS
records added, Fly cert issued 19 July), so the commented route is activated:
`"routes": [{ "pattern": "jessicaoss.com", "custom_domain": true }]` — wrangler
attaches the apex custom domain at deploy time; no `workers.dev` subdomain needed.

**Verification:** JSONC validity parse-checked (comments stripped → valid JSON).
Live proof deferred to the post-merge `npm run deploy` (publish + domain attach +
`https://jessicaoss.com` check) — recorded in CLAUDE.md Current status once run.

---

## 2026-07-19 — Remove upstream bun.lock (breaks packager detection twice) (branch `remove-bun-lockfile`)

**Scope:** deletes `frontend/bun.lock` (upstream artefact; this fork is npm-canonical
via `package-lock.json`). Follow-up to the `fix-opennext-packager` entry below: the
`buildCommand` override fixed the build phase, but wrangler ≥4.9x autoconfig delegates
`wrangler deploy` to `opennextjs-cloudflare deploy`, whose packager detection again
picked bun for the wrangler invocation — so the first Cloudflare deploy still failed
with `bun: command not found`. Deliberate, recorded deviation from minimal-diff rule 8:
the file actively broke two independent tool layers. Correction entry appended to
`docs/DURABLE_LESSONS.md`.

**Verification:** with the lockfile gone, `npx wrangler deploy` (delegating to
`opennextjs-cloudflare deploy`) invokes wrangler via npm and completes — verified live
against the `jessicaoss` Worker. CI green on the PR.

---

## 2026-07-19 — Fix OpenNext packager detection for Cloudflare deploy (branch `fix-opennext-packager`)

**Scope:** one-line config fix found during the first real frontend deploy. Upstream
ships `frontend/bun.lock`; OpenNext's packager auto-detection therefore ran
`bun run build` (bun is not installed — exit 127). Added an explicit
`buildCommand: "npx next build"` to `frontend/open-next.config.ts`; the upstream
lockfile stays (minimal diff, hard rule 8). Lesson + debugging signature appended to
`docs/DURABLE_LESSONS.md`.

**Verification:** `npx opennextjs-cloudflare build` completes and `.open-next/worker.js`
exists with the production API origin baked in; frontend `tsc --noEmit` clean; CI green
on the PR.

---

## 2026-07-19 — Merge governance: standing authorisation for agent merges (branch `merge-rule-update`)

**Scope:** CLAUDE.md only. Owner decision (19 July 2026, in-session): hard rule 6's
"Human merges" replaced with a standing authorisation — the agent merges a PR itself
once (1) all three CI checks are green, (2) an independent review has passed, and
(3) the BUILD_LOG entry is in place; anything short of all three still waits for the
owner. Rationale (owner's words): approvals had become rubber stamps ("I just do it
when you tell me they are ready"), and everything is PR-tracked and revertible.
Also refreshed CLAUDE.md `## Current status` with the deployment state: backend live
on Fly.io (`jessicaoss-api`, lhr, health verified), production Supabase + R2
configured, domain plan recorded, rebrand #15 noted.

**Verification:** docs-only diff; the three-condition gate matches the CI checks
that actually exist (`.github/workflows/ci.yml`) and this log's entry format.

---

## 2026-07-19 — Rebrand user-facing strings: Mike → JessicaOS (branch `rebrand-user-facing`)

**Scope:** Tier-1 rebrand sweep (owner decision 19/07/2026): every user-facing and
operator-facing "Mike" string becomes "JessicaOS". Internal identifiers, filenames,
CSS classes, crypto salts, protocol identifiers, and fork attribution are explicitly
out of scope (minimal-diff hard rule 8; attribution hard rule 3).

**Changed (24 files, 37 lines)**
- Frontend metadata/branding: `layout.tsx` (tab/og/twitter titles → "JessicaOS - AI
  Legal Platform", siteName, image alt), `global-error.tsx` title, `site-logo.tsx`
  and `AppSidebar.tsx` visible wordmark text, `WorkflowList.tsx` system-workflow
  badge.
- Frontend copy: api-keys page ("instance of JessicaOS"), support page (question
  description + link placeholder → `https://jessicaoss.com/...`), tabular/workflow
  column-prompt placeholders, MFA TOTP `friendlyName` ("JessicaOS" and the
  `` `JessicaOS ${Date.now()}` `` retry), privacy-data fallback export filenames
  (`jessicaoss-*-export.json`).
- Backend user/operator strings: startup log, chat + tabular system prompts ("You
  are JessicaOS…"), DOCX tracked-changes author default, MCP OAuth `client_name`
  (consent-screen display name, both registration paths), MCP tool-confirmation
  error, OAuth popup HTML copy, export filename prefix in `userDataExport.ts`.
- Names: `backend/package.json` → `jessicaoss-backend`, `frontend/package.json` →
  `jessicaoss` (lockfile name fields updated to match); `backend/schema.sql` header
  comment → "JessicaOS (fork of Mike) Supabase schema" (nothing else in the file).

**Deliberately left:** `MikeIcon`/`MikeLayout`/`MikeApiError`/`mikeApi.ts` and all
`mike-*`/`mike:`/`application/mike-*` internal identifiers, storage keys, and MIME
types; scrypt salts (`mike-user-api-keys-v1`, `mike-user-mcp-v1` — changing them
would orphan every encrypted key); MCP `CLIENT_INFO` protocol name; R2 bucket
default `"mike"`; code comments; `mikeoss.com` functional URLs (layout metadataBase/
og url, signup terms/privacy links, site-logo landing href) — flagged for a
follow-up once `jessicaoss.com` pages exist; all attribution/licence text.

**Verification:** backend `tsc --noEmit` clean; backend vitest 97/97 (7 files);
frontend `tsc --noEmit` clean; frontend ESLint 34 errors/77 warnings — byte-identical
to `main` baseline (pre-existing debt, no new issues); `npm run evals:smoke` 3
passed / 0 failed / 1 skipped (Companies House key not in worktree env); final
`grep -rn "Mike" frontend/src backend/src` audited — all 30 remaining hits are
internal identifiers or code comments.

**Addendum 2026-07-19 (same PR, owner note):** persona vs product split — where the
*assistant* names itself it is **"Jessica"** (system prompts in `chatTools.ts` /
`tabular.ts`, DOCX tracked-changes author, the two "what Jessica should extract"
prompt placeholders); the *product* remains **"JessicaOS"** everywhere else (titles,
wordmark, MFA device names, OAuth client name, filenames). Owner's rationale:
"Siri doesn't call herself SiriOS." Both `tsc` runs re-verified clean.

---

## 2026-07-19 — Process/docs adoption (branch `process-docs-adoption`)

**Scope:** Docs-only. Adopted the highest-value documentation/operating practices from
a structured review of the agl-founders-network sister project (three parallel review
agents: docs structure, architecture lessons, operating flow), and brought this log
back in sync with `main` — it had fallen three merged PRs behind its own
definition-of-done rule.

**Added / changed**
- `docs/DURABLE_LESSONS.md` — new append-only lessons file (index + dated entries,
  each: trigger → rule → debugging signature), seeded with seven lessons this project
  already paid for (Responses-API/local-models split, prettier-on-upstream, eval env
  loading, legislation.gov.uk gotchas, gh fork-target incident, judged-eval key
  semantics, zombie-agent protocol) plus five imported sister-project lessons marked
  with provenance (composed-range review, no raw errors to users, state-machine-in-
  UPDATE-predicate, framework-version warning, don't-surface-unbuilt-columns).
- `CLAUDE.md` — new "Where to read next" router table (per-need doc pointers + an
  explicit authority rule: newest BUILD_LOG entry beats BUILD_PLAN on status); the
  stale "Current sprint" section (7 July deadline framing) replaced with a dated
  "Current status" section reflecting the completed sprint and open items; definition
  of done gains a durable-lessons capture bullet.
- `.gitignore` — `.superpowers/` (ephemeral multi-agent session ledger; durable
  outcomes get promoted into this log / DURABLE_LESSONS.md, the scratch state stays
  untracked — sister-project pattern).
- Retrospective entries below for PRs #10–#12, reconstructed from merge commits and
  the session ledger.

**Practices reviewed and NOT adopted** (recorded so the decision isn't relitigated):
trunk-based direct-commit-to-main (our PR + human-merge gate stays — hard rule 6);
hand-maintained DB types and manual SQL-editor migrations (we keep `schema.sql` +
protected dated migrations); no-CI/no-tests posture (we keep vitest + the eval merge
gate); the 8k-line narrative build log (entries here stay factual and bounded).

**Verification:** docs-only diff; markdown links checked against files present on this
branch; no code, prompts, or user-facing strings touched.

---

## 2026-07-14 — Deployment config: fly.toml + wrangler.jsonc (branch `deploy-config`)

**Scope:** the two config files DEPLOYMENT.md §8 flagged as missing, unblocking the pilot deploy. Owner decided Fly.io (14/07/2026).

- `backend/fly.toml` — app `jessicaoss-api`, region `lhr` (UK data locality), builds from the WS6 Dockerfile, one always-warm shared-cpu-1x/1GB machine (`auto_stop_machines = "off"` so SSE chat streams are never cut; ~$6–11/month), `/health` checks, `TRUST_PROXY_HOPS=1` for Fly's proxy, `FRONTEND_URL` pinned to the production origin for CORS. Header documents first-deploy commands and the fresh-secret rule (openssl rand -hex 32 for the two signing/encryption secrets).
- `frontend/wrangler.jsonc` — Worker `jessicaoss`, `.open-next/worker.js` entry per @opennextjs/cloudflare, `nodejs_compat`, assets binding, observability on; custom-domain route left commented for the owner's DNS decision.
- `docs/DEPLOYMENT.md` §1/§8 updated: host decision recorded, wrangler gap closed.

**Verification:** wrangler config parses (`wrangler deploy --dry-run` requires a built app, so validated as JSONC + against the config schema); fly.toml validated with `fly config validate` where flyctl is available — noted in PR that first `fly launch --copy-config` confirms it end-to-end. No product code touched.

**Addendum 2026-07-19 (same PR, pre-merge):** canonical-origin decision taken by the owner — apex `jessicaoss.com` is the app origin, `www.jessicaoss.com` 301-redirects to it (never serves the app: CORS is single-origin), `api.jessicaoss.com` for the backend. `fly.toml` `FRONTEND_URL`, the wrangler route comment, and DEPLOYMENT.md §6 updated accordingly (commit `e96c104`). Merged as PR #13, merge `9c8ec49`.

---

## 2026-07-14 — Eval baseline committed (PR #12, merge `8112fe1`) *(retrospective entry, added 2026-07-19)*

- `evals/baseline.json` committed as the regression gate reference:
  `meanJudgedScore: 4.5` (measured mean on the first fully-live run was 4.83; the gap
  is deliberate headroom for judge variance).
- With #11's workflow this completes the CI merge gate: deterministic + citation cases
  hard-fail, judged mean must not regress below baseline.

---

## 2026-07-12 — CI merge gate (PR #11, merge `425b91b`) *(retrospective entry, added 2026-07-19)*

- `.github/workflows/ci.yml` (93 lines): three required checks — Backend
  (tsc + vitest), Frontend (tsc + lint), Evals (full golden set incl. citation hard
  gate) — using repo secrets `ANTHROPIC_API_KEY` / `COMPANIES_HOUSE_API_KEY` and the
  three `NEXT_PUBLIC_*` vars.
- A GitHub account billing lock initially prevented Actions jobs from starting; owner
  resolved it (all three checks verified green on PR #13, 2026-07-14).

---

## 2026-07-12 — Judged eval fixtures live (PR #10, merge `20ed269`) *(retrospective entry, added 2026-07-19)*

- Populated the four remaining judged golden-set cases with synthetic fixture
  documents (`evals/fixtures/`: SPA review, commercial lease LTA 1954, employment
  contract vs statutory minima, disclosure review — per `docs/safe-local-testing.md`,
  synthetic only) and wired them into `evals/cases/jud-*.yaml` (+1,360 lines).
- Owner added a real `ANTHROPIC_API_KEY` the same day (verified via `/v1/models`),
  unblocking the Opus judge. **First fully-live eval run: 35 passed / 0 failed /
  0 skipped / 0 pending**; judged scores 4,5,5,5,5,5 (due-diligence 4/5 with minor
  filing-date quibbles, above gate).
- All six judged fixtures remain flagged provisional pending the solicitor pass
  recorded in `docs/LEGAL_LANGUAGE_REVIEW.md`.

---

## 2026-07-08 — Pilot deployment workstream (branch `ws6-pilot-deployment`, WS6)

**Scope:** Owner decision (8 July 2026) to pilot-first: complete the product,
deploy privately at `jessicaoss.com` for a small group of Aria Grace Law
solicitors, gather feedback, optimise, then public launch. This workstream is
docs + deploy artefacts only, produced in parallel with five feature PRs
(#4–#8); expect a trivial conflict on this file against those parallel
entries.

**Added**
- `docs/DEPLOYMENT.md` — pilot deployment guide: architecture (Cloudflare
  Workers frontend, containerised backend, production Supabase, R2), a
  backend-hosting comparison (Fly.io recommended default; Railway already has
  partial groundwork via the existing `backend/nixpacks.toml`; Render; a
  small VM), a production Supabase checklist (new project, schema, invite-only
  sign-up, custom SMTP, TOTP MFA), R2 setup, a full backend + frontend env
  var matrix, DNS guidance, a post-deploy smoke checklist, and an explicit
  "decisions needed from the owner" section.
- `backend/Dockerfile` + `backend/.dockerignore` — multi-stage production
  image (`node:22-slim` build stage running `tsc`; runtime stage installing
  `libreoffice-writer` via apt for the `soffice` binary that
  `backend/src/lib/convert.ts` shells out to, non-root `node` user, `PORT`
  respected, `CMD ["node", "dist/index.js"]`). Not built or run in this
  sandbox — no Docker daemon available; the guide says so explicitly and
  gives the local verification command.
- `docs/PILOT.md` — pilot programme doc: Supabase-invite-only invite flow,
  synthetic/public-documents-only ground rule pending a data-protection
  review, what feedback is wanted (workflow accuracy, UK terminology,
  citation trust, speed, confusion points), how to give it (the new issue
  form), ~2-week expected cadence, and the "AI-generated, solicitor review
  required" reminder.
- `.github/ISSUE_TEMPLATE/pilot-feedback.yml` — structured GitHub issue form
  (what were you trying to do / what happened / expected / workflow-template
  dropdown / severity / UK-terminology checkbox / contact-ok). The
  workflow/template dropdown's six UK-specific options (SPA Review,
  Commercial Lease Review, TUPE Analysis, Employment Contract vs Statutory
  Minima, Companies House Due-Diligence Snapshot, Disclosure Review) are
  taken from `docs/BUILD_PLAN.md` §3 (WS4) and `docs/MIGRATION_SPEC.md` §6
  decision 1 (E-Discovery → Disclosure Review rename); **WS4 had not merged
  into this branch at time of writing**, so exact final titles should be
  checked against the merged workflow list before the pilot starts. An
  "Other / not sure" option covers drift in the meantime.
- `docs/BUILD_PLAN.md` — appended a WS6 entry to §3 (scope + re-sequencing
  note: the §9 launch checklist now sits after a pilot feedback window, not
  immediately after day 3). No other edits to that file.

**Verification**
- Every claim in `docs/DEPLOYMENT.md` was checked against the repo before
  writing it: `backend/src/index.ts` (CORS/`FRONTEND_URL`, `trust proxy`/
  `TRUST_PROXY_HOPS`, HSTS gated on `NODE_ENV=production`, `/health`, rate
  limit vars), `backend/src/lib/convert.ts` (`docxToPdf`/`soffice` binary
  resolution, the existing Railway-nixpacks error message), `backend/schema.sql`
  (`revoke all` grants now at lines 760-780, post-CourtListener-excision —
  CLAUDE.md's cited 792-823 is stale), `backend/migrations/` (38 files,
  latest `20260706_remove_courtlistener.sql`), `backend/package.json` /
  `frontend/package.json` scripts, `backend/.env.example` /
  `frontend/.env.local.example`, `frontend/open-next.config.ts`, and
  `docs/MIGRATION_SPEC.md` for the not-yet-merged WS1/WS3 env vars
  (`COMPANIES_HOUSE_API_KEY`, `LOCAL_LLM_*`) marked "planned" rather than
  live. Confirmed `backend/src` currently has no Companies House,
  legislation.gov.uk, or local-model code yet (WS1–WS3 are parallel,
  unmerged PRs at time of writing).
- **Gap found and documented, not silently fixed:** no `wrangler.toml` /
  `wrangler.jsonc` exists anywhere in the repo, so the frontend's `npm run
  deploy` script (`opennextjs-cloudflare build && opennextjs-cloudflare
  deploy`) has nothing to deploy against yet. Recorded as an owner decision
  item in `docs/DEPLOYMENT.md` §8 rather than invented, since it needs live
  Cloudflare account details (account ID, route, compatibility date) not
  available in this sandbox.
- `.github/ISSUE_TEMPLATE/pilot-feedback.yml` validated with `npx --yes
  yaml-lint` (pyyaml was not installed in this environment, so the
  `python3 -c "import yaml..."` fallback from the brief was not usable;
  yaml-lint reported "YAML Lint successful").
- `git status --short` clean of anything unexpected before each commit; no
  `.env*` files read, created, or edited; no migrations touched; no secrets
  or real company numbers/API keys in any new file — all env values in
  `docs/DEPLOYMENT.md` are placeholders.
- Not verified (explicitly out of scope for this sandbox): the Dockerfile
  was not built or run (`docker build`) — no Docker daemon available; no
  actual deploy to Cloudflare Workers, Fly.io/Railway/Render, or Supabase was
  performed — no accounts available. `docs/DEPLOYMENT.md` states this
  plainly rather than implying anything was deployed.

## 2026-07-08 — UK terminology sweep + UK workflow templates (branch `ws4-uk-workflows`, WS4)

**Addendum 2026-07-08 (same branch, post-review):** owner sign-off applied — 'lawyers' kept in persona; opinion→judgment in the core prompt; SONIA added to reference-rate examples (SOFR/EURIBOR kept for USD tranches); parties example now England & Wales Ltd; UK-first examples throughout (English Law leads, GBP illustrative currency, en-GB pinned in the five browser-locale date spots, four-weekly pay frequency); LPA waterfall reworded to lead with the descriptive term while keeping both market labels. All agent legal-language judgments now logged in `docs/LEGAL_LANGUAGE_REVIEW.md` for solicitor review. Also: provisional judged-eval fixtures committed for the due-diligence snapshot (live register data, 13927967) and TUPE analysis (synthetic scenario) — generated by session agents, scored 5/5 by an interim Opus judge pass (the first snapshot draft scored 3 for an ambiguous identity-verification narrative; the register genuinely carries two separate verification dates — officer record 16/03/2026, PSC record 24/02/2026 — reworded and re-judged 5/5); these cases skip until ANTHROPIC_API_KEY exists, then run automatically; inputs to be reviewed with an AGL associate.

**Scope:** Mechanical US→UK terminology sweep (audit-report subset only), the decided
Disclosure Review rework, five new UK workflow templates, and their golden-set eval
cases. Per the brief's scope discipline, only the 16 MECHANICAL audit rows and the
two DECIDED legal items (L6/L7) were applied; L1–L5, L8, L9, U1–U4 are untouched and
await owner sign-off.

**Part A — mechanical sweep (16/16 rows applied):** UK spellings (Analy**s**ing,
Summari**s**e ×11, finali**s**ing) across `TRChatPanel.tsx`, `AssistantMessage.tsx`,
`chatTools.ts`, backend `builtinWorkflows.ts`, `prompt-generator.ts`,
`columnPresets.ts`, frontend `builtinWorkflows.ts`; `credits-exhausted-modal.tsx`
date locale `en-US`→`en-GB` (renders "8 July 2026" style). Verified clean via grep
for all 16 find/replace pairs post-edit.

**Part B — Disclosure Review (L6/L7, DECIDED):** Renamed "E-Discovery Review" →
"Disclosure Review", added a CPR Part 31 / PD 57AD-framed `prompt_md`, and split the
single "Privileged?" column into three: **Legal Advice Privilege**, **Litigation
Privilege**, **Without Prejudice** (each Yes/No + basis, uncertainty noted
explicitly). "Lawyer" → "solicitor (or other legal adviser)" in the privilege
prompts.
- **Id kept as `builtin-ediscovery`** (not renamed) — verified `backend/schema.sql`'s
  `hidden_workflows.workflow_id` is a free-text column keyed on this exact string
  (`routes/workflows.ts` hide/unhide endpoints write whatever id the frontend
  sends); renaming would silently un-hide the workflow for any user who had
  previously hidden it. A code comment records this at the template definition.

**Part C — five new templates** in frontend `builtinWorkflows.ts`: English-law SPA
Review (tabular, Corporate, 10 columns incl. s.1159 CA2006 subsidiary check),
Commercial Lease Review — LTA 1954 (tabular, Real Estate, 10 columns incl. a
dedicated s.38A/s.24 security-of-tenure column and a 1954 Act red-flags column),
TUPE Analysis (assistant, Employment, structured reg 3/4/7/13–15 analysis citing SI
2006/246, instructs the model to verify citations "where verification tools are
available"), Employment Contract vs Statutory Minima (tabular, Employment, 7
columns each extracting the term / stating the statutory floor / flagging
shortfall), Companies House Due-Diligence Snapshot (assistant, Corporate, names the
three CH tools, instructs "say so" rather than inventing register data if
tools/key are unavailable).

**Backend** `builtinWorkflows.ts`: only the mechanical "finalising" fix — no new
templates added there per the brief.

**Part D — golden-set cases:** 22 new case files (17 `cit-`, 5 `jud-`) + 5 new rubric
files, across 6 templates (5 new + Disclosure Review; the Companies House snapshot
reuses the existing `jud-due-diligence-snapshot` + rubric per the brief, extended
with 2 new `cit-` cases rather than duplicated). Every new template has 3–4 golden
cases; 27 case files total in `evals/cases/` post-merge.

**Eval-harness bug fix (`evals/src/citations.ts`):** `resolveActUri` matched an
Act's canonical URI only via a calendar-year regex on the Atom `<id>` (e.g.
`/id/ukpga/2006/46`). The Landlord and Tenant Act 1954 — a real, brief-mandated
citation for the lease template — is canonically identified on
legislation.gov.uk by **regnal year** (`/id/ukpga/Eliz2/2-3/56`), so the existing
regex silently failed to resolve it even though the calendar-year alias path
(`/ukpga/1954/56/...`, which the API 301-redirects to the canonical URI) works
fine. Added a minimal fallback that reads the `<ukm:Year Value="…"/><ukm:Number
Value="…"/>` metadata pair (present on every entry regardless of citation style)
when the primary regex misses. Verified this doesn't regress any Act already
passing (Companies Act 2006, Employment Rights Act 1996, National Minimum Wage
Act 1998, Pensions Act 2008 all resolve via the pre-existing regex; only
pre-1963-style Acts needed the fallback).

**Verification evidence**
- `npm run evals` from worktree root: **20 passed, 0 failed, 1 skipped
  (`det-companies-house-profile`, no `COMPANIES_HOUSE_API_KEY` set — expected), 6
  pending** (all `jud-*` cases, correctly marked pending pre-workflow-fixture).
  Every new `cit-` case resolved its citation(s) against the live
  legislation.gov.uk API with zero failures.
- `npm run evals:smoke`: 3 passed, 1 skipped, 0 failed — unchanged (smoke set
  untouched, still 4 cases, none of the new cases marked `smoke`).
- `cd evals && npm run typecheck` — clean.
- `cd backend && npx tsc --noEmit` — clean.
- `cd frontend && npx tsc --noEmit` — clean.
- `cd frontend && npm run lint` — 35 errors / 77 warnings, identical file set to
  main; none in any file this branch touched (all in pre-existing files:
  `WorkflowPickerContent.tsx`, `ChatHistoryContext.tsx`, `useFetchDocxBytes.ts`,
  `useSelectedModel.ts`, `login/page.tsx`, `support/page.tsx`,
  `text-search-widget.tsx`, `label.ts`). No regression.
- `cd backend && npx prettier --check` on the two touched backend files reports
  the same pre-existing warnings as on `main` (confirmed via `git stash` diff) —
  not introduced by this branch's one-word edits.

**For owner review (new-content judgment calls, none blocking):**
1. SPA template's "Warranties" column references a tax covenant's *presence* but
   does not itself mandate a specific citation form for the tax covenant/tax deed
   mechanism (no single statute governs it) — flagged in case a house style is
   preferred.
2. Lease template's FRI ("full repairing and insuring") column format is `yes_no`
   with a request for the extent of repair covenant in the same answer — if the UI
   expects strictly Yes/No for `yes_no` columns, this may need a format change to
   `text`; used `yes_no` to match the existing precedent of `yes_no` columns that
   also request a short supporting explanation (e.g. "Independent Contractor?" in
   the Employment Agreement Review template, line ~1206).
3. Employment-minima template's Pay-vs-NMW column deliberately does **not** state a
   current NMW rate (rates change annually and the workflow has no live wage-rate
   API), instructing the model to flag verification is needed instead — a
   conservative choice consistent with hard rule 5, but means the column is less
   immediately actionable than the others; flagging in case a future workstream
   wires up a rates lookup.
4. SSP column in the same template intentionally does not cite a specific
   statute/SI for statutory sick pay (unlike the other six columns) — I could not
   find a citation form for this in the brief and did not want to guess at a
   specific SI/section without sign-off; the column instead asks the model to
   flag if a contract purports to exclude SSP altogether.
5. Disclosure Review's without-prejudice column asks for "genuine settlement
   negotiation content" per the brief's exact wording; note that the without
   prejudice rule is common-law in origin (no statute to cite), so this column,
   unlike the other two privilege columns, has no statutory citation at all —
   flagging as an intentional gap, not an oversight.

**Not in this branch (per scope discipline):** L1–L5 (US "lawyers"/"opinion"
generic usage, SOFR/EURIBOR reference-rate wording ×3, LPA waterfall
term-of-art), L8 (Delaware corporation example jurisdiction), L9 (PE
waterfall term), U1–U4 (browser-locale dates, governing-law example ordering,
illustrative currency, bi-weekly pay frequency) — all left exactly as audited,
no "drive-by" fixes.

**Note for parallel branches:** this entry is inserted at the top of the file
(after the first `---`); expect a trivial merge conflict with WS1–WS3 branches
doing the same — resolve by keeping both entries, newest first.

## 2026-07-08 — legislation.gov.uk integration (branch `ws2-legislation`, WS2)

**Scope:** legislation.gov.uk research tools per `docs/MIGRATION_SPEC.md` §4 — a no-key client, three LLM tools (`legislation_lookup`, `legislation_search`, `legislation_verify_citations`), the `[N]`/`<CITATIONS>` extension for legislation-kind citations, chat wiring so legislation research is always on (no key needed), and the matching frontend surface (tool chips, citation pills, `LegislationPanel`). First vitest harness in the repo.

**Backend**
- New `lib/legislation.ts`: `parseCitation` (natural UK citation parser — section-first/act-first, SI bare-number, regulation/article + SI title, article vs regulation), `resolveByTitle`/`search` (Atom title feed, TYPE_ORDER `ukpga,uksi,asp,asc,anaw,nisr`), `getProvision` (CLML fetch + extraction), `lookupCitation`/`verifyCitation` (orchestration). Local token-bucket limiter (burst 5, 1 req/s, retry-once-on-5xx, UA `JessicaOS/0.1 (+repo)`) and bounded TTL caches (title→URI 24h, current-version provision 6h, point-in-time 7d) — not shared with WS1's Companies House limiter.
- New `lib/legalSourcesTools/legislationTools.ts`: `LEGISLATION_TOOLS`, `LEGISLATION_SYSTEM_PROMPT` (verify-before-final-answer instruction; explicit "no case-law source, never invent neutral citations" per the CourtListener-excision gap), `executeLegislationToolCall`.
- `chatTools.ts`: `ParsedCitation` widened to `ParsedDocumentCitation | ParsedLegislationCitation`; `normalizeCitation`/`createCitationAnnotation` branch on `legislation_uri`; CITATIONS prompt block documents the legislation JSON shape; `buildSystemPrompt(includeResearchTools, sources: ResearchSources)` splices `LEGISLATION_SYSTEM_PROMPT` when `sources.legislation`; `buildMessages` gained the `sources` positional param; `runLLMStream` populates the (previously empty) `researchTools` seam from `researchSources.legislation`; `runToolCalls` gained a `legislation_*` branch mirroring the MCP branch 1:1 (`legislation_tool_start`/`legislation_tool_result` SSE pair, `legislationEvents` accumulator, pushed into `AssistantEvent[]` in `runLLMStream`'s `runTools` callback exactly like `mcpEvents`).
- `AssistantEvent` gained `LegislationToolEvent` (`type: "legislation_tool_call"`, `status`, `title`/`url`/`outstanding_effects`/`provision` on success).
- `routes/chat.ts` / `routes/projectChat.ts`: replaced the hardcoded `includeResearchTools: false` with `{ legislation: true }` (no key needed, so always on per the MIGRATION_SPEC §6.3 Companies House gating decision WS1 mirrors) and threaded `researchSources` through.

**CLML elements actually verified against live responses** (fetched 2026-07-08, ~1 req/s, captured into `backend/src/lib/__fixtures__/legislation/`):
- Outstanding/prospective-amendment flag: `ukm:PrimaryMetadata` (Acts) / `ukm:SecondaryMetadata` (SIs) → zero or more `ukm:UnappliedEffects > ukm:UnappliedEffect`, attributes `Type`, `Notes`, `AffectedProvisions`, `RequiresApplied`. Present **Act/SI-wide**, not scoped to the fetched section — matches the sitewide "outstanding changes" banner, so `outstandingEffects` is surfaced regardless of which fragment was requested (never hidden, per CLAUDE.md).
- Provision heading = nearest preceding `<Title>` (verified: "Petition by company member" for CA2006 s.994, "Effect of relevant transfer on contracts of employment" for TUPE reg.4, "General." for ERA1996 s.98).
- Both Acts and SIs wrap the requested fragment in `<P1 id="section-994">` / `<P1 id="regulation-4">` — only `id` varies by type.
- Extent = `RestrictExtent="E+W+S+N.I."` on the nearest ancestor.
- **Pre-1963 Acts are catalogued under regnal-year ids** (e.g. `Landlord and Tenant Act 1954` → `/id/ukpga/Eliz2/2-3/56`, not `/ukpga/1954/56`) — discovered while verifying the golden citation case. Fixed in both `backend/src/lib/legislation.ts` (`resolveByTitle`) and `evals/src/citations.ts` (`resolveActUri`): match the Atom entry by its `<ukm:Year Value="…">` and take the id's full path suffix, falling back only when the modern `/year/number` regex misses. Backward compatible — modern Acts still match the fast path first.

**Frontend**
- `shared/types.ts`: `legislation_tool_call` `AssistantEvent` variant; `LegislationCitationAnnotation`; `CitationAnnotation` re-widened to a union; kind-guards added to `getDocumentCitationQuotes`/`expandCitationToEntries`/`formatCitationPage`/`displayCitationQuote`.
- `useAssistantChat.ts`: `legislation_tool_start`/`legislation_tool_result` handled via the MCP start/result pairing pattern.
- `AssistantMessage.tsx`: extracted the inline `mcp_tool_call` JSX into a shared `ToolCallChip` (reused for both mcp and legislation chips — not cloned); legislation chip shows an amber "Outstanding amendments not yet applied to this text" note when flagged; `toolCallLabel` gained the three legislation tool names; citation-source helpers (`citationSourceKey`/`citationSourceLabel`/`CitationSourceIcon`) branch on `kind`, using a `Landmark` icon for legislation.
- New `LegislationPanel.tsx`: heading + text, extent, prominent amber banner when flagged, "View on legislation.gov.uk" canonical link. Degrades honestly when opened from a citation pill (title/URL/quote only, no heading/extent/flag data) rather than fabricating an "all clear" state.
- `AssistantSidePanel.tsx` gained a `LegislationTab` kind (no `documentId` — doesn't extend `CommonTab`); `ChatView.tsx` gained `openLegislation` (dedupes by URL, bypasses `upsertTab`'s document-keyed dedupe) and `openCitation` now branches on `citation.kind`.
- `projects/[id]/assistant/chat/[chatId]/page.tsx` (a second, simpler project-chat surface not covered by the frontend seam map, no `LegislationPanel` there): `handleCitationClick` falls back to opening the canonical legislation.gov.uk link in a new tab for a legislation citation, rather than erroring — flagged as a follow-up gap in the WS2 report, not a hard rule violation.

**Unit tests (vitest — new)**
- `backend/package.json`: `"test": "vitest run"`, devDep `"vitest": "^3.2.4"`; `backend/vitest.config.ts` added byte-identical to WS1's copy per the shared-seam contract.
- `legislation.test.ts` (29 cases): citation parsing variants, Atom resolution (incl. the regnal-year case), CLML extraction (incl. unapplied-effects and the "no outstanding effects" path) against captured fixtures, caching, 5xx retry, never-throws contract.
- `legislationTools.test.ts` (9 cases): tool schema shape, prompt content, all three tool executions incl. failure paths, unknown-tool fallback.
- Fixtures in `backend/src/lib/__fixtures__/legislation/` are trimmed real captures (documented as such in-file), not invented data.

**Evals**
- `evals/src/citations.ts`: `resolveActUri` regnal-year fix (see above) — improves, doesn't change, existing case behaviour.
- New cases: `det-legislation-tupe-reg4`, `det-legislation-era1996-s98`, `det-legislation-title-feed` (not smoke-flagged), `cit-legislation-tool-outputs-resolve` (citation-type, four citation styles incl. the pre-1963 Act, all verified to resolve live before committing).

**Decisions**
- Generic `legislation_tool_start`/`legislation_tool_result` SSE pair, mirroring the MCP pattern exactly (per the shared seam contract with WS1) rather than inventing a new event-pairing shape.
- `resolveActUri`/`resolveByTitle` fixed for regnal-year Acts rather than avoiding the citation in the golden case — a real correctness gap that would otherwise resurface for WS4's LTA 1954 workflow template.
- Legislation research is unconditionally on (`{ legislation: true }`) since the API needs no key — no new env var, no feature toggle, matching the Companies House "available whenever configured" precedent for the no-key case.

**Verification**
- `cd backend && npx tsc --noEmit` clean; `npm test` → 38/38 vitest passing.
- `cd frontend && npx tsc --noEmit` clean; `npm run lint` → 112 problems (35 errors/77 warnings), identical to the `ws2-legislation` base commit — no new lint errors, and zero findings in any WS2 file.
- Backend boots with dummy env (`SUPABASE_URL=http://x SUPABASE_SECRET_KEY=x DOWNLOAD_SIGNING_SECRET=x USER_API_KEYS_ENCRYPTION_SECRET=x`) → `GET /health` → `{"ok":true}`.
- `npm run evals` from repo root: 7 passed, 1 skipped (Companies House, no key — expected), 1 pending (judged, awaits WS1/WS4 fixtures) — all legislation + citation cases pass live, including the 4 new ones.

## 2026-07-08 — WS1: Companies House integration (branch `ws1-companies-house`)

**Scope:** First UK data integration per `docs/MIGRATION_SPEC.md` §3 — a Companies House client, chat tools, and a side-panel viewer, wired through the `researchTools`/`buildSystemPrompt` seam left by the CourtListener excision. No feature toggle: available whenever a Companies House key is configured (server env or per-user), per decision §6.3.

**Backend**
- `lib/rateLimit.ts` (new): generic `TokenBucket` (continuous refill) and `SingleFlight` de-dupe — provider-agnostic, no shared state with WS2's own politeness limiter.
- `lib/companiesHouse.ts` (new): typed client for `api.company-information.service.gov.uk` — HTTP Basic auth (key as username, blank password), company-number normalisation (uppercase, zero-pad to 8 chars, jurisdiction prefixes SC/NI/OC/etc.), per-key token bucket (500/5min headroom under the real 600 limit), single-flight + in-memory TTL cache (15min profile/officers/PSC, 5min search, 60min filing-history), 401/404/429/5xx → typed `CompaniesHouseError` (one retry on 5xx; no retry on 429). Errors are built from status + context only — never from raw request/response text, since Companies House keys aren't covered by `safeError.ts`'s redaction patterns.
- `lib/legalSourcesTools/companiesHouseTools.ts` (new): `COMPANIES_HOUSE_TOOLS` (3 OpenAI-shape tools: search, get_company, get_filing_history), `COMPANIES_HOUSE_SYSTEM_PROMPT`, `executeCompaniesHouseToolCall` — `get_company` batches profile+officers+PSCs into one payload; officer/PSC failures degrade gracefully (profile failure still fails the whole call).
- Provider plumbing: added `companies_house` to `ApiKeyProvider`/`PROVIDERS`/`envApiKey`/both `getUserApiKeyStatus`/`getUserApiKeys` literal objects (`userApiKeys.ts`), `UserApiKeys.companies_house` (`llm/types.ts`), `schema.sql` CHECK, and the pre-authorised migration `20260706_add_companies_house_user_api_key_provider.sql`. Route allowlist (`user.ts`) auto-follows via `normalizeApiKeyProvider`.
- `chatTools.ts` seam: `buildSystemPrompt(includeResearchTools, sources: ResearchSources)` splices `COMPANIES_HOUSE_SYSTEM_PROMPT` when `sources.companiesHouse`; `buildMessages` gained a 6th `sources` param; `runLLMStream` gained `researchSources`, populates `researchTools` from `COMPANIES_HOUSE_TOOLS`; `runToolCalls` gained a `companies_house_*` branch (mirrors the MCP branch: generic `companies_house_tool_start`/`companies_house_tool_result` SSE pair, same pattern as MCP, rather than one SSE event name per tool) plus a `companiesHouseEvents` accumulator, pushed into `AssistantEvent`s in `runLLMStream`'s `runTools` callback so they persist to chat history. `chat.ts`/`projectChat.ts`: `researchSources = { companiesHouse: !!apiKeys.companies_house?.trim() }`, `includeResearchTools` derived from it (replacing the hardcoded `false`).
- Left the shared seam exactly per the cross-branch contract (types/line shapes) so WS2's parallel legislation.gov.uk branch merges mechanically — expect trivial conflicts on those lines and this BUILD_LOG file.
- **New:** vitest test harness for `backend/` (upstream shipped none) — `"vitest": "^3.2.4"` devDep, `"test": "vitest run"` script, `vitest.config.ts` (byte-identical to WS2's, per the shared-seam contract). 34 unit tests across `companiesHouse.test.ts` and `companiesHouseTools.test.ts` (fetch mocked via `vi.stubGlobal`, fake timers for token-bucket refill).

**Frontend**
- `mikeApi.ts` / `UserProfileContext.tsx` / `account/api-keys/page.tsx`: added `companies_house` across all four lockstep provider-union seams; new "Companies House API Key" row with a one-line free-registration hint.
- `shared/types.ts`: `companies_house_tool_call` `AssistantEvent` variant (mirrors the backend shape, `company?: unknown` carrying the full profile/officers/PSC payload for the side panel).
- `useAssistantChat.ts`: `companies_house_tool_start`/`_result` handlers, same start→result pairing pattern as `mcp_tool_start`/`_result`.
- `AssistantMessage.tsx`: extracted the `mcp_tool_call` chip markup into a shared `ToolCallChip` component, reused by a new `companies_house_tool_call` branch with human-friendly labels ("Searching Companies House…", "Fetching company record…", "Fetching filing history…", plus done-state company name/number). Completed `get_company` chips are clickable, opening the `CompanyPanel`.
- `CompanyPanel.tsx` (new): profile (status, type, incorporation date, registered office, SIC codes, accounts/confirmation-statement due dates — all UK date format, e.g. "21 February 2022", never MM/DD/YYYY), officers, and PSCs, plus a "View on Companies House" link-out. Wired in via a new `CompanyTab` kind on `AssistantSidePanelTab` (not document-backed — no `versionId`/`filename` — so `upsertTab`'s dedupe now branches on `companyNumber` for company tabs and `documentId` otherwise); `openCompany` helper added in `ChatView.tsx` alongside `openCitation`/`openEditor`/`openDocument`.
- **Deviation from the brief's literal SSE shape:** the `companies_house_tool_result` SSE payload (and the frontend's paired update) also carries the full `company` payload, not just `company_number`/`company_name` — needed so the CompanyPanel has data to show without a page reload mid-conversation; the persisted `AssistantEvent` shape already documented `company?: unknown` for exactly this purpose.

**Evals** (`evals/cases/`, none smoke-flagged — smoke subset stays at 4/5)
- `det-companies-house-officers.yaml`, `det-companies-house-psc.yaml`, `det-companies-house-search.yaml`, `det-companies-house-filing-history.yaml` — real values verified live 8 July 2026 (ARIA GRACE LAW CIC 13927967; MARKS AND SPENCER P.L.C. 00214436).

**Verification**
- `cd backend && npx tsc --noEmit` clean; `npm test` → 34/34 pass.
- `cd frontend && npx tsc --noEmit` clean; ESLint on all changed files → 0 new errors/warnings (the only errors on touched files, `AssistantMessage.tsx`/`ChatView.tsx`, are pre-existing `set-state-in-effect`/`refs` issues at lines unrelated to this change).
- Backend boots with dummy env (`SUPABASE_URL`/`SUPABASE_SECRET_KEY`/`DOWNLOAD_SIGNING_SECRET`/`USER_API_KEYS_ENCRYPTION_SECRET`=x): `GET /health` → `{"ok":true}`.
- `npm run evals` (repo root, no `COMPANIES_HOUSE_API_KEY` in this worktree): 3 passed, 5 skipped (4 new CH cases + the pre-existing `det-companies-house-profile`, all correctly skipped — no key), 1 pending. `npm run evals:smoke`: 3 passed, 1 skipped, smoke count unchanged at 4.

**Decisions**
- Rate limiting/caching/single-flight are hand-rolled (no existing util) per `docs/MIGRATION_SPEC.md` note that no cache/throttle utility exists yet; kept generic in `rateLimit.ts` so WS2 can add its own instance without shared state.
- `get_company` degrades gracefully on officer/PSC failures (partial data + inline error string) rather than failing the whole tool call, since the profile is the core signal.

## 2026-07-08 — Local model support / WS3 (branch `ws3-local-models`)

**Scope:** New "local" LLM provider — any OpenAI-compatible `/v1/chat/completions`
server (Ollama, LM Studio, vLLM) — per `docs/MIGRATION_SPEC.md` §5 + §6 decision #2/#5.
Positioning is data sovereignty, not cost. Cloud OpenAI (Responses API client)
kept unchanged; this is a new chat-completions client, not a base-URL override.

**Backend**
- `lib/llm/localConfig.ts` (new): resolves `LOCAL_LLM_BASE_URL` (primary),
  `OPENAI_BASE_URL` (documented alias, only when the former is unset — never
  affects the cloud OpenAI client), `LOCAL_LLM_MODELS` (comma-separated,
  trimmed/deduped-empty), `LOCAL_LLM_API_KEY` (optional, defaults to bearer
  `ollama`). `getLocalLlmConfig()` returns null unless a base URL AND at least
  one model are present.
- `lib/llm/localOpenAI.ts` (new): `streamLocal`/`completeLocalText` — chat-completions
  streaming client mirroring `openai.ts`'s callback contract (`onContentDelta`,
  `onReasoningDelta`/`onReasoningBlockEnd`, `onToolCallStart`), tool_calls delta
  fragments accumulated by index, standard OpenAI tool schema (no conversion
  needed), tool loop (default 10 iterations) appending assistant `tool_calls` +
  per-call `{role:"tool"}` messages. Malformed tool-call JSON is never executed —
  it's fed back as `{"error": "Invalid tool arguments: ..."}` so the model can
  retry, with a logged warning; half-formed SSE frames stay buffered defensively.
  Raw-stream logging hooks (`createRawLlmStreamRecorder`/`logRawLlmStream`) mirrored.
- `lib/llm/types.ts`: `Provider` gains `"local"`. `lib/llm/models.ts`:
  `providerForModel` maps the `local:` prefix; `resolveModel` bypasses the static
  registry for any `local:*` id once local mode is configured at all (graceful
  fallback to default when unconfigured or a persisted id is stale).
  `lib/llm/index.ts`: dispatches `"local"` to the new client.
- `routes/user.ts`: `local: {configured, models}` merged additively into all four
  `apiKeyStatus`-bearing responses (`GET /user/profile`, `PATCH /user/profile`,
  `PATCH /user/security/mfa-login`, `GET`+`PUT /user/api-keys[/:provider]`) via a
  small `withLocalStatus()` helper — no schema/type change to `ApiKeyStatus`
  itself, no secrets or base URL in the payload. `ApiKeyProvider`/`user_api_keys`
  deliberately untouched — there is no per-user local key (server-env only; a
  per-user base URL is an SSRF surface, excluded per decision §6.5).
- `routes/tabular.ts`: `missingModelApiKey` bypasses the per-user-key gate for
  the `"local"` provider (server-reported availability, not key-gated) — without
  this, selecting a local tabular-review model would always 422.
- `.env.example`: documented `LOCAL_LLM_*` block; `CLAUDE.md` env registry row
  updated from "planned" to the real vars.

**Frontend**
- `mikeApi.ts`: `ApiKeyStatus` gains optional `local?: {configured, models}`
  (additive; `ApiKeyProvider` untouched). `UserProfileContext.tsx`: `UserProfile`
  gains `localModels: string[]` (empty when unconfigured/on the exception-path
  fallback profile).
- `ModelToggle.tsx`: `ModelOption["group"]` gains `"Local"` (rendered label
  "Local (on-premises)", `GROUP_ORDER` last); server-reported models merged into
  the option list at runtime (`toLocalModelOptions`); group header carries a
  "Guidance" link to `docs/local-models.md`; each local row's tooltip carries the
  "runs on your own hardware" hint. Hidden entirely when unconfigured.
- `modelAvailability.ts`: `ModelProvider` gains `"local"`; `getModelProvider`
  short-circuits on the `local:` prefix (bypasses the static `SETTINGS_MODELS`
  lookup); `isModelAvailable`/`isProviderAvailable` take an additional
  `localModels` param and treat local as server-reported, never key-gated;
  `providerLabel` gains "Local".
- `useSelectedModel.ts`: accepts `localModels`; a persisted `local:*` selection
  is re-validated whenever the reported list changes and falls back to
  `DEFAULT_MODEL_ID` gracefully if no longer valid.
- `ChatInput.tsx`, `TabularReviewView.tsx`, `TRChatPanel.tsx`,
  `account/models/page.tsx`: threaded `localModels` from `useUserProfile()`
  through to every `isModelAvailable`/`ModelToggle` call site (chat, tabular
  chat, tabular generation gating, title/tabular account preferences).
- `ApiKeyMissingModal` needed no changes — it only fires when
  `isModelAvailable` returns false, which never happens for a hidden
  (unconfigured) local model.

**Docs:** `docs/local-models.md` (new) — Ollama/LM Studio setup, Qwen 2.5 14B
Instruct (Apache-2.0) recommendation, data-sovereignty positioning, honest
quality caveat pointing at the README eval table (Day-3 run), tool-calling
reliability caveat.

**Tests (new — vitest, first backend test suite):** `backend/package.json`
devDep `vitest ^3.2.4`, script `test`, `vitest.config.ts` (byte-identical to
the WS1/WS2 copies per shared spec). 25 tests across `localConfig.test.ts`
(env resolution incl. `OPENAI_BASE_URL` alias precedence), `models.test.ts`
(`providerForModel`/`resolveModel` local-prefix behaviour configured vs not)
and `localOpenAI.test.ts` (canned-SSE/mocked-`fetch`: content-delta assembly,
tool-call fragment accumulation across deltas, malformed-JSON → tool error
without crashing, second-turn message shape, default `Bearer ollama`, abort
handling) — no live server required.

**Verification**
- `cd backend && npx tsc --noEmit` clean; `npm test` → 25/25 passing.
- `cd frontend && npx tsc --noEmit` clean; `npm run lint` → 34 errors/77
  warnings vs 35/77 on `main` (net improvement; zero new findings in any file
  touched by this workstream — confirmed by diffing per-file error lists).
- Backend boots on dummy env + `LOCAL_LLM_BASE_URL`/`LOCAL_LLM_MODELS` →
  `/health` → `{"ok":true}`; also boots identically without the local vars.
- No local Ollama/LM Studio server was reachable in the sandbox
  (`curl localhost:11434` connection refused) — the live smoke call was
  skipped per the brief; all coverage is via mocked fetch/canned SSE.
- Prettier: pre-existing 4-space-vs-default drift on `llm/types.ts`,
  `llm/models.ts`, `llm/index.ts`, `routes/user.ts`, `routes/tabular.ts` is
  unchanged from `main` (not introduced by this branch — minimal-diff, hard
  rule 8); all new files (`localConfig.ts`, `localOpenAI.ts`, tests) are
  Prettier-clean.

**Decisions carried from MIGRATION_SPEC §6:** dedicated `LOCAL_LLM_*` vars with
`OPENAI_BASE_URL` alias (#2); no per-user local base URL (#5, SSRF). Expect
trivial merge conflicts with parallel WS1/WS2 branches on `vitest.config.ts`
(byte-identical, should merge cleanly), `backend/package.json`, and this
`BUILD_LOG.md` entry position.

## 2026-07-08 — README + landing docs (branch `ws5-readme-landing`, WS5)

**Scope:** Docs-only. Full rewrite of `README.md` per `docs/BUILD_PLAN.md` §3 WS5 and `docs/MIGRATION_SPEC.md` §1.4/§6 item 7 framing. No code changes.

**Structure decisions**
- Fork lineage + AGPL-3.0 attribution placed immediately after the opening paragraph (not buried near the licence section) — matches CLAUDE.md's "celebrated, not hidden" instruction.
- Two-line "find your path" pointer at the top (solicitor vs self-hoster) so either reader orients in under a minute, per the brief's skimmability requirement.
- UK integrations, model providers (incl. local/on-premises mode), eval-table placeholder, and the transparent roadmap (Find Case Law pending TNA licence; HMLR deferred; BAILII never) each got their own heading, in that order, ahead of the self-hosting mechanics.
- Self-hosting section keeps all still-accurate detail from the prior "Mike" README (prerequisites, DB setup, troubleshooting, useful checks) rather than dropping it, updated for JessicaOS naming and folded under one `## Self-hosting` heading with subsections.
- Env var table mirrors `backend/.env.example` on this branch, plus `COMPANIES_HOUSE_API_KEY` (WS1) and the `LOCAL_LLM_BASE_URL` / `LOCAL_LLM_MODELS` / `LOCAL_LLM_API_KEY` block (WS3, with `OPENAI_BASE_URL` documented as the fallback alias) — both flagged as landing with their respective parallel workstreams rather than presented as already merged.
- `docs/local-models.md` is referenced, not created (WS3 owns it); this is called out explicitly in the README text.
- Eval comparison table left as a "—" placeholder (Claude / Gemini / local Qwen via Ollama × deterministic pass rate / citation gate / judged mean) with a pointer to `evals/README.md`, per the brief — no invented numbers.

**Verification**
- Read `README.md`, `CLAUDE.md`, `docs/MIGRATION_SPEC.md`, `docs/safe-local-testing.md`, `docs/BUILD_PLAN.md`, `backend/.env.example`, `evals/README.md`, `CONTRIBUTING.md`, `LICENSE`, `package.json`, and `.git/config` (remotes) before writing.
- Every path/link referenced exists on this branch (`backend/schema.sql`, `backend/migrations/`, `evals/`, `evals/README.md`, `docs/safe-local-testing.md`, `LICENSE`, `CONTRIBUTING.md`) except `docs/local-models.md`, which is explicitly marked as landing with the local-model workstream (WS3) rather than linked as if already present.
- Commands in the README match the verified command set in `CLAUDE.md` (`cd backend && npx tsc --noEmit`, etc.) rather than inventing flags.
- No US spellings introduced; DD/MM/YYYY convention n/a (no dates in the new copy); "solicitor" used throughout, no "attorney"/"lawyer".
- No marketing language ("supercharge"/"unlock"/"seamless") or exclamation marks.

**Controller additions (same branch, post-copywriter review)**
- README accuracy fixes: citation-verification wording no longer implies a runtime blocking pipeline (assistant is instructed to verify via tools; the eval gate enforces); "Account > Models & API Keys" corrected to the real nav labels (**Account → API Keys** / Model Preferences).
- `CONTRIBUTING.md`: rebranded greeting; removed the upstream "no local-LLM refactors" guideline (contradicted the shipped local-model mode); security reports now route to this repo's private vulnerability reporting, with a request to also report upstream-affecting issues to Mike; added minimal-diff and UK-English guidelines.
- `CLAUDE.md`: removed stale CourtListener references left after the 07/07 excision (routes/module map/request flow/env registry); did not touch the `COMPANIES_HOUSE_API_KEY` / local-model rows (owned by WS1/WS3 branches).

**Note for reviewers:** this entry is expected to produce a trivial merge conflict against other same-day workstream entries at the top of this file (WS1/WS3/WS4 land in parallel branches) — resolve by keeping both entries, newest first.

---

## 2026-07-07 — CourtListener excision (branch `excise-courtlistener`, PR #2)

**Scope:** Clean removal of the US CourtListener integration per `docs/MIGRATION_SPEC.md` §2 — code, tools, prompts, UI, DB surface, env vars, docs. No UK features yet; the research-tools seam is kept for WS1/WS2.

**Backend**
- Deleted `lib/courtlistener.ts` (1,189 lines), `lib/legalSourcesTools/courtlistenerTools.ts`, `routes/caseLaw.ts`; unmounted `/case-law`.
- `chatTools.ts`: removed the 5 CL tool branches, ~1,000 lines of CL turn-state helpers, case-citation parsing/annotation, CL event types (−33.7k chars). Kept `buildSystemPrompt(includeResearchTools)` and the `researchTools` array as the seam (empty until WS2).
- `llm/openai.ts`: removed the CourtListener citation-reminder prompt suffix.
- Removed `'courtlistener'` provider from `userApiKeys.ts` / `llm/types.ts` / `user.ts`; removed `legal_research_us` from `userSettings.ts`, `user.ts` (profile select/serialise/validate — legacy column-fallback cascade simplified), and both chat routes (`includeResearchTools: false` until UK sources land).

**Frontend**
- Deleted `CaseLawPanel.tsx`, the orphan `convert-courts-to-ts.js`, and the whole `/account/features` page (its only content was the US toggle; nav entry removed — per the no-toggle decision).
- Removed CL entry from `/account/api-keys`; `legalResearchUs` + courtlistener key state from `UserProfileContext`; `getCourtlistenerOpinions` + provider from `mikeApi.ts`.
- `shared/types.ts`: removed 7 CL event variants and the case-citation annotation type (`CitationAnnotation` is document-only now).
- `useAssistantChat.ts` / `TRChatPanel.tsx`: removed CL SSE handlers + parsers; `AssistantMessage.tsx`: removed `CourtListenerBlock`, case-link markdown handling, case citation pills, and the 5 CL event renderers.
- **Old-chat compatibility (decision #6):** `AssistantMessage.isRenderableEvent` now skips `case_citation` / `case_opinions` / `courtlistener_*` event types by string, so pre-fork chats still render (minus US case-law blocks). This is the one intentional "courtlistener" string left in source.

**Database** (authorised migration `20260706_remove_courtlistener.sql` + matching `schema.sql` edits)
- Drops both CL index tables, deletes stored CL tokens, tightens the `user_api_keys` provider CHECK, drops `user_profiles.legal_research_us`.

**Docs/env:** CL removed from `backend/.env.example` and README (prereqs, env block, integration section, first-run step, 2 troubleshooting entries).

**Verification**
- `grep -ri courtlistener|legal_research_us` over `backend/src`, `frontend/src`, `schema.sql`, `.env.example`, README → only the 2 intentional skip-guard lines above.
- `tsc --noEmit` clean in backend and frontend. Frontend ESLint: 35 errors / 77 warnings vs 41/77 baseline (strictly better; all remaining pre-existing).
- Backend boots with dummy env; `GET /health` → `{"ok":true}`.
- `npm run evals:smoke` → 3/3 pass (live legislation.gov.uk).
- `next build` with dummy public env vars — see PR notes (first run failed on missing `NEXT_PUBLIC_SUPABASE_URL`, an environment condition also present upstream).

**Addendum 2026-07-08 (same PR):** operator env files populated (backend/.env, frontend/.env.local — untracked); backend boots on the real config (`/health` ok). Companies House key verified live and the `det-companies-house-profile` golden case activated with real data: ARIA GRACE LAW CIC, company number 13927967, incorporated 2022-02-21, SIC 69102, England & Wales (values confirmed against the live API). Full eval run: 4 pass, 1 pending (judged case awaits WS1/WS4 workflow fixtures + ANTHROPIC_API_KEY).

**Addendum (same PR):** eval runner now loads operator env files at startup (`evals/src/env.ts`: repo-root `.env.local` / `.env`, then `backend/.env`; real environment always wins) so `npm run evals` picks up `COMPANIES_HOUSE_API_KEY` / `ANTHROPIC_API_KEY` wherever the operator keeps them. Verified against a synthetic env file (parse, quoted values, no-override).

**Tooling fix (found by dogfooding the hooks):** the PostToolUse hook ran `prettier --check` on backend files, but the repo has no prettier config and upstream files are not prettier-clean — an auto-format would have rewritten a whole file's indentation (caught and reverted). The hook now runs prettier only when a project defines a prettier config.

---

## 2026-07-06 — Phase 0 decisions recorded + extra agents (PR #1 follow-ups)

- Added `frontend-designer` and `uk-copywriter` agents at the owner's request (UI/copy work from excision + UK integrations).
- Migration authorisation operationalised: human-maintained allowlist `.claude/hooks/authorized-migrations.json` (agents blocked from editing it); two files pre-authorised.
- Owner decisions recorded in MIGRATION_SPEC §6: "Disclosure Review" rename; dedicated `LOCAL_LLM_*` env vars with `OPENAI_BASE_URL` alias; Companies House available whenever a key exists (no toggle); old US chat events silently skipped at render (no data migration). Per-user local base URLs deferred (SSRF).

## 2026-07-06 — Phase 0 (branch `phase-0`, PR #1)

**Scope:** BUILD_PLAN §1 — docs + eval harness + agents/hooks; no feature code.

- **CLAUDE.md**: TODOs replaced with verified architecture map, module tables, chat request flow, full env var registry, real commands. Documented that upstream has no tests, no CI, no root package.json, no backend lint script.
- **docs/MIGRATION_SPEC.md**: full US touchpoint inventory (file:line); CourtListener clean-removal plan; Companies House design (basic-auth-as-username, 600 req/5min); legislation.gov.uk design (no key, `/data.feed` Atom search, outstanding-effects flags surfaced); local-model design (key finding: upstream OpenAI client uses the Responses API, which Ollama/LM Studio don't serve — local needs a chat-completions client).
- **evals/**: golden-set runner (`npm run evals` / `evals:smoke` from root). Citation hard gate resolves statutory refs against the live legislation.gov.uk API; neutral case citations always fail until the TNA Find Case Law licence lands. Opus judge (`claude-opus-4-8`, structured JSON via `output_config`). Smoke verified 3/3 live; self-test proves the gate rejects a fabricated s.9999 CA 2006.
- **.claude/**: agents test-writer / code-reviewer / eval-judge / terminology-auditor; hooks — PreToolUse guard (migrations/`.env*`/LICENSE), PostToolUse typecheck+lint on changed files, Stop hook running tests + `evals:smoke`. All hook paths tested.
- New deps (evals only, justified in PR): `@anthropic-ai/sdk`, `js-yaml`, `tsx`, `typescript`.
