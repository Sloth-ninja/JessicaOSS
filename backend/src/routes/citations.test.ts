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
  verifyCitation: vi.fn(),
}));

import { verifyCitation } from "../lib/legislation";
import { citationsRouter } from "./citations";

const EXPECTED_CASE_LAW_REASON =
  "Case-law citations cannot be verified: Find Case Law integration is deferred pending The National Archives' computational-use licence, and BAILII must never be used. Check an authorised source.";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use("/citations", citationsRouter);
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
  vi.mocked(verifyCitation).mockReset();
});

async function check(body: unknown) {
  const res = await fetch(`${baseUrl}/citations/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /citations/check", () => {
  it("maps a resolved citation to status 'verified' with its canonical URL", async () => {
    vi.mocked(verifyCitation).mockResolvedValue({
      citation: "s.994 Companies Act 2006",
      resolved: true,
      url: "https://www.legislation.gov.uk/ukpga/2006/46/section/994",
    });
    const { status, body } = await check({
      text: "Under s.994 Companies Act 2006 a member may petition.",
    });
    expect(status).toBe(200);
    expect(body).toEqual({
      results: [
        {
          raw: "s.994 Companies Act 2006",
          kind: "statute-section",
          status: "verified",
          url: "https://www.legislation.gov.uk/ukpga/2006/46/section/994",
        },
      ],
    });
    expect(verifyCitation).toHaveBeenCalledTimes(1);
    expect(verifyCitation).toHaveBeenCalledWith("s.994 Companies Act 2006");
  });

  it("maps an unresolved citation to status 'unverified' with the resolver's reason", async () => {
    vi.mocked(verifyCitation).mockResolvedValue({
      citation: "s.9999 Companies Act 2006",
      resolved: false,
      reason: "legislation.gov.uk returned HTTP 404",
    });
    const { status, body } = await check({
      text: "See s.9999 Companies Act 2006.",
    });
    expect(status).toBe(200);
    expect(body.results).toEqual([
      {
        raw: "s.9999 Companies Act 2006",
        kind: "statute-section",
        status: "unverified",
        reason: "legislation.gov.uk returned HTTP 404",
      },
    ]);
  });

  it("marks neutral-case citations 'unverifiable' with the fixed copy and never calls the resolver for them", async () => {
    const { status, body } = await check({
      text: "The reasoning in [2024] UKSC 12 applies.",
    });
    expect(status).toBe(200);
    expect(body.results).toEqual([
      {
        raw: "[2024] UKSC 12",
        kind: "neutral-case",
        status: "unverifiable",
        reason: EXPECTED_CASE_LAW_REASON,
      },
    ]);
    expect(verifyCitation).not.toHaveBeenCalled();
  });

  it("handles a mixed text: statute verified, case law unverifiable, order preserved", async () => {
    vi.mocked(verifyCitation).mockImplementation(async (raw: string) => ({
      citation: raw,
      resolved: true,
      url: `https://www.legislation.gov.uk/resolved`,
    }));
    const { body } = await check({
      text: "s.994 Companies Act 2006 and the Insolvency Act 1986; see [2024] UKSC 12.",
    });
    expect(
      body.results.map((r: { kind: string; status: string }) => [
        r.kind,
        r.status,
      ]),
    ).toEqual([
      ["statute-section", "verified"],
      ["act", "verified"],
      ["neutral-case", "unverifiable"],
    ]);
  });

  it("caps verification at 50 citations per request", async () => {
    vi.mocked(verifyCitation).mockImplementation(async (raw: string) => ({
      citation: raw,
      resolved: true,
      url: "https://www.legislation.gov.uk/resolved",
    }));
    const text = Array.from({ length: 60 }, (_, i) => `SI 2000/${i + 1}`).join(
      "; ",
    );
    const { status, body } = await check({ text });
    expect(status).toBe(200);
    expect(body.results).toHaveLength(50);
    expect(verifyCitation).toHaveBeenCalledTimes(50);
  });

  it("returns 413 when the text exceeds 20,000 characters", async () => {
    const { status, body } = await check({ text: "a".repeat(20_001) });
    expect(status).toBe(413);
    expect(typeof body.detail).toBe("string");
    expect(verifyCitation).not.toHaveBeenCalled();
  });

  it("accepts text at exactly the 20,000-character cap", async () => {
    const { status, body } = await check({ text: "a".repeat(20_000) });
    expect(status).toBe(200);
    expect(body.results).toEqual([]);
  });

  it("returns 400 when text is missing or not a string", async () => {
    expect((await check({})).status).toBe(400);
    expect((await check({ text: 42 })).status).toBe(400);
    expect((await check({ text: "   " })).status).toBe(400);
  });

  it("returns a fixed generic 500 detail when verification throws, without leaking the error", async () => {
    vi.mocked(verifyCitation).mockRejectedValue(
      new Error("supabase exploded: secret-internal-state"),
    );
    const { status, body } = await check({
      text: "See s.994 Companies Act 2006.",
    });
    expect(status).toBe(500);
    expect(body).toEqual({
      detail: "Citation check failed. Please try again.",
    });
  });
});
