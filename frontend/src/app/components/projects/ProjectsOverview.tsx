"use client";

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
import { FolderOpen, ChevronDown } from "lucide-react";
import {
    getClioStatus,
    listProjects,
    updateProject,
    deleteProject,
} from "@/app/lib/mikeApi";
import { OwnerOnlyModal } from "@/app/components/shared/OwnerOnlyModal";
import { useAuth } from "@/contexts/AuthContext";
import type { Project } from "@/app/components/shared/types";
import { NewProjectModal } from "./NewProjectModal";
import { ClioMattersTable } from "./ClioMattersTable";
import { LinkClioMatterModal } from "./LinkClioMatterModal";
import {
    isAbort,
    readStoredMattersTab,
    storeMattersTab,
    subscribeToMattersTab,
    timeBoxed,
    type MattersTab,
} from "@/app/lib/clioMatters";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { HeaderFilterDropdown } from "@/app/components/shared/HeaderFilterDropdown";
import {
    RowActionMenuItems,
    RowActions,
} from "@/app/components/shared/RowActions";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { FirmBadge } from "@/app/components/shared/FirmBadge";
import {
    TABLE_CHECKBOX_CLASS,
    TABLE_STICKY_CELL_BG,
    SkeletonDot,
    SkeletonLine,
    TableBody,
    TableCell,
    TableEmptyState,
    TableHeaderCell,
    TableHeaderRow,
    TablePrimaryCell,
    TableRow,
    TableScrollArea,
    TableStickyCell,
} from "@/app/components/shared/TablePrimitive";

function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

function getProjectOwnerLabel(project: Project, currentUserId?: string | null) {
    if (project.is_owner ?? project.user_id === currentUserId) return "Me";
    return (
        project.owner_display_name?.trim() ||
        project.owner_email?.trim() ||
        "Shared"
    );
}

type ProjectFilter = "all" | "mine" | "shared-with-me";

/**
 * Whether this solicitor's own Clio Manage login is connected. "unknown" means
 * the status call itself failed — the Clio tabs stay reachable in that case,
 * because the list below has its own error+retry; only a definite "no" folds
 * the page back to Workspaces.
 */
type ClioState = "loading" | "connected" | "disconnected" | "unknown";

const MATTER_STATUSES = [
    { value: "open", label: "Open" },
    { value: "pending", label: "Pending" },
    { value: "closed", label: "Closed" },
];

const SEARCH_DEBOUNCE_MS = 350;

export function ProjectsOverview() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [activeFilter, setActiveFilter] = useState<ProjectFilter>("all");
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [cmEditingId, setCmEditingId] = useState<string | null>(null);
    const [cmValue, setCmValue] = useState("");
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [actionsOpen, setActionsOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const actionsRef = useRef<HTMLDivElement>(null);
    const router = useRouter();
    const { user, isAuthenticated, authLoading } = useAuth();

    // ── Clio-backed tabs (Practice Management) ───────────────────────────────
    const [clioState, setClioState] = useState<ClioState>("loading");
    // The remembered tab is external state (localStorage), so it is read through
    // useSyncExternalStore with a null server snapshot — a useState initialiser
    // would render one tab on the server and hydrate a different one. The
    // override keeps the page working when storage writes are unavailable
    // (private mode), and null still means "no preference yet".
    const storedTab = useSyncExternalStore(
        subscribeToMattersTab,
        readStoredMattersTab,
        () => null,
    );
    const [tabOverride, setTabOverride] = useState<MattersTab | null>(null);
    const tabPref = tabOverride ?? storedTab;
    const [statusFilter, setStatusFilter] = useState<string | null>(null);
    const [debouncedQuery, setDebouncedQuery] = useState("");
    const [linkingProject, setLinkingProject] = useState<Project | null>(null);
    // Workspace linking is gated on its own migration having run. Until a Clio
    // list answers (the table or the picker — both carry the flag), assume it
    // works: hiding the action on no evidence would be its own lie.
    const [linksUnavailable, setLinksUnavailable] = useState(false);
    const handleLinksUnavailable = useCallback(
        (unavailable: boolean) => setLinksUnavailable(unavailable),
        [],
    );

    useEffect(() => {
        if (authLoading || !isAuthenticated) return;
        const controller = new AbortController();
        const run = async () => {
            try {
                // Time-boxed: an unanswered status call must never leave the
                // tab bar stuck in "loading" (login-spinner lesson, 21/07).
                const status = await timeBoxed(
                    (signal) => getClioStatus(signal),
                    controller.signal,
                );
                setClioState(
                    status.manage.connected ? "connected" : "disconnected",
                );
            } catch (err) {
                if (isAbort(err)) return;
                setClioState("unknown");
            }
        };
        void run();
        return () => controller.abort();
    }, [authLoading, isAuthenticated, user?.id]);

    const clioConnected = clioState === "connected";
    // A definite "not connected" folds the page back to Workspaces — the
    // Clio tabs are then absent rather than disabled (the WS8 pattern).
    const clioTabsAvailable = clioState !== "disconnected";
    const activeTab: MattersTab =
        tabPref === null
            ? clioConnected
                ? "mine"
                : "workspaces"
            : !clioTabsAvailable && tabPref !== "workspaces"
              ? "workspaces"
              : tabPref;
    const isClioTab = activeTab !== "workspaces";

    const selectTab = useCallback((tab: MattersTab) => {
        setTabOverride(tab);
        storeMattersTab(tab);
    }, []);

    const handleReconnectNeeded = useCallback(() => {
        setClioState("disconnected");
    }, []);

    // Debounce the search box before it becomes a Clio query — typing must not
    // spend the 50 req/min per-user budget a keystroke at a time.
    useEffect(() => {
        const trimmed = search.trim();
        const timer = setTimeout(
            () => setDebouncedQuery(trimmed),
            trimmed ? SEARCH_DEBOUNCE_MS : 0,
        );
        return () => clearTimeout(timer);
    }, [search]);

    useEffect(() => {
        if (authLoading) {
            setLoading(true);
            return;
        }
        if (!isAuthenticated) {
            setProjects([]);
            setLoadError(null);
            setLoading(false);
            return;
        }

        let cancelled = false;
        setLoading(true);
        setLoadError(null);
        listProjects()
            .then((loaded) => {
                if (!cancelled) setProjects(loaded);
            })
            .catch((err) => {
                console.error("[projects] failed to load projects", err);
                if (!cancelled) {
                    setProjects([]);
                    setLoadError("Could not load matters.");
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [authLoading, isAuthenticated, user?.id]);

    useEffect(() => {
        setSelectedIds([]);
    }, [activeFilter]);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (
                actionsRef.current &&
                !actionsRef.current.contains(e.target as Node)
            )
                setActionsOpen(false);
        }
        if (actionsOpen) document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [actionsOpen]);

    const q = search.toLowerCase();
    const filtered = (
        activeFilter === "all"
            ? projects
            : activeFilter === "mine"
              ? projects.filter((p) => p.is_owner ?? p.user_id === user?.id)
              : projects.filter((p) => !(p.is_owner ?? p.user_id === user?.id))
    ).filter(
        (p) =>
            !q ||
            p.name.toLowerCase().includes(q) ||
            (p.cm_number ?? "").toLowerCase().includes(q),
    );

    const allSelected =
        filtered.length > 0 &&
        filtered.every((p) => selectedIds.includes(p.id));
    const someSelected =
        !allSelected && filtered.some((p) => selectedIds.includes(p.id));

    function toggleAll() {
        if (allSelected) {
            setSelectedIds([]);
        } else {
            setSelectedIds(filtered.map((p) => p.id));
        }
    }

    function toggleOne(id: string) {
        setSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
    }

    const filters: { id: ProjectFilter; label: string }[] = [
        { id: "all", label: "All" },
        { id: "mine", label: "Mine" },
        { id: "shared-with-me", label: "Shared with me" },
    ];

    async function handleRenameSubmit(projectId: string) {
        const trimmed = renameValue.trim();
        setRenamingId(null);
        if (!trimmed) return;
        setProjects((prev) =>
            prev.map((p) => (p.id === projectId ? { ...p, name: trimmed } : p)),
        );
        await updateProject(projectId, { name: trimmed });
    }

    async function handleCmSubmit(projectId: string) {
        const trimmed = cmValue.trim();
        setCmEditingId(null);
        setProjects((prev) =>
            prev.map((p) =>
                p.id === projectId ? { ...p, cm_number: trimmed || null } : p,
            ),
        );
        await updateProject(projectId, { cm_number: trimmed || undefined });
    }

    async function handleDeleteSelected() {
        const ids = [...selectedIds];
        setActionsOpen(false);
        // Only the project owner can delete; the per-row delete is hidden
        // for shared projects but the bulk action can still pick them up
        // if a user toggled them across filters. Filter and warn.
        const owned = ids.filter((id) => {
            const p = projects.find((pp) => pp.id === id);
            return !p || (p.is_owner ?? p.user_id === user?.id);
        });
        const blocked = ids.length - owned.length;
        setSelectedIds([]);
        await Promise.all(owned.map((id) => deleteProject(id).catch(() => {})));
        setProjects((prev) => prev.filter((p) => !owned.includes(p.id)));
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected matters — only the matter owner can delete a matter`,
            );
        }
    }

    // The three top-level tabs. Absent — not disabled — when this solicitor has
    // no Clio connection, so the page is exactly today's Workspaces list.
    const mattersTabs: { id: MattersTab; label: string }[] = [
        { id: "mine", label: "My matters" },
        { id: "all", label: "All matters" },
        { id: "workspaces", label: "Workspaces" },
    ];

    const statusFilterControl = (
        <div className="flex items-center gap-1 text-xs text-gray-500">
            <span>
                {MATTER_STATUSES.find((s) => s.value === statusFilter)?.label ??
                    "Any status"}
            </span>
            <HeaderFilterDropdown
                label="Filter matters by status"
                value={statusFilter}
                allLabel="Any status"
                options={MATTER_STATUSES}
                onChange={setStatusFilter}
                widthClassName="w-40"
            />
        </div>
    );

    // On the Workspaces tab these sit beside the tabs rather than replacing
    // them, so both levels of filtering stay reachable at once.
    const workspaceFilterButtons = (
        <div className="flex items-center gap-4">
            {filters.map((item) => (
                <button
                    key={item.id}
                    onClick={() => setActiveFilter(item.id)}
                    className={`text-xs transition-colors ${
                        activeFilter === item.id
                            ? "font-medium text-gray-700"
                            : "font-normal text-gray-500 hover:text-gray-700"
                    }`}
                >
                    {item.label}
                </button>
            ))}
        </div>
    );

    const toolbarActions = (
        <>
            {selectedIds.length > 0 && (
                <div ref={actionsRef} className="relative">
                    <button
                        onClick={() => setActionsOpen((v) => !v)}
                        className="flex items-center gap-1 text-xs font-medium text-gray-700 hover:text-gray-900 transition-colors"
                    >
                        Actions
                        <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    {actionsOpen && (
                        <div className="absolute top-full right-0 mt-1 w-36 rounded-lg border border-gray-100 bg-white shadow-lg z-50 overflow-hidden">
                            <button
                                onClick={handleDeleteSelected}
                                className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
                            >
                                Delete
                            </button>
                        </div>
                    )}
                </div>
            )}
        </>
    );

    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            {/* Page header */}
            <PageHeader
                loading={isClioTab ? false : loading}
                actions={[
                    {
                        type: "search",
                        value: search,
                        onChange: setSearch,
                        placeholder: isClioTab
                            ? "Search matters…"
                            : "Search workspaces…",
                    },
                    {
                        type: "new",
                        onClick: () => setModalOpen(true),
                        title: "New workspace",
                    },
                ]}
            >
                <h1 className="text-2xl font-medium font-serif text-gray-900">
                    Matters
                </h1>
            </PageHeader>

            {clioTabsAvailable ? (
                <TableToolbar
                    items={mattersTabs}
                    active={activeTab}
                    onChange={selectTab}
                    actions={
                        <>
                            {isClioTab
                                ? statusFilterControl
                                : workspaceFilterButtons}
                            {!isClioTab && toolbarActions}
                        </>
                    }
                />
            ) : (
                <TableToolbar
                    items={filters}
                    active={activeFilter}
                    onChange={setActiveFilter}
                    actions={toolbarActions}
                />
            )}

            {clioState === "disconnected" && (
                <p className="shrink-0 border-b border-gray-100 bg-gray-50/60 px-4 py-2 text-xs text-gray-500 md:px-10">
                    <span className="font-medium text-gray-700">
                        Clio not connected.
                    </span>{" "}
                    Showing your JessicaOS workspaces. Connect Clio in Account →
                    Connectors to see your firm&rsquo;s matters here.
                </p>
            )}

            {isClioTab ? (
                <ClioMattersTable
                    tab={activeTab}
                    query={debouncedQuery}
                    status={statusFilter}
                    onLinksUnavailable={handleLinksUnavailable}
                    // A 401 from Clio means the connection needs re-authorising:
                    // fold to Workspaces and show the Frame C banner, which
                    // carries the route back to Account → Connectors.
                    onReconnectNeeded={handleReconnectNeeded}
                />
            ) : (
            /* Table */
            <TableScrollArea>
                {/* Column headers */}
                <TableHeaderRow>
                    <TableStickyCell header>
                        {loading ? (
                            <SkeletonDot />
                        ) : (
                            <input
                                type="checkbox"
                                checked={allSelected}
                                ref={(el) => {
                                    if (el) el.indeterminate = someSelected;
                                }}
                                onChange={toggleAll}
                                className={TABLE_CHECKBOX_CLASS}
                            />
                        )}
                        <span>Name</span>
                    </TableStickyCell>
                    <TableHeaderCell className="ml-auto w-32">CM</TableHeaderCell>
                    <TableHeaderCell className="w-32">Owner</TableHeaderCell>
                    <TableHeaderCell className="w-24">Files</TableHeaderCell>
                    <TableHeaderCell className="w-24">Chats</TableHeaderCell>
                    <TableHeaderCell className="w-36">
                        Tabular Reviews
                    </TableHeaderCell>
                    <TableHeaderCell className="w-32">Created</TableHeaderCell>
                    <TableHeaderCell className="w-8" />
                </TableHeaderRow>

                {loading ? (
                    <TableBody>
                        {[1, 2, 3].map((i) => (
                            <TableRow
                                key={i}
                                interactive={false}
                            >
                                <TableStickyCell
                                    hover={false}
                                    bgClassName="bg-transparent"
                                >
                                    <SkeletonDot />
                                    <SkeletonLine className="h-3.5 w-48" />
                                </TableStickyCell>
                                <TableCell className="ml-auto w-32">
                                    <SkeletonLine className="w-20" />
                                </TableCell>
                                <TableCell className="w-32">
                                    <SkeletonLine className="w-16" />
                                </TableCell>
                                <TableCell className="w-24">
                                    <SkeletonLine className="w-8" />
                                </TableCell>
                                <TableCell className="w-24">
                                    <SkeletonLine className="w-8" />
                                </TableCell>
                                <TableCell className="w-36">
                                    <SkeletonLine className="w-8" />
                                </TableCell>
                                <TableCell className="w-32">
                                    <SkeletonLine className="w-20" />
                                </TableCell>
                                <TableCell className="w-8" />
                            </TableRow>
                        ))}
                    </TableBody>
                ) : loadError ? (
                    <TableEmptyState>
                        <FolderOpen className="h-8 w-8 text-gray-300 mb-4" />
                        <p className="text-2xl font-medium font-serif text-gray-900">
                            Matters
                        </p>
                        <p className="mt-1 text-xs text-red-500 max-w-xs">
                            {loadError}
                        </p>
                    </TableEmptyState>
                ) : filtered.length === 0 ? (
                    <TableEmptyState>
                        {activeFilter === "all" || activeFilter === "mine" ? (
                            <>
                                <FolderOpen className="h-8 w-8 text-gray-300 mb-4" />
                                <p className="text-2xl font-medium font-serif text-gray-900">
                                    Matters
                                </p>
                                <p className="mt-1 text-xs text-gray-400 max-w-xs">
                                    Upload documents into matters and to
                                    commence chats and tabular reviews with
                                    them.
                                </p>
                                <button
                                    onClick={() => setModalOpen(true)}
                                    className="mt-4 inline-flex items-center gap-1 rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white hover:bg-gray-700 transition-colors shadow-md"
                                >
                                    + Create New
                                </button>
                            </>
                        ) : (
                            <p className="text-sm text-gray-400">
                                No matters shared with you
                            </p>
                        )}
                    </TableEmptyState>
                ) : (
                    <TableBody>
                        {filtered.map((project) => {
                            const rowBg = selectedIds.includes(project.id)
                                ? "bg-gray-50"
                                : TABLE_STICKY_CELL_BG;
                            return (
                            <TableRow
                                key={project.id}
                                rightClickDropdown={
                                    (project.is_owner ??
                                        project.user_id === user?.id)
                                        ? (close) => (
                                              <RowActionMenuItems
                                                  onClose={close}
                                                  onRename={() => {
                                                      setRenameValue(
                                                          project.name,
                                                      );
                                                      setRenamingId(project.id);
                                                  }}
                                                  onUpdateCmNumber={() => {
                                                      setCmValue(
                                                          project.cm_number ??
                                                              "",
                                                      );
                                                      setCmEditingId(
                                                          project.id,
                                                      );
                                                  }}
                                                  onLinkClioMatter={
                                                      clioConnected &&
                                                      !linksUnavailable
                                                          ? () =>
                                                                setLinkingProject(
                                                                    project,
                                                                )
                                                          : undefined
                                                  }
                                                  onDelete={async () => {
                                                      await deleteProject(
                                                          project.id,
                                                      );
                                                      setProjects((prev) =>
                                                          prev.filter(
                                                              (p) =>
                                                                  p.id !==
                                                                  project.id,
                                                          ),
                                                      );
                                                  }}
                                              />
                                          )
                                        : undefined
                                }
                                onClick={() => {
                                    if (renamingId === project.id) return;
                                    router.push(`/projects/${project.id}`);
                                }}
                            >
                                {/* Project Name */}
                                <TablePrimaryCell
                                    bgClassName={rowBg}
                                    selected={selectedIds.includes(project.id)}
                                    onSelectionChange={() =>
                                        toggleOne(project.id)
                                    }
                                    label={project.name}
                                    adornment={
                                        project.visibility === "firm" ? (
                                            <FirmBadge />
                                        ) : undefined
                                    }
                                    editing={renamingId === project.id}
                                    editValue={renameValue}
                                    onEditValueChange={setRenameValue}
                                    onEditCommit={() =>
                                        handleRenameSubmit(project.id)
                                    }
                                    onEditCancel={() => setRenamingId(null)}
                                />

                                <TableCell
                                    className="ml-auto w-32"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {cmEditingId === project.id ? (
                                        <input
                                            autoFocus
                                            value={cmValue}
                                            onChange={(e) =>
                                                setCmValue(e.target.value)
                                            }
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter")
                                                    handleCmSubmit(project.id);
                                                if (e.key === "Escape")
                                                    setCmEditingId(null);
                                            }}
                                            onBlur={() =>
                                                handleCmSubmit(project.id)
                                            }
                                            placeholder="CM #"
                                            className="w-full text-sm text-gray-800 bg-transparent outline-none"
                                        />
                                    ) : (
                                        (project.cm_number ?? (
                                            <span className="text-gray-300">
                                                —
                                            </span>
                                        ))
                                    )}
                                </TableCell>
                                <TableCell className="w-32">
                                    {getProjectOwnerLabel(project, user?.id)}
                                </TableCell>
                                <TableCell className="w-24">
                                    {project.document_count ?? 0}
                                </TableCell>
                                <TableCell className="w-24">
                                    {project.chat_count ?? 0}
                                </TableCell>
                                <TableCell className="w-36">
                                    {project.review_count ?? 0}
                                </TableCell>
                                <TableCell className="w-32">
                                    {formatDate(project.created_at)}
                                </TableCell>

                                <div
                                    className="w-8 shrink-0 flex justify-end"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {(project.is_owner ??
                                        project.user_id === user?.id) && (
                                        <RowActions
                                            onRename={() => {
                                                setRenameValue(project.name);
                                                setRenamingId(project.id);
                                            }}
                                            onUpdateCmNumber={() => {
                                                setCmValue(
                                                    project.cm_number ?? "",
                                                );
                                                setCmEditingId(project.id);
                                            }}
                                            onLinkClioMatter={
                                                clioConnected &&
                                                !linksUnavailable
                                                    ? () =>
                                                          setLinkingProject(
                                                              project,
                                                          )
                                                    : undefined
                                            }
                                            onDelete={async () => {
                                                await deleteProject(project.id);
                                                setProjects((prev) =>
                                                    prev.filter(
                                                        (p) =>
                                                            p.id !== project.id,
                                                    ),
                                                );
                                            }}
                                        />
                                    )}
                                </div>
                            </TableRow>
                            );
                        })}
                    </TableBody>
                )}
            </TableScrollArea>
            )}

            <NewProjectModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                onCreated={(p) => {
                    setProjects((prev) => [p, ...prev]);
                    // A workspace created from a Clio tab would otherwise land
                    // in a list the user cannot see — move them to Workspaces
                    // so the thing they just made is where they come back to.
                    if (isClioTab) selectTab("workspaces");
                    router.push(`/projects/${p.id}`);
                }}
            />

            <LinkClioMatterModal
                open={linkingProject !== null}
                projectId={linkingProject?.id ?? null}
                projectName={linkingProject?.name ?? null}
                onClose={() => setLinkingProject(null)}
                onLinksUnavailable={handleLinksUnavailable}
            />

            <OwnerOnlyModal
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
        </div>
    );
}
