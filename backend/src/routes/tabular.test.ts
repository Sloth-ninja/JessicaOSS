import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Focused suite for PATCH /tabular-review/:reviewId/visibility (WS9): owner-only,
// orgless 403, project-scoped rejection, and audit. DB-level predicate atomicity
// is covered by firmVisibility.test.ts.
const state = vi.hoisted(() => ({
  orgId: "org-1" as string | null,
  outcome: "updated" as "updated" | "not_found" | "unsupported",
  review: { id: "r1", user_id: "owner", project_id: null } as
    | { id: string; user_id: string; project_id: string | null }
    | null,
  // WS8×WS9: when true, getTombstonedIds reports the review as soft-deleted so
  // ensureReviewAccess denies it at the choke point.
  reviewTombstoned: false,
  // Last UPDATE payload seen by the fake db (template-linkage assertions).
  lastUpdate: null as Record<string, unknown> | null,
}));

vi.mock("../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "owner";
    res.locals.userEmail = "owner@firm.test";
    res.locals.token = "token";
    next();
  },
}));

// Minimal fake: the route reads the review via
// .from("tabular_reviews").select(...).eq("id", …).single(), and PATCH writes it
// back via .update(patch).eq("id", …).select("*").single(). The last update
// payload is captured in state so the template-linkage tests can assert it.
vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () =>
            Promise.resolve({
              data: state.review,
              error: state.review ? null : { code: "PGRST116" },
            }),
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        state.lastUpdate = patch;
        return {
          eq: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: { ...state.review, ...patch },
                  error: null,
                }),
            }),
          }),
        };
      },
    }),
  }),
}));

const setResourceVisibility = vi.fn();
vi.mock("../lib/firmVisibility", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/firmVisibility")>();
  return {
    ...actual,
    setResourceVisibility: (...args: unknown[]) => setResourceVisibility(...args),
  };
});

const getUserOrganisationId = vi.fn();
vi.mock("../lib/organisations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/organisations")>();
  return {
    ...actual,
    getUserOrganisationId: (...args: unknown[]) => getUserOrganisationId(...args),
  };
});

const insertDeletionAudit = vi.fn();
vi.mock("../lib/deletionGovernance", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/deletionGovernance")>();
  return {
    ...actual,
    insertDeletionAudit: (...args: unknown[]) => insertDeletionAudit(...args),
    // ensureReviewAccess (real) consults this to gate on the review's tombstone.
    getTombstonedIds: (_db: unknown, type: string) =>
      Promise.resolve(
        state.reviewTombstoned && type === "tabular-review"
          ? new Set([state.review?.id])
          : new Set(),
      ),
  };
});

import { tabularRouter } from "./tabular";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/tabular-review", tabularRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
);

beforeEach(() => {
  state.orgId = "org-1";
  state.outcome = "updated";
  state.review = { id: "r1", user_id: "owner", project_id: null };
  state.reviewTombstoned = false;
  state.lastUpdate = null;
  getUserOrganisationId.mockReset().mockImplementation(() =>
    Promise.resolve(state.orgId),
  );
  setResourceVisibility
    .mockReset()
    .mockImplementation(() => Promise.resolve(state.outcome));
  insertDeletionAudit.mockReset().mockResolvedValue(undefined);
});

const patchVisibility = (reviewId: string, body: unknown) =>
  fetch(`${baseUrl}/tabular-review/${reviewId}/visibility`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PATCH /tabular-review/:reviewId/visibility", () => {
  it("rejects an invalid visibility with 400", async () => {
    const res = await patchVisibility("r1", { visibility: "public" });
    expect(res.status).toBe(400);
    expect(setResourceVisibility).not.toHaveBeenCalled();
  });

  it("returns 403 for an orgless caller", async () => {
    state.orgId = null;
    const res = await patchVisibility("r1", { visibility: "firm" });
    expect(res.status).toBe(403);
    expect(setResourceVisibility).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown review", async () => {
    state.review = null;
    const res = await patchVisibility("r1", { visibility: "firm" });
    expect(res.status).toBe(404);
    expect(setResourceVisibility).not.toHaveBeenCalled();
  });

  it("returns 404 for a non-owner (owner-only)", async () => {
    state.review = { id: "r1", user_id: "someone-else", project_id: null };
    const res = await patchVisibility("r1", { visibility: "firm" });
    expect(res.status).toBe(404);
    expect(setResourceVisibility).not.toHaveBeenCalled();
  });

  it("rejects a project-scoped review with a fixed 400 (inherits the matter)", async () => {
    state.review = { id: "r1", user_id: "owner", project_id: "p1" };
    const res = await patchVisibility("r1", { visibility: "firm" });
    expect(res.status).toBe(400);
    expect(setResourceVisibility).not.toHaveBeenCalled();
  });

  it("flips a standalone review to firm and audits 'firm_shared'", async () => {
    const res = await patchVisibility("r1", { visibility: "firm" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "r1",
      visibility: "firm",
      organisation_id: "org-1",
    });
    expect(setResourceVisibility).toHaveBeenCalledWith(
      expect.anything(),
      "tabular_review",
      "r1",
      "owner",
      { visibility: "firm", organisationId: "org-1" },
    );
    expect(insertDeletionAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "firm_shared",
        // Audit column uses the hyphenated deletion-governance vocabulary,
        // even though the firm-visibility call above uses the underscore form.
        resourceType: "tabular-review",
        resourceId: "r1",
      }),
    );
  });

  it("returns 404 when the flip matches no owned row", async () => {
    state.outcome = "not_found";
    const res = await patchVisibility("r1", { visibility: "firm" });
    expect(res.status).toBe(404);
    expect(insertDeletionAudit).not.toHaveBeenCalled();
  });
});

// Template linkage: tabular_reviews.workflow_id names the template a review was
// started from — the value the firm usage dashboard attributes runs to. It is a
// uuid FK, so built-in templates (client-side constants with "builtin-…" ids)
// must never be sent, and applying one in-grid CLEARS the linkage.
describe("PATCH /tabular-review/:reviewId — template linkage (workflow_id)", () => {
  const patchReview = (body: unknown) =>
    fetch(`${baseUrl}/tabular-review/r1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("stores a uuid workflow_id when a saved template is applied", async () => {
    const templateId = "11111111-2222-4333-8444-555555555555";
    const res = await patchReview({ workflow_id: templateId });
    expect(res.status).toBe(200);
    expect(state.lastUpdate).toMatchObject({ workflow_id: templateId });
  });

  it("clears the linkage when null is sent (a built-in was applied)", async () => {
    const res = await patchReview({ workflow_id: null });
    expect(res.status).toBe(200);
    expect(state.lastUpdate).toMatchObject({ workflow_id: null });
  });

  it("leaves the linkage untouched when workflow_id is absent", async () => {
    const res = await patchReview({ title: "Renamed" });
    expect(res.status).toBe(200);
    expect(state.lastUpdate).not.toHaveProperty("workflow_id");
  });

  it("rejects a built-in id with a fixed 400 before touching the database", async () => {
    const res = await patchReview({ workflow_id: "builtin-nda" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      detail: "workflow_id must be a template id or null",
    });
    expect(state.lastUpdate).toBeNull();
  });

  it("rejects a non-owner's attempt to re-point the template", async () => {
    state.review = { id: "r1", user_id: "someone-else", project_id: null };
    const res = await patchReview({
      workflow_id: "11111111-2222-4333-8444-555555555555",
    });
    // A non-owner cannot even read this review in the fake (shared_with is
    // absent), so the access check answers first — either way, no write.
    expect([403, 404]).toContain(res.status);
    expect(state.lastUpdate).toBeNull();
  });
});

// Representative content sub-route: the /generate WRITE path must 404 on a
// tombstoned review, via ensureReviewAccess's folded-in tombstone gate (WS8×WS9).
// The owner is the caller, so without the tombstone the row would be accessible —
// proving the 404 comes from the tombstone gate, not from a membership miss.
describe("POST /tabular-review/:reviewId/generate — tombstoned review is denied", () => {
  const generate = (reviewId: string) =>
    fetch(`${baseUrl}/tabular-review/${reviewId}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

  it("404s the owner's write when the review is tombstoned", async () => {
    state.reviewTombstoned = true;
    const res = await generate("r1");
    expect(res.status).toBe(404);
  });
});
