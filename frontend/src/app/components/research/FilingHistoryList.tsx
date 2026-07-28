"use client";

import { useEffect, useState } from "react";
import {
    ChevronLeft,
    ChevronRight,
    ExternalLink,
    FileText,
    Loader2,
} from "lucide-react";
import {
    chGetFilingHistory,
    getFilingDocument,
    MikeApiError,
    type ChFilingHistoryItem,
} from "@/app/lib/mikeApi";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";

const ITEMS_PER_PAGE = 25;

/** DD/MM/YYYY — never US date order. */
function formatUkShortDate(value?: string): string | null {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toLocaleDateString("en-GB");
}

/**
 * Companies House filing descriptions arrive as enum ids (e.g.
 * "confirmation-statement-with-no-updates") plus description_values.
 * Humanise the id and append the made-up date where present.
 */
function describeFiling(item: ChFilingHistoryItem): string {
    const raw = item.description?.trim();
    if (!raw) return "Filing";
    const humanised =
        raw.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
    const madeUpDate = formatUkShortDate(item.description_values?.made_up_date);
    return madeUpDate ? `${humanised} — made up to ${madeUpDate}` : humanised;
}

function errorMessageFor(err: unknown): string {
    if (err instanceof MikeApiError) {
        if (err.status === 429) {
            return "Companies House rate limit reached. Please try again in a few minutes.";
        }
        if (err.status === 404) {
            return "No filing history found for this company.";
        }
    }
    return "Could not load the filing history. Please try again later.";
}

function documentErrorMessage(err: unknown): string {
    if (err instanceof MikeApiError) {
        if (err.status === 429) {
            return "Rate limit reached. Please try again shortly.";
        }
        if (err.status === 404) {
            return "No document is available for this filing.";
        }
    }
    return "Could not open this document. Please try again later.";
}

interface Props {
    companyNumber: string;
}

/**
 * Paginated Companies House filing history (25 filings per page), fetched
 * lazily — the parent only mounts this component when its tab is opened.
 */
export function FilingHistoryList({ companyNumber }: Props) {
    const [page, setPage] = useState(1);
    // Results/errors are keyed by their fetch so "loading" is derived state —
    // no synchronous setState inside the effect body.
    const [fetched, setFetched] = useState<{
        key: string;
        items: ChFilingHistoryItem[];
        totalCount: number | null;
    } | null>(null);
    const [fetchError, setFetchError] = useState<{
        key: string;
        message: string;
    } | null>(null);
    // Per-item document view state, keyed by transaction id.
    const [docBusyId, setDocBusyId] = useState<string | null>(null);
    const [docError, setDocError] = useState<{
        id: string;
        message: string;
    } | null>(null);

    const fetchKey = `${companyNumber}:${page}`;

    async function openDocument(transactionId: string) {
        setDocError(null);
        setDocBusyId(transactionId);
        try {
            const blob = await getFilingDocument(companyNumber, transactionId);
            const url = URL.createObjectURL(blob);
            window.open(url, "_blank", "noopener,noreferrer");
            // Revoke once the new tab has had time to load the blob.
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch (err) {
            setDocError({
                id: transactionId,
                message: documentErrorMessage(err),
            });
        } finally {
            setDocBusyId(null);
        }
    }

    useEffect(() => {
        let cancelled = false;
        const key = `${companyNumber}:${page}`;
        chGetFilingHistory(companyNumber, page)
            .then((result) => {
                if (cancelled) return;
                setFetched({
                    key,
                    items: result.items ?? [],
                    totalCount:
                        typeof result.total_count === "number"
                            ? result.total_count
                            : null,
                });
            })
            .catch((err) => {
                if (cancelled) return;
                setFetchError({ key, message: errorMessageFor(err) });
            });
        return () => {
            cancelled = true;
        };
    }, [companyNumber, page]);

    const loading = fetched?.key !== fetchKey && fetchError?.key !== fetchKey;
    const error = fetchError?.key === fetchKey ? fetchError.message : null;
    const items = fetched?.key === fetchKey ? fetched.items : null;
    const totalCount = fetched?.key === fetchKey ? fetched.totalCount : null;

    const registerUrl = `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(companyNumber)}/filing-history`;

    if (loading) {
        return (
            <div className="flex flex-col gap-1">
                {["w-[70%]", "w-[55%]", "w-[65%]", "w-[45%]", "w-[60%]"].map(
                    (widthClass, i) => (
                        <div
                            key={i}
                            className="flex items-center gap-4 border-b border-gray-50 py-3"
                        >
                            <SkeletonLine className="w-20 shrink-0" />
                            <SkeletonLine className={widthClass} />
                        </div>
                    ),
                )}
            </div>
        );
    }

    if (error) {
        return <p className="py-4 text-sm text-gray-500">{error}</p>;
    }

    const filings = items ?? [];
    const startIndex = (page - 1) * ITEMS_PER_PAGE;
    const hasNextPage =
        totalCount !== null
            ? startIndex + filings.length < totalCount
            : filings.length === ITEMS_PER_PAGE;

    return (
        <div>
            {filings.length === 0 ? (
                <p className="py-4 text-sm text-gray-400">
                    No filings on record.
                </p>
            ) : (
                <ul>
                    {filings.map((item, i) => {
                        const txId = item.transaction_id;
                        const hasDocument =
                            !!txId && !!item.links?.document_metadata;
                        const busy = !!txId && docBusyId === txId;
                        const itemError =
                            !!txId && docError?.id === txId
                                ? docError.message
                                : null;
                        return (
                            <li
                                key={`${item.date ?? "filing"}-${i}`}
                                className="flex flex-col gap-1 border-b border-gray-50 py-2.5 text-sm"
                            >
                                <div className="flex items-center gap-4">
                                    <span className="w-24 shrink-0 tabular-nums text-gray-500">
                                        {formatUkShortDate(item.date) ?? "—"}
                                    </span>
                                    <span className="min-w-0 flex-1 text-gray-900">
                                        {describeFiling(item)}
                                    </span>
                                    {item.type && (
                                        <span className="shrink-0 text-[11px] text-gray-400">
                                            {item.type}
                                        </span>
                                    )}
                                    {hasDocument && (
                                        <button
                                            type="button"
                                            onClick={() => openDocument(txId)}
                                            disabled={busy}
                                            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 disabled:pointer-events-none disabled:opacity-50"
                                        >
                                            {busy ? (
                                                <Loader2 className="h-3 w-3 animate-spin" />
                                            ) : (
                                                <FileText className="h-3 w-3" />
                                            )}
                                            View PDF
                                        </button>
                                    )}
                                </div>
                                {itemError && (
                                    <p className="pl-28 text-[11px] text-gray-500">
                                        {itemError}
                                    </p>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-3 text-xs text-gray-500">
                <span>
                    {filings.length > 0
                        ? `Showing ${startIndex + 1}–${startIndex + filings.length}${
                              totalCount !== null ? ` of ${totalCount}` : ""
                          }`
                        : null}
                </span>
                <div className="flex items-center gap-3">
                    <a
                        href={registerUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-gray-500 transition-colors hover:text-gray-900"
                    >
                        View on Companies House
                        <ExternalLink className="h-3 w-3" />
                    </a>
                    {(page > 1 || hasNextPage) && (
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() =>
                                    setPage((p) => Math.max(1, p - 1))
                                }
                                disabled={page <= 1}
                                aria-label="Previous page"
                                className="flex h-6.5 w-6.5 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-900 disabled:pointer-events-none disabled:opacity-40"
                            >
                                <ChevronLeft className="h-3.5 w-3.5" />
                            </button>
                            <button
                                onClick={() => setPage((p) => p + 1)}
                                disabled={!hasNextPage}
                                aria-label="Next page"
                                className="flex h-6.5 w-6.5 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-900 disabled:pointer-events-none disabled:opacity-40"
                            >
                                <ChevronRight className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
