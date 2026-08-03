// Test-only in-memory stand-in for the `user_clio_connections` table. Backs the
// select / upsert / update / delete chains the connector lib uses so the real
// ordering, encryption and rotation logic run for real. `missing` makes every
// terminal error with a Postgres "unmigrated" code so the degradation paths can
// be exercised. Kept as plain TS (no vitest deps) so it can be imported by any
// Clio test file.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FakeClioRow {
  id: string;
  user_id: string;
  product: string;
  encrypted_access_token: string | null;
  access_token_iv: string | null;
  access_token_tag: string | null;
  encrypted_refresh_token: string | null;
  refresh_token_iv: string | null;
  refresh_token_tag: string | null;
  token_expires_at: string | null;
  scope: string | null;
  clio_user_id: string | null;
  clio_user_name: string | null;
  updated_at?: string;
  [key: string]: unknown;
}

export interface FakeClioDb {
  from(table: string): any;
  rows(): FakeClioRow[];
}

export function makeClioDb(
  opts: { seed?: FakeClioRow[]; missing?: "42P01" | "42703" | false } = {},
): FakeClioDb {
  const store: FakeClioRow[] = (opts.seed ?? []).map((r) => ({ ...r }));
  let idSeq = store.length;
  const err = opts.missing
    ? { code: opts.missing, message: "unmigrated" }
    : null;

  const clone = (r: FakeClioRow) => ({ ...r });

  function builder() {
    const state: {
      op: "select" | "upsert" | "update" | "delete" | null;
      filters: Array<{ col: string; val: unknown }>;
      payload: Record<string, unknown> | null;
    } = { op: null, filters: [], payload: null };

    const matches = (r: FakeClioRow) =>
      state.filters.every(
        (f) => (r as Record<string, unknown>)[f.col] === f.val,
      );

    function exec(): { data: unknown; error: unknown } {
      if (err) return { data: null, error: err };
      if (state.op === "select") {
        return { data: store.filter(matches).map(clone), error: null };
      }
      if (state.op === "delete") {
        for (let i = store.length - 1; i >= 0; i -= 1) {
          if (matches(store[i])) store.splice(i, 1);
        }
        return { data: null, error: null };
      }
      if (state.op === "update") {
        const hit = store.filter(matches);
        for (const r of hit) Object.assign(r, state.payload);
        return { data: hit.map(clone), error: null };
      }
      if (state.op === "upsert") {
        const row = state.payload as FakeClioRow;
        const existing = store.find(
          (r) => r.user_id === row.user_id && r.product === row.product,
        );
        if (existing) Object.assign(existing, row);
        else {
          idSeq += 1;
          store.push({ ...row, id: `clio-${idSeq}` });
        }
        const saved = store.find(
          (r) => r.user_id === row.user_id && r.product === row.product,
        );
        return { data: saved ? clone(saved) : null, error: null };
      }
      return { data: null, error: null };
    }

    const api: any = {
      select(_cols?: string) {
        if (!state.op) state.op = "select";
        return api;
      },
      eq(col: string, val: unknown) {
        state.filters.push({ col, val });
        return api;
      },
      upsert(payload: Record<string, unknown>) {
        state.op = "upsert";
        state.payload = payload;
        return api;
      },
      update(payload: Record<string, unknown>) {
        state.op = "update";
        state.payload = payload;
        return api;
      },
      delete() {
        state.op = "delete";
        return api;
      },
      maybeSingle() {
        const r = exec();
        if (r.error) return Promise.resolve({ data: null, error: r.error });
        const arr = r.data as unknown[];
        return Promise.resolve({
          data: arr.length ? arr[0] : null,
          error: null,
        });
      },
      single() {
        const r = exec();
        if (r.error) return Promise.resolve({ data: null, error: r.error });
        const arr = Array.isArray(r.data)
          ? (r.data as unknown[])
          : r.data
            ? [r.data]
            : [];
        return Promise.resolve({
          data: arr[0] ?? null,
          error: arr.length ? null : { code: "PGRST116" },
        });
      },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
        return Promise.resolve(exec()).then(res, rej);
      },
    };
    return api;
  }

  return {
    from(_table: string) {
      return builder();
    },
    rows: () => store.map(clone),
  };
}
