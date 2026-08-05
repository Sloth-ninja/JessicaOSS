import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeClioDb } from "./fakeClioDb";
import { saveClioConnection } from "./connections";
import { resetClioClientStateForTests } from "./client";
import { executeClioGrowToolCall, type ClioGrowToolContext } from "./growTools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = (db: unknown) => db as any;

// These tests perform real scrypt AES-256-GCM key derivation via
// saveClioConnection/loadClioConnection. Real KDF work under concurrent
// machine load (parallel agent suites) has blown 5s AND 20s ceilings while
// passing in isolation — that flake is contention, not a defect
// (DURABLE_LESSONS 2026-08-05), so the ceiling is deliberately generous.
vi.setConfig({ testTimeout: 120_000 });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function connectedDb() {
  const db = makeClioDb();
  await saveClioConnection(asDb(db), {
    userId: "user-1",
    product: "grow",
    tokens: {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 20 * 60 * 60 * 1000),
      scope: null,
    },
  });
  return db;
}

function ctx(db: unknown): ClioGrowToolContext {
  return { db: asDb(db), userId: "user-1" };
}

beforeEach(() => {
  resetClioClientStateForTests();
  process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-clio-secret-value";
  process.env.CLIO_GROW_CLIENT_ID = "g-id";
  process.env.CLIO_GROW_CLIENT_SECRET = "g-secret";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clio_intake_status", () => {
  it("returns the intake matters on success", async () => {
    const db = await connectedDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ data: [{ id: 3, status: "KYC Check" }] })),
    );
    const { event, content } = await executeClioGrowToolCall(
      "clio_intake_status",
      {},
      ctx(db),
    );
    expect(event.status).toBe("ok");
    expect(event.product).toBe("grow");
    expect(JSON.parse(content).data[0].status).toBe("KYC Check");
  });

  it("returns a friendly error when Grow is not connected", async () => {
    const db = makeClioDb();
    vi.stubGlobal("fetch", vi.fn());
    const { event } = await executeClioGrowToolCall(
      "clio_intake_status",
      {},
      ctx(db),
    );
    expect(event.status).toBe("error");
    expect(event.error).toMatch(/connect your clio/i);
  });
});

describe("clio_add_intake_note", () => {
  it("posts the note on success", async () => {
    const db = await connectedDb();
    let sent: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string | URL, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body ?? "{}"));
        return json({ id: 1, subject: "KYB" });
      }),
    );
    const { event } = await executeClioGrowToolCall(
      "clio_add_intake_note",
      { matter_id: "3", subject: "KYB", body: "Companies House check clear." },
      ctx(db),
    );
    expect(event.status).toBe("ok");
    expect((sent as { subject: string }).subject).toBe("KYB");
    expect(event.result).toBeTruthy();
  });

  it("rejects an over-length subject before calling Clio", async () => {
    const db = await connectedDb();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { event } = await executeClioGrowToolCall(
      "clio_add_intake_note",
      { matter_id: "3", subject: "x".repeat(256), body: "b" },
      ctx(db),
    );
    expect(event.status).toBe("error");
    expect(event.error).toMatch(/subject/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an over-length body before calling Clio", async () => {
    const db = await connectedDb();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { event } = await executeClioGrowToolCall(
      "clio_add_intake_note",
      { matter_id: "3", subject: "s", body: "x".repeat(65536) },
      ctx(db),
    );
    expect(event.status).toBe("error");
    expect(event.error).toMatch(/body/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires matter id, subject and body", async () => {
    const db = await connectedDb();
    vi.stubGlobal("fetch", vi.fn());
    const { event } = await executeClioGrowToolCall(
      "clio_add_intake_note",
      { matter_id: "3", subject: "s" },
      ctx(db),
    );
    expect(event.status).toBe("error");
  });
});

describe("executor failure logging (error containment)", () => {
  it("logs the original internal error via [clio/tools] but not validation errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Internal failure: a Postgrest-shaped PLAIN object thrown from the db
      // layer — contained by the executor, so it must be logged here or it is
      // logged nowhere.
      const badDb = {
        from() {
          throw {
            message: "permission denied for table user_clio_connections",
            code: "42501",
          };
        },
      };
      const internal = await executeClioGrowToolCall(
        "clio_intake_status",
        {},
        ctx(badDb),
      );
      expect(internal.event.status).toBe("error");
      expect(internal.event.error).not.toMatch(/permission denied/);
      const call = spy.mock.calls.find(
        (c) => c[0] === "[clio/tools] tool failed",
      );
      expect(call).toBeTruthy();
      const details = call?.[1] as {
        toolName: string;
        error: { message: string };
      };
      expect(details.toolName).toBe("clio_intake_status");
      expect(details.error.message).toMatch(/permission denied/);

      spy.mockClear();
      // Expected validation failure (missing matter id): unlogged.
      const db = await connectedDb();
      vi.stubGlobal("fetch", vi.fn());
      const validation = await executeClioGrowToolCall(
        "clio_intake_notes",
        {},
        ctx(db),
      );
      expect(validation.event.status).toBe("error");
      expect(
        spy.mock.calls.filter((c) => c[0] === "[clio/tools] tool failed"),
      ).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
