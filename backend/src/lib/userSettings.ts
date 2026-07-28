import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    DEFAULT_MAIN_MODEL,
    OPENAI_LOW_MODELS,
    defaultMainModelForProvider,
    safeProviderForModel,
    type ModelProviderId,
    type UserApiKeys,
} from "./llm";
import { isLocalModelId } from "./llm/localConfig";
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

/**
 * Clamp a CLIENT-SUPPLIED main-chat model id against the caller's firm model
 * policy (WS8 PR F). The account/chat model pickers are filtered client-side,
 * but `POST /chat` and `POST /projects/:id/chat` accept a raw `model` in the
 * request body — so the firm policy MUST also be enforced server-side, or a
 * member could bypass it with a crafted request (gate the routes, not just the
 * tabs — the PR B precedent). Mirrors the frontend picker + `getUserModelSettings`.
 *
 * Rules, in order:
 *   1. A local model id passes through untouched (data-sovereignty path).
 *   2. FAIL OPEN: any org-lookup error, or no membership (orgless/unmigrated) →
 *      the requested model is used unchanged (availability over a policy gap).
 *   3. Policy OFF with a firm default set → forced to the firm default.
 *   4. offeredProviders non-empty and the requested provider is not offered →
 *      substitute the firm default (kept coherent with offeredProviders by the
 *      admin route's validation) else the default main model (if its provider is
 *      offered) else the first offered provider's default main model.
 *   5. Otherwise (orgless / policy ON with no restriction, requested provider
 *      already offered) → unchanged.
 *
 * `requested` may be undefined (the client sent no model); the same rules apply,
 * returning a concrete model when the firm constrains it, else undefined.
 */
export async function resolveOrgChatModel(
    userId: string,
    requested: string | undefined,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<string | undefined> {
    // (1) Local ids are never clamped.
    if (requested && isLocalModelId(requested)) return requested;
    const client = db ?? createServerSupabase();
    try {
        const ctx = await getUserOrganisationModelContext(client, userId);
        if (!ctx) return requested; // (2) orgless / unmigrated
        const { allowMemberModelPrefs, config } = ctx;
        const firmDefault = config.defaultModel;

        // (3) Policy OFF: the firm default governs the main chat model when set.
        if (!allowMemberModelPrefs && firmDefault) return firmDefault;

        // (4) Provider restriction (applies under either policy state).
        const offered = config.offeredProviders;
        if (offered.length > 0) {
            const requestedProvider = requested
                ? safeProviderForModel(requested)
                : null;
            if (requestedProvider && offered.includes(requestedProvider)) {
                return requested; // already an offered provider
            }
            // Substitute within the offered set. The admin route guarantees a
            // set firm default's provider is offered (or offered is empty), so
            // the firm default is the preferred substitute when present.
            if (firmDefault) return firmDefault;
            const defaultProvider = safeProviderForModel(DEFAULT_MAIN_MODEL);
            if (defaultProvider && offered.includes(defaultProvider)) {
                return DEFAULT_MAIN_MODEL;
            }
            return defaultMainModelForProvider(offered[0] as ModelProviderId);
        }

        // (5) No restriction, or the requested provider is already offered.
        return requested;
    } catch (err) {
        console.error(
            "[user-settings] firm chat-model clamp failed; using requested model",
            { userId, error: safeErrorLog(err) },
        );
        return requested; // fail open
    }
}
