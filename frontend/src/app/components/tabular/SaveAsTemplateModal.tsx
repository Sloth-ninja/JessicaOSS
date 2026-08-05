"use client";

import {
    createTabularTemplate,
    type TabularTemplate,
} from "@/app/lib/mikeApi";
import type { ColumnConfig } from "../shared/types";
import { TemplateDetailsModal } from "./TemplateDetailsModal";

/**
 * "Save as template" from a live review grid (spec surface 1). Saves the
 * review's current column definitions as a new personal template — anyone who
 * can open the review may save one, and the copy belongs to whoever saved it.
 * Cell contents are never copied.
 */

interface Props {
    open: boolean;
    /** Prefills the template name. */
    reviewTitle: string;
    columns: ColumnConfig[];
    practice?: string | null;
    onClose: () => void;
    onSaved: (template: TabularTemplate) => void;
}

export function SaveAsTemplateModal({
    open,
    reviewTitle,
    columns,
    practice = null,
    onClose,
    onSaved,
}: Props) {
    const columnCount = columns.length;

    return (
        <TemplateDetailsModal
            open={open}
            action="Save as template"
            initialName={reviewTitle}
            initialPractice={practice}
            hint={
                <>
                    Saves this review&apos;s{" "}
                    {columnCount === 1 ? "column" : `${columnCount} columns`} as
                    a reusable template. Cell contents are not saved.
                </>
            }
            submitLabel="Save template"
            submittingLabel="Saving…"
            onClose={onClose}
            onSubmit={async ({ name, practice: chosenPractice }) => {
                const template = await createTabularTemplate({
                    title: name,
                    practice: chosenPractice,
                    columns,
                });
                onSaved(template);
            }}
        />
    );
}
