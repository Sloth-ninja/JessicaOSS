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

const h = vi.hoisted(() => ({
  mfaBlocks: false,
  configured: true,
}));

vi.mock("../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "user-1";
    next();
  },
  requireMfaIfEnrolled: (
    _req: unknown,
    res: { status: (c: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (h.mfaBlocks) {
      res.status(403).json({ code: "mfa_verification_required" });
      return;
    }
    next();
  },
}));

vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => ({}) as unknown,
}));

vi.mock("../lib/clio/config", () => ({
  clioConfigured: vi.fn(() => h.configured),
}));

vi.mock("../lib/clio/oauth", () => {
  class ClioOAuthError extends Error {}
  return {
    ClioOAuthError,
    startClioOAuth: vi.fn(() => ({
      authorizationUrl: "https://clio/authorize?x=1",
    })),
    completeClioOAuth: vi.fn(async () => ({})),
    deauthorizeClio: vi.fn(async () => {}),
  };
});

vi.mock("../lib/clio/connections", () => ({
  getClioConnectionSummaries: vi.fn(async () => ({
    manage: { connected: true, clioUserName: "Jane" },
    grow: { connected: false, clioUserName: null },
  })),
  loadClioConnection: vi.fn(async () => ({
    id: "c1",
    tokens: { accessToken: "a" },
  })),
  deleteClioConnection: vi.fn(async () => {}),
}));

vi.mock("../lib/clio/client", () => ({
  clioRequest: vi.fn(async () => ({ meta: { records: 12 } })),
}));

import { startClioOAuth } from "../lib/clio/oauth";
import { deauthorizeClio } from "../lib/clio/oauth";
import {
  deleteClioConnection,
  loadClioConnection,
} from "../lib/clio/connections";
import { clioManageRouter, clioGrowRouter } from "./clio";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/clio", clioManageRouter);
  app.use("/clio-grow", clioGrowRouter);
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
  h.mfaBlocks = false;
  h.configured = true;
  vi.mocked(startClioOAuth).mockClear();
  vi.mocked(deauthorizeClio).mockClear();
  vi.mocked(deleteClioConnection).mockClear();
  vi.mocked(loadClioConnection).mockReset();
  vi.mocked(loadClioConnection).mockResolvedValue({
    id: "c1",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tokens: { accessToken: "a" },
  } as any);
});

describe("GET /clio/oauth/start", () => {
  it("returns an authorization URL", async () => {
    const res = await fetch(`${baseUrl}/clio/oauth/start`);
    expect(res.status).toBe(200);
    expect((await res.json()).authorizationUrl).toContain("authorize");
    expect(vi.mocked(startClioOAuth).mock.calls[0][1]).toBe("manage");
  });

  it("starts Grow OAuth on the /clio-grow mount", async () => {
    await fetch(`${baseUrl}/clio-grow/oauth/start`);
    expect(vi.mocked(startClioOAuth).mock.calls[0][1]).toBe("grow");
  });

  it("returns 503 when the product is not configured", async () => {
    h.configured = false;
    const res = await fetch(`${baseUrl}/clio/oauth/start`);
    expect(res.status).toBe(503);
  });
});

describe("GET /clio/status", () => {
  it("reports per-product connection state and a cheap Manage count", async () => {
    const res = await fetch(`${baseUrl}/clio/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manage.connected).toBe(true);
    expect(body.manage.clioUserName).toBe("Jane");
    expect(body.manage.mattersVisible).toBe(12);
    expect(body.grow.connected).toBe(false);
  });
});

describe("POST /clio/:product/disconnect", () => {
  it("deauthorizes then deletes the connection", async () => {
    const res = await fetch(`${baseUrl}/clio/manage/disconnect`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(vi.mocked(deauthorizeClio)).toHaveBeenCalledOnce();
    expect(vi.mocked(deleteClioConnection)).toHaveBeenCalledOnce();
  });

  it("still deletes locally when the remote deauthorize fails", async () => {
    vi.mocked(deauthorizeClio).mockRejectedValueOnce(new Error("revoke down"));
    const res = await fetch(`${baseUrl}/clio/manage/disconnect`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(deleteClioConnection)).toHaveBeenCalledOnce();
  });

  it("rejects an unknown product with a 400", async () => {
    const res = await fetch(`${baseUrl}/clio/wombat/disconnect`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(deleteClioConnection)).not.toHaveBeenCalled();
  });

  it("is MFA-gated (403 when verification is required)", async () => {
    h.mfaBlocks = true;
    const res = await fetch(`${baseUrl}/clio/manage/disconnect`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(vi.mocked(deleteClioConnection)).not.toHaveBeenCalled();
  });
});
