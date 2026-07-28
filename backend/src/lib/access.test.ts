import { beforeEach, describe, expect, it, vi } from "vitest";

// access.ts resolves the caller's org id via organisations.getUserOrganisationId
// and excludes tombstoned rows via deletionGovernance.getTombstonedIds. Mock both
// so the tests drive the firm branch and tombstone state directly.
const getUserOrganisationId = vi.fn();
vi.mock("./organisations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./organisations")>();
  return {
    ...actual,
    getUserOrganisationId: (...args: unknown[]) =>
      getUserOrganisationId(...args),
  };
});

const getTombstonedIds = vi.fn();
vi.mock("./deletionGovernance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./deletionGovernance")>();
  return {
    ...actual,
    getTombstonedIds: (...args: unknown[]) => getTombstonedIds(...args),
  };
});

import {
  checkProjectAccess,
  ensureDocAccess,
  ensureReviewAccess,
  filterAccessibleDocumentIds,
  listAccessibleProjectIds,
} from "./access";

// ── Fake Supabase stand-in ───────────────────────────────────────────────────
// Supports the exact call shapes access.ts uses against projects/documents:
//   .from(t).select(cols)[.eq()|.neq()|.filter("col","cs",json)|.in()][.single()|await]
// A table flagged `firmMissing` raises 42703 for any select that references the
// firm-visibility columns (visibility / organisation_id) — the unmigrated DB.

type Row = Record<string, unknown>;
const ERR_42703 = { code: "42703", message: "column does not exist" } as const;

function makeDb(
  tables: Record<string, Row[]>,
  firmMissing: Set<string> = new Set(),
) {
  function builder(table: string) {
    let selectCols = "";
    const eqs: Array<[string, unknown]> = [];
    const neqs: Array<[string, unknown]> = [];
    const containsFilters: Array<[string, string[]]> = [];
    const ins: Array<[string, unknown[]]> = [];

    function touchesFirmColumns(): boolean {
      if (/visibility|organisation_id/.test(selectCols)) return true;
      return eqs.some(([c]) => c === "visibility" || c === "organisation_id");
    }

    function resolve(single: boolean) {
      if (firmMissing.has(table) && touchesFirmColumns()) {
        return Promise.resolve({ data: null, error: ERR_42703 });
      }
      const matched = (tables[table] ?? []).filter(
        (row) =>
          eqs.every(([c, v]) => row[c] === v) &&
          neqs.every(([c, v]) => row[c] !== v) &&
          ins.every(([c, vs]) => vs.includes(row[c])) &&
          containsFilters.every(([c, needles]) => {
            const arr = Array.isArray(row[c]) ? (row[c] as unknown[]) : [];
            return needles.every((n) => arr.includes(n));
          }),
      );
      if (single) {
        return Promise.resolve({
          data: matched[0] ? { ...matched[0] } : null,
          error: matched[0] ? null : { code: "PGRST116" },
        });
      }
      return Promise.resolve({
        data: matched.map((r) => ({ ...r })),
        error: null,
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select(cols?: string) {
        selectCols = cols ?? "";
        return b;
      },
      eq(col: string, val: unknown) {
        eqs.push([col, val]);
        return b;
      },
      neq(col: string, val: unknown) {
        neqs.push([col, val]);
        return b;
      },
      filter(col: string, op: string, val: string) {
        if (op === "cs") containsFilters.push([col, JSON.parse(val)]);
        return b;
      },
      in(col: string, vals: unknown[]) {
        ins.push([col, vals]);
        return b;
      },
      single() {
        return resolve(true);
      },
      then(onF: unknown, onR: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return resolve(false).then(onF as any, onR as any);
      },
    };
    return b;
  }
  return { from: (table: string) => builder(table) } as never;
}

const CALLER = "caller-uuid";
const CALLER_EMAIL = "caller@firm.test";
const OWNER = "owner-uuid";
const ORG = "org-1";
const OTHER_ORG = "org-2";

beforeEach(() => {
  getUserOrganisationId.mockReset().mockResolvedValue(null);
  getTombstonedIds.mockReset().mockResolvedValue(new Set());
});

// ── checkProjectAccess — the access-branch matrix ─────────────────────────────

describe("checkProjectAccess — firm branch matrix", () => {
  const firmProject = {
    id: "p1",
    user_id: OWNER,
    shared_with: [] as string[],
    visibility: "firm",
    organisation_id: ORG,
  };

  it("grants the OWNER access as isOwner", async () => {
    const db = makeDb({ projects: [{ ...firmProject, user_id: CALLER }] });
    const res = await checkProjectAccess("p1", CALLER, CALLER_EMAIL, db);
    expect(res).toMatchObject({ ok: true, isOwner: true });
  });

  it("grants an EMAIL-SHAREE access as a non-owner", async () => {
    const db = makeDb({
      projects: [{ ...firmProject, visibility: "private", organisation_id: null, shared_with: [CALLER_EMAIL] }],
    });
    const res = await checkProjectAccess("p1", CALLER, CALLER_EMAIL, db);
    expect(res).toEqual({
      ok: true,
      isOwner: false,
      project: expect.objectContaining({ id: "p1" }),
    });
  });

  it("grants a FIRM MEMBER in the SAME org access as a non-owner", async () => {
    getUserOrganisationId.mockResolvedValue(ORG);
    const db = makeDb({ projects: [firmProject] });
    const res = await checkProjectAccess("p1", CALLER, CALLER_EMAIL, db);
    expect(res).toMatchObject({ ok: true, isOwner: false });
  });

  it("EXCLUDES a firm member in a DIFFERENT org", async () => {
    getUserOrganisationId.mockResolvedValue(OTHER_ORG);
    const db = makeDb({ projects: [firmProject] });
    const res = await checkProjectAccess("p1", CALLER, CALLER_EMAIL, db);
    expect(res).toEqual({ ok: false });
  });

  it("EXCLUDES an orgless caller from a firm-visible matter", async () => {
    getUserOrganisationId.mockResolvedValue(null);
    const db = makeDb({ projects: [firmProject] });
    const res = await checkProjectAccess("p1", CALLER, CALLER_EMAIL, db);
    expect(res).toEqual({ ok: false });
  });

  it("EXCLUDES a same-org caller when the matter is private (not firm-shared)", async () => {
    getUserOrganisationId.mockResolvedValue(ORG);
    const db = makeDb({
      projects: [{ ...firmProject, visibility: "private", organisation_id: null }],
    });
    const res = await checkProjectAccess("p1", CALLER, CALLER_EMAIL, db);
    expect(res).toEqual({ ok: false });
  });

  it("firm access depends ONLY on the org-id match (policy-independent)", async () => {
    // access.ts never consults firm policies — a same-org firm-visible matter is
    // accessible regardless of any member-policy state.
    getUserOrganisationId.mockResolvedValue(ORG);
    const db = makeDb({ projects: [firmProject] });
    const res = await checkProjectAccess("p1", CALLER, CALLER_EMAIL, db);
    expect(res).toMatchObject({ ok: true, isOwner: false });
  });

  it("uses a threaded org id without an extra lookup", async () => {
    const db = makeDb({ projects: [firmProject] });
    const res = await checkProjectAccess("p1", CALLER, CALLER_EMAIL, db, ORG);
    expect(res).toMatchObject({ ok: true, isOwner: false });
    expect(getUserOrganisationId).not.toHaveBeenCalled();
  });

  it("does not resolve an org id at all on the owner fast-path", async () => {
    const db = makeDb({ projects: [{ ...firmProject, user_id: CALLER }] });
    await checkProjectAccess("p1", CALLER, CALLER_EMAIL, db);
    expect(getUserOrganisationId).not.toHaveBeenCalled();
  });

  it("degrades (firm branch absent) on an unmigrated DB (42703)", async () => {
    getUserOrganisationId.mockResolvedValue(ORG);
    // firm columns missing → the 5-col select 42703s, the legacy 3-col select
    // returns the row; owner/sharee still resolve, firm branch is unavailable.
    const db = makeDb(
      { projects: [{ id: "p1", user_id: OWNER, shared_with: [CALLER_EMAIL] }] },
      new Set(["projects"]),
    );
    const sharee = await checkProjectAccess("p1", CALLER, CALLER_EMAIL, db);
    expect(sharee).toMatchObject({ ok: true, isOwner: false });
    // A caller who would only qualify via the firm branch is excluded.
    const stranger = await checkProjectAccess("p1", "stranger", "x@y.z", db);
    expect(stranger).toEqual({ ok: false });
  });

  it("returns not-found for a missing project", async () => {
    const db = makeDb({ projects: [] });
    expect(await checkProjectAccess("nope", CALLER, CALLER_EMAIL, db)).toEqual({
      ok: false,
    });
  });
});

// ── Parent-tombstone gating (WS8×WS9 fix) ─────────────────────────────────────
// A tombstoned matter must be denied to EVERYONE — owner, sharee and firm viewer
// alike — at the shared choke point, so every content sub-route inherits the 404
// the detail routes already return.

describe("checkProjectAccess — a tombstoned matter is denied to everyone", () => {
  const firmProject = {
    id: "p1",
    user_id: OWNER,
    shared_with: [CALLER_EMAIL],
    visibility: "firm",
    organisation_id: ORG,
  };

  beforeEach(() => {
    getTombstonedIds.mockResolvedValue(new Set(["p1"]));
  });

  it("denies the OWNER (who would otherwise pass the fast-path)", async () => {
    const db = makeDb({ projects: [{ ...firmProject, user_id: CALLER }] });
    expect(await checkProjectAccess("p1", CALLER, CALLER_EMAIL, db)).toEqual({
      ok: false,
    });
  });

  it("denies an EMAIL-SHAREE", async () => {
    const db = makeDb({
      projects: [
        { ...firmProject, visibility: "private", organisation_id: null },
      ],
    });
    expect(await checkProjectAccess("p1", CALLER, CALLER_EMAIL, db)).toEqual({
      ok: false,
    });
  });

  it("denies a same-org FIRM member", async () => {
    getUserOrganisationId.mockResolvedValue(ORG);
    const db = makeDb({ projects: [firmProject] });
    expect(await checkProjectAccess("p1", CALLER, CALLER_EMAIL, db)).toEqual({
      ok: false,
    });
  });
});

describe("ensureReviewAccess — a tombstoned review is denied to everyone", () => {
  const firmReview = {
    id: "r1",
    user_id: OWNER,
    project_id: null,
    shared_with: [CALLER_EMAIL],
    visibility: "firm",
    organisation_id: ORG,
  };

  beforeEach(() => {
    // The review's OWN tombstone (tabular-review) is set; the project lookup (if
    // any) stays clean.
    getTombstonedIds.mockImplementation((_db: unknown, type: string) =>
      Promise.resolve(type === "tabular-review" ? new Set(["r1"]) : new Set()),
    );
  });

  it("denies the OWNER", async () => {
    const res = await ensureReviewAccess(
      { ...firmReview, user_id: CALLER },
      CALLER,
      CALLER_EMAIL,
      makeDb({}),
    );
    expect(res).toEqual({ ok: false });
  });

  it("denies an EMAIL-SHAREE", async () => {
    const res = await ensureReviewAccess(
      firmReview,
      CALLER,
      CALLER_EMAIL,
      makeDb({}),
    );
    expect(res).toEqual({ ok: false });
  });

  it("denies a same-org FIRM member (standalone review)", async () => {
    getUserOrganisationId.mockResolvedValue(ORG);
    const res = await ensureReviewAccess(
      firmReview,
      CALLER,
      CALLER_EMAIL,
      makeDb({}),
    );
    expect(res).toEqual({ ok: false });
  });

  it("denies a project-scoped review whose PARENT matter is tombstoned (review itself live)", async () => {
    getUserOrganisationId.mockResolvedValue(ORG);
    // review not tombstoned; the parent project is.
    getTombstonedIds.mockImplementation((_db: unknown, type: string) =>
      Promise.resolve(type === "project" ? new Set(["parent"]) : new Set()),
    );
    const db = makeDb({
      projects: [
        {
          id: "parent",
          user_id: OWNER,
          shared_with: [],
          visibility: "firm",
          organisation_id: ORG,
        },
      ],
    });
    const res = await ensureReviewAccess(
      {
        id: "r2",
        user_id: OWNER,
        project_id: "parent",
        shared_with: [],
        visibility: "private",
        organisation_id: null,
      },
      CALLER,
      CALLER_EMAIL,
      db,
    );
    expect(res).toEqual({ ok: false });
  });
});

// ── ensureReviewAccess — standalone firm branch ───────────────────────────────

describe("ensureReviewAccess — firm branch", () => {
  const standaloneFirmReview = {
    user_id: OWNER,
    project_id: null,
    shared_with: [] as string[],
    visibility: "firm",
    organisation_id: ORG,
  };

  it("grants a same-org firm member access to a STANDALONE firm review", async () => {
    getUserOrganisationId.mockResolvedValue(ORG);
    const res = await ensureReviewAccess(
      standaloneFirmReview,
      CALLER,
      CALLER_EMAIL,
      makeDb({}),
    );
    expect(res).toEqual({ ok: true, isOwner: false });
  });

  it("EXCLUDES a different-org caller from a standalone firm review", async () => {
    getUserOrganisationId.mockResolvedValue(OTHER_ORG);
    const res = await ensureReviewAccess(
      standaloneFirmReview,
      CALLER,
      CALLER_EMAIL,
      makeDb({}),
    );
    expect(res).toEqual({ ok: false });
  });

  it("EXCLUDES an orgless caller from a standalone firm review", async () => {
    getUserOrganisationId.mockResolvedValue(null);
    const res = await ensureReviewAccess(
      standaloneFirmReview,
      CALLER,
      CALLER_EMAIL,
      makeDb({}),
    );
    expect(res).toEqual({ ok: false });
  });

  it("still grants the owner and email-sharee (unchanged)", async () => {
    const owner = await ensureReviewAccess(
      { ...standaloneFirmReview, user_id: CALLER },
      CALLER,
      CALLER_EMAIL,
      makeDb({}),
    );
    expect(owner).toEqual({ ok: true, isOwner: true });
    const sharee = await ensureReviewAccess(
      { user_id: OWNER, project_id: null, shared_with: [CALLER_EMAIL] },
      CALLER,
      CALLER_EMAIL,
      makeDb({}),
    );
    expect(sharee).toEqual({ ok: true, isOwner: false });
  });

  it("a PROJECT-SCOPED review inherits its matter's firm visibility (not its own)", async () => {
    // The review's own visibility is 'private'; access flows through the parent
    // matter's firm branch via checkProjectAccess.
    getUserOrganisationId.mockResolvedValue(ORG);
    const db = makeDb({
      projects: [
        {
          id: "parent",
          user_id: OWNER,
          shared_with: [],
          visibility: "firm",
          organisation_id: ORG,
        },
      ],
    });
    const res = await ensureReviewAccess(
      { user_id: OWNER, project_id: "parent", shared_with: [], visibility: "private", organisation_id: null },
      CALLER,
      CALLER_EMAIL,
      db,
    );
    expect(res).toEqual({ ok: true, isOwner: false });
  });
});

// ── ensureDocAccess — inherits the matter's firm branch ───────────────────────

describe("ensureDocAccess — firm-visible matter documents", () => {
  it("grants a same-org firm member read of a firm-visible matter's document", async () => {
    getUserOrganisationId.mockResolvedValue(ORG);
    const db = makeDb({
      projects: [
        {
          id: "p1",
          user_id: OWNER,
          shared_with: [],
          visibility: "firm",
          organisation_id: ORG,
        },
      ],
    });
    const res = await ensureDocAccess(
      { id: "d1", user_id: OWNER, project_id: "p1" },
      CALLER,
      CALLER_EMAIL,
      db,
    );
    expect(res).toEqual({ ok: true, isOwner: false });
  });

  it("EXCLUDES a different-org caller", async () => {
    getUserOrganisationId.mockResolvedValue(OTHER_ORG);
    const db = makeDb({
      projects: [
        {
          id: "p1",
          user_id: OWNER,
          shared_with: [],
          visibility: "firm",
          organisation_id: ORG,
        },
      ],
    });
    const res = await ensureDocAccess(
      { id: "d1", user_id: OWNER, project_id: "p1" },
      CALLER,
      CALLER_EMAIL,
      db,
    );
    expect(res).toEqual({ ok: false });
  });
});

// ── listAccessibleProjectIds / filterAccessibleDocumentIds — firm rows ─────────

describe("listAccessibleProjectIds — firm-visible matters", () => {
  const projects = [
    { id: "own", user_id: CALLER, shared_with: [], visibility: "private", organisation_id: null },
    { id: "shared", user_id: OWNER, shared_with: [CALLER_EMAIL], visibility: "private", organisation_id: null },
    { id: "firm", user_id: OWNER, shared_with: [], visibility: "firm", organisation_id: ORG },
    { id: "firm-other", user_id: OWNER, shared_with: [], visibility: "firm", organisation_id: OTHER_ORG },
  ];

  it("includes own + email-shared + same-org firm matters, excludes other-org firm", async () => {
    getUserOrganisationId.mockResolvedValue(ORG);
    const ids = await listAccessibleProjectIds(CALLER, CALLER_EMAIL, makeDb({ projects }));
    expect(new Set(ids)).toEqual(new Set(["own", "shared", "firm"]));
  });

  it("orgless caller sees only own + email-shared (no firm branch)", async () => {
    getUserOrganisationId.mockResolvedValue(null);
    const ids = await listAccessibleProjectIds(CALLER, CALLER_EMAIL, makeDb({ projects }));
    expect(new Set(ids)).toEqual(new Set(["own", "shared"]));
  });

  it("degrades to own + shared on an unmigrated DB (firm query 42703)", async () => {
    getUserOrganisationId.mockResolvedValue(ORG);
    const ids = await listAccessibleProjectIds(
      CALLER,
      CALLER_EMAIL,
      makeDb({ projects }, new Set(["projects"])),
    );
    expect(new Set(ids)).toEqual(new Set(["own", "shared"]));
  });
});

describe("filterAccessibleDocumentIds — firm-visible matter documents", () => {
  it("allows attaching a document from a same-org firm-visible matter", async () => {
    getUserOrganisationId.mockResolvedValue(ORG);
    const db = makeDb({
      documents: [{ id: "d1", user_id: OWNER, project_id: "firm" }],
      projects: [
        { id: "firm", user_id: OWNER, shared_with: [], visibility: "firm", organisation_id: ORG },
      ],
    });
    const allowed = await filterAccessibleDocumentIds(["d1"], CALLER, CALLER_EMAIL, db);
    expect(allowed).toEqual(["d1"]);
  });

  it("rejects a document from a different-org firm matter", async () => {
    getUserOrganisationId.mockResolvedValue(OTHER_ORG);
    const db = makeDb({
      documents: [{ id: "d1", user_id: OWNER, project_id: "firm" }],
      projects: [
        { id: "firm", user_id: OWNER, shared_with: [], visibility: "firm", organisation_id: ORG },
      ],
    });
    const allowed = await filterAccessibleDocumentIds(["d1"], CALLER, CALLER_EMAIL, db);
    expect(allowed).toEqual([]);
  });
});
