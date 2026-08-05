"use client";

import { useEffect, useState, type ReactNode } from "react";
import { listWorkflows } from "@/app/lib/mikeApi";
import { Modal } from "../shared/Modal";
import type { Workflow } from "../shared/types";
import { BUILT_IN_WORKFLOWS } from "./builtinWorkflows";
import { WorkflowPickerContent } from "./WorkflowPickerContent";

interface WorkflowPickerModalProps {
    open: boolean;
    onClose: () => void;
    onSelect: (workflow: Workflow) => Promise<void> | void;
    workflowType: Workflow["type"];
    breadcrumbs: ReactNode[];
    primaryLabel?: string;
    selectingLabel?: string;
    selecting?: boolean;
    closeOnSelect?: boolean;
    initialWorkflowId?: string;
    disabledWorkflow?: (workflow: Workflow) => boolean;
    /** Replaces the default built-ins + listWorkflows(type) load. Review
     *  templates pass their own loader so the list covers personal, shared,
     *  firm-shared and built-in templates. */
    loadOptions?: () => Promise<Workflow[]>;
    groupLabelFor?: (workflow: Workflow) => string;
    emptyMessage?: string;
    searchPlaceholder?: string;
}

export function WorkflowPickerModal({
    open,
    onClose,
    onSelect,
    workflowType,
    breadcrumbs,
    primaryLabel = "Use",
    selectingLabel,
    selecting = false,
    closeOnSelect = true,
    initialWorkflowId,
    disabledWorkflow,
    loadOptions,
    groupLabelFor,
    emptyMessage,
    searchPlaceholder,
}: WorkflowPickerModalProps) {
    const [workflows, setWorkflows] = useState<Workflow[]>([]);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState<Workflow | null>(null);
    const [search, setSearch] = useState("");

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        const builtins = BUILT_IN_WORKFLOWS.filter(
            (workflow) => workflow.type === workflowType,
        );
        const frame = requestAnimationFrame(() => {
            if (cancelled) return;
            setWorkflows(builtins);
            setLoading(true);
            setSelected(
                initialWorkflowId
                    ? builtins.find((workflow) => workflow.id === initialWorkflowId) ??
                          null
                    : null,
            );
            setSearch("");
        });

        (loadOptions
            ? loadOptions()
            : listWorkflows(workflowType).then((custom) => [
                  ...builtins,
                  ...custom,
              ])
        )
            .then((all) => {
                if (cancelled) return;
                setWorkflows(all);
                if (initialWorkflowId) {
                    setSelected(
                        all.find((workflow) => workflow.id === initialWorkflowId) ??
                            null,
                    );
                }
            })
            .catch(() => {
                if (cancelled) return;
                if (initialWorkflowId) {
                    setSelected(
                        builtins.find(
                            (workflow) => workflow.id === initialWorkflowId,
                        ) ?? null,
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
            cancelAnimationFrame(frame);
        };
        // NOTE `loadOptions` is a dependency, so callers must pass a STABLE
        // function (a module-level function or one wrapped in useCallback). An
        // inline arrow would be a new identity on every render and re-run this
        // effect — refetching the template list in a loop while the modal is
        // open. Today's callers pass the module-level loadTemplateOptions.
    }, [initialWorkflowId, open, workflowType, loadOptions]);

    if (!open) return null;

    const selectionDisabled =
        !selected || selecting || (selected && disabledWorkflow?.(selected));
    const resolvedPrimaryLabel =
        selecting && selectingLabel ? selectingLabel : primaryLabel;

    function handleClose() {
        setSelected(null);
        setSearch("");
        onClose();
    }

    async function handleSelect() {
        if (!selected || selectionDisabled) return;
        await onSelect(selected);
        if (closeOnSelect) handleClose();
    }

    return (
        <Modal
            open={open}
            onClose={handleClose}
            size={selected ? "xl" : "lg"}
            breadcrumbs={breadcrumbs}
            primaryAction={{
                label: resolvedPrimaryLabel,
                onClick: () => void handleSelect(),
                disabled: selectionDisabled,
            }}
        >
            <WorkflowPickerContent
                workflows={workflows}
                selected={selected}
                onSelect={setSelected}
                search={search}
                onSearchChange={setSearch}
                loading={loading}
                workflowType={workflowType}
                previewMode={workflowType === "tabular" ? "columns" : "prompt"}
                disabledWorkflow={disabledWorkflow}
                groupLabelFor={groupLabelFor}
                emptyMessage={emptyMessage}
                searchPlaceholder={searchPlaceholder}
            />
        </Modal>
    );
}
