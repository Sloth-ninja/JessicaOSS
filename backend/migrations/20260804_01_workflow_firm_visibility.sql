-- 20260804_01_workflow_firm_visibility.sql
-- Review templates (saved tabular schemas v1): firm-shared templates
-- (owner-authorised 05/08/2026, allowlist entry). A template is a
-- workflows row with type='tabular'; an owner flips visibility to 'firm'
-- (stamping organisation_id) and every member of that organisation can
-- then use it from the template picker and Templates page.
-- Additive only; zero behaviour change until the templates backend reads
-- these columns, and the seam degrades cleanly (42703/PGRST204-tolerant)
-- if this migration has not run. Orgless deployments see no change.
-- Spec: docs/TABULAR_TEMPLATES_SPEC.md.

alter table public.workflows
  add column if not exists visibility text not null default 'private',
  add column if not exists organisation_id uuid references public.organisations(id) on delete set null;

create index if not exists workflows_firm_visible_idx
  on public.workflows(organisation_id) where visibility = 'firm';

-- Visible success (Supabase SQL editor shows the last statement's result;
-- an UPDATE/DDL-only script would print an ambiguous "Success. No rows").
select
  count(*) as workflows_rows,
  count(*) filter (where visibility = 'firm') as firm_visible
from public.workflows;
