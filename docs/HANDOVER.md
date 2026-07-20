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

## 3. IN-FLIGHT at session end — verify this FIRST

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
