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
  // Sub-route (people) fixtures: the matter the fake DB returns, and whether
  // getTombstonedIds reports it soft-deleted (WS8×WS9 choke-point gate).
  project: {
    id: "p1",
    user_id: "owner",
    shared_with: [] as string[],
    visibility: "private" as string | null,
    organisation_id: null as string | null,
  } as Record<string, unknown> | null,
  projectTombstoned: false,
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

// Minimal fake: the visibility route only threads `db` into mocked helpers, but
// the /people sub-route reads the matter via .from(...).select(...).eq(...).single()
// (twice — once directly, once inside checkProjectAccess's loadProjectAccessRow).
vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () =>
            Promise.resolve({
              data: state.project,
              error: state.project ? null : { code: "PGRST116" },
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
    // checkProjectAccess (real) consults this to gate on the matter's tombstone.
    getTombstonedIds: (_db: unknown, type: string) =>
      Promise.resolve(
        state.projectTombstoned && type === "project"
          ? new Set([state.project?.id])
          : new Set(),
      ),
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
  state.project = {
    id: "p1",
    user_id: "owner",
    shared_with: [],
    visibility: "private",
    organisation_id: null,
  };
  state.projectTombstoned = false;
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

// Representative content sub-route: GET /:projectId/people must 404 on a
// tombstoned matter, via checkProjectAccess's folded-in tombstone gate (WS8×WS9).
// The owner is the caller, so a live matter would pass the access gate — proving
// the 404 comes from the tombstone, not a membership miss or a missing row.
describe("GET /projects/:projectId/people — tombstoned matter is denied", () => {
  const people = (projectId: string) =>
    fetch(`${baseUrl}/projects/${projectId}/people`);

  it("404s the owner when the matter is tombstoned", async () => {
    state.projectTombstoned = true;
    const res = await people("p1");
    expect(res.status).toBe(404);
  });
});
