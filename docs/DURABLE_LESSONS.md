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
- 2026-07-19 — OpenNext build: upstream bun.lock hijacks packager detection
- 2026-07-19 — Correction: bun.lock also hijacked deploy (wrangler autoconfig) — deleted
- 2026-07-19 — Express 4 async handlers + Node 22: one unwrapped rejection kills the server
- 2026-07-21 — log-don't-die turns unwrapped handlers into hanging requests
- 2026-07-22 — Angle-bracket placeholders in runnable snippets get pasted literally
- 2026-07-22 — Supabase SQL editor: UPDATE without RETURNING reports "Success. No rows returned" either way
- 2026-07-22 — user_profiles.user_id is uuid; event tables' user_id is text — never cross-join raw
- 2026-07-23 — Relative `cd` in chained/background shell commands: use absolute paths

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

### 2026-07-19 — OpenNext build: upstream bun.lock hijacks packager detection

Trigger: first production frontend deploy — `npx opennextjs-cloudflare build` failed
with `/bin/sh: bun: command not found` (execSync status 127). Upstream Mike ships
`frontend/bun.lock` alongside our canonical `package-lock.json`, and OpenNext's
package-manager auto-detection prefers the bun lockfile. Fix: explicit
`buildCommand: "npx next build"` in `frontend/open-next.config.ts` (kept the upstream
lockfile — minimal diff). Debugging signature: any tool erroring with
`bun: command not found` in this repo is lockfile auto-detection, not a missing
dependency — check for a competing `bun.lock` before installing anything. Related
rule: never pipe a build through `tail`/`grep` when its exit code matters — the pipe
masked this failure as exit 0 on the first run.

### 2026-07-19 — Correction: bun.lock also hijacked deploy; lockfile deleted

The `buildCommand` override above proved insufficient: wrangler ≥4.9x "autoconfig"
detects an OpenNext project and silently delegates `wrangler deploy` to
`opennextjs-cloudflare deploy`, whose own packager detection again chose bun for the
wrangler invocation (`/bin/sh: bun: command not found`, even under plain
`npx wrangler deploy`). Fix: `frontend/bun.lock` deleted from the repo — two lockfiles
mean every packager auto-detection is a coin toss, and npm's `package-lock.json` is
this fork's canonical lockfile. Deviation from minimal-diff rule 8 recorded and
justified: the upstream file actively broke builds and deploys at two independent
layers; on upstream rebase, drop their copy again. Debugging signature: the wrangler
log line "OpenNext project detected, calling `opennextjs-cloudflare deploy`" means
your wrangler flags/env are NOT reaching wrangler — the wrapper re-invokes it.

### 2026-07-19 — Express 4 async handlers + Node 22: one unwrapped rejection kills the server

Trigger: first pilot user opened Account → API Keys and the whole production
backend died (`ERR_UNHANDLED_REJECTION`, Fly restarted it). Express 4 does NOT
catch rejections from `async` route handlers, and Node ≥15 terminates the process
on unhandled rejections by default — so any handler without its own try/catch
turns one transient DB hiccup into a full outage. `GET /user/api-keys` was such a
handler (upstream code). Fixes: try/catch in the handler AND process-level guards
in `index.ts` — `unhandledRejection` logs and continues (request-scoped), while
`uncaughtException` logs then exits for a clean Fly restart (post-throw state may
be corrupt; reviewer catch). Companion rule from the same review: a handler's
catch returns a FIXED generic `detail`; `errorMessage(err)` goes to
`console.error` only — the moment any frontend surfaces `detail` verbatim, raw DB
text reaches users. Rule: in this codebase every new async route handler wraps its
body in try/catch (or the route registers an error-forwarding wrapper); audit any
upstream route touched for the first time. Debugging signature: Fly logs showing
`UnhandledPromiseRejection ... reason "#<Object>"` followed by a machine restart
means an unwrapped async handler — the `#<Object>` is usually a Supabase error.
Secondary effect worth remembering: while the backend restarts, the frontend's
profile/status fetches fail silently and pages render their "nothing configured"
fallback — misleading UI during the outage window.

### 2026-07-21 — log-don't-die turns unwrapped handlers into hanging requests

Trigger: production Supabase lost the `service_role` grant on `user_api_keys`.
`GET /user/profile` (`backend/src/routes/user.ts`) awaited `getUserApiKeyStatus`
with NO try/catch, so it threw — and after the #22 `unhandledRejection` guard
(which logs and keeps the process alive), the throw no longer crashes the
server; instead the request simply NEVER RESPONDS. The frontend gate
(`MfaLoginGate`) blocks on `UserProfileContext`'s `loading` flag, which its
`getUserProfile()` call clears only in a `finally` — a fetch that never resolves
leaves `loading` true forever. Result: every pilot user saw an infinite login
spinner. The `unhandledRejection` guard converted a crash-and-restart into a
silent hang; "log, don't die" only degrades honestly if the handler still sends
a response.

Rule (now enforced by audit): EVERY async route handler wraps its body in
try/catch, or is registered through a wrapper that guarantees a response —
this fork uses `backend/src/lib/asyncHandler.ts` (self-responds with a fixed
generic 500 `detail` + `console.error` via `safeErrorLog`; mirrors the local
`asyncRoute` in `workflows.ts`). Complementary frontend rule: any loading gate
that blocks the UI on a fetch MUST also handle the failure path — time-box the
request (an `AbortController` timeout; 15s on the profile load) and render an
error+retry state, never an unbounded spinner and never a silent "all clear"
fallback that hides the outage.

Debugging signature: an infinite spinner in the browser with NO matching 4xx/5xx
in the network tab (the request is still pending), while Fly logs show
`[unhandledRejection]` entries carrying a Postgres error object — and, crucially,
NO machine restart (contrast the #22 signature, where `uncaughtException` exits
and Fly restarts). Supabase grant loss on `service_role` surfaces as Postgres
error `42501` ("permission denied for table …") with a GRANT hint; the fix is to
re-`GRANT` the needed privileges to `service_role`. Note `schema.sql`'s revokes
(≈792–823) only touch `anon`/`authenticated` (the browser-facing roles) — they
never revoke from `service_role`, so a lost `service_role` grant is external
drift, not something the schema did.

### 2026-07-22 — Angle-bracket placeholders in runnable snippets get pasted literally

Trigger: the owner pasted `<ORG_ID>` from FIRM_SETUP.md into the Supabase SQL
editor (Postgres `22P02: invalid input syntax for type uuid`), then into zsh —
where `<uuid>` is a *redirection*, failing with `zsh: no such file or
directory`. Rule: docs and chat instructions never use angle-bracket
placeholders inside runnable snippets. Prefer self-resolving SQL (CTE that
looks the value up); where hand-substitution is unavoidable, show a realistic
dummy value ("your value replaces this whole string") and say brackets must
not survive. Debugging signature: `22P02` on a quoted `<...>` literal, or
zsh "no such file or directory" naming your value = a placeholder survived.

### 2026-07-22 — Supabase SQL editor: UPDATE without RETURNING is ambiguous

Trigger: the admin-promotion UPDATE printed "Success. No rows returned",
indistinguishable from matching zero rows; the owner reasonably read it as
failure. Rule: every mutation snippet destined for the Supabase SQL editor
ends with `returning <columns that prove the change>` so success is visible
and countable.

### 2026-07-22 — user_profiles.user_id is uuid; event tables' user_id is text

Upstream schema: `user_profiles.user_id` is `uuid`, but `chats`,
`tabular_reviews`, `documents`, `workflows` carry `user_id` as `text`. Any
org-scoped aggregation or membership filter must resolve member uuids from
`user_profiles` first, then compare as lowercase uuid *strings* against the
event tables (PostgREST `.in()` on text). Never SQL-join across the types raw.
This was the WS8 plan's flagged "sharpest trap"; pinned by the usage-stats
cross-org exclusion tests.

### 2026-07-23 — Relative `cd` in chained/background shell commands

Trigger (twice): `cd backend && …` inside a compound/background command ran
from a cwd that was already `backend/`, failing with "no such file or
directory" — once silently skipping a verification step, once skipping a
deploy while the chain half-continued. Rule: in any chained, backgrounded, or
notification-driven shell command, `cd` only to ABSOLUTE paths (or prefix
tools with the absolute path); never assume the session cwd. Related, already
recorded 19/07: never pipe a command through `tail`/`grep` when its exit code
matters.
