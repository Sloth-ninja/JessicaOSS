const SECRET_CONTEXT_PATTERNS = [
  /(Incorrect API key provided:\s*)([^.\s]+)(\.?)/gi,
  /(api[_ -]?key|x-api-key|token|secret|authorization|bearer)\s*(?:provided\s*)?(?:is|:|=)\s*["']?([A-Za-z0-9._\-]{6,})["']?/gi,
];

const PROVIDER_KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_\-]{12,}\b/g,
  /\bsk-ant-[A-Za-z0-9_\-]{12,}\b/g,
  /\bsk-or-[A-Za-z0-9_\-]{12,}\b/g,
  /\bAIza[A-Za-z0-9_\-]{20,}\b/g,
];

export function redactSensitiveText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_CONTEXT_PATTERNS) {
    redacted = redacted.replace(pattern, (match, ...groups: string[]) => {
      if (match.toLowerCase().startsWith("incorrect api key provided:")) {
        return `${groups[0]}[redacted]${groups[2] ?? ""}`;
      }
      const secret = groups[1];
      return secret ? match.replace(secret, "[redacted]") : match;
    });
  }
  for (const pattern of PROVIDER_KEY_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  return redacted;
}

/**
 * Known diagnostic string fields on a non-Error thrown value — most importantly
 * supabase-js PostgrestError ({ message, code?, details?, hint? }), which
 * reaches these helpers as a plain object in production. Only these known
 * string fields are ever read; the object is never logged wholesale.
 * (Error-visibility incident 04/08/2026: such objects used to flatten to the
 * literal "Unexpected error", hiding the real cause from Fly logs.)
 */
function messageBearingParts(error: unknown): {
  message: string;
  code: string | null;
  details: string | null;
  hint: string | null;
} | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.message !== "string" || !candidate.message) return null;
  const str = (value: unknown): string | null =>
    typeof value === "string" && value ? value : null;
  return {
    message: candidate.message,
    code: str(candidate.code),
    details: str(candidate.details),
    hint: str(candidate.hint),
  };
}

export function safeErrorMessage(
  error: unknown,
  fallback = "Unexpected error",
): string {
  const message =
    error instanceof Error && error.message
      ? error.message
      : typeof error === "string"
        ? error
        : (messageBearingParts(error)?.message ?? fallback);
  return redactSensitiveText(message);
}

export function safeErrorLog(error: unknown): {
  name: string | null;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name || null,
      message: redactSensitiveText(error.message || "Unexpected error"),
      stack: error.stack ? redactSensitiveText(error.stack) : undefined,
    };
  }
  const parts = messageBearingParts(error);
  if (parts) {
    let message = parts.message;
    if (parts.details) message += ` | details: ${parts.details}`;
    if (parts.hint) message += ` | hint: ${parts.hint}`;
    return {
      name: parts.code,
      message: redactSensitiveText(message),
    };
  }
  return {
    name: null,
    message: safeErrorMessage(error),
  };
}

/**
 * The fixed, generic client-facing failure `detail` (the #22 contract): raw
 * provider/DB text is logged server-side only and never sent to the browser.
 */
export const GENERIC_ERROR_DETAIL = "Something went wrong. Please try again.";

/** Structural subset of an Express Response — keeps this lib dependency-free. */
type JsonResponder = {
  headersSent: boolean;
  status(code: number): { json(body: unknown): unknown };
};

/**
 * Log a DB/provider/library failure server-side (redacted, via safeErrorLog)
 * and respond with a FIXED `detail` — never the raw error message.
 * Error-visibility incident 04/08/2026: `detail: error.message` sites leaked
 * raw Supabase text to the browser while logging nothing server-side.
 */
export function failRequest(
  res: JsonResponder,
  scope: string,
  error: unknown,
  status = 500,
  detail = GENERIC_ERROR_DETAIL,
): void {
  console.error(scope, safeErrorLog(error));
  if (!res.headersSent) res.status(status).json({ detail });
}
