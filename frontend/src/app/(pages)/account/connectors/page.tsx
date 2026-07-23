"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    AlertTriangle,
    ChevronDown,
    Check,
    CheckCircle2,
    Circle,
    Eye,
    EyeOff,
    Loader2,
    Plus,
    RefreshCw,
    Trash2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Modal } from "@/app/components/shared/Modal";
import {
    MfaVerificationPopup,
    needsMfaVerification,
} from "@/app/components/shared/MfaVerificationPopup";
import {
    type ConnectorGalleryItem,
    type GalleryConnectionStatus,
    type McpConnectorSummary,
    MikeApiError,
    connectGalleryConnector,
    createMcpConnector,
    deleteMcpConnector,
    getConnectorGallery,
    getMcpConnector,
    isMfaRequiredError,
    refreshMcpConnectorTools,
    setMcpToolEnabled,
    startMcpConnectorOAuth,
    updateMcpConnector,
} from "@/app/lib/mikeApi";
import {
    accountGlassDangerButtonClassName,
    accountGlassIconButtonClassName,
    accountGlassInputClassName,
    accountGlassPrimaryButtonClassName,
} from "../accountStyles";
import { AccountSection } from "../AccountSection";
import { AccountToggle } from "../AccountToggle";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { FirmManagedCard, personalConnectorsBlocked } from "../firmPolicy";

type PendingMfaAction =
    | { type: "create" }
    | { type: "gallery-connect"; registryId: string }
    | { type: "save"; connectorId: string }
    | { type: "clear-token"; connectorId: string }
    | { type: "delete"; connectorId: string }
    | { type: "refresh"; connectorId: string }
    | { type: "connector-enabled"; connectorId: string; enabled: boolean }
    | {
          type: "tool-enabled";
          connectorId: string;
          toolId: string;
          enabled: boolean;
      };

type AddDraft = {
    name: string;
    serverUrl: string;
    bearerToken: string;
    customHeaders: string;
};

type DetailDraft = AddDraft & {
    clearBearerToken: boolean;
};

type AddStep = "form" | "working" | "auth" | "success";

const emptyAddDraft: AddDraft = {
    name: "",
    serverUrl: "",
    bearerToken: "",
    customHeaders: "",
};

type McpOAuthPopupMessage = {
    type?: string;
    success?: boolean;
    connectorId?: string;
    detail?: string;
};

const mcpOAuthMessageOrigin = new URL(
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001",
).origin;

function parseCustomHeaders(raw: string): Record<string, string> | undefined {
    const text = raw.trim();
    if (!text) return undefined;
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Custom headers must be a JSON object.");
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string") {
            throw new Error("Custom header values must be strings.");
        }
        headers[key] = value;
    }
    return headers;
}

function isGoogleMcpConnector(connector: McpConnectorSummary) {
    try {
        return new URL(connector.serverUrl).hostname
            .toLowerCase()
            .endsWith("googleapis.com");
    } catch {
        return false;
    }
}

// Opens the popup to the authorization URL and resolves once the OAuth callback
// posts a success message (or rejects on failure / close / timeout). Shared by
// the one-click gallery connect and the custom-connector add/refresh flows.
function waitForOAuthPopup(
    popup: Window,
    connectorId: string,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
            cleanup();
            reject(new Error("OAuth authorization timed out."));
        }, 5 * 60 * 1000);
        const poll = window.setInterval(() => {
            if (popup.closed) {
                cleanup();
                reject(new Error("OAuth authorization window was closed."));
            }
        }, 700);
        const cleanup = () => {
            window.clearTimeout(timeout);
            window.clearInterval(poll);
            window.removeEventListener("message", onMessage);
        };
        const onMessage = (event: MessageEvent<McpOAuthPopupMessage>) => {
            if (event.origin !== mcpOAuthMessageOrigin) return;
            if (event.data?.type !== "mcp_oauth_result") return;
            if (event.data.connectorId && event.data.connectorId !== connectorId) {
                return;
            }
            const sourceWindow = event.source as Window | null;
            sourceWindow?.postMessage(
                { type: "mcp_oauth_result_ack" },
                event.origin,
            );
            cleanup();
            if (event.data.success) {
                resolve();
                return;
            }
            reject(new Error(event.data.detail || "OAuth authorization failed."));
        };
        window.addEventListener("message", onMessage);
    });
}

function statusMeta(status: GalleryConnectionStatus): {
    label: string;
    tone: "connected" | "not_connected" | "issue";
} {
    if (status === "connected")
        return { label: "Connected", tone: "connected" };
    if (status === "connection_issue")
        return { label: "Connection issue", tone: "issue" };
    return { label: "Not connected", tone: "not_connected" };
}

export default function ConnectorsPage() {
    const { profile } = useUserProfile();
    const [gallery, setGallery] = useState<ConnectorGalleryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<
        "all" | "connected" | "not_connected"
    >("all");
    const [connectingId, setConnectingId] = useState<string | null>(null);
    const [addMenuOpen, setAddMenuOpen] = useState(false);
    const addMenuRef = useRef<HTMLDivElement | null>(null);
    const [pendingMfaAction, setPendingMfaAction] =
        useState<PendingMfaAction | null>(null);
    const [addOpen, setAddOpen] = useState(false);
    const [addDraft, setAddDraft] = useState<AddDraft>(emptyAddDraft);
    const [addStep, setAddStep] = useState<AddStep>("form");
    const [addResult, setAddResult] = useState<McpConnectorSummary | null>(
        null,
    );
    const [addError, setAddError] = useState<string | null>(null);
    const [addAuthMessage, setAddAuthMessage] = useState<string | null>(null);
    const [showAddToken, setShowAddToken] = useState(false);
    const [showAddAdvanced, setShowAddAdvanced] = useState(false);
    const [selectedConnectorId, setSelectedConnectorId] = useState<
        string | null
    >(null);
    const [selectedConnectorDetails, setSelectedConnectorDetails] =
        useState<McpConnectorSummary | null>(null);
    const [detailDraft, setDetailDraft] = useState<DetailDraft>({
        ...emptyAddDraft,
        clearBearerToken: false,
    });
    const [detailError, setDetailError] = useState<string | null>(null);
    const [loadingConnectorId, setLoadingConnectorId] = useState<string | null>(
        null,
    );
    const [clearedBearerTokenConnectorId, setClearedBearerTokenConnectorId] =
        useState<string | null>(null);
    const [showDetailToken, setShowDetailToken] = useState(false);
    const [showDetailAdvanced, setShowDetailAdvanced] = useState(false);

    const selectedConnector = selectedConnectorDetails;

    const loadGallery = useCallback(async () => {
        setError(null);
        try {
            setGallery(await getConnectorGallery());
        } catch (err) {
            setError(
                err instanceof Error ? err.message : "Failed to load connectors.",
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadGallery();
    }, [loadGallery]);

    // Close the Add menu on an outside click / Escape.
    useEffect(() => {
        if (!addMenuOpen) return;
        const onClick = (event: MouseEvent) => {
            if (
                addMenuRef.current &&
                !addMenuRef.current.contains(event.target as Node)
            ) {
                setAddMenuOpen(false);
            }
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") setAddMenuOpen(false);
        };
        document.addEventListener("mousedown", onClick);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onClick);
            document.removeEventListener("keydown", onKey);
        };
    }, [addMenuOpen]);

    useEffect(() => {
        if (!selectedConnector) return;
        setDetailDraft({
            name: selectedConnector.name,
            serverUrl: selectedConnector.serverUrl,
            bearerToken: "",
            customHeaders: "",
            clearBearerToken: false,
        });
        setDetailError(null);
        setClearedBearerTokenConnectorId(null);
        setShowDetailToken(false);
        setShowDetailAdvanced(false);
    }, [
        selectedConnector?.id,
        selectedConnector?.name,
        selectedConnector?.serverUrl,
    ]);

    // Update the open details modal in place, and refresh the gallery in the
    // background so its statuses/rows reflect the mutation. `options` preserve
    // an already-loaded tool list when the update carries none.
    const replaceConnector = (
        connector: McpConnectorSummary,
        options: { preserveToolsOnEmpty?: boolean } = {},
    ) => {
        const mergeConnector = (current: McpConnectorSummary) => {
            if (
                options.preserveToolsOnEmpty &&
                connector.tools.length === 0 &&
                current.tools.length > 0
            ) {
                return { ...connector, tools: current.tools };
            }
            return connector;
        };
        setSelectedConnectorDetails((current) =>
            current?.id === connector.id ? mergeConnector(current) : current,
        );
        void loadGallery();
    };

    const openConnectorDetails = async (connectorId: string) => {
        setSelectedConnectorId(connectorId);
        setDetailError(null);
        setLoadingConnectorId(connectorId);
        try {
            replaceConnector(await getMcpConnector(connectorId));
        } catch (err) {
            setDetailError(
                err instanceof Error
                    ? err.message
                    : "Failed to load connector details.",
            );
        } finally {
            setLoadingConnectorId((current) =>
                current === connectorId ? null : current,
            );
        }
    };

    const runSensitiveAction = async (
        action: PendingMfaAction,
        fn: () => Promise<void>,
    ) => {
        setError(null);
        setDetailError(null);
        try {
            if (await needsMfaVerification()) {
                setPendingMfaAction(action);
                return;
            }
            await fn();
        } catch (err) {
            if (isMfaRequiredError(err)) {
                setPendingMfaAction(action);
                return;
            }
            const message =
                err instanceof Error ? err.message : "Action failed.";
            if (action.type === "create") setAddError(message);
            else if (action.type === "save") setDetailError(message);
            else setError(message);
        }
    };

    const closeAddModal = () => {
        if (addStep === "working" || addStep === "auth") return;
        setAddOpen(false);
        setAddDraft(emptyAddDraft);
        setAddStep("form");
        setAddResult(null);
        setAddError(null);
        setAddAuthMessage(null);
        setShowAddToken(false);
        setShowAddAdvanced(false);
    };

    const connectConnectorOAuth = async (
        connectorId: string,
    ): Promise<McpConnectorSummary | null> => {
        const popup = window.open(
            "about:blank",
            "mike_mcp_oauth",
            "popup,width=560,height=720,menubar=no,toolbar=no,location=no,status=no",
        );
        const { authorizationUrl, alreadyAuthorized } =
            await startMcpConnectorOAuth(connectorId);
        if (alreadyAuthorized) {
            popup?.close();
            const refreshed = await refreshMcpConnectorTools(connectorId);
            replaceConnector(refreshed);
            return refreshed;
        }
        if (!authorizationUrl) {
            popup?.close();
            throw new Error("OAuth authorization URL was not returned.");
        }
        if (!popup) {
            window.location.assign(authorizationUrl);
            return null;
        }
        popup.location.href = authorizationUrl;

        await waitForOAuthPopup(popup, connectorId);

        const refreshed = await refreshMcpConnectorTools(connectorId);
        replaceConnector(refreshed);
        return refreshed;
    };

    // One-click connect for a gallery registry entry: create-or-reuse + OAuth on
    // the server, then drive the same popup as the custom flow. MFA-gated (the
    // server 403s and we replay after step-up).
    const handleGalleryConnect = async (registryId: string) => {
        setError(null);
        if (await needsMfaVerification()) {
            setPendingMfaAction({ type: "gallery-connect", registryId });
            return;
        }
        const popup = window.open(
            "about:blank",
            "mike_mcp_oauth",
            "popup,width=560,height=720,menubar=no,toolbar=no,location=no,status=no",
        );
        setConnectingId(registryId);
        try {
            const { connectorId, authorizationUrl, alreadyAuthorized } =
                await connectGalleryConnector(registryId);
            if (alreadyAuthorized) {
                popup?.close();
                await refreshMcpConnectorTools(connectorId);
                await loadGallery();
                return;
            }
            if (!authorizationUrl) {
                popup?.close();
                throw new Error("OAuth authorization URL was not returned.");
            }
            if (!popup) {
                window.location.assign(authorizationUrl);
                return;
            }
            popup.location.href = authorizationUrl;
            await waitForOAuthPopup(popup, connectorId);
            await refreshMcpConnectorTools(connectorId);
            await loadGallery();
        } catch (err) {
            popup?.close();
            if (isMfaRequiredError(err)) {
                setPendingMfaAction({ type: "gallery-connect", registryId });
                return;
            }
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not connect this connector.",
            );
        } finally {
            setConnectingId(null);
        }
    };

    const handleCreate = async () => {
        await runSensitiveAction({ type: "create" }, async () => {
            setBusyKey("create");
            setAddStep("working");
            setAddError(null);
            setAddAuthMessage(null);
            try {
                const headers = parseCustomHeaders(addDraft.customHeaders);
                const connector = await createMcpConnector({
                    name: addDraft.name,
                    serverUrl: addDraft.serverUrl,
                    bearerToken: addDraft.bearerToken.trim() || null,
                    ...(headers ? { headers } : {}),
                });
                let refreshed: McpConnectorSummary;
                try {
                    refreshed = await refreshMcpConnectorTools(connector.id);
                } catch (err) {
                    if (
                        err instanceof MikeApiError &&
                        err.code === "oauth_required"
                    ) {
                        replaceConnector(connector);
                        setAddAuthMessage(
                            "Complete authorization in the popup to finish connecting this MCP server.",
                        );
                        setAddStep("auth");
                        const authorized = await connectConnectorOAuth(
                            connector.id,
                        );
                        if (authorized) {
                            setAddAuthMessage(null);
                            setAddResult(authorized);
                            setAddStep("success");
                        }
                        return;
                    }
                    throw err;
                }
                replaceConnector(refreshed);
                if (isGoogleMcpConnector(refreshed) && !refreshed.oauthConnected) {
                    setAddAuthMessage(
                        "Authorize Google in the popup to finish connecting this MCP server.",
                    );
                    setAddStep("auth");
                    const authorized = await connectConnectorOAuth(refreshed.id);
                    if (authorized) {
                        setAddAuthMessage(null);
                        setAddResult(authorized);
                        setAddStep("success");
                    }
                    return;
                }
                setAddResult(refreshed);
                setAddStep("success");
            } catch (err) {
                setAddStep("form");
                setAddAuthMessage(null);
                setAddError(
                    err instanceof Error
                        ? err.message
                        : "Failed to add connector.",
                );
            } finally {
                setBusyKey(null);
            }
        });
    };

    const handleSaveSelectedConnector = async () => {
        if (!selectedConnector) return;
        await runSensitiveAction(
            { type: "save", connectorId: selectedConnector.id },
            async () => {
                setBusyKey(`save:${selectedConnector.id}`);
                setDetailError(null);
                try {
                    const headers = parseCustomHeaders(
                        detailDraft.customHeaders,
                    );
                    const saved = await updateMcpConnector(selectedConnector.id, {
                        name: detailDraft.name,
                        serverUrl: detailDraft.serverUrl,
                        ...(detailDraft.bearerToken.trim()
                            ? { bearerToken: detailDraft.bearerToken.trim() }
                            : {}),
                        ...(headers ? { headers } : {}),
                    });
                    const shouldRefreshTools =
                        saved.serverUrl !== selectedConnector.serverUrl ||
                        !!detailDraft.bearerToken.trim() ||
                        !!headers;
                    const refreshed = shouldRefreshTools
                            ? await refreshMcpConnectorTools(saved.id)
                            : saved;
                    replaceConnector(refreshed, {
                        preserveToolsOnEmpty: !shouldRefreshTools,
                    });
                    setDetailDraft({
                        name: refreshed.name,
                        serverUrl: refreshed.serverUrl,
                        bearerToken: "",
                        customHeaders: "",
                        clearBearerToken: false,
                    });
                } finally {
                    setBusyKey(null);
                }
            },
        );
    };

    const handleClearBearerToken = async (connectorId: string) => {
        await runSensitiveAction(
            { type: "clear-token", connectorId },
            async () => {
                setBusyKey(`clear-token:${connectorId}`);
                setDetailError(null);
                setClearedBearerTokenConnectorId(null);
                try {
                    const saved = await updateMcpConnector(connectorId, {
                        bearerToken: null,
                    });
                    replaceConnector(saved, { preserveToolsOnEmpty: true });
                    setDetailDraft((prev) => ({
                        ...prev,
                        bearerToken: "",
                        clearBearerToken: false,
                    }));
                    setClearedBearerTokenConnectorId(connectorId);
                } finally {
                    setBusyKey(null);
                }
            },
        );
    };

    const handleRefresh = async (connectorId: string) => {
        await runSensitiveAction({ type: "refresh", connectorId }, async () => {
            setBusyKey(`refresh:${connectorId}`);
            try {
                try {
                    replaceConnector(await refreshMcpConnectorTools(connectorId));
                } catch (err) {
                    if (
                        err instanceof MikeApiError &&
                            err.code === "oauth_required"
                    ) {
                        await connectConnectorOAuth(connectorId);
                        return;
                    }
                    throw err;
                }
            } finally {
                setBusyKey(null);
            }
        });
    };

    const handleConnectorEnabled = async (
        connectorId: string,
        enabled: boolean,
    ) => {
        await runSensitiveAction(
            { type: "connector-enabled", connectorId, enabled },
            async () => {
                setBusyKey(`connector:${connectorId}`);
                try {
                    replaceConnector(
                        await updateMcpConnector(connectorId, { enabled }),
                        { preserveToolsOnEmpty: true },
                    );
                } finally {
                    setBusyKey(null);
                }
            },
        );
    };

    const handleToolEnabled = async (
        connectorId: string,
        toolId: string,
        enabled: boolean,
    ) => {
        await runSensitiveAction(
            { type: "tool-enabled", connectorId, toolId, enabled },
            async () => {
                setBusyKey(`tool:${toolId}`);
                try {
                    replaceConnector(
                        await setMcpToolEnabled(connectorId, toolId, enabled),
                    );
                } finally {
                    setBusyKey(null);
                }
            },
        );
    };

    const handleDelete = async (connectorId: string) => {
        await runSensitiveAction({ type: "delete", connectorId }, async () => {
            setBusyKey(`delete:${connectorId}`);
            try {
                await deleteMcpConnector(connectorId);
                if (selectedConnectorId === connectorId) {
                    setSelectedConnectorId(null);
                    setSelectedConnectorDetails(null);
                }
                await loadGallery();
            } finally {
                setBusyKey(null);
            }
        });
    };

    const handleMfaVerified = async () => {
        const action = pendingMfaAction;
        setPendingMfaAction(null);
        if (!action) return;
        if (action.type === "create") await handleCreate();
        if (action.type === "gallery-connect") {
            await handleGalleryConnect(action.registryId);
        }
        if (action.type === "save") await handleSaveSelectedConnector();
        if (action.type === "clear-token") {
            await handleClearBearerToken(action.connectorId);
        }
        if (action.type === "refresh") await handleRefresh(action.connectorId);
        if (action.type === "delete") await handleDelete(action.connectorId);
        if (action.type === "connector-enabled") {
            await handleConnectorEnabled(action.connectorId, action.enabled);
        }
        if (action.type === "tool-enabled") {
            await handleToolEnabled(
                action.connectorId,
                action.toolId,
                action.enabled,
            );
        }
    };

    // Filter counts. "Not connected" groups everything that is not connected
    // (including connection issues), matching the mock-up's two-way split.
    const counts = useMemo(() => {
        const connected = gallery.filter(
            (item) => item.status === "connected",
        ).length;
        return {
            all: gallery.length,
            connected,
            not_connected: gallery.length - connected,
        };
    }, [gallery]);

    const visibleItems = useMemo(
        () =>
            gallery.filter((item) =>
                filter === "all"
                    ? true
                    : filter === "connected"
                      ? item.status === "connected"
                      : item.status !== "connected",
            ),
        [gallery, filter],
    );

    const popularItems = useMemo(
        () => gallery.filter((item) => item.popular),
        [gallery],
    );

    // Firm policy (WS8 PR B): members whose firm disables custom connectors have
    // this tab hidden; a direct navigation renders a neutral card rather than the
    // gallery or an error. Placed after all hooks to respect the rules of hooks.
    if (personalConnectorsBlocked(profile?.firm)) {
        return (
            <FirmManagedCard
                heading="Connectors"
                title="Managed by your firm"
                description={`Connectors are managed by ${profile?.firm?.name ?? "your firm"}. Ask your firm admin if you need a new connector added.`}
            />
        );
    }

    return (
        <div>
            <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="font-serif text-2xl font-medium text-gray-900">
                    Connectors
                </h2>
                <div className="relative" ref={addMenuRef}>
                    <button
                        type="button"
                        onClick={() => setAddMenuOpen((open) => !open)}
                        aria-haspopup="menu"
                        aria-expanded={addMenuOpen}
                        className={`inline-flex h-9 items-center gap-1.5 text-sm ${accountGlassPrimaryButtonClassName}`}
                    >
                        <Plus className="h-4 w-4" />
                        Add
                        <ChevronDown className="h-4 w-4" />
                    </button>
                    {addMenuOpen && (
                        <div
                            role="menu"
                            className="absolute right-0 z-50 mt-1.5 w-56 rounded-xl border border-white/70 bg-white/90 p-1 shadow-[0_12px_32px_rgba(15,23,42,0.14)] backdrop-blur-xl"
                        >
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    setAddMenuOpen(false);
                                    setAddOpen(true);
                                }}
                                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100"
                            >
                                <Plus className="h-4 w-4 text-gray-500" />
                                Add custom connector
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {error && (
                <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                </div>
            )}

            {loading ? (
                <GallerySkeleton />
            ) : (
                <>
                    {popularItems.length > 0 && (
                        <div className="mb-6">
                            <p className="mb-2 text-xs font-medium text-gray-500">
                                Popular
                            </p>
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                {popularItems.map((item) => (
                                    <PopularConnectorCard
                                        key={item.key}
                                        item={item}
                                        connecting={connectingId === item.registryId}
                                        onConnect={() =>
                                            item.registryId &&
                                            void handleGalleryConnect(
                                                item.registryId,
                                            )
                                        }
                                        onOpen={() =>
                                            item.connectorId &&
                                            void openConnectorDetails(
                                                item.connectorId,
                                            )
                                        }
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="mb-3 flex items-center gap-5 border-b border-gray-200">
                        {(
                            [
                                ["all", "All", counts.all],
                                ["connected", "Connected", counts.connected],
                                [
                                    "not_connected",
                                    "Not connected",
                                    counts.not_connected,
                                ],
                            ] as const
                        ).map(([key, label, count]) => (
                            <button
                                key={key}
                                type="button"
                                onClick={() => setFilter(key)}
                                className={`-mb-px flex h-9 items-center gap-1.5 border-b-2 text-xs font-medium transition-colors ${
                                    filter === key
                                        ? "border-gray-900 text-gray-900"
                                        : "border-transparent text-gray-500 hover:text-gray-800"
                                }`}
                            >
                                {label}
                                <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                                    {count}
                                </span>
                            </button>
                        ))}
                    </div>

                    <AccountSection className="overflow-hidden">
                        {visibleItems.length === 0 ? (
                            <p className="px-4 py-6 text-sm text-gray-500">
                                No connectors to show.
                            </p>
                        ) : (
                            <ul className="divide-y divide-gray-100">
                                {visibleItems.map((item) => (
                                    <GalleryRow
                                        key={item.key}
                                        item={item}
                                        connecting={
                                            connectingId === item.registryId
                                        }
                                        onConnect={() =>
                                            item.registryId &&
                                            void handleGalleryConnect(
                                                item.registryId,
                                            )
                                        }
                                        onOpen={() =>
                                            item.connectorId &&
                                            void openConnectorDetails(
                                                item.connectorId,
                                            )
                                        }
                                        onAddCustom={() => setAddOpen(true)}
                                    />
                                ))}
                            </ul>
                        )}
                    </AccountSection>
                </>
            )}

            <AddMcpConnectorModal
                open={addOpen}
                draft={addDraft}
                step={addStep}
                result={addResult}
                error={addError}
                authMessage={addAuthMessage}
                showToken={showAddToken}
                showAdvanced={showAddAdvanced}
                onDraftChange={setAddDraft}
                onShowTokenChange={setShowAddToken}
                onShowAdvancedChange={setShowAddAdvanced}
                onClose={closeAddModal}
                onSubmit={handleCreate}
                onOpenConnector={(connectorId) => {
                    void openConnectorDetails(connectorId);
                    closeAddModal();
                }}
            />

            <McpConnectorDetailsModal
                connector={selectedConnector}
                draft={detailDraft}
                error={detailError}
                busyKey={busyKey}
                toolsLoading={loadingConnectorId === selectedConnectorId}
                clearTokenStatus={
                    selectedConnectorId &&
                    busyKey === `clear-token:${selectedConnectorId}`
                        ? "clearing"
                        : selectedConnectorId === clearedBearerTokenConnectorId
                          ? "cleared"
                          : "idle"
                }
                showToken={showDetailToken}
                showAdvanced={showDetailAdvanced}
                onDraftChange={setDetailDraft}
                onShowTokenChange={setShowDetailToken}
                onShowAdvancedChange={setShowDetailAdvanced}
                onClose={() => {
                    setSelectedConnectorId(null);
                    setSelectedConnectorDetails(null);
                }}
                onSave={handleSaveSelectedConnector}
                onClearBearerToken={handleClearBearerToken}
                onRefresh={handleRefresh}
                onDelete={handleDelete}
                onConnectorEnabled={handleConnectorEnabled}
                onToolEnabled={handleToolEnabled}
            />

            <MfaVerificationPopup
                open={!!pendingMfaAction}
                onCancel={() => setPendingMfaAction(null)}
                onVerified={() => void handleMfaVerified()}
            />
        </div>
    );
}

// Neutral initial-letter tile (NO real brand-logo assets). The background is
// picked deterministically from the name so tiles are stable but varied.
const TILE_BACKGROUNDS = [
    "bg-gray-800",
    "bg-gray-700",
    "bg-gray-900",
    "bg-gray-600",
    "bg-gray-500",
];

function tileBackground(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    }
    return TILE_BACKGROUNDS[hash % TILE_BACKGROUNDS.length];
}

function LogoTile({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
    const dimension = size === "sm" ? "h-6 w-6 text-[11px]" : "h-9 w-9 text-base";
    return (
        <span
            aria-hidden
            className={`flex shrink-0 items-center justify-center rounded-lg font-serif text-white ${dimension} ${tileBackground(name)}`}
        >
            {name.trim().charAt(0).toUpperCase() || "?"}
        </span>
    );
}

function StatusPill({ status }: { status: GalleryConnectionStatus }) {
    const meta = statusMeta(status);
    if (meta.tone === "connected") {
        return (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {meta.label}
            </span>
        );
    }
    if (meta.tone === "issue") {
        return (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-800">
                <AlertTriangle className="h-3.5 w-3.5" />
                {meta.label}
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500">
            <Circle className="h-3.5 w-3.5" />
            {meta.label}
        </span>
    );
}

function PopularConnectorCard({
    item,
    connecting,
    onConnect,
    onOpen,
}: {
    item: ConnectorGalleryItem;
    connecting: boolean;
    onConnect: () => void;
    onOpen: () => void;
}) {
    return (
        <AccountSection className="flex flex-col items-start gap-2.5 p-4">
            <LogoTile name={item.name} />
            <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900">
                    {item.name}
                </p>
                <p className="text-xs text-gray-500">{item.category}</p>
            </div>
            {item.status === "connected" ? (
                <button
                    type="button"
                    onClick={onOpen}
                    className="mt-1 flex w-full items-center justify-center rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
                >
                    <StatusPill status="connected" />
                </button>
            ) : (
                <button
                    type="button"
                    onClick={onConnect}
                    disabled={connecting}
                    className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {connecting && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    )}
                    {item.status === "connection_issue" ? "Reconnect" : "Connect"}
                </button>
            )}
        </AccountSection>
    );
}

function GalleryRow({
    item,
    connecting,
    onConnect,
    onOpen,
    onAddCustom,
}: {
    item: ConnectorGalleryItem;
    connecting: boolean;
    onConnect: () => void;
    onOpen: () => void;
    onAddCustom: () => void;
}) {
    const clickable = !!item.connectorId;
    // A registry "custom" entry the user has not yet added: informational, not a
    // connectable one-click and not one of the user's own connectors. Reads as
    // "available via a custom connector" rather than a broken "Not connected".
    const informational = item.availability === "custom" && !item.connectorId;
    return (
        <li className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
            <button
                type="button"
                onClick={clickable ? onOpen : onAddCustom}
                className="flex min-w-0 items-start gap-2.5 text-left"
            >
                <LogoTile name={item.name} size="sm" />
                <span className="min-w-0">
                    <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-gray-900">
                            {item.name}
                        </span>
                        {informational && (
                            <span className="shrink-0 rounded-full border border-amber-600/20 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                                Custom
                            </span>
                        )}
                    </span>
                    {informational && (
                        <span className="mt-0.5 block truncate text-xs text-gray-500">
                            {item.description}
                        </span>
                    )}
                </span>
            </button>
            <span className="truncate text-xs text-gray-500">
                {item.category}
            </span>
            <span className="flex items-center justify-end">
                {item.connectable ? (
                    <button
                        type="button"
                        onClick={onConnect}
                        disabled={connecting}
                        className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {connecting && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        )}
                        {item.status === "connection_issue"
                            ? "Reconnect"
                            : "Connect"}
                    </button>
                ) : informational ? (
                    <button
                        type="button"
                        onClick={onAddCustom}
                        className="text-xs font-medium text-gray-500 transition-colors hover:text-gray-900"
                    >
                        Add via custom connector
                    </button>
                ) : (
                    <StatusPill status={item.status} />
                )}
            </span>
        </li>
    );
}

function GallerySkeleton() {
    return (
        <>
            <div className="mb-6">
                <div className="mb-2 h-3 w-16 animate-pulse rounded bg-gray-100" />
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {Array.from({ length: 3 }).map((_, index) => (
                        <AccountSection
                            key={index}
                            className="flex flex-col gap-2.5 p-4"
                        >
                            <div className="h-9 w-9 animate-pulse rounded-lg bg-gray-100" />
                            <div className="h-3.5 w-24 animate-pulse rounded bg-gray-100" />
                            <div className="h-7 w-full animate-pulse rounded-md bg-gray-100" />
                        </AccountSection>
                    ))}
                </div>
            </div>
            <AccountSection className="divide-y divide-gray-100">
                {Array.from({ length: 4 }).map((_, index) => (
                    <div
                        key={index}
                        className="flex items-center gap-2.5 px-4 py-3"
                    >
                        <div className="h-6 w-6 animate-pulse rounded-lg bg-gray-100" />
                        <div className="h-3.5 w-32 animate-pulse rounded bg-gray-100" />
                        <div className="ml-auto h-3 w-20 animate-pulse rounded bg-gray-100" />
                    </div>
                ))}
            </AccountSection>
        </>
    );
}

function AddMcpConnectorModal({
    open,
    draft,
    step,
    result,
    error,
    authMessage,
    showToken,
    showAdvanced,
    onDraftChange,
    onShowTokenChange,
    onShowAdvancedChange,
    onClose,
    onSubmit,
    onOpenConnector,
}: {
    open: boolean;
    draft: AddDraft;
    step: AddStep;
    result: McpConnectorSummary | null;
    error: string | null;
    authMessage: string | null;
    showToken: boolean;
    showAdvanced: boolean;
    onDraftChange: (draft: AddDraft) => void;
    onShowTokenChange: (show: boolean) => void;
    onShowAdvancedChange: (show: boolean) => void;
    onClose: () => void;
    onSubmit: () => Promise<void>;
    onOpenConnector: (connectorId: string) => void;
}) {
    const canSubmit =
        draft.name.trim().length > 0 &&
        draft.serverUrl.trim().length > 0 &&
        step !== "working" &&
        step !== "auth";

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={[
                "Connectors",
                step === "success"
                    ? "Connector added"
                    : step === "auth"
                      ? "Authenticate connector"
                      : "Add MCP connector",
            ]}
            size="lg"
            primaryAction={
                step === "success" && result
                    ? {
                          label: "View connector",
                          onClick: () => onOpenConnector(result.id),
                      }
                    : {
                          label:
                              step === "working"
                                  ? "Connecting..."
                                  : step === "auth"
                                    ? "Authorizing..."
                                  : "Connect",
                          icon:
                              step === "working" || step === "auth" ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                              ) : undefined,
                          onClick: () => void onSubmit(),
                          disabled: !canSubmit,
                      }
            }
            cancelAction={
                step === "working" || step === "auth"
                    ? false
                    : { label: step === "success" ? "Done" : "Cancel", onClick: onClose }
            }
            footerStatus={
                error ? (
                    <div className="rounded-xl border border-white/70 bg-white/75 px-3 py-2 text-sm text-red-600 shadow-[0_12px_32px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.75)] backdrop-blur-xl">
                        {error}
                    </div>
                ) : null
            }
        >
            {step === "success" && result ? (
                <SuccessToolsList connector={result} />
            ) : step === "auth" ? (
                <ConnectorAuthScreen
                    message={
                        authMessage ??
                        "Complete authorization in the popup to finish connecting this MCP server."
                    }
                />
            ) : (
                <div className="space-y-4 pb-4">
                    <p className="text-sm text-gray-500">
                        The assistant will have access to this MCP server and
                        its enabled tools.
                    </p>
                    <ConnectorForm
                        draft={draft}
                        showToken={showToken}
                        showAdvanced={showAdvanced}
                        showTokenNote
                        tokenPlaceholder="Bearer token"
                        disabled={step === "working"}
                        onDraftChange={(next) =>
                            onDraftChange({
                                name: next.name,
                                serverUrl: next.serverUrl,
                                bearerToken: next.bearerToken,
                                customHeaders: next.customHeaders,
                            })
                        }
                        onShowTokenChange={onShowTokenChange}
                        onShowAdvancedChange={onShowAdvancedChange}
                    />
                </div>
            )}
        </Modal>
    );
}

function McpConnectorDetailsModal({
    connector,
    draft,
    error,
    busyKey,
    toolsLoading,
    clearTokenStatus,
    showToken,
    showAdvanced,
    onDraftChange,
    onShowTokenChange,
    onShowAdvancedChange,
    onClose,
    onSave,
    onClearBearerToken,
    onRefresh,
    onDelete,
    onConnectorEnabled,
    onToolEnabled,
}: {
    connector: McpConnectorSummary | null;
    draft: DetailDraft;
    error: string | null;
    busyKey: string | null;
    toolsLoading: boolean;
    clearTokenStatus: "idle" | "clearing" | "cleared";
    showToken: boolean;
    showAdvanced: boolean;
    onDraftChange: (draft: DetailDraft) => void;
    onShowTokenChange: (show: boolean) => void;
    onShowAdvancedChange: (show: boolean) => void;
    onClose: () => void;
    onSave: () => Promise<void>;
    onClearBearerToken: (connectorId: string) => Promise<void>;
    onRefresh: (connectorId: string) => Promise<void>;
    onDelete: (connectorId: string) => Promise<void>;
    onConnectorEnabled: (
        connectorId: string,
        enabled: boolean,
    ) => Promise<void>;
    onToolEnabled: (
        connectorId: string,
        toolId: string,
        enabled: boolean,
    ) => Promise<void>;
}) {
    const hasChanges =
        !!connector &&
        (draft.name.trim() !== connector.name ||
            draft.serverUrl.trim() !== connector.serverUrl ||
            draft.bearerToken.trim().length > 0 ||
            draft.customHeaders.trim().length > 0);
    const isSaving = !!connector && busyKey === `save:${connector.id}`;

    return (
        <Modal
            open={!!connector}
            onClose={onClose}
            breadcrumbs={["Connectors", connector?.name ?? "MCP connector"]}
            headerAction={
                connector ? (
                    <AccountToggle
                        checked={connector.enabled}
                        disabled={busyKey === `connector:${connector.id}`}
                        loading={busyKey === `connector:${connector.id}`}
                        label={connector.enabled ? "Enabled" : "Disabled"}
                        onChange={(enabled) =>
                            void onConnectorEnabled(connector.id, enabled)
                        }
                    />
                ) : null
            }
            size="md"
            secondaryAction={
                connector
                    ? {
                          label: "Delete connector",
                          variant: "danger",
                          onClick: () => void onDelete(connector.id),
                          disabled: busyKey === `delete:${connector.id}`,
                      }
                    : undefined
            }
            primaryAction={{
                label: isSaving ? "Saving..." : "Save",
                icon: isSaving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                ) : undefined,
                onClick: () => void onSave(),
                disabled:
                    !connector ||
                    !hasChanges ||
                    isSaving ||
                    !draft.name.trim() ||
                    !draft.serverUrl.trim(),
            }}
            cancelAction={{ label: "Close", onClick: onClose }}
            footerStatus={
                error ? (
                    <span className="text-sm text-red-600">{error}</span>
                ) : null
            }
        >
            {connector && (
                <div className="flex min-h-0 flex-1 flex-col gap-5 pb-4">
                    <ConnectorForm
                        draft={draft}
                        showToken={showToken}
                        showAdvanced={showAdvanced}
                        tokenPlaceholder={
                            connector.hasAuthConfig
                                ? "Saved token encrypted"
                                : "Bearer token"
                        }
                        tokenAction={
                            connector.hasAuthConfig ||
                            clearTokenStatus === "cleared"
                                ? {
                                      label:
                                          clearTokenStatus === "cleared"
                                              ? "Cleared"
                                              : "Clear",
                                      loading:
                                          clearTokenStatus === "clearing",
                                      cleared:
                                          clearTokenStatus === "cleared",
                                      onClick: () =>
                                          void onClearBearerToken(connector.id),
                                  }
                                : undefined
                        }
                        onDraftChange={(next) =>
                            onDraftChange({
                                ...draft,
                                name: next.name,
                                serverUrl: next.serverUrl,
                                bearerToken: next.bearerToken,
                                customHeaders: next.customHeaders,
                            })
                        }
                        onShowTokenChange={onShowTokenChange}
                        onShowAdvancedChange={onShowAdvancedChange}
                    />
                    <div className="flex min-h-0 flex-1 flex-col">
                        <div className="mb-2 flex items-center justify-between">
                            <h3 className="text-xs font-medium text-gray-500">
                                {toolsLoading
                                    ? connector.toolCount
                                    : connector.tools.length}{" "}
                                {(toolsLoading
                                    ? connector.toolCount
                                    : connector.tools.length) === 1
                                    ? "Tool"
                                    : "Tools"}
                            </h3>
                            <div className="flex items-center">
                                <button
                                    type="button"
                                    onClick={() => void onRefresh(connector.id)}
                                    disabled={
                                        busyKey === `refresh:${connector.id}`
                                    }
                                    className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition-colors hover:text-gray-900 disabled:cursor-not-allowed disabled:text-gray-300"
                                >
                                    {busyKey === `refresh:${connector.id}` ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <RefreshCw className="h-3.5 w-3.5" />
                                    )}
                                    Refresh
                                </button>
                            </div>
                        </div>
                        {toolsLoading ? (
                            <ToolListSkeleton count={connector.toolCount} fill />
                        ) : (
                            <ScrollableToolList
                                connector={connector}
                                busyKey={busyKey}
                                onToolEnabled={onToolEnabled}
                                fill
                            />
                        )}
                    </div>
                </div>
            )}
        </Modal>
    );
}

function ConnectorForm({
    draft,
    showToken,
    showAdvanced,
    showTokenNote = false,
    tokenPlaceholder,
    tokenAction,
    disabled = false,
    onDraftChange,
    onShowTokenChange,
    onShowAdvancedChange,
}: {
    draft: AddDraft;
    showToken: boolean;
    showAdvanced: boolean;
    showTokenNote?: boolean;
    tokenPlaceholder: string;
    tokenAction?: {
        label: string;
        active?: boolean;
        loading?: boolean;
        cleared?: boolean;
        onClick: () => void;
    };
    disabled?: boolean;
    onDraftChange: (draft: AddDraft) => void;
    onShowTokenChange: (show: boolean) => void;
    onShowAdvancedChange: (show: boolean) => void;
}) {
    return (
        <div className="grid gap-3 pt-1">
            <label className="grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center">
                <span className="text-xs font-medium text-gray-500">
                    Label
                </span>
                <Input
                    value={draft.name}
                    onChange={(event) =>
                        onDraftChange({ ...draft, name: event.target.value })
                    }
                    placeholder="Connector label"
                    className={`h-8 text-sm ${accountGlassInputClassName}`}
                    disabled={disabled}
                />
            </label>
            <label className="grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center">
                <span className="text-xs font-medium text-gray-500">
                    URL endpoint
                </span>
                <Input
                    value={draft.serverUrl}
                    onChange={(event) =>
                        onDraftChange({
                            ...draft,
                            serverUrl: event.target.value,
                        })
                    }
                    placeholder="https://mcp.example.com/mcp"
                    className={`h-8 text-sm ${accountGlassInputClassName}`}
                    disabled={disabled}
                />
            </label>
            <div className="grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-start">
                <span className="pt-2 text-xs font-medium text-gray-500">
                    Bearer token
                </span>
                <div className="min-w-0">
                    <div className="relative">
                        <Input
                            value={draft.bearerToken}
                            onChange={(event) =>
                                onDraftChange({
                                    ...draft,
                                    bearerToken: event.target.value,
                                })
                            }
                            type={showToken ? "text" : "password"}
                            placeholder={tokenPlaceholder}
                            className={`h-8 ${
                                tokenAction
                                    ? draft.bearerToken
                                        ? "pr-[6.5rem]"
                                        : "pr-16"
                                    : "pr-10"
                            } text-sm ${accountGlassInputClassName}`}
                            autoComplete="off"
                            spellCheck={false}
                            disabled={disabled}
                        />
                        {draft.bearerToken && (
                            <button
                                type="button"
                                className={`absolute inset-y-1 ${
                                    tokenAction ? "right-[3.75rem]" : "right-1.5"
                                } flex items-center ${accountGlassIconButtonClassName}`}
                                onClick={() => onShowTokenChange(!showToken)}
                                aria-label={
                                    showToken ? "Hide token" : "Show token"
                                }
                                disabled={disabled}
                            >
                                {showToken ? (
                                    <EyeOff className="h-4 w-4" />
                                ) : (
                                    <Eye className="h-4 w-4" />
                                )}
                            </button>
                        )}
                        {tokenAction && (
                            <button
                                type="button"
                                onClick={tokenAction.onClick}
                                disabled={
                                    disabled ||
                                    tokenAction.loading ||
                                    tokenAction.cleared
                                }
                                className={`absolute inset-y-1 right-1.5 px-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:text-gray-300 ${
                                    tokenAction.active || tokenAction.cleared
                                        ? "text-red-600 hover:text-red-700"
                                        : "text-gray-500 hover:text-gray-900"
                                }`}
                            >
                                <span className="inline-flex items-center gap-1">
                                    {tokenAction.label}
                                    {tokenAction.loading && (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                    )}
                                </span>
                            </button>
                        )}
                    </div>
                    {showTokenNote && (
                        <p className="mt-1 text-right text-xs text-gray-500">
                            Tokens are stored encrypted.
                        </p>
                    )}
                </div>
            </div>
            <div className="grid gap-2">
                <button
                    type="button"
                    onClick={() => onShowAdvancedChange(!showAdvanced)}
                    className="inline-flex items-center gap-1 justify-self-start text-xs font-medium text-gray-500 transition-colors hover:text-gray-900"
                    disabled={disabled}
                >
                    Advanced
                    <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform ${
                            showAdvanced ? "" : "-rotate-90"
                        }`}
                    />
                </button>
                {showAdvanced && (
                    <label className="grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-start">
                        <span className="text-xs font-medium text-gray-500">
                            Custom headers
                        </span>
                        <div className="min-w-0">
                            <textarea
                                value={draft.customHeaders}
                                onChange={(event) =>
                                    onDraftChange({
                                        ...draft,
                                        customHeaders: event.target.value,
                                    })
                                }
                                placeholder='{"X-API-Key":"secret"}'
                                className={`min-h-20 w-full resize-y rounded-lg px-3 py-2 text-sm outline-none ${accountGlassInputClassName}`}
                                autoComplete="off"
                                spellCheck={false}
                                disabled={disabled}
                            />
                            <p className="mt-1 text-right text-xs text-gray-500">
                                Secrets are stored encrypted.
                            </p>
                        </div>
                    </label>
                )}
            </div>
        </div>
    );
}

function SuccessToolsList({ connector }: { connector: McpConnectorSummary }) {
    return (
        <div className="flex h-full min-h-0 flex-1 flex-col gap-4 pb-4">
            <div className="flex items-start gap-3 rounded-xl border border-green-100/80 bg-green-50/80 px-3 py-3 text-green-800 shadow-[0_3px_9px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_9px_rgba(255,255,255,0.05)] backdrop-blur-xl">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                        {connector.name} is connected.{" "}
                        <span className="font-normal text-green-700">
                        {connector.tools.length} tools discovered.
                        </span>
                    </p>
                </div>
            </div>
            <ScrollableToolList connector={connector} fill />
        </div>
    );
}

function ConnectorAuthScreen({ message }: { message: string }) {
    return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 pb-4 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/70 bg-white/75 text-gray-700 shadow-[0_3px_9px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_9px_rgba(255,255,255,0.05)] backdrop-blur-xl">
                <Loader2 className="h-4 w-4 animate-spin" />
            </div>
            <div className="max-w-sm space-y-1">
                <h3 className="text-sm font-medium text-gray-900">
                    Authentication required
                </h3>
                <p className="text-sm text-gray-500">{message}</p>
            </div>
        </div>
    );
}

function ToolListSkeleton({
    count,
    fill = false,
}: {
    count: number;
    fill?: boolean;
}) {
    const rowCount = Math.min(Math.max(count || 3, 3), 8);
    return (
        <div
            className={`overflow-hidden rounded-lg border border-gray-100 bg-white/60 ${
                fill ? "min-h-0 flex-1" : "max-h-72"
            }`}
        >
            <div className="divide-y divide-gray-100">
                {Array.from({ length: rowCount }).map((_, index) => (
                    <div key={index} className="px-3 py-2">
                        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
                            <div className="h-5 w-5" />
                            <div className="h-3.5 w-full max-w-[220px] animate-pulse rounded bg-gray-100" />
                            <div className="h-4 w-7 animate-pulse rounded-full bg-gray-100" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function ScrollableToolList({
    connector,
    busyKey,
    onToolEnabled,
    fill = false,
}: {
    connector: McpConnectorSummary;
    busyKey?: string | null;
    onToolEnabled?: (
        connectorId: string,
        toolId: string,
        enabled: boolean,
    ) => Promise<void>;
    fill?: boolean;
}) {
    const [expandedToolId, setExpandedToolId] = useState<string | null>(null);

    if (connector.tools.length === 0) {
        return (
            <div
                className={`rounded-lg bg-gray-50 px-3 py-3 text-sm text-gray-500 ${
                    fill ? "min-h-0 flex-1" : ""
                }`}
            >
                No tools discovered yet.
            </div>
        );
    }

    return (
        <div
            className={`overflow-y-auto rounded-lg border border-gray-100 bg-white/60 ${
                fill ? "min-h-0 flex-1" : "max-h-72"
            }`}
        >
            <div className="divide-y divide-gray-100">
                {connector.tools.map((tool) => {
                    const disabled =
                        !onToolEnabled ||
                        busyKey === `tool:${tool.id}` ||
                        tool.requiresConfirmation;
                    const isExpanded = expandedToolId === tool.id;
                    const toolLabel = tool.title || tool.toolName;
                    return (
                        <div key={tool.id} className="px-3 py-2">
                            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() =>
                                        setExpandedToolId(
                                            isExpanded ? null : tool.id,
                                        )
                                    }
                                    className="inline-flex h-5 w-5 items-center justify-center text-gray-400 transition-colors hover:text-gray-800"
                                    aria-label={`${
                                        isExpanded ? "Collapse" : "Expand"
                                    } ${toolLabel}`}
                                >
                                    <ChevronDown
                                        className={`h-3.5 w-3.5 transition-transform ${
                                            isExpanded ? "" : "-rotate-90"
                                        }`}
                                    />
                                </button>
                                <p className="min-w-0 truncate text-sm font-medium text-gray-800">
                                    {toolLabel}
                                </p>
                                {onToolEnabled ? (
                                    <AccountToggle
                                        checked={tool.enabled}
                                        disabled={disabled}
                                        loading={busyKey === `tool:${tool.id}`}
                                        onChange={(enabled) =>
                                            void onToolEnabled(
                                                connector.id,
                                                tool.id,
                                                enabled,
                                            )
                                        }
                                    />
                                ) : (
                                    <span
                                        className={`text-xs font-medium ${
                                            tool.enabled
                                                ? "text-green-600"
                                                : "text-gray-500"
                                        }`}
                                    >
                                        {tool.enabled ? "Enabled" : "Disabled"}
                                    </span>
                                )}
                            </div>
                            {isExpanded && (
                                <div className="ml-7 mt-2 min-w-0">
                                    {tool.requiresConfirmation && (
                                        <p className="text-xs font-medium text-amber-700">
                                            Confirmation required
                                        </p>
                                    )}
                                    {tool.description && (
                                        <p className="mt-1 text-xs text-gray-500">
                                            {tool.description}
                                        </p>
                                    )}
                                    <p className="mt-1 break-all font-mono text-[11px] text-gray-400">
                                        {tool.openaiToolName}
                                    </p>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
