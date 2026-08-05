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
- 2026-07-27 — Fail-open vs fail-safe is a per-operation choice; deletes fail SAFE
- 2026-07-28 — CH document proxy: parse+exact-host allowlist (not startsWith); fetch drops Authorization on cross-origin 302; stream-cap the body
- 2026-07-28 — `prettier --write` with no resolvable config reformats 4-space frontend files to 2-space wholesale — an unmergeable diff
- 2026-07-28 — Soft-delete (tombstone) and access checks must compose: gate at the shared choke point, not per-route
- 2026-08-03 — Continuous-refill rate-limit buckets make tests timing-flaky when the code does real CPU work between calls — freeze the clock
- 2026-08-05 — Suites doing real KDF (scrypt) work need explicit generous timeouts; a timeout flake that passes in isolation is contention, not a defect
- 2026-08-05 — Missing-column degrades: filters raise Postgres 42703, but UPDATE payloads raise PostgREST PGRST204 — cover both

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

### 2026-07-27 (WS8 PR G) — Fail-open vs fail-safe is a per-operation choice

Trigger: WS8 PR B's `requireMemberPolicy` deliberately FAILS OPEN on an
org-lookup error (calls `next()` as if the policy were ON) — availability beats
a brief policy gap when the worst case is a blocked key write. WS8 PR G reuses
the SAME org lookup to decide tombstone-vs-hard-delete, but copying the
fail-open direction there would hard-delete a member's data on a transient DB
hiccup — irreversible loss. Rule: the safe default on an infra error depends on
what the operation does. For anything DESTRUCTIVE, fail SAFE toward the
reversible outcome (`resolveDeletionMode` tombstones on lookup error, since a
tombstone can be restored and a hard delete cannot); for read/availability
gates, fail open. Never mechanically mirror a sibling seam's failure direction —
re-derive it from the blast radius. (Same lesson in miniature: `getTombstonedIds`
read-exclusion degrades to "show everything" on error — a member seeing their
own soon-to-be-purged row is low-harm, so there availability wins.)

Second gotcha from the same PR: adding a new named export to a lib that other
route tests `vi.mock(...)` breaks those suites at IMPORT time ("No X export is
defined on the mock") the moment any transitively-imported module statically
imports the new symbol — even if the test never exercises it. When you add an
export to a mocked module (`userDataCleanup` here), grep for every
`vi.mock("…/thatModule"` and add the new name to each factory. Debugging
signature: a whole test FILE fails to load with "No <newExport> export is
defined on the … mock", not an assertion failure.

### 2026-07-28 — Companies House document proxy: two load-bearing facts

Trigger: building the filing-document view/download path (transaction →
Document API metadata → signed content URL). Two things the whole design leans
on:

- **`fetch` (undici/Node 22) strips the `Authorization` header when it follows
  a cross-origin redirect.** CH's `/content` endpoint 302s to a *pre-signed*
  S3 URL on a different host; because the redirect is cross-origin, our Basic
  auth header is dropped automatically, so the API key never reaches S3 (and
  the signed URL already carries its own auth). This is why `redirect: "follow"`
  is safe here — but it means you must NOT assume the header survives a redirect
  when you *do* need it. Rule: for any authenticated fetch that may redirect,
  know whether the hop is same- or cross-origin; never rely on Authorization
  persisting across a cross-origin 302.
- **Host-check any URL you take from an upstream JSON body before fetching it
  with credentials attached — by PARSING it, never by `startsWith`.**
  `links.document_metadata` / `links.document` come from CH's own response, but
  a tampered/unexpected value would otherwise send an authenticated request
  (with the API key on it) wherever it points — key exfiltration + an SSRF
  primitive. **A string `startsWith(base)` guard is broken:** two shapes slip
  past a prefix match on `https://document-api.company-information.service.gov.uk` —
  the **suffix-domain** spoof
  `https://document-api.company-information.service.gov.uk.evil.com/…` (the real
  base is a literal prefix of an attacker-owned domain) and the **userinfo**
  trick `https://document-api.company-information.service.gov.uk@evil.com/…`
  (everything before `@` is credentials; the real host is `evil.com`). Correct
  guard: `new URL(u)` then require `url.protocol === "https:" && url.host ===
  "<exact host>"` (equality, not prefix; `.host` includes any port and excludes
  userinfo). Reject anything else — here as "no document" (404). This first
  shipped in this PR with the flawed `startsWith` and was caught in review;
  fixed before merge. Debugging signature: any allowlist/SSRF check that
  compares a URL as a raw string (`startsWith`/`includes`/regex on the whole
  URL) rather than parsing and comparing `.host` is bypassable — audit it.
  Corollary: enforce size caps by **streaming with a running byte counter and
  aborting** (`AbortController` + read the body reader), not by
  `arrayBuffer()`-then-check — a lying/absent `Content-Length` or a chunked
  response defeats a post-hoc check; and never echo an upstream `Content-Type`
  back with `Content-Disposition: inline` — allowlist (`application/pdf`,
  `application/octet-stream`) and force anything else to a download-only
  octet-stream so a browser can't render tampered content inline.

Complementary product bug from the same work: the PSC `ceased_on` field existed
on the frontend type but was **never read** by the renderer, so ceased PSCs
displayed as current. Inverse of the 19/07 "a column existing is not a reason to
surface it" lesson — here the field was fetched and typed but the behaviour was
never wired. When a raw API field encodes a lifecycle status (ceased/resigned/
revoked), rendering the record without it is a correctness bug, not a cosmetic
one.

### 2026-07-28 — `prettier --write` with no resolvable config reformats the frontend wholesale

Trigger: on the `company-search-saves` branch I ran `npx prettier --write` over
changed frontend files to satisfy the "prettier clean" definition-of-done line.
The frontend (`frontend/`) is authored in **4-space** indentation and its
formatting is enforced by **ESLint** (`npm run lint`), NOT by a standalone
prettier config — there is no `.prettierrc` and no `prettier` key in
`frontend/package.json`. So `prettier --write` fell back to its **default
2-space** style and rewrote `page.tsx` / `mikeApi.ts` end-to-end (≈1000-line
diffs on ~700-line files). It passed local checks (ESLint doesn't police
indent width), but when `origin/main` moved, the 2-space files could not merge
against the 4-space upstream — every line was a conflict.

Rule: **do not run `prettier --write` on frontend files.** Frontend formatting
is ESLint's job; run `npm run lint` (or `eslint --fix`) instead. Only run
prettier where a project actually defines a config — backend has none either
(the `"prettier": "^3.x"` in `backend/package.json` is the devDependency, not a
config block), so backend relies on its files already being 2-space and you
only hand-match that style in new code. Debugging signature: a changed
frontend file shows a diff far larger than your edit, with `-    ` / `+  `
(4→2 space) churn on lines you never touched; or a routine merge explodes into
whole-file conflicts right after a "format" step. Recovery: `git checkout
origin/main -- <file>` to restore the upstream 4-space version, then re-apply
only your semantic edits by hand.

### 2026-07-28 — Soft-delete (tombstone) and access checks must compose at the choke point

Trigger: WS8 deletion governance tombstones a row by setting `deleted_at` only
(the row stays in its table for the retention window); WS9 firm visibility lets
any firm member reach a matter/review through `checkProjectAccess` /
`ensureReviewAccess`. These two seams shipped in separate trains and were never
composed: the shared access helpers did NOT consult the tombstone, so only the
per-route DETAIL guards (which each re-checked `getTombstonedIds` after the access
call) hid a soft-deleted item. Every CONTENT sub-route (documents/chats/people/
upload; tabular generate/chat/…) trusted the helper alone, so a firm member with a
stale id could read — and via the write paths, mutate — a soft-deleted item for the
whole retention window.

Rule: when a lifecycle flag (tombstone, archived, suspended) must hide a resource,
enforce it INSIDE the shared access predicate/helper, not in each route. A guard
that lives in "the routes that happened to remember" is a guard that a new route
silently omits. Corollary: after folding it in, confirm the reverse — the admin/
system paths that MUST still see the hidden rows (restore, expedite, pending-list,
purge sweep) do not route through that helper; here they query the tables directly
with member scope, so they were unaffected. Debugging signature: a detail/GET route
404s a deleted item but a sibling sub-route (`/:id/documents`, `/:id/generate`)
returns 200/streams for the same id; grep shows the sub-routes calling the access
helper but never `getTombstonedIds`.

### 2026-07-28 — Shell cwd drift into a worktree silently updates the wrong refs

Trigger: after inspecting a crashed builder's worktree with `cd <worktree> &&
git status`, the session shell's cwd stayed in that worktree. Subsequent
chained `gh pr merge … && git pull` commands then fast-forwarded the
WORKTREE's branch while the main checkout's `main` fell 4 commits behind —
and a composed-range review workflow diffed `<base>...main` against the stale
ref, reviewing only a third of the train. The invalid run surfaced as an
adversarial verifier "refuting" a real finding on the grounds that the code
"was not in the range". Rules: (1) ref-affecting git commands always name
their checkout explicitly (`git -C /abs/path/to/main-checkout …`) — never
rely on the session cwd, which persists across turns and outlives worktree
inspections; (2) composed-range reviews pin BOTH ends of the range to SHAs
(`<base-sha>...<head-sha>`), never a local branch name, and reviewers verify
the head SHA matches origin before starting. Debugging signature: a verifier
claiming reviewed code does not exist on `main`, or `git pull` output
"Updating <sha>.." where `<sha>` is a feature-branch head, means the command
ran in the wrong checkout — check `git worktree list` and your cwd.

### 2026-08-03 (Clio connector) — Continuous-refill rate-limit buckets need a frozen clock in tests

Trigger: the Clio client's Grow limiter (`TokenBucket`, capacity 3 /
`refillIntervalMs` 1000ms, continuous proportional refill — `lib/rateLimit.ts`)
has a test that fires 4 requests and expects the 4th to be refused. It passed in
isolation but FLAKED under the full-suite run: each `clioRequest` decrypts the
stored token with `scrypt` (real CPU, ~300-500ms), so enough wall-clock elapsed
between the awaited calls for the bucket to refill a token — the 4th call
succeeded and the assertion failed. The refill is time-proportional, so any
real-time gap between acquisitions (CPU work, other suites contending for the
thread) silently tops the bucket back up.

Rule: when unit-testing a continuous-refill limiter, FREEZE the clock
(`vi.useFakeTimers()`) and reconstruct the limiter under the frozen clock, so
`Date.now()` is constant and elapsed-time refill is exactly zero between calls —
then the "N succeed, N+1 refused" invariant is deterministic. (Reset the
limiter's module state AFTER installing fake timers, since its constructor
samples `Date.now()` for `lastRefill`.) Do NOT try to make it pass by spacing
calls or widening the window — that just moves the flake. Debugging signature: a
bucket-exhaustion test that passes alone but fails in the full suite, or whose
pass/fail flips with unrelated CPU load, means the bucket refilled on wall-clock
between acquisitions.

### 2026-08-04 (OAuth callback base) — Env-derived callback bases silently degrade to a dev localhost fallback in production

Trigger (incident 03/08/2026): the deployed backend minted Clio authorize URLs
with `redirect_uri=http://127.0.0.1:3001/clio/oauth/callback` because neither
`API_PUBLIC_URL` nor `BACKEND_URL` was set on Fly, so `clioBackendBaseUrl()`
(config.ts) fell through to its dev literal. Clio accepted the consent (that
redirect variant is registered for dev), then redirected the solicitor's browser
to 127.0.0.1:3001 — her own machine — where nothing was listening. The failure
was invisible to every deploy check we run: `/`, `/health`, and the connectors
status page all returned 200 because the wrong host only appears INSIDE the
authorize URL's query string, and only a real consent round-trip from a non-dev
machine exercises it. Fixed operationally by setting `API_PUBLIC_URL` on Fly, then
hardened in code.

Rule: a callback/redirect base that reads `PROCESS_ENV || PROCESS_ENV || <dev
literal>` MUST fail CLOSED in production when it lands on the dev literal — do not
mint the URL. Here `clioConfigured()` now returns false (same state as missing
client credentials) when `NODE_ENV === 'production'` and the resolved base is the
127.0.0.1 fallback, so the start route returns the fixed "not configured" error
and a redacted log fires once per boot naming `API_PUBLIC_URL`. Corollary for
deploy verification: OAuth features cannot be signed off by hitting routes or
status pages — they need ONE real authorise→callback round-trip from a machine
that is NOT the backend host, because redirect-URI wrongness is only observable in
the provider handshake. Not every same-shaped fallback is equally dangerous: the
MCP interactive authorize redirect derives its base from the request `Host` header
(`routes/user.ts backendPublicUrl`), so on Fly it resolves to the real inbound
host, not 127.0.0.1 — a different fallback class, left unchanged. (The MCP
token-refresh helper `mcpOAuthCallbackUrl()` does keep the localhost literal, but
it is only reached in the non-interactive refresh path and is covered by
`API_PUBLIC_URL` now being required in production.) Debugging signature: consent
SUCCEEDS at the provider, then the browser lands on ERR_CONNECTION_REFUSED at
`127.0.0.1:3001` (or `localhost:<PORT>`); decode the authorize URL and its
`redirect_uri` names the wrong host — grep the derivation for a bare `||
"http://127.0.0.1..."` / `|| \`http://localhost:${PORT}\`` fallback with no
production guard.

### 2026-08-05 — Real-KDF test suites need explicit generous timeouts under agent load

Trigger: Stop-hook and full-suite runs flaked twice in one day on the
scrypt-heavy suites (`userApiKeys.test.ts` once; `organisationApiKeys.test.ts`
+ `clio/connections.test.ts` together) with 5s/20s timeouts — every failing
test passed in isolation. The machine was running concurrent builder-agent
test loads; real scrypt key derivation is CPU-bound, so wall-clock contention
stretches each derivation unpredictably and no "reasonable" ceiling is safe.

Rule: any suite doing real KDF/crypto work (scrypt AES-256-GCM here) sets an
explicit, generous per-file timeout (`vi.setConfig({ testTimeout: 120_000 })`)
— never weaken the crypto parameters to make tests fast, and never chase the
flake by nudging the ceiling up 2x at a time. A timeout failure in such a
suite that passes standalone is CONTENTION, not a defect: do not "fix" the
code. Watch for per-test timeout arguments (`it(..., 20_000)`) silently
overriding a higher file-level ceiling — the per-test value wins in vitest.
Debugging signature: timed-out tests concentrated in files doing scrypt/crypto
work, green when run standalone, while the machine runs parallel agent suites
or builds.

### 2026-08-05 (Review templates) — 42703 is not the only "missing column" code: UPDATE payloads surface PGRST204

Trigger: PR #74 review. The templates seam degraded firm sharing on an
unmigrated database via the usual `code === "42703" || code === "42P01"`
check — but that only covers a missing column referenced in a FILTER
(`.eq("visibility", …)`), where PostgREST forwards Postgres's
undefined_column error. When the missing column appears in an **UPDATE
payload** (`.update({ visibility: … })`), PostgREST validates the payload keys
against its own schema cache and rejects the request as **`PGRST204`
("Could not find the '<col>' column ... in the schema cache")** before
Postgres ever sees it. So `setTemplateVisibility` / `adminRevertTemplate`
would have 500'd instead of degrading on every pre-migration database — a
LIVE path here, since migration `20260804_01` had not run anywhere yet.

Rule: a "missing table/column" degrade check on a supabase-js write must
accept all three codes — `42703`, `42P01`, **and `PGRST204`** — whenever the
missing column can appear in the write payload (filters alone are fine with
the Postgres pair). Note `lib/firmVisibility.ts` (`isMissingColumnOrTable`,
~lines 40-44) shares the two-code idiom on its visibility updates; its
migration (`20260728_02`) has run in production so it is not live-broken —
flagged as a follow-up hardening, deliberately not changed in PR #74.
Debugging signature: an "unmigrated DB" code path that works for reads/lists
but 500s on the flip/write, with logs showing `PGRST204` and a message naming
the column and "schema cache", means the degrade check only knows the
Postgres codes. Also remember PostgREST schema-cache staleness has the
inverse failure: the column EXISTS in Postgres but PGRST204 still fires until
the cache reloads (`NOTIFY pgrst, 'reload schema'` / project restart).

