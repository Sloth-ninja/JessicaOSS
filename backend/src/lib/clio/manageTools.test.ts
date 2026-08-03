import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the document-side dependencies of clio_save_document_to_matter so the
// access-enforcement + size-cap branches can be exercised without real storage.
vi.mock("../access", () => ({ ensureDocAccess: vi.fn() }));
vi.mock("../documentVersions", () => ({ loadActiveVersion: vi.fn() }));
vi.mock("../storage", () => ({ downloadFile: vi.fn() }));
vi.mock("../organisations", () => ({
  getUserOrganisationId: vi.fn(async () => null),
}));

import { ensureDocAccess } from "../access";
import { loadActiveVersion } from "../documentVersions";
import { downloadFile } from "../storage";
import { makeClioDb } from "./fakeClioDb";
import { saveClioConnection } from "./connections";
import { resetClioClientStateForTests } from "./client";
import {
  executeClioManageToolCall,
  minutesToSeconds,
  type ClioManageToolContext,
} from "./manageTools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = (db: unknown) => db as any;

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
    product: "manage",
    tokens: {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
      scope: null,
    },
  });
  return db;
}

function ctx(db: unknown): ClioManageToolContext {
  return { db: asDb(db), userId: "user-1", userEmail: "user@example.com" };
}

beforeEach(() => {
  resetClioClientStateForTests();
  process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-clio-secret-value";
  process.env.CLIO_CLIENT_ID = "m-id";
  process.env.CLIO_CLIENT_SECRET = "m-secret";
  vi.mocked(ensureDocAccess).mockReset();
  vi.mocked(loadActiveVersion).mockReset();
  vi.mocked(downloadFile).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("minutesToSeconds", () => {
  it("converts minutes to seconds (6 -> 360)", () => {
    expect(minutesToSeconds(6)).toBe(360);
  });
  it("handles fractional minutes", () => {
    expect(minutesToSeconds(0.5)).toBe(30);
  });
  it("accepts a numeric string", () => {
    expect(minutesToSeconds("15")).toBe(900);
  });
  it("rejects zero and negative durations", () => {
    expect(() => minutesToSeconds(0)).toThrow();
    expect(() => minutesToSeconds(-5)).toThrow();
  });
  it("rejects absurd (>24h) durations", () => {
    expect(() => minutesToSeconds(24 * 60 + 1)).toThrow();
  });
});

describe("not-connected gating", () => {
  it("returns a friendly error (never throws) when Clio is not connected", async () => {
    const db = makeClioDb();
    vi.stubGlobal("fetch", vi.fn());
    const { event, content } = await executeClioManageToolCall(
      "clio_find_matter",
      { query: "Acme" },
      ctx(db),
    );
    expect(event.status).toBe("error");
    expect(event.error).toMatch(/connect your clio/i);
    expect(JSON.parse(content).error).toBeTruthy();
  });
});

describe("clio_find_matter — happy path + error mapping", () => {
  it("returns the matter list on success", async () => {
    const db = await connectedDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ data: [{ id: 7, display_number: "0001-0007" }] }),
      ),
    );
    const { event, content } = await executeClioManageToolCall(
      "clio_find_matter",
      { query: "Acme" },
      ctx(db),
    );
    expect(event.status).toBe("ok");
    expect(JSON.parse(content).data[0].display_number).toBe("0001-0007");
  });

  it("maps an upstream 500 to a fixed generic error (no raw text)", async () => {
    const db = await connectedDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "internal secret detail" }, 500)),
    );
    const { event } = await executeClioManageToolCall(
      "clio_find_matter",
      { query: "Acme" },
      ctx(db),
    );
    expect(event.status).toBe("error");
    expect(event.error).not.toMatch(/secret/);
  });
});

describe("clio_record_time — minutes converted to seconds", () => {
  it("posts quantity in seconds and honours the billable flag", async () => {
    const db = await connectedDb();
    let sentBody: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body ?? "{}"));
        return json({ data: { id: 55, quantity: 360 } });
      }),
    );
    const { event } = await executeClioManageToolCall(
      "clio_record_time",
      { matter_id: "7", minutes: 6, description: "Drafting", billable: false },
      ctx(db),
    );
    expect(event.status).toBe("ok");
    const data = (sentBody as { data: Record<string, unknown> }).data;
    expect(data.quantity).toBe(360);
    expect(data.non_billable).toBe(true);
    expect(data.note).toBe("Drafting");
    // The created entry is echoed for chat confirmation.
    expect(event.result).toBeTruthy();
  });

  it("rejects a non-positive duration with a friendly error", async () => {
    const db = await connectedDb();
    vi.stubGlobal("fetch", vi.fn());
    const { event } = await executeClioManageToolCall(
      "clio_record_time",
      { matter_id: "7", minutes: 0, description: "x" },
      ctx(db),
    );
    expect(event.status).toBe("error");
    expect(event.error).toMatch(/positive number of minutes/i);
  });
});

describe("clio_save_document_to_matter — access + size", () => {
  const docRow = {
    id: "doc-1",
    user_id: "someone-else",
    project_id: null,
    filename: "brief.docx",
  };

  function dbWithDoc() {
    // A db whose documents query returns docRow; connections are absent (the
    // access check fails before any Clio call).
    return {
      from(table: string) {
        if (table === "documents") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: docRow, error: null }),
              }),
            }),
          };
        }
        return makeClioDb().from(table);
      },
    };
  }

  it("refuses when ensureDocAccess denies access", async () => {
    vi.mocked(ensureDocAccess).mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", vi.fn());
    const { event } = await executeClioManageToolCall(
      "clio_save_document_to_matter",
      { document_id: "doc-1", matter_id: "7" },
      ctx(dbWithDoc()),
    );
    expect(event.status).toBe("error");
    expect(event.error).toMatch(/do not have access/i);
  });

  it("refuses a document over the 25 MB cap", async () => {
    vi.mocked(ensureDocAccess).mockResolvedValue({ ok: true, isOwner: true });
    vi.mocked(loadActiveVersion).mockResolvedValue({
      id: "v1",
      storage_path: "path/v1",
      pdf_storage_path: null,
      version_number: 1,
      filename: "brief.docx",
      source: null,
      file_type: "docx",
      size_bytes: null,
      page_count: null,
    });
    const tooBig = Buffer.alloc(26 * 1024 * 1024);
    vi.mocked(downloadFile).mockResolvedValue(
      tooBig.buffer.slice(0, tooBig.byteLength) as ArrayBuffer,
    );
    vi.stubGlobal("fetch", vi.fn());
    const { event } = await executeClioManageToolCall(
      "clio_save_document_to_matter",
      { document_id: "doc-1", matter_id: "7" },
      ctx(dbWithDoc()),
    );
    expect(event.status).toBe("error");
    expect(event.error).toMatch(/too large/i);
  });
});
