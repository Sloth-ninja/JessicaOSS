import { describe, expect, it } from "vitest";
import { buildUserAccountExport } from "./userDataExport";

// ---------------------------------------------------------------------------
// In-memory Supabase stand-in for the read-only export path: a lazy, awaitable
// builder resolving against a per-table row store. Only select is used here;
// eq/in filters are honoured, order/range are no-ops (seeded sets are small, so
// selectAll's pagination breaks after one page). `errorFor` injects a terminal
// error to exercise the missing-table degradation.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Filter =
  | { op: "eq"; col: string; val: unknown }
  | { op: "in"; col: string; vals: unknown[] };

function makeDb(config: {
  rows?: Record<string, Row[]>;
  errorFor?: (table: string) => { code?: string; message?: string } | null;
} = {}) {
  const store: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(config.rows ?? {})) {
    store[table] = rows.map((r) => ({ ...r }));
  }

  function builder(table: string) {
    const filters: Filter[] = [];
    const matches = (row: Row) =>
      filters.every((f) =>
        f.op === "eq" ? row[f.col] === f.val : f.vals.includes(row[f.col]),
      );

    function run() {
      const error = config.errorFor?.(table) ?? null;
      if (error) return { data: null, error };
      return { data: (store[table] ?? []).filter(matches), error: null };
    }

    const b: Record<string, unknown> = {
      select() {
        return b;
      },
      eq(col: string, val: unknown) {
        filters.push({ op: "eq", col, val });
        return b;
      },
      neq() {
        return b;
      },
      in(col: string, vals: unknown[]) {
        filters.push({ op: "in", col, vals });
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
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        return Promise.resolve()
          .then(() => run())
          .then(resolve, reject);
      },
    };
    return b;
  }

  return { db: { from: (t: string) => builder(t) } as never };
}

const SAVE = (companyNumber: string, starred: boolean): Row => ({
  id: `save-${companyNumber}`,
  user_id: "user-1",
  company_number: companyNumber,
  company_name: `Company ${companyNumber}`,
  company_status: "active",
  starred,
  last_viewed_at: "2026-07-28T00:00:00.000Z",
  created_at: "2026-07-27T00:00:00.000Z",
});

describe("buildUserAccountExport — company_search_saves", () => {
  it("includes the user's company_search_saves rows with all columns", async () => {
    const { db } = makeDb({
      rows: {
        company_search_saves: [SAVE("00000001", true), SAVE("00000002", false)],
      },
    });

    const exported = await buildUserAccountExport(db, "user-1");

    expect(exported.company_search_saves).toHaveLength(2);
    // All columns present — it is the user's data, exported verbatim.
    expect(exported.company_search_saves[0]).toMatchObject({
      user_id: "user-1",
      company_number: "00000001",
      company_name: "Company 00000001",
      company_status: "active",
      starred: true,
      last_viewed_at: "2026-07-28T00:00:00.000Z",
      created_at: "2026-07-27T00:00:00.000Z",
    });
  });

  it.each(["42P01", "42703"])(
    "tolerates a missing table/column (%s) — section is empty, export succeeds",
    async (code) => {
      const { db } = makeDb({
        errorFor: (table) =>
          table === "company_search_saves"
            ? { code, message: "unmigrated" }
            : null,
      });

      const exported = await buildUserAccountExport(db, "user-1");
      expect(exported.company_search_saves).toEqual([]);
    },
  );
});
