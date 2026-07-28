-- 20260728_01_company_search_saves.sql
-- Company search: starred companies + recent searches (owner-authorised
-- 28/07/2026, allowlist entry). One per-user table, hidden_workflows
-- precedent (user_id is text, matching the event tables). Additive only;
-- zero behaviour change until the application code lands.

create table if not exists public.company_search_saves (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  company_number text not null,
  company_name text not null,
  company_status text,
  starred boolean not null default false,
  last_viewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(user_id, company_number)
);

create index if not exists idx_company_search_saves_user_viewed
  on public.company_search_saves(user_id, last_viewed_at desc);

alter table public.company_search_saves enable row level security;

-- Browser roles never touch backend tables (schema.sql convention).
revoke all on table public.company_search_saves from anon, authenticated;
