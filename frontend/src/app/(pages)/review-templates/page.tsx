"use client";

// Review templates (saved tabular schemas v1) — the Templates surface.
// A template is a reusable set of tabular-review columns. Personal and
// firm-shared templates are `workflows` rows served by /tabular-templates; the
// built-ins stay client-side constants and keep the existing hide semantics.
// Orgless users, and firms whose database has not taken the firm-visibility
// migration, never see the firm section or the share-to-firm action.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
    Copy,
    Eye,
    EyeOff,
    Pencil,
    RefreshCw,
    Trash2,
    Undo2,
    Users,
} from "lucide-react";
import {
    createTabularTemplate,
    deleteTabularTemplate,
    hideWorkflow,
    listHiddenWorkflows,
    listTabularTemplates,
    setTabularTemplateVisibility,
    unhideWorkflow,
    updateTabularTemplate,
    type TabularTemplate,
    type TabularTemplateList,
} from "@/app/lib/mikeApi";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { FirmBadge } from "@/app/components/shared/FirmBadge";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import {
    HeaderActionsMenu,
    type HeaderActionsMenuItem,
} from "@/app/components/shared/HeaderActionsMenu";
import { TemplateDetailsModal } from "@/app/components/tabular/TemplateDetailsModal";
import { BUILT_IN_WORKFLOWS } from "@/app/components/workflows/builtinWorkflows";
import type { ColumnConfig, Workflow } from "@/app/components/shared/types";

type BuiltInTemplate = Workflow & { columns_config: ColumnConfig[] };

const BUILT_IN_TABULAR: BuiltInTemplate[] = BUILT_IN_WORKFLOWS.filter(
    (workflow): workflow is BuiltInTemplate =>
        workflow.type === "tabular" && !!workflow.columns_config?.length,
);

// DD/MM/YYYY, pinned to UTC to match the firm library and admin pages.
function formatUkDate(value: string | null): string {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
        ? "—"
        : parsed.toLocaleDateString("en-GB", { timeZone: "UTC" });
}

function columnCountLabel(count: number): string {
    return `${count} column${count === 1 ? "" : "s"}`;
}

function metaLine(count: number, practice: string | null): string {
    return practice
        ? `${columnCountLabel(count)} · ${practice}`
        : columnCountLabel(count);
}

export default function ReviewTemplatesPage() {
    const router = useRouter();
    const { profile } = useUserProfile();

    const [list, setList] = useState<TabularTemplateList | null>(null);
    const [hiddenBuiltInIds, setHiddenBuiltInIds] = useState<string[]>([]);
    const [loadError, setLoadError] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [actionError, setActionError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [showHiddenBuiltIns, setShowHiddenBuiltIns] = useState(false);

    const [renaming, setRenaming] = useState<TabularTemplate | null>(null);
    const [deleting, setDeleting] = useState<TabularTemplate | null>(null);
    const [deleteStatus, setDeleteStatus] = useState<
        "idle" | "loading" | "complete"
    >("idle");

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const [templates, hidden] = await Promise.all([
                    listTabularTemplates(),
                    listHiddenWorkflows().catch(() => [] as string[]),
                ]);
                if (!active) return;
                setList(templates);
                setHiddenBuiltInIds(hidden);
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
        setList(null);
        setActionError(null);
        setReloadKey((k) => k + 1);
    };

    const reload = useCallback(() => setReloadKey((k) => k + 1), []);

    const loading = list === null && !loadError;
    const firmSharingAvailable =
        !!profile?.firm && !!list?.firmSharingSupported;
    const firmName = profile?.firm?.name ?? "your firm";

    const visibleBuiltIns = useMemo(
        () =>
            BUILT_IN_TABULAR.filter(
                (template) => !hiddenBuiltInIds.includes(template.id),
            ),
        [hiddenBuiltInIds],
    );
    const hiddenBuiltIns = useMemo(
        () =>
            BUILT_IN_TABULAR.filter((template) =>
                hiddenBuiltInIds.includes(template.id),
            ),
        [hiddenBuiltInIds],
    );

    // ── Actions ─────────────────────────────────────────────────────────────

    async function duplicateTemplate(source: {
        title: string;
        practice: string | null;
        columns: ColumnConfig[];
        id: string;
    }) {
        setActionError(null);
        setBusyId(source.id);
        try {
            const created = await createTabularTemplate({
                title: `${source.title} (copy)`.slice(0, 200),
                practice: source.practice,
                columns: source.columns,
            });
            reload();
            router.push(`/review-templates/${created.id}`);
        } catch {
            setActionError("Could not duplicate that template.");
        } finally {
            setBusyId(null);
        }
    }

    async function flipVisibility(
        template: TabularTemplate,
        visibility: "private" | "firm",
    ) {
        setActionError(null);
        setBusyId(template.id);
        try {
            await setTabularTemplateVisibility(template.id, visibility);
            reload();
        } catch (err) {
            const message = err instanceof Error ? err.message : "";
            setActionError(
                message && message.length < 200
                    ? message
                    : "Could not change who can see that template.",
            );
        } finally {
            setBusyId(null);
        }
    }

    async function confirmDelete() {
        if (!deleting) return;
        setDeleteStatus("loading");
        try {
            await deleteTabularTemplate(deleting.id);
            setDeleteStatus("complete");
            setDeleting(null);
            setDeleteStatus("idle");
            reload();
        } catch {
            setDeleteStatus("idle");
            setActionError("Could not delete that template.");
        }
    }

    async function toggleBuiltInHidden(id: string, hidden: boolean) {
        const previous = hiddenBuiltInIds;
        setHiddenBuiltInIds((prev) =>
            hidden ? [...prev, id] : prev.filter((x) => x !== id),
        );
        try {
            await (hidden ? hideWorkflow(id) : unhideWorkflow(id));
        } catch {
            setHiddenBuiltInIds(previous);
            setActionError(
                hidden
                    ? "Could not hide that template."
                    : "Could not unhide that template.",
            );
        }
    }

    // ── Row menus ───────────────────────────────────────────────────────────

    function ownedMenuItems(template: TabularTemplate): HeaderActionsMenuItem[] {
        const items: HeaderActionsMenuItem[] = [
            {
                label: "Edit columns",
                icon: Pencil,
                onSelect: () =>
                    router.push(`/review-templates/${template.id}`),
            },
            {
                label: "Rename",
                icon: Pencil,
                onSelect: () => setRenaming(template),
            },
            {
                label: "Duplicate",
                icon: Copy,
                onSelect: () =>
                    void duplicateTemplate({
                        id: template.id,
                        title: template.title,
                        practice: template.practice,
                        columns: template.columns,
                    }),
            },
        ];
        if (firmSharingAvailable) {
            items.push(
                template.visibility === "firm"
                    ? {
                          label: "Revert to private",
                          icon: Undo2,
                          onSelect: () =>
                              void flipVisibility(template, "private"),
                      }
                    : {
                          label: "Share to firm",
                          icon: Users,
                          onSelect: () => void flipVisibility(template, "firm"),
                      },
            );
        }
        items.push({
            label: "Delete",
            icon: Trash2,
            variant: "danger",
            onSelect: () => {
                setDeleteStatus("idle");
                setDeleting(template);
            },
        });
        return items;
    }

    function duplicateOnlyMenuItems(
        template: TabularTemplate,
    ): HeaderActionsMenuItem[] {
        return [
            {
                label: "Duplicate",
                icon: Copy,
                onSelect: () =>
                    void duplicateTemplate({
                        id: template.id,
                        title: template.title,
                        practice: template.practice,
                        columns: template.columns,
                    }),
            },
        ];
    }

    function builtInMenuItems(
        template: BuiltInTemplate,
        hidden: boolean,
    ): HeaderActionsMenuItem[] {
        return [
            {
                label: "Duplicate",
                icon: Copy,
                onSelect: () =>
                    void duplicateTemplate({
                        id: template.id,
                        title: template.title,
                        practice: template.practice ?? null,
                        columns: template.columns_config,
                    }),
            },
            hidden
                ? {
                      label: "Unhide",
                      icon: Eye,
                      onSelect: () =>
                          void toggleBuiltInHidden(template.id, false),
                  }
                : {
                      label: "Hide",
                      icon: EyeOff,
                      onSelect: () =>
                          void toggleBuiltInHidden(template.id, true),
                  },
        ];
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    function TemplateRow({
        id,
        name,
        meta,
        trailing,
        badge,
        menuItems,
        dimmed = false,
    }: {
        id: string;
        name: string;
        meta: string;
        trailing: string;
        badge?: React.ReactNode;
        menuItems: HeaderActionsMenuItem[];
        dimmed?: boolean;
    }) {
        const open = () => router.push(`/review-templates/${id}`);
        return (
            <tr
                role="link"
                tabIndex={0}
                aria-label={`Open ${name}`}
                onClick={open}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open();
                    }
                }}
                className={`cursor-pointer border-b border-gray-100 transition-colors last:border-b-0 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none ${
                    dimmed ? "opacity-60" : ""
                }`}
            >
                <td className="px-4 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-gray-900">
                            {name}
                        </span>
                        {badge}
                        {busyId === id && (
                            <span className="text-[11px] text-gray-400">
                                Working…
                            </span>
                        )}
                    </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-gray-500">
                    {meta}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right text-xs text-gray-500">
                    {trailing}
                </td>
                <td
                    className="w-10 px-2 py-3 text-right"
                    onClick={(e) => e.stopPropagation()}
                >
                    <HeaderActionsMenu
                        items={menuItems}
                        title="Template actions"
                    />
                </td>
            </tr>
        );
    }

    function Section({
        label,
        children,
    }: {
        label: string;
        children: React.ReactNode;
    }) {
        return (
            <section className="mt-7 first:mt-0">
                <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    {label}
                </h2>
                <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                    <table className="w-full border-collapse">
                        <tbody>{children}</tbody>
                    </table>
                </div>
            </section>
        );
    }

    return (
        <div className="flex h-full flex-col overflow-y-auto">
            <PageHeader
                shrink
                loading={loading}
                actions={[
                    {
                        type: "new",
                        onClick: () => router.push("/review-templates/new"),
                        title: "New template",
                    },
                ]}
            >
                <h1 className="font-serif text-2xl font-medium text-gray-900">
                    Templates
                </h1>
            </PageHeader>

            <div className="mx-auto w-full max-w-4xl px-4 pb-16 md:px-10">
                <p className="mt-5 max-w-2xl text-xs leading-relaxed text-gray-500">
                    Reusable sets of tabular-review columns. Start a review from
                    a template, or save the columns of a review you have already
                    built.
                </p>

                {actionError && (
                    <p className="mt-3 text-xs text-red-600">{actionError}</p>
                )}

                {loadError ? (
                    <div className="mt-6 flex flex-col items-start gap-2.5 rounded-xl border border-gray-200 bg-white px-5 py-6">
                        <p className="text-sm text-gray-600">
                            Could not load your templates.
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
                    <div className="mt-6 space-y-2 rounded-xl border border-gray-200 bg-white px-5 py-4">
                        {[0, 1, 2].map((i) => (
                            <div
                                key={i}
                                className="h-6 w-full animate-pulse rounded bg-gray-100"
                            />
                        ))}
                    </div>
                ) : (
                    <div className="mt-6">
                        <Section label="My templates">
                            {list && list.mine.length > 0 ? (
                                list.mine.map((template) => (
                                    <TemplateRow
                                        key={template.id}
                                        id={template.id}
                                        name={template.title}
                                        meta={metaLine(
                                            template.columns.length,
                                            template.practice,
                                        )}
                                        trailing={`Created ${formatUkDate(
                                            template.updatedAt,
                                        )}`}
                                        badge={
                                            template.visibility === "firm" ? (
                                                <FirmBadge />
                                            ) : undefined
                                        }
                                        menuItems={ownedMenuItems(template)}
                                    />
                                ))
                            ) : (
                                <tr>
                                    <td className="px-4 py-6 text-sm text-gray-500">
                                        You have not saved a template yet. Use
                                        New template, or save the columns of a
                                        review from its ⋯ menu.
                                    </td>
                                </tr>
                            )}
                        </Section>

                        {list && list.shared.length > 0 && (
                            <Section label="Shared with me">
                                {list.shared.map((template) => (
                                    <TemplateRow
                                        key={template.id}
                                        id={template.id}
                                        name={template.title}
                                        meta={metaLine(
                                            template.columns.length,
                                            template.practice,
                                        )}
                                        trailing={
                                            template.ownerDisplayName?.trim() ||
                                            "Shared with you"
                                        }
                                        menuItems={duplicateOnlyMenuItems(
                                            template,
                                        )}
                                    />
                                ))}
                            </Section>
                        )}

                        {firmSharingAvailable && list && (
                            <Section label="Firm templates">
                                {list.firm.length > 0 ? (
                                    list.firm.map((template) => (
                                        <TemplateRow
                                            key={template.id}
                                            id={template.id}
                                            name={template.title}
                                            meta={metaLine(
                                                template.columns.length,
                                                template.practice,
                                            )}
                                            trailing={
                                                template.ownerDisplayName?.trim() ||
                                                "A colleague"
                                            }
                                            badge={<FirmBadge />}
                                            menuItems={duplicateOnlyMenuItems(
                                                template,
                                            )}
                                        />
                                    ))
                                ) : (
                                    <tr>
                                        <td className="px-4 py-6 text-sm text-gray-500">
                                            Nobody at {firmName} has shared a
                                            template with the whole firm yet.
                                            Your own templates stay private
                                            until you share them.
                                        </td>
                                    </tr>
                                )}
                            </Section>
                        )}

                        <Section label="Built-in">
                            {visibleBuiltIns.length > 0 ? (
                                visibleBuiltIns.map((template) => (
                                    <TemplateRow
                                        key={template.id}
                                        id={template.id}
                                        name={template.title}
                                        meta={metaLine(
                                            template.columns_config.length,
                                            template.practice ?? null,
                                        )}
                                        trailing="JessicaOS"
                                        badge={
                                            <span className="inline-flex shrink-0 items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                                                Built-in
                                            </span>
                                        }
                                        menuItems={builtInMenuItems(
                                            template,
                                            false,
                                        )}
                                    />
                                ))
                            ) : (
                                <tr>
                                    <td className="px-4 py-6 text-sm text-gray-500">
                                        You have hidden every built-in
                                        template.
                                    </td>
                                </tr>
                            )}
                        </Section>

                        {hiddenBuiltIns.length > 0 && (
                            <div className="mt-3">
                                <button
                                    type="button"
                                    onClick={() =>
                                        setShowHiddenBuiltIns((v) => !v)
                                    }
                                    className="text-xs font-medium text-gray-500 underline underline-offset-2 transition-colors hover:text-gray-800"
                                >
                                    {showHiddenBuiltIns
                                        ? "Hide"
                                        : `Show ${hiddenBuiltIns.length} hidden built-in ${
                                              hiddenBuiltIns.length === 1
                                                  ? "template"
                                                  : "templates"
                                          }`}
                                </button>
                                {showHiddenBuiltIns && (
                                    <div className="mt-2 overflow-hidden rounded-xl border border-gray-200 bg-white">
                                        <table className="w-full border-collapse">
                                            <tbody>
                                                {hiddenBuiltIns.map(
                                                    (template) => (
                                                        <TemplateRow
                                                            key={template.id}
                                                            id={template.id}
                                                            name={
                                                                template.title
                                                            }
                                                            meta={metaLine(
                                                                template
                                                                    .columns_config
                                                                    .length,
                                                                template.practice ??
                                                                    null,
                                                            )}
                                                            trailing="Hidden"
                                                            dimmed
                                                            menuItems={builtInMenuItems(
                                                                template,
                                                                true,
                                                            )}
                                                        />
                                                    ),
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        )}

                        <p className="mt-6 text-xs text-gray-400">
                            Looking for assistant prompts? They live on the{" "}
                            <Link
                                href="/workflows"
                                className="text-gray-600 underline underline-offset-2 hover:text-gray-900"
                            >
                                Workflows
                            </Link>{" "}
                            page.
                        </p>
                    </div>
                )}
            </div>

            <TemplateDetailsModal
                open={renaming !== null}
                action="Rename template"
                initialName={renaming?.title ?? ""}
                initialPractice={renaming?.practice ?? null}
                submitLabel="Save changes"
                submittingLabel="Saving…"
                onClose={() => setRenaming(null)}
                onSubmit={async ({ name, practice }) => {
                    if (!renaming) return;
                    await updateTabularTemplate(renaming.id, {
                        title: name,
                        practice,
                    });
                    setRenaming(null);
                    reload();
                }}
            />

            <ConfirmPopup
                open={deleting !== null}
                title="Delete template?"
                message={
                    deleting
                        ? `“${deleting.title}” will be deleted. Reviews already created from it are not affected.`
                        : ""
                }
                confirmLabel="Delete"
                confirmStatus={deleteStatus}
                onConfirm={() => void confirmDelete()}
                onCancel={() => {
                    if (deleteStatus === "loading") return;
                    setDeleting(null);
                    setDeleteStatus("idle");
                }}
            />
        </div>
    );
}
