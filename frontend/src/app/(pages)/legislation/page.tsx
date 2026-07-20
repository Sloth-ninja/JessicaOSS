"use client";

// Research › Legislation (WS7) — legislation.gov.uk lookup + title search.
// Two modes off one prominent input:
//   • Look up citation — parse a natural UK citation ("s.994 Companies Act
//     2006") straight to the provision view.
//   • Search by title — free-text Act/SI search; picking a result opens that
//     legislation's provision view.
// Submit-on-enter only (NO search-as-you-type): a title search hits several
// legislation.gov.uk feeds and can take 3–6s, so we never fire per-keystroke.
// The provision view reuses the shared LegislationPanel (assistant/) and
// always surfaces the amber outstanding-amendments band plus a per-effect list
// — CLAUDE.md forbids hiding revision lag.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, FileWarning, Landmark, MessageSquare, Search } from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { LegislationPanel } from "@/app/components/assistant/LegislationPanel";
import { Button } from "@/components/ui/button";
import { setAssistantPrefill } from "@/app/lib/assistantPrefill";
import {
    searchLegislation,
    lookupLegislation,
    type LegislationSearchMatch,
    type LegislationLookupResponse,
} from "@/app/lib/mikeApi";
import { cn } from "@/lib/utils";

type Mode = "lookup" | "search";

// Example chips teach the citation grammar the parser understands.
const LOOKUP_EXAMPLES = [
    "s.994 Companies Act 2006",
    "reg 5 The Community Interest Company Regulations 2005",
    "SI 2006/246",
    "Employment Rights Act 1996, s 98",
];
const SEARCH_EXAMPLES = [
    "Companies Act 2006",
    "Insolvency Act 1986",
    "Equality Act 2010",
];

function matchTypeLabel(type: string): string {
    // legislation.gov.uk type codes → short human badges.
    if (type === "ukpga" || type === "asp" || type === "nia" || type === "anaw")
        return "Act";
    if (type === "uksi" || type === "ssi" || type === "wsi" || type === "nisr")
        return "SI";
    return type.toUpperCase();
}

function matchReference(match: LegislationSearchMatch): string | null {
    if (!match.year && !match.number) return null;
    const isSi = matchTypeLabel(match.type) === "SI";
    if (isSi) {
        return match.number
            ? `SI ${match.year ?? ""}/${match.number}`.trim()
            : `${match.year ?? ""}`;
    }
    if (match.year && match.number) return `${match.year} c. ${match.number}`;
    return match.year ? `${match.year}` : null;
}

function lookupErrorMessage(): string {
    return "Could not reach legislation.gov.uk. Please try again later.";
}

export default function LegislationPage() {
    const router = useRouter();

    const [mode, setMode] = useState<Mode>("lookup");
    const [query, setQuery] = useState("");

    // Search-by-title state.
    const [matches, setMatches] = useState<LegislationSearchMatch[] | null>(
        null,
    );
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [selectedUrl, setSelectedUrl] = useState<string | null>(null);

    // Provision (lookup) state — shared by both modes' detail pane.
    const [lookup, setLookup] = useState<LegislationLookupResponse | null>(null);
    const [lookupLoading, setLookupLoading] = useState(false);
    const [lookupError, setLookupError] = useState<string | null>(null);
    // The human citation label used for the "Continue in Assistant" prefill.
    const [citationLabel, setCitationLabel] = useState("");

    function runLookup(citation: string, label: string) {
        const trimmed = citation.trim();
        if (!trimmed) return;
        setCitationLabel(label.trim() || trimmed);
        setLookup(null);
        setLookupError(null);
        setLookupLoading(true);
        lookupLegislation(trimmed)
            .then((res) => {
                setLookup(res);
                setLookupLoading(false);
            })
            .catch(() => {
                setLookupError(lookupErrorMessage());
                setLookupLoading(false);
            });
    }

    function runSearch(title: string) {
        const trimmed = title.trim();
        if (!trimmed) return;
        setSelectedUrl(null);
        setLookup(null);
        setLookupError(null);
        setSearchError(null);
        setMatches(null);
        setSearching(true);
        searchLegislation(trimmed)
            .then((res) => {
                setMatches(res.matches ?? []);
                setSearching(false);
            })
            .catch(() => {
                setSearchError(lookupErrorMessage());
                setSearching(false);
            });
    }

    function onSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (mode === "lookup") runLookup(query, query);
        else runSearch(query);
    }

    function onChipClick(value: string) {
        setQuery(value);
        if (mode === "lookup") runLookup(value, value);
        else runSearch(value);
    }

    function selectMatch(match: LegislationSearchMatch) {
        setSelectedUrl(match.url);
        // A search match is a whole Act/SI; open its provision view by
        // resolving a citation the backend can parse. Acts resolve by bare
        // title, but a whole SI has no title-only parse branch, so resolve
        // those by their "SI year/number" citation instead. The title stays
        // the human label for the prefill.
        const isSi = matchTypeLabel(match.type) === "SI";
        const citation =
            isSi && match.year && match.number
                ? `SI ${match.year}/${match.number}`
                : match.title;
        runLookup(citation, match.title);
    }

    function continueInAssistant() {
        if (!lookup || !lookup.resolved) return;
        setAssistantPrefill(
            `Regarding ${citationLabel} (${lookup.url}): `,
        );
        router.push("/assistant");
    }

    const examples = mode === "lookup" ? LOOKUP_EXAMPLES : SEARCH_EXAMPLES;
    const resolved = lookup && lookup.resolved ? lookup : null;
    const unresolved = lookup && !lookup.resolved ? lookup : null;
    const effects = resolved?.unapplied_effects ?? [];

    function renderDetail() {
        if (lookupLoading) {
            return (
                <div className="px-4 pt-6 md:px-10">
                    <SkeletonLine className="h-5 w-64" />
                    <SkeletonLine className="mt-3 w-44" />
                    <div className="mt-8 flex max-w-md flex-col gap-4">
                        {["w-full", "w-5/6", "w-2/3", "w-3/4"].map(
                            (widthClass, i) => (
                                <SkeletonLine key={i} className={widthClass} />
                            ),
                        )}
                    </div>
                </div>
            );
        }
        if (lookupError) {
            return (
                <div className="m-auto max-w-sm px-8 py-16 text-center">
                    <p className="text-sm text-gray-500">{lookupError}</p>
                </div>
            );
        }
        if (unresolved) {
            return (
                <div className="m-auto flex max-w-md flex-col items-center gap-2.5 px-8 py-16 text-center">
                    <FileWarning className="h-7 w-7 text-gray-300" />
                    <p className="text-sm font-medium text-gray-700">
                        Couldn&rsquo;t resolve that citation
                    </p>
                    <p className="text-[13px] leading-relaxed text-gray-500">
                        {unresolved.reason}
                    </p>
                    <p className="mt-1 text-xs text-gray-400">
                        Try the citation grammar in the examples above, e.g.
                        &ldquo;s.994 Companies Act 2006&rdquo;.
                    </p>
                </div>
            );
        }
        if (resolved) {
            return (
                <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 pt-4 md:px-6">
                        <div className="flex items-center gap-1.5 text-xs text-gray-500">
                            <Clock className="h-3.5 w-3.5 text-gray-400" />
                            Text from legislation.gov.uk — check the canonical
                            link for the latest revision.
                        </div>
                        <Button size="sm" onClick={continueInAssistant}>
                            <MessageSquare className="h-3.5 w-3.5" />
                            Continue in Assistant
                        </Button>
                    </div>

                    <div className="min-h-0 flex-1">
                        <LegislationPanel
                            url={resolved.url}
                            title={resolved.title}
                            provision={{
                                heading: resolved.heading,
                                text: resolved.text,
                                extent: resolved.extent,
                                unappliedEffects: resolved.unapplied_effects,
                            }}
                        />
                    </div>

                    {effects.length > 0 && (
                        <div className="max-h-56 shrink-0 overflow-y-auto border-t border-amber-200 bg-amber-50/40 px-4 py-3 md:px-6">
                            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-800">
                                Amendments not yet applied ({effects.length})
                            </h4>
                            <ul className="flex flex-col gap-2.5">
                                {effects.map((effect, i) => (
                                    <li
                                        key={i}
                                        className="text-[13px] leading-relaxed text-amber-900"
                                    >
                                        {effect.type && (
                                            <span className="mr-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
                                                {effect.type}
                                            </span>
                                        )}
                                        {effect.notes ??
                                            "Outstanding effect recorded on legislation.gov.uk."}
                                        {effect.affectedProvisions && (
                                            <span className="mt-0.5 block text-xs text-amber-700">
                                                Affects:{" "}
                                                {effect.affectedProvisions}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            );
        }
        // Nothing looked up yet — mode-dependent prompt.
        if (mode === "search" && matches && matches.length > 0) {
            return (
                <div className="m-auto flex max-w-sm flex-col items-center gap-2.5 px-8 py-16 text-center">
                    <Landmark className="h-7 w-7 text-gray-300" />
                    <p className="text-sm font-medium text-gray-700">
                        Select a result
                    </p>
                    <p className="text-[13px] text-gray-500">
                        Choose an Act or statutory instrument on the left to view
                        its provision text and any outstanding amendments.
                    </p>
                </div>
            );
        }
        return (
            <div className="m-auto flex max-w-sm flex-col items-center gap-2.5 px-8 py-16 text-center">
                <Landmark className="h-7 w-7 text-gray-300" />
                <p className="text-sm font-medium text-gray-700">
                    {mode === "lookup"
                        ? "Look up a provision"
                        : "Search UK legislation"}
                </p>
                <p className="text-[13px] text-gray-500">
                    {mode === "lookup"
                        ? "Enter a UK statutory citation to read the provision text, with a warning if amendments are outstanding. Data from legislation.gov.uk."
                        : "Search by Act or SI title, then open a result to read the provision text. Data from legislation.gov.uk."}
                </p>
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                shrink
                breadcrumbs={[{ label: "Research" }, { label: "Legislation" }]}
            />

            <div className="flex min-h-0 flex-1 flex-col border-t border-gray-200">
                {/* Prominent input + mode toggle + example chips */}
                <div className="shrink-0 border-b border-gray-200 px-4 py-4 md:px-10">
                    <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5 text-sm">
                        <button
                            type="button"
                            onClick={() => setMode("lookup")}
                            className={cn(
                                "rounded-md px-3 py-1.5 font-medium transition-colors",
                                mode === "lookup"
                                    ? "bg-white text-gray-900 shadow-sm"
                                    : "text-gray-500 hover:text-gray-900",
                            )}
                        >
                            Look up citation
                        </button>
                        <button
                            type="button"
                            onClick={() => setMode("search")}
                            className={cn(
                                "rounded-md px-3 py-1.5 font-medium transition-colors",
                                mode === "search"
                                    ? "bg-white text-gray-900 shadow-sm"
                                    : "text-gray-500 hover:text-gray-900",
                            )}
                        >
                            Search by title
                        </button>
                    </div>

                    <form onSubmit={onSubmit} className="mt-3">
                        <div className="flex h-11 max-w-2xl items-center gap-2.5 rounded-xl border border-gray-200 bg-white px-3.5 shadow-sm focus-within:border-gray-300">
                            <Search className="h-4 w-4 shrink-0 text-gray-400" />
                            <input
                                type="text"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder={
                                    mode === "lookup"
                                        ? "e.g. s.994 Companies Act 2006"
                                        : "Act or SI title, e.g. Companies Act 2006…"
                                }
                                aria-label={
                                    mode === "lookup"
                                        ? "Statutory citation to look up"
                                        : "Legislation title to search"
                                }
                                className="min-w-0 flex-1 bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400"
                            />
                            <Button
                                type="submit"
                                size="sm"
                                disabled={!query.trim()}
                            >
                                {mode === "lookup" ? "Look up" : "Search"}
                            </Button>
                        </div>
                    </form>

                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        <span className="mr-1 text-xs text-gray-400">
                            Try:
                        </span>
                        {examples.map((ex) => (
                            <button
                                key={ex}
                                type="button"
                                onClick={() => onChipClick(ex)}
                                className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
                            >
                                {ex}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Body: search list (search mode) + detail pane */}
                <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                    {mode === "search" && (
                        <div className="flex w-full shrink-0 flex-col border-b border-gray-200 max-md:max-h-64 md:min-h-0 md:w-80 md:border-b-0 md:border-r">
                            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
                                {searching ? (
                                    <div className="flex flex-col gap-3 px-2.5 py-3">
                                        {["w-3/4", "w-1/2", "w-2/3"].map(
                                            (widthClass, i) => (
                                                <div
                                                    key={i}
                                                    className="flex flex-col gap-1.5"
                                                >
                                                    <SkeletonLine
                                                        className={widthClass}
                                                    />
                                                    <SkeletonLine className="w-1/3" />
                                                </div>
                                            ),
                                        )}
                                    </div>
                                ) : searchError ? (
                                    <p className="px-2.5 py-3 text-xs text-gray-500">
                                        {searchError}
                                    </p>
                                ) : matches && matches.length === 0 ? (
                                    <p className="px-2.5 py-3 text-xs text-gray-500">
                                        No matching legislation. Try an Act or SI
                                        title, e.g. &ldquo;Companies Act
                                        2006&rdquo;.
                                    </p>
                                ) : matches ? (
                                    matches.map((match, i) => (
                                        <button
                                            key={`${match.url}-${i}`}
                                            onClick={() => selectMatch(match)}
                                            className={cn(
                                                "mb-0.5 w-full rounded-lg px-2.5 py-2 text-left transition-colors",
                                                selectedUrl === match.url
                                                    ? "bg-gray-200/60"
                                                    : "hover:bg-gray-100",
                                            )}
                                        >
                                            <div className="flex items-center gap-2">
                                                <span className="min-w-0 truncate text-[13px] font-semibold text-gray-900">
                                                    {match.title}
                                                </span>
                                                <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                                                    {matchTypeLabel(match.type)}
                                                </span>
                                            </div>
                                            {matchReference(match) && (
                                                <div className="mt-0.5 text-xs text-gray-500">
                                                    {matchReference(match)}
                                                </div>
                                            )}
                                        </button>
                                    ))
                                ) : (
                                    <p className="px-2.5 py-3 text-xs text-gray-400">
                                        Enter a title and press Enter to search
                                        legislation.gov.uk.
                                    </p>
                                )}
                            </div>
                        </div>
                    )}

                    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
                        {renderDetail()}
                    </div>
                </div>
            </div>
        </div>
    );
}
