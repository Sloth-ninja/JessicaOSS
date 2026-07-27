import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ─────────────────────────────────────────────────────────────
// resolveDeletionMode depends on organisations.resolveUserOrganisation; keep the
// rest of the module's real exports (DEFAULT_RETENTION_DAYS) so
// getRetentionContextForOwners' fallback stays authentic.
const resolveUserOrganisation = vi.fn();
vi.mock("./organisations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./organisations")>();
  return {
    ...actual,
    resolveUserOrganisation: (...args: unknown[]) =>
      resolveUserOrganisation(...args),
  };
});

// The purge helpers do real storage I/O in production; stub them so
// runDeletionPurge / expediteResource can be tested without touching R2/DB.
const purgeProjectsByIds = vi.fn();
const purgeDocumentsByIds = vi.fn();
const purgeChatsByIds = vi.fn();
const purgeTabularReviewsByIds = vi.fn();
const purgeWorkflowsByIds = vi.fn();
vi.mock("./userDataCleanup", () => ({
  purgeProjectsByIds: (...args: unknown[]) => purgeProjectsByIds(...args),
  purgeDocumentsByIds: (...args: unknown[]) => purgeDocumentsByIds(...args),
  purgeChatsByIds: (...args: unknown[]) => purgeChatsByIds(...args),
  purgeTabularReviewsByIds: (...args: unknown[]) =>
    purgeTabularReviewsByIds(...args),
  purgeWorkflowsByIds: (...args: unknown[]) => purgeWorkflowsByIds(...args),
}));

import {
  clampRetentionDays,
  expediteResource,
  getTombstonedIds,
  insertDeletionAudit,
  isResourceTombstoned,
  listPendingDeletions,
  resolveDeletionMode,
  restoreResource,
  runDeletionPurge,
  tombstoneAllForUser,
  tombstoneResource,
  type GovernedResourceType,
} from "./deletionGovernance";

// ── Fake chainable Supabase stand-in ─────────────────────────────────────────
// Supports the exact call shapes deletionGovernance.ts uses:
//   read:   .from(t).select(cols)[.eq()|.is()|.in()|.not()...][.maybeSingle()|await]
//   update: .from(t).update(patch)[.eq()|.is()|.in()|.not()...].select(cols) (awaited)
//   insert: .from(t).insert(payload) (awaited directly, no chaining)
// Mutations are applied against the predicate computed BEFORE the patch (the
// state-transition-in-the-predicate pattern the source relies on).

type Row = Record<string, unknown>;
type ErrSpec = { code?: string; message?: string } | null;

interface TableErrors {
  select?: ErrSpec;
  update?: ErrSpec;
  insert?: ErrSpec;
}

function makeDb(
  tables: Record<string, Row[]>,
  errors: Record<string, TableErrors> = {},
) {
  const inserts: Array<{ table: string; payload: Row }> = [];

  function builder(table: string) {
    let mode: "select" | "update" | "insert" | null = null;
    let updatePatch: Row | null = null;
    const eqFilters: Array<[string, unknown]> = [];
    const isFilters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    const notFilters: Array<[string, string, unknown]> = [];

    function matches(row: Row): boolean {
      return (
        eqFilters.every(([c, v]) => row[c] === v) &&
        isFilters.every(([c, v]) => row[c] === v) &&
        inFilters.every(([c, vs]) => vs.includes(row[c])) &&
        notFilters.every(([c, op, v]) => (op === "is" ? row[c] !== v : true))
      );
    }

    function currentRows(): Row[] {
      return (tables[table] ?? []).filter(matches);
    }

    function errFor(kind: "select" | "update" | "insert"): ErrSpec {
      return errors[table]?.[kind] ?? null;
    }

    function applyUpdate(): Row[] {
      const matched = currentRows();
      for (const row of matched) Object.assign(row, updatePatch);
      return matched;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select(_cols?: string) {
        if (mode === "update") {
          const err = errFor("update");
          if (err) return Promise.resolve({ data: null, error: err });
          const matched = applyUpdate();
          return Promise.resolve({
            data: matched.map((r) => ({ ...r })),
            error: null,
          });
        }
        mode = "select";
        return b;
      },
      update(patch: Row) {
        mode = "update";
        updatePatch = patch;
        return b;
      },
      insert(payload: Row) {
        mode = "insert";
        inserts.push({ table, payload });
        const err = errFor("insert");
        if (err) return Promise.resolve({ data: null, error: err });
        (tables[table] ??= []).push({ ...payload });
        return Promise.resolve({ data: null, error: null });
      },
      eq(col: string, val: unknown) {
        eqFilters.push([col, val]);
        return b;
      },
      is(col: string, val: unknown) {
        isFilters.push([col, val]);
        return b;
      },
      in(col: string, vals: unknown[]) {
        inFilters.push([col, vals]);
        return b;
      },
      not(col: string, op: string, val: unknown) {
        notFilters.push([col, op, val]);
        return b;
      },
      maybeSingle() {
        if (mode === "update") {
          const err = errFor("update");
          if (err) return Promise.resolve({ data: null, error: err });
          const matched = applyUpdate();
          return Promise.resolve({
            data: matched[0] ? { ...matched[0] } : null,
            error: null,
          });
        }
        const err = errFor("select");
        if (err) return Promise.resolve({ data: null, error: err });
        const rows = currentRows();
        return Promise.resolve({
          data: rows[0] ? { ...rows[0] } : null,
          error: null,
        });
      },
      then(resolve: unknown, reject: unknown) {
        const err = errFor(mode === "update" ? "update" : "select");
        const p = err
          ? Promise.resolve({ data: null, error: err })
          : Promise.resolve({
              data: currentRows().map((r) => ({ ...r })),
              error: null,
            });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return p.then(resolve as any, reject as any);
      },
    };
    return b;
  }

  const db = {
    from(table: string) {
      return builder(table);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, inserts };
}

const ERR_42703 = { code: "42703", message: "column does not exist" };
const ERR_42P01 = { code: "42P01", message: "relation does not exist" };
const ERR_GENERIC = { code: "23505", message: "unique violation" };

beforeEach(() => {
  resolveUserOrganisation.mockReset();
  purgeProjectsByIds.mockReset().mockResolvedValue(0);
  purgeDocumentsByIds.mockReset().mockResolvedValue(0);
  purgeChatsByIds.mockReset().mockResolvedValue(0);
  purgeTabularReviewsByIds.mockReset().mockResolvedValue(0);
  purgeWorkflowsByIds.mockReset().mockResolvedValue(0);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── resolveDeletionMode ───────────────────────────────────────────────────────

describe("resolveDeletionMode", () => {
  it("tombstones an organisation member and returns their firm id", async () => {
    resolveUserOrganisation.mockResolvedValue({
      id: "org-1",
      name: "Aria Grace Law",
      role: "member",
      policies: { memberApiKeys: true, memberMcpConnectors: false },
      retentionDays: 30,
    });
    const mode = await resolveDeletionMode({} as never, "u1");
    expect(mode).toEqual({ tombstone: true, organisationId: "org-1" });
  });

  it("hard-deletes (unchanged) for an orgless caller", async () => {
    resolveUserOrganisation.mockResolvedValue(null);
    const mode = await resolveDeletionMode({} as never, "u1");
    expect(mode).toEqual({ tombstone: false, organisationId: null });
  });

  it("FAILS SAFE to tombstone with an unknown org when the org lookup throws", async () => {
    resolveUserOrganisation.mockRejectedValue(new Error("db exploded"));
    const mode = await resolveDeletionMode({} as never, "u1");
    expect(mode).toEqual({ tombstone: true, organisationId: null });
  });
});

// ── tombstoneResource ──────────────────────────────────────────────────────────

describe("tombstoneResource", () => {
  it("sets deleted_at/deleted_by and returns 'tombstoned' on a live row", async () => {
    const { db } = makeDb({
      projects: [{ id: "p1", user_id: "owner1", deleted_at: null }],
    });
    const outcome = await tombstoneResource(db, "project", "p1", "deleter1", {
      user_id: "owner1",
    });
    expect(outcome).toBe("tombstoned");
  });

  it("actually persists deleted_at (ISO) and deleted_by on the row", async () => {
    const tables: Record<string, Row[]> = {
      projects: [{ id: "p1", user_id: "owner1", deleted_at: null }],
    };
    const { db } = makeDb(tables);
    await tombstoneResource(db, "project", "p1", "deleter1", {
      user_id: "owner1",
    });
    const row = tables.projects[0];
    expect(row.deleted_by).toBe("deleter1");
    expect(typeof row.deleted_at).toBe("string");
    expect(Number.isNaN(new Date(row.deleted_at as string).getTime())).toBe(
      false,
    );
  });

  it("returns 'not_found' when the row is already tombstoned (predicate excludes it)", async () => {
    const { db } = makeDb({
      projects: [
        { id: "p1", user_id: "owner1", deleted_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const outcome = await tombstoneResource(db, "project", "p1", "deleter1", {
      user_id: "owner1",
    });
    expect(outcome).toBe("not_found");
  });

  it("returns 'not_found' when the scope (ownership) predicate doesn't match", async () => {
    const { db } = makeDb({
      projects: [{ id: "p1", user_id: "someone-else", deleted_at: null }],
    });
    const outcome = await tombstoneResource(db, "project", "p1", "deleter1", {
      user_id: "owner1",
    });
    expect(outcome).toBe("not_found");
  });

  it("carries scope eqs correctly (an unrelated scope value blocks the match)", async () => {
    const { db } = makeDb({
      chats: [{ id: "c1", user_id: "u1", deleted_at: null, is_system: true }],
    });
    const outcome = await tombstoneResource(db, "chat", "c1", "u1", {
      user_id: "u1",
      is_system: false,
    });
    expect(outcome).toBe("not_found");
  });

  it("returns 'unsupported' on 42703 (unmigrated database)", async () => {
    const { db } = makeDb(
      { projects: [{ id: "p1", user_id: "owner1", deleted_at: null }] },
      { projects: { update: ERR_42703 } },
    );
    const outcome = await tombstoneResource(db, "project", "p1", "deleter1");
    expect(outcome).toBe("unsupported");
  });

  it("returns 'unsupported' on 42P01 (missing table)", async () => {
    const { db } = makeDb(
      { projects: [{ id: "p1", user_id: "owner1", deleted_at: null }] },
      { projects: { update: ERR_42P01 } },
    );
    const outcome = await tombstoneResource(db, "project", "p1", "deleter1");
    expect(outcome).toBe("unsupported");
  });

  it("throws on a non-42703/42P01 error", async () => {
    const { db } = makeDb(
      { projects: [{ id: "p1", user_id: "owner1", deleted_at: null }] },
      { projects: { update: ERR_GENERIC } },
    );
    await expect(
      tombstoneResource(db, "project", "p1", "deleter1"),
    ).rejects.toEqual(ERR_GENERIC);
  });
});

// ── tombstoneAllForUser ────────────────────────────────────────────────────────

describe("tombstoneAllForUser", () => {
  it("tombstones every not-yet-tombstoned row owned by the user and returns the count", async () => {
    const tables: Record<string, Row[]> = {
      chats: [
        { id: "c1", user_id: "u1", deleted_at: null },
        { id: "c2", user_id: "u1", deleted_at: null },
        // Already tombstoned — excluded.
        { id: "c3", user_id: "u1", deleted_at: "2026-01-01T00:00:00Z" },
        // Another user — excluded.
        { id: "c4", user_id: "u2", deleted_at: null },
      ],
    };
    const { db } = makeDb(tables);
    const count = await tombstoneAllForUser(db, "chat", "u1");
    expect(count).toBe(2);
    expect(tables.chats[0].deleted_by).toBe("u1");
    expect(tables.chats[1].deleted_by).toBe("u1");
    // Untouched rows stay untouched.
    expect(tables.chats[3].deleted_by).toBeUndefined();
  });

  it("returns 'unsupported' on 42703", async () => {
    const { db } = makeDb(
      { chats: [{ id: "c1", user_id: "u1", deleted_at: null }] },
      { chats: { update: ERR_42703 } },
    );
    expect(await tombstoneAllForUser(db, "chat", "u1")).toBe("unsupported");
  });
});

// ── getTombstonedIds / isResourceTombstoned ────────────────────────────────────

describe("getTombstonedIds", () => {
  it("returns the set of tombstoned ids, filtered to candidate ids", async () => {
    const { db } = makeDb({
      documents: [
        { id: "d1", deleted_at: "2026-01-01T00:00:00Z" },
        { id: "d2", deleted_at: null },
        { id: "d3", deleted_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const ids = await getTombstonedIds(db, "document", {
      ids: ["d1", "d2"],
    });
    expect(ids).toEqual(new Set(["d1"]));
  });

  it("returns an empty set immediately for an empty candidate id list (no query)", async () => {
    const { db } = makeDb({ documents: [] });
    const ids = await getTombstonedIds(db, "document", { ids: [] });
    expect(ids).toEqual(new Set());
  });

  it("scopes by userId when provided", async () => {
    const { db } = makeDb({
      projects: [
        { id: "p1", user_id: "u1", deleted_at: "2026-01-01T00:00:00Z" },
        { id: "p2", user_id: "u2", deleted_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const ids = await getTombstonedIds(db, "project", { userId: "u1" });
    expect(ids).toEqual(new Set(["p1"]));
  });

  it("degrades to an empty set on 42703/42P01 (never throws)", async () => {
    const { db: db1 } = makeDb(
      { workflows: [{ id: "w1", deleted_at: "2026-01-01T00:00:00Z" }] },
      { workflows: { select: ERR_42703 } },
    );
    expect(await getTombstonedIds(db1, "workflow")).toEqual(new Set());

    const { db: db2 } = makeDb(
      { workflows: [{ id: "w1", deleted_at: "2026-01-01T00:00:00Z" }] },
      { workflows: { select: ERR_42P01 } },
    );
    expect(await getTombstonedIds(db2, "workflow")).toEqual(new Set());
  });

  it("degrades to an empty set (never throws) on a generic query error", async () => {
    const { db } = makeDb(
      { workflows: [{ id: "w1", deleted_at: "2026-01-01T00:00:00Z" }] },
      { workflows: { select: ERR_GENERIC } },
    );
    await expect(getTombstonedIds(db, "workflow")).resolves.toEqual(new Set());
  });
});

describe("isResourceTombstoned", () => {
  it("is true for a tombstoned row", async () => {
    const { db } = makeDb({
      documents: [{ id: "d1", deleted_at: "2026-01-01T00:00:00Z" }],
    });
    expect(await isResourceTombstoned(db, "document", "d1")).toBe(true);
  });

  it("is false for a live row", async () => {
    const { db } = makeDb({
      documents: [{ id: "d1", deleted_at: null }],
    });
    expect(await isResourceTombstoned(db, "document", "d1")).toBe(false);
  });
});

// ── clampRetentionDays ────────────────────────────────────────────────────────

describe("clampRetentionDays", () => {
  it("passes a valid value through unchanged", () => {
    expect(clampRetentionDays(30)).toBe(30);
  });
  it("clamps 0 up to the 1-day floor", () => {
    expect(clampRetentionDays(0)).toBe(1);
  });
  it("clamps 400 down to the 365-day ceiling", () => {
    expect(clampRetentionDays(400)).toBe(365);
  });
  it("accepts the lower boundary (1)", () => {
    expect(clampRetentionDays(1)).toBe(1);
  });
  it("accepts the upper boundary (365)", () => {
    expect(clampRetentionDays(365)).toBe(365);
  });
  it("returns null for a non-numeric string", () => {
    expect(clampRetentionDays("abc")).toBeNull();
  });
  it("returns null for null", () => {
    expect(clampRetentionDays(null)).toBeNull();
  });
  it("returns null for an empty string", () => {
    expect(clampRetentionDays("")).toBeNull();
  });
  it("parses a numeric string", () => {
    expect(clampRetentionDays("45")).toBe(45);
  });
  it("truncates a fractional value (45.9 -> 45)", () => {
    expect(clampRetentionDays(45.9)).toBe(45);
  });
});

// ── runDeletionPurge ───────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-27T12:00:00.000Z");

describe("runDeletionPurge — window edges and per-owner retention", () => {
  it("purges rows strictly older than the owner's retention window; the exact boundary is kept", async () => {
    // orgUser: org "org-a", retention 7 days.
    // soloUser: no user_profiles row -> falls back to the 30-day default.
    const tables: Record<string, Row[]> = {
      user_profiles: [
        {
          user_id: "orgUser",
          organisation_id: "org-a",
          organisation: { retention_days: 7 },
        },
      ],
      projects: [
        {
          id: "p-org-boundary",
          user_id: "orgUser",
          deleted_at: new Date(NOW.getTime() - 7 * DAY_MS).toISOString(),
        },
        {
          id: "p-org-older",
          user_id: "orgUser",
          deleted_at: new Date(
            NOW.getTime() - 7 * DAY_MS - 60_000,
          ).toISOString(),
        },
        {
          id: "p-solo-boundary",
          user_id: "soloUser",
          deleted_at: new Date(NOW.getTime() - 30 * DAY_MS).toISOString(),
        },
        {
          id: "p-solo-older",
          user_id: "soloUser",
          deleted_at: new Date(
            NOW.getTime() - 30 * DAY_MS - 60_000,
          ).toISOString(),
        },
        // Not tombstoned — excluded by the `.not(deleted_at is null)` scan.
        { id: "p-live", user_id: "orgUser", deleted_at: null },
      ],
    };
    const { db, inserts } = makeDb(tables);

    const summary = await runDeletionPurge(db, NOW);

    expect(summary.byType.project).toBe(2);
    expect(summary.total).toBe(2);
    expect(purgeProjectsByIds).toHaveBeenCalledTimes(1);
    const purgedIds = purgeProjectsByIds.mock.calls[0][1] as string[];
    expect(new Set(purgedIds)).toEqual(
      new Set(["p-org-older", "p-solo-older"]),
    );
    // Boundary rows were never purged.
    expect(purgedIds).not.toContain("p-org-boundary");
    expect(purgedIds).not.toContain("p-solo-boundary");

    // Exactly one 'purged' audit row for org-a (the only owner with a
    // resolvable org among the purged rows) with the correct counts.
    const auditInserts = inserts.filter(
      (i) => i.table === "deletion_audit_logs",
    );
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].payload).toMatchObject({
      organisation_id: "org-a",
      action: "purged",
      resource_type: "sweep",
      detail: { counts: { project: 1 }, total: 1 },
    });
  });

  it("skips a table with a missing column/table (42703/42P01) without throwing", async () => {
    const tables: Record<string, Row[]> = {
      chats: [
        {
          id: "c1",
          user_id: "u1",
          deleted_at: new Date(NOW.getTime() - 100 * DAY_MS).toISOString(),
        },
      ],
    };
    const { db } = makeDb(tables, { chats: { select: ERR_42703 } });
    await expect(runDeletionPurge(db, NOW)).resolves.toEqual({
      total: 0,
      byType: {
        project: 0,
        document: 0,
        chat: 0,
        "tabular-review": 0,
        workflow: 0,
      },
    });
    expect(purgeChatsByIds).not.toHaveBeenCalled();
  });

  it("skips a table on 42P01 without throwing", async () => {
    const tables: Record<string, Row[]> = {
      workflows: [
        {
          id: "w1",
          user_id: "u1",
          deleted_at: new Date(NOW.getTime() - 100 * DAY_MS).toISOString(),
        },
      ],
    };
    const { db } = makeDb(tables, { workflows: { select: ERR_42P01 } });
    const summary = await runDeletionPurge(db, NOW);
    expect(summary.byType.workflow).toBe(0);
    expect(purgeWorkflowsByIds).not.toHaveBeenCalled();
  });
});

// ── listPendingDeletions ───────────────────────────────────────────────────────

describe("listPendingDeletions", () => {
  it("scopes to organisation members, computes daysRemaining, newest first", async () => {
    const now = new Date("2026-07-27T00:00:00.000Z");
    const tables: Record<string, Row[]> = {
      user_profiles: [
        { user_id: "m1", organisation_id: "org-x" },
        { user_id: "m2", organisation_id: "org-x" },
      ],
      organisations: [{ id: "org-x", retention_days: 10 }],
      projects: [
        {
          id: "p1",
          user_id: "m1",
          name: "Older matter",
          deleted_at: new Date(now.getTime() - 3 * DAY_MS).toISOString(),
          deleted_by: "m1",
        },
        {
          id: "p2",
          user_id: "m2",
          name: "Overdue matter",
          // Past the retention window -> daysRemaining clamps to 0.
          deleted_at: new Date(now.getTime() - 15 * DAY_MS).toISOString(),
          deleted_by: "m2",
        },
        {
          id: "p3",
          user_id: "m1",
          name: "Newest matter",
          deleted_at: new Date(now.getTime() - 1 * DAY_MS).toISOString(),
          deleted_by: "m1",
        },
        // Not a member of org-x — must be excluded.
        {
          id: "p-outsider",
          user_id: "outsider",
          name: "Not ours",
          deleted_at: new Date(now.getTime() - 1 * DAY_MS).toISOString(),
          deleted_by: "outsider",
        },
      ],
    };
    const { db } = makeDb(tables);

    const pending = await listPendingDeletions(db, "org-x", now);

    expect(pending.map((p) => p.id)).not.toContain("p-outsider");
    expect(pending).toHaveLength(3);
    // Newest first: p3 (-1d), p1 (-3d), p2 (-15d).
    expect(pending.map((p) => p.id)).toEqual(["p3", "p1", "p2"]);

    const p1 = pending.find((p) => p.id === "p1")!;
    expect(p1.daysRemaining).toBe(7); // 10 - 3
    const p2 = pending.find((p) => p.id === "p2")!;
    expect(p2.daysRemaining).toBe(0); // max(0, 10 - 15)
  });

  it("returns an empty list when the org has no members", async () => {
    const { db } = makeDb({ user_profiles: [] });
    const pending = await listPendingDeletions(db, "org-empty");
    expect(pending).toEqual([]);
  });
});

// ── restoreResource ──────────────────────────────────────────────────────────

describe("restoreResource", () => {
  it("clears the tombstone on a member-owned tombstoned row and returns 'ok'", async () => {
    const tables: Record<string, Row[]> = {
      chats: [
        {
          id: "c1",
          user_id: "m1",
          deleted_at: "2026-07-20T00:00:00.000Z",
          deleted_by: "m1",
        },
      ],
    };
    const { db } = makeDb(tables);
    const outcome = await restoreResource(db, "chat", "c1", ["m1", "m2"]);
    expect(outcome).toBe("ok");
    expect(tables.chats[0].deleted_at).toBeNull();
    expect(tables.chats[0].deleted_by).toBeNull();
  });

  it("returns 'not_found' (and does not restore) a row owned by a NON-member", async () => {
    const tables: Record<string, Row[]> = {
      chats: [
        {
          id: "c1",
          user_id: "outsider",
          deleted_at: "2026-07-20T00:00:00.000Z",
          deleted_by: "outsider",
        },
      ],
    };
    const { db } = makeDb(tables);
    const outcome = await restoreResource(db, "chat", "c1", ["m1", "m2"]);
    expect(outcome).toBe("not_found");
    // The row must be untouched — authz scoping, not just a wrong return value.
    expect(tables.chats[0].deleted_at).toBe("2026-07-20T00:00:00.000Z");
  });

  it("returns 'not_found' for a live (non-tombstoned) row even if owned by a member", async () => {
    const { db } = makeDb({
      chats: [{ id: "c1", user_id: "m1", deleted_at: null }],
    });
    expect(await restoreResource(db, "chat", "c1", ["m1"])).toBe("not_found");
  });

  it("short-circuits to 'not_found' with an empty member list", async () => {
    const { db } = makeDb({ chats: [] });
    expect(await restoreResource(db, "chat", "c1", [])).toBe("not_found");
  });

  it("returns 'unsupported' on 42703", async () => {
    const { db } = makeDb(
      {
        chats: [
          {
            id: "c1",
            user_id: "m1",
            deleted_at: "2026-07-20T00:00:00.000Z",
          },
        ],
      },
      { chats: { update: ERR_42703 } },
    );
    expect(await restoreResource(db, "chat", "c1", ["m1"])).toBe("unsupported");
  });
});

// ── expediteResource ───────────────────────────────────────────────────────────

describe("expediteResource", () => {
  it("purges a member-owned tombstoned row immediately and returns 'ok'", async () => {
    const { db } = makeDb({
      documents: [
        {
          id: "d1",
          user_id: "m1",
          deleted_at: "2026-07-20T00:00:00.000Z",
        },
      ],
    });
    purgeDocumentsByIds.mockResolvedValue(1);
    const outcome = await expediteResource(db, "document", "d1", ["m1", "m2"]);
    expect(outcome).toBe("ok");
    expect(purgeDocumentsByIds).toHaveBeenCalledWith(db, ["d1"]);
  });

  it("returns 'not_found' for a non-member's row and never purges", async () => {
    const { db } = makeDb({
      documents: [
        {
          id: "d1",
          user_id: "outsider",
          deleted_at: "2026-07-20T00:00:00.000Z",
        },
      ],
    });
    const outcome = await expediteResource(db, "document", "d1", ["m1"]);
    expect(outcome).toBe("not_found");
    expect(purgeDocumentsByIds).not.toHaveBeenCalled();
  });

  it("returns 'not_found' for a live (non-tombstoned) row and never purges", async () => {
    const { db } = makeDb({
      documents: [{ id: "d1", user_id: "m1", deleted_at: null }],
    });
    const outcome = await expediteResource(db, "document", "d1", ["m1"]);
    expect(outcome).toBe("not_found");
    expect(purgeDocumentsByIds).not.toHaveBeenCalled();
  });

  it("short-circuits to 'not_found' with an empty member list, never purging", async () => {
    const { db } = makeDb({ documents: [] });
    expect(await expediteResource(db, "document", "d1", [])).toBe("not_found");
    expect(purgeDocumentsByIds).not.toHaveBeenCalled();
  });

  it("returns 'unsupported' on 42703 and never purges", async () => {
    const { db } = makeDb(
      {
        documents: [
          {
            id: "d1",
            user_id: "m1",
            deleted_at: "2026-07-20T00:00:00.000Z",
          },
        ],
      },
      { documents: { select: ERR_42703 } },
    );
    const outcome = await expediteResource(db, "document", "d1", ["m1"]);
    expect(outcome).toBe("unsupported");
    expect(purgeDocumentsByIds).not.toHaveBeenCalled();
  });
});

// ── insertDeletionAudit ────────────────────────────────────────────────────────

describe("insertDeletionAudit", () => {
  it("inserts an audit row when organisationId is present", async () => {
    const { db, inserts } = makeDb({});
    await insertDeletionAudit(db, {
      organisationId: "org-1",
      actorUserId: "u1",
      action: "restored",
      resourceType: "chat",
      resourceId: "c1",
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      table: "deletion_audit_logs",
      payload: {
        organisation_id: "org-1",
        actor_user_id: "u1",
        action: "restored",
        resource_type: "chat",
        resource_id: "c1",
      },
    });
  });

  it("is a no-op (no insert) when organisationId is null", async () => {
    const { db, inserts } = makeDb({});
    await insertDeletionAudit(db, {
      organisationId: null,
      actorUserId: "u1",
      action: "expedited",
      resourceType: "document",
    });
    expect(inserts).toHaveLength(0);
  });

  it("never throws even when the insert itself errors", async () => {
    const { db } = makeDb({}, { deletion_audit_logs: { insert: ERR_GENERIC } });
    await expect(
      insertDeletionAudit(db, {
        organisationId: "org-1",
        actorUserId: "u1",
        action: "purged",
        resourceType: "sweep",
      }),
    ).resolves.toBeUndefined();
  });
});

// Sanity: GovernedResourceType stays importable/usable as a type-only import
// (keeps the test file honest about the module's public surface).
const _typeCheck: GovernedResourceType = "project";
void _typeCheck;
