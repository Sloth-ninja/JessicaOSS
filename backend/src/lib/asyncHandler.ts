import type { NextFunction, Request, Response } from "express";
import { safeErrorLog } from "./safeError";

/**
 * Wraps an async Express route handler so a rejected promise can never escape
 * as an unhandled rejection.
 *
 * Express 4 does not catch rejections thrown by `async` route handlers, and the
 * process-level `unhandledRejection` guard in `index.ts` (added post-#22) keeps
 * the process alive but leaves the request hanging FOREVER — the client sees an
 * infinite spinner (login-spinner incident, 2026-07-21; see
 * docs/DURABLE_LESSONS.md). Any handler whose body is not already wrapped in a
 * whole-body try/catch must go through this wrapper.
 *
 * On an uncaught rejection it degrades honestly: the raw error is logged
 * server-side (redacted via safeErrorLog) and the client gets a FIXED, generic
 * 500 `detail` — raw provider/DB text never reaches users (the #22 contract). If
 * the response has already started (e.g. an SSE stream mid-flight, where the
 * handler owns its own error framing), it only logs and lets the stream finish.
 *
 * Mirrors the local `asyncRoute` pattern already used in `routes/workflows.ts`,
 * but self-responds with JSON rather than forwarding to `next` — there is no
 * global error-handling middleware, so forwarding would fall through to
 * Express's default HTML handler.
 */
export function asyncHandler(
  handler: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => unknown | Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      console.error(
        `[asyncHandler] ${req.method} ${req.originalUrl} failed`,
        safeErrorLog(err),
      );
      if (!res.headersSent) {
        res
          .status(500)
          .json({ detail: "Something went wrong. Please try again." });
      }
    });
  };
}
