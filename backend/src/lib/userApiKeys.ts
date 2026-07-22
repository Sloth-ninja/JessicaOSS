import { createServerSupabase } from "./supabase";
import type { UserApiKeys } from "./llm";
import {
    decryptApiKey,
    encryptApiKey,
    type EncryptedKeyFields,
} from "./apiKeyCrypto";
import { getUserOrganisationKeyContext } from "./organisations";
import {
    getOrganisationApiKeys,
    getOrganisationApiKeyStatus,
} from "./organisationApiKeys";

type Db = ReturnType<typeof createServerSupabase>;
export type ApiKeyProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "openrouter"
    | "companies_house";
// Precedence of a resolved key: a personal key ("user") beats a firm-shared key
// ("firm"), which beats the server env fallback ("env"); null = unconfigured.
export type ApiKeySource = "user" | "firm" | "env" | null;
export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
    sources: Record<ApiKeyProvider, ApiKeySource>;
    /**
     * Providers where the caller has a SAVED personal key that is NOT currently
     * used because their firm disabled personal keys (WS8 PR B, policy off).
     * The key is inert but still removable (removal always complies with the
     * policy). Absent/empty when there is nothing inert to surface.
     */
    inertPersonalKeys?: ApiKeyProvider[];
};

type EncryptedKeyRow = EncryptedKeyFields & {
    provider: ApiKeyProvider;
};

const PROVIDERS: ApiKeyProvider[] = [
    "claude",
    "gemini",
    "openai",
    "openrouter",
    "companies_house",
];

function envApiKey(provider: ApiKeyProvider): string | null {
    switch (provider) {
        case "claude":
            return (
                process.env.ANTHROPIC_API_KEY?.trim() ||
                process.env.CLAUDE_API_KEY?.trim() ||
                null
            );
        case "gemini":
            return process.env.GEMINI_API_KEY?.trim() || null;
        case "openai":
            return process.env.OPENAI_API_KEY?.trim() || null;
        case "openrouter":
            return process.env.OPENROUTER_API_KEY?.trim() || null;
        case "companies_house":
            return process.env.COMPANIES_HOUSE_API_KEY?.trim() || null;
        default:
            return null;
    }
}

export function hasEnvApiKey(provider: ApiKeyProvider): boolean {
    return !!envApiKey(provider);
}

// AES-256-GCM crypto lives in ./apiKeyCrypto (shared with organisationApiKeys).
// These thin wrappers keep the personal-key call sites and log tag unchanged.
function encrypt(value: string): EncryptedKeyFields {
    return encryptApiKey(value);
}

function decrypt(row: EncryptedKeyRow): string | null {
    return decryptApiKey(row, (err) =>
        console.error("[user-api-keys] failed to decrypt stored key", {
            provider: row.provider,
            error: err instanceof Error ? err.message : String(err),
        }),
    );
}

function isProvider(value: string): value is ApiKeyProvider {
    return (PROVIDERS as string[]).includes(value);
}

export function normalizeApiKeyProvider(value: string): ApiKeyProvider | null {
    return isProvider(value) ? value : null;
}

export async function getUserApiKeyStatus(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<ApiKeyStatus> {
    const status: ApiKeyStatus = {
        claude: false,
        gemini: false,
        openai: false,
        openrouter: false,
        companies_house: false,
        sources: {
            claude: null,
            gemini: null,
            openai: null,
            openrouter: null,
            companies_house: null,
        },
    };

    // Env keys are the baseline/fallback.
    for (const provider of PROVIDERS) {
        if (hasEnvApiKey(provider)) {
            status[provider] = true;
            status.sources[provider] = "env";
        }
    }

    // Firm layer: a firm-shared key overrides the env fallback (source "firm").
    // Orgless users (and unmigrated databases) have no firm layer — unchanged.
    // The same lookup also yields the firm's personal-key policy (one query, no
    // second round-trip). Degrade honestly: any failure resolving the firm must
    // never break a whole firm's key status — log with a scoped tag, skip the
    // firm layer (env fallback still applies), and FAIL OPEN on the policy
    // (personalKeysAllowed stays true → personal keys still apply), per the
    // DURABLE_LESSONS discipline. Availability first.
    let personalKeysAllowed = true;
    try {
        const orgContext = await getUserOrganisationKeyContext(db, userId);
        if (orgContext) {
            // Policy off ⇒ a member's personal key is not used (firm > env).
            personalKeysAllowed = orgContext.allowMemberApiKeys;
            const firmStatus = await getOrganisationApiKeyStatus(
                orgContext.id,
                db,
            );
            for (const provider of PROVIDERS) {
                if (firmStatus[provider]) {
                    status[provider] = true;
                    status.sources[provider] = "firm";
                }
            }
        }
    } catch (err) {
        console.error(
            "[user-api-keys] firm key status read failed; skipping firm layer",
            { userId, error: err instanceof Error ? err.message : String(err) },
        );
    }

    const { data, error } = await db
        .from("user_api_keys")
        .select("provider")
        .eq("user_id", userId);
    if (error) throw error;

    // A user's own key normally takes precedence over firm + env (source
    // "user"). When the firm disables personal keys, a saved personal key is
    // INERT — not layered into the resolved status, source never "user" — but we
    // still report it under `inertPersonalKeys` so the member can remove it.
    const inertPersonalKeys: ApiKeyProvider[] = [];
    for (const row of data ?? []) {
        const provider = normalizeApiKeyProvider(String(row.provider));
        if (!provider) continue;
        if (personalKeysAllowed) {
            status[provider] = true;
            status.sources[provider] = "user";
        } else {
            inertPersonalKeys.push(provider);
        }
    }
    if (inertPersonalKeys.length > 0) {
        status.inertPersonalKeys = inertPersonalKeys;
    }

    return status;
}

export async function getUserApiKeys(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<UserApiKeys> {
    // Env keys are the fallback; firm keys, then the user's own key, override
    // them below (user > firm > env).
    const apiKeys: UserApiKeys = {
        claude: envApiKey("claude"),
        gemini: envApiKey("gemini"),
        openai: envApiKey("openai"),
        openrouter: envApiKey("openrouter"),
        companies_house: envApiKey("companies_house"),
    };

    // Firm layer: a firm-shared key overrides the env fallback but (normally)
    // never a personal key. The same lookup yields the firm's personal-key
    // policy (one query). Orgless users / unmigrated databases keep env-only.
    // Degrade honestly: any failure resolving the firm must never break chat key
    // resolution for a whole firm — log, skip the firm layer (env fallback still
    // applies), and FAIL OPEN on the policy (personalKeysAllowed stays true, so
    // a personal key still overrides), per DURABLE_LESSONS. Availability first.
    let personalKeysAllowed = true;
    try {
        const orgContext = await getUserOrganisationKeyContext(db, userId);
        if (orgContext) {
            // Policy off ⇒ resolution is firm > env; the personal key is skipped.
            personalKeysAllowed = orgContext.allowMemberApiKeys;
            const firmKeys = await getOrganisationApiKeys(orgContext.id, db);
            for (const provider of PROVIDERS) {
                const firmKey = firmKeys[provider];
                if (firmKey?.trim()) apiKeys[provider] = firmKey;
            }
        }
    } catch (err) {
        console.error(
            "[user-api-keys] firm key read failed; skipping firm layer",
            { userId, error: err instanceof Error ? err.message : String(err) },
        );
    }

    // When the firm disables personal keys, a saved personal key is inert — do
    // not layer it over the firm/env key. (Availability: on the fail-open path
    // above, personalKeysAllowed stays true and personal keys apply as before.)
    if (!personalKeysAllowed) return apiKeys;

    const { data, error } = await db
        .from("user_api_keys")
        .select("provider, encrypted_key, iv, auth_tag")
        .eq("user_id", userId);
    if (error) throw error;

    for (const row of (data ?? []) as EncryptedKeyRow[]) {
        const provider = normalizeApiKeyProvider(row.provider);
        if (!provider) continue;
        // The user's own key always takes precedence. Only fall back to the
        // underlying firm/env key when decryption fails or yields an empty value
        // (preserving the prior trim/decrypt-error behaviour rather than nulling
        // a live firm/env key).
        const decrypted = decrypt(row);
        if (decrypted?.trim()) apiKeys[provider] = decrypted;
    }

    return apiKeys;
}

export async function saveUserApiKey(
    userId: string,
    provider: ApiKeyProvider,
    value: string | null,
    db: Db = createServerSupabase(),
): Promise<void> {
    const normalized = value?.trim() || null;
    if (!normalized) {
        const { error } = await db
            .from("user_api_keys")
            .delete()
            .eq("user_id", userId)
            .eq("provider", provider);
        if (error) throw error;
        return;
    }

    const { error } = await db.from("user_api_keys").upsert(
        {
            user_id: userId,
            provider,
            ...encrypt(normalized),
            updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" },
    );
    if (error) throw error;
}
