"use client";

// Firm admin › Firm settings (WS8 PR C). Organisation admins only — the page
// gates on profile.isAdmin (and every /admin API route is gated server-side by
// requireAdmin). Three sections mirror the approved mock-up:
//   1. Members     — list + role badges + promote/demote (MFA-gated).
//   2. Firm API keys — per-provider shared keys used by all members.
//   3. Policies    — live toggles (WS8 PR B); enforced server-side + reflected
//                    in every member's account settings.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Info, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
    MfaVerificationPopup,
    needsMfaVerification,
} from "@/app/components/shared/MfaVerificationPopup";
import {
    expeditePendingDeletion,
    getConnectorGalleryCuration,
    getFirmApiKeyStatus,
    getFirmMembers,
    getPendingDeletions,
    isMfaRequiredError,
    MikeApiError,
    restorePendingDeletion,
    saveFirmApiKey,
    updateConnectorGalleryCuration,
    updateFirmMemberRole,
    updateFirmPolicies,
    updateFirmRetention,
    type ApiKeyProvider,
    type ConnectorRegistryAdminEntry,
    type FirmApiKeyStatus,
    type FirmMember,
    type GovernedResourceType,
    type OrganisationPolicies,
    type OrganisationRole,
    type PendingDeletion,
} from "@/app/lib/mikeApi";
import { AccountToggle } from "@/app/(pages)/account/AccountToggle";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";

const FIRM_API_KEY_FIELDS: {
    provider: ApiKeyProvider;
    label: string;
    placeholder: string;
}[] = [
    { provider: "claude", label: "Anthropic (Claude) API key", placeholder: "sk-ant-..." },
    { provider: "gemini", label: "Google (Gemini) API key", placeholder: "AI..." },
    { provider: "openai", label: "OpenAI API key", placeholder: "sk-..." },
    { provider: "openrouter", label: "OpenRouter API key", placeholder: "sk-or-..." },
    {
        provider: "companies_house",
        label: "Companies House API key",
        placeholder: "Your Companies House API key",
    },
];

function initials(member: FirmMember): string {
    const source = member.displayName || member.email || "?";
    return source.trim().charAt(0).toUpperCase() || "?";
}

/**
 * DD/MM/YYYY — never US order. Pinned to UTC to match the Dashboard's date
 * rendering, so the same timestamp never shows different days across the two
 * admin pages for a viewer near local midnight.
 */
function formatUkDate(value: string | null): string {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
        ? "—"
        : parsed.toLocaleDateString("en-GB", { timeZone: "UTC" });
}

// MFA step-up for a single mutation. `run(action)` runs the WHOLE action (which
// must include its own busy/success/error UI). If the session needs MFA — either
// proactively (needsMfaVerification) or reactively (the server 403s), in which
// case the action rethrows the mfa-required error — the entire action is stashed
// and replayed after the user verifies, so nothing shows "done" prematurely.
type MfaGuard = {
    run: (action: () => Promise<void>) => Promise<void>;
    popup: React.ReactNode;
};

function useMfaGuardedAction(): MfaGuard {
    const [pending, setPending] = useState<null | (() => Promise<void>)>(null);
    const run = useCallback(async (action: () => Promise<void>) => {
        try {
            if (await needsMfaVerification()) {
                setPending(() => action);
                return;
            }
            await action();
        } catch (error) {
            if (isMfaRequiredError(error)) {
                setPending(() => action);
                return;
            }
            throw error;
        }
    }, []);
    const popup = (
        <MfaVerificationPopup
            open={!!pending}
            onCancel={() => setPending(null)}
            onVerified={() => {
                const action = pending;
                setPending(null);
                if (action) void action();
            }}
        />
    );
    return { run, popup };
}

export default function FirmSettingsPage() {
    const router = useRouter();
    const { profile, loading: profileLoading } = useUserProfile();

    // Non-admins never see this page. Redirect once the profile has loaded and
    // confirms they are not an admin (avoids flashing on first paint).
    useEffect(() => {
        if (!profileLoading && profile && !profile.isAdmin) {
            router.replace("/assistant");
        }
    }, [profileLoading, profile, router]);

    if (profileLoading || !profile) {
        return (
            <div className="flex h-full items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </div>
        );
    }
    if (!profile.isAdmin) return null;

    return (
        <div className="flex h-full flex-col overflow-y-auto">
            <PageHeader
                shrink
                breadcrumbs={[
                    { label: "Firm admin" },
                    { label: "Firm settings" },
                ]}
            />
            <div className="mx-auto w-full max-w-4xl px-4 pb-16 md:px-10">
                <MembersSection />
                <FirmApiKeysSection />
                <PoliciesCard />
                <RetentionCard />
                <PendingDeletionsSection />
                <ConnectorsCurationCard />
            </div>
        </div>
    );
}

function SectionCard({
    title,
    description,
    action,
    children,
}: {
    title: string;
    description?: string;
    action?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <section className="mt-6 overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
                <div>
                    <h2 className="text-sm font-semibold text-gray-900">
                        {title}
                    </h2>
                    {description && (
                        <p className="mt-0.5 text-xs text-gray-500">
                            {description}
                        </p>
                    )}
                </div>
                {action}
            </div>
            {children}
        </section>
    );
}

// In-card load failure with in-place recovery (the Dashboard's ErrorState
// pattern, sized for a SectionCard row). Load errors use this; mutation
// errors keep their inline banners.
function LoadErrorRow({
    message,
    onRetry,
}: {
    message: string;
    onRetry: () => void;
}) {
    return (
        <div className="flex flex-col items-start gap-2.5 px-5 py-6">
            <p className="text-sm text-gray-600">{message}</p>
            <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
                <RefreshCw className="h-3.5 w-3.5" />
                Try again
            </button>
        </div>
    );
}

function RoleBadge({ role }: { role: OrganisationRole }) {
    return role === "admin" ? (
        <span className="inline-flex items-center rounded-full bg-gray-900 px-2.5 py-0.5 text-[11px] font-medium text-white">
            Admin
        </span>
    ) : (
        <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] font-medium text-gray-700">
            Member
        </span>
    );
}

function MembersSection() {
    const mfa = useMfaGuardedAction();
    const [members, setMembers] = useState<FirmMember[] | null>(null);
    const [loadError, setLoadError] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [busyUserId, setBusyUserId] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const list = await getFirmMembers();
                if (!active) return;
                setMembers(list);
                setLoadError(false);
            } catch {
                if (!active) return;
                setLoadError(true);
            }
        })();
        return () => {
            active = false;
        };
    }, [reloadKey]);

    // State reset lives in the handler, not the effect (set-state-in-effect).
    const retryLoad = () => {
        setLoadError(false);
        setMembers(null);
        setReloadKey((k) => k + 1);
    };

    const adminCount = (members ?? []).filter(
        (m) => m.role === "admin",
    ).length;

    const changeRole = (member: FirmMember, role: OrganisationRole) => {
        const verb = role === "admin" ? "make an admin" : "change to a member";
        const name = member.displayName || member.email || "this member";
        if (!window.confirm(`Are you sure you want to ${verb}: ${name}?`)) {
            return;
        }
        // The whole operation (busy + network + UI + error) is the guarded
        // action so it replays intact after an MFA step-up. mfa-required errors
        // are rethrown for the guard; everything else surfaces inline.
        void mfa.run(async () => {
            setBusyUserId(member.userId);
            setError(null);
            try {
                const updated = await updateFirmMemberRole(member.userId, role);
                setMembers((prev) =>
                    (prev ?? []).map((m) =>
                        m.userId === updated.userId
                            ? { ...m, role: updated.role }
                            : m,
                    ),
                );
            } catch (err) {
                if (isMfaRequiredError(err)) throw err;
                if (err instanceof MikeApiError && err.message) {
                    setError(err.message);
                } else {
                    setError("Could not update that member's role.");
                }
            } finally {
                setBusyUserId(null);
            }
        });
    };

    return (
        <>
        <SectionCard
            title="Members"
            description="Everyone in your firm and their role."
        >
            {error && (
                <p className="px-5 py-3 text-xs text-red-600">{error}</p>
            )}
            {loadError ? (
                <LoadErrorRow
                    message="Could not load the firm's members."
                    onRetry={retryLoad}
                />
            ) : members === null ? (
                <div className="space-y-2 px-5 py-4">
                    {[0, 1, 2].map((i) => (
                        <div
                            key={i}
                            className="h-6 w-full animate-pulse rounded bg-gray-100"
                        />
                    ))}
                </div>
            ) : members.length === 0 ? (
                <p className="px-5 py-6 text-sm text-gray-500">
                    No members to show.
                </p>
            ) : (
                <ul className="divide-y divide-gray-100">
                    {members.map((member) => {
                        // Guard the demote control for the last remaining admin
                        // so the UI matches the server's last-admin refusal.
                        const isLastAdmin =
                            member.role === "admin" && adminCount <= 1;
                        const busy = busyUserId === member.userId;
                        return (
                            <li
                                key={member.userId}
                                className="flex flex-wrap items-center gap-3 px-5 py-3.5"
                            >
                                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-700 font-serif text-xs text-white">
                                    {initials(member)}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm text-gray-900">
                                        {member.displayName ||
                                            member.email ||
                                            member.userId}
                                    </span>
                                    {member.displayName && member.email && (
                                        <span className="block truncate text-xs text-gray-400">
                                            {member.email}
                                        </span>
                                    )}
                                </span>
                                <RoleBadge role={member.role} />
                                <span className="hidden w-24 text-right text-xs tabular-nums text-gray-500 sm:block">
                                    {formatUkDate(member.createdAt)}
                                </span>
                                <span className="w-28 text-right">
                                    {busy ? (
                                        <Loader2 className="ml-auto h-4 w-4 animate-spin text-gray-400" />
                                    ) : member.role === "member" ? (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                changeRole(member, "admin")
                                            }
                                            className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950"
                                        >
                                            Make admin
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            disabled={isLastAdmin}
                                            title={
                                                isLastAdmin
                                                    ? "Your firm must keep at least one admin."
                                                    : undefined
                                            }
                                            onClick={() =>
                                                changeRole(member, "member")
                                            }
                                            className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-300"
                                        >
                                            Change to member
                                        </button>
                                    )}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}
            <div className="flex items-start gap-2.5 border-t border-gray-100 bg-gray-50 px-5 py-3.5">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                <p className="text-xs leading-relaxed text-gray-600">
                    New members join your firm by signing up with an invited
                    email address. Invitations are managed in Supabase for now —
                    a self-service invite flow is planned for a future update.
                </p>
            </div>
        </SectionCard>
        {mfa.popup}
        </>
    );
}

function FirmApiKeysSection() {
    const mfa = useMfaGuardedAction();
    const [status, setStatus] = useState<FirmApiKeyStatus | null>(null);
    const [loadError, setLoadError] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const next = await getFirmApiKeyStatus();
                if (active) {
                    setStatus(next);
                    setLoadError(false);
                }
            } catch {
                if (active) setLoadError(true);
            }
        })();
        return () => {
            active = false;
        };
    }, [reloadKey]);

    // State reset lives in the handler, not the effect (set-state-in-effect).
    const retryLoad = () => {
        setLoadError(false);
        setStatus(null);
        setReloadKey((k) => k + 1);
    };

    // Plain network mutation; the MFA step-up + busy/success UI are owned by the
    // row, which wraps this in mfa.run.
    const save = async (provider: ApiKeyProvider, value: string | null) => {
        setStatus(await saveFirmApiKey(provider, value));
    };

    return (
        <>
            <SectionCard
                title="Firm API keys"
                description="Used by all members — a member's own key always takes priority over the firm key."
            >
                {loadError ? (
                    // Resolve the skeleton on failure — an error over pulsing
                    // rows reads as "still loading" and never recovers.
                    <LoadErrorRow
                        message="Could not load the firm's API keys."
                        onRetry={retryLoad}
                    />
                ) : status === null ? (
                    // Skeleton while status loads, so a real "Not set" badge
                    // never flashes before the firm's keys are known.
                    <div className="space-y-4 px-5 py-4">
                        {FIRM_API_KEY_FIELDS.map((field) => (
                            <div key={field.provider} className="space-y-2">
                                <div className="h-4 w-48 animate-pulse rounded bg-gray-100" />
                                <div className="h-9 w-full animate-pulse rounded bg-gray-100" />
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="divide-y divide-gray-100">
                        {FIRM_API_KEY_FIELDS.map((field) => (
                            <FirmApiKeyRow
                                key={field.provider}
                                label={field.label}
                                placeholder={field.placeholder}
                                configured={!!status[field.provider]}
                                run={mfa.run}
                                onSave={(value) => save(field.provider, value)}
                            />
                        ))}
                    </div>
                )}
            </SectionCard>
            {mfa.popup}
        </>
    );
}

function FirmApiKeyRow({
    label,
    placeholder,
    configured,
    run,
    onSave,
}: {
    label: string;
    placeholder: string;
    configured: boolean;
    run: (action: () => Promise<void>) => Promise<void>;
    onSave: (value: string | null) => Promise<void>;
}) {
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const dirty = value.trim().length > 0;

    // The whole save (busy + network + success/error UI) is the guarded action,
    // so it replays intact after an MFA step-up and never shows "Saved" early.
    const runSave = (next: string | null) =>
        void run(async () => {
            setBusy(true);
            setError(null);
            try {
                await onSave(next);
                setValue("");
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
            } catch (err) {
                if (isMfaRequiredError(err)) throw err;
                if (err instanceof MikeApiError && err.message) {
                    setError(err.message);
                } else {
                    setError(`Could not update ${label}.`);
                }
            } finally {
                setBusy(false);
            }
        });

    return (
        <div className="px-5 py-4">
            <label className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-700">
                {label}
                {configured ? (
                    <span className="inline-flex items-center rounded-full border border-green-600/15 bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700">
                        Configured
                    </span>
                ) : (
                    <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                        Not set
                    </span>
                )}
            </label>
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    type="password"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={
                        configured ? "Enter a new key to replace it" : placeholder
                    }
                    className="min-w-0 flex-1 border-gray-200 bg-gray-50"
                    autoComplete="off"
                    spellCheck={false}
                />
                <button
                    type="button"
                    onClick={() => runSave(value.trim() || null)}
                    disabled={busy || !dirty || saved}
                    className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                >
                    {busy ? "Saving..." : saved ? "Saved" : configured ? "Replace" : "Save"}
                </button>
                {configured && (
                    <button
                        type="button"
                        onClick={() => runSave(null)}
                        disabled={busy}
                        className="text-xs font-medium text-red-600 transition-colors hover:text-red-700 disabled:cursor-not-allowed disabled:text-red-300"
                    >
                        Remove
                    </button>
                )}
            </div>
            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>
    );
}

const POLICY_ROWS: {
    key: keyof OrganisationPolicies;
    title: string;
    desc: string;
}[] = [
    {
        key: "memberApiKeys",
        title: "Members may add personal API keys",
        desc: "When off, the API Keys tab is hidden from members' account settings — removed, not disabled. Members rely on the firm keys above.",
    },
    {
        key: "memberMcpConnectors",
        title: "Members may add custom connectors",
        desc: "When off, the Connectors tab is hidden from members' account settings. Firm-managed connectors remain available to everyone in chat.",
    },
];

function PoliciesCard() {
    const mfa = useMfaGuardedAction();
    const { profile, reloadProfile } = useUserProfile();
    const [policies, setPolicies] = useState<OrganisationPolicies>(
        profile?.firm?.policies ?? {
            memberApiKeys: false,
            memberMcpConnectors: false,
        },
    );
    const [busyKey, setBusyKey] = useState<
        keyof OrganisationPolicies | null
    >(null);
    const [error, setError] = useState<string | null>(null);

    const toggle = (key: keyof OrganisationPolicies, next: boolean) => {
        const previous = policies[key];
        setError(null);
        // The whole update (optimistic flip + network + reconcile) is the
        // guarded action so it replays intact after an MFA step-up. On any
        // failure the optimistic flip is rolled back; mfa-required is rethrown
        // for the guard, everything else surfaces inline.
        void mfa.run(async () => {
            setBusyKey(key);
            setPolicies((current) => ({ ...current, [key]: next }));
            try {
                const updated = await updateFirmPolicies({ [key]: next });
                setPolicies(updated);
                // Refresh the profile so the admin's own account tabs reflect
                // the change immediately (their surfaces are gated too).
                await reloadProfile();
            } catch (err) {
                setPolicies((current) => ({ ...current, [key]: previous }));
                if (isMfaRequiredError(err)) throw err;
                if (err instanceof MikeApiError && err.message) {
                    setError(err.message);
                } else {
                    setError("Could not update that policy.");
                }
            } finally {
                setBusyKey(null);
            }
        });
    };

    return (
        <>
            <SectionCard
                title="Policies"
                description="Control what members can configure for themselves."
            >
                {error && (
                    <p className="px-5 py-3 text-xs text-red-600">{error}</p>
                )}
                <ul className="divide-y divide-gray-100">
                    {POLICY_ROWS.map((policy) => (
                        <li
                            key={policy.key}
                            className="flex items-start justify-between gap-4 px-5 py-4"
                        >
                            <div>
                                <p className="text-sm font-semibold text-gray-900">
                                    {policy.title}
                                </p>
                                <p className="mt-0.5 max-w-lg text-xs leading-relaxed text-gray-500">
                                    {policy.desc}
                                </p>
                            </div>
                            <div className="mt-0.5 shrink-0">
                                <AccountToggle
                                    size="md"
                                    checked={policies[policy.key]}
                                    loading={busyKey === policy.key}
                                    onChange={(next) =>
                                        toggle(policy.key, next)
                                    }
                                />
                            </div>
                        </li>
                    ))}
                </ul>
                <div className="flex items-start gap-2.5 border-t border-gray-100 bg-gray-50 px-5 py-3.5">
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                    <p className="text-xs leading-relaxed text-gray-600">
                        Changes take effect immediately. Turning a policy off
                        hides the matching tab from members&apos; account
                        settings — it is removed, not shown disabled.
                    </p>
                </div>
            </SectionCard>
            {mfa.popup}
        </>
    );
}

// Firm-configurable retention window for deletion governance (WS8 PR G) — how
// long a member's tombstoned item is held before permanent purge. Seeded from
// profile.firm.retentionDays; MFA-guarded save via PATCH /admin/retention.
function RetentionCard() {
    const mfa = useMfaGuardedAction();
    const { profile, reloadProfile } = useUserProfile();
    const currentRetention = profile?.firm?.retentionDays ?? 30;
    const [value, setValue] = useState(String(currentRetention));
    const [saved, setSaved] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setValue(String(currentRetention));
    }, [currentRetention]);

    const parsed = Number(value);
    const isValid =
        value.trim() !== "" &&
        Number.isInteger(parsed) &&
        parsed >= 1 &&
        parsed <= 365;
    const dirty = isValid && parsed !== currentRetention;

    const save = () => {
        if (!isValid) {
            setError("Enter a whole number of days between 1 and 365.");
            return;
        }
        setError(null);
        // The whole save (busy + network + reconcile) is the guarded action so
        // it replays intact after an MFA step-up.
        void mfa.run(async () => {
            setBusy(true);
            try {
                const stored = await updateFirmRetention(parsed);
                setValue(String(stored));
                await reloadProfile();
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
            } catch (err) {
                if (isMfaRequiredError(err)) throw err;
                if (err instanceof MikeApiError && err.message) {
                    setError(err.message);
                } else {
                    setError("Could not update the retention period.");
                }
            } finally {
                setBusy(false);
            }
        });
    };

    return (
        <>
            <SectionCard
                title="Deletion retention"
                description="How long a member's deleted item is held before it is permanently removed."
            >
                <div className="px-5 py-4">
                    <label
                        htmlFor="retention-days"
                        className="mb-2 block text-sm font-medium text-gray-700"
                    >
                        Retention period (days)
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            id="retention-days"
                            type="number"
                            min={1}
                            max={365}
                            step={1}
                            value={value}
                            onChange={(e) => {
                                setValue(e.target.value);
                                setSaved(false);
                                setError(null);
                            }}
                            className="w-28 border-gray-200 bg-gray-50"
                        />
                        <button
                            type="button"
                            onClick={save}
                            disabled={busy || !dirty || saved}
                            className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                        >
                            {busy ? "Saving..." : saved ? "Saved" : "Save"}
                        </button>
                    </div>
                    {error && (
                        <p className="mt-2 text-xs text-red-600">{error}</p>
                    )}
                </div>
            </SectionCard>
            {mfa.popup}
        </>
    );
}

const RESOURCE_TYPE_LABELS: Record<GovernedResourceType, string> = {
    project: "Matter",
    document: "Document",
    chat: "Chat",
    "tabular-review": "Tabular review",
    workflow: "Workflow",
};

function pendingDeletionKey(item: PendingDeletion): string {
    return `${item.resourceType}:${item.id}`;
}

// Pending deletions (WS8 PR G) — the firm's tombstoned items, awaiting either
// admin restore, admin expedite (immediate permanent delete), or the retention
// window elapsing. Restore/expedite are MFA-stepped-up server-side; the MFA
// handoff follows the manual needsMfaVerification()/isMfaRequiredError pattern
// used on privacy-data (not the generic useMfaGuardedAction hook), so the
// ConfirmPopup can hand off cleanly to the MfaVerificationPopup.
function PendingDeletionsSection() {
    const [items, setItems] = useState<PendingDeletion[] | null>(null);
    const [membersById, setMembersById] = useState<Record<string, string>>(
        {},
    );
    const [loadError, setLoadError] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [confirmTarget, setConfirmTarget] = useState<{
        item: PendingDeletion;
        kind: "restore" | "expedite";
    } | null>(null);
    const [mfaPending, setMfaPending] = useState<{
        item: PendingDeletion;
        kind: "restore" | "expedite";
    } | null>(null);
    const [busyKey, setBusyKey] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const [list, members] = await Promise.all([
                    getPendingDeletions(),
                    getFirmMembers().catch(() => [] as FirmMember[]),
                ]);
                if (!active) return;
                setItems(list);
                setMembersById(
                    Object.fromEntries(
                        members.map((m) => [
                            m.userId,
                            m.displayName || m.email || m.userId,
                        ]),
                    ),
                );
                setLoadError(false);
            } catch {
                if (!active) return;
                setLoadError(true);
            }
        })();
        return () => {
            active = false;
        };
    }, [reloadKey]);

    // State reset lives in the handler, not the effect (set-state-in-effect).
    const retryLoad = () => {
        setLoadError(false);
        setItems(null);
        setReloadKey((k) => k + 1);
    };

    const requestAction = (
        item: PendingDeletion,
        kind: "restore" | "expedite",
    ) => {
        setError(null);
        setConfirmTarget({ item, kind });
    };

    // The whole mutation (MFA check + network + list update) lives here so it
    // can be called both from the confirm popup and replayed after MFA
    // verification, mirroring privacy-data's handleDeleteData.
    const performAction = async (
        item: PendingDeletion,
        kind: "restore" | "expedite",
    ) => {
        setBusyKey(pendingDeletionKey(item));
        try {
            if (await needsMfaVerification()) {
                setConfirmTarget(null);
                setMfaPending({ item, kind });
                return;
            }
            if (kind === "restore") {
                await restorePendingDeletion(item.resourceType, item.id);
            } else {
                await expeditePendingDeletion(item.resourceType, item.id);
            }
            setItems((prev) =>
                (prev ?? []).filter(
                    (i) => pendingDeletionKey(i) !== pendingDeletionKey(item),
                ),
            );
            setConfirmTarget(null);
        } catch (err) {
            if (isMfaRequiredError(err)) {
                setConfirmTarget(null);
                setMfaPending({ item, kind });
                return;
            }
            setConfirmTarget(null);
            if (err instanceof MikeApiError && err.message) {
                setError(err.message);
            } else {
                setError(
                    kind === "restore"
                        ? "Could not restore that item."
                        : "Could not delete that item.",
                );
            }
        } finally {
            setBusyKey(null);
        }
    };

    const confirmBusy =
        !!confirmTarget && busyKey === pendingDeletionKey(confirmTarget.item);

    return (
        <>
            <SectionCard
                title="Pending deletions"
                description="Items your firm's members have deleted. They are held for the retention window above before permanent removal."
            >
                {error && (
                    <p className="px-5 py-3 text-xs text-red-600">{error}</p>
                )}
                {loadError ? (
                    <LoadErrorRow
                        message="Could not load pending deletions."
                        onRetry={retryLoad}
                    />
                ) : items === null ? (
                    <div className="space-y-2 px-5 py-4">
                        {[0, 1, 2].map((i) => (
                            <div
                                key={i}
                                className="h-6 w-full animate-pulse rounded bg-gray-100"
                            />
                        ))}
                    </div>
                ) : items.length === 0 ? (
                    <p className="px-5 py-6 text-sm text-gray-500">
                        No items awaiting deletion.
                    </p>
                ) : (
                    <ul className="divide-y divide-gray-100">
                        {items.map((item) => {
                            const rowBusy =
                                busyKey === pendingDeletionKey(item);
                            const requesterLabel = item.deletedBy
                                ? membersById[item.deletedBy] ||
                                  item.deletedBy
                                : "Unknown";
                            const typeLabel =
                                RESOURCE_TYPE_LABELS[item.resourceType];
                            return (
                                <li
                                    key={pendingDeletionKey(item)}
                                    className="flex flex-wrap items-center gap-3 px-5 py-3.5"
                                >
                                    <span className="inline-flex shrink-0 items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] font-medium text-gray-700">
                                        {typeLabel}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm text-gray-900">
                                            {item.displayName ||
                                                `Untitled ${typeLabel.toLowerCase()}`}
                                        </span>
                                        <span className="block truncate text-xs text-gray-400">
                                            Deleted by {requesterLabel}
                                        </span>
                                    </span>
                                    <span className="hidden w-24 text-right text-xs tabular-nums text-gray-500 sm:block">
                                        {formatUkDate(item.deletedAt)}
                                    </span>
                                    <span className="w-20 shrink-0 text-right text-xs tabular-nums text-gray-500">
                                        {item.daysRemaining}{" "}
                                        {item.daysRemaining === 1
                                            ? "day"
                                            : "days"}{" "}
                                        left
                                    </span>
                                    <span className="flex w-32 shrink-0 items-center justify-end gap-3">
                                        {rowBusy ? (
                                            <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                                        ) : (
                                            <>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        requestAction(
                                                            item,
                                                            "restore",
                                                        )
                                                    }
                                                    className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950"
                                                >
                                                    Restore
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        requestAction(
                                                            item,
                                                            "expedite",
                                                        )
                                                    }
                                                    className="text-xs font-medium text-red-600 transition-colors hover:text-red-700"
                                                >
                                                    Expedite
                                                </button>
                                            </>
                                        )}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                )}
                <div className="flex items-start gap-2.5 border-t border-gray-100 bg-gray-50 px-5 py-3.5">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                    <p className="text-xs leading-relaxed text-gray-600">
                        Restore returns an item to its owner. Expedite
                        permanently deletes it now, ahead of the retention
                        window — that cannot be undone.
                    </p>
                </div>
            </SectionCard>
            <ConfirmPopup
                open={!!confirmTarget}
                title={
                    confirmTarget?.kind === "restore"
                        ? "Restore this item?"
                        : "Delete this item permanently?"
                }
                message={
                    confirmTarget?.kind === "restore"
                        ? "This returns the item to its owner — it will reappear in their account."
                        : "This permanently deletes the item now, ahead of the retention window. This cannot be undone."
                }
                confirmLabel={
                    confirmTarget?.kind === "restore" ? "Restore" : "Delete"
                }
                confirmStatus={confirmBusy ? "loading" : "idle"}
                cancelLabel="Cancel"
                onCancel={() => {
                    if (confirmBusy) return;
                    setConfirmTarget(null);
                }}
                onConfirm={() => {
                    if (!confirmTarget) return;
                    void performAction(confirmTarget.item, confirmTarget.kind);
                }}
            />
            <MfaVerificationPopup
                open={!!mfaPending}
                onCancel={() => {
                    setMfaPending(null);
                    setBusyKey(null);
                }}
                onVerified={() => {
                    const target = mfaPending;
                    setMfaPending(null);
                    if (target) void performAction(target.item, target.kind);
                }}
                title="Two-factor verification required"
                message={
                    mfaPending?.kind === "expedite"
                        ? "Permanent deletion is sensitive. Enter a code from your authenticator app to continue."
                        : "This action is sensitive. Enter a code from your authenticator app to continue."
                }
            />
        </>
    );
}

// Firm curation of the connector gallery (WS8 PR E). A ticked connector is
// visible to members; the stored `enabledConnectorIds` empty array is the
// canonical "all visible" state, so an empty curation renders as everything
// ticked. When the admin ticks the whole list we save [] again (canonical).
function ConnectorsCurationCard() {
    const mfa = useMfaGuardedAction();
    const [registry, setRegistry] = useState<ConnectorRegistryAdminEntry[] | null>(
        null,
    );
    const [visible, setVisible] = useState<Set<string>>(new Set());
    const [busyId, setBusyId] = useState<string | null>(null);
    const [loadError, setLoadError] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const { registry: entries, enabledConnectorIds } =
                    await getConnectorGalleryCuration();
                if (!active) return;
                setRegistry(entries);
                // Empty curation ⇒ all visible.
                setVisible(
                    new Set(
                        enabledConnectorIds.length === 0
                            ? entries.map((e) => e.id)
                            : enabledConnectorIds,
                    ),
                );
                setLoadError(false);
            } catch {
                if (active) setLoadError(true);
            }
        })();
        return () => {
            active = false;
        };
    }, [reloadKey]);

    // State reset lives in the handler, not the effect (set-state-in-effect).
    const retryLoad = () => {
        setLoadError(false);
        setRegistry(null);
        setReloadKey((k) => k + 1);
    };

    const allVisible = !!registry && visible.size === registry.length;

    const toggle = (id: string, next: boolean) => {
        if (!registry) return;
        const previous = new Set(visible);
        const optimistic = new Set(visible);
        if (next) optimistic.add(id);
        else optimistic.delete(id);
        // An empty tick-list cannot be saved: the stored [] canonically means
        // "all visible", so unticking the last connector would silently invert
        // to showing everything. Block it and point at the real control.
        if (optimistic.size === 0) {
            setError(
                "At least one connector must stay ticked. To stop members adding connectors, turn off “Members may add custom connectors” in Policies above.",
            );
            return;
        }
        // Canonical form: a full tick-list is stored as [] ("all visible").
        const payload =
            optimistic.size === registry.length ? [] : [...optimistic];
        setError(null);
        void mfa.run(async () => {
            setBusyId(id);
            setVisible(optimistic);
            try {
                const saved = await updateConnectorGalleryCuration(payload);
                setVisible(
                    new Set(
                        saved.length === 0
                            ? registry.map((e) => e.id)
                            : saved,
                    ),
                );
            } catch (err) {
                setVisible(previous);
                if (isMfaRequiredError(err)) throw err;
                if (err instanceof MikeApiError && err.message) {
                    setError(err.message);
                } else {
                    setError("Could not update the connector list.");
                }
            } finally {
                setBusyId(null);
            }
        });
    };

    return (
        <>
            <SectionCard
                title="Connectors"
                description="Choose which connectors members can see and connect in their account settings."
            >
                {error && (
                    <p className="px-5 py-3 text-xs text-red-600">{error}</p>
                )}
                {loadError ? (
                    <LoadErrorRow
                        message="Could not load the connector list."
                        onRetry={retryLoad}
                    />
                ) : registry === null ? (
                    <div className="space-y-2 px-5 py-4">
                        {[0, 1, 2].map((i) => (
                            <div
                                key={i}
                                className="h-6 w-full animate-pulse rounded bg-gray-100"
                            />
                        ))}
                    </div>
                ) : registry.length === 0 ? (
                    <p className="px-5 py-6 text-sm text-gray-500">
                        No connectors to show.
                    </p>
                ) : (
                    <ul className="divide-y divide-gray-100">
                        {registry.map((entry) => (
                            <li
                                key={entry.id}
                                className="flex items-start gap-3 px-5 py-3.5"
                            >
                                <input
                                    id={`connector-${entry.id}`}
                                    type="checkbox"
                                    checked={visible.has(entry.id)}
                                    disabled={busyId === entry.id}
                                    onChange={(e) =>
                                        toggle(entry.id, e.target.checked)
                                    }
                                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 accent-gray-900"
                                />
                                <label
                                    htmlFor={`connector-${entry.id}`}
                                    className="min-w-0 flex-1 cursor-pointer"
                                >
                                    <span className="flex items-center gap-2 text-sm font-medium text-gray-900">
                                        {entry.name}
                                        <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                                            {entry.category}
                                        </span>
                                        {entry.availability === "custom" && (
                                            <span className="inline-flex items-center rounded-full border border-amber-600/20 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                                                Custom connector
                                            </span>
                                        )}
                                    </span>
                                    <span className="mt-0.5 block text-xs leading-relaxed text-gray-500">
                                        {entry.description}
                                    </span>
                                </label>
                                {busyId === entry.id && (
                                    <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-gray-400" />
                                )}
                            </li>
                        ))}
                    </ul>
                )}
                <div className="flex items-start gap-2.5 border-t border-gray-100 bg-gray-50 px-5 py-3.5">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                    <p className="text-xs leading-relaxed text-gray-600">
                        {allVisible
                            ? "All connectors are visible to members. Untick any you want to hide from their gallery."
                            : "Only the ticked connectors appear in members' gallery. Tick them all to show the full list."}{" "}
                        Members still need permission to add connectors (see the
                        policy above).
                    </p>
                </div>
            </SectionCard>
            {mfa.popup}
        </>
    );
}
