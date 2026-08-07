// Practice management (Clio-backed Matters) — shared client-side helpers.
//
// Self-contained by design (the 22/07 architectural rule): formatting, the
// remembered tab, and the time-boxing wrapper live here rather than being
// scattered through the Matters surfaces.
//
// Two honesty rules are encoded here and must not be relaxed:
//   1. A hidden money/hours figure is NOT zero. Only Clio's own redaction flag
//      licenses "Hidden by your Clio permissions"; a merely absent amount is
//      an em dash.
//   2. Durations are READ in seconds (Clio's unit) and WRITTEN in minutes
//      (what the UI collects) — the backend owns that conversion.

import type { ClioMattersTab } from "@/app/lib/mikeApi";

/** Tabs on the Matters page: the two Clio-backed lists plus JessicaOS workspaces. */
export type MattersTab = ClioMattersTab | "workspaces";

/**
 * Clio calls can be slow, and a request that never settles must never leave an
 * unbounded spinner on screen (login-spinner incident, 2026-07-21). Every load
 * on these surfaces is time-boxed and falls to an error+retry state.
 */
export const CLIO_LOAD_TIMEOUT_MS = 20_000;

/**
 * A load that ran out of time. Deliberately NOT an AbortError: callers discard
 * genuine aborts silently (the component unmounted, nobody is watching), so a
 * timeout wearing that name would leave a skeleton on screen for ever with no
 * way back. This is a real failure and must reach an error+retry state.
 */
export class ClioTimeoutError extends Error {
    constructor(message = "Clio did not respond in time.") {
        super(message);
        this.name = "ClioTimeoutError";
    }
}

/**
 * Run a fetch with a deadline. The signal handed to `run` is aborted on timeout
 * or when the caller's own signal fires (unmount, tab change), AND the returned
 * promise is raced against the deadline — so a callee that ignores its signal
 * still cannot hold the UI open indefinitely.
 *
 * Two distinct outcomes, and the difference is load-bearing:
 *   • the CALLER aborted  → rejects with AbortError; `isAbort` is true and the
 *     caller returns without touching state.
 *   • the DEADLINE passed → rejects with `ClioTimeoutError`; `isAbort` is false
 *     and the caller falls through to its error+retry branch.
 */
export async function timeBoxed<T>(
    run: (signal: AbortSignal) => Promise<T>,
    outerSignal?: AbortSignal,
    timeoutMs: number = CLIO_LOAD_TIMEOUT_MS,
): Promise<T> {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    outerSignal?.addEventListener("abort", onOuterAbort);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new ClioTimeoutError());
        }, timeoutMs);
    });
    try {
        return await Promise.race([run(controller.signal), deadline]);
    } catch (err) {
        // Belt: a well-behaved callee rejects with its own AbortError the
        // instant we abort it, which can win the race against the line above.
        // If the caller did not ask for this, it was the deadline.
        if (
            isAbort(err) &&
            (timedOut || controller.signal.aborted) &&
            !outerSignal?.aborted
        ) {
            throw new ClioTimeoutError();
        }
        throw err;
    } finally {
        clearTimeout(timer);
        outerSignal?.removeEventListener("abort", onOuterAbort);
    }
}

/**
 * True when a rejection is a genuine abort — the caller walked away, so there
 * is nobody to show an error to. A timeout is NOT one of these.
 */
export function isAbort(err: unknown): boolean {
    if (err instanceof ClioTimeoutError) return false;
    return (
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && err.name === "AbortError")
    );
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** ISO date → DD/MM/YYYY, pinned to UTC. Never US date order. */
export function formatUkDate(value: string | null | undefined): string {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
        ? "—"
        : parsed.toLocaleDateString("en-GB", { timeZone: "UTC" });
}

/**
 * ISO date → DD/MM for the dense time-entry list, but DD/MM/YYYY once the entry
 * is from another year — a bare "04/08" on a two-year-old entry reads as recent.
 */
export function formatUkDayMonth(value: string | null | undefined): string {
    if (!value) return "—";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "—";
    const sameYear =
        parsed.getUTCFullYear() === new Date().getUTCFullYear();
    return parsed.toLocaleDateString("en-GB", {
        timeZone: "UTC",
        day: "2-digit",
        month: "2-digit",
        ...(sameYear ? {} : { year: "numeric" }),
    });
}

/** ISO date → `YYYY-MM-DD` for a date input; empty when unparseable. */
export function toDateInputValue(value: string | null | undefined): string {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toISOString().slice(0, 10);
}

/** Money in the matter's own currency (Clio reports the code; GBP by default). */
export function formatMoney(
    amount: number | null | undefined,
    currencyCode: string | null | undefined,
): string {
    if (amount === null || amount === undefined) return "—";
    try {
        return new Intl.NumberFormat("en-GB", {
            style: "currency",
            currency: currencyCode || "GBP",
            // Money always carries its pence: £1,240.00, never £1,240 next to
            // £1,240.50 in the same column.
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(amount);
    } catch {
        // An unexpected currency code must not take the page down.
        return `${amount.toLocaleString("en-GB")}`;
    }
}

/** Clio's seconds → decimal hours, the unit solicitors record time in. */
export function formatHours(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined) return "—";
    return `${(seconds / 3600).toFixed(2)}h`;
}

/** Seconds → whole minutes, the unit the edit form (and the API) writes. */
export function secondsToMinutes(seconds: number | null | undefined): number {
    if (seconds === null || seconds === undefined) return 0;
    return Math.round(seconds / 60);
}

/** Sentence-case a Clio status ("open" → "Open") for a chip. */
export function formatStatus(status: string | null | undefined): string | null {
    if (!status) return null;
    const cleaned = status.replace(/_/g, " ").trim();
    if (!cleaned) return null;
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

/** `00123-Example — Example Ltd & general advice`, degrading honestly. */
export function matterLabel(matter: {
    displayNumber: string | null;
    description: string | null;
}): string {
    const number = matter.displayNumber?.trim();
    const description = matter.description?.trim();
    if (number && description) return `${number} — ${description}`;
    return number || description || "Untitled matter";
}

// ── Remembered tab ───────────────────────────────────────────────────────────

const TAB_KEY = "jessica.mattersTab";
const TABS: MattersTab[] = ["mine", "all", "workspaces"];

// Local subscribers, so a write in this tab re-renders the page that reads it.
const tabListeners = new Set<() => void>();

/**
 * The last tab this browser used, or null when there is no usable preference.
 *
 * Read through `useSyncExternalStore(subscribeToMattersTab,
 * readStoredMattersTab, () => null)` rather than a `useState` initialiser: the
 * server render has no localStorage, so a lazy initialiser would hydrate a
 * different tab than it rendered. The `() => null` server snapshot makes the
 * first paint deterministic and the stored value arrives on hydration.
 */
export function readStoredMattersTab(): MattersTab | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(TAB_KEY);
        return TABS.includes(raw as MattersTab) ? (raw as MattersTab) : null;
    } catch {
        // Storage unavailable (private mode/quota) — the tab simply defaults.
        return null;
    }
}

/** Subscribe to tab changes — this tab's own writes and other tabs' `storage`. */
export function subscribeToMattersTab(onChange: () => void): () => void {
    tabListeners.add(onChange);
    if (typeof window !== "undefined") {
        window.addEventListener("storage", onChange);
    }
    return () => {
        tabListeners.delete(onChange);
        if (typeof window !== "undefined") {
            window.removeEventListener("storage", onChange);
        }
    };
}

export function storeMattersTab(tab: MattersTab): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(TAB_KEY, tab);
    } catch {
        // Not remembering the tab is a fair degrade; never break the page.
    }
    // `storage` does not fire in the tab that wrote it — notify locally.
    tabListeners.forEach((listener) => listener());
}
