"use client";

import { useCallback, useEffect, useState } from "react";
import { Info, Loader2, RefreshCw } from "lucide-react";
import {
    type ClioProduct,
    type ClioProductStatus,
    type ClioStatus,
    disconnectClio,
    getClioStatus,
    isMfaRequiredError,
    startClioConnect,
} from "@/app/lib/mikeApi";
import {
    MfaVerificationPopup,
    needsMfaVerification,
} from "@/app/components/shared/MfaVerificationPopup";
import { Modal } from "@/app/components/shared/Modal";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { AccountSection } from "./AccountSection";

// Self-contained practice-management connector card (Clio). Rendered at the top
// of Account › Connectors, above the MCP gallery. Talks only to the Clio routes
// via mikeApi; owns its own status fetch, connect (OAuth popup) and MFA-gated
// disconnect. Kept as a clean seam per the licensing-optionality rule.

interface ProductMeta {
    product: ClioProduct;
    name: string;
    description: string;
    initial: string;
    tileClassName: string;
}

const PRODUCTS: ProductMeta[] = [
    {
        product: "manage",
        name: "Clio Manage",
        description: "Matters, time recording, WIP & balances, documents",
        initial: "C",
        // Clio brand blue — a coloured initial tile, not a logo asset.
        tileClassName: "bg-[#1656d8]",
    },
    {
        product: "grow",
        name: "Clio Grow",
        description:
            "Client intake pipeline, conflict-check & KYC status, intake notes",
        initial: "G",
        tileClassName: "bg-[#0d9488]",
    },
];

// Thrown when the 5-minute popup wait elapses without the popup landing back on
// our origin. Distinguished from other failures so the caller can re-check the
// connection status once before declaring failure — the backend callback can
// outrace a slow popup, leaving us connected despite the wait timing out.
class ClioPopupTimeout extends Error {
    constructor() {
        super("Connecting to Clio timed out.");
        this.name = "ClioPopupTimeout";
    }
}

// Opens the popup to the Clio authorise URL and resolves once it returns to our
// own origin. The backend OAuth callback (routes/clio.ts) redirects the browser
// back to /account/connectors?clio=<product>&clioStatus=<connected|error>, so —
// unlike the MCP popup helper, which awaits a postMessage from the backend — we
// poll the popup's location. Reads throw while it is still on Clio's / the API's
// domain (cross-origin), so those are swallowed until it lands back on us.
function waitForClioPopup(popup: Window): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
            () => {
                cleanup();
                reject(new ClioPopupTimeout());
            },
            5 * 60 * 1000,
        );
        const poll = window.setInterval(() => {
            let returned: URLSearchParams | null = null;
            try {
                const url = new URL(popup.location.href);
                if (
                    url.origin === window.location.origin &&
                    url.searchParams.get("clio")
                ) {
                    returned = url.searchParams;
                }
            } catch {
                // Still on Clio / the API — cross-origin read blocked. Keep polling.
            }
            if (returned) {
                cleanup();
                popup.close();
                if (returned.get("clioStatus") === "connected") {
                    resolve();
                } else {
                    reject(
                        new Error(
                            "Clio did not complete the connection. Please try again.",
                        ),
                    );
                }
                return;
            }
            if (popup.closed) {
                cleanup();
                reject(
                    new Error(
                        "The Clio window was closed before connecting finished.",
                    ),
                );
            }
        }, 600);
        const cleanup = () => {
            window.clearTimeout(timeout);
            window.clearInterval(poll);
        };
    });
}

function StatePill({
    product,
    status,
}: {
    product: ClioProduct;
    status: ClioProductStatus;
}) {
    if (!status.connected) {
        if (!status.configured) {
            return (
                <span
                    title="Not configured on this deployment."
                    aria-label="Not available: not configured on this deployment."
                    className="inline-flex flex-none items-center rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium whitespace-nowrap text-gray-500"
                >
                    Not available
                </span>
            );
        }
        return (
            <span className="inline-flex flex-none items-center rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium whitespace-nowrap text-gray-500">
                Not connected
            </span>
        );
    }
    let label = status.clioUserName
        ? `Connected as ${status.clioUserName}`
        : "Connected";
    if (product === "manage" && typeof status.mattersVisible === "number") {
        const noun = status.mattersVisible === 1 ? "matter" : "matters";
        label += ` · ${status.mattersVisible} ${noun} visible`;
    }
    return (
        <span className="inline-flex flex-none items-center gap-1.5 rounded-full border border-green-700/15 bg-green-50 px-2.5 py-1 text-[11px] font-medium whitespace-nowrap text-green-800">
            <span
                className="h-1.5 w-1.5 rounded-full bg-green-600"
                aria-hidden="true"
            />
            {label}
        </span>
    );
}

export function ClioConnectorCard() {
    const { reloadProfile } = useUserProfile();
    const [status, setStatus] = useState<ClioStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [busyProduct, setBusyProduct] = useState<ClioProduct | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [confirmProduct, setConfirmProduct] = useState<ClioProduct | null>(
        null,
    );
    const [pendingMfaProduct, setPendingMfaProduct] =
        useState<ClioProduct | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setLoadError(false);
        try {
            setStatus(await getClioStatus());
        } catch {
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    // Re-fetch after an action without the full loading shell — a transient
    // refresh failure keeps the last-known status rather than blanking the card.
    const refresh = async () => {
        try {
            setStatus(await getClioStatus());
        } catch {
            // Keep the current status.
        }
    };

    const handleConnect = async (product: ClioProduct) => {
        setActionError(null);
        const popup = window.open(
            "about:blank",
            "clio_oauth",
            "popup,width=560,height=720,menubar=no,toolbar=no,location=no,status=no",
        );
        setBusyProduct(product);
        try {
            const { authorizationUrl } = await startClioConnect(product);
            if (!authorizationUrl) {
                throw new Error("Clio did not return an authorisation link.");
            }
            if (!popup) {
                window.location.assign(authorizationUrl);
                return;
            }
            popup.location.href = authorizationUrl;
            await waitForClioPopup(popup);
            await refresh();
            await reloadProfile();
        } catch (err) {
            popup?.close();
            if (err instanceof ClioPopupTimeout) {
                // The wait elapsed, but the backend callback may have completed
                // the connection anyway. Re-check status once before declaring
                // failure so a slow-but-successful connect self-heals.
                try {
                    const latest = await getClioStatus();
                    setStatus(latest);
                    if (latest[product]?.connected) {
                        await reloadProfile();
                        return;
                    }
                } catch {
                    // Status re-check failed — fall through to the timeout message.
                }
                setActionError("Connecting to Clio timed out. Please try again.");
                return;
            }
            setActionError(
                err instanceof Error
                    ? err.message
                    : "Could not connect to Clio.",
            );
        } finally {
            setBusyProduct(null);
        }
    };

    const performDisconnect = async (product: ClioProduct) => {
        const previous = status;
        setActionError(null);
        setBusyProduct(product);
        // Optimistic: flip the row to disconnected, roll back on failure.
        if (status) {
            setStatus({
                ...status,
                [product]: {
                    ...status[product],
                    connected: false,
                    clioUserName: null,
                },
            });
        }
        try {
            await disconnectClio(product);
            await refresh();
            await reloadProfile();
        } catch (err) {
            setStatus(previous);
            if (isMfaRequiredError(err)) {
                setPendingMfaProduct(product);
                return;
            }
            setActionError(
                err instanceof Error
                    ? err.message
                    : "Could not disconnect from Clio.",
            );
        } finally {
            setBusyProduct(null);
        }
    };

    const requestDisconnect = async (product: ClioProduct) => {
        setConfirmProduct(null);
        setActionError(null);
        try {
            if (await needsMfaVerification()) {
                setPendingMfaProduct(product);
                return;
            }
        } catch {
            // If the assurance-level probe fails, fall through — the server still
            // enforces MFA and returns mfa_verification_required, replayed below.
        }
        await performDisconnect(product);
    };

    const handleMfaVerified = () => {
        const product = pendingMfaProduct;
        setPendingMfaProduct(null);
        if (product) void performDisconnect(product);
    };

    const anyConfigured =
        !!status && (status.manage.configured || status.grow.configured);

    return (
        <AccountSection className="mb-6 overflow-hidden">
            <div className="border-b border-gray-100 px-5 py-4">
                <h3 className="text-sm font-semibold text-gray-900">
                    Practice management — Clio
                </h3>
                <p className="mt-0.5 text-xs text-gray-500">
                    Connect your own Clio logins. Jessica only ever sees what
                    your Clio permissions allow.
                </p>
            </div>

            {loading ? (
                <div className="divide-y divide-gray-100">
                    {[0, 1].map((i) => (
                        <div
                            key={i}
                            className="flex items-center gap-3.5 px-5 py-3.5"
                        >
                            <div className="h-9 w-9 flex-none animate-pulse rounded-lg bg-gray-100" />
                            <div className="min-w-0 flex-1 space-y-1.5">
                                <div className="h-3.5 w-28 animate-pulse rounded bg-gray-100" />
                                <div className="h-3 w-56 max-w-full animate-pulse rounded bg-gray-100" />
                            </div>
                            <div className="h-8 w-24 animate-pulse rounded-lg bg-gray-100" />
                        </div>
                    ))}
                </div>
            ) : loadError ? (
                <div className="flex flex-col items-start gap-2.5 px-5 py-6">
                    <p className="text-sm text-gray-600">
                        Couldn’t load your Clio connection status.
                    </p>
                    <button
                        type="button"
                        onClick={() => void load()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
                    >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Try again
                    </button>
                </div>
            ) : !anyConfigured ? (
                <div className="px-5 py-4">
                    <p className="text-sm text-gray-500">
                        Clio is not configured on this deployment.
                    </p>
                </div>
            ) : (
                <>
                    <div className="divide-y divide-gray-100">
                        {PRODUCTS.map((meta) => {
                            const ps = status![meta.product];
                            const busy = busyProduct === meta.product;
                            return (
                                <div
                                    key={meta.product}
                                    className="flex items-center gap-3.5 px-5 py-3.5"
                                >
                                    <span
                                        className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg text-base font-bold text-white ${meta.tileClassName}`}
                                        aria-hidden="true"
                                    >
                                        {meta.initial}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <div className="text-sm font-semibold text-gray-900">
                                            {meta.name}
                                        </div>
                                        <div className="mt-0.5 text-xs text-gray-500">
                                            {meta.description}
                                        </div>
                                    </div>
                                    <StatePill
                                        product={meta.product}
                                        status={ps}
                                    />
                                    {ps.connected ? (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setConfirmProduct(meta.product)
                                            }
                                            disabled={busyProduct !== null}
                                            aria-label={`Disconnect ${meta.name}`}
                                            className="inline-flex h-8 flex-none items-center gap-1.5 rounded-lg border border-gray-200 px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45"
                                        >
                                            {busy ? (
                                                <>
                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    Disconnecting…
                                                </>
                                            ) : (
                                                "Disconnect"
                                            )}
                                        </button>
                                    ) : ps.configured ? (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void handleConnect(meta.product)
                                            }
                                            disabled={busyProduct !== null}
                                            aria-label={`Connect ${meta.name}`}
                                            className="inline-flex h-8 flex-none items-center gap-1.5 rounded-lg bg-gray-900 px-3 text-xs font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-45"
                                        >
                                            {busy ? (
                                                <>
                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    Connecting…
                                                </>
                                            ) : (
                                                "Connect"
                                            )}
                                        </button>
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>

                    {actionError && (
                        <div
                            role="alert"
                            className="border-t border-gray-100 px-5 py-2.5 text-xs text-red-600"
                        >
                            {actionError}
                        </div>
                    )}

                    <div className="flex gap-2 border-t border-gray-100 bg-gray-50/60 px-5 py-3">
                        <Info
                            className="mt-0.5 h-3.5 w-3.5 flex-none text-gray-400"
                            aria-hidden="true"
                        />
                        <p className="text-xs text-gray-500">
                            Each connection uses your personal Clio login —
                            colleagues never share access. The “matters visible”
                            count is your own Clio permission set, so you can
                            sanity-check it against Clio itself.
                        </p>
                    </div>
                </>
            )}

            <Modal
                open={confirmProduct !== null}
                onClose={() => setConfirmProduct(null)}
                title="Disconnect Clio?"
                size="sm"
                primaryAction={{
                    label: "Disconnect",
                    variant: "danger",
                    onClick: () =>
                        confirmProduct && void requestDisconnect(confirmProduct),
                }}
                cancelAction={{
                    label: "Cancel",
                    onClick: () => setConfirmProduct(null),
                }}
            >
                <p className="text-sm text-gray-600">
                    {confirmProduct === "grow" ? "Clio Grow" : "Clio Manage"}{" "}
                    will be disconnected and Jessica will lose access until you
                    reconnect. Reconnecting after a permissions change asks Clio
                    for fresh consent.
                </p>
            </Modal>

            <MfaVerificationPopup
                open={pendingMfaProduct !== null}
                onCancel={() => setPendingMfaProduct(null)}
                onVerified={() => handleMfaVerified()}
            />
        </AccountSection>
    );
}
