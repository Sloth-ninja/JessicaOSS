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
import type { OrganisationMembership } from "../lib/organisations";

// Shared, mutable control state for the mocked org lookup. `resolve` is what
// resolveUserOrganisation returns; when `throws` is set it rejects instead (to
// exercise the deliberate fail-open path).
const state = vi.hoisted(() => ({
  resolve: null as OrganisationMembership | null,
  throws: false,
}));

vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => ({}),
}));

vi.mock("../lib/organisations", () => ({
  resolveUserOrganisation: () => {
    if (state.throws) return Promise.reject(new Error("db down"));
    return Promise.resolve(state.resolve);
  },
}));

import { requireMemberPolicy } from "./auth";

const KEYS_DETAIL = "Personal API keys are managed by your firm.";
const CONNECTORS_DETAIL = "Connectors are managed by your firm.";
const MODEL_PREFS_DETAIL = "Model preferences are managed by your firm.";

function membership(
  policies: Partial<OrganisationMembership["policies"]>,
  role: OrganisationMembership["role"] = "member",
): OrganisationMembership {
  return {
    id: "org-1",
    name: "Aria Grace Law",
    role,
    policies: {
      memberApiKeys: false,
      memberMcpConnectors: false,
      memberModelPrefs: false,
      ...policies,
    },
    modelConfig: { defaultModel: null, offeredProviders: [] },
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Fake requireAuth: populate the caller id the middleware reads.
  const fakeAuth = (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "caller";
    next();
  };
  app.put(
    "/keys",
    fakeAuth,
    requireMemberPolicy("memberApiKeys", KEYS_DETAIL),
    (_req, res) => res.json({ ok: true }),
  );
  app.post(
    "/connectors",
    fakeAuth,
    requireMemberPolicy("memberMcpConnectors", CONNECTORS_DETAIL),
    (_req, res) => res.json({ ok: true }),
  );
  // Mirrors PUT /user/api-keys/:provider: only a real (non-empty) SAVE is gated;
  // a null/empty api_key (removal) always passes.
  app.put(
    "/keys-save-only",
    fakeAuth,
    requireMemberPolicy(
      "memberApiKeys",
      KEYS_DETAIL,
      (req) =>
        typeof req.body?.api_key === "string" &&
        req.body.api_key.trim().length > 0,
    ),
    (_req, res) => res.json({ ok: true }),
  );
  // Mirrors PATCH /user/profile (WS8 PR F): the memberModelPrefs gate applies
  // ONLY when the body touches a model-preference field; a display-name-only
  // edit skips the gate.
  app.patch(
    "/profile-model",
    fakeAuth,
    requireMemberPolicy(
      "memberModelPrefs",
      MODEL_PREFS_DETAIL,
      (req) =>
        !!req.body &&
        typeof req.body === "object" &&
        ("titleModel" in req.body || "tabularModel" in req.body),
    ),
    (_req, res) => res.json({ ok: true }),
  );
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
  state.resolve = null;
  state.throws = false;
});

const putKeys = () => fetch(`${baseUrl}/keys`, { method: "PUT" });
const postConnectors = () => fetch(`${baseUrl}/connectors`, { method: "POST" });

describe("requireMemberPolicy — memberApiKeys", () => {
  it("blocks with a fixed 403 when the firm policy is OFF", async () => {
    state.resolve = membership({
      memberApiKeys: false,
      memberMcpConnectors: true,
    });
    const res = await putKeys();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: KEYS_DETAIL });
  });

  it("allows the write when the firm policy is ON", async () => {
    state.resolve = membership({
      memberApiKeys: true,
      memberMcpConnectors: false,
    });
    const res = await putKeys();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("allows an admin caller only if the policy is ON (admins are not exempt)", async () => {
    state.resolve = membership(
      { memberApiKeys: false, memberMcpConnectors: false },
      "admin",
    );
    const res = await putKeys();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: KEYS_DETAIL });
  });

  it("allows an orgless caller (no membership)", async () => {
    state.resolve = null;
    const res = await putKeys();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("fails open (allows) when the org lookup throws", async () => {
    state.throws = true;
    const res = await putKeys();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("requireMemberPolicy — memberMcpConnectors", () => {
  it("blocks with the connectors detail when that policy is OFF", async () => {
    state.resolve = membership({
      memberApiKeys: true,
      memberMcpConnectors: false,
    });
    const res = await postConnectors();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: CONNECTORS_DETAIL });
  });

  it("allows the write when that policy is ON", async () => {
    state.resolve = membership({
      memberApiKeys: false,
      memberMcpConnectors: true,
    });
    const res = await postConnectors();
    expect(res.status).toBe(200);
  });

  it("fails open when the org lookup throws", async () => {
    state.throws = true;
    const res = await postConnectors();
    expect(res.status).toBe(200);
  });
});

describe("requireMemberPolicy — shouldGate predicate (save-only gate)", () => {
  const putKeysSave = (body: unknown) =>
    fetch(`${baseUrl}/keys-save-only`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("blocks a real SAVE under policy OFF", async () => {
    state.resolve = membership({
      memberApiKeys: false,
      memberMcpConnectors: true,
    });
    const res = await putKeysSave({ api_key: "sk-live" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: KEYS_DETAIL });
  });

  it("lets a REMOVAL (null api_key) through under policy OFF", async () => {
    state.resolve = membership({
      memberApiKeys: false,
      memberMcpConnectors: true,
    });
    const res = await putKeysSave({ api_key: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("lets a REMOVAL (empty/whitespace api_key) through under policy OFF", async () => {
    state.resolve = membership({
      memberApiKeys: false,
      memberMcpConnectors: true,
    });
    const res = await putKeysSave({ api_key: "   " });
    expect(res.status).toBe(200);
  });
});

describe("requireMemberPolicy — memberModelPrefs (WS8 PR F)", () => {
  const patchModel = (body: unknown) =>
    fetch(`${baseUrl}/profile-model`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("blocks a model-pref write with a fixed 403 when the policy is OFF", async () => {
    state.resolve = membership({ memberModelPrefs: false });
    const res = await patchModel({ tabularModel: "gpt-5.4" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: MODEL_PREFS_DETAIL });
  });

  it("lets a display-name-only edit through even when the policy is OFF", async () => {
    state.resolve = membership({ memberModelPrefs: false });
    const res = await patchModel({ displayName: "Jane Solicitor" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("allows a model-pref write when the policy is ON", async () => {
    state.resolve = membership({ memberModelPrefs: true });
    const res = await patchModel({ titleModel: "gpt-5.4-lite" });
    expect(res.status).toBe(200);
  });

  it("does not exempt an admin (blocked under policy OFF)", async () => {
    state.resolve = membership({ memberModelPrefs: false }, "admin");
    const res = await patchModel({ tabularModel: "gpt-5.4" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: MODEL_PREFS_DETAIL });
  });

  it("allows an orgless caller", async () => {
    state.resolve = null;
    const res = await patchModel({ tabularModel: "gpt-5.4" });
    expect(res.status).toBe(200);
  });

  it("fails open (allows) when the org lookup throws", async () => {
    state.throws = true;
    const res = await patchModel({ tabularModel: "gpt-5.4" });
    expect(res.status).toBe(200);
  });
});
