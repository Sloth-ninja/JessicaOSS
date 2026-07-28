# WS9 mini-spec — matter permissions + firm library (DRAFT)

> Owner decisions (28/07): share-to-firm = any owner flips their own item,
> admins can revert, audit-logged; precedents = firm-visible matters + a
> "Firm library" view; sharee rights stay single-level; invite picker shows
> firm members with external emails still allowed.

## Model

- `projects.visibility` (existing, dead) becomes live: `'private' | 'firm'`.
  App-validated; no DB check constraint (additive safety).
- `projects.organisation_id uuid null` — stamped with the owner's org when
  flipped to `'firm'`, cleared on revert. Firm visibility = visibility='firm'
  AND organisation_id = caller's org. Stamping (not deriving) means an owner
  changing firms later cannot silently re-scope the library.
- `tabular_reviews` gains the same two columns (it never had `visibility`).
- Enforcement: `checkProjectAccess`/`ensureReviewAccess` gain the org branch
  (owner OR shared_with email OR firm-visible-in-caller's-org); overview RPCs
  gain a `p_user_org_id uuid` parameter with the same predicate (migration
  recreates both functions; backend passes the caller's org id, null ⇒ no
  firm branch — orgless unchanged).
- Sharee semantics inside a firm-visible matter = today's shared-matter
  semantics (view docs + chats, AI chat, upload; no delete/manage). Owner
  keeps owner rights; firm ADMINS additionally get revert-visibility (not
  content rights).
- Audit: extend `deletion_audit_logs` action check with `'firm_shared'`,
  `'firm_reverted'` (the "seed of a general admin audit log" growing as
  designed). Best-effort insert on every flip/revert with resource refs.
- Lifecycle: `removeEmailFromSharedWith` unchanged (email shares); firm
  visibility survives owner account deletion? NO — account deletion of the
  owner hard-deletes/tombstones their matters as today; the spec's answer to
  "the firm library must outlive its author" is admin stewardship: admins are
  warned (Pending deletions already shows tombstoned firm-visible items) and
  can restore. Documented, not new machinery, v1.
- Export: firm-visible items appear in members' exports only if owned or
  email-shared (browsing access ≠ a personal-data relationship). Documented.

## Surfaces

1. **PeopleModal**: firm-member picker (from `listOrganisationMembers`) above
   the existing email input; external emails still allowed. Plus a "Firm
   visibility" section: toggle "Visible to everyone at <firm>" (owner only;
   admins see revert). Confirmation copy states what the whole firm gains.
2. **Firm library**: sidebar item (org users only) listing firm-visible
   matters and tabular reviews (name, owner, updated, counts) → normal
   matter/review views through existing routes.
3. **Admin (Firm settings)**: a "Firm library" card listing firm-visible
   items with per-item Revert (MFA-gated, audited).
4. Matters list: firm-visible items get a small "Firm" badge; they appear in
   members' matters overview via the RPC predicate.

## Non-goals v1

Workflow/precedent-prompt org visibility (built-ins cover it); per-member
edit roles; external-user org membership; chat-list asymmetry change (global
recent-chats stays owner-scoped — deliberate, documented).

## Migration (basename `20260728_02_firm_visibility.sql`, needs authorisation)

- `alter table projects add column if not exists organisation_id uuid
  references organisations(id) on delete set null;` (visibility col exists)
- `alter table tabular_reviews add column if not exists visibility text not
  null default 'private'; add column if not exists organisation_id uuid
  references organisations(id) on delete set null;`
- Partial indexes: `(organisation_id) where visibility = 'firm'` on both.
- Recreate `get_projects_overview` + `get_tabular_reviews_overview` with the
  extra `p_user_org_id uuid default null` parameter + firm predicate
  (drop-and-recreate, body otherwise byte-identical plus the one predicate).
- Extend `deletion_audit_logs_action_check`: drop constraint, re-add with
  `'firm_shared','firm_reverted'` included.
- All additive/defaulted; RPC recreation is the only non-trivially-reversible
  piece (old signature restorable from prior migration files).

## Build plan (after migration + mock-up approvals)

PR 1: migration + schema mirror. PR 2: backend (access branches, routes:
PATCH visibility owner-gated + admin revert + firm-library list, RPC params,
audit, tests incl. cross-org exclusion + orgless unchanged + 42703). PR 3:
frontend (PeopleModal picker + visibility section, Firm library page, badge,
admin card) to approved mock-ups. Composed-range review, deploy.
