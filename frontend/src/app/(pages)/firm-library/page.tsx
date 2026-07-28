"use client";

// Firm library (WS9). Every member of a firm sees the matters and standalone
// tabular reviews their colleagues have deliberately made firm-visible; opening
// one uses the normal matter/review views. Orgless self-hosters never reach the
// sidebar item, and the endpoint returns an empty library for them anyway.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Info, RefreshCw } from "lucide-react";
import { getFirmLibrary, type FirmLibraryItem } from "@/app/lib/mikeApi";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { FirmBadge } from "@/app/components/shared/FirmBadge";

type LibraryRow = FirmLibraryItem & {
    kind: "matter" | "review";
    href: string;
    typeLabel: string;
};

// DD/MM/YYYY, pinned to UTC to match the admin pages' date rendering.
function formatUkDate(value: string | null): string {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
        ? "—"
        : parsed.toLocaleDateString("en-GB", { timeZone: "UTC" });
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function contentsSummary(row: LibraryRow): string {
    if (row.kind === "review") return plural(row.documentCount, "document");
    const parts = [plural(row.documentCount, "document")];
    if (typeof row.chatCount === "number") {
        parts.push(plural(row.chatCount, "chat"));
    }
    return parts.join(" · ");
}

export default function FirmLibraryPage() {
    const router = useRouter();
    const { profile } = useUserProfile();
    const [projects, setProjects] = useState<FirmLibraryItem[] | null>(null);
    const [reviews, setReviews] = useState<FirmLibraryItem[] | null>(null);
    const [loadError, setLoadError] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);

    const firmName = profile?.firm?.name ?? "your firm";

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const library = await getFirmLibrary();
                if (!active) return;
                setProjects(library.projects);
                setReviews(library.reviews);
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
        setProjects(null);
        setReviews(null);
        setReloadKey((k) => k + 1);
    };

    const rows: LibraryRow[] | null = useMemo(() => {
        if (projects === null || reviews === null) return null;
        const combined: LibraryRow[] = [
            ...projects.map((item) => ({
                ...item,
                kind: "matter" as const,
                href: `/projects/${item.id}`,
                typeLabel: "Matter",
            })),
            ...reviews.map((item) => ({
                ...item,
                kind: "review" as const,
                href: `/tabular-reviews/${item.id}`,
                typeLabel: "Tabular review",
            })),
        ];
        return combined.sort(
            (a, b) =>
                Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""),
        );
    }, [projects, reviews]);

    const loading = rows === null && !loadError;

    return (
        <div className="flex h-full flex-col overflow-y-auto">
            <PageHeader
                shrink
                breadcrumbs={[{ label: "Firm" }, { label: "Firm library" }]}
            />
            <div className="mx-auto w-full max-w-4xl px-4 pb-16 md:px-10">
                <section className="mt-6 overflow-hidden rounded-xl border border-gray-200 bg-white">
                    <div className="border-b border-gray-100 px-5 py-4">
                        <h2 className="text-sm font-semibold text-gray-900">
                            Shared with everyone at {firmName}
                        </h2>
                        <p className="mt-0.5 text-xs text-gray-500">
                            Matters and tabular reviews owners have made
                            firm-visible. Open them like any other matter.
                        </p>
                    </div>

                    {loadError ? (
                        <div className="flex flex-col items-start gap-2.5 px-5 py-6">
                            <p className="text-sm text-gray-600">
                                Could not load the firm library.
                            </p>
                            <button
                                type="button"
                                onClick={retryLoad}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
                            >
                                <RefreshCw className="h-3.5 w-3.5" />
                                Try again
                            </button>
                        </div>
                    ) : loading ? (
                        <div className="space-y-2 px-5 py-4">
                            {[0, 1, 2].map((i) => (
                                <div
                                    key={i}
                                    className="h-6 w-full animate-pulse rounded bg-gray-100"
                                />
                            ))}
                        </div>
                    ) : rows && rows.length === 0 ? (
                        <p className="px-5 py-8 text-sm text-gray-500">
                            Nothing in the firm library yet. When a colleague
                            makes a matter or tabular review visible to the whole
                            firm, it will appear here for everyone to open.
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full border-collapse text-sm">
                                <thead>
                                    <tr className="border-b border-gray-200 text-left text-[10.5px] uppercase tracking-wide text-gray-400">
                                        <th className="px-5 py-2 font-medium">
                                            Name
                                        </th>
                                        <th className="px-5 py-2 font-medium">
                                            Owner
                                        </th>
                                        <th className="px-5 py-2 font-medium">
                                            Contents
                                        </th>
                                        <th className="px-5 py-2 text-right font-medium">
                                            Updated
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {(rows ?? []).map((row) => (
                                        <tr
                                            key={`${row.kind}-${row.id}`}
                                            onClick={() => router.push(row.href)}
                                            className="cursor-pointer border-b border-gray-100 transition-colors hover:bg-gray-50"
                                        >
                                            <td className="px-5 py-3">
                                                <div className="flex items-center gap-2">
                                                    <span className="font-medium text-gray-900">
                                                        {row.name?.trim() ||
                                                            `Untitled ${row.kind}`}
                                                    </span>
                                                    <FirmBadge />
                                                </div>
                                                <div className="mt-0.5 text-[11.5px] text-gray-400">
                                                    {row.typeLabel}
                                                </div>
                                            </td>
                                            <td className="px-5 py-3 text-gray-500">
                                                {row.ownerDisplayName?.trim() ||
                                                    (row.isOwner ? "You" : "—")}
                                            </td>
                                            <td className="whitespace-nowrap px-5 py-3 tabular-nums text-gray-500">
                                                {contentsSummary(row)}
                                            </td>
                                            <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums text-gray-500">
                                                {formatUkDate(row.updatedAt)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    <div className="flex items-start gap-2.5 border-t border-gray-100 bg-gray-50 px-5 py-3.5">
                        <Info className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                        <p className="text-xs leading-relaxed text-gray-600">
                            Only items someone has deliberately made firm-visible
                            appear here. Private and individually-shared matters
                            never do.
                        </p>
                    </div>
                </section>
            </div>
        </div>
    );
}
