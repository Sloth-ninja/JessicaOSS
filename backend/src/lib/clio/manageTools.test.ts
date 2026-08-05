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
  decodeMatterPageToken,
  encodeMatterPageToken,
  executeClioManageToolCall,
  matterPageTokenFromNext,
  minutesToSeconds,
  parseMatterStatusFilter,
  type ClioManageToolContext,
} from "./manageTools";

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
  it("returns the matter list with count/total/has_more on success", async () => {
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
    const payload = JSON.parse(content);
    expect(payload.matters[0].display_number).toBe("0001-0007");
    expect(payload.count).toBe(1);
    expect(payload.total_entries).toBeNull();
    expect(payload.has_more).toBe(false);
    expect(payload.next_page_token).toBeUndefined();
  });

  it("requests a 100-result page and passes the status filter through", async () => {
    const db = await connectedDb();
    const fetchMock = vi.fn(async (_url: string | URL) => json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { event } = await executeClioManageToolCall(
      "clio_find_matter",
      { query: "Kyckr", status: "open" },
      ctx(db),
    );
    expect(event.status).toBe("ok");
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v4/matters.json");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.get("query")).toBe("Kyckr");
    expect(url.searchParams.get("fields")).toContain("display_number");
  });

  it("searches by status alone (no query) and normalises the list", async () => {
    const db = await connectedDb();
    const fetchMock = vi.fn(async (_url: string | URL) => json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { event } = await executeClioManageToolCall(
      "clio_find_matter",
      { status: "Open, pending" },
      ctx(db),
    );
    expect(event.status).toBe("ok");
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("status")).toBe("open,pending");
    expect(url.searchParams.get("query")).toBeNull();
  });

  it("rejects an unknown status value with a friendly error", async () => {
    const db = await connectedDb();
    vi.stubGlobal("fetch", vi.fn());
    const { event } = await executeClioManageToolCall(
      "clio_find_matter",
      { query: "Acme", status: "archived" },
      ctx(db),
    );
    expect(event.status).toBe("error");
    expect(event.error).toMatch(/'open', 'pending', 'closed'/);
  });

  it("requires a query, status, or page token", async () => {
    const db = await connectedDb();
    vi.stubGlobal("fetch", vi.fn());
    const { event } = await executeClioManageToolCall(
      "clio_find_matter",
      {},
      ctx(db),
    );
    expect(event.status).toBe("error");
    expect(event.error).toMatch(/query and\/or a status filter/i);
  });

  it("surfaces meta.records and extracts the opaque cursor from meta.paging.next", async () => {
    const db = await connectedDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          data: [{ id: 1 }, { id: 2 }],
          meta: {
            records: 26,
            paging: {
              next: "https://eu.app.clio.com/api/v4/matters.json?limit=100&page_token=abc123&status=open",
            },
          },
        }),
      ),
    );
    const { content } = await executeClioManageToolCall(
      "clio_find_matter",
      { query: "Kyckr", status: "open" },
      ctx(db),
    );
    const payload = JSON.parse(content);
    expect(payload.count).toBe(2);
    expect(payload.total_entries).toBe(26);
    expect(payload.has_more).toBe(true);
    // The minted token is BOUND: cursor plus the filters this page used.
    const decoded = JSON.parse(
      Buffer.from(payload.next_page_token, "base64url").toString("utf8"),
    );
    expect(decoded).toEqual({ c: "abc123", q: "Kyckr", s: "open" });
  });

  it("reports has_more from the RAW next URL even when no cursor can be extracted", async () => {
    const db = await connectedDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          data: [{ id: 1 }],
          meta: {
            paging: {
              next: "https://evil.example.com/matters.json?page_token=x",
            },
          },
        }),
      ),
    );
    const { content } = await executeClioManageToolCall(
      "clio_find_matter",
      { query: "Kyckr" },
      ctx(db),
    );
    const payload = JSON.parse(content);
    expect(payload.has_more).toBe(true);
    expect(payload.next_page_token).toBeUndefined();
  });

  it("sends a continuation as a rebuilt request using the token's bound filters", async () => {
    const db = await connectedDb();
    const fetchMock = vi.fn(async (_url: string | URL) =>
      json({ data: [{ id: 3 }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const token = encodeMatterPageToken("abc123", "Kyckr", "open");
    const { event, content } = await executeClioManageToolCall(
      "clio_find_matter",
      { page_token: token },
      ctx(db),
    );
    expect(event.status).toBe("ok");
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v4/matters.json");
    expect(url.searchParams.get("page_token")).toBe("abc123");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("query")).toBe("Kyckr");
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.get("fields")).toContain("display_number");
    expect(JSON.parse(content).count).toBe(1);
  });

  it("ignores model-supplied query/status when a page_token is present", async () => {
    const db = await connectedDb();
    const fetchMock = vi.fn(async (_url: string | URL) => json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const token = encodeMatterPageToken("abc123", "Kyckr", "open");
    const { event } = await executeClioManageToolCall(
      "clio_find_matter",
      { page_token: token, query: "Different Client", status: "closed" },
      ctx(db),
    );
    expect(event.status).toBe("ok");
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    // The bound filters win; the conflicting model args never reach Clio.
    expect(url.searchParams.get("query")).toBe("Kyckr");
    expect(url.searchParams.get("status")).toBe("open");
  });

  it("rejects a tampered or garbage page_token before any fetch", async () => {
    const db = await connectedDb();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bad of [
      "/matters.json/../../../api/v4/bills.json",
      "!!!not-base64url!!!",
      Buffer.from(JSON.stringify({ x: 1 })).toString("base64url"),
      Buffer.from(JSON.stringify({ c: 42 })).toString("base64url"),
    ]) {
      const { event } = await executeClioManageToolCall(
        "clio_find_matter",
        { page_token: bad },
        ctx(db),
      );
      expect(event.status).toBe("error");
      expect(event.error).toMatch(/page token is not valid/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a decoded status that is not a valid filter", async () => {
    const db = await connectedDb();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tampered = Buffer.from(
      JSON.stringify({ c: "abc123", s: "archived" }),
    ).toString("base64url");
    const { event } = await executeClioManageToolCall(
      "clio_find_matter",
      { page_token: tampered },
      ctx(db),
    );
    expect(event.status).toBe("error");
    expect(event.error).toMatch(/'open', 'pending', 'closed'/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a hand-crafted cursor-only token (no bound filters) before any fetch", async () => {
    const db = await connectedDb();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // Decodes fine ({ c }), but carries neither query nor status — issuing it
    // would be the UNFILTERED fetch the token binding exists to prevent.
    const bare = Buffer.from(JSON.stringify({ c: "abc123" })).toString(
      "base64url",
    );
    const { event } = await executeClioManageToolCall(
      "clio_find_matter",
      { page_token: bare },
      ctx(db),
    );
    expect(event.status).toBe("error");
    expect(event.error).toMatch(/query and\/or a status filter/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an over-length (257-char) query at token-mint time", async () => {
    const db = await connectedDb();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { event } = await executeClioManageToolCall(
      "clio_find_matter",
      { query: "a".repeat(257) },
      ctx(db),
    );
    expect(event.status).toBe("error");
    expect(event.error).toMatch(/too long/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a null (204/unparseable) body to an error, never an authoritative empty list", async () => {
    const db = await connectedDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const { event } = await executeClioManageToolCall(
      "clio_find_matter",
      { query: "Acme" },
      ctx(db),
    );
    expect(event.status).toBe("error");
    expect(event.error).toMatch(/could not be read/i);
  });

  it("rejects an over-length page_token before decoding", async () => {
    const db = await connectedDb();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { event } = await executeClioManageToolCall(
      "clio_find_matter",
      { page_token: "a".repeat(1025) },
      ctx(db),
    );
    expect(event.status).toBe("error");
    expect(event.error).toMatch(/page token is not valid/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits a minted token that exceeds the decoder's cap, keeping has_more honest", async () => {
    const db = await connectedDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          data: [{ id: 1 }],
          meta: {
            paging: {
              next: "https://eu.app.clio.com/api/v4/matters.json?limit=100&page_token=abc123",
            },
          },
        }),
      ),
    );
    // 256 CJK chars pass the mint-side length cap but weigh 3 UTF-8 bytes
    // each, pushing the base64url envelope past MAX_PAGE_TOKEN_LENGTH — a
    // token our own decoder would refuse on the follow-up call.
    const { content } = await executeClioManageToolCall(
      "clio_find_matter",
      { query: "亜".repeat(256) },
      ctx(db),
    );
    const payload = JSON.parse(content);
    expect(payload.has_more).toBe(true);
    expect(payload.next_page_token).toBeUndefined();
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

describe("null-body guard on the sibling read tools", () => {
  it("clio_find_contact maps a null (204) body to an error", async () => {
    const db = await connectedDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const { event } = await executeClioManageToolCall(
      "clio_find_contact",
      { query: "Jane" },
      ctx(db),
    );
    expect(event.status).toBe("error");
    expect(event.error).toMatch(/could not be read/i);
  });

  it("clio_list_matter_documents maps a null (204) body to an error", async () => {
    const db = await connectedDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const { event } = await executeClioManageToolCall(
      "clio_list_matter_documents",
      { matter_id: "7" },
      ctx(db),
    );
    expect(event.status).toBe("error");
    expect(event.error).toMatch(/could not be read/i);
  });
});

describe("executor failure logging (error containment)", () => {
  it("logs the original error via [clio/tools] for an internal (Postgrest-shaped) throw", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Postgrest errors reach the executor as PLAIN objects, not Errors —
      // exactly the shape that used to vanish (chatTools' stream-error log
      // never fires for Clio tools because the executor contains the throw).
      const db = {
        from() {
          throw {
            message: "permission denied for table documents",
            code: "42501",
          };
        },
      };
      const { event } = await executeClioManageToolCall(
        "clio_save_document_to_matter",
        { document_id: "doc-1", matter_id: "7" },
        ctx(db),
      );
      expect(event.status).toBe("error");
      // The client-facing message stays fixed and generic.
      expect(event.error).not.toMatch(/permission denied/);
      const call = spy.mock.calls.find(
        (c) => c[0] === "[clio/tools] tool failed",
      );
      expect(call).toBeTruthy();
      const details = call?.[1] as {
        toolName: string;
        error: { message: string };
      };
      expect(details.toolName).toBe("clio_save_document_to_matter");
      expect(details.error.message).toMatch(/permission denied/);
    } finally {
      spy.mockRestore();
    }
  });

  it("does NOT log expected validation failures", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const db = await connectedDb();
      vi.stubGlobal("fetch", vi.fn());
      const { event } = await executeClioManageToolCall(
        "clio_find_matter",
        {},
        ctx(db),
      );
      expect(event.status).toBe("error");
      expect(
        spy.mock.calls.filter((c) => c[0] === "[clio/tools] tool failed"),
      ).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("parseMatterStatusFilter", () => {
  it("returns undefined for an absent filter", () => {
    expect(parseMatterStatusFilter(undefined)).toBeUndefined();
    expect(parseMatterStatusFilter("")).toBeUndefined();
  });
  it("normalises case, whitespace, and duplicates", () => {
    expect(parseMatterStatusFilter(" Closed ,OPEN,closed")).toBe("closed,open");
  });
  it("throws on unknown values", () => {
    expect(() => parseMatterStatusFilter("open,archived")).toThrow(
      /'open', 'pending', 'closed'/,
    );
  });
});

describe("matterPageTokenFromNext", () => {
  it("extracts only the opaque page_token cursor from a matters next URL", () => {
    expect(
      matterPageTokenFromNext(
        "https://eu.app.clio.com/api/v4/matters.json?fields=id&page_token=x1y2&limit=100",
      ),
    ).toBe("x1y2");
  });
  it("returns undefined when the next URL carries no page_token", () => {
    expect(
      matterPageTokenFromNext(
        "https://eu.app.clio.com/api/v4/matters.json?limit=100",
      ),
    ).toBeUndefined();
  });
  it("rejects path traversal — URL normalisation defeats the pathname check", () => {
    expect(
      matterPageTokenFromNext(
        "https://eu.app.clio.com/api/v4/matters.json/../../../api/v4/bills.json?page_token=x",
      ),
    ).toBeUndefined();
  });
  it("rejects suffix-path, non-matters, off-host, and protocol-relative URLs", () => {
    expect(
      matterPageTokenFromNext(
        "https://eu.app.clio.com/api/v4/matters.jsonx/steal?page_token=x",
      ),
    ).toBeUndefined();
    expect(
      matterPageTokenFromNext(
        "https://eu.app.clio.com/api/v4/contacts.json?page_token=x",
      ),
    ).toBeUndefined();
    expect(
      matterPageTokenFromNext(
        "https://evil.example.com/api/v4/matters.json?page_token=x",
      ),
    ).toBeUndefined();
    expect(
      matterPageTokenFromNext(
        "//evil.example.com/api/v4/matters.json?page_token=x",
      ),
    ).toBeUndefined();
  });
  it("rejects the suffix-domain and userinfo host spoofs (2026-07-28 lesson)", () => {
    // Suffix-domain: the real host is a literal prefix of an attacker domain.
    expect(
      matterPageTokenFromNext(
        "https://eu.app.clio.com.evil.example.com/api/v4/matters.json?page_token=x",
      ),
    ).toBeUndefined();
    // Userinfo: everything before @ is credentials; the real host is evil.
    expect(
      matterPageTokenFromNext(
        "https://eu.app.clio.com@evil.example.com/api/v4/matters.json?page_token=x",
      ),
    ).toBeUndefined();
  });
  it("returns undefined for malformed or non-string input", () => {
    expect(matterPageTokenFromNext("not a url")).toBeUndefined();
    expect(matterPageTokenFromNext(null)).toBeUndefined();
  });
});

describe("matter page token encode/decode", () => {
  it("round-trips cursor + bound filters", () => {
    const token = encodeMatterPageToken("cur-1", "Kyckr", "open,pending");
    expect(decodeMatterPageToken(token)).toEqual({
      cursor: "cur-1",
      query: "Kyckr",
      status: "open,pending",
    });
  });
  it("omits absent filters and decodes a cursor-only token", () => {
    const token = encodeMatterPageToken("cur-2");
    expect(decodeMatterPageToken(token)).toEqual({ cursor: "cur-2" });
  });
  it("throws the friendly validation error on garbage", () => {
    expect(() => decodeMatterPageToken("zzz")).toThrow(
      /page token is not valid/i,
    );
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
