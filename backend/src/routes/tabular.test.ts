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
// .from("tabular_reviews").select(...).eq("id", …).single().
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
        resourceType: "tabular_review",
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
