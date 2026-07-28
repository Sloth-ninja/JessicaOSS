import { cn } from "@/lib/utils";

/**
 * The small indigo "Firm" pill shown on firm-visible matters and reviews
 * wherever they are listed (WS9). Marks an item every member of the owner's
 * firm can open.
 */
export function FirmBadge({ className }: { className?: string }) {
    return (
        <span
            className={cn(
                "inline-flex shrink-0 items-center rounded-full border border-indigo-700/20 bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700",
                className,
            )}
        >
            Firm
        </span>
    );
}
