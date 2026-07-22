import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assignDefaultOrganisation,
  isAdmin,
  resolveUserOrganisation,
} from "./organisations";

const DEFAULT_ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";

type OrgRow = {
  id: string;
  name: string;
  allow_member_api_keys: boolean | null;
  allow_member_mcp_connectors: boolean | null;
};
type Profile = { organisation_id: string | null; role: string | null };
type ProfileStore = Record<string, Profile>;
type OrgStore = Record<string, OrgRow>;

const ERR_42703 = {
  code: "42703",
  message: 'column user_profiles.organisation_id does not exist',
};

// Minimal stand-in for the Supabase query builder used by organisations.ts:
// the join select, the lightweight isAdmin select, and the guarded
// update().eq().is() default-org assignment — backed by an in-memory store so
// the resolution and idempotency logic run for real. `missingColumns` makes
// every call error with Postgres 42703 (unmigrated database).
function makeDb(
  profiles: ProfileStore,
  orgs: OrgStore,
  opts: { missingColumns?: boolean } = {},
) {
  return {
    from(_table: string) {
      return {
        select(sel: string) {
          return {
            eq(_col: string, userId: string) {
              return {
                maybeSingle() {
                  if (opts.missingColumns) {
                    return Promise.resolve({ data: null, error: ERR_42703 });
                  }
                  const p = profiles[userId] ?? null;
                  if (!p) return Promise.resolve({ data: null, error: null });
                  if (sel.includes("organisation:organisations")) {
                    const org = p.organisation_id
                      ? (orgs[p.organisation_id] ?? null)
                      : null;
                    return Promise.resolve({
                      data: {
                        organisation_id: p.organisation_id,
                        role: p.role,
                        organisation: org,
                      },
                      error: null,
                    });
                  }
                  return Promise.resolve({
                    data: {
                      organisation_id: p.organisation_id,
                      role: p.role,
                    },
                    error: null,
                  });
                },
              };
            },
          };
        },
        update(patch: { organisation_id: string; role: string }) {
          return {
            eq(_col: string, userId: string) {
              return {
                is(_c: string, _v: null) {
                  if (opts.missingColumns) {
                    return Promise.resolve({ error: ERR_42703 });
                  }
                  const p = profiles[userId];
                  // Predicate guard: only claim orgless rows.
                  if (p && p.organisation_id === null) {
                    p.organisation_id = patch.organisation_id;
                    p.role = patch.role;
                  }
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

const ARIA: OrgRow = {
  id: DEFAULT_ORG,
  name: "Aria Grace Law CIC",
  allow_member_api_keys: true,
  allow_member_mcp_connectors: false,
};

beforeEach(() => {
  vi.stubEnv("DEFAULT_ORGANISATION_ID", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveUserOrganisation", () => {
  it("resolves a member's firm, role and policy flags in one join", async () => {
    const profiles: ProfileStore = {
      u1: { organisation_id: DEFAULT_ORG, role: "member" },
    };
    const membership = await resolveUserOrganisation(
      makeDb(profiles, { [DEFAULT_ORG]: ARIA }),
      "u1",
    );
    expect(membership).toEqual({
      id: DEFAULT_ORG,
      name: "Aria Grace Law CIC",
      role: "member",
      policies: { memberApiKeys: true, memberMcpConnectors: false },
    });
  });

  it("reports role 'admin' for an admin member", async () => {
    const profiles: ProfileStore = {
      u1: { organisation_id: DEFAULT_ORG, role: "admin" },
    };
    const membership = await resolveUserOrganisation(
      makeDb(profiles, { [DEFAULT_ORG]: ARIA }),
      "u1",
    );
    expect(membership?.role).toBe("admin");
  });

  it("coerces null/unknown policy flags to false", async () => {
    const profiles: ProfileStore = {
      u1: { organisation_id: OTHER_ORG, role: "member" },
    };
    const org: OrgRow = {
      id: OTHER_ORG,
      name: "Solo Firm",
      allow_member_api_keys: null,
      allow_member_mcp_connectors: null,
    };
    const membership = await resolveUserOrganisation(
      makeDb(profiles, { [OTHER_ORG]: org }),
      "u1",
    );
    expect(membership?.policies).toEqual({
      memberApiKeys: false,
      memberMcpConnectors: false,
    });
  });

  it("returns null for an orgless user when no default org is configured", async () => {
    const profiles: ProfileStore = {
      u1: { organisation_id: null, role: "member" },
    };
    const membership = await resolveUserOrganisation(makeDb(profiles, {}), "u1");
    expect(membership).toBeNull();
    // No default configured → the profile must stay orgless (no write).
    expect(profiles.u1.organisation_id).toBeNull();
  });

  it("degrades to null on an unmigrated database (Postgres 42703)", async () => {
    const membership = await resolveUserOrganisation(
      makeDb({ u1: { organisation_id: null, role: null } }, {}, {
        missingColumns: true,
      }),
      "u1",
    );
    expect(membership).toBeNull();
  });
});

describe("resolveUserOrganisation — default-org assignment", () => {
  it("assigns an orgless user to the default org (as member) then resolves it", async () => {
    vi.stubEnv("DEFAULT_ORGANISATION_ID", DEFAULT_ORG);
    const profiles: ProfileStore = {
      u1: { organisation_id: null, role: "member" },
    };
    const membership = await resolveUserOrganisation(
      makeDb(profiles, { [DEFAULT_ORG]: ARIA }),
      "u1",
    );
    expect(membership?.id).toBe(DEFAULT_ORG);
    expect(membership?.role).toBe("member");
    // The write actually happened.
    expect(profiles.u1.organisation_id).toBe(DEFAULT_ORG);
  });

  it("is idempotent and never stomps an existing membership/role", async () => {
    vi.stubEnv("DEFAULT_ORGANISATION_ID", DEFAULT_ORG);
    const profiles: ProfileStore = {
      u1: { organisation_id: null, role: "member" },
    };
    const db = makeDb(profiles, { [DEFAULT_ORG]: ARIA });

    // First load assigns.
    await resolveUserOrganisation(db, "u1");
    // Simulate a later admin promotion of the same user.
    profiles.u1.role = "admin";
    // Second load must NOT re-assign or reset the role (predicate guard).
    const again = await resolveUserOrganisation(db, "u1");
    expect(again?.role).toBe("admin");
    expect(profiles.u1.organisation_id).toBe(DEFAULT_ORG);
  });

  it("does not touch a user who already belongs to another firm", async () => {
    vi.stubEnv("DEFAULT_ORGANISATION_ID", DEFAULT_ORG);
    const other: OrgRow = {
      id: OTHER_ORG,
      name: "Other LLP",
      allow_member_api_keys: false,
      allow_member_mcp_connectors: true,
    };
    const profiles: ProfileStore = {
      u1: { organisation_id: OTHER_ORG, role: "admin" },
    };
    const membership = await resolveUserOrganisation(
      makeDb(profiles, { [OTHER_ORG]: other, [DEFAULT_ORG]: ARIA }),
      "u1",
    );
    expect(membership?.id).toBe(OTHER_ORG);
    expect(membership?.role).toBe("admin");
  });
});

describe("assignDefaultOrganisation", () => {
  it("no-ops (returns null) when DEFAULT_ORGANISATION_ID is unset", async () => {
    const profiles: ProfileStore = {
      u1: { organisation_id: null, role: "member" },
    };
    const result = await assignDefaultOrganisation(makeDb(profiles, {}), "u1");
    expect(result).toBeNull();
    expect(profiles.u1.organisation_id).toBeNull();
  });

  it("tolerates an unmigrated database (42703 → null, no throw)", async () => {
    vi.stubEnv("DEFAULT_ORGANISATION_ID", DEFAULT_ORG);
    const result = await assignDefaultOrganisation(
      makeDb({ u1: { organisation_id: null, role: null } }, {}, {
        missingColumns: true,
      }),
      "u1",
    );
    expect(result).toBeNull();
  });
});

describe("isAdmin", () => {
  it("is true for an organisation admin", async () => {
    const profiles: ProfileStore = {
      u1: { organisation_id: DEFAULT_ORG, role: "admin" },
    };
    expect(await isAdmin(makeDb(profiles, {}), "u1")).toBe(true);
  });

  it("is false for a member", async () => {
    const profiles: ProfileStore = {
      u1: { organisation_id: DEFAULT_ORG, role: "member" },
    };
    expect(await isAdmin(makeDb(profiles, {}), "u1")).toBe(false);
  });

  it("is false for an orgless user even if their role reads 'admin'", async () => {
    const profiles: ProfileStore = {
      u1: { organisation_id: null, role: "admin" },
    };
    expect(await isAdmin(makeDb(profiles, {}), "u1")).toBe(false);
  });

  it("is false on an unmigrated database (42703)", async () => {
    expect(
      await isAdmin(
        makeDb({ u1: { organisation_id: null, role: null } }, {}, {
          missingColumns: true,
        }),
        "u1",
      ),
    ).toBe(false);
  });

  it("does not assign a default org as a side effect", async () => {
    vi.stubEnv("DEFAULT_ORGANISATION_ID", DEFAULT_ORG);
    const profiles: ProfileStore = {
      u1: { organisation_id: null, role: "member" },
    };
    await isAdmin(makeDb(profiles, {}), "u1");
    // isAdmin is a read — it must never write a membership.
    expect(profiles.u1.organisation_id).toBeNull();
  });
});
