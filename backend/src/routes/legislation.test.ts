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

vi.mock("../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "test-user";
    next();
  },
}));

vi.mock("../lib/legislation", () => ({
  search: vi.fn(),
  lookupCitation: vi.fn(),
}));

import { search, lookupCitation } from "../lib/legislation";
import { legislationRouter } from "./legislation";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/legislation", legislationRouter);
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
  vi.mocked(search).mockReset();
  vi.mocked(lookupCitation).mockReset();
});

async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

describe("GET /legislation/search", () => {
  it("wraps the lib matches under { matches } and forwards the trimmed title", async () => {
    const matches = [
      {
        title: "Companies Act 2006",
        type: "ukpga",
        year: 2006,
        number: "46",
        url: "https://www.legislation.gov.uk/ukpga/2006/46",
      },
    ];
    vi.mocked(search).mockResolvedValue(matches);
    const { status, body } = await get(
      "/legislation/search?title=%20companies%20act%202006%20",
    );
    expect(status).toBe(200);
    expect(body).toEqual({ matches });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("companies act 2006");
  });

  it("returns 400 when the title is missing or blank, without calling the lib", async () => {
    expect((await get("/legislation/search")).status).toBe(400);
    expect((await get("/legislation/search?title=%20%20")).status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it("returns a fixed generic 502 when the lib throws, never leaking the error", async () => {
    vi.mocked(search).mockRejectedValue(
      new Error("network blew up: secret-internal-state"),
    );
    const { status, body } = await get("/legislation/search?title=companies");
    expect(status).toBe(502);
    expect(body).toEqual({
      detail: "Could not reach legislation.gov.uk. Please try again later.",
    });
    expect(JSON.stringify(body)).not.toMatch(/secret-internal-state/);
  });
});

describe("GET /legislation/lookup", () => {
  it("maps a resolved lookup to the snake_case success payload", async () => {
    vi.mocked(lookupCitation).mockResolvedValue({
      resolved: true,
      canonicalUrl: "https://www.legislation.gov.uk/ukpga/2006/46/section/994",
      title: "Companies Act 2006, s.994",
      heading: "Petition by company member",
      text: "A member of a company may apply...",
      extent: "E+W+S+N.I.",
      outstandingEffects: true,
      unappliedEffects: [
        {
          type: "inserted",
          notes: "not yet applied",
          affectedProvisions: "s.994A",
        },
      ],
    });
    const { status, body } = await get(
      "/legislation/lookup?citation=s.994%20Companies%20Act%202006",
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      resolved: true,
      title: "Companies Act 2006, s.994",
      url: "https://www.legislation.gov.uk/ukpga/2006/46/section/994",
      heading: "Petition by company member",
      text: "A member of a company may apply...",
      extent: "E+W+S+N.I.",
      outstanding_effects: true,
      unapplied_effects: [
        {
          type: "inserted",
          notes: "not yet applied",
          affectedProvisions: "s.994A",
        },
      ],
    });
    expect(lookupCitation).toHaveBeenCalledWith("s.994 Companies Act 2006");
  });

  it("returns HTTP 200 with { resolved:false, citation, reason } on an unresolved citation (domain result, not an error)", async () => {
    vi.mocked(lookupCitation).mockResolvedValue({
      resolved: false,
      citation: "s.9999 Companies Act 2006",
      reason: "legislation.gov.uk returned HTTP 404",
    });
    const { status, body } = await get(
      "/legislation/lookup?citation=s.9999%20Companies%20Act%202006",
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      resolved: false,
      citation: "s.9999 Companies Act 2006",
      reason: "legislation.gov.uk returned HTTP 404",
    });
  });

  it("returns 400 when the citation is missing or blank, without calling the lib", async () => {
    expect((await get("/legislation/lookup")).status).toBe(400);
    expect((await get("/legislation/lookup?citation=%20")).status).toBe(400);
    expect(lookupCitation).not.toHaveBeenCalled();
  });

  it("returns a fixed generic 502 when the lib throws, never leaking the error", async () => {
    vi.mocked(lookupCitation).mockRejectedValue(
      new Error("supabase exploded: secret-internal-state"),
    );
    const { status, body } = await get(
      "/legislation/lookup?citation=s.994%20Companies%20Act%202006",
    );
    expect(status).toBe(502);
    expect(body).toEqual({
      detail: "Could not reach legislation.gov.uk. Please try again later.",
    });
    expect(JSON.stringify(body)).not.toMatch(/secret-internal-state/);
  });
});
