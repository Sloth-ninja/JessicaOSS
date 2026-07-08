import { SETTINGS_MODELS, isLocalModelId, type ModelOption } from "../components/assistant/ModelToggle";
import type { ApiKeyState } from "@/app/lib/mikeApi";

export type ModelProvider = "claude" | "gemini" | "openai" | "local";

export function getModelProvider(modelId: string): ModelProvider | null {
    // Local models are server-reported at runtime, not part of the static
    // SETTINGS_MODELS catalog, so they're matched by id prefix instead.
    if (isLocalModelId(modelId)) return "local";
    const model = SETTINGS_MODELS.find((m) => m.id === modelId);
    if (!model) return null;
    return modelGroupToProvider(model.group);
}

export function isModelAvailable(
    modelId: string,
    apiKeys: ApiKeyState,
    localModels: string[] = [],
): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    if (provider === "local") return localModels.includes(modelId);
    return isProviderAvailable(provider, apiKeys);
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: ApiKeyState,
    localModels: string[] = [],
): boolean {
    // Local availability is server-reported (env-configured), never gated
    // on a per-user API key.
    if (provider === "local") return localModels.length > 0;
    return !!apiKeys[provider]?.configured;
}

export function providerLabel(provider: ModelProvider): string {
    if (provider === "claude") return "Anthropic (Claude)";
    if (provider === "openai") return "OpenAI";
    if (provider === "local") return "Local";
    return "Google (Gemini)";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    if (group === "Anthropic") return "claude";
    if (group === "OpenAI") return "openai";
    if (group === "Local") return "local";
    return "gemini";
}
