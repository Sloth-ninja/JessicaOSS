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

// Control state for the mocked middleware + libs, shared via vi.hoisted so the
// hoisted vi.mock factories can close over it.
const state = vi.hoisted(() => ({
    connectorsBlocked: false,
    orgId: null as string | null,
    enabledConnectorIds: [] as string[],
    existingConnectors: [] as Array<{ id: string; serverUrl: string }>,
}));

const createUserMcpConnector = vi.fn();
const startUserMcpConnectorOAuth = vi.fn();
const listUserMcpConnectors = vi.fn();

vi.mock("../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "caller";
        next();
    },
    // Simulates the real firm-policy gate: a blocked firm gets the fixed 403.
    requireMemberPolicy:
        (_policy: string, detail: string) =>
        (
            _req: unknown,
            res: { status: (n: number) => { json: (b: unknown) => void } },
            next: () => void,
        ) => {
            if (state.connectorsBlocked) {
                res.status(403).json({ detail });
                return;
            }
            next();
        },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

vi.mock("../lib/supabase", () => ({ createServerSupabase: () => ({}) }));

vi.mock("../lib/organisations", () => ({
    getUserOrganisationId: () => Promise.resolve(state.orgId),
    getOrganisationEnabledConnectorIds: () =>
        Promise.resolve(state.enabledConnectorIds),
    resolveUserOrganisation: () => Promise.resolve(null),
}));

// mcpConnectorRegistry + mcpConnectorGallery are used REAL (registry validation
// and normaliseServerUrl are what we want to exercise).
vi.mock("../lib/mcpConnectors", () => ({
    McpOAuthRequiredError: class extends Error {},
    createUserMcpConnector: (...a: unknown[]) => createUserMcpConnector(...a),
    startUserMcpConnectorOAuth: (...a: unknown[]) =>
        startUserMcpConnectorOAuth(...a),
    listUserMcpConnectors: (...a: unknown[]) => listUserMcpConnectors(...a),
    completeUserMcpConnectorOAuth: vi.fn(),
    deleteUserMcpConnector: vi.fn(),
    getUserMcpConnector: vi.fn(),
    refreshUserMcpConnectorTools: vi.fn(),
    setUserMcpToolEnabled: vi.fn(),
    updateUserMcpConnector: vi.fn(),
    validateRemoteMcpUrl: vi.fn(),
}));

// Peripheral user.ts imports — mocked so the module loads; unused by this route.
vi.mock("../lib/llm", () => ({
    DEFAULT_TABULAR_MODEL: "m",
    DEFAULT_TITLE_MODEL: "m",
    CLAUDE_LOW_MODELS: [],
    OPENAI_LOW_MODELS: [],
    resolveModel: () => null,
}));
vi.mock("../lib/userApiKeys", () => ({
    getUserApiKeyStatus: vi.fn(),
    normalizeApiKeyProvider: () => null,
    saveUserApiKey: vi.fn(),
}));
vi.mock("../lib/llm/localConfig", () => ({
    getLocalLlmStatus: () => ({ configured: false, models: [] }),
}));
vi.mock("../lib/userDataCleanup", () => ({
    deleteAllUserChats: vi.fn(),
    deleteAllUserTabularReviews: vi.fn(),
    deleteUserAccountData: vi.fn(),
    deleteUserProjects: vi.fn(),
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

beforeEach(() => {
    state.connectorsBlocked = false;
    state.orgId = null;
    state.enabledConnectorIds = [];
    state.existingConnectors = [];
    createUserMcpConnector.mockReset();
    startUserMcpConnectorOAuth.mockReset();
    listUserMcpConnectors.mockReset();
    listUserMcpConnectors.mockImplementation(() =>
        Promise.resolve(state.existingConnectors),
    );
    startUserMcpConnectorOAuth.mockResolvedValue({
        authorizationUrl: "https://auth.example/authorize",
        alreadyAuthorized: false,
    });
    createUserMcpConnector.mockImplementation((_u, input) =>
        Promise.resolve({ id: "new-conn", serverUrl: input.serverUrl }),
    );
});

const connect = (registryId: string) =>
    fetch(`${baseUrl}/user/connector-gallery/${registryId}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
    });

describe("POST /user/connector-gallery/:registryId/connect", () => {
    it("creates the connector and starts OAuth for a one-click entry", async () => {
        const res = await connect("google-drive");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            connectorId: "new-conn",
            authorizationUrl: "https://auth.example/authorize",
            alreadyAuthorized: false,
        });
        expect(createUserMcpConnector).toHaveBeenCalledWith(
            "caller",
            {
                name: "Google Drive",
                serverUrl: "https://drivemcp.googleapis.com/mcp/v1",
            },
            expect.anything(),
        );
    });

    it("reuses an existing connector for the same endpoint (no duplicate)", async () => {
        state.existingConnectors = [
            {
                id: "existing-drive",
                serverUrl: "https://drivemcp.googleapis.com/mcp/v1",
            },
        ];
        const res = await connect("google-drive");
        expect(res.status).toBe(200);
        expect((await res.json()).connectorId).toBe("existing-drive");
        expect(createUserMcpConnector).not.toHaveBeenCalled();
        expect(startUserMcpConnectorOAuth).toHaveBeenCalledWith(
            "caller",
            "existing-drive",
            expect.any(String),
            expect.anything(),
        );
    });

    it("404s an unknown registry id", async () => {
        const res = await connect("not-a-connector");
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ detail: "Unknown connector." });
        expect(createUserMcpConnector).not.toHaveBeenCalled();
    });

    it("404s a custom (non-one-click) entry", async () => {
        const res = await connect("clio");
        expect(res.status).toBe(404);
        expect(createUserMcpConnector).not.toHaveBeenCalled();
    });

    it("404s an entry hidden by the firm's curation", async () => {
        state.orgId = "org-1";
        state.enabledConnectorIds = ["gmail"]; // google-drive not curated
        const res = await connect("google-drive");
        expect(res.status).toBe(404);
        expect(createUserMcpConnector).not.toHaveBeenCalled();
    });

    it("allows a curated entry through", async () => {
        state.orgId = "org-1";
        state.enabledConnectorIds = ["google-drive"];
        const res = await connect("google-drive");
        expect(res.status).toBe(200);
    });

    it("403s when the firm blocks personal connectors", async () => {
        state.connectorsBlocked = true;
        const res = await connect("google-drive");
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
            detail: "Connectors are managed by your firm.",
        });
        expect(createUserMcpConnector).not.toHaveBeenCalled();
    });
});
