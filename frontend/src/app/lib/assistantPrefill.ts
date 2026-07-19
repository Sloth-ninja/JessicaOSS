// Cross-page handoff into the Assistant chat input (WS7). A page (e.g.
// Company Search's "Continue in Assistant") writes a prefill string, then
// navigates to /assistant; InitialView consumes it once on mount. Stored in
// sessionStorage so it never outlives the tab and survives the route change.

const PREFILL_KEY = "jessica.assistantPrefill";

export function setAssistantPrefill(text: string): void {
    try {
        sessionStorage.setItem(PREFILL_KEY, text);
    } catch {
        // Storage unavailable (private mode/quota) — the handoff simply
        // degrades to an empty input.
    }
}

/** Reads the pending prefill without clearing it (idempotent — safe to call
 *  from a render-phase state initialiser). Pair with clearAssistantPrefill()
 *  from an effect. */
export function peekAssistantPrefill(): string | null {
    try {
        return sessionStorage.getItem(PREFILL_KEY);
    } catch {
        return null;
    }
}

export function clearAssistantPrefill(): void {
    try {
        sessionStorage.removeItem(PREFILL_KEY);
    } catch {
        // Nothing to clear if storage is unavailable.
    }
}
