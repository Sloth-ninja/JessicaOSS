import { describe, it, expect } from "vitest";
import {
    CONNECTOR_REGISTRY,
    connectorRegistryIds,
    getConnectorRegistryEntry,
    isOneClickEntry,
} from "./mcpConnectorRegistry";

describe("connector registry invariants", () => {
    it("has unique, non-empty ids and names", () => {
        const ids = CONNECTOR_REGISTRY.map((e) => e.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const entry of CONNECTOR_REGISTRY) {
            expect(entry.id).toMatch(/^[a-z0-9-]+$/);
            expect(entry.name.length).toBeGreaterThan(0);
            expect(entry.description.length).toBeGreaterThan(0);
            expect(entry.category.length).toBeGreaterThan(0);
        }
    });

    // HONESTY RULE: an entry may only be one-click ("oauth") if it carries a
    // concrete https server URL and authType "oauth". "custom" entries must NOT
    // carry a server URL (they render informational — no Connect button).
    it("only lists one-click entries with a verified https OAuth endpoint", () => {
        for (const entry of CONNECTOR_REGISTRY) {
            if (entry.availability === "oauth") {
                expect(entry.serverUrl, entry.id).toMatch(/^https:\/\//);
                expect(entry.authType, entry.id).toBe("oauth");
                expect(isOneClickEntry(entry)).toBe(true);
            } else {
                expect(entry.availability).toBe("custom");
                expect(entry.serverUrl, entry.id).toBeUndefined();
                expect(isOneClickEntry(entry)).toBe(false);
            }
        }
    });

    it("only features one-click entries in the Popular row", () => {
        for (const entry of CONNECTOR_REGISTRY) {
            if (entry.popular) expect(entry.availability).toBe("oauth");
        }
    });

    it("resolves known ids and rejects unknown ones", () => {
        expect(getConnectorRegistryEntry("google-drive")?.name).toBe(
            "Google Drive",
        );
        expect(getConnectorRegistryEntry("nope")).toBeUndefined();
        expect(connectorRegistryIds().has("google-drive")).toBe(true);
        expect(connectorRegistryIds().has("nope")).toBe(false);
    });
});
