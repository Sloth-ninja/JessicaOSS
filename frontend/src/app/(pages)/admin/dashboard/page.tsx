"use client";

// Firm admin › Dashboard (WS8 PR D). Organisation admins only — gates on
// profile.isAdmin (and GET /admin/usage is gated server-side by requireAdmin).
// Read-only usage overview mirroring the approved mock-up:
//   • Four stat tiles (active members, chats, workflow runs, documents).
//   • A restrained daily chat-trend bar chart (single accent, faint baseline,
//     DD/MM labels, tabular figures).
//   • A per-member activity table and a per-workflow-template usage table.
// A 7d/30d period switch drives the tiles, member columns and the trend; the
// workflow table always reports both a 7d and a 30d column. Loading skeletons
// and an error+retry state follow the incident discipline (never a bare
// spinner, never a silent all-clear).

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    FileText,
    Loader2,
    MessageSquare,
    RefreshCw,
    Table2,
    Users,
} from "lucide-react";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
    getFirmUsage,
    type FirmUsage,
    type FirmUsageDailyPoint,
    type FirmUsageMember,
    type FirmUsageWorkflow,
} from "@/app/lib/mikeApi";

type Period = 7 | 30;

/** DD/MM/YYYY — never US order. Rendered in UTC to match the UTC-bucketed
 *  daily trend, so a late-night UK viewer never sees a last-active/last-run
 *  date drift a day from the chart. */
function formatUkDate(value: string | null): string {
    if (!value) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
        ? "—"
        : parsed.toLocaleDateString("en-GB", { timeZone: "UTC" });
}

/** YYYY-MM-DD → DD/MM, parsed by parts to avoid any timezone shift. */
function dayLabel(date: string): string {
    const [, m, d] = date.split("-");
    return d && m ? `${d}/${m}` : date;
}

function initial(member: FirmUsageMember): string {
    const source = member.displayName || member.email || "?";
    return source.trim().charAt(0).toUpperCase() || "?";
}

export default function AdminDashboardPage() {
    const router = useRouter();
    const { profile, loading: profileLoading } = useUserProfile();
    const [period, setPeriod] = useState<Period>(7);
    const [usage, setUsage] = useState<FirmUsage | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);

    // Non-admins never see this page. Redirect once the profile has loaded and
    // confirms they are not an admin (avoids flashing on first paint).
    useEffect(() => {
        if (!profileLoading && profile && !profile.isAdmin) {
            router.replace("/assistant");
        }
    }, [profileLoading, profile, router]);

    // Fetch-only (no synchronous setState): the skeleton reset happens in the
    // event handlers below, so the effect never triggers a cascading render.
    const load = useCallback((days: Period, signal: AbortSignal) => {
        getFirmUsage(days, signal)
            .then((data) => {
                if (!signal.aborted) setUsage(data);
            })
            .catch(() => {
                if (!signal.aborted) {
                    setError("Could not load the firm's usage.");
                }
            });
    }, []);

    useEffect(() => {
        if (profileLoading || !profile?.isAdmin) return;
        const controller = new AbortController();
        load(period, controller.signal);
        return () => controller.abort();
    }, [period, reloadKey, profileLoading, profile?.isAdmin, load]);

    // Period change / retry reset to the loading skeleton in the event handler
    // (allowed) and let the effect re-run against a fresh AbortController.
    const changePeriod = (next: Period) => {
        if (next === period) return;
        setUsage(null);
        setError(null);
        setPeriod(next);
    };
    const retry = () => {
        setUsage(null);
        setError(null);
        setReloadKey((k) => k + 1);
    };

    if (profileLoading || !profile) {
        return (
            <div className="flex h-full items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </div>
        );
    }
    if (!profile.isAdmin) return null;

    const windowLabel = period === 7 ? "Last 7 days" : "Last 30 days";

    return (
        <div className="flex h-full flex-col overflow-y-auto">
            <PageHeader
                shrink
                breadcrumbs={[
                    { label: "Firm admin" },
                    { label: "Dashboard" },
                ]}
            />
            <div className="mx-auto w-full max-w-5xl px-4 pb-16 md:px-10">
                <div className="mt-4 flex items-center justify-between gap-3">
                    <p className="text-xs text-gray-500">
                        Firm activity at a glance. {windowLabel}.
                    </p>
                    <PeriodSwitch value={period} onChange={changePeriod} />
                </div>

                {error ? (
                    <ErrorState onRetry={retry} />
                ) : (
                    <>
                        <StatTiles usage={usage} />
                        <TrendChart usage={usage} windowLabel={windowLabel} />
                        <MembersTable usage={usage} />
                        <WorkflowsTable usage={usage} />
                    </>
                )}
            </div>
        </div>
    );
}

function PeriodSwitch({
    value,
    onChange,
}: {
    value: Period;
    onChange: (next: Period) => void;
}) {
    return (
        <div
            role="group"
            aria-label="Reporting period"
            className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5"
        >
            {([7, 30] as Period[]).map((days) => (
                <button
                    key={days}
                    type="button"
                    onClick={() => onChange(days)}
                    aria-pressed={value === days}
                    className={
                        value === days
                            ? "rounded-md bg-gray-900 px-3 py-1 text-xs font-medium text-white"
                            : "rounded-md px-3 py-1 text-xs font-medium text-gray-600 transition-colors hover:text-gray-900"
                    }
                >
                    {days} days
                </button>
            ))}
        </div>
    );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-gray-200 bg-white px-5 py-12 text-center">
            <p className="text-sm text-gray-600">
                Could not load the firm&apos;s usage.
            </p>
            <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
                <RefreshCw className="h-3.5 w-3.5" />
                Try again
            </button>
        </div>
    );
}

const STAT_TILES: {
    key: keyof FirmUsage["totals"];
    label: string;
    icon: typeof Users;
}[] = [
    { key: "activeMembers", label: "Active members", icon: Users },
    { key: "chats", label: "Chats", icon: MessageSquare },
    { key: "workflowRuns", label: "Workflow runs", icon: Table2 },
    { key: "documents", label: "Documents processed", icon: FileText },
];

function StatTiles({ usage }: { usage: FirmUsage | null }) {
    return (
        <div className="mt-4 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
            {STAT_TILES.map((tile) => {
                const Icon = tile.icon;
                return (
                    <div
                        key={tile.key}
                        className="flex flex-col gap-1 rounded-xl border border-gray-200 bg-white p-4"
                    >
                        <span className="mb-1.5 flex h-7 w-7 items-center justify-center rounded-lg bg-gray-100 text-gray-700">
                            <Icon className="h-4 w-4" />
                        </span>
                        {usage === null ? (
                            <div className="h-7 w-16 animate-pulse rounded bg-gray-100" />
                        ) : tile.key === "activeMembers" ? (
                            <div className="font-serif text-2xl leading-none text-gray-900">
                                <span className="tabular-nums">
                                    {usage.totals.activeMembers}
                                </span>{" "}
                                <span className="text-base text-gray-400">
                                    of {usage.totals.totalMembers}
                                </span>
                            </div>
                        ) : (
                            <div className="font-serif text-2xl leading-none tabular-nums text-gray-900">
                                {usage.totals[tile.key]}
                            </div>
                        )}
                        <div className="mt-0.5 text-xs text-gray-500">
                            {tile.label}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// ── Restrained daily trend chart ────────────────────────────────────────────
// Single grey-900 accent, one faint baseline, DD/MM labels, tabular figures.
// No gradients, no second series, no y-axis grid clutter. Per-bar value labels
// only in the 7-day view (30 bars would collide); date labels thin out to
// roughly six ticks in the 30-day view.
const CHART_W = 760;
const CHART_H = 150;
const PAD_TOP = 20; // headroom for value labels
const PAD_BOTTOM = 24; // room for DD/MM labels
const PAD_X = 8;

function TrendChart({
    usage,
    windowLabel,
}: {
    usage: FirmUsage | null;
    windowLabel: string;
}) {
    return (
        <div className="mt-6 rounded-xl border border-gray-200 bg-white p-4">
            <div className="mb-2.5 flex items-baseline justify-between">
                <h3 className="text-[13px] font-semibold text-gray-900">
                    Chats per day
                </h3>
                <span className="text-[11px] text-gray-400">{windowLabel}</span>
            </div>
            {usage === null ? (
                <div className="flex h-[110px] items-end gap-2 px-2 pb-5">
                    {[40, 65, 50, 100, 80, 70, 75].map((h, i) => (
                        <div
                            key={i}
                            className="flex-1 animate-pulse rounded bg-gray-100"
                            style={{ height: `${h}%` }}
                        />
                    ))}
                </div>
            ) : (
                <DailyBars points={usage.daily} />
            )}
        </div>
    );
}

function DailyBars({ points }: { points: FirmUsageDailyPoint[] }) {
    const n = points.length;
    const showValues = n <= 7;
    const plotW = CHART_W - PAD_X * 2;
    const plotH = CHART_H - PAD_TOP - PAD_BOTTOM;
    const baseline = PAD_TOP + plotH;
    const max = Math.max(1, ...points.map((p) => p.chats));
    const slot = plotW / n;
    const barW = Math.max(4, Math.min(28, slot * 0.55));
    // Thin date labels to ~6 ticks when there are many bars.
    const labelEvery = n <= 10 ? 1 : Math.ceil(n / 6);

    return (
        <svg
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            className="h-[150px] w-full"
            role="img"
            aria-label="Chats per day"
        >
            <line
                x1={PAD_X}
                y1={baseline}
                x2={CHART_W - PAD_X}
                y2={baseline}
                stroke="#e5e7eb"
                strokeWidth={1}
            />
            {points.map((p, i) => {
                const cx = PAD_X + slot * i + slot / 2;
                const h = p.chats === 0 ? 0 : (p.chats / max) * plotH;
                const y = baseline - h;
                const showLabel = i % labelEvery === 0 || i === n - 1;
                return (
                    <g key={p.date}>
                        {h > 0 && (
                            <rect
                                x={cx - barW / 2}
                                y={y}
                                width={barW}
                                height={h}
                                rx={3}
                                fill="#111827"
                            />
                        )}
                        {showValues && p.chats > 0 && (
                            <text
                                x={cx}
                                y={y - 5}
                                textAnchor="middle"
                                className="tabular-nums"
                                fontSize={10}
                                fill="#4b5563"
                            >
                                {p.chats}
                            </text>
                        )}
                        {showLabel && (
                            <text
                                x={cx}
                                y={CHART_H - 8}
                                textAnchor="middle"
                                className="tabular-nums"
                                fontSize={10}
                                fill="#9ca3af"
                            >
                                {dayLabel(p.date)}
                            </text>
                        )}
                    </g>
                );
            })}
        </svg>
    );
}

// ── Data tables (mirror the firm-settings light-grid pattern) ────────────────

function TableCard({
    title,
    description,
    children,
}: {
    title: string;
    description: string;
    children: React.ReactNode;
}) {
    return (
        <section className="mt-6 overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="border-b border-gray-100 px-5 py-4">
                <h2 className="text-[13px] font-semibold text-gray-900">
                    {title}
                </h2>
                <p className="mt-0.5 text-xs text-gray-500">{description}</p>
            </div>
            {children}
        </section>
    );
}

function TableSkeleton() {
    return (
        <div className="space-y-2 px-5 py-4">
            {[0, 1, 2, 3].map((i) => (
                <div
                    key={i}
                    className="h-6 w-full animate-pulse rounded bg-gray-100"
                />
            ))}
        </div>
    );
}

const MEMBER_COLS = "minmax(0,2fr) 1fr 1fr 1fr";

function MembersTable({ usage }: { usage: FirmUsage | null }) {
    return (
        <TableCard title="Members" description="Activity per member.">
            {usage === null ? (
                <TableSkeleton />
            ) : usage.members.length === 0 ? (
                <p className="px-5 py-6 text-sm text-gray-500">
                    No members to show.
                </p>
            ) : (
                <div role="table">
                    <div
                        role="row"
                        className="grid items-center gap-3 border-b border-gray-200 bg-gray-50 px-5 py-2.5 text-[10.5px] font-semibold uppercase tracking-wide text-gray-500"
                        style={{ gridTemplateColumns: MEMBER_COLS }}
                    >
                        <div>Name</div>
                        <div>Last active</div>
                        <div>Chats</div>
                        <div>Workflows run</div>
                    </div>
                    {usage.members.map((member) => (
                        <div
                            role="row"
                            key={member.userId}
                            className="grid items-center gap-3 border-b border-gray-100 px-5 py-3 text-[13px] text-gray-800 last:border-b-0 hover:bg-gray-50"
                            style={{ gridTemplateColumns: MEMBER_COLS }}
                        >
                            <div className="flex min-w-0 items-center gap-2">
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-700 font-serif text-[11px] text-white">
                                    {initial(member)}
                                </span>
                                <span className="truncate">
                                    {member.displayName ||
                                        member.email ||
                                        member.userId}
                                </span>
                            </div>
                            <div className="tabular-nums text-gray-500">
                                {formatUkDate(member.lastActive)}
                            </div>
                            <div className="tabular-nums">{member.chats}</div>
                            <div className="tabular-nums">
                                {member.workflowRuns}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </TableCard>
    );
}

const WORKFLOW_COLS = "minmax(0,2.4fr) 1fr 1fr 1fr";

function WorkflowsTable({ usage }: { usage: FirmUsage | null }) {
    return (
        <TableCard
            title="Workflow templates"
            description="Usage across the firm."
        >
            {usage === null ? (
                <TableSkeleton />
            ) : usage.workflows.length === 0 ? (
                <p className="px-5 py-6 text-sm text-gray-500">
                    No workflow runs yet.
                </p>
            ) : (
                <div role="table">
                    <div
                        role="row"
                        className="grid items-center gap-3 border-b border-gray-200 bg-gray-50 px-5 py-2.5 text-[10.5px] font-semibold uppercase tracking-wide text-gray-500"
                        style={{ gridTemplateColumns: WORKFLOW_COLS }}
                    >
                        <div>Template</div>
                        <div>Runs (7d)</div>
                        <div>Runs (30d)</div>
                        <div>Last run</div>
                    </div>
                    {usage.workflows.map((wf: FirmUsageWorkflow) => (
                        <div
                            role="row"
                            key={wf.workflowId}
                            className="grid items-center gap-3 border-b border-gray-100 px-5 py-3 text-[13px] text-gray-800 last:border-b-0 hover:bg-gray-50"
                            style={{ gridTemplateColumns: WORKFLOW_COLS }}
                        >
                            <div className="truncate">{wf.title}</div>
                            <div className="tabular-nums">{wf.runs7d}</div>
                            <div className="tabular-nums text-gray-500">
                                {wf.runs30d}
                            </div>
                            <div className="tabular-nums text-gray-500">
                                {formatUkDate(wf.lastRun)}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </TableCard>
    );
}
