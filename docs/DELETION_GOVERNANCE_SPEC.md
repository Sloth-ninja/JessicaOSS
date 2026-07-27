# Deletion governance (WS8 PR G) — mini-spec

> Records the design agreed at the owner gates of 22/07 and 27/07/2026. Firm
> members' destructive deletes become reversible **tombstones** held for a
> firm-configurable retention window, then hard-purged; orgless self-hosters keep
> today's immediate hard delete unchanged. Migration: `20260727_01` (#44).

## Why

For a firm running the pilot, an accidental delete by one solicitor is a data-loss
incident the firm cannot recover from. Deletion governance gives the firm a safety
net (restore within the retention window) and an audit trail, without changing
anything for single-user self-hosters. Reversibility is the whole point, so the
mechanics are deliberately biased towards **not** destroying bytes until the
retention window has elapsed.

## Behaviour matrix

| Caller | Destructive delete (single + bulk) | Account deletion (`DELETE /user/account`) |
|---|---|---|
| **Org member** (admins included — one rule for the whole firm, PR B precedent) | **Tombstone**: `deleted_at=now()`, `deleted_by=caller`. Bytes retained. Row hidden immediately. Purged after the firm's `retention_days`. | **Blocked** (403, fixed copy: *"Account deletion is managed by your firm. Ask your firm administrator."*). Not audited. |
| **Orgless** (self-hoster, no firm) | **Immediate hard delete** — zero behaviour change. | Unchanged (immediate hard delete). |
| **Org-lookup errors** | **Fail-SAFE → tombstone** (see below). | **Blocked** (fail-safe: a hiccup must not delete a whole account). |
| **Admin** (firm settings surface) | Can **restore** or **expedite** any member's tombstone; can set `retention_days`. | n/a (account off-boarding is a later PR). |

### The deliberate fail-safe inversion (vs PR B fail-open)

PR B's `requireMemberPolicy` **fails open** on an org-lookup error (availability
beats a brief policy gap — a blocked key write is a minor annoyance). Deletion
inverts that: on any org-lookup error we **tombstone anyway**, because a tombstone
is reversible and a hard delete is not. Availability is preserved (the delete still
"succeeds" from the user's view — the item disappears), and the bytes survive for
the firm to recover. Hard delete on a DB hiccup would be irreversible data loss.
This inversion is intentional and recorded here and in `docs/BUILD_LOG.md`.

## Covered routes

Tombstone-or-hard-delete decision applied to:

- `DELETE /projects/:projectId`
- `DELETE /single-documents/:documentId`
- `DELETE /chat/:chatId`
- `DELETE /tabular-review/:reviewId`
- `DELETE /workflows/:workflowId`
- Bulk: `DELETE /user/chats`, `DELETE /user/projects`, `DELETE /user/tabular-reviews`

Blocked for members: `DELETE /user/account`.

Every tombstone encodes the state transition in the UPDATE predicate itself
(`.eq("id", …).eq("user_id", …).is("deleted_at", null)` + select-back; zero rows ⇒
generic failure), atomic against races/double-submits (DURABLE_LESSONS 2026-07-19).

### Storage bytes

**Not** deleted at tombstone time — restore must be lossless. Storage objects (R2)
and child rows (chat messages, tabular cells, document versions, project subfolders)
stay in place and are removed only at **purge**, via the existing hard-delete helpers
(`deleteUserProjects` and per-id equivalents in `userDataCleanup.ts`).

## Immediate hiding (reads)

Tombstoned rows are excluded from every member/owner-facing read the moment they are
tombstoned:

- **List surfaces**: `GET /projects`, `GET /chat`, `GET /workflows`,
  `GET /tabular-review`, `GET /single-documents`. The four overview RPCs
  (`get_projects_overview` / `get_chats_overview` / `get_tabular_reviews_overview` /
  `get_workflows_overview`) do **not** filter on `deleted_at` and **must not be
  changed** (hard rule 1 forbids editing migrations; the RPCs are owner-frozen for
  v1). Their results are therefore **post-filtered in backend code**: the caller's
  tombstoned ids for the table are fetched and excluded (cheap at pilot scale).
- **Fetch-by-id**: a tombstoned project / chat / review / workflow / single-document
  returns a generic 404 so a tombstoned parent cannot resurface via a child route.

All read-exclusion is 42703/42P01-tolerant: if the migration has not run, the
tombstoned-id lookup returns empty and reads behave exactly as today.

## Retention & purge mechanics

- `organisations.retention_days` (int, default 30, admin-editable, **server-clamped
  1–365**) is the firm's window.
- A row is due for purge when `deleted_at < now() - retention_days`. Retention is
  resolved **per row's owner → org** (orgless owners, and rows whose org cannot be
  resolved, use the default 30). Owner→org resolution respects the uuid-vs-text trap
  (`user_profiles.user_id` is uuid; the event tables' `user_id` is text —
  DURABLE_LESSONS 2026-07-22): owners are matched by their uuid **string**.
- The purge sweep (`lib/deletionGovernance.ts`, `runDeletionPurge`) runs the existing
  hard-delete code paths for each due row (including storage cleanup) and audits one
  `purged` row per org per sweep with per-type counts in `detail`.
- **Trigger**: on backend boot + every 6 hours via `setInterval` in `index.ts`.
  Best-effort, logged, never blocks a request. Also invoked synchronously by admin
  **expedite**.

## Admin surface

Router-level `requireAdmin`; the two mutations additionally step up MFA
(`requireMfaIfEnrolled`); all `asyncHandler`-wrapped with fixed generic error details.

- `GET /admin/pending-deletions` — org-scoped list: resource type, display
  name/title (where cheaply available), requester (`deleted_by`), `deleted_at`, days
  remaining.
- `POST /admin/pending-deletions/:resourceType/:id/restore` — clear the tombstone
  (predicate-encoded; scoped to the firm's members).
- `POST /admin/pending-deletions/:resourceType/:id/expedite` — immediate hard delete
  now (runs the purge path for that row).
- `PATCH /admin/retention` — `{ retentionDays }`, server-clamped 1–365.

Firm settings UI: a **Pending deletions** card (list + Restore / Expedite with
confirm, DD/MM/YYYY dates, the `LoadErrorRow` retry pattern) and a **retention-days**
field near Policies (MFA-guarded save, 1–365 validation).

## Audit trail

Best-effort inserts to `deletion_audit_logs` (never block a request; mirror
`insertMcpAuditLog`). `actor_user_id` and `deleted_by` are **uuid**; the event
tables' `user_id` is text — resolved carefully. Actions:

| Action | When | Notes |
|---|---|---|
| `requested` | Every member tombstone | **One row per bulk action** with counts in `detail` (owner decision). |
| `restored` | Admin restore | acting admin = `actor_user_id`. |
| `expedited` | Admin expedite | acting admin = `actor_user_id`. |
| `purged` | Each sweep | One row per org per sweep, per-type counts in `detail`. |
| `exported` | `GET /user/export`, `/user/chats/export`, `/user/tabular-reviews/export` | Only when the caller is org-affiliated (orgless exports are **not** audited). |

An audit insert requires a resolvable `organisation_id`; the fail-safe tombstone
case (org unknown) tombstones but cannot audit — acceptable, best-effort by design.

## Explicit v1 exclusions

- **No new migration in this PR** — everything rides `20260727_01` (#44). Code is
  42703/42P01-tolerant so it degrades to today's hard-delete behaviour if the
  migration has not run in an environment.
- **RPCs are not modified.** Hiding is done by backend post-filtering, not by
  changing `get_*_overview`.
- **Member account deletion is blocked, not tombstoned.** Admin-driven member
  off-boarding is a later PR.
- **`tabular_review_chats` are not independently tombstoned.** They are children of a
  tabular review and follow their parent at purge; the bulk "delete all chats"
  tombstone covers assistant `chats` only.
- **Project children are not individually tombstoned** when a project is tombstoned —
  they stay in place and follow the parent at purge (lossless restore). Because a
  tombstoned project's detail route 404s, its children are unreachable in the UI.
- **No restore-window UI for members** — restore is an admin action. Members see the
  item disappear and honest copy explaining the firm holds it for N days.
- **Purge scheduling is in-process** (`setInterval`), not a durable job queue —
  adequate at pilot scale; a hardened scheduler is a later concern.
