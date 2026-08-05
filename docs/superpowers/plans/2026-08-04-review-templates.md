# Review Templates (Saved Tabular Schemas v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First-class "Review templates" for tabular reviews — save-as-template from a live review, a dedicated Templates surface, and firm-shared templates — per `docs/TABULAR_TEMPLATES_SPEC.md` (owner-approved 04/08/2026, mock-up https://claude.ai/code/artifact/98d5ce8a-1a9e-4561-91f3-0ce540296fb3).

**Architecture:** Storage stays in the existing `workflows` table (`type='tabular'`, `columns_config` jsonb). All new behaviour lives in a self-contained seam `backend/src/lib/tabularTemplates.ts` + thin `/tabular-templates` routes; firm visibility copies WS9 semantics (stamp org on flip, owner guard in the UPDATE predicate, 42703-degrade). Frontend adds a Templates surface and relabels the existing pickers; built-ins remain client-side constants.

**Tech Stack:** Express 4 + Supabase service client (backend, 2-space), Next.js 16 App Router (frontend, 4-space, ESLint-formatted — NEVER `prettier --write`), vitest.

## Global Constraints

- CLAUDE.md hard rules: no edits to `backend/migrations/**` except the ONE authorised file below; never touch `.env*`/LICENSE; all work lands via PR from a feature branch; merge gate = independent review + 3 green CI checks + BUILD_LOG entry.
- Migration `20260804_01_workflow_firm_visibility.sql` may be written ONLY after the owner adds it to `.claude/hooks/authorized-migrations.json`.
- UK English everywhere; the UI word is **template** ("Review templates", "Save as template"); never "schema" in user-facing copy.
- Async route handlers use `asyncHandler` (`backend/src/lib/asyncHandler.ts`); client-facing error `detail` is always a fixed string; server logs use `safeErrorLog` (PR #72 pattern).
- Every read path in the seam excludes tombstoned rows (`deleted_at is not null`) — choke-point rule (DURABLE_LESSONS 2026-07-28).
- New user-owned data flows must be checked into `userDataCleanup.ts` + `userDataExport.ts` (three-train lesson) — here `workflows` coverage is VERIFIED in Task 2, not assumed.
- `git -C` absolute paths for all git; `gh --repo Sloth-ninja/JessicaOSS` always.

## File Structure

| File | Responsibility |
|---|---|
| `backend/migrations/20260804_01_workflow_firm_visibility.sql` (create, authorised) | additive: `workflows.visibility` + `workflows.organisation_id` + partial index + proving select |
| `backend/schema.sql` (modify, workflows table block ~435-449) | keep canonical schema in sync with the migration |
| `backend/src/lib/tabularTemplates.ts` (create) | the seam: list/create/update/delete/setVisibility/adminRevert + column validation |
| `backend/src/lib/tabularTemplates.test.ts` (create) | seam unit tests |
| `backend/src/routes/tabularTemplates.ts` (create) | `/tabular-templates` router, thin, authz + validation + fixed details |
| `backend/src/routes/tabularTemplates.test.ts` (create) | route tests |
| `backend/src/index.ts` (modify) | mount router at `/tabular-templates` |
| `frontend/src/app/lib/mikeApi.ts` (modify) | 6 new API methods |
| `frontend/src/app/(pages)/review-templates/page.tsx` (create) | Templates page (My/Firm/Built-in sections) |
| `frontend/src/app/(pages)/review-templates/[id]/page.tsx` (create) | template editor (reuses AddColumnModal) |
| `frontend/src/app/components/tabular/SaveAsTemplateModal.tsx` (create) | Frame B modal |
| `frontend/src/app/components/tabular/TabularReviewView.tsx` (modify) | header ⋯ menu "Save as template" entry |
| `frontend/src/app/components/tabular/AddNewTRModal.tsx` + `TRWorkflowModal.tsx` (modify) | relabel to template pickers; include firm templates |
| `frontend/src/app/components/workflows/WorkflowList.tsx` (modify) | drop tabular entries; pointer line |
| `frontend/src/app/components/shared/Sidebar` (locate exact file at build time) (modify) | "Templates" nav entry under Tabular Review |

---

### Task 1: Migration + schema sync (PR 1, branch `templates-migration`)

**Blocked until** the owner adds `20260804_01_workflow_firm_visibility.sql` to `.claude/hooks/authorized-migrations.json`.

**Files:** Create `backend/migrations/20260804_01_workflow_firm_visibility.sql`; Modify `backend/schema.sql` (workflows block); also commit `docs/TABULAR_TEMPLATES_SPEC.md` (already written, uncommitted) and this plan.

**Interfaces — Produces:** columns `workflows.visibility text not null default 'private'`, `workflows.organisation_id uuid null` (FK organisations, on delete set null); partial index `workflows_firm_visible_idx on (organisation_id) where visibility = 'firm'`.

- [ ] **Step 1:** Write the migration exactly per the spec's Migration section: header comment (workstream, owner-authorised date, additive-only statement), the two `add column if not exists` clauses, `create index if not exists`, and a proving `select count(*) as workflows_rows, count(*) filter (where visibility = 'firm') as firm_visible from public.workflows;` at the end (22/07 visible-success lesson).
- [ ] **Step 2:** Mirror the same columns into `backend/schema.sql`'s workflows table definition and append the index near the other workflow indexes.
- [ ] **Step 3:** `cd /Users/ezanahaddis/JessicaOSS/backend && npx tsc --noEmit` (schema.sql is not compiled — this guards accidental TS edits). Commit, push, PR, review gate, merge. BUILD_LOG entry.

### Task 2: Backend seam (PR 2, branch `templates-backend`, can start immediately — 42703-degrade covers pre-migration order)

**Files:** Create `backend/src/lib/tabularTemplates.ts`, `backend/src/lib/tabularTemplates.test.ts`.

**Interfaces — Produces (exact, later tasks depend on these):**

```ts
export type TemplateColumn = { index: number; name: string; prompt: string; format?: string; tags?: string[] };
export type TabularTemplate = {
  id: string; title: string; practice: string | null; columns: TemplateColumn[];
  ownerUserId: string; ownerDisplayName: string | null;
  visibility: "private" | "firm"; isOwner: boolean; updatedAt: string | null;
};
export type TemplateList = { mine: TabularTemplate[]; firm: TabularTemplate[]; firmSharingSupported: boolean };
export const MAX_TEMPLATE_COLUMNS = 30;
export const COLUMN_FORMATS: readonly string[]; // the 9 values from routes/tabular.ts formatPromptSuffix
export function validateTemplateColumns(raw: unknown): TemplateColumn[]; // throws TemplateValidationError with a user-safe message
export class TemplateValidationError extends Error {}
export async function listTemplates(db, userId: string, orgId: string | null): Promise<TemplateList>;
export async function createTemplate(db, userId: string, input: { title: string; practice?: string | null; columns: unknown }): Promise<TabularTemplate>;
export async function updateTemplate(db, userId: string, id: string, patch: { title?: string; practice?: string | null; columns?: unknown }): Promise<TabularTemplate | "not_found">;
export async function deleteTemplate(db, userId: string, id: string): Promise<"deleted" | "not_found">;
export async function setTemplateVisibility(db, userId: string, id: string, visibility: "private" | "firm", orgId: string | null): Promise<TabularTemplate | "not_found" | "unsupported">;
export async function adminRevertTemplate(db, adminUserId: string, orgId: string, id: string): Promise<"reverted" | "not_found">;
export async function listFirmTemplatesForAdmin(db, orgId: string): Promise<TabularTemplate[]>;
```

Implementation rules: queries hit `workflows` directly (`type = 'tabular'`), always `.is("deleted_at", null)`; `is_system` rows are never returned (built-ins are client-side) and never updatable; owner guard encoded in the UPDATE predicate (`.eq("id", id).eq("user_id", userId)` + select-back, zero rows ⇒ `"not_found"`); flip to firm stamps `organisation_id: orgId`, revert nulls it; 42703/42P01 on visibility columns ⇒ `firmSharingSupported: false` / `"unsupported"` (copy `isMissingColumnOrTable` idiom from `lib/firmVisibility.ts`); flips insert best-effort `deletion_audit_logs` rows (actions `firm_shared`/`firm_reverted` — both already in the constraint); `index` re-derived (`columns.map((c, i) => ({...c, index: i}))`); title ≤200 chars, prompt ≤4000, name ≤120, tags only when `format === "tag"`.

- [ ] **Step 1:** Write `tabularTemplates.test.ts` first — mock the Supabase client as `lib/firmVisibility` tests do. Cases: `validateTemplateColumns` (valid round-trip + reindex; missing name/prompt; unknown format; tags without tag-format; 31 columns; over-length fields — each throws `TemplateValidationError`); `listTemplates` (own rows only when orgless; firm rows for org callers exclude own; tombstoned excluded from both; `is_system` excluded; 42703 ⇒ `firmSharingSupported:false` with mine still returned); `createTemplate` (inserts type tabular, private, validated columns); `updateTemplate`/`deleteTemplate` (zero-row update ⇒ not_found — non-owner and tombstoned covered by the same predicate; `is_system` guarded); `setTemplateVisibility` (stamps org on firm; nulls on revert; orgless ⇒ unsupported; audit insert attempted; audit failure non-fatal); `adminRevertTemplate` (org-scoped predicate, zero rows ⇒ not_found).
- [ ] **Step 2:** Run the file — all fail (module missing). Implement the seam. Run again — green.
- [ ] **Step 3:** Full `npx vitest run` (watch the 2026-07-27 vi.mock lesson — new exports break existing mock factories only if other suites mock this new module; none should). `npx tsc --noEmit`. `npx prettier --check src/lib/tabularTemplates*.ts`. Commit.

### Task 3: Backend routes + lifecycle verification (same PR 2)

**Files:** Create `backend/src/routes/tabularTemplates.ts`, `backend/src/routes/tabularTemplates.test.ts`; Modify `backend/src/index.ts` (mount + rate-limit bucket reuse — standard API limiter, no new env vars).

**Interfaces — Consumes:** Task 2 exports verbatim. **Produces routes:** `GET /tabular-templates` → `TemplateList`; `POST /` `{title, practice?, columns}` → 201 `TabularTemplate`; `GET /:id` → `TabularTemplate` (owner or firm-visible-in-caller's-org only); `PATCH /:id`; `DELETE /:id`; `PATCH /:id/visibility` `{visibility}`; `GET /admin/firm` + `POST /:id/admin-revert` behind `requireAdmin`. All `requireAuth` + `asyncHandler`; org id via `getUserOrganisationId`; validation errors → 400 with the `TemplateValidationError` message (user-safe by construction); infra errors → fixed generic detail + `safeErrorLog`.

- [ ] **Step 1:** Route tests first (supertest style as `routes/admin.test.ts`): authz (401 unauthenticated; non-owner PATCH/DELETE → 404-shaped not_found; admin routes 403 for members); happy paths per route; 400 on invalid columns; visibility flip orgless → 409 `{detail: "Firm sharing is not available."}`; unsupported (42703) → same 409.
- [ ] **Step 2:** Implement router; mount in `index.ts`. Green locally.
- [ ] **Step 3 (lifecycle verification — REQUIRED, record result in PR body):** read `userDataCleanup.ts` + `userDataExport.ts`; confirm `workflows` rows are deleted/exported for account deletion + SAR. If either misses them, add 42P01-tolerant coverage in this PR with a test.
- [ ] **Step 4:** Full gates (`vitest run`, `tsc`, prettier on changed files). Commit, push, PR 2, review gate, merge, BUILD_LOG entry.

### Task 4: Frontend (PR 3, branch `templates-frontend`, starts after PR 2 merges)

**Files:** as File Structure table, frontend rows.

**Interfaces — Consumes:** the routes above via new `mikeApi.ts` methods:

```ts
listTabularTemplates(): Promise<TemplateList>
createTabularTemplate(input: {title: string; practice?: string; columns: ColumnConfig[]}): Promise<TabularTemplate>
updateTabularTemplate(id: string, patch: {...}): Promise<TabularTemplate>
deleteTabularTemplate(id: string): Promise<void>
setTabularTemplateVisibility(id: string, visibility: "private" | "firm"): Promise<TabularTemplate>
adminRevertTabularTemplate(id: string): Promise<void>
```

- [ ] **Step 1:** mikeApi methods (match the file's existing fetch/auth idiom; 4-space).
- [ ] **Step 2:** Templates page per mock-up Frame A: sections My/Firm/Built-in; built-ins from `BUILT_IN_WORKFLOWS.filter(w => w.type === "tabular")` with existing hide semantics (`hidden_workflows`); row actions per ownership as mocked; Firm chip on own shared rows; Firm section hidden when `firmSharingSupported === false` or orgless. Loading gate MUST have an error+retry state (no unbounded spinners — 21/07 lesson).
- [ ] **Step 3:** Editor page: reuse `AddColumnModal` + `columnFormat.ts` exactly as `WorkflowDetailPage` does; `is_system` → read-only + Duplicate.
- [ ] **Step 4:** `SaveAsTemplateModal` per Frame B (name prefilled from review title, practice select, "Cell contents are not saved." line); entry in `TabularReviewView` header ⋯ menu; success toast links to `/review-templates`.
- [ ] **Step 5:** Picker relabels per Frame C ("Start from a template" / "Apply template"; sections mine/firm/built-in); `WorkflowList` drops `type === "tabular"` rows and shows the pointer line "Review templates have moved to Templates." linking `/review-templates`; sidebar entry added under Tabular Review.
- [ ] **Step 6:** Gates: `npm run lint`, `npx tsc --noEmit`, `npm run build` in `frontend/`. NEVER `prettier --write`. uk-copywriter pass over all new strings. Screenshots in the PR body. Review gate, merge, BUILD_LOG entry.

### Task 5: Composed-range review + fix wave (PR 4 if findings)

- [ ] **Step 1:** SHA-pin the range (pre-train main SHA … post-PR-3 main SHA); multi-lens review: security/authz (firm scoping, is_system, admin routes), WS8×WS9×templates lifecycle composition (tombstoned templates in pickers? policy interactions?), UI drift vs mock-up, UK terminology.
- [ ] **Step 2:** Fix wave PR for any findings; then deploy both sides, verify live (`/review-templates` 200, save→apply round-trip in prod), update CLAUDE.md Current status + BUILD_LOG close-out entry.

## Self-Review (run)

Spec coverage: model→Tasks 1-2; routes→Task 3; all five spec surfaces→Task 4 steps 2-5; audit/42703/tombstone→Task 2 rules+tests; lifecycle→Task 3 step 3; non-goals absent — no gaps found. Placeholder scan: none (the sidebar file is named "locate exact file at build time" deliberately — its path varies and the builder greps `Firm library` nav strings to find it; acceptable). Type consistency: `TemplateColumn` mirrors the existing backend `Column` (routes/tabular.ts:1771) plus optional fields; frontend consumes existing `ColumnConfig` — verified same shape.
