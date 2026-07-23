import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpConnectorSummary } from "./mcp/types";
import { CONNECTOR_REGISTRY } from "./mcpConnectorRegistry";

const listUserMcpConnectors = vi.fn();
vi.mock("./mcpConnectors", () => ({
    listUserMcpConnectors: (...args: unknown[]) =>
        listUserMcpConnectors(...args),
}));
vi.mock("./supabase", () => ({ createServerSupabase: () => ({}) }));

import {
    buildConnectorGallery,
    deriveConnectionStatus,
    filterRegistryByOrgCuration,
    normaliseServerUrl,
} from "./mcpConnectorGallery";

function summary(over: Partial<McpConnectorSummary>): McpConnectorSummary {
    return {
        id: "c1",
        name: "Custom",
        transport: "streamable_http",
        serverUrl: "https://mcp.example.com/mcp",
        authType: "none",
        enabled: true,
        hasAuthConfig: false,
        customHeaderKeys: [],
        oauthConnected: false,
        toolPolicy: {},
        tools: [],
        toolCount: 0,
        createdAt: "2026-07-20T00:00:00Z",
        updatedAt: "2026-07-20T00:00:00Z",
        ...over,
    };
}

// A db stub whose only query is the audit-log lookup; `auditRows` are returned
// newest-first exactly as the real query orders them.
function makeDb(auditRows: Array<{ connector_id: string; status: string }>) {
    return {
        from() {
            return {
                select() {
                    return {
                        in() {
                            return {
                                order() {
                                    return {
                                        limit: () =>
                                            Promise.resolve({
                                                data: auditRows,
                                                error: null,
                                            }),
                                    };
                                },
                            };
                        },
                    };
                },
            };
        },
    } as never;
}

beforeEach(() => listUserMcpConnectors.mockReset());

describe("normaliseServerUrl", () => {
    it("canonicalises and tolerates junk", () => {
        expect(normaliseServerUrl("https://mcp.canva.com/mcp")).toBe(
            "https://mcp.canva.com/mcp",
        );
        expect(normaliseServerUrl("not a url")).toBeNull();
        expect(normaliseServerUrl(undefined)).toBeNull();
    });
});

describe("deriveConnectionStatus", () => {
    it("is not_connected without a matching connector", () => {
        expect(
            deriveConnectionStatus({
                matched: false,
                enabled: false,
                oauthConnected: false,
                isOAuth: true,
                hasRecentError: false,
            }),
        ).toBe("not_connected");
    });

    it("is not_connected when the matched connector is disabled", () => {
        expect(
            deriveConnectionStatus({
                matched: true,
                enabled: false,
                oauthConnected: true,
                isOAuth: true,
                hasRecentError: false,
            }),
        ).toBe("not_connected");
    });

    it("is connection_issue on a recent error", () => {
        expect(
            deriveConnectionStatus({
                matched: true,
                enabled: true,
                oauthConnected: true,
                isOAuth: true,
                hasRecentError: true,
            }),
        ).toBe("connection_issue");
    });

    it("is connection_issue for an OAuth connector not yet authorised", () => {
        expect(
            deriveConnectionStatus({
                matched: true,
                enabled: true,
                oauthConnected: false,
                isOAuth: true,
                hasRecentError: false,
            }),
        ).toBe("connection_issue");
    });

    it("is connected when enabled, authorised and healthy", () => {
        expect(
            deriveConnectionStatus({
                matched: true,
                enabled: true,
                oauthConnected: true,
                isOAuth: true,
                hasRecentError: false,
            }),
        ).toBe("connected");
    });
});

describe("filterRegistryByOrgCuration", () => {
    it("returns the whole shortlist for null / empty curation", () => {
        expect(filterRegistryByOrgCuration(CONNECTOR_REGISTRY, null)).toHaveLength(
            CONNECTOR_REGISTRY.length,
        );
        expect(filterRegistryByOrgCuration(CONNECTOR_REGISTRY, [])).toHaveLength(
            CONNECTOR_REGISTRY.length,
        );
    });

    it("restricts to the curated ids and ignores unknown ones", () => {
        const filtered = filterRegistryByOrgCuration(CONNECTOR_REGISTRY, [
            "gmail",
            "ghost-connector",
        ]);
        expect(filtered.map((e) => e.id)).toEqual(["gmail"]);
    });
});

describe("buildConnectorGallery", () => {
    it("derives connected / issue / not-connected against the caller's connectors", async () => {
        listUserMcpConnectors.mockResolvedValue([
            // Google Drive → connected (oauth authorised, enabled, healthy).
            summary({
                id: "drive-conn",
                serverUrl: "https://drivemcp.googleapis.com/mcp/v1",
                authType: "oauth",
                oauthConnected: true,
            }),
            // Gmail → connection_issue (latest call errored).
            summary({
                id: "gmail-conn",
                serverUrl: "https://gmailmcp.googleapis.com/mcp/v1",
                authType: "oauth",
                oauthConnected: true,
            }),
            // Google Calendar has no connector → not_connected.
        ]);

        const items = await buildConnectorGallery(
            "user-1",
            null,
            makeDb([{ connector_id: "gmail-conn", status: "error" }]),
        );

        const byId = new Map(items.map((i) => [i.registryId, i]));
        expect(byId.get("google-drive")?.status).toBe("connected");
        expect(byId.get("google-drive")?.connectorId).toBe("drive-conn");
        expect(byId.get("google-drive")?.connectable).toBe(false);
        expect(byId.get("gmail")?.status).toBe("connection_issue");
        expect(byId.get("gmail")?.connectable).toBe(true);
        expect(byId.get("google-calendar")?.status).toBe("not_connected");
        expect(byId.get("google-calendar")?.connectable).toBe(true);
    });

    it("reports an abandoned one-click connect as connection_issue, not connected", async () => {
        // createUserMcpConnector persists auth_type "none"; it only flips to
        // "oauth" once a token is stored. A row for a registry OAuth endpoint
        // with no token and no audit rows is an abandoned connect — it must read
        // connection_issue (Reconnect), never a false "connected".
        listUserMcpConnectors.mockResolvedValue([
            summary({
                id: "drive-pending",
                serverUrl: "https://drivemcp.googleapis.com/mcp/v1",
                authType: "none",
                oauthConnected: false,
                enabled: true,
            }),
        ]);

        const items = await buildConnectorGallery("user-1", null, makeDb([]));
        const drive = items.find((i) => i.registryId === "google-drive");
        expect(drive?.status).toBe("connection_issue");
        expect(drive?.connectable).toBe(true);
    });

    it("applies org curation and appends unmatched custom connectors", async () => {
        listUserMcpConnectors.mockResolvedValue([
            summary({
                id: "dms-conn",
                name: "Internal DMS",
                serverUrl: "https://dms.internal.example/mcp",
                authType: "bearer",
                enabled: true,
            }),
        ]);

        const items = await buildConnectorGallery(
            "user-1",
            ["google-drive"],
            makeDb([]),
        );

        // Only the curated registry entry is present …
        const registryItems = items.filter((i) => i.registryId !== null);
        expect(registryItems.map((i) => i.registryId)).toEqual(["google-drive"]);
        // … plus the caller's unmatched custom connector, rendered as custom.
        const custom = items.find((i) => i.connectorId === "dms-conn");
        expect(custom).toMatchObject({
            registryId: null,
            name: "Internal DMS",
            category: "Custom connector",
            availability: "custom",
            connectable: false,
            status: "connected",
        });
    });
});
