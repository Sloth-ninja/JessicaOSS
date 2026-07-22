import { createServerSupabase } from "./supabase";
import {
    decryptApiKey,
    encryptApiKey,
    type EncryptedKeyFields,
} from "./apiKeyCrypto";
import type { ApiKeyProvider } from "./userApiKeys";

type Db = ReturnType<typeof createServerSupabase>;

/**
 * Providers that may hold a firm-level (shared) key. Mirrors the
 * organisation_api_keys / user_api_keys provider enum (migration
 * 20260721_01_firm_administration.sql). Kept as a local list — importing the
 * PROVIDERS value from userApiKeys would create a runtime import cycle, since
 * userApiKeys layers these firm keys on top of personal keys.
 */
const ORG_PROVIDERS: ApiKeyProvider[] = [
    "claude",
    "gemini",
    "openai",
    "openrouter",
    "companies_house",
];

export type OrganisationApiKeyStatus = Record<ApiKeyProvider, boolean>;

/** Decrypted firm keys, keyed by provider. Absent providers = no firm key. */
export type OrganisationApiKeys = Partial<Record<ApiKeyProvider, string>>;

type OrgKeyRow = EncryptedKeyFields & { provider: string };

function isProvider(value: string): value is ApiKeyProvider {
    return (ORG_PROVIDERS as string[]).includes(value);
}

function emptyStatus(): OrganisationApiKeyStatus {
    return {
        claude: false,
        gemini: false,
        openai: false,
        openrouter: false,
        companies_house: false,
    };
}

/**
 * Per-provider "configured" flags for a firm. Never returns key material — used
 * by the admin firm-keys screen and (indirectly) the member key-status layer.
 */
export async function getOrganisationApiKeyStatus(
    organisationId: string,
    db: Db = createServerSupabase(),
): Promise<OrganisationApiKeyStatus> {
    const status = emptyStatus();
    const { data, error } = await db
        .from("organisation_api_keys")
        .select("provider")
        .eq("organisation_id", organisationId);
    if (error) throw error;

    for (const row of data ?? []) {
        const provider = String((row as { provider: unknown }).provider);
        if (isProvider(provider)) status[provider] = true;
    }
    return status;
}

/**
 * Decrypted firm keys for a firm. A row that fails to decrypt is skipped (logged
 * server-side, never surfaced) rather than breaking key resolution.
 */
export async function getOrganisationApiKeys(
    organisationId: string,
    db: Db = createServerSupabase(),
): Promise<OrganisationApiKeys> {
    const keys: OrganisationApiKeys = {};
    const { data, error } = await db
        .from("organisation_api_keys")
        .select("provider, encrypted_key, iv, auth_tag")
        .eq("organisation_id", organisationId);
    if (error) throw error;

    for (const row of (data ?? []) as OrgKeyRow[]) {
        if (!isProvider(row.provider)) continue;
        const provider = row.provider;
        const decrypted = decryptApiKey(row, (err) =>
            console.error("[org-api-keys] failed to decrypt stored key", {
                organisationId,
                provider,
                error: err instanceof Error ? err.message : String(err),
            }),
        );
        if (decrypted?.trim()) keys[provider] = decrypted;
    }
    return keys;
}

/**
 * Save (upsert) or, when value is empty/null, delete a firm's provider key.
 * Mirrors saveUserApiKey semantics: trim, delete-on-empty, encrypted upsert
 * keyed on (organisation_id, provider).
 */
export async function saveOrganisationApiKey(
    organisationId: string,
    provider: ApiKeyProvider,
    value: string | null,
    db: Db = createServerSupabase(),
): Promise<void> {
    const normalized = value?.trim() || null;
    if (!normalized) {
        const { error } = await db
            .from("organisation_api_keys")
            .delete()
            .eq("organisation_id", organisationId)
            .eq("provider", provider);
        if (error) throw error;
        return;
    }

    const { error } = await db.from("organisation_api_keys").upsert(
        {
            organisation_id: organisationId,
            provider,
            ...encryptApiKey(normalized),
            updated_at: new Date().toISOString(),
        },
        { onConflict: "organisation_id,provider" },
    );
    if (error) throw error;
}
