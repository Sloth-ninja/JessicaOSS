# JessicaOS — Pilot Deployment Guide

> Written for the private pilot at `jessicaoss.com` (owner decision, 8 July 2026):
> complete the product, deploy privately for a small group of Aria Grace Law
> solicitors, gather feedback, optimise, then public launch. This guide is
> **reviewed, not executed** — the authoring sandbox has no Docker daemon and
> no Cloudflare account, so nothing here has actually been deployed. Every
> claim about the current codebase was checked against the files cited below
> as of this writing; things that depend on infrastructure not present in this
> repo (a Cloudflare account, a chosen backend host, a production Supabase
> project) are marked as such, not asserted as working.

## 1. Architecture

- **Frontend** — Next.js app, deployed to **Cloudflare Workers** at the apex
  domain `jessicaoss.com`, via `@opennextjs/cloudflare`
  (`frontend/package.json` — `preview`/`deploy`/`upload` scripts run
  `opennextjs-cloudflare build` then the matching Cloudflare command;
  `frontend/open-next.config.ts` calls `defineCloudflareConfig()` with no
  overrides). **Gap found:** there is no `wrangler.toml` / `wrangler.jsonc`
  anywhere in the repo, so `wrangler` (a devDependency) has nothing to deploy
  against yet — see [§8](#8-decisions-needed-from-the-owner).
- **Backend** — Express API on a container host at `api.jessicaoss.com`
  (host TBD, see [§2](#2-backend-hosting-comparison)).
- **Database/Auth** — Supabase Postgres, a dedicated **production** project
  (not the dev one used so far).
- **Storage** — Cloudflare R2 (S3-compatible), per `backend/src/lib/storage.ts`.
- **Browser never talks to the database directly.** All client grants are
  revoked in `backend/schema.sql:760-780` (`revoke all on public.<table> from
  anon, authenticated;` for every application table) — the frontend only
  calls the backend over HTTPS, and Supabase Auth directly (for sign-in/JWTs),
  never Postgres directly with the anon key.

### CORS, proxy trust, HSTS (verified in `backend/src/index.ts`)

- CORS origin is `process.env.FRONTEND_URL` (falls back to
  `http://localhost:3000` for local dev) — set
  **`FRONTEND_URL=https://jessicaoss.com`** in production
  (`backend/src/index.ts:113-118`).
- `frontend/.env.local` / the Cloudflare Workers env must set
  **`NEXT_PUBLIC_API_BASE_URL=https://api.jessicaoss.com`**.
- `app.set("trust proxy", envInt("TRUST_PROXY_HOPS", 1))`
  (`backend/src/index.ts:91`) — defaults to trusting **one** hop. If the
  chosen host sits behind more than one reverse proxy in front of the Node
  process (e.g. platform edge + an internal load balancer), set
  `TRUST_PROXY_HOPS` accordingly, or rate limiting / client IP detection
  (`express-rate-limit` reads `req.ip`) will see the proxy's IP instead of the
  client's.
- HSTS is **conditional on `NODE_ENV`**: `hsts: isProduction ? { maxAge:
  15552000, includeSubDomains: true } : false` where `isProduction =
  process.env.NODE_ENV === "production"` (`backend/src/index.ts:17,103-108`).
  **`NODE_ENV=production` must be set on the backend host** or the pilot
  deployment silently runs without HSTS. `maxAge` is 180 days
  (15,552,000 seconds).

## 2. Backend hosting comparison

The binding requirement is **LibreOffice** for DOCX→PDF conversion
(`backend/src/lib/convert.ts` — `docxToPdf()` shells out to a `soffice`
binary via the `libreoffice-convert` npm package; `resolveSofficeBinaryPaths()`
looks for `SOFFICE_BINARY_PATH` / `LIBREOFFICE_BINARY_PATH` /
`LIBRE_OFFICE_EXE` env overrides, then `soffice`/`libreoffice` on `PATH`, then
a fixed list of common install paths). That rules out most pure Node
serverless platforms (no arbitrary binary install) — a **container image** is
the portable answer, which is what `backend/Dockerfile` (added by this
workstream) builds.

Note: the repo already contains `backend/nixpacks.toml` (`nixPkgs = ["...",
"libreoffice"]`) and `convert.ts`'s own error message says *"Ensure Railway
uses backend/nixpacks.toml"* — i.e. Railway (via Nixpacks, not Docker) was
already the implicit target before this workstream. The new `Dockerfile`
gives a second, platform-agnostic path; either is viable.

| Host | LibreOffice | Notes |
|---|---|---|
| **Fly.io** (suggested default) | Yes, via `backend/Dockerfile` | Containers are first-class; no persistent volume needed (all state is in Supabase/R2); simple `fly.toml` + `fly deploy`; good free/low tier for a small pilot. |
| **Railway** | Yes, via existing `backend/nixpacks.toml` (buildpack, no Dockerfile needed) **or** the new Dockerfile | Already has groundwork in this repo; Nixpacks build is simpler to set up than Docker if the team prefers not to touch the Dockerfile at all. |
| **Render** | Yes, via `backend/Dockerfile` (Render supports "Docker" as a service type) | Comparable to Fly.io; free tier has a cold-start sleep that would hurt pilot UX unless upgraded. |
| **Small VM** (e.g. a Hetzner/DigitalOcean droplet) | Yes, run the Dockerfile or install LibreOffice + Node directly | Most control, most ops burden (patching, TLS, process supervision) — only worth it if the team wants full control from day one. |

**Recommendation: Fly.io as the default**, kept as an explicit decision item
for the owner (see §8) since it has not been tested in this sandbox (no
Cloudflare/Fly.io accounts available here).

**Verify locally before trusting the image:**

```bash
docker build -t jessicaos-backend backend/
docker run --rm -p 3001:3001 --env-file backend/.env jessicaos-backend
```

(Not run in this sandbox — no Docker daemon available.)

## 3. Production Supabase checklist

- [ ] Create a **new** Supabase project dedicated to the pilot (do not reuse
  the dev/test project — CLAUDE.md and `docs/safe-local-testing.md` already
  say to use throwaway resources for dev; the pilot needs its own, separate
  "production" one).
- [ ] Apply `backend/schema.sql` in the SQL editor (it "already includes the
  latest database shape" per `README.md:33`) — this is a **fresh** database,
  so the full schema file is correct here (the incremental
  `backend/migrations/*.sql` path in the README is for upgrading an
  *existing* deployment, not for a first-time setup). There are currently 38
  dated files in `backend/migrations/`, most recently
  `20260706_remove_courtlistener.sql`; if the pilot project is provisioned
  from an older Mike/JessicaOS schema snapshot instead of the current
  `schema.sql`, apply migrations dated after that snapshot, in filename
  order.
- [ ] **Auth → disable public sign-up (invite-only).** In the Supabase
  dashboard this is under **Authentication → Sign In / Providers → Email**
  as an "Allow new users to sign up" toggle — **verify the exact current
  wording in your project's dashboard before relying on this document**, as
  Supabase has renamed/relocated this setting before and it was not possible
  to verify the live dashboard from this sandbox. With sign-up disabled, add
  each pilot solicitor via **Authentication → Users → Invite user** (sends a
  Supabase-templated invite email with a magic sign-in link).
- [ ] **Custom SMTP.** The built-in Supabase mailer is rate-limited and
  unsuitable for anything beyond local dev (`README.md:112` already flags
  this for confirmation emails). Configure custom SMTP under **Project
  Settings → Auth → SMTP Settings** so invite emails and any password-reset
  mail land reliably.
- [ ] **TOTP MFA.** The app has a per-user `mfa_on_login` profile flag
  (`backend/migrations/20260610_02_user_profile_mfa_on_login.sql`) and
  CLAUDE.md documents TOTP MFA as a client-side Supabase Auth feature. Confirm
  MFA (TOTP) is enabled at the project level under **Authentication →
  Providers → Auth MFA** so pilot users who opt in can actually enrol.
- [ ] Record the project's Supabase URL, anon/publishable key, and
  service-role key for the env matrix below (service-role key is
  backend-only — never in `frontend/`).

## 4. R2 (object storage)

- Create a dedicated Cloudflare R2 bucket for the pilot (do not reuse a dev
  bucket).
- Generate R2 API tokens (access key ID / secret) scoped to that bucket only.
- Set `R2_BUCKET_NAME` explicitly — the code defaults to `"mike"`
  (`backend/src/lib/storage.ts:40`: `process.env.R2_BUCKET_NAME ?? "mike"`)
  if unset, which is fine to keep or rename, but should be a deliberate
  choice rather than an accident for a named pilot deployment.
- `R2_ENDPOINT_URL` is the account-specific R2 S3 endpoint
  (`https://<account-id>.r2.cloudflarestorage.com`).

## 5. Environment variable matrix

All values below are placeholders. Never commit real values — `.env`,
`.env.*` (except the checked-in `.env.example` / `.env.local.example`
templates) must never be created, read, or edited by an agent per CLAUDE.md
hard rule 2; this table only documents names and example shapes.

### Backend (`backend/.env` on the host — mirrors `backend/.env.example`)

| Var | Pilot value | Status |
|---|---|---|
| `PORT` | `3001` (or whatever the host assigns) | required |
| `NODE_ENV` | `production` | required — turns on HSTS (§1) |
| `FRONTEND_URL` | `https://jessicaoss.com` | required — CORS origin |
| `TRUST_PROXY_HOPS` | host-dependent, default `1` | verify against chosen host's proxy topology |
| `DOWNLOAD_SIGNING_SECRET` | fresh `openssl rand -hex 32`, distinct from any dev value | required |
| `SUPABASE_URL` | pilot project URL | required |
| `SUPABASE_SECRET_KEY` | pilot project service-role key | required |
| `R2_ENDPOINT_URL` | pilot R2 endpoint | required for uploads |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | pilot R2 credentials | required for uploads |
| `R2_BUCKET_NAME` | pilot bucket name | optional, default `mike` — set explicitly (§4) |
| `USER_API_KEYS_ENCRYPTION_SECRET` | fresh long random secret | required |
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` | provider keys, if the pilot is to have a working default model without every solicitor bringing their own key | optional (BYO-key model still applies per user) |
| `OPENROUTER_API_KEY` | as above | optional |
| `RESEND_API_KEY` | in `.env.example`; SDK installed but currently unused in `src/` (per CLAUDE.md env registry) | optional, no functional effect yet |
| `RATE_LIMIT_*` (11 vars, `backend/src/index.ts:52-84`) | defaults are reasonable for a small pilot; only override if the pilot group hits limits | optional |
| `MCP_OAUTH_CLIENT_ID` / `MCP_OAUTH_CLIENT_SECRET` / `MCP_OAUTH_DEFAULT_SCOPE` / `MCP_CONNECTORS_ENCRYPTION_SECRET` | only if MCP connectors are offered to pilot users | optional |
| `API_PUBLIC_URL` / `BACKEND_URL` | `https://api.jessicaoss.com`, needed for MCP OAuth callback base if connectors are enabled | optional |
| `LOG_RAW_LLM_STREAM` / `RAW_LLM_STREAM_LOG_DIR` | leave unset in production (dev-only stream logging) | optional, dev-only |
| `COMPANIES_HOUSE_API_KEY` | **planned, not yet merged** — WS1 lands this; add once that PR merges | planned |
| `LOCAL_LLM_BASE_URL` / `LOCAL_LLM_MODELS` / `LOCAL_LLM_API_KEY` (or the `OPENAI_BASE_URL` alias) | **planned, not yet merged** — WS3 lands this; per `docs/MIGRATION_SPEC.md` §5, local/open-weights mode is a data-sovereignty feature, not a cost one, and should stay **off** in the hosted pilot (solicitors are using the hosted service; there is no "local machine" for these vars to point at) | planned, recommend leaving unset for the pilot |

`COURTLISTENER_API_TOKEN` / `COURTLISTENER_BULK_DATA_ENABLED` no longer
apply — CourtListener was excised (`docs/BUILD_LOG.md`, 2026-07-07 entry);
they are absent from the current `backend/.env.example` and should stay
absent here.

### Frontend (Cloudflare Workers environment vars — mirrors `frontend/.env.local.example`)

| Var | Pilot value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | pilot Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | pilot project anon/publishable key |
| `NEXT_PUBLIC_API_BASE_URL` | `https://api.jessicaoss.com` |

No secrets belong in the frontend — only `NEXT_PUBLIC_`-prefixed values, all
of which are safe to expose to the browser (per `docs/safe-local-testing.md`).

## 6. DNS

- **`jessicaoss.com` (apex)** → Cloudflare Workers route for the Next.js app.
  Cloudflare-proxied by definition (Workers routes run on Cloudflare's edge).
- **`api.jessicaoss.com`** → CNAME/A record to the chosen backend host
  (Fly.io/Railway/Render/VM — see §2). Proxy through Cloudflare (orange
  cloud) where the host supports it, for TLS termination and DDoS protection
  in front of the origin; some platforms (e.g. Fly.io's own edge/anycast)
  may prefer being reached directly (grey cloud) — check the chosen host's
  guidance before proxying.
- Both records need TLS. Cloudflare Workers routes get certificates
  automatically; `api.jessicaoss.com` needs a certificate either from
  Cloudflare (if proxied) or from the backend host (Let's Encrypt via the
  platform, or the platform's built-in TLS).

## 7. Smoke checklist (run after every deploy)

- [ ] `GET https://api.jessicaoss.com/health` → `{"ok":true}`
  (`backend/src/index.ts:157`).
- [ ] Sign in as an invited pilot user at `https://jessicaoss.com`.
- [ ] Upload a document (synthetic/public only per §8 and `docs/PILOT.md`)
  and download it back.
- [ ] One Companies House lookup (once WS1 has merged and
  `COMPANIES_HOUSE_API_KEY` is set) against a known company number.
- [ ] One legislation.gov.uk lookup (once WS2 has merged).
- [ ] Generate a DOCX via a workflow and confirm the DOCX→PDF conversion
  succeeds (exercises the LibreOffice/`soffice` install in the container —
  this is the one smoke check that specifically validates the Dockerfile's
  apt-installed `libreoffice-writer`, not just app code).

## 8. Decisions needed from the owner

1. **Backend host.** Fly.io is recommended (§2) but not chosen yet; Railway
   already has partial groundwork (`backend/nixpacks.toml`) and is a
   reasonable alternative if the team prefers to avoid Docker entirely for
   now.
2. **Cloudflare Workers deploy config is missing.** No `wrangler.toml` /
   `wrangler.jsonc` exists anywhere in the repo, so `npm run deploy --prefix
   frontend` (which runs `opennextjs-cloudflare build && opennextjs-cloudflare
   deploy`) cannot succeed as-is. Someone with Cloudflare account access
   needs to create the wrangler config (account ID, Workers project name,
   custom domain route for `jessicaoss.com`, compatibility date) — out of
   scope for this docs-only workstream since it requires live Cloudflare
   account details this sandbox does not have.
3. **Real client documents vs synthetic-only.** Default recommendation:
   **synthetic-only** until a data-protection/data-flow review has happened
   with the supervising solicitor — see `docs/PILOT.md` and the existing
   `docs/safe-local-testing.md` for the reasoning (storage, logging,
   deletion, and model-provider data flows have not been audited for live
   client data yet). This is a data-protection decision for the owner and
   the supervising solicitor to take together, not a default this workstream
   can set unilaterally.
4. **Pilot user list and invite emails.** Who at Aria Grace Law gets
   invited, and when (see `docs/PILOT.md` for the invite mechanism).
5. **Error monitoring.** None is wired up today. Sentry (or an equivalent)
   is an option but would add a new dependency (CLAUDE.md hard rule 7
   requires stating why any new dependency is needed in the PR that adds
   it) — worth deciding before or shortly after the pilot starts, not
   silently added here.
