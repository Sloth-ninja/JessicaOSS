"use client";

import { ExternalLink } from "lucide-react";

// ---------------------------------------------------------------------------
// Loosely-typed Companies House response shapes. These mirror the public
// API's JSON (https://developer.company-information.service.gov.uk/) but are
// deliberately permissive — the raw response is passed straight through
// from the backend tool result, so every field is read defensively.
// ---------------------------------------------------------------------------

interface RegisteredOfficeAddress {
    address_line_1?: string;
    address_line_2?: string;
    locality?: string;
    region?: string;
    postal_code?: string;
    country?: string;
}

interface CompanyProfile {
    company_name?: string;
    company_number?: string;
    company_status?: string;
    type?: string;
    date_of_creation?: string;
    registered_office_address?: RegisteredOfficeAddress;
    sic_codes?: string[];
    accounts?: {
        next_due?: string;
        next_accounts?: { period_end_on?: string };
        last_accounts?: { made_up_to?: string };
    };
    confirmation_statement?: {
        next_due?: string;
        last_made_up_to?: string;
    };
}

interface Officer {
    name?: string;
    officer_role?: string;
    appointed_on?: string;
    resigned_on?: string;
    nationality?: string;
    occupation?: string;
}

interface Psc {
    name?: string;
    kind?: string;
    natures_of_control?: string[];
    notified_on?: string;
    ceased_on?: string;
}

export interface CompanyPanelData {
    company_number?: string;
    retrieved_at?: string;
    profile?: CompanyProfile | { error: string };
    officers?: { items?: Officer[] } | { error: string };
    psc?: { items?: Psc[] } | { error: string };
}

export type CompanyPanelSection = "profile" | "officers" | "pscs";

interface Props {
    companyNumber: string;
    companyName?: string;
    /** The full structured payload from the companies_house_get_company tool call. */
    company: unknown;
    /**
     * When set, renders only that section's card (no panel header or
     * attribution) — used by the Company Search page, which supplies its own
     * header, tabs, and attribution footer. Omitted = the full side panel.
     */
    section?: CompanyPanelSection;
}

function isErrorResult(value: unknown): value is { error: string } {
    return (
        !!value &&
        typeof value === "object" &&
        typeof (value as { error?: unknown }).error === "string"
    );
}

/**
 * UK date formatting — never US MM/DD/YYYY. Renders as e.g. "21 February
 * 2022" so it reads unambiguously regardless of locale.
 */
function formatUkDate(value: string | null | undefined): string | null {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

function formatAddress(address?: RegisteredOfficeAddress): string | null {
    if (!address) return null;
    const parts = [
        address.address_line_1,
        address.address_line_2,
        address.locality,
        address.region,
        address.postal_code,
        address.country,
    ].filter((part): part is string => !!part && part.trim().length > 0);
    return parts.length ? parts.join(", ") : null;
}

function humaniseCompanyType(type?: string): string | null {
    if (!type) return null;
    return type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function humaniseStatus(status?: string): string | null {
    if (!status) return null;
    return status.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Matches DocPanel's SectionLabel (frontend/src/app/components/shared/DocPanel.tsx)
// so section headings read identically across doc-backed and company-backed
// side-panel tabs.
function SectionLabel({ children }: { children: React.ReactNode }) {
    return <p className="text-xs font-medium text-gray-700">{children}</p>;
}

function Field({
    label,
    value,
}: {
    label: string;
    value: string | null | undefined;
}) {
    if (!value) return null;
    return (
        <div className="flex flex-col gap-0.5">
            <span className="text-xs text-gray-400">{label}</span>
            <span className="text-sm text-gray-800">{value}</span>
        </div>
    );
}

/**
 * Side-panel view of a Companies House company record: profile, officers,
 * and persons with significant control (PSCs), rendered from the payload
 * persisted on a completed companies_house_get_company tool call. Links out
 * to the public Companies House register for the full filing history and
 * source documents.
 */
export function CompanyPanel({
    companyNumber,
    companyName,
    company,
    section,
}: Props) {
    const data = (company ?? {}) as CompanyPanelData;
    const profile = !isErrorResult(data.profile) ? data.profile : undefined;
    const profileError = isErrorResult(data.profile)
        ? data.profile.error
        : null;
    const officers = !isErrorResult(data.officers)
        ? (data.officers?.items ?? [])
        : [];
    const officersError = isErrorResult(data.officers)
        ? data.officers.error
        : null;
    const pscs = !isErrorResult(data.psc) ? (data.psc?.items ?? []) : [];
    const pscError = isErrorResult(data.psc) ? data.psc.error : null;

    const displayName = profile?.company_name ?? companyName ?? companyNumber;
    const registeredOffice = formatAddress(profile?.registered_office_address);
    const incorporationDate = formatUkDate(profile?.date_of_creation);
    const accountsDue = formatUkDate(profile?.accounts?.next_due);
    const confirmationDue = formatUkDate(
        profile?.confirmation_statement?.next_due,
    );
    const retrievedAt = formatUkDate(data.retrieved_at);
    const registerUrl = `https://find-and-update.company-information.service.gov.uk/company/${companyNumber}`;
    const hasProfileFields = !!(
        profile &&
        (humaniseStatus(profile.company_status) ||
            humaniseCompanyType(profile.type) ||
            incorporationDate ||
            profile.sic_codes?.length ||
            accountsDue ||
            confirmationDue ||
            registeredOffice)
    );

    return (
        <div className="flex h-full flex-col">
            {!section && (
            <div className="flex items-start gap-3 px-3 pt-4 pb-3">
                <div className="min-w-0 flex-1">
                    <h2
                        className="min-w-0 break-words font-serif text-xl text-gray-900"
                        title={displayName}
                    >
                        {displayName}
                    </h2>
                    <p className="mt-1 text-xs text-gray-500">
                        Company no. {companyNumber}
                        {retrievedAt && ` · Retrieved ${retrievedAt}`}
                    </p>
                </div>
                <a
                    href={registerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-50 transition-colors"
                >
                    View on Companies House
                    <ExternalLink className="h-3 w-3" />
                </a>
            </div>
            )}

            <div className="flex flex-1 min-h-0 flex-col gap-5 overflow-y-auto px-3 pb-6">
                {(!section || section === "profile") && (
                <section className="flex flex-col gap-3 rounded-xl border border-gray-100 bg-white/60 p-3">
                    <SectionLabel>Profile</SectionLabel>
                    {profileError ? (
                        <p className="text-sm text-red-600">{profileError}</p>
                    ) : !hasProfileFields ? (
                        <p className="text-sm text-gray-400">
                            No profile data available.
                        </p>
                    ) : (
                        <div className="grid grid-cols-2 gap-3">
                            <Field
                                label="Status"
                                value={humaniseStatus(profile?.company_status)}
                            />
                            <Field
                                label="Company type"
                                value={humaniseCompanyType(profile?.type)}
                            />
                            <Field
                                label="Incorporated"
                                value={incorporationDate}
                            />
                            <Field
                                label="SIC codes"
                                value={profile?.sic_codes?.join(", ") || null}
                            />
                            <Field
                                label="Accounts due"
                                value={accountsDue}
                            />
                            <Field
                                label="Confirmation statement due"
                                value={confirmationDue}
                            />
                            <div className="col-span-2">
                                <Field
                                    label="Registered office"
                                    value={registeredOffice}
                                />
                            </div>
                        </div>
                    )}
                </section>
                )}

                {(!section || section === "officers") && (
                <section className="flex flex-col gap-3 rounded-xl border border-gray-100 bg-white/60 p-3">
                    <SectionLabel>Officers</SectionLabel>
                    {officersError ? (
                        <p className="text-sm text-red-600">
                            {officersError}
                        </p>
                    ) : officers.length === 0 ? (
                        <p className="text-sm text-gray-400">
                            No officers on record.
                        </p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-gray-100">
                            {officers.map((officer, i) => (
                                <li
                                    key={`${officer.name ?? "officer"}-${i}`}
                                    className="py-2 flex flex-col gap-0.5"
                                >
                                    <span className="text-sm font-medium text-gray-800">
                                        {officer.name ?? "Unnamed officer"}
                                    </span>
                                    <span className="text-xs text-gray-500">
                                        {humaniseStatus(officer.officer_role)}
                                        {officer.resigned_on ? (
                                            <>
                                                {" "}
                                                · Resigned{" "}
                                                {formatUkDate(
                                                    officer.resigned_on,
                                                )}
                                            </>
                                        ) : officer.appointed_on ? (
                                            <>
                                                {" "}
                                                · Appointed{" "}
                                                {formatUkDate(
                                                    officer.appointed_on,
                                                )}
                                            </>
                                        ) : null}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
                )}

                {(!section || section === "pscs") && (
                <section className="flex flex-col gap-3 rounded-xl border border-gray-100 bg-white/60 p-3">
                    <SectionLabel>Persons with significant control</SectionLabel>
                    {pscError ? (
                        <p className="text-sm text-red-600">{pscError}</p>
                    ) : pscs.length === 0 ? (
                        <p className="text-sm text-gray-400">
                            No PSCs on record.
                        </p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-gray-100">
                            {pscs.map((psc, i) => (
                                <li
                                    key={`${psc.name ?? "psc"}-${i}`}
                                    className="py-2 flex flex-col gap-0.5"
                                >
                                    <span className="text-sm font-medium text-gray-800">
                                        {psc.name ?? "Unnamed PSC"}
                                    </span>
                                    <span className="text-xs text-gray-500">
                                        {humaniseStatus(psc.kind)}
                                    </span>
                                    {psc.natures_of_control &&
                                        psc.natures_of_control.length > 0 && (
                                            <span className="text-xs text-gray-400">
                                                {psc.natures_of_control
                                                    .map(
                                                        (n) =>
                                                            humaniseStatus(
                                                                n,
                                                            ) ?? n,
                                                    )
                                                    .join(", ")}
                                            </span>
                                        )}
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
                )}

                {!section && (
                <p className="text-xs text-gray-400">
                    Data from the public Companies House register (Crown
                    copyright, Open Government Licence). Not legal advice.
                </p>
                )}
            </div>
        </div>
    );
}
