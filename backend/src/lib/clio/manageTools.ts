// Clio Manage chat tools: matter/contact search, matter financials, time
// recording, and matter documents (list + save-a-JessicaOS-document). Wired
// into the chat engine through the same seam as the Companies House tools,
// gated on the caller having Clio Manage connected (absent connection => the
// tools are never offered; the executor also re-checks and returns a friendly
// "connect Clio" error as defence in depth).
//
// Writes (record time, save document, delete time entry) return the created/
// affected record so the chat layer can show a confirmation; the chat layer is
// responsible for asking the user before invoking a write (system-prompt
// guidance), exactly as with generate_docx.

import { createHash } from "crypto";
import { ensureDocAccess } from "../access";
import { loadActiveVersion } from "../documentVersions";
import { getUserOrganisationId } from "../organisations";
import { downloadFile } from "../storage";
import type { OpenAIToolSchema } from "../llm";
import { createServerSupabase } from "../supabase";
import { clioRequest } from "./client";
import {
  clioToolError,
  clioToolOk,
  ClioValidationError,
  safeToolMessage,
  type ClioToolOutcome,
} from "./toolShared";

type Db = ReturnType<typeof createServerSupabase>;

export interface ClioManageToolContext {
  db: Db;
  userId: string;
  userEmail?: string | null;
}

// A document saved to Clio must fit the same 25 MB envelope as the CH proxy.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_TIME_ENTRY_MINUTES = 24 * 60; // reject absurd (>24h) single entries.

/**
 * Convert whole/fractional minutes to the SECONDS Clio's `activities.quantity`
 * expects (verified 03/08: 360 → 6 min). Rejects non-positive and absurd
 * (>24h) durations with a fixed, user-safe message. Exported for unit testing.
 */
export function minutesToSeconds(minutes: unknown): number {
  const value =
    typeof minutes === "number"
      ? minutes
      : typeof minutes === "string"
        ? Number(minutes)
        : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    throw new ClioValidationError(
      "Enter the time to record as a positive number of minutes.",
    );
  }
  if (value > MAX_TIME_ENTRY_MINUTES) {
    throw new ClioValidationError(
      "That time entry is too long — record no more than 24 hours in a single entry.",
    );
  }
  return Math.round(value * 60);
}

export const CLIO_MANAGE_TOOLS: OpenAIToolSchema[] = [
  {
    type: "function",
    function: {
      name: "clio_find_matter",
      description:
        "Search the user's Clio Manage matters by name, client, or matter number. Returns each matter's id, display number, description, status, and client. Use this to resolve a matter id before recording time or saving a document.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Matter name, client name, or matter/display number.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clio_find_contact",
      description:
        "Search the user's Clio Manage contacts (people and companies) by name. Returns each contact's id, name, type, and primary email/phone.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Contact name to search for." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clio_matter_financials",
      description:
        "Read Clio Manage financials: unbilled work-in-progress per matter (billable_matters) and outstanding billed-but-unpaid balances per client (outstanding_client_balances). Optionally narrow by a matter id or a contact id.",
      parameters: {
        type: "object",
        properties: {
          matter_id: {
            type: "string",
            description:
              "Optional Clio matter id to focus the unbilled WIP figures on.",
          },
          contact_id: {
            type: "string",
            description:
              "Optional Clio contact id to focus the outstanding balance on.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clio_record_time",
      description:
        "Record a time entry against a Clio Manage matter. Provide the matter id, the duration in MINUTES (converted to seconds for Clio), a description, an optional date (YYYY-MM-DD, defaults to today), and whether it is billable. Always confirm the details with the user before calling this — it writes to Clio.",
      parameters: {
        type: "object",
        properties: {
          matter_id: { type: "string", description: "Clio matter id." },
          minutes: {
            type: "number",
            description: "Duration in minutes (positive, no more than 1440).",
          },
          description: {
            type: "string",
            description: "What the time was spent on (the activity note).",
          },
          date: {
            type: "string",
            description: "Activity date, YYYY-MM-DD. Defaults to today.",
          },
          billable: {
            type: "boolean",
            description: "Whether the entry is billable. Defaults to true.",
          },
        },
        required: ["matter_id", "minutes", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clio_list_matter_documents",
      description:
        "List the documents on a Clio Manage matter (id, name, created date). Provide the matter id.",
      parameters: {
        type: "object",
        properties: {
          matter_id: { type: "string", description: "Clio matter id." },
        },
        required: ["matter_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clio_save_document_to_matter",
      description:
        "Upload one of the user's JessicaOS documents to a Clio Manage matter. Provide the JessicaOS document id (the user must have access to it) and the target Clio matter id. Confirm with the user before calling — it writes to Clio.",
      parameters: {
        type: "object",
        properties: {
          document_id: {
            type: "string",
            description: "The JessicaOS document id to upload.",
          },
          matter_id: { type: "string", description: "Target Clio matter id." },
          name: {
            type: "string",
            description:
              "Optional filename to save it as in Clio. Defaults to the document's own name.",
          },
        },
        required: ["document_id", "matter_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clio_delete_time_entry",
      description:
        "Delete a Clio Manage time entry (activity) by its id — an undo for an entry created in this session. Confirm with the user before calling.",
      parameters: {
        type: "object",
        properties: {
          activity_id: {
            type: "string",
            description: "Clio activity (time entry) id to delete.",
          },
        },
        required: ["activity_id"],
      },
    },
  },
];

export const CLIO_MANAGE_SYSTEM_PROMPT = `CLIO MANAGE (the user's connected practice-management system):
- You can search matters (clio_find_matter) and contacts (clio_find_contact), read matter financials (clio_matter_financials), list matter documents (clio_list_matter_documents), record time (clio_record_time), save a JessicaOS document to a matter (clio_save_document_to_matter), and delete a time entry you created this session (clio_delete_time_entry).
- Clio enforces each user's own matter permissions — you only ever see and change data this user is permitted to. If a call returns a permissions error, tell the user plainly; never guess around it.
- Before any WRITE (recording time, saving a document, deleting a time entry) restate the exact details and get the user's explicit go-ahead in the conversation first. Report time durations in minutes/hours to the user even though Clio stores seconds.
- Resolve a matter with clio_find_matter before recording time or saving a document — never invent a matter id.`;

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v);
}

async function findMatter(
  ctx: ClioManageToolContext,
  args: Record<string, unknown>,
): Promise<ClioToolOutcome> {
  const query = asString(args.query);
  if (!query) throw new ClioValidationError("A search query is required.");
  const body = await clioRequest(
    ctx.db,
    ctx.userId,
    "manage",
    "/matters.json",
    {
      fields: "id,display_number,description,status,client{id,name}",
      query: { query, limit: 10 },
    },
  );
  return clioToolOk("manage", "clio_find_matter", body);
}

async function findContact(
  ctx: ClioManageToolContext,
  args: Record<string, unknown>,
): Promise<ClioToolOutcome> {
  const query = asString(args.query);
  if (!query) throw new ClioValidationError("A search query is required.");
  const body = await clioRequest(
    ctx.db,
    ctx.userId,
    "manage",
    "/contacts.json",
    {
      fields:
        "id,name,type,primary_email_address{address},primary_phone_number{number}",
      query: { query, limit: 10 },
    },
  );
  return clioToolOk("manage", "clio_find_contact", body);
}

async function matterFinancials(
  ctx: ClioManageToolContext,
  args: Record<string, unknown>,
): Promise<ClioToolOutcome> {
  const matterId = asString(args.matter_id);
  const contactId = asString(args.contact_id);
  // Filter params are best-effort — Clio returns the list either way, so an
  // unrecognised filter degrades to "all", never an error.
  const billable = await clioRequest(
    ctx.db,
    ctx.userId,
    "manage",
    "/billable_matters.json",
    {
      fields:
        "id,unbilled_amount,unbilled_hours,matter{id,display_number,client{name}}",
      query: { ...(matterId ? { matter_id: matterId } : {}), limit: 20 },
    },
  );
  const outstanding = await clioRequest(
    ctx.db,
    ctx.userId,
    "manage",
    "/outstanding_client_balances.json",
    {
      fields: "id,total_outstanding_balance,contact{id,name}",
      query: { ...(contactId ? { contact_id: contactId } : {}), limit: 20 },
    },
  );
  return clioToolOk("manage", "clio_matter_financials", {
    billable_matters: billable,
    outstanding_client_balances: outstanding,
  });
}

async function recordTime(
  ctx: ClioManageToolContext,
  args: Record<string, unknown>,
): Promise<ClioToolOutcome> {
  const matterId = asString(args.matter_id);
  if (!matterId) throw new ClioValidationError("A matter id is required.");
  const description = asString(args.description);
  if (!description) {
    throw new ClioValidationError("A description of the work is required.");
  }
  const quantitySeconds = minutesToSeconds(args.minutes);
  const date = asString(args.date) || new Date().toISOString().slice(0, 10);
  const billable = args.billable === undefined ? true : args.billable === true;

  const body = await clioRequest(
    ctx.db,
    ctx.userId,
    "manage",
    "/activities.json",
    {
      method: "POST",
      fields:
        "id,type,date,quantity,note,non_billable,matter{id,display_number}",
      json: {
        data: {
          type: "TimeEntry",
          matter: { id: Number(matterId) || matterId },
          quantity: quantitySeconds,
          date,
          note: description,
          non_billable: !billable,
        },
      },
    },
  );
  return clioToolOk("manage", "clio_record_time", body, body);
}

async function listMatterDocuments(
  ctx: ClioManageToolContext,
  args: Record<string, unknown>,
): Promise<ClioToolOutcome> {
  const matterId = asString(args.matter_id);
  if (!matterId) throw new ClioValidationError("A matter id is required.");
  const body = await clioRequest(
    ctx.db,
    ctx.userId,
    "manage",
    "/documents.json",
    {
      fields: "id,name,created_at,latest_document_version{uuid,fully_uploaded}",
      query: { matter_id: matterId, limit: 25 },
    },
  );
  return clioToolOk("manage", "clio_list_matter_documents", body);
}

async function deleteTimeEntry(
  ctx: ClioManageToolContext,
  args: Record<string, unknown>,
): Promise<ClioToolOutcome> {
  const activityId = asString(args.activity_id);
  if (!activityId)
    throw new ClioValidationError("A time entry id is required.");
  await clioRequest(
    ctx.db,
    ctx.userId,
    "manage",
    `/activities/${encodeURIComponent(activityId)}.json`,
    { method: "DELETE" },
  );
  return clioToolOk(
    "manage",
    "clio_delete_time_entry",
    { deleted: true, activity_id: activityId },
    { deleted: true, activity_id: activityId },
  );
}

interface MultipartInstruction {
  part_number?: number;
  put_url?: string;
  put_headers?: Array<{ name?: string; value?: string }>;
}

/**
 * The three-step Clio document upload (verified 03/08):
 *   1. POST /documents.json with metadata + a single multipart part
 *      (content_length + base64 content_md5) → put_url + put_headers,
 *   2. PUT the raw bytes to put_url with the returned headers (NO bearer —
 *      it is a presigned URL), and
 *   3. PATCH /documents/{id}.json { uuid, fully_uploaded: true } to finalise.
 */
async function saveDocumentToMatter(
  ctx: ClioManageToolContext,
  args: Record<string, unknown>,
): Promise<ClioToolOutcome> {
  const documentId = asString(args.document_id);
  const matterId = asString(args.matter_id);
  if (!documentId) throw new ClioValidationError("A document id is required.");
  if (!matterId) throw new ClioValidationError("A matter id is required.");

  // Load + access-check the JessicaOS document (enforces ownership / firm
  // visibility / tombstone via the shared choke point).
  const { data: doc, error } = await ctx.db
    .from("documents")
    .select("id, user_id, project_id, filename")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw error;
  if (!doc) throw new ClioValidationError("That document could not be found.");

  const docRow = doc as {
    id: string;
    user_id: string;
    project_id: string | null;
    filename: string | null;
  };
  const userOrgId = await getUserOrganisationId(ctx.db, ctx.userId);
  const access = await ensureDocAccess(
    docRow,
    ctx.userId,
    ctx.userEmail,
    ctx.db,
    userOrgId,
  );
  if (!access.ok) {
    throw new ClioValidationError("You do not have access to that document.");
  }

  const active = await loadActiveVersion(documentId, ctx.db);
  if (!active) {
    throw new ClioValidationError(
      "That document has no saved content to upload.",
    );
  }
  const raw = await downloadFile(active.storage_path);
  if (!raw) {
    throw new ClioValidationError("That document's content could not be read.");
  }
  const bytes = Buffer.from(raw);
  if (bytes.byteLength === 0) {
    throw new ClioValidationError("That document is empty.");
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new ClioValidationError(
      "That document is too large to save to Clio (25 MB limit).",
    );
  }

  const name =
    asString(args.name) || active.filename || docRow.filename || "document";
  const contentMd5 = createHash("md5").update(bytes).digest("base64");

  // Step 1: create the document + get the presigned upload instruction.
  const created = (await clioRequest(
    ctx.db,
    ctx.userId,
    "manage",
    "/documents.json",
    {
      method: "POST",
      fields: "id,latest_document_version{uuid,put_url,put_headers,multiparts}",
      json: {
        data: {
          name,
          parent: { id: Number(matterId) || matterId, type: "Matter" },
          multiparts: [
            {
              part_number: 1,
              content_length: bytes.byteLength,
              content_md5: contentMd5,
            },
          ],
        },
      },
    },
  )) as {
    data?: {
      id?: unknown;
      latest_document_version?: {
        uuid?: unknown;
        put_url?: unknown;
        put_headers?: unknown;
        multiparts?: MultipartInstruction[];
      };
    };
  } | null;

  const docData = created?.data;
  const version = docData?.latest_document_version;
  const clioDocId = docData?.id != null ? String(docData.id) : "";
  const uuid = version?.uuid != null ? String(version.uuid) : "";
  // The upload target lives either at the top level or on the single multipart.
  const part = Array.isArray(version?.multiparts)
    ? version?.multiparts?.[0]
    : undefined;
  const putUrl =
    (typeof version?.put_url === "string" && version.put_url) ||
    (typeof part?.put_url === "string" && part.put_url) ||
    "";
  const putHeadersRaw = Array.isArray(version?.put_headers)
    ? version?.put_headers
    : Array.isArray(part?.put_headers)
      ? part?.put_headers
      : [];
  if (!clioDocId || !uuid || !putUrl) {
    throw new ClioValidationError(
      "Clio did not accept the document upload. Please try again.",
    );
  }

  // Step 2: PUT the bytes to the presigned URL. This is NOT the Clio API host
  // and carries its own auth in the returned headers — never attach the bearer.
  const putHeaders: Record<string, string> = {};
  for (const h of putHeadersRaw as Array<{ name?: unknown; value?: unknown }>) {
    if (typeof h?.name === "string" && typeof h?.value === "string") {
      putHeaders[h.name] = h.value;
    }
  }
  let putRes: Response;
  try {
    putRes = await fetch(putUrl, {
      method: "PUT",
      headers: putHeaders,
      body: bytes,
    });
  } catch {
    throw new ClioValidationError(
      "Could not upload the document to Clio. Please try again.",
    );
  }
  if (!putRes.ok) {
    throw new ClioValidationError(
      "Could not upload the document to Clio. Please try again.",
    );
  }

  // Step 3: finalise.
  const finalised = await clioRequest(
    ctx.db,
    ctx.userId,
    "manage",
    `/documents/${encodeURIComponent(clioDocId)}.json`,
    {
      method: "PATCH",
      fields: "id,name,created_at,matter{id,display_number}",
      json: { data: { uuid, fully_uploaded: true } },
    },
  );
  return clioToolOk(
    "manage",
    "clio_save_document_to_matter",
    finalised,
    finalised,
  );
}

export async function executeClioManageToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ClioManageToolContext,
): Promise<ClioToolOutcome> {
  try {
    switch (name) {
      case "clio_find_matter":
        return await findMatter(ctx, args);
      case "clio_find_contact":
        return await findContact(ctx, args);
      case "clio_matter_financials":
        return await matterFinancials(ctx, args);
      case "clio_record_time":
        return await recordTime(ctx, args);
      case "clio_list_matter_documents":
        return await listMatterDocuments(ctx, args);
      case "clio_save_document_to_matter":
        return await saveDocumentToMatter(ctx, args);
      case "clio_delete_time_entry":
        return await deleteTimeEntry(ctx, args);
      default:
        return clioToolError("manage", name, `Unknown Clio tool '${name}'.`);
    }
  } catch (err) {
    return clioToolError("manage", name, safeToolMessage(err));
  }
}
