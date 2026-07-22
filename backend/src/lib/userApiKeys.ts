import { createServerSupabase } from "./supabase";
import type { UserApiKeys } from "./llm";
import {
    decryptApiKey,
    encryptApiKey,
    type EncryptedKeyFields,
} from "./apiKeyCrypto";
import { getUserOrganisationId } from "./organisations";
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
    // Degrade honestly: any failure resolving the firm's keys must never break
    // a whole firm's key status — log with a scoped tag and skip the firm layer
    // (env fallback still applies), per the DURABLE_LESSONS discipline.
    try {
        const organisationId = await getUserOrganisationId(db, userId);
        if (organisationId) {
            const firmStatus = await getOrganisationApiKeyStatus(
                organisationId,
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

    // A user's own key always takes precedence over firm + env, so it reports
    // source "user" even when a firm or env key is also configured.
    for (const row of data ?? []) {
        const provider = normalizeApiKeyProvider(String(row.provider));
        if (provider) {
            status[provider] = true;
            status.sources[provider] = "user";
        }
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

    // Firm layer: a firm-shared key overrides the env fallback but never a
    // personal key. Orgless users / unmigrated databases keep env-only.
    // Degrade honestly: any failure resolving the firm's keys must never break
    // chat key resolution for a whole firm — log with a scoped tag and skip the
    // firm layer (env fallback still applies), per the DURABLE_LESSONS
    // discipline. A personal key still overrides everything below.
    try {
        const organisationId = await getUserOrganisationId(db, userId);
        if (organisationId) {
            const firmKeys = await getOrganisationApiKeys(organisationId, db);
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
