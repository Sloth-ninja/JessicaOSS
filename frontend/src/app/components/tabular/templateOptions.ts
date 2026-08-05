import {
    listHiddenWorkflows,
    listTabularTemplates,
    type TabularTemplate,
} from "@/app/lib/mikeApi";
import type { Workflow } from "../shared/types";
import { BUILT_IN_WORKFLOWS } from "../workflows/builtinWorkflows";

/**
 * Adapts review templates to the shape the existing workflow pickers already
 * render, so "Start from a template" (new review) and "Apply template"
 * (in-grid) can list a caller's own templates, ones colleagues shared with
 * them, firm-shared ones and the built-ins from a single call — without
 * forking the picker.
 */

/** Server-enforced cap (backend lib/tabularTemplates.ts MAX_TEMPLATE_COLUMNS).
 *  Kept here so every surface that offers "save as template" can say so before
 *  the request rather than surfacing a 400. */
export const MAX_TEMPLATE_COLUMNS = 30;

export type TemplateGroup =
    | "My templates"
    | "Shared with me"
    | "Firm templates"
    | "Built-in";

export type TemplateOption = Workflow & { templateGroup: TemplateGroup };

function toOption(
    template: TabularTemplate,
    group: TemplateGroup,
): TemplateOption {
    return {
        id: template.id,
        user_id: template.ownerUserId,
        title: template.title,
        type: "tabular",
        prompt_md: null,
        columns_config: template.columns,
        is_system: false,
        created_at: template.updatedAt ?? "",
        practice: template.practice,
        shared_by_name: template.isOwner ? null : template.ownerDisplayName,
        is_owner: template.isOwner,
        templateGroup: group,
    };
}

export function builtInTemplateOptions(
    hiddenIds: readonly string[] = [],
): TemplateOption[] {
    const hidden = new Set(hiddenIds);
    return BUILT_IN_WORKFLOWS.filter(
        (workflow) =>
            workflow.type === "tabular" &&
            !!workflow.columns_config?.length &&
            !hidden.has(workflow.id),
    ).map((workflow) => ({ ...workflow, templateGroup: "Built-in" as const }));
}

/**
 * Templates first (most specific), built-ins last.
 *
 * Built-ins the caller has hidden from the Templates page are left out, so Hide
 * means the same thing in both pickers as it does on that page. Both fetches
 * fail open on their own: a failed template fetch still yields the built-ins
 * rather than an empty picker, and a failed hidden-list fetch shows every
 * built-in rather than silently dropping templates the caller can still use.
 */
export async function loadTemplateOptions(): Promise<TemplateOption[]> {
    const [list, hiddenIds] = await Promise.all([
        listTabularTemplates().catch(() => null),
        listHiddenWorkflows().catch(() => [] as string[]),
    ]);
    const builtIns = builtInTemplateOptions(hiddenIds);
    if (!list) return builtIns;
    return [
        ...list.mine.map((t) => toOption(t, "My templates")),
        ...list.shared.map((t) => toOption(t, "Shared with me")),
        ...list.firm.map((t) => toOption(t, "Firm templates")),
        ...builtIns,
    ];
}

/**
 * The `workflow_id` to store on a review created from `workflow` — the template
 * linkage the firm usage dashboard attributes runs to.
 *
 * `tabular_reviews.workflow_id` is a uuid FK to `workflows.id`, but the picker
 * also offers the 14 built-in templates, which are client-side constants with
 * ids like "builtin-nda". Those carry no row to point at, so they yield
 * undefined (create) / null (apply-in-grid, which clears any previous linkage).
 */
export function persistableTemplateId(
    workflow?: Pick<Workflow, "id" | "is_system"> | null,
): string | undefined {
    if (!workflow || workflow.is_system) return undefined;
    return workflow.id.startsWith("builtin-") ? undefined : workflow.id;
}

export function templateGroupOf(workflow: Workflow): string {
    return (
        (workflow as Partial<TemplateOption>).templateGroup ??
        (workflow.is_system ? "Built-in" : "My templates")
    );
}
