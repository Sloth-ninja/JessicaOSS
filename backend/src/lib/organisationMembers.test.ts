import { describe, expect, it } from "vitest";
import {
  getUserOrganisationId,
  listOrganisationMembers,
  setMemberRole,
} from "./organisations";

const ORG = "org-1";
const OTHER_ORG = "org-2";

type Profile = {
  user_id: string;
  organisation_id: string | null;
  role: string;
  display_name: string | null;
  created_at: string | null;
};

// Chainable stand-in for the Supabase builder used by the member-management
// helpers: select().eq()…(await | maybeSingle) and
// update().eq()….select(). Backed by a shared `profiles` array so role writes
// are observable. auth.admin.listUsers supplies emails.
function makeDb(
  profiles: Profile[],
  authUsers: Array<{ id: string; email: string | null }> = [],
) {
  const matches = (p: Profile, filters: Array<[string, unknown]>) =>
    filters.every(
      ([col, val]) => (p as unknown as Record<string, unknown>)[col] === val,
    );

  function selectBuilder() {
    const filters: Array<[string, unknown]> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return b;
      },
      rows() {
        return profiles.filter((p) => matches(p, filters));
      },
      maybeSingle() {
        return Promise.resolve({ data: b.rows()[0] ?? null, error: null });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then(resolve: any, reject: any) {
        return Promise.resolve({ data: b.rows(), error: null }).then(
          resolve,
          reject,
        );
      },
    };
    return b;
  }

  function updateBuilder(patch: Partial<Profile>) {
    const filters: Array<[string, unknown]> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return b;
      },
      select() {
        const affected = profiles.filter((p) => matches(p, filters));
        for (const p of affected) Object.assign(p, patch);
        return Promise.resolve({
          data: affected.map((p) => ({ ...p })),
          error: null,
        });
      },
    };
    return b;
  }

  return {
    from() {
      return {
        select() {
          return selectBuilder();
        },
        update(patch: Partial<Profile>) {
          return updateBuilder(patch);
        },
      };
    },
    auth: {
      admin: {
        listUsers: () =>
          Promise.resolve({ data: { users: authUsers }, error: null }),
        getUserById: (id: string) => {
          const user = authUsers.find((u) => u.id === id) ?? null;
          return Promise.resolve({ data: { user }, error: null });
        },
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function profile(overrides: Partial<Profile> & { user_id: string }): Profile {
  return {
    organisation_id: ORG,
    role: "member",
    display_name: null,
    created_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("getUserOrganisationId", () => {
  it("returns the caller's organisation id", async () => {
    const db = makeDb([profile({ user_id: "u1", organisation_id: ORG })]);
    expect(await getUserOrganisationId(db, "u1")).toBe(ORG);
  });

  it("returns null for an orgless user", async () => {
    const db = makeDb([profile({ user_id: "u1", organisation_id: null })]);
    expect(await getUserOrganisationId(db, "u1")).toBeNull();
  });

  it("returns null when the profile is absent", async () => {
    expect(await getUserOrganisationId(makeDb([]), "ghost")).toBeNull();
  });
});

describe("listOrganisationMembers", () => {
  it("lists members with joined emails and normalised roles", async () => {
    const db = makeDb(
      [
        profile({
          user_id: "u1",
          role: "admin",
          display_name: "A. Solicitor",
        }),
        profile({ user_id: "u2", role: "member", display_name: "R. Associate" }),
      ],
      [
        { id: "u1", email: "a@firm.example" },
        { id: "u2", email: "r@firm.example" },
      ],
    );
    const members = await listOrganisationMembers(db, ORG);
    expect(members).toHaveLength(2);
    expect(members[0]).toMatchObject({
      userId: "u1",
      email: "a@firm.example",
      role: "admin",
    });
    expect(members[1]).toMatchObject({ userId: "u2", role: "member" });
  });

  it("reports a null email when auth has no match", async () => {
    const db = makeDb([profile({ user_id: "u1" })], []);
    const members = await listOrganisationMembers(db, ORG);
    expect(members[0].email).toBeNull();
  });
});

describe("setMemberRole", () => {
  it("promotes a member to admin and returns the member with email", async () => {
    const profiles = [
      profile({ user_id: "admin1", role: "admin" }),
      profile({ user_id: "u2", role: "member" }),
    ];
    const result = await setMemberRole(
      makeDb(profiles, [{ id: "u2", email: "u2@firm.example" }]),
      {
        organisationId: ORG,
        targetUserId: "u2",
        role: "admin",
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.member.role).toBe("admin");
      expect(result.member.email).toBe("u2@firm.example");
    }
    expect(profiles.find((p) => p.user_id === "u2")?.role).toBe("admin");
  });

  it("demotes an admin when another admin remains", async () => {
    const profiles = [
      profile({ user_id: "admin1", role: "admin" }),
      profile({ user_id: "admin2", role: "admin" }),
    ];
    const result = await setMemberRole(makeDb(profiles), {
      organisationId: ORG,
      targetUserId: "admin2",
      role: "member",
    });
    expect(result.ok).toBe(true);
    expect(profiles.find((p) => p.user_id === "admin2")?.role).toBe("member");
  });

  it("refuses to demote the last admin (reason last_admin)", async () => {
    const profiles = [
      profile({ user_id: "admin1", role: "admin" }),
      profile({ user_id: "u2", role: "member" }),
    ];
    const result = await setMemberRole(makeDb(profiles), {
      organisationId: ORG,
      targetUserId: "admin1",
      role: "member",
    });
    expect(result).toEqual({ ok: false, reason: "last_admin" });
    // The admin's role must be untouched.
    expect(profiles.find((p) => p.user_id === "admin1")?.role).toBe("admin");
  });

  it("refuses to touch a member of another firm (reason not_found)", async () => {
    const profiles = [
      profile({ user_id: "admin1", role: "admin", organisation_id: ORG }),
      profile({
        user_id: "outsider",
        role: "member",
        organisation_id: OTHER_ORG,
      }),
    ];
    const result = await setMemberRole(makeDb(profiles), {
      organisationId: ORG,
      targetUserId: "outsider",
      role: "admin",
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    // The other firm's member is unchanged.
    expect(profiles.find((p) => p.user_id === "outsider")?.role).toBe("member");
  });

  it("returns not_found for an unknown target", async () => {
    const result = await setMemberRole(
      makeDb([profile({ user_id: "admin1", role: "admin" })]),
      { organisationId: ORG, targetUserId: "ghost", role: "member" },
    );
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});
