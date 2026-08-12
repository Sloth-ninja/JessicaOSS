-- 20260807_01_matter_workspace_links.sql
-- Practice Management (Clio-backed Matters, spec docs/PRACTICE_MANAGEMENT_SPEC.md):
-- the ONLY stored Clio artefact — the id/number pair anchoring a JessicaOS
-- workspace (a `projects` row) to a live Clio matter. Everything else
-- (financials, contacts, activities, documents) is read LIVE from Clio with
-- the caller's own token; JessicaOS keeps no database copy of matter data.
-- Owner-authorised (allowlist entry 12/08/2026, .claude/hooks/authorized-migrations.json).
-- Additive only; zero behaviour change until this runs — the seam
-- (lib/clio/mattersSurface.ts, plus userDataCleanup.ts / userDataExport.ts)
-- is already PGRST205/42P01-tolerant against the missing table today, so
-- link reads/writes simply keep degrading to "unsupported" until this lands.

create table if not exists public.matter_workspace_links (
  id uuid primary key default gen_random_uuid(),
  -- LOAD-BEARING: `on delete cascade` is required by the WS8
  -- deletion-governance purge path (lib/deletionGovernance.ts) — when a
  -- purged (hard-deleted) project row goes, its link row must go with it.
  -- Do not weaken this to `set null`/`restrict`: either would leave an
  -- orphaned link (or block the purge) once a linked workspace is purged.
  project_id uuid not null references public.projects(id) on delete cascade,
  clio_matter_id text not null,
  clio_display_number text,
  organisation_id uuid references public.organisations(id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique(project_id)
);

create index if not exists idx_matter_links_matter
  on public.matter_workspace_links(clio_matter_id);

alter table public.matter_workspace_links enable row level security;

-- Browser roles never touch backend tables (schema.sql convention).
revoke all on table public.matter_workspace_links from anon, authenticated;

-- Visible success (Supabase SQL editor shows the last statement's result;
-- a DDL-only script would print an ambiguous "Success. No rows"). Zero rows
-- is expected and fine here — the point is the statement errors if the
-- table does not exist.
select count(*) as matter_workspace_links_rows
from public.matter_workspace_links;
