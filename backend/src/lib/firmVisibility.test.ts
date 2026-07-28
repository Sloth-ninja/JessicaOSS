import { beforeEach, describe, expect, it, vi } from "vitest";

// listFirmLibrary excludes tombstoned rows via deletionGovernance.getTombstonedIds
// — mock it so the tombstone state is driven directly.
const getTombstonedIds = vi.fn();
vi.mock("./deletionGovernance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./deletionGovernance")>();
  return {
    ...actual,
    getTombstonedIds: (...args: unknown[]) => getTombstonedIds(...args),
  };
});

import {
  adminRevertResource,
  isFirmResourceType,
  listFirmLibrary,
  parseFirmVisibility,
  setResourceVisibility,
} from "./firmVisibility";

// ── Fake Supabase stand-in ───────────────────────────────────────────────────
// Update:  .from(t).update(patch).eq()…​.select("id")  (predicate BEFORE patch)
// Select:  .from(t).select(cols).in(col, vals) (awaited)
// RPC:     .rpc(name, params) → configured result
// A table in `firmMissing` raises 42703 on update (the unmigrated DB).

type Row = Record<string, unknown>;
const ERR_42703 = { code: "42703", message: "column does not exist" } as const;

function makeDb(opts: {
  tables?: Record<string, Row[]>;
  rpc?: Record<string, { data: unknown; error?: unknown }>;
  firmMissing?: Set<string>;
}) {
  const tables = opts.tables ?? {};
  const firmMissing = opts.firmMissing ?? new Set<string>();
  const rpcCalls: Array<{ name: string; params: unknown }> = [];

  function builder(table: string) {
    let mode: "select" | "update" | null = null;
    let patch: Row | null = null;
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];

    function matched(): Row[] {
      return (tables[table] ?? []).filter(
        (row) =>
          eqs.every(([c, v]) => row[c] === v) &&
          ins.every(([c, vs]) => vs.includes(row[c])),
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      update(p: Row) {
        mode = "update";
        patch = p;
        return b;
      },
      select(_cols?: string) {
        if (mode === "update") {
          if (firmMissing.has(table)) {
            return Promise.resolve({ data: null, error: ERR_42703 });
          }
          const rows = matched();
          for (const row of rows) Object.assign(row, patch);
          return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null });
        }
        mode = "select";
        return b;
      },
      eq(col: string, val: unknown) {
        eqs.push([col, val]);
        return b;
      },
      in(col: string, vals: unknown[]) {
        ins.push([col, vals]);
        return b;
      },
      then(onF: unknown, onR: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return Promise.resolve({ data: matched().map((r) => ({ ...r })), error: null }).then(
          onF as any,
          onR as any,
        );
      },
    };
    return b;
  }

  const db = {
    from: (table: string) => builder(table),
    rpc: (name: string, params: unknown) => {
      rpcCalls.push({ name, params });
      const res = opts.rpc?.[name] ?? { data: [], error: null };
      return Promise.resolve({ data: res.data, error: res.error ?? null });
    },
  } as never;
  return { db, tables, rpcCalls };
}

const OWNER = "owner-uuid";
const ORG = "org-1";
const OTHER_ORG = "org-2";

beforeEach(() => {
  getTombstonedIds.mockReset().mockResolvedValue(new Set());
});

// ── guards ────────────────────────────────────────────────────────────────────

describe("guards", () => {
  it("parseFirmVisibility accepts only 'private' | 'firm'", () => {
    expect(parseFirmVisibility("firm")).toBe("firm");
    expect(parseFirmVisibility("private")).toBe("private");
    expect(parseFirmVisibility("public")).toBeNull();
    expect(parseFirmVisibility(undefined)).toBeNull();
    expect(parseFirmVisibility(1)).toBeNull();
  });

  it("isFirmResourceType accepts only project | tabular_review", () => {
    expect(isFirmResourceType("project")).toBe(true);
    expect(isFirmResourceType("tabular_review")).toBe(true);
    expect(isFirmResourceType("tabular-review")).toBe(false);
    expect(isFirmResourceType("workflow")).toBe(false);
  });
});

// ── setResourceVisibility — owner-scoped flip ─────────────────────────────────

describe("setResourceVisibility", () => {
  it("flips the OWNER's own project to firm and stamps organisation_id", async () => {
    const { db, tables } = makeDb({
      tables: { projects: [{ id: "p1", user_id: OWNER, visibility: "private", organisation_id: null }] },
    });
    const outcome = await setResourceVisibility(db, "project", "p1", OWNER, {
      visibility: "firm",
      organisationId: ORG,
    });
    expect(outcome).toBe("updated");
    expect(tables.projects[0]).toMatchObject({ visibility: "firm", organisation_id: ORG });
  });

  it("reverting to private clears organisation_id", async () => {
    const { db, tables } = makeDb({
      tables: { projects: [{ id: "p1", user_id: OWNER, visibility: "firm", organisation_id: ORG }] },
    });
    const outcome = await setResourceVisibility(db, "project", "p1", OWNER, {
      visibility: "private",
      organisationId: ORG,
    });
    expect(outcome).toBe("updated");
    expect(tables.projects[0]).toMatchObject({ visibility: "private", organisation_id: null });
  });

  it("a NON-owner cannot flip (predicate matches zero rows ⇒ not_found)", async () => {
    const { db, tables } = makeDb({
      tables: { projects: [{ id: "p1", user_id: OWNER, visibility: "private", organisation_id: null }] },
    });
    const outcome = await setResourceVisibility(db, "project", "p1", "someone-else", {
      visibility: "firm",
      organisationId: ORG,
    });
    expect(outcome).toBe("not_found");
    // Untouched — the flip never applied.
    expect(tables.projects[0]).toMatchObject({ visibility: "private", organisation_id: null });
  });

  it("works the same for a standalone tabular_review", async () => {
    const { db, tables } = makeDb({
      tables: { tabular_reviews: [{ id: "r1", user_id: OWNER, visibility: "private", organisation_id: null }] },
    });
    const outcome = await setResourceVisibility(db, "tabular_review", "r1", OWNER, {
      visibility: "firm",
      organisationId: ORG,
    });
    expect(outcome).toBe("updated");
    expect(tables.tabular_reviews[0]).toMatchObject({ visibility: "firm", organisation_id: ORG });
  });

  it("returns 'unsupported' on an unmigrated DB (42703)", async () => {
    const { db } = makeDb({
      tables: { projects: [{ id: "p1", user_id: OWNER }] },
      firmMissing: new Set(["projects"]),
    });
    const outcome = await setResourceVisibility(db, "project", "p1", OWNER, {
      visibility: "firm",
      organisationId: ORG,
    });
    expect(outcome).toBe("unsupported");
  });
});

// ── adminRevertResource — org-scoped revert ───────────────────────────────────

describe("adminRevertResource", () => {
  it("reverts a firm-visible item belonging to the caller's own org", async () => {
    const { db, tables } = makeDb({
      tables: { projects: [{ id: "p1", user_id: OWNER, visibility: "firm", organisation_id: ORG }] },
    });
    const outcome = await adminRevertResource(db, "project", "p1", ORG);
    expect(outcome).toBe("updated");
    expect(tables.projects[0]).toMatchObject({ visibility: "private", organisation_id: null });
  });

  it("EXCLUDES an item belonging to another org (cross-org guard ⇒ not_found)", async () => {
    const { db, tables } = makeDb({
      tables: { projects: [{ id: "p1", user_id: OWNER, visibility: "firm", organisation_id: OTHER_ORG }] },
    });
    const outcome = await adminRevertResource(db, "project", "p1", ORG);
    expect(outcome).toBe("not_found");
    // The other org's item is untouched.
    expect(tables.projects[0]).toMatchObject({ visibility: "firm", organisation_id: OTHER_ORG });
  });

  it("returns not_found for an already-private item (nothing to revert)", async () => {
    const { db } = makeDb({
      tables: { projects: [{ id: "p1", user_id: OWNER, visibility: "private", organisation_id: null }] },
    });
    expect(await adminRevertResource(db, "project", "p1", ORG)).toBe("not_found");
  });

  it("returns 'unsupported' on an unmigrated DB (42703)", async () => {
    const { db } = makeDb({
      tables: { projects: [{ id: "p1", visibility: "firm", organisation_id: ORG }] },
      firmMissing: new Set(["projects"]),
    });
    expect(await adminRevertResource(db, "project", "p1", ORG)).toBe("unsupported");
  });
});

// ── listFirmLibrary ────────────────────────────────────────────────────────────

describe("listFirmLibrary", () => {
  it("returns an empty library for an orgless caller without querying", async () => {
    const { db, rpcCalls } = makeDb({});
    expect(await listFirmLibrary(db, "u1", "u1@x.test", null)).toEqual({
      projects: [],
      reviews: [],
    });
    expect(rpcCalls).toHaveLength(0);
  });

  it("keeps only visibility='firm' rows and maps counts + owner name", async () => {
    const { db } = makeDb({
      rpc: {
        get_projects_overview: {
          data: [
            {
              id: "p1",
              user_id: OWNER,
              name: "Firm Matter",
              visibility: "firm",
              owner_display_name: "Alex Owner",
              updated_at: "2026-07-28T00:00:00Z",
              is_owner: false,
              document_count: 3,
              chat_count: 2,
              review_count: 1,
            },
            { id: "p2", visibility: "private", name: "Private" },
          ],
        },
        get_tabular_reviews_overview: {
          data: [
            {
              id: "r1",
              user_id: OWNER,
              title: "Firm Review",
              visibility: "firm",
              updated_at: "2026-07-28T00:00:00Z",
              is_owner: false,
              document_count: 4,
            },
          ],
        },
      },
      tables: { user_profiles: [{ user_id: OWNER, display_name: "Alex Owner" }] },
    });
    const lib = await listFirmLibrary(db, "u1", "u1@x.test", ORG);
    expect(lib.projects).toEqual([
      {
        id: "p1",
        name: "Firm Matter",
        ownerUserId: OWNER,
        ownerDisplayName: "Alex Owner",
        updatedAt: "2026-07-28T00:00:00Z",
        isOwner: false,
        documentCount: 3,
        chatCount: 2,
        reviewCount: 1,
      },
    ]);
    // Review owner name enriched from user_profiles (the reviews RPC omits it).
    expect(lib.reviews).toEqual([
      {
        id: "r1",
        name: "Firm Review",
        ownerUserId: OWNER,
        ownerDisplayName: "Alex Owner",
        updatedAt: "2026-07-28T00:00:00Z",
        isOwner: false,
        documentCount: 4,
      },
    ]);
  });

  it("excludes tombstoned firm items", async () => {
    getTombstonedIds.mockImplementation(
      (_db: unknown, type: string) =>
        Promise.resolve(type === "project" ? new Set(["p1"]) : new Set()),
    );
    const { db } = makeDb({
      rpc: {
        get_projects_overview: {
          data: [{ id: "p1", user_id: OWNER, name: "Tombstoned", visibility: "firm" }],
        },
        get_tabular_reviews_overview: {
          data: [{ id: "r1", user_id: OWNER, title: "Live", visibility: "firm" }],
        },
      },
      tables: { user_profiles: [] },
    });
    const lib = await listFirmLibrary(db, "u1", "u1@x.test", ORG);
    expect(lib.projects).toEqual([]);
    expect(lib.reviews.map((r) => r.id)).toEqual(["r1"]);
  });

  it("threads the caller's org id into both overview RPCs", async () => {
    const { db, rpcCalls } = makeDb({
      rpc: {
        get_projects_overview: { data: [] },
        get_tabular_reviews_overview: { data: [] },
      },
    });
    await listFirmLibrary(db, "u1", "u1@x.test", ORG);
    expect(rpcCalls).toEqual([
      { name: "get_projects_overview", params: expect.objectContaining({ p_user_org_id: ORG }) },
      {
        name: "get_tabular_reviews_overview",
        params: expect.objectContaining({ p_user_org_id: ORG, p_project_id: null }),
      },
    ]);
  });
});
