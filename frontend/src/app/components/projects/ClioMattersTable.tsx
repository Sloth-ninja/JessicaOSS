"use client";

// Matters › My matters / All matters — the Clio-backed list (mock-up Frame A).
//
// Every row here is a LIVE read through the signed-in solicitor's own Clio
// token: two people at the same firm see different lists, and JessicaOS stores
// none of it. One 200-row page per view (no per-row financials — that would
// burn Clio's 50 req/min budget), with an honest count when the page is full.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FolderOpen, RefreshCw } from "lucide-react";
import {
    listClioMatters,
    MikeApiError,
    type ClioMatterRow,
    type ClioMattersList,
    type ClioMattersTab,
} from "@/app/lib/mikeApi";
import {
    formatStatus,
    formatUkDate,
    isAbort,
    timeBoxed,
} from "@/app/lib/clioMatters";
import {
    SkeletonLine,
    TableBody,
    TableCell,
    TableEmptyState,
    TableHeaderCell,
    TableHeaderRow,
    TableRow,
    TableScrollArea,
    TableStickyCell,
    TABLE_STICKY_CELL_BG,
} from "@/app/components/shared/TablePrimitive";

interface Props {
    tab: ClioMattersTab;
    /** Passed to Clio's own matter search; empty means "no search". */
    query: string;
    /** `open` | `pending` | `closed`, or null for every status. */
    status: string | null;
    /** Raised when Clio says the connection needs re-authorising (401). */
    onReconnectNeeded?: () => void;
}

function loadErrorMessage(err: unknown): string {
    if (err instanceof MikeApiError) {
        // These details are fixed, user-safe strings minted by the backend
        // (the #72 pattern) — showing them beats a generic message.
        if (err.status === 401 || err.status === 400 || err.status === 403) {
            return err.message;
        }
        if (err.status === 429) {
            return "Clio is rate-limiting requests. Please try again in a minute.";
        }
    }
    return "Clio didn’t respond. Your workspaces are still available on the Workspaces tab.";
}

function StatusChip({ status }: { status: string | null }) {
    const label = formatStatus(status);
    if (!label) return <span className="text-xs text-gray-300">—</span>;
    const tone =
        status === "open"
            ? "border-green-700/15 bg-green-50 text-green-800"
            : status === "pending"
              ? "border-amber-700/15 bg-amber-50 text-amber-800"
              : "border-gray-200 bg-gray-50 text-gray-500";
    return (
        <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}
        >
            {label}
        </span>
    );
}

export function ClioMattersTable({
    tab,
    query,
    status,
    onReconnectNeeded,
}: Props) {
    const router = useRouter();
    const [result, setResult] = useState<ClioMattersList | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    // Monotonic guard: a slow earlier request must never overwrite a newer one.
    const seqRef = useRef(0);

    useEffect(() => {
        const seq = ++seqRef.current;
        const controller = new AbortController();
        const run = async () => {
            try {
                const loaded = await timeBoxed(
                    (signal) =>
                        listClioMatters(
                            {
                                tab,
                                ...(query ? { query } : {}),
                                ...(status ? { status } : {}),
                            },
                            signal,
                        ),
                    controller.signal,
                );
                if (seqRef.current !== seq) return;
                setResult(loaded);
                setLoadError(null);
            } catch (err) {
                if (isAbort(err) || seqRef.current !== seq) return;
                if (err instanceof MikeApiError && err.status === 401) {
                    onReconnectNeeded?.();
                }
                setResult(null);
                setLoadError(loadErrorMessage(err));
            }
        };
        void run();
        return () => controller.abort();
    }, [tab, query, status, reloadKey, onReconnectNeeded]);

    const retry = useCallback(() => {
        setLoadError(null);
        setResult(null);
        setReloadKey((k) => k + 1);
    }, []);

    const loading = result === null && loadError === null;
    const matters: ClioMatterRow[] = result?.matters ?? [];

    return (
        <>
            <TableScrollArea>
                <TableHeaderRow>
                    <TableStickyCell header>
                        <span>Matter</span>
                    </TableStickyCell>
                    <TableHeaderCell className="ml-auto w-40">
                        Client
                    </TableHeaderCell>
                    <TableHeaderCell className="w-36">
                        Responsible
                    </TableHeaderCell>
                    <TableHeaderCell className="w-36">
                        Originating
                    </TableHeaderCell>
                    <TableHeaderCell className="w-36">
                        Practice area
                    </TableHeaderCell>
                    <TableHeaderCell className="w-24">Status</TableHeaderCell>
                    <TableHeaderCell className="w-28">Opened</TableHeaderCell>
                </TableHeaderRow>

                {loading ? (
                    <TableBody>
                        {[1, 2, 3].map((i) => (
                            <TableRow key={i} interactive={false}>
                                <TableStickyCell
                                    hover={false}
                                    bgClassName="bg-transparent"
                                >
                                    <SkeletonLine className="h-3.5 w-56" />
                                </TableStickyCell>
                                <TableCell className="ml-auto w-40">
                                    <SkeletonLine className="w-24" />
                                </TableCell>
                                <TableCell className="w-36">
                                    <SkeletonLine className="w-20" />
                                </TableCell>
                                <TableCell className="w-36">
                                    <SkeletonLine className="w-20" />
                                </TableCell>
                                <TableCell className="w-36">
                                    <SkeletonLine className="w-20" />
                                </TableCell>
                                <TableCell className="w-24">
                                    <SkeletonLine className="w-12" />
                                </TableCell>
                                <TableCell className="w-28">
                                    <SkeletonLine className="w-16" />
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                ) : loadError ? (
                    <TableEmptyState className="max-w-md">
                        <p className="text-sm text-gray-600">{loadError}</p>
                        <button
                            type="button"
                            onClick={retry}
                            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
                        >
                            <RefreshCw className="h-3.5 w-3.5" />
                            Try again
                        </button>
                    </TableEmptyState>
                ) : matters.length === 0 ? (
                    <TableEmptyState>
                        <FolderOpen className="mb-4 h-8 w-8 text-gray-300" />
                        <p className="font-serif text-2xl font-medium text-gray-900">
                            No matters
                        </p>
                        <p className="mt-1 max-w-xs text-xs text-gray-400">
                            {query || status
                                ? "No Clio matters match this search. Try different words, or clear the status filter."
                                : tab === "mine"
                                  ? "Clio has no matters where you are the responsible or originating solicitor. Try All matters."
                                  : "Your Clio permissions show no matters for this firm."}
                        </p>
                    </TableEmptyState>
                ) : (
                    <TableBody>
                        {matters.map((matter) => (
                            <TableRow
                                key={matter.id}
                                onClick={() =>
                                    router.push(`/matters/${matter.id}`)
                                }
                            >
                                <TableStickyCell
                                    bgClassName={TABLE_STICKY_CELL_BG}
                                >
                                    <span className="flex min-w-0 flex-col justify-center leading-tight">
                                        <span className="truncate text-[13px] text-gray-800">
                                            {matter.displayNumber ??
                                                "Untitled matter"}
                                        </span>
                                        {matter.description && (
                                            <span className="truncate text-[11px] text-gray-400">
                                                {matter.description}
                                            </span>
                                        )}
                                    </span>
                                </TableStickyCell>
                                <TableCell className="ml-auto w-40">
                                    {matter.client?.name ?? (
                                        <span className="text-xs text-gray-300">
                                            —
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell className="w-36">
                                    {matter.responsibleSolicitor?.name ?? (
                                        <span className="text-xs text-gray-300">
                                            —
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell className="w-36">
                                    {matter.originatingSolicitor?.name ?? (
                                        <span className="text-xs text-gray-300">
                                            —
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell className="w-36">
                                    {matter.practiceArea?.name ?? (
                                        <span className="text-xs text-gray-300">
                                            —
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell className="w-24">
                                    <StatusChip status={matter.status} />
                                </TableCell>
                                <TableCell className="w-28">
                                    {formatUkDate(matter.openDate)}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                )}
            </TableScrollArea>

            {result !== null && matters.length > 0 && (
                <div className="shrink-0 border-t border-gray-100 px-4 py-2 text-xs text-gray-500 md:px-10">
                    <MattersCount result={result} tab={tab} />
                </div>
            )}
        </>
    );
}

/**
 * Honest counts. Clio returns one 200-row page; when that page is full we say
 * so rather than implying the list is complete, and we never invent a total
 * Clio did not give us.
 */
function MattersCount({
    result,
    tab,
}: {
    result: ClioMattersList;
    tab: ClioMattersTab;
}) {
    const shown = result.count.toLocaleString("en-GB");
    const scope =
        tab === "mine"
            ? "where you are the responsible or originating solicitor"
            : "your Clio permissions allow you to see";

    if (result.capped && result.totalEntries !== null) {
        return (
            <>
                Showing {shown} of{" "}
                {result.totalEntries.toLocaleString("en-GB")} matters {scope}.
                Narrow the search to see the rest.
            </>
        );
    }
    if (result.capped || result.hasMore) {
        return (
            <>
                Showing the first {shown} matters {scope}. Narrow the search to
                see the rest.
            </>
        );
    }
    return (
        <>
            Showing {shown} matter{result.count === 1 ? "" : "s"} {scope}.
        </>
    );
}
