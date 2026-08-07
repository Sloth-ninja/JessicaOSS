import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The link surface composes with the shared access choke point (which also
// enforces the tombstone rule) and the org lookup; both are mocked so the
// seam's own branching is what is under test.
vi.mock("../access", () => ({ checkProjectAccess: vi.fn() }));
vi.mock("../organisations", () => ({
  getUserOrganisationId: vi.fn(async () => "org-1"),
}));

import { checkProjectAccess } from "../access";
import { getUserOrganisationId } from "../organisations";
import { makeClioDb, type FakeClioRow } from "./fakeClioDb";
import { saveClioConnection } from "./connections";
import { ClioApiError, resetClioClientStateForTests } from "./client";
import { ClioValidationError } from "./toolShared";
import {
  BILLED_ENTRY_DETAIL,
  ETAG_CONFLICT_DETAIL,
  MATTERS_PAGE_SIZE,
  NOT_OWN_ENTRY_DETAIL,
  RECONNECT_FOR_OWN_MATTERS_DETAIL,
  createWorkspaceForMatter,
  deleteActivity,
  getLinkForMatter,
  getMatterDetail,
  isLinksSchemaMissing,
  linkWorkspace,
  listActivities,
  listMatters,
  listRelatedContacts,
  resetMattersSurfaceStateForTests,
  unlinkWorkspace,
  updateActivity,
  workspaceNameForMatter,
  type MatterListRow,
} from "./mattersSurface";

/* eslint-disable @typescript-eslint/no-explicit-any */
const asDb = (db: unknown) => db as any;

// Real scrypt AES-256-GCM derivation runs through saveClioConnection /
// loadClioConnection here; under concurrent agent load that has blown 5s and
// 20s ceilings while passing in isolation — contention, not a defect
// (DURABLE_LESSONS 2026-08-05).
vi.setConfig({ testTimeout: 120_000 });

const CLIO_USER_ID = "9001";
const PROJECT_ID = "3f8f3a54-9b5e-4f6e-a9d2-1c2b3d4e5f60";

type Row = Record<string, unknown>;

interface DbOptions {
  rows?: Record<string, Row[]>;
  /** Per-table/op error injection, e.g. an unmigrated links table. */
  errorFor?: (
    table: string,
    op: string,
  ) => { code: string; message: string } | null;
  /** Seed the caller's Clio connection with no stored clio_user_id. */
  withoutClioUserId?: boolean;
}

/**
 * Multi-table in-memory Supabase stand-in. `user_clio_connections` is delegated
 * to the shared Clio fake so the real encryption/rotation path runs; every other
 * table gets a small select/insert/delete/limit builder with a unique(project_id)
 * constraint on the links table.
 */
function makeDb(opts: DbOptions = {}) {
  const store: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(opts.rows ?? {})) {
    store[table] = rows.map((row) => ({ ...row }));
  }
  const rowsOf = (table: string) => (store[table] ??= []);
  const clio = makeClioDb();
  let seq = 0;

  function builder(table: string) {
    const state: {
      op: "select" | "insert" | "delete";
      filters: Array<{ col: string; val: unknown }>;
      payload: Row | null;
      limit?: number;
    } = { op: "select", filters: [], payload: null };

    const matches = (row: Row) =>
      state.filters.every((f) => row[f.col] === f.val);

    function exec(): { data: unknown; error: unknown } {
      const injected = opts.errorFor?.(table, state.op) ?? null;
      if (injected) return { data: null, error: injected };
      if (state.op === "select") {
        let out = rowsOf(table)
          .filter(matches)
          .map((row) => ({ ...row }));
        if (state.limit !== undefined) out = out.slice(0, state.limit);
        return { data: out, error: null };
      }
      if (state.op === "delete") {
        const list = rowsOf(table);
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (matches(list[i])) list.splice(i, 1);
        }
        return { data: null, error: null };
      }
      seq += 1;
      const row: Row = {
        id: `${table}-${seq}`,
        created_at: "2026-08-07T00:00:00.000Z",
        ...(state.payload ?? {}),
      };
      if (
        table === "matter_workspace_links" &&
        rowsOf(table).some((r) => r.project_id === row.project_id)
      ) {
        return { data: null, error: { code: "23505", message: "duplicate" } };
      }
      rowsOf(table).push(row);
      return { data: [{ ...row }], error: null };
    }

    const first = () => {
      const result = exec();
      if (result.error) return { data: null, error: result.error };
      const list = Array.isArray(result.data) ? (result.data as Row[]) : [];
      return { data: list[0] ?? null, error: null };
    };

    const api: any = {
      select(_cols?: string) {
        return api;
      },
      eq(col: string, val: unknown) {
        state.filters.push({ col, val });
        return api;
      },
      limit(n: number) {
        state.limit = n;
        return api;
      },
      insert(payload: Row) {
        state.op = "insert";
        state.payload = payload;
        return api;
      },
      delete() {
        state.op = "delete";
        return api;
      },
      maybeSingle: () => Promise.resolve(first()),
      single: () =>
        Promise.resolve(
          (() => {
            const r = first();
            if (r.error) return r;
            return r.data
              ? r
              : { data: null, error: { code: "PGRST116", message: "none" } };
          })(),
        ),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(exec()).then(res, rej),
    };
    return api;
  }

  return {
    from: (table: string) =>
      table === "user_clio_connections" ? clio.from(table) : builder(table),
    rows: (table: string) => rowsOf(table).map((row) => ({ ...row })),
    clioRows: (): FakeClioRow[] => clio.rows(),
  };
}

async function connectedDb(opts: DbOptions = {}) {
  const db = makeDb(opts);
  await saveClioConnection(asDb(db), {
    userId: "user-1",
    product: "manage",
    tokens: {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
      scope: null,
    },
    clioUserId: opts.withoutClioUserId ? null : CLIO_USER_ID,
    clioUserName: "Test Solicitor",
  });
  return db;
}

interface FetchCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Stub global fetch with a URL-aware handler and record every call. */
function stubFetch(handler: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        (init?.headers ?? {}) as Record<string, string>,
      )) {
        headers[k.toLowerCase()] = v;
      }
      const call: FetchCall = {
        url: new URL(input),
        method: init?.method ?? "GET",
        headers,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MATTER_ROW = {
  id: 7,
  etag: "etag-m7",
  display_number: "0001-0007",
  description: "Acme Ltd share purchase",
  status: "open",
  open_date: "2026-05-01",
  close_date: null,
  client: { id: 42, name: "Acme Ltd" },
  responsible_attorney: { id: 9001, name: "Test Solicitor" },
  originating_attorney: { id: 9002, name: "Another Solicitor" },
  practice_area: { id: 3, name: "Corporate" },
};

const ACTIVITY_ROW = {
  id: 55,
  etag: "etag-a55",
  date: "2026-08-05",
  quantity: 360,
  quantity_redacted: false,
  note: "Drafting",
  type: "TimeEntry",
  non_billable: false,
  billed: false,
  price: 250,
  total: 25,
  user: { id: 9001, name: "Test Solicitor" },
};

beforeEach(() => {
  resetClioClientStateForTests();
  resetMattersSurfaceStateForTests();
  process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-clio-secret-value";
  process.env.CLIO_CLIENT_ID = "m-id";
  process.env.CLIO_CLIENT_SECRET = "m-secret";
  vi.mocked(checkProjectAccess).mockReset();
  vi.mocked(getUserOrganisationId).mockReset().mockResolvedValue("org-1");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── listMatters ──────────────────────────────────────────────────────────────

describe("listMatters — all matters", () => {
  it("makes ONE call, sorted open_date(desc) at one 200-row page", async () => {
    const db = await connectedDb();
    const calls = stubFetch(() =>
      json({ data: [MATTER_ROW], meta: { records: 26 } }),
    );

    const result = await listMatters(asDb(db), "user-1", { tab: "all" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toMatch(/\/matters\.json$/);
    expect(calls[0].url.searchParams.get("order")).toBe("open_date(desc)");
    expect(calls[0].url.searchParams.get("limit")).toBe(
      String(MATTERS_PAGE_SIZE),
    );
    expect(result.count).toBe(1);
    expect(result.totalEntries).toBe(26);
    expect(result.capped).toBe(false);
    expect(result.matters[0]).toMatchObject({
      id: "7",
      displayNumber: "0001-0007",
      client: { id: "42", name: "Acme Ltd" },
      responsibleSolicitor: { id: "9001", name: "Test Solicitor" },
      originatingSolicitor: { id: "9002", name: "Another Solicitor" },
      practiceArea: { id: "3", name: "Corporate" },
    });
  });

  it("reports the 200-row cap honestly rather than silently truncating", async () => {
    const db = await connectedDb();
    const rows = Array.from({ length: MATTERS_PAGE_SIZE }, (_, i) => ({
      ...MATTER_ROW,
      id: i + 1,
    }));
    stubFetch(() =>
      json({ data: rows, meta: { paging: { next: "https://x/next" } } }),
    );

    const result = await listMatters(asDb(db), "user-1", { tab: "all" });

    expect(result.capped).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(result.totalEntries).toBeNull();
  });

  it("passes the search query and a validated status filter through", async () => {
    const db = await connectedDb();
    const calls = stubFetch(() => json({ data: [] }));

    await listMatters(asDb(db), "user-1", {
      tab: "all",
      query: "Acme",
      status: "open,pending",
    });

    expect(calls[0].url.searchParams.get("query")).toBe("Acme");
    expect(calls[0].url.searchParams.get("status")).toBe("open,pending");
  });

  it("rejects an unknown status filter before calling Clio", async () => {
    const db = await connectedDb();
    const calls = stubFetch(() => json({ data: [] }));

    await expect(
      listMatters(asDb(db), "user-1", { tab: "all", status: "archived" }),
    ).rejects.toBeInstanceOf(ClioValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("listMatters — my matters", () => {
  it("merges responsible ∪ originating, de-dupes, and sorts open_date desc", async () => {
    const db = await connectedDb();
    const calls = stubFetch((call) => {
      if (call.url.searchParams.get("responsible_attorney_id")) {
        return json({
          data: [
            { ...MATTER_ROW, id: 7, open_date: "2026-05-01" },
            { ...MATTER_ROW, id: 8, open_date: "2026-07-01" },
          ],
        });
      }
      return json({
        data: [
          // id 7 appears on BOTH pages and must be counted once.
          { ...MATTER_ROW, id: 7, open_date: "2026-05-01" },
          { ...MATTER_ROW, id: 9, open_date: "2026-06-01" },
        ],
      });
    });

    const result = await listMatters(asDb(db), "user-1", { tab: "mine" });

    expect(calls).toHaveLength(2);
    expect(calls[0].url.searchParams.get("responsible_attorney_id")).toBe(
      CLIO_USER_ID,
    );
    expect(calls[1].url.searchParams.get("originating_attorney_id")).toBe(
      CLIO_USER_ID,
    );
    expect(result.matters.map((m) => m.id)).toEqual(["8", "9", "7"]);
    expect(result.count).toBe(3);
    // Neither page was capped, so the union size IS the honest total.
    expect(result.totalEntries).toBe(3);
  });

  it("claims NO total when either page was capped (the union is unknowable)", async () => {
    const db = await connectedDb();
    const rows = Array.from({ length: MATTERS_PAGE_SIZE }, (_, i) => ({
      ...MATTER_ROW,
      id: i + 1,
    }));
    stubFetch((call) =>
      call.url.searchParams.get("responsible_attorney_id")
        ? json({ data: rows })
        : json({ data: [] }),
    );

    const result = await listMatters(asDb(db), "user-1", { tab: "mine" });

    expect(result.capped).toBe(true);
    expect(result.totalEntries).toBeNull();
  });

  it("asks the user to reconnect when no Clio user id is stored", async () => {
    const db = await connectedDb({ withoutClioUserId: true });
    const calls = stubFetch(() => json({ data: [] }));

    await expect(
      listMatters(asDb(db), "user-1", { tab: "mine" }),
    ).rejects.toThrow(RECONNECT_FOR_OWN_MATTERS_DETAIL);
    expect(calls).toHaveLength(0);
  });

  it("returns ClioAuthError (never another user's data) when not connected", async () => {
    const db = makeDb();
    const calls = stubFetch(() => json({ data: [] }));

    await expect(
      listMatters(asDb(db), "user-1", { tab: "all" }),
    ).rejects.toBeInstanceOf(ClioApiError);
    expect(calls).toHaveLength(0);
  });
});

describe("listMatters — in-memory cache", () => {
  it("serves a repeat view from cache without a second Clio call", async () => {
    const db = await connectedDb();
    const calls = stubFetch(() => json({ data: [MATTER_ROW] }));

    await listMatters(asDb(db), "user-1", { tab: "all" });
    const second = await listMatters(asDb(db), "user-1", { tab: "all" });

    expect(calls).toHaveLength(1);
    expect(second.count).toBe(1);
  });

  it("keys the cache on tab/query/status, so a different view refetches", async () => {
    const db = await connectedDb();
    const calls = stubFetch(() => json({ data: [MATTER_ROW] }));

    await listMatters(asDb(db), "user-1", { tab: "all" });
    await listMatters(asDb(db), "user-1", { tab: "all", query: "Acme" });
    await listMatters(asDb(db), "user-1", { tab: "all", status: "open" });

    expect(calls).toHaveLength(3);
  });

  it("is cleared for the caller by an activity write", async () => {
    const db = await connectedDb();
    let listCalls = 0;
    stubFetch((call) => {
      if (call.url.pathname.endsWith("/matters.json")) {
        listCalls += 1;
        return json({ data: [MATTER_ROW] });
      }
      if (call.method === "GET") return json({ data: ACTIVITY_ROW });
      return json({ data: { ...ACTIVITY_ROW, note: "Revised" } });
    });

    await listMatters(asDb(db), "user-1", { tab: "all" });
    await updateActivity(asDb(db), "user-1", "55", { note: "Revised" });
    await listMatters(asDb(db), "user-1", { tab: "all" });

    expect(listCalls).toBe(2);
  });
});

// ── Detail + financials ──────────────────────────────────────────────────────

describe("getMatterDetail", () => {
  it("returns the overview plus unbilled WIP and the CLIENT-level balance", async () => {
    const db = await connectedDb();
    const calls = stubFetch((call) => {
      if (call.url.pathname.endsWith("/billable_matters.json")) {
        return json({
          data: [
            {
              id: 1,
              display_number: "0001-0007",
              unbilled_amount: 1200.5,
              unbilled_hours: 4.5,
              amount_in_trust: 500,
              currency_code: "GBP",
              client: { id: 42, name: "Acme Ltd" },
            },
          ],
        });
      }
      if (call.url.pathname.endsWith("/outstanding_client_balances.json")) {
        return json({
          data: [{ id: 2, total_outstanding_balance: 3000 }],
        });
      }
      return json({ data: { ...MATTER_ROW, custom_field_values: [] } });
    });

    const detail = await getMatterDetail(asDb(db), "user-1", "7");

    expect(detail.displayNumber).toBe("0001-0007");
    expect(detail.customFieldsUnavailable).toBe(false);
    expect(detail.financialsUnavailable).toBe(false);
    expect(detail.financials).toMatchObject({
      unbilledAmount: 1200.5,
      unbilledHours: 4.5,
      amountInTrust: 500,
      currencyCode: "GBP",
      clientOutstandingBalance: 3000,
    });
    // The client balance is fetched by CONTACT id — Clio has no per-matter figure.
    const balanceCall = calls.find((c) =>
      c.url.pathname.endsWith("/outstanding_client_balances.json"),
    );
    expect(balanceCall?.url.searchParams.get("contact_id")).toBe("42");
  });

  it("marks withheld money/hours as hidden — never as zero", async () => {
    const db = await connectedDb();
    stubFetch((call) => {
      if (call.url.pathname.endsWith("/billable_matters.json")) {
        return json({
          data: [
            {
              id: 1,
              unbilled_amount: null,
              unbilled_hours: null,
              amount_in_trust: null,
              currency_code: "GBP",
            },
          ],
        });
      }
      if (call.url.pathname.endsWith("/outstanding_client_balances.json")) {
        return json({ data: [] });
      }
      return json({ data: MATTER_ROW });
    });

    const detail = await getMatterDetail(asDb(db), "user-1", "7");

    expect(detail.financials?.unbilledAmount).toBeNull();
    expect(detail.financials?.unbilledAmountHidden).toBe(true);
    expect(detail.financials?.unbilledHoursHidden).toBe(true);
    expect(detail.financials?.amountInTrustHidden).toBe(true);
    // No balance record at all is "nothing to show", not "hidden".
    expect(detail.financials?.clientOutstandingBalanceHidden).toBe(false);
  });

  it("normalises custom field values through their custom_field name", async () => {
    const db = await connectedDb();
    stubFetch((call) =>
      call.url.pathname.endsWith(".json") &&
      call.url.pathname.includes("/matters/")
        ? json({
            data: {
              ...MATTER_ROW,
              custom_field_values: [
                {
                  id: 11,
                  field_type: "text",
                  value: "LAA-123",
                  custom_field: { id: 5, name: "Legal aid reference" },
                },
              ],
            },
          })
        : json({ data: [] }),
    );

    const detail = await getMatterDetail(asDb(db), "user-1", "7");

    expect(detail.customFields).toEqual([
      { id: "11", name: "Legal aid reference", type: "text", value: "LAA-123" },
    ]);
  });

  it("falls back to the core selector when Clio rejects the custom-field one", async () => {
    const db = await connectedDb();
    let matterCalls = 0;
    const calls = stubFetch((call) => {
      if (call.url.pathname.includes("/matters/")) {
        matterCalls += 1;
        if (matterCalls === 1) return json({ error: "bad field" }, 400);
        return json({ data: MATTER_ROW });
      }
      return json({ data: [] });
    });

    const detail = await getMatterDetail(asDb(db), "user-1", "7");

    expect(matterCalls).toBe(2);
    expect(detail.customFieldsUnavailable).toBe(true);
    expect(detail.customFields).toEqual([]);
    expect(detail.displayNumber).toBe("0001-0007");
    const retry = calls.filter((c) => c.url.pathname.includes("/matters/"))[1];
    expect(retry.url.searchParams.get("fields")).not.toContain(
      "custom_field_values",
    );
  });

  it("keeps the page usable when financials are refused by permissions", async () => {
    const db = await connectedDb();
    stubFetch((call) =>
      call.url.pathname.includes("/matters/")
        ? json({ data: MATTER_ROW })
        : json({ error: "forbidden" }, 403),
    );

    const detail = await getMatterDetail(asDb(db), "user-1", "7");

    expect(detail.financialsUnavailable).toBe(true);
    expect(detail.financials).toBeNull();
    expect(detail.displayNumber).toBe("0001-0007");
  });

  it("rejects a non-numeric matter id before building a request path", async () => {
    const db = await connectedDb();
    const calls = stubFetch(() => json({ data: MATTER_ROW }));

    await expect(
      getMatterDetail(asDb(db), "user-1", "../../users"),
    ).rejects.toBeInstanceOf(ClioValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("listRelatedContacts", () => {
  it("returns the matter's key people", async () => {
    const db = await connectedDb();
    const calls = stubFetch(() =>
      json({
        data: [
          {
            id: 42,
            name: "Acme Ltd",
            type: "Company",
            primary_email_address: "hello@acme.test",
          },
        ],
      }),
    );

    const contacts = await listRelatedContacts(asDb(db), "user-1", "7");

    expect(calls[0].url.pathname).toContain("/matters/7/related_contacts.json");
    expect(contacts).toEqual([
      {
        id: "42",
        name: "Acme Ltd",
        type: "Company",
        email: "hello@acme.test",
      },
    ]);
  });
});

// ── Time entries ─────────────────────────────────────────────────────────────

describe("listActivities", () => {
  it("defaults to the caller's OWN entries, newest first", async () => {
    const db = await connectedDb();
    const calls = stubFetch(() => json({ data: [ACTIVITY_ROW] }));

    const result = await listActivities(asDb(db), "user-1", "7");

    expect(calls[0].url.searchParams.get("user_id")).toBe(CLIO_USER_ID);
    expect(calls[0].url.searchParams.get("type")).toBe("TimeEntry");
    expect(calls[0].url.searchParams.get("order")).toBe("date(desc)");
    expect(result.everyone).toBe(false);
    expect(result.activities[0]).toMatchObject({
      id: "55",
      quantitySeconds: 360,
      quantityRedacted: false,
      isOwn: true,
      locked: false,
      billable: true,
    });
  });

  it("lifts the user filter when everyone is requested", async () => {
    const db = await connectedDb();
    const calls = stubFetch(() => json({ data: [] }));

    const result = await listActivities(asDb(db), "user-1", "7", {
      everyone: true,
    });

    expect(calls[0].url.searchParams.get("user_id")).toBeNull();
    expect(result.everyone).toBe(true);
  });

  it("passes Clio's redaction through and locks billed entries", async () => {
    const db = await connectedDb();
    stubFetch(() =>
      json({
        data: [
          {
            ...ACTIVITY_ROW,
            id: 56,
            quantity: null,
            quantity_redacted: true,
            price: null,
            total: null,
            billed: true,
            user: { id: 9002, name: "Another Solicitor" },
          },
        ],
      }),
    );

    const result = await listActivities(asDb(db), "user-1", "7", {
      everyone: true,
    });

    expect(result.activities[0]).toMatchObject({
      quantitySeconds: null,
      quantityRedacted: true,
      amountsHidden: true,
      billed: true,
      locked: true,
      isOwn: false,
    });
  });
});

describe("updateActivity", () => {
  it("patches an own, unbilled entry with an If-Match etag", async () => {
    const db = await connectedDb();
    const calls = stubFetch((call) =>
      call.method === "GET"
        ? json({ data: ACTIVITY_ROW })
        : json({ data: { ...ACTIVITY_ROW, quantity: 900, note: "Revised" } }),
    );

    const updated = await updateActivity(asDb(db), "user-1", "55", {
      quantitySeconds: 900,
      note: "Revised",
      date: "2026-08-06",
      etag: "etag-a55",
    });

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.headers["if-match"]).toBe("etag-a55");
    expect(patch?.body).toEqual({
      data: { quantity: 900, note: "Revised", date: "2026-08-06" },
    });
    expect(updated.quantitySeconds).toBe(900);
  });

  it("refuses a BILLED entry server-side with the fixed 409 detail", async () => {
    const db = await connectedDb();
    const calls = stubFetch(() =>
      json({ data: { ...ACTIVITY_ROW, billed: true } }),
    );

    await expect(
      updateActivity(asDb(db), "user-1", "55", { note: "Revised" }),
    ).rejects.toThrow(BILLED_ENTRY_DETAIL);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("refuses another fee earner's entry", async () => {
    const db = await connectedDb();
    stubFetch(() =>
      json({ data: { ...ACTIVITY_ROW, user: { id: 9002, name: "Other" } } }),
    );

    await expect(
      updateActivity(asDb(db), "user-1", "55", { note: "Revised" }),
    ).rejects.toThrow(NOT_OWN_ENTRY_DETAIL);
  });

  it("fails the stale-etag conflict BEFORE writing", async () => {
    const db = await connectedDb();
    const calls = stubFetch(() => json({ data: ACTIVITY_ROW }));

    await expect(
      updateActivity(asDb(db), "user-1", "55", {
        note: "Revised",
        etag: "etag-old",
      }),
    ).rejects.toThrow(ETAG_CONFLICT_DETAIL);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("maps a Clio 412 onto the same fixed conflict detail", async () => {
    const db = await connectedDb();
    stubFetch((call) =>
      call.method === "GET"
        ? json({ data: ACTIVITY_ROW })
        : json({ error: "precondition failed" }, 412),
    );

    await expect(
      updateActivity(asDb(db), "user-1", "55", { note: "Revised" }),
    ).rejects.toThrow(ETAG_CONFLICT_DETAIL);
  });

  it("rejects an empty patch and a non-positive duration", async () => {
    const db = await connectedDb();
    stubFetch(() => json({ data: ACTIVITY_ROW }));

    await expect(
      updateActivity(asDb(db), "user-1", "55", {}),
    ).rejects.toBeInstanceOf(ClioValidationError);
    await expect(
      updateActivity(asDb(db), "user-1", "55", { quantitySeconds: 0 }),
    ).rejects.toBeInstanceOf(ClioValidationError);
  });
});

describe("deleteActivity", () => {
  it("deletes an own, unbilled entry", async () => {
    const db = await connectedDb();
    const calls = stubFetch((call) =>
      call.method === "GET"
        ? json({ data: ACTIVITY_ROW })
        : // A 204 carries no body, so it cannot go through json().
          new Response(null, { status: 204 }),
    );

    await deleteActivity(asDb(db), "user-1", "55");

    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("refuses to delete a billed entry", async () => {
    const db = await connectedDb();
    const calls = stubFetch(() =>
      json({ data: { ...ACTIVITY_ROW, billed: true } }),
    );

    await expect(deleteActivity(asDb(db), "user-1", "55")).rejects.toThrow(
      BILLED_ENTRY_DETAIL,
    );
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

// ── Workspace links ──────────────────────────────────────────────────────────

const LINK_ROW = {
  id: "link-1",
  project_id: PROJECT_ID,
  clio_matter_id: "7",
  clio_display_number: "0001-0007",
  organisation_id: "org-1",
  created_by: "user-1",
  created_at: "2026-08-07T00:00:00.000Z",
};

function grantAccess(isOwner = true) {
  vi.mocked(checkProjectAccess).mockResolvedValue({
    ok: true,
    isOwner,
    project: { id: PROJECT_ID, user_id: "user-1", shared_with: [] },
  } as never);
}

describe("isLinksSchemaMissing", () => {
  it("covers the filter codes AND the PostgREST payload code", () => {
    expect(isLinksSchemaMissing({ code: "42P01" })).toBe(true);
    expect(isLinksSchemaMissing({ code: "42703" })).toBe(true);
    expect(isLinksSchemaMissing({ code: "PGRST204" })).toBe(true);
    expect(isLinksSchemaMissing({ code: "23505" })).toBe(false);
  });
});

describe("getLinkForMatter", () => {
  it("returns the link when the caller may access the linked workspace", async () => {
    const db = await connectedDb({
      rows: {
        matter_workspace_links: [LINK_ROW],
        projects: [{ id: PROJECT_ID, name: "0001-0007 — Acme Ltd" }],
      },
    });
    grantAccess();

    const link = await getLinkForMatter(asDb(db), "user-1", "u@test", "7");

    expect(link).toMatchObject({
      projectId: PROJECT_ID,
      projectName: "0001-0007 — Acme Ltd",
      clioMatterId: "7",
      clioDisplayNumber: "0001-0007",
    });
  });

  it("hides a link whose workspace the caller cannot access", async () => {
    const db = await connectedDb({
      rows: { matter_workspace_links: [LINK_ROW] },
    });
    // Also the tombstone path: checkProjectAccess is the shared choke point
    // that excludes soft-deleted matters, so a tombstoned workspace stops being
    // offered here without any extra check of our own.
    vi.mocked(checkProjectAccess).mockResolvedValue({ ok: false } as never);

    expect(
      await getLinkForMatter(asDb(db), "user-1", "u@test", "7"),
    ).toBeNull();
  });

  it("degrades to null on an unmigrated links table", async () => {
    const db = await connectedDb({
      errorFor: (table) =>
        table === "matter_workspace_links"
          ? { code: "42P01", message: "unmigrated" }
          : null,
    });

    expect(
      await getLinkForMatter(asDb(db), "user-1", "u@test", "7"),
    ).toBeNull();
  });
});

describe("linkWorkspace", () => {
  it("links an existing workspace the caller OWNS", async () => {
    const db = await connectedDb({
      rows: { projects: [{ id: PROJECT_ID, name: "Existing matter" }] },
    });
    grantAccess();
    stubFetch(() => json({ data: MATTER_ROW }));

    const outcome = await linkWorkspace(asDb(db), "user-1", "u@test", {
      projectId: PROJECT_ID,
      clioMatterId: "7",
    });

    expect(outcome).toMatchObject({
      projectId: PROJECT_ID,
      clioMatterId: "7",
      clioDisplayNumber: "0001-0007",
    });
    const stored = db.rows("matter_workspace_links")[0];
    // The display number is taken from CLIO, never from the client.
    expect(stored.clio_display_number).toBe("0001-0007");
    expect(stored.organisation_id).toBe("org-1");
    expect(stored.created_by).toBe("user-1");
  });

  it("refuses a workspace the caller can see but does not own", async () => {
    const db = await connectedDb();
    grantAccess(false);
    stubFetch(() => json({ data: MATTER_ROW }));

    expect(
      await linkWorkspace(asDb(db), "user-1", "u@test", {
        projectId: PROJECT_ID,
        clioMatterId: "7",
      }),
    ).toBe("forbidden");
  });

  it("returns not_found for an inaccessible workspace, without calling Clio", async () => {
    const db = await connectedDb();
    vi.mocked(checkProjectAccess).mockResolvedValue({ ok: false } as never);
    const calls = stubFetch(() => json({ data: MATTER_ROW }));

    expect(
      await linkWorkspace(asDb(db), "user-1", "u@test", {
        projectId: PROJECT_ID,
        clioMatterId: "7",
      }),
    ).toBe("not_found");
    expect(calls).toHaveLength(0);
  });

  it("reports already_linked on the unique(project_id) violation", async () => {
    const db = await connectedDb({
      rows: { matter_workspace_links: [{ ...LINK_ROW, clio_matter_id: "8" }] },
    });
    grantAccess();
    stubFetch(() => json({ data: MATTER_ROW }));

    expect(
      await linkWorkspace(asDb(db), "user-1", "u@test", {
        projectId: PROJECT_ID,
        clioMatterId: "7",
      }),
    ).toBe("already_linked");
  });

  it("degrades to unsupported on an unmigrated links table", async () => {
    const db = await connectedDb({
      errorFor: (table, op) =>
        table === "matter_workspace_links" && op === "insert"
          ? { code: "42P01", message: "unmigrated" }
          : null,
    });
    grantAccess();
    stubFetch(() => json({ data: MATTER_ROW }));

    expect(
      await linkWorkspace(asDb(db), "user-1", "u@test", {
        projectId: PROJECT_ID,
        clioMatterId: "7",
      }),
    ).toBe("unsupported");
  });
});

describe("unlinkWorkspace", () => {
  it("unlinks for the owner and refuses a non-owner", async () => {
    const db = await connectedDb({
      rows: { matter_workspace_links: [LINK_ROW] },
    });
    grantAccess();

    expect(
      await unlinkWorkspace(asDb(db), "user-1", "u@test", PROJECT_ID),
    ).toBe("unlinked");
    expect(db.rows("matter_workspace_links")).toHaveLength(0);

    grantAccess(false);
    expect(
      await unlinkWorkspace(asDb(db), "user-1", "u@test", PROJECT_ID),
    ).toBe("forbidden");
  });
});

describe("workspaceNameForMatter", () => {
  const base: MatterListRow = {
    id: "7",
    etag: null,
    displayNumber: "0001-0007",
    description: "Acme Ltd share purchase",
    status: "open",
    openDate: null,
    closeDate: null,
    client: null,
    responsibleSolicitor: null,
    originatingSolicitor: null,
    practiceArea: null,
  };

  it("joins number and description, truncating a long description", () => {
    expect(workspaceNameForMatter(base)).toBe(
      "0001-0007 — Acme Ltd share purchase",
    );
    const long = workspaceNameForMatter({
      ...base,
      description: "x".repeat(200),
    });
    expect(long.length).toBeLessThanOrEqual("0001-0007 — ".length + 80);
  });

  it("never produces an empty name", () => {
    expect(
      workspaceNameForMatter({
        ...base,
        displayNumber: null,
        description: null,
      }),
    ).toBe("Clio matter 7");
  });
});

describe("createWorkspaceForMatter", () => {
  it("creates the workspace, links it, and stamps the org on the LINK only", async () => {
    const db = await connectedDb();
    vi.mocked(checkProjectAccess).mockResolvedValue({ ok: false } as never);
    stubFetch(() => json({ data: MATTER_ROW }));

    const outcome = await createWorkspaceForMatter(
      asDb(db),
      "user-1",
      "u@test",
      "7",
    );

    expect(outcome).toMatchObject({
      projectName: "0001-0007 — Acme Ltd share purchase",
    });
    const project = db.rows("projects")[0];
    expect(project.name).toBe("0001-0007 — Acme Ltd share purchase");
    expect(project.cm_number).toBe("0001-0007");
    expect(project.user_id).toBe("user-1");
    // WS9 firm visibility is the ONLY thing that stamps a workspace's org.
    expect(project.organisation_id).toBeUndefined();
    expect(db.rows("matter_workspace_links")[0].organisation_id).toBe("org-1");
  });

  it("returns already_linked when the caller can already see a linked workspace", async () => {
    const db = await connectedDb({
      rows: {
        matter_workspace_links: [LINK_ROW],
        projects: [{ id: PROJECT_ID, name: "Existing" }],
      },
    });
    grantAccess();
    const calls = stubFetch(() => json({ data: MATTER_ROW }));

    expect(
      await createWorkspaceForMatter(asDb(db), "user-1", "u@test", "7"),
    ).toBe("already_linked");
    expect(calls).toHaveLength(0);
  });

  it("creates NO workspace when the links table is unmigrated", async () => {
    const db = await connectedDb({
      errorFor: (table) =>
        table === "matter_workspace_links"
          ? { code: "42P01", message: "unmigrated" }
          : null,
    });
    const calls = stubFetch(() => json({ data: MATTER_ROW }));

    expect(
      await createWorkspaceForMatter(asDb(db), "user-1", "u@test", "7"),
    ).toBe("unsupported");
    expect(db.rows("projects")).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("rolls the workspace back if the link insert fails after creation", async () => {
    const db = await connectedDb({
      errorFor: (table, op) =>
        table === "matter_workspace_links" && op === "insert"
          ? { code: "42P01", message: "unmigrated" }
          : null,
    });
    vi.mocked(checkProjectAccess).mockResolvedValue({ ok: false } as never);
    stubFetch(() => json({ data: MATTER_ROW }));

    expect(
      await createWorkspaceForMatter(asDb(db), "user-1", "u@test", "7"),
    ).toBe("unsupported");
    expect(db.rows("projects")).toHaveLength(0);
  });
});
