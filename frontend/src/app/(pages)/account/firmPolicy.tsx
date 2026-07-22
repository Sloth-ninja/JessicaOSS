import { Info } from "lucide-react";
import type { OrganisationMembership } from "@/app/lib/mikeApi";
import { AccountSection } from "./AccountSection";

// Firm-policy helpers (WS8 PR B). A member's own API-key / connector surfaces are
// hidden when their firm has switched the corresponding policy OFF. Orgless users
// (firm === null) are never gated — the flags only apply inside a firm.

export function personalApiKeysBlocked(
    firm: OrganisationMembership | null | undefined,
): boolean {
    return !!firm && !firm.policies.memberApiKeys;
}

export function personalConnectorsBlocked(
    firm: OrganisationMembership | null | undefined,
): boolean {
    return !!firm && !firm.policies.memberMcpConnectors;
}

/**
 * Neutral "managed by your firm" placeholder rendered when a member navigates
 * directly to a route whose tab has been hidden by firm policy. Deliberately not
 * an error — there is simply nothing for the member to configure here.
 */
export function FirmManagedCard({
    heading,
    title,
    description,
}: {
    heading: string;
    title: string;
    description: string;
}) {
    return (
        <div>
            <div className="mb-4 flex items-center gap-2">
                <h2 className="font-serif text-2xl font-medium">{heading}</h2>
            </div>
            <AccountSection>
                <div className="flex items-start gap-3 px-4 py-5">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                    <div>
                        <p className="text-sm font-medium text-gray-900">
                            {title}
                        </p>
                        <p className="mt-1 text-sm leading-relaxed text-gray-600">
                            {description}
                        </p>
                    </div>
                </div>
            </AccountSection>
        </div>
    );
}
