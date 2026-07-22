import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getUserApiKeyStatus,
  getUserApiKeys,
  saveUserApiKey,
} from "./userApiKeys";
import { encryptApiKey } from "./apiKeyCrypto";

const USER = "user-1";
const ORG = "org-1";

type Row = {
  user_id: string;
  provider: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  updated_at?: string;
};

type OrgRow = {
  organisation_id: string;
  provider: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
};

function orgKey(provider: string, value: string): OrgRow {
  return { organisation_id: ORG, provider, ...encryptApiKey(value) };
}

// Table-aware stand-in for the Supabase query builder. Covers the exact chains
// userApiKeys.ts now drives across three tables:
//   - user_profiles          → organisation_id lookup (firm precedence layer)
//   - organisation_api_keys  → firm-shared keys
//   - user_api_keys          → the user's own keys (select/upsert/delete)
// `orgId` null models an orgless user (no firm layer).
function makeDb(opts: {
  userKeys?: Row[];
  orgKeys?: OrgRow[];
  orgId?: string | null;
  orgKeysError?: boolean;
  // Firm policy (WS8 PR B). Defaults ON (personal keys allowed) so the existing
  // precedence tests are unchanged. `orgContextError` makes the user_profiles
  // (org/policy) lookup fail, to exercise the deliberate policy fail-open.
  allowMemberApiKeys?: boolean;
  orgContextError?: boolean;
}) {
  const userKeys = opts.userKeys ?? [];
  const orgKeys = opts.orgKeys ?? [];
  const orgId = opts.orgId ?? null;
  const allowMemberApiKeys = opts.allowMemberApiKeys ?? true;

  return {
    from(table: string) {
      if (table === "user_profiles") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle() {
                    if (opts.orgContextError) {
                      return Promise.resolve({
                        data: null,
                        error: {
                          code: "XX000",
                          message: "user_profiles read failed",
                        },
                      });
                    }
                    return Promise.resolve({
                      data: {
                        organisation_id: orgId,
                        organisation: orgId
                          ? { allow_member_api_keys: allowMemberApiKeys }
                          : null,
                      },
                      error: null,
                    });
                  },
                };
              },
            };
          },
        };
      }

      if (table === "organisation_api_keys") {
        return {
          select() {
            return {
              eq(_col: string, organisationId: string) {
                if (opts.orgKeysError) {
                  return Promise.resolve({
                    data: null,
                    error: {
                      code: "XX000",
                      message: "organisation_api_keys read failed",
                    },
                  });
                }
                return Promise.resolve({
                  data: orgKeys.filter(
                    (r) => r.organisation_id === organisationId,
                  ),
                  error: null,
                });
              },
            };
          },
        };
      }

      // user_api_keys
      return {
        select() {
          return {
            eq(_col: string, userId: string) {
              return Promise.resolve({
                data: userKeys.filter((r) => r.user_id === userId),
                error: null,
              });
            },
          };
        },
        upsert(row: Row) {
          const i = userKeys.findIndex(
            (r) => r.user_id === row.user_id && r.provider === row.provider,
          );
          if (i >= 0) userKeys[i] = row;
          else userKeys.push(row);
          return Promise.resolve({ error: null });
        },
        delete() {
          return {
            eq(_c1: string, userId: string) {
              return {
                eq(_c2: string, provider: string) {
                  const i = userKeys.findIndex(
                    (r) => r.user_id === userId && r.provider === provider,
                  );
                  if (i >= 0) userKeys.splice(i, 1);
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

describe("userApiKeys precedence (user > firm > env)", () => {
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

  describe("getUserApiKeys — orgless (user > env, unchanged)", () => {
    it("prefers the user's decrypted key over the env key for every provider", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "env-claude");
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const db = makeDb({ orgId: null });

      await saveUserApiKey(USER, "claude", "user-claude", db);
      await saveUserApiKey(USER, "companies_house", "user-ch", db);

      const keys = await getUserApiKeys(USER, db);
      expect(keys.claude).toBe("user-claude");
      expect(keys.companies_house).toBe("user-ch");
    });

    it("falls back to the env key when the user has no key", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const keys = await getUserApiKeys(USER, makeDb({ orgId: null }));
      expect(keys.companies_house).toBe("env-ch");
    });

    it("reverts to the env key after the user's key is removed", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const db = makeDb({ orgId: null });

      await saveUserApiKey(USER, "companies_house", "user-ch", db);
      expect((await getUserApiKeys(USER, db)).companies_house).toBe("user-ch");

      await saveUserApiKey(USER, "companies_house", null, db);
      expect((await getUserApiKeys(USER, db)).companies_house).toBe("env-ch");
    });

    it("returns null when neither a user key nor an env key exists", async () => {
      const keys = await getUserApiKeys(USER, makeDb({ orgId: null }));
      expect(keys.companies_house).toBeNull();
      expect(keys.claude).toBeNull();
    });

    it("keeps the env key as fallback when a stored key fails to decrypt", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      // A row that cannot be decrypted with the current secret (garbage bytes).
      const db = makeDb({
        orgId: null,
        userKeys: [
          {
            user_id: USER,
            provider: "companies_house",
            encrypted_key: "not-real",
            iv: "AAAAAAAAAAAAAAAA",
            auth_tag: "AAAAAAAAAAAAAAAAAAAAAA==",
          },
        ],
      });
      const keys = await getUserApiKeys(USER, db);
      expect(keys.companies_house).toBe("env-ch");
    });
  });

  describe("getUserApiKeys — firm layer (user > firm > env)", () => {
    it("uses the firm key when the user has none, over the env fallback", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const db = makeDb({
        orgId: ORG,
        orgKeys: [orgKey("companies_house", "firm-ch")],
      });
      const keys = await getUserApiKeys(USER, db);
      expect(keys.companies_house).toBe("firm-ch");
    });

    it("lets the user's own key override the firm key", async () => {
      const db = makeDb({
        orgId: ORG,
        orgKeys: [orgKey("claude", "firm-claude")],
      });
      await saveUserApiKey(USER, "claude", "user-claude", db);
      const keys = await getUserApiKeys(USER, db);
      expect(keys.claude).toBe("user-claude");
    });

    it("uses the firm key with no env key set at all", async () => {
      const db = makeDb({
        orgId: ORG,
        orgKeys: [orgKey("openai", "firm-openai")],
      });
      const keys = await getUserApiKeys(USER, db);
      expect(keys.openai).toBe("firm-openai");
    });

    it("does not apply a firm key from another provider", async () => {
      const db = makeDb({
        orgId: ORG,
        orgKeys: [orgKey("openai", "firm-openai")],
      });
      const keys = await getUserApiKeys(USER, db);
      expect(keys.gemini).toBeNull();
    });

    it("degrades to user/env keys when the firm-keys read fails", async () => {
      // A transient organisation_api_keys read error must never break chat key
      // resolution for a whole firm — the firm layer is skipped, env still wins.
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const db = makeDb({ orgId: ORG, orgKeysError: true });
      await saveUserApiKey(USER, "claude", "user-claude", db);

      const keys = await getUserApiKeys(USER, db);
      expect(keys.companies_house).toBe("env-ch"); // env fallback intact
      expect(keys.claude).toBe("user-claude"); // personal key intact
    });
  });

  describe("firm policy off — personal keys are inert (WS8 PR B)", () => {
    it("getUserApiKeys skips the personal key and uses the firm key", async () => {
      const db = makeDb({
        orgId: ORG,
        allowMemberApiKeys: false,
        orgKeys: [orgKey("claude", "firm-claude")],
      });
      await saveUserApiKey(USER, "claude", "user-claude", db);
      const keys = await getUserApiKeys(USER, db);
      // Policy off ⇒ firm > env; the saved personal key does not apply.
      expect(keys.claude).toBe("firm-claude");
    });

    it("getUserApiKeys falls back to env (not the personal key) with no firm key", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const db = makeDb({ orgId: ORG, allowMemberApiKeys: false });
      await saveUserApiKey(USER, "companies_house", "user-ch", db);
      const keys = await getUserApiKeys(USER, db);
      expect(keys.companies_house).toBe("env-ch");
    });

    it("getUserApiKeyStatus never reports source 'user' and lists the key as inert", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const db = makeDb({
        orgId: ORG,
        allowMemberApiKeys: false,
        orgKeys: [orgKey("companies_house", "firm-ch")],
      });
      await saveUserApiKey(USER, "companies_house", "user-ch", db);
      const status = await getUserApiKeyStatus(USER, db);
      expect(status.companies_house).toBe(true);
      expect(status.sources.companies_house).toBe("firm");
      expect(status.inertPersonalKeys).toEqual(["companies_house"]);
    });

    it("getUserApiKeyStatus reports source 'env' + inert when only env backs it", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const db = makeDb({ orgId: ORG, allowMemberApiKeys: false });
      await saveUserApiKey(USER, "companies_house", "user-ch", db);
      const status = await getUserApiKeyStatus(USER, db);
      expect(status.sources.companies_house).toBe("env");
      expect(status.inertPersonalKeys).toEqual(["companies_house"]);
    });

    it("no inertPersonalKeys field when the member has no personal key", async () => {
      const db = makeDb({ orgId: ORG, allowMemberApiKeys: false });
      const status = await getUserApiKeyStatus(USER, db);
      expect(status.inertPersonalKeys).toBeUndefined();
    });

    it("fail-open: when the org/policy lookup errors, the personal key still applies", async () => {
      // A transient user_profiles (org/policy) read failure must not strand a
      // member without their own key — availability first.
      const db = makeDb({ orgId: ORG, orgContextError: true });
      await saveUserApiKey(USER, "claude", "user-claude", db);
      const keys = await getUserApiKeys(USER, db);
      expect(keys.claude).toBe("user-claude");

      const status = await getUserApiKeyStatus(USER, db);
      expect(status.sources.claude).toBe("user");
      expect(status.inertPersonalKeys).toBeUndefined();
    });
  });

  describe("getUserApiKeyStatus — sources reflect the winning layer", () => {
    it("reports source 'user' when a user key exists, even with firm + env set", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const db = makeDb({
        orgId: ORG,
        orgKeys: [orgKey("companies_house", "firm-ch")],
      });
      await saveUserApiKey(USER, "companies_house", "user-ch", db);

      const status = await getUserApiKeyStatus(USER, db);
      expect(status.companies_house).toBe(true);
      expect(status.sources.companies_house).toBe("user");
    });

    it("reports source 'firm' when a firm key exists and the user has none", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const db = makeDb({
        orgId: ORG,
        orgKeys: [orgKey("companies_house", "firm-ch")],
      });
      const status = await getUserApiKeyStatus(USER, db);
      expect(status.companies_house).toBe(true);
      expect(status.sources.companies_house).toBe("firm");
    });

    it("reports source 'env' for an org member with an env key but no firm key", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const status = await getUserApiKeyStatus(
        USER,
        makeDb({ orgId: ORG, orgKeys: [] }),
      );
      expect(status.companies_house).toBe(true);
      expect(status.sources.companies_house).toBe("env");
    });

    it("reports source 'env' for an orgless user with only an env key", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const status = await getUserApiKeyStatus(USER, makeDb({ orgId: null }));
      expect(status.sources.companies_house).toBe("env");
    });

    it("reports unconfigured (false / null) when nothing is set", async () => {
      const status = await getUserApiKeyStatus(USER, makeDb({ orgId: ORG }));
      expect(status.companies_house).toBe(false);
      expect(status.sources.companies_house).toBeNull();
    });

    it("degrades to source 'env' when the firm-keys read fails", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const status = await getUserApiKeyStatus(
        USER,
        makeDb({ orgId: ORG, orgKeysError: true }),
      );
      expect(status.companies_house).toBe(true);
      expect(status.sources.companies_house).toBe("env");
    });

    it("source is 'firm' with a firm key, 'env' without it (env fallback present)", async () => {
      vi.stubEnv("COMPANIES_HOUSE_API_KEY", "env-ch");
      const withFirm = await getUserApiKeyStatus(
        USER,
        makeDb({ orgId: ORG, orgKeys: [orgKey("companies_house", "firm-ch")] }),
      );
      expect(withFirm.sources.companies_house).toBe("firm");

      const withoutFirm = await getUserApiKeyStatus(
        USER,
        makeDb({ orgId: ORG, orgKeys: [] }),
      );
      expect(withoutFirm.sources.companies_house).toBe("env");
    });
  });
});
