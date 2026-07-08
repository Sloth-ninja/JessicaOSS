# JessicaOS Build Log

> Running record of what was done, by whom, and how it was verified — one entry per
> PR/workstream, newest first. Every PR must append an entry here (CLAUDE.md,
> definition of done). Keep entries factual: scope, key changes, verification
> evidence, decisions taken, anything deferred.

---

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
