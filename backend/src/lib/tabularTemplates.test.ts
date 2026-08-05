import { beforeEach, describe, expect, it, vi } from "vitest";

// The seam delegates deletion-mode resolution, tombstoning and audit appends to
// deletionGovernance — mock those so each path is driven directly (mirrors
// firmVisibility.test.ts).
const resolveDeletionMode = vi.fn();
const tombstoneResource = vi.fn();
const insertDeletionAudit = vi.fn();
vi.mock("./deletionGovernance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./deletionGovernance")>();
  return {
    ...actual,
    resolveDeletionMode: (...args: unknown[]) => resolveDeletionMode(...args),
    tombstoneResource: (...args: unknown[]) => tombstoneResource(...args),
    insertDeletionAudit: (...args: unknown[]) => insertDeletionAudit(...args),
  };
});

import {
  COLUMN_FORMATS,
  MAX_TEMPLATE_COLUMNS,
  TemplateValidationError,
  adminRevertTemplate,
  createTemplate,
  deleteTemplate,
  getTemplate,
  listFirmTemplatesForAdmin,
  listTemplates,
  setTemplateVisibility,
  updateTemplate,
  validateTemplateColumns,
} from "./tabularTemplates";

// ── Fake Supabase stand-in ───────────────────────────────────────────────────
// Select:  .from(t).select("*").eq()…​ then awaited / .maybeSingle() / .single()
// Insert:  .from(t).insert(row).select("*").single()
// Update:  .from(t).update(patch).eq()…​.select(cols)  (patch BEFORE predicate)
// Delete:  .from(t).delete().eq()…​.select("id")
// When `visibilityMissing` is set, any filter or payload touching the
// `visibility` / `organisation_id` columns raises 42703 (the unmigrated DB).

type Row = Record<string, unknown>;
const ERR_42703 = { code: "42703", message: "column does not exist" } as const;
const VISIBILITY_COLUMNS = ["visibility", "organisation_id"];

function makeDb(opts: {
  tables?: Record<string, Row[]>;
  visibilityMissing?: boolean;
}) {
  const tables = opts.tables ?? {};
  let idCounter = 0;

  function builder(table: string) {
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let patch: Row | null = null;
    let inserted: Row | null = null;
    const eqs: Array<[string, unknown]> = [];
    const neqs: Array<[string, unknown]> = [];
    const iss: Array<[string, unknown]> = [];

    function touchesMissingColumn(): boolean {
      if (!opts.visibilityMissing) return false;
      const filterCols = [...eqs, ...neqs, ...iss].map(([col]) => col);
      const payloadCols = Object.keys({ ...(patch ?? {}) });
      return [...filterCols, ...payloadCols].some((col) =>
        VISIBILITY_COLUMNS.includes(col),
      );
    }

    function matched(): Row[] {
      return (tables[table] ?? []).filter(
        (row) =>
          eqs.every(([c, v]) => row[c] === v) &&
          neqs.every(([c, v]) => row[c] !== v) &&
          // `.is(col, null)` matches rows where the column is null OR absent
          // (an untombstoned fixture omits deleted_at entirely).
          iss.every(([c, v]) => (row[c] ?? null) === v),
      );
    }

    function resolve(): Promise<{ data: Row[] | null; error: unknown }> {
      if (touchesMissingColumn()) {
        return Promise.resolve({ data: null, error: ERR_42703 });
      }
      if (mode === "insert") {
        const row = { id: `generated-${++idCounter}`, ...inserted };
        (tables[table] ??= []).push(row);
        return Promise.resolve({ data: [{ ...row }], error: null });
      }
      if (mode === "update") {
        const rows = matched();
        for (const row of rows) Object.assign(row, patch);
        return Promise.resolve({
          data: rows.map((r) => ({ ...r })),
          error: null,
        });
      }
      if (mode === "delete") {
        const rows = matched();
        tables[table] = (tables[table] ?? []).filter(
          (row) => !rows.includes(row),
        );
        return Promise.resolve({
          data: rows.map((r) => ({ ...r })),
          error: null,
        });
      }
      return Promise.resolve({
        data: matched().map((r) => ({ ...r })),
        error: null,
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      insert(row: Row) {
        mode = "insert";
        inserted = row;
        return b;
      },
      update(p: Row) {
        mode = "update";
        patch = p;
        return b;
      },
      delete() {
        mode = "delete";
        return b;
      },
      select(_cols?: string) {
        if (mode === "select") return b;
        const settled = resolve();
        return {
          then: (onF: unknown, onR: unknown) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            settled.then(onF as any, onR as any),
          single: () =>
            settled.then(({ data, error }) => ({
              data: data?.[0] ? { ...data[0] } : null,
              error,
            })),
          maybeSingle: () =>
            settled.then(({ data, error }) => ({
              data: data?.[0] ? { ...data[0] } : null,
              error,
            })),
        };
      },
      eq(col: string, val: unknown) {
        eqs.push([col, val]);
        return b;
      },
      neq(col: string, val: unknown) {
        neqs.push([col, val]);
        return b;
      },
      is(col: string, val: unknown) {
        iss.push([col, val]);
        return b;
      },
      in(col: string, vals: unknown[]) {
        // `.in()` is only used for the owner-name lookup; match set membership.
        eqs.push([col, vals]);
        return b;
      },
      order() {
        return b;
      },
      limit() {
        return b;
      },
      maybeSingle() {
        return resolve().then(({ data, error }) => ({
          data: data?.[0] ? { ...data[0] } : null,
          error,
        }));
      },
      single() {
        return resolve().then(({ data, error }) => ({
          data: data?.[0] ? { ...data[0] } : null,
          error,
        }));
      },
      then(onF: unknown, onR: unknown) {
        // The `.in()` predicate stores an array; match with set semantics.
        const rows = (tables[table] ?? []).filter(
          (row) =>
            eqs.every(([c, v]) =>
              Array.isArray(v) ? v.includes(row[c]) : row[c] === v,
            ) &&
            neqs.every(([c, v]) => row[c] !== v) &&
            iss.every(([c, v]) => (row[c] ?? null) === v),
        );
        const result = touchesMissingColumn()
          ? { data: null, error: ERR_42703 }
          : { data: rows.map((r) => ({ ...r })), error: null };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return Promise.resolve(result).then(onF as any, onR as any);
      },
    };
    return b;
  }

  const db = { from: (table: string) => builder(table) } as never;
  return { db, tables };
}

const OWNER = "owner-user";
const OTHER = "other-user";
const ORG = "org-1";
const OTHER_ORG = "org-2";

const COLUMNS = [
  { index: 0, name: "Parties", prompt: "Identify the parties." },
  { index: 1, name: "Term", prompt: "Extract the term.", format: "date" },
];

function templateRow(over: Row = {}): Row {
  return {
    id: "t1",
    user_id: OWNER,
    title: "NDA review",
    type: "tabular",
    prompt_md: null,
    columns_config: COLUMNS,
    practice: "Commercial",
    is_system: false,
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  resolveDeletionMode
    .mockReset()
    .mockResolvedValue({ tombstone: false, organisationId: null });
  tombstoneResource.mockReset().mockResolvedValue("tombstoned");
  insertDeletionAudit.mockReset().mockResolvedValue(undefined);
});

// ── validateTemplateColumns ──────────────────────────────────────────────────

describe("validateTemplateColumns", () => {
  it("exposes the nine formats from routes/tabular.ts", () => {
    expect([...COLUMN_FORMATS]).toEqual([
      "text",
      "bulleted_list",
      "number",
      "percentage",
      "monetary_amount",
      "currency",
      "yes_no",
      "date",
      "tag",
    ]);
    expect(MAX_TEMPLATE_COLUMNS).toBe(30);
  });

  it("round-trips valid columns and re-derives index from position", () => {
    const result = validateTemplateColumns([
      { index: 7, name: "  Parties  ", prompt: " Identify the parties. " },
      {
        index: 3,
        name: "Governing law",
        prompt: "Which law governs?",
        format: "tag",
        tags: ["England and Wales", "Scotland"],
      },
    ]);
    expect(result).toEqual([
      { index: 0, name: "Parties", prompt: "Identify the parties." },
      {
        index: 1,
        name: "Governing law",
        prompt: "Which law governs?",
        format: "tag",
        tags: ["England and Wales", "Scotland"],
      },
    ]);
  });

  it("rejects a non-array payload", () => {
    expect(() => validateTemplateColumns("nope")).toThrow(
      TemplateValidationError,
    );
    expect(() => validateTemplateColumns(null)).toThrow(
      TemplateValidationError,
    );
  });

  it("rejects a column with a missing or blank name", () => {
    expect(() =>
      validateTemplateColumns([{ prompt: "Identify the parties." }]),
    ).toThrow(TemplateValidationError);
    expect(() =>
      validateTemplateColumns([{ name: "   ", prompt: "x" }]),
    ).toThrow(TemplateValidationError);
  });

  it("rejects a column with a missing prompt", () => {
    expect(() => validateTemplateColumns([{ name: "Parties" }])).toThrow(
      TemplateValidationError,
    );
  });

  it("rejects an unknown format", () => {
    expect(() =>
      validateTemplateColumns([
        { name: "Parties", prompt: "x", format: "emoji" },
      ]),
    ).toThrow(TemplateValidationError);
  });

  it("rejects tags on a non-tag column", () => {
    expect(() =>
      validateTemplateColumns([
        { name: "Parties", prompt: "x", format: "text", tags: ["a"] },
      ]),
    ).toThrow(TemplateValidationError);
  });

  it("rejects more than MAX_TEMPLATE_COLUMNS columns", () => {
    const columns = Array.from(
      { length: MAX_TEMPLATE_COLUMNS + 1 },
      (_, i) => ({
        name: `Column ${i}`,
        prompt: "x",
      }),
    );
    expect(() => validateTemplateColumns(columns)).toThrow(
      TemplateValidationError,
    );
  });

  it("rejects over-length names and prompts", () => {
    expect(() =>
      validateTemplateColumns([{ name: "n".repeat(121), prompt: "x" }]),
    ).toThrow(TemplateValidationError);
    expect(() =>
      validateTemplateColumns([{ name: "Parties", prompt: "p".repeat(4001) }]),
    ).toThrow(TemplateValidationError);
  });
});

// ── listTemplates ────────────────────────────────────────────────────────────

describe("listTemplates", () => {
  it("returns own templates only for an orgless caller", async () => {
    const { db } = makeDb({
      tables: {
        workflows: [
          templateRow(),
          templateRow({ id: "t2", user_id: OTHER }),
          templateRow({ id: "t3", type: "assistant" }),
          templateRow({ id: "t4", is_system: true, user_id: null }),
          templateRow({ id: "t5", deleted_at: "2026-08-01T00:00:00Z" }),
        ],
      },
    });
    const list = await listTemplates(db, OWNER, null);
    expect(list.mine.map((t) => t.id)).toEqual(["t1"]);
    expect(list.firm).toEqual([]);
    expect(list.firmSharingSupported).toBe(false);
    expect(list.mine[0]).toMatchObject({
      title: "NDA review",
      practice: "Commercial",
      visibility: "private",
      isOwner: true,
      ownerUserId: OWNER,
      columns: COLUMNS,
    });
  });

  it("lists other members' firm templates for an org caller (own excluded from firm)", async () => {
    const { db } = makeDb({
      tables: {
        workflows: [
          templateRow({ visibility: "firm", organisation_id: ORG }),
          templateRow({
            id: "t2",
            user_id: OTHER,
            title: "Shared lease review",
            visibility: "firm",
            organisation_id: ORG,
          }),
          templateRow({
            id: "t3",
            user_id: OTHER,
            visibility: "firm",
            organisation_id: OTHER_ORG,
          }),
          templateRow({
            id: "t4",
            user_id: OTHER,
            visibility: "firm",
            organisation_id: ORG,
            deleted_at: "2026-08-01T00:00:00Z",
          }),
          templateRow({ id: "t5", user_id: OTHER }),
        ],
        user_profiles: [{ user_id: OTHER, display_name: "Sam Solicitor" }],
      },
    });
    const list = await listTemplates(db, OWNER, ORG);
    expect(list.firmSharingSupported).toBe(true);
    expect(list.mine.map((t) => t.id)).toEqual(["t1"]);
    expect(list.mine[0].visibility).toBe("firm");
    expect(list.firm.map((t) => t.id)).toEqual(["t2"]);
    expect(list.firm[0]).toMatchObject({
      title: "Shared lease review",
      isOwner: false,
      ownerUserId: OTHER,
      ownerDisplayName: "Sam Solicitor",
      visibility: "firm",
    });
  });

  it("degrades to firmSharingSupported:false on an unmigrated DB (42703), mine intact", async () => {
    const { db } = makeDb({
      tables: { workflows: [templateRow()] },
      visibilityMissing: true,
    });
    const list = await listTemplates(db, OWNER, ORG);
    expect(list.mine.map((t) => t.id)).toEqual(["t1"]);
    expect(list.firm).toEqual([]);
    expect(list.firmSharingSupported).toBe(false);
  });
});

// ── createTemplate ───────────────────────────────────────────────────────────

describe("createTemplate", () => {
  it("inserts a private tabular template owned by the caller", async () => {
    const { db, tables } = makeDb({ tables: { workflows: [] } });
    const template = await createTemplate(db, OWNER, {
      title: "  Lease review  ",
      practice: "Property",
      columns: [{ index: 9, name: "Rent", prompt: "Extract the rent." }],
    });
    expect(tables.workflows).toHaveLength(1);
    expect(tables.workflows[0]).toMatchObject({
      user_id: OWNER,
      title: "Lease review",
      type: "tabular",
      is_system: false,
      practice: "Property",
      columns_config: [{ index: 0, name: "Rent", prompt: "Extract the rent." }],
    });
    expect(template).toMatchObject({
      title: "Lease review",
      practice: "Property",
      visibility: "private",
      isOwner: true,
      ownerUserId: OWNER,
      columns: [{ index: 0, name: "Rent", prompt: "Extract the rent." }],
    });
  });

  it("rejects a blank title", async () => {
    const { db } = makeDb({ tables: { workflows: [] } });
    await expect(
      createTemplate(db, OWNER, { title: "   ", columns: [] }),
    ).rejects.toThrow(TemplateValidationError);
  });

  it("rejects invalid columns", async () => {
    const { db } = makeDb({ tables: { workflows: [] } });
    await expect(
      createTemplate(db, OWNER, {
        title: "Lease review",
        columns: [{ name: "Rent" }],
      }),
    ).rejects.toThrow(TemplateValidationError);
  });
});

// ── getTemplate ──────────────────────────────────────────────────────────────

describe("getTemplate", () => {
  it("returns the caller's own template", async () => {
    const { db } = makeDb({ tables: { workflows: [templateRow()] } });
    const template = await getTemplate(db, OWNER, "t1", null);
    expect(template).toMatchObject({ id: "t1", isOwner: true });
  });

  it("returns a firm-visible template from the caller's org with the owner's name", async () => {
    const { db } = makeDb({
      tables: {
        workflows: [
          templateRow({
            user_id: OTHER,
            visibility: "firm",
            organisation_id: ORG,
          }),
        ],
        user_profiles: [{ user_id: OTHER, display_name: "Sam Solicitor" }],
      },
    });
    const template = await getTemplate(db, OWNER, "t1", ORG);
    expect(template).toMatchObject({
      id: "t1",
      isOwner: false,
      visibility: "firm",
      ownerDisplayName: "Sam Solicitor",
    });
  });

  it("hides another user's private template", async () => {
    const { db } = makeDb({
      tables: { workflows: [templateRow({ user_id: OTHER })] },
    });
    expect(await getTemplate(db, OWNER, "t1", ORG)).toBe("not_found");
  });

  it("hides a firm template belonging to another org", async () => {
    const { db } = makeDb({
      tables: {
        workflows: [
          templateRow({
            user_id: OTHER,
            visibility: "firm",
            organisation_id: OTHER_ORG,
          }),
        ],
      },
    });
    expect(await getTemplate(db, OWNER, "t1", ORG)).toBe("not_found");
  });

  it("hides a tombstoned template (choke-point rule)", async () => {
    const { db } = makeDb({
      tables: {
        workflows: [templateRow({ deleted_at: "2026-08-01T00:00:00Z" })],
      },
    });
    expect(await getTemplate(db, OWNER, "t1", null)).toBe("not_found");
  });

  it("never returns an is_system row (built-ins are client-side)", async () => {
    const { db } = makeDb({
      tables: { workflows: [templateRow({ is_system: true })] },
    });
    expect(await getTemplate(db, OWNER, "t1", null)).toBe("not_found");
  });
});

// ── updateTemplate ───────────────────────────────────────────────────────────

describe("updateTemplate", () => {
  it("lets the owner rename and revalidates patched columns", async () => {
    const { db, tables } = makeDb({ tables: { workflows: [templateRow()] } });
    const result = await updateTemplate(db, OWNER, "t1", {
      title: "Renamed",
      columns: [{ index: 4, name: "Deposit", prompt: "Extract the deposit." }],
    });
    expect(result).toMatchObject({ id: "t1", title: "Renamed" });
    expect(tables.workflows[0]).toMatchObject({
      title: "Renamed",
      columns_config: [
        { index: 0, name: "Deposit", prompt: "Extract the deposit." },
      ],
    });
  });

  it("returns not_found for a non-owner (predicate matches zero rows)", async () => {
    const { db, tables } = makeDb({ tables: { workflows: [templateRow()] } });
    expect(await updateTemplate(db, OTHER, "t1", { title: "Hijack" })).toBe(
      "not_found",
    );
    expect(tables.workflows[0]).toMatchObject({ title: "NDA review" });
  });

  it("returns not_found for a tombstoned template", async () => {
    const { db } = makeDb({
      tables: {
        workflows: [templateRow({ deleted_at: "2026-08-01T00:00:00Z" })],
      },
    });
    expect(await updateTemplate(db, OWNER, "t1", { title: "x" })).toBe(
      "not_found",
    );
  });

  it("never updates an is_system template", async () => {
    const { db, tables } = makeDb({
      tables: { workflows: [templateRow({ is_system: true })] },
    });
    expect(await updateTemplate(db, OWNER, "t1", { title: "x" })).toBe(
      "not_found",
    );
    expect(tables.workflows[0]).toMatchObject({ title: "NDA review" });
  });

  it("throws on an invalid patch", async () => {
    const { db } = makeDb({ tables: { workflows: [templateRow()] } });
    await expect(
      updateTemplate(db, OWNER, "t1", {
        columns: [{ name: "X", prompt: "x", format: "emoji" }],
      }),
    ).rejects.toThrow(TemplateValidationError);
    await expect(updateTemplate(db, OWNER, "t1", {})).rejects.toThrow(
      TemplateValidationError,
    );
  });
});

// ── deleteTemplate ───────────────────────────────────────────────────────────

describe("deleteTemplate", () => {
  it("tombstones for an org member and records a 'requested' audit row", async () => {
    resolveDeletionMode.mockResolvedValue({
      tombstone: true,
      organisationId: ORG,
    });
    const { db } = makeDb({ tables: { workflows: [templateRow()] } });
    expect(await deleteTemplate(db, OWNER, "t1")).toBe("deleted");
    expect(tombstoneResource).toHaveBeenCalledWith(
      db,
      "workflow",
      "t1",
      OWNER,
      expect.objectContaining({ user_id: OWNER, is_system: false }),
    );
    expect(insertDeletionAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        organisationId: ORG,
        actorUserId: OWNER,
        action: "requested",
        resourceType: "workflow",
        resourceId: "t1",
      }),
    );
  });

  it("returns not_found when the tombstone matches zero rows, without auditing", async () => {
    resolveDeletionMode.mockResolvedValue({
      tombstone: true,
      organisationId: ORG,
    });
    tombstoneResource.mockResolvedValue("not_found");
    const { db } = makeDb({ tables: { workflows: [] } });
    expect(await deleteTemplate(db, OWNER, "t1")).toBe("not_found");
    expect(insertDeletionAudit).not.toHaveBeenCalled();
  });

  it("falls back to hard delete when tombstoning is unsupported (unmigrated)", async () => {
    resolveDeletionMode.mockResolvedValue({
      tombstone: true,
      organisationId: ORG,
    });
    tombstoneResource.mockResolvedValue("unsupported");
    const { db, tables } = makeDb({ tables: { workflows: [templateRow()] } });
    expect(await deleteTemplate(db, OWNER, "t1")).toBe("deleted");
    expect(tables.workflows).toHaveLength(0);
  });

  it("hard-deletes for an orgless self-hoster; unknown id is not_found", async () => {
    const { db, tables } = makeDb({ tables: { workflows: [templateRow()] } });
    expect(await deleteTemplate(db, OWNER, "t1")).toBe("deleted");
    expect(tables.workflows).toHaveLength(0);
    expect(await deleteTemplate(db, OWNER, "t1")).toBe("not_found");
    expect(tombstoneResource).not.toHaveBeenCalled();
  });

  it("never deletes another user's template", async () => {
    const { db, tables } = makeDb({
      tables: { workflows: [templateRow({ user_id: OTHER })] },
    });
    expect(await deleteTemplate(db, OWNER, "t1")).toBe("not_found");
    expect(tables.workflows).toHaveLength(1);
  });
});

// ── setTemplateVisibility ────────────────────────────────────────────────────

describe("setTemplateVisibility", () => {
  it("flips to firm, stamps the org and audits firm_shared", async () => {
    const { db, tables } = makeDb({ tables: { workflows: [templateRow()] } });
    const result = await setTemplateVisibility(db, OWNER, "t1", "firm", ORG);
    expect(result).toMatchObject({ id: "t1", visibility: "firm" });
    expect(tables.workflows[0]).toMatchObject({
      visibility: "firm",
      organisation_id: ORG,
    });
    expect(insertDeletionAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        organisationId: ORG,
        actorUserId: OWNER,
        action: "firm_shared",
        resourceType: "workflow",
        resourceId: "t1",
      }),
    );
  });

  it("reverting to private clears the org stamp and audits firm_reverted", async () => {
    const { db, tables } = makeDb({
      tables: {
        workflows: [templateRow({ visibility: "firm", organisation_id: ORG })],
      },
    });
    const result = await setTemplateVisibility(db, OWNER, "t1", "private", ORG);
    expect(result).toMatchObject({ id: "t1", visibility: "private" });
    expect(tables.workflows[0]).toMatchObject({
      visibility: "private",
      organisation_id: null,
    });
    expect(insertDeletionAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ action: "firm_reverted" }),
    );
  });

  it("returns unsupported for an orgless caller without touching the row", async () => {
    const { db, tables } = makeDb({ tables: { workflows: [templateRow()] } });
    expect(await setTemplateVisibility(db, OWNER, "t1", "firm", null)).toBe(
      "unsupported",
    );
    expect(tables.workflows[0]).not.toMatchObject({ visibility: "firm" });
  });

  it("returns not_found for a non-owner", async () => {
    const { db, tables } = makeDb({ tables: { workflows: [templateRow()] } });
    expect(await setTemplateVisibility(db, OTHER, "t1", "firm", ORG)).toBe(
      "not_found",
    );
    expect(tables.workflows[0]).not.toMatchObject({ visibility: "firm" });
  });

  it("returns not_found for a tombstoned template", async () => {
    const { db } = makeDb({
      tables: {
        workflows: [templateRow({ deleted_at: "2026-08-01T00:00:00Z" })],
      },
    });
    expect(await setTemplateVisibility(db, OWNER, "t1", "firm", ORG)).toBe(
      "not_found",
    );
  });

  it("returns unsupported on an unmigrated DB (42703)", async () => {
    const { db } = makeDb({
      tables: { workflows: [templateRow()] },
      visibilityMissing: true,
    });
    expect(await setTemplateVisibility(db, OWNER, "t1", "firm", ORG)).toBe(
      "unsupported",
    );
  });

  it("an audit failure is non-fatal", async () => {
    insertDeletionAudit.mockRejectedValue(new Error("audit table missing"));
    const { db } = makeDb({ tables: { workflows: [templateRow()] } });
    const result = await setTemplateVisibility(db, OWNER, "t1", "firm", ORG);
    expect(result).toMatchObject({ id: "t1", visibility: "firm" });
  });
});

// ── adminRevertTemplate ──────────────────────────────────────────────────────

describe("adminRevertTemplate", () => {
  it("reverts a firm template in the admin's own org and audits firm_reverted", async () => {
    const { db, tables } = makeDb({
      tables: {
        workflows: [templateRow({ visibility: "firm", organisation_id: ORG })],
      },
    });
    expect(await adminRevertTemplate(db, "admin-user", ORG, "t1")).toBe(
      "reverted",
    );
    expect(tables.workflows[0]).toMatchObject({
      visibility: "private",
      organisation_id: null,
    });
    expect(insertDeletionAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        organisationId: ORG,
        actorUserId: "admin-user",
        action: "firm_reverted",
        resourceType: "workflow",
        resourceId: "t1",
      }),
    );
  });

  it("cannot revert a template belonging to another org", async () => {
    const { db, tables } = makeDb({
      tables: {
        workflows: [
          templateRow({ visibility: "firm", organisation_id: OTHER_ORG }),
        ],
      },
    });
    expect(await adminRevertTemplate(db, "admin-user", ORG, "t1")).toBe(
      "not_found",
    );
    expect(tables.workflows[0]).toMatchObject({
      visibility: "firm",
      organisation_id: OTHER_ORG,
    });
  });

  it("returns not_found for an already-private template", async () => {
    const { db } = makeDb({ tables: { workflows: [templateRow()] } });
    expect(await adminRevertTemplate(db, "admin-user", ORG, "t1")).toBe(
      "not_found",
    );
  });

  it("degrades to not_found on an unmigrated DB (42703)", async () => {
    const { db } = makeDb({
      tables: { workflows: [templateRow()] },
      visibilityMissing: true,
    });
    expect(await adminRevertTemplate(db, "admin-user", ORG, "t1")).toBe(
      "not_found",
    );
  });
});

// ── listFirmTemplatesForAdmin ────────────────────────────────────────────────

describe("listFirmTemplatesForAdmin", () => {
  it("lists the org's firm templates with owner names, excluding tombstoned and system rows", async () => {
    const { db } = makeDb({
      tables: {
        workflows: [
          templateRow({ visibility: "firm", organisation_id: ORG }),
          templateRow({
            id: "t2",
            user_id: OTHER,
            visibility: "firm",
            organisation_id: OTHER_ORG,
          }),
          templateRow({
            id: "t3",
            visibility: "firm",
            organisation_id: ORG,
            deleted_at: "2026-08-01T00:00:00Z",
          }),
          templateRow({
            id: "t4",
            visibility: "firm",
            organisation_id: ORG,
            is_system: true,
          }),
        ],
        user_profiles: [{ user_id: OWNER, display_name: "Alex Owner" }],
      },
    });
    const templates = await listFirmTemplatesForAdmin(db, ORG);
    expect(templates.map((t) => t.id)).toEqual(["t1"]);
    expect(templates[0]).toMatchObject({
      visibility: "firm",
      ownerUserId: OWNER,
      ownerDisplayName: "Alex Owner",
    });
  });

  it("returns an empty list on an unmigrated DB (42703)", async () => {
    const { db } = makeDb({
      tables: { workflows: [templateRow()] },
      visibilityMissing: true,
    });
    expect(await listFirmTemplatesForAdmin(db, ORG)).toEqual([]);
  });
});
