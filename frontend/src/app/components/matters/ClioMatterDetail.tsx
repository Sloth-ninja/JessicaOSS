"use client";

// Matter detail (mock-up Frame B) — overview, key people, financials, time
// entries and the matter's JessicaOS workspace.
//
// Everything on this page is a live read through the signed-in solicitor's own
// Clio token. Three honesty rules govern what is drawn:
//   • Only Clio's own redaction flag licenses "Hidden by your Clio
//     permissions". A merely absent amount is an em dash, never £0.
//   • Clio has no per-matter outstanding balance, so the client-level figure is
//     labelled as such.
//   • Billed entries carry no edit or delete affordance (the server refuses
//     them too) until the write probe says what Clio actually allows.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, RefreshCw, Trash2 } from "lucide-react";
import {
    createWorkspaceForClioMatter,
    deleteClioActivity,
    getClioMatter,
    getClioMatterActivities,
    getClioMatterContacts,
    unlinkWorkspaceFromClioMatter,
    MikeApiError,
    type ClioActivity,
    type ClioMatterContact,
    type ClioMatterDetail as ClioMatterDetailData,
    type ClioMatterFinancials,
    type ClioWorkspaceLink,
} from "@/app/lib/mikeApi";
import {
    formatHours,
    formatMoney,
    formatStatus,
    formatUkDate,
    formatUkDayMonth,
    isAbort,
    matterLabel,
    timeBoxed,
} from "@/app/lib/clioMatters";
import { setAssistantPrefill } from "@/app/lib/assistantPrefill";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import { EditTimeEntryModal } from "@/app/components/matters/EditTimeEntryModal";

const HIDDEN_COPY = "Hidden by your Clio permissions";

function Card({
    title,
    action,
    children,
}: {
    title: string;
    action?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className="rounded-xl border border-gray-200 bg-white">
            <div className="flex items-center justify-between gap-4 border-b border-gray-100 px-5 py-3.5">
                <h2 className="font-serif text-[15px] font-semibold text-gray-900">
                    {title}
                </h2>
                {action}
            </div>
            <div className="px-5 py-4">{children}</div>
        </div>
    );
}

function Row({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <div className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-1 py-1 text-[13px]">
            <dt className="text-gray-500">{label}</dt>
            <dd className="m-0 min-w-0 break-words text-gray-800">
                {children}
            </dd>
        </div>
    );
}

function Hidden() {
    return <span className="text-gray-400 italic">{HIDDEN_COPY}</span>;
}

function Dash() {
    return <span className="text-gray-300">—</span>;
}

/** Render a custom field's value without ever guessing at its meaning. */
function customFieldValue(value: unknown): string {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (typeof value === "string" || typeof value === "number") {
        return String(value);
    }
    return JSON.stringify(value);
}

function Financials({
    financials,
    unavailable,
}: {
    financials: ClioMatterFinancials | null;
    unavailable: boolean;
}) {
    if (unavailable || !financials) {
        return (
            <p className="text-[13px] text-gray-500">
                Financial figures are not available for this matter — your Clio
                permissions may not include billing, or Clio did not answer.
            </p>
        );
    }
    const currency = financials.currencyCode;
    return (
        <dl className="m-0">
            {/* Amount and hours are separately redactable in Clio, so they are
                rendered independently: a hidden amount must not swallow the
                fact that the hours are hidden too — stating each is the whole
                point of this surface. */}
            <Row label="Unbilled WIP">
                {financials.unbilledAmountHidden ? (
                    <Hidden />
                ) : financials.unbilledAmount === null ? (
                    <Dash />
                ) : (
                    formatMoney(financials.unbilledAmount, currency)
                )}
            </Row>
            <Row label="Unbilled hours">
                {financials.unbilledHoursHidden ? (
                    <Hidden />
                ) : financials.unbilledHours === null ? (
                    <Dash />
                ) : (
                    `${financials.unbilledHours.toFixed(2)}h`
                )}
            </Row>
            <Row label="In trust">
                {financials.amountInTrustHidden ? (
                    <Hidden />
                ) : financials.amountInTrust === null ? (
                    <Dash />
                ) : (
                    formatMoney(financials.amountInTrust, currency)
                )}
            </Row>
            <Row label="Client balance">
                {financials.clientOutstandingBalanceHidden ? (
                    <Hidden />
                ) : financials.clientOutstandingBalance === null ? (
                    <Dash />
                ) : (
                    <>
                        {formatMoney(
                            financials.clientOutstandingBalance,
                            currency,
                        )}{" "}
                        <span className="text-gray-500">
                            (across this client&rsquo;s matters)
                        </span>
                    </>
                )}
            </Row>
        </dl>
    );
}

export function ClioMatterDetail({ matterId }: { matterId: string }) {
    const router = useRouter();

    const [matter, setMatter] = useState<ClioMatterDetailData | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);

    const [contacts, setContacts] = useState<ClioMatterContact[] | null>(null);
    const [contactsError, setContactsError] = useState(false);

    const [everyone, setEveryone] = useState(false);
    const [activities, setActivities] = useState<ClioActivity[] | null>(null);
    const [activitiesError, setActivitiesError] = useState<string | null>(null);
    const [activitiesKey, setActivitiesKey] = useState(0);
    const [activitiesCapped, setActivitiesCapped] = useState(false);

    const [editing, setEditing] = useState<ClioActivity | null>(null);
    const [deleting, setDeleting] = useState<ClioActivity | null>(null);
    const [deleteStatus, setDeleteStatus] = useState<
        "idle" | "loading" | "complete"
    >("idle");

    const [link, setLink] = useState<ClioWorkspaceLink | null>(null);
    const [workspaceBusy, setWorkspaceBusy] = useState(false);
    // Action failures are reported where the action lives, not at the top of the
    // page: a refusal to unlink belongs in the Workspace card, and a refused
    // delete belongs beside the time entries it applies to.
    const [workspaceError, setWorkspaceError] = useState<string | null>(null);
    const [entryError, setEntryError] = useState<string | null>(null);
    const [confirmUnlink, setConfirmUnlink] = useState(false);

    const matterSeq = useRef(0);
    const contactsSeq = useRef(0);
    const activitySeq = useRef(0);

    // ── Matter + link ────────────────────────────────────────────────────────
    useEffect(() => {
        const seq = ++matterSeq.current;
        const controller = new AbortController();
        const run = async () => {
            try {
                const loaded = await timeBoxed(
                    (signal) => getClioMatter(matterId, signal),
                    controller.signal,
                );
                if (matterSeq.current !== seq) return;
                setMatter(loaded);
                setLink(loaded.link);
                setLoadError(null);
            } catch (err) {
                if (isAbort(err) || matterSeq.current !== seq) return;
                setMatter(null);
                setLoadError(
                    err instanceof MikeApiError &&
                        (err.status === 401 ||
                            err.status === 403 ||
                            err.status === 404)
                        ? err.message
                        : "Clio didn’t respond. This matter could not be loaded.",
                );
            }
        };
        void run();
        return () => controller.abort();
    }, [matterId, reloadKey]);

    // ── Key people ───────────────────────────────────────────────────────────
    useEffect(() => {
        // Same monotonic guard as its two siblings: a slow earlier response must
        // never overwrite a newer matter's contacts.
        const seq = ++contactsSeq.current;
        const controller = new AbortController();
        const run = async () => {
            try {
                const loaded = await timeBoxed(
                    (signal) => getClioMatterContacts(matterId, signal),
                    controller.signal,
                );
                if (contactsSeq.current !== seq) return;
                setContacts(loaded.contacts);
                setContactsError(false);
            } catch (err) {
                if (isAbort(err) || contactsSeq.current !== seq) return;
                setContacts([]);
                setContactsError(true);
            }
        };
        void run();
        return () => controller.abort();
    }, [matterId, reloadKey]);

    // ── Time entries ─────────────────────────────────────────────────────────
    useEffect(() => {
        const seq = ++activitySeq.current;
        const controller = new AbortController();
        const run = async () => {
            try {
                const loaded = await timeBoxed(
                    (signal) =>
                        getClioMatterActivities(
                            matterId,
                            { everyone },
                            signal,
                        ),
                    controller.signal,
                );
                if (activitySeq.current !== seq) return;
                setActivities(loaded.activities);
                setActivitiesCapped(loaded.capped);
                setActivitiesError(null);
            } catch (err) {
                if (isAbort(err) || activitySeq.current !== seq) return;
                setActivities(null);
                setActivitiesError(
                    err instanceof MikeApiError &&
                        (err.status === 401 || err.status === 403)
                        ? err.message
                        : "Could not load time entries from Clio.",
                );
            }
        };
        void run();
        return () => controller.abort();
    }, [matterId, everyone, activitiesKey, reloadKey]);

    const reloadMatter = useCallback(() => {
        setMatter(null);
        setLoadError(null);
        setContacts(null);
        setActivities(null);
        setActivitiesError(null);
        setWorkspaceError(null);
        setEntryError(null);
        setReloadKey((k) => k + 1);
    }, []);

    const reloadActivities = useCallback(() => {
        setActivities(null);
        setActivitiesError(null);
        setActivitiesKey((k) => k + 1);
    }, []);

    async function handleStartWorkspace() {
        setWorkspaceBusy(true);
        setWorkspaceError(null);
        try {
            const created = await createWorkspaceForClioMatter(matterId);
            setLink(created.link);
            setWorkspaceBusy(false);
            router.push(`/projects/${created.projectId}`);
        } catch (err) {
            setWorkspaceBusy(false);
            // Fixed, user-safe server details — including the three distinct
            // "already linked" refusals, which each mean something different.
            setWorkspaceError(
                err instanceof MikeApiError && err.message
                    ? err.message
                    : "Could not start a workspace for this matter.",
            );
        }
    }

    async function handleUnlink() {
        if (!link) return;
        setConfirmUnlink(false);
        setWorkspaceBusy(true);
        setWorkspaceError(null);
        try {
            await unlinkWorkspaceFromClioMatter(link.projectId);
            setLink(null);
            setWorkspaceBusy(false);
        } catch (err) {
            setWorkspaceBusy(false);
            // Includes the owner-only 403: the link payload carries no
            // ownership signal, so a non-owner only learns here. Shown inside
            // the Workspace card, next to the button they pressed.
            setWorkspaceError(
                err instanceof MikeApiError && err.message
                    ? err.message
                    : "Could not unlink this workspace.",
            );
        }
    }

    async function confirmDeleteEntry() {
        if (!deleting) return;
        setDeleteStatus("loading");
        setEntryError(null);
        try {
            await deleteClioActivity(deleting.id);
            setDeleteStatus("complete");
            setActivities((prev) =>
                prev ? prev.filter((a) => a.id !== deleting.id) : prev,
            );
            setDeleting(null);
            setDeleteStatus("idle");
        } catch (err) {
            setDeleteStatus("idle");
            setDeleting(null);
            setEntryError(
                err instanceof MikeApiError && err.message
                    ? err.message
                    : "Could not delete that time entry.",
            );
        }
    }

    function handleRecordTime() {
        const label = matter ? matterLabel(matter) : matterId;
        // Recording a NEW entry runs through the assistant's Clio time tool,
        // which confirms before it writes and can undo — there is deliberately
        // no direct create route. Prefill the matter so the solicitor only has
        // to add the duration and what they did. No placeholder tokens: they
        // get sent literally (lesson, 2026-07-22).
        setAssistantPrefill(
            `Record time on Clio matter ${label}. Duration in minutes: `,
        );
        router.push("/assistant");
    }

    const title = matter ? matterLabel(matter) : "Matter";
    const statusLabel = formatStatus(matter?.status);

    return (
        <div className="flex h-full flex-col overflow-y-auto">
            <PageHeader
                shrink
                loading={matter === null && loadError === null}
                breadcrumbs={[
                    { label: "Matters", onClick: () => router.push("/projects") },
                    { label: title, loading: matter === null && !loadError },
                ]}
            />

            <div className="mx-auto w-full max-w-5xl px-4 pb-16 md:px-10">
                {loadError ? (
                    <div className="mt-6 flex flex-col items-start gap-2.5 rounded-xl border border-gray-200 bg-white px-5 py-6">
                        <p className="text-sm text-gray-600">{loadError}</p>
                        <button
                            type="button"
                            onClick={reloadMatter}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
                        >
                            <RefreshCw className="h-3.5 w-3.5" />
                            Try again
                        </button>
                    </div>
                ) : matter === null ? (
                    <div className="mt-6 space-y-2 rounded-xl border border-gray-200 bg-white px-5 py-4">
                        {[0, 1, 2].map((i) => (
                            <div
                                key={i}
                                className="h-6 w-full animate-pulse rounded bg-gray-100"
                            />
                        ))}
                    </div>
                ) : (
                    <>
                        {statusLabel && (
                            <p className="mt-4 text-xs text-gray-500">
                                <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                                    {statusLabel}
                                </span>
                            </p>
                        )}

                        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
                            <div className="flex flex-col gap-4">
                                <Card title="Overview">
                                    <dl className="m-0">
                                        <Row label="Client">
                                            {matter.client?.name ?? <Dash />}
                                        </Row>
                                        <Row label="Practice area">
                                            {matter.practiceArea?.name ?? (
                                                <Dash />
                                            )}
                                        </Row>
                                        <Row label="Responsible">
                                            {matter.responsibleSolicitor
                                                ?.name ?? <Dash />}
                                        </Row>
                                        <Row label="Originating">
                                            {matter.originatingSolicitor
                                                ?.name ?? <Dash />}
                                        </Row>
                                        <Row label="Opened">
                                            {formatUkDate(matter.openDate)}
                                        </Row>
                                        {matter.closeDate && (
                                            <Row label="Closed">
                                                {formatUkDate(
                                                    matter.closeDate,
                                                )}
                                            </Row>
                                        )}
                                        {matter.customFields.map((field) => (
                                            <Row
                                                key={field.id}
                                                label={field.name ?? "Field"}
                                            >
                                                {customFieldValue(field.value)}
                                            </Row>
                                        ))}
                                    </dl>
                                    {matter.customFieldsUnavailable && (
                                        <p className="mt-3 text-[11px] text-gray-400">
                                            Clio did not return this
                                            matter&rsquo;s custom fields.
                                        </p>
                                    )}
                                </Card>

                                <Card
                                    title="Time entries"
                                    action={
                                        <div className="flex items-center gap-3 text-xs">
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setEveryone((v) => !v)
                                                }
                                                aria-pressed={everyone}
                                                title={
                                                    everyone
                                                        ? "Show only the time you recorded"
                                                        : "Show everyone's time on this matter"
                                                }
                                                aria-label={
                                                    everyone
                                                        ? "Showing everyone on this matter — switch to only mine"
                                                        : "Showing only mine — switch to everyone on this matter"
                                                }
                                                className="font-medium text-gray-500 underline underline-offset-2 transition-colors hover:text-gray-800"
                                            >
                                                {everyone
                                                    ? "Everyone on this matter"
                                                    : "Mine"}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={handleRecordTime}
                                                className="font-medium text-gray-500 underline underline-offset-2 transition-colors hover:text-gray-800"
                                            >
                                                Record time
                                            </button>
                                        </div>
                                    }
                                >
                                    {entryError && (
                                        <p
                                            role="alert"
                                            className="mb-3 text-xs text-red-600"
                                        >
                                            {entryError}
                                        </p>
                                    )}
                                    <TimeEntries
                                        activities={activities}
                                        error={activitiesError}
                                        capped={activitiesCapped}
                                        everyone={everyone}
                                        currencyCode={
                                            matter.financials?.currencyCode ??
                                            null
                                        }
                                        onRetry={reloadActivities}
                                        onEdit={setEditing}
                                        onDelete={setDeleting}
                                    />
                                </Card>
                            </div>

                            <div className="flex flex-col gap-4">
                                <Card title="Financials">
                                    <Financials
                                        financials={matter.financials}
                                        unavailable={
                                            matter.financialsUnavailable
                                        }
                                    />
                                </Card>

                                <Card title="Key people">
                                    {contacts === null ? (
                                        <div className="h-6 w-full animate-pulse rounded bg-gray-100" />
                                    ) : contactsError ? (
                                        <p className="text-[13px] text-gray-500">
                                            Could not load the related contacts
                                            for this matter.
                                        </p>
                                    ) : contacts.length === 0 ? (
                                        <p className="text-[13px] text-gray-500">
                                            No related contacts on this matter
                                            in Clio.
                                        </p>
                                    ) : (
                                        <ul className="m-0 flex list-none flex-col gap-2 p-0">
                                            {contacts.map((contact) => (
                                                <li
                                                    key={contact.id}
                                                    className="text-[13px]"
                                                >
                                                    <span className="text-gray-800">
                                                        {contact.name ??
                                                            "Unnamed contact"}
                                                    </span>
                                                    {contact.type && (
                                                        <span className="text-gray-500">
                                                            {" "}
                                                            · {contact.type}
                                                        </span>
                                                    )}
                                                    {contact.email && (
                                                        <span className="block text-xs text-gray-400">
                                                            {contact.email}
                                                        </span>
                                                    )}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </Card>

                                <Card title="Workspace">
                                    {workspaceError && (
                                        <p
                                            role="alert"
                                            className="mb-3 text-xs text-red-600"
                                        >
                                            {workspaceError}
                                        </p>
                                    )}
                                    {link ? (
                                        <div className="flex flex-col gap-3">
                                            <p className="text-[13px] text-gray-500">
                                                Documents, chats and reviews for
                                                this matter live in{" "}
                                                <span className="font-medium text-gray-700">
                                                    {link.projectName ??
                                                        "a workspace"}
                                                </span>
                                                .
                                            </p>
                                            <div className="flex items-center gap-3">
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        router.push(
                                                            `/projects/${link.projectId}`,
                                                        )
                                                    }
                                                    className="inline-flex h-8 flex-none items-center gap-1.5 rounded-lg bg-gray-900 px-3 text-xs font-medium text-white transition-colors hover:bg-gray-800"
                                                >
                                                    Open workspace
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        setConfirmUnlink(true)
                                                    }
                                                    disabled={workspaceBusy}
                                                    className="text-xs font-medium text-gray-500 underline underline-offset-2 transition-colors hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-45"
                                                >
                                                    Unlink
                                                </button>
                                            </div>
                                        </div>
                                    ) : matter.linksUnavailable ? (
                                        /* Not "no workspace yet" — the feature
                                           itself is not available on this
                                           deployment, so offering a button that
                                           could only refuse would be a lie. */
                                        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-gray-200 px-4 py-3.5">
                                            <p className="text-[13px] text-gray-500">
                                                Workspace linking isn&rsquo;t
                                                available yet. Documents, chats
                                                and reviews still live in your
                                                workspaces on the Matters page.
                                            </p>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-gray-200 px-4 py-3.5">
                                            <p className="text-[13px] text-gray-500">
                                                No workspace yet — documents,
                                                chats and reviews will attach to
                                                this matter.
                                            </p>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    void handleStartWorkspace()
                                                }
                                                disabled={workspaceBusy}
                                                className="inline-flex h-8 flex-none items-center gap-1.5 rounded-lg bg-gray-900 px-3 text-xs font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-45"
                                            >
                                                {workspaceBusy ? (
                                                    <>
                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                        Starting…
                                                    </>
                                                ) : (
                                                    "Start workspace"
                                                )}
                                            </button>
                                        </div>
                                    )}
                                </Card>
                            </div>
                        </div>
                    </>
                )}
            </div>

            {editing && (
                <EditTimeEntryModal
                    key={editing.id}
                    entry={editing}
                    onClose={() => setEditing(null)}
                    onSaved={(updated) =>
                        setActivities((prev) =>
                            prev
                                ? prev.map((a) =>
                                      a.id === updated.id ? updated : a,
                                  )
                                : prev,
                        )
                    }
                    onReload={reloadActivities}
                />
            )}

            <ConfirmPopup
                open={deleting !== null}
                title="Delete this time entry?"
                message={
                    deleting
                        ? `It will be deleted in Clio. ${
                              deleting.note?.trim()
                                  ? `“${deleting.note.trim().slice(0, 80)}”`
                                  : "This entry has no description."
                          }`
                        : ""
                }
                confirmLabel="Delete"
                confirmStatus={deleteStatus}
                onConfirm={() => void confirmDeleteEntry()}
                onCancel={() => {
                    if (deleteStatus === "loading") return;
                    setDeleting(null);
                    setDeleteStatus("idle");
                }}
            />

            <ConfirmPopup
                open={confirmUnlink}
                title="Unlink this workspace?"
                message="The workspace and everything in it stays in JessicaOS — it simply stops being shown against this Clio matter."
                confirmLabel="Unlink"
                onConfirm={() => void handleUnlink()}
                onCancel={() => setConfirmUnlink(false)}
            />
        </div>
    );
}

function TimeEntries({
    activities,
    error,
    capped,
    everyone,
    currencyCode,
    onRetry,
    onEdit,
    onDelete,
}: {
    activities: ClioActivity[] | null;
    error: string | null;
    capped: boolean;
    everyone: boolean;
    currencyCode: string | null;
    onRetry: () => void;
    onEdit: (entry: ClioActivity) => void;
    onDelete: (entry: ClioActivity) => void;
}) {
    if (error) {
        return (
            <div className="flex flex-col items-start gap-2.5">
                <p className="text-[13px] text-gray-600">{error}</p>
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
    if (activities === null) {
        return (
            <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                    <div
                        key={i}
                        className="h-5 w-full animate-pulse rounded bg-gray-100"
                    />
                ))}
            </div>
        );
    }
    if (activities.length === 0) {
        return (
            <p className="text-[13px] text-gray-500">
                {everyone
                    ? "No time has been recorded on this matter in Clio."
                    : "You have not recorded time on this matter. Use Record time to add an entry."}
            </p>
        );
    }

    return (
        <>
            <ul className="m-0 flex list-none flex-col p-0">
                {activities.map((entry) => (
                    <li
                        key={entry.id}
                        className="flex items-baseline justify-between gap-3 border-t border-gray-50 py-2 text-[13px] first:border-t-0"
                    >
                        <span className="min-w-0 flex-1">
                            <span className="text-gray-800">
                                {formatUkDayMonth(entry.date)}
                            </span>
                            <span className="text-gray-600">
                                {" "}
                                — {entry.note?.trim() || "No description"}
                            </span>
                            <span className="block text-xs text-gray-400">
                                {entry.user?.name ?? "Unknown fee earner"}
                            </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2 tabular-nums whitespace-nowrap">
                            {entry.quantityRedacted ? (
                                <span className="text-gray-400 italic">
                                    {HIDDEN_COPY}
                                </span>
                            ) : (
                                <>
                                    <span className="text-gray-700">
                                        {formatHours(entry.quantitySeconds)}
                                    </span>
                                    <span className="text-gray-400">·</span>
                                    <span className="text-gray-700">
                                        {entry.amountsUnavailable
                                            ? "—"
                                            : formatMoney(
                                                  entry.total ?? entry.price,
                                                  currencyCode,
                                              )}
                                    </span>
                                </>
                            )}
                            {entry.locked ? (
                                <span className="text-[11px] text-gray-400">
                                    Billed — locked
                                </span>
                            ) : entry.isOwn && entry.quantityRedacted ? (
                                // Own entry, but Clio withholds its duration —
                                // the edit form would have nothing truthful to
                                // prefill, so it is not offered.
                                <span className="text-[11px] text-gray-400">
                                    Not editable here
                                </span>
                            ) : entry.isOwn ? (
                                <span className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        onClick={() => onEdit(entry)}
                                        title="Edit this time entry"
                                        aria-label="Edit this time entry"
                                        className="flex h-6 w-6 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                                    >
                                        <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => onDelete(entry)}
                                        title="Delete this time entry"
                                        aria-label="Delete this time entry"
                                        className="flex h-6 w-6 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </span>
                            ) : null}
                        </span>
                    </li>
                ))}
            </ul>
            {capped && (
                <p className="mt-3 text-[11px] text-gray-400">
                    Showing the most recent{" "}
                    {activities.length.toLocaleString("en-GB")} time entries.
                </p>
            )}
        </>
    );
}
