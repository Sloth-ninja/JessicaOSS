"use client";

import { use } from "react";
import { TemplateEditor } from "@/app/components/tabular/TemplateEditor";

interface Props {
    params: Promise<{ id: string }>;
}

export default function ReviewTemplatePage({ params }: Props) {
    const { id } = use(params);
    return <TemplateEditor templateId={id} />;
}
