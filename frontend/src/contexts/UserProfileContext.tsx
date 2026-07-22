"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
    useCallback,
} from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
    type ApiKeyState,
    type ApiKeyProvider,
    type OrganisationMembership,
    type UserProfile as ApiUserProfile,
    getUserProfile,
    isMfaRequiredError,
    saveApiKey,
    updateUserMfaOnLogin,
    updateUserProfile,
} from "@/app/lib/mikeApi";

interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    /** Structured firm membership (WS8); null for orgless users. */
    firm: OrganisationMembership | null;
    isAdmin: boolean;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    titleModel: string;
    tabularModel: string;
    mfaOnLogin: boolean;
    apiKeys: ApiKeyState;
    /** Server-reported local:-prefixed model ids; empty when unconfigured. */
    localModels: string[];
    /** Providers with a saved personal key that is inert because the firm
     *  disabled personal keys (WS8 PR B) — surfaced so it can be removed. */
    inertPersonalKeys: ApiKeyProvider[];
}

// Cap how long the initial profile load may block the app. Without this, a
// backend that accepts the request but never responds (e.g. an unwrapped
// handler hanging on a lost DB grant — login-spinner incident, 2026-07-21)
// leaves `loading` true forever and the gate shows an infinite spinner.
const PROFILE_LOAD_TIMEOUT_MS = 15_000;

interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    /** True when the profile load failed or timed out; drives the retry gate. */
    error: boolean;
    updateDisplayName: (name: string) => Promise<boolean>;
    updateOrganisation: (organisation: string) => Promise<boolean>;
    updateModelPreference: (
        field: "titleModel" | "tabularModel",
        value: string,
    ) => Promise<boolean>;
    updateMfaOnLogin: (enabled: boolean) => Promise<boolean>;
    updateApiKey: (
        provider: ApiKeyProvider,
        value: string | null,
    ) => Promise<boolean>;
    reloadProfile: () => Promise<void>;
    incrementMessageCredits: () => Promise<boolean>;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);

const API_KEY_PROVIDERS: ApiKeyProvider[] = [
    "claude",
    "gemini",
    "openai",
    "openrouter",
    "companies_house",
];

function emptyApiKeys(): ApiKeyState {
    return {
        claude: { configured: false, source: null },
        gemini: { configured: false, source: null },
        openai: { configured: false, source: null },
        openrouter: { configured: false, source: null },
        companies_house: { configured: false, source: null },
    };
}

function toProfile(data: ApiUserProfile): UserProfile {
    const { apiKeyStatus, ...profile } = data;
    const apiKeys = emptyApiKeys();
    for (const provider of API_KEY_PROVIDERS) {
        apiKeys[provider] = {
            configured: !!apiKeyStatus[provider],
            source:
                apiKeyStatus.sources?.[provider] ??
                (apiKeyStatus[provider] ? "user" : null),
        };
    }

    return {
        ...profile,
        mfaOnLogin: profile.mfaOnLogin === true,
        apiKeys,
        localModels: apiKeyStatus.local?.models ?? [],
        inertPersonalKeys: apiKeyStatus.inertPersonalKeys ?? [],
    };
}

export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated } = useAuth();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const userId = user?.id ?? null;

    const loadProfile = useCallback(async () => {
        setLoading(true);
        setError(false);
        // Time-box the request so a hanging backend can't spin forever.
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            PROFILE_LOAD_TIMEOUT_MS,
        );
        try {
            const profileData = await getUserProfile(controller.signal);
            setProfile(toProfile(profileData));
        } catch {
            // A rejected or timed-out profile load must surface an honest error
            // state with a retry — never an infinite spinner, and never a
            // misleading "all clear" fallback profile that hides the outage.
            setProfile(null);
            setError(true);
        } finally {
            clearTimeout(timeout);
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated && userId) {
            setLoading(true);
            loadProfile();
        } else {
            setProfile(null);
            setLoading(false);
        }
    }, [isAuthenticated, userId, loadProfile]);

    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            if (!user) {
                return false;
            }

            try {
                const updated = await updateUserProfile({ displayName });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({ organisation });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                return false;
            }
        },
        [user],
    );

    const updateModelPreference = useCallback(
        async (
            field: "titleModel" | "tabularModel",
            value: string,
        ): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({
                    [field]: value,
                });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateMfaOnLogin = useCallback(
        async (enabled: boolean): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserMfaOnLogin(enabled);
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                return false;
            }
        },
        [user],
    );

    const updateApiKey = useCallback(
        async (
            provider: ApiKeyProvider,
            value: string | null,
        ): Promise<boolean> => {
            if (!user) return false;
            const normalized = value?.trim() ? value.trim() : null;
            try {
                await saveApiKey(provider, normalized);
                setProfile((prev) =>
                    prev
                        ? {
                              ...prev,
                              apiKeys: {
                                  ...prev.apiKeys,
                                  [provider]: {
                                      configured: !!normalized,
                                      source: normalized ? "user" : null,
                                  },
                              },
                          }
                        : null,
                );
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                // Rethrow so the caller can surface the server's explanation
                // (e.g. the 409 "configured by the server environment" detail).
                throw error;
            }
        },
        [user],
    );

    const reloadProfile = useCallback(async () => {
        if (userId) {
            await loadProfile();
        }
    }, [userId, loadProfile]);

    const incrementMessageCredits = useCallback(async (): Promise<boolean> => {
        if (!user || !profile) {
            return false;
        }

        // Check if user has credits remaining
        if (profile.creditsRemaining <= 0) {
            return false;
        }

        return false;
    }, [user, profile]);

    return (
        <UserProfileContext.Provider
            value={{
                profile,
                loading,
                error,
                updateDisplayName,
                updateOrganisation,
                updateModelPreference,
                updateMfaOnLogin,
                updateApiKey,
                reloadProfile,
                incrementMessageCredits,
            }}
        >
            {children}
        </UserProfileContext.Provider>
    );
}

export function useUserProfile() {
    const context = useContext(UserProfileContext);
    if (context === undefined) {
        throw new Error(
            "useUserProfile must be used within a UserProfileProvider",
        );
    }
    return context;
}
