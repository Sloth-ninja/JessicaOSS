"use client";

import { useCallback, useEffect, useState } from "react";
import { ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID } from "../components/assistant/ModelToggle";

const STORAGE_KEY = "mike.selectedModel";

function isAllowed(id: string, localModels: string[]): boolean {
    return ALLOWED_MODEL_IDS.has(id) || localModels.includes(id);
}

function readStoredRaw(): string | null {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(STORAGE_KEY);
}

/**
 * @param localModels Server-reported local:-prefixed model ids (empty when
 * local mode is unconfigured). A persisted selection of a since-removed (or
 * never-configured) local model falls back to DEFAULT_MODEL_ID gracefully —
 * it never gets stuck on an unusable id.
 */
export function useSelectedModel(
    localModels: string[] = [],
): [string, (id: string) => void] {
    const [model, setModelState] = useState<string>(DEFAULT_MODEL_ID);

    useEffect(() => {
        const stored = readStoredRaw();
        setModelState(stored && isAllowed(stored, localModels) ? stored : DEFAULT_MODEL_ID);
        // Re-validate whenever the server-reported local model list changes
        // (e.g. it loads in after the initial render, or local mode is
        // reconfigured), so a valid persisted local selection is restored
        // and a no-longer-valid one falls back.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [localModels.join(",")]);

    const setModel = useCallback(
        (id: string) => {
            const next = isAllowed(id, localModels) ? id : DEFAULT_MODEL_ID;
            setModelState(next);
            if (typeof window !== "undefined") {
                window.localStorage.setItem(STORAGE_KEY, next);
            }
        },
        [localModels],
    );

    return [model, setModel];
}
