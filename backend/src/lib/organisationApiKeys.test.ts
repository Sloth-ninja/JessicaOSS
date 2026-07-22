import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOrganisationApiKeys,
  getOrganisationApiKeyStatus,
  saveOrganisationApiKey,
} from "./organisationApiKeys";

const ORG = "org-1";

type OrgRow = {
  organisation_id: string;
  provider: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  updated_at?: string;
};

// In-memory stand-in for the Supabase builder used by organisationApiKeys.ts:
// the select/upsert/delete chains, backed by a store so the encrypt→decrypt
// round-trip runs for real.
function makeDb(store: OrgRow[]) {
  return {
    from() {
      return {
        select() {
          return {
            eq(_col: string, organisationId: string) {
              return Promise.resolve({
                data: store.filter(
                  (r) => r.organisation_id === organisationId,
                ),
                error: null,
              });
            },
          };
        },
        upsert(row: OrgRow) {
          const i = store.findIndex(
            (r) =>
              r.organisation_id === row.organisation_id &&
              r.provider === row.provider,
          );
          if (i >= 0) store[i] = row;
          else store.push(row);
          return Promise.resolve({ error: null });
        },
        delete() {
          return {
            eq(_c1: string, organisationId: string) {
              return {
                eq(_c2: string, provider: string) {
                  const i = store.findIndex(
                    (r) =>
                      r.organisation_id === organisationId &&
                      r.provider === provider,
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

describe("organisationApiKeys", () => {
  beforeEach(() => {
    vi.stubEnv("USER_API_KEYS_ENCRYPTION_SECRET", "test-encryption-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips a saved firm key through encrypt → decrypt", async () => {
    const store: OrgRow[] = [];
    const db = makeDb(store);
    await saveOrganisationApiKey(ORG, "claude", "firm-claude", db);
    const keys = await getOrganisationApiKeys(ORG, db);
    expect(keys.claude).toBe("firm-claude");
    // Nothing plaintext at rest.
    expect(store[0].encrypted_key).not.toContain("firm-claude");
  });

  it("reports per-provider configured flags without exposing key material", async () => {
    const store: OrgRow[] = [];
    const db = makeDb(store);
    await saveOrganisationApiKey(ORG, "companies_house", "firm-ch", db);

    const status = await getOrganisationApiKeyStatus(ORG, db);
    expect(status.companies_house).toBe(true);
    expect(status.claude).toBe(false);
    // The status object is booleans only.
    expect(Object.values(status).every((v) => typeof v === "boolean")).toBe(
      true,
    );
  });

  it("deletes the firm key when saved with an empty value", async () => {
    const store: OrgRow[] = [];
    const db = makeDb(store);
    await saveOrganisationApiKey(ORG, "openai", "firm-openai", db);
    expect((await getOrganisationApiKeyStatus(ORG, db)).openai).toBe(true);

    await saveOrganisationApiKey(ORG, "openai", "", db);
    expect((await getOrganisationApiKeyStatus(ORG, db)).openai).toBe(false);
    expect(await getOrganisationApiKeys(ORG, db)).toEqual({});
  });

  it("scopes keys to the requested organisation", async () => {
    const store: OrgRow[] = [];
    const db = makeDb(store);
    await saveOrganisationApiKey(ORG, "claude", "firm-claude", db);
    const other = await getOrganisationApiKeys("org-2", db);
    expect(other.claude).toBeUndefined();
  });
});
