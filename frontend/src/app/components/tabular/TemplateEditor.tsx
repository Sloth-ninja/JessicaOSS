"use client";

// Review template editor. Three modes:
//   • draft      — /review-templates/new, held client-side until the first
//                  column exists (the server requires at least one column)
//   • owned      — full editing, columns auto-save like the workflow editor
//   • read-only  — built-in templates and templates shared with the caller;
//                  Duplicate makes an editable copy that belongs to them
// Columns reuse AddColumnModal / WFEditColumnModal / columnFormat, exactly as
// the older workflow editor does.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import {
    MikeApiError,
    createTabularTemplate,
    deleteTabularTemplate,
    getTabularTemplate,
    updateTabularTemplate,
    type TabularTemplate,
} from "@/app/lib/mikeApi";
import type { ColumnConfig, Workflow } from "../shared/types";
import { AddColumnModal } from "./AddColumnModal";
import { TemplateDetailsModal } from "./TemplateDetailsModal";
import { WFColumnViewModal } from "../workflows/WFColumnViewModal";
import { WFEditColumnModal } from "../workflows/WFEditColumnModal";
import { BUILT_IN_WORKFLOWS } from "../workflows/builtinWorkflows";
import { formatIcon, formatLabel } from "./columnFormat";
import { ConfirmPopup } from "../shared/ConfirmPopup";
import { HeaderActionsMenu } from "../shared/HeaderActionsMenu";
import { PageHeader } from "../shared/PageHeader";
import { FirmBadge } from "../shared/FirmBadge";

const MAX_TEMPLATE_COLUMNS = 30;
const NAME_COL_W = "w-[332px] shrink-0";

type SaveStatus = "idle" | "saving" | "saved";

function findBuiltIn(id: string): Workflow | null {
    return (
        BUILT_IN_WORKFLOWS.find(
            (workflow) => workflow.id === id && workflow.type === "tabular",
        ) ?? null
    );
}

export function TemplateEditor({ templateId }: { templateId: string }) {
    const router = useRouter();
    const isDraft = templateId === "new";
    const builtIn = isDraft ? null : findBuiltIn(templateId);

    const [template, setTemplate] = useState<TabularTemplate | null>(null);
    const [title, setTitle] = useState(isDraft ? "" : (builtIn?.title ?? ""));
    const [practice, setPractice] = useState<string | null>(
        builtIn?.practice ?? null,
    );
    const [columns, setColumns] = useState<ColumnConfig[]>(
        builtIn?.columns_config ?? [],
    );
    const [loading, setLoading] = useState(!isDraft && !builtIn);
    const [loadError, setLoadError] = useState(false);
    const [notFound, setNotFound] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);

    const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
    const [actionError, setActionError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);

    const [addColumnOpen, setAddColumnOpen] = useState(false);
    const [editingColumn, setEditingColumn] = useState<ColumnConfig | null>(
        null,
    );
    const [viewingColumn, setViewingColumn] = useState<ColumnConfig | null>(
        null,
    );
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleteStatus, setDeleteStatus] = useState<
        "idle" | "loading" | "complete"
    >("idle");

    // Built-ins and templates owned by someone else open read-only with a
    // Duplicate action; only a draft or the caller's own template is editable.
    const canEdit = isDraft || (!builtIn && !!template && template.isOwner);

    useEffect(() => {
        if (isDraft || builtIn) return;
        let active = true;
        (async () => {
            try {
                const loaded = await getTabularTemplate(templateId);
                if (!active) return;
                setTemplate(loaded);
                setTitle(loaded.title);
                setPractice(loaded.practice);
                setColumns(
                    [...loaded.columns].sort((a, b) => a.index - b.index),
                );
                setLoadError(false);
                setNotFound(false);
            } catch (err) {
                if (!active) return;
                if (err instanceof MikeApiError && err.status === 404) {
                    setNotFound(true);
                } else {
                    setLoadError(true);
                }
            } finally {
                if (active) setLoading(false);
            }
        })();
        return () => {
            active = false;
        };
    }, [templateId, isDraft, builtIn, reloadKey]);

    // State reset lives in the handler, not the effect (set-state-in-effect).
    const retryLoad = () => {
        setLoadError(false);
        setLoading(true);
        setReloadKey((k) => k + 1);
    };

    async function persistColumns(
        next: ColumnConfig[],
        previous: ColumnConfig[],
    ) {
        if (isDraft || !template || !template.isOwner) return;
        setSaveStatus("saving");
        setActionError(null);
        try {
            const updated = await updateTabularTemplate(template.id, {
                columns: next,
            });
            setTemplate(updated);
            setSaveStatus("saved");
            setTimeout(() => setSaveStatus("idle"), 2000);
        } catch (err) {
            // Snapshot + rollback (the admin card's pattern): a failed save
            // restores the previous columns so what is shown always matches
            // what the server holds.
            setColumns(previous);
            setSaveStatus("idle");
            setActionError(
                err instanceof MikeApiError && err.message
                    ? err.message
                    : "Could not save the template. Your last change was undone — please try again.",
            );
        }
    }

    // Optimistic write with the previous state captured for rollback.
    function applyColumns(next: ColumnConfig[]) {
        const previous = columns;
        setColumns(next);
        void persistColumns(next, previous);
    }

    function handleColumnsAdded(added: ColumnConfig[]) {
        const next = [
            ...columns,
            ...added.map((column, i) => ({
                ...column,
                index: columns.length + i,
            })),
        ].slice(0, MAX_TEMPLATE_COLUMNS);
        applyColumns(next);
        setAddColumnOpen(false);
    }

    function handleColumnSaved(updated: ColumnConfig) {
        applyColumns(
            columns.map((column) =>
                column.index === updated.index ? updated : column,
            ),
        );
        setEditingColumn(null);
    }

    function removeColumn(index: number) {
        if (columns.length <= 1) {
            setActionError("A template needs at least one column.");
            return;
        }
        applyColumns(
            columns
                .filter((column) => column.index !== index)
                .map((column, i) => ({ ...column, index: i })),
        );
    }

    async function createDraft() {
        if (!title.trim() || columns.length === 0 || creating) return;
        setCreating(true);
        setActionError(null);
        try {
            const created = await createTabularTemplate({
                title: title.trim(),
                practice,
                columns,
            });
            router.replace(`/review-templates/${created.id}`);
        } catch (err) {
            setActionError(
                err instanceof MikeApiError && err.message
                    ? err.message
                    : "Could not create the template. Please try again.",
            );
            setCreating(false);
        }
    }

    async function duplicateTemplate() {
        setActionError(null);
        try {
            const created = await createTabularTemplate({
                title: `${title} (copy)`.slice(0, 200),
                practice,
                columns,
            });
            router.push(`/review-templates/${created.id}`);
        } catch (err) {
            setActionError(
                err instanceof MikeApiError && err.message
                    ? err.message
                    : "Could not duplicate that template.",
            );
        }
    }

    async function handleDelete() {
        if (!template) return;
        setDeleteStatus("loading");
        try {
            await deleteTabularTemplate(template.id);
            setDeleteStatus("complete");
            setTimeout(() => router.push("/review-templates"), 600);
        } catch {
            setDeleteStatus("idle");
            setActionError("Could not delete that template.");
        }
    }

    const breadcrumbs = [
        {
            label: "Templates",
            onClick: () => router.push("/review-templates"),
            title: "Back to Templates",
        },
        {
            label: (
                <span className="max-w-xs truncate text-gray-900">
                    {isDraft ? "New template" : title || "Untitled template"}
                </span>
            ),
        },
    ];

    if (loading) {
        return (
            <div className="flex h-full flex-col">
                <PageHeader
                    shrink
                    breadcrumbs={[
                        breadcrumbs[0],
                        { loading: true, skeletonClassName: "w-40" },
                    ]}
                />
                <div className="flex-1 space-y-2 px-4 py-6 md:px-10">
                    {[0, 1, 2, 3].map((i) => (
                        <div
                            key={i}
                            className="h-8 w-full animate-pulse rounded bg-gray-100"
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (notFound) {
        return (
            <div className="flex flex-1 items-center justify-center">
                <p className="font-serif text-gray-400">Template not found.</p>
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="flex h-full flex-col">
                <PageHeader shrink breadcrumbs={[breadcrumbs[0]]} />
                <div className="flex flex-1 flex-col items-center justify-center gap-3">
                    <p className="text-sm text-gray-600">
                        Could not load this template.
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
            </div>
        );
    }

    const atColumnLimit = columns.length >= MAX_TEMPLATE_COLUMNS;

    return (
        <div className="flex h-full flex-col">
            <PageHeader
                shrink
                breadcrumbs={breadcrumbs}
                actions={[
                    saveStatus !== "idle"
                        ? {
                              type: "custom" as const,
                              render: (
                                  <span className="inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-sm text-gray-500">
                                      {saveStatus === "saved" ? (
                                          <Check className="h-3.5 w-3.5 text-green-600" />
                                      ) : null}
                                      {saveStatus === "saving"
                                          ? "Saving…"
                                          : "Saved"}
                                  </span>
                              ),
                          }
                        : null,
                    isDraft
                        ? {
                              onClick: () => void createDraft(),
                              disabled:
                                  creating ||
                                  !title.trim() ||
                                  columns.length === 0,
                              title: "Create template",
                              label: (
                                  <span>
                                      {creating
                                          ? "Creating…"
                                          : "Create template"}
                                  </span>
                              ),
                          }
                        : null,
                    !isDraft
                        ? {
                              type: "custom" as const,
                              render: (
                                  <HeaderActionsMenu
                                      title="Template actions"
                                      items={
                                          canEdit
                                              ? [
                                                    {
                                                        label: "Rename",
                                                        icon: Pencil,
                                                        onSelect: () =>
                                                            setDetailsOpen(
                                                                true,
                                                            ),
                                                    },
                                                    {
                                                        label: "Duplicate",
                                                        icon: Copy,
                                                        onSelect: () =>
                                                            void duplicateTemplate(),
                                                    },
                                                    {
                                                        label: "Delete",
                                                        icon: Trash2,
                                                        variant: "danger",
                                                        onSelect: () => {
                                                            setDeleteStatus(
                                                                "idle",
                                                            );
                                                            setDeleteOpen(true);
                                                        },
                                                    },
                                                ]
                                              : [
                                                    {
                                                        label: "Duplicate",
                                                        icon: Copy,
                                                        onSelect: () =>
                                                            void duplicateTemplate(),
                                                    },
                                                ]
                                      }
                                  />
                              ),
                          }
                        : null,
                ]}
            />

            {isDraft && (
                <div className="border-b border-gray-100 px-4 py-4 md:px-10">
                    <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Template name"
                        maxLength={200}
                        className="w-full bg-transparent font-serif text-2xl text-gray-800 placeholder-gray-300 focus:outline-none"
                        autoFocus
                    />
                    <p className="mt-1.5 text-xs text-gray-500">
                        Add at least one column, then choose Create template.
                        Nothing is saved until you do.
                    </p>
                </div>
            )}

            <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex h-10 shrink-0 items-center justify-between border-b border-gray-200 px-4 md:px-10">
                    {canEdit ? (
                        <button
                            onClick={() => setAddColumnOpen(true)}
                            disabled={atColumnLimit}
                            className="flex items-center gap-1.5 text-xs text-gray-500 transition-colors hover:text-gray-700 disabled:cursor-not-allowed disabled:text-gray-300"
                        >
                            <Plus className="h-3.5 w-3.5" />
                            Add column
                        </button>
                    ) : (
                        <span className="text-xs font-medium text-gray-500">
                            Read-only
                        </span>
                    )}
                    <div className="flex items-center gap-3">
                        {template?.visibility === "firm" && <FirmBadge />}
                        {practice && (
                            <span className="text-xs text-gray-400">
                                {practice}
                            </span>
                        )}
                        <span className="text-xs tabular-nums text-gray-400">
                            {columns.length}/{MAX_TEMPLATE_COLUMNS} columns
                        </span>
                    </div>
                </div>

                {actionError && (
                    <p className="border-b border-gray-100 px-4 py-2 text-xs text-red-600 md:px-10">
                        {actionError}
                    </p>
                )}
                {atColumnLimit && canEdit && (
                    <p className="border-b border-gray-100 px-4 py-2 text-xs text-gray-500 md:px-10">
                        A template can have at most {MAX_TEMPLATE_COLUMNS}{" "}
                        columns.
                    </p>
                )}

                <div className="min-h-0 flex-1 overflow-auto">
                    <div className="flex min-h-full min-w-max flex-col">
                        <div className="flex h-8 shrink-0 select-none items-center border-b border-gray-200 pr-3 text-xs font-medium text-gray-500 md:pr-10">
                            <div
                                className={`sticky left-0 z-[60] ${NAME_COL_W} flex items-center gap-4 self-stretch bg-[#fafbfc] pl-4 pr-2 text-left`}
                            >
                                <span>Column title</span>
                            </div>
                            <div className="ml-auto w-36 shrink-0">Format</div>
                            <div className="min-w-0 flex-1">Prompt</div>
                            {canEdit && <div className="w-8 shrink-0" />}
                        </div>

                        <div className="flex-1">
                            {columns.length === 0 ? (
                                <div className="mx-auto flex w-full max-w-xs flex-col items-start py-24">
                                    <Plus className="mb-4 h-8 w-8 text-gray-300" />
                                    <p className="font-serif text-2xl font-medium text-gray-900">
                                        Columns
                                    </p>
                                    <p className="mt-1 text-left text-xs text-gray-400">
                                        Add columns to define what a review
                                        built from this template extracts from
                                        each document.
                                    </p>
                                    {canEdit && (
                                        <button
                                            onClick={() =>
                                                setAddColumnOpen(true)
                                            }
                                            className="mt-4 inline-flex items-center gap-1 rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white shadow-md transition-colors hover:bg-gray-700"
                                        >
                                            + Add column
                                        </button>
                                    )}
                                </div>
                            ) : (
                                columns.map((column) => {
                                    const FormatIcon = formatIcon(
                                        column.format ?? "text",
                                    );
                                    return (
                                        <div
                                            key={column.index}
                                            onClick={() =>
                                                canEdit
                                                    ? setEditingColumn(column)
                                                    : setViewingColumn(column)
                                            }
                                            className="group flex h-10 cursor-pointer items-center border-b border-gray-50 pr-3 transition-colors hover:bg-gray-100 md:pr-10"
                                        >
                                            <div
                                                className={`sticky left-0 z-[60] ${NAME_COL_W} bg-[#fafbfc] py-2 pl-4 pr-2 transition-colors group-hover:bg-gray-100`}
                                            >
                                                <span className="block min-w-0 truncate text-sm text-gray-800">
                                                    {column.name}
                                                </span>
                                            </div>
                                            <div className="ml-auto w-36 shrink-0">
                                                <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
                                                    <FormatIcon className="h-3.5 w-3.5 text-gray-400" />
                                                    {formatLabel(
                                                        column.format ?? "text",
                                                    )}
                                                </span>
                                            </div>
                                            <div className="min-w-0 flex-1 pr-4">
                                                <span className="block truncate text-xs text-gray-500">
                                                    {column.prompt}
                                                </span>
                                            </div>
                                            {canEdit && (
                                                <div className="flex w-8 shrink-0 justify-end">
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            removeColumn(
                                                                column.index,
                                                            );
                                                        }}
                                                        className="p-1 text-gray-300 transition-colors hover:text-red-500"
                                                        aria-label={`Remove ${column.name}`}
                                                    >
                                                        <X className="h-3.5 w-3.5" />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {viewingColumn && (
                <WFColumnViewModal
                    col={viewingColumn}
                    onClose={() => setViewingColumn(null)}
                />
            )}

            <AddColumnModal
                open={addColumnOpen}
                existingCount={columns.length}
                onClose={() => setAddColumnOpen(false)}
                onAdd={handleColumnsAdded}
            />

            {editingColumn && (
                <WFEditColumnModal
                    column={editingColumn}
                    onClose={() => setEditingColumn(null)}
                    onSave={handleColumnSaved}
                    onDelete={() => {
                        removeColumn(editingColumn.index);
                        setEditingColumn(null);
                    }}
                />
            )}

            <TemplateDetailsModal
                open={detailsOpen}
                action="Rename template"
                initialName={title}
                initialPractice={practice}
                submitLabel="Save changes"
                submittingLabel="Saving…"
                onClose={() => setDetailsOpen(false)}
                onSubmit={async ({ name, practice: nextPractice }) => {
                    if (!template) return;
                    const updated = await updateTabularTemplate(template.id, {
                        title: name,
                        practice: nextPractice,
                    });
                    setTemplate(updated);
                    setTitle(updated.title);
                    setPractice(updated.practice);
                    setDetailsOpen(false);
                }}
            />

            <ConfirmPopup
                open={deleteOpen}
                title="Delete template?"
                message="This template will be deleted. Reviews already created from it are not affected."
                confirmLabel="Delete"
                confirmStatus={deleteStatus}
                onConfirm={() => void handleDelete()}
                onCancel={() => {
                    if (deleteStatus === "loading") return;
                    setDeleteOpen(false);
                    setDeleteStatus("idle");
                }}
            />
        </div>
    );
}
