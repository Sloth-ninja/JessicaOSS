import {
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

export function builtInTemplateOptions(): TemplateOption[] {
    return BUILT_IN_WORKFLOWS.filter(
        (workflow) =>
            workflow.type === "tabular" && !!workflow.columns_config?.length,
    ).map((workflow) => ({ ...workflow, templateGroup: "Built-in" as const }));
}

/**
 * Templates first (most specific), built-ins last. A failed template fetch
 * still yields the built-ins rather than an empty picker.
 */
export async function loadTemplateOptions(): Promise<TemplateOption[]> {
    const builtIns = builtInTemplateOptions();
    try {
        const list = await listTabularTemplates();
        return [
            ...list.mine.map((t) => toOption(t, "My templates")),
            ...list.shared.map((t) => toOption(t, "Shared with me")),
            ...list.firm.map((t) => toOption(t, "Firm templates")),
            ...builtIns,
        ];
    } catch {
        return builtIns;
    }
}

export function templateGroupOf(workflow: Workflow): string {
    return (
        (workflow as Partial<TemplateOption>).templateGroup ??
        (workflow.is_system ? "Built-in" : "My templates")
    );
}
