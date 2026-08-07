import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Mutable control state for the mocked auth middleware, declared via vi.hoisted
// so the hoisted vi.mock factory can close over it (the routes/admin.test.ts
// idiom).
const state = vi.hoisted(() => ({ authed: true }));

vi.mock("../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: {
      status: (n: number) => { json: (b: unknown) => void };
      locals: Record<string, unknown>;
    },
    next: () => void,
  ) => {
    if (!state.authed) {
      res.status(401).json({ detail: "Missing auth session" });
      return;
    }
    res.locals.userId = "caller";
    res.locals.userEmail = "caller@example.test";
    next();
  },
}));

vi.mock("../lib/supabase", () => ({ createServerSupabase: () => ({}) }));

const listMatters = vi.fn();
const areLinksAvailable = vi.fn();
const getMatterDetail = vi.fn();
const getLinkForMatter = vi.fn();
const listRelatedContacts = vi.fn();
const listActivities = vi.fn();
const updateActivity = vi.fn();
const deleteActivity = vi.fn();
const linkWorkspace = vi.fn();
const unlinkWorkspace = vi.fn();
const createWorkspaceForMatter = vi.fn();

vi.mock("../lib/clio/mattersSurface", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/clio/mattersSurface")>();
  return {
    ...actual,
    listMatters: (...args: unknown[]) => listMatters(...args),
    areLinksAvailable: (...args: unknown[]) => areLinksAvailable(...args),
    getMatterDetail: (...args: unknown[]) => getMatterDetail(...args),
    getLinkForMatter: (...args: unknown[]) => getLinkForMatter(...args),
    listRelatedContacts: (...args: unknown[]) => listRelatedContacts(...args),
    listActivities: (...args: unknown[]) => listActivities(...args),
    updateActivity: (...args: unknown[]) => updateActivity(...args),
    deleteActivity: (...args: unknown[]) => deleteActivity(...args),
    linkWorkspace: (...args: unknown[]) => linkWorkspace(...args),
    unlinkWorkspace: (...args: unknown[]) => unlinkWorkspace(...args),
    createWorkspaceForMatter: (...args: unknown[]) =>
      createWorkspaceForMatter(...args),
  };
});

import { ClioApiError } from "../lib/clio/client";
import { ClioValidationError } from "../lib/clio/toolShared";
import { clioMattersRouter } from "./clioMatters";

const PROJECT_ID = "3f8f3a54-9b5e-4f6e-a9d2-1c2b3d4e5f60";

const LINK = {
  projectId: PROJECT_ID,
  projectName: "0001-0007 — Acme Ltd",
  clioMatterId: "7",
  clioDisplayNumber: "0001-0007",
  createdAt: "2026-08-07T00:00:00.000Z",
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/clio-matters", clioMattersRouter);
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
  state.authed = true;
  listMatters.mockReset().mockResolvedValue({
    matters: [],
    count: 0,
    totalEntries: null,
    capped: false,
    hasMore: false,
    tab: "mine",
  });
  areLinksAvailable.mockReset().mockResolvedValue(true);
  getMatterDetail.mockReset().mockResolvedValue({ id: "7" });
  getLinkForMatter.mockReset().mockResolvedValue(null);
  listRelatedContacts.mockReset().mockResolvedValue([]);
  listActivities.mockReset().mockResolvedValue({
    activities: [],
    count: 0,
    capped: false,
    everyone: false,
  });
  updateActivity.mockReset().mockResolvedValue({ id: "55" });
  deleteActivity.mockReset().mockResolvedValue(undefined);
  linkWorkspace.mockReset().mockResolvedValue(LINK);
  unlinkWorkspace.mockReset().mockResolvedValue("unlinked");
  createWorkspaceForMatter
    .mockReset()
    .mockResolvedValue({ link: LINK, projectId: PROJECT_ID, projectName: "X" });
});

describe("authz", () => {
  it("applies auth at the ROUTER, so no route can be added without it", async () => {
    // The limiter has to run after auth to key on the user, so auth is mounted
    // router-level rather than repeated per route — this asserts the ordering
    // holds (an unauthenticated call is refused before any handler runs).
    state.authed = false;
    const res = await fetch(`${baseUrl}/clio-matters/7/activities`);
    expect(res.status).toBe(401);
    expect(listActivities).not.toHaveBeenCalled();
  });

  it("401s every route when unauthenticated, without touching the seam", async () => {
    state.authed = false;
    for (const [method, path] of [
      ["GET", "/clio-matters"],
      ["GET", "/clio-matters/7"],
      ["GET", "/clio-matters/7/contacts"],
      ["GET", "/clio-matters/7/activities"],
      ["PATCH", "/clio-matters/activities/55"],
      ["DELETE", "/clio-matters/activities/55"],
      ["POST", "/clio-matters/links"],
      ["DELETE", `/clio-matters/links/${PROJECT_ID}`],
      ["POST", "/clio-matters/7/workspace"],
    ] as const) {
      const res = await fetch(`${baseUrl}${path}`, { method });
      expect(res.status).toBe(401);
    }
    expect(listMatters).not.toHaveBeenCalled();
    expect(updateActivity).not.toHaveBeenCalled();
  });
});

describe("GET /clio-matters", () => {
  it("threads tab, query and status through to the seam for the CALLER", async () => {
    const res = await fetch(
      `${baseUrl}/clio-matters?tab=all&query=Acme&status=open`,
    );
    expect(res.status).toBe(200);
    expect(listMatters).toHaveBeenCalledWith(expect.anything(), "caller", {
      tab: "all",
      query: "Acme",
      status: "open",
    });
  });

  it.each([true, false])(
    "carries linksUnavailable on the list too (available=%s)",
    async (available) => {
      // The "Link to a Clio matter" affordance lives on the Matters page and in
      // the picker, neither of which loads a matter detail — so the capability
      // has to ride the list as well.
      areLinksAvailable.mockResolvedValue(available);
      const res = await fetch(`${baseUrl}/clio-matters`);
      expect((await res.json()).linksUnavailable).toBe(!available);
    },
  );

  it("surfaces a validation failure as a 400 with its own message", async () => {
    listMatters.mockRejectedValue(
      new ClioValidationError("Choose either your matters or all matters."),
    );
    const res = await fetch(`${baseUrl}/clio-matters?tab=nope`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      detail: "Choose either your matters or all matters.",
    });
  });

  it("maps an unmapped Clio failure onto a 502 (upstream, not us)", async () => {
    listMatters.mockRejectedValue(new ClioApiError(undefined, 500));
    const res = await fetch(`${baseUrl}/clio-matters`);
    expect(res.status).toBe(502);
    expect((await res.json()).detail).toMatch(/clio/i);
  });

  it("never leaks a non-Clio error's text to the client", async () => {
    listMatters.mockRejectedValue(
      new Error("relation projects does not exist"),
    );
    const res = await fetch(`${baseUrl}/clio-matters`);
    expect(res.status).toBe(500);
    expect((await res.json()).detail).not.toContain("relation projects");
  });
});

describe("GET /clio-matters/:matterId", () => {
  it("returns the detail with the caller-visible workspace link folded in", async () => {
    getMatterDetail.mockResolvedValue({ id: "7", displayNumber: "0001-0007" });
    getLinkForMatter.mockResolvedValue(LINK);
    const res = await fetch(`${baseUrl}/clio-matters/7`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "7",
      displayNumber: "0001-0007",
      link: LINK,
      linksUnavailable: false,
    });
    expect(getLinkForMatter).toHaveBeenCalledWith(
      expect.anything(),
      "caller",
      "caller@example.test",
      "7",
    );
  });

  it("reports linksUnavailable when the seam says linking is unsupported", async () => {
    // The unmigrated case. `link` still has to be null (there is nothing to
    // open), but the flag is what tells the page to stop offering to START a
    // workspace — a button that could only ever be refused.
    getMatterDetail.mockResolvedValue({ id: "7" });
    getLinkForMatter.mockResolvedValue("unsupported");
    const res = await fetch(`${baseUrl}/clio-matters/7`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "7",
      link: null,
      linksUnavailable: true,
    });
  });

  it("passes a Clio 404 through as a 404", async () => {
    getMatterDetail.mockRejectedValue(
      new ClioApiError("That Clio matter was not found.", 404),
    );
    const res = await fetch(`${baseUrl}/clio-matters/7`);
    expect(res.status).toBe(404);
  });
});

describe("GET /clio-matters/:matterId/contacts and /activities", () => {
  it("returns key people with a count", async () => {
    listRelatedContacts.mockResolvedValue([
      { id: "42", name: "Acme Ltd", type: "Company", email: null },
    ]);
    const res = await fetch(`${baseUrl}/clio-matters/7/contacts`);
    expect(await res.json()).toEqual({
      contacts: [{ id: "42", name: "Acme Ltd", type: "Company", email: null }],
      count: 1,
    });
  });

  it("defaults time entries to the caller's own and honours everyone=true", async () => {
    await fetch(`${baseUrl}/clio-matters/7/activities`);
    expect(listActivities).toHaveBeenLastCalledWith(
      expect.anything(),
      "caller",
      "7",
      { everyone: false },
    );
    await fetch(`${baseUrl}/clio-matters/7/activities?everyone=true`);
    expect(listActivities).toHaveBeenLastCalledWith(
      expect.anything(),
      "caller",
      "7",
      { everyone: true },
    );
  });
});

describe("PATCH /clio-matters/activities/:activityId", () => {
  it("converts the UI's MINUTES into the seconds Clio stores", async () => {
    const res = await fetch(`${baseUrl}/clio-matters/activities/55`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        minutes: 15,
        note: "Drafting",
        date: "2026-08-06",
        etag: "etag-a55",
      }),
    });
    expect(res.status).toBe(200);
    expect(updateActivity).toHaveBeenCalledWith(
      expect.anything(),
      "caller",
      "55",
      {
        quantitySeconds: 900,
        note: "Drafting",
        date: "2026-08-06",
        etag: "etag-a55",
      },
    );
  });

  it("omits fields the client did not send", async () => {
    await fetch(`${baseUrl}/clio-matters/activities/55`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "Only the note" }),
    });
    expect(updateActivity).toHaveBeenCalledWith(
      expect.anything(),
      "caller",
      "55",
      { note: "Only the note" },
    );
  });

  it("rejects an absurd duration at the boundary, before the seam", async () => {
    const res = await fetch(`${baseUrl}/clio-matters/activities/55`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ minutes: 60 * 25 }),
    });
    expect(res.status).toBe(400);
    expect(updateActivity).not.toHaveBeenCalled();
  });

  it("returns the fixed 409 for a billed entry and 412 for a stale etag", async () => {
    updateActivity.mockRejectedValue(
      new ClioApiError("This time entry has been billed in Clio.", 409),
    );
    const billed = await fetch(`${baseUrl}/clio-matters/activities/55`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "x" }),
    });
    expect(billed.status).toBe(409);
    expect((await billed.json()).detail).toMatch(/billed/i);

    updateActivity.mockRejectedValue(
      new ClioApiError(
        "This entry changed in Clio — reload and try again.",
        412,
      ),
    );
    const stale = await fetch(`${baseUrl}/clio-matters/activities/55`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "x" }),
    });
    expect(stale.status).toBe(412);
    expect((await stale.json()).detail).toMatch(/changed in Clio/i);
  });
});

describe("DELETE /clio-matters/activities/:activityId", () => {
  it("returns 204 on success", async () => {
    const res = await fetch(`${baseUrl}/clio-matters/activities/55`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(deleteActivity).toHaveBeenCalledWith(
      expect.anything(),
      "caller",
      "55",
    );
  });

  it("refuses another fee earner's entry with a 403", async () => {
    deleteActivity.mockRejectedValue(
      new ClioApiError(
        "You can only change time entries you recorded yourself.",
        403,
      ),
    );
    const res = await fetch(`${baseUrl}/clio-matters/activities/55`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /clio-matters/links", () => {
  async function postLink(body: unknown) {
    return fetch(`${baseUrl}/clio-matters/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("creates the link and returns 201", async () => {
    const res = await postLink({ projectId: PROJECT_ID, clioMatterId: "7" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(LINK);
  });

  it("404s a non-uuid workspace id before reaching Postgres", async () => {
    const res = await postLink({ projectId: "admin", clioMatterId: "7" });
    expect(res.status).toBe(404);
    expect(linkWorkspace).not.toHaveBeenCalled();
  });

  it("distinguishes the matter side from the workspace side in its 409 copy", async () => {
    // Same status, different remedy: the user must know WHICH end of the
    // relationship is already spoken for.
    linkWorkspace.mockResolvedValue("already_linked");
    const matterSide = await postLink({
      projectId: PROJECT_ID,
      clioMatterId: "7",
    });
    expect(matterSide.status).toBe(409);
    expect((await matterSide.json()).detail).toBe(
      "That matter already has a linked workspace.",
    );

    linkWorkspace.mockResolvedValue("workspace_already_linked");
    const workspaceSide = await postLink({
      projectId: PROJECT_ID,
      clioMatterId: "7",
    });
    expect(workspaceSide.status).toBe(409);
    expect((await workspaceSide.json()).detail).toBe(
      "That workspace is already linked to a Clio matter.",
    );
  });

  it("maps each seam outcome onto its own status", async () => {
    linkWorkspace.mockResolvedValue("unsupported");
    expect(
      (await postLink({ projectId: PROJECT_ID, clioMatterId: "7" })).status,
    ).toBe(409);

    linkWorkspace.mockResolvedValue("forbidden");
    expect(
      (await postLink({ projectId: PROJECT_ID, clioMatterId: "7" })).status,
    ).toBe(403);

    linkWorkspace.mockResolvedValue("not_found");
    expect(
      (await postLink({ projectId: PROJECT_ID, clioMatterId: "7" })).status,
    ).toBe(404);
  });
});

describe("DELETE /clio-matters/links/:projectId", () => {
  it("returns 204 for the owner and 403 for a non-owner", async () => {
    const ok = await fetch(`${baseUrl}/clio-matters/links/${PROJECT_ID}`, {
      method: "DELETE",
    });
    expect(ok.status).toBe(204);

    unlinkWorkspace.mockResolvedValue("forbidden");
    const denied = await fetch(`${baseUrl}/clio-matters/links/${PROJECT_ID}`, {
      method: "DELETE",
    });
    expect(denied.status).toBe(403);
  });

  it("404s a non-uuid workspace id", async () => {
    const res = await fetch(`${baseUrl}/clio-matters/links/not-a-uuid`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    expect(unlinkWorkspace).not.toHaveBeenCalled();
  });
});

describe("POST /clio-matters/:matterId/workspace", () => {
  it("creates the workspace and returns 201 with the link", async () => {
    const res = await fetch(`${baseUrl}/clio-matters/7/workspace`, {
      method: "POST",
    });
    expect(res.status).toBe(201);
    expect((await res.json()).link).toEqual(LINK);
    expect(createWorkspaceForMatter).toHaveBeenCalledWith(
      expect.anything(),
      "caller",
      "caller@example.test",
      "7",
    );
  });

  it("409s when the links table is not migrated yet, with honest copy", async () => {
    createWorkspaceForMatter.mockResolvedValue("unsupported");
    const res = await fetch(`${baseUrl}/clio-matters/7/workspace`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect((await res.json()).detail).toMatch(/not available yet/i);
  });

  it("404s an unknown matter", async () => {
    createWorkspaceForMatter.mockResolvedValue("not_found");
    const res = await fetch(`${baseUrl}/clio-matters/7/workspace`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
