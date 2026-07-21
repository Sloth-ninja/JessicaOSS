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

// Auth is stubbed so the router runs; the real target here is the async-handler
// safety net around GET /user/profile (login-spinner incident, 2026-07-21).
vi.mock("../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "test-user";
    res.locals.userEmail = "test@example.com";
    next();
  },
  requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

// getUserApiKeyStatus is the call that threw in production when the
// service_role grant on user_api_keys was lost. Mock it so we can make it
// reject and assert the handler degrades honestly instead of hanging.
vi.mock("../lib/userApiKeys", () => ({
  getUserApiKeyStatus: vi.fn(),
  normalizeApiKeyProvider: vi.fn(() => null),
  saveUserApiKey: vi.fn(),
}));

// createServerSupabase is called before getUserApiKeyStatus; a bare stub is
// enough because the rejection happens before the DB is otherwise used.
vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => ({}),
}));

// The remaining modules are imported at load time but not exercised by the
// GET /profile error path — stub them so the router module loads in isolation.
vi.mock("../lib/llm", () => ({
  DEFAULT_TABULAR_MODEL: "x",
  DEFAULT_TITLE_MODEL: "x",
  CLAUDE_LOW_MODELS: [],
  OPENAI_LOW_MODELS: [],
  resolveModel: vi.fn(),
}));
vi.mock("../lib/llm/localConfig", () => ({
  getLocalLlmStatus: vi.fn(() => ({ configured: false })),
}));
vi.mock("../lib/mcpConnectors", () => ({
  completeUserMcpConnectorOAuth: vi.fn(),
  createUserMcpConnector: vi.fn(),
  deleteUserMcpConnector: vi.fn(),
  getUserMcpConnector: vi.fn(),
  listUserMcpConnectors: vi.fn(),
  McpOAuthRequiredError: class extends Error {},
  refreshUserMcpConnectorTools: vi.fn(),
  setUserMcpToolEnabled: vi.fn(),
  startUserMcpConnectorOAuth: vi.fn(),
  updateUserMcpConnector: vi.fn(),
}));
vi.mock("../lib/userDataCleanup", () => ({
  deleteAllUserChats: vi.fn(),
  deleteAllUserTabularReviews: vi.fn(),
  deleteUserAccountData: vi.fn(),
  deleteUserProjects: vi.fn(),
}));
vi.mock("../lib/userDataExport", () => ({
  buildUserAccountExport: vi.fn(),
  buildUserChatsExport: vi.fn(),
  buildUserTabularReviewsExport: vi.fn(),
  userExportFilename: vi.fn(() => "export.json"),
}));

import { getUserApiKeyStatus } from "../lib/userApiKeys";
import { userRouter } from "./user";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/user", userRouter);
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
  vi.mocked(getUserApiKeyStatus).mockReset();
});

describe("GET /user/profile — async-handler safety net", () => {
  it("returns a fixed generic 500 (not a hang) when getUserApiKeyStatus rejects, without leaking the error", async () => {
    // Reproduces the production failure: a lost service_role grant makes the
    // status lookup throw with a Postgres 42501 permission error. The handler
    // has no inner try/catch — the asyncHandler wrapper must catch it, respond
    // 500 with a FIXED detail, and never surface the raw DB text.
    vi.mocked(getUserApiKeyStatus).mockRejectedValue(
      new Error(
        'permission denied for table user_api_keys: code 42501, hint "GRANT to service_role"',
      ),
    );

    const res = await fetch(`${baseUrl}/user/profile`, {
      headers: { Authorization: "Bearer test" },
    });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({
      detail: "Something went wrong. Please try again.",
    });
    // The raw Postgres error text must never reach the client.
    expect(JSON.stringify(body)).not.toContain("42501");
    expect(JSON.stringify(body)).not.toContain("permission denied");
  });
});
