import { createServerSupabase } from "./supabase";
import { listUserMcpConnectors } from "./mcpConnectors";
import type { McpConnectorSummary } from "./mcp/types";
import {
    CONNECTOR_REGISTRY,
    type ConnectorAvailability,
    type ConnectorRegistryEntry,
} from "./mcpConnectorRegistry";

type Db = ReturnType<typeof createServerSupabase>;

export type GalleryConnectionStatus =
    | "connected"
    | "not_connected"
    | "connection_issue";

// One row rendered by the gallery. A row is either a registry entry (possibly
// backed by one of the caller's connectors) or one of the caller's own custom
// connectors that matches no registry entry.
export interface ConnectorGalleryItem {
    /** Stable React key. */
    key: string;
    /** Registry slug when this row is a shortlist entry; null for a bare custom connector. */
    registryId: string | null;
    /** The caller's connector row id when they have one; null otherwise. */
    connectorId: string | null;
    name: string;
    description: string;
    /** The "Type" column. */
    category: string;
    popular: boolean;
    availability: ConnectorAvailability;
    /** True → the gallery shows a one-click "Connect" affordance for this row. */
    connectable: boolean;
    status: GalleryConnectionStatus;
}

/**
 * Normalise an MCP server URL for matching a registry entry against one of the
 * caller's stored connectors. Mirrors `validateRemoteMcpUrl`, which stores
 * `new URL(raw).toString()`, so the comparison is on the same canonical form.
 * Returns null for an unparseable URL (never throws — matching just misses).
 */
export function normaliseServerUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        return new URL(url).toString();
    } catch {
        return null;
    }
}

/**
 * Derive a gallery row's connection status from the caller's connector state.
 * Pure and exhaustively unit-tested:
 *   - no matching connector           → "not_connected"
 *   - matched but disabled            → "not_connected" (member switched it off)
 *   - matched, most recent call errored → "connection_issue"
 *   - matched OAuth, not yet authorised → "connection_issue" (auth incomplete)
 *   - otherwise                       → "connected"
 */
export function deriveConnectionStatus(input: {
    matched: boolean;
    enabled: boolean;
    oauthConnected: boolean;
    /** OAuth connector (one whose auth_type is "oauth"). */
    isOAuth: boolean;
    /** The connector's most recent tool call errored. */
    hasRecentError: boolean;
}): GalleryConnectionStatus {
    if (!input.matched) return "not_connected";
    if (!input.enabled) return "not_connected";
    if (input.hasRecentError) return "connection_issue";
    if (input.isOAuth && !input.oauthConnected) return "connection_issue";
    return "connected";
}

/**
 * Filter the registry to a firm's curated shortlist.
 *
 * Semantics (documented contract): an EMPTY (or absent) `enabledIds` means "no
 * curation" → the whole shortlist is visible. A non-empty list restricts the
 * gallery to those ids (unknown ids are simply ignored). Orgless users pass
 * `null` and see the whole shortlist.
 */
export function filterRegistryByOrgCuration(
    entries: readonly ConnectorRegistryEntry[],
    enabledIds: string[] | null | undefined,
): ConnectorRegistryEntry[] {
    if (!enabledIds || enabledIds.length === 0) return [...entries];
    const allowed = new Set(enabledIds);
    return entries.filter((entry) => allowed.has(entry.id));
}

// Latest tool-call status per connector, keyed by connector id. Only "error"
// (the most recent call failed) matters for the gallery.
//
// Trade-off: this reads ONE shared 500-row newest-first window across all the
// caller's connectors, not the latest row per connector. A very chatty connector
// could push a quieter connector's most-recent (error) row out of the window,
// so that connector would report no recent error. This degrades in the SAFE
// direction — we may MISS an error (show "connected" instead of "connection
// issue"), never INVENT one. At pilot scale (few connectors, modest call
// volume) the window comfortably covers every connector; noted for a future
// per-connector `distinct on` / RPC upgrade if connector counts grow.
async function loadLatestAuditStatus(
    db: Db,
    connectorIds: string[],
): Promise<Map<string, "ok" | "error">> {
    const latest = new Map<string, "ok" | "error">();
    if (connectorIds.length === 0) return latest;
    const { data, error } = await db
        .from("user_mcp_tool_audit_logs")
        .select("connector_id, status, created_at")
        .in("connector_id", connectorIds)
        .order("created_at", { ascending: false })
        .limit(500);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{
        connector_id: string;
        status: string;
    }>) {
        // Rows arrive newest-first; the first time we see a connector is its
        // most recent call.
        if (!latest.has(row.connector_id)) {
            latest.set(
                row.connector_id,
                row.status === "error" ? "error" : "ok",
            );
        }
    }
    return latest;
}

/**
 * Build the connector gallery for a caller: the firm-curated registry shortlist
 * (each with a live connection status derived from the caller's own connectors)
 * followed by any of the caller's custom connectors that match no shortlist
 * entry. `enabledConnectorIds` is the caller's firm curation (null/[] ⇒ all).
 */
export async function buildConnectorGallery(
    userId: string,
    enabledConnectorIds: string[] | null,
    db: Db = createServerSupabase(),
): Promise<ConnectorGalleryItem[]> {
    const connectors = await listUserMcpConnectors(userId, db, {
        includeTools: false,
    });

    // Index the caller's connectors by canonical server URL; the list is ordered
    // newest-first, so the first entry for a URL is the most recent one.
    const byUrl = new Map<string, McpConnectorSummary>();
    for (const connector of connectors) {
        const url = normaliseServerUrl(connector.serverUrl);
        if (url && !byUrl.has(url)) byUrl.set(url, connector);
    }

    const visibleEntries = filterRegistryByOrgCuration(
        CONNECTOR_REGISTRY,
        enabledConnectorIds,
    );

    // Which connector ids we need audit status for: the ones backing a visible
    // registry entry plus every unmatched custom connector.
    const matchedRegistryUrls = new Set<string>();
    for (const entry of visibleEntries) {
        const url = normaliseServerUrl(entry.serverUrl);
        if (url) matchedRegistryUrls.add(url);
    }
    const relevantConnectorIds = connectors
        .filter((connector) => {
            const url = normaliseServerUrl(connector.serverUrl);
            // Unmatched customs OR a connector backing a visible registry entry.
            return !url || !matchedRegistryUrls.has(url) || byUrl.has(url);
        })
        .map((connector) => connector.id);
    const latestAudit = await loadLatestAuditStatus(db, relevantConnectorIds);

    const usedConnectorIds = new Set<string>();
    const items: ConnectorGalleryItem[] = [];

    for (const entry of visibleEntries) {
        const url = normaliseServerUrl(entry.serverUrl);
        const connector = url ? byUrl.get(url) : undefined;
        if (connector) usedConnectorIds.add(connector.id);
        const status = deriveConnectionStatus({
            matched: !!connector,
            enabled: connector?.enabled ?? false,
            oauthConnected: connector?.oauthConnected ?? false,
            // Registry truth, NOT the stored auth_type: createUserMcpConnector
            // persists auth_type "none" and only flips to "oauth" once a token is
            // stored. Deriving isOAuth from the stored row would let an abandoned
            // one-click connect (row exists, no token, no audit rows) skip the
            // "OAuth not yet authorised → connection_issue" branch and read as
            // "connected". Using the entry's availability keeps it honest.
            isOAuth: entry.availability === "oauth",
            hasRecentError:
                !!connector && latestAudit.get(connector.id) === "error",
        });
        items.push({
            key: `registry:${entry.id}`,
            registryId: entry.id,
            connectorId: connector?.id ?? null,
            name: entry.name,
            description: entry.description,
            category: entry.category,
            popular: entry.popular,
            availability: entry.availability,
            // One-click Connect only for verified OAuth entries not already
            // connected (a connected entry shows its status, not a Connect).
            connectable: entry.availability === "oauth" && status !== "connected",
            status,
        });
    }

    // The caller's own custom connectors that back no visible registry entry.
    for (const connector of connectors) {
        if (usedConnectorIds.has(connector.id)) continue;
        const status = deriveConnectionStatus({
            matched: true,
            enabled: connector.enabled,
            oauthConnected: connector.oauthConnected,
            isOAuth: connector.authType === "oauth",
            hasRecentError: latestAudit.get(connector.id) === "error",
        });
        items.push({
            key: `connector:${connector.id}`,
            registryId: null,
            connectorId: connector.id,
            name: connector.name,
            description: connector.serverUrl,
            category: "Custom connector",
            popular: false,
            availability: "custom",
            connectable: false,
            status,
        });
    }

    return items;
}
