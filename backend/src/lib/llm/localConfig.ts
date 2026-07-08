// Config resolution for the local / on-premises OpenAI-compatible provider
// (Ollama, LM Studio, vLLM — any server exposing POST /v1/chat/completions).
//
// Server-level env config only — there is deliberately NO per-user base URL
// (a user-supplied URL fetched by the backend is an SSRF surface; see
// docs/MIGRATION_SPEC.md §6.5). Positioning is data sovereignty, not cost.

export type LocalLlmConfig = {
  /** Base URL, e.g. "http://localhost:11434/v1" (no trailing slash). */
  baseUrl: string;
  /** Bare model ids as configured (no "local:" prefix), e.g. ["qwen2.5:14b-instruct"]. */
  models: string[];
  /** Bearer token to send; defaults to "ollama" when unset (most local servers ignore it). */
  apiKey: string;
};

export const LOCAL_MODEL_PREFIX = "local:";

function resolveBaseUrl(): string {
  const dedicated = process.env.LOCAL_LLM_BASE_URL?.trim();
  if (dedicated) return dedicated.replace(/\/+$/, "");

  // OPENAI_BASE_URL is honoured as a documented alias only when
  // LOCAL_LLM_BASE_URL is unset — it must never affect the cloud OpenAI
  // client, which always talks to the real OpenAI Responses API.
  const alias = process.env.OPENAI_BASE_URL?.trim();
  if (alias) return alias.replace(/\/+$/, "");

  return "";
}

function resolveModels(): string[] {
  const raw = process.env.LOCAL_LLM_MODELS?.trim() || "";
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Returns the local provider config, or null when not configured.
 * "Configured" = a base URL is present AND at least one model is listed.
 */
export function getLocalLlmConfig(): LocalLlmConfig | null {
  const baseUrl = resolveBaseUrl();
  const models = resolveModels();
  if (!baseUrl || models.length === 0) return null;

  const apiKey = process.env.LOCAL_LLM_API_KEY?.trim() || "ollama";
  return { baseUrl, models, apiKey };
}

/** All selectable model ids, prefixed for the picker (e.g. "local:qwen2.5:14b-instruct"). */
export function getLocalModelIds(): string[] {
  const config = getLocalLlmConfig();
  if (!config) return [];
  return config.models.map((model) => `${LOCAL_MODEL_PREFIX}${model}`);
}

export function isLocalModelId(id: string): boolean {
  return id.startsWith(LOCAL_MODEL_PREFIX);
}

export function stripLocalModelPrefix(id: string): string {
  return isLocalModelId(id) ? id.slice(LOCAL_MODEL_PREFIX.length) : id;
}

/** Availability payload surfaced to the frontend via /user/api-keys (and /user/profile). */
export function getLocalLlmStatus(): { configured: boolean; models: string[] } {
  const config = getLocalLlmConfig();
  if (!config) return { configured: false, models: [] };
  return { configured: true, models: getLocalModelIds() };
}
