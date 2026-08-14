// Regression cover for the operator-script read-only rail.
//
// Every case below except the happy path is a bypass that a REVIEWER found in an
// earlier deny-list version of this proxy — `db.rest.from(t).update(…)`,
// `db.rest.rpc(…)`, `db.schema("public").from(t).update(…)`. They are committed
// as tests so the guarantee survives a refactor rather than resting on a
// one-off manual check.

import { describe, expect, it, vi } from "vitest";

import { ProbeWriteBlockedError, readOnlyDb } from "./readOnlyDb";

/**
 * A stand-in for the Supabase client, shaped like the real one where it matters:
 * `from()` returns a builder carrying both reads and writes, and the client also
 * exposes the other routes to the server (`rest`, `schema`, `rpc`, `auth`,
 * `storage`) that the proxy must refuse.
 */
function fakeClient() {
  const writes: string[] = [];
  const makeBuilder = (table: string) => ({
    select: vi.fn(() => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { table }, error: null }),
      }),
    })),
    insert: vi.fn(() => {
      writes.push(`insert:${table}`);
      return { error: null };
    }),
    update: vi.fn(() => {
      writes.push(`update:${table}`);
      return { error: null };
    }),
    upsert: vi.fn(() => {
      writes.push(`upsert:${table}`);
      return { error: null };
    }),
    delete: vi.fn(() => {
      writes.push(`delete:${table}`);
      return { error: null };
    }),
  });
  const client = {
    from: vi.fn((table: string) => makeBuilder(table)),
    rpc: vi.fn(() => {
      writes.push("rpc");
      return { error: null };
    }),
    schema: vi.fn(() => ({ from: (table: string) => makeBuilder(table) })),
    auth: { admin: {} },
    storage: { from: () => ({}) },
    functions: { invoke: vi.fn() },
    realtime: {},
  };
  // The property that defeated the deny-list: the PostgrestClient itself.
  (client as Record<string, unknown>).rest = {
    from: (table: string) => makeBuilder(table),
    rpc: () => {
      writes.push("rest.rpc");
      return { error: null };
    },
  };
  return { client, writes };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = (client: unknown) => readOnlyDb(client as any);

describe("readOnlyDb", () => {
  it("lets a table read through unchanged", async () => {
    const { client, writes } = fakeClient();
    const db = asDb(client) as unknown as {
      from: (t: string) => {
        select: (s: string) => {
          eq: (
            c: string,
            v: string,
          ) => { maybeSingle: () => Promise<{ data: { table: string } }> };
        };
      };
    };

    const result = await db
      .from("user_clio_connections")
      .select("*")
      .eq("user_id", "u1")
      .maybeSingle();

    expect(result.data).toEqual({ table: "user_clio_connections" });
    expect(client.from).toHaveBeenCalledWith("user_clio_connections");
    expect(writes).toEqual([]);
  });

  it.each(["insert", "update", "upsert", "delete"] as const)(
    "throws on a %s through from()",
    (method) => {
      const { client, writes } = fakeClient();
      const db = asDb(client) as unknown as {
        from: (t: string) => Record<string, (value: unknown) => unknown>;
      };

      expect(() => db.from("user_clio_connections")[method]({})).toThrow(
        ProbeWriteBlockedError,
      );
      expect(writes).toEqual([]);
    },
  );

  it.each([
    "rest",
    "schema",
    "rpc",
    "auth",
    "storage",
    "functions",
    "realtime",
  ])("throws on reading `%s` — the bypasses a deny-list missed", (prop) => {
    const { client, writes } = fakeClient();
    const db = asDb(client) as unknown as Record<string, unknown>;

    expect(() => db[prop]).toThrow(ProbeWriteBlockedError);
    expect(writes).toEqual([]);
  });

  it("blocks the proven db.rest.from(t).update(...) bypass", () => {
    const { client, writes } = fakeClient();
    const db = asDb(client) as unknown as {
      rest: { from: (t: string) => { update: (v: unknown) => unknown } };
    };

    expect(() => db.rest.from("user_clio_connections").update({})).toThrow(
      ProbeWriteBlockedError,
    );
    expect(writes).toEqual([]);
  });

  it("blocks the proven db.schema(...).from(t).update(...) bypass", () => {
    const { client, writes } = fakeClient();
    const db = asDb(client) as unknown as {
      schema: (s: string) => {
        from: (t: string) => { update: (v: unknown) => unknown };
      };
    };

    expect(() =>
      db.schema("public").from("user_clio_connections").update({}),
    ).toThrow(ProbeWriteBlockedError);
    expect(writes).toEqual([]);
  });

  it("stays inert for symbols and `then` instead of throwing", async () => {
    const { client } = fakeClient();
    const db = asDb(client) as unknown as Record<string | symbol, unknown>;

    // A throwing Symbol.toStringTag would explode any console.log of the handle.
    expect(() => String(db[Symbol.toStringTag])).not.toThrow();
    // A function here would make the proxy thenable, so `await db` would hang or
    // resolve to something unexpected.
    expect(db.then).toBeUndefined();
    await expect(Promise.resolve(db as unknown)).resolves.toBeDefined();
  });
});
