# JessicaOS Build Log

> Running record of what was done, by whom, and how it was verified — one entry per
> PR/workstream, newest first. Every PR must append an entry here (CLAUDE.md,
> definition of done). Keep entries factual: scope, key changes, verification
> evidence, decisions taken, anything deferred.

---

## 2026-07-19 — Pilot stability: API-keys crash fix + honest save errors (branch `fix-apikeys-stability`)

**Scope:** first live-user bug, found during owner QA. Symptoms: "Failed to save"
alerts for Claude, OpenAI and Companies House keys. Root causes (two distinct):

1. **Backend crash (the real outage):** `GET /user/api-keys` had no try/catch;
   Express 4 doesn't catch async-handler rejections and Node 22 kills the process
   on unhandled rejections — one transient Supabase error took the whole backend
   down mid-QA (Fly logs 19:21 UTC, machine restart). Fixed with a handler
   try/catch (500 + generic detail) and process-level
   `unhandledRejection`/`uncaughtException` log-don't-die guards in `index.ts`.
   Lesson + debugging signature appended to `docs/DURABLE_LESSONS.md`.
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
