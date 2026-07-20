import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getUserApiKeyStatus,
  getUserApiKeys,
  saveUserApiKey,
} from "./userApiKeys";

const USER = "user-1";

type Row = {
  user_id: string;
  provider: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  updated_at?: string;
};

// Minimal stand-in for the Supabase query builder used by userApiKeys.ts:
// supports the exact select/upsert/delete chains those functions call, backed
// by an in-memory row store so the encrypt→decrypt round-trip runs for real.
function makeDb(store: Row[]) {
  return {
    from() {
      return {
        select() {
          return {
            eq(_col: string, userId: string) {
              return Promise.resolve({
                data: store.filter((r) => r.user_id === userId),
                error: null,
              });
            },
          };
        },
        upsert(row: Row) {
          const i = store.findIndex(
            (r) => r.user_id === row.user_id && r.provider === row.provider,
          );
          if (i >= 0) store[i] = row;
          else store.push(row);
          return Promise.resolve({ error: null });
        },
        delete() {
          return {
            eq(_c1: string, userId: string) {
              return {
                eq(_c2: string, provider: string) {
                  const i = store.findIndex(
                    (r) => r.user_id === userId && r.provider === provider,
                  );
                  if (i >= 0) store.splice(i, 1);
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("userApiKeys precedence (user key overrides env)", () => {
  beforeEach(() => {
    vi.stubEnv("USER_API_KEYS_ENCRYPTION_SECRET", "test-encryption-secret");
    // Start every test from a clean env; individual tests set what they need.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("COMPANIES_HOUSE_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("getUserApiKeys", () => {
    it("prefers the user's decrypted key over the env key for every provider", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-claude");
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const store: Row[] = [];
      const db = makeDb(store);

      await saveUserApiKey(USER, "claude", "user-claude", db);
      await saveUserApiKey(USER, "companies_house", "user-ch", db);

      const keys = await getUserApiKeys(USER, db);
      expect(keys.claude).toBe("user-claude");
      expect(keys.companies_house).toBe("user-ch");
    });

    it("falls back to the env key when the user has no key", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const keys = await getUserApiKeys(USER, makeDb([]));
      expect(keys.companies_house).toBe("env-ch");
    });

    it("reverts to the env key after the user's key is removed", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const store: Row[] = [];
      const db = makeDb(store);

      await saveUserApiKey(USER, "companies_house", "user-ch", db);
      expect((await getUserApiKeys(USER, db)).companies_house).toBe("user-ch");

      await saveUserApiKey(USER, "companies_house", null, db);
      expect((await getUserApiKeys(USER, db)).companies_house).toBe("env-ch");
    });

    it("returns null when neither a user key nor an env key exists", async () => {
      const keys = await getUserApiKeys(USER, makeDb([]));
      expect(keys.companies_house).toBeNull();
      expect(keys.claude).toBeNull();
    });

    it("keeps the env key as fallback when a stored key fails to decrypt", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      // A row that cannot be decrypted with the current secret (garbage bytes).
      const store: Row[] = [
        {
          user_id: USER,
          provider: "companies_house",
          encrypted_key: "not-real",
          iv: "AAAAAAAAAAAAAAAA",
          auth_tag: "AAAAAAAAAAAAAAAAAAAAAA==",
        },
      ];
      const keys = await getUserApiKeys(USER, makeDb(store));
      expect(keys.companies_house).toBe("env-ch");
    });
  });

  describe("getUserApiKeyStatus", () => {
    it("reports source 'user' when a user key exists, even if an env key is also set", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const store: Row[] = [];
      const db = makeDb(store);
      await saveUserApiKey(USER, "companies_house", "user-ch", db);

      const status = await getUserApiKeyStatus(USER, db);
      expect(status.companies_house).toBe(true);
      expect(status.sources.companies_house).toBe("user");
    });

    it("reports source 'env' when only an env key is set", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const status = await getUserApiKeyStatus(USER, makeDb([]));
      expect(status.companies_house).toBe(true);
      expect(status.sources.companies_house).toBe("env");
    });

    it("reports unconfigured (false / null) when neither is set", async () => {
      const status = await getUserApiKeyStatus(USER, makeDb([]));
      expect(status.companies_house).toBe(false);
      expect(status.sources.companies_house).toBeNull();
    });

    it("reverts source to 'env' after the user's key is removed", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const store: Row[] = [];
      const db = makeDb(store);

      await saveUserApiKey(USER, "companies_house", "user-ch", db);
      expect((await getUserApiKeyStatus(USER, db)).sources.companies_house).toBe(
        "user",
      );

      await saveUserApiKey(USER, "companies_house", null, db);
      expect((await getUserApiKeyStatus(USER, db)).sources.companies_house).toBe(
        "env",
      );
    });
  });
});
