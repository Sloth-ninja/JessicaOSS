import { describe, expect, it } from "vitest";
import {
    getOrganisationUsage,
    normaliseUsageDays,
    type FirmUsage,
} from "./usageStats";

const ORG = "org-1";
const OTHER_ORG = "org-2";
// Fixed "now" so every window edge is deterministic. 22 July 2026, midday UTC.
const NOW = new Date("2026-07-22T12:00:00.000Z");

// A UTC-midnight ISO for `n` whole days before NOW's calendar day (negative n
// = future). Used to place event rows precisely relative to the window edges.
function dayAt(offsetDays: number, hour = 10): string {
    const base = Date.UTC(2026, 6, 22); // 22 July 2026 00:00 UTC
    const d = new Date(base + offsetDays * 86_400_000);
    d.setUTCHours(hour);
    return d.toISOString();
}

type Profile = {
    user_id: string;
    organisation_id: string | null;
    role: string;
    display_name: string | null;
    created_at: string | null;
};
type Chat = { id: string; user_id: string; created_at: string };
type Review = {
    id: string;
    user_id: string;
    workflow_id: string | null;
    created_at: string;
};
type Doc = { id: string; user_id: string; created_at: string };
type Workflow = { id: string; title: string | null };

interface Seed {
    profiles: Profile[];
    chats?: Chat[];
    tabular_reviews?: Review[];
    documents?: Doc[];
    workflows?: Workflow[];
    authUsers?: Array<{ id: string; email: string | null }>;
}

// Chainable Supabase stand-in supporting the exact call shapes usageStats and
// listOrganisationMembers use: select().eq()(await|maybeSingle) for profiles/
// workflows, and select().in().gte()(await) for the event tables.
function makeDb(seed: Seed) {
    const tables: Record<string, Array<Record<string, unknown>>> = {
        user_profiles: seed.profiles,
        chats: seed.chats ?? [],
        tabular_reviews: seed.tabular_reviews ?? [],
        documents: seed.documents ?? [],
        workflows: seed.workflows ?? [],
    };

    function builder(table: string) {
        const eqFilters: Array<[string, unknown]> = [];
        const inFilters: Array<[string, unknown[]]> = [];
        const gteFilters: Array<[string, string]> = [];
        const rows = () =>
            tables[table].filter(
                (r) =>
                    eqFilters.every(([c, v]) => r[c] === v) &&
                    inFilters.every(([c, vs]) => vs.includes(r[c])) &&
                    gteFilters.every(
                        ([c, v]) =>
                            typeof r[c] === "string" &&
                            (r[c] as string) >= v,
                    ),
            );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const b: any = {
            eq(col: string, val: unknown) {
                eqFilters.push([col, val]);
                return b;
            },
            in(col: string, vals: unknown[]) {
                inFilters.push([col, vals]);
                return b;
            },
            gte(col: string, val: string) {
                gteFilters.push([col, val]);
                return b;
            },
            maybeSingle() {
                return Promise.resolve({ data: rows()[0] ?? null, error: null });
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            then(resolve: any, reject: any) {
                return Promise.resolve({ data: rows(), error: null }).then(
                    resolve,
                    reject,
                );
            },
        };
        return b;
    }

    return {
        from(table: string) {
            return {
                select() {
                    return builder(table);
                },
            };
        },
        auth: {
            admin: {
                listUsers: () =>
                    Promise.resolve({
                        data: { users: seed.authUsers ?? [] },
                        error: null,
                    }),
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

const run = (seed: Seed, days?: number): Promise<FirmUsage> =>
    getOrganisationUsage(makeDb(seed), ORG, { days, now: NOW });

describe("normaliseUsageDays", () => {
    it("accepts 7 and 30, defaults everything else to 7", () => {
        expect(normaliseUsageDays("30")).toBe(30);
        expect(normaliseUsageDays(7)).toBe(7);
        expect(normaliseUsageDays("14")).toBe(7);
        expect(normaliseUsageDays(undefined)).toBe(7);
        expect(normaliseUsageDays("nonsense")).toBe(7);
    });
});

describe("getOrganisationUsage — org scoping (watertight)", () => {
    it("counts only the caller firm's members; another firm's activity is EXCLUDED", async () => {
        const seed: Seed = {
            profiles: [
                profile({ user_id: "u1", organisation_id: ORG }),
                profile({ user_id: "outsider", organisation_id: OTHER_ORG }),
            ],
            chats: [
                { id: "c1", user_id: "u1", created_at: dayAt(-1) },
                // Another firm's user, same window — must never be counted.
                { id: "c2", user_id: "outsider", created_at: dayAt(-1) },
            ],
            tabular_reviews: [
                { id: "r1", user_id: "outsider", workflow_id: "w1", created_at: dayAt(-1) },
            ],
            documents: [{ id: "d1", user_id: "outsider", created_at: dayAt(-1) }],
        };
        const usage = await run(seed, 7);
        expect(usage.totals.chats).toBe(1);
        expect(usage.totals.workflowRuns).toBe(0);
        expect(usage.totals.documents).toBe(0);
        expect(usage.totals.totalMembers).toBe(1);
        expect(usage.totals.activeMembers).toBe(1);
        expect(usage.members.map((m) => m.userId)).toEqual(["u1"]);
    });
});

describe("getOrganisationUsage — uuid→text member resolution", () => {
    it("matches event rows whose TEXT user_id equals the uuid-string member id", async () => {
        const uuid = "11111111-1111-1111-1111-111111111111";
        const seed: Seed = {
            profiles: [profile({ user_id: uuid })],
            chats: [{ id: "c1", user_id: uuid, created_at: dayAt(-2) }],
        };
        const usage = await run(seed, 7);
        expect(usage.totals.chats).toBe(1);
        expect(usage.members[0].userId).toBe(uuid);
        expect(usage.members[0].chats).toBe(1);
    });
});

describe("getOrganisationUsage — totals & member rows", () => {
    it("aggregates a multi-user firm with emails and per-member counts", async () => {
        const seed: Seed = {
            profiles: [
                profile({ user_id: "u1", display_name: "A. Solicitor" }),
                profile({ user_id: "u2", display_name: "R. Associate" }),
            ],
            chats: [
                { id: "c1", user_id: "u1", created_at: dayAt(-1) },
                { id: "c2", user_id: "u1", created_at: dayAt(-2) },
                { id: "c3", user_id: "u2", created_at: dayAt(-1) },
            ],
            tabular_reviews: [
                { id: "r1", user_id: "u1", workflow_id: "w1", created_at: dayAt(-1) },
            ],
            documents: [{ id: "d1", user_id: "u2", created_at: dayAt(-1) }],
            workflows: [{ id: "w1", title: "NDA first-look review" }],
            authUsers: [
                { id: "u1", email: "a@firm.example" },
                { id: "u2", email: "r@firm.example" },
            ],
        };
        const usage = await run(seed, 7);
        expect(usage.totals).toMatchObject({
            activeMembers: 2,
            totalMembers: 2,
            chats: 3,
            workflowRuns: 1,
            documents: 1,
        });
        const u1 = usage.members.find((m) => m.userId === "u1")!;
        expect(u1).toMatchObject({
            email: "a@firm.example",
            chats: 2,
            workflowRuns: 1,
        });
        const u2 = usage.members.find((m) => m.userId === "u2")!;
        expect(u2).toMatchObject({ chats: 1, workflowRuns: 0 });
    });
});

describe("getOrganisationUsage — empty & single-member orgs", () => {
    it("empty org: zeros, empty tables, full zero-filled daily series", async () => {
        const usage = await run({ profiles: [] }, 7);
        expect(usage.totals).toEqual({
            activeMembers: 0,
            totalMembers: 0,
            chats: 0,
            workflowRuns: 0,
            documents: 0,
        });
        expect(usage.members).toEqual([]);
        expect(usage.workflows).toEqual([]);
        expect(usage.daily).toHaveLength(7);
        expect(usage.daily.every((d) => d.chats === 0)).toBe(true);
    });

    it("single member with no activity is listed with null last-active and zeros", async () => {
        const usage = await run(
            { profiles: [profile({ user_id: "solo" })] },
            7,
        );
        expect(usage.totals.totalMembers).toBe(1);
        expect(usage.totals.activeMembers).toBe(0);
        expect(usage.members).toHaveLength(1);
        expect(usage.members[0]).toMatchObject({
            userId: "solo",
            lastActive: null,
            chats: 0,
            workflowRuns: 0,
        });
    });
});

describe("getOrganisationUsage — window edges & daily bucketing", () => {
    it("7d window: today and day -6 are IN; day -7 is OUT", async () => {
        const seed: Seed = {
            profiles: [profile({ user_id: "u1" })],
            chats: [
                { id: "today", user_id: "u1", created_at: dayAt(0) },
                { id: "edge-in", user_id: "u1", created_at: dayAt(-6) },
                { id: "edge-out", user_id: "u1", created_at: dayAt(-7) },
            ],
        };
        const usage = await run(seed, 7);
        // Only the two in-window chats count toward totals.
        expect(usage.totals.chats).toBe(2);
        // Daily series spans exactly 7 days, oldest→newest, correct edges.
        expect(usage.daily).toHaveLength(7);
        expect(usage.daily[0].date).toBe("2026-07-16"); // -6
        expect(usage.daily[6].date).toBe("2026-07-22"); // today
        expect(usage.daily[0].chats).toBe(1); // edge-in on -6
        expect(usage.daily[6].chats).toBe(1); // today
        // day -7 (2026-07-15) is outside the 7-day series entirely.
        expect(usage.daily.some((d) => d.date === "2026-07-15")).toBe(false);
    });

    it("last-active reflects a beyond-window (but within 30d) event", async () => {
        const seed: Seed = {
            profiles: [profile({ user_id: "u1" })],
            // -10 days: outside the 7d totals window, inside the 30d fetch.
            chats: [{ id: "c1", user_id: "u1", created_at: dayAt(-10) }],
        };
        const usage = await run(seed, 7);
        expect(usage.totals.chats).toBe(0); // not in the 7d window
        expect(usage.members[0].chats).toBe(0);
        // But last-active still surfaces the older activity.
        expect(usage.members[0].lastActive).toBe(dayAt(-10));
    });
});

describe("getOrganisationUsage — workflow-template 7d/30d columns", () => {
    it("splits runs into 7d and 30d and records the last run; resolves titles", async () => {
        const seed: Seed = {
            profiles: [profile({ user_id: "u1" })],
            tabular_reviews: [
                { id: "r1", user_id: "u1", workflow_id: "w1", created_at: dayAt(-1) },
                { id: "r2", user_id: "u1", workflow_id: "w1", created_at: dayAt(-3) },
                // -20d: counts to 30d only, not 7d.
                { id: "r3", user_id: "u1", workflow_id: "w1", created_at: dayAt(-20) },
                // Null workflow_id: counts to totals but not the template table.
                { id: "r4", user_id: "u1", workflow_id: null, created_at: dayAt(-1) },
            ],
            workflows: [{ id: "w1", title: "Client onboarding checklist" }],
        };
        const usage = await run(seed, 7);
        // Totals workflowRuns counts only the requested (7d) window incl. the
        // null-workflow row: r1, r2, r4 = 3.
        expect(usage.totals.workflowRuns).toBe(3);
        expect(usage.workflows).toHaveLength(1);
        expect(usage.workflows[0]).toMatchObject({
            workflowId: "w1",
            title: "Client onboarding checklist",
            runs7d: 2,
            runs30d: 3,
            lastRun: dayAt(-1),
        });
    });
});

describe("getOrganisationUsage — 30d period", () => {
    it("30d window includes a -20d chat that the 7d window excludes", async () => {
        const seed: Seed = {
            profiles: [profile({ user_id: "u1" })],
            chats: [{ id: "c1", user_id: "u1", created_at: dayAt(-20) }],
        };
        const week = await run(seed, 7);
        const month = await run(seed, 30);
        expect(week.totals.chats).toBe(0);
        expect(month.totals.chats).toBe(1);
        expect(month.daily).toHaveLength(30);
        expect(month.period.days).toBe(30);
    });
});
