import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeClioDb } from "./fakeClioDb";
import {
  deleteClioConnection,
  getClioConnectionMetadata,
  getClioConnectionSummaries,
  isClioSchemaMissing,
  listConnectedProducts,
  loadClioConnection,
  persistRefreshedTokens,
  saveClioConnection,
} from "./connections";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = (db: unknown) => db as any;

// These tests perform real scrypt AES-256-GCM key derivation via
// saveClioConnection/loadClioConnection. Real KDF work under concurrent
// machine load (parallel agent suites) has blown 5s AND 20s ceilings while
// passing in isolation — that flake is contention, not a defect
// (DURABLE_LESSONS 2026-08-05), so the ceiling is deliberately generous.
vi.setConfig({ testTimeout: 120_000 });

beforeEach(() => {
  process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-clio-secret-value";
});

describe("isClioSchemaMissing", () => {
  it("is true for undefined_table / undefined_column, false otherwise", () => {
    expect(isClioSchemaMissing({ code: "42P01" })).toBe(true);
    expect(isClioSchemaMissing({ code: "42703" })).toBe(true);
    expect(isClioSchemaMissing({ code: "23505" })).toBe(false);
    expect(isClioSchemaMissing(null)).toBe(false);
  });
});

describe("save + load round-trip (encryption)", () => {
  it("encrypts on save and decrypts the same tokens on load", async () => {
    const db = makeClioDb();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await saveClioConnection(asDb(db), {
      userId: "user-1",
      product: "manage",
      tokens: {
        accessToken: "access-abc",
        refreshToken: "refresh-xyz",
        expiresAt,
        scope: null,
      },
      clioUserId: "42",
      clioUserName: "Jane Solicitor",
    });

    // The stored columns must be ciphertext, never the raw token.
    const raw = db.rows()[0];
    expect(raw.encrypted_access_token).not.toBe("access-abc");
    expect(raw.encrypted_access_token).toBeTruthy();

    const loaded = await loadClioConnection(asDb(db), "user-1", "manage");
    expect(loaded).not.toBeNull();
    expect(loaded?.tokens.accessToken).toBe("access-abc");
    expect(loaded?.tokens.refreshToken).toBe("refresh-xyz");
    expect(loaded?.clioUserName).toBe("Jane Solicitor");
    expect(loaded?.tokens.expiresAt?.toISOString()).toBe(
      expiresAt.toISOString(),
    );
  });

  it("upserts on the (user, product) key rather than duplicating", async () => {
    const db = makeClioDb();
    const base = {
      userId: "user-1",
      product: "manage" as const,
      tokens: {
        accessToken: "a1",
        refreshToken: "r1",
        expiresAt: null,
        scope: null,
      },
    };
    await saveClioConnection(asDb(db), base);
    await saveClioConnection(asDb(db), {
      ...base,
      tokens: { ...base.tokens, accessToken: "a2" },
    });
    expect(db.rows()).toHaveLength(1);
    const loaded = await loadClioConnection(asDb(db), "user-1", "manage");
    expect(loaded?.tokens.accessToken).toBe("a2");
  });
});

describe("unmigrated-database degradation", () => {
  it("loadClioConnection returns null (never throws) on 42P01", async () => {
    const db = makeClioDb({ missing: "42P01" });
    await expect(
      loadClioConnection(asDb(db), "user-1", "manage"),
    ).resolves.toBeNull();
  });
  it("listConnectedProducts returns all-false on 42703", async () => {
    const db = makeClioDb({ missing: "42703" });
    await expect(listConnectedProducts(asDb(db), "user-1")).resolves.toEqual({
      manage: false,
      grow: false,
    });
  });
  it("getClioConnectionSummaries returns all-disconnected on 42P01", async () => {
    const db = makeClioDb({ missing: "42P01" });
    const s = await getClioConnectionSummaries(asDb(db), "user-1");
    expect(s.manage.connected).toBe(false);
    expect(s.grow.connected).toBe(false);
  });
});

describe("connected-product + summary reads", () => {
  it("reflects which products have a stored access token", async () => {
    const db = makeClioDb();
    await saveClioConnection(asDb(db), {
      userId: "user-1",
      product: "manage",
      tokens: {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: null,
        scope: null,
      },
      clioUserName: "Jane",
    });
    const products = await listConnectedProducts(asDb(db), "user-1");
    expect(products).toEqual({ manage: true, grow: false });
    const summaries = await getClioConnectionSummaries(asDb(db), "user-1");
    expect(summaries.manage).toEqual({ connected: true, clioUserName: "Jane" });
    expect(summaries.grow.connected).toBe(false);
  });
});

describe("persistRefreshedTokens — rotation atomicity", () => {
  it("persists a new rotated refresh token and returns the updated connection", async () => {
    const db = makeClioDb();
    const saved = await saveClioConnection(asDb(db), {
      userId: "user-1",
      product: "grow",
      tokens: {
        accessToken: "a1",
        refreshToken: "r1",
        expiresAt: null,
        scope: null,
      },
    });
    const updated = await persistRefreshedTokens(asDb(db), saved.id, {
      accessToken: "a2",
      refreshToken: "r2-rotated",
      expiresAt: new Date(Date.now() + 3600_000),
      scope: null,
    });
    expect(updated.tokens.accessToken).toBe("a2");
    expect(updated.tokens.refreshToken).toBe("r2-rotated");
    // Read back through a fresh load to prove it committed before use.
    const reload = await loadClioConnection(asDb(db), "user-1", "grow");
    expect(reload?.tokens.refreshToken).toBe("r2-rotated");
  });

  it("throws (surfacing the error) when the update matches zero rows, leaving the old token in place", async () => {
    const db = makeClioDb();
    const saved = await saveClioConnection(asDb(db), {
      userId: "user-1",
      product: "grow",
      tokens: {
        accessToken: "a1",
        refreshToken: "r1",
        expiresAt: null,
        scope: null,
      },
    });
    await expect(
      persistRefreshedTokens(asDb(db), "does-not-exist", {
        accessToken: "a2",
        refreshToken: "r2-rotated",
        expiresAt: null,
        scope: null,
      }),
    ).rejects.toThrow();
    // The genuine row is untouched — the old refresh token is retained.
    const reload = await loadClioConnection(asDb(db), "user-1", "grow");
    expect(reload?.tokens.refreshToken).toBe("r1");
    expect(saved.tokens.refreshToken).toBe("r1");
  });
});

describe("deleteClioConnection", () => {
  it("removes the row and is a no-op on an unmigrated database", async () => {
    const db = makeClioDb();
    await saveClioConnection(asDb(db), {
      userId: "user-1",
      product: "manage",
      tokens: {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: null,
        scope: null,
      },
    });
    await deleteClioConnection(asDb(db), "user-1", "manage");
    expect(db.rows()).toHaveLength(0);

    const missingDb = makeClioDb({ missing: "42P01" });
    await expect(
      deleteClioConnection(asDb(missingDb), "user-1", "manage"),
    ).resolves.toBeUndefined();
  });
});

describe("getClioConnectionMetadata (SAR/export)", () => {
  it("returns token-free metadata, omitting encrypted/token fields even when present on the row", async () => {
    // Seed a raw row carrying encrypted token material alongside the metadata.
    const db = makeClioDb({
      seed: [
        {
          id: "row-1",
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
        },
      ],
    });

    const meta = await getClioConnectionMetadata(asDb(db), "user-1");
    expect(meta).toHaveLength(1);
    expect(meta[0]).toEqual({
      product: "manage",
      clio_user_name: "Jane Solicitor",
      clio_user_id: "99",
      scope: "grow_matter_read",
      token_expires_at: "2026-09-01T00:00:00.000Z",
      created_at: "2026-08-03T00:00:00.000Z",
      updated_at: "2026-08-03T01:00:00.000Z",
    });
    // No token material of any kind leaks through.
    const asRecord = meta[0] as unknown as Record<string, unknown>;
    for (const key of [
      "encrypted_access_token",
      "access_token_iv",
      "access_token_tag",
      "encrypted_refresh_token",
      "refresh_token_iv",
      "refresh_token_tag",
    ]) {
      expect(asRecord[key]).toBeUndefined();
    }
    expect(JSON.stringify(meta)).not.toContain("ENCRYPTED");
  });

  it.each(["42P01", "42703"] as const)(
    "returns an empty array on an unmigrated database (%s)",
    async (code) => {
      const db = makeClioDb({ missing: code });
      await expect(
        getClioConnectionMetadata(asDb(db), "user-1"),
      ).resolves.toEqual([]);
    },
  );
});
