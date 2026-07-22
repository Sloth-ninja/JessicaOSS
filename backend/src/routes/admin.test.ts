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
// via vi.hoisted so the hoisted vi.mock factories can close over it.
const state = vi.hoisted(() => ({
  isAdmin: true,
  orgId: "org-1" as string | null,
  setMemberRoleResult: { ok: true, member: {} } as
    | { ok: true; member: unknown }
    | { ok: false; reason: "not_found" | "last_admin" },
}));

vi.mock("../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "caller";
    res.locals.token = "token";
    next();
  },
  requireAdmin: (
    _req: unknown,
    res: {
      status: (n: number) => { json: (b: unknown) => void };
      locals: Record<string, unknown>;
    },
    next: () => void,
  ) => {
    if (!state.isAdmin) {
      res.status(403).json({ detail: "Administrator access is required." });
      return;
    }
    next();
  },
  requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => ({}),
}));

const listOrganisationMembers = vi.fn();
const setMemberRole = vi.fn();
vi.mock("../lib/organisations", () => ({
  getUserOrganisationId: () => Promise.resolve(state.orgId),
  listOrganisationMembers: (...args: unknown[]) =>
    listOrganisationMembers(...args),
  setMemberRole: (...args: unknown[]) => setMemberRole(...args),
}));

const saveOrganisationApiKey = vi.fn();
vi.mock("../lib/organisationApiKeys", () => ({
  getOrganisationApiKeyStatus: () =>
    Promise.resolve({
      claude: true,
      gemini: false,
      openai: false,
      openrouter: false,
      companies_house: false,
    }),
  saveOrganisationApiKey: (...args: unknown[]) =>
    saveOrganisationApiKey(...args),
}));

vi.mock("../lib/userApiKeys", () => ({
  normalizeApiKeyProvider: (value: string) =>
    ["claude", "gemini", "openai", "openrouter", "companies_house"].includes(
      value,
    )
      ? value
      : null,
}));

import { adminRouter } from "./admin";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/admin", adminRouter);
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
  state.isAdmin = true;
  state.orgId = "org-1";
  state.setMemberRoleResult = { ok: true, member: { userId: "u2" } };
  listOrganisationMembers.mockReset();
  setMemberRole.mockReset();
  saveOrganisationApiKey.mockReset();
  setMemberRole.mockImplementation(() =>
    Promise.resolve(state.setMemberRoleResult),
  );
});

describe("admin authz", () => {
  it("returns 403 for a non-admin member on every admin route", async () => {
    state.isAdmin = false;
    for (const path of ["/admin/firm-keys", "/admin/members"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        detail: "Administrator access is required.",
      });
    }
  });
});

describe("GET /admin/firm-keys", () => {
  it("returns per-provider configured flags to an admin", async () => {
    const res = await fetch(`${baseUrl}/admin/firm-keys`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ claude: true, openai: false });
  });
});

describe("PUT /admin/firm-keys/:provider", () => {
  it("rejects an unsupported provider with 400", async () => {
    const res = await fetch(`${baseUrl}/admin/firm-keys/nope`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: "x" }),
    });
    expect(res.status).toBe(400);
    expect(saveOrganisationApiKey).not.toHaveBeenCalled();
  });

  it("saves a firm key and returns the updated status", async () => {
    saveOrganisationApiKey.mockResolvedValue(undefined);
    const res = await fetch(`${baseUrl}/admin/firm-keys/claude`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: "firm-claude" }),
    });
    expect(res.status).toBe(200);
    expect(saveOrganisationApiKey).toHaveBeenCalledWith(
      "org-1",
      "claude",
      "firm-claude",
      expect.anything(),
    );
  });
});

describe("GET /admin/members", () => {
  it("returns the firm's members", async () => {
    listOrganisationMembers.mockResolvedValue([
      { userId: "u1", role: "admin" },
    ]);
    const res = await fetch(`${baseUrl}/admin/members`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      members: [{ userId: "u1", role: "admin" }],
    });
  });
});

describe("PATCH /admin/members/:userId/role", () => {
  const patch = (userId: string, body: unknown) =>
    fetch(`${baseUrl}/admin/members/${userId}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("rejects an invalid role with 400", async () => {
    const res = await patch("u2", { role: "superuser" });
    expect(res.status).toBe(400);
    expect(setMemberRole).not.toHaveBeenCalled();
  });

  it("promotes a member and returns the updated record", async () => {
    state.setMemberRoleResult = {
      ok: true,
      member: { userId: "u2", role: "admin" },
    };
    const res = await patch("u2", { role: "admin" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      member: { userId: "u2", role: "admin" },
    });
    expect(setMemberRole).toHaveBeenCalledWith(expect.anything(), {
      organisationId: "org-1",
      targetUserId: "u2",
      role: "admin",
    });
  });

  it("returns 409 when the last admin would be demoted", async () => {
    state.setMemberRoleResult = { ok: false, reason: "last_admin" };
    const res = await patch("admin1", { role: "member" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      detail: "You cannot remove the last administrator of your firm.",
    });
  });

  it("returns 404 when the target is not in the caller's firm", async () => {
    state.setMemberRoleResult = { ok: false, reason: "not_found" };
    const res = await patch("outsider", { role: "admin" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      detail: "That member is not part of your firm.",
    });
  });
});
