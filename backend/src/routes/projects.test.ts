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

// Focused suite for PATCH /projects/:projectId/visibility (WS9). The DB-level
// owner predicate is covered by firmVisibility.test.ts; here we assert the
// route's validation, orgless 403, audit action, and response shape.
const state = vi.hoisted(() => ({
  orgId: "org-1" as string | null,
  outcome: "updated" as "updated" | "not_found" | "unsupported",
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

vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => ({}),
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

import { projectsRouter } from "./projects";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/projects", projectsRouter);
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
  getUserOrganisationId.mockReset().mockImplementation(() =>
    Promise.resolve(state.orgId),
  );
  setResourceVisibility
    .mockReset()
    .mockImplementation(() => Promise.resolve(state.outcome));
  insertDeletionAudit.mockReset().mockResolvedValue(undefined);
});

const patchVisibility = (projectId: string, body: unknown) =>
  fetch(`${baseUrl}/projects/${projectId}/visibility`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PATCH /projects/:projectId/visibility", () => {
  it("rejects an invalid visibility with 400", async () => {
    const res = await patchVisibility("p1", { visibility: "public" });
    expect(res.status).toBe(400);
    expect(setResourceVisibility).not.toHaveBeenCalled();
  });

  it("returns 403 for an orgless caller (feature does not exist)", async () => {
    state.orgId = null;
    const res = await patchVisibility("p1", { visibility: "firm" });
    expect(res.status).toBe(403);
    expect(setResourceVisibility).not.toHaveBeenCalled();
  });

  it("returns 404 when the flip matches no owned row (non-owner)", async () => {
    state.outcome = "not_found";
    const res = await patchVisibility("p1", { visibility: "firm" });
    expect(res.status).toBe(404);
    expect(insertDeletionAudit).not.toHaveBeenCalled();
  });

  it("flips to firm, stamps the owner's org, and audits 'firm_shared'", async () => {
    const res = await patchVisibility("p1", { visibility: "firm" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "p1",
      visibility: "firm",
      organisation_id: "org-1",
    });
    expect(setResourceVisibility).toHaveBeenCalledWith(
      expect.anything(),
      "project",
      "p1",
      "owner",
      { visibility: "firm", organisationId: "org-1" },
    );
    expect(insertDeletionAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organisationId: "org-1",
        actorUserId: "owner",
        action: "firm_shared",
        resourceType: "project",
        resourceId: "p1",
      }),
    );
  });

  it("reverts to private (organisation_id null) and audits 'firm_reverted'", async () => {
    const res = await patchVisibility("p1", { visibility: "private" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "p1",
      visibility: "private",
      organisation_id: null,
    });
    expect(insertDeletionAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "firm_reverted" }),
    );
  });
});
