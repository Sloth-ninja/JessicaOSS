import {
    describe,
    it,
    expect,
    vi,
    beforeAll,
    afterAll,
    beforeEach,
} from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OrganisationMembership } from "../lib/organisations";

// PATCH /user/profile — server-side belt for the legacy free-text
// `organisation` field (pilot-feedback fix train, PR B item 3-belt). A firm
// member's write to it must be silently dropped (other fields still land);
// an orgless caller's write must still land; a membership-lookup error must
// fail OPEN (the write still lands — availability wins for this cosmetic
// field, WS8 PR B precedent, not the deletion fail-SAFE direction).

const state = vi.hoisted(() => ({
    membership: null as OrganisationMembership | null,
    membershipThrows: false,
    row: {
        display_name: "Jane Solicitor",
        organisation: "Original Org",
        message_credits_used: 0,
        credits_reset_date: "2099-01-01T00:00:00.000Z",
        tier: "Pilot",
        title_model: null,
        tabular_model: "claude-sonnet-4-6",
        mfa_on_login: false,
    } as Record<string, unknown>,
    updateCalls: [] as Record<string, unknown>[],
}));

vi.mock("../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "caller";
        next();
    },
    // PATCH /user/profile's real gate only blocks title/tabular-model writes
    // (WS8 PR F); pass through here so we exercise the organisation-drop
    // logic in isolation (the gate itself is covered elsewhere).
    requireMemberPolicy:
        () => (_req: unknown, _res: unknown, next: () => void) => next(),
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

vi.mock("../lib/supabase", () => ({
    createServerSupabase: () => ({
        from: (_table: string) => ({
            upsert: () => Promise.resolve({ error: null }),
            update: (patch: Record<string, unknown>) => {
                state.updateCalls.push(patch);
                return { eq: () => Promise.resolve({ error: null }) };
            },
            select: () => ({
                eq: () => ({
                    maybeSingle: () =>
                        Promise.resolve({ data: state.row, error: null }),
                    single: () =>
                        Promise.resolve({ data: state.row, error: null }),
                }),
            }),
        }),
    }),
}));

// A spy (not a bare closure) so call-count assertions can pin exactly when
// the belt logic short-circuits vs. falls through to loadProfile's own
// resolve (Minor 2 fix: the earlier closure-based mock made the "does not
// resolve membership" test pass for any implementation, since nothing
// recorded whether it was actually called).
const resolveUserOrganisation = vi.fn();

vi.mock("../lib/organisations", () => ({
    resolveUserOrganisation: (...args: unknown[]) =>
        resolveUserOrganisation(...args),
    getOrganisationEnabledConnectorIds: vi.fn(),
    getUserOrganisationId: vi.fn(),
    listOrganisationMembers: vi.fn(),
}));

// Peripheral user.ts imports — mocked so the module loads (unused by this route).
vi.mock("../lib/llm", () => ({
    DEFAULT_TABULAR_MODEL: "m",
    DEFAULT_TITLE_MODEL: "m",
    CLAUDE_LOW_MODELS: [],
    OPENAI_LOW_MODELS: [],
    resolveModel: () => null,
}));
vi.mock("../lib/userApiKeys", () => ({
    getUserApiKeyStatus: () =>
        Promise.resolve({
            claude: false,
            gemini: false,
            openai: false,
            openrouter: false,
            companies_house: false,
            sources: {
                claude: null,
                gemini: null,
                openai: null,
                openrouter: null,
                companies_house: null,
            },
        }),
    normalizeApiKeyProvider: () => null,
    saveUserApiKey: vi.fn(),
}));
vi.mock("../lib/llm/localConfig", () => ({
    getLocalLlmStatus: () => ({ configured: false, models: [] }),
}));
vi.mock("../lib/mcpConnectors", () => ({
    McpOAuthRequiredError: class extends Error {},
    createUserMcpConnector: vi.fn(),
    startUserMcpConnectorOAuth: vi.fn(),
    listUserMcpConnectors: vi.fn(),
    completeUserMcpConnectorOAuth: vi.fn(),
    deleteUserMcpConnector: vi.fn(),
    getUserMcpConnector: vi.fn(),
    refreshUserMcpConnectorTools: vi.fn(),
    setUserMcpToolEnabled: vi.fn(),
    updateUserMcpConnector: vi.fn(),
    validateRemoteMcpUrl: vi.fn(),
}));
vi.mock("../lib/userDataCleanup", () => ({
    deleteAllUserChats: vi.fn(),
    deleteAllUserTabularReviews: vi.fn(),
    deleteUserAccountData: vi.fn(),
    deleteUserProjects: vi.fn(),
    purgeProjectsByIds: vi.fn(),
    purgeDocumentsByIds: vi.fn(),
    purgeChatsByIds: vi.fn(),
    purgeTabularReviewsByIds: vi.fn(),
    purgeWorkflowsByIds: vi.fn(),
}));
vi.mock("../lib/userDataExport", () => ({
    buildUserAccountExport: vi.fn(),
    buildUserChatsExport: vi.fn(),
    buildUserTabularReviewsExport: vi.fn(),
    userExportFilename: () => "x",
}));

import { userRouter } from "./user";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/user", userRouter);
    await new Promise<void>((resolve) => {
        server = app.listen(0, resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
    () =>
        new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
        }),
);

const ARIA_MEMBER: OrganisationMembership = {
    id: "org-1",
    name: "Aria Grace Law CIC",
    role: "member",
    policies: {
        memberApiKeys: true,
        memberMcpConnectors: true,
        memberModelPrefs: true,
    },
    modelConfig: { defaultModel: null, offeredProviders: [] },
    retentionDays: 30,
};

beforeEach(() => {
    state.membership = null;
    state.membershipThrows = false;
    state.updateCalls = [];
    resolveUserOrganisation.mockReset();
    resolveUserOrganisation.mockImplementation(() => {
        if (state.membershipThrows) {
            return Promise.reject(new Error("db down"));
        }
        return Promise.resolve(state.membership);
    });
});

const patchProfile = (body: Record<string, unknown>) =>
    fetch(`${baseUrl}/user/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

describe("PATCH /user/profile — legacy organisation field, firm-member belt", () => {
    it("drops the organisation write for a firm member while other fields still apply", async () => {
        state.membership = ARIA_MEMBER;

        const res = await patchProfile({
            organisation: "Sneaky Renamed Firm",
            displayName: "New Display Name",
        });

        expect(res.status).toBe(200);
        expect(state.updateCalls).toHaveLength(1);
        expect(state.updateCalls[0]).not.toHaveProperty("organisation");
        expect(state.updateCalls[0]).toMatchObject({
            display_name: "New Display Name",
        });
    });

    it("still lands the organisation write for an orgless caller", async () => {
        state.membership = null;

        const res = await patchProfile({ organisation: "My New Firm" });

        expect(res.status).toBe(200);
        expect(state.updateCalls).toHaveLength(1);
        expect(state.updateCalls[0]).toMatchObject({
            organisation: "My New Firm",
        });
    });

    it("fails open (write still lands) when the membership lookup errors", async () => {
        state.membershipThrows = true;

        const res = await patchProfile({ organisation: "Still Applies Ltd" });

        expect(res.status).toBe(200);
        expect(state.updateCalls).toHaveLength(1);
        expect(state.updateCalls[0]).toMatchObject({
            organisation: "Still Applies Ltd",
        });
    });

    it("resolves membership exactly once (loadProfile's own resolve) for a displayName-only PATCH — the belt's extra lookup is skipped", async () => {
        state.membership = ARIA_MEMBER;

        const res = await patchProfile({ displayName: "Only This" });

        expect(res.status).toBe(200);
        expect(state.updateCalls[0]).not.toHaveProperty("organisation");
        expect(state.updateCalls[0]).toMatchObject({
            display_name: "Only This",
        });
        // Cheap-path guard: exactly one resolve (loadProfile's), not two — the
        // belt logic must not fire when the payload never touches organisation.
        expect(resolveUserOrganisation).toHaveBeenCalledTimes(1);
    });

    it("resolves membership exactly twice (belt + loadProfile) when the payload touches organisation", async () => {
        state.membership = ARIA_MEMBER;

        const res = await patchProfile({
            organisation: "Sneaky Renamed Firm",
            displayName: "Two",
        });

        expect(res.status).toBe(200);
        expect(state.updateCalls[0]).not.toHaveProperty("organisation");
        // One resolve from the belt (drops organisation), one from
        // loadProfile (builds the response's `firm` field) — both call sites
        // are independent resolves, not a shared cache.
        expect(resolveUserOrganisation).toHaveBeenCalledTimes(2);
    });
});
