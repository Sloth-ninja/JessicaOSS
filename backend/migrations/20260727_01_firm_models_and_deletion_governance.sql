-- 20260727_01_firm_models_and_deletion_governance.sql
-- One bundled migration for WS8 PR F (firm model preferences) and PR G
-- (deletion governance). Owner-authorised 27/07/2026 (allowlist entry).
-- Additive only, everything defaulted: zero behaviour change until the
-- application code lands.

-- ---------- PR F: firm model preferences ----------
-- Third policy toggle + firm model configuration (default model, offered
-- providers), shaped like the existing policy flags on organisations.
alter table public.organisations
  add column if not exists allow_member_model_prefs boolean not null default false,
  add column if not exists model_config jsonb not null default '{}'::jsonb;

-- ---------- PR G: deletion governance ----------
-- Per-firm retention window for soft-deleted items (days).
alter table public.organisations
  add column if not exists retention_days integer not null default 30;

-- Tombstone columns on the five member-owned tables, mirroring the
-- document_versions soft-delete precedent (deleted_at/deleted_by, no FK on
-- deleted_by, partial indexes for the purge sweep).
alter table public.projects
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;
alter table public.documents
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;
alter table public.chats
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;
alter table public.tabular_reviews
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;
alter table public.workflows
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;

create index if not exists projects_pending_purge_idx
  on public.projects(deleted_at) where deleted_at is not null;
create index if not exists documents_pending_purge_idx
  on public.documents(deleted_at) where deleted_at is not null;
create index if not exists chats_pending_purge_idx
  on public.chats(deleted_at) where deleted_at is not null;
create index if not exists tabular_reviews_pending_purge_idx
  on public.tabular_reviews(deleted_at) where deleted_at is not null;
create index if not exists workflows_pending_purge_idx
  on public.workflows(deleted_at) where deleted_at is not null;

-- Append-only audit trail (seed of the general admin audit log).
-- Mirrors user_mcp_tool_audit_logs: service-role only, best-effort inserts.
create table if not exists public.deletion_audit_logs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  actor_user_id uuid not null,
  action text not null check (action in ('requested', 'restored', 'expedited', 'purged', 'exported')),
  resource_type text not null,
  resource_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists deletion_audit_logs_org_created_idx
  on public.deletion_audit_logs(organisation_id, created_at desc);

alter table public.deletion_audit_logs enable row level security;

-- Browser roles never touch backend tables (schema.sql convention).
revoke all on table public.deletion_audit_logs from anon, authenticated;
