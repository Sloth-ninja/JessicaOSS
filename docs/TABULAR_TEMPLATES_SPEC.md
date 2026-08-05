# Review templates mini-spec — saved tabular schemas v1 (DRAFT)

> Owner decisions (04/08/2026): v1 = save-as-template from a live review +
> first-class Templates surface + firm-shared templates. UI word is
> "template" (internal/docs name stays "saved tabular schemas"). Templates
> get their own surface and leave the Workflows page. Storage stays in the
> `workflows` table behind a self-contained seam (no data migration). Lists
> columns (status / assignee / cite-to-clause) are the NEXT train, not this
> one.

## Model

- A template IS a `workflows` row with `type='tabular'` and a `columns_config`
  jsonb (today's mechanism, unchanged). The 14 built-ins remain client-side
  constants — their string ids are load-bearing for `hidden_workflows` and
  never become DB rows in v1.
- `workflows.visibility text default 'private'` and
  `workflows.organisation_id uuid null` — new columns (migration below), WS9
  semantics verbatim: `'private' | 'firm'`, app-validated; flipping to
  `'firm'` STAMPS the owner's org id, revert clears it; firm visibility =
  `visibility='firm' AND organisation_id = caller's org`.
- New seam `backend/src/lib/tabularTemplates.ts` (licensing-optionality rule:
  self-contained, no upstream entanglement). Owns: list (mine + email-shared
  + firm-visible), create (name, practice, columns — including from a
  review), update/rename (owner-only, encoded in the UPDATE predicate,
  `is_system` blocked), delete (existing workflows delete path,
  tombstone-aware), setVisibility (owner-only flip + org stamp), admin
  revert. Tombstone exclusion lives INSIDE the seam's read path (28/07
  lesson: gate at the choke point, not per-route).
- Column validation at the seam: `name`+`prompt` required, `format` from the
  existing 9-value allowlist, `tags` only for `tag` format, ≤30 columns,
  name/prompt length caps. `index` re-derived on write, never trusted.
- 42703-tolerance: if the migration hasn't run, firm-sharing degrades to
  `"unsupported"` (toggle hidden); personal templates still work. Orgless
  users never see firm sections.
- Routes `/tabular-templates` (requireAuth + asyncHandler): `GET /`,
  `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`, `PATCH /:id/visibility`.
  No RPC changes — the seam queries `workflows` directly.
- Audit: visibility flips recorded in `deletion_audit_logs` as
  `firm_shared`/`firm_reverted` with the template resource ref (action
  values already exist; no constraint change expected — verify in build).
- Lifecycle: verify `workflows` rows are covered by account deletion
  (`userDataCleanup`) and SAR export (`userDataExport`); add 42P01-tolerant
  coverage if missing (the gap the composed-range review has caught on three
  consecutive trains). Per-email `workflow_shares` keep working unchanged —
  firm visibility is additive.

## Surfaces

1. **Review grid — "Save as template"** (grid header ⋯ menu): modal with
   template name + optional practice area; saves the review's current
   columns as a new personal template. Available to anyone who can read the
   review (the copy becomes THEIRS); confirmation links to the Templates
   page.
2. **Templates page** (`/review-templates`, sidebar entry in the Tabular
   Review group): sections My templates / Shared with me (email-shared via
   existing `workflow_shares`; Duplicate only) / Firm templates / Built-in. Rows:
   name, column count, practice tag, owner (firm section). Actions by
   ownership — owner: edit, rename, duplicate, delete, share to firm /
   revert to private; non-owner firm: duplicate (becomes theirs); built-in:
   duplicate, hide (existing `hidden_workflows` semantics).
3. **Template editor** (`/review-templates/[id]`): reuses `AddColumnModal` +
   `columnFormat.ts` (already shared with the old workflow editor).
   `is_system` templates open read-only with Duplicate.
4. **Pickers relabelled**: `AddNewTRModal` ("Start from a template") and the
   in-grid apply (`TRWorkflowModal`, "Apply template") list built-ins + mine
   + firm templates. The Workflows page drops tabular entries and gains a
   one-line pointer to the Templates page.
5. **Admin (Firm settings)**: firm-shared templates listed with per-item
   Revert, parity with the WS9 firm-library card.

## Non-goals v1

Lists columns (status/assignee/cite-to-clause — next train); realtime
collaboration; backend seeding of built-ins; changes to per-email
`workflow_shares`; template versioning.

## Migration (basename `20260804_01_workflow_firm_visibility.sql`, needs owner authorisation + allowlist entry)

- `alter table public.workflows add column if not exists visibility text not
  null default 'private', add column if not exists organisation_id uuid
  references public.organisations(id) on delete set null;`
- `create index if not exists workflows_firm_visible_idx on
  public.workflows(organisation_id) where visibility = 'firm';`
- Additive only; no function changes; safe before/after backend deploy
  (42703-degrade covers the gap). End with a proving `select` (22/07 lesson).

## Verification

Seam unit tests: mine/firm/orgless scoping, owner-only update/flip
predicates, `is_system` immutability, 42703 degrade, tombstone exclusion,
org stamping, column validation. Route tests for authz + validation.
Frontend `tsc`/ESLint/build. UK copy pass on all new strings. Standard
gates: independent review + 3 green CI checks + BUILD_LOG entry per PR;
composed-range multi-lens review over the train before close-out.
