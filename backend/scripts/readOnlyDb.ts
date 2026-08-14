// Read-only Supabase handle for operator scripts.
//
// `scripts/clio-live-probes.ts` reads a PRODUCTION connection row and hands the
// database client to shipped library code that WOULD, on some paths, write to
// it (token-refresh persistence, dead-grant pruning). This module makes "never
// writes" structural rather than a promise.
//
// The rule is an ALLOW-LIST, and deliberately so. An earlier version denied a
// list of property names (`rpc`, `schema`, `storage`, …) and was shown to be
// bypassable twice over — `db.schema("public").from(t).update(…)` returns a
// fresh, unwrapped builder, and `db.rest` is a public property holding the
// PostgrestClient itself, so `db.rest.from(t).update(…)` and `db.rest.rpc(…)`
// walked straight past it. Enumerating the ways out of a client is a game you
// lose on the next dependency bump; naming the ONE way in is not. Reading any
// property other than `from` therefore throws.
//
// Kept as its own module (rather than living in the script) so the guarantee
// can be unit-tested without importing a script that runs on import.

import type { createServerSupabase } from "../src/lib/supabase";

type Db = ReturnType<typeof createServerSupabase>;

/** A database write — or a route to one — was attempted through the proxy. */
export class ProbeWriteBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeWriteBlockedError";
  }
}

/**
 * The mutating methods on a PostgrestQueryBuilder. These are the complete set:
 * everything else `from()` offers is a read or a chainable filter, and the
 * filter builder returned by `.select()` carries no mutators at all, so it needs
 * no wrapping of its own.
 */
const BLOCKED_TABLE_METHODS = new Set(["insert", "update", "upsert", "delete"]);

function wrapTableBuilder(builder: object, table: string): object {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && BLOCKED_TABLE_METHODS.has(prop)) {
        return () => {
          throw new ProbeWriteBlockedError(
            `Blocked a ${prop.toUpperCase()} on "${table}" — this script never writes to the database.`,
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Wrap a Supabase client so that ONLY table reads survive.
 *
 * Reading any property other than `from` throws immediately — including `rest`,
 * `schema`, `rpc`, `auth` and `storage`. `from(table)` returns a builder whose
 * insert/update/upsert/delete throw.
 *
 * Symbol properties and `then` are the two deliberate exceptions, and they
 * return `undefined` rather than throwing: a proxy that throws on
 * `Symbol.toStringTag` explodes the moment anything logs or inspects it, and one
 * that returns a function for `then` looks THENABLE, so `await db` would try to
 * resolve it. Neither can reach the database, so inert is the right answer.
 */
export function readOnlyDb(db: Db): Db {
  // The proxy target is an empty object, not the client: an empty object has no
  // non-configurable own properties, so the `get` trap is free to throw for any
  // name without tripping a proxy invariant.
  return new Proxy({} as object, {
    get(_target, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      if (prop === "from") {
        return (table: string) =>
          wrapTableBuilder(
            (db as unknown as { from: (t: string) => object }).from(table),
            table,
          );
      }
      throw new ProbeWriteBlockedError(
        `Blocked access to \`${prop}\` — this script may only READ tables, through from().`,
      );
    },
  }) as unknown as Db;
}
