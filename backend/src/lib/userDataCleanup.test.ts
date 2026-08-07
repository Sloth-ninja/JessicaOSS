import { describe, expect, it, vi } from "vitest";

// Storage is exercised elsewhere; here we only care about the DB row deletions,
// so stub the R2 helpers to no-ops.
vi.mock("./storage", () => ({
  deleteFile: vi.fn().mockResolvedValue(undefined),
  listFiles: vi.fn().mockResolvedValue([]),
}));

import { deleteUserAccountData } from "./userDataCleanup";

// ---------------------------------------------------------------------------
// Minimal in-memory Supabase stand-in: a lazy, awaitable builder whose terminal
// resolution runs against a per-table row store. Filters (eq/in) are honoured so
// `delete().eq("user_id", …)` really removes only that user's rows; every other
// chain method is a no-op passthrough. `errorFor(table, op)` injects a terminal
// error so the degradation paths can be exercised.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type OpRecord = { table: string; op: string; filters: Filter[] };
type Filter =
  | { op: "eq"; col: string; val: unknown }
  | { op: "in"; col: string; vals: unknown[] };

function makeDb(config: {
  rows?: Record<string, Row[]>;
  errorFor?: (
    table: string,
    op: string,
  ) => { code?: string; message?: string } | null;
} = {}) {
  const store: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(config.rows ?? {})) {
    store[table] = rows.map((r) => ({ ...r }));
  }
  const ops: OpRecord[] = [];

  function builder(table: string) {
    const state = { op: "select", filters: [] as Filter[] };

    const matches = (row: Row) =>
      state.filters.every((f) =>
        f.op === "eq"
          ? row[f.col] === f.val
          : f.vals.includes(row[f.col]),
      );

    function run() {
      ops.push({ table, op: state.op, filters: [...state.filters] });
      const error = config.errorFor?.(table, state.op) ?? null;
      if (error) return { data: null, error };
      const rows = store[table] ?? (store[table] = []);
      if (state.op === "delete") {
        store[table] = rows.filter((r) => !matches(r));
        return { data: null, error: null };
      }
      if (state.op === "select") return { data: rows.filter(matches), error: null };
      return { data: null, error: null };
    }

    const b: Record<string, unknown> = {
      select() {
        state.op = "select";
        return b;
      },
      delete() {
        state.op = "delete";
        return b;
      },
      update() {
        state.op = "update";
        return b;
      },
      upsert() {
        state.op = "upsert";
        return b;
      },
      eq(col: string, val: unknown) {
        state.filters.push({ op: "eq", col, val });
        return b;
      },
      neq() {
        return b;
      },
      in(col: string, vals: unknown[]) {
        state.filters.push({ op: "in", col, vals });
        return b;
      },
      is() {
        return b;
      },
      filter() {
        return b;
      },
      order() {
        return b;
      },
      range() {
        return b;
      },
      limit() {
        return b;
      },
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        return Promise.resolve()
          .then(() => run())
          .then(resolve, reject);
      },
    };
    return b;
  }

  return {
    db: { from: (t: string) => builder(t) } as never,
    store,
    ops,
  };
}

const SAVE = (userId: string, companyNumber: string): Row => ({
  id: `${userId}-${companyNumber}`,
  user_id: userId,
  company_number: companyNumber,
  company_name: `Company ${companyNumber}`,
  company_status: "active",
  starred: false,
  last_viewed_at: null,
  created_at: "2026-07-28T00:00:00.000Z",
});

describe("deleteUserAccountData — company_search_saves", () => {
  it("deletes the user's company_search_saves rows, keyed on user_id", async () => {
    const { db, store, ops } = makeDb({
      rows: {
        company_search_saves: [
          SAVE("user-1", "00000001"),
          SAVE("user-1", "00000002"),
          SAVE("user-2", "00000003"),
        ],
      },
    });

    await deleteUserAccountData(db, "user-1");

    // user-1's saves gone; user-2's untouched.
    expect(store.company_search_saves).toHaveLength(1);
    expect(store.company_search_saves[0].user_id).toBe("user-2");

    const savesDelete = ops.find(
      (o) => o.table === "company_search_saves" && o.op === "delete",
    );
    expect(savesDelete).toBeDefined();
    expect(savesDelete?.filters).toContainEqual({
      op: "eq",
      col: "user_id",
      val: "user-1",
    });
  });

  it.each(["42P01", "42703"])(
    "tolerates a missing table/column (%s) — account deletion still succeeds",
    async (code) => {
      const { db } = makeDb({
        errorFor: (table, op) =>
          table === "company_search_saves" && op === "delete"
            ? { code, message: "unmigrated" }
            : null,
      });

      await expect(deleteUserAccountData(db, "user-1")).resolves.toBeUndefined();
    },
  );

  it("still throws on a non-tolerated error from company_search_saves", async () => {
    const { db } = makeDb({
      errorFor: (table, op) =>
        table === "company_search_saves" && op === "delete"
          ? { code: "42501", message: "permission denied" }
          : null,
    });

    await expect(deleteUserAccountData(db, "user-1")).rejects.toThrow(
      /Failed to delete account data/,
    );
  });
});

const LINK = (userId: string, matterId: string): Row => ({
  id: `${userId}-${matterId}`,
  created_by: userId,
  clio_matter_id: matterId,
  clio_matter_number: `M-${matterId}`,
  workspace_type: "project",
  workspace_id: `workspace-${matterId}`,
  created_at: "2026-08-07T00:00:00.000Z",
});

describe("deleteUserAccountData — matter_workspace_links", () => {
  it("deletes the user's matter_workspace_links rows, keyed on created_by", async () => {
    const { db, store, ops } = makeDb({
      rows: {
        matter_workspace_links: [
          LINK("user-1", "matter-1"),
          LINK("user-1", "matter-2"),
          LINK("user-2", "matter-3"),
        ],
      },
    });

    await deleteUserAccountData(db, "user-1");

    // user-1's links gone; user-2's untouched.
    expect(store.matter_workspace_links).toHaveLength(1);
    expect(store.matter_workspace_links[0].created_by).toBe("user-2");

    const linksDelete = ops.find(
      (o) => o.table === "matter_workspace_links" && o.op === "delete",
    );
    expect(linksDelete).toBeDefined();
    expect(linksDelete?.filters).toContainEqual({
      op: "eq",
      col: "created_by",
      val: "user-1",
    });
  });

  it.each(["42P01", "42703"])(
    "tolerates a missing table/column (%s) — account deletion still succeeds",
    async (code) => {
      const { db } = makeDb({
        errorFor: (table, op) =>
          table === "matter_workspace_links" && op === "delete"
            ? { code, message: "unmigrated" }
            : null,
      });

      await expect(deleteUserAccountData(db, "user-1")).resolves.toBeUndefined();
    },
  );

  it("still throws on a non-tolerated error from matter_workspace_links", async () => {
    const { db } = makeDb({
      errorFor: (table, op) =>
        table === "matter_workspace_links" && op === "delete"
          ? { code: "42501", message: "permission denied" }
          : null,
    });

    await expect(deleteUserAccountData(db, "user-1")).rejects.toThrow(
      /Failed to delete account data/,
    );
  });
});
