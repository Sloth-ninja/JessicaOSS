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

// Shared, mutable control state for the mocked auth middleware + libs. Declared
// via vi.hoisted so the hoisted vi.mock factories can close over it (mirrors
// routes/admin.test.ts).
const state = vi.hoisted(() => ({
  authed: true,
  isAdmin: true,
  mfaOk: true,
  orgId: "org-1" as string | null,
}));

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
  requireAdmin: (
    _req: unknown,
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (!state.isAdmin) {
      res.status(403).json({ detail: "Administrator access is required." });
      return;
    }
    next();
  },
  requireMfaIfEnrolled: (
    _req: unknown,
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (!state.mfaOk) {
      res.status(403).json({
        code: "mfa_verification_required",
        detail: "MFA verification required",
      });
      return;
    }
    next();
  },
}));

vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => ({}),
}));

vi.mock("../lib/organisations", () => ({
  getUserOrganisationId: () => Promise.resolve(state.orgId),
}));

const listTemplates = vi.fn();
const getTemplate = vi.fn();
const createTemplate = vi.fn();
const updateTemplate = vi.fn();
const deleteTemplate = vi.fn();
const setTemplateVisibility = vi.fn();
const adminRevertTemplate = vi.fn();
const listFirmTemplatesForAdmin = vi.fn();
vi.mock("../lib/tabularTemplates", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/tabularTemplates")>();
  return {
    ...actual,
    listTemplates: (...args: unknown[]) => listTemplates(...args),
    getTemplate: (...args: unknown[]) => getTemplate(...args),
    createTemplate: (...args: unknown[]) => createTemplate(...args),
    updateTemplate: (...args: unknown[]) => updateTemplate(...args),
    deleteTemplate: (...args: unknown[]) => deleteTemplate(...args),
    setTemplateVisibility: (...args: unknown[]) =>
      setTemplateVisibility(...args),
    adminRevertTemplate: (...args: unknown[]) => adminRevertTemplate(...args),
    listFirmTemplatesForAdmin: (...args: unknown[]) =>
      listFirmTemplatesForAdmin(...args),
  };
});

import { TemplateValidationError } from "../lib/tabularTemplates";
import { tabularTemplatesRouter } from "./tabularTemplates";

// Template ids are uuids; the router 404s any non-uuid `:id` up front.
const ID = "3f8f3a54-9b5e-4f6e-a9d2-1c2b3d4e5f60";

const TEMPLATE = {
  id: ID,
  title: "NDA review",
  practice: "Commercial",
  columns: [{ index: 0, name: "Parties", prompt: "Identify the parties." }],
  ownerUserId: "caller",
  ownerDisplayName: null,
  visibility: "private",
  isOwner: true,
  updatedAt: "2026-08-01T00:00:00Z",
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/tabular-templates", tabularTemplatesRouter);
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
  state.isAdmin = true;
  state.mfaOk = true;
  state.orgId = "org-1";
  listTemplates.mockReset().mockResolvedValue({
    mine: [],
    shared: [],
    firm: [],
    firmSharingSupported: true,
  });
  getTemplate.mockReset().mockResolvedValue(TEMPLATE);
  createTemplate.mockReset().mockResolvedValue(TEMPLATE);
  updateTemplate.mockReset().mockResolvedValue(TEMPLATE);
  deleteTemplate.mockReset().mockResolvedValue("deleted");
  setTemplateVisibility
    .mockReset()
    .mockResolvedValue({ ...TEMPLATE, visibility: "firm" });
  adminRevertTemplate.mockReset().mockResolvedValue("reverted");
  listFirmTemplatesForAdmin.mockReset().mockResolvedValue([]);
});

describe("authz", () => {
  it("returns 401 when unauthenticated", async () => {
    state.authed = false;
    const res = await fetch(`${baseUrl}/tabular-templates`);
    expect(res.status).toBe(401);
    expect(listTemplates).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin member on the admin routes", async () => {
    state.isAdmin = false;
    const listRes = await fetch(`${baseUrl}/tabular-templates/admin/firm`);
    expect(listRes.status).toBe(403);
    const revertRes = await fetch(
      `${baseUrl}/tabular-templates/${ID}/admin-revert`,
      { method: "POST" },
    );
    expect(revertRes.status).toBe(403);
    expect(listFirmTemplatesForAdmin).not.toHaveBeenCalled();
    expect(adminRevertTemplate).not.toHaveBeenCalled();
  });
});

describe("GET /tabular-templates", () => {
  it("returns the caller's template list, threading their email and org id", async () => {
    listTemplates.mockResolvedValue({
      mine: [TEMPLATE],
      shared: [],
      firm: [],
      firmSharingSupported: true,
    });
    const res = await fetch(`${baseUrl}/tabular-templates`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mine: [TEMPLATE],
      shared: [],
      firm: [],
      firmSharingSupported: true,
    });
    expect(listTemplates).toHaveBeenCalledWith(
      expect.anything(),
      "caller",
      "caller@example.test",
      "org-1",
    );
  });

  it("responds 500 with the fixed generic detail on an infra failure", async () => {
    listTemplates.mockRejectedValue(new Error("supabase exploded"));
    const res = await fetch(`${baseUrl}/tabular-templates`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      detail: "Something went wrong. Please try again.",
    });
  });
});

describe("POST /tabular-templates", () => {
  it("creates a template and returns 201", async () => {
    const res = await fetch(`${baseUrl}/tabular-templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "NDA review",
        practice: "Commercial",
        columns: TEMPLATE.columns,
      }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(TEMPLATE);
    expect(createTemplate).toHaveBeenCalledWith(expect.anything(), "caller", {
      title: "NDA review",
      practice: "Commercial",
      columns: TEMPLATE.columns,
    });
  });

  it("maps a TemplateValidationError to a 400 with its user-safe message", async () => {
    createTemplate.mockRejectedValue(
      new TemplateValidationError("Each column needs a name."),
    );
    const res = await fetch(`${baseUrl}/tabular-templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", columns: [{}] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "Each column needs a name." });
  });
});

describe("GET /tabular-templates/:id", () => {
  it("returns the template", async () => {
    const res = await fetch(`${baseUrl}/tabular-templates/${ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TEMPLATE);
    expect(getTemplate).toHaveBeenCalledWith(
      expect.anything(),
      "caller",
      ID,
      "org-1",
      "caller@example.test",
    );
  });

  it("returns a fixed 404 when not readable", async () => {
    getTemplate.mockResolvedValue("not_found");
    const res = await fetch(`${baseUrl}/tabular-templates/${ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "Template not found." });
  });

  it("404s a non-uuid id up front (no seam call, no 22P02 500)", async () => {
    const res = await fetch(`${baseUrl}/tabular-templates/not-a-uuid`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "Template not found." });
    expect(getTemplate).not.toHaveBeenCalled();
  });

  it("404s the mistyped /tabular-templates/admin rather than treating it as an id", async () => {
    const res = await fetch(`${baseUrl}/tabular-templates/admin`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "Template not found." });
    expect(getTemplate).not.toHaveBeenCalled();
  });
});

describe("PATCH /tabular-templates/:id", () => {
  it("updates and returns the template", async () => {
    const res = await fetch(`${baseUrl}/tabular-templates/${ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TEMPLATE);
    expect(updateTemplate).toHaveBeenCalledWith(
      expect.anything(),
      "caller",
      ID,
      { title: "Renamed" },
    );
  });

  it("returns the 404-shaped not_found for a non-owner", async () => {
    updateTemplate.mockResolvedValue("not_found");
    const res = await fetch(`${baseUrl}/tabular-templates/${ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Hijack" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "Template not found." });
  });

  it("maps validation failures to 400", async () => {
    updateTemplate.mockRejectedValue(
      new TemplateValidationError("Unknown column format."),
    );
    const res = await fetch(`${baseUrl}/tabular-templates/${ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns: [{ format: "emoji" }] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "Unknown column format." });
  });
});

describe("DELETE /tabular-templates/:id", () => {
  it("deletes and returns 204", async () => {
    const res = await fetch(`${baseUrl}/tabular-templates/${ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(deleteTemplate).toHaveBeenCalledWith(
      expect.anything(),
      "caller",
      ID,
    );
  });

  it("returns the 404-shaped not_found for a non-owner", async () => {
    deleteTemplate.mockResolvedValue("not_found");
    const res = await fetch(`${baseUrl}/tabular-templates/${ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "Template not found." });
  });
});

describe("PATCH /tabular-templates/:id/visibility", () => {
  it("flips visibility and returns the template", async () => {
    const res = await fetch(`${baseUrl}/tabular-templates/${ID}/visibility`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "firm" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...TEMPLATE, visibility: "firm" });
    expect(setTemplateVisibility).toHaveBeenCalledWith(
      expect.anything(),
      "caller",
      ID,
      "firm",
      "org-1",
    );
  });

  it("404s a non-uuid id before validating the body", async () => {
    const res = await fetch(`${baseUrl}/tabular-templates/nope/visibility`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "firm" }),
    });
    expect(res.status).toBe(404);
    expect(setTemplateVisibility).not.toHaveBeenCalled();
  });

  it("rejects an invalid visibility with 400", async () => {
    const res = await fetch(`${baseUrl}/tabular-templates/${ID}/visibility`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      detail: "visibility must be 'private' or 'firm'.",
    });
    expect(setTemplateVisibility).not.toHaveBeenCalled();
  });

  it("returns 409 for an orgless caller without calling the seam", async () => {
    state.orgId = null;
    const res = await fetch(`${baseUrl}/tabular-templates/${ID}/visibility`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "firm" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      detail: "Firm sharing is not available.",
    });
    expect(setTemplateVisibility).not.toHaveBeenCalled();
  });

  it("returns the same 409 when the seam reports unsupported (unmigrated DB)", async () => {
    setTemplateVisibility.mockResolvedValue("unsupported");
    const res = await fetch(`${baseUrl}/tabular-templates/${ID}/visibility`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "firm" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      detail: "Firm sharing is not available.",
    });
  });

  it("returns 404 when the seam reports not_found", async () => {
    setTemplateVisibility.mockResolvedValue("not_found");
    const res = await fetch(`${baseUrl}/tabular-templates/${ID}/visibility`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "firm" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "Template not found." });
  });
});

describe("admin routes", () => {
  it("GET /admin/firm lists the org's firm templates", async () => {
    listFirmTemplatesForAdmin.mockResolvedValue([
      { ...TEMPLATE, visibility: "firm" },
    ]);
    const res = await fetch(`${baseUrl}/tabular-templates/admin/firm`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ ...TEMPLATE, visibility: "firm" }]);
    expect(listFirmTemplatesForAdmin).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
    );
  });

  it("GET /admin/firm returns an empty list for an orgless admin", async () => {
    state.orgId = null;
    const res = await fetch(`${baseUrl}/tabular-templates/admin/firm`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(listFirmTemplatesForAdmin).not.toHaveBeenCalled();
  });

  it("POST /:id/admin-revert reverts and returns 204", async () => {
    const res = await fetch(`${baseUrl}/tabular-templates/${ID}/admin-revert`, {
      method: "POST",
    });
    expect(res.status).toBe(204);
    expect(adminRevertTemplate).toHaveBeenCalledWith(
      expect.anything(),
      "caller",
      "org-1",
      ID,
    );
  });

  it("POST /:id/admin-revert returns 403 without MFA step-up", async () => {
    // Alignment with routes/admin.ts: an enrolled-but-unverified admin cannot
    // mutate. The revert seam must never be reached.
    state.mfaOk = false;
    const res = await fetch(`${baseUrl}/tabular-templates/${ID}/admin-revert`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "mfa_verification_required" }),
    );
    expect(adminRevertTemplate).not.toHaveBeenCalled();
  });

  it("POST /:id/admin-revert returns 404 for another org's template", async () => {
    adminRevertTemplate.mockResolvedValue("not_found");
    const res = await fetch(`${baseUrl}/tabular-templates/${ID}/admin-revert`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "Template not found." });
  });
});
