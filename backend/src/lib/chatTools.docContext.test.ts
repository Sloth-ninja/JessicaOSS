import { describe, it, expect } from "vitest";
import { buildDocContext } from "./chatTools";

/**
 * WS8 PR G: a tombstoned single document referenced by a chat's message files
 * must NOT be reloaded into the model's doc context (where read_document /
 * edit_document would keep a "deleted" document readable and editable). These
 * tests pin the exclusion at the buildDocContext seam, plus the 42703
 * degradation path (unmigrated DB → getTombstonedIds returns empty → no
 * exclusion, i.e. today's behaviour).
 */

const TOMBSTONED_ID = "11111111-1111-1111-1111-111111111111";
const VISIBLE_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "user-1";

type ScanOutcome = "tombstone-one" | "unmigrated-42703";

// Minimal chainable fake for the two documents-table reads buildDocContext makes:
//   1. getTombstonedIds → .from("documents").select("id").not("deleted_at","is",null).in("id", ids)
//   2. the visible-docs load → .from("documents").select(...).in("id", visibleIds).eq("user_id").eq("status","ready")
// We record the ids handed to (2) so the test can assert the tombstoned id was
// filtered out before the model ever sees the document.
function makeDb(outcome: ScanOutcome, captured: { visibleIds: string[] }) {
  function makeQuery(table: string) {
    const state = { isTombstoneScan: false, inIds: [] as string[] };
    const result = () => {
      if (table !== "documents") return { data: [], error: null };
      if (state.isTombstoneScan) {
        if (outcome === "unmigrated-42703") {
          return { data: null, error: { code: "42703" } };
        }
        // Only TOMBSTONED_ID is tombstoned, intersected with the candidate ids.
        const data = state.inIds
          .filter((id) => id === TOMBSTONED_ID)
          .map((id) => ({ id }));
        return { data, error: null };
      }
      // The visible-docs load: record the ids, return no rows (so
      // attachActiveVersionPaths short-circuits and no version read is needed).
      captured.visibleIds = state.inIds;
      return { data: [], error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      is: () => q,
      not: () => {
        state.isTombstoneScan = true;
        return q;
      },
      in: (_col: string, vals: string[]) => {
        state.inIds = vals;
        return q;
      },
      order: () => q,
      limit: () => q,
      then: (resolve: (v: unknown) => void) => resolve(result()),
    };
    return q;
  }
  return { from: (table: string) => makeQuery(table) } as never;
}

const messages = [
  {
    role: "user",
    content: "look at these",
    files: [{ document_id: TOMBSTONED_ID }, { document_id: VISIBLE_ID }],
  },
] as never;

describe("buildDocContext — tombstone exclusion (WS8 PR G)", () => {
  it("excludes a tombstoned document id from the docs loaded into context", async () => {
    const captured = { visibleIds: [] as string[] };
    const { docIndex, docStore } = await buildDocContext(
      messages,
      USER_ID,
      makeDb("tombstone-one", captured),
    );

    // The tombstoned id never reached the visible-docs query.
    expect(captured.visibleIds).toContain(VISIBLE_ID);
    expect(captured.visibleIds).not.toContain(TOMBSTONED_ID);
    // Nothing tombstoned surfaced in the model-facing index/store.
    expect(Object.keys(docIndex)).toHaveLength(0);
    expect(docStore.size).toBe(0);
  });

  it("degrades to today's behaviour on an unmigrated DB (42703 → no exclusion)", async () => {
    const captured = { visibleIds: [] as string[] };
    await buildDocContext(
      messages,
      USER_ID,
      makeDb("unmigrated-42703", captured),
    );

    // getTombstonedIds returned empty → both ids are loaded as before.
    expect(captured.visibleIds).toContain(VISIBLE_ID);
    expect(captured.visibleIds).toContain(TOMBSTONED_ID);
  });
});
