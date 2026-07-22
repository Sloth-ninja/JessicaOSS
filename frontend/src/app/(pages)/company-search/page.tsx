"use client";

// Research › Company Search (WS7) — master–detail Companies House search.
// Left: debounced name/number search (320px list). Right: company detail
// with Overview / Officers / PSCs / Filing history tabs, reusing the
// existing CompanyPanel sections plus the paginated FilingHistoryList.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { KeyRound, MessageSquare, Search } from "lucide-react";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { personalApiKeysBlocked } from "@/app/(pages)/account/firmPolicy";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import {
    CompanyPanel,
    type CompanyPanelData,
} from "@/app/components/assistant/CompanyPanel";
import { FilingHistoryList } from "@/app/components/research/FilingHistoryList";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { setAssistantPrefill } from "@/app/lib/assistantPrefill";
import {
    chGetCompany,
    chSearchCompanies,
    MikeApiError,
    type ChCompanySearchItem,
} from "@/app/lib/mikeApi";
import { cn } from "@/lib/utils";

type DetailTab = "overview" | "officers" | "pscs" | "filing";

const DETAIL_TABS: { id: DetailTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "officers", label: "Officers" },
    { id: "pscs", label: "PSCs" },
    { id: "filing", label: "Filing history" },
];

const KEY_MISSING_CODE = "companies_house_key_missing";

function humanise(value?: string): string | null {
    if (!value) return null;
    return value.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** DD/MM/YYYY — never US date order. */
function formatUkShortDate(value?: string): string | null {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toLocaleDateString("en-GB");
}

function StatusDot({ status }: { status?: string }) {
    const active = status?.toLowerCase() === "active";
    return (
        <span
            className={cn(
                "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                active ? "bg-green-600" : "bg-gray-400",
            )}
        />
    );
}

function searchErrorMessage(err: unknown): string {
    if (err instanceof MikeApiError && err.status === 429) {
        return "Companies House rate limit reached. Please try again in a few minutes.";
    }
    return "Could not search Companies House. Please try again later.";
}

function detailErrorMessage(err: unknown): string {
    if (err instanceof MikeApiError) {
        if (err.status === 429) {
            return "Companies House rate limit reached. Please try again in a few minutes.";
        }
        if (err.status === 404) {
            return "Company not found on the Companies House register.";
        }
    }
    return "Could not load this company. Please try again later.";
}

export default function CompanySearchPage() {
    const router = useRouter();
    const { profile } = useUserProfile();

    const [query, setQuery] = useState("");
    const [results, setResults] = useState<ChCompanySearchItem[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);

    const [selected, setSelected] = useState<ChCompanySearchItem | null>(null);
    const [company, setCompany] = useState<CompanyPanelData | null>(null);
    const [companyLoading, setCompanyLoading] = useState(false);
    const [companyError, setCompanyError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<DetailTab>("overview");

    // Key state: from the profile (status endpoint), or discovered via a 409.
    const [keyMissingFromApi, setKeyMissingFromApi] = useState(false);
    const keyConfigured = profile
        ? profile.apiKeys.companies_house.configured && !keyMissingFromApi
        : !keyMissingFromApi;
    // Firm policy (WS8 PR B): a member whose firm manages keys can't add their
    // own — point them at their firm admin instead of the hidden API keys tab.
    const firmManagesKeys = personalApiKeysBlocked(profile?.firm);

    const searchSeq = useRef(0);

    // Debounced search-as-you-type. All state updates happen inside the
    // debounce/promise callbacks, never synchronously in the effect body.
    useEffect(() => {
        const q = query.trim();
        const seq = ++searchSeq.current;
        const timer = setTimeout(
            () => {
                if (q.length < 2) {
                    setResults(null);
                    setSearching(false);
                    setSearchError(null);
                    return;
                }
                setSearching(true);
                setSearchError(null);
                chSearchCompanies(q)
                    .then((result) => {
                        if (searchSeq.current !== seq) return;
                        setResults(result.items ?? []);
                        setSearching(false);
                    })
                    .catch((err) => {
                        if (searchSeq.current !== seq) return;
                        if (
                            err instanceof MikeApiError &&
                            err.code === KEY_MISSING_CODE
                        ) {
                            setKeyMissingFromApi(true);
                        } else {
                            setSearchError(searchErrorMessage(err));
                        }
                        setResults(null);
                        setSearching(false);
                    });
            },
            q.length < 2 ? 0 : 350,
        );
        return () => clearTimeout(timer);
    }, [query]);

    function selectCompany(item: ChCompanySearchItem) {
        const companyNumber = item.company_number;
        if (!companyNumber) return;
        setSelected(item);
        setActiveTab("overview");
        setCompany(null);
        setCompanyError(null);
        setCompanyLoading(true);
        chGetCompany(companyNumber)
            .then((bundle) => {
                setCompany((bundle ?? {}) as CompanyPanelData);
                setCompanyLoading(false);
            })
            .catch((err) => {
                if (
                    err instanceof MikeApiError &&
                    err.code === KEY_MISSING_CODE
                ) {
                    setKeyMissingFromApi(true);
                } else {
                    setCompanyError(detailErrorMessage(err));
                }
                setCompanyLoading(false);
            });
    }

    function continueInAssistant() {
        const companyNumber = selected?.company_number;
        if (!companyNumber) return;
        const profileData =
            company?.profile &&
            typeof company.profile === "object" &&
            !("error" in company.profile)
                ? company.profile
                : undefined;
        const name =
            profileData?.company_name ?? selected?.title ?? companyNumber;
        setAssistantPrefill(
            `Using Companies House, review ${name} (company no. ${companyNumber}): `,
        );
        router.push("/assistant");
    }

    const selectedProfile =
        company?.profile &&
        typeof company.profile === "object" &&
        !("error" in company.profile)
            ? company.profile
            : undefined;
    const detailName =
        selectedProfile?.company_name ??
        selected?.title ??
        selected?.company_number ??
        "";
    const detailStatus = humanise(
        selectedProfile?.company_status ?? selected?.company_status,
    );
    const detailType = humanise(selectedProfile?.type ?? selected?.company_type);
    const retrievedAt = formatUkShortDate(company?.retrieved_at);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                shrink
                breadcrumbs={[
                    { label: "Research" },
                    { label: "Company Search" },
                ]}
            />

            {!keyConfigured ? (
                <div className="flex-1 overflow-y-auto border-t border-gray-200">
                    <div className="mx-auto mt-14 mb-10 max-w-md rounded-2xl border border-gray-200 bg-gray-50 px-6 py-7 text-center">
                        <div className="mx-auto mb-3.5 flex h-10 w-10 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-500">
                            <KeyRound className="h-4 w-4" />
                        </div>
                        <h3 className="text-sm font-semibold text-gray-900">
                            Companies House key not configured
                        </h3>
                        {firmManagesKeys ? (
                            <p className="mt-1.5 text-[13px] leading-relaxed text-gray-500">
                                Company search uses a Companies House key managed
                                by {profile?.firm?.name ?? "your firm"}. Ask your
                                firm admin to add one to enable it.
                            </p>
                        ) : (
                            <>
                                <p className="mt-1.5 text-[13px] leading-relaxed text-gray-500">
                                    Add a Companies House API key in Account → API
                                    keys to enable company search. Registration is
                                    free at
                                    developer.company-information.service.gov.uk.
                                </p>
                                <Link
                                    href="/account/api-keys"
                                    className="mt-4 inline-flex h-8 items-center rounded-md border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
                                >
                                    Go to API keys
                                </Link>
                            </>
                        )}
                    </div>
                </div>
            ) : (
                <div className="flex min-h-0 flex-1 flex-col border-t border-gray-200 md:flex-row">
                    {/* Search list */}
                    <div className="flex w-full shrink-0 flex-col border-b border-gray-200 max-md:max-h-64 md:min-h-0 md:w-80 md:border-b-0 md:border-r">
                        <div className="mx-4 mt-3.5 mb-2 flex h-9 shrink-0 items-center gap-2 rounded-lg bg-gray-100 px-3">
                            <Search className="h-4 w-4 shrink-0 text-gray-400" />
                            <input
                                type="text"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Company name or number…"
                                className="min-w-0 flex-1 bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400"
                            />
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                            {searching ? (
                                <div className="flex flex-col gap-3 px-2.5 py-3">
                                    {["w-3/4", "w-1/2", "w-2/3"].map(
                                        (widthClass, i) => (
                                            <div
                                                key={i}
                                                className="flex flex-col gap-1.5"
                                            >
                                                <SkeletonLine
                                                    className={widthClass}
                                                />
                                                <SkeletonLine className="w-1/3" />
                                            </div>
                                        ),
                                    )}
                                </div>
                            ) : searchError ? (
                                <p className="px-2.5 py-3 text-xs text-gray-500">
                                    {searchError}
                                </p>
                            ) : results && results.length === 0 ? (
                                <p className="px-2.5 py-3 text-xs text-gray-500">
                                    No companies found. Try a different name or
                                    a company number.
                                </p>
                            ) : (
                                (results ?? []).map((item, i) => (
                                    <button
                                        key={`${item.company_number ?? "company"}-${i}`}
                                        onClick={() => selectCompany(item)}
                                        className={cn(
                                            "mb-0.5 w-full rounded-lg px-2.5 py-2 text-left transition-colors",
                                            selected?.company_number ===
                                                item.company_number
                                                ? "bg-gray-200/60"
                                                : "hover:bg-gray-100",
                                        )}
                                    >
                                        <div className="truncate text-[13px] font-semibold text-gray-900">
                                            {item.title ?? item.company_number}
                                        </div>
                                        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
                                            <StatusDot
                                                status={item.company_status}
                                            />
                                            <span className="truncate">
                                                {item.company_number}
                                                {item.company_status &&
                                                    ` · ${humanise(item.company_status)}`}
                                            </span>
                                        </div>
                                    </button>
                                ))
                            )}
                        </div>
                    </div>

                    {/* Detail pane */}
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
                        {!selected ? (
                            <div className="m-auto flex max-w-sm flex-col items-center gap-2.5 px-8 py-16 text-center">
                                <Search className="h-7 w-7 text-gray-300" />
                                <p className="text-sm font-medium text-gray-700">
                                    Search for a company
                                </p>
                                <p className="text-[13px] text-gray-500">
                                    Search by company name or number to view
                                    registered details, officers, PSCs and
                                    filing history from Companies House.
                                </p>
                            </div>
                        ) : companyLoading ? (
                            <div className="px-4 pt-6 md:px-10">
                                <SkeletonLine className="h-5 w-64" />
                                <SkeletonLine className="mt-3 w-44" />
                                <div className="mt-8 flex max-w-md flex-col gap-4">
                                    {["w-full", "w-5/6", "w-2/3", "w-3/4"].map(
                                        (widthClass, i) => (
                                            <SkeletonLine
                                                key={i}
                                                className={widthClass}
                                            />
                                        ),
                                    )}
                                </div>
                            </div>
                        ) : companyError ? (
                            <div className="m-auto max-w-sm px-8 py-16 text-center">
                                <p className="text-sm text-gray-500">
                                    {companyError}
                                </p>
                            </div>
                        ) : company ? (
                            <>
                                <div className="px-4 pt-5 md:px-10">
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <h2 className="font-serif text-xl text-gray-900">
                                                {detailName}
                                            </h2>
                                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-gray-500">
                                                <span className="flex items-center gap-1.5">
                                                    <StatusDot
                                                        status={
                                                            selectedProfile?.company_status ??
                                                            selected.company_status
                                                        }
                                                    />
                                                    Company number{" "}
                                                    {selected.company_number}
                                                    {detailStatus &&
                                                        ` · ${detailStatus}`}
                                                </span>
                                                {detailType && (
                                                    <Badge variant="secondary">
                                                        {detailType}
                                                    </Badge>
                                                )}
                                            </div>
                                        </div>
                                        <Button
                                            size="sm"
                                            onClick={continueInAssistant}
                                        >
                                            <MessageSquare className="h-3.5 w-3.5" />
                                            Continue in Assistant
                                        </Button>
                                    </div>
                                </div>

                                <div className="mt-3">
                                    <TableToolbar
                                        items={DETAIL_TABS}
                                        active={activeTab}
                                        onChange={setActiveTab}
                                    />
                                </div>

                                <div className="flex-1 px-1 pt-4 pb-2 md:px-7">
                                    {activeTab === "filing" ? (
                                        <div className="px-3">
                                            <FilingHistoryList
                                                key={selected.company_number}
                                                companyNumber={
                                                    selected.company_number ??
                                                    ""
                                                }
                                            />
                                        </div>
                                    ) : (
                                        <CompanyPanel
                                            companyNumber={
                                                selected.company_number ?? ""
                                            }
                                            companyName={selected.title}
                                            company={company}
                                            section={
                                                activeTab === "overview"
                                                    ? "profile"
                                                    : activeTab === "officers"
                                                      ? "officers"
                                                      : "pscs"
                                            }
                                        />
                                    )}
                                </div>

                                <p className="px-4 pt-2 pb-6 text-xs text-gray-400 md:px-10">
                                    Data from the public Companies House
                                    register (Crown copyright, Open Government
                                    Licence). Not legal advice.
                                    {retrievedAt &&
                                        ` Retrieved ${retrievedAt}.`}
                                </p>
                            </>
                        ) : null}
                    </div>
                </div>
            )}
        </div>
    );
}
