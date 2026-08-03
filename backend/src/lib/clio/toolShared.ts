// Shared shapes + helpers for the Clio chat tools (Manage + Grow). Mirrors the
// Companies House tool seam: each tool returns a `content` string (fed back to
// the model) and a structured `event` (streamed to the frontend so it can show
// a confirmation card for writes). Errors are always a fixed, generic message —
// raw Clio/DB text never reaches the model or the user.

import { ClioApiError } from "./client";
import type { ClioProduct } from "./config";

export interface ClioToolEvent {
  type: "clio_tool_call";
  product: ClioProduct;
  tool_name: string;
  status: "ok" | "error";
  error?: string;
  /** Optional structured payload for the frontend (e.g. a created time entry). */
  result?: unknown;
}

export interface ClioToolOutcome {
  content: string;
  event: ClioToolEvent;
}

/** A user-safe validation failure raised by a tool before any API call. */
export class ClioValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClioValidationError";
  }
}

/**
 * Map any thrown error onto a fixed, user-safe message. Known Clio/validation
 * errors already carry safe messages; anything else collapses to a generic
 * line so raw provider/DB text is never surfaced.
 */
export function safeToolMessage(err: unknown): string {
  if (err instanceof ClioValidationError) return err.message;
  if (err instanceof ClioApiError) return err.message;
  return "Something went wrong talking to Clio. Please try again.";
}

export function clioToolOk(
  product: ClioProduct,
  toolName: string,
  payload: unknown,
  result?: unknown,
): ClioToolOutcome {
  return {
    content: JSON.stringify(payload),
    event: {
      type: "clio_tool_call",
      product,
      tool_name: toolName,
      status: "ok",
      ...(result !== undefined ? { result } : {}),
    },
  };
}

export function clioToolError(
  product: ClioProduct,
  toolName: string,
  message: string,
): ClioToolOutcome {
  return {
    content: JSON.stringify({ error: message }),
    event: {
      type: "clio_tool_call",
      product,
      tool_name: toolName,
      status: "error",
      error: message,
    },
  };
}
