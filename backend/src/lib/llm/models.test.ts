import { afterEach, describe, expect, it, vi } from "vitest";
import { providerForModel, resolveModel } from "./models";

describe("providerForModel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps known cloud prefixes", () => {
    expect(providerForModel("claude-fable-5")).toBe("claude");
    expect(providerForModel("gemini-3-flash-preview")).toBe("gemini");
    expect(providerForModel("gpt-5.5")).toBe("openai");
  });

  it("maps the local: prefix regardless of configuration", () => {
    expect(providerForModel("local:qwen2.5:14b-instruct")).toBe("local");
  });

  it("throws for unknown model ids", () => {
    expect(() => providerForModel("mystery-model")).toThrow(
      "Unknown model id: mystery-model",
    );
  });
});

describe("resolveModel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a registry model id", () => {
    expect(resolveModel("claude-fable-5", "gemini-3-flash-preview")).toBe(
      "claude-fable-5",
    );
  });

  it("falls back for an unknown non-local id", () => {
    expect(resolveModel("mystery-model", "gemini-3-flash-preview")).toBe(
      "gemini-3-flash-preview",
    );
  });

  it("falls back for a local: id when local mode is not configured", () => {
    vi.stubEnv("LOCAL_LLM_BASE_URL", "");
    vi.stubEnv("OPENAI_BASE_URL", "");
    vi.stubEnv("LOCAL_LLM_MODELS", "");
    expect(
      resolveModel("local:qwen2.5:14b-instruct", "gemini-3-flash-preview"),
    ).toBe("gemini-3-flash-preview");
  });

  it("accepts any local: id when local mode is configured (registry bypass)", () => {
    vi.stubEnv("LOCAL_LLM_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("LOCAL_LLM_MODELS", "qwen2.5:14b-instruct");
    // Even a model id not in LOCAL_LLM_MODELS is accepted once local
    // mode is configured at all — per docs/MIGRATION_SPEC.md §5.2.
    expect(
      resolveModel("local:some-other-model", "gemini-3-flash-preview"),
    ).toBe("local:some-other-model");
  });

  it("falls back gracefully for null/undefined ids", () => {
    expect(resolveModel(null, "gemini-3-flash-preview")).toBe(
      "gemini-3-flash-preview",
    );
    expect(resolveModel(undefined, "gemini-3-flash-preview")).toBe(
      "gemini-3-flash-preview",
    );
  });
});
