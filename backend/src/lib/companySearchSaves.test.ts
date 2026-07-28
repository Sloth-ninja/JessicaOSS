import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listCompanySaves,
  recordCompanyView,
  setCompanyStar,
  RECENTS_CAP,
} from "./companySearchSaves";

// ---------------------------------------------------------------------------
// In-memory Supabase stand-in for company_search_saves. Backs the upsert /
// select / update / delete chains used by the lib so the real ordering, prune
// and snapshot logic run for real. `missing` makes every terminal error with a
// Postgres "unmigrated" code so the degradation paths can be exercised.
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  user_id: string;
  company_number: string;
  company_name: string;
  company_status: string | null;
  starred: boolean;
  last_viewed_at: string;
  created_at: string;
};

type Filter =
  | { op: "eq"; col: string; val: unknown }
  | { op: "in"; col: string; vals: unknown[] };

function makeDb(opts: { missing?: false | "42P01" | "42703" } = {}) {
  const rows: Row[] = [];
  let idSeq = 0;

  const err = opts.missing
    ? { code: opts.missing, message: "unmigrated" }
    : null;

  function applyFilters(source: Row[], filters: Filter[]): Row[] {
    return source.filter((row) =>
      filters.every((f) => {
        const value = (row as unknown as Record<string, unknown>)[f.col];
        return f.op === "eq" ? value === f.val : f.vals.includes(value);
      }),
    );
  }

  function makeBuilder(exec: (b: BuilderState) => unknown) {
    const state: BuilderState = { filters: [], order: null, limit: null };
    const b = {
      eq(col: string, val: unknown) {
        state.filters.push({ op: "eq", col, val });
        return b;
      },
      in(col: string, vals: unknown[]) {
        state.filters.push({ op: "in", col, vals });
        return b;
      },
      order(col: string, o?: { ascending?: boolean }) {
        state.order = { col, ascending: o?.ascending !== false };
        return b;
      },
      limit(n: number) {
        state.limit = n;
        return b;
      },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
        return Promise.resolve()
          .then(() => exec(state))
          .then(res, rej);
      },
    };
    return b;
  }

  type BuilderState = {
    filters: Filter[];
    order: { col: string; ascending: boolean } | null;
    limit: number | null;
  };

  function execSelect(state: BuilderState) {
    if (err) return { data: null, error: err };
    let out = applyFilters(rows, state.filters).map((r) => ({ ...r }));
    if (state.order) {
      const { col, ascending } = state.order;
      out = out.sort((a, b) => {
        const av = String((a as Record<string, unknown>)[col] ?? "");
        const bv = String((b as Record<string, unknown>)[col] ?? "");
        return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (state.limit != null) out = out.slice(0, state.limit);
    return { data: out, error: null };
  }

  function execUpdate(patch: Record<string, unknown>, state: BuilderState) {
    if (err) return { data: null, error: err };
    for (const row of applyFilters(rows, state.filters)) {
      Object.assign(row, patch);
    }
    return { data: null, error: null };
  }

  function execDelete(state: BuilderState) {
    if (err) return { error: err };
    const doomed = new Set(applyFilters(rows, state.filters).map((r) => r.id));
    for (let i = rows.length - 1; i >= 0; i--) {
      if (doomed.has(rows[i].id)) rows.splice(i, 1);
    }
    return { error: null };
  }

  function execUpsert(payload: Record<string, unknown>) {
    if (err) return { data: null, error: err };
    const existing = rows.find(
      (r) =>
        r.user_id === payload.user_id &&
        r.company_number === payload.company_number,
    );
    if (existing) {
      // ON CONFLICT DO UPDATE SET <provided columns only>.
      for (const key of Object.keys(payload)) {
        (existing as unknown as Record<string, unknown>)[key] = payload[key];
      }
    } else {
      const now = new Date().toISOString();
      rows.push({
        id: `row-${++idSeq}`,
        user_id: String(payload.user_id),
        company_number: String(payload.company_number),
        company_name: String(payload.company_name ?? ""),
        company_status:
          (payload.company_status as string | null | undefined) ?? null,
        starred: (payload.starred as boolean | undefined) ?? false,
        last_viewed_at: (payload.last_viewed_at as string | undefined) ?? now,
        created_at: now,
      });
    }
    return { data: null, error: null };
  }

  const db = {
    from(_table: string) {
      return {
        select: () => makeBuilder(execSelect),
        update: (patch: Record<string, unknown>) =>
          makeBuilder((state) => execUpdate(patch, state)),
        delete: () => makeBuilder(execDelete),
        upsert: (payload: Record<string, unknown>) =>
          makeBuilder(() => execUpsert(payload)),
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { db, rows };
}

const USER_A = "user-a";
const USER_B = "user-b";

describe("recordCompanyView", () => {
  it("inserts a new row with the snapshot and a fresh last_viewed_at", async () => {
    const { db, rows } = makeDb();
    await recordCompanyView(db, USER_A, {
      companyNumber: "00214436",
      companyName: "MARKS AND SPENCER P.L.C.",
      companyStatus: "active",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: USER_A,
      company_number: "00214436",
      company_name: "MARKS AND SPENCER P.L.C.",
      company_status: "active",
      starred: false,
    });
    expect(rows[0].last_viewed_at).toBeTruthy();
  });

  it("refreshes the name/status snapshot and last_viewed_at on re-view without touching starred", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    const { db, rows } = makeDb();
    // Star it first (so we can prove a re-view preserves the star).
    await setCompanyStar(db, USER_A, "13927967", true, {
      companyName: "ARIA GRACE LAW CIC",
      companyStatus: "active",
    });
    const firstViewedAt = rows[0].last_viewed_at;

    vi.setSystemTime(new Date("2026-07-02T00:00:00Z"));
    await recordCompanyView(db, USER_A, {
      companyNumber: "13927967",
      companyName: "ARIA GRACE LAW C.I.C. (RENAMED)",
      companyStatus: "liquidation",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].starred).toBe(true); // star survived the re-view
    expect(rows[0].company_name).toBe("ARIA GRACE LAW C.I.C. (RENAMED)");
    expect(rows[0].company_status).toBe("liquidation");
    expect(rows[0].last_viewed_at).not.toBe(firstViewedAt);
    vi.useRealTimers();
  });

  it("prunes non-starred rows beyond the 25 most-recent (starred never pruned)", async () => {
    vi.useFakeTimers();
    const { db, rows } = makeDb();

    // Star company 001 up front — it would be the oldest, but must survive.
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    await setCompanyStar(db, USER_A, "00000001", true, {
      companyName: "Company 001",
    });

    // 30 distinct non-starred views, each 1 minute newer than the last.
    for (let i = 2; i <= 31; i++) {
      vi.setSystemTime(new Date(2026, 6, 1, 0, i, 0));
      await recordCompanyView(db, USER_A, {
        companyNumber: String(i).padStart(8, "0"),
        companyName: `Company ${String(i).padStart(3, "0")}`,
      });
    }

    const nonStarred = rows.filter((r) => !r.starred);
    const starred = rows.filter((r) => r.starred);
    expect(nonStarred).toHaveLength(RECENTS_CAP);
    expect(starred.map((r) => r.company_number)).toEqual(["00000001"]);

    // The oldest non-starred views (companies 002..006) were pruned; the
    // newest 25 (007..031) remain.
    const kept = nonStarred.map((r) => r.company_number).sort();
    expect(kept).toContain("00000031");
    expect(kept).not.toContain("00000002");
    vi.useRealTimers();
  });
});

describe("setCompanyStar", () => {
  it("inserts a not-yet-saved company with the snapshot when starred", async () => {
    const { db, rows } = makeDb();
    await setCompanyStar(db, USER_A, "00214436", true, {
      companyName: "MARKS AND SPENCER P.L.C.",
      companyStatus: "active",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      company_number: "00214436",
      company_name: "MARKS AND SPENCER P.L.C.",
      company_status: "active",
      starred: true,
    });
  });

  it("clears the flag on an existing row when unstarred", async () => {
    const { db, rows } = makeDb();
    await recordCompanyView(db, USER_A, {
      companyNumber: "00214436",
      companyName: "MARKS AND SPENCER P.L.C.",
    });
    await setCompanyStar(db, USER_A, "00214436", true, {
      companyName: "MARKS AND SPENCER P.L.C.",
    });
    expect(rows[0].starred).toBe(true);

    await setCompanyStar(db, USER_A, "00214436", false);
    expect(rows[0].starred).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it("is a no-op when unstarring a company that was never saved (no snapshot)", async () => {
    const { db, rows } = makeDb();
    await setCompanyStar(db, USER_A, "99999999", false);
    expect(rows).toHaveLength(0);
  });
});

describe("listCompanySaves", () => {
  it("returns starred (by name) and non-starred recents (by last_viewed_at desc)", async () => {
    vi.useFakeTimers();
    const { db } = makeDb();

    vi.setSystemTime(new Date("2026-07-01T09:00:00Z"));
    await recordCompanyView(db, USER_A, {
      companyNumber: "00000010",
      companyName: "Older recent",
    });
    vi.setSystemTime(new Date("2026-07-01T10:00:00Z"));
    await recordCompanyView(db, USER_A, {
      companyNumber: "00000011",
      companyName: "Newer recent",
    });
    await setCompanyStar(db, USER_A, "00000020", true, {
      companyName: "Zeta Ltd",
    });
    await setCompanyStar(db, USER_A, "00000021", true, {
      companyName: "Alpha Ltd",
    });

    const { starred, recents } = await listCompanySaves(db, USER_A);

    expect(starred.map((s) => s.companyName)).toEqual([
      "Alpha Ltd",
      "Zeta Ltd",
    ]);
    expect(recents.map((r) => r.companyNumber)).toEqual([
      "00000011",
      "00000010",
    ]);
    // A starred company never appears in recents.
    expect(recents.some((r) => r.starred)).toBe(false);
    vi.useRealTimers();
  });

  it("isolates users — A's saves are never returned for B", async () => {
    const { db } = makeDb();
    await recordCompanyView(db, USER_A, {
      companyNumber: "00214436",
      companyName: "MARKS AND SPENCER P.L.C.",
    });
    await setCompanyStar(db, USER_A, "13927967", true, {
      companyName: "ARIA GRACE LAW CIC",
    });

    const b = await listCompanySaves(db, USER_B);
    expect(b.starred).toEqual([]);
    expect(b.recents).toEqual([]);

    const a = await listCompanySaves(db, USER_A);
    expect(a.starred).toHaveLength(1);
    expect(a.recents).toHaveLength(1);
  });
});

describe("unmigrated-database degradation (42P01 / 42703)", () => {
  for (const code of ["42P01", "42703"] as const) {
    it(`recordCompanyView / setCompanyStar are no-ops and listCompanySaves is empty on ${code}`, async () => {
      const { db } = makeDb({ missing: code });
      await expect(
        recordCompanyView(db, USER_A, {
          companyNumber: "00214436",
          companyName: "MARKS AND SPENCER P.L.C.",
        }),
      ).resolves.toBeUndefined();
      await expect(
        setCompanyStar(db, USER_A, "00214436", true, {
          companyName: "MARKS AND SPENCER P.L.C.",
        }),
      ).resolves.toBeUndefined();
      await expect(
        setCompanyStar(db, USER_A, "00214436", false),
      ).resolves.toBeUndefined();
      await expect(listCompanySaves(db, USER_A)).resolves.toEqual({
        starred: [],
        recents: [],
      });
    });
  }

  it("still throws on a non-degradable error", async () => {
    const { db } = makeDb({ missing: "42P01" });
    // Sanity: a different Postgres code is NOT swallowed.
    const throwingDb = {
      from: () => ({
        upsert: () => ({
          then: (res: (v: unknown) => unknown) =>
            Promise.resolve({
              data: null,
              error: { code: "23505", message: "unique_violation" },
            }).then(res),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    void db;
    await expect(
      recordCompanyView(throwingDb, USER_A, {
        companyNumber: "00214436",
        companyName: "M&S",
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
