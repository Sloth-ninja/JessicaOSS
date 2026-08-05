import { createServerSupabase } from "./supabase";
import {
  insertDeletionAudit,
  resolveDeletionMode,
  tombstoneResource,
} from "./deletionGovernance";
import { safeErrorLog } from "./safeError";

/**
 * Review templates (saved tabular schemas v1) — the self-contained seam behind
 * the `/tabular-templates` routes. See docs/TABULAR_TEMPLATES_SPEC.md.
 *
 * A template IS a `workflows` row with `type='tabular'` and a `columns_config`
 * jsonb — today's storage, unchanged. The 14 built-in templates remain
 * client-side constants (`is_system` rows are never returned and never
 * updatable here). Firm sharing copies the WS9 semantics verbatim: flipping to
 * 'firm' STAMPS the owner's organisation_id (so an owner who later changes
 * firms cannot silently re-scope the library), reverting clears it, and every
 * flip is audited best-effort in `deletion_audit_logs`.
 *
 * Everything is tolerant of an unmigrated database: if migration
 * 20260804_01_workflow_firm_visibility.sql has not run (Postgres 42703/42P01
 * on the visibility columns), firm sharing degrades to
 * `firmSharingSupported:false` / "unsupported" and personal templates keep
 * working. Reads use `select("*")` so a missing column is simply absent from
 * the row rather than an error; only firm-filtered queries and visibility
 * writes can hit 42703. Tombstoned rows (`deleted_at` set) are excluded inside
 * every read path — the choke-point rule (DURABLE_LESSONS 2026-07-28).
 */

type Db = ReturnType<typeof createServerSupabase>;

const TABLE = "workflows";

export type TemplateColumn = {
  index: number;
  name: string;
  prompt: string;
  format?: string;
  tags?: string[];
};

export type TabularTemplate = {
  id: string;
  title: string;
  practice: string | null;
  columns: TemplateColumn[];
  ownerUserId: string;
  ownerDisplayName: string | null;
  visibility: "private" | "firm";
  isOwner: boolean;
  updatedAt: string | null;
};

export type TemplateList = {
  mine: TabularTemplate[];
  /** Templates email-shared with the caller via workflow_shares (isOwner false). */
  shared: TabularTemplate[];
  firm: TabularTemplate[];
  firmSharingSupported: boolean;
};

export const MAX_TEMPLATE_COLUMNS = 30;

/** The nine column formats from routes/tabular.ts formatPromptSuffix. */
export const COLUMN_FORMATS: readonly string[] = [
  "text",
  "bulleted_list",
  "number",
  "percentage",
  "monetary_amount",
  "currency",
  "yes_no",
  "date",
  "tag",
];

const MAX_TITLE_LENGTH = 200;
const MAX_PRACTICE_LENGTH = 120;
const MAX_COLUMN_NAME_LENGTH = 120;
const MAX_COLUMN_PROMPT_LENGTH = 4000;
const MAX_TAGS = 50;
const MAX_TAG_LENGTH = 100;

// Max ids per `.in()` filter — PostgREST encodes the list into the query
// string, so unbounded lists risk a 414 (URL too long).
const IN_CHUNK_SIZE = 100;

/** Thrown with a user-safe message; routes surface `message` as the 400 detail. */
export class TemplateValidationError extends Error {}

// "Unmigrated database" error codes — migration 20260804_01 has not run.
// Filters on a missing column surface Postgres 42703/42P01, but an UPDATE
// PAYLOAD naming a missing column is rejected by PostgREST's schema cache as
// PGRST204 before Postgres ever sees it — degrade checks must cover both
// (DURABLE_LESSONS 2026-08-05). Extends the companySearchSaves.ts idiom.
function isMissingColumnOrTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "42703" || code === "42P01" || code === "PGRST204";
}

/**
 * Strip control characters (incl. newlines) from a user-supplied value that is
 * later interpolated into cell-generation prompts — defence against
 * prompt-marker injection via firm-shared templates (the `[[${tag}]]`
 * interpolation class). Control characters become a single space, whitespace
 * collapses, ends trimmed.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/**
 * Tag values additionally drop `[`, `]` and `|` — the `[[tag]]` prompt-marker
 * interpolation vocabulary in routes/tabular.ts formatPromptSuffix — so a
 * crafted tag on a firm-shared template cannot smuggle extra markers into the
 * cell-generation prompt. Column names keep the control-char strip only.
 */
const TAG_MARKER_CHARS = /[[\]|]/g;
function stripTagValue(value: string): string {
  return stripControlChars(value.replace(TAG_MARKER_CHARS, " "));
}

/**
 * Validate a client-supplied columns payload into clean TemplateColumn rows.
 * `index` is re-derived from position, never trusted. Throws
 * TemplateValidationError with a user-safe message on any problem.
 */
export function validateTemplateColumns(raw: unknown): TemplateColumn[] {
  if (!Array.isArray(raw)) {
    throw new TemplateValidationError("Template columns must be a list.");
  }
  if (raw.length === 0) {
    throw new TemplateValidationError("A template needs at least one column.");
  }
  if (raw.length > MAX_TEMPLATE_COLUMNS) {
    throw new TemplateValidationError(
      `A template can have at most ${MAX_TEMPLATE_COLUMNS} columns.`,
    );
  }
  return raw.map((entry, position) => {
    if (!entry || typeof entry !== "object") {
      throw new TemplateValidationError(
        "Each column needs a name and a prompt.",
      );
    }
    const candidate = entry as Record<string, unknown>;
    const name =
      typeof candidate.name === "string"
        ? stripControlChars(candidate.name)
        : "";
    if (!name) {
      throw new TemplateValidationError("Each column needs a name.");
    }
    if (name.length > MAX_COLUMN_NAME_LENGTH) {
      throw new TemplateValidationError(
        `Column names must be ${MAX_COLUMN_NAME_LENGTH} characters or fewer.`,
      );
    }
    const prompt =
      typeof candidate.prompt === "string" ? candidate.prompt.trim() : "";
    if (!prompt) {
      throw new TemplateValidationError("Each column needs a prompt.");
    }
    if (prompt.length > MAX_COLUMN_PROMPT_LENGTH) {
      throw new TemplateValidationError(
        `Column prompts must be ${MAX_COLUMN_PROMPT_LENGTH} characters or fewer.`,
      );
    }
    let format: string | undefined;
    if (candidate.format !== undefined && candidate.format !== null) {
      if (
        typeof candidate.format !== "string" ||
        !COLUMN_FORMATS.includes(candidate.format)
      ) {
        throw new TemplateValidationError("Unknown column format.");
      }
      format = candidate.format;
    }
    let tags: string[] | undefined;
    if (candidate.tags !== undefined && candidate.tags !== null) {
      if (format !== "tag") {
        throw new TemplateValidationError(
          "Tags are only available on tag-format columns.",
        );
      }
      if (!Array.isArray(candidate.tags)) {
        throw new TemplateValidationError("Column tags must be a list.");
      }
      if (candidate.tags.length > MAX_TAGS) {
        throw new TemplateValidationError(
          `A tag column can have at most ${MAX_TAGS} tags.`,
        );
      }
      tags = candidate.tags.map((tag) => {
        const value = typeof tag === "string" ? stripTagValue(tag) : "";
        if (!value) {
          throw new TemplateValidationError("Tags must be non-empty text.");
        }
        if (value.length > MAX_TAG_LENGTH) {
          throw new TemplateValidationError(
            `Tags must be ${MAX_TAG_LENGTH} characters or fewer.`,
          );
        }
        return value;
      });
    }
    const column: TemplateColumn = { index: position, name, prompt };
    if (format !== undefined) column.format = format;
    if (tags !== undefined) column.tags = tags;
    return column;
  });
}

function validateTitle(raw: unknown): string {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (!title) {
    throw new TemplateValidationError("A template name is required.");
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new TemplateValidationError(
      `Template names must be ${MAX_TITLE_LENGTH} characters or fewer.`,
    );
  }
  return title;
}

function validatePractice(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new TemplateValidationError("Practice area must be text.");
  }
  const practice = raw.trim();
  if (!practice) return null;
  if (practice.length > MAX_PRACTICE_LENGTH) {
    throw new TemplateValidationError(
      `Practice areas must be ${MAX_PRACTICE_LENGTH} characters or fewer.`,
    );
  }
  return practice;
}

type WorkflowRow = Record<string, unknown>;

/**
 * Lenient read-side mapping of a stored columns_config jsonb: rows written
 * before this seam existed (the old workflow editor) are surfaced best-effort
 * rather than rejected. `index` is still re-derived from position.
 */
function parseStoredColumns(raw: unknown): TemplateColumn[] {
  if (!Array.isArray(raw)) return [];
  const columns: TemplateColumn[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const prompt = typeof candidate.prompt === "string" ? candidate.prompt : "";
    const column: TemplateColumn = { index: columns.length, name, prompt };
    if (typeof candidate.format === "string") column.format = candidate.format;
    if (
      Array.isArray(candidate.tags) &&
      candidate.tags.every((tag) => typeof tag === "string")
    ) {
      column.tags = candidate.tags as string[];
    }
    columns.push(column);
  }
  return columns;
}

// NOTE the workflows table carries no updated_at column; created_at is the only
// timestamp, so it is surfaced as `updatedAt` (the closest honest value).
function toTemplate(row: WorkflowRow, callerUserId: string): TabularTemplate {
  const ownerUserId = typeof row.user_id === "string" ? row.user_id : "";
  return {
    id: String(row.id),
    title: typeof row.title === "string" ? row.title : "",
    practice:
      typeof row.practice === "string" && row.practice ? row.practice : null,
    columns: parseStoredColumns(row.columns_config),
    ownerUserId,
    ownerDisplayName: null,
    visibility: row.visibility === "firm" ? "firm" : "private",
    isOwner: ownerUserId !== "" && ownerUserId === callerUserId,
    updatedAt: typeof row.created_at === "string" ? row.created_at : null,
  };
}

/**
 * Best-effort: fill in `ownerDisplayName` from user_profiles. A lookup failure
 * leaves the names null rather than failing the list (mirrors
 * enrichReviewOwnerNames in firmVisibility.ts).
 */
async function enrichOwnerNames(
  db: Db,
  templates: TabularTemplate[],
): Promise<void> {
  const ownerIds = [
    ...new Set(
      templates
        .map((template) => template.ownerUserId)
        .filter((id): id is string => id !== ""),
    ),
  ];
  if (ownerIds.length === 0) return;
  try {
    const { data, error } = await db
      .from("user_profiles")
      .select("user_id, display_name")
      .in("user_id", ownerIds);
    if (error) return;
    const nameByUserId = new Map<string, string>();
    for (const row of (data ?? []) as {
      user_id?: unknown;
      display_name?: unknown;
    }[]) {
      const uid = typeof row.user_id === "string" ? row.user_id : null;
      const name =
        typeof row.display_name === "string" && row.display_name.trim()
          ? row.display_name.trim()
          : null;
      if (uid && name) nameByUserId.set(uid, name);
    }
    for (const template of templates) {
      if (template.ownerUserId) {
        template.ownerDisplayName =
          nameByUserId.get(template.ownerUserId) ?? null;
      }
    }
  } catch (err) {
    console.error("[tabularTemplates] owner enrichment failed", {
      error: safeErrorLog(err),
    });
  }
}

/**
 * Templates email-shared with the caller via `workflow_shares` (matched on the
 * normalised email, as routes/workflows.ts resolveWorkflowAccess does). The
 * caller's own rows are excluded (they live in `mine`), as are tombstoned and
 * `is_system` rows.
 */
async function listEmailSharedTemplates(
  db: Db,
  userId: string,
  userEmail: string | null,
): Promise<TabularTemplate[]> {
  const normalizedEmail = (userEmail ?? "").trim().toLowerCase();
  if (!normalizedEmail) return [];
  const sharesResult = await db
    .from("workflow_shares")
    .select("workflow_id")
    .eq("shared_with_email", normalizedEmail);
  if (sharesResult.error) throw sharesResult.error;
  const workflowIds = [
    ...new Set(
      ((sharesResult.data ?? []) as { workflow_id?: unknown }[])
        .map((row) => row.workflow_id)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  if (workflowIds.length === 0) return [];
  // Chunk the `.in()` id list: PostgREST encodes it into the query string, so
  // an unbounded list risks a 414 (URL too long) on share-heavy accounts.
  const rows: WorkflowRow[] = [];
  for (let i = 0; i < workflowIds.length; i += IN_CHUNK_SIZE) {
    const chunk = workflowIds.slice(i, i + IN_CHUNK_SIZE);
    const sharedResult = await db
      .from(TABLE)
      .select("*")
      .in("id", chunk)
      .eq("type", "tabular")
      .eq("is_system", false)
      .neq("user_id", userId)
      .is("deleted_at", null);
    if (sharedResult.error) throw sharedResult.error;
    rows.push(...((sharedResult.data ?? []) as WorkflowRow[]));
  }
  // Per-chunk queries lose global ordering; sort newest-first here (ISO
  // timestamps compare lexicographically).
  rows.sort((a, b) =>
    String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
  );
  const shared = rows.map((row) => toTemplate(row, userId));
  await enrichOwnerNames(db, shared);
  return shared;
}

/**
 * List the caller's templates: their own (newest first), templates
 * email-shared with them via workflow_shares, and other members' firm-shared
 * templates in their organisation. The caller's own firm-shared templates stay
 * in `mine` (with visibility 'firm') and are excluded from `firm`. Orgless
 * callers, and org callers on an unmigrated database, get
 * `firmSharingSupported:false` with `mine` and `shared` intact.
 */
export async function listTemplates(
  db: Db,
  userId: string,
  userEmail: string | null,
  orgId: string | null,
): Promise<TemplateList> {
  const mineResult = await db
    .from(TABLE)
    .select("*")
    .eq("user_id", userId)
    .eq("type", "tabular")
    .eq("is_system", false)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (mineResult.error) throw mineResult.error;
  const mine = ((mineResult.data ?? []) as WorkflowRow[]).map((row) =>
    toTemplate(row, userId),
  );

  const shared = await listEmailSharedTemplates(db, userId, userEmail);

  let firm: TabularTemplate[] = [];
  let firmSharingSupported = false;
  if (orgId) {
    const firmResult = await db
      .from(TABLE)
      .select("*")
      .eq("type", "tabular")
      .eq("is_system", false)
      .eq("visibility", "firm")
      .eq("organisation_id", orgId)
      .neq("user_id", userId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (firmResult.error) {
      if (!isMissingColumnOrTable(firmResult.error)) throw firmResult.error;
      // Unmigrated database: firm sharing stays dormant.
    } else {
      firmSharingSupported = true;
      // A template can be BOTH email-shared with the caller and firm-visible;
      // shared wins — it never appears twice.
      const sharedIds = new Set(shared.map((template) => template.id));
      firm = ((firmResult.data ?? []) as WorkflowRow[])
        .filter((row) => !sharedIds.has(String(row.id)))
        .map((row) => toTemplate(row, userId));
      await enrichOwnerNames(db, firm);
    }
  }

  return { mine, shared, firm, firmSharingSupported };
}

/**
 * Fetch one template the caller may read: their own, a firm-visible one in
 * their organisation, or one email-shared with them via `workflow_shares`
 * (read semantics identical to the `shared` list entries). Route seam for
 * GET /tabular-templates/:id — an addition alongside the planned exports;
 * nothing listed in the plan changed shape.
 */
export async function getTemplate(
  db: Db,
  userId: string,
  id: string,
  orgId: string | null,
  userEmail?: string | null,
): Promise<TabularTemplate | "not_found"> {
  const { data, error } = await db
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .eq("type", "tabular")
    .eq("is_system", false)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  const row = data as WorkflowRow | null;
  if (!row) return "not_found";
  const template = toTemplate(row, userId);
  if (template.isOwner) return template;
  const firmVisible =
    orgId !== null &&
    row.visibility === "firm" &&
    row.organisation_id === orgId;
  if (firmVisible) {
    await enrichOwnerNames(db, [template]);
    return template;
  }
  const normalizedEmail = (userEmail ?? "").trim().toLowerCase();
  if (normalizedEmail) {
    const shareResult = await db
      .from("workflow_shares")
      .select("id")
      .eq("workflow_id", id)
      .eq("shared_with_email", normalizedEmail)
      .maybeSingle();
    if (shareResult.error) throw shareResult.error;
    if (shareResult.data) {
      await enrichOwnerNames(db, [template]);
      return template;
    }
  }
  return "not_found";
}

/** Create a private template owned by the caller. Validates title + columns. */
export async function createTemplate(
  db: Db,
  userId: string,
  input: { title: string; practice?: string | null; columns: unknown },
): Promise<TabularTemplate> {
  const title = validateTitle(input.title);
  const practice = validatePractice(input.practice);
  const columns = validateTemplateColumns(input.columns);
  const { data, error } = await db
    .from(TABLE)
    .insert({
      user_id: userId,
      title,
      type: "tabular",
      prompt_md: null,
      columns_config: columns,
      practice,
      is_system: false,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toTemplate(data as WorkflowRow, userId);
}

/**
 * Owner-only update (rename / practice / columns). The owner guard, the
 * `is_system` block and the tombstone exclusion are all encoded in the UPDATE
 * predicate + select-back — zero rows ⇒ "not_found" (DURABLE_LESSONS: encode
 * state transitions in the predicate).
 */
export async function updateTemplate(
  db: Db,
  userId: string,
  id: string,
  patch: { title?: string; practice?: string | null; columns?: unknown },
): Promise<TabularTemplate | "not_found"> {
  const updates: Record<string, unknown> = {};
  if (patch.title !== undefined) updates.title = validateTitle(patch.title);
  if (patch.practice !== undefined) {
    updates.practice = validatePractice(patch.practice);
  }
  if (patch.columns !== undefined) {
    updates.columns_config = validateTemplateColumns(patch.columns);
  }
  if (Object.keys(updates).length === 0) {
    throw new TemplateValidationError("Nothing to update.");
  }
  const { data, error } = await db
    .from(TABLE)
    .update(updates)
    .eq("id", id)
    .eq("user_id", userId)
    .eq("type", "tabular")
    .eq("is_system", false)
    .is("deleted_at", null)
    .select("*");
  if (error) throw error;
  const row = ((data ?? []) as WorkflowRow[])[0];
  if (!row) return "not_found";
  return toTemplate(row, userId);
}

/**
 * Owner-only delete via the existing workflows delete path (WS8 PR G): org
 * members tombstone (reversible, audited as 'requested'); orgless self-hosters
 * — and unmigrated databases — hard-delete. Idempotent: a second delete of the
 * same id reports "not_found".
 */
export async function deleteTemplate(
  db: Db,
  userId: string,
  id: string,
): Promise<"deleted" | "not_found"> {
  const mode = await resolveDeletionMode(db, userId);
  if (mode.tombstone) {
    const outcome = await tombstoneResource(db, "workflow", id, userId, {
      user_id: userId,
      is_system: false,
      type: "tabular",
    });
    if (outcome === "tombstoned") {
      try {
        await insertDeletionAudit(db, {
          organisationId: mode.organisationId,
          actorUserId: userId,
          action: "requested",
          resourceType: "workflow",
          resourceId: id,
        });
      } catch (err) {
        console.error("[tabularTemplates] delete audit failed", {
          error: safeErrorLog(err),
        });
      }
      return "deleted";
    }
    if (outcome === "not_found") return "not_found";
    // "unsupported" (unmigrated) → fall through to hard delete.
  }
  const { data, error } = await db
    .from(TABLE)
    .delete()
    .eq("id", id)
    .eq("user_id", userId)
    .eq("type", "tabular")
    .eq("is_system", false)
    .select("id");
  if (error) throw error;
  return ((data ?? []) as unknown[]).length > 0 ? "deleted" : "not_found";
}

/**
 * Owner flip between 'private' and 'firm'. Flipping to firm stamps the
 * caller's organisation_id; reverting clears it. Owner guard, `is_system`
 * block and tombstone exclusion live in the UPDATE predicate. Orgless callers
 * and unmigrated databases (42703/42P01) get "unsupported". Flips are audited
 * best-effort as firm_shared / firm_reverted.
 *
 * Sharing to the firm additionally re-validates the STORED columns first. Rows
 * written before this seam existed (the old workflow editor, or the legacy
 * POST/PATCH /workflows routes, which still accept type:'tabular' payloads
 * without these checks) can carry oversize or control-character values that
 * `createTemplate`/`updateTemplate` would reject — and a firm-shared template's
 * tags are interpolated into every colleague's cell-generation prompts. Sharing
 * is the moment a private row becomes other people's input, so it is the right
 * choke point: an invalid row reports "invalid_columns" and stays private until
 * its owner reopens and re-saves it (which runs the same validation). Reverting
 * to private is never blocked — that direction only ever reduces exposure.
 */
export async function setTemplateVisibility(
  db: Db,
  userId: string,
  id: string,
  visibility: "private" | "firm",
  orgId: string | null,
): Promise<TabularTemplate | "not_found" | "unsupported" | "invalid_columns"> {
  if (!orgId) return "unsupported";
  if (visibility === "firm") {
    const existing = await db
      .from(TABLE)
      .select("columns_config")
      .eq("id", id)
      .eq("user_id", userId)
      .eq("type", "tabular")
      .eq("is_system", false)
      .is("deleted_at", null)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) return "not_found";
    try {
      validateTemplateColumns((existing.data as WorkflowRow).columns_config);
    } catch (err) {
      if (err instanceof TemplateValidationError) return "invalid_columns";
      throw err;
    }
  }
  const { data, error } = await db
    .from(TABLE)
    .update({
      visibility,
      organisation_id: visibility === "firm" ? orgId : null,
    })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("type", "tabular")
    .eq("is_system", false)
    .is("deleted_at", null)
    .select("*");
  if (error) {
    if (isMissingColumnOrTable(error)) {
      // Loud enough to catch a post-migration typo (a wrong column name would
      // silently 409 forever otherwise); expected only pre-migration.
      console.warn(
        "[tabularTemplates] visibility flip degraded — visibility columns missing (run migration 20260804_01)",
        safeErrorLog(error),
      );
      return "unsupported";
    }
    throw error;
  }
  const row = ((data ?? []) as WorkflowRow[])[0];
  if (!row) return "not_found";
  try {
    await insertDeletionAudit(db, {
      organisationId: orgId,
      actorUserId: userId,
      action: visibility === "firm" ? "firm_shared" : "firm_reverted",
      resourceType: "workflow",
      resourceId: id,
    });
  } catch (err) {
    console.error("[tabularTemplates] visibility audit failed", {
      error: safeErrorLog(err),
    });
  }
  return toTemplate(row, userId);
}

/**
 * Admin revert of a firm-shared template back to private. Scoped to the
 * admin's OWN organisation and to a currently-firm-visible row, both encoded
 * in the UPDATE predicate — another firm's template yields zero rows ⇒
 * "not_found". An unmigrated database also reports "not_found" (nothing can be
 * firm-shared before the migration).
 */
export async function adminRevertTemplate(
  db: Db,
  adminUserId: string,
  orgId: string,
  id: string,
): Promise<"reverted" | "not_found"> {
  const { data, error } = await db
    .from(TABLE)
    .update({ visibility: "private", organisation_id: null })
    .eq("id", id)
    .eq("organisation_id", orgId)
    .eq("visibility", "firm")
    .eq("type", "tabular")
    .eq("is_system", false)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    if (isMissingColumnOrTable(error)) {
      console.warn(
        "[tabularTemplates] admin revert degraded — visibility columns missing (run migration 20260804_01)",
        safeErrorLog(error),
      );
      return "not_found";
    }
    throw error;
  }
  if (((data ?? []) as unknown[]).length === 0) return "not_found";
  try {
    await insertDeletionAudit(db, {
      organisationId: orgId,
      actorUserId: adminUserId,
      action: "firm_reverted",
      resourceType: "workflow",
      resourceId: id,
    });
  } catch (err) {
    console.error("[tabularTemplates] admin revert audit failed", {
      error: safeErrorLog(err),
    });
  }
  return "reverted";
}

/**
 * The organisation's firm-shared templates for the admin card (parity with the
 * WS9 firm-library card). `isOwner` is always false here — the admin surface
 * acts on org scope, not ownership. Unmigrated databases degrade to [].
 */
export async function listFirmTemplatesForAdmin(
  db: Db,
  orgId: string,
): Promise<TabularTemplate[]> {
  const { data, error } = await db
    .from(TABLE)
    .select("*")
    .eq("type", "tabular")
    .eq("is_system", false)
    .eq("visibility", "firm")
    .eq("organisation_id", orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingColumnOrTable(error)) return [];
    throw error;
  }
  // NOTE no client-side is_system re-filter: `.eq("is_system", false)` above
  // already excludes built-ins in the query.
  const templates = ((data ?? []) as WorkflowRow[]).map((row) =>
    toTemplate(row, ""),
  );
  await enrichOwnerNames(db, templates);
  return templates;
}
