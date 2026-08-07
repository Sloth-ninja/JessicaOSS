"use client";

// "Link to a Clio matter" — anchors an EXISTING JessicaOS workspace to a Clio
// matter so its documents, chats and reviews sit under that matter.
//
// Only the workspace's owner may link or unlink it; the server enforces that
// and the three distinct 409 refusals (matter already linked / workspace
// already linked / links not available yet) are shown verbatim, because each
// tells the solicitor a different thing to do next.

import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, Search, X } from "lucide-react";
import { Modal } from "@/app/components/shared/Modal";
import {
    linkWorkspaceToClioMatter,
    listClioMatters,
    MikeApiError,
    type ClioMatterRow,
    type ClioWorkspaceLink,
} from "@/app/lib/mikeApi";
import { formatUkDate, isAbort, timeBoxed } from "@/app/lib/clioMatters";

interface Props {
    open: boolean;
    projectId: string | null;
    projectName: string | null;
    onClose: () => void;
    onLinked?: (link: ClioWorkspaceLink) => void;
    /** Reports whether workspace linking exists on this deployment. The picker
     *  is the first thing to learn it (it lists matters on open), so it tells
     *  the page, which then stops offering the action at all. */
    onLinksUnavailable?: (unavailable: boolean) => void;
}

const SEARCH_DEBOUNCE_MS = 350;

export function LinkClioMatterModal({
    open,
    projectId,
    projectName,
    onClose,
    onLinked,
    onLinksUnavailable,
}: Props) {
    const [search, setSearch] = useState("");
    const [debounced, setDebounced] = useState("");
    const [matters, setMatters] = useState<ClioMatterRow[] | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [linking, setLinking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [linksUnavailable, setLinksUnavailable] = useState(false);
    const seqRef = useRef(0);

    // Debounce the search box so typing does not spend Clio's request budget.
    useEffect(() => {
        if (!open) return;
        const timer = setTimeout(
            () => setDebounced(search.trim()),
            search.trim() ? SEARCH_DEBOUNCE_MS : 0,
        );
        return () => clearTimeout(timer);
    }, [search, open]);

    useEffect(() => {
        if (!open) return;
        const seq = ++seqRef.current;
        const controller = new AbortController();
        const run = async () => {
            try {
                const loaded = await timeBoxed(
                    (signal) =>
                        listClioMatters(
                            {
                                tab: "all",
                                ...(debounced ? { query: debounced } : {}),
                            },
                            signal,
                        ),
                    controller.signal,
                );
                if (seqRef.current !== seq) return;
                setMatters(loaded.matters);
                setListError(null);
                setLinksUnavailable(loaded.linksUnavailable);
                onLinksUnavailable?.(loaded.linksUnavailable);
            } catch (err) {
                if (isAbort(err) || seqRef.current !== seq) return;
                setMatters([]);
                setListError(
                    err instanceof MikeApiError &&
                        (err.status === 401 || err.status === 403)
                        ? err.message
                        : "Could not load matters from Clio. Please try again.",
                );
            }
        };
        void run();
        return () => controller.abort();
    }, [debounced, open, onLinksUnavailable]);

    const handleClose = useCallback(() => {
        if (linking) return;
        setSearch("");
        setDebounced("");
        setSelectedId(null);
        setError(null);
        setMatters(null);
        setListError(null);
        onClose();
    }, [linking, onClose]);

    async function handleLink() {
        if (!projectId || !selectedId) return;
        setLinking(true);
        setError(null);
        try {
            const link = await linkWorkspaceToClioMatter(
                projectId,
                selectedId,
            );
            onLinked?.(link);
            setLinking(false);
            setSearch("");
            setDebounced("");
            setSelectedId(null);
            setMatters(null);
            setListError(null);
            onClose();
        } catch (err) {
            setLinking(false);
            // Server details here are fixed, user-safe strings, and the three
            // 409s differ deliberately — pass them through unchanged.
            setError(
                err instanceof MikeApiError && err.message
                    ? err.message
                    : "Could not link this workspace to that matter.",
            );
        }
    }

    if (!open) return null;

    return (
        <Modal
            open={open}
            onClose={handleClose}
            breadcrumbs={["Matters", "Link to a Clio matter"]}
            primaryAction={{
                label: linking ? "Linking…" : "Link matter",
                onClick: () => void handleLink(),
                disabled:
                    !selectedId || linking || !projectId || linksUnavailable,
            }}
            cancelAction={{ label: "Cancel", onClick: handleClose }}
        >
            <div className="flex min-h-0 flex-1 flex-col">
                <p className="text-[13px] leading-relaxed text-gray-500">
                    Documents, chats and reviews in{" "}
                    <span className="font-medium text-gray-700">
                        {projectName ?? "this workspace"}
                    </span>{" "}
                    will be shown against the Clio matter you choose. Nothing is
                    copied from Clio, and only you can change this link.
                </p>

                <div className="pt-3 pb-2">
                    <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                        <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                        <input
                            type="text"
                            placeholder="Search Clio matters…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            autoFocus
                            className="flex-1 bg-transparent text-sm text-gray-700 outline-none placeholder:text-gray-400"
                        />
                        {search && (
                            <button
                                type="button"
                                onClick={() => setSearch("")}
                                className="text-gray-400 hover:text-gray-600"
                                aria-label="Clear search"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto pb-2">
                    {linksUnavailable ? (
                        /* The picker would otherwise let a solicitor choose a
                           matter and only then be refused. */
                        <p className="py-8 text-center text-sm text-gray-500">
                            Workspace linking isn&rsquo;t available yet.
                        </p>
                    ) : matters === null ? (
                        <div className="flex flex-col gap-2 py-3">
                            {[0, 1, 2].map((i) => (
                                <div
                                    key={i}
                                    className="h-6 w-full animate-pulse rounded bg-gray-100"
                                />
                            ))}
                        </div>
                    ) : listError ? (
                        <p className="py-8 text-center text-sm text-gray-500">
                            {listError}
                        </p>
                    ) : matters.length === 0 ? (
                        <p className="py-8 text-center text-sm text-gray-400">
                            {debounced
                                ? "No matters match that search"
                                : "No Clio matters available"}
                        </p>
                    ) : (
                        matters.map((matter) => {
                            const isSelected = selectedId === matter.id;
                            return (
                                <button
                                    key={matter.id}
                                    type="button"
                                    onClick={() =>
                                        setSelectedId(
                                            isSelected ? null : matter.id,
                                        )
                                    }
                                    className={`flex w-full items-center gap-2 px-2 py-2 text-left text-xs transition-colors ${
                                        isSelected
                                            ? "bg-gray-100"
                                            : "hover:bg-gray-50"
                                    }`}
                                >
                                    <span
                                        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                                            isSelected
                                                ? "border-gray-900 bg-gray-900"
                                                : "border-gray-300"
                                        }`}
                                    >
                                        <span className="h-1.5 w-1.5 rounded-full bg-white" />
                                    </span>
                                    <Folder className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                    <span
                                        className={`flex-1 truncate ${
                                            isSelected
                                                ? "font-medium text-gray-900"
                                                : "text-gray-700"
                                        }`}
                                    >
                                        {matter.displayNumber ??
                                            "Untitled matter"}
                                        {matter.description
                                            ? ` — ${matter.description}`
                                            : ""}
                                    </span>
                                    <span className="shrink-0 text-gray-400">
                                        {formatUkDate(matter.openDate)}
                                    </span>
                                </button>
                            );
                        })
                    )}
                </div>

                {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
            </div>
        </Modal>
    );
}
