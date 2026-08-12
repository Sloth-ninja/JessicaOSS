# Practice Management (Clio-backed Matters) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Matters tab becomes Clio-backed per `docs/PRACTICE_MANAGEMENT_SPEC.md` (owner-approved 06/08 with mock-ups https://claude.ai/code/artifact/931413c4-b22b-4821-938a-3eaffa7b8ae5): my-matters preload + firm search, matter detail with financials and editable time entries, lazily-linked JessicaOS workspaces — live Clio reads, no DB copy of matter data.

**Architecture:** New self-contained seam `backend/src/lib/clio/mattersSurface.ts` over the existing `clioRequest` client (per-user OAuth, 50 req/min budget, X-API-VERSION 4.0.11) + thin `/clio-matters` routes; one tiny table `matter_workspace_links` (ids only); frontend re-tabs the existing Matters page with the Workspaces list preserved as tab + fallback.

**Tech Stack:** Express 4 + existing `lib/clio/` machinery (2-space backend), Next.js 16 (4-space frontend, ESLint-formats, NEVER `prettier --write`), vitest (mock HTTP as `manageTools.test.ts` does).

## Global Constraints

- CLAUDE.md hard rules (no migrations except the ONE authorised file below; no `.env*`/LICENSE; PR-per-unit; merge gate = independent review + 3 green CI + BUILD_LOG entry each; UK English/terminology — "solicitor", "matter").
- Migration `20260807_01_matter_workspace_links.sql` may be written ONLY after the owner adds it to `.claude/hooks/authorized-migrations.json`.
- **Probe-gated claims (spec Open questions; live probes pending owner action):** (1) list continuation beyond one 200-row page — v1 ships ONE sorted page, honest count, NO deep paging until the offset probe passes; (2) the `clio_matter_financials` selector fix ships on docs evidence + the owner's live repro, and the probe run validates it before train close-out; (3) billed time entries render LOCKED (no edit/delete affordance) until the write probe answers; (4) `clio_find_contact` selector fix same basis as (2).
- Every Clio read uses the CALLER's token via existing `loadClioConnection`/`clioRequest` — never another user's, never a firm token. Redacted money/hours (`quantity_redacted`, null price/total) render as "Hidden by your Clio permissions", never £0.
- Error pattern: fixed client details + `safeErrorLog` (PR #72); `ClioValidationError` messages pass through. No unbounded spinners; time-boxed loads with error+retry; the Workspaces tab must remain usable when Clio errors.
- All list/detail fields use ONLY the doc-verified selectors from the 06/08 spike report (one-level nesting; the exact list selector recorded in the spec).

## File Structure

| File | Responsibility |
|---|---|
| `backend/migrations/20260807_01_matter_workspace_links.sql` (create, authorised) + `backend/schema.sql` | additive links table per spec Model + RLS revoke + proving select |
| `backend/src/lib/clio/mattersSurface.ts` (create) | seam: listMatters (mine/all/search/status, in-memory 60s TTL cache keyed user+query, cap ~200 entries), matterDetail, relatedContacts, listActivities, updateActivity (ETag), deleteActivity, linkWorkspace/unlinkWorkspace/getLinkForProject/getLinkForMatter |
| `backend/src/lib/clio/mattersSurface.test.ts` (create) | seam tests (mocked HTTP + mocked supabase) |
| `backend/src/routes/clioMatters.ts` (+ test) (create) | `/clio-matters` routes: GET / (tab,query,status), GET /:id, GET /:id/contacts, GET /:id/activities, PATCH /activities/:id, DELETE /activities/:id, POST /:id/workspace (create+link), POST /links (link existing project), DELETE /links/:projectId |
| `backend/src/index.ts` (modify) | mount + research-rate-limit bucket |
| `backend/src/lib/clio/manageTools.ts` (modify) | FIX the `clio_matter_financials` selector (docs-verified: `id,display_number,unbilled_amount,unbilled_hours,amount_in_trust,currency_code,client{id,name}`) and `clio_find_contact` (`id,name,type,primary_email_address,email_addresses{address,primary}` shape) + tests |
| `backend/src/lib/userDataCleanup.ts` + `userDataExport.ts` (modify) | cover `matter_workspace_links` rows created_by the user (42P01-tolerant) + tests |
| `frontend/src/app/lib/mikeApi.ts` (modify) | 9 new methods mirroring the routes |
| `frontend/src/app/(pages)/projects/page.tsx` + `components/projects/ProjectsOverview.tsx` (modify) | Matters page: My matters / All matters / Workspaces tabs per mock-up Frame A; connected-state detection from profile clioConnections; fallback states Frame C |
| `frontend/src/app/(pages)/matters/[clioId]/page.tsx` + `components/matters/ClioMatterDetail.tsx` (create) | Frame B: overview, key people, financials (client-level balance labelled), time entries panel (edit-in-place own entries, billed locked, 412 conflict copy), workspace section (Start workspace / open linked) |
| `components/projects/LinkClioMatterModal.tsx` (create) | link an existing workspace to a matter (picker via matter search) |

## Tasks (one PR each, sequential merges, standard gates)

### Task 1 — migration + docs (branch `pm-migration`; BLOCKED on owner allowlist entry)
- [ ] Migration per spec Model: `matter_workspace_links (id uuid pk default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade, clio_matter_id text not null, clio_display_number text, organisation_id uuid references public.organisations(id) on delete set null, created_by uuid, created_at timestamptz not null default now(), unique(project_id))` + `create index if not exists idx_matter_links_matter on public.matter_workspace_links(clio_matter_id)` + `enable row level security` + `revoke all ... from anon, authenticated` + proving select. Mirror in schema.sql. Commit spec + this plan. Gates, PR, BUILD_LOG.

### Task 2 — backend seam + routes + tool fixes (branch `pm-backend`; starts immediately, 42P01-degrade covers ordering)
- [ ] Seam first, TDD: my-matters = two calls (responsible ∪ originating by stored `clio_user_id`), de-dup by id, sort `open_date` desc client-side; all-matters = one call `order=open_date(desc)&limit=200` with honest `meta.records` total when present; search passes `query`; status filter validated `open|pending|closed`. Cache: Map keyed `${userId}:${tab}:${query}:${status}`, 60s TTL, max 200 entries, cleared on activity write.
- [ ] Detail/contacts/activities per the spec's verified selectors; activities default `user_id=self`, `everyone=true` param lifts it. updateActivity: minutes→seconds conversion at the ROUTE boundary (UI sends minutes), pass IF-MATCH etag, map 412 to fixed detail "This entry changed in Clio — reload and try again."; billed entries: server REFUSES edit/delete with fixed 409 detail (belt for the locked UI) until the write probe says otherwise.
- [ ] Links: creating a workspace from a matter = insert `projects` row (name `${display_number} — ${description truncated}`, cm_number = display_number) + link row, org-stamped from the caller; linking existing = owner-only predicate; tombstoned projects excluded at the seam choke point (28/07 lesson).
- [ ] `clio_matter_financials` + `clio_find_contact` selector fixes with updated tests (cite the spike report in the PR body; note probe-validation pending).
- [ ] Lifecycle: cleanup/export cover links rows; tests. Full gates; PR; BUILD_LOG.

### Task 3 — frontend (branch `pm-frontend`; after Task 2 merges)
- [ ] Per mock-up frames A/B/C and the build notes under each; tabs remember last choice (localStorage); connected detection via existing profile `clioConnections`; row → `/matters/{clioId}`; "Start workspace"/link flows; time-entry edit modal reusing existing modal idioms; redaction + locked states; UK copy pass. Gates (lint parity, tsc, build); PR with QA steps; BUILD_LOG.

### Task 4 — composed-range review + fix wave + ship
- [ ] SHA-pinned range over the train; lenses: per-user token isolation (no cross-user read path), WS8/WS9/deletion-governance composition with links + lazily-created projects, rate-limit budget (no N+1), UI drift vs mock-up, UK terminology; fix wave PR if findings. Deploy both sides (owner), purge Cloudflare cache (EVERY deploy — 06/08 lesson), owner runs migration + pastes proving output + columns check, owner QA, probe-validation of the financials fix, close-out docs.

## Self-Review (run)
Spec coverage: model→T1/T2, all five surfaces→T2/T3, open questions→Global Constraints (gated), non-goals absent, verification section→T4 — no gaps. Placeholders: none. Type consistency: route/mikeApi names match 1:1; minutes↔seconds boundary stated once and owned by the route.
