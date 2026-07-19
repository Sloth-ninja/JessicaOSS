"use client";

import { useState } from "react";
import {
    CheckCircle2,
    ClipboardCheck,
    ExternalLink,
    Loader2,
    Scale,
    XCircle,
} from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
    SkeletonDot,
    SkeletonLine,
    TableHeaderCell,
    TableHeaderRow,
} from "@/app/components/shared/TablePrimitive";
import {
    checkCitations,
    type CitationCheckResult,
} from "@/app/lib/mikeApi";
import { cn } from "@/lib/utils";

const KIND_LABELS: Record<CitationCheckResult["kind"], string> = {
    "statute-section": "Statute section",
    act: "Act",
    si: "Statutory instrument",
    "neutral-case": "Case law",
};

function summarise(results: CitationCheckResult[]): string {
    const verified = results.filter((r) => r.status === "verified").length;
    const notFound = results.filter((r) => r.status === "unverified").length;
    const caseLaw = results.filter((r) => r.status === "unverifiable").length;
    const parts = [`${verified} verified`];
    if (notFound > 0) parts.push(`${notFound} not found`);
    if (caseLaw > 0)
        parts.push(
            `${caseLaw} case-law citation${caseLaw === 1 ? "" : "s"}`,
        );
    return parts.join(" · ");
}

export default function CitationCheckerPage() {
    const [text, setText] = useState("");
    const [checking, setChecking] = useState(false);
    const [results, setResults] = useState<CitationCheckResult[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function handleCheck() {
        if (!text.trim() || checking) return;
        setChecking(true);
        setError(null);
        setResults(null);
        try {
            const response = await checkCitations(text);
            setResults(response.results);
        } catch (err) {
            setError(
                err instanceof Error && err.message
                    ? err.message
                    : "Citation check failed. Please try again.",
            );
        } finally {
            setChecking(false);
        }
    }

    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            <PageHeader>
                <h1 className="text-2xl font-medium font-serif text-gray-900">
                    Citation Checker
                </h1>
            </PageHeader>

            <div className="flex-1 overflow-y-auto px-4 pb-10 md:px-10">
                <div className="max-w-3xl">
                    <p className="text-sm text-gray-500">
                        Paste a draft. Statutory citations are extracted and
                        verified live against legislation.gov.uk.
                    </p>

                    <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        disabled={checking}
                        placeholder='Paste a paragraph, submission, or draft containing statutory citations, e.g. "s.994 Companies Act 2006" or "SI 2006/246"…'
                        className={cn(
                            "mt-4 min-h-40 w-full resize-y rounded-xl border border-gray-200 bg-gray-50 p-3.5 text-sm leading-relaxed text-gray-800 outline-none placeholder:text-gray-400 focus:border-gray-300",
                            checking && "bg-gray-100 text-gray-400",
                        )}
                    />

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                        <button
                            onClick={handleCheck}
                            disabled={!text.trim() || checking}
                            className="inline-flex h-9 items-center gap-2 rounded-full bg-gray-900 px-4 text-sm font-medium text-white shadow-md transition-colors hover:bg-gray-700 disabled:opacity-40"
                        >
                            {checking ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <ClipboardCheck className="h-4 w-4" />
                            )}
                            {checking ? "Checking citations…" : "Check citations"}
                        </button>
                        <span className="max-w-md text-xs leading-relaxed text-gray-400">
                            Citations are checked against legislation.gov.uk.
                            Case-law citation checking (Find Case Law / BAILII)
                            is not yet available — see the README roadmap.
                        </span>
                    </div>

                    {checking && (
                        <div className="mt-6">
                            <p className="text-xs text-gray-400">
                                This may take up to a minute for long drafts.
                            </p>
                            <div className="mt-3 border-t border-gray-100">
                                {["w-[42%]", "w-[55%]", "w-[33%]"].map(
                                    (w, i) => (
                                        <div
                                            key={i}
                                            className="flex items-center gap-3 border-b border-gray-100 py-3.5"
                                        >
                                            <SkeletonDot className="rounded-full" />
                                            <SkeletonLine className={w} />
                                        </div>
                                    ),
                                )}
                            </div>
                        </div>
                    )}

                    {error && !checking && (
                        <p className="mt-6 text-sm text-red-600">{error}</p>
                    )}

                    {results && !checking && results.length === 0 && (
                        <p className="mt-6 text-sm text-gray-500">
                            No statutory citations were found in that text.
                        </p>
                    )}

                    {results && !checking && results.length > 0 && (
                        <div className="mt-6">
                            <p className="text-sm text-gray-900">
                                <span className="font-semibold">
                                    {results.length} citation
                                    {results.length === 1 ? "" : "s"}
                                </span>{" "}
                                found — {summarise(results)}
                            </p>

                            <div className="mt-3 overflow-x-auto">
                                <div className="min-w-[560px]">
                                    <TableHeaderRow className="pr-0 md:pr-0">
                                        <TableHeaderCell className="w-[45%] pl-1">
                                            Citation
                                        </TableHeaderCell>
                                        <TableHeaderCell className="w-[20%]">
                                            Kind
                                        </TableHeaderCell>
                                        <TableHeaderCell className="w-[35%]">
                                            Status
                                        </TableHeaderCell>
                                    </TableHeaderRow>
                                    {results.map((result, index) => (
                                        <div
                                            key={`${result.raw}-${index}`}
                                            className="flex items-start border-b border-gray-50 py-3"
                                        >
                                            <div className="w-[45%] shrink-0 pl-1 pr-3">
                                                <span className="break-words font-mono text-[13px] text-gray-800">
                                                    {result.raw}
                                                </span>
                                            </div>
                                            <div className="w-[20%] shrink-0 pr-3 text-sm text-gray-500">
                                                {KIND_LABELS[result.kind]}
                                            </div>
                                            <div className="w-[35%] shrink-0">
                                                {result.status ===
                                                    "verified" && (
                                                    <div>
                                                        <span className="inline-flex items-center gap-1 rounded-full border border-green-600/15 bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700">
                                                            <CheckCircle2 className="h-3 w-3" />
                                                            Verified
                                                        </span>
                                                        {result.url && (
                                                            <a
                                                                href={
                                                                    result.url
                                                                }
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="mt-1 flex w-fit items-center gap-1 text-xs text-sky-600 hover:underline"
                                                            >
                                                                View on
                                                                legislation.gov.uk
                                                                <ExternalLink className="h-3 w-3" />
                                                            </a>
                                                        )}
                                                    </div>
                                                )}
                                                {result.status ===
                                                    "unverified" && (
                                                    <div>
                                                        <span className="inline-flex items-center gap-1 rounded-full border border-red-600/15 bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-700">
                                                            <XCircle className="h-3 w-3" />
                                                            Not found
                                                        </span>
                                                        {result.reason && (
                                                            <p className="mt-1 text-xs leading-relaxed text-red-600">
                                                                {result.reason}
                                                            </p>
                                                        )}
                                                    </div>
                                                )}
                                                {result.status ===
                                                    "unverifiable" && (
                                                    <div>
                                                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-600/20 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800">
                                                            <Scale className="h-3 w-3" />
                                                            Case law — cannot
                                                            be verified
                                                        </span>
                                                        {result.reason && (
                                                            <p className="mt-1 text-xs leading-relaxed text-amber-700">
                                                                {result.reason}
                                                            </p>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <p className="mt-4 text-xs leading-relaxed text-gray-400">
                                Verification confirms the cited provision
                                exists on legislation.gov.uk — not that it
                                supports the proposition it is cited for.
                                Review every citation in context before
                                relying on it.
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
