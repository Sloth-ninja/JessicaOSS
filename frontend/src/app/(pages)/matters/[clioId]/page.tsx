"use client";

import { use } from "react";
import { ClioMatterDetail } from "@/app/components/matters/ClioMatterDetail";

interface Props {
    params: Promise<{ clioId: string }>;
}

export default function ClioMatterPage({ params }: Props) {
    const { clioId } = use(params);
    // Keyed by the Clio id so every state slice (time entries, workspace link)
    // re-initialises when navigating between matters.
    return <ClioMatterDetail key={clioId} matterId={clioId} />;
}
