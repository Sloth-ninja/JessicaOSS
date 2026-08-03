-- 20260803_01_clio_connections.sql
-- Clio connector (owner-authorised 03/08/2026, allowlist entry): per-user
-- encrypted OAuth tokens for Clio Manage and Clio Grow (separate products,
-- separate token sets — one row per user per product). AES-256-GCM column
-- triplets mirror the user_mcp_oauth_tokens precedent. Grow refresh tokens
-- rotate on every use, so updates must be persisted atomically by the app.
-- Additive only; zero behaviour change until the connector code lands.

create table if not exists public.user_clio_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null check (product in ('manage', 'grow')),
  encrypted_access_token text,
  access_token_iv text,
  access_token_tag text,
  encrypted_refresh_token text,
  refresh_token_iv text,
  refresh_token_tag text,
  token_expires_at timestamptz,
  scope text,
  clio_user_id text,
  clio_user_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, product)
);

create index if not exists idx_user_clio_connections_user
  on public.user_clio_connections(user_id);

alter table public.user_clio_connections enable row level security;

-- Browser roles never touch backend tables (schema.sql convention).
revoke all on table public.user_clio_connections from anon, authenticated;
