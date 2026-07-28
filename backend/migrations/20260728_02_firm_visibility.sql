-- 20260728_02_firm_visibility.sql
-- WS9: matter permissions + firm library (owner-authorised 28/07/2026,
-- allowlist entry). Firm-visible matters/tabular reviews: an owner flips
-- visibility to 'firm' (stamping organisation_id); every member of that
-- organisation can then read the item through the normal access paths.
-- Additive + function recreation only; orgless deployments see no change
-- (the new predicate branches require a non-null caller org id).

-- ---------- Columns ----------
-- projects.visibility already exists (default 'private'; previously unused).
-- App-enforced values: 'private' | 'firm'. No DB check constraint (additive
-- safety; the column may carry legacy values on long-lived installs).
alter table public.projects
  add column if not exists organisation_id uuid references public.organisations(id) on delete set null;

alter table public.tabular_reviews
  add column if not exists visibility text not null default 'private',
  add column if not exists organisation_id uuid references public.organisations(id) on delete set null;

create index if not exists projects_firm_visible_idx
  on public.projects(organisation_id) where visibility = 'firm';
create index if not exists tabular_reviews_firm_visible_idx
  on public.tabular_reviews(organisation_id) where visibility = 'firm';

-- ---------- Audit actions ----------
-- deletion_audit_logs is the seed of the general admin audit log (WS8 PR G);
-- firm-visibility flips are recorded there.
alter table public.deletion_audit_logs
  drop constraint if exists deletion_audit_logs_action_check;
alter table public.deletion_audit_logs
  add constraint deletion_audit_logs_action_check
  check (action in ('requested', 'restored', 'expedited', 'purged', 'exported', 'firm_shared', 'firm_reverted'));

-- ---------- Overview functions ----------
-- Both gain p_user_org_id uuid default null (null => no firm branch, so
-- existing callers and orgless users behave exactly as before) and return
-- the visibility column (for the "Firm" badge). Old signatures dropped
-- first: create-or-replace with a new parameter list would otherwise leave
-- an ambiguous overload behind.

drop function if exists public.get_projects_overview(text, text);

create or replace function public.get_projects_overview(
  p_user_id text,
  p_user_email text default null,
  p_user_org_id uuid default null
)
returns table (
  id uuid,
  user_id text,
  name text,
  cm_number text,
  shared_with jsonb,
  visibility text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  owner_display_name text,
  owner_email text,
  document_count integer,
  chat_count integer,
  review_count integer
)
language sql
stable
as $$
  with visible_projects as (
    select p.*
    from public.projects p
    where p.user_id = p_user_id
       or (
        coalesce(p_user_email, '') <> ''
        and p.user_id <> p_user_id
        and p.shared_with @> jsonb_build_array(p_user_email)
      )
       or (
        p_user_org_id is not null
        and p.user_id <> p_user_id
        and p.visibility = 'firm'
        and p.organisation_id = p_user_org_id
      )
  ),
  document_counts as (
    select d.project_id, count(*)::integer as document_count
    from public.documents d
    where d.project_id in (select vp.id from visible_projects vp)
    group by d.project_id
  ),
  chat_counts as (
    select c.project_id, count(*)::integer as chat_count
    from public.chats c
    where c.project_id in (select vp.id from visible_projects vp)
    group by c.project_id
  ),
  review_counts as (
    select tr.project_id, count(*)::integer as review_count
    from public.tabular_reviews tr
    where tr.project_id in (select vp.id from visible_projects vp)
    group by tr.project_id
  )
  select
    vp.id,
    vp.user_id,
    vp.name,
    vp.cm_number,
    vp.shared_with,
    vp.visibility,
    vp.created_at,
    vp.updated_at,
    vp.user_id = p_user_id as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    null::text as owner_email,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id::text = vp.user_id
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by vp.created_at desc;
$$;

drop function if exists public.get_tabular_reviews_overview(text, text, text);

create or replace function public.get_tabular_reviews_overview(
  p_user_id text,
  p_user_email text default null,
  p_project_id text default null,
  p_user_org_id uuid default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid,
  shared_with jsonb,
  visibility text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  document_count integer
)
language sql
stable
as $$
  with accessible_projects as (
    select p.id
    from public.projects p
    where p.user_id = p_user_id
       or (
        coalesce(p_user_email, '') <> ''
        and p.user_id <> p_user_id
        and p.shared_with @> jsonb_build_array(p_user_email)
      )
       or (
        p_user_org_id is not null
        and p.user_id <> p_user_id
        and p.visibility = 'firm'
        and p.organisation_id = p_user_org_id
      )
  ),
  visible_reviews as (
    select tr.*
    from public.tabular_reviews tr
    where (p_project_id is null or tr.project_id::text = p_project_id)
      and (
        p_project_id is null
        or exists (
          select 1
          from accessible_projects ap
          where ap.id::text = p_project_id
        )
      )
      and (
        tr.user_id = p_user_id
        or (
          tr.project_id in (select ap.id from accessible_projects ap)
          and tr.user_id <> p_user_id
        )
        or (
          p_project_id is null
          and coalesce(p_user_email, '') <> ''
          and tr.user_id <> p_user_id
          and tr.shared_with @> jsonb_build_array(p_user_email)
        )
        or (
          p_project_id is null
          and p_user_org_id is not null
          and tr.user_id <> p_user_id
          and tr.visibility = 'firm'
          and tr.organisation_id = p_user_org_id
        )
      )
  ),
  cell_document_counts as (
    select
      tc.review_id,
      count(distinct tc.document_id)::integer as document_count
    from public.tabular_cells tc
    where tc.review_id in (select vr.id from visible_reviews vr)
    group by tc.review_id
  )
  select
    vr.id,
    vr.project_id,
    vr.user_id,
    vr.title,
    vr.columns_config,
    vr.document_ids,
    vr.workflow_id,
    vr.shared_with,
    vr.visibility,
    vr.created_at,
    vr.updated_at,
    vr.user_id = p_user_id as is_owner,
    case
      when jsonb_typeof(vr.document_ids) = 'array'
        then (
          select count(distinct doc_id.value)::integer
          from jsonb_array_elements_text(vr.document_ids) as doc_id(value)
        )
      else coalesce(cdc.document_count, 0)
    end as document_count
  from visible_reviews vr
  left join cell_document_counts cdc
    on cdc.review_id = vr.id
  order by vr.created_at desc;
$$;
