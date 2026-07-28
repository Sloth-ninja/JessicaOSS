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

// GET /user/firm-members (WS9): the firm-member people-picker source. Org
// members only; orgless ⇒ empty; only displayName + email exposed.
const state = vi.hoisted(() => ({ orgId: "org-1" as string | null }));

vi.mock("../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "caller";
    res.locals.userEmail = "caller@firm.test";
    res.locals.token = "token";
    next();
  },
  requireMemberPolicy: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => ({}),
}));

const listOrganisationMembers = vi.fn();
vi.mock("../lib/organisations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/organisations")>();
  return {
    ...actual,
    getUserOrganisationId: () => Promise.resolve(state.orgId),
    listOrganisationMembers: (...args: unknown[]) =>
      listOrganisationMembers(...args),
  };
});

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
  state.orgId = "org-1";
  listOrganisationMembers.mockReset();
});

describe("GET /user/firm-members", () => {
  it("returns an empty list for an orgless caller (no member query)", async () => {
    state.orgId = null;
    const res = await fetch(`${baseUrl}/user/firm-members`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ members: [] });
    expect(listOrganisationMembers).not.toHaveBeenCalled();
  });

  it("returns only displayName + email for firm members (no id/role leak)", async () => {
    listOrganisationMembers.mockResolvedValue([
      {
        userId: "u1",
        displayName: "Alex Solicitor",
        email: "alex@firm.test",
        role: "admin",
        createdAt: "2026-01-01",
      },
      {
        userId: "u2",
        displayName: null,
        email: "sam@firm.test",
        role: "member",
        createdAt: "2026-01-02",
      },
    ]);
    const res = await fetch(`${baseUrl}/user/firm-members`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      members: [
        { displayName: "Alex Solicitor", email: "alex@firm.test" },
        { displayName: null, email: "sam@firm.test" },
      ],
    });
    expect(listOrganisationMembers).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
    );
  });
});
