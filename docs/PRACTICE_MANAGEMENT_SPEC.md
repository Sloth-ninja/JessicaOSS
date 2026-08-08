# Practice Management surface mini-spec — Clio-backed Matters (DRAFT)

> Owner decisions (06/08/2026): the Matters tab becomes Clio-backed (one
> matters concept — no parallel Clio browser); v1 = my-matters preload +
> firm-wide search + matter detail + time entries view/edit + linked
> workspaces; live reads with NO database copy of matter data. Reference
> UI: the Clio Matters page (owner screenshots 06/08). Subsumes pilot asks:
> "Clio matters should appear in Matters", preloaded matters, in-app time
> records. API capabilities verified against docs.developers.clio.com
> 06/08 (spike report; quotes on file) — open questions are NAMED below,
> never assumed.

## Model

- **No matter data is persisted.** Lists and details are live Clio reads via
  the existing `lib/clio/` client (per-user OAuth, 50 req/min/user token,
  X-API-VERSION 4.0.11). A short in-memory server cache (per user+query,
  ~60s TTL, capped entries) absorbs tab-switching; nothing survives restart.
- **One new table (migration, owner authorisation needed):**
  `matter_workspace_links (id, project_id fk → projects, clio_matter_id
  text, clio_display_number text, organisation_id uuid, created_by,
  created_at, unique(project_id), index(clio_matter_id))` — the ONLY stored
  Clio artefact is the id/number pair that anchors a JessicaOS workspace
  (documents/chats/reviews) to a Clio matter. Covered by SAR export +
  account deletion (the four-train lesson) and 42P01-degrade.
- **Permissions are Clio's.** Every read uses the caller's own token; a
  member sees exactly what their Clio login allows (the connector's
  established confidentiality model). No firm-level token, ever.
- **New seam** `backend/src/lib/clio/mattersSurface.ts` + routes
  `/clio-matters` (requireAuth + asyncHandler): list (mine/all + search +
  status filter), detail, related contacts, activities list, activity
  update/delete, workspace link/unlink. Thin wrappers over `clioRequest`;
  fixed client details + safeErrorLog (the #72 pattern); ClioValidationError
  messages pass through (user-safe by construction).

## Surfaces

1. **Matters tab (Clio-connected users).** Header tabs: **My matters**
   (default: `responsible_attorney_id = stored clio_user_id`, merged with
   `originating_attorney_id` matches, de-duplicated) / **All matters**
   (permission-scoped firm list) / **Workspaces** (the existing JessicaOS
   list, unchanged — also the whole tab's fallback when Clio is not
   connected or for orgless users). Columns per the reference screenshot:
   matter number+description, client, responsible solicitor, originating
   solicitor, practice area, status chip, open date. Search box → Clio
   `query` param; status filter (open/pending/closed). Row count honest
   ("Showing 200 of N" when capped). One API call per list view.
2. **Matter detail page.** Sections: overview (client with contact details,
   status, practice area, responsible/originating, open/close dates,
   custom fields incl. UK legal-aid + KYC fields where present); key people
   (related_contacts); **financials** (unbilled WIP via
   `billable_matters?matter_id=`; trust/account balances inline; NO
   per-matter outstanding-balance claim — Clio only aggregates that
   per client, so the UI shows the client-level figure labelled as such);
   **time entries** (see 3); **workspace** (see 4). Money/hours fields can
   arrive REDACTED per the viewer's Clio permissions — render "Hidden by
   your Clio permissions", never £0.
3. **Time entries panel** (pilot ask 4). The matter's TimeEntry activities
   (date, description, duration, amount, billed state, fee earner;
   `order=date(desc)`), defaulting to the caller's own entries with a
   "everyone on this matter" toggle. Edit-in-place for OWN entries
   (duration in minutes/hours UI → seconds API, note, date) via PATCH with
   ETag concurrency (412 → "This entry changed in Clio — reloaded, try
   again"); delete with confirm; "Record time" button prefilled with the
   matter. Billed entries render locked pending the write-probe result
   (open question 3).
4. **Linked workspace.** Matter detail's Documents/Chats/Reviews section IS
   a JessicaOS workspace lazily created on first use and linked via
   `matter_workspace_links` (name + CM number prefilled from Clio; existing
   workspace features unchanged). Existing manual workspaces can be linked
   ("Link to a Clio matter" picker) or stay standalone. The chat's
   save-document-to-matter tool and this surface share the same linkage.
   **Workspace linkage is per viewer, not per matter:** the workspace a
   solicitor sees against a Clio matter is one they can access, so a
   colleague's workspace on the same matter appears only when it is
   firm-visible — two people on one matter can legitimately see different
   workspaces, or one and none, and that is correct rather than a sync bug.
5. **Fallbacks.** Not connected → the tab shows the Workspaces list plus a
   one-line pointer to Account → Connectors. Clio API down/rate-limited →
   error+retry state with the Workspaces tab still usable (no unbounded
   spinners; time-boxed loads).

## Open questions (probe before build claims them)

1. **Sorted list continuation.** Cursor pagination is documented `id(asc)`
   -only; `offset` support on `/matters.json` is contradictory between doc
   pages. v1 ships one 200-row page sorted `open_date(desc)` (covers the
   pilot firm's working set); continuation beyond 200 lands only if the
   offset probe passes.
2. **`clio_matter_financials` selector bug (shipped, suspected 400 on every
   live call).** Confirm via live probe/product use, then fix with the
   corrected selector (`id,display_number,unbilled_amount,unbilled_hours,
   amount_in_trust,currency_code,client{id,name}`) in this train.
3. **Billed-entry edit/delete restrictions** are undocumented — write probe
   on a designated test matter (owner-authorised, self-cleaning, exactly
   like the 03/08 spike) before the UI promises edits on billed entries.
4. **`clio_find_contact` brace-on-scalar selector** — same class as (2),
   lower confidence; probe alongside.

## Non-goals v1

Grow intake surface; matter creation/editing in Clio (read + time entries
only); background sync/webhooks (none exist in the API); offline cache;
per-matter outstanding-balance figures (API cannot provide them); replacing
the Workspaces concept for orgless/self-hosted users.

## Verification

Seam unit tests (mocked HTTP): my-matters merge/de-dup, redaction
rendering states, ETag 412 path, link lifecycle incl. tombstoned-workspace
composition (choke-point rule), 42P01 degrade, SAR/deletion coverage of the
links table. Route authz tests. Frontend gates + UK copy pass. Live probes
1–9 (read-only) before build sign-off; write probe 10 owner-authorised.
Standard gates per PR + composed-range review over the train.
