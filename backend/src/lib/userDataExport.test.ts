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

function makeDb(
  config: {
    rows?: Record<string, Row[]>;
    errorFor?: (table: string) => { code?: string; message?: string } | null;
  } = {},
) {
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

describe("buildUserAccountExport — clio_connections (SAR completeness)", () => {
  // A raw connection row as stored: metadata AND encrypted token material. The
  // export section must carry the metadata and NONE of the token material.
  const CLIO_ROW: Row = {
    id: "clio-1",
    user_id: "user-1",
    product: "manage",
    encrypted_access_token: "ENCRYPTED-ACCESS",
    access_token_iv: "iv-a",
    access_token_tag: "tag-a",
    encrypted_refresh_token: "ENCRYPTED-REFRESH",
    refresh_token_iv: "iv-r",
    refresh_token_tag: "tag-r",
    token_expires_at: "2026-09-01T00:00:00.000Z",
    scope: "grow_matter_read",
    clio_user_id: "99",
    clio_user_name: "Jane Solicitor",
    created_at: "2026-08-03T00:00:00.000Z",
    updated_at: "2026-08-03T01:00:00.000Z",
  };

  it("includes token-free connection metadata with all metadata fields and NO token material", async () => {
    const { db } = makeDb({ rows: { user_clio_connections: [CLIO_ROW] } });

    const exported = await buildUserAccountExport(db, "user-1");

    expect(exported.clio_connections).toHaveLength(1);
    expect(exported.clio_connections[0]).toEqual({
      product: "manage",
      clio_user_name: "Jane Solicitor",
      clio_user_id: "99",
      scope: "grow_matter_read",
      token_expires_at: "2026-09-01T00:00:00.000Z",
      created_at: "2026-08-03T00:00:00.000Z",
      updated_at: "2026-08-03T01:00:00.000Z",
    });
    // No encrypted/token field survives into the export, even though the source
    // row carries them.
    expect(JSON.stringify(exported.clio_connections)).not.toContain(
      "ENCRYPTED",
    );
  });

  it.each(["42P01", "42703"])(
    "tolerates an unmigrated database (%s) — section present but empty",
    async (code) => {
      const { db } = makeDb({
        rows: { user_clio_connections: [CLIO_ROW] },
        errorFor: (table) =>
          table === "user_clio_connections"
            ? { code, message: "unmigrated" }
            : null,
      });

      const exported = await buildUserAccountExport(db, "user-1");
      expect(exported.clio_connections).toEqual([]);
    },
  );
});

const LINK = (matterId: string): Row => ({
  id: `link-${matterId}`,
  created_by: "user-1",
  clio_matter_id: matterId,
  clio_matter_number: `M-${matterId}`,
  workspace_type: "project",
  workspace_id: `workspace-${matterId}`,
  created_at: "2026-08-07T00:00:00.000Z",
});

describe("buildUserAccountExport — matter_workspace_links", () => {
  it("includes the user's matter_workspace_links rows with all columns", async () => {
    const { db } = makeDb({
      rows: {
        matter_workspace_links: [LINK("matter-1"), LINK("matter-2")],
      },
    });

    const exported = await buildUserAccountExport(db, "user-1");

    expect(exported.matter_workspace_links).toHaveLength(2);
    // All columns present — it is the user's data, exported verbatim.
    expect(exported.matter_workspace_links[0]).toMatchObject({
      created_by: "user-1",
      clio_matter_id: "matter-1",
      clio_matter_number: "M-matter-1",
      workspace_type: "project",
      workspace_id: "workspace-matter-1",
      created_at: "2026-08-07T00:00:00.000Z",
    });
  });

  it.each(["42P01", "42703"])(
    "tolerates a missing table/column (%s) — section is empty, export succeeds",
    async (code) => {
      const { db } = makeDb({
        errorFor: (table) =>
          table === "matter_workspace_links"
            ? { code, message: "unmigrated" }
            : null,
      });

      const exported = await buildUserAccountExport(db, "user-1");
      expect(exported.matter_workspace_links).toEqual([]);
    },
  );
});
