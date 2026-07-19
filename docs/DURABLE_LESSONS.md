# Durable lessons

> Append-only engineering lessons for JessicaOS. One entry per lesson: the concrete
> trigger, the generalised rule, and (where useful) a **debugging signature** — the
> symptom that tells you you're hitting the same class of bug again.
>
> **Ritual:** append a lesson at the end of any session that discovers a gotcha worth
> not relearning; never edit old entries retroactively (add a dated correction instead).
> **Mandatory pre-reading** before work touching: the eval harness, legal-sources
> integrations, the merge/PR workflow, hooks, or anything running against upstream code.
>
> Kept separate from `CLAUDE.md` so the startup file stays short (pattern adopted
> 19 July 2026 from the agl-founders-network sister project's `docs/durable-lessons.md`).

## Index

- 2026-07-06 — Local models need a chat-completions client, not the Responses API
- 2026-07-07 — Never prettier-format upstream files; no prettier config exists
- 2026-07-08 — Eval runner loads operator env itself; real environment always wins
- 2026-07-08 — legislation.gov.uk: regnal-year URIs, UnappliedEffects, push-protection false positive
- 2026-07-08 — Verify the gh target repo before every `gh pr create` (fork!)
- 2026-07-12 — Judged eval cases skip on a missing key but FAIL on an invalid one
- 2026-07-12 — Zombie agents: verify liveness and message-vs-diff before pushing
- 2026-07-19 — Imported lessons from the sister project (agl-founders-network)

## Lessons

### 2026-07-06 (Phase 0) — Local models need a chat-completions client

Trigger: planning WS3 revealed upstream `backend/src/lib/llm/openai.ts` uses OpenAI's
**Responses API**, which Ollama / LM Studio / vLLM do not serve. Rule: the local-model
path lives in its own chat-completions client (`llm/localOpenAI.ts`); never route local
models through the cloud OpenAI client. `OPENAI_BASE_URL` is only honoured as an alias
for `LOCAL_LLM_BASE_URL` when the latter is unset — it never affects the cloud client.

### 2026-07-07 (Excision) — Never prettier-format upstream files

Trigger: the PostToolUse hook ran `prettier --check` on backend files, but the repo has
**no prettier config** and upstream files are not prettier-clean; an auto-format would
have rewritten a whole file's indentation (caught and reverted). Rule: hooks and agents
only run prettier where a project defines a config; never `prettier --write` upstream
code — it destroys the minimal-diff discipline (hard rule 8) and makes rebases expensive.

### 2026-07-08 (Excision addendum) — Eval runner loads operator env itself

`evals/src/env.ts` loads repo-root `.env.local` / `.env`, then `backend/.env`, and the
real environment always wins. Rule: never read env files yourself (hard rule 2) and
never pass keys on the command line — run `npm run evals` and let the runner find them.
When verifying a branch that lives in a worktree, run evals from the MAIN checkout
(detached HEAD works).

### 2026-07-08 (WS2) — legislation.gov.uk integration gotchas

- Title search is `/{type}/data.feed?title=…` (Atom), not a JSON endpoint.
- Pre-1963 Acts use **regnal-year URIs** (LTA 1954 = `ukpga/Eliz2/2-3/56`); the resolver
  falls back to per-entry `ukm:Year`/`ukm:Number` metadata rather than parsing regnal
  strings. Debugging signature: a statute resolves in search but 404s on a
  calendar-year URI → it's pre-1963.
- Outstanding amendments = `ukm:UnappliedEffects` in CLML. Surface them; never hide
  revision lag (CLAUDE.md data-integrations rule).
- Effect ids (`key-<32hex>`) **false-positive GitHub push protection** as Mailgun keys.
  Committed XML fixtures use `key-redacted-effect-id`. Debugging signature: a push
  rejected for "Mailgun API key" in legislation XML is this, not a real secret — but
  verify before overriding, and prefer redacting to allowlisting.

### 2026-07-08 (WS5, PR #4 incident) — Verify the gh target repo on every PR

Trigger: `gh pr create` defaulted to upstream `Open-Legal-Products/mike` and briefly
opened PR #207 there (closed within a minute, apologised). The default is now pinned to
`Sloth-ninja/JessicaOSS`, but the rule stands: pass `--repo` explicitly or verify
`gh repo set-default --view` before creating any PR from a fork.

### 2026-07-12 — Judged eval cases skip on a missing key but FAIL on an invalid one

`evals/src/judge.ts` (judge = `claude-opus-4-8`): cases skip cleanly when
`ANTHROPIC_API_KEY` is absent, but a set-but-invalid key makes them fail with 401s.
Debugging signature: judged cases suddenly failing right after "adding the key" means
the key is bad (placeholder, wrong scope), not an eval regression. Verified-stable
Companies House fixtures for deterministic cases: ARIA GRACE LAW CIC `13927967`,
MARKS AND SPENCER P.L.C. `00214436`.

### 2026-07-12 (merge train) — Zombie agents: verify liveness and message-vs-diff

Trigger: the ws4 pre-stager agent appeared dead, the controller rebased inline, and the
agent's zombie later woke and wrote into shared state (it self-cleaned, but only luck
made that harmless). Rules: treat unexplained working-tree changes during multi-agent
runs as possible zombie writes and check agent liveness before reinterpreting intent;
before any push, verify the commit message actually describes the diff it sits on.

### 2026-07-19 — Imported lessons from agl-founders-network (sister project)

Reviewed 19 July 2026; these transfer to JessicaOS and are adopted as project law.
Provenance: `agl-founders-network/docs/durable-lessons.md`.

- **Per-task review cannot see cross-commit drift.** Six individually-approved tasks
  still produced ten real cross-commit inconsistencies there. After any multi-PR train
  or multi-agent fan-out here, run one composed-range review over the full merged diff
  (multi-lens: security, UI drift, copy/terminology, integration) before calling the
  train done. Our post-merge integration check on 12 July was a partial version of this;
  make it the standard.
- **Never surface raw provider/DB error messages to users.** Log server-side with a
  scoped tag; return one fixed, friendly message. Differentiated errors leak state —
  in a legal platform, even confirming a document/matter *exists* can be a breach.
- **Encode state transitions in the UPDATE predicate itself** (`.eq("id", …)
  .eq("status", expected)` + select-back, zero rows = generic failure) rather than
  read-then-write. Atomic against races/double-submits; applies to any document/workflow
  lifecycle we add on Supabase.
- **Framework-version warning beats pretrained memory.** Next.js 16 broke conventions
  agents "know" (`middleware.ts` → `proxy.ts`, async `searchParams`). When touching
  frontend framework conventions, check `node_modules/next/dist/docs/` first.
- **A column existing in the schema is not a reason to surface it in UI.** Render only
  fields whose behaviour is actually built.
