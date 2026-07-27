import type { Provider } from "./types";
import { getLocalLlmConfig, isLocalModelId } from "./localConfig";

// ---------------------------------------------------------------------------
// Canonical model IDs
// ---------------------------------------------------------------------------
// Main-chat tier (top-end) — user picks one of these per message.
export const CLAUDE_MAIN_MODELS = [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
] as const;
export const GEMINI_MAIN_MODELS = [
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
] as const;
export const OPENAI_MAIN_MODELS = ["gpt-5.5", "gpt-5.4"] as const;

// Mid-tier (used for tabular review) — user picks one in account settings.
export const CLAUDE_MID_MODELS = ["claude-sonnet-4-6"] as const;
export const GEMINI_MID_MODELS = ["gemini-3.5-flash", "gemini-3-flash-preview"] as const;
export const OPENAI_MID_MODELS = ["gpt-5.4"] as const;

// Low-tier (used for title generation, lightweight extractions) — user picks
// one in account settings.
export const CLAUDE_LOW_MODELS = ["claude-haiku-4-5"] as const;
export const GEMINI_LOW_MODELS = ["gemini-3.1-flash-lite-preview"] as const;
export const OPENAI_LOW_MODELS = ["gpt-5.4-lite"] as const;

export const DEFAULT_MAIN_MODEL = "gemini-3-flash-preview";
export const DEFAULT_TITLE_MODEL = "gemini-3.1-flash-lite-preview";
export const DEFAULT_TABULAR_MODEL = "gemini-3-flash-preview";

const ALL_MODELS = new Set<string>([
    ...CLAUDE_MAIN_MODELS,
    ...GEMINI_MAIN_MODELS,
    ...OPENAI_MAIN_MODELS,
    ...CLAUDE_MID_MODELS,
    ...GEMINI_MID_MODELS,
    ...OPENAI_MID_MODELS,
    ...CLAUDE_LOW_MODELS,
    ...GEMINI_LOW_MODELS,
    ...OPENAI_LOW_MODELS,
]);

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

export function providerForModel(model: string): Provider {
    if (isLocalModelId(model)) return "local";
    if (model.startsWith("claude")) return "claude";
    if (model.startsWith("gemini")) return "gemini";
    if (model.startsWith("gpt-")) return "openai";
    throw new Error(`Unknown model id: ${model}`);
}

export function resolveModel(id: string | null | undefined, fallback: string): string {
    if (id && ALL_MODELS.has(id)) return id;
    // Local model ids are dynamic (server env-configured), so the static
    // registry check above is bypassed for the "local:" prefix whenever
    // local mode is configured at all.
    if (id && isLocalModelId(id) && getLocalLlmConfig()) return id;
    return fallback;
}

// ---------------------------------------------------------------------------
// Firm model configuration (WS8 PR F)
// ---------------------------------------------------------------------------
// The cloud providers a firm can offer members in the model picker. Local
// models are an env-configured data-sovereignty path, never a firm BYO-provider
// choice, so they are deliberately NOT part of this set.
export const MODEL_PROVIDERS = ["claude", "gemini", "openai"] as const;
export type ModelProviderId = (typeof MODEL_PROVIDERS)[number];

export function isModelProvider(value: unknown): value is ModelProviderId {
    return (
        typeof value === "string" &&
        (MODEL_PROVIDERS as readonly string[]).includes(value)
    );
}

/**
 * True when `id` is a model a firm may pin as its default: any registry model,
 * or a configured local model id. Mirrors `resolveModel`'s acceptance so a firm
 * default can never pin an unknown/unusable model.
 */
export function isSelectableModelId(id: string): boolean {
    if (ALL_MODELS.has(id)) return true;
    return isLocalModelId(id) && !!getLocalLlmConfig();
}
