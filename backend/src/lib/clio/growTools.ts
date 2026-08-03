// Clio Grow ("Clio Platform") chat tools: watch the firm's intake pipeline and
// annotate intake matters with notes. Grow is read-heavy (no status writes, no
// documents, no webhooks); the durable machine-readable artefact Jessica can
// leave is a matter note (e.g. a Companies House conflict/KYB summary).
//
// Gated on the caller having Clio Grow connected (absent connection => the
// tools are never offered; the executor re-checks). Endpoint verification
// (spike 03/08, live token): `GET /matters` is LIVE-VERIFIED (verbatim firm
// statuses, status_category, clio_id). The matter-note read/write endpoints
// (`GET`/`POST /matters/{id}/notes`) remain research-based — not yet probed
// against a live note — so those two tools follow the research doc. All
// failures return a fixed, friendly error rather than leaking raw Clio text.

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

export interface ClioGrowToolContext {
  db: Db;
  userId: string;
}

const NOTE_SUBJECT_MAX = 255;
const NOTE_BODY_MAX = 65535;

export const CLIO_GROW_TOOLS: OpenAIToolSchema[] = [
  {
    type: "function",
    function: {
      name: "clio_intake_status",
      description:
        "List the user's Clio Grow intake matters (prospective clients moving through the firm's intake pipeline). Returns each matter's id, the firm's own pipeline status string (verbatim), its status category (intake/hired/declined), and clio_id (the Clio Manage id once converted). Optionally filter by a status string.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description:
              "Optional pipeline status to filter by (matches the firm's own status strings, e.g. 'KYC Check').",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clio_intake_notes",
      description:
        "Read the notes on a Clio Grow intake matter. Provide the Grow matter id.",
      parameters: {
        type: "object",
        properties: {
          matter_id: { type: "string", description: "Clio Grow matter id." },
        },
        required: ["matter_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clio_add_intake_note",
      description:
        "Add a note to a Clio Grow intake matter — the durable place to record intake research (e.g. a conflict/KYB summary). Provide the Grow matter id, a short subject, and the note body. Confirm with the user before calling — it writes to Clio.",
      parameters: {
        type: "object",
        properties: {
          matter_id: { type: "string", description: "Clio Grow matter id." },
          subject: {
            type: "string",
            description: "Short note subject (max 255 characters).",
          },
          body: {
            type: "string",
            description: "The note body (max 65535 characters).",
          },
        },
        required: ["matter_id", "subject", "body"],
      },
    },
  },
];

export const CLIO_GROW_SYSTEM_PROMPT = `CLIO GROW (the user's connected client-intake system):
- You can list intake matters and their pipeline status (clio_intake_status), read a matter's notes (clio_intake_notes), and add a note to a matter (clio_add_intake_note).
- Grow is read-only apart from notes: you cannot move a matter's status, upload documents, or convert to a Manage matter — those are done by a person in Clio. Report the firm's pipeline status strings exactly as they come back; never paraphrase them into a different scheme.
- Adding a note WRITES to Clio — restate the subject and body and get the user's explicit go-ahead first. A note is the right place to record intake research such as a Companies House conflict or KYB summary.`;

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v);
}

async function intakeStatus(
  ctx: ClioGrowToolContext,
  args: Record<string, unknown>,
): Promise<ClioToolOutcome> {
  const status = asString(args.status);
  const body = await clioRequest(ctx.db, ctx.userId, "grow", "/matters", {
    query: { ...(status ? { status } : {}), limit: 25 },
  });
  return clioToolOk("grow", "clio_intake_status", body);
}

async function intakeNotes(
  ctx: ClioGrowToolContext,
  args: Record<string, unknown>,
): Promise<ClioToolOutcome> {
  const matterId = asString(args.matter_id);
  if (!matterId) throw new ClioValidationError("A matter id is required.");
  const body = await clioRequest(
    ctx.db,
    ctx.userId,
    "grow",
    `/matters/${encodeURIComponent(matterId)}/notes`,
    { query: { limit: 25 } },
  );
  return clioToolOk("grow", "clio_intake_notes", body);
}

async function addIntakeNote(
  ctx: ClioGrowToolContext,
  args: Record<string, unknown>,
): Promise<ClioToolOutcome> {
  const matterId = asString(args.matter_id);
  const subject = asString(args.subject);
  const noteBody = asString(args.body);
  if (!matterId) throw new ClioValidationError("A matter id is required.");
  if (!subject) throw new ClioValidationError("A note subject is required.");
  if (!noteBody) throw new ClioValidationError("A note body is required.");
  if (subject.length > NOTE_SUBJECT_MAX) {
    throw new ClioValidationError(
      `The note subject must be ${NOTE_SUBJECT_MAX} characters or fewer.`,
    );
  }
  if (noteBody.length > NOTE_BODY_MAX) {
    throw new ClioValidationError(
      `The note body must be ${NOTE_BODY_MAX} characters or fewer.`,
    );
  }
  const created = await clioRequest(
    ctx.db,
    ctx.userId,
    "grow",
    `/matters/${encodeURIComponent(matterId)}/notes`,
    {
      method: "POST",
      json: { subject, body: noteBody },
    },
  );
  return clioToolOk("grow", "clio_add_intake_note", created, created);
}

export async function executeClioGrowToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ClioGrowToolContext,
): Promise<ClioToolOutcome> {
  try {
    switch (name) {
      case "clio_intake_status":
        return await intakeStatus(ctx, args);
      case "clio_intake_notes":
        return await intakeNotes(ctx, args);
      case "clio_add_intake_note":
        return await addIntakeNote(ctx, args);
      default:
        return clioToolError("grow", name, `Unknown Clio tool '${name}'.`);
    }
  } catch (err) {
    return clioToolError("grow", name, safeToolMessage(err));
  }
}
