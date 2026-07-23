import type { McpAuthType } from "./mcp/types";

// WS8 PR E — curated MCP connector gallery registry.
//
// HONESTY RULE (CLAUDE.md hard rule 5, applied to connectors): a provider is
// only listed as one-click (`availability: "oauth"`, with a `serverUrl`) when a
// PUBLIC remote MCP server with OAuth was verified to exist (July 2026). Every
// such entry carries its verification source in a comment below. Providers with
// no verified public OAuth MCP endpoint — or that require each operator to
// register their own OAuth app / self-host — are listed as `availability:
// "custom"`: informational only, rendered as "available via a custom connector"
// with NO Connect button (never a dead button).
//
// The existing OAuth machinery (backend/src/lib/mcp/oauth.ts) completes a
// one-click connect either via OAuth 2.0 Dynamic Client Registration (DCR) —
// fully automatic — or via pre-provisioned client credentials read from env by
// host prefix (`oauthClientEnvFor`; Google uses the `GOOGLE_MCP_OAUTH_*`
// prefix). An entry is therefore "oauth" only when it supports DCR OR the
// codebase already first-classes it through an env prefix (Google).

export type ConnectorAvailability = "oauth" | "custom";

export interface ConnectorRegistryEntry {
    /** Stable slug id (used in URLs + org curation lists). */
    id: string;
    /** Display name (no real brand-logo asset — the UI renders an initial tile). */
    name: string;
    /** One-line, UK-legal-relevant description in UK English. */
    description: string;
    /** The "Type" column value in the gallery list. */
    category: string;
    /** Featured in the "Popular" row. */
    popular: boolean;
    /**
     * "oauth"  → verified public remote MCP + OAuth; one-click Connect.
     * "custom" → informational only; add via the custom-connector form.
     */
    availability: ConnectorAvailability;
    /** Canonical remote MCP endpoint. Present iff availability === "oauth". */
    serverUrl?: string;
    /** MCP auth type for one-click entries (always "oauth" here). */
    authType?: McpAuthType;
    /**
     * Env prefix supplying pre-provisioned OAuth client credentials when the
     * provider does not support DCR (see `oauthClientEnvFor`). Undefined when
     * the provider supports DCR (no operator config needed).
     */
    oauthEnvPrefix?: string;
}

// ── The shortlist ───────────────────────────────────────────────────────────
export const CONNECTOR_REGISTRY: readonly ConnectorRegistryEntry[] = [
    // ── One-click (verified public remote MCP + OAuth) ──────────────────────
    {
        // VERIFIED: official Google Workspace remote MCP server, OAuth 2.0.
        // Source: https://developers.google.com/workspace/guides/configure-mcp-servers
        // Google requires a pre-registered OAuth app → env credentials under the
        // GOOGLE_MCP_OAUTH_* prefix; the codebase already first-classes Google
        // (oauthClientEnvFor + isGoogleMcpConnector).
        id: "google-drive",
        name: "Google Drive",
        description:
            "Read matter documents and files stored in Google Drive.",
        category: "Cloud storage",
        popular: true,
        availability: "oauth",
        serverUrl: "https://drivemcp.googleapis.com/mcp/v1",
        authType: "oauth",
        oauthEnvPrefix: "GOOGLE_MCP_OAUTH",
    },
    {
        // VERIFIED: official Google Workspace remote MCP server, OAuth 2.0.
        // Source: https://developers.google.com/workspace/guides/configure-mcp-servers
        id: "gmail",
        name: "Gmail",
        description:
            "Search and draft client correspondence from a connected Gmail mailbox.",
        category: "Email",
        popular: true,
        availability: "oauth",
        serverUrl: "https://gmailmcp.googleapis.com/mcp/v1",
        authType: "oauth",
        oauthEnvPrefix: "GOOGLE_MCP_OAUTH",
    },
    {
        // VERIFIED: official Google Calendar remote MCP server, OAuth 2.0.
        // Source: https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server
        id: "google-calendar",
        name: "Google Calendar",
        description:
            "Read hearing dates and appointments from Google Calendar.",
        category: "Calendar",
        popular: true,
        availability: "oauth",
        serverUrl: "https://calendarmcp.googleapis.com/mcp/v1",
        authType: "oauth",
        oauthEnvPrefix: "GOOGLE_MCP_OAUTH",
    },
    {
        // VERIFIED: official Canva remote MCP server, OAuth 2 with Dynamic
        // Client Registration (DCR) — no operator config needed.
        // Source: https://www.canva.dev/docs/mcp/ (endpoint https://mcp.canva.com/mcp)
        id: "canva",
        name: "Canva",
        description:
            "Create and export branded documents and presentations in Canva.",
        category: "Design",
        popular: false,
        availability: "oauth",
        serverUrl: "https://mcp.canva.com/mcp",
        authType: "oauth",
    },
    {
        // VERIFIED: official Apollo.io remote MCP server over Streamable HTTP
        // with OAuth (browser sign-in, any plan). OAuth authorization-server
        // metadata is published at mcp.apollo.io/.well-known/oauth-authorization-server.
        // Source: https://docs.apollo.io/docs/apollo-mcp (endpoint https://mcp.apollo.io/mcp)
        id: "apollo",
        name: "Apollo.io",
        description:
            "Enrich company and contact records for business development.",
        category: "Business development",
        popular: false,
        availability: "oauth",
        serverUrl: "https://mcp.apollo.io/mcp",
        authType: "oauth",
    },

    // ── Custom (no verified one-click endpoint — informational only) ─────────
    {
        // NOT one-click: no official Microsoft-hosted public remote MCP server
        // with OAuth. Only self-hosted community servers (e.g. Softeria
        // ms-365-mcp-server) that require each operator to register their own
        // Entra OAuth app. Source: https://github.com/softeria/ms-365-mcp-server
        id: "microsoft-365",
        name: "Microsoft 365",
        description:
            "OneDrive, SharePoint and Outlook — available via a custom connector to a self-hosted Microsoft 365 MCP server.",
        category: "Cloud storage & email",
        popular: false,
        availability: "custom",
    },
    {
        // NOT one-click (yet): DocuSign runs a hosted MCP server
        // (mcp-d.docusign.com/mcp, OAuth via account-d.docusign.com) but it is
        // in BETA and production access requires beta-programme enrolment.
        // Source: https://fast.io/resources/mcp-server-for-docusign/
        id: "docusign",
        name: "DocuSign",
        description:
            "Send and track agreements for e-signature — DocuSign's hosted MCP server is in beta; add via a custom connector once enrolled.",
        category: "E-signature",
        popular: false,
        availability: "custom",
    },
    {
        // NOT one-click: Slack runs an official hosted MCP server
        // (mcp.slack.com/mcp, Streamable HTTP) but it does NOT support Dynamic
        // Client Registration — each firm must register its own Slack OAuth app
        // and supply client credentials. Source:
        // https://truto.one/blog/best-mcp-server-for-slack-in-2026/
        id: "slack",
        name: "Slack",
        description:
            "Search and post to Slack channels — add via a custom connector using your firm's Slack app credentials.",
        category: "Team messaging",
        popular: false,
        availability: "custom",
    },
    {
        // NOT one-click: no official Microsoft-hosted Teams MCP server; only
        // third-party hosted (e.g. Improvado) or community self-hosted servers.
        // Source: https://improvado.io/mcp/microsoft-teams
        id: "microsoft-teams",
        name: "Microsoft Teams",
        description:
            "Read and post Teams messages — available via a custom connector to a Teams MCP server.",
        category: "Team messaging",
        popular: false,
        availability: "custom",
    },
    {
        // NOT one-click for a self-hosted deployment: HubSpot's official remote
        // MCP server (mcp.hubspot.com, GA April 2026, OAuth 2.1 + PKCE) requires
        // creating an "MCP auth app" in HubSpot's developer dashboard for
        // credentials rather than pure DCR. Source:
        // https://developers.hubspot.com/changelog/remote-hubspot-mcp-server-is-now-generally-available
        id: "hubspot",
        name: "HubSpot",
        description:
            "Sync CRM contacts and deals from HubSpot — add via a custom connector with your HubSpot MCP app credentials.",
        category: "CRM",
        popular: false,
        availability: "custom",
    },
    {
        // NOT one-click: no vendor-hosted Clio MCP server. Clio integrations are
        // open-source, self-hosted, and use each firm's own Clio OAuth app.
        // Highly relevant to UK firms so surfaced here as an informational
        // custom entry. Source: https://github.com/oktopeak/clio-mcp
        id: "clio",
        name: "Clio",
        description:
            "Read matters, contacts and billing from Clio practice management via a self-hosted connector.",
        category: "Practice management",
        popular: false,
        availability: "custom",
    },
];

/** Registry entry by id, or undefined for an unknown id. */
export function getConnectorRegistryEntry(
    id: string,
): ConnectorRegistryEntry | undefined {
    return CONNECTOR_REGISTRY.find((entry) => entry.id === id);
}

/** True when the entry is a verified one-click OAuth connector (has serverUrl). */
export function isOneClickEntry(
    entry: ConnectorRegistryEntry,
): entry is ConnectorRegistryEntry & { serverUrl: string } {
    return entry.availability === "oauth" && typeof entry.serverUrl === "string";
}

/** The set of all valid registry ids (used to validate admin curation input). */
export function connectorRegistryIds(): Set<string> {
    return new Set(CONNECTOR_REGISTRY.map((entry) => entry.id));
}
