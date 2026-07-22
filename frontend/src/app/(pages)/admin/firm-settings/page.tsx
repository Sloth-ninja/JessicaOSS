"use client";

// Firm admin › Firm settings (WS8 PR C). Organisation admins only — the page
// gates on profile.isAdmin (and every /admin API route is gated server-side by
// requireAdmin). Three sections mirror the approved mock-up:
//   1. Members     — list + role badges + promote/demote (MFA-gated).
//   2. Firm API keys — per-provider shared keys used by all members.
//   3. Policies    — SHOWN but read-only; enforcement lands in a later update.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Info, Loader2, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
    MfaVerificationPopup,
    needsMfaVerification,
} from "@/app/components/shared/MfaVerificationPopup";
import {
    getFirmApiKeyStatus,
    getFirmMembers,
    isMfaRequiredError,
    MikeApiError,
    saveFirmApiKey,
    updateFirmMemberRole,
    type ApiKeyProvider,
    type FirmApiKeyStatus,
    type FirmMember,
    type OrganisationRole,
} from "@/app/lib/mikeApi";

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

/** DD/MM/YYYY — never US order. */
function formatUkDate(value: string | null): string {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
        ? "—"
        : parsed.toLocaleDateString("en-GB");
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
    const [error, setError] = useState<string | null>(null);
    const [busyUserId, setBusyUserId] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const list = await getFirmMembers();
                if (!active) return;
                setMembers(list);
                setError(null);
            } catch {
                if (!active) return;
                setMembers([]);
                setError("Could not load the firm's members.");
            }
        })();
        return () => {
            active = false;
        };
    }, []);

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
            {members === null ? (
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
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const next = await getFirmApiKeyStatus();
                if (active) {
                    setStatus(next);
                    setError(null);
                }
            } catch {
                if (active) setError("Could not load the firm's API keys.");
            }
        })();
        return () => {
            active = false;
        };
    }, []);

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
                {error && (
                    <p className="px-5 py-3 text-xs text-red-600">{error}</p>
                )}
                {status === null ? (
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

function PoliciesCard() {
    const policies = [
        {
            title: "Members may add personal API keys",
            desc: "When off, the API Keys tab is hidden from members' account settings. Members rely on the firm keys above.",
        },
        {
            title: "Members may add custom connectors",
            desc: "When off, the Add custom connector option is hidden from members' Connectors gallery. Firm-managed connectors remain visible to everyone.",
        },
    ];
    return (
        <SectionCard
            title="Policies"
            description="Control what members can configure for themselves."
        >
            <ul className="divide-y divide-gray-100">
                {policies.map((policy) => (
                    <li
                        key={policy.title}
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
                        {/* Read-only placeholder toggle — enforcement is not yet
                            wired up, so it is deliberately disabled. */}
                        <span
                            aria-disabled="true"
                            title="Enforced in the next update"
                            className="mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-gray-200 p-0.5 opacity-60"
                        >
                            <span className="h-4 w-4 rounded-full bg-white shadow-sm" />
                        </span>
                    </li>
                ))}
            </ul>
            <div className="flex items-start gap-2.5 border-t border-gray-100 bg-gray-50 px-5 py-3.5">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                <p className="text-xs leading-relaxed text-gray-600">
                    Policy enforcement is coming in the next update. These
                    controls are shown here as a preview and cannot be changed
                    yet.
                </p>
            </div>
        </SectionCard>
    );
}
