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
  mfaOk: true,
  orgId: "org-1" as string | null,
  enabledConnectorIds: [] as string[],
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

const listOrganisationMembers = vi.fn();
const setMemberRole = vi.fn();
const updateOrganisationPolicies = vi.fn();
const setOrganisationEnabledConnectorIds = vi.fn();
vi.mock("../lib/organisations", () => ({
  getUserOrganisationId: () => Promise.resolve(state.orgId),
  listOrganisationMembers: (...args: unknown[]) =>
    listOrganisationMembers(...args),
  setMemberRole: (...args: unknown[]) => setMemberRole(...args),
  updateOrganisationPolicies: (...args: unknown[]) =>
    updateOrganisationPolicies(...args),
  getOrganisationEnabledConnectorIds: () =>
    Promise.resolve(state.enabledConnectorIds),
  setOrganisationEnabledConnectorIds: (...args: unknown[]) =>
    setOrganisationEnabledConnectorIds(...args),
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

const listPendingDeletions = vi.fn();
const restoreResource = vi.fn();
const expediteResource = vi.fn();
const getOrganisationMemberIds = vi.fn();
const updateOrganisationRetention = vi.fn();
const insertDeletionAudit = vi.fn();
vi.mock("../lib/deletionGovernance", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/deletionGovernance")>();
  return {
    ...actual,
    listPendingDeletions: (...args: unknown[]) => listPendingDeletions(...args),
    restoreResource: (...args: unknown[]) => restoreResource(...args),
    expediteResource: (...args: unknown[]) => expediteResource(...args),
    getOrganisationMemberIds: (...args: unknown[]) =>
      getOrganisationMemberIds(...args),
    updateOrganisationRetention: (...args: unknown[]) =>
      updateOrganisationRetention(...args),
    insertDeletionAudit: (...args: unknown[]) => insertDeletionAudit(...args),
  };
});

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
  state.mfaOk = true;
  state.orgId = "org-1";
  state.enabledConnectorIds = [];
  state.setMemberRoleResult = { ok: true, member: { userId: "u2" } };
  listOrganisationMembers.mockReset();
  setMemberRole.mockReset();
  saveOrganisationApiKey.mockReset();
  updateOrganisationPolicies.mockReset();
  setOrganisationEnabledConnectorIds.mockReset();
  setOrganisationEnabledConnectorIds.mockImplementation(
    (_db: unknown, _orgId: unknown, ids: string[]) => Promise.resolve(ids),
  );
  setMemberRole.mockImplementation(() =>
    Promise.resolve(state.setMemberRoleResult),
  );
  listPendingDeletions.mockReset().mockResolvedValue([]);
  restoreResource.mockReset().mockResolvedValue("ok");
  expediteResource.mockReset().mockResolvedValue("ok");
  getOrganisationMemberIds.mockReset().mockResolvedValue(["u1", "u2"]);
  updateOrganisationRetention
    .mockReset()
    .mockImplementation((_db: unknown, _orgId: unknown, days: number) =>
      Promise.resolve(days),
    );
  insertDeletionAudit.mockReset().mockResolvedValue(undefined);
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

describe("PATCH /admin/policies", () => {
  const patchPolicies = (body: unknown) =>
    fetch(`${baseUrl}/admin/policies`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("is gated to admins (403 for a non-admin)", async () => {
    state.isAdmin = false;
    const res = await patchPolicies({ memberApiKeys: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      detail: "Administrator access is required.",
    });
    expect(updateOrganisationPolicies).not.toHaveBeenCalled();
  });

  it("is MFA-gated (403 when the session is not stepped up)", async () => {
    state.mfaOk = false;
    const res = await patchPolicies({ memberApiKeys: false });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: "mfa_verification_required",
    });
    expect(updateOrganisationPolicies).not.toHaveBeenCalled();
  });

  it("rejects an unsupported policy field with 400", async () => {
    const res = await patchPolicies({ memberApiKeys: true, wat: false });
    expect(res.status).toBe(400);
    expect(updateOrganisationPolicies).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean value with 400", async () => {
    const res = await patchPolicies({ memberApiKeys: "yes" });
    expect(res.status).toBe(400);
    expect(updateOrganisationPolicies).not.toHaveBeenCalled();
  });

  it("rejects an empty patch (no fields) with 400", async () => {
    const res = await patchPolicies({});
    expect(res.status).toBe(400);
    expect(updateOrganisationPolicies).not.toHaveBeenCalled();
  });

  it("persists the patch scoped to the caller's firm and returns the flags", async () => {
    updateOrganisationPolicies.mockResolvedValue({
      memberApiKeys: false,
      memberMcpConnectors: true,
    });
    const res = await patchPolicies({
      memberApiKeys: false,
      memberMcpConnectors: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      policies: { memberApiKeys: false, memberMcpConnectors: true },
    });
    expect(updateOrganisationPolicies).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      { memberApiKeys: false, memberMcpConnectors: true },
    );
  });
});

describe("GET /admin/connector-gallery", () => {
  it("returns the registry plus the firm's curation to an admin", async () => {
    state.enabledConnectorIds = ["google-drive", "gmail"];
    const res = await fetch(`${baseUrl}/admin/connector-gallery`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      registry: { id: string }[];
      enabledConnectorIds: string[];
    };
    expect(body.enabledConnectorIds).toEqual(["google-drive", "gmail"]);
    expect(body.registry.length).toBeGreaterThan(0);
    expect(body.registry.map((e) => e.id)).toContain("google-drive");
    // Never leaks server URLs / secrets in the admin view.
    expect(body.registry[0]).not.toHaveProperty("serverUrl");
  });

  it("returns 403 for a non-admin", async () => {
    state.isAdmin = false;
    const res = await fetch(`${baseUrl}/admin/connector-gallery`);
    expect(res.status).toBe(403);
  });
});

describe("PATCH /admin/connector-gallery", () => {
  const patchCuration = (body: unknown) =>
    fetch(`${baseUrl}/admin/connector-gallery`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("rejects a body missing enabledConnectorIds with 400", async () => {
    const res = await patchCuration({});
    expect(res.status).toBe(400);
    expect(setOrganisationEnabledConnectorIds).not.toHaveBeenCalled();
  });

  it("rejects an unknown connector id with 400", async () => {
    const res = await patchCuration({
      enabledConnectorIds: ["google-drive", "not-a-real-connector"],
    });
    expect(res.status).toBe(400);
    expect(setOrganisationEnabledConnectorIds).not.toHaveBeenCalled();
  });

  it("accepts an empty array (all visible) and persists it", async () => {
    const res = await patchCuration({ enabledConnectorIds: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabledConnectorIds: [] });
    expect(setOrganisationEnabledConnectorIds).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      [],
    );
  });

  it("persists a valid, de-duplicated shortlist scoped to the firm", async () => {
    const res = await patchCuration({
      enabledConnectorIds: ["google-drive", "gmail", "google-drive"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabledConnectorIds: ["google-drive", "gmail"],
    });
    expect(setOrganisationEnabledConnectorIds).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      ["google-drive", "gmail"],
    );
  });

  it("returns 403 without MFA step-up", async () => {
    state.mfaOk = false;
    const res = await patchCuration({ enabledConnectorIds: [] });
    expect(res.status).toBe(403);
    expect(setOrganisationEnabledConnectorIds).not.toHaveBeenCalled();
  });
});

describe("GET /admin/pending-deletions", () => {
  it("returns 403 for a non-admin caller", async () => {
    state.isAdmin = false;
    const res = await fetch(`${baseUrl}/admin/pending-deletions`);
    expect(res.status).toBe(403);
    expect(listPendingDeletions).not.toHaveBeenCalled();
  });

  it("returns the firm's pending deletions, scoped to the caller's org", async () => {
    listPendingDeletions.mockResolvedValue([
      { resourceType: "chat", id: "c1", daysRemaining: 5 },
    ]);
    const res = await fetch(`${baseUrl}/admin/pending-deletions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [{ resourceType: "chat", id: "c1", daysRemaining: 5 }],
    });
    expect(listPendingDeletions).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
    );
  });
});

describe("POST /admin/pending-deletions/:resourceType/:id/restore", () => {
  const restore = (resourceType: string, id: string) =>
    fetch(`${baseUrl}/admin/pending-deletions/${resourceType}/${id}/restore`, {
      method: "POST",
    });

  it("returns 404 for an unknown resourceType (never reaches restoreResource)", async () => {
    const res = await restore("not-a-real-type", "id1");
    expect(res.status).toBe(404);
    expect(restoreResource).not.toHaveBeenCalled();
  });

  it("restores a governed item and writes an audit row", async () => {
    const res = await restore("chat", "c1");
    expect(res.status).toBe(204);
    expect(restoreResource).toHaveBeenCalledWith(
      expect.anything(),
      "chat",
      "c1",
      ["u1", "u2"],
    );
    expect(insertDeletionAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organisationId: "org-1",
        action: "restored",
        resourceType: "chat",
        resourceId: "c1",
      }),
    );
  });

  it("returns 404 when restoreResource reports not_found and skips the audit", async () => {
    restoreResource.mockResolvedValue("not_found");
    const res = await restore("chat", "c1");
    expect(res.status).toBe(404);
    expect(insertDeletionAudit).not.toHaveBeenCalled();
  });

  it("returns 403 without MFA step-up", async () => {
    state.mfaOk = false;
    const res = await restore("chat", "c1");
    expect(res.status).toBe(403);
    expect(restoreResource).not.toHaveBeenCalled();
  });
});

describe("POST /admin/pending-deletions/:resourceType/:id/expedite", () => {
  const expedite = (resourceType: string, id: string) =>
    fetch(`${baseUrl}/admin/pending-deletions/${resourceType}/${id}/expedite`, {
      method: "POST",
    });

  it("returns 404 for an unknown resourceType (never reaches expediteResource)", async () => {
    const res = await expedite("not-a-real-type", "id1");
    expect(res.status).toBe(404);
    expect(expediteResource).not.toHaveBeenCalled();
  });

  it("expedites a governed item and writes an audit row", async () => {
    const res = await expedite("document", "d1");
    expect(res.status).toBe(204);
    expect(expediteResource).toHaveBeenCalledWith(
      expect.anything(),
      "document",
      "d1",
      ["u1", "u2"],
    );
    expect(insertDeletionAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "expedited", resourceId: "d1" }),
    );
  });

  it("returns 404 when expediteResource reports not_found", async () => {
    expediteResource.mockResolvedValue("not_found");
    const res = await expedite("document", "d1");
    expect(res.status).toBe(404);
    expect(insertDeletionAudit).not.toHaveBeenCalled();
  });
});

describe("PATCH /admin/retention", () => {
  const patchRetention = (body: unknown) =>
    fetch(`${baseUrl}/admin/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("returns 400 when retentionDays is not a number", async () => {
    const res = await patchRetention({ retentionDays: "not-a-number" });
    expect(res.status).toBe(400);
    expect(updateOrganisationRetention).not.toHaveBeenCalled();
  });

  it("returns 400 when retentionDays is missing", async () => {
    const res = await patchRetention({});
    expect(res.status).toBe(400);
    expect(updateOrganisationRetention).not.toHaveBeenCalled();
  });

  it("clamps out-of-range values and persists the clamped value", async () => {
    const res = await patchRetention({ retentionDays: 4000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ retentionDays: 365 });
    expect(updateOrganisationRetention).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      365,
    );
  });

  it("persists a valid in-range value unchanged", async () => {
    const res = await patchRetention({ retentionDays: 45 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ retentionDays: 45 });
    expect(updateOrganisationRetention).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      45,
    );
  });

  it("returns 403 without MFA step-up", async () => {
    state.mfaOk = false;
    const res = await patchRetention({ retentionDays: 30 });
    expect(res.status).toBe(403);
    expect(updateOrganisationRetention).not.toHaveBeenCalled();
  });
});
