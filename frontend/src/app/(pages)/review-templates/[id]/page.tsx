"use client";

import { use } from "react";
import { TemplateEditor } from "@/app/components/tabular/TemplateEditor";

interface Props {
    params: Promise<{ id: string }>;
}

export default function ReviewTemplatePage({ params }: Props) {
    const { id } = use(params);
    // Keyed by id so the editor's state re-initialises per template segment:
    // without it, navigating built-in → Duplicate → Back reuses the previous
    // template's state, and createDraft's replace() flashes read-only.
    return <TemplateEditor key={id} templateId={id} />;
}
