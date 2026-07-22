-- Migration date: 2026-07-21

-- Migration: firm administration foundation (WS8 PR A).
-- Introduces organisations (firms), an admin/member role on user_profiles, and
-- firm-level (shared) provider API keys. Additive only — self-hosters with no
-- organisation keep their existing per-user behaviour everywhere; the columns
-- default so an unmigrated or orgless deployment is unaffected.
--
-- No pilot/firm data is seeded here. Creating the pilot organisation, promoting
-- the admin, and backfilling existing profiles is a one-off operator step run
-- against production Supabase — see docs/FIRM_SETUP.md.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Organisations (firms)
-- ---------------------------------------------------------------------------

create table if not exists public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- Policy flags (admins toggle these later in PR C). Default-closed: members
  -- may not use their own provider keys or MCP connectors unless the firm
  -- opts in. enabled_connector_ids is a jsonb array of connector ids the firm
  -- has enabled for its members.
  allow_member_api_keys boolean not null default false,
  allow_member_mcp_connectors boolean not null default false,
  enabled_connector_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.organisations enable row level security;

-- ---------------------------------------------------------------------------
-- Organisation membership + role on user_profiles
-- ---------------------------------------------------------------------------

-- A profile belongs to at most one organisation. on delete set null so removing
-- a firm degrades its members to orgless rather than deleting their accounts.
alter table public.user_profiles
  add column if not exists organisation_id uuid
    references public.organisations(id) on delete set null;

alter table public.user_profiles
  add column if not exists role text not null default 'member'
    check (role in ('admin', 'member'));

create index if not exists idx_user_profiles_organisation
  on public.user_profiles(organisation_id);

-- ---------------------------------------------------------------------------
-- Organisation (firm-level, shared) provider API keys
-- ---------------------------------------------------------------------------

-- Encrypted with the same AES-256-GCM scheme as user_api_keys. Consumed by a
-- later PR; created here so the schema foundation is complete.
create table if not exists public.organisation_api_keys (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null
    references public.organisations(id) on delete cascade,
  provider text not null
    check (provider in ('claude', 'gemini', 'openai', 'openrouter', 'companies_house')),
  encrypted_key text not null,
  iv text not null,
  auth_tag text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organisation_id, provider)
);

create index if not exists idx_organisation_api_keys_organisation
  on public.organisation_api_keys(organisation_id);

alter table public.organisation_api_keys enable row level security;

-- ---------------------------------------------------------------------------
-- Direct client grant hardening (schema.sql grant posture, DURABLE_LESSONS)
-- ---------------------------------------------------------------------------
--
-- These are backend-owned tables reached only through the API with the service
-- role after the backend verifies the user's JWT. The browser's anon /
-- authenticated roles get no direct privileges. service_role is unaffected.

revoke all on public.organisations from anon, authenticated;
revoke all on public.organisation_api_keys from anon, authenticated;
