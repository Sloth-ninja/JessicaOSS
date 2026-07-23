# CLAUDE.md — JessicaOS

> Project constitution. Read fully before any work. Rules here override task instructions.

## What this project is

**JessicaOS** is the UK localisation of [Mike](https://github.com/willchen96/mike) (MikeOS), the open-source AI legal platform. Fork lineage and AGPL-3.0 licence are preserved and celebrated, not hidden.

Mission: the first *substantive* UK version — real UK data integrations, UK legal workflows, verified citations, and an optional fully on-premises open-weights model mode. Built by the COO of Aria Grace Law and piloted with real solicitors.

**Naming rationale:** Mike worked for Harvey. They both worked for Jessica.

## Where to read next

| Need | Read |
|---|---|
| Current status + what happened last | `## Current status` below, then the top entry of `docs/BUILD_LOG.md` |
| Session handover / next actions (written 19 July for the incoming agent) | `docs/HANDOVER.md` |
| Competitor + integration research (Legora/Harvey, Quill/Unity, HMLR) | `docs/research/` |
| Engineering lessons/gotchas (mandatory before evals, legal-sources, hooks, or merge-train work) | `docs/DURABLE_LESSONS.md` |
| Sprint plan and workstream scopes (historical; superseded by BUILD_LOG for status) | `docs/BUILD_PLAN.md` |
| US→UK migration design, touchpoint inventory, owner decisions | `docs/MIGRATION_SPEC.md` |
| Deploying the pilot (Fly.io / Cloudflare / production Supabase) | `docs/DEPLOYMENT.md` |
| Running the pilot programme | `docs/PILOT.md` |
| Local/on-premises model mode | `docs/local-models.md` |
| Eval harness: cases, gates, judge, baseline | `evals/README.md` |
| Legal terms of art awaiting solicitor sign-off | `docs/LEGAL_LANGUAGE_REVIEW.md` |

Where docs conflict on status or scope, `docs/BUILD_LOG.md` (newest entry) wins over `docs/BUILD_PLAN.md`, which is kept as the historical plan of record.

## Architecture (verified against code, Phase 0)

Two independent npm projects, no shared workspace. Frontend calls backend over HTTP; browser never touches the DB directly (all client grants revoked in `backend/schema.sql:792-823`).

- **Frontend**: Next.js 16 App Router (TypeScript, React 19, Tailwind 4) in `frontend/`. Deploy target Cloudflare Workers via `@opennextjs/cloudflare`. Auth is Supabase JS on the client (JWT + optional TOTP MFA).
- **Backend**: Express 4 (TypeScript, tsx in dev, tsc→node in prod) in `backend/`. Single entry `backend/src/index.ts` (helmet, CORS from `FRONTEND_URL`, per-route rate limits).
- **DB**: Supabase Postgres. Canonical schema `backend/schema.sql`; dated migrations in `backend/migrations/` (protected — see hard rule 1). Backend uses the service-role key only.
- **Storage**: Cloudflare R2 / S3-compatible (`backend/src/lib/storage.ts`), HMAC-signed download tokens (`downloadTokens.ts`), DOCX→PDF via LibreOffice (`convert.ts`).
- **Model providers**: `backend/src/lib/llm/` — `models.ts` (registry: Claude / Gemini / OpenAI tiers, provider inferred from model-id prefix), `index.ts` (dispatch), `claude.ts` / `gemini.ts` / `openai.ts` (streaming + tool calls). BYO keys per user, AES-256-GCM encrypted (`userApiKeys.ts`), env keys as fallback.

### Module map (backend)

| Area | Files |
|---|---|
| Routes | `src/routes/`: `chat.ts` (main SSE chat), `projectChat.ts`, `projects.ts`, `documents.ts`, `tabular.ts`, `workflows.ts`, `user.ts` (profile, API keys, MCP connectors, export/delete), `downloads.ts`, `companies.ts` (Companies House research: search / profile+officers+PSCs bundle / filing history — WS7), `citations.ts` (WS7 Citation Checker: `POST /citations/check` — extraction via `lib/citationExtraction.ts`, live verification via `lib/legislation.ts`), `legislation.ts` (WS7 Legislation panel: `GET /legislation/search` title search + `GET /legislation/lookup` citation→provision — thin, un-keyed wrappers over `lib/legislation.ts`), `admin.ts` (WS8 firm administration, mounted at `/admin`, all behind `requireAuth` + `requireAdmin`: `GET/PUT /admin/firm-keys[/:provider]` firm-shared API keys, `GET /admin/members` + `PATCH /admin/members/:userId/role` member role management with a last-admin guard, `PATCH /admin/policies` firm member-policy toggles — WS8 PR B; `GET/PATCH /admin/connector-gallery` firm curation of the connector shortlist — WS8 PR E). `user.ts` also serves the connector gallery: `GET /user/connector-gallery` (curated shortlist + live status) and `POST /user/connector-gallery/:registryId/connect` (one-click create+OAuth, `requireMemberPolicy`-gated — WS8 PR E) |
| Chat engine | `src/lib/chatTools.ts` (~3.7k lines: system prompts, doc context, tool execution loop `runLLMStream`, citation annotation extraction, research-tools seam) |
| Legal sources | `src/lib/legalSourcesTools/` (CourtListener excised 07/07/2026; UK sources — Companies House WS1, legislation.gov.uk WS2 — land here per `docs/MIGRATION_SPEC.md`) |
| Documents | `storage.ts`, `documentVersions.ts`, `docxTrackedChanges.ts`, `convert.ts`, `upload.ts`, `downloadTokens.ts` |
| Users | `userSettings.ts`, `userApiKeys.ts` (key precedence user > firm > env), `userDataExport.ts`, `userDataCleanup.ts`, `access.ts`, `middleware/auth.ts` (`requireAdmin`, `requireMemberPolicy` — WS8 PR B firm-policy write gate, fail-open) |
| Firm admin (WS8) | `organisations.ts` (membership, `isAdmin`, `getUserOrganisationId`, member list + `setMemberRole` last-admin guard), `organisationApiKeys.ts` (firm-shared keys CRUD), `apiKeyCrypto.ts` (shared AES-256-GCM for user + firm keys) |
| MCP | `src/lib/mcp/` (client, oauth, servers) + `mcpConnectors.ts`; `mcpConnectorRegistry.ts` (WS8 PR E curated one-click connector shortlist — honesty-verified OAuth endpoints vs informational "custom" entries) + `mcpConnectorGallery.ts` (gallery build: per-caller status derivation, org-curation filtering) |
| Seed workflows | `src/lib/builtinWorkflows.ts` (backend, 3 system workflows) and `frontend/src/app/components/workflows/builtinWorkflows.ts` (frontend, 14 templates) |

### Module map (frontend)

- `src/app/(pages)/` — routes: assistant, projects, tabular-reviews, workflows, company-search / legislation / citation-checker (WS7, "Research" sidebar group), account (models / features / api-keys / connectors [WS8 PR E connector gallery — Popular cards, All/Connected/Not-connected filters, initial-letter tiles, Add-custom menu] / security / privacy-data); `admin/firm-settings` (WS8; gains a "Connectors" curation card — PR E); `login`, `signup`, `verify-mfa` at app root.
- `src/app/components/` — `assistant/` (ChatView, AssistantMessage, AssistantSidePanel), `projects/`, `tabular/`, `workflows/`, `shared/`, `modals/`.
- `src/app/lib/mikeApi.ts` — the only backend client (~1.2k lines; base URL `NEXT_PUBLIC_API_BASE_URL`, Supabase JWT bearer auth).
- `src/app/hooks/useAssistantChat.ts` — SSE event parser/state machine for streaming chat.
- Contexts: `AuthContext`, `UserProfileContext` (profile, feature flags, API-key status), `ChatHistoryContext`.

### Request flow (chat)

1. `ChatInput` → `useAssistantChat` → `mikeApi.streamChat()` → `POST /chat` (SSE).
2. `requireAuth` middleware validates Supabase JWT → `chat.ts` builds doc context (`buildDocContext`), loads user model settings + decrypted API keys, assembles system prompt (`buildSystemPrompt(includeResearchTools)` — the seam where UK research prompts splice in).
3. `runLLMStream` (chatTools.ts) → `streamChatWithTools` (llm/index.ts) → provider stream; tool calls (document read/edit, generate_docx, workflow, MCP, legal research) executed server-side, results fed back; every step emitted as an SSE event (`text_delta`, `doc_edited`, `mcp_tool_*`…).
4. Assistant message + citation annotations persisted to `chat_messages`; frontend renders events incrementally.

### Env var registry

Backend (`backend/.env.example` documents the core set):

| Var | Required | Purpose |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | yes | DB + auth admin |
| `DOWNLOAD_SIGNING_SECRET` | yes | HMAC for `/download/:token` |
| `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | yes for uploads | R2 storage (`R2_BUCKET_NAME` optional, default `mike`) |
| `USER_API_KEYS_ENCRYPTION_SECRET` | yes | AES-256-GCM key derivation for BYO keys |
| `ANTHROPIC_API_KEY` (alt `CLAUDE_API_KEY`), `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | optional | provider fallbacks used only when the user has no key of their own; a per-user BYO key always takes precedence |
| `PORT` (3001), `FRONTEND_URL` (CORS), `NODE_ENV`, `TRUST_PROXY_HOPS` | optional | runtime |
| `API_PUBLIC_URL` / `BACKEND_URL` | optional | MCP OAuth callback base |
| `MCP_OAUTH_CLIENT_ID/_SECRET`, `MCP_OAUTH_DEFAULT_SCOPE`, `MCP_CONNECTORS_ENCRYPTION_SECRET` | optional | MCP connectors |
| `RATE_LIMIT_*` (16 vars, `src/index.ts`) | optional | rate-limit tuning; incl. `RATE_LIMIT_RESEARCH_WINDOW_MINUTES` (default 15) / `RATE_LIMIT_RESEARCH_MAX` (default 120) for the UK research routes (`/companies`, `/legislation`) and `RATE_LIMIT_CITATIONS_MAX` / `RATE_LIMIT_CITATIONS_WINDOW_MINUTES` (default 20 per 15 min) for `POST /citations/check` |
| `LOG_RAW_LLM_STREAM`, `RAW_LLM_STREAM_LOG_DIR` | optional | dev-only stream logging |
| `RESEND_API_KEY` | optional | in `.env.example`; SDK installed, currently unused in `src/` |
| `COMPANIES_HOUSE_API_KEY` | optional | Companies House key: the per-user BYO key always takes precedence; this env key is the shared fallback used only when a user has none. (Owner decision 19/07/2026 flipped the env-first precedence documented in the PR #25 review; a user with their own key escapes the shared env-key rate bucket.) |
| `DEFAULT_ORGANISATION_ID` | optional | Firm administration (WS8): uuid of the organisation new/orgless users are auto-assigned to (as members) on first profile load. Unset ⇒ orgless (self-hoster default). Set to the pilot firm's org uuid per `docs/FIRM_SETUP.md`. |
| `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODELS`, `LOCAL_LLM_API_KEY` | optional | Local/on-premises OpenAI-compatible chat-completions provider (Ollama, LM Studio, vLLM) — data sovereignty mode, see `docs/local-models.md`. `OPENAI_BASE_URL` honoured as an alias for `LOCAL_LLM_BASE_URL` when the latter is unset; never affects the cloud OpenAI client. |

Frontend (`frontend/.env.local.example`, all public): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`, `NEXT_PUBLIC_API_BASE_URL` (default `http://localhost:3001`). No secrets in the frontend, ever.

## UK conventions — apply everywhere

| US (upstream) | UK (this fork) |
|---|---|
| attorney / lawyer | solicitor / counsel (context-dependent) |
| opinion | judgment |
| plaintiff | claimant |
| deposition | (rarely applicable — witness statement / examination) |
| discovery | disclosure |
| motion | application |
| docket | case file / cause list |
| MM/DD/YYYY | DD/MM/YYYY |
| US Bluebook citations | UK neutral citations, e.g. `[2024] UKSC 12`; statutes as `s.994 Companies Act 2006` |
| ZIP code | postcode |
| corporation / Inc. | company / Ltd / plc / LLP |
| US spelling (analyze, license-as-verb-and-noun) | UK spelling (analyse, licence [noun] / license [verb]) |

All user-facing copy, prompts, and workflow templates use UK English and UK legal terminology. When in doubt, ask; do not guess US→UK legal equivalences — some concepts have no equivalent.

## Data integrations

1. **Companies House API** — free, requires API key (`COMPANIES_HOUSE_API_KEY`). Company search, profile, officers, PSCs, filing history.
2. **legislation.gov.uk API** — fully open, no key. Open Government Licence permits computational reuse. Acts + SIs, revised versions. Surface the "outstanding effects / prospective amendments" flags to the user — never hide revision lag.
3. **Find Case Law (The National Archives)** — DEFERRED pending computational-use licence. Do not integrate case-law retrieval yet. Roadmap item; be transparent in README.
4. **HM Land Registry Business Gateway** — DEFERRED (commercial account required). Roadmap item.
5. **BAILII** — NEVER scrape or integrate. Prohibited by their terms.

## Model providers

- Default recommendation: frontier API models (quality hierarchy documented in README eval table).
- Local/open-weights mode: any OpenAI-compatible endpoint via `OPENAI_BASE_URL` (Ollama, LM Studio, vLLM). Positioning = data sovereignty, not cost. Docs must carry honest quality caveats backed by the eval table.
- Never remove or weaken the BYO-key model; never log or persist API keys outside the existing encrypted path.

## Hard rules — violating any of these fails review

1. **NEVER** edit files in `backend/**/migrations/` (or wherever migrations live) without an explicit human instruction naming the file.
2. **NEVER** edit, create, or read `.env`, `.env.*`, or any secrets file. Use `.env.example` for documenting new vars.
3. **NEVER** remove or alter licence headers, `LICENSE`, or upstream copyright/attribution. This fork stays AGPL-3.0.
4. **NEVER** hardcode API keys, company numbers used in tests notwithstanding.
5. Any cited statutory provision or citation produced by product prompts MUST be verifiable against a live API. Unverifiable citation = bug = red build.
6. All work lands via PR from a feature branch. No direct pushes to `main`. Merges: standing owner authorisation (19 July 2026) — the agent merges a PR itself once all three CI checks are green, an independent review has passed, and the BUILD_LOG entry is in place; anything not meeting all three still waits for the owner. Rationale: everything is PR-tracked and revertible.
7. Do not add dependencies without stating why in the PR description; prefer stdlib/existing deps.
8. Do not "fix" upstream code style wholesale — minimal diffs, so upstream rebases stay cheap.

## Definition of done (per workstream)

- `tsc`, ESLint, Prettier clean on changed files (hook-enforced)
- Unit tests written and passing
- Eval smoke subset passing; no regression on golden set
- UK terminology table respected in all user-facing strings
- PR description: what/why/how-tested, screenshots for UI
- CLAUDE.md and `/docs` updated if behaviour or env vars changed
- Entry appended to `docs/BUILD_LOG.md` (scope, key changes, verification evidence, decisions)
- Any gotcha discovered en route captured in `docs/DURABLE_LESSONS.md` (append-only; trigger + rule + debugging signature)

## Commands

Two separate npm projects — install and run each from its own directory. There is no root workspace; the root `package.json` exists only to expose the eval runners.

```bash
# Backend (Express, port 3001)
cd backend && npm install
npm run dev              # tsx watch src/index.ts
npm run build            # tsc → dist/
npm start                # node dist/index.js
npx tsc --noEmit         # typecheck (no dedicated lint script; prettier is a devDependency)
npx prettier --check src # format check

# Frontend (Next.js, port 3000)
cd frontend && npm install
npm run dev              # next dev
npm run build            # next build
npm run lint             # eslint (flat config)
npx tsc --noEmit         # typecheck

# Evals (from repo root; see evals/README.md)
npm run evals            # full golden set — CI merge gate, includes citation hard gate
npm run evals:smoke      # ≤5 smoke cases — used by the Stop hook
```

**No unit-test framework exists yet** (upstream ships none). Adding one (vitest) is part of the sprint; until then "unit tests passing" in the definition of done applies only where tests exist. Hooks in `.claude/settings.json` enforce typecheck/lint/format on edits, protect migrations/`.env*`/LICENSE, and run `evals:smoke` on Stop.

## Current status

Updated 2026-07-19. The v1 sprint is **complete**: Phase 0, CourtListener excision, and all six workstreams (WS1 Companies House #7, WS2 legislation.gov.uk #8, WS3 local models #6, WS4 UK templates/terminology #5, WS5 README/landing #4, WS6 pilot-deployment artefacts #9) are merged, plus judged eval fixtures (#10), the CI merge gate (#11, `.github/workflows/ci.yml`), and the eval baseline (#12, `evals/baseline.json`). Judged evals run fully live — 35/35 passing.

**PILOT PLATFORM DEPLOYED AND REACHABLE (19 July 2026; in-browser functional QA pending).** Frontend: `https://jessicaoss.com` (Cloudflare Worker `jessicaoss`, custom domain attached at deploy, HTTP 200, JessicaOS branding). Backend: `https://api.jessicaoss.com` (Fly.io app `jessicaoss-api`, region `lhr`, one always-warm machine, Let's Encrypt cert, `/health` ok, CORS verified against the apex origin). Production Supabase (invite-only, Resend SMTP on the verified domain) + scoped R2 bucket configured. Merged same day: #13 deploy-config, #14 process-docs, #15 rebrand (product "JessicaOS", assistant persona "Jessica"), #16 merge governance, #17/#18 OpenNext packager fixes, #19 Worker route. Since then: www→apex redirect live; mikeoss.com URLs switched (#21) except the signup terms/privacy links (blocked on solicitor-approved AGL legal pages); pilot-stability fixes (#22); **WS7 COMPLETE (verified live 20 July 2026)** — the full train merged and deployed: Matters rename (#23), Citation Checker (#24, 20k ReDoS cap), Company Search (#25), handover pack (#26), BYO-key-precedence flip (#27 — user keys always beat env keys, owner decision 19/07), research-doc sourcing (#28), Legislation panel (#29), Land Registry coming-soon stub (#30, honest "planned/not yet started" wording), composed-range review fix wave (#31). Live checks 20/07: `/`, `/company-search`, `/legislation`, `/citation-checker` all HTTP 200; API health ok. Composed-range multi-lens review: security and integration lenses approved; UI-drift findings fixed in #31. Next actions (owner-set order): admin usage dashboard → saved tabular schemas → Playbooks → Word add-in → Unity v1.1 spike; owner-pending items live in `docs/HANDOVER.md` §§4–5. Keep this section current when status changes materially; per-PR detail lives in `docs/BUILD_LOG.md`.
