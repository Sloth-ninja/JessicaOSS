import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    OPENAI_LOW_MODELS,
    type UserApiKeys,
} from "./llm";
import { getUserApiKeys as getStoredUserApiKeys } from "./userApiKeys";
import { getUserOrganisationModelContext } from "./organisations";
import { safeErrorLog } from "./safeError";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    api_keys: UserApiKeys;
};

// Title generation is a lightweight task — always routed to the cheapest model
// of whichever provider the user has keys for: Gemini Flash Lite if Gemini is
// available, otherwise OpenAI lite, otherwise Claude Haiku. With no user keys
// set, defaults to Gemini (the dev-mode env fallback).
function resolveTitleModel(apiKeys: UserApiKeys): string {
    if (apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
    if (apiKeys.openai?.trim()) return OPENAI_LOW_MODELS[0];
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    return DEFAULT_TITLE_MODEL;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const { data } = await client
        .from("user_profiles")
        .select("title_model, tabular_model")
        .eq("user_id", userId)
        .single();
    const api_keys = await getStoredUserApiKeys(userId, client);

    // Firm model policy (WS8 PR F): when the member's firm manages model access
    // (`memberModelPrefs` off), the member's personal title/tabular prefs are
    // INERT — the firm's default model governs the review tier, and the title
    // tier stays on the provider-appropriate lightweight default (personal
    // ignored, never deleted). FAIL OPEN: any org-lookup error → personal prefs
    // apply (availability over a brief policy gap; mirrors userApiKeys.ts).
    try {
        const orgContext = await getUserOrganisationModelContext(client, userId);
        if (orgContext && !orgContext.allowMemberModelPrefs) {
            const firmDefault = orgContext.config.defaultModel;
            return {
                title_model: resolveTitleModel(api_keys),
                tabular_model: firmDefault
                    ? resolveModel(firmDefault, DEFAULT_TABULAR_MODEL)
                    : DEFAULT_TABULAR_MODEL,
                api_keys,
            };
        }
    } catch (err) {
        console.error(
            "[user-settings] firm model policy read failed; using personal prefs",
            { userId, error: safeErrorLog(err) },
        );
    }

    return {
        title_model: resolveModel(data?.title_model, resolveTitleModel(api_keys)),
        tabular_model: resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL),
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    const client = db ?? createServerSupabase();
    return getStoredUserApiKeys(userId, client);
}
