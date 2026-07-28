"use client";

// Research › Land Registry (WS7 — Land Registry v1). Three cards:
//   1. Account connection — honest status: HM Land Registry's conditions of use
//      bar entering portal credentials into a third-party app until it is an
//      authorised channel partner, so v1 has NO account-connection path by
//      design (CLAUDE.md data integration 4). The "coming in v2" messaging lives
//      here, inside the page — not in the sidebar.
//   2. Price Paid lookup — free, keyless open-data sold-price search by
//      postcode over /land-registry (Open Government Licence v3.0), capped at
//      the 25 most recent transactions.
//   3. Official services — plain outbound links to HM Land Registry's own
//      chargeable services; nothing chargeable happens inside JessicaOS in v1.
//
// Submit-on-enter / click only (NO search-as-you-type): the lookup is a live
// SPARQL round trip. Every fetch is time-boxed and shows a skeleton then an
// error-with-retry — never an unbounded spinner (docs/DURABLE_LESSONS.md).

import { useRef, useState } from "react";
import {
    ExternalLink,
    Info,
    Landmark,
    Lock,
    Search,
} from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { Button } from "@/components/ui/button";
import {
    getPricePaid,
    MikeApiError,
    type PricePaidEntry,
} from "@/app/lib/mikeApi";

const GBP = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
});

/** ISO `YYYY-MM-DD` → DD/MM/YYYY (never US date order). */
function formatUkDate(iso: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function propertyLine(entry: PricePaidEntry): string {
    return [entry.propertyType, entry.tenure].filter(Boolean).join(" · ") || "—";
}

const OFFICIAL_SERVICES = [
    {
        title: "Search for land and property information",
        description: "Title summaries, ownership and tenure — GOV.UK, £3 per summary",
        href: "https://search-property-information.service.gov.uk/",
    },
    {
        title: "Order an official copy of the register",
        description: "Official copies and title plans — £7, via your portal account",
        href: "https://www.gov.uk/get-information-about-property-and-land/search-the-register",
    },
    {
        title: "HM Land Registry portal sign-in",
        description: "Business e-services — use your existing firm login",
        href: "https://customer.landregistry.gov.uk/",
    },
];

type SearchStatus = "idle" | "loading" | "error" | "done";

function lookupErrorMessage(err: unknown): string {
    // The backend returns a fixed, safe detail for a malformed postcode (400);
    // surface it so the user can correct the input. Anything else is generic.
    if (err instanceof MikeApiError && err.status === 400) {
        return err.message || "Enter a valid UK postcode.";
    }
    return "Could not reach HM Land Registry. Please try again later.";
}

export default function LandRegistryPage() {
    const [postcode, setPostcode] = useState("");
    const [status, setStatus] = useState<SearchStatus>("idle");
    const [entries, setEntries] = useState<PricePaidEntry[]>([]);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [searchedPostcode, setSearchedPostcode] = useState("");

    const abortRef = useRef<AbortController | null>(null);
    const seqRef = useRef(0);

    function runSearch(raw: string) {
        const trimmed = raw.trim();
        if (!trimmed) return;

        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const seq = ++seqRef.current;

        setStatus("loading");
        setErrorMsg(null);
        setSearchedPostcode(trimmed);

        getPricePaid(trimmed, controller.signal)
            .then((result) => {
                if (seqRef.current !== seq) return;
                setEntries(result.entries ?? []);
                setStatus("done");
            })
            .catch((err) => {
                if (seqRef.current !== seq) return;
                if (err instanceof DOMException && err.name === "AbortError")
                    return;
                setEntries([]);
                setErrorMsg(lookupErrorMessage(err));
                setStatus("error");
            });
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                shrink
                breadcrumbs={[
                    { label: "Research" },
                    { label: "Land Registry" },
                ]}
            />

            <div className="flex-1 overflow-y-auto border-t border-gray-200">
                <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6 md:py-8">
                    {/* 1. Account connection */}
                    <section className="rounded-xl border border-gray-200">
                        <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-3.5">
                            <div>
                                <h2 className="text-sm font-semibold text-gray-900">
                                    Account connection
                                </h2>
                                <p className="mt-0.5 text-xs text-gray-500">
                                    Why you can’t link your portal login yet — and
                                    what’s coming.
                                </p>
                            </div>
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300/60 bg-amber-50 px-2.5 py-0.5 text-[11px] font-medium text-amber-800">
                                <Lock className="h-2.5 w-2.5" />
                                Not yet connectable
                            </span>
                        </div>
                        <div className="px-5 py-4 text-[13px] leading-relaxed text-gray-500">
                            <p className="max-w-prose">
                                HM Land Registry’s conditions of use don’t allow
                                portal credentials to be entered into a third-party
                                application until that application is an authorised
                                channel partner. This requires JessicaOS to be
                                authorised as an HM Land Registry channel partner.
                                Until then, your portal account works exactly as
                                today.
                            </p>
                            <ul className="mt-3 list-disc space-y-1.5 pl-5">
                                <li>
                                    <span className="font-semibold text-gray-900">
                                        Available now (below):
                                    </span>{" "}
                                    sold-price history for any postcode, free, no
                                    account needed.
                                </li>
                                <li>
                                    <span className="font-semibold text-gray-900">
                                        Coming in v2:
                                    </span>{" "}
                                    official copies of the register ordered in-app
                                    with your own Business Gateway credentials — £7
                                    per copy, billed to the firm.
                                </li>
                            </ul>
                        </div>
                    </section>

                    {/* 2. Price Paid lookup */}
                    <section className="mt-5 rounded-xl border border-gray-200">
                        <div className="border-b border-gray-100 px-5 py-3.5">
                            <h2 className="text-sm font-semibold text-gray-900">
                                Price Paid lookup
                            </h2>
                            <p className="mt-0.5 text-xs text-gray-500">
                                Sold prices registered in England and Wales —
                                searched by postcode.
                            </p>
                        </div>
                        <div className="px-5 py-4">
                            <form
                                className="flex gap-2.5"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    runSearch(postcode);
                                }}
                            >
                                <input
                                    type="text"
                                    value={postcode}
                                    onChange={(e) => setPostcode(e.target.value)}
                                    placeholder="e.g. IG10 1LH"
                                    autoCapitalize="characters"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    aria-label="Postcode"
                                    className="h-9 w-48 rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm uppercase tracking-wide text-gray-900 outline-none placeholder:normal-case placeholder:tracking-normal placeholder:text-gray-400 focus:border-gray-300"
                                />
                                <Button
                                    type="submit"
                                    disabled={
                                        status === "loading" || !postcode.trim()
                                    }
                                >
                                    <Search className="h-3.5 w-3.5" />
                                    Search
                                </Button>
                            </form>

                            {status === "loading" && (
                                <div className="mt-5 flex flex-col gap-3">
                                    {["w-full", "w-5/6", "w-3/4", "w-2/3"].map(
                                        (w, i) => (
                                            <SkeletonLine key={i} className={w} />
                                        ),
                                    )}
                                </div>
                            )}

                            {status === "error" && (
                                <div className="mt-5 rounded-lg border border-gray-200 bg-gray-50 px-4 py-5 text-center">
                                    <p className="text-[13px] text-gray-600">
                                        {errorMsg}
                                    </p>
                                    <button
                                        onClick={() => runSearch(searchedPostcode)}
                                        className="mt-3 inline-flex h-8 items-center rounded-md border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
                                    >
                                        Try again
                                    </button>
                                </div>
                            )}

                            {status === "done" && entries.length === 0 && (
                                <div className="mt-5 rounded-lg border border-gray-200 bg-gray-50 px-4 py-6 text-center">
                                    <p className="text-[13px] text-gray-500">
                                        No registered transactions found for{" "}
                                        {searchedPostcode.toUpperCase()}.
                                    </p>
                                </div>
                            )}

                            {status === "done" && entries.length > 0 && (
                                <>
                                    <div className="mt-4 overflow-x-auto">
                                        <table className="w-full border-collapse text-[13px]">
                                            <thead>
                                                <tr className="border-b border-gray-200 text-left text-[11px] uppercase tracking-wider text-gray-400">
                                                    <th className="px-2 py-1.5 font-medium">
                                                        Address
                                                    </th>
                                                    <th className="px-2 py-1.5 font-medium">
                                                        Type
                                                    </th>
                                                    <th className="px-2 py-1.5 text-right font-medium">
                                                        Price
                                                    </th>
                                                    <th className="px-2 py-1.5 text-right font-medium">
                                                        Date
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {entries.map((entry, i) => (
                                                    <tr
                                                        key={`${entry.address}-${entry.date}-${i}`}
                                                        className="border-b border-gray-100 align-top"
                                                    >
                                                        <td className="px-2 py-2 text-gray-900">
                                                            {entry.address || "—"}
                                                        </td>
                                                        <td className="px-2 py-2 text-gray-500">
                                                            {propertyLine(entry)}
                                                        </td>
                                                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-gray-900">
                                                            {GBP.format(entry.price)}
                                                        </td>
                                                        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-gray-500">
                                                            {formatUkDate(entry.date)}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-gray-400">
                                        Contains HM Land Registry data © Crown
                                        copyright and database right{" "}
                                        {new Date().getFullYear()}. This data is
                                        licensed under the Open Government Licence
                                        v3.0.{" "}
                                        {entries.length < 25
                                            ? `Showing all ${entries.length.toLocaleString("en-GB")} transaction${entries.length === 1 ? "" : "s"}.`
                                            : "Showing the 25 most recent transactions (the list is capped at 25)."}
                                    </p>
                                </>
                            )}
                        </div>
                    </section>

                    {/* 3. Official services */}
                    <section className="mt-5 rounded-xl border border-gray-200">
                        <div className="border-b border-gray-100 px-5 py-3.5">
                            <h2 className="text-sm font-semibold text-gray-900">
                                Official services
                            </h2>
                            <p className="mt-0.5 text-xs text-gray-500">
                                The chargeable steps stay on HM Land Registry’s own
                                services for now.
                            </p>
                        </div>
                        <div>
                            {OFFICIAL_SERVICES.map((service) => (
                                <a
                                    key={service.href}
                                    href={service.href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-3 transition-colors first:border-t-0 hover:bg-gray-50"
                                >
                                    <div className="min-w-0">
                                        <div className="text-[13px] font-medium text-gray-900">
                                            {service.title}
                                        </div>
                                        <div className="mt-0.5 text-xs text-gray-500">
                                            {service.description}
                                        </div>
                                    </div>
                                    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-gray-500">
                                        Open
                                        <ExternalLink className="h-3 w-3" />
                                    </span>
                                </a>
                            ))}
                        </div>
                        <div className="flex items-start gap-2.5 rounded-b-xl bg-gray-50 px-5 py-3.5 text-xs text-gray-500">
                            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
                            <span>
                                Bought a copy on the portal? Upload the PDF into the
                                matter and Jessica can read and cite it like any
                                other document.
                            </span>
                        </div>
                    </section>

                    <p className="mt-5 flex items-center gap-1.5 text-xs text-gray-400">
                        <Landmark className="h-3 w-3" />
                        HM Land Registry open data. Not legal advice.
                    </p>
                </div>
            </div>
        </div>
    );
}
