import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLocalLlmConfig,
  getLocalLlmStatus,
  getLocalModelIds,
  isLocalModelId,
  stripLocalModelPrefix,
} from "./localConfig";

describe("localConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when nothing is configured", () => {
    vi.stubEnv("LOCAL_LLM_BASE_URL", "");
    vi.stubEnv("OPENAI_BASE_URL", "");
    vi.stubEnv("LOCAL_LLM_MODELS", "");
    expect(getLocalLlmConfig()).toBeNull();
    expect(getLocalLlmStatus()).toEqual({ configured: false, models: [] });
  });

  it("requires both a base URL and at least one model", () => {
    vi.stubEnv("LOCAL_LLM_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("LOCAL_LLM_MODELS", "");
    expect(getLocalLlmConfig()).toBeNull();

    vi.stubEnv("LOCAL_LLM_BASE_URL", "");
    vi.stubEnv("LOCAL_LLM_MODELS", "qwen2.5:14b-instruct");
    expect(getLocalLlmConfig()).toBeNull();
  });

  it("resolves a fully configured LOCAL_LLM_* set, trimming/ignoring empty model entries", () => {
    vi.stubEnv("LOCAL_LLM_BASE_URL", "http://localhost:11434/v1/");
    vi.stubEnv("LOCAL_LLM_MODELS", " qwen2.5:14b-instruct ,, mistral-small ,");
    vi.stubEnv("LOCAL_LLM_API_KEY", "");

    const config = getLocalLlmConfig();
    expect(config).not.toBeNull();
    expect(config?.baseUrl).toBe("http://localhost:11434/v1");
    expect(config?.models).toEqual(["qwen2.5:14b-instruct", "mistral-small"]);
    expect(config?.apiKey).toBe("ollama");
  });

  it("honours an explicit LOCAL_LLM_API_KEY over the ollama default", () => {
    vi.stubEnv("LOCAL_LLM_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("LOCAL_LLM_MODELS", "qwen2.5:14b-instruct");
    vi.stubEnv("LOCAL_LLM_API_KEY", "my-secret");

    expect(getLocalLlmConfig()?.apiKey).toBe("my-secret");
  });

  it("honours OPENAI_BASE_URL as an alias only when LOCAL_LLM_BASE_URL is unset", () => {
    vi.stubEnv("LOCAL_LLM_BASE_URL", "");
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:1234/v1");
    vi.stubEnv("LOCAL_LLM_MODELS", "qwen2.5:14b-instruct");

    expect(getLocalLlmConfig()?.baseUrl).toBe("http://localhost:1234/v1");
  });

  it("prefers LOCAL_LLM_BASE_URL over OPENAI_BASE_URL when both are set", () => {
    vi.stubEnv("LOCAL_LLM_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:1234/v1");
    vi.stubEnv("LOCAL_LLM_MODELS", "qwen2.5:14b-instruct");

    expect(getLocalLlmConfig()?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("getLocalModelIds prefixes each model with local:", () => {
    vi.stubEnv("LOCAL_LLM_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("LOCAL_LLM_MODELS", "qwen2.5:14b-instruct,mistral-small");

    expect(getLocalModelIds()).toEqual([
      "local:qwen2.5:14b-instruct",
      "local:mistral-small",
    ]);
  });

  it("getLocalLlmStatus reports configured + prefixed models", () => {
    vi.stubEnv("LOCAL_LLM_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("LOCAL_LLM_MODELS", "qwen2.5:14b-instruct");

    expect(getLocalLlmStatus()).toEqual({
      configured: true,
      models: ["local:qwen2.5:14b-instruct"],
    });
  });

  it("isLocalModelId / stripLocalModelPrefix", () => {
    expect(isLocalModelId("local:qwen2.5:14b-instruct")).toBe(true);
    expect(isLocalModelId("gpt-5.5")).toBe(false);
    expect(stripLocalModelPrefix("local:qwen2.5:14b-instruct")).toBe(
      "qwen2.5:14b-instruct",
    );
    expect(stripLocalModelPrefix("gpt-5.5")).toBe("gpt-5.5");
  });
});
