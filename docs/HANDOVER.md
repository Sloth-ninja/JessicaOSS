# Handover — 19 July 2026 (Fable → Opus)

> Written at the end of the 19 July session by the outgoing agent (Claude Fable 5,
> leaving the plan). Read this first, then follow the pointers. Where this file and
> BUILD_LOG disagree on status, the newest BUILD_LOG entry wins.

## 1. Orientation — the trinity

- `CLAUDE.md` — constitution + "Where to read next" router + `## Current status`.
- `docs/DURABLE_LESSONS.md` — append-only project law. **Mandatory pre-reading**
  before evals, legal-sources, hooks, merge-train, or Express-handler work.
- `docs/BUILD_LOG.md` — one entry per PR, newest first, authoritative record.

Research context from 19 July lives in `docs/research/` (competitor scan;
Quill/Unity + HMLR integration briefs).

## 2. Live infrastructure

| Piece | Where | Deploy |
|---|---|---|
| Frontend | `https://jessicaoss.com` — Cloudflare Worker `jessicaoss` (custom domain via wrangler route; www 301-redirects to apex) | `cd frontend && npm run deploy` |
| Backend | `https://api.jessicaoss.com` — Fly.io app `jessicaoss-api`, region `lhr`, one always-warm machine, `/health` | `cd backend && fly deploy --yes` |
| DB/Auth | Production Supabase (invite-only sign-up, TOTP MFA, Resend SMTP on the verified domain) | dashboard |
| Storage | Cloudflare R2 bucket `jessicaoss-pilot`, scoped token | — |
| Secrets | Fly secrets (backend) — incl. `ANTHROPIC_API_KEY`, `COMPANIES_HOUSE_API_KEY`; two fresh signing/encryption secrets distinct from dev | `fly secrets list` (names only) |

Deploy gotchas are in DURABLE_LESSONS (OpenNext packager/bun.lock, wrangler
autoconfig delegation, piped-exit-code trap, Express-async crash class).

## 0. CURRENT PICKUP — 4 August 2026 (read this, then CLAUDE.md Current status)

State: everything through PR #68 is merged + deployed + live. Clio connector
v1 shipped (#62–#66) and survived first pilot contact: the 03/08 incident
(production minted 127.0.0.1 OAuth redirects because `API_PUBLIC_URL` was
unset on Fly) was fixed operationally (`fly secrets set … API_PUBLIC_URL=…`)
and structurally (#68 fail-closed guard + DURABLE_LESSONS entry). WS9 firm
library ACTIVE in production. All migrations through `20260803_01` run in
production Supabase.

**Live pilot threads (chase, verify, don't rebuild):**
1. Lindsay Healy + the owner's second account were created via Supabase
   "Create new user" (invite emails were quarantined by the firm's Microsoft
   365 — owner has the M365 allow-list + Cloudflare DMARC fixes as pending
   actions; invite flow unverified since). Lindsay's Clio reconnect after the
   incident fix was pending at session end — FIRST ASK: did it work, and does
   her "matters visible" count differ from the owner's as expected? That is
   the pilot's per-user permissions verification (owner decision: it happens
   via the card, not a spike).
2. Grow intake-notes tools (clio_intake_notes / clio_add_intake_note) are the
   one research-based (not live-verified) surface — verify on first real use.
3. Remaining ~5 pilot lawyers join after the office two are happy.

**Owner-pending (unchanged):** M365 quarantine release + allow-list; DMARC
TXT record on jessicaoss.com; HMLR channel-partner email (drafted in-session
28/07, never sent); solicitor sign-offs per §5 below.

**Next roadmap (owner order):** saved tabular schemas → Playbooks → Word
add-in. Spec → mock-up → build for new surfaces; all work through the
standard gates (independent review + 3 CI checks + BUILD_LOG entry; composed-
range review after any multi-PR train — it has caught a real cross-module
defect on every train to date).

---

> **RESOLVED 28 July 2026:** everything in §3a completed. PR E merged (#40) and
> deployed; the composed-range review ran (0 Critical/Important, minors fixed
> #43); migration #44 owner-authorised; PR F merged (#45, incl. a review-forced
> server-side chat-model clamp); PR G merged (#46, spec in
> `docs/DELETION_GOVERNANCE_SPEC.md`, fail-safe inversion recorded in
> DURABLE_LESSONS); both sides deployed 28/07. Outstanding owner action: run
> migration `20260727_01` in production Supabase. Current truth: CLAUDE.md
> `## Current status`.

## 3a. (Historical) IN-FLIGHT at 23 July 2026 session end

**WS8 "Firm administration" is nearly complete.** Merged + deployed: #34 org
foundation (organisations table, admin role, `firm` profile payload,
`DEFAULT_ORGANISATION_ID`), #35 allowlist record, #36 firm API keys + admin area
+ member role management, #37 FIRM_SETUP fix, #38 policy enforcement (tabs
vanish; lingering personal keys inert + removable; fail-open on infra errors),
#39 admin usage dashboard. Production firm seeded: Aria Grace Law CIC, admin
`ezana.haddis@aria-grace.com` (dot form — the hyphen form was wrong), org id
`932aa0af-a52e-4e96-8bb0-62e028cb21d3` in `DEFAULT_ORGANISATION_ID`.

**Still open when the session ended:**
1. **PR E — connectors gallery** (branch `ws8-connectors-gallery`, agent was
   mid-build with per-provider OAuth-MCP verification). Check `gh pr list`; if
   open, run the gate (independent opus review re-deriving: registry honesty —
   no dead Connect buttons, per-provider verification evidence in the PR body;
   policy gating on connect; SSRF guards; admin curation authz) → fix wave →
   merge on CI green.
2. **Composed-range multi-lens review** of the WS8 train (DURABLE_LESSONS
   mandate): range `0646edf...main` (everything after PR #33), lenses =
   security/RLS+admin-authz, policy-matrix correctness (OFF/ON/orgless),
   UI drift across admin+account surfaces, UK terminology. Fix wave if needed.
3. **Deploy both sides** after E + fixes (fly deploy from backend/, npm run
   deploy from frontend/) and verify live.
4. **PR F (firm model preferences) + PR G (deletion governance)** — owner
   decisions already taken (see §4a); G needs a mini-spec first and BOTH need
   ONE bundled migration the owner must authorise in
   `.claude/hooks/authorized-migrations.json` (suggest basename
   `20260723_01_firm_models_and_deletion_governance.sql`).

**Approved mock-ups (permanent artifact URLs — session scratchpads are gone):**
WS7 Research panels: https://claude.ai/code/artifact/5bee83e3-b0bb-4d66-ba62-5fc69a209e36
WS8 Firm administration: https://claude.ai/code/artifact/e229829e-6914-4974-a908-0fad10c21a98
Fetch with WebFetch if visual reference is needed; build-mapping notes live in
the relevant BUILD_LOG entries.

## 4a. WS8 remaining scope — owner decisions already taken (22 July)

- **PR F — firm-level Model Preferences:** third policy toggle ("members may
  set own model preferences", default OFF for firms); firm model config
  (default model, offered providers) in Firm settings; members under
  policy-off see absence + "Model access is provided by <firm name>".
- **PR G — deletion governance:** member delete → soft-delete request (hidden
  immediately, held per-org `retention_days` default 30, then purged); admin
  "Pending deletions" restore/expedite in Firm settings; append-only audit
  trail (requester/restorer/purge — the seed of a general admin audit log);
  export stays but audited. Mini-spec before build.
- Also owner-confirmed: existing connectors keep working for members under
  policy-off (writes gated, reads/refresh open) — PR #38's shipped behaviour.

## 3b. (Historical) 19 July workflow handover — RESOLVED

> **RESOLVED 20 July 2026:** the workflow completed. All lanes merged (#25, #27,
> #29, #30, #31) and deployed; live pages verified HTTP 200; composed-range
> review ran (security/integration approved, UI-drift fixes landed as #31); the
> Land Registry stub's README overclaim was caught by its merge gate and
> corrected before merging. Nothing from this section remains outstanding —
> it is kept for the record. Current truth: CLAUDE.md `## Current status`.

A Workflow run (`wf_141dad74-31b`; script:
`~/.claude/projects/-Users-ezanahaddis-JessicaOSS/7d6b925c-e616-4bdd-8ca7-8d098ecaf2b5/workflows/scripts/ws7-closeout-wf_141dad74-31b.js`)
was finishing WS7 autonomously:

1. Merge PR #25 (Company Search — review-fixed, #24-integrated).
2. Build + gate **Legislation panel** (`ws7-legislation-panel`) and the
   **BYO-key-precedence flip** (`byo-key-precedence`) in parallel.
3. **Land Registry coming-soon stub** (`ws7-land-registry-stub`).
4. Composed-range multi-lens review over `56896cf...main` (the whole WS7 train),
   fix wave if needed.
5. Deploy both sides + health checks + worktree cleanup.

**Check:** `gh pr list --repo Sloth-ninja/JessicaOSS`, BUILD_LOG top entries, and
that `/company-search`, `/legislation`, `/citation-checker` return 200 on the live
site. Complete any unfinished lane by hand using the specs inside the script file
(they are self-contained prompts). The **owner decision driving the precedence
flip: a user's own API key ALWAYS beats the server env key, for every provider**
(reverses the pre-existing env-first behaviour; PUT /user/api-keys' 409 env-block
must be gone; removing a user key falls back to the env default).

## 4. Next-actions queue (owner-set order, 19 July)

1. **Admin usage dashboard** (S) — adoption/usage views over existing tables; the
   COO's ROI evidence. Then **saved tabular schemas → Lists** (S–M) — reusable
   extraction templates; then status/assignee/cite-to-clause columns.
2. **Playbooks** (M, ✅ approved) — firm red-lines applied as tracked-changes
   review via the existing tool loop + `docxTrackedChanges.ts`.
3. **Word add-in** (M, ✅ approved) — Office.js task pane over the existing
   `/chat` SSE + document tools; Supabase JWT auth.
4. **Unity integration** (v1.1, parked) — owner gets access w/c 20 July; one-day
   read-only spike is the go/no-go; time-recording is the headline; see
   `docs/research/2026-07-19-integrations.md`.
5. ❌ Translate rejected; Portal and no-code agent builder deferred.

## 5. Owner-pending items (chase, don't do)

- Solicitor sign-off: `docs/LEGAL_LANGUAGE_REVIEW.md` (R1–R10, incl. R10 "matter")
  + 6 provisional judged eval fixtures + **pilot terms/privacy** (signup links
  still point at mikeoss.com legal pages — blocked on real AGL documents).
- Quill registration Google form (wiki → Register your App) with the three
  questions in the research brief.
- Model-comparison run to populate the README eval table (key exists; never run).
- Ollama live smoke of local-model mode — owner's Mac is an 8GB M1 → `qwen3:4b`.
- Upstream dependency-vulnerability triage (7 moderate/5 high, WS6 PR body).
- Launch checklist (BUILD_PLAN §9): demo video, AGL quotes, ping Will Chen.

## 6. Operating rituals (how this project runs)

- **Merge rule (hard rule 6):** agent merges only when ALL THREE hold — 3 CI
  checks green on the current head + independent review passed + BUILD_LOG entry.
- Every PR gets an independent code-reviewer pass before merge; after any
  multi-PR train, run a **composed-range multi-lens review** over the full merged
  diff (DURABLE_LESSONS: per-task review cannot see cross-commit drift).
- Append to DURABLE_LESSONS whenever a gotcha is paid for (trigger → rule →
  debugging signature). Never edit old entries; add dated corrections.
- Always `gh ... --repo Sloth-ninja/JessicaOSS` (fork-target incident).
- Clean up `.claude/worktrees/agent-*` once branches merge; never delete remote
  branches (owner's call).
- Bias to small PRs; minimal diffs vs upstream (hard rule 8); UK English and the
  terminology table everywhere; product = "JessicaOS", assistant persona =
  "Jessica".
