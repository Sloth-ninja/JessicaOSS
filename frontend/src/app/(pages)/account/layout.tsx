"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { accountTabButtonClassName } from "./accountStyles";
import {
    personalApiKeysBlocked,
    personalConnectorsBlocked,
} from "./firmPolicy";

interface TabDef {
    id: string;
    label: string;
    href: string;
}

const TABS: TabDef[] = [
    { id: "general", label: "General", href: "/account" },
    {
        id: "privacy-data",
        label: "Privacy & Data",
        href: "/account/privacy-data",
    },
    { id: "security", label: "Security", href: "/account/security" },
    { id: "models", label: "Model Preferences", href: "/account/models" },
    { id: "api-keys", label: "API Keys", href: "/account/api-keys" },
    { id: "connectors", label: "Connectors", href: "/account/connectors" },
];

export default function AccountLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const { isAuthenticated, authLoading } = useAuth();
    const { profile } = useUserProfile();

    // Firm policy (WS8 PR B): a member's own API-key / connector tabs are hidden
    // — not disabled — when their firm disables the policy. Orgless users and
    // policy-ON firms see every tab. Tradeoff: default-permissive while the
    // profile loads means a policy-OFF member may see a tab appear then vanish
    // once the profile arrives. Chosen deliberately — the common cases (orgless,
    // policy-ON) stay flash-free, and the routes themselves are server-enforced
    // and render a neutral card, so a brief flash exposes nothing.
    const firm = profile?.firm ?? null;
    const tabs = TABS.filter((tab) => {
        if (tab.id === "api-keys") return !personalApiKeysBlocked(firm);
        if (tab.id === "connectors") return !personalConnectorsBlocked(firm);
        return true;
    });

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/");
        }
    }, [isAuthenticated, authLoading, router]);

    if (authLoading) {
        return (
            <div className="h-dvh flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
            </div>
        );
    }

    if (!isAuthenticated) {
        return null;
    }

    return (
        <div className="flex h-full flex-col overflow-y-auto">
            <header className="mx-auto flex h-16 w-full max-w-5xl shrink-0 items-end px-6 pb-2 md:h-24 md:pb-4">
                <h1 className="text-4xl font-medium font-eb-garamond">
                    Settings
                </h1>
            </header>

            <main className="mx-auto w-full max-w-5xl flex-1 px-6 pb-10 pt-4 md:pt-6">
                <div className="grid grid-cols-1 gap-y-6 md:grid-cols-[224px_minmax(0,1fr)] md:gap-x-10">
                    <nav
                        aria-label="Settings"
                        className="z-10 -ml-3 min-w-0 self-start md:sticky md:top-4"
                    >
                        <div className="-m-1 min-w-0 p-1">
                            <div className="-m-1 min-w-0 overflow-x-auto overflow-y-hidden p-1">
                                <ul className="mb-0 flex gap-1 md:flex-col">
                                    {tabs.map((tab) => {
                                        const active =
                                            pathname === tab.href ||
                                            (tab.href !== "/account" &&
                                                pathname.startsWith(tab.href));
                                        return (
                                            <li key={tab.id}>
                                                <button
                                                    type="button"
                                                    aria-current={
                                                        active
                                                            ? "page"
                                                            : undefined
                                                    }
                                                    onClick={() =>
                                                        router.push(tab.href)
                                                    }
                                                    className={accountTabButtonClassName(
                                                        active,
                                                    )}
                                                >
                                                    {tab.label}
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        </div>
                    </nav>

                    <div className="min-w-0 outline-none">{children}</div>
                </div>
            </main>
        </div>
    );
}
