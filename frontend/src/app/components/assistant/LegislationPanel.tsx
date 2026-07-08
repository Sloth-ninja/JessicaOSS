"use client";

import { ExternalLink, Landmark, TriangleAlert } from "lucide-react";

export type LegislationUnappliedEffect = {
    type?: string;
    notes?: string;
    affectedProvisions?: string;
};

export type LegislationProvisionPayload = {
    heading?: string | null;
    text?: string;
    extent?: string | null;
    unappliedEffects?: LegislationUnappliedEffect[];
};

interface Props {
    url: string;
    title: string;
    /** Verbatim quote from a citation pill — shown when the full provision text isn't available. */
    quote?: string;
    provision?: LegislationProvisionPayload;
}

/**
 * Side-panel body for a UK statutory provision (docs/MIGRATION_SPEC.md §4.3).
 * Opened from a completed legislation_lookup tool-call chip (full
 * heading/text/extent/outstanding-effects payload) or from a legislation
 * citation pill (title + canonical URL + the quoted passage only — CLAUDE.md
 * forbids inventing data we don't actually have, so the amber banner only
 * ever appears when a lookup actually reported outstanding effects).
 */
export function LegislationPanel({ url, title, quote, provision }: Props) {
    const outstanding = !!provision?.unappliedEffects?.length;
    const bodyText = provision?.text?.trim();
    const heading = provision?.heading?.trim();

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-start gap-3 px-3 pt-4 pb-3">
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2 text-gray-400">
                        <Landmark className="h-4 w-4 shrink-0" />
                        <span className="text-xs font-serif uppercase tracking-wide">
                            legislation.gov.uk
                        </span>
                    </div>
                    <h2
                        className="mt-1 min-w-0 break-words font-serif text-xl text-gray-900"
                        title={title}
                    >
                        {title}
                    </h2>
                </div>
                <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-900"
                >
                    <ExternalLink className="h-3.5 w-3.5" />
                    View on legislation.gov.uk
                </a>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4">
                {outstanding && (
                    <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5">
                        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                        <div className="text-sm font-serif text-amber-900">
                            <p className="font-medium">
                                Outstanding amendments not yet applied to this
                                text.
                            </p>
                            <p className="mt-0.5 text-xs text-amber-800">
                                Check the &ldquo;Changes to Legislation&rdquo;
                                notes on legislation.gov.uk before relying on
                                this wording.
                            </p>
                        </div>
                    </div>
                )}

                {provision?.extent && (
                    <p className="mb-3 text-xs font-medium text-gray-500">
                        Extent: {provision.extent}
                    </p>
                )}

                {heading && (
                    <h3 className="mb-2 font-serif text-base font-medium text-gray-800">
                        {heading}
                    </h3>
                )}

                {bodyText ? (
                    <div className="whitespace-pre-wrap font-serif text-sm leading-7 text-gray-800">
                        {bodyText}
                    </div>
                ) : quote ? (
                    <blockquote className="border-l-4 border-gray-300 pl-4 font-serif text-sm italic leading-7 text-gray-700">
                        {quote}
                    </blockquote>
                ) : (
                    <p className="font-serif text-sm text-gray-500">
                        No cached provision text — open the canonical link
                        above to read it on legislation.gov.uk.
                    </p>
                )}

                {!provision && (
                    <p className="mt-4 text-xs text-gray-400">
                        This citation didn&rsquo;t carry the full provision
                        text. Outstanding-amendment status is unknown from
                        this view alone — check the canonical link.
                    </p>
                )}
            </div>
        </div>
    );
}
