"use client";

import { useEffect, useState } from "react";
import { User, UserPlus, Loader2, Plus, Info } from "lucide-react";
import {
    getFirmMemberSuggestions,
    type FirmMemberSuggestion,
    type FirmVisibility,
    type ProjectPeople,
} from "@/app/lib/mikeApi";
import { AccountToggle } from "@/app/(pages)/account/AccountToggle";
import { ConfirmPopup } from "./ConfirmPopup";
import { Modal } from "./Modal";

/**
 * Any resource the modal can manage members for — projects today, tabular
 * reviews now, anything else with a `shared_with` email list later.
 */
export interface SharedResource {
    id: string;
    shared_with?: string[] | null;
}

interface Props {
    open: boolean;
    onClose: () => void;
    /** The thing being shared (project, review, …). */
    resource: SharedResource | null;
    /**
     * Resolve the owner + members roster for the given resource. Different
     * resource types hit different endpoints (`/projects/:id/people`,
     * `/tabular-review/:id/people`, …) so the caller passes the appropriate
     * fetcher.
     */
    fetchPeople: (id: string) => Promise<ProjectPeople>;
    /** Currently signed-in user's email — gets the "You" tag if it matches. */
    currentUserEmail?: string | null;
    breadcrumb: string[];
    /**
     * Persist a new shared_with list. Parent should PATCH the resource and
     * sync its local state on success. Throw to surface an error inline.
     */
    onSharedWithChange?: (sharedWith: string[]) => Promise<void> | void;
    /**
     * The caller's firm name (WS9). When set, orgless users are unaffected;
     * firm members get the firm-member share suggestions and — for an item they
     * own — the "Visible to everyone at <firm>" control. Null/undefined ⇒ no
     * firm surfaces at all.
     */
    firmName?: string | null;
    /** Noun used in the firm-visibility copy. Defaults to "matter". */
    resourceKind?: "matter" | "review";
    /** Current firm visibility of the item ('private' when absent). */
    firmVisibility?: FirmVisibility;
    /**
     * Persist a firm-visibility flip (owner only). When provided, the toggle is
     * shown; throw to surface an inline error (the optimistic flip is rolled
     * back). Omitted ⇒ no toggle (non-owner, or see `firmVisibilityInherited`).
     */
    onFirmVisibilityChange?: (next: FirmVisibility) => Promise<void>;
    /**
     * True for a project-scoped review: it inherits its matter's visibility, so
     * the toggle is replaced by an explanatory note.
     */
    firmVisibilityInherited?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type RosterRow = {
    email: string;
    display_name: string | null;
    role: "owner" | "member";
};

/**
 * Roster of every Mike member with access to the project, with controls to
 * add/remove members. Mirrors AddDocumentsModal's frame.
 */
export function PeopleModal({
    open,
    onClose,
    resource,
    fetchPeople,
    currentUserEmail,
    breadcrumb,
    onSharedWithChange,
    firmName,
    resourceKind = "matter",
    firmVisibility,
    onFirmVisibilityChange,
    firmVisibilityInherited,
}: Props) {
    const [newEmail, setNewEmail] = useState("");
    const [busy, setBusy] = useState<"add" | "remove" | null>(null);
    const [removingEmail, setRemovingEmail] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Firm-member share suggestions (WS9) — fetched once per open when the
    // caller belongs to a firm and can edit membership.
    const [firmMembers, setFirmMembers] = useState<FirmMemberSuggestion[]>([]);

    // Firm-visibility control state. `firmVisibilityLocal` mirrors the prop but
    // flips optimistically so the toggle responds instantly; it rolls back on a
    // failed persist.
    const [firmVisibilityLocal, setFirmVisibilityLocal] =
        useState<FirmVisibility>(firmVisibility ?? "private");
    const [firmBusy, setFirmBusy] = useState(false);
    const [firmError, setFirmError] = useState<string | null>(null);
    const [confirmShareOpen, setConfirmShareOpen] = useState(false);

    // Server-resolved roster: owner email/display_name + members'
    // display_names. We keep `resource.shared_with` as the source of truth
    // for membership and just merge display_names from this fetch.
    const [people, setPeople] = useState<ProjectPeople | null>(null);
    const [peopleLoading, setPeopleLoading] = useState(false);

    const resourceId = resource?.id ?? null;
    const sharedWith: string[] = Array.isArray(resource?.shared_with)
        ? (resource!.shared_with as string[])
        : [];

    useEffect(() => {
        if (!open) return;
        setNewEmail("");
        setError(null);
        setBusy(null);
        setRemovingEmail(null);
        setFirmError(null);
        setConfirmShareOpen(false);
    }, [open]);

    // Keep the optimistic toggle in step with the parent's value.
    useEffect(() => {
        setFirmVisibilityLocal(firmVisibility ?? "private");
    }, [firmVisibility]);

    // Firm-member suggestions: only when the caller has a firm and may edit the
    // member list. Failure leaves the list empty (the modal still works on
    // free-typed emails), never an error.
    const canEditMembers = !!onSharedWithChange;
    const showFirmSurfaces = !!firmName;
    useEffect(() => {
        if (!open || !showFirmSurfaces || !canEditMembers) {
            setFirmMembers([]);
            return;
        }
        let cancelled = false;
        getFirmMemberSuggestions()
            .then((members) => {
                if (!cancelled) setFirmMembers(members);
            })
            .catch(() => {
                /* no suggestions on failure */
            });
        return () => {
            cancelled = true;
        };
    }, [open, showFirmSurfaces, canEditMembers]);

    // Re-fetch roster whenever the modal opens or membership changes —
    // keyed by the joined shared_with list so add/remove triggers a refresh.
    const sharedKey = sharedWith
        .map((e) => e.toLowerCase())
        .sort()
        .join(",");

    useEffect(() => {
        if (!open || !resourceId) return;
        let cancelled = false;
        setPeopleLoading(true);
        fetchPeople(resourceId)
            .then((data) => {
                if (cancelled) return;
                setPeople(data);
            })
            .catch(() => {
                /* keep stale data; modal still works on emails alone */
            })
            .finally(() => {
                if (!cancelled) setPeopleLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, resourceId, sharedKey, fetchPeople]);

    if (!open || !resource) return null;

    const memberDisplayByEmail = new Map<string, string | null>();
    for (const m of people?.members ?? []) {
        memberDisplayByEmail.set(m.email.toLowerCase(), m.display_name);
    }
    const ownerEmail = people?.owner.email ?? null;
    const ownerDisplayName = people?.owner.display_name ?? null;

    const roster: RosterRow[] = [];
    if (ownerEmail) {
        roster.push({
            email: ownerEmail,
            display_name: ownerDisplayName,
            role: "owner",
        });
    }
    for (const email of sharedWith) {
        const lower = email.toLowerCase();
        if (ownerEmail && lower === ownerEmail.toLowerCase()) continue;
        roster.push({
            email,
            display_name: memberDisplayByEmail.get(lower) ?? null,
            role: "member",
        });
    }

    const trimmedNewEmail = newEmail.trim().toLowerCase();
    const normalizedCurrentUserEmail =
        currentUserEmail?.trim().toLowerCase() ?? null;
    const isValidEmail = EMAIL_RE.test(trimmedNewEmail);
    const sharedLower = sharedWith.map((e) => e.toLowerCase());
    const alreadyShared = sharedLower.includes(trimmedNewEmail);
    const isOwnerEmail =
        !!ownerEmail && trimmedNewEmail === ownerEmail.toLowerCase();
    const isSelfEmail =
        !!normalizedCurrentUserEmail &&
        trimmedNewEmail === normalizedCurrentUserEmail;
    const canAdd =
        isValidEmail &&
        !alreadyShared &&
        !isOwnerEmail &&
        !isSelfEmail &&
        busy === null;

    // Shared add path for both the email input and the firm suggestions. The
    // caller is responsible for having validated `email` (a valid, not-already-
    // present, non-owner, non-self address).
    async function addEmail(email: string) {
        if (!onSharedWithChange || busy !== null) return;
        setBusy("add");
        setError(null);
        try {
            await onSharedWithChange([...sharedWith, email]);
            setNewEmail("");
        } catch (e) {
            setError(
                e instanceof Error
                    ? e.message
                    : "Couldn't add the member. Try again.",
            );
        } finally {
            setBusy(null);
        }
    }

    async function handleAdd() {
        if (!canAdd) return;
        await addEmail(trimmedNewEmail);
    }

    // Firm suggestions not already on the item (and never the owner or you).
    const firmSuggestions = firmMembers.filter((member) => {
        const email = member.email?.trim().toLowerCase();
        if (!email) return false;
        if (sharedLower.includes(email)) return false;
        if (ownerEmail && email === ownerEmail.toLowerCase()) return false;
        if (email === normalizedCurrentUserEmail) return false;
        return true;
    });

    // Persist a firm-visibility flip with an optimistic toggle + rollback.
    async function applyVisibility(next: FirmVisibility) {
        if (!onFirmVisibilityChange || firmBusy) return;
        const previous = firmVisibilityLocal;
        setFirmVisibilityLocal(next);
        setFirmBusy(true);
        setFirmError(null);
        try {
            await onFirmVisibilityChange(next);
        } catch (e) {
            setFirmVisibilityLocal(previous);
            setFirmError(
                e instanceof Error
                    ? e.message
                    : "Couldn't update firm visibility. Try again.",
            );
        } finally {
            setFirmBusy(false);
        }
    }

    // Confirm before turning ON (the whole firm gains access); OFF is immediate.
    function handleVisibilityToggle(next: boolean) {
        if (next) setConfirmShareOpen(true);
        else void applyVisibility("private");
    }

    const noun = resourceKind === "review" ? "review" : "matter";
    const firmShareDescription =
        resourceKind === "review"
            ? "Everyone in your firm can open this review and its documents, and use it in AI chat. They can't delete or manage it. Shown in the Firm library."
            : "Everyone in your firm can open this matter, its documents and its chats, and use it in AI chat. They can't delete or manage it. Shown in the Firm library.";
    const firmShareConfirmMessage =
        resourceKind === "review"
            ? `Everyone at ${firmName} will be able to open this review and its documents, and use it in AI chat. They can't delete or manage it, and it will appear in the Firm library. Firm admins can turn it off later.`
            : `Everyone at ${firmName} will be able to open this matter, its documents and its chats, and use it in AI chat. They can't delete or manage it, and it will appear in the Firm library. Firm admins can turn it off later.`;

    async function handleRemove(email: string) {
        if (!onSharedWithChange || busy !== null) return;
        setBusy("remove");
        setRemovingEmail(email);
        setError(null);
        try {
            const next = sharedWith.filter(
                (e) => e.toLowerCase() !== email.toLowerCase(),
            );
            await onSharedWithChange(next);
        } catch (e) {
            setError(
                e instanceof Error
                    ? e.message
                    : "Couldn't remove the member. Try again.",
            );
        } finally {
            setBusy(null);
            setRemovingEmail(null);
        }
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={breadcrumb}
            footerInfo={
                roster.length === 0
                    ? "No one has access yet."
                    : `${roster.length} ${
                          roster.length === 1 ? "person" : "people"
                      } with access.`
            }
        >
            <div className="flex min-h-0 flex-1 flex-col gap-6">
                {/* Add-member row */}
                {onSharedWithChange && (
                    <section className="space-y-2">
                        <div className="flex items-center gap-2">
                            <div className="flex flex-1 items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                                <UserPlus className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                                <input
                                    type="email"
                                    placeholder={
                                        showFirmSurfaces && canEditMembers
                                            ? "Add from your firm, or type any email…"
                                            : "Add by email…"
                                    }
                                    value={newEmail}
                                    onChange={(e) =>
                                        setNewEmail(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") void handleAdd();
                                    }}
                                    className="flex-1 bg-transparent text-sm text-gray-700 placeholder:text-gray-400 outline-none"
                                    autoFocus
                                />
                            </div>
                            <button
                                onClick={() => void handleAdd()}
                                disabled={!canAdd}
                                title="Add member"
                                className="inline-flex items-center justify-center rounded-lg border border-gray-900 bg-gray-900 p-2 text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {busy === "add" ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Plus className="h-3.5 w-3.5" />
                                )}
                            </button>
                        </div>
                        {alreadyShared && trimmedNewEmail && (
                            <p className="mt-1.5 text-xs text-gray-400">
                                {trimmedNewEmail} already has access.
                            </p>
                        )}
                        {isOwnerEmail && trimmedNewEmail && (
                            <p className="mt-1.5 text-xs text-gray-400">
                                {trimmedNewEmail} is the owner.
                            </p>
                        )}
                        {isSelfEmail && !isOwnerEmail && trimmedNewEmail && (
                            <p className="mt-1.5 text-xs text-gray-400">
                                You cannot share this with yourself.
                            </p>
                        )}
                        {trimmedNewEmail &&
                            !isValidEmail &&
                            !alreadyShared &&
                            !isOwnerEmail &&
                            !isSelfEmail && (
                                <p className="mt-1.5 text-xs text-gray-400">
                                    Enter a valid email.
                                </p>
                            )}
                        {error && (
                            <p className="mt-1.5 text-xs text-red-500">
                                {error}
                            </p>
                        )}

                        {/* Firm-member suggestions (WS9). External emails are
                            still typed in the input above, exactly as before. */}
                        {firmSuggestions.length > 0 && (
                            <div className="flex flex-wrap items-center gap-2 pt-1">
                                {firmSuggestions.map((member) => {
                                    const email = member.email!.trim();
                                    const name =
                                        member.displayName?.trim() || email;
                                    return (
                                        <button
                                            key={email.toLowerCase()}
                                            type="button"
                                            onClick={() =>
                                                void addEmail(
                                                    email.toLowerCase(),
                                                )
                                            }
                                            disabled={busy !== null}
                                            title={`Add ${email}`}
                                            className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            <Plus className="h-3 w-3" />
                                            {name}
                                        </button>
                                    );
                                })}
                                <span className="text-xs text-gray-400">
                                    firm suggestions
                                </span>
                            </div>
                        )}
                    </section>
                )}

                <section className="min-h-0 flex-1">
                    <div className="mb-2 flex items-center gap-2">
                        <h3 className="text-xs font-medium text-gray-500">
                            People with Access
                        </h3>
                        {peopleLoading && (
                            <Loader2 className="h-3 w-3 animate-spin text-gray-400" />
                        )}
                    </div>

                    {/* Member list */}
                    {roster.length === 0 ? (
                        <div className="flex h-full items-center justify-center text-sm text-gray-400">
                            No one has access yet.
                        </div>
                    ) : (
                        <ul className="divide-y divide-gray-100 [&>li:nth-child(2)]:border-t-0">
                            {roster.map((entry) => {
                                const isYou =
                                    !!currentUserEmail &&
                                    entry.email.toLowerCase() ===
                                        currentUserEmail.toLowerCase();
                                const isRemoving =
                                    busy === "remove" &&
                                    removingEmail === entry.email;
                                const primary =
                                    entry.display_name?.trim() || entry.email;
                                const showSecondary =
                                    !!entry.display_name?.trim() &&
                                    primary !== entry.email;
                                return (
                                    <li
                                        key={`${entry.role}-${entry.email}`}
                                        className="flex items-center gap-3 py-3"
                                    >
                                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-900 text-white">
                                            <User className="h-3 w-3" />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm text-gray-800">
                                                {primary}
                                                {isYou && (
                                                    <span className="ml-1.5 text-xs text-gray-400">
                                                        (You)
                                                    </span>
                                                )}
                                                {entry.role === "owner" && (
                                                    <span className="ml-1.5 text-[10px] text-gray-400">
                                                        Owner
                                                    </span>
                                                )}
                                            </p>
                                            {showSecondary && (
                                                <p className="truncate text-xs text-gray-400">
                                                    {entry.email}
                                                </p>
                                            )}
                                        </div>
                                        {entry.role === "member" &&
                                            onSharedWithChange && (
                                                <button
                                                    onClick={() =>
                                                        void handleRemove(
                                                            entry.email,
                                                        )
                                                    }
                                                    disabled={busy !== null}
                                                    title="Remove access"
                                                    className="self-center inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                                                >
                                                    {isRemoving && (
                                                        <Loader2 className="h-3 w-3 animate-spin" />
                                                    )}
                                                    Remove
                                                </button>
                                            )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>

                {/* Firm visibility (WS9). Shown only to firm members. A
                    project-scoped review inherits its matter's visibility, so it
                    gets an explanatory note instead of the toggle. */}
                {showFirmSurfaces && firmVisibilityInherited && (
                    <section className="rounded-xl border border-gray-200">
                        <div className="flex items-start gap-2.5 px-4 py-3">
                            <Info className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                            <p className="text-xs leading-relaxed text-gray-600">
                                This review takes its matter&apos;s visibility.
                                To share it with everyone at {firmName}, change
                                the matter&apos;s visibility instead.
                            </p>
                        </div>
                    </section>
                )}

                {showFirmSurfaces &&
                    !firmVisibilityInherited &&
                    onFirmVisibilityChange && (
                        <section className="overflow-hidden rounded-xl border border-gray-200">
                            <div className="flex items-start gap-3 px-4 py-3">
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-medium text-gray-800">
                                        Visible to everyone at {firmName}
                                    </p>
                                    <p className="mt-0.5 text-xs leading-relaxed text-gray-500">
                                        {firmShareDescription}
                                    </p>
                                    {firmError && (
                                        <p className="mt-1.5 text-xs text-red-500">
                                            {firmError}
                                        </p>
                                    )}
                                </div>
                                <div className="mt-0.5 shrink-0">
                                    <AccountToggle
                                        size="md"
                                        checked={firmVisibilityLocal === "firm"}
                                        loading={firmBusy}
                                        onChange={handleVisibilityToggle}
                                        ariaLabel={`Make this ${noun} visible to everyone at ${firmName}`}
                                    />
                                </div>
                            </div>
                            <div className="flex items-start gap-2.5 border-t border-gray-100 bg-gray-50 px-4 py-2.5">
                                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
                                <p className="text-xs leading-relaxed text-gray-500">
                                    Turning this on is recorded in the firm audit
                                    trail. Firm admins can turn it off.
                                </p>
                            </div>
                        </section>
                    )}
            </div>

            <ConfirmPopup
                open={confirmShareOpen}
                title={`Make this ${noun} visible to everyone at ${firmName}?`}
                message={firmShareConfirmMessage}
                confirmLabel="Make visible"
                confirmStatus={firmBusy ? "loading" : "idle"}
                onCancel={() => {
                    if (firmBusy) return;
                    setConfirmShareOpen(false);
                }}
                onConfirm={() => {
                    setConfirmShareOpen(false);
                    void applyVisibility("firm");
                }}
            />
        </Modal>
    );
}
